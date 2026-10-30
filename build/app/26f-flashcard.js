  /* ---- FLASHCARD: a card that holds ecash ----------------------------------
   *
   * The screens over the wallet's card functions (build/wallet/08a-flashcard.js
   * and 21a-flashcard.js). These places use them:
   *
   *   the receive screen's CARD button   somebody pays this phone with their
   *                                      card: its PIN on this phone's pad,
   *                                      a tap, paid or not;
   *   a split bill's share screen        the same CARD, for one payer's share
   *                                      of the bill (`payShareByCard`): one
   *                                      share to a tap, and a share the mint
   *                                      has vouched for is ticked and the
   *                                      screen moves on to the next payer;
   *   CARD (home, top left)              a holder's own card: what it holds,
   *                                      money on and off it, its PIN and its
   *                                      limit, and the cards this phone can
   *                                      take back if they are lost.
   *   a card's address, from outside     a card held to the phone raises one
   *                                      address and iOS opens Foxy with it:
   *                                      the same as CARD on home, if it is
   *                                      a moment for it (`cardTapped`);
   *   SEND > FLASHCARD                   money onto any card held to this phone
   *                                      (`fcSendCard`);
   *   RESET (software 1.17)              the first of the row of round buttons
   *                                      under the holder's card (`fcReset`).
   *
   * The daily limit is the most the card signs for in one day. The card keeps
   * its own clock, counts the whole worth of every piece it signs against the
   * day it falls in, and starts the count again by itself when the day is over.
   * A card has none until its owner sets one; only the phone that holds the
   * words the card was set up with, the owner, can set, change or remove it,
   * change the card's PIN, or add funds without the PIN.
   *
   * A card of software 1.15 and on takes its clock from the newest Bitcoin
   * block header it has been shown (build/wallet/08b-block-headers.js): no one
   * can show it a block from a time that has not come, so no terminal can walk
   * its day forward, and a screen of ours says the block its clock reads
   * ("Block #970809", under the title). The phone's own time is only a note the card
   * writes in its log and receipts, and the log shows it beside the block's.
   *
   * Three things here are not this app's to draw. The sheet that slides up
   * while the phone looks for a card is the phone's own, and one line of text
   * on it is ours (`link.say`). The page behind it cannot be touched while it
   * is up. And a card is let go as soon as it has signed: its sheet ends with
   * "Done.", and a screen of ours says that the mint is being
   * asked for as long as that takes (the card's part is seconds; the mint's is
   * as long as Tor).
   *
   * A card's PIN is not Foxy's PIN. It is typed on the same pad because that
   * is the pad a person already knows; it is held in a variable for the length
   * of one flow, passed to the card, and never stored.
   *
   * A card of software 1.16 and on need not have one. It is set up with none
   * and asked for none (no pad: SET UP, then the tap), and a PIN can be added
   * to it later (ADD PIN, in CHANGE PIN's place). A card with a PIN has a third limit, the NO
   * PIN LIMIT: how much it signs for in a day without the PIN. At a till the
   * card is tapped first, with no PIN asked for: a card with none, or one
   * whose no PIN limit covers the payment, pays in that tap; any other ends
   * the tap asking for its PIN, and the pad comes up for a second tap. A card
   * of an older software always needs it, and is asked the same way.
   */

  /* A tap, step by step: the line on the phone's sheet. The wallet names the steps as it reaches them; the screen behind
   * the sheet is drawn from where the tap has got to (26h-tap-screen.js), not from these. */
  // the screen's lead over the sheet, in ms: TAP BEHIND PHONE is seen before iOS's sheet comes up
  /* No head start for the screen before the sheet. A phone with its screen on reads a card's tag by itself and offers
   * its banner whenever no card sheet is up, so a card already at the phone in that half second was taken by the
   * system and not by the payment. The sheet is asked for at once; the screen behind it comes up with it. */
  FC_TAP_LEAD = 0;
  FC_STEPS = {
    hold: 'Tap behind the phone.',
    reading: 'Reading the card',
    signing: 'Keep holding.',
    mint: 'Asking the mint',
    change: 'Putting change back on the card',
    /* The card has signed and been let go, and these are said on our screen alone (`fcTap`'s `on`): there is no sheet. */
    checking: '',
    making: '',
    writing: 'Keep holding.',
    resetting: 'Keep holding.',
    done: 'Done.',
  };
  FC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /* How near its date a card's own phone starts saying RENEW: a card's money is good for fourteen days, and is renewed with ten
   * left, which is above the week a phone with no route needs left on a piece (the wallet's `cardMargins().offline`), so a card is
   * renewed before such a phone starts refusing it. */
  FC_RENEW_DAYS = 10;
  // the hold the renewal threshold is ten days of (the wallet's CARD_HOLD_DEFAULT)
  FC_HOLD_DAYS = 14;
  // the renewal threshold in seconds: ten of the hold's fourteen days, scaled with a shortened hold (the wallet's `cardHoldSecs`)
  fcRenewSecs() {
    const W = this.fcW ? this.fcW() : null;
    const hold = (W && W.cardHoldSecs) ? Number(W.cardHoldSecs()) || 0 : 0;
    return hold > 0 ? Math.round(hold * this.FC_RENEW_DAYS / this.FC_HOLD_DAYS) : this.FC_RENEW_DAYS * 86400;
  }
  // the hold as a person reads it, in whole days ("Renew it for 14 days"): the wallet's, a day at least for a test build's shorter one
  fcHoldDays() {
    const W = this.fcW ? this.fcW() : null;
    const hold = (W && W.cardHoldSecs) ? Number(W.cardHoldSecs()) || 0 : 0;
    return hold > 0 ? Math.max(1, Math.round(hold / 86400)) : this.FC_HOLD_DAYS;
  }
  /* The owner's own margin before a date, the wallet's (`cardMargins`: ten minutes of the fourteen days, scaled with a test build's
   * shorter hold): a renewal is not offered closer to the date than that. */
  fcOwnSecs() {
    const W = this.fcW ? this.fcW() : null;
    const m = (W && W.cardMargins) ? W.cardMargins() : null;
    return (m && Number(m.own) > 0) ? Number(m.own) : 600;
  }
  // the longest a payment's confirmation waits for its change to be taken
  FC_HOLD_MS = 150000;
  /* The wait for the mint's word on a card that has signed, which the CHECKING card makes (`fcChecking`) and the screen behind the sheet
   * counts too (26h-tap-screen.js): the first asking this long after the card is let go, then one every FC_CHECK_EVERY_MS, FC_CHECK_ASKS in all.
   * CHECKING until the last has gone unanswered, and STILL CHECKING after it. */
  FC_CHECK_FIRST_MS = 3000;
  FC_CHECK_EVERY_MS = 5000;
  FC_CHECK_ASKS = 12;
  // what a mint's melt quote agreed to at a tap must still have before its expiry, for the card's payment of it (`fcQuoteFresh`)
  FC_QUOTE_LEFT_MS = 75000;
  /* A card at another mint than this phone's pays from there, with this phone at that mint for the tap and the melt (`fcXmGo`). A tap
   * left part way, or a mint that has not answered, keeps it there for the card's flows to finish; after this long with none of them
   * running, it goes home whatever happened (`fcXmStay`). */
  FC_XM_STAY_MS = 200000;
  // how long after a card screen has come down a confirmation waits to be sure the card flow has not gone straight on to its next screen
  FC_END_SETTLE_MS = 300;
  /* Every new card can be taken back.
   *
   * A card set up here names a key of the phone that loaded it, and that phone
   * can take its money back after the pieces' date (fourteen days from when it
   * was put on) if the card is lost or blocked. Set-up asks nothing about it:
   * there is no "like cash" card to choose. This switch is the list that makes
   * that true for a person: the cards this phone loaded are shown on the
   * FLASHCARD screen, with TAKE BACK for any past its date, and the screen
   * with no card on it is opened first, since a lost card cannot be tapped.
   * False hides the list and that screen as they once were
   * (tests/flashcard-screens.js runs both ways); a card is set up recoverable
   * either way. A cash card set up before still reads and pays as what it is. */
  FC_RECOVERABLE = true;

  fcW() {
    const W = window.FoxyWallet;
    return (W && W.cardSession) ? W : null;
  }

  /* A card's name: the one given it on this phone (NAME CARD, 26j-card-wheel.js `fcNameKept`), or, for a card with none, the last four
   * characters of its key, which tell two apart. */
  fcName(key) { return this.fcNameKept(key) || 'CARD ··' + String(key || '').slice(-4).toUpperCase(); }

  /* A card holds one kind of money, bitcoin or dollars, chosen when it is set up (21a-flashcard.js, `cardSetUp`). Every figure
   * below is in the unit it is given: sats where none is named, as every caller from before cards held dollars, and cents for
   * 'usd', said as dollars to the cent with no price in it. A dollar is a dollar. */
  fcSats(n, unit) {
    if (unit === 'usd') return '$ ' + this.usd(Math.round(Number(n) || 0) / 100);
    return '₿' + this.group(Math.round(Number(n) || 0));
  }

  /* An amount for a button or a sentence: dollars where this phone has a
   * price to say them at, the sats where it has not, and the sats too for an
   * amount under half a cent, which in dollars would read as nothing. A dollar card's cents are dollars already. */
  fcPrice(n, unit) {
    if (unit === 'usd') return '$' + this.usd(Math.round(Number(n) || 0) / 100);
    const sats = Math.round(Number(n) || 0);
    const usd = (sats / 1e8) * ((this.px && this.px()) || 0);
    return usd >= 0.005 ? '$' + this.usd(usd) : this.fcSats(sats);
  }

  /* The same with the sats after it: "$1.28 (₿1,499)". A dollar card's has no sats after it: none were asked of it. */
  fcBoth(n, unit) {
    if (unit === 'usd') return this.fcPrice(n, 'usd');
    const sats = Math.round(Number(n) || 0);
    const usd = (sats / 1e8) * ((this.px && this.px()) || 0);
    return usd >= 0.005 ? '$' + this.usd(usd) + ' (' + this.fcSats(sats) + ')' : this.fcSats(sats);
  }

  /* A figure as the screens of two balances write it, "₿ 5,000" or "$ 4.21" (01-ui-basics.js, `unitFigure`): for the words
   * that put the two side by side, where a dollar card is asked for sats. */
  fcFig(n, unit) {
    if (this.unitFigure) return this.unitFigure(n, unit);
    const v = Math.round(Number(n) || 0);
    return unit === 'usd' ? '$ ' + this.usd(v / 100) : '₿ ' + this.group(v);
  }

  // the unit of the card on show: 'usd' for a dollar card, 'sat' for any other (and for none)
  /* (a card of software 1.23: the currency this ADD FUNDS or WITHDRAW is in, where it was asked, `fcFlowUnit`; else its record's) */
  fcUnit() {
    const fc = this.state.fc;
    if (fc && fc.v123 && (this._fcFlowUnit === 'usd' || this._fcFlowUnit === 'sat')) return this._fcFlowUnit;
    return (fc && fc.unit === 'usd') ? 'usd' : 'sat';
  }

  /* What a card holds in one currency: for a card of 1.23 that currency's own balance (`fc.bal`), for any other its balance. */
  fcHeld(fc, unit) {
    if (!fc) return 0;
    if (fc.v123 && fc.bal) return Math.max(0, Math.round(Number(fc.bal[unit === 'usd' ? 'usd' : 'sat']) || 0));
    return Math.max(0, Math.round(Number(fc.balance) || 0));
  }

  /* The price a card's rate is written at (software 1.23, the sats a dollar its sats payments are weighed at): this phone's own, never
   * another phone's (`peerRate`, shown while this phone is offline after an offline payment) and never one older than the wallet trusts
   * (`priceTooOld`); 0 for none, and the wallet then writes no rate where one is needed (`no-price`). */
  fcRatePrice() {
    const peer = (this.peerRate && this.peerRate()) || 0;
    let p = (this.px && this.px()) || 0;
    if (peer > 0 && p === peer) p = (this.state.satUsd ? this.state.satUsd * 1e8 : 0) || Number(this.state.livePrice) || 0;
    const W = this.fcW ? this.fcW() : null;
    const lp = (W && W.lastPrice) ? W.lastPrice() : null;
    if (p > 0 && lp && Number(lp.rate) > 0 && Math.round(Number(lp.rate)) === Math.round(p) && W.priceTooOld && W.priceTooOld(lp.at)) p = 0;
    return p > 0 ? p : 0;
  }

  /* What a card as the wallet read it holds in `unit`: a card of 1.23 that currency's own balance (its `balance` is its record's), any
   * other its balance. */
  fcCardHolds(card, unit) {
    if (!card) return 0;
    if (card.units && card.units[unit === 'usd' ? 'usd' : 'sat']) return Math.max(0, Math.round(Number(card.units[unit === 'usd' ? 'usd' : 'sat'].balance) || 0));
    return Math.max(0, Math.round(Number(card.balance) || 0));
  }

  /* Whether a card holds money in any currency: a card of 1.23 in either of its two (its record's balance may be nothing while it holds
   * the other), any other card its balance. */
  fcAnyMoney(fc) {
    if (!fc) return false;
    if (fc.v123 && fc.bal) return this.fcHeld(fc, 'usd') > 0 || this.fcHeld(fc, 'sat') > 0;
    return Math.round(Number(fc.balance) || 0) > 0;
  }

  /* What all of a card holds, in words: each currency it holds money of, dollars first ("$15.00 and $2.00 (2,000 sats)"); a card of one
   * currency its balance. */
  fcWholeWords(fc) {
    if (!fc) return '';
    if (!(fc.v123 && fc.bal)) return this.fcBoth(fc.balance, fc.unit);
    const each = ['usd', 'sat'].filter((u) => this.fcHeld(fc, u) > 0).map((u) => this.fcBoth(this.fcHeld(fc, u), u));
    return each.length ? each.join(' and ') : this.fcBoth(0, fc.unit);
  }

  /* The figure a tap that takes all of a card is shown with: its record's currency where it holds any, else the other it holds. */
  fcWholeStage(fc) {
    if (!fc) return '';
    if (!(fc.v123 && fc.bal) || this.fcHeld(fc, fc.unit) > 0) return this.stageMoney(fc.balance, fc.unit);
    const other = fc.unit === 'usd' ? 'sat' : 'usd';
    return this.stageMoney(this.fcHeld(fc, other), other);
  }

  /* The unit a card's limit is typed in (software 1.23, one figure for both currencies, kept in cents): a card that holds dollars only
   * takes it in dollars; a card that holds bitcoin, alone or with dollars, in dollars or sats, as a bitcoin card's keypad offers them.
   * A card before 1.23 in its own unit. */
  fcLimitUnit() {
    const fc = this.state.fc;
    if (!(fc && fc.v123)) return this.fcUnit();
    /* (by what it holds, the design's rule: bitcoin held, dollars or sats; dollars alone, dollars; nothing yet, by what it was set up to hold) */
    if (this.fcHeld(fc, 'sat') > 0) return 'sat';
    if (this.fcHeld(fc, 'usd') > 0) return 'usd';
    return fc.unit === 'usd' ? 'usd' : 'sat';
  }

  /* A wallet result's figure in its own unit. A card's results say `amount` in the card's unit and keep `sats` for
   * bitcoin, with `sats` 0 for a dollar card (08a-flashcard.js, `cardGot`): read here, so a dollar card's cents are never
   * read as nothing, and never under a sats name. A result from before results said `amount` is read by its sats. */
  fcAmt(x) {
    if (!x) return 0;
    const n = (x.amount !== undefined && x.amount !== null) ? x.amount : x.sats;
    return Math.max(0, Math.round(Number(n) || 0));
  }

  // the unit a wallet result or error is in: its own word for the card's unit, else its own unit, else sats
  fcUnitOf(x) {
    const u = x && (x.cardUnit || x.unit);
    return u === 'usd' ? 'usd' : 'sat';
  }

  /* A piece's date, as a day. Written out here and not left to the phone's
   * region, so the same card reads the same on every phone. */
  fcDay(secs) {
    const d = new Date((Number(secs) || 0) * 1000);
    return d.getDate() + ' ' + this.FC_MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  /* CARD, home's round button at the top left, asks for the card at once: the phone's own sheet
   * comes up with no screen of ours to read first. A card tapped, and the
   * screen is that card. The sheet dismissed, and the person is where they
   * were: there is no screen for no card.
   *
   * Except where cards can be taken back (FC_RECOVERABLE): the screen with
   * no card on it is opened first and stays when the sheet goes. A lost card
   * cannot be tapped: its money is taken back from home's MENU, RESTORE LOST
   * CARD (`fcRestoreLost`), not from this screen. */
  goFlashcard() {
    // a card read on an earlier visit is not shown again: it may be somebody else's, and what it held may have changed
    this._fcCard = null;
    clearInterval(this._fcRollT);
    if (this.state.fcRoll) this.setState({ fcRoll: null });
    if (this.FC_RECOVERABLE) {
      // (from the card's own screen, which a card's address can come to, it is not put on the stack again)
      this.setState(p => ({ fc: null, screen: 'flashcard', stack: p.screen === 'flashcard' ? p.stack : p.stack.concat([p.screen]) }));
      this.fcRead();
      return;
    }
    if (this.state.fc) this.setState({ fc: null });
    this.fcRead(true);
  }

  /* ---- a card's address, from outside Foxy -----------------------------------
   *
   * A Foxy card answers as an NFC tag that carries one address, the same on every
   * card (https://getfoxy.io/card; Foxy/Flashcard/CardAddress.swift). With the
   * screen on, iOS reads the tag by itself and shows a banner, and a tap on the
   * banner opens Foxy, or brings it forward, with that address. iOS gives no
   * session with the card; it gives the address, and the phone passes on one
   * thing, `FoxyWallet._cardTapped()`: a card was tapped. Nothing of the address
   * comes with it. What is done is what CARD on home does (`goFlashcard`:
   * the screen, the phone's sheet, the card still behind the phone), when it is
   * a moment for that. `cardTapRule` is the one place that says whether it is:
   *
   *   act      the person is at home, or on a screen where nothing is in
   *            progress (CARD_TAP_FREE);
   *   keep     Foxy is locked, or still starting (the launch screens, the
   *            first-run warning, the Tor gate's screens). The request waits
   *            for the person to be in and is acted on then, if that is within
   *            CARD_TAP_KEEP_MS; after that it lapses;
   *   ignore   a payment, an amount being typed, a confirmation, a sending or a
   *            paid screen, a split bill, a card sheet or a card flow, a card
   *            on the screen, or anything else up over it. A card resting behind
   *            the phone must never pull a person out of a payment.
   *
   * A screen is a place to leave only if it is named in CARD_TAP_FREE, so one
   * added later is ignored until somebody decides, and so is anything drawn over
   * the screen that this code does not know. Each outcome is one log line, and
   * none of them says anything of the address. */

  // the screens on which nothing is in progress: a card's address may take the person away from any of them
  // (RESTORE CARD, 'fcRestore', is a list: a take-back under way is its stage, drawn over it)
  CARD_TAP_FREE = ['home', 'history', 'contacts', 'txDetail', 'flashcard', 'change', 'fieldLog', 'switchMint', 'fcRestore'];
  // how long a request waits for Foxy to be open before it lapses, and how often it looks again meanwhile
  CARD_TAP_KEEP_MS = 60000;
  CARD_TAP_POLL_MS = 250;

  /* The phone's word that a card was tapped (registered as `FoxyWallet._cardTapped` by bootWallet, once the lock has
   * been decided). Answers true when this page has the request, whatever it then does with it: that is how the phone
   * knows to stop asking. A second request while one waits is the same tap said twice. */
  cardTapped() {
    if (this._cardTapAt) {
      console.log('[foxy] card tap: ignored, one is already waiting');
      return true;
    }
    this._cardTapAt = Date.now();
    this._cardTapKept = false;
    this.cardTapSettle();
    return true;
  }

  /* What is true of the screen right now, as plain values for `cardTapRule`. While a screen of the gate's is up the
   * overlays are not looked at, because the gate's own are among them; the request is kept, and looked at again when
   * the gate has gone. */
  cardTapFacts() {
    const s = this.state;
    const G = window.FoxyGate;
    let starting = false;
    try { starting = !!(G && G.visible && G.visible()); } catch (e) { starting = false; }
    return {
      locked: !!this._pinLocked,
      starting,
      screen: String(s.screen || ''),
      // the mint list asked for a transfer's mint, or for the one a card moves to: money, not a list
      transfer: !!s.trStep,
      pick: !!s.fcPick,
      over: starting ? '' : this.cardTapOver(),
    };
  }

  /* What is up over the screen, by name, or ''. Nearly everything this app draws over a screen is a fixed element on the
   * body (the PIN pad, the cards, the stage and loading screens, the explainer, the seed screens), so any such element is
   * a reason to leave the person where they are. Not the lock's own pad (that is `locked`), the app itself, the gate, a
   * field that is only there to hold focus, or the list of apps that sell bitcoin, which is only to be read and which
   * a card's tap closes (`cardTapAct`). The one question the template draws over a screen that is free, the one that
   * asks for a backup of the words over home, is named by its flag. */
  cardTapOver() {
    if (this.state.bkAskOpen) return 'the backup question';
    const lockPad = this._pinLocked ? this._pinEl : null;
    const kids = document.body ? Array.prototype.slice.call(document.body.children) : [];
    for (let i = 0; i < kids.length; i++) {
      const n = /** @type {any} */ (kids[i]);
      if (!n || n === lockPad || n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') continue;
      const id = String(n.id || '');
      if (id === 'dc-root' || id === 'foxy-get-dollars' || id.indexOf('ftg-') === 0) continue;
      if (n.style && n.style.position === 'fixed') return id || (n === this._pinEl ? 'a PIN pad' : n === this._blockedEl ? 'a card' : 'an overlay');
    }
    return '';
  }

  /* Act, keep or ignore, for the facts of `cardTapFacts`. What is on screen decides first: a request that finds a
   * payment under the lock is ignored there and then, not kept to be acted on a minute later from wherever the person
   * has got to. */
  cardTapRule(f) {
    if (f.over) return 'ignore';
    const free = this.CARD_TAP_FREE.indexOf(f.screen) >= 0 && !(f.screen === 'switchMint' && (f.transfer || f.pick));
    if (!free) return 'ignore';
    if (f.locked || f.starting) return 'keep';
    return 'act';
  }

  /* One look at the request: acted on, ignored, or kept and looked at again a moment from now, until it lapses. */
  cardTapSettle() {
    clearTimeout(this._cardTapT);
    this._cardTapT = null;
    const at = this._cardTapAt;
    if (!at) return;
    const f = this.cardTapFacts();
    const say = this.cardTapRule(f);
    if (say === 'keep') {
      if (Date.now() - at >= this.CARD_TAP_KEEP_MS) {
        this._cardTapAt = 0;
        console.log('[foxy] card tap: lapsed, Foxy was not open within ' + Math.round(this.CARD_TAP_KEEP_MS / 1000) + ' s');
        return;
      }
      if (!this._cardTapKept) {
        this._cardTapKept = true;
        console.log('[foxy] card tap: kept until Foxy is open, ' + (f.locked ? 'it is locked' : 'it is starting'));
      }
      this._cardTapT = setTimeout(() => this.cardTapSettle(), this.CARD_TAP_POLL_MS);
      return;
    }
    this._cardTapAt = 0;
    if (say === 'ignore') {
      console.log('[foxy] card tap: ignored, ' + (f.over ? 'something is up over the screen (' + f.over + ')'
        : 'the screen is ' + f.screen + (f.screen === 'switchMint' && (f.transfer || f.pick) ? ', asking where money moves' : '')));
      return;
    }
    console.log('[foxy] card tap: opening the card screen from ' + f.screen
      + (this._cardTapKept ? ', after ' + Math.round((Date.now() - at) / 1000) + ' s kept' : ''));
    this.cardTapAct();
  }

  /* What the menu's row does when it is pressed: the drawer closes (`shut`), and the tap begins. */
  cardTapAct() {
    if (this.state.open0) this.setState({ open0: false });
    if (this.hideGetDollars) this.hideGetDollars();
    this.goFlashcard();
  }

  /* ---- one tap ------------------------------------------------------------
   *
   * `o`: amount (a heading under the title) and body, for the screen behind
   * the sheet, and `warm`, for a tap that goes on to the mint (the road to it
   * is opened as the sheet opens). `fn(link, on)` is what to do with the card;
   * `on(step)` moves both screens on, and after the card is let go
   * (`link.released`) only ours. Resolves and rejects as `fn` does, with our
   * screen down either way. */
  fcTap(o, fn) {
    const W = this.fcW();
    if (!W) return Promise.reject(new Error('The wallet is not ready.'));
    // a tap is in progress from here until it settles, whatever is on the screen meanwhile (`cardFlowBusy`)
    this._fcTaps = (this._fcTaps || 0) + 1;
    const free = () => { this._fcTaps = Math.max(0, (this._fcTaps || 1) - 1); };
    /* The tap that follows the PIN pad (the last sheet ended asking for it) starts as PLEASE TAP AGAIN, on the screen
     * the last tap left up (26h-tap-screen.js). */
    const was = document.getElementById('foxy-stage');
    const afterPin = !!(was && was.getAttribute('data-stage') === 'card' && was.getAttribute('data-look') === 'pin');
    this._fcTapO = Object.assign({}, o || {});
    delete this._fcTapO.t;
    if (afterPin) this._fcTapO.pinAgain = true;
    this.fcStage('hold');
    /* What the phone's own link says is happening, as it says it: the card found, the card lost. The sheet's lines are
     * ours already, and the screen behind it does not repeat them. */
    if (W.onCard) W.onCard((ev) => this.fcTapEvent(ev));
    /* The screen comes down with the tap, except when the sheet ended asking for the PIN: it stays up under the pad, and
     * the tap that follows takes it up again. */
    const over = (pinNeeded) => {
      if (W.onCard) W.onCard(null);
      if (pinNeeded) this.fcTapPin(); else this.hideStage('card');
    };
    /* The screen and the sheet together. The sheet could follow the screen by FC_TAP_LEAD, and did by half a second
     * so that TAP BEHIND PHONE was seen first; with a tag on the card, that half second was one in which the system
     * read the card and raised its banner. The lead is nothing now, and a lead that is set is still honoured. */
    const lead = Math.max(0, Number(this.FC_TAP_LEAD) || 0);
    // with no lead the sheet is asked for in this very turn
    const after = (start) => (lead > 0 ? new Promise((go) => setTimeout(go, lead)).then(start) : start());
    return after(() => W.cardSession((o && o.sheet) || this.FC_STEPS.hold, (link) => {
      const on = (step, info) => {
        const line = this.FC_STEPS[step];
        if (line === undefined) return;
        // the card has been let go and the sheet is gone: nothing to say on it, and "remove the card" has been said
        if (link.released && step === 'done') return;
        // a card that says which design it is (a till does not know until it has read it)
        if (info && Object.prototype.hasOwnProperty.call(info, 'design')) this.fcTapSeen(info.design);
        // a step of the card's own work means it is in the field, whether or not the phone has said so
        if (this.FC_TAP_CONTACT[step]) this.fcContact();
        /* 'checking' and 'making' are said whether or not the sheet is still up: with it kept for the change the card is
         * still there, and the screen is told it is (mint, change), not that it can go. */
        this.fcStage(!link.released && step === 'checking' ? 'mint' : !link.released && step === 'making' ? 'change' : step);
        if (!link.released) link.say(line);
        const paying = !!(this._fcTapO && this._fcTapO.paying);
        /* The card's part is over. The mint's work can take as long as Tor does
         * (this screen is not the sheet, which iOS ends after a minute), and what
         * is said under the heading is what a person who has taken the card away
         * needs to hear. */
        /* The card has signed and something is coming back to it in this sheet (`info.change`: its change, or a payment held
         * for another amount): the page asks for three buzzes, so that whoever holds the card would know a second tap is
         * coming. iOS plays no haptic of an app's while its own sheet is up, so they are not felt today; the sheet's words
         * ("Hold for change.", 08a-flashcard.js `cardLetGo`) are what says it. Nothing else in the
         * app asks for three. */
        if ((step === 'checking' || step === 'mint') && info && info.change) this.fcChangeBuzz();
        if (step === 'checking') {
          clearTimeout(this._stageT);
          this._stageT = setTimeout(() => this.hideStage('card'), 180000);
          /* The card has signed for a payment: its PAYMENT RECEIVED waits from
           * here, before the mint has said paid, until its change is back on
           * the card or is left for later. Held as this payment's and no
           * other's (`info.hash`, its entry). */
          if (paying) this.fcHoldConfirm(info && info.hash);
        }
        if (step === 'making' && paying) this.fcHoldConfirm(info && info.hash);
      };
      /* Which piece, of how many: said on the sheet before the card is asked, so the line is up for as long as it works
       * on that piece and a person keeps holding. A card that has said its design (`design`) is drawn as it. */
      const progress = (p) => {
        if (p && Object.prototype.hasOwnProperty.call(p, 'design')) this.fcTapSeen(p.design);
        // a piece being written: some of the change is going on, and contact breaking now breaks it part way
        if (p && p.step === 'writing' && Math.round(Number(p.i)) > 0) this.fcTapState().wrote = true;
        const text = this.fcProgressText(p);
        if (!text) return;
        link.say(text);
      };
      on('reading');
      return fn(link, on, progress);
      // a tap that goes on to the mint opens the road to it as the sheet opens, not when the card has signed
    }, { warm: !!(o && o.warm), again: (o && typeof o.again === 'function') ? (e) => {
      const line = o.again(e);
      /* The card left and the same sheet is about to ask for it again: the screen says so from now until the card is
       * found. */
      if (line) this.fcTapLost();
      return line;
    } : null }).then((r) => { free(); over(false); return r; },
            (e) => { free(); over(!!(e && e.card === 'pin-needed')); throw e; }));
  }

  /* "Signing piece 3 of 9", "Writing 2 of 4": the words for one step of a
   * card's work, or '' for a step with none. */
  fcProgressText(p) {
    /* A card made to wait by its own limit on one tap (08a-flashcard.js,
     * `cardWaitSigns`): how long is left, counted down as the card says. */
    if (p && p.step === 'waiting') {
      // a card of software 1.12 waits a limit's worth for the change it makes, within the limit as well as over it
      if (p.making) return 'Keep holding.';
      /* A card before 1.12 waits by what its pieces come to. A small payment made
       * with a piece worth much more than the price is not over anybody's
       * limit, and was being told it was: it is the piece that is. */
      if (p.want > 0 && p.sum >= 2 * p.want) return 'Paying from a larger piece.';
      // a card of 1.13 slows a second payment signed in one time in the field, limit or no limit (08a-flashcard.js, `cardPaid`)
      if (p.second) return 'Keep holding.';
      /* Over the limit: the first limit's worth over takes ten askings of the card (seven before software 1.17, `info.waitOver`),
       * and each further limit's worth three or four (`info.waitMore`); said as the level it has come to, "x2" when the second begins, and so on. */
      const over = Number(p.over) || this.fcWaitOver();
      const more = Number(p.more) || this.fcWaitMore();
      const polls = Math.round(Number(p.polls) || 0);
      const level = polls > over ? 2 + Math.floor((polls - over - 1) / more) : 1;
      return 'Over per tap limit' + (level > 1 ? ' x' + level : '');
    }
    // the card is owed change that no till has handed back, and the mint is being asked for it (08a-flashcard.js, `cardOwnerChange`)
    if (p && p.step === 'fetching') return 'Asking for change owed.';
    const i = Math.round(Number(p && p.i)), n = Math.round(Number(p && p.n));
    if (!(i > 0 && n > 0)) return '';
    // a card that signs once for a payment has no pieces to count
    if (p.step === 'signing') return p.all ? 'Signing' : 'Signing piece ' + i + ' of ' + n;
    if (p.step === 'writing') return 'Writing ' + i + ' of ' + n;
    /* The card makes its change a piece at a time, about half a second each over NFC, between the pieces being
     * named and the signature: said before each, so that the sheet is never quiet for seconds and the card is not
     * taken away (08a-flashcard.js, `cardSignGroup`). */
    if (p.step === 'change') return 'Making change ' + i + ' of ' + n + '.';
    return '';
  }

  /* Three buzzes, 0.15 s apart (Foxy/Bridge/FoxyBridge.swift, "triple"), silent: change is coming back to the card, so
   * there is a second tap to make. The page asks for them as the card is let go. Not felt while the phone's own NFC
   * sheet is up, which it is at that moment: iOS keeps its haptics to itself under its sheet. Kept for the day it does
   * not, and for a sheet that is already down. */
  fcChangeBuzz() {
    this.haptic && this.haptic('triple', true);
  }

  /* The screen behind the sheet, for this step of the tap (26h-tap-screen.js). The steps that change what is true of
   * the tap are noted first: the card has signed (`mint`, `change`), has been let go (`checking`, `making`, `done`),
   * is asked for again (`receive`), or has been lost (`lost`). */
  fcStage(step) {
    const t = this.fcTapState();
    if (step !== 'hold') t.touched = true;
    if (step === 'mint' || step === 'change') t.signed = true;
    /* The card is let go with the mint not yet heard from (`checking`): REMOVE, then CHECKING (26h-tap-screen.js). With the mint's word in
     * (`making`: the change is being made; `done`: the tap is over) there is nothing left to check, and the screen keeps the look it had, whichever
     * of REMOVE, CHECKING and STILL CHECKING that was, until it comes down. */
    if (step === 'checking') { t.signed = true; t.gone = true; t.connected = false; if (!t.goneAt) t.goneAt = Date.now(); }
    if (step === 'making' || step === 'done') {
      if (t.gone && t.goneAt && !t.kept) t.kept = this.fcGoneKey(t);
      t.signed = true; t.gone = true; t.connected = false;
    }
    if (step === 'receive') { t.signed = true; t.connected = false; t.gone = false; t.goneAt = 0; t.kept = ''; t.sheetGoneAt = 0; }
    if (step === 'lost') { t.lost = true; t.connected = false; }
    this.fcTapDraw();
  }

  /* A card's PIN, on the pad the lock uses. `o`: title, subtitle, warn, and
   * `cta`, what the button says: it names the thing the PIN is for ("PAY
   * $0.43"), and it cannot be pressed until four digits are in. The way out
   * is a back button at the top left, where every screen's is; `o.onBack`
   * runs after it.
   *
   * A pad that `then` opens in the same turn (a PIN asked twice, and asked again where the two differed) takes the
   * place of the one that was answered, and comes up with no fade (`cover`, as the lock's pad has). A pad fades in
   * from the screen under it, and with the first gone and the second still faint, the card's screen showed through
   * for an instant between the two. */
  fcAskPin(o, then) {
    const opt = o || {};
    // the pad is remembered, so that a card flow waiting on a PIN can be told from a pad that is gone (`cardFlowBusy`)
    this._fcPadEl = this.pinOverlay({
      title: opt.title || 'CARD PIN',
      subtitle: opt.subtitle || '',
      warn: opt.warn || '',
      cta: opt.cta || 'NEXT',
      gate: true,
      cover: !!this._fcPadSwap,
      /* backed out of: the screen left up under the pad by a tap that ended asking for the PIN (ENTER PIN) goes with it */
      back: () => { this.hideStage('card'); if (opt.onBack) opt.onBack(); },
      onSubmit: (pin) => {
        this.pinDismiss();
        this._fcPadSwap = true;
        try { then(pin); } finally { this._fcPadSwap = false; }
      },
    });
  }

  /* Whether the card on screen has no PIN (software 1.16 and on can be set up without one). */
  fcHasNoPin() {
    const fc = this.state.fc;
    return !!(fc && fc.setUp && !fc.pinSet);
  }

  /* The card's PIN, asked for on the pad; or, for a card that has none, nothing is asked and `then` is
   * called with an empty PIN, which the wallet takes as none. */
  fcPinOr(o, then) {
    if (this.fcHasNoPin()) { then(''); return; }
    this.fcAskPin(o, then);
  }

  /* An amount for a card, typed where every other amount in Foxy is typed:
   * the SET AMOUNT screen, with its dollars first, its swap to sats, its 00
   * key, the back button at the top and NEXT at the bottom. `flow` says which
   * question is being asked ('cardAdd', 'cardWd', 'cardLimit', and 'cardSend' from
   * the send screen); NEXT comes
   * back through `fcAmountNext`. */
  fcAmount(flow) {
    // a dollar card's own amounts are dollars, typed exactly with no ₿ toggle (`usdKeypad`), whatever the price
    const usd = this.fcTypedUnitFor(flow) === 'usd';
    this.setState(p => ({
      // one keypad at a time: asked from another card question's keypad, this takes its place
      screen: 'amount', stack: p.screen === 'amount' ? p.stack : p.stack.concat([p.screen]), flow,
      // dollars, as the receive flow starts; sats where there is no price to say dollars at
      amount: '', unit: (usd || this.px()) ? 'USD' : 'SATS',
      asset: '', network: '', note: '', noteDraft: '', recipient: '', recipientKind: '',
    }));
  }

  /* The unit a card's amount is typed in. ADD FUNDS, WITHDRAW and LIMITS are in the card's own unit: a dollar card's are
   * cents, typed in dollars. FLASHCARD on the send screen has no card on show: it is in the balance the money comes from,
   * dollars where this phone sends from its dollars at a mint with two, and the card tapped must hold that kind. */
  fcTypedUnitFor(flow) {
    // (a card of 1.23's limit: dollars, or dollars and sats where it holds bitcoin, `fcLimitUnit`)
    if (String(flow) === 'cardLimit') return this.fcLimitUnit();
    // (the two amounts of a card's set-up: in what the card will hold, 26j-card-wheel.js `fcSuUnitNow`)
    if (/^cardSu(NoPin|Tap)$/.test(String(flow))) return this.fcSuUnitNow();
    if (/^card(Add|Wd)$/.test(String(flow))) return this.fcUnit();
    if (flow === 'cardSend') return (this.twoUnitsOn && this.twoUnitsOn() && this.walletNow && this.walletNow('send') === 'usd') ? 'usd' : 'sat';
    return 'sat';
  }

  fcTypedUnit() { return this.fcTypedUnitFor(String(this.state.flow)); }

  // the figure typed on the keypad, in that unit: cents exactly for dollars, the keypad's sats for bitcoin
  fcTyped() {
    if (this.fcTypedUnit() !== 'usd') return this.wantedSats();
    if (this.centsTyped) return this.centsTyped();
    const v = parseFloat(this.state.amount) || 0;
    return v > 0 ? Math.round(v * 100) : 0;
  }

  /* ADD FUNDS: does the card on show have the room for `sats`? The wallet's
   * answer ({ ok, why, … }, `cardLoadFits`) to the amount typed, for the card
   * read a moment ago, or null where there is none to ask about: no card on
   * show (FLASHCARD on the send screen), a card other than the one read last,
   * or a wallet that cannot say. The keypad asks as it is typed
   * (`renderContext`), and NEXT asks again (`fcAmountNext`). */
  fcLoadFits(sats) {
    const W = this.fcW();
    const fc = this.state.fc;
    const card = this._fcCard;
    if (!W || !W.cardLoadFits || !fc || !card || card.key !== fc.key || !(sats > 0)) return null;
    // (a card of 1.23: in the currency being added, `fcUnit`)
    try { return W.cardLoadFits(card, sats, fc.v123 ? this.fcUnit() : undefined); } catch (e) { return null; }
  }

  fcAmountNext() {
    const flow = String(this.state.flow);
    // the set-up's two amounts carry on the set-up (26j-card-wheel.js), with no card on show to check them against
    if (/^cardSu(NoPin|Tap)$/.test(flow)) { this.fcSuAmountNext(); return; }
    const fc = this.state.fc;
    // in the unit it is typed in: sats for a bitcoin card, whatever the screen showed; cents, exactly, for a dollar card
    const unit = this.fcTypedUnit();
    const sats = this.fcTyped();
    // FLASHCARD on the send screen has no card on show: the card is the one held to the phone when NEXT is pressed
    if (!fc && flow !== 'cardSend') { this.back(); return; }
    /* SEND > FLASHCARD from home at a mint with two balances, the send not started in either: the figure is kept in both (dollars
     * exactly or at the price, and sats), and the card held to the phone decides (`fcSendRun`, `fig`): the one currency it holds, or,
     * for a card that takes both, the question which, where both of this phone's balances could pay. */
    if (flow === 'cardSend' && this.twoUnitsOn && this.twoUnitsOn() && !(this.walletNow && this.walletNow('send'))) {
      const fig = { usd: this.centsTyped(), sat: this.wantedSats() };
      if (!(fig.usd > 0) && !(fig.sat > 0)) { this.toast('Type an amount first.', true); return; }
      /* The design's rule: the amount, then the currency, asked only where both of this phone's balances could pay it; where one
       * can, that one, with nothing asked; where neither can, said. The card then takes it in the one it holds (`fcSendGuard`). */
      const canUsd = fig.usd > 0 && fig.usd <= this.fcHave('usd');
      const canSat = fig.sat > 0 && fig.sat <= this.fcHave('sat');
      const goIn = (u2) => {
        const alt2 = u2 === 'usd' ? { sats: fig.sat, have: this.fcHave('sat') } : null;
        this._fcSendTapped = false;
        if (this.fcSendPinFirst()) this.fcSendAsk(fig[u2], u2, alt2); else this.fcSendRun(fig[u2], '', u2, alt2);
      };
      if (canUsd && canSat) {
        this.fcPickUnit({ question: 'SEND WHICH TO THE CARD?', foot: 'Either balance could pay. The card takes it in the one it holds.',
                          short: { usd: '', sat: '' }, why: '' }, goIn);
        return;
      }
      if (canUsd || canSat) { goIn(canUsd ? 'usd' : 'sat'); return; }
      this.toast('You have ' + this.fcBoth(this.fcHave('usd'), 'usd') + ' and ' + this.fcBoth(this.fcHave('sat'), 'sat') + '.', true);
      return;
    }
    if (!(sats > 0)) { this.toast('Type an amount first.', true); return; }
    /* In sats, whatever the screen was typed in. The line under the figure
     * says the same thing in red, but it is worked out in dollars and has
     * nothing to say with no price. A dollar card is loaded from this phone's dollars, and says them. */
    const have = unit === 'usd' ? Math.max(0, Math.round(Number(this.state.balUsdCents) || 0)) : Math.floor(this.balNow().sats || 0);
    /* ADD FUNDS to a card at another mint: what this phone can cover, the fees in it and in whichever balance pays, is the
     * confirmation's to say (`fcXlBegin`), asked of both mints. */
    if (flow === 'cardAdd' && this.fcAddAway()) { this.fcXlAdd(sats); return; }
    // the card's room first, as the line under the figure names it first: the wallet's own words, asked of what the phone holds at the most
    const room = flow === 'cardAdd' ? this.fcLoadFits(Math.min(sats, have)) : null;
    if (room && !room.ok) { this.toast(room.why, true); return; }
    if ((flow === 'cardAdd' || flow === 'cardSend') && sats > have) { this.toast('You have ' + this.fcBoth(have, unit) + '.', true); return; }
    /* The sheet comes up at once, over the keypad, which stays where it is (`fcSendRun`). Typed in dollars, the card held to
     * the phone may yet turn out to hold bitcoin, as every card did: it is then loaded with the sats those dollars are at
     * this phone's price, from this phone's bitcoin (`alt`), as it always was. */
    if (flow === 'cardSend') {
      const alt = unit === 'usd' ? { sats: this.wantedSats(), have: Math.floor(this.balNow().sats || 0) } : null;
      /* The PIN before the card is asked for, so the card is tapped once: every card of 1.21 and on takes money under its PIN only,
       * and the owner found the tap, then "enter the card's PIN", then a second tap (`fcSendPinFirst`). A card read without a PIN
       * after all ignores the one typed (`fcSendRun`). */
      // (a new send: no card has been tapped for it yet, whatever the last one did)
      this._fcSendTapped = false;
      if (this.fcSendPinFirst()) { this.fcSendAsk(sats, unit, alt); return; }
      this.fcSendRun(sats, '', unit, alt);
      return;
    }
    // (a card of 1.23: what it holds in the currency being taken off)
    if (flow === 'cardWd' && sats > this.fcHeld(fc, unit)) { this.toast('The card holds ' + this.fcBoth(this.fcHeld(fc, unit), unit) + '.', true); return; }
    /* The PIN pad goes up over the keypad, which stays where it is: back
     * from the pad is back to the amount, still typed. The keypad is left
     * only when the PIN has been given (`fcLeaveAmount`). */
    if (flow === 'cardAdd') this.fcAddPin(sats);
    else if (flow === 'cardWd') this.fcWithdrawPin(sats);
    /* A limit typed in dollars is kept in dollars (`fcLimitRun`): the card holds sats, and the price moves. A dollar card's
     * limit is dollars, and is never kept at anything: no dollars are sent to keep it at. */
    // (the limit on a payment of a card that waits for it is typed as a rate: the card is sent three seconds of it, 26j-card-wheel.js)
    else if (flow === 'cardLimit') {
      const k = (this._fcLimitTap && this.fcPacedNow && this.fcPacedNow()) ? this.FC_SPEED_SECS : 1;
      this.fcLimitConfirm(sats * k, (unit === 'usd' ? 0 : this.state.unit === 'USD' ? Number(this.state.amount) || 0 : 0) * k);
    }
  }

  /* Off the keypad and back to the card's own screen, once an amount has
   * been taken from it. */
  fcLeaveAmount() {
    if (this.state.screen !== 'amount' || !/^card/.test(String(this.state.flow))) return;
    this.setState(p => ({
      screen: p.stack.length ? p.stack[p.stack.length - 1] : 'flashcard', stack: p.stack.slice(0, -1),
      flow: 'receive', amount: '', unit: 'USD',
    }));
  }

  /* ---- what went wrong, as a card --------------------------------------------
   *
   * Every refusal the wallet or the card can give, by its kind, in the words
   * of the screen list. `o.again` is what TRY AGAIN does, where trying again
   * can work; `o.taken` says whether "nothing was taken" is a true thing to
   * add (it is for a payment and a withdrawal, and means nothing for a read).
   */
  fcFailed(e, o) {
    const opt = o || {};
    const kind = String((e && e.card) || '');
    const said = String((e && e.message) || 'That did not work.');
    // whatever is said next is said on its own: the screen of a tap that ended asking for the PIN, and no pad followed, goes
    this.hideStage('card');
    const safe = opt.taken ? ' Nothing was taken.' : '';
    const again = opt.again ? { retry: 'TRY AGAIN', go: opt.again, shut: { label: 'CANCEL' } } : {};
    console.log('[foxy] card: ' + (kind || 'failed') + ' — ' + said);
    // their own cancel, or no card held up: the screen they were on is the answer
    if (kind === 'cancelled') return;
    if (kind === 'waiting') { this.fcChecking(e && e.id, (e && e.after) ? Object.assign({}, opt, { after: e.after }) : opt); return; }
    // the unit of the card that refused, which every figure below is in: a dollar card's are its cents (08a-flashcard.js puts it on each)
    const u = this.fcUnitOf(e);
    /* A bitcoin card at a dollar receive, which asked it for dollars alone: why it could not be asked for its sats instead. With
     * the dollar code not up yet there were none to ask; with no route, no price to work them out at, or no way to turn them
     * into dollars later (`payUsdByCard`). */
    const satsNo = () => {
      const why = opt.usd ? String(opt.usd.satsWhy || '') : '';
      if (why === 'old' || why === 'none') {
        const lp = opt.usd.price || { ageMs: 0 };
        return {
          title: 'BITCOIN PRICE TOO OLD',
          reason: (why === 'old' ? 'This phone last saw the Bitcoin price ' + this.agoWords(lp.ageMs) + '. That is too old'
            : 'This phone has not seen the Bitcoin price, so it has nothing') + ' to work out what to take from the card.',
          chip: 'Nothing was taken. Get online once and Foxy has a new price.',
        };
      }
      if (opt.offline) {
        return { title: 'THIS CARD HOLDS BITCOIN',
          reason: 'This card holds bitcoin here, not dollars. A phone that is offline takes dollars only from a dollar card. Take this payment in bitcoin, or when this phone is online.',
          chip: 'Nothing was taken.' };
      }
      if (!opt.codeUp) {
        return { title: 'THIS CARD HOLDS BITCOIN',
          reason: 'This card holds bitcoin. Tap it again when the dollar code is on screen, and it pays that.', chip: 'Nothing was taken.' };
      }
      return { title: 'THIS CARD HOLDS BITCOIN', reason: said, chip: 'Nothing was taken.' };
    };
    const cards = {
      'wrong-pin': () => Object.assign({ tone: 'warn', title: 'WRONG PIN',
        reason: ((e.tries === 1) ? '1 try left.' : (e.tries + ' tries left.')) + safe,
        // the last one is said for what it is: the card blocks itself for good
        chip: e.tries === 1 ? 'One more wrong PIN blocks this card for good.' : '' }, again),
      'blocked': () => ({ title: 'CARD BLOCKED',
        reason: 'Too many wrong PINs. This card can no longer pay until its owner sets a new PIN on it.' }),
      'not-enough': () => ({ tone: 'warn', title: 'NOT ENOUGH ON THE CARD',
        reason: 'It holds ' + this.fcSats(e.balance, u) + '.' + safe }),
      'other-mint': () => ({ tone: 'warn', title: 'A DIFFERENT MINT', reason: said }),
      /* A card asked for the other kind of money than it holds, said before any PIN or signature. A dollar card at a till
       * taking bitcoin; a bitcoin card at a till taking dollars (`satsNo` says why it was not asked for its sats); and either,
       * loaded from the other balance, in the wallet's own words. */
      'wrong-unit': () => (u === 'usd'
        ? { tone: 'warn', title: 'THIS CARD HOLDS DOLLARS',
            reason: opt.paying ? 'This card holds dollars here, not bitcoin. Ask for dollars, and it pays.' : said, chip: 'Nothing was taken.' }
        : opt.cross ? { tone: 'warn', title: 'THIS CARD HOLDS BITCOIN',
            reason: 'This is not the dollar card that was tapped first. It holds bitcoin: press CARD again, and it pays the bitcoin asked.', chip: 'Nothing was taken.' }
        : opt.dollarAsk ? Object.assign({ tone: 'warn' }, satsNo())
        : { tone: 'warn', title: 'THIS CARD HOLDS BITCOIN', reason: said, chip: 'Nothing was taken.' }),
      // a dollar card asked for sats where the phone being paid cannot work out the dollars for them (`fcOtherUnit`)
      'other-unit': () => ({ tone: 'warn', title: 'THIS CARD HOLDS DOLLARS', reason: said, chip: 'Nothing was taken.' }),
      /* Software 1.23, a card of dollars and bitcoin, in the wallet's own words (08a-flashcard.js, `cardRefused`): a limit and no rate to
       * weigh bitcoin at; both currencies asked at once; money of the currency the card keeps that kind as the other of; no room for
       * another kind; a new currency only its owner may start; and a limit in sats with no price to turn it into dollars. */
      'no-rate': () => ({ tone: 'warn', title: 'CARD NEEDS ITS OWNER', reason: said, chip: opt.taken ? 'Nothing was taken.' : '' }),
      'two-units': () => ({ tone: 'warn', title: 'ONE CURRENCY AT A TIME', reason: said, chip: '' }),
      'unit-taken': () => ({ tone: 'warn', title: 'THE OTHER CURRENCY', reason: said, chip: '' }),
      'table-full': () => ({ tone: 'warn', title: 'NO ROOM ON THE CARD', reason: said, chip: '' }),
      'owner-unit': () => ({ tone: 'warn', title: 'A NEW CURRENCY', reason: said, chip: '' }),
      'no-price': () => ({ tone: 'warn', title: 'NO BITCOIN PRICE', reason: said, chip: '' }),
      // a dollar card at a mint that does not issue dollars (now, or at all): the wallet's words name the mint
      'no-dollars-here': () => ({ tone: 'warn', title: 'NO DOLLARS AT THIS MINT', reason: said, chip: 'Nothing was taken.' }),
      // with no route, a dollar card is checked against the mint's dollar keys this phone has seen; it has seen none
      'offline-no-keys': () => ({ tone: 'warn', title: 'CARD NOT TAKEN', reason: said,
        chip: 'Nothing was taken. Take this payment when this phone is online.' }),
      /* Online, a card whose money is a day from its date; offline, one with under a week left, which the wallet says in
       * its own words (the owner can take it back after the date, and a payment kept here must settle before then). */
      'renew': () => ({ tone: 'warn', title: 'CARD NEEDS RENEWING',
        reason: /offline/.test(said) ? said + safe : 'Its owner must renew it with their own phone before it can pay.' }),
      'past-date': () => ({ tone: 'warn', title: 'ITS DATE HAS PASSED',
        reason: 'This phone can take this card’s money back with no card.',
        chip: 'MENU › RESTORE LOST CARD' }),
      'empty': () => ({ tone: 'warn', title: 'NO MONEY ON THIS CARD',
        reason: 'It has not been set up, or nothing has been put on it.' }),
      'not-a-card': () => ({ title: 'NOT A FOXY CARD', reason: said }),
      // this phone's store too full for what the tap writes once the card has signed: refused before the card was asked anything
      'storage-full': () => ({ tone: 'warn', title: 'PHONE STORAGE FULL', reason: said, chip: 'Nothing was taken.' }),
      'no-route': () => Object.assign({ tone: 'warn', title: opt.taken ? 'NOT PAID' : 'NO CONNECTION',
        reason: 'The mint could not be reached.' + safe }, again),
      /* A till, and the card's day has too little left for this payment: said
       * before the PIN was sent, in the amounts a person reads, with when the
       * day turns. */
      'limit': () => ({ tone: 'warn', title: 'OVER THE CARD’S DAILY LIMIT',
        reason: (e.left !== undefined ? this.fcLimitRefusal(e) : said) + safe }),
      /* The same for the limit on one tap: said before the PIN was sent, with
       * what to do about it, which is to charge it in parts. */
      'tap-limit': () => ({ tone: 'warn', title: 'OVER THE CARD’S PER TAP LIMIT',
        reason: (e.left !== undefined ? this.fcTapRefusal(e) : said) + safe }),
      /* A card topped up with under ten days left on its money holds money of two dates,
       * and one signature is for one of them: said before the PIN was sent,
       * with the most it can pay at once. */
      'two-dates': () => ({ tone: 'warn', title: 'TAKE IT IN TWO PARTS',
        reason: 'This card’s money was put on it at two different times, and one payment can use only one of them. The most it can pay at once is '
          + this.fcSats(e.most, u) + '.' + safe }),
      /* A card whose money is in more pieces than it signs for in one go:
       * said before the PIN was sent, with the most it can pay at once, where
       * that is known; and as the card's own refusal where it is the card
       * that said so. */
      'too-many': () => ({ tone: 'warn', title: 'TAKE IT IN PARTS',
        reason: (e.most > 0 ? 'This card can pay ' + this.fcSats(e.most, u) + ' at once. Its money is in more pieces than it signs for in one go.'
          : 'That is more pieces than the card signs for at once.') + safe }),
      'old-card': () => ({ tone: 'warn', title: 'NOT ON THIS CARD',
        reason: /limit on one tap/.test(said) ? 'This card’s software has no per tap limit.' : said }),
      // software 1.21: a card with no PIN takes nothing; 1.22: a card that paid in this tap shows no history in it, and one with an owner none to a guest
      'pin-first': () => ({ tone: 'warn', title: 'THIS CARD HAS NO PIN', reason: said }),
      'paid-here': () => ({ tone: 'warn', title: 'THE CARD HAS JUST PAID', reason: said }),
      // software 1.22: the card would not take change a till bound to another key, under the mint's (`fcMendRun`); and what is given up
      'mend-refused': () => ({ tone: 'warn', title: 'CHANGE NOT PUT ON', reason: said }),
      'nothing-owed': () => ({ tone: 'warn', title: 'NOTHING TO GIVE UP', reason: said }),
      'has-owner': () => ({ tone: 'warn', title: 'THIS CARD HAS AN OWNER', reason: said }),
      'keep-holding': () => Object.assign({ tone: 'warn', title: 'HOLD IT LONGER', reason: said }, again),
      // software 1.16: a card with no PIN has no limit for payments without one; a card that has a PIN cannot be given another
      'no-pin': () => ({ tone: 'warn', title: 'THIS CARD HAS NO PIN', reason: said }),
      'has-pin': () => ({ tone: 'warn', title: 'THIS CARD HAS A PIN', reason: said }),
      // a PIN is wanted where none was given (the card's word at a tap that was not a payment's)
      'pin-needed': () => ({ tone: 'warn', title: 'THE CARD WANTS ITS PIN', reason: said + safe }),
      'not-owner': () => ({ tone: 'warn', title: 'NOT THIS PHONE’S CARD',
        reason: 'This phone does not hold the seed phrase this card was set up with, so it cannot change the card’s PIN or limit.',
        chip: 'Restore that seed phrase in Foxy, on this phone or another, to do it.' }),
      'no-owner': () => ({ tone: 'warn', title: 'THIS CARD HAS NO OWNER', reason: said }),
      'set-up': () => ({ tone: 'warn', title: 'THIS CARD HAS AN OWNER', reason: said }),
      'no-owner-key': () => ({ tone: 'warn', title: 'NO SEED PHRASE', reason: said }),
      'wrong-signer': () => ({ title: 'NOT A FOXY CARD', reason: said }),
      'no-time': () => ({ tone: 'warn', title: 'THE CARD HAS NO TIME', reason: said }),
      'gone': () => Object.assign({ tone: 'warn', title: 'THE CARD LEFT TOO SOON',
        reason: 'Hold it still until the phone says to remove it.' + safe }, again),
      /* The card left part-way through signing: nothing moved, and what it did
       * sign goes back on it at its next tap (with no PIN), or, where the mint
       * has not answered yet, once it has. Said by what the person was doing. */
      /* Not made yet (no route to the mint): there is nothing to write, and a
       * TAP CARD here only found "nothing was waiting for this card". */
      'interrupted': () => Object.assign({ tone: 'warn', title: opt.paying ? 'NOT PAID' : 'THE CARD LEFT TOO SOON',
        reason: 'The card was taken away too soon. ' + (opt.paying ? 'Nothing was paid. ' : 'Nothing was taken. ')
          + (e.made === false
            ? 'What it signed for is made ready to go back on it once this phone reaches the mint, and the card\u2019s next tap here puts it back.'
            : 'Tap it again to put back the ' + this.fcSats(e.owed, u) + ' it signed for. ' + this.fcNoPinWords()),
        chip: 'Hold it still until the phone says to remove it.' },
        e.made === false ? { shut: { label: 'OK' } } : { retry: 'TAP CARD', go: () => this.fcWriteAsk({}), shut: { label: 'LATER' } }),
      'spent': () => ({ title: opt.taken ? 'NOT PAID' : 'ALREADY SPENT',
        reason: 'The mint says this card’s money was already spent.' }),
      'no-nfc': () => ({ tone: 'warn', title: 'NO CARD READER', reason: 'This phone cannot read a card.' }),
      'full': () => ({ tone: 'warn', title: 'THE CARD IS FULL', reason: said }),
      // offline, only an exact set of the card's pieces can be taken: said before the PIN, so nothing was taken
      'inexact': () => ({ tone: 'warn', title: 'NO CHANGE WHILE OFFLINE', reason: said + safe }),
      'bad-pieces': () => ({ tone: 'warn', title: 'THE CARD’S PIECES ARE NOT GOOD', reason: said }),
      /* With no route, a card pays only with money it proves with the mint's own proofs (software 1.20, format 4): the
       * card is too old for that, cannot prove it, or holds money the mint never signed. All three are said before the
       * PIN, so nothing was taken; the first two can still pay this phone once it is online. */
      'offline-old': () => ({ tone: 'warn', title: 'TOO OLD TO PAY OFFLINE', reason: said + safe }),
      // (or what it signed before it left, which is not "nothing taken": that goes back on it once this phone is online)
      'offline-unproven': () => ({ tone: 'warn', title: 'CANNOT PROVE ITS MONEY', reason: said + (e.held ? '' : safe) }),
      'fake': () => ({ title: 'NOT THE MINT’S MONEY', reason: said }),
      /* The mint refused after the card had signed. The card burned the pieces
       * when it signed, so it has to be tapped again to have them put back (the
       * next tap clears the places and loads the same pieces). Its day stays
       * charged: only the owner's phone can give a day back. */
      // put back in the same sheet already: said, with nothing more to do
      'putback': () => (e.putBackDone > 0) ? ({ tone: 'warn', title: opt.paying ? 'PAYMENT FAILED' : 'NOT TAKEN OFF',
        reason: 'The mint refused it. ' + this.fcSats(e.putBackDone, u) + ' is back on the card.',
        chip: e.limited ? 'The card\u2019s daily limit stays used for it.' : '' }) : ({ tone: 'warn', title: opt.paying ? 'PAYMENT FAILED' : 'NOT TAKEN OFF',
        reason: 'The mint refused it, and the card had already signed for it. Tap the card again to put ' + this.fcSats(e.owed, u) + ' back on it.',
        chip: e.limited ? 'The card’s daily limit stays used for it.' : '',
        retry: 'TAP CARD', go: () => this.fcWriteAsk({}), shut: { label: 'LATER' } }),
      'misfit': () => ({ tone: 'warn', title: 'NOT AT THIS MINT', reason: said, chip: 'Nothing was taken.' }),
      'misfit-kept': () => ({ tone: 'warn', title: 'KEPT FOR THE CARD', reason: said }),
      'locked': () => ({ tone: 'warn', title: 'THE CARD IS LOCKED',
        reason: opt.resetting ? said : 'Nothing more can be written to it. It can still pay.' }),
      // RESET CARD (software 1.17): the wallet's own words, written for the person
      'has-money': () => ({ tone: 'warn', title: 'MONEY ON THE CARD', reason: said }),
      'change-owed': () => Object.assign({ tone: 'warn', title: 'THE CARD IS OWED CHANGE', reason: said }, again),
      'unsettled': () => Object.assign({ tone: 'warn', title: 'MONEY ON ITS WAY', reason: said }, again),
      'too-soon': () => ({ tone: 'warn', title: 'NOT YET',
        reason: e.date ? 'This card can be taken back after ' + this.fcDay(e.date) + '.' : said }),
      'nothing': () => ({ tone: 'warn', title: 'NOTHING WAS LEFT ON IT', reason: said }),
      // paying out of this phone from a card's screen, and another card was held to it (08a-flashcard.js, `o.only`)
      'wrong-card': () => ({ tone: 'warn', title: 'A DIFFERENT CARD', reason: said }),
      // a card at another mint whose pieces cost more to spend there than its confirmation showed (`fcXmPay`): refused before it signed
      'fee-more': () => ({ tone: 'warn', title: 'NOT PAID', reason: said }),
      /* Paying out of this phone from a card, and the payment was not made after the card had paid this phone for it: what it
       * paid goes back on it, as a till's refusal does, at its next tap (`fcOutBack`). With no route yet, once there is one. */
      'not-paid-out': () => (e.made ? {
        tone: 'warn', title: 'NOT PAID',
        reason: said + ' ' + this.fcSats(this.fcAmt(e), u) + ' goes back on the card: tap it to put it back.',
        chip: this.fcNoPinWords(),
        retry: 'TAP CARD', go: () => this.fcOutWrite(), shut: { label: 'LATER' },
      } : {
        tone: 'warn', title: 'NOT PAID',
        reason: said + ' ' + this.fcSats(this.fcAmt(e), u) + ' goes back on the card once this phone reaches the mint, and the card\u2019s next tap here puts it back.',
        shut: { label: 'OK' },
      }),
    };
    const spec = (cards[kind] || (() => ({ tone: 'warn', title: 'THAT DID NOT WORK', reason: said + safe })))();
    this.haptic && this.haptic('error');
    this.blockedCard('fc-' + (kind || 'failed'), spec);
  }

  /* A time as a person reads it on a card's day: "3:40 PM" for today, and
   * with the day after it for any other. Written out here and not left to the
   * phone's region, as fcDay is. */
  fcWhen(secs) {
    const d = new Date((Number(secs) || 0) * 1000);
    const h = d.getHours();
    const clock = ((h % 12) || 12) + ':' + ('0' + d.getMinutes()).slice(-2) + (h < 12 ? ' AM' : ' PM');
    const t = new Date();
    return (d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate())
      ? clock : clock + ', ' + this.fcDay(secs);
  }

  /* When, as the card's screen says it under its title: the time of day in the phone's own habit (twelve hours or twenty-four,
   * `txClock`), "11:42am", and the day after it for any other than today. */
  fcAt(ms) {
    const d = new Date(Number(ms) || 0);
    const h = d.getHours(), m = d.getMinutes();
    const mm = (m < 10 ? '0' : '') + m;
    let clock = this.txClock ? String(this.txClock(d)) : (((h % 12) || 12) + ':' + mm + (h < 12 ? ' AM' : ' PM'));
    clock = clock.replace(/\s*([AP])M$/i, (x, p) => p.toLowerCase() + 'm');
    const t = new Date();
    return (d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate())
      ? clock : clock + ', ' + d.getDate() + ' ' + this.FC_MONTHS[d.getMonth()];
  }

  /* What a till is told when the card's day cannot cover the payment: how much
   * the card can still spend today and when its day turns. `e.left`, `e.turns`
   * and `e.limit` are the card's own, read before the PIN was sent. */
  /* Why a payment was over the limit on one tap: what the tap has left where
   * some of it is used (a tap is ten seconds to the card), or the limit. */
  fcTapRefusal(e) {
    // a card whose limit on one tap is waited for: said as the wait it would be, and what can be taken instead
    // the card does not say what its limit is to a till: only that this was too long to hold it for
    if (e.paced && e.hidden) return 'To pay this the card would have to be held longer than a tap lasts. It has a per tap limit: take it in smaller parts.';
    if (e.paced) {
      return 'To pay this the card would have to be held for ' + e.wait + ' seconds, which is longer than a tap lasts. Its per tap limit is '
        + this.fcBoth(e.limit, this.fcUnitOf(e)) + ': take ' + this.fcBoth(e.left, this.fcUnitOf(e)) + ' or less at a time.';
    }
    if (e.turns > 0 && e.left < e.limit) {
      return 'The card has ' + this.fcBoth(e.left, this.fcUnitOf(e)) + ' left in this tap. Tap it again in ten seconds.';
    }
    return 'The card pays at most ' + this.fcBoth(e.limit || e.left, this.fcUnitOf(e)) + ' in one tap, and this payment is more than that. Charge it in parts, a tap for each.';
  }

  fcLimitRefusal(e) {
    if (e.turns > 0 && e.left < e.limit) {
      return 'The card can still spend ' + this.fcBoth(e.left, this.fcUnitOf(e)) + ' today. Its day turns at ' + this.fcWhen(e.turns) + '.';
    }
    return 'The card can spend ' + this.fcBoth(e.limit || e.left, this.fcUnitOf(e)) + ' in a day, and this payment is more than that.';
  }

  /* The card has signed and the mint has not answered.
   *
   * The one state in which nobody knows yet: the card has marked its pieces
   * spent, and whether they became this phone's is the mint's to say. Asked
   * again every five seconds, a dozen times (FC_CHECK_*; the screen behind
   * the card sheet says CHECKING and STILL CHECKING by the same wait), and
   * never past this screen: the wallet asks again by itself whenever it
   * connects, and the payment is in HISTORY when it lands. */
  fcChecking(id, o) {
    const W = this.fcW();
    const opt = o || {};
    let tries = 0;
    clearTimeout(this._fcCheckT);
    this.stageScreen('cardChecking', {
      art: 'card', title: 'CHECKING',
      body: 'The card has signed and the mint has not answered yet.',
      dots: true, forMs: 70000, button: 'CLOSE',
      // (a card at another mint: the asking is over, and this phone goes home, `fcXmHome`)
      go: () => { clearTimeout(this._fcCheckT); if (opt.xm) this.fcXmHome(); },
    });
    const settled = (how, row) => {
      clearTimeout(this._fcCheckT);
      this.hideStage('cardChecking');
      /* A card at another mint: what the mint's answer comes to has been worked out there (`cardSettle`), and this phone goes home
       * before it is said. Its pieces were held for this phone's invoice and never melted, so a late "paid" is the card's, back on
       * it at its next tap, as a payment out of a card's own screen. */
      if (opt.xm) this.fcXmHome();
      /* Paying out of this phone: the mint's answer came too late, and the payment it was for was never made. The wallet has
       * owed all of it back to the card (21a-flashcard.js, `cardSettle`), and its next tap puts it back. */
      /* The same for a dollar card's cents held for this phone's own bitcoin invoice (`opt.btc.holding`): the invoice was never
       * paid with them, so they went back to the card too, and are said so. */
      const outKey = opt.send ? opt.send.key : (opt.btc && opt.btc.holding) ? opt.btc.key : opt.xm ? opt.xm.key : '';
      if (how === 'paid' && outKey) {
        const mine = this.fcOwed().filter((x) => x.key === outKey);
        const owed = mine.reduce((n, x) => n + x.amount, 0);
        this.fcFailed({ card: 'not-paid-out', message: 'The mint answered too late, so nothing was paid.', amount: owed || (row && row.change) || 0,
                        unit: (mine[0] && mine[0].unit) || this.fcUnitOf(row || opt.send || { unit: 'usd' }), made: owed > 0 }, opt);
        return;
      }
      if (how === 'paid') {
        if (opt.share) this.fcShareMoved(opt.share, id);
        /* A dollar card paid a dollar receive in cents, straight into this phone's dollars: there is no invoice for its sats to
         * pay (`fcMoved`). And one paid for sats asked has its cents pay the sats invoice (`fcBtcPay`): the cents are not announced. */
        if (opt.usd && this.fcUnitOf(row) === 'usd') { opt.usd = null; this._fcUsd = null; }
        if (opt.usd) this.fcUsdHush(id);
        if (opt.btc && this.fcUnitOf(row) !== 'usd') opt.btc = null;
        if (opt.btc) this.fcBtcHush(id);
        this.fcMoved(opt);
        // the mint's answer came late, and the change it made waits for the card's second tap (RECEIVE)
        if (opt.paying && row && row.change > 0 && !row.refund) this.fcReceiveNow(row.change, this.fcAmt(row), { unit: this.fcUnitOf(row) });
        return;
      }
      if (how === 'spent') { this.fcFailed({ card: 'spent' }, { taken: opt.taken }); return; }
      if (how === 'putback') { this.fcFailed({ card: 'putback', owed: row && row.owed, limited: row && row.limited }, opt); return; }
      if (how === 'bad') { this.fcFailed({ card: 'bad-pieces', message: 'The card gave pieces the mint did not sign. Nothing was paid.' }, opt); return; }
      this.blockedCard('fc-still', { tone: 'warn', title: 'STILL CHECKING',
        reason: 'The mint has not answered. Foxy keeps asking, and this will be in HISTORY when it does.',
        chip: opt.paying ? 'It is not paid until then.' : '' });
    };
    const ask = () => {
      // closed, or timed out: the asking stops with the screen
      if (!this.stageUp('cardChecking')) return;
      W.cardSettle().then((rows) => {
        if (!this.stageUp('cardChecking')) return;
        const mine = (rows || []).filter(r => r.id === id)[0];
        if (mine && mine.state === 'paid') return settled('paid', mine);
        if (mine && mine.state === 'spent') return settled('spent');
        if (mine && mine.state === 'putback') return settled('putback', mine);
        if (mine && mine.state === 'bad') return settled('bad');
        if (!mine) {
          // answered by the wallet's own asking, between two of ours: the entry says which way, and in which unit it was paid
          return W.transactions(50).then((list) => {
            const t = (list || []).filter(x => x.hash === id)[0];
            return settled(t ? 'paid' : 'spent', t ? { unit: t.unit === 'usd' ? 'usd' : 'sat', amount: t.unit === 'usd' ? t.amount : t.sats } : null);
          });
        }
        tries += 1;
        if (tries >= this.FC_CHECK_ASKS) return settled('waiting');
        this._fcCheckT = setTimeout(ask, this.FC_CHECK_EVERY_MS);
        return null;
      }, () => settled('waiting'));
    };
    this._fcCheckT = setTimeout(ask, this.FC_CHECK_FIRST_MS);
  }

  /* Money has moved by a card and the screens catch up. A payment is
   * announced by the history pass like any other; a holder's own move is said
   * by the flow that made it (16-history-lists.js keeps the pass quiet). */
  fcMoved(o) {
    const opt = o || {};
    /* A dollar receive paid by a bitcoin card is not over when the card has paid: the receive screen stays, watching its
     * invoice, and the sats pay that invoice (`fcUsdPay`). A dollar card paid it in cents, and there is no invoice in it
     * (`fcPayRun` puts `usd` down for that). */
    if (opt.usd && opt.usd.bolt11) { this.fcUsdPay(opt.usd); return; }
    // the mirror: a dollar card paid a bitcoin receive's invoice in cents, which pay that invoice (`fcBtcPay`)
    if (opt.btc && opt.btc.bolt11) { this.fcBtcPay(opt.btc); return; }
    // a card at another mint: its pieces held there pay this phone's own invoice from there (`fcXmMelt`)
    if (opt.xm && opt.xm.bolt11) { this.fcXmMelt(opt.xm); return; }
    if (opt.paying && this.state.screen === 'confirm') this.closeReceive();
    if (opt.paying && this.noteReceived) this.noteReceived();
    this.refreshBalance();
    this.loadHistory();
    if (opt.paying && this.tidyChangeNow) this.tidyChangeNow();
    if (!opt.paying && opt.done) opt.done(opt.after);
  }

  /* The entry that will pay a share of a split bill, noted on the share's row in the bill's ledger (`splitNoteCard`) as soon as it has a
   * name: when the card has signed, before the mint has answered, or when the card has paid while this phone is offline. However late
   * that entry settles (the mint's answer after CHECKING was closed, or found by the wallet's own settling; a card's payment taken
   * offline is received at once), the ledger ticks the share then, and the screens follow it as they follow a share paid by its invoice (`spSyncPaid`). A failure to
   * note it does not stop the payment: the share is then ticked only if the mint answers while the screen is waiting (`fcShareMoved`). */
  fcShareNote(share, hash) {
    const W = this.fcW();
    try {
      if (W && W.splitNoteCard) W.splitNoteCard(share.hash, hash);
    } catch (e) {
      console.warn('[foxy] a share’s card payment could not be noted on its row:', (e && e.message) || e);
    }
  }

  /* A share of a split bill, paid by a card: the mint has given this phone its pieces (`hash`: the payment's entry).
   *
   * The bill's own screens say a share is paid: its row turns green on COLLECTING, and EVERYONE HAS PAID sums them
   * up. So the payment is not announced as well, as a share paid over the tap is not (12-receive.js,
   * `requestPaidHere`): its entry is marked as announced before a history pass can queue it, and one already queued,
   * or held for the change, is let go. Its entry stays in HISTORY as a payment from a card, as the receive screen's
   * does. Then the share is ticked, which also ends the asking about its invoice, and the screen moves on to the next
   * payer (17-split-bill-and-copy.js).
   *
   * A bill that is no longer being collected (stopped by hand while the mint was asked) has no share to tick: the
   * payment is an ordinary one, with its own PAYMENT RECEIVED. */
  fcShareMoved(share, hash) {
    const W = this.fcW();
    try {
      const bill = W && (W.splitRecord ? W.splitRecord() : (W.splitPending && W.splitPending()));
      const row = bill && bill.rows ? bill.rows.filter((r) => r && r.hash === share.hash)[0] : null;
      if (!row) return;
      const entry = String(hash || '');
      if (entry) {
        this.txIsNew(entry);
        this._paidQueue = (this._paidQueue || []).filter((q) => !(q && q.hash === entry));
        if (this._heldConfirm && this._heldConfirm.hash === entry) this._heldConfirm = null;
      }
      // the next share is a new tap, not this one's radio (a fresh screen arms afresh)
      if (this.state.tapArmed) this.setState({ tapArmed: false });
      if (!row.paid) this.spMarkPaid(share.idx, share.hash);
      this.spPaidOnScreen(share.idx, 'by card');
    } catch (e) {
      /* The payment is made whatever this comes to, and what is left of its handling (the change, the confirmation) goes
       * on after it. The ledger is the bill's truth, and the next history pass puts the screen right by it (`spSyncPaid`). */
      console.warn('[foxy] a share paid by a card could not be ticked on screen:', (e && e.message) || e);
    }
  }

  /* ---- being paid by a card (the receive screen's CARD button) -------------- */

  payByCard() {
    const s = this.state;
    // a receive into the dollar balance: a dollar card pays its cents, a bitcoin card the dollar invoice's sats (`payUsdByCard`)
    if (s.recvUnit === 'usd' && this.walletNow && this.walletNow('receive') === 'usd') { this.payUsdByCard(); return; }
    const W = this.fcW();
    if (!W) return;
    const sats = (!s.invoiceIsAddress && W.amountOf && W.amountOf(s.invoice)) || this.wantedSats();
    if (!(sats > 0)) { this.toast('Enter an amount first.', true); return; }
    this.fcPayBegin(sats);
  }

  /* ---- a dollar receive, paid by a card -----------------------------------------------------------------------------
   *
   * A card holds one kind of money, and which is known only once it is tapped, so the till asks in both where it can and the
   * card pays the one it holds, in one tap (08a-flashcard.js, `cardAsks`).
   *
   * A dollar card pays the cents asked, straight into this phone's dollars: a dollar is a dollar, and no invoice, no price
   * and no melt come into it. It needs no code on screen, so CARD is there before the mint has made the invoice, and with no
   * route (24-render-receive-and-send.js, `recvCardShown`); with no route the card signs its cents over to this phone as a
   * bitcoin card signs its sats (`cardKeepSigned`).
   *
   * A bitcoin card is asked for sats as well, where there are sats to ask. Online, the dollar invoice on the receive screen is a
   * Lightning invoice the mint made for the cents asked, naming its own number of sats at the mint's rate: the card pays
   * exactly that number, read off the invoice as every invoice's amount is read (`amountOf`), and never a figure this phone
   * works out at its own price, since a till that converted would take the wrong amount whenever its price and the mint's
   * differ. The tap is the bitcoin receive's in every way (the sheet, the PIN, the limits, the refusals, the change), and then
   * the sats it brought pay the dollar invoice, from this phone, as any payment is made (`fcUsdPay`). The mint says that
   * invoice is paid, and the dollars land exactly as they land for a dollar invoice paid from anywhere else (12-receive.js,
   * `usdInvoiceUp`).
   *
   * The card's money here is at this phone's own mint (one at another mint pays the code from its own mint instead, with the
   * charge shown first: `fcXmBegin`), so the invoice the sats pay is one the same mint made. That is the common case of the mint
   * paying its own invoice, which it settles in its own books with no Lightning payment in between.
   *
   * Offline there is no invoice to pay. Where this build can turn sats into dollars later (`W.convertOne`, a wallet with
   * two balances), a bitcoin card is asked for the sats the dollars come to at this phone's own last price, and that price is
   * kept with the payment (`terms`) so the sats become dollars once the payment has settled with the mint. With no price, one
   * too old, or no such build, a bitcoin card is asked for nothing it holds, and is told why once it is read (`fcFailed`,
   * before its PIN); a dollar card pays as ever. With the card's switch off, the words are the ones a card payment with no
   * connection always has.
   *
   * The invoice lives as long as the mint said it would (the clock on screen, `recvExpiresAt`), and a melt sent after
   * that is refused. A tap, a PIN and the mint's answer take seconds, so a code with less than a quarter of a minute left
   * is not handed to a card: a new one is asked for first, and CARD pressed again pays that. */
  payUsdByCard() {
    const s = this.state;
    const W = window.FoxyWallet;
    /* A card flow already going (a sheet up, its PIN asked, a card asking to be tapped again): CARD starts no second one. The
     * wait's own timer pressed CARD again after the person had, and two sheets were begun for one code, the second taking over
     * `_fcUsd` from the payment the first was making. */
    if (this.cardFlowBusy && this.cardFlowBusy()) { clearTimeout(this._fcUsdCodeWaitT); this._fcUsdCodeWait = null; return; }
    // the cents asked, as the receive screen holds them, or as typed while the mint is still making the code
    const cents = Math.round(Number(s.recvAmount != null ? s.recvAmount : (this.centsTyped ? this.centsTyped() : 0)) || 0);
    if (W && W.cardOnline && !W.cardOnline()) {
      if (!(W.cardOffline && W.cardOffline()) || !this.fcW()) { this.offlineNo('A card payment'); return; }
      if (!(cents > 0)) { this.toast('Enter an amount first.', true); return; }
      const lp = (W.lastPrice && W.lastPrice()) || { rate: 0, at: 0, ageMs: 0 };
      const old = !(lp.rate > 0) || !!(W.priceTooOld && W.priceTooOld(lp.at));
      // (no invoice to melt: `usd` names the cents alone, and a bitcoin card's sats are kept as bitcoin until they settle and convert)
      const usd = { cents, bolt11: '', hash: '', sats: 0 };
      if (!W.convertOne || old) {
        // why a bitcoin card is not asked for sats here, said if one is tapped (`fcFailed`)
        usd.satsWhy = !W.convertOne ? 'build' : lp.rate > 0 ? 'old' : 'none';
        usd.price = lp;
        this.fcPayStart(0, true, null, null, usd);
        return;
      }
      const sats = Math.round(cents / 100 / lp.rate * 1e8);
      // the price is this phone's own (`own`), which the payment's screens and history say it is
      this.fcPayStart(sats, true, null, null, usd, { usd: cents, rate: lp.rate, ageMs: lp.ageMs, seenAt: lp.at, convert: true, own: true });
      return;
    }
    const bolt11 = s.invoiceIsAddress ? '' : String(s.invoice || '');
    /* The code still being made by the mint (12-receive.js, `_usdCodeMaking`; or asked again, `_requoting`): a bitcoin card
     * needs it, and reading the card now refused it ("tap it again when the dollar code is on screen"), as the owner found
     * pressing CARD the moment the screen opened. Wait for the code, two and a half seconds at most (the mint answers in about
     * one; a dollar card needs no code, and is not kept waiting on a mint that is slow), then go on as before. The wait is this
     * receive's (`run`): one begun for another, or for this one and left when its screen was, is not this one's, and its start
     * no longer cuts this one short. */
    if (!bolt11 && (this._usdCodeMaking === this._invoiceRun || this._requoting)) {
      const was = this._fcUsdCodeWait;
      if (!was || was.run !== this._invoiceRun) {
        this._fcUsdCodeWait = { at: Date.now(), run: this._invoiceRun };
        this.toast('One moment: the code is being made.', false);
      }
      const wait = this._fcUsdCodeWait;
      if (Date.now() - wait.at < 2500) {
        clearTimeout(this._fcUsdCodeWaitT);
        this._fcUsdCodeWaitT = setTimeout(() => {
          // the receive screen left, or another receive on it: the wait is over, and nothing is pressed for it
          if (this.state.screen !== 'confirm' || this._invoiceRun !== wait.run) { if (this._fcUsdCodeWait === wait) this._fcUsdCodeWait = null; return; }
          this.payUsdByCard();
        }, 250);
        return;
      }
    }
    // past the wait, or none: its timer, if one is armed, would press CARD a second time
    clearTimeout(this._fcUsdCodeWaitT);
    this._fcUsdCodeWait = null;
    const sats = bolt11 && W && W.amountOf ? Math.round(Number(W.amountOf(bolt11)) || 0) : 0;
    // a code on screen that names no sats is not one to pay, nor to pay around
    if (bolt11 && !(sats > 0)) { this.toast('The invoice is still being made.', true); return; }
    if (!this.fcW()) return;
    if (this.offlineNow()) { this.offlineNo('A card payment'); return; }
    if (!(cents > 0)) { this.toast('Enter an amount first.', true); return; }
    const ends = Number(s.recvExpiresAt) || 0;
    if (bolt11 && ends && ends - Date.now() < 15000) {
      this.toast('This code has almost run out. A new one is being made; press CARD when it is up.', true);
      if (this.recvRequote) this.recvRequote(this._invoiceRun);
      return;
    }
    // no code yet: a dollar card needs none, and a bitcoin card is told to tap again once it is up
    if (!bolt11) { this.fcPayStart(0, false, null, null, { cents, bolt11: '', hash: '', sats: 0 }); return; }
    // the code on screen paid by a card already, its dollars landing: no second sheet for it (`fcUsdLanding`, as `fcPayBegin`)
    if (this.fcUsdLanding()) { this.toast('The card has paid this code. The dollars land in a moment.', true); return; }
    const usd = { bolt11, hash: String(s.invoiceHash || ''), cents, sats, run: this._invoiceRun, ends };
    // the code on screen is kept while the card pays it (`fcUsdHolds`), and not replaced when its minute runs out
    this._fcUsd = usd;
    this.fcPayStart(sats, false, null, null, usd);
  }

  /* Whether the dollar code `hash` is being paid by a card at this moment: tapped, its PIN asked for, waiting for the
   * mint, or its sats on their way to the invoice. The receive screen does not swap it for a new code meanwhile
   * (12-receive.js, `recvClockTick`), which would leave the sats paying a code nobody is watching. */
  /* Whether the dollar code on screen is being paid by a card's sats right now, or was paid moments ago and its dollars are
   * landing: melting, pending with the mint, or paid with the watch's twenty seconds running (`fcUsdPay`, `fcUsdLand`). */
  fcUsdLanding() {
    const u = this._fcUsd;
    const hash = this.state && this.state.invoiceHash;
    if (!u || !hash || u.hash !== hash || u.done) return false;
    /* Pending with the mint, and the wallet holds that melt no longer: the mint has answered (`fcUsdHolds` takes it from here). It is
     * not landing on the card's word: a melt that failed kept VERIFYING up, and CARD saying the code was paid, until the code's clock
     * ran out. */
    if (u.pending && !this.fcUsdInFlight(u)) {
      if (this.hideStage && (!this.stageUp || this.stageUp('paidCheck'))) this.hideStage('paidCheck');
      return false;
    }
    return !!(u.melting || u.pending || (u.landingUntil && u.landingUntil > Date.now()));
  }

  fcUsdHolds(hash) {
    // a card at another mint paying this very code from there (`fcXmPay`): kept until that payment is over
    const x = this._fcXmLive;
    if (x && hash && x.hash === hash) return true;
    const u = this._fcUsd;
    if (!u || !hash || u.hash !== hash || u.done) return false;
    /* Its sats' payment with the mint, unanswered: the code is the one being paid, and stays until the mint answers
     * (the wallet's own asking settles it). Answered, the screen's watch is asked at once, and has its twenty seconds. */
    if (u.pending) {
      if (this.fcUsdInFlight(u)) return true;
      u.pending = false;
      u.landingUntil = Date.now() + 20000;
      this.fcUsdLand(u);
    }
    // paid, and the watch about to say so: twenty seconds for the mint's answer, before a new code may be asked for
    if (u.landingUntil && Date.now() < u.landingUntil) return true;
    return !!u.melting || this.cardFlowBusy() || !!(this.stageUp && this.stageUp('cardChecking'));
  }

  /* What the screen behind the card's sheet says the payment is: the dollars asked, with the sats the card pays under
   * them, for a dollar receive; and for every other payment what it always said. */
  /* An offline dollar receive (`terms`, from `payUsdByCard`) is said the same way, in the dollars asked: it has no invoice. */
  /* A dollar receive asks a bitcoin card for sats only where there are sats to ask (`payUsdByCard`): with none, nothing is
   * under the dollars. And a dollar card asked for sats (`fcOtherUnit`): the cents it pays, with the sats asked under them
   * and whose price made the one of the other, and the sheet saying what the hold pays. */
  fcPayLook(sats, usd, terms) {
    // a card at another mint: what it pays from there, its fee in it (`fcXmPay`)
    if (terms && terms.xm) {
      const u = terms.payUnit === 'usd' ? 'usd' : 'sat';
      const main = this.fcPrice(terms.pay, u);
      return { amount: main, amountSub: (u === 'sat' && main.charAt(0) === '$' ? this.fcSats(terms.pay) + ', ' : '') + 'its fee included',
               sheet: 'Hold to pay ' + main };
    }
    if (terms && terms.payUnit === 'usd') {
      return {
        amount: this.fcFig(terms.pay, 'usd'),
        amountSub: this.fcFig(terms.sats, 'sat') + (terms.online ? ' at ' + this.fcRateWho()
          : ' at this phone’s price, seen ' + this.agoWords(terms.ageMs)),
        sheet: 'Hold to pay ' + this.fcFig(terms.pay, 'usd'),
      };
    }
    const cents = usd ? usd.cents : (terms && terms.usd > 0) ? terms.usd : null;
    if (cents === null) return { amount: this.fcPrice(sats) };
    const look = { amount: '$' + this.usd(Math.round(Number(cents) || 0) / 100) };
    if (Math.round(Number(sats) || 0) > 0) look.amountSub = this.fcSats(sats);
    /* A card of software 1.23 whose holder chose its bitcoin to pay a dollar receive (`fcPayChoose`): the chosen currency's figure big,
     * the other under it. */
    const from = (this._fcFrom && Date.now() - this._fcFrom.at < 180000) ? this._fcFrom.unit : '';
    if (from === 'sat' && look.amountSub) return { amount: look.amountSub, amountSub: look.amount };
    return look;
  }

  // "Forge's rate": whose rate a dollar card's cents for sats are at, online (26i-swap.js, `swapRateWho`)
  fcRateWho() {
    if (this.swapRateWho) return this.swapRateWho();
    const who = String((this.mintName && this.mintName()) || 'the mint');
    return who + (/s$/i.test(who) ? '’' : '’s') + ' rate';
  }

  /* What a card is asked to pay, in each unit the till takes, for the wallet to pick by the card's unit (08a-flashcard.js,
   * `cardAsks`): the figures this payment's steps carry, as a list. A payment out of this phone from a card's screen (`send`)
   * is in the card's own unit. A dollar card asked for sats and agreed to (`terms.payUnit`) pays the cents agreed. A dollar
   * receive asks dollars, and sats as well where there are some to ask a bitcoin card for. Any other is the sats asked. */
  fcAsks(sats, usd, terms, send) {
    const n = Math.max(0, Math.round(Number(sats) || 0));
    if (send) return [{ unit: send.unit === 'usd' ? 'usd' : 'sat', amount: n }];
    // a card at another mint pays the total its mint quoted, in its own unit (`fcXmPay`)
    // (what the hold needs: the most it comes to with its mint's fee on the card's own pieces is `pay`, held to by `feeMost`)
    if (terms && terms.xm) return [{ unit: terms.payUnit === 'usd' ? 'usd' : 'sat', amount: Math.max(0, Math.round(Number(terms.want || terms.pay) || 0)) }];
    if (terms && terms.payUnit === 'usd') {
      // (what the payment keeps of the agreement: the figures and whose price, not the mint's quote, which `fcBtcPay` keeps)
      const kept = { payUnit: 'usd', pay: terms.pay, sats: terms.sats, rate: terms.rate, ageMs: terms.ageMs, seenAt: terms.seenAt, own: terms.own, convert: terms.convert };
      return [{ unit: 'usd', amount: Math.round(Number(terms.pay) || 0), terms: kept }];
    }
    if (!usd) return [Object.assign({ unit: 'sat', amount: n }, terms ? { terms } : {})];
    const asks = [{ unit: 'usd', amount: Math.round(Number(usd.cents) || 0) }];
    if (n > 0) asks.push(Object.assign({ unit: 'sat', amount: n }, terms ? { terms } : {}));
    return asks;
  }

  // the figure of this payment asked in `unit`, or the sats where none is (what a screen says the payment was)
  fcAskIn(unit, sats, usd, terms, send) {
    const a = this.fcAsks(sats, usd, terms, send).filter((x) => x.unit === unit)[0];
    return a ? a.amount : Math.round(Number(sats) || 0);
  }

  /* The card's sats are this phone's: their entry is not a payment of its own to announce (the dollars are), and they pay
   * the dollar invoice. */
  fcUsdHush(hash) {
    const entry = String(hash || '');
    if (!entry) return;
    this.txIsNew(entry);
    this._paidQueue = (this._paidQueue || []).filter((q) => !(q && q.hash === entry));
    if (this._heldConfirm && this._heldConfirm.hash === entry) this._heldConfirm = null;
  }

  /* The sats the card paid, paying the dollar invoice it was tapped for. The fee is asked first so that the payment's own
   * entry is known before it is written, and is not announced as a payment sent: it is the other half of the dollars
   * arriving. Paid, the receive screen's own watch of the invoice says PAYMENT RECEIVED in dollars. Not paid, the sats are
   * in the bitcoin balance, and said so. */
  fcUsdPay(usd) {
    const W = this.fcW();
    this.refreshBalance();
    this.loadHistory();
    if (!W || usd.melting || usd.done) return;
    console.log('[foxy] card: ' + usd.sats + ' sats taken; they pay the dollar invoice on screen');
    /* The code ran out while the card was read (a PIN, a card held, a tap finished later), or has too few seconds left
     * for the fee's question and the melt to reach the mint in time: the mint refuses a melt of it, so none is sent, and
     * the sats are this phone's bitcoin. The screen moves on to a new code. */
    if (usd.ends && usd.ends - Date.now() < 5000) {
      usd.done = true;
      this.fcUsdKept(usd, null, 'The code ran out while the card paid.');
      return;
    }
    usd.melting = true;
    /* VERIFYING over the code, from the card's payment until PAYMENT RECEIVED: the code stayed on screen for the seconds
     * the mint took and read as unpaid, and the owner tapped the card at it again. The receive's watch takes this screen
     * down as it says paid (12-receive.js); a refusal takes it down here, and a payment the mint has not answered keeps it
     * up with that said. */
    this.fcUsdVerifying(usd, 'The card paid ' + this.fcPaidWords(usd.sats, 'sat') + '. Foxy is confirming the payment with your mint.', 60000);
    const end = (paid) => {
      usd.melting = false;
      if (paid) usd.landingUntil = Date.now() + 20000; else usd.done = true;
      if (!paid && this.hideStage) this.hideStage('paidCheck');
      this.refreshBalance();
      this.loadHistory();
    };
    // with the mint and unanswered: the code is held until it answers (`fcUsdHolds`), and the dollars may yet land
    const waiting = () => {
      usd.melting = false;
      usd.pending = true;
      this.fcUsdVerifying(usd, 'The card paid ' + this.fcPaidWords(usd.sats, 'sat') + '. The mint has not answered yet; the dollars land when it does.', 120000);
      this.refreshBalance();
      this.loadHistory();
      this.fcUsdWaiting();
    };
    /* The mint's fee is paid from this phone's bitcoin, beside the card's sats. Where that cannot cover it, nothing is
     * sent, and the reason is said in plain words rather than as the wallet's sum of sats needed and held. */
    const noFee = 'This phone\u2019s bitcoin could not cover the mint\u2019s fee.';
    const quote = W.quoteFee ? W.quoteFee(usd.bolt11, { unit: 'sat' }) : Promise.resolve(null);
    Promise.resolve(quote).then((q) => {
      if (q && q.quote && q.quote.quote) this.txIsNew(String(q.quote.quote));
      const need = (q && W.payNeed) ? W.payNeed(q.amount, q.feeReserve, { unit: 'sat' }) : null;
      if (need && !need.ok) { const e = /** @type {any} */ (new Error(noFee)); e.plain = noFee; throw e; }
      return W.pay(usd.bolt11, () => {}, q ? { unit: 'sat', quote: q } : { unit: 'sat' });
    }).then((paid) => {
      if (paid && paid.hash) this.txIsNew(String(paid.hash));
      if (paid && paid.pending) { waiting(); return; }
      end(true);
      this.fcUsdLand(usd);
    }, (e) => {
      /* Not refused: with the mint, its answer not in (the payment is held, and the wallet's own asking settles it). The
       * sats are not in the bitcoin balance to be said to be, and the dollars may yet land. */
      if ((e && e.pending) || this.fcUsdInFlight(usd)) { waiting(); return; }
      end();
      this.fcUsdKept(usd, e, e && e.plain);
    });
  }

  /* The VERIFYING screen over the dollar code a card has paid (the receive's `paidCheck` stage, as a tap payment's
   * "Confirming payment"): what the card paid and what Foxy is waiting on. CLOSE shows the code again, where CARD says the code
   * is paid already (`fcUsdLanding`). Not drawn where the code is no longer the one on screen. */
  fcUsdVerifying(usd, body, forMs) {
    if (!usd || this.state.invoiceHash !== usd.hash || this.state.screen !== 'confirm') return;
    this.fcCardVerifying(body, forMs);
  }

  /* An amount a card paid, said dollars first with the sats in brackets ("$5.00 (₿6,182)"), as the owner reads figures; sats alone
   * where this phone has no price. A dollar card's cents are dollars alone. */
  fcPaidWords(amount, unit) {
    if (unit === 'usd') return this.unitFigure(amount, 'usd');
    const m = (this.px && this.px() > 0 && this.money) ? this.money(amount) : null;
    return (m && m.main && /\$/.test(m.main)) ? m.main + ' (' + this.fcSats(amount) + ')' : this.fcSats(amount);
  }

  fcCardVerifying(body, forMs) {
    const o = { art: 'phone', title: 'Verifying', dots: true, forMs: forMs || 60000, body, button: 'CLOSE', go: () => {} };
    // (the tap screens' `waitingScreen` where the app has it; the stage itself where a page has only the card's methods)
    if (this.waitingScreen) this.waitingScreen('paidCheck', o);
    else if (this.stageScreen) { console.log('[foxy] blocked: paidCheck \u2014 ' + body); this.stageScreen('paidCheck', o); }
  }

  // whether the wallet still holds a melt of this dollar invoice whose outcome the mint has not given
  fcUsdInFlight(usd) {
    const W = window.FoxyWallet;
    const want = String((usd && usd.bolt11) || '').toLowerCase();
    if (!want || !W || !W.pendingMelts) return false;
    return W.pendingMelts().some((m) => m && m.bolt11 && String(m.bolt11).toLowerCase() === want);
  }

  // the sats' payment of the dollar invoice is with the mint, unanswered: the dollars land when it answers
  fcUsdWaiting() {
    console.log('[foxy] card: the dollar invoice’s payment is pending with the mint');
    this.toast('The mint has not answered yet. The dollars land when it does.', true);
  }

  /* The invoice is paid: the receive screen's watch of it is asked now rather than at its next turn. Where the watch has
   * ended (the card took longer than the code's minute and a quarter), the same watch is begun again for it, while the
   * screen still shows that code; otherwise the wallet's own asking claims it, and HISTORY says so. */
  fcUsdLand(usd) {
    const W = this.fcW();
    if (W && W.watchKick && W.watchKick(usd.hash, 20000)) return;
    const s = this.state;
    /* The code has run out by now, so its clock counts the watch's own twenty seconds rather than a minute it does not
     * have; then a new code is asked for. */
    if (s.screen === 'confirm' && s.recvUnit === 'usd' && s.invoiceHash === usd.hash && usd.run === this._invoiceRun && this.usdInvoiceUp) {
      this.usdInvoiceUp({ hash: usd.hash, bolt11: usd.bolt11, amount: usd.cents, expiresIn: 20, expiresAt: Date.now() + 20000 }, usd.run);
    }
  }

  // the card paid and the dollar invoice did not take its sats: they are this phone's bitcoin
  fcUsdKept(usd, e, plain) {
    const W = this.fcW();
    if (this.hideStage) this.hideStage('paidCheck');
    const said = String(plain || (e ? (W && W.reason ? W.reason(e) : e.message) : '') || '').trim();
    console.log('[foxy] card: the dollar invoice was not paid; the card’s sats stay in bitcoin — ' + said);
    this.haptic && this.haptic('error');
    this.blockedCard('fc-usd-kept', {
      tone: 'warn', title: 'PAID IN BITCOIN',
      reason: 'The card paid ' + this.fcSats(usd.sats) + ', and the mint did not turn it into dollars.'
        + (said ? ' ' + said.replace(/\.?$/, '.') : '') + ' It is in your bitcoin balance.',
      shut: { label: 'OK' },
    });
  }

  /* CARD on a payer's own screen of a split bill: that payer's share, taken as the receive screen's CARD takes an
   * invoice, in every way but one. It is the bill's own share that is paid, and the screen is told so (`fcShareMoved`).
   *
   * The share is the row of the bill's ledger that the code on this screen was made for, and its amount the row's, so
   * the card pays what the code says. Until the code is made there is no row to settle, and a share that is paid
   * has nothing left to pay. */
  payShareByCard(idx) {
    const W = this.fcW();
    if (!W) return;
    const code = (this.state.spInvoices || [])[idx] || '';
    const bill = W.splitPending && W.splitPending();
    const row = code && bill && bill.rows ? bill.rows[idx] : null;
    const sats = row ? Math.round(Number(row.sats) || 0) : 0;
    if (!row || row.bolt11 !== code || !(sats > 0)) { this.toast('That share\u2019s invoice is still being made.', true); return; }
    if (row.paid) { this.toast('That share is already paid.', true); return; }
    this.fcPayBegin(sats, { idx: Number(idx), hash: row.hash });
  }

  /* Where a card payment begins, for the receive screen's invoice and for a share of a bill alike. `share`: the share
   * of a split bill this payment is for (its place in the bill, and its row's hash), and none for an invoice. It is
   * carried through every step the payment can be taken up by again (the PIN's pad, a wrong PIN's TRY AGAIN, a card
   * that left part way), so that it is the same share that is ticked when the mint says paid. */
  fcPayBegin(sats, share) {
    const W = this.fcW();
    /* The dollar code on screen has been paid by a card already, and its dollars are landing (the card's sats are with the
     * mint, or paid and the code's watch about to say so): no second sheet, which read the card again for the same code and
     * refused it as short. The owner tapped twice in the seconds between the card's payment and PAYMENT RECEIVED. */
    if (!share && this.fcUsdLanding()) {
      this.toast('The card has paid this code. The dollars land in a moment.', true);
      return;
    }
    /* No route to the mint: a card still pays, with nothing asked of the person. The wallet takes it only from a card
     * that proves its money with the mint's own proofs and has a week or more left on it, and only an exact set of its
     * pieces; the card signs the swap over to this phone, which nobody else can use, and this phone settles it with the
     * mint when it is online (08a-flashcard.js, `cardKeepSigned`). A card it cannot take so is refused before its PIN.
     * The switch off (`cardOffline`), a card payment needs a connection, as any other does. */
    if (W.cardOnline && !W.cardOnline()) {
      if (W.cardOffline && W.cardOffline()) { this.fcPayStart(sats, true, share); return; }
      this.offlineNo('A card payment');
      return;
    }
    if (this.offlineNow()) { this.offlineNo('A card payment'); return; }
    this.fcPayStart(sats, false, share);
  }

  /* The CARD button: the sheet comes up and the card is tapped at once, with no PIN asked for first. A card
   * with no PIN, or one whose no PIN limit covers the payment, pays in this tap. Any other says so (the sheet
   * ends with "Enter the card\u2019s PIN"; software before 1.16 always does), and the PIN pad comes up for a
   * second tap (`fcPayAsk`, from the rejection in `fcPayRun`). `offline`: this phone has no route, and the card
   * signs the payment over to it to be settled later (`fcPayBegin`). */
  /* `usd`: a dollar receive this payment is for (`payUsdByCard`), carried as `share` and `send` are, or none. `terms`: an
   * offline dollar receive's price, kept with the payment so its sats become dollars once it settles (`payUsdByCard`). */
  fcPayStart(sats, offline, share, send, usd, terms) {
    this.fcPayRun(sats, '', offline, false, share, send, usd, terms);
  }

  /* The card's PIN, for the second tap: asked for after the card has said it wants one, or after a wrong
   * one. TAP AGAIN pays with it. `cardUnit`: the unit of the card that asked for it, where it said (its `pin-needed`):
   * a dollar card is told the cents it pays, whatever else the till asked. */
  fcPayAsk(sats, offline, resuming, share, send, usd, terms, cardUnit) {
    let figure;
    // a card at another mint: the total it pays from there, its fee in it (`fcXmPay`)
    if (terms && terms.xm) {
      figure = this.fcBoth(terms.pay, terms.payUnit === 'usd' ? 'usd' : 'sat') + ', its fee included';
    } else if (terms && terms.payUnit === 'usd') {
      figure = this.fcFig(terms.sats, 'sat') + ' for ' + this.fcFig(terms.pay, 'usd')
        + (terms.online ? ' at ' + this.fcRateWho() + ', its fee included' : ' at this phone’s price, seen ' + this.agoWords(terms.ageMs));
    } else if (cardUnit === 'usd') {
      // a dollar card pays the cents asked of it, exactly
      figure = this.fcSats(this.fcAskIn('usd', sats, usd, terms, send), 'usd');
    } else if (usd || (terms && terms.usd > 0)) {
      // a dollar receive: the dollars asked, with the sats the card pays after them
      figure = this.fcPayLook(sats, usd, terms).amount + ' (' + this.fcSats(sats) + ')';
    } else {
      figure = this.fcBoth(sats);
    }
    this.fcAskPin({
      title: 'CARD PIN',
      subtitle: 'To pay ' + figure + '. The card’s owner types its PIN here.',
      cta: 'TAP AGAIN',
      // a card at another mint: backing out of the pad ends the visit to its mint (`fcXmHome`)
      /* and the currency its holder chose for this payment is this payment's alone (`fcPayChoose`): backed out of, the next payment asks
       * again */
      onBack: () => { this._fcFrom = null; if (terms && terms.xm) this.fcXmHome(); },
    }, (pin) => this.fcPayRun(sats, pin, offline, resuming, share, send, usd, terms));
  }

  /* A card payment is two taps, and is said as two every time, so a person
   * learns one way of paying: SEND (the card signs no more than two pieces and
   * is let go), VERIFY (this screen, while the mint swaps them), RECEIVE (the
   * change goes back on, with no PIN) and COMPLETE. Paid exactly, there is
   * nothing to receive, and the payment is complete at once. With no route
   * it is one tap: only an exact set is taken then. */
  /* `resuming`: the same payment, taken up again after the card left part way
   * through: the card signs only what it had not (08a-flashcard.js, `cardHeld`). `share`: the share of a split bill
   * this payment is for (`payShareByCard`), or none. `send`: the card paying out of this phone (SEND on the card's own
   * screen, `fcOutNext`): the tap is a till's in every way, and what the card pays is held for that payment (`fcOutPay`)
   * and is not this phone's; { to, key, unit, inv | found, quote }. */
  /* The card is asked in every unit the till takes (`fcAsks`) and pays in the one it holds, so the result says which
   * (`r.unit`), and its figures are in that unit: a dollar card's cents are `amount`, with `sats` 0. */
  fcPayRun(sats, pin, offline, resuming, share, send, usd, terms) {
    const W = this.fcW();
    /* A card at another mint than this phone's, paying this phone's own invoice from there (`fcXmPay`): this phone goes to that mint
     * first, for the tap and the melt, and comes home after (`fcXmGo`, `fcXmHome`). A quote that has run short is asked again before
     * the card is touched, on the confirmation it was agreed on. */
    const xm = !!(terms && terms.xm);
    if (xm && !resuming && !this.fcQuoteFresh(terms.quote)) {
      console.log('[foxy] card: the quote from the card’s mint is about to run out; asked again');
      this.fcXmHome();
      this.toast('The card’s mint gave a new fee. Check it and press PAY again.', true);
      this.fcXmOpen(terms);
      return;
    }
    if (xm && (!this._fcXmVisit || !this.fcXmThere(terms))) { this.fcXmGo(terms, () => this.fcPayRun(sats, pin, offline, resuming, share, send, usd, terms)); return; }
    const cross = !xm && !!(terms && terms.payUnit === 'usd');
    /* Online, the figure agreed is the mint's quote, which it honours until its own expiry: one that would be within
     * FC_QUOTE_LEFT_MS of it by the time the card has paid is asked for again, and the new figure agreed, before the card
     * is touched. Otherwise the payment would be refused at the melt and end in dollars. */
    /* (Not a quote just asked for: a mint whose quotes are all shorter than that is paid with what it gives.) */
    if (cross && terms.online && !resuming && terms.read && !this.fcQuoteFresh(terms.quote)
        && Date.now() - (Number(terms.quote && terms.quote.at) || 0) > 20000) {
      console.log('[foxy] card: the mint’s quote the holder agreed to is about to run out; asked again');
      this.fcOtherUnitOnline(terms.read, sats);
      return;
    }
    /* Online, a dollar card paying a bitcoin receive pays this phone exactly as it pays SEND from its own screen: the pieces it
     * pays are held for this phone's invoice (`holdFor`) and are what is melted, and they are this phone's (`holdKeep`) if
     * that payment is not made (`fcBtcPay`). Only the card agreed with pays it (`only`). */
    const btcHold = !!(cross && terms.online && terms.key && !send);
    /* A card at another mint: its pieces are held for this phone's invoice and melted at its mint (`fcXmMelt`), and they are the card's
     * (not this phone's) if that payment is not made, back on it at its next tap, as a payment out of a card's own screen is. */
    const xmHold = !!(xm && terms.key && !send);
    // (after a try with no PIN, trying again is the same: the card says whether it wants one)
    const opt = { paying: true, taken: true, share: share || null, send: send || null, offline: !!offline,
                  /* a dollar receive asks a bitcoin card for sats only where there are some to ask (`fcFailed` says why not),
                   * and a dollar card asked for sats has the cents agreed (`cross`) */
                  dollarAsk: !!usd && !send, codeUp: !!(usd && usd.bolt11), cross,
                  /* (the pad asked again is in the unit of the card that refused, where it said: `opt.cardUnit`, set as it refuses) */
                  again: () => (pin ? this.fcPayAsk(sats, offline, false, share, send, usd, terms, opt.cardUnit) : this.fcPayStart(sats, offline, share, send, usd, terms)) };
    // a dollar receive: when the mint has said paid, a bitcoin card's sats pay its invoice (`fcMoved`, `fcUsdPay`)
    if (usd) opt.usd = usd;
    // a bitcoin receive paid by a dollar card online: its cents pay the receive's own invoice (`fcMoved`, `fcBtcPay`)
    if (cross && terms.online) opt.btc = terms;
    if (btcHold) terms.holding = true;
    // a card at another mint: its pieces pay this phone's invoice from there (`fcMoved`, `fcXmMelt`)
    if (xm) opt.xm = terms;
    const look = this.fcPayLook(sats, usd, terms);
    const asks = this.fcAsks(sats, usd, terms, send);
    /* A new payment: a confirmation still held for the one before (its change
     * tap never ended in anything this screen heard of) is not this one's, and
     * is not raised over it. It is in HISTORY. */
    if (!resuming) this.fcDropConfirm();
    // (paying out of this phone, nobody here is being paid: no PAYMENT RECEIVED is held for it)
    const tapO = { amount: look.amount, lost: !!resuming,
                   sheet: resuming ? 'Hold to finish paying' : (look.sheet || ''), warm: !offline, paying: !send,
                   /* the card left part way through: the same sheet asks for it again, and the payment is taken up in it */
                   again: (e) => (e && e.card === 'interrupted' && e.resumable) ? 'Hold to finish paying'
                     : (e && e.card === 'gone') ? 'Tap behind the phone.' : '' };
    // the sats under the dollars, for a dollar receive (26h-tap-screen.js)
    if (look.amountSub) tapO.amountSub = look.amountSub;
    /* What the wallet is asked: the sats alone, as it always was, for a payment asked in nothing else (a bitcoin card's
     * steps are then exactly what they were), and the list for one asked in two units or in dollars. */
    const plain = asks.length === 1 && asks[0].unit === 'sat';
    const satAsk = asks.filter((x) => x.unit === 'sat')[0];
    const asking = plain ? Object.assign({ sats }, terms ? { terms } : {}) : Object.assign({ asks }, satAsk ? { sats: satAsk.amount } : {});
    this.fcTap(tapO,
               (link, on, progress) => {
                 /* A tap to feel the moment the card has signed and may be lifted: the
                  * phone's own sheet takes about three seconds to go after it is told
                  * to, and nothing on it says the card's part is over. Its own kind,
                  * and silent: the payment's buzz and sound are for PAYMENT RECEIVED. */
                 let felt = false;
                 const onPay = (step, info) => {
                   // (with change coming it is three buzzes instead, which the tap's own step handler gives: `fcChangeBuzz`)
                   if (!felt && (step === 'checking' || step === 'mint')) { felt = true; if (!(info && info.change)) this.haptic && this.haptic('tap', true); }
                   /* The payment's entry has a name from here, before the mint is asked: a share of a bill has it noted on its
                    * row, so that the share is ticked whenever the payment lands, however late (`fcShareNote`). */
                   if (share && info && info.hash && (step === 'checking' || step === 'mint')) this.fcShareNote(share, info.hash);
                   on(step, info);
                 };
                 /* (a card of software 1.23 that holds both: the currency its holder chose for this payment, `fcPayChoose`; the card it
                  * was chosen for alone, and for a few minutes) */
                 const from = (this._fcFrom && Date.now() - this._fcFrom.at < 180000) ? this._fcFrom : null;
                 /* (this receive's unit, picked by the person for it, 12-receive.js `recvPicked`: what is paid in it stays in it, and a
                  * payment kept offline is not swapped into the unit the phone holds) */
                 const picked = !send && !xm && !!(this.recvPicked && this.recvPicked(usd ? 'usd' : 'sat'));
                 return W.cardPay(link, Object.assign(asking, { pin, on: onPay, progress, offline: !!offline, keepSheet: !offline },
                                                      picked ? { kept: true } : {},
                                                      from ? { from: from.unit, fromKey: from.key } : {},
                                                      send ? { holdFor: true, only: send.key }
                                                        : btcHold ? { holdFor: true, holdKeep: true, only: terms.key }
                                                        : xmHold ? { holdFor: true, only: terms.key, feeMost: Math.max(0, Number(terms.cardFee) || 0) } : {}))
                   .then((r) => this.fcChangeInSheet(link, on, progress, r, pin), (e) => {
                     // a card whose money is at another mint: the read is the news, said on the screen that follows; the sheet ends with a tick, not in red
                     if (e && e.card === 'other-mint' && !send && !share && !xm) e.sheetText = 'Card read';
                     return this.fcPutBackInSheet(link, on, progress, e, pin);
                   });
               })
      .then((r) => {
        // (the currency chosen is this payment's, and the next asks again)
        this._fcFrom = null;
        // paying out of this phone: the card has paid this phone, and the payment it is for is made now
        if (send) { this.fcOutPay(r, send, sats); return; }
        this.haptic && this.haptic('success');
        // the unit the card paid in, and what it paid in it: a dollar card's cents, a bitcoin card's sats
        const unit = this.fcUnitOf(r);
        /* VERIFYING from here to PAYMENT RECEIVED: the card's sheet has gone and the code would show as unpaid for the second the
         * mint takes (a dollar code's melt says its own words a moment later, `fcUsdPay`). The paid screen takes it down. */
        // (not where the card is owed change: the next thing is its second tap, said by TAP TO RECEIVE, not a wait)
        const owesChange = !!(r && r.change && this.fcAmt(r.change) > 0);
        /* For every card payment of the code on screen (the design's rule: never the code read as unpaid while the mint works): at the
         * card's own mint PAYMENT RECEIVED follows in the next moment and takes it down; a melt (another mint, a dollar card paying
         * sats, sats paying a dollar code) keeps it up until the mint answers. */
        if (!share && !owesChange && this.state.screen === 'confirm') {
          this.fcCardVerifying('The card paid ' + this.fcPaidWords(this.fcAmt(r), unit) + '. Foxy is confirming the payment with your mint.', 60000);
          /* A payment settled within the tap (the card's own mint, sats) reaches PAYMENT RECEIVED in the next moment, which takes this
           * down; one still with a mint (a melt, at the card's mint or for a dollar code) keeps it. Nothing of either a moment on, with
           * no melt out: down, and the code stands as it was. */
          setTimeout(() => {
            if (!(this.stageUp && this.stageUp('paidCheck'))) return;
            const W2 = this.fcW();
            // still the code's screen, with a melt out or the dollars landing: kept; anything else, down
            const out = this.state.screen === 'confirm' && (!!(W2 && W2.pendingMelts && W2.pendingMelts().length) || this.fcUsdLanding());
            if (!out) this.hideStage('paidCheck');
          }, 700);
        }
        const paid = this.fcAskIn(unit, sats, usd, terms, send);
        /* A dollar card paid a dollar receive in cents, straight into this phone's dollars: the code on screen is not held for
         * it and nothing pays it (`fcMoved`). A bitcoin card paid in sats, which do (`fcUsdPay`). */
        if (unit === 'usd' && opt.usd) { opt.usd = null; this._fcUsd = null; }
        if (unit !== 'usd') opt.btc = null;
        // the pieces held for the invoice, which pay it (`fcBtcPay`)
        if (opt.btc) opt.btc.held = (r && r.held) || '';
        /* A card at another mint: the pieces held at its mint pay this phone's invoice (`fcXmMelt`), and what came off the card is not a
         * payment received here: the invoice, paid, is. */
        if (opt.xm) { opt.xm.held = (r && r.held) || ''; this.fcUsdHush(r && r.hash); }
        /* With no route: the card proved its money and signed it over to this phone, which keeps what it signed and
         * settles it with the mint when it is online. It is received now, and counts in the balance: the receive closes and
         * the history pass says PAYMENT RECEIVED, as for any payment. A share of a bill has the entry noted on its row,
         * and is ticked from it, since the entry is settled. */
        if (r && r.kept) {
          if (opt.share) this.fcShareNote(opt.share, r.hash);
          this.fcMoved(opt);
          this.toast('Paid by card while this phone is offline. Foxy settles it with the mint when it is online.');
          return;
        }
        /* The mint has given this phone its own pieces: a share of a bill is paid, and the bill's screens say so
         * before anything else is done with the payment, which is not announced on top of them. */
        if (opt.share) this.fcShareMoved(opt.share, r && r.hash);
        // a dollar receive: the card's sats are not announced; the dollars they buy are (and the mirror: the sats the cents buy)
        if (opt.usd) this.fcUsdHush(r && r.hash);
        if (opt.btc) this.fcBtcHush(r && r.hash);
        const ch = r && r.change;
        const owe = this.fcAmt(ch);
        const receiving = !!(ch && !ch.written && !ch.unmade && owe > 0);
        // the change went back in the same sheet: the payment is whole, and its PAYMENT RECEIVED goes up now
        if (ch && ch.written && owe > 0) this.fcReleaseConfirm('the change is back on the card');
        // no change to take after all (too small, or not made): the confirmation is not held for it
        else if (!receiving) this.fcReleaseConfirm('no change to take');
        this.fcMoved(opt);
        /* Made, and not written back in that sheet (it was dismissed, or the
         * phone's minute ran out): the second tap is asked for at once, with
         * TAP TO CONFIRM up from now until it is over, so the till is never
         * looking at its home screen between a payment and its change. */
        if (receiving) this.fcReceiveNow(owe, paid, { unit });
        // not made: this phone tries again when it connects, and says so
        if (ch && ch.unmade && owe > 0) this.fcChangeLater(owe, paid, unit);
        /* A payment of this card's held for another amount was let go as this
         * one finished: its pieces go back on at the same second tap. */
        const back = r && r.letGo && r.letGo.made ? this.fcAmt(r.letGo) : 0;
        if (back > 0 && !receiving) this.fcReceiveNow(back, paid, { unit });
        // a piece the card signed as it was taken away, whose answer never came: said, quietly
        if (r && r.torn > 0) this.toast(this.fcSats(r.torn, unit) + ' the card signed as it was taken away never reached this phone.', true);
      }, (e) => {
        // not paid: nothing of this payment's is held back (a hold begun as the mint was asked is let go)
        this.fcDropConfirm();
        /* A card at another mint than this phone's, at a receive (not a share of a bill, nor a card paying out of this phone): it pays
         * this phone's own invoice from its mint, online, with the charge shown first (`fcXmBegin`); with no route it is refused. */
        if (e && e.card === 'other-mint' && !send && !share && !xm) { this.fcXmBegin(e, sats, offline, usd); return; }
        /* Paying from another mint, and not paid: home again, except where the card's own flows go on at that mint (a tap left part way,
         * to be taken up there; a mint that has not answered, asked again there), which come home when they end (`fcXmStay`). */
        /* (And the card wanting its PIN, whose pad comes up next: the tap after it is at the same mint, and backing out of the pad comes
         * home, `fcPayAsk`.) */
        if (xm) {
          const goesOn = (e && e.card === 'interrupted' && e.resumable) || (e && e.card === 'waiting') || (e && e.card === 'pin-needed' && !pin);
          if (goesOn) this.fcXmStay(); else this.fcXmHome();
        }
        // the unit of the card read, for TRY AGAIN's pad: a dollar card is asked its PIN for the cents it pays
        if (e && e.cardUnit) opt.cardUnit = e.cardUnit;
        /* A dollar card asked for sats alone: nothing was asked of it but its read, and the phone being paid works out the
         * dollars for them, for the holder to agree to by tapping again (`fcOtherUnit`). Not for one that has agreed already
         * (another card was held up for the second tap), nor for a card paying out of this phone. */
        if (e && e.card === 'other-unit' && !cross && !send) { this._fcFrom = null; this.fcOtherUnit(e, sats, offline, share); return; }
        /* A card of software 1.23 that holds dollars and bitcoin, either of which could pay this: its holder is asked which, every time, on
         * the CURRENCY screen, before any PIN; nothing was asked of the card but its read. The payment goes on with the one chosen. */
        if (e && e.card === 'choose-unit') { this.fcPayChoose(e, () => opt.again()); return; }
        /* The card wants its PIN for this payment (it has one and no no PIN limit covers it, or its software
         * always asks): the sheet ended saying so, nothing was signed or taken, and the pad comes up. */
        if (e && e.card === 'pin-needed' && !pin) { this.fcPayAsk(sats, offline, resuming, share, send, usd, terms, e.cardUnit); return; }
        /* The card left part way through signing, and the sheet that looked for
         * it again was dismissed: what it signed is held, said with TAP CARD.
         * Where the phone could not keep the sheet up (an older one), a new
         * sheet comes up by itself instead, once iOS has taken the last down. */
        if (e && e.card === 'interrupted' && e.resumable) {
          if (e.sheetClosed) this.fcHeldCard(sats, pin, offline, share, send, usd, terms, e.cardUnit, e.key); else this.fcResumeNow(sats, pin, offline, share, send, usd, terms);
          return;
        }
        // taken up, and the card could not make the rest: what it signed goes back, and why is said
        if (e && e.card === 'not-enough' && e.still > 0) { this.fcShortHeld(e, this.fcAskIn(this.fcUnitOf(e), sats, usd, terms, send)); return; }
        // that tap read no card, or the card left before signing anything more: the hold stands, said with TAP CARD
        if (resuming && e && (e.card === 'cancelled' || e.card === 'gone')) { this.fcHeldCard(sats, pin, offline, share, send, usd, terms, e.cardUnit, e.key); return; }
        this._fcFrom = null;
        this.fcFailed(e, opt);
      });
  }

  /* Which currency pays, from a card of software 1.23 that holds both (the wallet's `choose-unit`, with each currency's balance and what is
   * asked in it): the CURRENCY screen, asked "PAY FROM WHICH?", a currency that cannot cover what is asked greyed and not offered. The one
   * chosen is this payment's (`_fcFrom`, for that card alone), and `again` takes the payment up with it. */
  fcPayChoose(e, again) {
    const bal = {}, short = {};
    (Array.isArray(e.units) ? e.units : []).forEach((x) => {
      if (!x || (x.unit !== 'usd' && x.unit !== 'sat')) return;
      bal[x.unit] = Math.max(0, Math.round(Number(x.balance) || 0));
      short[x.unit] = x.short ? 'NOT ENOUGH ON THE CARD' : '';
    });
    this.haptic && this.haptic('warning');
    this.fcPickUnit({
      question: 'PAY FROM WHICH?',
      foot: 'This card holds dollars and bitcoin. The one you pick pays this time; you are asked every time.',
      bal, short, why: 'The card holds too little of that for this payment.',
    }, (u) => { this._fcFrom = { key: String(e.key || ''), unit: u, at: Date.now() }; again(); });
  }

  /* The sheet again, a moment after the one the card left: iOS refuses a
   * reading session started on the heels of the last. The PIN typed for this
   * payment is used again, as it is for every tap of the one payment. And a
   * settling once the hold could be stale, so one nobody came back for goes
   * back to the card even with Foxy left open. */
  fcResumeNow(sats, pin, offline, share, send, usd, terms) {
    clearTimeout(this._fcResumeT);
    this._fcResumeT = setTimeout(() => this.fcPayRun(sats, pin, offline, true, share, send, usd, terms), 2500);
    // TAP AGAIN stays up through the pause, with nothing to press
    const look = this.fcPayLook(sats, usd, terms);
    this._fcTapO = { amount: look.amount, paying: !send, lost: true };
    if (look.amountSub) this._fcTapO.amountSub = look.amountSub;
    this.fcStage('reading');
    this.fcHeldClock();
  }

  /* A payment taken up again that the card could not finish: it holds too
   * little for the rest (often because a piece it signed as it was taken away
   * never arrived). What it signed for the payment is given back; the tap that
   * puts it on is one press away. In the card's own unit (`e.cardUnit`), `sats` the payment asked in it. */
  fcShortHeld(e, sats) {
    const u = this.fcUnitOf(e);
    const back = e.letGo && e.letGo.made ? this.fcAmt(e.letGo) : 0;
    this.fcReleaseConfirm('the payment was not finished');
    this.blockedCard('fc-short', Object.assign({
      tone: 'warn', title: 'NOT PAID',
      reason: 'The card holds ' + this.fcSats(e.balance, u) + ', and ' + this.fcSats(e.still, u) + ' of ' + this.fcSats(sats, u) + ' was still to pay.'
        + (e.torn > 0 ? ' ' + this.fcSats(e.torn, u) + ' it signed as it was taken away never reached this phone, and cannot be spent.' : '')
        + (back > 0 ? ' What it signed for this payment goes back on it: tap it to put it back.' : ' What it signed for this payment goes back on it once this phone reaches the mint.'),
    }, back > 0 ? { retry: 'TAP CARD', go: () => this.fcWriteAsk({ sheet: 'Tap to put back signatures.' }), shut: { label: 'LATER' } }
                : { shut: { label: 'OK' } }));
  }

  fcHeldClock() {
    const W = this.fcW();
    clearTimeout(this._fcHeldT);
    this._fcHeldT = setTimeout(() => { if (W && W.cardSettle) W.cardSettle().then(null, () => {}); }, 185000);
  }

  /* Held, and the tap to finish read no card: said, with the tap again, and
   * CANCEL, which gives back what the card signed (`fcLetGo`). `cardUnit`: the unit the held card pays in, which the
   * words are in; `cardKey`: that card, whose hold alone CANCEL lets go. */
  fcHeldCard(sats, pin, offline, share, send, usd, terms, cardUnit, cardKey) {
    const u = cardUnit === 'usd' ? 'usd' : 'sat';
    this.fcHeldClock();
    this.blockedCard('fc-held', {
      tone: 'warn', title: 'NOT PAID YET',
      reason: 'The card was taken away before it had signed for all of ' + this.fcSats(this.fcAskIn(u, sats, usd, terms, send), u) + '. Tap it again to finish paying.',
      chip: 'Nothing is paid until then. CANCEL puts back what it signed.',
      retry: 'TAP CARD', go: () => this.fcPayRun(sats, pin, offline, true, share, send, usd, terms),
      /* (a card at another mint: what it signed is let go at its mint, and then this phone goes home, `fcXmHome`) */
      shut: { label: 'CANCEL', tap: () => {
        if (!(terms && terms.xm)) { this.fcLetGo(cardKey); return; }
        /* (at the card's mint, where what it signed was signed: a visit gone home meanwhile, `fcXmStay`, goes back there for it) */
        const letGo = () => Promise.resolve(this.fcLetGo(cardKey)).then(() => this.fcXmHome(), () => this.fcXmHome());
        if (this._fcXmVisit && this.fcXmThere(terms)) letGo(); else this.fcXmGo(terms, letGo);
      } },
    });
  }

  /* ---- a dollar card, asked for sats --------------------------------------------------------------------------------
   *
   * A card pays only the kind of money it holds. A dollar card tapped at a phone that asked for sats has been read and
   * nothing more (08a-flashcard.js, `cardWrongUnit`: `other-unit`), and this phone works out what to take in dollars, for
   * the holder to see and agree to by tapping the card again; nothing is taken at the first tap.
   *
   * Online, the mint sets the figure: the dollars its quote says this phone's own invoice costs, its fee included, and those
   * cents pay the invoice from this phone (`fcOtherUnitOnline`, `fcBtcPay`), so the sats asked are what arrive. With no
   * route, this phone's own Bitcoin price sets it, and the price and how old it is are said with the figure: one over a day
   * old, or none, is refused. The cents are kept as dollars, and swapped into bitcoin once online only where the person
   * chose to hold bitcoin alone (16b-two-balances.js, `convertOne`). The card's own limits hold, in its cents.
   *
   * Only at a mint that issues both, for a receive into bitcoin, and never for a share of a split bill (bills are in sats). */
  fcOtherUnit(e, sats, offline, share) {
    const W = this.fcW();
    const two = !!(this.twoUnitsOn && this.twoUnitsOn());
    const into = this.walletNow ? this.walletNow('receive') : 'sat';
    if (!W || e.unit !== 'usd' || !two || !(W.twoUnits && W.twoUnits(e.mint)) || (into && into !== 'sat') || share) {
      this.fcFailed(e, { paying: true, taken: true });
      return;
    }
    if (!offline) { this.fcOtherUnitOnline(e, sats); return; }
    const lp = (W.lastPrice && W.lastPrice()) || { rate: 0, at: 0, ageMs: 0 };
    if (!(lp.rate > 0)) {
      this.haptic && this.haptic('error');
      this.blockedCard('noPrice', {
        tone: 'warn', title: 'NO BITCOIN PRICE',
        reason: 'This phone has never seen the Bitcoin price, so it cannot work out what to take from a dollar card.',
        chip: 'Nothing was taken. Get online once and Foxy has a price.',
      });
      return;
    }
    const tooOld = () => (this.haptic && this.haptic('error'), this.blockedCard('priceTooOld', {
      tone: 'warn', title: 'BITCOIN PRICE TOO OLD',
      reason: 'This phone last saw the Bitcoin price ' + this.agoWords(lp.ageMs) + '. That is too old to work out what to take from the card.',
      chip: 'Nothing was taken. Get online once and Foxy has a new price.',
    }));
    if (W.priceTooOld && W.priceTooOld(lp.at)) { tooOld(); return; }
    // the mint's dollar keys, as this phone has them: with no route a dollar card is checked against them, and they are not asked for
    if (!(W.unitKeysOffline && W.unitKeysOffline('usd'))) {
      this.haptic && this.haptic('error');
      this.blockedCard('fc-no-usd-keys', {
        tone: 'warn', title: 'CARD NOT TAKEN',
        reason: 'This phone has not seen the mint’s dollar keys yet, so it cannot check a dollar card while offline.',
        chip: 'Nothing was taken. Take this payment when this phone is online.',
      });
      return;
    }
    // typed in dollars (a bitcoin receive's keypad is, offline): the card pays the cents typed, not a figure turned round twice
    const typed = (this.state.unit === 'USD' && this.centsTyped) ? this.centsTyped() : 0;
    const q = W.centsFor ? W.centsFor(sats, typed) : null;
    if (!q) { tooOld(); return; }
    const choice = (W.walletChoice && W.walletChoice()) || {};
    const terms = { payUnit: 'usd', pay: q.cents, sats: q.sats, rate: q.rate, ageMs: q.ageMs, seenAt: q.at, own: true,
                    convert: choice.hold === 'bitcoin' };
    this.fcOtherAgree(e, terms, sats, offline, share);
  }

  /* A card of software 1.23 that holds bitcoin too little for a bitcoin payment, and dollars enough: what it holds in bitcoin, said before
   * its dollars are asked for (the wallet's `other-unit`, `satsToo`). Nothing for a card of dollars alone. */
  fcSatsShort(e) {
    const n = Math.round(Number(e && e.satsToo) || 0);
    return n > 0 ? 'Its ' + this.fcFig(n, 'sat') + ' in bitcoin is not enough. ' : '';
  }

  /* The holder agrees by tapping again: with its PIN where the card will want one for this (it has one, and what it pays
   * without one today does not cover the cents and a cent of the mint's fee), and otherwise on the confirmation that says the
   * figure (`fcOuSpec`), with TAP CARD. */
  fcOtherAgree(e, terms, sats, offline, share) {
    if (e.pinSet && !(Number(e.noPinLeft) >= terms.pay + 1)) {
      this.fcPayAsk(sats, offline, false, share, null, null, terms, 'usd');
      return;
    }
    // a step of the payment, not a refusal: felt as one to look at
    this.haptic && this.haptic('warning');
    const x = { e, terms, sats, offline: !!offline, share: share || null, asking: false, err: '', lapsed: false, requotes: 0 };
    if (this.state.screen === 'fcOuConfirm') this.setState({ fcOu: x });
    else this.setState(p => ({ screen: 'fcOuConfirm', stack: p.stack.concat([p.screen]), fcOu: x }));
    this.fcOuClock();
  }

  /* Online: the mint's quote for this phone's own invoice in dollars (a melt quote commits to nothing). The card pays its
   * amount and its fee reserve, so the receiver, who may hold no dollars to pay a fee from, gets exactly the sats asked; what
   * of the reserve the mint does not use comes back to this phone's dollars as a melt's change. A code about to run out is
   * renewed first, as for a dollar receive (`payUsdByCard`). */
  fcOtherUnitOnline(e, sats) {
    const W = this.fcW();
    const s = this.state;
    const bolt11 = s.invoiceIsAddress ? '' : String(s.invoice || '');
    if (!bolt11 || !W.quoteFee) { this.fcFailed(e, { paying: true, taken: true }); return; }
    const ends = Number(s.recvExpiresAt) || 0;
    if (ends && ends - Date.now() < 15000) {
      this.toast('This code has almost run out. A new one is being made; press CARD when it is up.', true);
      if (this.recvRequote) this.recvRequote(this._invoiceRun);
      return;
    }
    this.fcOuQuote(e, sats).then((terms) => {
      if (terms) this.fcOtherAgree(e, terms, sats, false, null);
    }).catch(() => {
      this.haptic && this.haptic('error');
      this.blockedCard('fc-other-unit', {
        tone: 'warn', title: 'THIS CARD HOLDS DOLLARS',
        reason: 'This card holds dollars here, not bitcoin, and the mint could not say what this invoice costs in dollars just now.',
        chip: 'Nothing was taken.',
      });
    });
  }

  /* The mint's figure for the invoice on screen, in dollars: the terms a dollar card pays it on, or null where the screen has moved
   * on while the mint was asked. Refused, or no figure: an error. */
  fcOuQuote(e, sats) {
    const W = this.fcW();
    const s = this.state;
    const bolt11 = s.invoiceIsAddress ? '' : String(s.invoice || '');
    const ends = Number(s.recvExpiresAt) || 0;
    const run = this._invoiceRun;
    return Promise.resolve().then(() => W.quoteFee(bolt11, { unit: 'usd' })).then((q) => {
      if (!q || !(q.amount > 0)) throw new Error('no quote');
      // the screen has moved on while the mint was asked: nothing to agree to
      if (this.state.invoice !== bolt11) return null;
      /* What the card pays: the quote and its reserve, and the mint's fee for spending the very pieces it pays them in, which
       * are held for this invoice and melted, every one and nothing of this phone's (`cardOutTotal`, as SEND from a card's
       * screen pays). The receiver pays no fee for being paid, whatever it holds. */
      const cents = W.cardOutTotal ? W.cardOutTotal(q.amount, q.feeReserve, 'usd')
        : Math.round(Number(q.amount) || 0) + Math.round(Number(q.feeReserve) || 0);
      // `key` and `read`: the card agreed with, which alone pays it, and what its read said (to ask again by, `fcPayRun`)
      return { payUnit: 'usd', pay: cents, sats, online: true, bolt11, hash: String(s.invoiceHash || ''), quote: q, run, ends,
               key: String(e.key || ''), read: e };
    });
  }

  /* ---- the confirmation for a dollar card asked for sats (`fcOuConfirm`) ----------------------------------------------
   *
   * What the card pays, dollars first with the sats asked under them; what this phone receives, the fee, and whose rate made the
   * one of the other: the mint's online, held for as long as its quote is good for a payment (`fcQuoteFresh`) and asked again when
   * that runs out, or this phone's own price with no route, with how old it is. TAP CARD is the second tap; the round back
   * button puts the card away with nothing taken. */

  /* Milliseconds the mint's rate on the confirmation is still held for: until its quote has too little left for a payment
   * (FC_QUOTE_LEFT_MS before its expiry), and at least the twenty seconds after it was asked that a payment takes it anyway
   * (`fcPayRun`). null where nothing counts down: a quote with no expiry, and this phone's own price. */
  fcOuHeld(t) {
    if (!t || !t.online || !t.quote) return null;
    const exp = Number(t.quote.quote && t.quote.quote.expiry) || 0;
    if (!(exp > 0)) return null;
    const until = Math.max(exp * 1000 - (Number(this.FC_QUOTE_LEFT_MS) || 75000), (Number(t.quote.at) || 0) + 20000);
    return Math.max(0, until - Date.now());
  }

  /* The countdown under the rate, once a second while the confirmation is up, and the mint asked again when it runs out, three
   * times with nobody pressing anything; then it waits for GET A NEW RATE. It stops as soon as the screen has gone or there is
   * nothing to count. */
  fcOuClock() {
    if (this._fcOuT) return;
    this._fcOuT = setInterval(() => {
      const x = this.state.fcOu;
      const held = x ? this.fcOuHeld(x.terms) : null;
      if (this.state.screen !== 'fcOuConfirm' || !x || x.lapsed || (held === null && !x.asking)) {
        clearInterval(this._fcOuT);
        this._fcOuT = null;
        return;
      }
      if (x.asking || x.err) return;
      if (held > 0) { this.setState({ fcOuTick: Date.now() }); return; }
      if (x.requotes >= 3) {
        console.log('[foxy] card: the mint’s rate ran out with nobody looking; waiting for a press');
        this.setState({ fcOu: Object.assign({}, x, { lapsed: true }) });
        return;
      }
      console.log('[foxy] card: the mint’s rate ran out, so it is asked again');
      this.fcOuRequote(x.requotes + 1);
    }, 1000);
  }

  // the mint asked again for the invoice on screen, with the confirmation up: its figures put on it, or why not
  fcOuRequote(requotes) {
    const x0 = this.state.fcOu;
    if (!x0 || !x0.terms.online) return;
    const run = (this._fcOuRun = (this._fcOuRun || 0) + 1);
    const put = (more) => {
      const x = this.state.fcOu;
      if (run !== this._fcOuRun || !x || this.state.screen !== 'fcOuConfirm') return;
      this.setState({ fcOu: Object.assign({}, x, more) });
    };
    put({ asking: true, err: '', lapsed: false, requotes: Number(requotes) || 0 });
    this.fcOuClock();
    this.fcOuQuote(x0.e, x0.sats).then((terms) => {
      put(terms ? { asking: false, terms } : { asking: false, err: 'The code on screen changed. Nothing was taken.' });
    }, () => {
      put({ asking: false, err: 'The mint could not say what this invoice costs in dollars just now. Nothing was taken.' });
    });
  }

  /* TAP CARD: back to the receive screen, and the card's second tap, which pays the figure on the screen; a rate that has run
   * out, or a code changed under it, is asked again first, on the screen. */
  fcOuGo() {
    const x = this.state.fcOu;
    if (!x || x.asking) return;
    const t = x.terms;
    if (t.online && (x.err || x.lapsed || this.fcOuHeld(t) === 0 || this.state.invoice !== t.bolt11)) { this.fcOuRequote(0); return; }
    this.setState(p => ({ fcOu: null, screen: p.stack.length ? p.stack[p.stack.length - 1] : 'confirm', stack: p.stack.slice(0, -1) }));
    this.fcPayStart(x.sats, x.offline, x.share, null, null, t);
  }

  // "02:41": minutes and seconds
  fcOuClockText(ms) {
    const n = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  }

  /* The confirmation (confirmSpec). */
  /** @returns {ConfirmSpec} */
  fcOuSpec() {
    const x = this.state.fcOu || { e: null, terms: { pay: 0, sats: 0 }, sats: 0, asking: false, err: '', lapsed: false };
    const t = x.terms || {};
    const own = !t.online;
    const sats = Math.round(Number(own ? t.sats : x.sats) || 0);
    const cents = Math.round(Number(t.pay) || 0);
    const q = t.quote || {};
    // the mint's rate, off its quote (`quoteFee`), or the cents for the invoice over the sats asked where it names none
    const rate = own ? Number(t.rate) || 0
      : (Number(q.rate && q.rate.usdPerBtc) || (sats > 0 ? Number(q.amount) * 1e6 / sats : 0));
    const satsOf = (c) => (rate > 0 ? Math.round(c * 1e6 / rate) : 0);
    const usd = (c, n) => ({ main: this.fcFig(c, 'usd'), sub: n > 0 ? '(' + this.fcFig(n, 'sat') + ')' : '' });
    const fee = own ? 0 : Math.max(0, cents - Math.round(Number(q.amount) || 0));
    const rateText = rate > 0 ? '₿ 1 = $ ' + this.group(Math.round(rate)) : 'UNKNOWN';
    const held = this.fcOuHeld(t);
    const rows = [
      this.cfRow('YOU RECEIVE', this.fcFig(sats, 'sat')),
      this.cfRow('FEE', own ? 'NONE' : usd(fee, satsOf(fee)).main, { sub: own ? '' : usd(fee, satsOf(fee)).sub, ink: 'var(--btc-ink)' }),
      own
        ? this.cfRow('THIS PHONE’S PRICE', rateText, { sub: 'Seen ' + this.agoWords(t.ageMs) })
        : this.cfRow(this.fcRateWho().toUpperCase(), rateText, {
          sub: x.asking ? 'Checking the rate…' : x.lapsed ? 'The rate ran out' : held !== null ? 'Rate held for ' + this.fcOuClockText(held) : '' }),
    ];
    const subtitle = this.fcSatsShort(x.e) + 'They asked for ' + this.fcFig(sats, 'sat') + '. '
      + (own ? 'At this phone’s Bitcoin price, seen ' + this.agoWords(t.ageMs) + ', that is ' + this.fcFig(cents, 'usd') + '.'
        : 'At ' + this.fcRateWho() + ' that is ' + this.fcFig(cents, 'usd') + ' with its fee.');
    const base = { title: 'THIS CARD HOLDS DOLLARS', amountLabel: 'THE CARD PAYS', amount: this.fcFig(cents, 'usd'),
                   // (the shell puts the brackets round it: "(₿ 12,391)")
                   amountSub: this.fcFig(sats, 'sat'), rows, subtitle };
    if (x.asking) return Object.assign(base, { cta: 'CHECKING THE RATE…', ctaTone: 'go', ctaBusy: true, go: () => {} });
    if (x.err) return Object.assign(base, { warn: x.err, cta: 'TRY AGAIN', ctaTone: 'warn', go: () => this.fcOuRequote(0) });
    if (x.lapsed) {
      return Object.assign(base, { chip: 'The rate ran out. Nothing was taken.', cta: 'GET A NEW RATE', ctaTone: 'go',
                                   go: () => this.fcOuRequote(0) });
    }
    return Object.assign(base, { cta: 'TAP CARD', ctaTone: 'go', go: () => this.fcOuGo() });
  }

  /* A dollar card's cents, paying the bitcoin invoice it was tapped for: the mirror of `fcUsdPay`, with the quote the holder
   * agreed to, while it is fresh. Paid, the receive screen's own watch of the invoice says PAYMENT RECEIVED in sats. Not paid,
   * the cents are in the dollar balance, and said so; nothing is left to swap them later (the person has SWAP). */
  fcBtcPay(btc) {
    const W = this.fcW();
    this.refreshBalance();
    this.loadHistory();
    if (!W || btc.melting || btc.done) return;
    console.log('[foxy] card: ' + btc.pay + ' cents taken; they pay the bitcoin invoice on screen');
    /* The card's pieces held for the invoice (`btc.held`), where they were: they are what is melted. Not paid, they are this
     * phone's, into its dollars (`cardOutKeep`), before it is said. */
    const held = String(btc.held || '');
    const keep = () => (held && W.cardOutKeep ? Promise.resolve(W.cardOutKeep(held)).catch(() => null) : Promise.resolve(null));
    // (the code ran out while the card was read: the mint refuses a melt of it, so none is sent)
    if (btc.ends && btc.ends - Date.now() < 5000) {
      btc.done = true;
      keep().then(() => { this.refreshBalance(); this.loadHistory(); this.fcBtcKept(btc, null, 'The code ran out while the card paid.'); });
      return;
    }
    btc.melting = true;
    const end = (paid) => {
      btc.melting = false;
      btc.done = true;
      this.refreshBalance();
      this.loadHistory();
      if (paid) this.fcBtcLand(btc);
    };
    if (btc.quote && btc.quote.quote && btc.quote.quote.quote) this.txIsNew(String(btc.quote.quote.quote));
    const how = Object.assign({ unit: 'usd' }, btc.quote ? { quote: btc.quote } : {}, held ? { held } : {});
    Promise.resolve().then(() => W.pay(btc.bolt11, () => {}, how)).then((paid) => {
      if (paid && paid.hash) this.txIsNew(String(paid.hash));
      if (paid && paid.pending) { btc.melting = false; this.refreshBalance(); this.loadHistory(); this.fcBtcWaiting(); return; }
      end(true);
    }, (e) => {
      if (e && e.pending) { btc.melting = false; this.refreshBalance(); this.loadHistory(); this.fcBtcWaiting(); return; }
      keep().then(() => {
        end(false);
        this.fcBtcKept(btc, e, e && e.plain);
      });
    });
  }

  // the card's cents are this phone's, paying its own invoice: their entry is not a payment of its own to announce (the sats are)
  fcBtcHush(hash) { this.fcUsdHush(hash); }

  /* Whether a mint's melt quote still has FC_QUOTE_LEFT_MS before its own expiry (a quote that names none is fresh): the
   * time a PIN, a tap and the card's swap take, and the half minute `pay` leaves before an expiry. */
  fcQuoteFresh(q) {
    const exp = Number(q && q.quote && q.quote.expiry) || 0;
    return !(exp > 0) || exp * 1000 - Date.now() > (Number(this.FC_QUOTE_LEFT_MS) || 75000);
  }

  // paid: the receive screen's watch of its invoice is asked now rather than at its next turn
  fcBtcLand(btc) {
    const W = this.fcW();
    if (W && W.watchKick) W.watchKick(btc.hash, 20000);
  }

  // the cents' payment of the bitcoin invoice is with the mint, unanswered: the sats land when it answers
  fcBtcWaiting() {
    console.log('[foxy] card: the bitcoin invoice’s payment is pending with the mint');
    this.toast('The mint has not answered yet. The sats land when it does.', true);
  }

  // the card paid and the bitcoin invoice did not take its cents: they are this phone's dollars
  fcBtcKept(btc, e, plain) {
    const W = this.fcW();
    const said = String(plain || (e ? (W && W.reason ? W.reason(e) : e.message) : '') || '').trim();
    console.log('[foxy] card: the bitcoin invoice was not paid; the card’s cents stay in dollars — ' + said);
    this.haptic && this.haptic('error');
    this.blockedCard('fc-btc-kept', {
      tone: 'warn', title: 'PAID IN DOLLARS',
      reason: 'The card paid ' + this.fcFig(btc.pay, 'usd') + ', and the mint did not turn it into bitcoin.'
        + (said ? ' ' + said.replace(/\.?$/, '.') : '') + ' It is in your dollar balance.',
      shut: { label: 'OK' },
    });
  }

  /* ---- a card at another mint ----------------------------------------------------------------------------------------
   *
   * A card's money is at the mint its record names, and a till at another mint cannot take it as it is: ecash of one mint is
   * nothing at another. Online, the card pays the till's own invoice from its mint instead, as SEND on a card's screen pays an
   * invoice (`fcOutNext`): the invoice on the receive screen (a mint quote this phone's own mint made for the amount asked) is
   * quoted at the card's mint in the card's unit, the charge is shown on a confirmation before anything is asked of the card or
   * its holder, and PAY taps the card for that total. Its pieces are held for the invoice at its mint and melted there; the till's
   * mint then says the invoice is paid, and the receive screen's own watch lands it, PAYMENT RECEIVED, the amount asked exactly.
   * The payer pays the fee: the quote's reserve and the card's mint's fee on the pieces are in the total. What of the reserve the
   * Lightning payment does not use comes back as the melt's change, to this phone, at the card's mint (as every melt's does).
   *
   * A dollar card paying a bitcoin ask and a bitcoin card paying a dollar ask are the same: the invoice is in bitcoin as every
   * invoice is, and the card's mint quotes it in the card's unit.
   *
   * This phone goes to the card's mint for the tap and the melt, and comes home after (`fcXmGo`, `fcXmHome`): a visit, never saved as
   * its own mint, so a Foxy closed there opens at home. The card's change, and what goes back on it when the payment is not made,
   * are a card payment's as ever (put on in the same sheet, or at the card's next tap here, from whatever mint this phone is at).
   *
   * Offline it is refused, before anything is asked of the card: between two mints, both must be online. */
  fcMintKey(u) {
    const m = /^(https?:\/\/[^/?#]+)(.*)$/i.exec(String(u || '').trim());
    return m ? m[1].toLowerCase() + m[2].replace(/\/+$/, '') : String(u || '').trim().replace(/\/+$/, '');
  }

  // whether this phone is at the card's mint now
  fcXmThere(x) {
    const W = this.fcW();
    return !!(W && x && this.fcMintKey(W.mintUrl) === this.fcMintKey(x.mint));
  }

  // the one sentence a card at another mint is refused with, with no route
  fcXmOffline() {
    this.haptic && this.haptic('error');
    this.blockedCard('fc-xm-offline', { tone: 'warn', title: 'A DIFFERENT MINT', reason: 'Paying a card from another mint needs the connection.' });
  }

  /* The card was read, and its money is at another mint (`fcPayRun`, the wallet's `other-mint`, which says the card's unit, its key,
   * what it holds and whether it wants its PIN). Nothing has been asked of it. The receive screen's own invoice is what it pays: a
   * dollar receive's code (`usd`), or the bitcoin receive's. A code not up yet is waited for. */
  fcXmBegin(e, sats, offline, usd) {
    const W = this.fcW();
    const s = this.state;
    if (!W) return;
    if (offline || this.offlineNow() || (W.cardOnline && !W.cardOnline())) { this.fcXmOffline(); return; }
    const bolt11 = usd ? String(usd.bolt11 || '') : (s.invoiceIsAddress ? '' : String(s.invoice || ''));
    if (!bolt11) { this.toast('The invoice is still being made. Press CARD when it is up.', true); return; }
    /* A card of software 1.23 that holds dollars and bitcoin pays from there in either: its holder is asked which, every time, on the
     * CURRENCY screen, before its mint is asked anything (`fcPayChoose`'s question). What it pays is then that currency's alone. */
    const held = (e && e.units && typeof e.units === 'object') ? e.units : null;
    if (held && Number(held.usd) > 0 && Number(held.sat) > 0) {
      this.haptic && this.haptic('warning');
      this.fcPickUnit({
        question: 'PAY FROM WHICH?',
        foot: 'This card holds dollars and bitcoin. The one you pick pays this time; you are asked every time.',
        bal: { usd: Math.round(Number(held.usd) || 0), sat: Math.round(Number(held.sat) || 0) }, short: {}, why: '',
      }, (u) => {
        const one = u === 'usd' ? 'usd' : 'sat';
        const picked = Object.assign({}, e, { units: null, cardUnit: one, balance: Math.round(Number(held[one]) || 0) });
        // (and the card as read, which is not copied with the rest: its mint's fee on the pieces of the chosen currency is worked out from it)
        try { Object.defineProperty(picked, 'cardRead', { value: e.cardRead || null, enumerable: false }); } catch (eR) { /* the fee is then found at the tap */ }
        this.fcXmBegin(picked, sats, offline, usd);
      });
      return;
    }
    // the code on screen is paid by the card from its mint, not by sats from this phone (`fcUsdPay`)
    if (usd) this._fcUsd = null;
    const ask = usd ? { unit: 'usd', amount: Math.round(Number(usd.cents) || 0) }
      : { unit: 'sat', amount: Math.round(Number((W.amountOf && W.amountOf(bolt11)) || sats) || 0) };
    const x = {
      xm: true, mint: this.fcMintKey(e.mint), home: this.fcMintKey(W.mintUrl), payUnit: e.cardUnit === 'usd' ? 'usd' : 'sat',
      key: String(e.key || ''), pinSet: !!e.pinSet, noPinLeft: Math.round(Number(e.noPinLeft) || 0), balance: Math.round(Number(e.balance) || 0),
      usdAsk: !!usd, ask, bolt11, hash: usd ? String(usd.hash || '') : String(s.invoiceHash || ''), ends: usd ? (Number(usd.ends) || 0) : 0,
      quote: null, pay: 0, want: 0, cardFee: 0, fee: 0, err: '', short: false,
    };
    // the card as read, in memory only: what its mint charges on the pieces it would pay with is worked out from it (`cardCrossQuote`)
    this._fcXmCard = e.cardRead || null;
    // the card's pieces owed back to it at its mint go on from here, whatever mint this phone is at (`fcWriteAsk`)
    this._fcXmAt = Object.assign({}, this._fcXmAt || {}, { [x.mint]: true });
    console.log('[foxy] card: its money is at ' + x.mint + '; it is asked to pay this phone’s invoice from there');
    this.fcXmOpen(x);
  }

  // the confirmation, for the agreement `x`: its figures asked of the card's mint afresh
  fcXmOpen(x) {
    const fresh = Object.assign({}, x, { quote: null, pay: 0, want: 0, cardFee: 0, fee: 0, err: '', short: false });
    if (this.state.screen === 'fcXmConfirm') this.setState({ fcXm: fresh });
    else this.setState(p => ({ screen: 'fcXmConfirm', stack: p.stack.concat([p.screen]), fcXm: fresh }));
    this.fcXmQuote();
  }

  /* What the card's mint asks for this phone's invoice, in the card's unit (21a-flashcard.js, `cardCrossQuote`), asked with this
   * phone at its own mint: a melt quote commits to nothing. */
  fcXmQuote() {
    const W = this.fcW();
    const x0 = this.state.fcXm;
    if (!W || !x0) return;
    const run = (this._fcXmRun = (this._fcXmRun || 0) + 1);
    const put = (more) => {
      const x = this.state.fcXm;
      if (run !== this._fcXmRun || !x || x.bolt11 !== x0.bolt11) return;
      this.setState({ fcXm: Object.assign({}, x, more) });
    };
    put({ quote: null, err: '', pay: 0, want: 0, cardFee: 0, fee: 0, short: false });
    /* `pay`: the most that comes off the card, its mint's fee on its own pieces in it (`cardFee`); `want`: what the tap asks it for, the
     * hold that pays the invoice. A card that does not hold `pay` is `short`: nothing on the screen can change that. */
    Promise.resolve().then(() => W.cardCrossQuote(x0.mint, x0.bolt11, x0.payUnit, this._fcXmCard || undefined)).then((q) => {
      const short = q.total > x0.balance;
      put({ quote: q.quote, pay: q.total, want: q.want || q.total, cardFee: Math.max(0, Number(q.cardFee) || 0), fee: q.fee, short, err: short
        ? 'The card holds ' + this.fcSats(x0.balance, x0.payUnit) + ', and this needs ' + this.fcSats(q.total, x0.payUnit) + ' with its fee.' : '' });
    }, (e) => {
      put({ err: 'The card’s mint could not say what this costs: ' + String((W.reason ? W.reason(e) : (e && e.message)) || 'it did not answer').replace(/\.?$/, '.') });
    });
  }

  // the receive screen's code was renewed under the confirmation (12-receive.js, `recvRequote`): the card pays the new one
  fcXmRenew() {
    const x = this.state.fcXm;
    const s = this.state;
    if (!x || !s.invoice || s.invoice === x.bolt11) return;
    this.fcXmOpen(Object.assign({}, x, { bolt11: String(s.invoice), hash: String(s.invoiceHash || ''), ends: Number(s.recvExpiresAt) || 0 }));
  }

  /* The confirmation (confirmSpec): what the card pays, dollars first, before its PIN is asked or it is touched again. The rows: what
   * this phone receives, the fee the card pays on top, and the two mints. */
  fcXmSpec() {
    const x = this.state.fcXm || { ask: { unit: 'sat', amount: 0 }, payUnit: 'sat' };
    const u = x.payUnit === 'usd' ? 'usd' : 'sat';
    const fig = (n, unit) => (unit === 'usd' ? { main: this.fcSats(n, 'usd'), sub: '' } : this.money(n));
    const known = !!x.quote && x.pay > 0;
    const gets = fig(x.ask.amount, x.ask.unit);
    const rows = [
      this.cfRow('YOU RECEIVE', gets.main, { sub: gets.sub }),
      this.cfRow('FEE, PAID BY THE CARD', x.err && !known ? 'UNKNOWN' : known ? 'UP TO ' + fig(x.fee, u).main : 'CHECKING…',
                 { sub: known ? fig(x.fee, u).sub : '', ink: 'var(--btc-ink)' }),
      this.cfRow('THE CARD’S MINT', String(this.mintNameOf(x.mint) || '').toUpperCase(), { half: true }),
      this.cfRow('YOUR MINT', String(this.mintNameOf(x.home) || '').toUpperCase(), { half: true }),
    ];
    const subtitle = 'This card’s money is at another mint. It pays your invoice from there, and pays the fee.'
      + (known ? ' What the fee does not use goes back on the card.' : '');
    /* A card that does not hold enough: said, with the PAY it would take greyed. Asking the mint again cannot change it; the way out is the
     * round back button. */
    if (x.err && x.short && known) {
      return {
        title: 'A CARD FROM ANOTHER MINT', amountLabel: 'THE CARD PAYS',
        amount: fig(x.pay, u).main, amountSub: fig(x.pay, u).sub, amountInk: '#FF5C5C', rows,
        subtitle, warn: x.err, cta: 'PAY ' + fig(x.pay, u).main, ctaTone: 'go', ctaBusy: true, go: () => {},
      };
    }
    if (x.err) {
      return {
        title: 'A CARD FROM ANOTHER MINT', amountLabel: 'THE CARD PAYS',
        amount: known ? fig(x.pay, u).main : gets.main + ' + fee', amountSub: known ? fig(x.pay, u).sub : '', amountInk: '#FF5C5C', rows,
        subtitle, warn: x.err, cta: 'TRY AGAIN', ctaTone: 'warn', go: () => this.fcXmQuote(),
      };
    }
    return {
      title: 'A CARD FROM ANOTHER MINT', amountLabel: 'THE CARD PAYS',
      amount: known ? fig(x.pay, u).main : gets.main + ' + fee', amountSub: known ? fig(x.pay, u).sub : '', rows, subtitle,
      cta: known ? 'PAY ' + fig(x.pay, u).main : 'CHECKING THE FEE…', ctaTone: 'go', ctaBusy: !known,
      go: () => { if (known) this.fcXmPay(); },
    };
  }

  /* PAY on the confirmation: back to the receive screen, and the card tapped for the total, with its PIN first where it will want it
   * (it has one, and what it pays without one does not cover the total). The tap is a till's in every way (`fcPayRun`). */
  fcXmPay() {
    const W = this.fcW();
    const x = this.state.fcXm;
    if (!W || !x || !x.quote || !(x.pay > 0) || x.short) return;
    if (this.offlineNow() || (W.cardOnline && !W.cardOnline())) { this.fcXmOffline(); return; }
    // a dollar code with less than half a minute left is renewed first (12-receive.js), and the card pays the new one (`fcXmRenew`)
    if (x.ends && x.ends - Date.now() < 30000) {
      this.toast('This code has almost run out. A new one is being made, and the fee asked again.', true);
      if (this.recvRequote) this.recvRequote(this._invoiceRun);
      return;
    }
    if (!this.fcQuoteFresh(x.quote)) { this.fcXmOpen(x); return; }
    const terms = Object.assign({}, x);
    this.setState(p => ({ fcXm: null, screen: p.stack.length ? p.stack[p.stack.length - 1] : 'confirm', stack: p.stack.slice(0, -1) }));
    this._fcXmLive = terms;
    /* The card is asked for the hold (`want`), and its mint's fee on its own pieces comes on top, up to what was shown (`cardFee`,
     * `feeMost`): `pay`, the most it is charged, is what the screens say. */
    const want = Math.max(0, Math.round(Number(x.want || x.pay) || 0));
    if (x.pinSet && !(x.noPinLeft >= x.pay)) { this.fcPayAsk(want, false, false, null, null, null, terms, x.payUnit); return; }
    this.fcPayStart(want, false, null, null, null, terms);
  }

  /* To the card's mint, for the tap and the melt: a visit (21a-flashcard.js, `cardVisit`), never saved as this phone's own, and with
   * what else is started meanwhile (an invoice, a payment, the late claims) waiting for this phone to be home. `fcXmHome` ends it. */
  fcXmGo(x, then) {
    const W = this.fcW();
    if (!W) return;
    if (this.offlineNow() || (W.cardOnline && !W.cardOnline())) { this.fcXmOffline(); return; }
    clearTimeout(this._fcXmStayT);
    this._fcXmLive = x;
    const v = this._fcXmVisit;
    if (v && this.fcMintKey(v.mint) === this.fcMintKey(x.mint) && this.fcXmThere(x)) { then(); return; }
    /* The seconds this takes showed the receive's code bare, as if nothing had happened to it (the owner saw "the receive invoice
     * screen for a second" between confirming and the sheet): a screen says what is going on instead. */
    if (this.showMelt) this.showMelt('Reaching ' + this.mintNameOf(x.mint) + '\u2026', 30000);
    Promise.resolve().then(() => W.cardVisit(x.mint)).then((visit) => {
      if (this.hideMelt) this.hideMelt();
      // a visit already ended by the time this one is there (a back out of the pad meanwhile) ends this one too
      if (this._fcXmLive !== x) { visit.end(); return; }
      this._fcXmVisit = visit;
      then();
    }, (e) => {
      if (this.hideMelt) this.hideMelt();
      console.warn('[foxy] card: the card’s mint could not be reached:', (W.reason ? W.reason(e) : (e && e.message)));
      this._fcXmLive = null;
      this.haptic && this.haptic('error');
      this.blockedCard('fc-xm-away', { tone: 'warn', title: 'NOT PAID',
        reason: 'Foxy could not reach ' + this.mintNameOf(x.mint) + ', where this card’s money is. Nothing was taken.' });
    });
  }

  /* The visit is over, however the payment went: this phone goes home, and keeps trying until it is there (`cardVisit`). Resolves
   * once it is home; what is said on the screen meanwhile does not wait for that. What the payment left at the card's mint is
   * settled there by the wallet, on a visit of its own (`cardAwayLeft`), once home. */
  fcXmHome() {
    const W = this.fcW();
    clearTimeout(this._fcXmStayT);
    this._fcXmLive = null;
    const v = this._fcXmVisit;
    this._fcXmVisit = null;
    if (!W || !v) return Promise.resolve();
    return Promise.resolve(v.end()).then(() => {
      this.refreshBalance();
      this.loadHistory();
      // and anything the payment left at the card's mint, settled there now that nothing else is (a minute's wait is the wallet's)
      if (W.cardAwayLeft) W.cardAwayLeft({ skipDue: true }).then((at) => { if (at && at.length) { this.refreshBalance(); this.loadHistory(); if (this.fcMoneyWaiting) this.fcMoneyWaiting(); } }, () => {});
    });
  }

  /* Kept at the card's mint for a flow that goes on there (a tap left part way, a mint that has not answered), which comes home when it
   * ends; and home after FC_XM_STAY_MS whatever, once no card flow is running. */
  fcXmStay() {
    clearTimeout(this._fcXmStayT);
    const wait = () => {
      this._fcXmStayT = setTimeout(() => {
        if (this.cardFlowBusy && this.cardFlowBusy()) { wait(); return; }
        this.fcXmHome();
      }, Number(this.FC_XM_STAY_MS) || 200000);
    };
    wait();
  }

  /* The card has paid this phone, and its pieces are held at its mint for this phone's own invoice: they are melted there, with the
   * quote agreed (`pay`, `opts.held`), and this phone goes home. Paid, the receive screen's watch of the invoice is asked at once,
   * and lands it. With the mint and unanswered, the wallet's own asking settles the melt, as any payment it is waiting on, and the
   * invoice lands when it is paid. Not paid (refused, or the code ran out first), the pieces go back to the card: made into pieces
   * for it at its mint and owed to it, put on at its next tap, with nothing taken (`cardOutBack`). */
  fcXmMelt(xm) {
    const W = this.fcW();
    this.refreshBalance();
    this.loadHistory();
    if (!W || xm.melting || xm.done) return;
    const held = String(xm.held || '');
    // (said at once: the way home does not hold up what is said)
    const back = (e, plain) => {
      const said = String(plain || (e ? (W.reason ? W.reason(e) : e.message) : '') || 'The payment was not made.').trim().replace(/\.?$/, '.');
      console.log('[foxy] card: the invoice was not paid from the card’s mint; what the card paid goes back to it — ' + said);
      // made into pieces for the card while this phone is still at its mint (`cardOutBack`), then home
      Promise.resolve(held && W.cardOutBack ? W.cardOutBack(held) : null).catch(() => null).then((r) => {
        this.fcXmHome();
        this.refreshBalance();
        this.loadHistory();
        this.fcFailed({ card: 'not-paid-out', message: said, amount: this.fcAmt(r) || xm.pay, unit: xm.payUnit, made: !!(r && r.made) }, { paying: true });
      });
    };
    if (!held) { xm.done = true; back(null, 'The card’s pieces were not kept for this payment.'); return; }
    // the code ran out while the card was read: the mint refuses a melt of it, so none is sent
    if (xm.ends && xm.ends - Date.now() < 5000) { xm.done = true; back(null, 'The code ran out while the card paid.'); return; }
    xm.melting = true;
    console.log('[foxy] card: ' + xm.want + (xm.payUnit === 'usd' ? ' cents' : ' sats') + ' held at the card’s mint; they pay this phone’s invoice');
    if (xm.quote && xm.quote.quote && xm.quote.quote.quote) this.txIsNew(String(xm.quote.quote.quote));
    /* The mint has not said yet: the wallet's own asking settles the melt (from home as well), and the invoice lands when it is paid;
     * the melt's change, and the whole of a melt found not to have gone, are the card's, owed to it at its mint (`cardAwayLeft`). */
    const waiting = () => {
      this.fcXmHome();
      console.log('[foxy] card: the payment from the card’s mint is pending');
      this.toast('The card’s mint has not answered yet. The payment lands when it does.', true);
    };
    /* The reserve the Lightning payment did not use is the card's (`changeToCard`), held for it and owed to it here, at its mint,
     * before this phone goes home: it goes on at the card's next tap, as the change of a payment out of a card always does. */
    Promise.resolve().then(() => W.pay(xm.bolt11, () => {}, { unit: xm.payUnit, quote: xm.quote, held, card: xm.key, changeToCard: true, cardVisit: true })).then((paid) => {
      xm.melting = false;
      xm.done = true;
      if (paid && paid.hash) this.txIsNew(String(paid.hash));
      if (paid && paid.pending) { waiting(); return; }
      const ch = paid && paid.cardChange;
      Promise.resolve(ch && this.fcAmt(ch) > 0 && W.cardOutBack ? W.cardOutBack(ch.id) : null).catch(() => null).then((r) => {
        this.fcXmHome().then(() => this.fcBtcLand(xm));
        // owed to the card now: its change tap, as after any till payment with change (TAP TO RECEIVE, no PIN)
        if (r && r.made && this.fcAmt(r) > 0) {
          this.refreshBalance();
          this.loadHistory();
          this.fcChangeWaiting(this.fcAmt(r), 0, xm.payUnit);
        }
      });
    }, (e) => {
      xm.melting = false;
      xm.done = true;
      if (e && e.pending) { waiting(); return; }
      back(e, e && e.plain);
    });
  }

  /* The payment is given up: what the card signed for it is made into pieces
   * for the card again, and the sheet comes up by itself to put them back. With
   * no route to the mint they are made once there is one, and said so. */
  /* `key`: the card held, where it is known; with none, every card held is let go, and the wallet answers each unit apart
   * (`also`), so a bitcoin card's sats and a dollar card's cents are never said as one figure. */
  fcLetGo(key) {
    const W = this.fcW();
    if (!W || !W.cardHeldLetGo) return Promise.resolve();
    return W.cardHeldLetGo(key || undefined).then((r) => {
      if (r && r.made && this.fcAmt(r) > 0) { this.fcReceiveNow(this.fcAmt(r), 0, { putBack: true, unit: this.fcUnitOf(r) }); return; }
      if (r && this.fcAmt(r) > 0) {
        this.blockedCard('fc-let-go', {
          tone: 'warn', title: 'NOT PAID',
          reason: 'What the card signed goes back on it once this phone reaches the mint, and the card\u2019s next tap here puts it back.',
          shut: { label: 'OK' },
        });
        return;
      }
      /* A card that signs once for a payment, taken away as it signed: whether
       * it signed is the card's to say, at its next tap here. */
      if (W.cardAskedOpen && W.cardAskedOpen() > 0) {
        this.blockedCard('fc-let-go', {
          tone: 'warn', title: 'NOT PAID',
          reason: 'If the card signed as it was taken away, its next tap on this phone finds that out and puts the money back on it.',
          shut: { label: 'OK' },
        });
      }
    }, () => {});
  }

  /* The change for a payment could not be made (the mint did not make it):
   * the payment stands, and this phone makes the change when it next
   * connects, after which a tap of the card here receives it. */
  fcChangeLater(sats, paid, unit) {
    const p = Math.round(Number(paid) || 0);
    this.blockedCard('fc-change-later', {
      tone: 'warn', title: 'CHANGE NOT MADE YET',
      reason: (p > 0 ? 'Paid ' + this.fcSats(p, unit) + '. ' : '') + 'The mint did not make its ' + this.fcSats(sats, unit)
        + ' of change. This phone tries again whenever it connects, and then a tap of the card here receives it.',
      chip: 'It is owed to that card and no other.',
      shut: { label: 'OK' },
    });
  }

  /* The second tap of a payment, asked for as soon as the mint has said paid:
   * the phone's sheet comes up by itself for the card again, with nothing to
   * press first. PIN, tap, remove the card, wait, tap again. A sheet that ends
   * with no card read (cancelled, timed out, Foxy put away) leaves TAP TO
   * RECEIVE up instead, so the change is never left without a way to it. A
   * moment's pause first: iOS refuses a reading session started on the heels
   * of the last one. */
  /* `o.unit`: the unit of the card the change is for, which its figures are in. */
  fcReceiveNow(sats, paid, o) {
    const p = Math.round(Number(paid) || 0);
    const n = Math.round(Number(sats) || 0);
    const putBack = !!(o && o.putBack);
    const unit = (o && o.unit === 'usd') ? 'usd' : undefined;
    clearTimeout(this._fcReceiveT);
    // TAP TO CONFIRM from now, through the pause and the tap, with nothing to press until the sheet is up
    if (!putBack) { this._fcTapO = this.fcReceiveLook(p, n, unit); this.fcStage('receive'); }
    this._fcReceiveT = setTimeout(() => {
      const W = this.fcW();
      // written meanwhile (or never owed here): nothing to ask for, and nothing to hold a confirmation for
      if (!W || !this.fcOwedAfterPaying()) {
        this.hideStage('card');
        this.fcReleaseConfirm('nothing is waiting for the card');
        return;
      }
      this.fcWriteRun('', Object.assign({ change: true, receive: !putBack, paid: p, sats: n,
                                          sheet: putBack ? 'Tap to put back signatures.' : '' }, unit ? { unit } : {}));
    }, 2500);
  }

  /* What TAP TO CONFIRM is drawn with for a tap that only takes change: the
   * amount of the payment it is the second tap of, or of the change where
   * this phone did not take the payment. */
  fcReceiveLook(paid, sats, unit) {
    return { look: 'receive', amount: this.fcPrice(paid > 0 ? paid : sats, unit) };
  }

  /* The second tap of a payment: RECEIVE. `paid` is what was paid, where
   * this phone was the till; a holder's own withdrawal with change has none. */
  fcChangeWaiting(sats, paid, unit) {
    const p = Math.round(Number(paid) || 0);
    this.blockedCard('fc-change', {
      tone: 'warn', title: 'TAP TO RECEIVE',
      reason: (p > 0 ? 'Paid ' + this.fcSats(p, unit) + '. ' : 'The money is off the card. ')
        + 'Tap the card again to receive its ' + this.fcSats(sats, unit) + ' of change. ' + this.fcNoPinWords(),
      chip: (p > 0 ? 'Tap 2 of 2. ' : '') + 'The change is kept for that card and no other.',
      retry: 'TAP CARD', go: () => this.fcWriteAsk(Object.assign({ paid: p, receive: true }, unit === 'usd' ? { unit } : {})),
      shut: { label: 'LATER', tap: () => this.fcReleaseConfirm('the change is left for later') },
    });
  }

  /* ---- what this phone owes cards -------------------------------------------
   *
   * Pieces made for a card and not on it yet: a top-up whose tap was cut
   * short, a payer's change, something a card signed for and was not paid.
   * They are locked to that card, so only it can spend them, and they go on
   * at the next tap with its PIN. */
  /* By card, in the card's own unit: `amount` is cents for a dollar card's (a card's rows are of its one unit, 08a-flashcard.js
   * `cardWriteOwed`). */
  fcOwed() {
    const W = this.fcW();
    const by = {};
    const unitOf = {};
    ((W && W.cardOwed()) || []).forEach((r) => {
      by[r.card] = (by[r.card] || 0) + this.fcAmt(r);
      if (!unitOf[r.card]) unitOf[r.card] = this.fcUnitOf(r);
    });
    return Object.keys(by).map(key => ({ key, unit: unitOf[key], amount: by[key] }));
  }

  /* What is owed to cards, in all, in one unit: one figure for a line that names no card. The unit is the one asked for
   * (`unit`, a change tap's), else that of the card on show where something is owed to it, else that of the first card owed:
   * sats and cents are never added together, and a dollar card being tapped is told its own cents. */
  fcOwedSum(unit) {
    const owed = this.fcOwed();
    const fc = this.state.fc;
    const shown = fc && fc.key ? owed.filter((r) => r.key === fc.key)[0] : null;
    const u = (unit === 'usd' || unit === 'sat') ? unit : shown ? shown.unit : owed.length ? owed[0].unit : 'sat';
    return { unit: u, amount: owed.filter((r) => r.unit === u).reduce((n, r) => n + r.amount, 0) };
  }

  fcWriteAsk(o) {
    const opt = o || {};
    /* Money moved for a card waits at the mint it was moved to, and can only
     * be written from there: said here, with the way to get there, and not
     * found out at the tap. */
    const W = this.fcW();
    const here = String((W && W.mintUrl) || '').replace(/\/+$/, '');
    /* (Not what is owed at the mint of a card that has just paid this phone from there, `fcXmPay`: a card's own pieces go on it from any
     * phone, whatever mint the phone is at.) */
    const xmAt = this._fcXmAt || {};
    const away = ((W && W.cardOwed()) || []).filter(r => r.mint && here && r.mint !== here && !xmAt[this.fcMintKey(r.mint)])[0];
    /* Money for the card on its own screen, at another mint (a TRANSFER's new pieces, cut off before they went on): this phone visits
     * that mint for the tap and comes back (`fcMoveWrite`), and is not sent to switch. */
    const fc0 = this.state.fc;
    if (away && !opt.here && fc0 && away.card === fc0.key && this.state.screen === 'flashcard') { this.fcMoveWrite(away.mint); return; }
    if (away && !opt.here) {
      this.blockedCard('fc-other-mint', {
        tone: 'warn', title: 'A DIFFERENT MINT',
        reason: 'That money is at ' + this.mintNameOf(away.mint) + '. Switch this phone to it, then tap the card.',
        retry: 'SWITCH MINT', go: () => this.goSwitchMint(), shut: { label: 'CANCEL' },
      });
      return;
    }
    /* The card on screen is this phone's own: it loads it with its own proof and
     * no PIN. Any other card is written to as a till writes change, with its PIN. */
    const fc = this.state.fc;
    /* A card of 1.21 and on on its screen wants its PIN for every load, its owner's and a payment's change included: the PIN is asked
     * before the card is, so it is tapped once (`fcCardPinFirst`); a tap with none, refused for want of it, then the pad and a second tap,
     * was what the owner's phone did. */
    const pinFirst = !!(fc && this.state.screen === 'flashcard' && this.fcCardPinFirst()) || this.fcKnownPinFirst();
    if (fc && fc.ownedHere && this.state.screen === 'flashcard' && !opt.pin && !pinFirst) { this.fcWriteRun('', Object.assign({}, opt, { owner: true })); return; }
    /* What is owed is a payment's change, or pieces a card signed for a payment
     * that was not made: the card has just paid, and lets the tap after a payment
     * put pieces on with no PIN. Tapped first without one; a card that asks for
     * it after all is given it on the next tap. */
    if (!opt.pin && !pinFirst && this.fcOwedAfterPaying()) { this.fcWriteRun('', Object.assign({}, opt, { change: true })); return; }
    // money made for a card that has no PIN (FLASHCARD on the send screen): nothing to ask, whoever holds it writes it
    if (opt.noPin) { this.fcWriteRun('', opt); return; }
    const sum = this.fcOwedSum(opt.unit);
    const owed = sum.amount;
    this.fcAskPin({
      title: 'CARD PIN',
      subtitle: owed > 0 ? 'To put ' + this.fcBoth(owed, sum.unit) + ' on the card.' : 'To write to the card.',
      cta: owed > 0 ? 'PUT ' + this.fcPrice(owed, sum.unit) + ' ON CARD' : 'WRITE TO CARD',
      // backed out of: a payment's confirmation held for this goes up
      onBack: () => this.fcReleaseConfirm('the change was not taken'),
    }, (pin) => this.fcWriteRun(pin, opt));
  }

  /* Whether what this phone owes cards came of a payment: change, a refund of
   * what a card signed and left with, or a payment the mint refused put back. */
  fcOwedAfterPaying() {
    const W = this.fcW();
    return ((W && W.cardOwed()) || []).some((r) => r && (r.kind === 'change' || r.kind === 'refund' || r.kind === 'putback'));
  }

  /* `opt.owner`: this phone's own proof that it owns the card, and no PIN.
   * `opt.change`: the tap after a payment, which needs none either. */
  fcWriteRun(pin, o) {
    const W = this.fcW();
    const opt = o || {};
    const how = opt.owner ? { owner: true } : opt.change ? { change: true } : { pin };
    const looks = opt.receive ? this.fcReceiveLook(Math.round(Number(opt.paid) || 0), Math.round(Number(opt.sats) || 0), opt.unit) : {};
    this.fcTap({ amount: looks.amount || (opt.sats ? this.stageMoney(opt.sats, opt.unit) : ''), look: looks.look || '', lost: !!opt.lost, wrote: !!opt.lost,
                 sheet: opt.sheet || (opt.receive ? 'Hold for change.' : ''),
                 // what went on stays on: the same sheet asks for the card again for the rest
                 again: (e) => (e && e.card === 'gone') ? 'Hold for the rest.' : '' },
               (link, on, progress) => { on('writing'); return W.cardWrite(link, Object.assign({ progress }, how)); })
      .then((r) => this.fcWrote(r, opt),
            /* Not the owner after all (another card was tapped), or not the tap
             * after a payment after all: the PIN is what writes then. */
            /* And a card that wants its PIN where none was given (a card of 1.21 and on wants it for every load, its owner's too): the
             * PIN is asked, and what is waiting for the card is written with it; nothing is made again. */
            (e) => ((opt.owner && e && e.card === 'not-owner') || (opt.change && e && e.card === 'pin-needed') || (!pin && e && e.card === 'pin-needed'))
              ? this.fcWriteAsk(Object.assign({}, opt, { pin: true, owner: false, change: false, noPin: false }))
              : (e && e.card === 'cancelled')
                ? this.fcStillWaiting(opt)
                /* The card left after some pieces went on: the sheet again by
                 * itself for the rest. A tap of it that reads no card says what
                 * is still waiting. Where nothing went on, the card says so and
                 * waits to be asked, so a card that keeps leaving is not asked forever. */
                // the sheet asked for the card again and was dismissed: what is still waiting is said, with TAP CARD
                : (e && e.card === 'gone' && e.sheetClosed)
                  ? this.fcStillWaiting(opt)
                : (e && e.card === 'gone' && e.wrote > 0)
                  ? this.fcWriteAgain(opt)
                  : (this.fcReleaseConfirm('the change tap failed'), this.fcFailed(e, { again: () => this.fcWriteAsk(opt) })));
  }

  /* RECEIVE in the same sheet as SEND.
   *
   * The card has signed and may be taken away; the sheet stayed up saying so
   * (`keepSheet`, 08a-flashcard.js) while the mint answered and the change was
   * made. Now the same sheet asks for the card again and puts the change on,
   * with no PIN, and ends saying the change is back. A second sheet opened for
   * this was refused by iOS as often as not, and the person was left a card to
   * press. Never throws: whatever is not done here (the sheet dismissed, or
   * timed out at iOS's minute, or a card that wants its PIN) is left on the
   * result unwritten, and the screen takes it from there. */
  fcChangeInSheet(link, on, progress, r, pin) {
    const W = this.fcW();
    const ch = r && r.change;
    if (!W || !link || link.released || typeof link.again !== 'function' || !(ch && !ch.written && !ch.unmade && this.fcAmt(ch) > 0)) return Promise.resolve(r);
    let tries = 0;
    // TAP TO CONFIRM from the moment the card is asked for, and not only once it is found
    const once = (line) => { this.fcStage('receive'); return ask(line); };
    // and TAP AGAIN once the card has left part way through being written to
    const lost = () => { if (this._fcTapO) this._fcTapO.lost = true; };
    /* With no PIN, as the card allows the one tap after a payment. A card that
     * left part way through has used that tap up, and wants its PIN for the
     * rest: it is given the one typed for this payment, as every tap of the
     * one payment is (`fcResumeNow`), and nobody is asked for it twice. */
    const put = (withPin) => W.cardWrite(link, withPin ? { pin, progress } : { change: true, progress })
      .then(null, (e) => { if (!withPin && pin && e && e.card === 'pin-needed') return put(true); throw e; });
    const ask = (line) => link.again(line).then(() => {
      on('writing');
      return put(false).then((w) => {
        if (w && w.left > 0 && this.fcAmt(w) > 0 && tries < 3) { tries += 1; lost(); return once('Hold for the rest.'); }
        // written when nothing made for this payment is still owed to a card
        const still = ((W.cardOwed && W.cardOwed()) || []).some((x) => x && r && x.forHash === r.hash);
        ch.written = !!(w && !(w.left > 0) && !still);
        if (ch.written) link.doneText = 'Done.';
        /* A holder's withdrawal has the card as the tap knew it (`r.card`); that tap read it after the change went on, and that is the card as it
         * stands. It was not read as the owner, so what only that read says (`mine`, its log, its receipts, the change it owes itself) is kept
         * from the one before. */
        if (ch.written && r && r.card && w && w.card && w.card.key === r.card.key) {
          r.card = Object.assign({}, w.card, { mine: r.card.mine, log: r.card.log, receipts: r.card.receipts, owes: r.card.owes, design: w.card.design || r.card.design });
        }
        return r;
      }, (e) => {
        // taken away while it was written: what went on stays on, and the same sheet asks again
        if (e && e.card === 'gone' && tries < 3) { tries += 1; lost(); return once('Hold for change.'); }
        return r;
      });
    }, () => r);
    return once('Hold for change.');
  }

  /* The mint refused a payment after the card had signed, with the sheet still
   * up (`keepSheet`): what is still good goes back on the card in the same
   * sheet, and the payment's failure is said once it is back. Always rejects
   * with the payment's own error; `putBackDone` says it went back, and
   * `sheetText` ends the sheet calmly. */
  fcPutBackInSheet(link, on, progress, e, pin) {
    const W = this.fcW();
    if (!W || !e || e.card !== 'putback' || !(e.owed > 0) || !link || link.released || typeof link.again !== 'function') return Promise.reject(e);
    let tries = 0;
    // the same ground as a payment's second tap, saying what this one is for
    if (this._fcTapO) this._fcTapO.putBack = true;
    const once = (line) => { this.fcStage('receive'); return ask(line); };
    // with the payment's own PIN where the card has used up its tap without one (`fcChangeInSheet`)
    const put = (withPin) => W.cardWrite(link, withPin ? { pin, progress } : { change: true, progress })
      .then(null, (x) => { if (!withPin && pin && x && x.card === 'pin-needed') return put(true); throw x; });
    const ask = (line) => link.again(line).then(() => {
      on('writing');
      return put(false).then((w) => {
        if (w && w.left > 0 && this.fcAmt(w) > 0 && tries < 3) { tries += 1; return once('Hold for the rest.'); }
        if (w && w.back > 0 && !(w.left > 0)) {
          e.putBackDone = w.back;
          e.sheetText = 'Payment did not go through.';
        }
        throw e;
      }, (x) => {
        if (x && x.card === 'gone' && tries < 3) { tries += 1; return once('Tap behind the phone.'); }
        throw e;
      });
    }, () => { throw e; });
    return once('Payment did not go through.');
  }

  /* A card payment's PAYMENT RECEIVED (announcePayment, 12-receive.js) waits
   * while its change is made and taken: it came up the moment the payment
   * landed, with the payer still to tap for their change, and read as if it
   * were over. It goes up when the change is back on the card, when the
   * change is left for later, when nothing is owed for the payment any more
   * however that came about, or after two and a half minutes whatever
   * happens, so it is never lost.
   *
   * `hash` is the payment's entry: only its confirmation is held. A hold that
   * held whatever came kept one payment's confirmation through the next
   * payment, and raised it, with its amount, when that one's change went back. */
  fcHoldConfirm(hash) {
    this._holdConfirmUntil = Date.now() + this.FC_HOLD_MS;
    this._holdConfirmFor = String(hash || '');
    clearTimeout(this._holdConfirmT);
    this._holdConfirmT = setTimeout(() => this.fcReleaseConfirm('the change tap took too long'), this.FC_HOLD_MS);
  }

  fcReleaseConfirm(why) {
    if (this.releaseHeldConfirm) { this.releaseHeldConfirm(why); return; }
    clearTimeout(this._holdConfirmT);
    this._holdConfirmUntil = 0;
    this._holdConfirmFor = '';
  }

  /* The hold let go with nothing raised: for a payment that was not made, and
   * for one left over when the next payment begins. */
  fcDropConfirm() {
    if (this._heldConfirm) console.log('[foxy] confirmation: a held one is dropped, not raised; it is in HISTORY');
    this._heldConfirm = null;
    clearTimeout(this._holdConfirmT);
    this._holdConfirmUntil = 0;
    this._holdConfirmFor = '';
  }

  /* Whether anything made for a card after a payment is still to go back on
   * one; and the confirmation let go when nothing is. Asked after every tap
   * that could have written it, whatever that tap came to: the change of a
   * payment went back on a tap that ended as cancelled, nothing said so, and
   * its PAYMENT RECEIVED never came. */
  fcConfirmIfSettled(why) {
    if (this.fcOwedAfterPaying()) return false;
    this.fcReleaseConfirm(why || 'nothing is waiting for the card');
    return true;
  }

  /* ---- no confirmation over a card that is being read or written ------------------------------------------------------
   *
   * A payment's PAYMENT RECEIVED is raised over whatever screen is up (`announcePayment`, 12-receive.js), and one that came while a card
   * was being tapped (the late end of an earlier payment's swap, say) rose over the card's own screen, with the phone's sheet up
   * under it. It waits instead, in the queue of confirmations (`_paidQueue`, which `nextPaidScreen` empties one at a time, in order),
   * until the card flow is over.
   *
   * A card flow is going on while: a tap is in progress (the phone's sheet is up, or the screen behind it, or the pause between two taps
   * of one flow, which keeps that screen), the pieces for a tap are being made (GETTING IT READY, TAKING IT BACK), a card's PIN is being
   * asked for a tap, or a card is up that asks for the card to be tapped again (TAP CARD: the rest of a withdrawal, a payment held, change
   * still to take). Nothing is kept for ever: a confirmation that has waited FC_HOLD_MS is raised whatever is on the screen. */
  cardFlowBusy() {
    return (this._fcTaps || 0) > 0 || this.stageUp('card') || this.stageUp('cardReady') || this.stageUp('cardBack') || this.fcPadUp() || this.fcAskingForCard()
      // (the set-up's SET AMOUNT, 26j-card-wheel.js, and its MAX SPEND PER SECOND)
      || !!(this.fcSuAsking && this.fcSuAsking()) || !!(this._fcSu && this.state.screen === 'fcSpeed');
  }

  // a card's PIN pad, asked for a tap, is still up
  fcPadUp() {
    const pad = this._fcPadEl;
    return !!(pad && pad.parentNode && pad === this._pinEl);
  }

  // a card of the card screens is up, and its button is the card to be tapped again
  fcAskingForCard() {
    const up = this._blockedEl;
    return !!(up && up.parentNode && /^fc-/.test(String(this._blockedKind || '')) && /TAP CARD/.test(up.textContent || ''));
  }

  /* Whether this payment's confirmation waits for the card flow: there is one, and the payment is not the one it is making. The flow's
   * own payment is held by the flow, from the moment the card has signed until its change is back (`fcHoldConfirm`), and that is not
   * touched here. */
  cardFlowHolds(ev) {
    if (!this.cardFlowBusy()) return false;
    const hash = String((ev && (ev.hash || ev.tokenHash)) || '');
    return !(hash && hash === String(this._holdConfirmFor || '') && Date.now() < (this._holdConfirmUntil || 0));
  }

  /* A confirmation that came while a card was being tapped: kept in the queue, behind the ones before it, to be raised when the card
   * flow is over. One already queued under its name (the history pass found it) waits where it is. */
  keepForCardFlow(ev) {
    const hash = String((ev && (ev.hash || ev.tokenHash)) || '');
    const queue = this._paidQueue = this._paidQueue || [];
    if (!(hash && queue.some((q) => q && q.hash === hash))) {
      queue.push({ dir: ev.dir || 'in', sats: ev.sats, hash: ev.hash, party: ev.to || '', ev: Object.assign({}, ev), held: Date.now() });
    }
    console.log('[foxy] confirmation held back: a card is being read or written; it is raised when that is over');
    this.queueLater();
  }

  /* A card screen has come down. If that was the end of the card flow, the confirmations kept for it are raised; a moment later, so that a flow that
   * goes straight on to its next screen (a pause, a card, the next tap) is not mistaken for one that has ended. */
  cardFlowMayHaveEnded() {
    clearTimeout(this._fcEndT);
    this._fcEndT = setTimeout(() => {
      this._fcEndT = null;
      if (this.cardFlowBusy()) return;
      if (this._paidQueue && this._paidQueue.length) this.nextPaidScreen();
    }, this.FC_END_SETTLE_MS);
  }

  fcWriteAgain(o) {
    clearTimeout(this._fcResumeT);
    this._fcResumeT = setTimeout(() => this.fcWriteAsk(Object.assign({}, o, { sheet: 'Hold for the rest.', lost: true })), 2500);
    // a payment's second tap, which the card left part way through: TAP AGAIN stays up through the pause
    if (o && o.receive) {
      // (some of it went on: that is why the card is asked for again)
      this._fcTapO = Object.assign(this.fcReceiveLook(Math.round(Number(o.paid) || 0), Math.round(Number(o.sats) || 0), o.unit), { lost: true, wrote: true });
      this.fcStage('receive');
    }
  }

  /* A write tap that closed with no card read (the sheet went without a tap,
   * or was cancelled): what is still waiting is said again, with the tap to
   * try once more, instead of nothing. A person who has just been told to tap
   * for their change must not be left wondering whether anything happened. */
  fcStillWaiting(opt) {
    const sum = this.fcOwedSum(opt.unit);
    const owed = sum.amount;
    // it all went on after all, in a tap that ended as if it had not: the payment is whole
    if (!(owed > 0)) { this.fcReleaseConfirm('nothing is waiting for the card'); return; }
    const after = this.fcOwedAfterPaying();
    this.blockedCard('fc-change', {
      tone: 'warn', title: after ? 'TAP TO RECEIVE' : 'TAP THE CARD AGAIN',
      reason: 'The card was not read. ' + this.fcSats(owed, sum.unit) + ' is still waiting to go ' + (after ? 'back on it.' : 'onto it.') + (after ? ' ' + this.fcNoPinWords() : ''),
      chip: 'It is kept for that card and no other.',
      retry: 'TAP CARD', go: () => this.fcWriteAsk(opt),
      shut: { label: 'LATER', tap: () => this.fcReleaseConfirm('the change is left for later') },
    });
  }

  fcWrote(r, o) {
    // a card that was at another mint and has been moved by this write is told so, below
    const was = String((this.state.fc && this.state.fc.mint) || '').replace(/\/+$/, '');
    // what the balance on its screen says before this write, which it counts from (where a count is still going, the figure it has got to)
    const before = (this.state.fc && r.card && this.state.fc.key === r.card.key) ? this.fcBalanceShown(this.state.fc, this.state) : null;
    this.fcShow(r.card);
    const now = String((r.card && r.card.record && r.card.record.mint) || '').replace(/\/+$/, '');
    const moved = !!(was && now && was !== now);
    // what went on, in the card's own unit (a dollar card's cents are `amount`; its `sats` are 0)
    /* The unit of what went on: a card of both loaded with sats says `sats` while its record is in dollars, so a figure of nought in the
     * card's unit is read again in the other (the success screen once said "$0.00" for 3,094 sats). */
    const u0 = this.fcUnitOf(r);
    const went0 = this.fcAmt(r);
    const u = (went0 > 0 || !(Number(r && r.sats) > 0)) ? u0 : 'sat';
    const went = went0 > 0 ? went0 : Math.max(0, Math.round(Number(r && r.sats) || 0));
    this.refreshBalance();
    this.loadHistory();
    /* Cut short with some of it written: the sheet comes up again by itself
     * for the rest (a tap of it that reads no card says what is still waiting,
     * `fcStillWaiting`). Not where nothing went on: that would ask forever. */
    if (r.left > 0 && r.why !== 'full' && went > 0) { this.fcWriteAgain(o); return; }
    if (r.left > 0) {
      this.blockedCard('fc-more', {
        tone: 'warn', title: r.why === 'full' ? 'THE CARD IS FULL' : 'TAP THE CARD AGAIN',
        reason: (went > 0 ? this.fcSats(went, u) + ' went on. ' : '')
          + (r.why === 'full' ? 'There is no room for the rest. Take some money off it first.' : 'The rest is still waiting for it.'),
        retry: 'TAP CARD', go: () => this.fcWriteAsk(o),
        shut: { label: 'LATER', tap: () => this.fcReleaseConfirm('the rest is left for later') },
      });
      return;
    }
    /* Nothing made after a payment is waiting for a card any more: that
     * payment's confirmation is not held for it, whatever this tap put on.
     * (A payment's change says so itself, below.) */
    if (!(r.change > 0 && r.change + (r.refund || 0) === went)) this.fcConfirmIfSettled('nothing is waiting for the card');
    if (!(went > 0)) {
      /* Nothing was owed to the card that was tapped. Where something is
       * still owed, it is owed to another card, and saying so is the only way
       * the person finds out they picked up the wrong one. */
      const owed = this.fcOwed();
      this.blockedCard('fc-none', {
        tone: 'warn', title: owed.length ? 'A DIFFERENT CARD' : 'NOTHING TO WRITE',
        reason: owed.length
          ? 'Nothing was waiting for this card. ' + this.fcSats(owed[0].amount, owed[0].unit) + ' is waiting for ' + this.fcName(owed[0].key) + '.'
          : 'Nothing was waiting for this card.',
      });
      return;
    }
    this.haptic && this.haptic('success');
    /* A payment the mint refused, put back: said as that, with what else went on in the same tap. */
    if (r.back > 0) {
      this.blockedCard('fc-put-back', {
        tone: 'ask', title: 'PUT BACK ON THE CARD',
        reason: this.fcSats(r.back, u) + ' is back on the card. The payment was not made.'
          + (went > r.back ? ' ' + this.fcSats(went - r.back, u) + ' more went on.' : '')
          + (this.state.screen === 'flashcard' ? ' It now holds ' + this.fcSats(this.fcCardHolds(r.card, u), u) + '.' : ''),
        shut: { label: 'DONE' },
      });
      return;
    }
    /* The second tap of a payment: its change is back on the card, and the
     * payment is COMPLETE. */
    /* The change of a payment, back on the card: said in passing, and the
     * payment's own PAYMENT RECEIVED, held until now, goes up at once. It was
     * a COMPLETE card with DONE, and the confirmation waited on the press,
     * which did not always come. */
    if (r.change > 0 && r.change + (r.refund || 0) === went) {
      this.toast(this.fcSats(r.change, u) + ' of change is back on the card'
        + (r.refund > 0 ? ', and ' + this.fcSats(r.refund, u) + ' from a payment that was not finished' : '') + '.');
      this.fcReleaseConfirm('the change is back on the card');
      return;
    }
    /* What a card signed for a payment that was not made, back on it: said
     * as that, and not as money put on it. */
    if (r.refund > 0 && r.refund === went) {
      this.blockedCard('fc-refunded', {
        tone: 'ask', title: 'BACK ON THE CARD',
        reason: this.fcSats(r.refund, u) + ' is back on the card. The payment was not made.'
          + (this.state.screen === 'flashcard' ? ' It now holds ' + this.fcSats(this.fcCardHolds(r.card, u), u) + '.' : ''),
        shut: { label: 'DONE' },
      });
      return;
    }
    /* What it now holds is said to its holder by the FLASHCARD screen itself: the balance counts up to it, and no card is raised over
     * it. The two things the balance cannot say are said in a line: that the card was moved to this phone's mint by the same tap, and
     * that more than was asked for went on. */
    if (this.state.screen === 'flashcard' && !(o && o.renewed)) {
      this.fcRollStart(before);
      const note = (moved ? 'The card is now at ' + this.mintNameOf(now) + '.' : '')
        // an amount of too many pieces is rounded up, so the card has fewer to sign for and is quicker to use
        + ((o && o.rounded > 0) ? (moved ? ' ' : '') + this.fcSats(o.rounded, u) + ' more than you asked for, so the card holds fewer pieces and is quicker to use.' : '');
      if (note) this.toast(note);
      return;
    }
    /* Money put on a card that is not on show (FLASHCARD on the send screen, which leaves the person at Home) or renewed ends on the
     * app's own success screen, ON THE CARD, with its flash, as a payment does (24-render-receive-and-send.js, `renderPaid`): the sheet
     * that said it was out of place among the other endings (the design's rule). What the balance cannot say goes in a line after. */
    // nothing went on (a read after a write that put nothing, a reset): nothing to celebrate
    if (!(went > 0)) return;
    /* A payment's change put back on the card (TAP TO RECEIVE, `fcChangeWaiting`; the change tap of a till): the ending is the
     * payment's own confirmation, held for this and released now, not a success screen of its own (which once came up over it as
     * ON THE CARD $0.00). A line says the change is back. */
    if (o && (o.receive || o.change)) {
      this.toast(this.fcSats(went, u) + ' of change is back on the card.');
      this.fcReleaseConfirm('the change is back on the card');
      return;
    }
    this._lastFee = 0;
    this._lastPay = null;
    this.setState(p => ({
      screen: 'paid', stack: p.stack.concat([p.screen]),
      payOut: true, paidSays: 'ON THE CARD', paidTo: 'ECASHCARD', paidPlace: null, paidUnit: u, paidAmount: went,
      paidAsked: 0, paidAskedSats: 0, paidAskOwn: false, paidConvert: false,
      recvResolved: true, recv: Object.assign({}, p.recv, { live: 'in' }),
    }));
    this.haptic && this.haptic('success');
    const said = (moved ? 'The card is now at ' + this.mintNameOf(now) + '.' : '')
      // an amount of too many pieces is rounded up, so the card has fewer to sign for and is quicker to use
      + ((o && o.rounded > 0) ? (moved ? ' ' : '') + this.fcSats(o.rounded, u) + ' more than you asked for, so the card holds fewer pieces and is quicker to use.' : '');
    if (said) this.toast(said);
  }

  /* ---- the balance counts to what the card holds ---------------------------------------
   *
   * Money put on a card or taken off it from its own screen is not said by a card raised over it: the screen is there, and its balance
   * counts from the figure it showed to the one the card holds now, as home's does when money lands (`runBalanceAnim`,
   * 19-update-keypad-balance.js: the same length, the same ease out). What the card holds is state, and the count is a lerp from
   * `fcRoll.from` to it, so a count that another read cuts short still ends on the right figure. A phone set to reduce motion is shown the
   * new figure at once. */
  FC_ROLL_MS = 1150;

  fcRollStart(from) {
    const fc = this.state.fc;
    clearInterval(this._fcRollT);
    // from nothing known (another card was on show), or from what it already shows, or with reduced motion: there is nothing to count
    const was = (from === null || from === undefined) ? NaN : Math.round(Number(from));
    let still = false;
    try { still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { still = false; }
    if (!fc || !(was >= 0) || was === Math.round(fc.balance) || still) { if (this.state.fcRoll) this.setState({ fcRoll: null }); return; }
    const began = Date.now();
    this.setState({ fcRoll: { key: fc.key, from: was }, fcRollT: 0 });
    this._fcRollT = setInterval(() => {
      const t = Math.min((Date.now() - began) / this.FC_ROLL_MS, 1);
      // done, or the screen was left: what it holds is what it shows
      if (t >= 1 || this.state.screen !== 'flashcard') { clearInterval(this._fcRollT); this.setState({ fcRoll: null, fcRollT: 1 }); return; }
      this.setState({ fcRollT: t });
    }, 40);
  }

  /* Does this card hold two balances? Only a card whose software reports more than one unit, and none does yet:
   * a card of software 1.20 and before holds sats alone and reports no units at all. */
  fcTwoUnits(fc) {
    return !!(fc && Array.isArray(fc.units) && fc.units.length > 1);
  }

  /* The sats the balance on the card's screen says now: what it holds, or where its count has got to. */
  fcBalanceShown(fc, s) {
    if (!fc) return 0;
    const r = s && s.fcRoll;
    if (!r || r.key !== fc.key) return fc.balance;
    const t = Math.min(1, Math.max(0, Number(s.fcRollT) || 0));
    return Math.round(r.from + (fc.balance - r.from) * (1 - Math.pow(1 - t, 3)));
  }

  /* ---- CARD on home: reading a card ------------------------------------- */

  /* `open`: the card's screen is opened by what is read (the menu's way in).
   *
   * The owner's read also looks into the change the card has made for itself and no till has handed
   * back (`change`, 08a-flashcard.js `cardOwnerChange`): fetched from the mint, and put on the card
   * in this tap when there is any, with the sheet saying so.
   *
   * And it is the read that asks a card of software 1.20 for the mint's proofs of the pieces this phone
   * does not know to be real (`real`): they are checked once the card is let go (`fcReal`). */
  fcRead(open) {
    const W = this.fcW();
    if (!W) return;
    // with the price, so that a limit this phone set in dollars is kept at those dollars (08a-flashcard.js, `cardLook`)
    /* (none for a dollar card on show: its limits are dollars, and are never re-pegged; the wallet holds to that whatever it is
     * sent, since the card read may be another) */
    // (software 1.23: every card's rate follows the price, a dollar card's too, so the price is sent for a card of it)
    // (and never another phone's price, or one too old to trust, for a card's rate: `fcRatePrice`)
    const price = (this.state.fc && this.state.fc.unit === 'usd' && !this.state.fc.v123) ? 0 : (this.fcRatePrice ? this.fcRatePrice() : (this.px && this.px()) || 0);
    this.fcTap({}, (link, on, progress) => W.cardLook(link, { mine: true, price, change: true, real: true, on, progress })
      .then((card) => {
        if (card && card.owes && card.owes.wrote > 0) link.doneText = 'Done.';
        return card;
      }))
      .then((card) => {
        this.fcShow(card, open);
        // (software 1.23: a rate far from the card's is asked about once, `fcRateAsk`)
        if (card && card.rateAsk) this.fcRateAsk(card);
        // change a till never handed over has been fetched and put on: said in passing, as change put back always is
        if (card && card.owes && card.owes.wrote > 0) { this.haptic && this.haptic('success'); this.refreshBalance(); this.loadHistory(); }
        // its owner, online, and its money near its date: the renewal is offered now
        this.fcRefreshMaybe(card);
        this.fcRekeyMaybe(card);
      }, (e) => this.fcFailed(e, { again: () => this.fcRead(open) }));
  }

  /* What a card said, kept for the screen. Only on the FLASHCARD screen, or
   * on the way to it (`open`): a payer's card read at the till is not left
   * on show in the menu. */
  fcShow(card, open) {
    if (!card || !card.key) return;
    if (this.state.screen !== 'flashcard') {
      if (!open) return;
      this.setState(p => ({ screen: 'flashcard', stack: p.stack.concat([p.screen]) }));
    }
    const W = this.fcW();
    const dates = (card.pieces || []).map(x => x.date).filter(Boolean);
    // what the screen already says of this same card
    const prior = (this.state.fc && this.state.fc.key === card.key) ? this.state.fc : null;
    this._fcCard = card;
    this.setState({ fc: {
      /* The one kind of money it holds, from its record: 'usd' for a dollar card, 'sat' for any other. Its balance, its
       * limits and every figure the screen says of it are in that unit: cents for a dollar card. */
      unit: (card.record && card.record.unit === 'usd') ? 'usd' : 'sat',
      key: card.key, balance: card.balance, count: (card.pieces || []).length,
      room: card.info.empty + card.info.spent,
      pin: card.info.pin, locked: !!card.info.locked, hasRecord: !!card.info.hasRecord,
      /* software 1.16 and on: the PIN is optional. `setUp`: the card has its record (and, before 1.16, a PIN); `pinSet`: it has a PIN (a blocked one does);
       * `noPinKnown`: its software can be without one and has the no PIN limit; `noPin`: that limit and what is left of it today (`known`, `set`, `limit`, `left`) */
      setUp: !!card.info.setUp, pinSet: !!card.info.pinSet, noPinKnown: !!card.info.noPinKnown, noPin: card.noPin || null,
      // software 1.21 and on: a PIN before any money, every load under it, and the owner taken in a held claim
      pinFirst: (() => { const v = String(card.info.version || '').split('.'); return Number(v[0]) > 1 || (Number(v[0]) === 1 && Number(v[1]) >= 21); })(),
      /* software 1.22 and on: a card with a PIN and no owner is a holder's with no phone, shown with VIEW AS GUEST and TIE OWNERSHIP
       * TO THIS PHONE; `guestRead`, the history it showed as a guest in this tap (`fcGuestRun`), which this phone keeps nowhere */
      guests: !!card.info.guests, guestRead: !!card.guest,
      /* software 1.24 and on: a card with no owner is connected to a phone with money on it as well as empty (`claimFull`); and a card
       * so connected whose backup is still to move here (the wallet's `cardRekeyDue`, `rekeyDue` on a read that could not ask) */
      claimFull: !!card.info.claimFull,
      rekeyDue: !!card.rekeyDue || !!(W && W.cardRekeyDue && W.cardRekeyDue(card)),
      // a set-up this phone began for the card's holder and did not finish (`cardSetUpFor`): not this phone's to set up as its own
      forHolder: !!card.forHolder,
      limit: (card.record && card.record.limit) || 0,
      day: card.day || null,
      // the limit on one tap: { known, limited, limit, left, turns }; `known` false on a card whose software has none
      tap: card.tap || null,
      // the card's own log, where this phone is its owner and the card keeps one: counts, the last eight taps, what is new
      log: card.log || null,
      // its receipts, as this phone has them: { count, list, fresh }; and how far its clock is ahead of this phone's, in seconds
      receipts: card.receipts || null,
      // (for a card before 1.15 only: a card of 1.15 and on is ahead of this phone's newest block header at most, which no screen says)
      clockAhead: (card.info && card.info.headers) ? 0 : Math.round(Number(card.clockAhead) || 0),
      // a card of software 1.15 and on keeps its time by Bitcoin block headers: the block its clock reads (the hash of the last it was shown, and the time in it)
      headers: !!(card.info && card.info.headers),
      clock: (card.info && card.info.headers) ? { hash: String(card.info.headerHash || ''), short: (W && card.info.headerHash) ? W.headerShort(card.info.headerHash) : '', time: Number(card.info.now) || 0 } : null,
      owner: !!(card.info && card.info.owner),
      // software 1.17 and on: its owner can reset it (RESET CARD)
      resetKnown: !!(card.info && card.info.resetKnown),
      /* whether this phone is its owner, which the card was asked (a till does not ask). A read that did not ask (`card.mine`
       * undefined: the short read after money went on under the PIN, say) keeps the answer the card gave before: the $10 put on a
       * 1.23 card under its PIN left SWAP and CHANGE LIMIT saying NOT THIS PHONE'S CARD to the phone that had set it up. */
      ownedHere: card.mine === true || (card.mine === undefined && !!prior && prior.ownedHere === true),
      mint: (card.record && card.record.mint) || '',
      /* Software 1.23: dollars and sats at its one mint. `v123`: the card is of it, and its ceiling is cents for both its currencies
       * (`cents`); `units`: the two it holds (or may: format 5), for `fcTwoUnits`, or the one; `bal`: what it holds in each; `rate`: the
       * sats a dollar its sats payments are weighed at, where it said (to its owner). */
      v123: !!(card.info && card.info.units), cents: !!(card.info && card.info.cents),
      units: (W && W.cardUnits && W.cardUnits(card)) ? W.cardUnits(card).map((x) => x.unit) : null,
      bal: card.units ? { usd: card.units.usd.balance, sat: card.units.sat.balance } : null,
      /* `only`: the one currency its owner chose for it when this phone set it up ('usd' or 'sat'), which this phone's ADD FUNDS and
       * SEND put on it and nothing else; '' for a card of both, one this phone made no such promise for, or one that holds the other
       * currency all the same (given it elsewhere): that is a card of both (the wallet's `cardHold`) */
      only: (() => { const h = (W && W.cardHold) ? W.cardHold(card) : ''; return h === 'usd' || h === 'sat' ? h : ''; })(),
      /* `both`: the card holds both or may (format 5, the wallet's `cardBoth`), as against one shown with two pills only because its
       * owner chose BOTH when this phone set it up (`units` lists both for either): that one is not swapped until it holds some of each */
      both: !!(W && W.cardBoth && W.cardBoth(card)),
      rate: (card.info && card.info.rateSaid) ? Number(card.info.rate) || 0 : 0,
      recoverable: !!(card.record && card.record.refundKey),
      mine: !!(W && W.cardIsMine(card)),
      first: dates.length ? Math.min.apply(null, dates) : 0,
      last: dates.length ? Math.max.apply(null, dates) : 0,
      /* A card read the short way (after money went on or off it, say) lists no nonces, so there is nothing to put to the mint (`fcCheck`): what the
       * screen said of the mint's word, and when, stands, and is not left asking. */
      check: (card.bare && prior) ? prior.check : (card.pieces || []).length ? 'asking' : 'none',
      // (a card that held nothing had nothing for the mint to dispute, and what has gone on it since this phone has just made)
      checkedAt: (card.bare && prior) ? (prior.checkedAt || (prior.check === 'none' ? Date.now() : undefined)) : undefined,
      /* A card of software 1.20 keeps the mint's proof with its pieces, and the line under the title also says whether this phone found them
       * real (`fcReal`): 'ok', 'fake' or 'unproven', 'asking' while it is worked out. A read of the short kind lists no nonces and has nothing
       * to say of them, so what the screen said stands; a card with nothing on it has no piece to doubt. */
      proofs: !!(card.info && card.info.proofs),
      real: (card.bare && prior) ? prior.real : !(card.info && card.info.proofs) ? undefined : (card.pieces || []).length ? 'asking' : 'ok',
      // the design it is drawn in: what the card says, or what this phone wrote down for it (`FoxyWallet.cardLook`)
      design: String(card.design || ''),
      // what it holds in pieces larger than its limit on one tap, as its owner read it: a till holds longer for those
      // (a card of 1.23 says its limit in cents: `fcAbove` weighs each piece in them)
      above: card.mine === true ? this.fcAbove(card, (card.tap && card.tap.limited) ? card.tap.limit : 0, (card.info && card.info.cents) ? 'usd' : '') : 0,
      // the change it made for itself that no till has handed back, as its owner's read left it (08a-flashcard.js, `cardOwnerChange`)
      // (in the card's own unit: `amount`, which is the sats of a bitcoin card's and the cents of a dollar card's)
      // (and each opening by its number on the card, with whether it may be given up: `fcGiveUp`)
      owes: (card.owes && card.owes.parts && card.owes.parts.length) ? { amount: this.fcAmt(card.owes), parts: card.owes.parts, openings: card.owes.openings || [] } : null,
    } });
    this.fcOwesLater(card);
    if ((card.pieces || []).length) { this.fcCheck(card); this.fcReal(card); }
    // ecash found for this card is asked of the mint, and the line about it redrawn if any of it was not owed after all
    if (W && W.cardOwedCheck) W.cardOwedCheck(card).then((gone) => { if (gone) this.forceUpdate(); }, () => {});
  }

  /* What the line under the balance says of the change the card is owed (`fc.owes`), by where it stands. */
  FC_OWES = {
    put: 'FETCHED AND PUT ON',
    fetched: 'FETCHED, WAITING TO GO ON',
    fetching: 'BEING FETCHED',
    unmade: 'NOT YET MADE BY THE TILL',
    offline: 'NO CONNECTION TO FETCH IT',
    away: 'AT ANOTHER MINT',
    silent: 'THE MINT DID NOT ANSWER',
    stuck: 'CANNOT BE FINISHED',
    // software 1.22: a till bound it to a key that is not the mint's; the mint's answer goes on with the card's PIN (`fcMend`)
    mend: 'NEEDS THE CARD\u2019S PIN',
  };

  /* The mint was still being asked for the card's change when its owner's tap went on: when it has answered, the line
   * says where that stands (what was fetched is owed to the card and goes on at the next tap), if it is the card on show. */
  fcOwesLater(card) {
    const later = card && card.owes && card.owes.later;
    if (!later || typeof later.then !== 'function') return;
    later.then((o) => {
      if (!o || !o.parts || !this.state.fc || this.state.fc.key !== card.key || this._fcCard !== card) return;
      this.setState({ fc: Object.assign({}, this.state.fc, { owes: { amount: this.fcAmt(o), parts: o.parts, openings: o.openings || [] } }) });
    }, () => {});
  }

  /* ---- change a till bound to a key of its own (software 1.22) -------------------------------------------------------
   *
   * A till names the mint's key for each piece of change the card makes for itself, and the card keeps the key with the opening.
   * One that named another made change the mint's answer can never be loaded under. The owner's read sees it (the key the card
   * kept is not the mint's) and fetches the mint's answer all the same, and the line under the card says the change NEEDS THE
   * CARD'S PIN: FINISH THIS CHANGE asks for it, and one tap puts the mint's answer on under the mint's own key, which the card
   * takes only with the PIN and its owner's say (on a card with no owner, the history held for), in a tap that paid nothing.
   *
   * What the mint has no answer for, or what the card would not take, cannot be finished, and is the owner's to give up: GIVE UP
   * THIS CHANGE, for that opening, with one sentence first that its money is gone. */

  // what the change NEEDS THE CARD'S PIN comes to, from the card's last read
  fcMendAmount(fc) {
    const p = ((fc && fc.owes && fc.owes.parts) || []).filter((x) => x && x.state === 'mend')[0];
    return p ? this.fcAmt(p) : 0;
  }

  fcMend() {
    const fc = this.state.fc;
    const amt = this.fcMendAmount(fc);
    if (!fc || !(amt > 0)) return;
    this.fcAskPin({
      title: 'CARD PIN',
      subtitle: 'To put ' + this.fcBoth(amt, fc.unit) + ' of change on the card.' + (fc.owner ? '' : ' Hold the card still for a few seconds when you tap it.'),
      cta: 'FINISH ' + this.fcPrice(amt, fc.unit),
    }, (pin) => this.fcMendRun(pin));
  }

  fcMendRun(pin) {
    const W = this.fcW();
    if (!W) return;
    this.fcTap({}, (link, on, progress) => { on('writing'); return W.cardMend(link, { pin, onHold: () => on('writing'), on, progress }); })
      .then((r) => {
        this.fcShow(r.card);
        if (r.amount > 0) {
          this.haptic && this.haptic('success');
          this.toast(this.fcSats(r.amount, r.unit) + ' went onto the card.');
          this.refreshBalance && this.refreshBalance();
        }
        // the card's own refusal: the mint's answer does not fit the opening, which can now only be given up
        if (r.refused > 0) this.fcFailed({ card: 'mend-refused', message: 'The card would not take this change.' });
      }, (e) => this.fcFailed(e, { again: () => this.fcMendRun(pin) }));
  }

  /* GIVE UP THIS CHANGE, for one opening (`x`: { number, amount }): one sentence that its money is gone, then the tap. The owner's
   * phone gives it up with its proof; a card with no owner, under its PIN, held. */
  fcGiveUp(x) {
    const fc = this.state.fc;
    if (!fc || !x) return;
    // a card before 1.22 cannot give change up: said at once, with no warning first and nothing sent
    if (!fc.guests) { this.fcFailed({ card: 'old-card', message: 'This card\u2019s software cannot do that.' }); return; }
    const price = this.fcPrice(x.amount, fc.unit);
    const cta = 'GIVE UP ' + price;
    this.blockedCard('fc-give-up', {
      tone: 'warn', title: 'GIVE UP THIS CHANGE?',
      reason: 'The ' + this.fcBoth(x.amount, fc.unit) + ' of this change will be gone for good: nothing can put it on the card.',
      retry: cta,
      go: () => (fc.owner ? this.fcGiveUpRun(x, '') : this.fcAskPin({
        title: 'CARD PIN',
        subtitle: 'To give up ' + this.fcBoth(x.amount, fc.unit) + ' of change. Hold the card still for a few seconds when you tap it.',
        cta,
      }, (pin) => this.fcGiveUpRun(x, pin))),
    });
  }

  fcGiveUpRun(x, pin) {
    const W = this.fcW();
    if (!W) return;
    this.fcTap({}, (link, on) => { on('writing'); return W.cardGiveUp(link, { number: x.number, B_: x.B_, amount: x.amount, pin, onHold: () => on('writing') }); })
      .then((r) => {
        // what the screen said of the card's change, without the one given up
        const card = Object.assign({}, r.card, { owes: this.fcOwesWithout(this.state.fc && this.state.fc.owes, x.number) });
        this.fcShow(card);
        this.haptic && this.haptic('success');
        this.toast('The change is given up.');
      }, (e) => this.fcFailed(e, { again: () => this.fcGiveUpRun(x, pin) }));
  }

  // the change the card is owed, as the screen has it, less the opening `n`
  fcOwesWithout(owes, n) {
    const list = ((owes && owes.openings) || []).filter((o) => o && o.number !== n);
    const parts = [];
    Object.keys(this.FC_OWES).forEach((state) => {
      const of = list.filter((o) => o.state === state);
      if (of.length) parts.push({ state, amount: of.reduce((m, o) => m + (Number(o.amount) || 0), 0), count: of.length });
    });
    return { amount: list.reduce((m, o) => m + (Number(o.amount) || 0), 0), parts, openings: list };
  }

  /* Whether the pieces on a card of software 1.20 are real, which the mint's word that they are unspent does not say: the mint's proofs the
   * card was read for are checked with the keys this phone has (08a-flashcard.js, `cardRealCheck`), once the card has been let go, and the
   * line under the title waits for it as it waits for the mint. */
  fcReal(card) {
    const W = this.fcW();
    if (card.bare || !(card.info && card.info.proofs) || !W || !W.cardRealCheck) return;
    // only the newest asking is heard: a card shown again, whole, while this one is still worked out has its own, and a short read after it asks nothing
    const mine = this._fcRealN = (this._fcRealN || 0) + 1;
    W.cardRealCheck(card).then((real) => {
      if (!real || mine !== this._fcRealN || !this.state.fc || this.state.fc.key !== card.key) return;
      this.setState({ fc: Object.assign({}, this.state.fc, { real }) });
    });
  }

  /* The mint's word on what the card says it holds. A card is a list of
   * pieces and a promise not to sign twice; whether the pieces are still good
   * is something only the mint knows. */
  fcCheck(card) {
    const W = this.fcW();
    /* A card read the short way (after a write or a limit set, say) lists no
     * nonces, so there is nothing to put to the mint: what the screen says of
     * the mint's word is what the card's own screen found when it was opened,
     * reading the card whole, and it stands. */
    if (card.bare) return;
    /* With the mint's word goes when it was given: now, or, where the mint
     * could not be asked, when this phone last had it for these same pieces
     * (`cardCheckedAt`). The screen says that under its title. */
    const put = (check, at) => {
      if (!this.state.fc || this.state.fc.key !== card.key || this._fcCard !== card) return;
      this.setState({ fc: Object.assign({}, this.state.fc, { check, checkedAt: Number(at) || 0 }) });
    };
    const before = () => { try { return W.cardCheckedAt ? W.cardCheckedAt(card) : 0; } catch (e) { return 0; } };
    W.cardCheck(card).then((r) => put(r.spent > 0 ? { spent: r.spent } : 'ok', r.spent > 0 ? 0 : (r.at || Date.now())),
                           (e) => put((e && e.card) === 'other-mint' ? 'other' : 'off', before()));
  }

  /* How long ago, as a title says it: "Just Now", "2 Hours Ago" (`agoWords`,
   * with its words capitalised). */
  fcAgo(ms) {
    const n = Math.max(0, Number(ms) || 0);
    if (n < 90 * 1000) return 'Just Now';
    return String(this.agoWords(n)).replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }

  /* Whether money can be moved on or off the card that is on screen, said
   * before any pad is raised. */
  fcReady(doing) {
    const fc = this.state.fc;
    if (!fc || !this._fcCard) return false;
    if (this.offlineNow()) { this.offlineNo(doing); return false; }
    const W = this.fcW();
    const here = (W && W.mintHost && W.mintHost()) || '';
    const there = String(fc.mint || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (there && here && there !== String(here).replace(/^https?:\/\//, '').replace(/\/+$/, '')) {
      this.fcOtherMint(doing);
      return false;
    }
    return true;
  }

  /* The card is at another mint than this phone. ADD FUNDS to a card with money on it, or to one this phone does not own, loads it
   * at its own mint, online (`fcAddAway`, `fcXlAdd`), and does not come here. What is left:
   *
   *   ADD FUNDS to an empty card, on its owner's phone: SWITCH TO <this phone's mint> goes straight
   *   to the amount, and the card's record is rewritten in the same tap that
   *   writes the funds (`fcAddRun`, the owner's proof, no PIN; its PIN, its
   *   owner, its limit and its time key stay as they are), which costs no fee;
   *   the other things a card does offer to move the phone to the card's mint, as ever. */
  fcOtherMint(doing) {
    const fc = this.state.fc;
    const adding = doing === 'Adding funds';
    const at = this.mintNameOf(fc.mint), here = this.mintName();
    if (adding && fc.ownedHere && fc.owner) {
      this.blockedCard('fc-other-mint', {
        tone: 'warn', title: 'A DIFFERENT MINT',
        reason: 'This card holds nothing, and is set up at ' + at + '. This phone is at ' + here + '.',
        retry: 'SWITCH TO ' + String(here).toUpperCase(), go: () => this.fcAmount('cardAdd'), shut: { label: 'CANCEL' },
      });
      return;
    }
    this.blockedCard('fc-other-mint', {
      tone: 'warn', title: 'A DIFFERENT MINT',
      reason: 'This card’s money is at ' + at + '. This phone is at ' + here + '.',
      retry: 'SWITCH MINT', go: () => this.goSwitchMint(), shut: { label: 'CANCEL' },
    });
  }

  /* ---- a new card ----------------------------------------------------------
   * A card of software 1.16 and on is set up with no PIN and asked for none: SET UP, then one tap that writes its record and,
   * last, its owner, then the card's screen, with a line saying it is set up. A PIN is added later from that screen (ADD PIN,
   * `fcPinAdd`), whenever its owner wants one. A card before 1.16 cannot be without a PIN, nor can one that has a PIN already (a
   * set-up cut short after it): those are asked for one first, typed twice, and the one tap writes it as well. Every card
   * is set up so that this phone can take its money back if it is lost, with nothing asked about it (the question IF THE
   * CARD IS LOST, `fcSetUpKind`, is no longer reached); and nothing is read between the PIN and the tap and
   * nothing after it (a notice that this phone becomes the owner, and one that
   * the card is cash, were two screens before a card that holds nothing; what
   * they said is in docs/CARD.md). No limit is asked for or suggested: a new
   * card has none, and one is set later from LIMITS. A PIN is typed
   * here, once, and never again to add funds. The mint is this phone's, shown
   * and not chosen. It is reached from WELCOME TO YOUR CASHU CARD's SET UP CARD (26j-card-wheel.js, `fcWelcomeSetUp`), the screen a
   * new card lands on. */
  fcSetUp() {
    const fc = this.state.fc;
    if (!fc) return;
    // a set-up this phone began for the card's holder is finished by sending it money, never by setting it up as this phone's own
    if (fc.forHolder && fc.pinSet && !fc.setUp) {
      this.fcFailed({ card: 'for-holder', message: 'This phone began setting this card up for the person who holds it. Send it money to finish.' });
      return;
    }
    /* A card of 1.21 and on holds no money without a PIN: the owner's steps, in his order (26j-card-wheel.js): the PIN twice, what
     * it holds, then its two numbers on SET AMOUNT, and one tap. */
    if (fc.pinFirst) { this.fcSetUpSteps({}); return; }
    /* At a mint with two balances the card is asked what it will hold first, on the CURRENCY screen, every time: a card
     * holds one kind, chosen here and changed only by RESET and setting it up again. At a mint with one, nothing is asked:
     * it holds bitcoin, as every card did. */
    if (this.twoUnitsOn && this.twoUnitsOn()) { this.fcUnitAsk((unit) => this.fcSetUpIn(unit)); return; }
    this.fcSetUpIn('');
  }

  /* WHAT WILL THIS CARD HOLD? (25-render-confirm-and-blocked.js, `renderCurrency`, its `card` flow): the two balances' own
   * cards, each with what this phone holds of it, which is what can be loaded. The pick is this card's and nobody's
   * remembered choice (`currencyPick` writes nothing for it); `then(unit)` goes on with it. Back is the card's screen. `both`: a card of
   * software 1.23 being set up, which is offered BOTH as well (`then('both')`). */
  fcUnitAsk(then, card, both) {
    this._fcUnitThen = then;
    this.setState(p => ({ screen: 'currency', currencyFlow: 'card', currencyNext: p.screen, stack: p.stack.concat([p.screen]), curCard: card || null,
                          curBoth: !card && !!both }));
  }

  /* Which of a card's two currencies (software 1.23): the same CURRENCY screen, asked in this flow's words. `o`: { question, foot, bal (the
   * figures each card shows: the card's own, or this phone's where the money comes from it), short ({ unit: why it cannot }, greyed and
   * not offered), why (said when a greyed one is tapped) }. `then(unit)` goes on with the one chosen; back is where it was asked from. */
  fcPickUnit(o, then) {
    this.fcUnitAsk(then, Object.assign({ question: '', foot: '', bal: null, short: {}, why: '' }, o || {}));
  }

  /* Set-up, in `unit` ('' at a mint with one balance, which the wallet takes as bitcoin). */
  fcSetUpIn(unit) {
    const fc = this.state.fc;
    if (!fc) return;
    if (fc.noPinKnown && !fc.pinSet && !fc.pinFirst) { this.fcSetUpNoPin(unit); return; }
    // no mint is asked: the card is told this phone's mint and given a key from this phone's words
    const first = (warn) => this.fcAskPin({
      title: 'CHOOSE A PIN',
      subtitle: 'Four to eight digits. The card asks for it every time it pays.',
      warn: warn || '',
    }, (a) => this.fcAskPin({
      title: 'TYPE IT AGAIN',
      subtitle: 'So a mistyped digit does not become the card’s PIN.',
    }, (b) => {
      if (a !== b) { first('Those did not match. Start again.'); return; }
      this.fcSetUpRun(a, true, unit);
    }));
    first('');
  }

  // the tap that sets a card up with no PIN: nothing is asked first
  fcSetUpNoPin(unit) {
    this.fcSetUpRun('', true, unit);
  }

  fcSetUpRun(pin, recoverable, unit) {
    const W = this.fcW();
    // (the unit only where one was chosen: a card set up at a mint with one balance is set up as every card was)
    const how = /** @type {any} */ (Object.assign({ pin, recoverable, design: this.FC_SETUP_DESIGN }, unit ? { unit } : {}));
    /* A card of 1.21 takes this phone as its owner only after about ten seconds of asking: each asking says Keep holding again. */
    this.fcTap({}, (link, on) => { on('writing'); how.onHold = () => on('writing'); return W.cardSetUp(link, how); })
      .then((card) => {
        this.fcNameSettle(card && card.key);
        this.fcShow(card);
        this.haptic && this.haptic('success');
        this.toast(unit === 'usd' ? 'The card is set up. It holds dollars.' : 'The card is set up.');
      }, (e) => this.fcFailed(e, { again: () => this.fcSetUpRun(pin, recoverable, unit) }));
  }

  // (`unit`: the one chosen for the card, carried to the tap as `fcSetUpRun` takes it, so a choice of dollars is never lost here)
  fcSetUpKind(pin, unit) {
    this.blockedCard('fc-kind', {
      tone: 'ask', title: 'IF THE CARD IS LOST',
      reason: 'RECOVERABLE: this phone can take the money back after a year.\n'
        + 'LIKE CASH: lose the card and the money is gone. Choose it for a gift.',
      chip: 'Its money will be at ' + this.mintName() + '.',
      retry: 'RECOVERABLE', go: () => this.fcSetUpRun(pin, true, unit),
      shut: { label: 'LIKE CASH', tap: () => this.fcSetUpRun(pin, false, unit) },
    });
  }

  /* ---- add funds ------------------------------------------------------------
   * The amount, the card's PIN, then the mint, then the card: the pieces are
   * made before the tap, so the card is held for as long as writing takes and
   * no longer. A tap that fails leaves them owed to the card. */
  fcAdd() {
    /* A card at another mint with money on it, or one this phone cannot switch (not its owner): loaded at its own mint, online
     * (`fcXlAdd`). An empty card this phone owns is still offered the switch to this phone's mint, which costs nothing (`fcOtherMint`). */
    if (this.fcAddAway()) {
      if (this.offlineNow()) { this.fcXlOffline(); return; }
    } else if (!this.fcReady('Adding funds')) return;
    // one at a time: the pieces of the last ADD FUNDS are still being made (a second sheet would take the reader from the first's)
    if (this._fcAdding) { this.toast('Still getting the last amount ready for the card.', true); return; }
    this._fcFlowUnit = null;
    /* A card of software 1.23 at a mint with both currencies takes either: which is asked first, on the CURRENCY screen with what this
     * phone holds of each (what can be added), and then SET AMOUNT in it. One its owner set up here to hold one currency (`fc.only`)
     * is asked nothing: SET AMOUNT in that one. */
    const fc = this.state.fc;
    if (fc && fc.v123 && fc.only) { this._fcFlowUnit = fc.only; this.fcAmount('cardAdd'); return; }
    /* A card of both at another mint: which goes on it is asked the same way, with nothing greyed, since either of this phone's balances
     * pays for it there (`fcXlQuote` asks which, where both can) */
    if (fc && fc.v123 && this.fcAddAway() && this.fcTakesBoth(this._fcCard)) {
      this.fcPickUnit({
        question: 'ADD WHICH TO THE CARD?',
        foot: 'The card keeps dollars and bitcoin side by side. Either of this phone’s balances can pay for it.',
        short: { usd: '', sat: '' },
      }, (u) => { this._fcFlowUnit = u; this.fcAmount('cardAdd'); });
      return;
    }
    if (fc && fc.v123 && this.twoUnitsOn && this.twoUnitsOn()) {
      const none = (u) => !(this.unitBalance(u) > 0);
      this.fcPickUnit({
        question: 'ADD WHICH TO THE CARD?',
        foot: 'From what this phone holds. The card keeps dollars and bitcoin side by side.',
        short: { usd: none('usd') ? 'NONE ON THIS PHONE' : '', sat: none('sat') ? 'NONE ON THIS PHONE' : '' },
        why: 'This phone holds none of that to add.',
      }, (u) => { this._fcFlowUnit = u; this.fcAmount('cardAdd'); });
      return;
    }
    this.fcAmount('cardAdd');
  }

  // whether ADD FUNDS on the card on screen loads it at its own mint, another than this phone's (`fcAdd`)
  fcAddAway() {
    const fc = this.state.fc;
    const card = this._fcCard;
    if (!fc || !card || card.key !== fc.key || !this.fcXlAway(card)) return false;
    return fc.count > 0 || !(fc.ownedHere && fc.owner);
  }

  /* The owner's phone adds funds with its own proof and no PIN: the PIN was
   * typed once, at set-up. Any other phone, with the card's PIN, adds them as a
   * till writes change. The daily limit is not touched by putting money on. */
  fcAddPin(sats) {
    const fc = this.state.fc;
    /* (from 1.21 every load wants the PIN, the owner's own included: decided from the card just read, `fcCardPinFirst`, and never from a
     * figure of the screen's that may not be there) */
    if (fc && fc.ownedHere && !this.fcCardPinFirst()) { this.fcLeaveAmount(); this.fcAddRun(sats, '', true); return; }
    this.fcAddAskPin(sats);
  }

  /* Whether the card in hand is of software 1.21 or later, whose every load wants its PIN: from the card as it was read (its version,
   * which the wallet's `pinFirst` is worked out from); a card with no version said is taken to want it, so the PIN is asked, not refused.
   * A card read with no PIN set (`pinSet` false) has none to ask, whatever its software. */
  fcCardPinFirst() {
    const info = this.fcPinInfo();
    if (!info) return true;
    if (info.pinSet === false) return false;
    if (info.pinFirst === true) return true;
    const v = String(info.version || '').split('.');
    if (v.length < 2 || !v[0]) return true;
    return Number(v[0]) > 1 || (Number(v[0]) === 1 && Number(v[1]) >= 21);
  }

  /* The card the PIN-first rule is asked of, as it was read (`info`), or null. Off the card's own screen (a payment's change at a till,
   * money waiting after a payment) it is the last card read by any flow (the wallet's `cardLastRead`), never the card on the screen this
   * phone was last on: a till whose owner had opened his own 1.21 card and swiped home asked a customer's 1.20 card, which has no PIN, for
   * one. On the card's screen it is the card shown (`_fcCard`) where that is the card last read, and the last read where another card
   * has been read since. */
  fcPinInfo() {
    const W = this.fcW();
    const last = (W && W.cardLastRead) ? W.cardLastRead() : null;
    const shown = this._fcCard;
    const useShown = this.state && this.state.screen === 'flashcard' && !!(shown && shown.info) && (!last || last.key === shown.key);
    return (useShown ? shown.info : (last && last.info)) || null;
  }

  /* Whether the card in hand, as the last flow read it, wants its PIN before any load: a payment's change included (software 1.21 and
   * on). Unknown card: no, as before (the tap after a payment puts change on with no PIN on older cards). */
  fcKnownPinFirst() {
    return !!this.fcPinInfo() && this.fcCardPinFirst();
  }

  // the sentence after "tap the card again": whether its PIN comes first
  fcNoPinWords() {
    return this.fcKnownPinFirst() ? 'Its PIN is asked first.' : 'No PIN is needed.';
  }

  fcAddAskPin(sats) {
    // (a card with no PIN is loaded by whoever holds it: nothing to ask)
    const u = this.fcUnit();
    this.fcPinOr({
      title: 'CARD PIN',
      subtitle: 'To add ' + this.fcBoth(sats, u) + ' to the card.',
      cta: 'ADD ' + this.fcPrice(sats, u) + ' TO CARD',
    }, (pin) => { this.fcLeaveAmount(); this.fcAddRun(sats, pin, false); });
  }

  fcAddRun(sats, pin, owner) {
    const W = this.fcW();
    const card = this._fcCard;
    if (this._fcAdding) { this.toast('Still getting the last amount ready for the card.', true); return; }
    /* The run in hand. CLOSE on the screen while the pieces are being made lets the person go, and the pieces,
     * once made, wait for the next tap as anything made for a card does (`cardOwed`): no sheet comes up by itself
     * later, over whatever they are doing then. Two runs at once once put two sheets on one reader, and neither
     * wrote. */
    const run = { closed: false };
    this._fcAdding = run;
    // in the card's own unit: a dollar card is loaded from this phone's dollars, in cents (a card of 1.23: the currency chosen, `fcUnit`)
    const u = (this.state.fc && this.state.fc.v123) ? this.fcUnit() : (card && card.record && card.record.unit === 'usd') ? 'usd' : 'sat';
    const v123 = !!(this.state.fc && this.state.fc.v123);
    this.stageScreen('cardReady', {
      art: 'card', title: 'GETTING<br>IT READY', amount: this.stageMoney(sats, u),
      body: 'Keep the card nearby. You will be asked to tap it in a moment.',
      dots: true, forMs: 90000, button: 'CLOSE', go: () => { run.closed = true; },
    });
    /* A card that holds nothing and is at another mint than this phone's is told
     * its new mint in the tap that writes the funds (the owner's proof; `fcOtherMint`
     * only offers this to its owner): the money is made for the mint this phone is at. */
    const there = String((card && card.record && card.record.mint) || '').replace(/\/+$/, '');
    const here = String(W.mintUrl || '').replace(/\/+$/, '');
    const moving = !!(there && here && there !== here && !((card.pieces || []).length));
    W.cardPrepare(card, sats, Object.assign({ moving }, (u === 'usd' || v123) ? { unit: u } : {})).then((made) => {
      if (this._fcAdding === run) this._fcAdding = null;
      // said by this flow, so not announced as a payment sent (16-history-lists.js)
      if (made && made.hash) this.txIsNew(made.hash);
      this.hideStage('cardReady');
      if (run.closed) {
        this.toast(this.fcPrice(this.fcAmt(made), u) + ' is ready for the card. It goes on at the next tap.');
        return;
      }
      this.fcWriteRun(pin, Object.assign({ sats: this.fcAmt(made), owner: !!owner, asked: sats, rounded: Number(made.rounded) || 0 }, (u === 'usd' || v123) ? { unit: u } : {}));
    }, (e) => {
      if (this._fcAdding === run) this._fcAdding = null;
      this.hideStage('cardReady');
      if (run.closed) return;
      this.fcFailed(e, {});
    });
  }

  /* ---- withdraw --------------------------------------------------------------
   * An amount on the keypad, or ALL OF IT, which is the button under its
   * NEXT (23-render-home-and-amount.js). */
  fcWithdraw() {
    if (!this.fcReady('Withdrawing')) return;
    const fc = this.state.fc;
    this._fcFlowUnit = null;
    /* A card of software 1.23 that holds both currencies: which is asked first, on the CURRENCY screen with what the card holds of each,
     * and then SET AMOUNT in it. One that holds one is taken off in that one. */
    if (fc.v123 && fc.bal && this.fcTwoUnits(fc)) {
      const have = (u) => fc.bal[u] > 0;
      if (!have('usd') && !have('sat')) { this.toast('There is nothing on this card.', true); return; }
      if (have('usd') && have('sat')) {
        this.fcPickUnit({
          question: 'WITHDRAW WHICH?',
          foot: 'From the card into this phone, in the same currency.',
          bal: { usd: fc.bal.usd, sat: fc.bal.sat },
          short: { usd: '', sat: '' },
        }, (u) => { this._fcFlowUnit = u; this.fcAmount('cardWd'); });
        return;
      }
      this._fcFlowUnit = have('usd') ? 'usd' : 'sat';
      this.fcAmount('cardWd');
      return;
    }
    if (fc.v123 && fc.bal) this._fcFlowUnit = fc.bal.usd > 0 && !(fc.bal.sat > 0) ? 'usd' : fc.bal.sat > 0 && !(fc.bal.usd > 0) ? 'sat' : null;
    if (!(fc.balance > 0) && !(fc.v123 && fc.bal && (fc.bal.usd > 0 || fc.bal.sat > 0))) { this.toast('There is nothing on this card.', true); return; }
    this.fcAmount('cardWd');
  }

  fcWithdrawPin(sats) {
    const fc = this.state.fc;
    if (!fc) return;
    const u = this.fcUnit();
    this.fcPinOr({
      title: 'ENTER PIN TO WITHDRAW',
      subtitle: (sats ? this.fcBoth(sats, u) : 'Everything') + ' from the card to this phone.',
      cta: sats ? 'WITHDRAW ' + this.fcPrice(sats, u) : 'WITHDRAW ALL',
    }, (p) => { this.fcLeaveAmount(); this.fcWithdrawRun(sats, p); });
  }

  /* `before`: what earlier taps of this same withdrawal took off the card
   * (a tap cut short keeps what the card signed, and the next takes the rest).
   * The PIN is held for the length of the withdrawal, as for one tap: the
   * card that says TAP CARD for the rest is still this flow, and LATER ends it. */
  /* `again`: { rest } where this is the sheet come up by itself for the rest of
   * a withdrawal cut short; a tap of it that reads no card puts the TAP CARD
   * card up instead. */
  /* `unit`: the card's, carried to the taps for the rest (the screen that knew it may be gone by then). */
  fcWithdrawRun(sats, pin, before, again, unit) {
    const W = this.fcW();
    const u = unit || this.fcUnit();
    // (a card of 1.23: the currency chosen is named to the wallet, and stays named for the taps for the rest)
    const named = !!(unit || (this.state.fc && this.state.fc.v123 && this._fcFlowUnit));
    const prior = Math.round(Number(before) || 0);
    /* What came off in this tap's sheet, as it is cut short and taken up again
     * in the same sheet (`again` below), and what is still to take. */
    let took = prior, ask = sats;
    const counted = new Set();
    const absorb = (e) => {
      if (!e || e.card !== 'partial' || counted.has(e)) return;
      counted.add(e);
      took += this.fcAmt(e);
      if (e.hash) this.txIsNew(e.hash);
      ask = sats ? Math.round(Number(e.left) || 0) : 0;
    };
    const partCard = (got, rest) => this.blockedCard('fc-part', {
      tone: 'warn', title: 'TAP THE CARD AGAIN',
      reason: this.fcSats(got, u) + ' came off the card into this phone before it was taken away. Tap it again for the rest'
        + (rest > 0 ? ', ' + this.fcSats(rest, u) + '.' : '.'),
      chip: 'Hold it still until the phone says to remove it.',
      retry: 'TAP CARD', go: () => this.fcWithdrawRun(sats ? rest : 0, pin, got, undefined, u),
      shut: { label: 'LATER' },
    });
    const said = (r) => {
      this.haptic && this.haptic('success');
      /* The card's own screen is still up, and the card as it stands now is known (`r.card`: what the tap read of it less what it signed
       * for, or the card as the sheet that put its change back read it; for a mint that answered late, the same, from the error): the
       * screen comes back with its balance counting down to it, and nothing is raised over it. */
      if (r && r.card && this.fcWithdrew(r.card)) return;
      /* Otherwise (a withdrawal that was cut short took the screen away, or the card is not known) what the screen knew of the card is out
       * of date, and is not shown as if it were current: the screen goes, and a card says what came off. */
      this.fcGone();
      const got = took + this.fcAmt(r);
      this.blockedCard('fc-out', {
        tone: 'ask', title: 'IN YOUR WALLET',
        reason: (got > 0 ? this.fcSats(got, u) : 'The money') + ' from the card is in this phone now.',
        shut: { label: 'DONE' },
      });
    };
    const opt = { taken: true, again: () => this.fcWithdraw(), done: (after) => said(after ? { card: after } : null) };
    this.fcTap({ amount: sats ? this.stageMoney(sats, u) : '', warm: true, sheet: again ? 'Hold for the rest.' : '',
                 again: (e) => {
                   if (e && e.card === 'partial' && Number(e.left) > 0) { absorb(e); return 'Hold for the rest.'; }
                   return (e && e.card === 'gone') ? 'Tap behind the phone.' : '';
                 } },
               // (a card of 1.23: in the currency chosen, `unit`; all of it in that one)
               (link, on, progress) => W.cardWithdraw(link, Object.assign(ask ? { pin, sats: ask, on, progress, keepSheet: true } : { pin, on, progress, keepSheet: true },
                                                                          named ? { unit: u } : {}))
                 .then((r) => this.fcChangeInSheet(link, on, progress, r, pin)))
      .then((r) => {
        if (r && r.hash) this.txIsNew(r.hash);
        this.fcMoved({});
        said(r);
        const ch = r && r.change;
        if (ch && !ch.written && !ch.unmade && this.fcAmt(ch) > 0) this.fcChangeWaiting(this.fcAmt(ch), 0, u);
      }, (e) => {
        absorb(e);
        /* The sheet looked for the card again and was dismissed, or a sheet for
         * the rest read no card: the TAP CARD card, with what came off so far. */
        if (took > prior || (again && e && (e.card === 'cancelled' || e.card === 'gone'))) {
          if (e && (e.sheetClosed || e.card === 'cancelled' || e.card === 'gone')) {
            this.fcMoved({});
            this.fcGone();
            partCard(took, sats ? ask : 0);
            return;
          }
        }
        // a card that wants its PIN where none was given: asked for, and the withdrawal run again with it
        if (e && e.card === 'pin-needed' && !pin && took === prior) {
          this.fcAskPin({
            title: 'ENTER PIN TO WITHDRAW',
            subtitle: (sats ? this.fcBoth(sats, u) : 'Everything') + ' from the card to this phone.',
            cta: sats ? 'WITHDRAW ' + this.fcPrice(sats, u) : 'WITHDRAW ALL',
          }, (p) => this.fcWithdrawRun(sats, p, before, again, unit));
          return;
        }
        if (!(e && e.card === 'partial')) { this.fcFailed(e, opt); return; }
        /* Cut short where the phone could not keep the sheet up (an older one):
         * a new sheet comes up by itself for the rest, once iOS has taken the
         * last down, with the PIN already given. */
        this.fcMoved({});
        this.fcGone();
        this.haptic && this.haptic('warning');
        // nothing left on the card to take: the withdrawal is whole
        if (!(Math.round(Number(e.left) || 0) > 0)) { said({ sats: 0 }); return; }
        clearTimeout(this._fcResumeT);
        this._fcResumeT = setTimeout(() => this.fcWithdrawRun(sats ? ask : 0, pin, took, { rest: ask }, u), 2500);
      });
  }

  /* A withdrawal finished with the card's own screen up for that card: it shows the card as it stands now, and its balance counts down to
   * that. False where the screen is not up for it (a withdrawal cut short took it away, `fcGone`), and the caller says it another way. */
  fcWithdrew(card) {
    const fc = this.state.fc;
    if (!fc || this.state.screen !== 'flashcard' || !card || card.key !== fc.key) return false;
    const before = this.fcBalanceShown(fc, this.state);
    // (the change the card owes itself is what the owner's read of it said: this tap did not look into that)
    const was = this._fcCard;
    this.fcShow(card.owes === undefined && was && was.key === card.key ? Object.assign({}, card, { owes: was.owes }) : card);
    this.fcRollStart(before);
    return true;
  }

  /* What the screen knew of the card is out of date and is not shown as if it
   * were current: the next thing to do with the card is to tap it. */
  fcGone() {
    // no count is left half done for the next card, or the next read of this one, to show
    clearInterval(this._fcRollT);
    if (this.state.fcRoll) this.setState({ fcRoll: null });
    this._fcCard = null;
    if (this.state.fc) this.setState({ fc: null });
    // with no list of cards to show, the screen with no card on it is not one to be left on
    if (!this.FC_RECOVERABLE && this.state.screen === 'flashcard') this.back();
  }

  /* ---- its PIN, its limit, its date ------------------------------------------ */

  /* CHANGE PIN, and UNBLOCK, which is the same: the owner's phone sets a new PIN
   * with its proof. The old PIN is not asked for, because this phone does not
   * know it and a blocked or forgotten PIN is the case that needs this. */
  fcChangePin() {
    const fc = this.state.fc;
    if (!fc) return;
    const W = this.fcW();
    // said before anything is asked
    if (!fc.owner) { this.fcFailed({ card: 'no-owner', message: 'This card has no owner, so its PIN cannot be changed.' }); return; }
    if (fc.ownedHere === false) { this.fcFailed({ card: 'not-owner' }); return; }
    const was = fc.pin === 'blocked';
    const fresh = (warn) => this.fcAskPin({
      title: 'NEW PIN', subtitle: 'Four to eight digits.', warn: warn || '',
    }, (a) => this.fcAskPin({ title: 'NEW PIN AGAIN', subtitle: 'So a mistyped digit does not become the card’s PIN.' }, (b) => {
      if (a !== b) { fresh('Those did not match. Start again.'); return; }
      this.fcTap({}, (link, on) => { on('writing'); return W.cardChangePin(link, { newPin: a }); })
        .then(() => {
          this.haptic && this.haptic('success');
          this.blockedCard('fc-pin', { tone: 'ask', title: was ? 'CARD UNBLOCKED' : 'PIN CHANGED', reason: 'The card asks for the new one from now on.', shut: { label: 'DONE' } });
          // what the screen knew of the card is out of date: a blocked card is not blocked now
          if (was && this.state.fc) this.setState({ fc: Object.assign({}, this.state.fc, { pin: 'set' }) });
        }, (e) => this.fcFailed(e, { again: () => this.fcChangePin() }));
    }));
    fresh('');
  }

  /* ADD PIN, in CHANGE PIN's place on a card that has none: the owner's phone gives it one, as at set-up (a PIN, typed
   * twice, and one tap). The card then asks for it for every payment until a no PIN limit is set. */
  fcPinAdd() {
    const fc = this.state.fc;
    if (!fc) return;
    const W = this.fcW();
    if (!fc.owner) { this.fcFailed({ card: 'no-owner', message: 'This card has no owner, so a PIN cannot be added to it.' }); return; }
    if (fc.ownedHere === false) { this.fcFailed({ card: 'not-owner' }); return; }
    const fresh = (warn) => this.fcAskPin({
      title: 'CHOOSE A PIN', subtitle: 'A card with no PIN is cash to whoever holds it. Four to eight digits.', warn: warn || '',
    }, (a) => this.fcAskPin({ title: 'TYPE IT AGAIN', subtitle: 'So a mistyped digit does not become the card’s PIN.' }, (b) => {
      if (a !== b) { fresh('Those did not match. Start again.'); return; }
      this.fcTap({}, (link, on) => { on('writing'); return W.cardAddPin(link, { pin: a }); })
        .then((card) => {
          this.fcShow(card);
          this.haptic && this.haptic('success');
          this.toast('PIN added. Every payment asks for it until you set a no-PIN limit.');
        }, (e) => this.fcFailed(e, { again: () => this.fcPinAdd() }));
    }));
    fresh('');
  }

  /* How many signatures the card on show asks for the first limit's worth over its limit on one tap: ten from software 1.17, seven
   * before (`info.waitOver`, 08a-flashcard.js). Ten for a card not read yet, as the newest is. */
  fcWaitOver() {
    const c = this._fcCard;
    return Number(c && c.info && c.info.waitOver) || 10;
  }
  /* And for each further limit's worth: four from software 1.18, three before (`info.waitMore`). Four for a card not read yet. */
  fcWaitMore() {
    const c = this._fcCard;
    return Number(c && c.info && c.info.waitMore) || 4;
  }
  /* What the screen behind the sheet counts to by the time a payment of `askings` askings is signed, on a card held well. The
   * count runs from the card being found; measured on a phone, a payment with change took about 3.3 seconds for the read, the
   * pieces and the change, and 0.58 seconds an asking (a card of 1.17: ten askings reached 9, thirteen 10, sixteen 12). The
   * screen shows whole seconds, so the figure is the count reached, not rounded up. What HOW TAP LIMIT WORKS and the limit's
   * confirmation say; a payment within the limit is one second, up to about four with change. */
  FC_TAP_SECS = { found: 3.3, asking: 0.58 };
  fcWaitSecs(askings) {
    const T = this.FC_TAP_SECS;
    return Math.floor(T.found + T.asking * Math.max(0, Number(askings) || 0));
  }

  /* Whether the card on show waits by the rule of software 1.13 (`cardWaitSigns`), which the words on its limit screens
   * say: a card read as the one before it (a card that signs once, of format 4, and is not 1.13 yet: the rule of 1.12 is
   * its words) has the old rule's words. Anything else, and a card not read yet, has the newest. */
  fcShaped() {
    const c = this._fcCard;
    // (format 5, a card of 1.23 that holds both units, is format 4 in this)
    return !(c && c.info && (c.info.format === 4 || c.info.format === 5) && c.info.shaped === false);
  }

  /* ---- the daily limit ---------------------------------------------------------
   *
   * The most the card signs for in one day. LIMITS asks for it in three
   * steps, and the owner's phone sets it with its proof and
   * no PIN:
   *
   *   a warning       what a daily limit is, and who can change it
   *   an amount       the keypad every amount is typed on, dollars first, with
   *                   NO LIMIT as the way to remove one
   *   a confirmation  the amount again, and what it means
   *
   * `fcLimitAsk(done)` runs them and calls `done(sats)` with the screens that
   * were opened for them gone: `sats` is 0 for NO LIMIT.
   *
   * A card has a second limit, on ONE TAP, asked for by the same three steps
   * in its own words (`tap`): for the card that makes its own change the first
   * step is HOW TAP LIMIT WORKS (26g-tap-limit-explainer.js), the rule played
   * out, and for the card of 1.12 a warning in its own words.
   *
   * A card of software 1.16 and on that has a PIN has a third, the NO PIN
   * LIMIT (`tap` is 'nopin'): the most it signs for in a day without its PIN,
   * asked for in the same three steps; none (NO LIMIT under the keypad) is 0,
   * and every payment then asks for the PIN. */
  fcLimitAsk(done, tap) {
    const np = tap === 'nopin';
    this._fcLimitDone = done;
    this._fcLimitTap = tap === true;
    this._fcLimitNoPin = np;
    if (tap === true && this.fcShaped()) {
      // (CONTINUE: the rate, MAX SPEND PER SECOND, for a card that waits for its limit, 26j-card-wheel.js `fcLimitAmount`)
      this.fcTapLimitExplainer({ over: this.fcWaitOver(), more: this.fcWaitMore(), go: () => this.fcLimitAmount(), cancel: () => { this._fcLimitDone = null; } });
      return;
    }
    this.blockedCard('fc-limit-warn', np ? {
      tone: 'warn', title: 'SET NO PIN LIMIT',
      // (from 1.21 the allowance is refilled each time the PIN is entered on the card, not by the day)
      reason: (this.state.fc && this.state.fc.pinFirst
        ? 'A \u201cNo PIN\u201d limit is how much this card can pay by tap alone before it asks for your PIN.\n\n'
          + 'Once it is used up, the PIN is asked for, and entering it fills the limit again.\n\n'
        : 'A \u201cNo PIN\u201d limit is the most this card will pay in one day without requiring your PIN.\n\n'
          + 'Once you reach your limit, the PIN is asked for every payment until the next day.\n\n')
        + 'Only this phone, or a phone restored from its seed phrase, can change or remove the limit.',
      retry: 'CONTINUE', go: () => this.fcLimitAmount(),
      shut: { label: 'CANCEL', tap: () => { this._fcLimitDone = null; } },
    } : {
      tone: 'warn', title: 'SET PER TAP LIMIT',
      reason: 'A per tap limit is the most this card pays in one tap straight away, when it pays exactly. A payment that makes change holds the card 3 seconds; one over the limit, 3 seconds for every limit\u2019s worth of what leaves the card. Lift the card and the payment stops, with nothing taken.\n\n'
        + 'Only this phone, or a phone restored from its seed phrase, can change or remove the limit.\n\n'
        + 'If you lose the seed phrase for this Foxy app, the PIN and the limits on this card can never be changed.\n\n'
        + 'Do you wish to continue?',
      retry: 'CONTINUE', go: () => this.fcLimitAmount(),
      shut: { label: 'CANCEL', tap: () => { this._fcLimitDone = null; } },
    });
  }

  /* What the keypad asks, for whichever limit is being set (23-render-home-and-amount.js). */
  fcLimitQuestion() {
    // (from 1.21 the allowance is filled again by the PIN, not by the day)
    if (this._fcLimitNoPin) {
      return (this.state.fc && this.state.fc.pinFirst) ? 'What is the most this card should pay by tap alone before it asks for its PIN?'
        : 'What is the most this card should pay in a day without its PIN?';
    }
    // (a card that waits for its limit: the figure typed is a rate, 26j-card-wheel.js)
    if (this.fcPacedNow && this.fcPacedNow()) return 'What is the most this card should pay each second?';
    return 'What is the most this card should pay in one tap straight away?';
  }

  /* After NEXT on the keypad, or NO LIMIT under it: the confirmation, over it. */
  fcLimitConfirm(sats, usd) {
    this.setState(p => ({ screen: 'fcLimitConfirm', stack: p.stack.concat([p.screen]),
                          fcLimit: { sats: Math.max(0, Math.round(Number(sats) || 0)), usd: Math.max(0, Number(usd) || 0) } }));
  }

  /* The confirmation shell's contents (confirmSpec). */
  fcLimitSpec() {
    const sats = ((this.state.fcLimit || {}).sats) || 0;
    /* A dollar card's limit is cents, said as the dollars they are, with nothing under them: no price is in it, and it is
     * never kept at anything (`fcLimitRun`). */
    // (a card of 1.23: in the unit it was typed in, `fcLimitUnit`)
    const U = this.fcLimitUnit();
    const fig = (n) => (U === 'usd' ? { main: this.fcSats(n, 'usd'), sub: '' } : this.money(n));
    const secondary = { label: 'CANCEL', go: () => this.fcLimitCancel() };
    if (this._fcLimitNoPin) {
      return !(sats > 0) ? {
        title: 'CONFIRMATION', amountLabel: 'YOU ARE REMOVING THIS CARD\u2019S NO PIN LIMIT.',
        amount: 'NO LIMIT', amountSub: '', rows: [],
        warn: 'Every payment will ask for the PIN.',
        secondary, cta: 'CONFIRM', ctaTone: 'go',
        go: () => this.fcLimitConfirmed(),
      } : {
        title: 'CONFIRMATION', amountLabel: 'YOU ARE APPLYING A NO PIN LIMIT OF:',
        amount: fig(sats).main, amountSub: fig(sats).sub, rows: [],
        // (from 1.21 the PIN fills the allowance again, and no day does)
        warn: ((this.state.fc && this.state.fc.pinFirst) ? 'This card will pay up to this much without its PIN, and entering the PIN fills it again. '
          : 'This card will pay up to this much a day without its PIN. ') + 'Over it, the PIN is asked for the whole payment. '
          + (((this.state.fcLimit || {}).usd > 0) ? 'It is kept at this many dollars: this phone sets the card again when the price has moved. ' : '')
          + 'Only this phone, or a phone restored from its seed phrase, can change or remove it.',
        secondary, cta: 'CONFIRM', ctaTone: 'go',
        go: () => this.fcLimitConfirmed(),
      };
    }
    /* A card that waits for its limit: the limit said as the rate it makes (26j-card-wheel.js, `fcSpeedText`), and the limit itself in the
     * words under it. */
    if (this.fcPacedNow && this.fcPacedNow()) {
      const usd = ((this.state.fcLimit || {}).usd) || 0;
      const fc = this.state.fc;
      const L = U === 'usd' ? this.fcSats(sats, 'usd') : usd > 0 ? '$ ' + this.usd(usd) : fig(sats).main;
      return !(sats > 0) ? {
        title: 'CONFIRMATION', amountLabel: 'YOU ARE REMOVING THIS CARD\u2019S PER SECOND LIMIT.',
        amount: 'NO LIMIT', amountSub: '', rows: [],
        warn: 'One tap will be able to pay as much as the card holds straight away.',
        secondary, cta: 'CONFIRM', ctaTone: 'go',
        go: () => this.fcLimitConfirmed(),
      } : {
        title: 'CONFIRMATION', amountLabel: 'YOU ARE APPLYING A PER SECOND LIMIT OF:',
        amount: this.fcSpeedText(sats, U, usd) + ' / sec', amountSub: '', rows: [],
        warn: 'This card pays up to ' + L + ' straight away, change or no change. Over it, the card has to be held about ' + this.fcWaitSecs(this.fcWaitOver()) + ' seconds, and ' + Math.max(1, Math.round(this.FC_TAP_SECS.asking * this.fcWaitMore())) + ' seconds more for every ' + L + ' beyond that. '
          + (usd > 0 ? 'It is kept at this many dollars: this phone sets the card again when the price has moved. ' : '')
          + (this.fcAbove(this._fcCard, sats, U, true) > 0 ? 'It holds ' + this.fcPrice(this.fcAbove(this._fcCard, sats, U, true), (fc && fc.unit) || U) + ' in pieces larger than that: with your PIN they are recut under the new limit in the same tap. ' : '')
          + this.fcAboveKept(this._fcCard, sats, U)
          + 'Only this phone, or a phone restored from its seed phrase, can change or remove it.',
        secondary, cta: 'CONFIRM', ctaTone: 'go',
        go: () => this.fcLimitConfirmed(),
      };
    }
    return !(sats > 0) ? {
      title: 'CONFIRMATION', amountLabel: 'YOU ARE REMOVING THIS CARD\u2019S PER TAP LIMIT.',
      amount: 'NO LIMIT', amountSub: '', rows: [],
      warn: 'One tap will be able to pay as much as the card holds straight away.',
      secondary, cta: 'CONFIRM', ctaTone: 'go',
      go: () => this.fcLimitConfirmed(),
    } : {
      title: 'CONFIRMATION', amountLabel: 'YOU ARE APPLYING A PER TAP LIMIT OF:',
      amount: fig(sats).main, amountSub: fig(sats).sub, rows: [],
      warn: (this.fcShaped()
        ? 'This card will pay up to this straight away, change or no change. Over it, the card has to be held about ' + this.fcWaitSecs(this.fcWaitOver()) + ' seconds, and ' + Math.max(1, Math.round(this.FC_TAP_SECS.asking * this.fcWaitMore())) + ' seconds more for every limit\u2019s worth beyond that. '
        : 'This card will pay up to this straight away when it pays exactly. With change, or over the limit, it has to be held 3 seconds for every limit\u2019s worth. ')
        + (((this.state.fcLimit || {}).usd > 0) ? 'It is kept at this many dollars: this phone sets the card again when the price has moved. ' : '')
        + (this.fcAbove(this._fcCard, sats, U, true) > 0 ? 'It holds ' + this.fcPrice(this.fcAbove(this._fcCard, sats, U, true), (this.state.fc && this.state.fc.unit) || U) + ' in pieces larger than that: with your PIN they are recut under the new limit in the same tap. ' : '')
        + this.fcAboveKept(this._fcCard, sats, U)
        + 'Only this phone, or a phone restored from its seed phrase, can change or remove it.',
      secondary, cta: 'CONFIRM', ctaTone: 'go',
      go: () => this.fcLimitConfirmed(),
    };
  }

  /* Off the confirmation and the keypad and MAX SPEND PER SECOND under it, to where the flow began. */
  fcLimitLeave() {
    this.setState(p => {
      const LEAVE = ['fcLimitConfirm', 'amount', 'fcSpeed'];
      let screen = p.screen, at = 0;
      while (LEAVE.indexOf(screen) >= 0) { at += 1; screen = p.stack.length >= at ? p.stack[p.stack.length - at] : 'flashcard'; }
      return at ? { screen, stack: p.stack.slice(0, Math.max(0, p.stack.length - at)), fcLimit: null, fcSpeed: null, flow: 'receive', amount: '', unit: 'USD' } : { fcLimit: null };
    });
  }

  fcLimitCancel() {
    this._fcLimitDone = null;
    this.fcLimitLeave();
  }

  fcLimitConfirmed() {
    const sats = ((this.state.fcLimit || {}).sats) || 0;
    const usd = ((this.state.fcLimit || {}).usd) || 0;
    const done = this._fcLimitDone;
    this._fcLimitDone = null;
    this.fcLimitLeave();
    /* A limit on one tap, lower than pieces the card holds: with the PIN the
     * card's money is recut under it in the same tap (the wallet's
     * cardSetLimit), so the PIN is asked first. Zero is a choice: NO LIMIT. */
    if (done && this._fcLimitTap && sats > 0 && this.fcAbove(this._fcCard, sats, this.fcLimitUnit(), true) > 0) {
      this.fcPinOr({ title: 'CARD PIN', subtitle: 'To recut its money under the new limit' }, (pin) => done(sats, usd, pin));
      return;
    }
    if (done) done(sats, usd);
  }

  /* A card of 1.23 that holds both currencies is not recut under a new limit on one payment (the wallet's `cardSetLimit` skips it: taking
   * its money off would take both and put back one). What it holds in pieces larger than the limit, in each currency, is said as it is:
   * they stay, and a till holds the card longer for them. '' for any other card, or none above. */
  fcAboveKept(card, limit, unit) {
    const W = this.fcW ? this.fcW() : null;
    if (!card || !card.info || !card.info.cents || !W || !W.cardBoth || !W.cardBoth(card) || !W.cardInUnit) return '';
    const each = ['usd', 'sat'].map((u) => ({ u, n: this.fcAbove(W.cardInUnit(card, u), limit, unit) })).filter((x) => x.n > 0);
    if (!each.length) return '';
    return 'It holds ' + each.map((x) => this.fcBoth(x.n, x.u)).join(' and ') + ' in pieces larger than that. On a card that holds both currencies they are not recut: they stay as they are, and a till holds the card longer to pay with them. ';
  }

  /* What a card holds in pieces larger than `limit`: the pieces a till holds
   * longer for. Only a card cut deep is cut to a limit; 0 for any other. */
  /* (A card of 1.23: `limit` is in `unit` (cents for 'usd'), and each piece is weighed against it in cents at the card's rate, the figure said
   * in the card's record's currency (the wallet's `cardAboveFor`). `recut`: for the promise that the pieces are recut under a new limit,
   * which a card of both currencies is not: 0 for it.) */
  fcAbove(card, limit, unit, recut) {
    if (!card || !card.info || !card.info.wide || !card.info.many || !(limit > 0)) return 0;
    const W = this.fcW ? this.fcW() : null;
    if (card.info.cents && W && W.cardAboveFor) {
      if (recut && W.cardBoth && W.cardBoth(card)) return 0;
      return W.cardAboveFor(card, limit, unit || '', (this.px && this.px()) || 0);
    }
    return (card.pieces || []).reduce((n, x) => (Number(x.amount) > limit ? n + Number(x.amount) : n), 0);
  }

  /* ---- the card's own log -----------------------------------------------------
   *
   * Kept by the card and written by nothing else: every tap in which it signed
   * for anything, or refused to because a limit was reached (08a-flashcard.js,
   * `cardLogOf`). The card cannot know a price, so it cannot say a payment was
   * too much; it says what it signed for and when, and the person judges. What
   * it can say by itself is that a terminal asked for more than its limit
   * three times or more inside ten seconds, which a terminal that keeps to the
   * limits never does once: that tap is marked. */
  fcLogCard() {
    const fc = this.state.fc || {};
    const log = fc.log;
    if (!log || !log.last) return;
    /* The card's counts are its own, of no unit (they keep their sats names), and in the unit of the card's money
     * (`log.unit`): a dollar card's are cents, said as the dollars they are, with no price in them. */
    const U = (log.unit === 'usd' || fc.unit === 'usd') ? 'usd' : 'sat';
    /* A card of software 1.15 and on cannot be told a false time: its clock is block headers, which no one can make for a time
     * that has not come, so nothing here speaks of one (`fc.headers`). A mark the card counted that this phone cannot find in
     * its eight taps is, for such a card, a run of refusals that has left the ring. */
    const blocks = !!fc.headers;
    const refusals = log.last.some((x) => x.tamper) || (blocks && !!log.since && log.since.tampers > 0);
    const counted = !blocks && !log.last.some((x) => x.tamper) && !!log.since && log.since.tampers > 0;
    const clock = !blocks && (log.last.some((x) => x.clock) || fc.clockAhead > 0 || counted);
    const marked = refusals || clock;
    const n = (count, one, many) => count + ' ' + (count === 1 ? one : many);
    /* When a tap was. A card of 1.15 and on writes the time its terminal told it beside the time in the newest block header it
     * had: the phone's own, to the second, with the block's beside it. A card before it has the one time, its own clock. */
    const when = (x) => {
      if (!blocks) return this.fcWhen(x.time);
      const block = x.time > 0 ? 'block ' + this.fcWhen(x.time) : 'no block yet';
      return x.told > 0 ? this.fcWhen(x.told) + ' (' + block + ')' : block;
    };
    // in dollars, at the price now: the card keeps sats and knows no price
    const line = (x) => {
      const said = [];
      const put = x.loaded > 0 || x.loads > 0;
      // (software 1.23: each entry is of one currency, which the card says, bit 5 of its flags: its figures are in that one)
      const XU = (x.unit === 'usd' || x.unit === 'sat') ? x.unit : U;
      /* An opening of the card's own change given up in the tap (software 1.22, bit 4 of its flags): a line of its own, after the
       * tap's other line where it had anything else. */
      const gaveUp = x.letGo ? when(x) + ': change owed to the card given up' : '';
      if (gaveUp && !(x.sats > 0 || x.pieces > 0 || put || x.refused || x.noPin || x.waited || x.tamper || x.clock)) return gaveUp;
      // what it signed for (which is the pieces, and may be more than the price), unless the tap only put money on
      if (x.sats > 0 || x.pieces > 0 || !put) said.push(this.fcPrice(x.sats, XU) + (x.pieces ? ', ' + n(x.pieces, 'piece', 'pieces') : ''));
      if (put) said.push(this.fcPrice(x.loaded, XU) + ' put on');
      if (x.noPin) said.push('no PIN');
      if (x.waited) said.push('over the per tap limit');
      if (x.refused) said.push(x.refused + ' refused');
      return when(x) + ': ' + said.join(', ')
        + (x.tamper ? ' — TAMPER' : '') + (x.clock ? ' — TOLD A FALSE TIME' : '') + (gaveUp ? '\n' + gaveUp : '');
    };
    const since = (log.since && (log.since.taps > 0 || log.since.refused > 0))
      ? 'Since this phone last looked: ' + n(log.since.taps, 'tap', 'taps') + ', ' + this.fcPrice(log.since.sats, U) + ' signed for'
        + (log.since.refused > 0 ? ', ' + log.since.refused + ' refused' : '') + '.\n\n'
      : '';
    const ahead = fc.clockAhead > 0
      ? 'This card’s clock is ' + this.fcSpan(fc.clockAhead) + ' ahead of this phone’s: it has been told a time that had not come.\n\n'
      : '';
    // a guest's view (software 1.22) is kept nowhere on this phone: what the card says, and nothing to copy
    const guest = !!fc.guestRead;
    const receipts = fc.receipts && fc.receipts.count > 0
      ? (guest ? '\n\nThe card has signed ' + n(fc.receipts.count, 'payment', 'payments') + '.'
        : '\n\nReceipts kept on this phone: ' + fc.receipts.list.length + ' of ' + n(fc.receipts.count, 'payment', 'payments')
          + '. Each names the swap its money went into, which can be matched to the wallet that took it.')
      : '';
    this.blockedCard('fc-log', Object.assign({
      long: true,
      tone: marked ? 'warn' : 'ask', title: marked ? 'TAMPER ON THIS CARD' : 'THIS CARD’S OWN LOG',
      reason: (refusals ? 'A terminal asked this card for more than its limit allows, three times or more ' + (blocks ? 'before its clock moved on' : 'within ten seconds') + '. The card refused each time and wrote it down.\n\n' : '')
        + ((!blocks && (log.last.some((x) => x.clock) || counted)) ? 'A terminal told this card the time twice in one tap, more than two minutes apart. No phone’s clock does that.\n\n' : '')
        + (blocks ? 'This card keeps its time by Bitcoin blocks, which no terminal can set. Each tap is shown at the time the phone that tapped it told the card, with the block the card had beside it.\n\n' : '')
        + ahead
        + 'Kept by the card itself. No phone or terminal can change it.'
        + (guest ? ' Shown as a guest: nothing of it is kept on this phone.' : '') + '\n\n' + since
        + log.last.map(line).join('\n')
        + '\n\nIn all: ' + n(log.taps, 'tap', 'taps') + ', ' + this.fcPrice(log.sats, U)
        // (software 1.23: and what was signed for in its other currency, apart, never added in)
        + ((Number(log.other) > 0 && log.otherUnit) ? ' and ' + this.fcPrice(log.other, log.otherUnit === 'usd' ? 'usd' : 'sat') : '')
        + ' signed for, ' + log.refused + ' refused.'
        + ((U !== 'usd' && ((this.px && this.px()) || 0) > 0) ? '\n\nIn dollars at the price now.' : '')
        + receipts,
      shut: { label: 'CLOSE' },
    }, (receipts && !guest) ? { retry: 'COPY RECEIPTS', go: () => this.fcCopyReceipts() } : {}));
  }

  /* A length of time in words, for how far a clock is out. */
  fcSpan(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 5400) return Math.max(1, Math.round(s / 60)) + ' minutes';
    if (s < 172800) return Math.round(s / 3600) + ' hours';
    return Math.round(s / 86400) + ' days';
  }

  /* The card's receipts as text, for whoever has to be shown them: the card,
   * and for each payment its number, when (the card's clock, in UTC), what
   * the pieces were worth in sats, the hash of what the card signed, and the
   * first output of the swap it went into. */
  fcCopyReceipts() {
    const fc = this.state.fc || {};
    const W = this.fcW();
    const list = (W && W.cardReceipts) ? W.cardReceipts(fc.key) : [];
    if (!list.length) { this.toast('No receipts to copy.', true); return; }
    const iso = (secs) => new Date(secs * 1000).toISOString().replace('.000Z', 'Z');
    /* A card of software 1.15 and on writes two times in a receipt: the one its terminal told it (the phone's own clock, a note the
     * card trusts for nothing) and the time in the newest block header the card had (its own clock). A card before it has the one, which
     * was told it under a signature: it goes in the first column, and the second has none. */
    const blocks = list.some((r) => r.told !== undefined);
    // a dollar card's receipts count cents (the card's own figures, which name no unit)
    const col0 = (fc.unit === 'usd' || (fc.receipts && fc.receipts.unit === 'usd')) ? 'cents' : 'sats';
    /* (a card of software 1.23 says each receipt's unit, which may be either: the column is then the amount, each with its unit after it) */
    const mixed = list.some((r) => r.unit === 'usd' || r.unit === 'sat');
    const col = mixed ? 'amount (cents or sats, as said)' : col0;
    const amt = (r) => (mixed ? r.sats + ' ' + (r.unit === 'usd' ? 'cents' : r.unit === 'sat' ? 'sats' : col0) : String(r.sats));
    const text = (blocks
      ? ['Foxy card receipts', 'card ' + fc.key, 'payment, time (UTC, as the phone that tapped it told the card), block time (UTC, the card’s clock), ' + col + ', sha256 of the message signed, first output (B_)']
        .concat(list.map((r) => '#' + r.n + ', ' + (r.told !== undefined ? (r.told > 0 ? iso(r.told) : '-') : iso(r.time)) + ', '
          + (r.told !== undefined ? (r.time > 0 ? 'block ' + iso(r.time) : '-') : '-') + ', ' + amt(r) + ', ' + r.hash + ', ' + r.out))
      : ['Foxy card receipts', 'card ' + fc.key, 'payment, time (UTC, by the card’s clock), ' + col + ', sha256 of the message signed, first output (B_)']
        .concat(list.map((r) => '#' + r.n + ', ' + iso(r.time) + ', ' + amt(r) + ', ' + r.hash + ', ' + r.out)))
      .join('\n');
    const copied = this.copySecret ? this.copySecret(text) : false;
    this.toast(copied ? 'Receipts copied.' : 'Could not copy the receipts.', !copied);
  }

  /* LIMITS. */
  fcSetLimit() {
    const fc = this.state.fc;
    if (!fc) return;
    // said before anything is asked: a card with no owner has nobody to set its limit, and another phone's card is not this one's to
    if (!fc.owner) { this.fcFailed({ card: 'no-owner', message: 'This card has no owner, so its limit cannot be changed.' }); return; }
    if (fc.ownedHere === false) { this.fcFailed({ card: 'not-owner' }); return; }
    /* The limit on one payment and the no-PIN limit. This phone sets no daily limit (the card's own rule since 1.21), and says
     * nothing of one a card has. A card whose software has no limit on one tap (an older one) has none this phone sets. */
    if (!(fc.tap && fc.tap.known)) { this.fcFailed({ card: 'old-card', message: 'This card\u2019s software has no limit on one tap.' }); return; }
    // CARD LIMITS (26j-card-wheel.js): a row for each, and a second for a card that has a PIN and a software that has the no PIN limit (1.16 and on)
    this.fcLimitsOpen();
  }

  /* One tap that sets the limit with this phone's proof that it is the owner. No PIN is asked, unless the card holds
   * pieces larger than a new limit on one tap (`pin`): then its money is recut under the limit in the same tap. */
  /* `answer`: the owner's answer to the rate guard (software 1.23: `rate-far`, `fcRateFar`), { rateOk } or { keepRate }. */
  fcLimitRun(sats, tap, usd, pin, answer) {
    const W = this.fcW();
    // 'nopin': the no PIN limit (software 1.16 and on), whose dollars are kept like the limit on one tap's
    const np = tap === 'nopin';
    /* A card of software 1.23: one figure for both its currencies, kept in cents on the card, written with the rate at this phone's price;
     * typed in dollars it is those dollars exactly, typed in sats it is turned into cents at that rate (`unit`). Nothing is kept here to
     * follow the price: the rate does that. */
    const v123 = !!(this.state.fc && this.state.fc.v123);
    const lu = this.fcLimitUnit();
    // a dollar card's limit is its cents, and is kept at nothing: no dollars are sent for it (the wallet writes no pace note for one)
    const keep = v123 ? (lu === 'sat' ? usd : 0) : this.fcUnit() === 'usd' ? 0 : usd;
    const more = v123 ? Object.assign({ unit: lu, price: (this.fcRatePrice ? this.fcRatePrice() : (this.px && this.px()) || 0) }, answer || {}) : {};
    this.fcTap({}, (link, on, progress) => {
      on('writing');
      return W.cardSetLimit(link, Object.assign(np ? { sats, noPin: true, usd: keep, on, progress } : { sats, tap: !!tap, usd: (tap || v123) ? keep : 0, pin, on, progress }, more));
    })
      .then((card) => {
        this.fcShow(card);
        this.haptic && this.haptic('success');
        this.toast((np ? 'No PIN limit ' : (this.fcPacedNow && this.fcPacedNow()) ? 'Per second limit ' : 'Per tap limit ') + (sats > 0 ? 'set.' : 'removed.') + (card && card.recut ? ' The card\u2019s money is recut under it.' : ''));
      }, (e) => {
        // the rate guard: asked once, and the limit written with the answer
        if (e && e.card === 'rate-far' && !answer) { this.fcRateFar(e, (a) => this.fcLimitRun(sats, tap, usd, pin, a)); return; }
        this.fcFailed(e, { again: () => this.fcLimitRun(sats, tap, usd, pin, answer) });
      });
  }

  /* ---- SWAP between a card's two balances (software 1.23) ------------------------------------------------------------
   *
   * The card cannot reach a mint, and a swap between dollars and bitcoin is the mint's, which takes longer than a card is held. So it is
   * this phone's own SWAP (26i-swap.js) with the card at each end: the amount on SET AMOUNT in the currency that leaves, the swap's own
   * confirmation (YOU ARE GETTING, YOU ARE SPENDING, FEE, the mint's rate), then
   *
   *   tap 1, the PIN    what the swap spends, its fee with it, taken off the card in that currency, as WITHDRAW takes it;
   *   no card           the swap at the mint, on this phone, at the rate shown while it holds (a new one for what came off where not);
   *   tap 2             what arrived put on the card in the other currency, as ADD FUNDS puts it on, under the PIN and the design's say.
   *
   * Cut short anywhere, the money is in this phone, in whichever currency it was then, and the screen offers to put it on the card or
   * leave it. Only the card's owner's phone swaps. */
  fcSwap() {
    const fc = this.state.fc;
    if (!fc || !fc.v123 || !fc.bal) return;
    if (!this.fcReady('Swapping')) return;
    if (fc.ownedHere === false) { this.fcFailed({ card: 'not-owner' }); return; }
    if (!this.twoUnitsOn || !this.twoUnitsOn()) { this.toast('This mint issues only bitcoin, so there is nothing to swap with.', true); return; }
    const from = fc.bal.usd > 0 || !(fc.bal.sat > 0) ? 'usd' : 'sat';
    if (!(fc.bal[from] > 0)) { this.toast('There is nothing on this card to swap.', true); return; }
    this._swapCard = { key: fc.key, bal: { usd: fc.bal.usd, sat: fc.bal.sat } };
    console.log('[foxy] card: SWAP opened on the card, from ' + this.unitWord(from).toLowerCase());
    // as home's SWAP opens (26i-swap.js, `goSwap`), from the card's balances
    this._swapAhead = null;
    this._swapProbed = {};
    this._swapProbeWanted = null;
    clearTimeout(this._swapTypedT);
    this._swapTypedT = null;
    this.setState(p => ({
      screen: 'swap', stack: p.stack.concat([p.screen]),
      swapFrom: from, swapTo: from === 'usd' ? 'sat' : 'usd',
      swapQuote: null, swapNewRate: false, swapAmount: 0, swapAll: false,
      swapErr: '', swapErrAmount: false, swapQuoting: false, swapBusy: false, swapResult: null,
      swapRequotes: 0, swapLapsed: false, swapProbing: false,
    }));
    this.swapProbe(from);
  }

  // SWAP pressed on the confirmation of a card's swap (26i-swap.js, `swapGo`): the PIN, then the first tap
  fcSwapGo(q) {
    const W = this.fcW();
    const sc = this._swapCard;
    const { from, to } = this.swapUnits();
    if (!W || !sc || !q) return;
    if (this.moneyBusy && this.moneyBusy()) { this.toast('Something else is moving money right now. Try again in a moment.', true); return; }
    const total = Math.round(Number(q.total) || 0);
    this.fcPinOr({
      title: 'CARD PIN',
      subtitle: 'To take ' + this.fcBoth(total, from) + ' off the card for the swap. Then tap the card again to put on what the swap brings.',
      cta: 'TAKE ' + this.fcPrice(total, from) + ' OFF',
    }, (pin) => {
      this.setState({ swapBusy: true, swapErr: '', swapErrAmount: false });
      let took = 0;
      this.fcTap({ amount: this.stageMoney(total, from), warm: true },
                 (link, on, progress) => W.cardWithdraw(link, { pin, sats: total, unit: from, on, progress, only: sc.key }))
        .then((r) => {
          took = this.fcAmt(r);
          if (r && r.hash) this.txIsNew(r.hash);
          this.refreshBalance();
          // the swap at the mint, with no card: at the rate shown while it holds, a new one for what came off where not
          const fresh = Number(q.expiresAt) - Date.now() > (this.SWAP_MARGIN_MS || 15000);
          this.showMelt('Swapping ' + this.unitWord(from).toLowerCase() + ' into ' + this.unitWord(to).toLowerCase() + '\u2026', 120000);
          /* the card the swap is for (`opts.card`, kept on the quote and the swap's records); the swap's own rows are this phone's and
           * name no card: in the card's history it is the two taps. The quote the swap screen asked is marked here, a new one is asked with it. */
          if (fresh) q.card = sc.key;
          this._swapRun = (fresh ? Promise.resolve(q) : W.swapQuote(from, to, took, { card: sc.key })).then((q2) => W.swapRun(q2, (stage) => console.log('[foxy] card: swap ' + stage)));
          return this._swapRun.then((sw) => { this._swapRun = null; return sw; }, (e) => { this._swapRun = null; throw e; });
        })
        .then((sw) => {
          this.hideMelt();
          this.refreshBalance();
          this.loadHistory();
          this.setState({ swapBusy: false, swapQuote: null });
          if (sw && sw.state === 'pending') { this.fcSwapPending(sw, took, from); return; }
          if (!(sw && sw.state === 'done')) { this.fcSwapBack(took, from, pin, sc.key); return; }
          /* (what the mint's fee reserve did not use came back to this phone in the currency that left: it goes back on the card in the
           * same tap, `back`) */
          const left = Math.max(0, took - Math.round(Number(sw.from && sw.from.amount) || 0));
          this.fcSwapOn(Math.round(Number(sw.to && sw.to.amount) || 0), to, pin, sw, left > 0 ? { amount: left, unit: from } : null, sc.key);
        }, (e) => {
          this.hideMelt();
          this.setState({ swapBusy: false });
          // nothing came off the card: said as any card's refusal is, and the confirmation stays
          if (!(took > 0)) { this.fcFailed(e, { taken: true, again: () => this.fcSwapGo(q) }); return; }
          this.fcSwapBack(took, from, pin, sc.key);
        });
    });
  }

  /* The swap's first half made and the second not answered: back on the card's screen, not home, with what came off the card
   * (`took`, which the card signed away) taken from its figures, since the card is not read again here; the card over it says
   * where the swap stands (26i-swap.js, `swapPendingCard`). The sweeps finish the swap when the mint answers: what it brings
   * lands in this phone, in the other currency, and ADD FUNDS puts it on the card; a swap the mint never made leaves what
   * came off in this phone, in the currency it left in. */
  fcSwapPending(sw, took, unit) {
    const sc = this._swapCard;
    this._swapCard = null;
    this._preSettle = null;
    const fc = this.state.fc;
    const off = Math.max(0, Math.round(Number(took) || 0));
    const next = (fc && sc && fc.key === sc.key && off > 0) ? Object.assign({}, fc, {
      balance: fc.unit === unit ? Math.max(0, (Number(fc.balance) || 0) - off) : fc.balance,
      bal: fc.bal ? Object.assign({}, fc.bal, { [unit]: Math.max(0, (Number(fc.bal[unit]) || 0) - off) }) : fc.bal,
    }) : fc;
    this.setState({ screen: 'flashcard', stack: [], fc: next, swapResult: null });
    this.swapPendingCard(sw, { card: true });
  }

  // the swap was not made: what came off the card is in this phone, in the currency it left in, to put back or keep
  // (`key`: the card it came off, which PUT IT BACK puts it on and no other)
  fcSwapBack(took, unit, pin, key) {
    this._swapCard = null;
    this.setState({ screen: 'flashcard', stack: [] });
    this.haptic && this.haptic('warning');
    this.blockedCard('fc-swap-back', {
      tone: 'warn', title: 'NOT SWAPPED',
      reason: this.fcBoth(took, unit) + ' came off the card and is in this phone. Put it back on the card, or leave it in this phone.',
      retry: 'PUT IT BACK', go: () => this.fcSwapOn(took, unit, pin, null, null, key),
      shut: { label: 'LEAVE IT', pill: true },
    });
  }

  // the second tap: what the swap brought (or what came off, put back) onto the card, in its currency
  /* `back`: what the mint's fee reserve did not use, { amount, unit } in the currency that left, put back on in the same tap; where it
   * cannot be made for the card it stays in this phone, and the swap's end says so. */
  /* `key`: the card the swap is for (the one whose first tap it took from). The second tap is held to it: another card at the reader
   * is refused by the wallet before anything is made (`wrong-card`, `cardPrepare`'s `only`), so nothing is owed to that card or
   * written on it, and the screen asks for the right card again. */
  fcSwapOn(amount, unit, pin, sw, back, key) {
    const W = this.fcW();
    if (!W || !(amount > 0)) return;
    let made = null, backOn = 0;
    const only = key || undefined;
    // (nothing of an earlier swap's card is kept for this one's SWAPPED, 26i-swap.js `swapDoneClose`)
    this._fcSwapWrote = null;
    this.fcTap({ amount: this.stageMoney(amount, unit), warm: true }, (link, on) => {
      on('mint');
      return W.cardLook(link, { short: true }).then((card) => W.cardPrepare(card, amount, { unit, only }).then((m) => {
        if (!(back && back.amount > 0)) return m;
        if (m && m.hash) this.txIsNew(m.hash);
        return W.cardPrepare(card, back.amount, { unit: back.unit, only }).then((b) => {
          backOn = back.amount;
          if (b && b.hash) this.txIsNew(b.hash);
          return m;
        }, (eB) => { console.warn('[foxy] card: the swap fee’s unused part stays in this phone:', (eB && eB.message) || eB); return m; });
      })).then((m) => {
        made = m;
        if (m && m.hash) this.txIsNew(m.hash);
        on('writing');
        return W.cardWrite(link, { pin: pin || undefined, price: (this.fcRatePrice ? this.fcRatePrice() : (this.px && this.px()) || 0) });
      });
    }).then((r) => {
      this._swapCard = null;
      this.refreshBalance();
      this.loadHistory();
      this.haptic && this.haptic('success');
      /* The card as the write read it: shown now where the card's screen is up, and kept for SWAPPED's close onto it (26i-swap.js,
       * `swapDoneClose`), which is off the card's screen while this runs and found it stale ("I had to go home and rescan"). */
      if (r && r.card) { this._fcSwapWrote = r.card; this.fcShow(r.card); }
      if (back && back.amount > 0) {
        this.toast(backOn > 0 ? this.fcBoth(backOn, back.unit) + ' of the mint’s fee was not used and is back on the card.'
          : this.fcBoth(back.amount, back.unit) + ' of the mint’s fee was not used. It is in this phone.');
      }
      if (sw) { this.setState({ swapBusy: false, swapResult: sw, screen: 'swapDone', stack: ['flashcard'] }); return; }
      this.setState({ screen: 'flashcard', stack: [] });
      this.toast(this.fcBoth(amount, unit) + ' is back on the card.');
    }, (e) => {
      this.refreshBalance();
      this.loadHistory();
      // made for the card and not written: it goes on at the card's next tap, as anything made for a card does
      if (made) { this._swapCard = null; this.setState({ screen: 'flashcard', stack: [] }); this.fcStillWaiting({ noPin: !pin }); return; }
      this.haptic && this.haptic('warning');
      // another card at the second tap: nothing was made for it or put on it; the money is in this phone for the right card
      if (e && e.card === 'wrong-card') {
        this.blockedCard('fc-swap-left', {
          tone: 'warn', title: 'A DIFFERENT CARD',
          reason: 'That is not the card on the screen. Nothing was put on it. ' + this.fcBoth(amount, unit)
            + ' is in this phone. Tap the card on the screen to put it on, or leave it in this phone.',
          retry: 'TAP CARD', go: () => this.fcSwapOn(amount, unit, pin, sw, back, key),
          shut: { label: 'LEAVE IT', pill: true, tap: () => { this._swapCard = null; } },
        });
        return;
      }
      this.blockedCard('fc-swap-left', {
        tone: 'warn', title: sw ? 'SWAPPED, NOT ON THE CARD' : 'NOT ON THE CARD',
        reason: this.fcBoth(amount, unit) + ' is in this phone. Tap the card to put it on, or leave it in this phone.'
          + ((e && e.message) ? ' ' + String(e.message) : ''),
        retry: 'TAP CARD', go: () => this.fcSwapOn(amount, unit, pin, sw, back, key),
        shut: { label: 'LEAVE IT', pill: true, tap: () => { this._swapCard = null; } },
      });
    });
  }

  /* ---- the rate (software 1.23) ------------------------------------------------------------------------------------------
   *
   * A card of 1.23 weighs a payment in sats in cents, at a rate its owner's phone writes from the price it shows, and its owner's phone
   * keeps that near the market without a word (08a-flashcard.js, `cardRepeg23`). A price more than twice the one the card last knew, or
   * under half of it, is asked about once before it is written: a wrong price is the one way the owner's own phone could loosen the card's
   * ceiling for sats. Never on the first rate a card is given. */
  fcRateWords(now, was) {
    return 'Bitcoin\u2019s price is now $' + this.group(Math.round(Number(now) || 0)) + '; the card last knew $' + this.group(Math.round(Number(was) || 0)) + '. Update it?';
  }

  // from CHANGE LIMIT (the wallet's `rate-far`): YES writes this phone's rate with the limit, NO keeps the card's
  fcRateFar(e, then) {
    this.haptic && this.haptic('warning');
    this.blockedCard('fc-rate-far', {
      tone: 'ask', title: 'BITCOIN PRICE',
      reason: this.fcRateWords(e.now, e.was),
      retry: 'YES', go: () => then({ rateOk: true }),
      shut: { label: 'NO', pill: true, tap: () => then({ keepRate: true }) },
    });
  }

  // from the owner's read (`card.rateAsk`): YES is one tap that writes the rate, NO is not asked again at this price
  fcRateAsk(card) {
    const W = this.fcW();
    const a = card && card.rateAsk;
    if (!W || !a) return;
    this.blockedCard('fc-rate-ask', {
      tone: 'ask', title: 'BITCOIN PRICE',
      reason: this.fcRateWords(a.now, a.was),
      retry: 'YES', go: () => this.fcTap({}, (link, on) => { on('writing'); return W.cardSetRate(link, { price: a.now }); })
        .then((c) => { this.fcShow(c); this.haptic && this.haptic('success'); this.toast('The card has the new price.'); },
              (e) => this.fcFailed(e, { again: () => this.fcRateAsk(card) })),
      shut: { label: 'NO', pill: true, tap: () => { if (W.cardRateNo) W.cardRateNo(card.key, a.rate); } },
    });
  }

  /* ---- its mint: TRANSFER ---------------------------------------------------
   *
   * TRANSFER, in the card's MENU above RESET, moves the card, and its money with it, to another mint, in one tap. It is built of
   * screens the app already has:
   *
   *   which mint            the app's own list of mints, asked "TO WHICH MINT?"
   *   what it costs         the confirmation every move has: what moves, the card's mint's fee, the Lightning fee, the new mint's
   *                         fee, and about what arrives on the card, asked of both mints before the card is touched
   *                         (the wallet's `cardTransferQuote`). Nothing moves until it is agreed to
   *   the PIN, and one tap  the card's sheet, the card drawn upright: the money comes off the card, crosses by Lightning, the
   *                         empty card is told its new mint with this phone's proof that it owns it, and the new pieces go on,
   *                         all in the one tap (`cardTransfer`)
   *   the end               the orange success screen: CARD MOVED, what is on the card now, NOW AT the new mint, DONE
   *
   * The money pays for its own crossing: this phone's own balance is not dipped into. A dollar card goes to a mint that issues
   * dollars as dollars, and to one that issues none as bitcoin, which the confirmation says before anything moves ("macadamia
   * has no dollars, so the money becomes bitcoin.") and the card's record is changed to at the write.
   *
   * Cut short anywhere, nothing is only in memory: a tap that drops once the new pieces are made leaves them owed to the card at
   * its new mint, and TAP CARD (now, or the line on the card's screen later) writes them, the record first; a crossing that did
   * not go leaves the money in this phone at the old mint with the TRANSFER noted, and the card's screen offers to finish it
   * (`fcMoveResume`), which is the confirmation again and one tap. Only the phone that owns the card is offered TRANSFER: the new
   * mint is written into the card with the owner's proof.
   *
   * The phone is taken to the card's mint for as long as this lasts, and to the new one for the tap's end, and put back when it
   * ends, however it ends (`fcMoveEnd`). */
  fcSwitchMint() {
    const fc = this.state.fc;
    const W = this.fcW();
    if (!fc || !this._fcCard || !W) return;
    if (this.offlineNow()) { this.offlineNo('Moving a card to another mint'); return; }
    if (fc.ownedHere !== true) {
      this.blockedCard('fc-move-owner', { tone: 'warn', title: 'NOT THIS PHONE’S CARD', reason: 'Only the phone that owns this card can move it to another mint.' });
      return;
    }
    // a move connects to another mint, and waits like every switch for money that is already moving
    if (this.refuseSwitchWhileBusy && this.refuseSwitchWhileBusy()) return;
    if (this.fcOwed().some(r => r.key === fc.key)) {
      this.blockedCard('fc-owed-first', {
        tone: 'warn', title: 'PUT IT ON FIRST',
        reason: 'Money is waiting to go onto this card. Put it on, then move the card.',
        retry: 'TAP CARD', go: () => this.fcWriteAsk({}), shut: { label: 'CANCEL' },
      });
      return;
    }
    // (a card of software 1.23 holding both currencies moves one currency at a time: its SWAP makes it one first)
    if (fc.bal && fc.bal.usd > 0 && fc.bal.sat > 0) {
      this.blockedCard('fc-move-both', { tone: 'warn', title: 'TWO CURRENCIES', reason: 'This card holds dollars and bitcoin. SWAP it to one of them first, then transfer it.' });
      return;
    }
    /* Whichever mint this phone is at. The money comes off the card at the
     * card's own mint, and this phone is taken there for as long as the move
     * lasts (`fcMoveQuote`) and put back after (`fcMoveEnd`). */
    // through the one way into that list, which clears every other question it can be asking
    this.goSwitchMint({ fcPick: true });
  }

  /* A mint tapped on that list. */
  fcSwitchPick(url) {
    const fc = this.state.fc;
    const W = this.fcW();
    const to = String(url || '').replace(/\/+$/, '');
    if (!this.state.fcPick) return;
    if (!fc || !W || !to) { this.setState({ fcPick: false }); this.back(); return; }
    this._fcMoveWas = String(W.mintUrl || '').replace(/\/+$/, '');
    if (!this.fcAnyMoney(fc)) {
      // nothing to move: off the list, and the card is told its new mint in one tap, with this phone's proof that it owns it
      this.setState(p => ({ fcPick: false, screen: p.stack.length ? p.stack[p.stack.length - 1] : 'flashcard', stack: p.stack.slice(0, -1) }));
      this.fcRepointRun(to);
      return;
    }
    const unit = (fc.bal && !(fc.bal[fc.unit] > 0) && fc.bal[fc.unit === 'usd' ? 'sat' : 'usd'] > 0) ? (fc.unit === 'usd' ? 'sat' : 'usd') : fc.unit;
    const have = fc.bal ? fc.bal[unit] : fc.balance;
    // the confirmation takes the list's place: back from it is the card's own screen
    this.setState({
      fcPick: false, screen: 'fcMoveConfirm',
      fcMove: { from: String(fc.mint || '').replace(/\/+$/, ''), to, unit, have, sats: have, quote: null, fee: null, lands: 0, err: '', busy: false },
    });
    this.fcMoveQuote();
  }

  fcRepointRun(to) {
    const W = this.fcW();
    const end = () => this.fcMoveEnd();
    Promise.resolve()
      .then(() => (String(W.mintUrl || '').replace(/\/+$/, '') === to ? null : W.connect(to, null, null, { remember: false })))
      .then(() => this.fcTap({}, (link, on) => { on('writing'); return W.cardRepoint(link); }))
      .then((card) => {
        this.fcShow(card);
        end();
        this.haptic && this.haptic('success');
        this.fcMovedScreen(to, card && card.balance, (card && card.record && card.record.unit) === 'usd' ? 'usd' : 'sat');
      }, (e) => { end(); this.fcFailed(e, { again: () => this.fcSwitchMint() }); });
  }

  /* What it will cost, asked of both mints before the card is touched (the wallet's `cardTransferQuote`, with this phone at the
   * card's mint). Nothing is spent by asking. A TRANSFER being finished from its note (`fcMove.resume`) is asked the same, of the
   * money in this phone. */
  fcMoveQuote() {
    const W = this.fcW();
    const m = this.state.fcMove;
    if (!W || !m) return;
    const put = (more) => { if (this.state.fcMove) this.setState({ fcMove: Object.assign({}, this.state.fcMove, more) }); };
    put({ quoting: true, err: '' });
    // to the card's mint first, where this phone is not there already: a visit, not a change of this phone's own mint
    const bare = (u) => String(u || '').replace(/\/+$/, '');
    this._fcVisit = Promise.resolve()
      .then(() => (bare(W.mintUrl) === bare(m.from) ? null : W.connect(m.from, null, null, { remember: false })));
    /* (a TRANSFER being finished: the card on show, empty, as if it held what is in this phone for it, so that the new mint's pieces
     * are cut for it as they will be; with none on show, the figure alone) */
    const shown = this._fcCard;
    const card = !m.resume ? shown
      : shown ? Object.assign({}, shown, { balance: m.have, pieces: [], units: undefined, whole: undefined, record: Object.assign({}, shown.record, { unit: m.unit }) })
      : { record: { unit: m.unit, mint: m.from }, balance: m.have, pieces: [], info: null };
    this._fcVisit.then(() => W.cardTransferQuote(card, m.to)).then((q) => {
      put({ quoting: false, quote: q, lands: q.lands, fee: q.fee, toUnit: q.toUnit });
    }, (e) => {
      put({ quoting: false, quote: null, fee: null, err: (e && (e.card === 'too-little' || e.card === 'both-units')) ? String(e.message) : W.reason(e) });
    });
  }

  // a figure of a TRANSFER in its own unit, as the confirmation says it: dollars with the sats under them, or the money line for sats
  fcMoveFig(n, unit) {
    if (unit !== 'usd') return this.money(n);
    const sat1 = (this.satUsd && this.satUsd()) || 0;
    return { main: this.unitFigure(n, 'usd'), sub: sat1 ? '₿ ' + this.group(Math.round(n / 100 / sat1)) : '' };
  }

  /* The confirmation screen's contents (confirmSpec), in the transfer's own shape: what goes, the three fees, what lands. */
  fcMoveSpec() {
    const m = this.state.fcMove || { sats: 0, unit: 'sat' };
    const u = m.unit === 'usd' ? 'usd' : 'sat';
    const q = m.quote;
    const from = (this.mintNameOf(m.from) || '').toUpperCase();
    const to = (this.mintNameOf(m.to) || '').toUpperCase();
    const asking = m.err ? 'UNKNOWN' : !q ? 'CHECKING…' : '';
    const fee = (n, prefix) => asking || ((prefix || '') + this.fcMoveFig(n, u).main);
    // what lands, in the unit it lands in: sats where the money becomes bitcoin, with what that is worth in the card's dollars under it
    const lands = !q ? null : q.converts ? { main: '₿ ' + this.group(q.lands), sub: '' } : this.fcMoveFig(q.lands, q.toUnit);
    const rows = [
      this.cfRow('FROM', from, { half: true }),
      this.cfRow('TO', to, { half: true }),
      this.cfRow(from + ' FEE', fee(q ? q.fees.from : 0), { half: true }),
      this.cfRow('LIGHTNING FEE', fee(q ? q.fees.lightning : 0, 'UP TO '), { half: true }),
      // the new mint's fee is in what lands there: in sats where the money becomes bitcoin
      this.cfRow(to + ' FEE', asking || this.fcMoveFig(q.fees.to, q.toUnit).main),
      this.cfRow('ARRIVES ON THE CARD', asking || 'ABOUT ' + lands.main,
                 { ink: 'var(--acc)', sub: (q && q.converts) ? this.unitFigure(q.worth, u) : '' }),
    ];
    const cancel = { label: 'CANCEL', go: () => this.fcMoveCancel() };
    const what = this.fcMoveFig(m.have, u);
    if (m.err) {
      return {
        title: 'CONFIRMATION', amountLabel: 'MOVING THIS CARD',
        amount: what.main, amountSub: what.sub, amountInk: '#FF5C5C', rows,
        warn: m.err, cta: 'TRY AGAIN', ctaTone: 'warn', go: () => this.fcMoveQuote(), secondary: cancel,
      };
    }
    return {
      title: 'CONFIRMATION', amountLabel: 'MOVING THIS CARD',
      amount: what.main, amountSub: what.sub, rows,
      subtitle: !q ? '' : q.converts ? this.mintNameOf(m.to) + ' has no dollars, so the money becomes bitcoin.'
        : 'Tap your card once. Its money moves to ' + this.mintNameOf(m.to) + '.',
      secondary: cancel,
      cta: m.busy ? 'MOVING…' : !q ? 'CHECKING THE FEE…' : 'TRANSFER ' + what.main,
      ctaTone: 'go', ctaBusy: !!m.busy || !q,
      go: () => { if (q && !m.busy) this.fcMoveGo(); },
    };
  }

  /* CANCEL on the confirmation: nothing has moved, and the phone goes back to the mint it was at. */
  fcMoveCancel() {
    this.fcMoveEnd(null);
  }

  fcMoveGo() {
    const m = this.state.fcMove;
    if (!m || !m.quote || m.busy) return;
    if (this.refuseSwitchWhileBusy && this.refuseSwitchWhileBusy()) return;
    const what = this.fcMoveFig(m.have, m.unit).main;
    this.fcPinOr({
      title: 'CARD PIN',
      subtitle: 'To transfer this card to ' + this.mintNameOf(m.to) + '.',
      cta: 'TRANSFER ' + what,
    }, (pin) => this.fcMoveRun(pin));
  }

  /* The one tap: off the card, across, the card told its new mint, and on again (the wallet's `cardTransfer`). */
  fcMoveRun(pin) {
    const W = this.fcW();
    const m = this.state.fcMove;
    const fc = this.state.fc;
    if (!m || !W) return;
    const busy = (on) => { if (this.state.fcMove) this.setState({ fcMove: Object.assign({}, this.state.fcMove, { busy: on }) }); };
    busy(true);
    /* One thing was asked for, and it writes entries: off the card, out of one mint, into the other, onto the card. None is a
     * payment to announce. Quiet from here, as a crossing made for a tap is (26d-tap.js), and every entry it wrote is marked seen
     * when it ends (`fcMoveEnd`). */
    this._quiet = true;
    this._fcQuiet = true;
    W.transactions(50).then((list) => { this._sweepBefore = new Set(list.map(x => x.hash)); },
                            () => { this._sweepBefore = null; });
    this.fcTap({ amount: this.stageMoney(m.have, m.unit), warm: true },
      (link, on, progress) => W.cardTransfer(link, { pin, on, progress, to: m.to, most: m.quote.fee, toUnit: m.quote.toUnit, unit: m.unit,
                                                     only: fc && fc.key, resume: !!m.resume }))
      .then((r) => {
        const end = r.visit ? r.visit.end() : Promise.resolve();
        this.fcMoveEnd(r.card, end);
        this.haptic && this.haptic('success');
        this.fcMovedScreen(m.to, r.lands, r.toUnit);
      }, (e) => {
        busy(false);
        this.fcMoveCut(m, e, pin);
      });
  }

  /* A TRANSFER cut short: said with where the money is (the wallet's `stage` on the error). */
  fcMoveCut(m, e, pin) {
    const W = this.fcW();
    const to = this.mintNameOf(m.to);
    const end = (e && e.visit) ? () => e.visit.end() : () => Promise.resolve();
    // nothing moved: the card was not read, or refused before anything came off it
    if (!e || !e.stage || e.stage === 'card') {
      end();
      this.fcMoveEnd(null);
      this.fcFailed(e, { again: () => this.fcMoveGo() });
      return;
    }
    // made for the card and owed to it at the new mint: the next tap writes it, with the phone still there
    if (e.stage === 'owed') {
      this.fcMoveEnd(null, end());
      this.blockedCard('fc-move-tap', {
        tone: 'warn', title: 'TAP THE CARD AGAIN',
        reason: 'Its money is at ' + to + ', waiting to go onto this card.',
        retry: 'TAP CARD', go: () => this.fcMoveWrite(m.to, pin),
        shut: { label: 'LATER' },
      });
      return;
    }
    // in this phone, at the old mint or the new: noted, and finished from the card's screen
    this.fcMoveEnd(null, end());
    const where = this.mintNameOf(e.stage === 'paid' ? m.to : m.from);
    this.blockedCard('fc-move-failed', {
      tone: 'warn', title: 'NOT MOVED YET',
      reason: (e.card === 'fee-up' ? String(e.message) : (e.card ? String(e.message) : W.reason(e))),
      chip: 'The money is in this phone, at ' + where + '. The card is empty. Finish the transfer from the card’s screen.',
      retry: 'FINISH', go: () => this.fcMoveResume(), shut: { label: 'LATER' },
    });
  }

  /* What a TRANSFER left owed to the card at its new mint, written: the phone visits that mint for the tap (the wallet's `cardVisit`),
   * the card is told its new mint and the pieces go on, under its PIN where it wants one for every load (software 1.21). */
  fcMoveWrite(to, pin0) {
    const W = this.fcW();
    if (!W) return;
    const go = (pin) => W.cardVisit(to).then((v) => this.fcTap({},
      (link, on, progress) => { on('writing'); return W.cardWrite(link, pin ? { pin, progress } : { owner: true, progress }); })
      .then((r) => {
        v.end();
        this.fcShow(r.card);
        this.refreshBalance();
        this.loadHistory();
        this.haptic && this.haptic('success');
        this.fcMovedScreen(to, r.amount, r.unit);
      }, (e) => { v.end(); this.fcFailed(e, { again: () => this.fcMoveWrite(to, pin) }); }),
    (e) => this.fcFailed(e, { again: () => this.fcMoveWrite(to, pin) }));
    if (pin0 || !this.fcKnownPinFirst()) { go(pin0 || ''); return; }
    this.fcAskPin({ title: 'CARD PIN', subtitle: 'To put its money on the card at ' + this.mintNameOf(to) + '.', cta: 'TAP CARD' }, go);
  }

  /* A TRANSFER the card's screen says is not finished (the wallet's `cardTransfers`): its money is in this phone. Where it is at the
   * old mint, the confirmation again, for what it holds of it, and one tap; where it has crossed already, one tap. */
  fcMoveResume() {
    const W = this.fcW();
    const fc = this.state.fc;
    const note = (W && W.cardTransfers && fc) ? W.cardTransfers()[fc.key] : null;
    if (!note) return;
    if (this.offlineNow()) { this.offlineNo('Finishing a card’s transfer'); return; }
    this._fcMoveWas = String(W.mintUrl || '').replace(/\/+$/, '');
    const unit = note.unit === 'usd' ? 'usd' : 'sat';
    const base = { from: String(note.from || '').replace(/\/+$/, ''), to: String(note.to || '').replace(/\/+$/, ''), unit, resume: true,
                   have: Math.round(Number(note.amount) || 0), sats: Math.round(Number(note.amount) || 0), err: '', busy: false };
    if (note.stage === 'paid') {
      // across already: nothing more to agree to, the new mint's own fee aside, and the tap is the write
      const q = { fee: Number.MAX_SAFE_INTEGER, toUnit: note.toUnit === 'usd' ? 'usd' : 'sat', lands: Math.round(Number(note.land) || 0) };
      this.setState({ fcMove: Object.assign(base, { quote: q, lands: q.lands }) });
      this.fcPinOr({ title: 'CARD PIN', subtitle: 'To finish moving this card to ' + this.mintNameOf(base.to) + '.', cta: 'FINISH' }, (pin) => this.fcMoveRun(pin));
      return;
    }
    this.setState(p => ({ screen: 'fcMoveConfirm', stack: p.stack.concat([p.screen]),
                          fcMove: Object.assign(base, { quote: null, fee: null, lands: 0 }) }));
    this.fcMoveQuote();
  }

  /* The end of a TRANSFER that went: the app's own success screen, orange, as money that arrives ends (12-receive.js; the design's
   * rule): CARD MOVED, what is on the card now in the unit it holds, NOW AT the new mint, DONE (back to the card's screen). */
  fcMovedScreen(to, amount, unit) {
    const u = unit === 'usd' ? 'usd' : 'sat';
    const got = Math.round(Number(amount) || 0);
    this._lastFee = 0;
    this._lastPay = null;
    this.setState(p => ({
      screen: 'paid', stack: (p.screen === 'paid' ? p.stack : p.stack.concat([p.screen])).filter((x) => x !== 'fcMoveConfirm'),
      payOut: false, paidSays: 'CARD MOVED', paidTo: '', paidUnit: u, paidAmount: got,
      paidPlace: { label: 'NOW AT', to: this.mintNameOf(to), dismiss: 'DONE' },
      paidAsked: 0, paidAskedSats: 0, paidAskOwn: false, paidConvert: false,
      asset: 'BITCOIN', unit: 'SATS', amount: String(u === 'usd' ? 0 : got),
      recvResolved: true, recv: Object.assign({}, p.recv, { live: 'in' }),
    }));
  }

  /* The quiet a move began is ended, with what it wrote marked as seen. */
  fcLoud() {
    if (!this._fcQuiet) return;
    this._fcQuiet = false;
    const loud = () => { this._quiet = false; };
    (this.hushSweepEntries ? this.hushSweepEntries() : Promise.resolve()).then(loud, loud);
  }

  /* The end of a move, however it went: the confirmation gives way to the
   * card's screen (showing `card` where there is one to show), and the phone
   * goes back to the mint it was at, once a visit the tap left open
   * (`after`, the wallet's `visit.end()`) has brought it back from the new one. */
  fcMoveEnd(card, after) {
    const W = this.fcW();
    const was = this._fcMoveWas;
    this._fcMoveWas = '';
    if (this.state.screen === 'fcMoveConfirm') {
      this.setState(p => ({ fcMove: null, screen: p.stack.length ? p.stack[p.stack.length - 1] : 'flashcard', stack: p.stack.slice(0, -1) }));
    } else if (this.state.fcMove) {
      this.setState({ fcMove: null });
    }
    if (card) this.fcShow(card);
    this.fcLoud();
    const home = () => { this.refreshBalance(); this.loadHistory(); };
    // after a visit that is still being made (CANCEL pressed while it was): put back from where that leaves it
    const visit = Promise.all([this._fcVisit || Promise.resolve(), after || Promise.resolve()]);
    this._fcVisit = null;
    const put = () => {
      if (W && was && String(W.mintUrl || '').replace(/\/+$/, '') !== was) W.connect(was).then(home, home);
      else home();
    };
    visit.then(put, put);
  }

  /* Everything off the card and on again, which is the only way its pieces
   * get a new date: the date is part of each piece. */
  fcRenew() {
    if (!this.fcReady('Renewing a card')) return;
    const W = this.fcW();
    const fc = this.state.fc;
    this.fcPinOr({
      title: 'CARD PIN',
      subtitle: 'Its money is good until ' + this.fcDay(fc.first) + '. Renew it for ' + this.fcHoldDays() + ' days: ' + this.fcWholeWords(fc) + '.',
      cta: 'RENEW',
    }, (pin) => this.fcTap({ amount: this.fcWholeStage(fc), warm: true },
      (link, on, progress) => W.cardRenew(link, { pin, on, progress }))
      .then((r) => {
        (r.hashes || []).forEach(h => this.txIsNew(h));
        this.fcWrote(r, { renewed: true });
      }, (e) => {
        ((e && e.hashes) || []).forEach(h => this.txIsNew(h));
        this.refreshBalance();
        this.loadHistory();
        this.fcFailed(e, { again: () => this.fcRenew() });
      }));
  }

  /* Its owner's phone, online, reads a card whose money has under FC_RENEW_DAYS left: it is offered the renewal at once,
   * since a card with under a week left is refused by a phone that is offline, and one a day from its date by any phone.
   * RENEW is `fcRenew` (its PIN, then the tap); LATER leaves the line on the card's screen that offers it too. Asked once
   * for a card in a session, so a card read again and again is not asked again and again. The whole card is renewed:
   * one payment signs pieces of one date, and a card of two dates could pay only part of what it holds at once. Not for a
   * card past its date (that is TAKE BACK), one at another mint, a locked one, or one with money still owed to it to be
   * written, which its next tap puts on first. */
  fcRefreshMaybe(card) {
    const W = this.fcW();
    const fc = this.state.fc;
    if (!W || !card || !fc || fc.key !== card.key || this.state.screen !== 'flashcard') return;
    this._fcRefreshAsked = this._fcRefreshAsked || {};
    if (this._fcRefreshAsked[fc.key]) return;
    if (!(W.cardOnline && W.cardOnline()) || this.offlineNow()) return;
    // (a locked card cannot give its money up to be renewed until its owner has opened it)
    if (!(fc.mine && fc.recoverable && this.fcAnyMoney(fc)) || fc.locked) return;
    const now = Math.floor(Date.now() / 1000);
    if (!(fc.first > 0 && fc.first - now < this.fcRenewSecs() && fc.first > now + this.fcOwnSecs())) return;
    const here = String((W.mintHost && W.mintHost()) || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const there = String(fc.mint || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!here || (there && there !== here)) return;
    const owed = ((W.cardOwed && W.cardOwed()) || []).some((r) => r && r.card === fc.key);
    const coming = !!(card.owes && card.owes.parts && card.owes.parts.some((x) => x && x.state !== 'put'));
    if (owed || coming) return;
    this._fcRefreshAsked[fc.key] = true;
    console.log('[foxy] card: its money has ' + Math.floor((fc.first - now) / 86400) + ' days left; its owner is offered the renewal');
    this.blockedCard('fc-renew-ask', {
      tone: 'ask', title: 'RENEW THIS CARD',
      reason: 'Its money is good until ' + this.fcDay(fc.first) + '. Renew it for ' + this.fcHoldDays() + ' days.',
      retry: 'RENEW', go: () => this.fcRenew(),
      shut: { label: 'LATER' },
    });
  }

  /* ---- a lost card ---------------------------------------------------------- */
  fcTakeBack(key) {
    const W = this.fcW();
    if (this.offlineNow()) { this.offlineNo('Taking a card back'); return; }
    this.stageScreen('cardBack', { art: 'card', title: 'TAKING<br>IT BACK', body: 'Asking the mint what is left on it.',
                                   dots: true, forMs: 90000, button: 'CLOSE' });
    W.cardTakeBack(key).then((r) => {
      this.hideStage('cardBack');
      // (RESTORE CARD's word from the mint for this card is out of date now: its row says what is on file, what is left for later)
      if (this._fcAtMint) delete this._fcAtMint[key];
      if (r && r.hash) this.txIsNew(r.hash);
      this.refreshBalance();
      this.loadHistory();
      this.forceUpdate();
      // in the card's own unit: a dollar card's cents are back in this phone's dollars
      const u = this.fcUnitOf(r);
      if (!(this.fcAmt(r) > 0)) {
        this.blockedCard('fc-back', { tone: 'warn', title: 'NOTHING WAS LEFT ON IT', reason: 'Everything this phone put on that card has been spent.' });
        return;
      }
      /* Back in this phone: the app's own success screen, RESTORED, with its flash, as money that arrives ends (12-receive.js; the
       * owner's rule), in the card's unit, ADDED TO the balance it went into. DONE there is home. What is not due yet goes in a line. */
      const got = this.fcAmt(r);
      this._lastFee = 0;
      this._lastPay = null;
      this.setState(p => ({
        screen: 'paid', stack: p.screen === 'paid' ? p.stack : p.stack.concat([p.screen]),
        payOut: false, paidSays: 'RESTORED', paidTo: '', paidPlace: null, paidUnit: u, paidAmount: got,
        paidAsked: 0, paidAskedSats: 0, paidAskOwn: false, paidConvert: false,
        asset: 'BITCOIN', unit: 'SATS', amount: String(u === 'usd' ? 0 : got),
        recvResolved: true, recv: Object.assign({}, p.recv, { live: 'in' }),
      }));
      this.haptic && this.haptic('success');
      if (r.later > 0) this.toast(this.fcSats(r.later, u) + ' more can be taken back from the card later.');
    }, (e) => {
      this.hideStage('cardBack');
      if ((e && e.card) === 'other-mint') {
        this.blockedCard('fc-other-mint', { tone: 'warn', title: 'A DIFFERENT MINT', reason: String(e.message || ''),
          retry: 'SWITCH MINT', go: () => this.goSwitchMint(), shut: { label: 'CANCEL' } });
        return;
      }
      this.fcFailed(e, { again: () => this.fcTakeBack(key) });
    });
  }

  /* The designs a card's face can be drawn in, each by a code of three
   * characters (capital letters and digits).
   *
   * A card maker takes a code nobody has taken and adds its drawing; the
   * codes taken are listed here and in docs/CARD-DESIGNS.md of the card
   * repository (https://github.com/getfoxy/card), so that anybody can see which are. FL1 is the first
   * Flash design, drawn in CSS; FX1 is Foxy's, a picture; EL1 is the beaker,
   * drawn in CSS and SVG and animated (build/markup.html, the card on the
   * FLASHCARD screen, and the face behind the sheet in 26h-tap-screen.js). From
   * software 1.10 the card's record names its design; a card that names none
   * is drawn as the design this phone wrote down for it when it set it up
   * (FC_SETUP_DESIGN), and FC_DESIGN where it wrote none. */
  FC_DESIGNS = {
    FL1: { name: 'Flash, first design', by: 'Flash' },
    FX1: { name: 'Foxy, first design', by: 'Foxy' },
    EL1: { name: 'Beaker, first design', by: 'Foxy' },
  };
  FC_DESIGN = 'FL1';
  /* EL1's face, the block build/markup.html holds inside the card on the FLASHCARD screen, for the face behind the sheet (26h-tap-screen.js);
   * shown only under [data-card-design="EL1"]. The two must stay the same. */
  FC_EL1_FACE = '<div data-el1 style="position:absolute;inset:0;overflow:hidden;border-radius:inherit;background:radial-gradient(120% 90% at 50% 100%,#1A1D20 0%,#0B0C0D 60%,#050505 100%);font-family:Sora,sans-serif"><div style="position:absolute;inset:0;background:linear-gradient(115deg,rgba(255,255,255,0) 30%,rgba(255,255,255,.06) 46%,rgba(255,255,255,0) 60%);pointer-events:none"></div><div style="position:absolute;left:7.69cqw;top:7.69cqw;width:13.08cqw;height:10.38cqw;border-radius:1.92cqw;background-image:linear-gradient(90deg,transparent 32%,rgba(90,55,10,.3) 32% 34%,transparent 34% 66%,rgba(90,55,10,.3) 66% 68%,transparent 68%),linear-gradient(0deg,transparent 48%,rgba(90,55,10,.3) 48% 52%,transparent 52%),linear-gradient(135deg,#F6D58A,#C9963F)"></div><div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:29.81cqw;height:44.23cqw"><div style="position:absolute;inset:0;animation:foxyEl1Sway 3.2s ease-in-out infinite;transform-origin:50% 90%"><div style="position:absolute;left:16.4%;width:67.2%;top:30%;height:22.9%;overflow:hidden"><div style="position:absolute;left:-25%;width:150%;top:0;bottom:-40%;transform-origin:50% 41%;animation:foxyEl1Slosh 3.2s ease-in-out infinite"><svg viewBox="0 0 237 147" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%"><g style="animation:foxyEl1FlowB 4.6s linear infinite"><path d="M0 147 L0 51 L0 58.6 L3 58.1 L6 57.4 L9 56.5 L12 55.6 L15 54.5 L18 53.3 L21 52.0 L24 50.8 L27 49.5 L30 48.3 L33 47.1 L36 46.0 L39 45.1 L42 44.3 L45 43.7 L48 43.3 L51 43.0 L54 43.0 L57 43.2 L60 43.5 L63 44.1 L66 44.8 L69 45.7 L72 46.7 L75 47.8 L78 49.0 L81 50.3 L84 51.6 L87 52.8 L90 54.0 L93 55.2 L96 56.2 L99 57.1 L102 57.8 L105 58.4 L108 58.8 L111 59.0 L114 59.0 L117 58.8 L120 58.3 L123 57.7 L126 57.0 L129 56.1 L132 55.0 L135 53.9 L138 52.6 L141 51.4 L144 50.1 L147 48.9 L150 47.7 L153 46.6 L156 45.6 L159 44.7 L162 44.0 L165 43.5 L168 43.1 L171 43.0 L174 43.1 L177 43.3 L180 43.8 L183 44.4 L186 45.2 L189 46.2 L192 47.3 L195 48.4 L198 49.7 L201 50.9 L204 52.2 L207 53.4 L210 54.6 L213 55.7 L216 56.7 L219 57.5 L222 58.1 L225 58.6 L228 58.9 L231 59.0 L234 58.9 L237 58.6 L240 58.1 L243 57.4 L246 56.5 L249 55.6 L252 54.5 L255 53.3 L258 52.0 L261 50.8 L264 49.5 L267 48.3 L270 47.1 L273 46.0 L276 45.1 L279 44.3 L282 43.7 L285 43.3 L288 43.0 L291 43.0 L294 43.2 L297 43.5 L300 44.1 L303 44.8 L306 45.7 L309 46.7 L312 47.8 L315 49.0 L318 50.3 L321 51.6 L324 52.8 L327 54.0 L330 55.2 L333 56.2 L336 57.1 L339 57.8 L342 58.4 L345 58.8 L348 59.0 L351 59.0 L354 58.8 L357 58.3 L360 57.7 L363 57.0 L366 56.1 L369 55.0 L372 53.9 L375 52.6 L378 51.4 L381 50.1 L384 48.9 L387 47.7 L390 46.6 L393 45.6 L396 44.7 L399 44.0 L402 43.5 L405 43.1 L408 43.0 L411 43.1 L414 43.3 L417 43.8 L420 44.4 L423 45.2 L426 46.2 L429 47.3 L432 48.4 L435 49.7 L438 50.9 L441 52.2 L444 53.4 L447 54.6 L450 55.7 L453 56.7 L456 57.5 L459 58.1 L462 58.6 L465 58.9 L468 59.0 L471 58.9 L474 58.6 L474 147 Z" fill="#FFA24D"></path></g><g style="animation:foxyEl1Flow 2.8s linear infinite"><path d="M0 147 L0 55 L0 55.0 L3 56.0 L6 56.9 L9 57.8 L12 58.6 L15 59.3 L18 59.9 L21 60.4 L24 60.7 L27 60.9 L30 61.0 L33 60.9 L36 60.7 L39 60.3 L42 59.8 L45 59.1 L48 58.4 L51 57.5 L54 56.6 L57 55.7 L60 54.8 L63 53.8 L66 52.9 L69 52.0 L72 51.2 L75 50.6 L78 50.0 L81 49.5 L84 49.2 L87 49.0 L90 49.0 L93 49.1 L96 49.4 L99 49.8 L102 50.4 L105 51.1 L108 51.8 L111 52.7 L114 53.6 L117 54.5 L120 55.5 L123 56.4 L126 57.3 L129 58.2 L132 58.9 L135 59.6 L138 60.2 L141 60.6 L144 60.9 L147 61.0 L150 61.0 L153 60.8 L156 60.5 L159 60.0 L162 59.4 L165 58.8 L168 58.0 L171 57.1 L174 56.2 L177 55.2 L180 54.3 L183 53.4 L186 52.5 L189 51.6 L192 50.9 L195 50.2 L198 49.7 L201 49.3 L204 49.1 L207 49.0 L210 49.1 L213 49.3 L216 49.6 L219 50.1 L222 50.7 L225 51.4 L228 52.2 L231 53.1 L234 54.0 L237 55.0 L240 56.0 L243 56.9 L246 57.8 L249 58.6 L252 59.3 L255 59.9 L258 60.4 L261 60.7 L264 60.9 L267 61.0 L270 60.9 L273 60.7 L276 60.3 L279 59.8 L282 59.1 L285 58.4 L288 57.5 L291 56.6 L294 55.7 L297 54.8 L300 53.8 L303 52.9 L306 52.0 L309 51.2 L312 50.6 L315 50.0 L318 49.5 L321 49.2 L324 49.0 L327 49.0 L330 49.1 L333 49.4 L336 49.8 L339 50.4 L342 51.1 L345 51.8 L348 52.7 L351 53.6 L354 54.5 L357 55.5 L360 56.4 L363 57.3 L366 58.2 L369 58.9 L372 59.6 L375 60.2 L378 60.6 L381 60.9 L384 61.0 L387 61.0 L390 60.8 L393 60.5 L396 60.0 L399 59.4 L402 58.8 L405 58.0 L408 57.1 L411 56.2 L414 55.2 L417 54.3 L420 53.4 L423 52.5 L426 51.6 L429 50.9 L432 50.2 L435 49.7 L438 49.3 L441 49.1 L444 49.0 L447 49.1 L450 49.3 L453 49.6 L456 50.1 L459 50.7 L462 51.4 L465 52.2 L468 53.1 L471 54.0 L474 55.0 L474 147 Z" fill="#F68200"></path></g></svg></div></div><img src="img/card-el1-beaker.png" alt="" style="position:absolute;inset:0;width:100%;height:100%"></div><div style="position:absolute;left:20%;right:13%;top:18%;bottom:9.5%;overflow:hidden;border-radius:0 0 3.46cqw 3.46cqw;pointer-events:none"><span style="position:absolute;left:4%;bottom:-4%;width:1.35cqw;height:1.35cqw;border-radius:50%;border:0.38cqw solid #FFFFFF;background:rgba(255,255,255,.35);box-shadow:0 0 0.77cqw rgba(255,255,255,.4);box-sizing:border-box;opacity:0;animation:foxyEl1Bub 5.2s cubic-bezier(.4,0,.6,1) -2.91s infinite"></span><span style="position:absolute;left:9%;bottom:-4%;width:0.77cqw;height:0.77cqw;border-radius:50%;border:0.38cqw solid #FFFFFF;background:rgba(255,255,255,.35);box-shadow:0 0 0.77cqw rgba(255,255,255,.4);box-sizing:border-box;opacity:0;animation:foxyEl1Bub 4.4s cubic-bezier(.4,0,.6,1) -4.07s infinite"></span><span style="position:absolute;left:76%;bottom:-4%;width:1.15cqw;height:1.15cqw;border-radius:50%;border:0.38cqw solid #FFFFFF;background:rgba(255,255,255,.35);box-shadow:0 0 0.77cqw rgba(255,255,255,.4);box-sizing:border-box;opacity:0;animation:foxyEl1Bub 5.8s cubic-bezier(.4,0,.6,1) -4.04s infinite"></span><span style="position:absolute;left:84%;bottom:-4%;width:0.77cqw;height:0.77cqw;border-radius:50%;border:0.38cqw solid #FFFFFF;background:rgba(255,255,255,.35);box-shadow:0 0 0.77cqw rgba(255,255,255,.4);box-sizing:border-box;opacity:0;animation:foxyEl1Bub 4.8s cubic-bezier(.4,0,.6,1) -0.49s infinite"></span><span style="position:absolute;left:90%;bottom:-4%;width:0.96cqw;height:0.96cqw;border-radius:50%;border:0.38cqw solid #FFFFFF;background:rgba(255,255,255,.35);box-shadow:0 0 0.77cqw rgba(255,255,255,.4);box-sizing:border-box;opacity:0;animation:foxyEl1Bub 6.2s cubic-bezier(.4,0,.6,1) -1.06s infinite"></span><span style="position:absolute;left:40%;bottom:-4%;width:0.58cqw;height:0.58cqw;border-radius:50%;border:0.38cqw solid #FFFFFF;background:rgba(255,255,255,.35);box-shadow:0 0 0.77cqw rgba(255,255,255,.4);box-sizing:border-box;opacity:0;animation:foxyEl1Bub 3.6s cubic-bezier(.4,0,.6,1) -0.63s infinite"></span><span style="position:absolute;left:56%;bottom:-4%;width:0.77cqw;height:0.77cqw;border-radius:50%;border:0.38cqw solid #FFFFFF;background:rgba(255,255,255,.35);box-shadow:0 0 0.77cqw rgba(255,255,255,.4);box-sizing:border-box;opacity:0;animation:foxyEl1Bub 4.2s cubic-bezier(.4,0,.6,1) -2.56s infinite"></span><span style="position:absolute;left:14%;bottom:-4%;width:0.58cqw;height:0.58cqw;border-radius:50%;border:0.38cqw solid #FFFFFF;background:rgba(255,255,255,.35);box-shadow:0 0 0.77cqw rgba(255,255,255,.4);box-sizing:border-box;opacity:0;animation:foxyEl1Bub 5s cubic-bezier(.4,0,.6,1) -1.0s infinite"></span></div></div><div style="position:absolute;right:7.69cqw;bottom:5.77cqw;display:flex;flex-direction:column;align-items:center;gap:1.54cqw"><svg viewBox="0 0 28 34" style="width:5.96cqw;height:7.31cqw" fill="none" stroke="#EB6A2E" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5v24M8 5h9a5.5 5.5 0 0 1 0 11H8M8 16h10a6.5 6.5 0 0 1 0 13H8M12 1.5v3.5M16.5 1.5v3.5M12 29v3.5M16.5 29v3.5"></path></svg><span style="font-weight:700;font-size:2.5cqw;letter-spacing:.32em;color:#BDBDBD">BEARER</span></div></div>';
  /* The design this phone gives the cards it sets up, written on its own file
   * for each (the card itself does not yet carry one): a card of this phone's
   * is drawn as Foxy's, and a card read at it as a till as Flash's. */
  FC_SETUP_DESIGN = 'FX1';

  /* The design to draw a card in: the one it names, where it names one this
   * build can draw, and FC_DESIGN otherwise. */
  fcDesignOf(card) {
    const code = String((card && card.design) || '').toUpperCase();
    return (/^[A-Z0-9]{3}$/.test(code) && this.FC_DESIGNS[code]) ? code : this.FC_DESIGN;
  }

  /* What has been done with this card, as this phone knows it: the history
   * screen, with only the entries that name it. A card keeps no list of its
   * own, so a payment it made at somebody else's phone is not here. */
  fcHistory() {
    const fc = this.state.fc;
    if (!fc || !fc.key) return;
    this.setState(p => ({ screen: 'history', stack: p.stack.concat([p.screen]), histCard: fc.key, histFilter: 'all' }));
    this.loadHistory();
  }

  /* ---- RESET CARD (software 1.17) --------------------------------------------
   *
   * RESET, the first of the row under the card's screen, for its owner. One warning, then one tap: the money on the card comes off to this
   * phone and the card is reset, in that tap (the wallet's `cardEmptyAndReset`; an empty card is just `cardReset`). A locked
   * card, or one that holds money and has a PIN, asks for the PIN first, on the pad. The card is then another card: it has
   * no owner and no PIN, a key of its own, and nothing this phone knew of the old one is kept, so the screen does not stay
   * on it: Home, with a line. */
  fcReset() {
    const fc = this.state.fc;
    if (!fc) return;
    if (!fc.resetKnown) { this.fcFailed({ card: 'old-card', message: 'This card\u2019s software cannot be reset.' }); return; }
    if (!fc.owner) { this.fcFailed({ card: 'no-owner', message: 'This card has no owner, so there is nothing to reset.' }); return; }
    // a locked card is not asked whether this phone is its owner; its own word is the proof, at the tap
    if (fc.ownedHere === false && !fc.locked) { this.fcFailed({ card: 'not-owner' }); return; }
    // the money comes off at the card's own mint
    if (this.fcAnyMoney(fc) && !this.fcReady('Resetting a card')) return;
    this.blockedCard('fc-reset', {
      tone: 'warn', title: 'RESET CARD',
      reason: 'This takes the card back to how it was in its packet. Its PIN, its owner, its limits and its log are wiped, and it gets a new key. It is then anyone\u2019s to set up.\n\n'
        + (this.fcAnyMoney(fc) ? 'The ' + this.fcWholeWords(fc) + ' on it ' + (/ and /.test(this.fcWholeWords(fc)) ? 'come' : 'comes') + ' off to this phone first.\n\n' : '')
        + 'This cannot be undone.\n\nDo you wish to continue?',
      retry: 'CONTINUE', go: () => this.fcResetGo(),
      shut: { label: 'CANCEL' },
    });
  }

  fcResetGo() {
    const fc = this.state.fc;
    if (!fc) return;
    // the PIN is the card's, for the money to come off and for a locked card; an empty one that is not locked is reset with this phone's proof alone
    if (!(fc.locked || this.fcAnyMoney(fc))) { this.fcResetRun(''); return; }
    this.fcPinOr({
      title: 'CARD PIN',
      subtitle: this.fcAnyMoney(fc) ? 'To take ' + this.fcWholeWords(fc) + ' off the card and reset it.' : 'To reset the card. It is locked.',
      cta: 'RESET CARD',
    }, (pin) => this.fcResetRun(pin));
  }

  fcResetRun(pin) {
    const W = this.fcW();
    const fc = this.state.fc;
    if (!W || !fc) return;
    const money = this.fcAnyMoney(fc);
    this.fcTap({ amount: money ? this.fcWholeStage(fc) : '', warm: money },
      (link, on, progress) => {
        // the card is held through the money coming off and the reset: the steps that say it may go are not said
        const held = (step, info) => { if (step !== 'done' && step !== 'checking') on(step, info); };
        on('resetting');
        return W.cardEmptyAndReset(link, { pin: pin || undefined, on: held, progress });
      })
      .then((r) => {
        if (r && r.hash) this.txIsNew(r.hash);
        if (r && r.withdrew > 0) this.fcMoved({});
        // the card on show is not that card any more
        this._fcCard = null;
        this.setState({ fc: null, screen: 'home', stack: [], flow: 'receive', amount: '', unit: 'USD' });
        this.haptic && this.haptic('success');
        this.toast('The card is reset.');
      }, (e) => {
        /* The money came off and the reset did not: the card is empty and this phone has the money. The next tap finishes it. */
        if (e && e.withdrew > 0) {
          if (e.hash) this.txIsNew(e.hash);
          this.fcMoved({});
          if (this.state.fc) this.setState({ fc: Object.assign({}, this.state.fc, { balance: 0, count: 0 }, this.state.fc.bal ? { bal: { usd: 0, sat: 0 } } : {}) });
          this.haptic && this.haptic('warning');
          // (in the currency it came off in, and a card of both its other apart: `e.unit`, `e.also`)
          const came = [this.fcBoth(e.withdrew, e.unit === 'usd' ? 'usd' : 'sat')].concat((Array.isArray(e.also) ? e.also : []).filter((x) => x && this.fcAmt(x) > 0)
            .map((x) => this.fcBoth(this.fcAmt(x), x.unit === 'usd' ? 'usd' : 'sat'))).join(' and ');
          this.blockedCard('fc-reset-part', {
            tone: 'warn', title: 'EMPTY, BUT NOT RESET',
            reason: came + ' came off the card into this phone. The card is not reset yet: tap it again to finish.',
            chip: 'Hold it still until the phone says to remove it.',
            retry: 'TAP CARD', go: () => this.fcResetGo(), shut: { label: 'LATER' },
          });
          return;
        }
        this.fcFailed(e, { resetting: true, again: () => this.fcResetGo() });
      });
  }

  /* ---- FLASHCARD on the send screen -----------------------------------------------
   *
   * Money onto a card held to this phone, any card: the amount first (the keypad every amount is typed on), and NEXT brings
   * the sheet up at once. A card with no PIN takes the money in that tap. A card with a PIN ends the sheet asking for it,
   * nothing made yet: the pad comes up, and TAP AGAIN writes it, as a till writes change (the non-owner path of ADD FUNDS,
   * reached from here with no card on show). The pieces are made in the tap, once the card is read, for that card's key.
   * A tap that fails after they were made leaves them owed to the card, and the way to finish is the same as for any money
   * owed (`fcWriteRun`, `fcWriteAsk`). */
  fcSendCard() {
    if (!this.fcW()) return;
    if (this.offlineNow()) { this.offlineNo('Putting money on a card'); return; }
    this.fcAmount('cardSend');
  }

  fcSendAsk(sats, unit, alt) {
    // the pad before any tap (`fcSendPinFirst`) says TAP CARD; asked by the card after a tap, it says TAP AGAIN
    const tapped = !!(this._fcTaps > 0) || this._fcSendTapped === true;
    this._fcSendTapped = false;
    this.fcAskPin({
      title: 'CARD PIN',
      subtitle: 'To put ' + this.fcBoth(sats, unit) + ' on the card.',
      cta: tapped ? 'TAP AGAIN' : 'TAP CARD',
    }, (pin) => this.fcSendRun(sats, pin, unit, alt));
  }

  /* Whether SEND > FLASHCARD from home asks the card's PIN before the card is asked for: only where the card is known to want it, a
   * card of 1.21 or later (`pinFirst`) with a PIN. Known from the last card read in this run (the wallet's `cardLastRead`) where that
   * is a card of this phone's own (on file) or the card on screen: the card most likely to be held to it. Otherwise from the cards on
   * file that say what they were when last read (`pinFirst`, written by the wallet's `cardRemember`): every one of those 1.21 or
   * later, and at least one. Otherwise the card is read first, as before. A card with no PIN (software before 1.21, a new card, or
   * one with none set) was asked for one it has not got, and the PIN typed was dropped; typed ahead for a card that is not the one
   * tapped (the last card a till read was a customer's), it could cost that card a try. */
  fcSendPinFirst() {
    const W = this.fcW();
    const known = /** @type {any} */ ((W && W.cardsKnown) ? W.cardsKnown() : null) || {};
    const last = (W && W.cardLastRead) ? W.cardLastRead() : null;
    const fc = this.state.fc;
    const likely = !!(last && last.info && last.key) && (Object.prototype.hasOwnProperty.call(known, last.key) || !!(fc && fc.key === last.key));
    if (likely) return last.info.pinFirst === true && last.info.pinSet !== false;
    const said = Object.keys(known).map((k) => known[k]).filter((r) => r && typeof r.pinFirst === 'boolean');
    return said.length > 0 && said.every((r) => r.pinFirst === true);
  }

  /* `unit`: the balance the money comes from ('usd' from this phone's dollars), which the card held to the phone must hold:
   * the wallet refuses one of the other kind before anything is made for it (`cardPrepare`, `wrong-unit`). `alt`: typed in
   * dollars, what a bitcoin card is loaded with instead ({ sats, have }: the sats at this phone's price, and its bitcoin);
   * a dollar card typed in sats is refused as ever. */
  /* `fig`: { usd, sat }, where the send was not started in either balance (unit ''): the figure in each, and the currency is chosen
   * once the card is read (`fcSendUnit`). */
  fcSendRun(sats, pin, unit, alt, fig) {
    const W = this.fcW();
    if (!W) return;
    let made = null;
    const typedUsd = this.state.unit !== 'SATS';
    // the dollars typed, exactly, for a dollar card at another mint (`fcXlSend`), whatever balance the figure was sent in
    const cents = (typedUsd && this.state.screen === 'amount' && this.centsTyped) ? this.centsTyped() : 0;
    let away = null;
    this.fcTap({ amount: unit ? this.stageMoney(sats, unit) : typedUsd ? this.stageMoney(fig.usd, 'usd') : this.stageMoney(fig.sat, 'sat'), warm: true },
      (link, on) => {
        on('mint');
        return W.cardLook(link, { short: true }).then((card) => {
          // the card has been tapped for this send: a PIN asked after this says TAP AGAIN (`fcSendAsk`)
          this._fcSendTapped = true;
          /* A new card, with no PIN and no owner, of software 1.22: the first phone that sends it money sets it up for its holder
           * (`fcSendSetUp`). The sheet ends calmly, nothing made, and the set-up's steps come up. */
          // (a new card of 1.21 takes no money with no owner: its holder sets it up on a Foxy of their own first)
          if (!card.info.setUp && !card.info.pinSet && !card.info.owner && card.info.pinFirst && !card.info.guests) {
            const o = /** @type {any} */ (new Error('This card is new, and its software cannot be set up on somebody else\u2019s phone. Its holder sets it up on their own Foxy first.'));
            o.card = 'old-card';
            throw o;
          }
          /* And a set-up cut short (1.22): a card with a PIN and no record yet, which any phone takes up again, or one this phone began
           * for its holder and did not finish (`forHolder`: its record written, the holder's two numbers perhaps not), while it is
           * empty. Its steps come up again; where the card has its record, its PIN is the holder's already and is asked once. */
          const empty = !(card.info.unspent > 0) && !card.info.changeDue;
          const cut = !!card.info.guests && !card.info.owner && !card.info.locked && !!card.info.pinSet && empty
            && (!card.info.hasRecord || (!!card.forHolder && card.info.pin !== 'blocked'));
          if ((!card.info.setUp && !card.info.pinSet && !card.info.owner && card.info.guests && !card.info.locked) || cut) {
            const n = /** @type {any} */ (new Error('The card is new.'));
            n.card = 'needs-set-up';
            n.sheetText = cut ? 'Finish setting up the card' : 'Set up the card first';
            // (and its key, for the name typed for it on NAME CARD, 26j-card-wheel.js `fcNameSettle`)
            n.info = Object.assign({}, card.info, { keepPin: cut && !!card.info.hasRecord, key: card.key });
            throw n;
          }
          /* A card whose money is at another mint than this phone's: loaded there, online, from this phone's balance (`fcXlBegin`), with
           * what it costs shown first. Nothing is made here, and the sheet ends calmly. */
          if (this.fcXlAway(card)) {
            away = card;
            const xa = /** @type {any} */ (new Error('This card’s money is at another mint.'));
            xa.card = 'xl-away';
            xa.sheetText = 'Card read';
            throw xa;
          }
          /* Not started in a currency: the card's own (one currency), or, for a card that takes both, the one of this phone's that can
           * pay, or the question which where both can: the sheet ends calmly, nothing made, and the CURRENCY screen asks. */
          if (!unit && fig) {
            const pick = this.fcSendUnit(card, fig);
            if (pick.ask) {
              const q = /** @type {any} */ (new Error('Which currency to send.'));
              q.card = 'choose-unit';
              q.sheetText = 'Choose a currency';
              q.pinSet = !!card.info.pinSet;
              throw q;
            }
            unit = pick.unit;
            sats = fig[unit];
            alt = null;
          }
          // a card set up for the other currency alone is refused before anything is made for it (its PIN may have been typed ahead of the read)
          if (unit) this.fcSendGuard(card, unit, alt);
          // a PIN typed before the read (`fcSendPinFirst`), for a card that turns out to have none: not sent to it
          if (pin && !card.info.pinSet) pin = '';
          // a card that has a PIN is asked for it before any money is made for it: the sheet ends saying so
          if (card.info.pinSet && !pin) {
            const x = /** @type {any} */ (new Error('The card wants its PIN first.'));
            x.card = 'pin-needed';
            x.sheetText = 'Enter the card\u2019s PIN';
            throw x;
          }
          return this.fcSendPrepare(card, sats, unit, alt);
        }).then((m) => {
          made = m;
          // said by this flow, so not announced as a payment sent (16-history-lists.js)
          if (m && m.hash) this.txIsNew(m.hash);
          on('writing');
          return W.cardWrite(link, { pin: pin || undefined });
        });
      })
      .then((r) => {
        // the money is on the card: the person is home, and the card says so
        this.setState({ screen: 'home', stack: [], flow: 'receive', amount: '', unit: 'USD' });
        this.fcWrote(r, { rounded: Number(made && made.rounded) || 0 });
      }, (e) => {
        if (e && e.card === 'xl-away' && !made && away) { this.fcXlSend(away, pin, sats, unit, alt, fig, typedUsd, cents); return; }
        if (e && e.card === 'choose-unit' && !made && fig) {
          this.fcPickUnit({ question: 'SEND WHICH TO THE CARD?', foot: 'This card holds dollars and bitcoin. You are asked when both could pay.',
                            short: { usd: fig.usd > this.fcHave('usd') ? 'NOT ENOUGH' : '', sat: fig.sat > this.fcHave('sat') ? 'NOT ENOUGH' : '' },
                            why: 'This phone does not hold that much of it.' },
                          (u) => { if (e.pinSet) this.fcSendAsk(fig[u], u, null); else this.fcSendRun(fig[u], '', u, null); });
          return;
        }
        // (not started in a currency, and decided by the card: what is asked again is in the one decided)
        if (e && e.card === 'pin-needed' && !pin && !made) { this.fcSendAsk(sats, unit || 'sat', alt); return; }
        /* (WELCOME TO YOUR CASHU CARD first, the one way into any card's set-up, 26j-card-wheel.js `fcWelcomeSend`: its SET UP CARD is
         * the set-up for the holder, with what is being sent) */
        if (e && e.card === 'needs-set-up' && !made) {
          // (a new card, not started in a currency: the one typed in, where this phone holds it)
          if (!unit && fig) { const u = typedUsd && fig.usd > 0 && fig.usd <= this.fcHave('usd') ? 'usd' : 'sat'; this.fcWelcomeSend(fig[u], u, null, e.info); return; }
          this.fcWelcomeSend(sats, unit, alt, e.info);
          return;
        }
        if (made) {
          // the pieces exist and are owed to that card; they go on at its next tap
          this.refreshBalance();
          this.loadHistory();
          if (e && (e.card === 'cancelled' || e.card === 'gone')) {
            this.setState({ screen: 'home', stack: [], flow: 'receive', amount: '', unit: 'USD' });
            this.fcStillWaiting({ noPin: !pin });
            return;
          }
          this.fcFailed(e, { again: () => ((e && e.card === 'wrong-pin') ? this.fcWriteAsk({}) : this.fcWriteRun(pin || '', {})) });
          return;
        }
        this.fcFailed(e, { again: () => (pin ? this.fcSendAsk(sats, unit || 'sat', alt) : this.fcSendRun(sats, '', unit, alt, fig)) });
      });
  }

  // what this phone holds to send in `unit`: cents of its dollars, or its sats
  fcHave(unit) {
    return unit === 'usd' ? Math.max(0, Math.round(Number(this.state.balUsdCents) || 0)) : Math.floor((this.balNow() && this.balNow().sats) || 0);
  }

  /* A card of 1.23 its owner set up on this phone to hold one currency (`cardHold`) takes that one alone from here: the other is refused
   * before anything is made, and before its PIN is asked, in the wallet's words for a card of the other kind. A bitcoin card typed in
   * dollars is loaded with their sats (`alt`). A card set up for both, or holding both, is never refused here: it takes either. */
  fcSendGuard(card, unit, alt) {
    const W = this.fcW();
    const only = (W && W.cardHold && W.cardHold(card)) || '';
    const from = unit === 'usd' ? 'usd' : 'sat';
    if ((only === 'usd' || only === 'sat') && from !== only && !(only === 'sat' && alt)) {
      const wu = /** @type {any} */ (new Error('This card holds ' + (only === 'usd' ? 'dollars' : 'bitcoin') + ', so it is loaded from your '
        + (only === 'usd' ? 'dollars' : 'bitcoin') + '.'));
      wu.card = 'wrong-unit';
      wu.cardUnit = only;
      throw wu;
    }
  }

  /* SEND > FLASHCARD not started in a currency (`fig`: the figure in each): which the card read takes it in. A card of software 1.23 that
   * takes both (its owner set it up here for both, or it holds both or may: `cardHold`, `cardUnits`) is sent the one of this phone's
   * balances that covers the figure, or asks which (`ask`) where both do; any other card its own currency, as it always was (a one-currency
   * card of 1.23 its owner set up here: that one). Where nothing covers it, the currency that came nearest, and the wallet says it is short. */
  fcSendUnit(card, fig) {
    const W = this.fcW();
    const hold = (W && W.cardHold && W.cardHold(card)) || '';
    const both = this.fcTakesBoth(card);
    const own = (hold === 'usd' || hold === 'sat') ? hold : (card && card.record && card.record.unit === 'usd') ? 'usd' : 'sat';
    if (!both) return { unit: own };
    const covers = ['usd', 'sat'].filter((u) => fig[u] > 0 && fig[u] <= this.fcHave(u));
    if (covers.length === 2) return { ask: true };
    if (covers.length === 1) return { unit: covers[0] };
    return { unit: this.state.unit === 'SATS' ? 'sat' : (fig.usd > 0 ? 'usd' : 'sat') };
  }

  // whether the card read takes both currencies: a card of 1.23 set up for both, or holding both or able to (`cardHold`, `cardUnits`, `cardBoth`)
  fcTakesBoth(card) {
    const W = this.fcW();
    const hold = (W && W.cardHold && W.cardHold(card)) || '';
    const cu = (W && W.cardUnits && W.cardUnits(card)) || null;
    const v123 = !!(card && card.info && card.info.units);
    return v123 && hold !== 'usd' && hold !== 'sat' && (hold === 'both' || !!(cu && cu.length === 2) || !!(W && W.cardBoth && W.cardBoth(card)));
  }

  /* The pieces for the card held to the phone, in its unit (`fcSendRun`). Typed in dollars, a bitcoin card is loaded with the sats
   * those dollars are at this phone's price, from this phone's bitcoin (`alt`). */
  fcSendPrepare(card, sats, unit, alt) {
    const W = this.fcW();
    this.fcSendGuard(card, unit, alt);
    /* A card of software 1.23 takes the currency sent where it holds it already, or where it is its record's: dollars onto its dollars,
     * as they are (a new currency on it is its holder's to start, and a phone that is not its owner would be refused). */
    const cu = W.cardUnits ? W.cardUnits(card) : null;
    if (cu && (unit === 'usd' || unit === 'sat') && cu.some((x) => x.unit === unit)) return W.cardPrepare(card, sats, { unit });
    const holdsUsd = !!(card.record && card.record.unit === 'usd');
    if (unit === 'usd' && !holdsUsd && alt) {
      // a bitcoin card, typed in dollars: its sats, from this phone's bitcoin, checked as the keypad checks them
      if (!(alt.sats > 0)) {
        const np = /** @type {any} */ (new Error('This phone has no Bitcoin price to load the card at. Type the amount in sats.'));
        np.card = 'wrong-unit';
        throw np;
      }
      if (alt.sats > alt.have) {
        const short = /** @type {any} */ (new Error('You have ' + this.fcBoth(alt.have) + '.'));
        short.card = 'bad-amount';
        throw short;
      }
      return W.cardPrepare(card, alt.sats);
    }
    return W.cardPrepare(card, sats, unit ? { unit } : undefined);
  }

  /* ---- a card at another mint, loaded from this phone ---------------------------------------------------------------
   *
   * SEND > FLASHCARD (home) and ADD FUNDS (the card's screen) for a card whose money is at another mint than this phone's. Its money
   * stays where it is: this phone's money goes there by Lightning and is made into pieces for the card at the card's mint (the wallet's
   * `cardLoadQuote`, `cardLoadAcross`, 08a-flashcard.js). The card is read once (SEND's tap, or the card on screen), and then:
   *
   *   the confirmation (`fcXlSpec`)  what goes on the card, the most that leaves this phone, the fee and the two mints, asked of both
   *                                  mints before anything moves; where this phone cannot cover it, said, with the button greyed;
   *   PUT ... ON CARD                the card's PIN, where it wants one and it was not typed before the read (SEND asks it first on a
   *                                  card of 1.21 and on, `fcSendPinFirst`); the owner's own proof on its screen where the card
   *                                  takes it (`fcAddPin`'s rule); then the crossing, with this phone visiting the card's mint for
   *                                  the claim and the pieces (`cardVisit`), and one tap that writes them under the PIN;
   *   home                           this phone goes home after the tap, whatever it did (`fcXmHome`); SEND ends at Home, ADD FUNDS
   *                                  on the card's screen.
   *
   * This phone pays every fee, as it pays a move between its own mints. A tap that does not take the pieces leaves them owed to the
   * card and written at its next tap, from any mint (`_fcXmAt`). A melt not answered is held as any is, and the sweeps settle it. Offline
   * nothing is asked of anybody: between two mints, the connection is needed. */
  fcXlAway(card) {
    const W = this.fcW();
    const at = card && card.record && card.record.mint;
    return !!(W && at && card.info && card.info.setUp && W.mintUrl && this.fcMintKey(at) !== this.fcMintKey(W.mintUrl));
  }

  fcXlOffline() {
    this.haptic && this.haptic('error');
    this.blockedCard('fc-xm-offline', { tone: 'warn', title: 'A DIFFERENT MINT', reason: 'Putting money on a card at another mint needs the connection.' });
  }

  /* The unit the card is loaded in: the one a card of 1.23 its owner set up to hold alone, the one typed where it takes that one, and
   * otherwise its own. */
  fcXlUnit(card, typed) {
    const W = this.fcW();
    const hold = (W && W.cardHold && W.cardHold(card)) || '';
    if (hold === 'usd' || hold === 'sat') return hold;
    const cu = (W && W.cardUnits && W.cardUnits(card)) || null;
    if (cu && (typed === 'usd' || typed === 'sat') && cu.some((x) => x.unit === typed)) return typed;
    return (card && card.record && card.record.unit === 'usd') ? 'usd' : 'sat';
  }

  /* SEND > FLASHCARD's tap found the card at another mint (`fcSendRun`): the figure typed, in the card's unit, and the balance of this
   * phone's that pays. A dollar card is loaded with the dollars typed (a figure typed in sats is not a dollar amount: said, and nothing
   * is asked); a bitcoin card with the sats typed, or with the sats the dollars typed are at this phone's price, as at its own mint. */
  /* A card of both, the send not started in a currency (`fig`): which goes on the card is asked first, as at its own mint (`chosen`), with
   * nothing greyed: either of this phone's balances pays for it there, and which is the confirmation's to settle (`fcXlQuote`). */
  fcXlSend(card, pin, sats, unit, alt, fig, typedUsd, cents, chosen) {
    if (fig && !unit && !chosen && this.fcTakesBoth(card)) {
      this.fcPickUnit({ question: 'SEND WHICH TO THE CARD?', foot: 'This card holds dollars and bitcoin. Either of this phone’s balances can pay for it.',
                        short: { usd: '', sat: '' } },
                      (u) => this.fcXlSend(card, pin, sats, unit, alt, fig, typedUsd, cents, u));
      return;
    }
    const typed = chosen || unit || (typedUsd ? 'usd' : 'sat');
    const cu = (chosen === 'usd' || chosen === 'sat') ? chosen : this.fcXlUnit(card, typed);
    let amount = 0;
    let pay = unit === 'usd' ? 'usd' : 'sat';
    if (cu === 'usd') {
      if (!fig && !typedUsd) {
        this.haptic && this.haptic('error');
        this.blockedCard('fc-xl-unit', { tone: 'warn', title: 'A DOLLAR CARD', reason: 'This card holds dollars. Type the amount in dollars.' });
        return;
      }
      amount = fig ? fig.usd : unit === 'usd' ? sats : cents;
      if (fig) pay = (this.twoUnitsOn && this.twoUnitsOn() && fig.usd > 0 && fig.usd <= this.fcHave('usd')) ? 'usd' : 'sat';
    } else {
      if (fig) {
        amount = fig.sat;
        pay = (fig.sat > this.fcHave('sat') && fig.usd > 0 && fig.usd <= this.fcHave('usd')) ? 'usd' : 'sat';
      } else if (unit === 'usd') {
        amount = alt ? Math.round(Number(alt.sats) || 0) : 0;
        if (!(amount > 0)) {
          this.fcFailed({ card: 'wrong-unit', message: 'This phone has no Bitcoin price to load the card at. Type the amount in sats.' });
          return;
        }
      } else amount = sats;
    }
    if (!(amount > 0)) { this.toast('Type an amount first.', true); return; }
    // (a send started in one of this phone's balances pays from it: not asked again, though the other pays where it cannot, `fcXlQuote`)
    this.fcXlBegin({ from: 'send', card, pin: (card.info && card.info.pinSet) ? String(pin || '') : '', cardUnit: cu, payUnit: pay, amount, payFixed: !!unit && !fig });
  }

  /* ADD FUNDS on the screen of a card at another mint: the amount typed is in the card's unit (`fcUnit`), and this phone pays from its
   * dollars where it loads dollars and holds some at a mint with two balances, from its bitcoin otherwise: first asked, and the other
   * asked too where this phone has two balances, so that one that cannot pay gives way to one that can, and where both can the person
   * is asked which (`fcXlQuote`). */
  fcXlAdd(amount) {
    const card = this._fcCard;
    const fc = this.state.fc;
    if (!card || !fc) return;
    const cu = fc.v123 ? this.fcUnit() : (card.record && card.record.unit === 'usd') ? 'usd' : 'sat';
    const pay = (cu === 'usd' && this.twoUnitsOn && this.twoUnitsOn() && this.fcHave('usd') > 0) ? 'usd' : 'sat';
    this.fcXlBegin({ from: 'add', card, pin: '', cardUnit: cu, payUnit: pay, amount });
  }

  fcXlBegin(o) {
    const W = this.fcW();
    if (!W || !o || !o.card) return;
    if (this.offlineNow() || (W.cardOnline && !W.cardOnline())) { this.fcXlOffline(); return; }
    const card = o.card;
    const x = {
      from: o.from === 'add' ? 'add' : 'send', mint: this.fcMintKey(card.record.mint), home: this.fcMintKey(W.mintUrl),
      key: String(card.key || ''), cardUnit: o.cardUnit === 'usd' ? 'usd' : 'sat', payUnit: o.payUnit === 'usd' ? 'usd' : 'sat',
      amount: Math.round(Number(o.amount) || 0), pinSet: !!(card.info && card.info.pinSet), pin: String(o.pin || ''),
      plan: null, err: '', short: false, busy: false, payFixed: !!o.payFixed,
    };
    // the card as read, in memory only: its pieces are cut at its mint from it, and made for it there (`cardLoadQuote`, `cardPrepare`)
    this._fcXlCard = card;
    console.log('[foxy] card: its money is at ' + x.mint + '; this phone at ' + x.home + ' puts money on it there');
    this.fcXlOpen(x);
  }

  // the confirmation for `x`, its figures asked of both mints afresh
  fcXlOpen(x) {
    const fresh = Object.assign({}, x, { plan: null, err: '', short: false, busy: false });
    if (this.state.screen === 'fcXlConfirm') this.setState({ fcXl: fresh });
    else this.setState(p => ({ screen: 'fcXlConfirm', stack: p.stack.concat([p.screen]), fcXl: fresh }));
    this.fcXlQuote();
  }

  /* What it costs, asked of both mints with this phone at its own: the card's mint's invoice for the amount (a mint quote, which commits
   * to nothing), and this phone's mint's melt quote for it. A refusal that is the card's (no owner, full, its mint's keys) is said as the
   * card's, off the confirmation; a mint that did not answer, on it, with TRY AGAIN. */
  fcXlQuote() {
    const W = this.fcW();
    const x0 = this.state.fcXl;
    if (!W || !x0) return;
    const run = (this._fcXlRun = (this._fcXlRun || 0) + 1);
    const live = () => run === this._fcXlRun && !!this.state.fcXl && this.state.fcXl.key === x0.key;
    const put = (more) => { if (live()) this.setState({ fcXl: Object.assign({}, this.state.fcXl, more) }); };
    put({ plan: null, err: '', short: false });
    const show = (plan) => put({ plan, payUnit: plan.payUnit === 'usd' ? 'usd' : 'sat', short: !!plan.short,
                                 err: plan.short ? String(plan.why || 'This phone does not hold enough for that.') : '' });
    Promise.resolve().then(() => W.cardLoadQuote(x0.mint, x0.amount, { cardUnit: x0.cardUnit, payUnit: x0.payUnit, card: this._fcXlCard || undefined })).then((plan) => {
      if (!live()) return;
      /* This phone's other balance, where it has two and holds some of the other: the same invoice quoted from it. One that cannot pay
       * gives way to one that can (never a greyed button while the other could pay); where both can, the person is asked which, the
       * same question as a payment's (`fcPickUnit`), unless the send was started in one (`payFixed`). */
      const other = plan.payUnit === 'usd' ? 'sat' : 'usd';
      if (!(this.twoUnitsOn && this.twoUnitsOn()) || !(this.fcHave(other) > 0) || !W.cardLoadRepay) { show(plan); return; }
      return W.cardLoadRepay(plan, other).then((alt) => {
        if (!live()) return;
        if (plan.short && !alt.short) {
          const word = (u) => (u === 'usd' ? 'dollars' : 'bitcoin');
          console.log('[foxy] card: this phone\u2019s ' + word(plan.payUnit) + ' cannot cover the load at another mint; its ' + word(other) + ' pays it');
          show(alt);
          return;
        }
        if (plan.short || alt.short || x0.payFixed) { show(plan); return; }
        show(plan);
        this.fcPickUnit({ question: 'PAY FROM WHICH?', foot: 'Either of this phone’s balances can pay for this. You are asked when both could pay.',
                          bal: { usd: this.fcHave('usd'), sat: this.fcHave('sat') }, short: { usd: '', sat: '' } },
                        (u) => {
                          if (!live()) return;
                          show(u === plan.payUnit ? plan : alt);
                          // chosen: a quote asked again before the load (`fcXlGo`) keeps it, and does not ask again
                          put({ payFixed: true });
                        });
      }, (e2) => {
        console.warn('[foxy] card: the other balance could not be quoted for the load:', (e2 && e2.message) || e2);
        show(plan);
      });
    }).then(null, (e) => {
      if (!live()) return;
      if (e && e.card) {
        this.setState(p => ({ fcXl: null, screen: p.stack.length ? p.stack[p.stack.length - 1] : 'home', stack: p.stack.slice(0, -1) }));
        this.fcFailed(e, {});
        return;
      }
      put({ err: 'Foxy could not find out what this costs: ' + String((W.reason ? W.reason(e) : (e && e.message)) || 'a mint did not answer').replace(/\.?$/, '.') });
    });
  }

  /* The confirmation (confirmSpec), dollars first: what goes on the card, the most that leaves this phone (`total`) with the fee in it
   * (`fee`: the Lightning reserve, this mint's fee on what it melts and the card's mint's on the pieces it makes), and the two mints. */
  fcXlSpec() {
    const x = this.state.fcXl || { amount: 0, cardUnit: 'sat', payUnit: 'sat', mint: '', home: '' };
    const cu = x.cardUnit === 'usd' ? 'usd' : 'sat';
    const pu = x.payUnit === 'usd' ? 'usd' : 'sat';
    /* (the design: dollars first and the sats under them, the sats the main figure where this phone has no price; a dollar figure's
     * sats are at the market price) */
    const rate = (this.satUsd && this.satUsd()) || 0;
    const fig = (n, unit) => (unit === 'usd' ? { main: this.fcSats(n, 'usd'), sub: rate ? '\u20bf ' + this.group(Math.round(n / 100 / rate)) : '' } : this.money(n));
    // (the figure YOU PAY has its sats under it in brackets, "(₿ 126)": the confirmation shell's own)
    const p = x.plan;
    const known = !!p;
    // what the card will get: the pieces as cut at its mint (`plan.land`), which can differ from the amount typed
    const on = fig(this.fcXlLand(x), cu);
    const rows = [
      this.cfRow('ON THE CARD', on.main, { sub: on.sub }),
      this.cfRow('FEE, PAID BY YOU', x.err && !known ? 'UNKNOWN' : known ? 'UP TO ' + fig(p.fee, pu).main : 'CHECKING…',
                 { sub: known ? fig(p.fee, pu).sub : '', ink: 'var(--btc-ink)' }),
      this.cfRow('CARD’S MINT', String(this.mintNameOf(x.mint) || '').toUpperCase(), { half: true }),
      this.cfRow('YOUR MINT', String(this.mintNameOf(x.home) || '').toUpperCase(), { half: true }),
    ];
    const subtitle = 'This card is at another mint. Your money goes there by Lightning, and you pay the fee.';
    const cta = 'PUT ' + on.main + ' ON CARD';
    const head = { title: 'CARD AT DIFFERENT MINT', amountLabel: 'YOU PAY', rows, subtitle };
    // this phone cannot cover it: said, with the button greyed; asking again cannot change it, and the way out is the round back button
    if (known && x.short) {
      return Object.assign(head, { amount: 'UP TO ' + fig(p.total, pu).main, amountSub: fig(p.total, pu).sub, amountInk: '#FF5C5C',
                                   warn: x.err, cta, ctaTone: 'go', ctaBusy: true, go: () => {} });
    }
    if (x.err) {
      return Object.assign(head, { amount: on.main + ' + fee', amountSub: '', amountInk: '#FF5C5C', warn: x.err, cta: 'TRY AGAIN', ctaTone: 'warn',
                                   go: () => this.fcXlQuote() });
    }
    return Object.assign(head, {
      amount: known ? 'UP TO ' + fig(p.total, pu).main : on.main + ' + fee', amountSub: known ? fig(p.total, pu).sub : '',
      cta: x.busy ? 'PUTTING IT ON…' : known ? cta : 'CHECKING THE FEE…', ctaTone: 'go', ctaBusy: !known || !!x.busy,
      go: () => { if (known && !x.busy) this.fcXlGo(); },
    });
  }

  // what goes on the card: the plan's pieces as cut (`land`) once it is known, the amount typed before
  fcXlLand(x) {
    const land = Math.round(Number(x && x.plan && x.plan.land) || 0);
    return land > 0 ? land : Math.round(Number(x && x.amount) || 0);
  }

  /* PUT ... ON CARD: the PIN where the card wants one and none was typed (on its own screen, its owner's proof where the card takes it,
   * as ADD FUNDS at its own mint), then the load. A quote that has gone stale is asked again first, so the fee shown is the one paid. */
  fcXlGo() {
    const W = this.fcW();
    const x = this.state.fcXl;
    if (!W || !x || !x.plan || x.short || x.busy) return;
    if (this.offlineNow() || (W.cardOnline && !W.cardOnline())) { this.fcXlOffline(); return; }
    if (!this.fcQuoteFresh(x.plan.melt) || Date.now() - Number(x.plan.at || 0) > 60000) { this.fcXlOpen(x); return; }
    const fc = this.state.fc;
    const land = this.fcXlLand(x);
    const price = this.fcPrice(land, x.cardUnit);
    if (x.from === 'add' && fc && fc.key === x.key && fc.ownedHere && !this.fcCardPinFirst()) { this.fcXlRun(x, '', true); return; }
    if (!x.pinSet || x.pin) { this.fcXlRun(x, x.pin, false); return; }
    this.fcAskPin({ title: 'CARD PIN', subtitle: 'To put ' + this.fcBoth(land, x.cardUnit) + ' on the card.', cta: 'PUT ' + price + ' ON CARD' },
                  (pin) => this.fcXlRun(x, pin, false));
  }

  /* The load: off the confirmation to where the flow ends (Home for SEND, the card's screen for ADD FUNDS), the crossing with a screen
   * saying so, and then the one tap. */
  fcXlRun(x, pin, owner) {
    const W = this.fcW();
    const card = this._fcXlCard;
    if (!W || !card || card.key !== x.key) return;
    if (this.state.fcXl) this.setState({ fcXl: Object.assign({}, this.state.fcXl, { busy: true }) });
    const plan = x.plan;
    const to = this.mintNameOf(x.mint);
    // what this writes to the history is this flow's to say: none of it is announced as a payment (16-history-lists.js)
    if (plan.mintQuote && plan.mintQuote.quote) this.txIsNew(String(plan.mintQuote.quote));
    if (plan.melt && plan.melt.quote && plan.melt.quote.quote) this.txIsNew(String(plan.melt.quote.quote));
    this.setState(x.from === 'add'
      ? (p) => { const i = p.stack.lastIndexOf('flashcard'); return { fcXl: null, screen: 'flashcard', stack: i >= 0 ? p.stack.slice(0, i) : ['home'], flow: 'receive', amount: '', unit: 'USD' }; }
      : { fcXl: null, screen: 'home', stack: [], flow: 'receive', amount: '', unit: 'USD' });
    // the pieces it leaves owed to the card at its mint go on from any mint this phone is at (`fcWriteAsk`)
    this._fcXmAt = Object.assign({}, this._fcXmAt || {}, { [x.mint]: true });
    if (this.showMelt) this.showMelt('Moving ' + this.fcPrice(this.fcXlLand(x), x.cardUnit) + ' to ' + to + '…', 0, { mint: to });
    Promise.resolve().then(() => W.cardLoadAcross(plan, card, () => {})).then((done) => {
      if (this.hideMelt) this.hideMelt();
      const made = done.made;
      if (done.paid && done.paid.hash) this.txIsNew(String(done.paid.hash));
      if (made && made.hash) this.txIsNew(String(made.hash));
      // the visit stays open for the tap, and `fcXmHome` ends it
      this._fcXmVisit = done.visit;
      this.refreshBalance();
      this.loadHistory();
      this.fcXlWrite(x, made, pin, owner);
    }, (e) => this.fcXlFailed(x, e));
  }

  // the one tap: the pieces made at the card's mint, written under its PIN (or its owner's proof), and home after
  fcXlWrite(x, made, pin, owner) {
    const W = this.fcW();
    const cu = x.cardUnit;
    const how = owner ? { owner: true } : { pin: pin || undefined };
    this.fcTap({ amount: this.stageMoney(this.fcAmt(made), cu) }, (link, on, progress) => { on('writing'); return W.cardWrite(link, Object.assign({ progress }, how)); })
      .then((r) => {
        this.fcXmHome();
        this.fcWrote(r, { rounded: Number(made && made.rounded) || 0, unit: cu });
      }, (e) => {
        // the pieces exist and are owed to that card; they go on at its next tap, from any mint
        this.fcXmHome();
        this.refreshBalance();
        this.loadHistory();
        if (e && (e.card === 'cancelled' || e.card === 'gone')) { this.fcStillWaiting({ noPin: !x.pinSet, unit: cu }); return; }
        this.fcFailed(e, { again: () => ((e && e.card === 'wrong-pin') ? this.fcWriteAsk({ unit: cu }) : this.fcWriteRun(pin || '', owner ? { owner: true, unit: cu } : { unit: cu })) });
      });
  }

  /* The load did not get as far as the card. Where the money is is said: still here (refused, nothing taken), on its way (the melt not
   * answered: held, and settled by the sweeps), or this phone's at the card's mint (paid, and not made into pieces for the card). */
  fcXlFailed(x, e) {
    const W = this.fcW();
    if (this.hideMelt) this.hideMelt();
    this.refreshBalance();
    this.loadHistory();
    const to = this.mintNameOf(x.mint);
    const said = String((e ? (W && W.reason ? W.reason(e) : e.message) : '') || 'That did not work.').trim().replace(/\.?$/, '.');
    console.log('[foxy] card: the load at ' + x.mint + ' did not reach the card — ' + said);
    this.haptic && this.haptic('error');
    /* (a payment that failed with its melt still held is on its way as much as one not answered: `cardLoadAcross` passes the error
     * on, and the wallet keeps the melt until the mint says either way) */
    const held = !!(x && x.plan && x.plan.invoice && W && W.pendingMelts
      && W.pendingMelts().some((m) => m && m.bolt11 && String(m.bolt11).toLowerCase() === String(x.plan.invoice).toLowerCase()));
    if (e && (e.pending || (held && !e.movePaid))) {
      this.blockedCard('fc-xl-waiting', {
        tone: 'warn', title: 'NOT ON THE CARD',
        reason: 'The payment to ' + to + ' has not finished. Foxy holds the money until the mint says either way. Nothing went on the card.',
        chip: 'If it goes through, the money is in this phone at ' + to + '. If not, it comes back here.',
      });
      return;
    }
    if (e && e.movePaid) {
      this.blockedCard('fc-xl-across', {
        tone: 'warn', title: 'NOT ON THE CARD', reason: said,
        chip: 'The money is in this phone, at ' + to + '. The card is as it was.',
      });
      return;
    }
    this.blockedCard('fc-xl-not', { tone: 'warn', title: 'NOT ON THE CARD', reason: said + ' Nothing was taken.' });
  }

  /* ---- a new card, set up by the first phone that sends it money (software 1.22) ------------------------------------
   *
   * SEND > FLASHCARD to a card that has no PIN and no owner: the card's holder may have no phone, and this one sets the card up
   * for them, with the set-up's own steps (26j-card-wheel.js): the holder types their PIN twice here, and chooses the two numbers.
   * The card holds what is being sent. Then one tap: the PIN, the record with no key of this phone's in it (a cash card: its
   * money cannot be got back if it is lost), the numbers, and the money, under the holder's PIN. This phone does not become its
   * owner, and never says it is: read again, the card is somebody else's here as on any phone (VIEW AS GUEST, TIE OWNERSHIP TO
   * THIS PHONE). */
  fcSendSetUp(sats, unit, alt, info) {
    this.fcSetUpSteps({ other: true, unit: unit === 'usd' ? 'usd' : 'sat', info: info || null, keepPin: !!(info && info.keepPin),
                        run: (c) => this.fcSendSetUpRun(sats, unit, alt, c) });
  }

  fcSendSetUpRun(sats, unit, alt, c) {
    const W = this.fcW();
    if (!W) return;
    let made = null;
    // whether the set-up itself was finished in this tap: a tap cut after it is a send with the holder's PIN, one cut before it the set-up again
    let setUp = false;
    this.fcTap({ amount: this.stageMoney(sats, unit), warm: true }, (link, on) => {
      on('writing');
      // (the dollars each number was chosen in, and the price: a card of software 1.23 keeps them in cents with its rate)
      return W.cardSetUpFor(link, { pin: c.pin, unit: c.unit, design: this.FC_SETUP_DESIGN, tapLimit: c.tapLimit, noPin: c.noPin,
                                    tapUsd: c.tapUsd, noPinUsd: c.noPinUsd, price: (this.fcRatePrice ? this.fcRatePrice() : (this.px && this.px()) || 0) })
        .then((card) => { setUp = true; this.fcNameSettle(card && card.key); on('mint'); return this.fcSendPrepare(card, sats, unit, alt); })
        .then((m) => {
          made = m;
          if (m && m.hash) this.txIsNew(m.hash);
          on('writing');
          return W.cardWrite(link, { pin: c.pin });
        });
    }).then((r) => {
      this.setState({ screen: 'home', stack: [], flow: 'receive', amount: '', unit: 'USD' });
      this.toast('The card is set up for the person who holds it.');
      this.fcWrote(r, { rounded: Number(made && made.rounded) || 0 });
    }, (e) => {
      if (made) {
        this.refreshBalance();
        this.loadHistory();
        if (e && (e.card === 'cancelled' || e.card === 'gone')) {
          this.setState({ screen: 'home', stack: [], flow: 'receive', amount: '', unit: 'USD' });
          this.fcStillWaiting({});
          return;
        }
        this.fcFailed(e, { again: () => this.fcWriteRun(c.pin, {}) });
        return;
      }
      /* Set up, the next try is the send with the holder's PIN. Cut short before that, it is the set-up again with the same PIN and
       * the same two numbers (`cardSetUpFor` takes up a set-up cut after the PIN or after the record): the holder's numbers are not
       * dropped by a send that never writes them. */
      this.fcFailed(e, { again: () => (setUp ? this.fcSendRun(sats, c.pin, unit, alt) : this.fcSendSetUpRun(sats, unit, alt, c)) });
    });
  }

  /* ---- a card with no owner, on any Foxy (software 1.22) ----------------------------------------------------------
   *
   * A card with a PIN and no owner is its holder's, who may have no phone. Read on the FLASHCARD screen of any Foxy, it shows what
   * it holds at once (nothing of that is held for), and two buttons:
   *
   *   VIEW AS GUEST                  its PIN, then a held tap: the card answers Keep holding for some seconds and then gives its
   *                                  history, which the screen shows with what it holds (the card's own log). A till that was
   *                                  handed the PIN for a payment does not hold a card that long, and the card shows nothing in a
   *                                  tap that paid. Nothing is paid in this tap, and nothing of the history is kept here.
   *   CONNECT TO PHONE               its PIN, then the claim set-up makes (about four seconds of Keep holding): this phone is
   *                                  then its owner. Before software 1.24 only an empty card: one with money on it is told to
   *                                  spend or move it first. A card of 1.24 is connected with its money on it (`fcGuestTie`). */
  fcGuestView() {
    const fc = this.state.fc;
    if (!fc) return;
    this.fcAskPin({
      title: 'CARD PIN',
      subtitle: 'To see this card\u2019s history. Hold the card still for a few seconds when you tap it.',
      cta: 'VIEW AS GUEST',
    }, (pin) => this.fcGuestRun(pin));
  }

  fcGuestRun(pin) {
    const W = this.fcW();
    if (!W) return;
    // (`on`: the sheet says what the card is held for when its change is looked into in the same tap)
    this.fcTap({}, (link, on) => W.cardGuestLook(link, { pin, onHold: () => on('writing'), on }))
      .then((card) => {
        this.fcShow(card);
        this.haptic && this.haptic('success');
        this.fcLogCard();
      }, (e) => this.fcFailed(e, { again: () => this.fcGuestRun(pin) }));
  }

  /* CONNECT TO PHONE: straight to the card's PIN ("To connect the card to this phone…", CONNECT), then the claim's held tap (about
   * four seconds of Keep holding). Before software 1.24 only an empty card: one with money on it is told to spend or move it first,
   * as its software would refuse it. A card of 1.24 is connected with its money on it, and its backup moves to this phone: in the same
   * sheet where this phone has a route to the card's mint and is at it (the card is asked for once more: it signs nothing in the tap
   * that claimed it), and otherwise the next time it has the card and a route (`fcRekeyMaybe`), the card's screen saying so meanwhile
   * ("Backup moves to this phone next time you’re online."). */
  fcGuestTie() {
    const fc = this.state.fc;
    if (!fc) return;
    if ((fc.balance > 0 || fc.count > 0) && !fc.claimFull) {
      this.fcFailed({ card: 'has-money', message: 'Spend or move the money on this card first. Only an empty card can be tied to a phone.' });
      return;
    }
    this.fcAskPin({
      title: 'CARD PIN',
      subtitle: 'To connect the card to this phone. Hold it still for about four seconds when you tap it.',
      cta: 'CONNECT',
    }, (pin) => this.fcTieRun(pin));
  }

  fcTieRun(pin) {
    const W = this.fcW();
    if (!W) return;
    const fc = this.state.fc;
    const full = !!fc && (fc.balance > 0 || fc.count > 0);
    // its money's backup moved in the same sheet only where that can be done now: a route, and this phone at the card's mint
    const here = String((W.mintHost && W.mintHost()) || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const there = String((fc && fc.mint) || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const refresh = full && !this.offlineNow() && !!(W.cardOnline && W.cardOnline()) && !!here && (!there || there === here);
    this.fcTap({ warm: refresh }, (link, on, progress) => {
      on('writing');
      return W.cardClaim(link, { pin, onHold: () => on('writing'), refresh, on, progress });
    }).then((card) => {
      (card && card.hashes || []).forEach((h) => this.txIsNew(h));
      this.fcShow(card);
      if (full) { this.refreshBalance(); this.loadHistory(); }
      this.haptic && this.haptic('success');
      this.toast(card && card.rekeyed ? 'Connected. Backup on this phone.' : 'Connected to this phone.');
    }, (e) => this.fcFailed(e, { again: () => this.fcTieRun(pin) }));
  }

  /* A card connected with money on it whose backup is still to move here (software 1.24, `rekeyDue`): read by this phone with a route
   * and at the card's mint, the move is begun at once, as a renewal is offered (`fcRefreshMaybe`): its PIN where it has one, and one
   * tap. Begun once for a card in a session; the line on the card's screen begins it again (`fcRekey`). */
  fcRekeyMaybe(card) {
    const W = this.fcW();
    const fc = this.state.fc;
    if (!W || !card || !fc || fc.key !== card.key || this.state.screen !== 'flashcard' || !fc.rekeyDue || fc.ownedHere !== true) return;
    this._fcRekeyAsked = this._fcRekeyAsked || {};
    if (this._fcRekeyAsked[fc.key]) return;
    if (!(W.cardOnline && W.cardOnline()) || this.offlineNow() || fc.locked) return;
    const here = String((W.mintHost && W.mintHost()) || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const there = String(fc.mint || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!here || (there && there !== here)) return;
    if (((W.cardOwed && W.cardOwed()) || []).some((r) => r && r.card === fc.key)) return;
    this._fcRekeyAsked[fc.key] = true;
    this.fcRekey();
  }

  /* Its backup moved: everything off the card and on again, made with this phone's refund key, the card's record given that key while
   * it is empty (the wallet's `cardRekeyRun`). The card's mint is visited for it where this phone is at another. */
  fcRekey() {
    const W = this.fcW();
    const fc = this.state.fc;
    if (!W || !fc) return;
    if (this.offlineNow() || !(W.cardOnline && W.cardOnline())) { this.toast('Backup moves to this phone next time you’re online.'); return; }
    this.fcPinOr({
      title: 'CARD PIN',
      subtitle: 'To move this card’s backup to this phone: ' + this.fcWholeWords(fc) + '.',
      cta: 'MOVE BACKUP',
    }, (pin) => W.cardVisit(fc.mint || W.mintUrl).then((v) => this.fcTap({ amount: this.fcWholeStage(fc), warm: true },
      (link, on, progress) => W.cardRekeyRun(link, { pin, on, progress }))
      .then((r) => {
        v.end();
        (r.hashes || []).forEach((h) => this.txIsNew(h));
        this.fcWrote(r, { renewed: true });
        this.toast('Backup on this phone.');
      }, (e) => {
        v.end();
        ((e && e.hashes) || []).forEach((h) => this.txIsNew(h));
        this.refreshBalance();
        this.loadHistory();
        this.fcFailed(e, { again: () => this.fcRekey() });
      }), (e) => this.fcFailed(e, { again: () => this.fcRekey() })));
  }

  /* ---- RESTORE LOST CARD ------------------------------------------------------------------------------------------------
   *
   * From home's MENU (21-render-values.js): RESTORE CARD, a screen of its own, 'fcRestore' (the design; drawn by
   * 26j-card-wheel.js `renderCardScreens`). Under CARDS TIED TO YOUR PHONE a row for each card this phone set up (`fcLostRows`): its
   * name, what it held when last seen, and on the right whether its money can be taken back. Only an unlocked card with money on it
   * can be pressed (the design's rule): the take-back (`fcTakeBack`), which ends on the app's success screen. A card whose date has
   * not come says when it unlocks and cannot be pressed; nor can one with nothing to take back. Not on a card's own screens: a card
   * being read is not lost. Opened, it asks the mint what is still there (`fcAskAtMint`). */
  fcRestoreLost() {
    const W = this.fcW();
    if (!W) return;
    const rows = (W.cardsList() || []);
    if (!rows.length) {
      this.blockedCard('fc-restore', { tone: 'ask', title: 'RESTORE LOST CARD',
        reason: 'This phone has set up no card whose money it can take back. A card set up for somebody else is cash, and its money cannot be restored if it is lost.' });
      return;
    }
    this._fcCard = null;
    this.setState(p => ({ fc: null, screen: 'fcRestore', stack: p.screen === 'fcRestore' ? p.stack : p.stack.concat([p.screen]), open0: false }));
    this.fcAskAtMint(rows);
  }

  /* RESTORE CARD's word from the mint (the owner's ask): on opening, with a route, each card whose money is at the mint this phone is
   * connected to is asked after, one request a card (21a-flashcard.js `cardsStillAtMint`, the take-back's own check, which spends
   * and swaps nothing), and its row then says what is still there, "$ 0.60 at the mint" or Empty at the mint, and a ready one takes
   * that back. Only this opening's answers say "at the mint" (`_fcAtMint`, begun again at each opening): the wallet stamps the pieces
   * the mint called spent, so the next opening's "when last seen" is already the smaller figure. A card at another mint, one taken
   * back, offline, an answer that does not come: the row as it was. */
  fcAskAtMint(list) {
    const W = this.fcW();
    const asked = this._fcAtMint = {};
    if (!W || typeof W.cardsStillAtMint !== 'function' || this.offlineNow()) return;
    (list || []).forEach((r) => {
      if (!r || !r.key || r.takenBack) return;
      Promise.resolve().then(() => W.cardsStillAtMint(r.key)).then((got) => {
        // (an answer for an opening that is over is not this one's)
        if (!got || this._fcAtMint !== asked) return;
        asked[r.key] = got;
        if (this.state.screen === 'fcRestore') this.forceUpdate();
      }, () => {});
    });
  }

  /* RESTORE CARD's rows: { key, name, sub, top, bottom, ink, ready, plain, tap }. The name in capitals (`fcName`: CARD ··C2C9 for a
   * card with none); what it held when last seen, dollars first (`fcPrice`, a dollar card's cents as they are), or Empty, and once the
   * mint has answered in this opening (`fcAskAtMint`) what is still there, at the mint, never more than it held; on the right
   * Ready / To Restore on the app's fur, Unlocks in / 2 Days in amber, or Nothing / To Restore in grey. A card is unlocked from the
   * soonest of its pieces' dates (the wallet's `first`, `due` from then). `tap` only on a ready row: the others are drawn with no
   * press at all. Ready rows first, then the locked ones, the soonest to unlock first, then the rest; newest first within each, as
   * the wallet lists them. */
  fcLostRows() {
    const W = this.fcW();
    const now = Math.floor(Date.now() / 1000);
    const list = (W && W.cardsList ? W.cardsList() : null) || [];
    const atMint = this._fcAtMint || {};
    const rows = list.map((r) => {
      const mint = r.takenBack ? null : atMint[r.key];
      const shown = mint ? Math.min(this.fcAmt(mint), this.fcAmt(r)) : this.fcAmt(r);
      const had = r.takenBack ? 0 : shown;
      const opens = Number(r.first || r.date) || 0;
      const locked = !r.takenBack && !r.due && opens > now;
      const ready = !locked && !r.takenBack && !!r.due && had > 0;
      const when = mint ? ' at the mint' : ' when last seen';
      const row = {
        key: r.key,
        name: this.fcName(r.key).toUpperCase(),
        sub: r.takenBack ? 'Restored to this phone'
          : shown > 0 ? this.fcPrice(shown, this.fcUnitOf(r)).replace(/^\$/, '$ ') + when : 'Empty' + when,
        top: ready ? 'Ready' : locked ? 'Unlocks in' : 'Nothing',
        bottom: locked ? this.fcLockLeft(opens - now) : 'To Restore',
        ink: ready ? '#fff' : locked ? '#F7931A' : 'rgba(var(--ink-rgb),.5)',
        ready, plain: !ready,
        tap: ready ? () => this.fcTakeBack(r.key) : null,
      };
      // (the order's own figures are kept off the row: a row is what the screen draws)
      return { row, rank: ready ? 0 : locked ? 1 : 2, opens };
    });
    return rows.map((x, i) => Object.assign(x, { i }))
      .sort((a, b) => (a.rank - b.rank) || (a.rank === 1 ? a.opens - b.opens : 0) || (a.i - b.i))
      .map((x) => x.row);
  }

  // how long until a locked card unlocks, rounded up: 2 Days, 1 Hour, 3 Hours, 9 Minutes
  fcLockLeft(secs) {
    const left = Math.max(0, Number(secs) || 0);
    const say = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');
    if (left >= 86400) return say(Math.ceil(left / 86400), 'Day');
    if (left >= 3600) return say(Math.ceil(left / 3600), 'Hour');
    return say(Math.max(1, Math.ceil(left / 60)), 'Minute');
  }

  /* ---- home and the card --------------------------------------------------------------------------------------------
   *
   * Home's round button at the top left is the CARD button: it opens the card's screen as a card's address does (`goFlashcard`),
   * which asks for the card to be tapped; nothing of a card is shown before it has been read. The card's screen has the HOME
   * button in the same place, which comes back home (`fcGoHome`). A swipe does the same (`fcSwipe`): to the left on home is CARD,
   * to the right on the card's screen is HOME; nothing is drawn for it and nothing of a card is kept for it. */
  // the stores an earlier build kept for a swipe between home and the card: a card's last read and the newest card; cleared once
  FC_OLD_STORES = ['foxy.flashcard.reads', 'foxy.flashcard.last'];

  fcDropOldStores() {
    this.FC_OLD_STORES.forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} });
  }

  // HOME, the round button at the top left of the card's screen
  fcGoHome() {
    if (this._pinLocked || this.cardTapOver() || this.cardFlowBusy()) return false;
    this._fcCard = null;
    this.setState({ screen: 'home', stack: [], fc: null, open0: false });
    return true;
  }

  /* The swipe: `edge`, the strip at the left that is the back gesture's (`watchEdgeSwipe`); `travel`, how far sideways a swipe goes
   * at the least; `slop`, how far up or down it may wander; `ms`, how long it may take. */
  FC_SWIPE = { edge: 24, travel: 72, slop: 48, ms: 700 };

  fcWatchSwipe() {
    if (this._fcSwipeOn) return;
    this._fcSwipeOn = true;
    const S = this.FC_SWIPE;
    let live = false, x0 = 0, y0 = 0, t0 = 0;
    const start = (e) => {
      const t = e.touches && e.touches[0];
      live = !!t && e.touches.length === 1 && t.clientX > S.edge && this.fcSwipeFrom(e.target);
      if (t) { x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); }
    };
    const end = (e) => {
      if (!live) return;
      live = false;
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - x0, dy = Math.abs(t.clientY - y0);
      if (Math.abs(dx) < S.travel || dy > S.slop || Date.now() - t0 > S.ms) return;
      if (this.fcSwipe(dx < 0 ? 'left' : 'right') && this.haptic) this.haptic('light');
    };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchend', end, { passive: true });
    this._fcSwipeOff = () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchend', end);
      this._fcSwipeOn = false;
    };
  }

  // whether a touch that starts on `target` may be this swipe: not in a field, and not in anything that scrolls sideways
  fcSwipeFrom(target) {
    for (let n = /** @type {any} */ (target); n && n !== document.body && n.nodeType === 1; n = n.parentNode) {
      const tag = String(n.tagName || '');
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
      if (n.scrollWidth > n.clientWidth + 1) {
        let ox = '';
        try { ox = window.getComputedStyle(n).overflowX; } catch (e) {}
        if (ox === 'auto' || ox === 'scroll') return false;
      }
    }
    return true;
  }

  /* A swipe, `dir` 'left' or 'right': on home to the left is CARD (`goFlashcard`, which asks for the tap), on the card's screen to the
   * right is HOME (`fcGoHome`). Nothing while Foxy is locked, the menu is open, anything is up over the screen (a sheet, a pad, a card)
   * or a card flow is under way. Answers whether it did anything. */
  fcSwipe(dir) {
    const s = this.state;
    if (this._pinLocked || s.open0 || this.cardTapOver() || this.cardFlowBusy()) return false;
    if (s.screen === 'home' && dir === 'left') {
      console.log('[foxy] swipe: to the card');
      this.goFlashcard();
      return true;
    }
    if (s.screen === 'flashcard' && dir === 'right') {
      console.log('[foxy] swipe: home');
      return this.fcGoHome();
    }
    return false;
  }

  /* ---- paying from the card (SEND on the card's screen) ----------------------------------------------------------
   *
   * SEND on a card's screen opens the app's own SEND MONEY screen in card mode: the camera as ever, PASTE, CONTACTS and
   * TYPE, and the card's WITHDRAW at the top; SEND ECASH and FLASHCARD are not there. What is read goes to the same
   * confirmation, with the card in a FROM row and NEXT for PAY. NEXT reads the payment's total (the amount and the fee the
   * confirmation showed) off the card exactly as a till reads a card that pays it (`fcPayRun`, with `send`): the PIN,
   * the per tap limit's wait, the card's own change, a tap taken up again. The pieces the card pays this phone are held
   * for the payment and nothing else (08a-flashcard.js, `cardOutHold`), and the app's own payment (`startSendNow`) is
   * made with them. Made: PAYMENT SENT as ever. Not made: they go back on the card at its next tap, as a till's refusal
   * does, and the screen says NOT PAID.
   *
   * A bitcoin address is paid on chain the same way, where the mint pays on chain (`fcOutAddress`): the phone's own
   * on-chain confirmation (26b-onchain.js) with the FROM FLASHCARD row and NEXT, the card read for the amount and the fee
   * option's reserve (`fcOcNext`), and the phone's own on-chain melt made with the held pieces (`fcOcPay`). PENDING is then
   * the phone's to follow, for as long as it follows any payment on chain. What comes back after the card has gone (the
   * reserve the transaction did not use, or all of it where the mint does not take it) is the card's, owed to it and put
   * on at its next tap; until then each launch says so (`fcMoneyWaiting`).
   *
   * Card mode is `sendFrom: 'card'` in the state, set by SEND and by nothing else, and true only while the card's screen
   * is under the flow (`fcOutMode`). Leaving the flow by any way (back past SEND MONEY, home, another screen) ends it
   * (`syncCardOut`). A Cashu request is said no to (12-receive.js, `acceptTarget`), and a bitcoin address at a mint that
   * does not pay on chain. */
  FC_OUT_SCREENS = ['sendHow', 'sendType', 'contacts', 'sendConfirm', 'sendDone', 'ocConfirm'];

  fcOutMode() {
    const s = this.state;
    return s.sendFrom === 'card' && !!s.fc && !!this._fcCard && (s.stack || []).indexOf('flashcard') >= 0;
  }

  // card mode is put down as soon as the flow is not on screen, so it cannot come back with a later SEND
  syncCardOut() {
    const s = this.state;
    if (s.sendFrom !== 'card') return;
    const on = this.fcOutMode() && (this.FC_OUT_SCREENS.indexOf(s.screen) >= 0 || (s.screen === 'amount' && (s.flow === 'send' || s.flow === 'onchain')));
    if (!on) this.setState({ sendFrom: '' });
  }

  // SEND, the tile on the card's screen, and SCAN under it (the same camera); PASTE brings what it read (`pasted`), taken as the camera takes it
  fcOutOpen(pasted) {
    if (!this.fcReady('Paying from the card')) return;
    const fc = this.state.fc;
    /* The way to pay first (the camera, PASTE, CONTACTS, TYPE, or the card's WITHDRAW): no currency is asked before it. A card of software
     * 1.23 that holds both is asked which pays once what is paid is known, and only where both could pay it (`fcOutUnitAsk`, on the
     * confirmation); WITHDRAW asks its own question. One that holds one pays in that one. */
    this._fcFlowUnit = null;
    this._fcOutUnitFor = '';
    this._fcOutAsking = false;
    const both = !!(fc.v123 && fc.bal && fc.bal.usd > 0 && fc.bal.sat > 0);
    if (fc.v123 && fc.bal && !both) this._fcFlowUnit = fc.bal.usd > 0 ? 'usd' : fc.bal.sat > 0 ? 'sat' : null;
    if (!both && !(this.fcHeld(fc, this.fcUnit()) > 0)) { this.toast('There is nothing on this card.', true); return; }
    this.setState(p => ({
      screen: 'sendHow', stack: p.stack.concat([p.screen]), flow: 'send', sendFrom: 'card', tokenMode: false,
      amount: '', asset: '', unit: 'USD', recipient: '', recipientKind: '', emailDraft: '', note: '', noteDraft: '',
    }));
    if (pasted) this.acceptTarget(pasted);
  }

  /* PASTE, in the row at the bottom of the card's screen: what the clipboard holds, paid from the card as SEND pays what its
   * camera reads (`fcOutOpen`, card mode). The clipboard is read at the press, before any tap of the card. */
  fcOutPaste() {
    const clip = typeof navigator !== 'undefined' && navigator.clipboard;
    if (!clip || !clip.readText) { this.toast('Paste is not available here. Use scan.', true); return; }
    clip.readText()
      .then((t) => {
        const text = String(t || '').trim();
        if (!text) { this.toast('There is nothing to paste.', true); return; }
        this.fcOutOpen(text);
      })
      .catch(() => this.toast('Could not read the clipboard. Try scan.', true));
  }

  /* A card of software 1.23 that holds both, paying from SEND: which pays, asked on the confirmation once what is paid is known (the
   * wallet's own rule, 08a-flashcard.js `cardPayUnit`): where both of the card's balances cover it, the CURRENCY screen asks, and the
   * fee is asked in the one chosen; where one does, that one, with nothing asked; where neither does, its bitcoin, and NEXT says what
   * the card holds. Answers whether the question is up (nothing is quoted meanwhile). Asked again for another payment. */
  fcOutUnitAsk() {
    const s = this.state;
    const fc = s.fc;
    if (s.screen !== 'sendConfirm' || !this.fcOutMode() || !fc || !(fc.v123 && fc.bal && fc.bal.usd > 0 && fc.bal.sat > 0)) return false;
    const ask = this.sendAsk ? this.sendAsk() : null;
    if (!ask) return false;
    if (this._fcOutUnitFor === ask.key && (this._fcFlowUnit === 'usd' || this._fcFlowUnit === 'sat')) return false;
    const W = this.fcW();
    const sats = ask.inv ? Math.round(Number(W && W.amountOf ? W.amountOf(ask.inv) : 0) || 0) : Math.round(Number(ask.sats) || 0);
    const px = Number(this.px && this.px()) || 0;
    const cents = px > 0 ? Math.ceil(sats / 1e8 * px * 100) : 0;
    // (with no price, whether the dollars cover it is not known here: they are offered, and the card's own total says at NEXT)
    const covers = { sat: fc.bal.sat >= sats, usd: px > 0 ? fc.bal.usd >= cents : true };
    if (covers.sat && covers.usd) {
      /* Asked already: chosen and on its way (`currencyPick` takes the question down first), or backed out of, the question still
       * waiting for an answer, which is a way back from this payment: back past the confirmation to where it came from. */
      if (this._fcOutAsking) {
        if (!this._fcUnitThen) return true;
        this._fcUnitThen = null;
        this._fcOutAsking = false;
        this.back();
        return true;
      }
      this._fcOutAsking = true;
      this.fcPickUnit({ question: 'PAY FROM WHICH?', foot: 'This card holds dollars and bitcoin. You are asked when both could pay.',
                        bal: { usd: fc.bal.usd, sat: fc.bal.sat }, short: { usd: '', sat: '' } },
                      (u) => {
                        this._fcOutAsking = false;
                        this._fcFlowUnit = u;
                        this._fcOutUnitFor = ask.key;
                        // the fee is asked again, in the currency chosen
                        this._quotedFor = null;
                        this.forceUpdate();
                      });
      return true;
    }
    this._fcFlowUnit = covers.usd && !covers.sat ? 'usd' : 'sat';
    this._fcOutUnitFor = ask.key;
    this._quotedFor = null;
    return false;
  }

  /* WITHDRAW, the row on SEND MONEY in card mode: back to the card's screen, out of card mode, and the withdrawal as the
   * card's own tile always began it (`fcWithdraw`), so that it ends on the card's screen as it always did. */
  fcOutWithdraw() {
    this.setState(p => {
      const stack = (p.stack || []).slice();
      const to = stack.length ? stack.pop() : 'flashcard';
      return { screen: to, stack, sendFrom: '', flow: 'receive', amount: '', unit: 'USD', recipient: '', recipientKind: '' };
    });
    this.fcWithdraw();
  }

  /* NEXT on the confirmation in card mode. Everything that can be said before the card is touched is said here: no route,
   * another mint, a payment of this already going, a fee not known yet, a card that does not hold the total. Then the tap. */
  fcOutNext() {
    const W = this.fcW();
    const s = this.state;
    if (!W || !this.fcOutMode()) { this.back(); return; }
    if (!W.connected) { this.offlineNo('Paying from the card'); return; }
    if (!this.fcReady('Paying from the card')) return;
    const fc = s.fc;
    const to = String(s.recipient || '').trim().replace(/^lightning:/i, '');
    const want = to.toLowerCase();
    if ((W.pendingMelts && W.pendingMelts().some(m => m && ((m.bolt11 && m.bolt11.toLowerCase() === want) || (m.payee && m.payee === want))))
        || this._sendRun) { this.showPayPending(); return; }
    // the fee the confirmation showed, on the very invoice that is paid: never a tap for a total that is not known
    const ask = this.sendAsk();
    const q = this._feeQuote;
    /* A dollar card pays in dollars, as a melt of its cents at the card's mint (the quote was asked in dollars,
     * 03-send.js `quoteSendFee`), and its total is in cents; a bitcoin card's is in sats, as ever. A quote in the other unit
     * (asked before the card was read) is not paid with. */
    // (a card of software 1.23 that holds both: the currency chosen to pay from, `fcUnit`)
    const unit = this.fcUnit() === 'usd' ? 'usd' : 'sat';
    const inUnit = !!q && (q.unit || 'sat') === unit;
    let send = null;
    if (inUnit && ask && ask.inv && q.bolt11 === ask.inv) send = { to, key: fc.key, quote: q, unit };
    else if (inUnit && ask && ask.addr && this._found && this._found.addr === ask.addr && this._found.sats === ask.sats && q.bolt11 === this._found.pr) {
      send = { to, key: fc.key, quote: q, found: this._found, unit };
    }
    if (!send) { this.toast('Foxy is still asking the mint for the fee.', true); return; }
    const total = W.cardOutTotal ? W.cardOutTotal(q.amount, q.feeReserve, unit) : q.amount + q.feeReserve;
    if (total > this.fcHeld(fc, unit)) { this.fcFailed({ card: 'not-enough', balance: this.fcHeld(fc, unit), cardUnit: unit }, { taken: true }); return; }
    // Tor can drop while the confirmation sits open: given a moment to come back, as a payment from this phone is (`startSend`)
    const G = window.FoxyGate;
    const fresh = (G && G.recheck) ? G.recheck() : null;
    Promise.resolve(fresh).then((ok) => {
      if (fresh && !ok) { this.offlineNo('Paying from the card'); return; }
      this.fcPayRun(total, '', false, false, null, send);
    });
  }

  /* The card has paid this phone the total, and its pieces for it are held: the payment is made with them, on the screen a
   * payment from this phone is made on. Change the card is still owed (its sheet was closed before it went on) is asked for
   * once the payment is over (`fcOutSettled`). */
  fcOutPay(r, send, sats) {
    // the money that came off the card is the holder's own move, said by this flow and not announced
    if (r && r.hash) this.txIsNew(r.hash);
    const ch = r && r.change;
    // the change in the card's own unit: a dollar card's is in cents, with its `sats` 0 (08a-flashcard.js, `cardGot`)
    const owe = this.fcAmt(ch);
    const o = Object.assign({}, send, {
      held: (r && r.held) || '', card: send.key, sats, unit: send.unit === 'usd' ? 'usd' : 'sat',
      change: (ch && !ch.written && !ch.unmade && owe > 0) ? owe : 0,
      changeLater: (ch && ch.unmade && owe > 0) ? owe : 0,
    });
    this.refreshBalance();
    this.loadHistory();
    if (!o.held) {
      // (not to be: the pieces were not held, and are in this phone's own balance)
      this.blockedCard('fc-out-lost', {
        tone: 'warn', title: 'NOT PAID',
        reason: this.fcSats(sats, send.unit) + ' came off the card into this phone, and could not be kept for this payment. Nothing was paid.',
      });
      return;
    }
    // a bitcoin address: paid on chain, on the confirmation it was read on
    if (send.onchain) { this.fcOcPay(o, send); return; }
    /* What came off the card for this payment, for the card's screen the confirmation returns to (24-render-receive-and-send.js,
     * `dismissPaid`): the card is not read again there, so its figure is stepped down by this much. */
    this._fcPaidOff = { key: send.key, unit: o.unit, off: Math.max(0, Math.round(Number(sats) || 0)) };
    clearTimeout(this._sendA); clearTimeout(this._sendB); clearInterval(this._eta);
    this.setState(p => ({ screen: 'sendDone', stack: p.stack.concat([p.screen]), sendPhase: 'in', etaLeft: 600 }));
    this.startSendNow(send.to, o);
  }

  // whether the card's pieces for this payment are still held, and so not in a melt
  fcOutStillHeld(o) {
    const W = this.fcW();
    return !!(W && W.cardOutHeld && o && o.held && W.cardOutHeld().some((h) => h.id === o.held));
  }

  /* The payment was not made, and the card's pieces are still held for it: they go back to the card (made into pieces for it
   * and owed to it), and NOT PAID says so, with TAP CARD to put them on. Once only, however many ways it ended. */
  fcOutBack(o, e) {
    const W = this.fcW();
    if (!W || !o || o.done) return;
    o.done = true;
    // nothing left the card for good: no confirmation is to step its figure down (`_fcPaidOff`, kept by `fcOutPay` for `dismissPaid`)
    this._fcPaidOff = null;
    const said = e ? String(W.reason ? W.reason(e) : (e.message || '')) : 'The payment could not be started.';
    console.log('[foxy] card: a payment from the card was not made; what it paid goes back to it');
    const tell = (r) => {
      this.refreshBalance();
      this.loadHistory();
      // in the card's own unit: a dollar card's cents
      const amount = this.fcAmt(r) || Math.round(Number(o.sats) || 0);
      this.fcFailed({ card: 'not-paid-out', message: said, amount, unit: o.unit === 'usd' ? 'usd' : 'sat', made: !!(r && r.made) }, { paying: true });
    };
    W.cardOutBack(o.held).then(tell, () => tell(null));
  }

  /* TAP CARD on NOT PAID: the card's own phone writes with its own proof and no PIN; any other, as a till writes change. */
  fcOutWrite() {
    const fc = this.state.fc;
    // (a card of 1.21 and on wants its PIN for every load, its owner's too: asked before the tap, `fcWriteAsk`)
    if (fc && fc.ownedHere && !this.fcCardPinFirst()) { this.fcWriteRun('', { owner: true }); return; }
    this.fcWriteAsk({});
  }

  // a payment from the card is over: made (`paid`), or pending; change the card is still owed is asked for once it is made
  fcOutSettled(o, paid) {
    if (!o || o.done) return;
    o.done = true;
    const W = this.fcW();
    if (W && W.cardOutDone) W.cardOutDone(o.held);
    /* Not made (pending, or stopped): no confirmation comes to step the card's figure down, and what `fcOutPay` kept for one
     * (`_fcPaidOff`) would be taken by the next, a payment on chain from the card's screen that keeps none. Made, it is kept:
     * the confirmation raised after this is what takes it (24-render-receive-and-send.js, `dismissPaid`). */
    if (!paid) { this._fcPaidOff = null; return; }
    if (o.change > 0 && this.fcOwedAfterPaying()) this.fcChangeWaiting(o.change, 0, o.unit);
    else if (o.changeLater > 0) this.fcChangeLater(o.changeLater, 0, o.unit);
  }

  /* A bitcoin address read in card mode (12-receive.js, `acceptTarget`). Whether this mint pays on chain at all is asked of it
   * first (its NUT-30 melt, `onchainLimits`, once a mint): one that does not is said in the card's words, and nothing moves.
   * A mint that could not be asked has not said no: the address goes to the confirmation, which asks it for the fee and
   * says what it answers. */
  fcOutAddress(text) {
    const W = this.fcW();
    if (!W || !W.connected) { this.offlineNo('Paying from the card'); return; }
    /* A dollar card pays Lightning, by a melt of its dollars: a mint's payment on chain is in sats (16a-onchain.js), and is
     * not made from one. Said before the mint is asked anything. */
    // (a card of 1.23 that holds bitcoin as well pays an address from its bitcoin: nothing to ask, only sats go on chain)
    const fc0 = this.state.fc;
    if (fc0 && fc0.v123 && fc0.bal && fc0.bal.sat > 0) this._fcFlowUnit = 'sat';
    if (this.fcUnit() === 'usd') {
      this.blockedCard('fcOutNot', {
        tone: 'warn', title: 'THAT WON\u2019T WORK',
        reason: 'A dollar card pays Lightning invoices. To pay a bitcoin address, WITHDRAW to this phone and pay it from your bitcoin.',
        chip: 'Nothing was taken from the card.',
      });
      return;
    }
    Promise.resolve(W.onchainLimits ? W.onchainLimits() : null).then((limits) => {
      // left card mode while the mint was asked: nothing to do
      if (!this.fcOutMode()) return;
      const known = !!(W.onchainKnown && W.onchainKnown());
      if (known) this.setState({ ocLimits: limits || null });
      if (known && !(limits && limits.send)) {
        this.blockedCard('fcOutNot', {
          tone: 'warn', title: 'THAT WON\u2019T WORK',
          reason: this.mintName() + ' does not pay bitcoin addresses, so an EcashCard cannot pay one from here. '
            + 'Ask them for a Lightning invoice, or WITHDRAW to this phone and pay from a mint that does.',
          chip: 'Nothing was taken from the card.',
        });
        return;
      }
      this.payOnchain(text);
    }, () => this.payOnchain(text));
  }

  /* NEXT on the on-chain confirmation in card mode, as `fcOutNext` is for Lightning: what can be said before the card is
   * touched is said here. The card is then read for the amount and the reserve of the fee option chosen, with the mint's fee
   * on the pieces they are cut into (`cardOutTotal`), as a till reads it: the PIN, the per tap limit and its wait, all as
   * they are for any payment. */
  fcOcNext() {
    const W = this.fcW();
    const s = this.state;
    if (!W || !this.fcOutMode()) { this.back(); return; }
    if (!W.connected) { this.offlineNo('Paying from the card'); return; }
    if (!this.fcReady('Paying from the card')) return;
    const fc = s.fc;
    // (a dollar card never reaches the on-chain confirmation: `fcOutAddress` says so first)
    if (this.fcUnit() === 'usd') { this.fcOutAddress(''); return; }
    const plan = s.ocPlan;
    const pick = plan ? plan.options.filter(o => o.index === s.ocFee)[0] : null;
    if (!plan || !pick) { this.toast('Foxy is still asking the mint for the fee.', true); return; }
    // this one already handed to the mint: it is followed, and not paid twice
    if (s.ocBusy || (W.onchainSending && W.onchainSending().some(r => r && r.quote === plan.id))) { this.showPayPending(); return; }
    const total = W.cardOutTotal ? W.cardOutTotal(plan.sats, pick.fee) : plan.sats + pick.fee;
    if (total > this.fcHeld(fc, 'sat')) { this.fcFailed({ card: 'not-enough', balance: this.fcHeld(fc, 'sat') }, { taken: true }); return; }
    const send = { to: plan.address, key: fc.key, onchain: { plan, fee: pick.index } };
    const G = window.FoxyGate;
    const fresh = (G && G.recheck) ? G.recheck() : null;
    Promise.resolve(fresh).then((ok) => {
      if (fresh && !ok) { this.offlineNo('Paying from the card'); return; }
      this.fcPayRun(total, '', false, false, null, send);
    });
  }

  /* The card has paid this phone the total, and its pieces are held: they are handed to the mint on chain by the phone's own
   * on-chain payment (`onchainPay`, with them), on the screen the phone's own is handed over on, and said as it says it.
   * Whatever the mint gives back of the reserve is owed to the card now (`cardOutBack`), and said (`fcMoneyWaiting`). Not
   * made with the pieces still held (refused before the melt, or by the mint at once): back to the card, NOT PAID, as for
   * Lightning (`fcOutBack`). A melt whose answer did not come is the mint's to say: followed as any payment on chain is. */
  fcOcPay(o, send) {
    const W = this.fcW();
    const plan = send.onchain.plan;
    this.setState({ ocBusy: true });
    this.showMelt('Handing it to the mint\u2026');
    /* Asked inside a promise: the card has paid by now, and a wallet that refused by throwing (no route, say) went past
     * both handlers below, with the card's pieces left held, nothing owed to the card and the overlay up. */
    Promise.resolve()
      .then(() => W.onchainPay(plan, send.onchain.fee, (stage) => { if (stage === 'paying') this.meltSays('Sending it on chain\u2026'); },
                               { held: o.held, card: o.card }))
      .then((done) => {
        this.hideMelt();
        this.setState({ ocBusy: false, ocPlan: null, ocTo: '', ocSats: 0 });
        this.refreshBalance();
        this.loadHistory();
        this.onchainWatchLater();
        const txid = this.ocTxidOf(done.outpoint);
        if (txid) W.tag('onchain-' + done.quote, { txid: txid });
        // the card's own change from the tap, as after a Lightning payment
        this.fcOutSettled(o, true);
        if (done.state === 'UNKNOWN') this.showPayPending();
        else this.announcePayment({ dir: 'out', sats: done.sats, hash: 'onchain-' + done.quote, to: 'a bitcoin address', force: true });
        const back = done.cardChange;
        if (!(back && back.sats > 0)) return null;
        return W.cardOutBack(back.id).then(() => null, () => null).then(() => {
          this.refreshBalance();
          this.loadHistory();
          this.fcMoneyWaiting();
        });
      }, (e) => {
        this.hideMelt();
        this.setState({ ocBusy: false });
        if (this.fcOutStillHeld(o)) { this.fcOutBack(o, e); return; }
        o.done = true;
        this.refreshBalance();
        this.loadHistory();
        this.onchainWatchLater();
        this.showPayPending();
      });
  }

  /* The connect's sweep is over (06-wallet-boot-and-restore.js, `onCaughtUp`). Where it made money owed to a card that was
   * not here (a payment's change left in its hold when Foxy closed, or a payment found never to have gone), it is said now:
   * the launch's own word came before the sweep had made it, and found nothing. */
  fcCaughtUp(info) {
    if (info && Number(info.cardOwed) > 0) this.fcMoneyWaiting();
  }

  /* Money owed to a card from a payment it made out of this phone, whose card was gone by the time it was owed: an on-chain
   * payment's unused reserve, or the whole of one the mint did not take. Said at every launch until it is on the card, and
   * when it comes to be owed; one button, the tap that puts it on (`fcWriteAsk`). It is also on the card's own screen, in
   * the line for money waiting for a card. Answers whether it said anything. */
  fcMoneyWaiting() {
    const W = this.fcW();
    const owed = ((W && W.cardOwed && W.cardOwed()) || []).filter((r) => r && r.out);
    // in the unit of the card it is owed to (a card's rows are of its one unit)
    const u = owed.length ? this.fcUnitOf(owed[0]) : 'sat';
    const sats = owed.filter((r) => this.fcUnitOf(r) === u).reduce((n, r) => n + this.fcAmt(r), 0);
    if (!(sats > 0)) return false;
    this.blockedCard('fc-money-waiting', {
      tone: 'warn', title: 'YOUR CARD HAS MONEY WAITING',
      reason: 'Tap your card to put ' + this.fcSats(sats, u) + ' back on it.',
      retry: 'TAP CARD', go: () => this.fcWriteAsk({}),
    });
    return true;
  }

  /* flashcard: the card that was tapped, or the invitation to tap one. */
  /** @param {RenderContext} c */
  renderFlashcard(c) {
    const { s, sc } = c;
    const on = sc === 'flashcard';
    const W = on ? this.fcW() : null;
    const fc = (on && s.fc) || null;
    const now = Math.floor(Date.now() / 1000);
    const AMBER = '#F7931A';
    const RED = '#FF5C5C';

    /* What this phone owes cards, first and in the warning colour: it is the
     * one thing on this screen that is waiting on the person. */
    const notes = !on ? [] : this.fcOwed().map(r => ({
      // the card on screen is "this card"; any other is named, since its name is shown nowhere else
      text: this.fcSats(r.amount, r.unit) + ' is waiting to go onto '
        + ((fc && fc.key === r.key) ? 'this card. Press here, then tap it.' : this.fcName(r.key) + '. Press here, then tap that card.'),
      tap: () => this.fcWriteAsk({}),
    }));

    /* The card's own log, which only the card writes, is on this screen only
     * when the card has something to accuse: a tap it marked (a terminal
     * asked for more than its limit, three times or more inside ten seconds)
     * or a false time it was told. What else the card did is in this phone's
     * history, which has it already; the log itself opens from the mark. */
    const log = fc && fc.log;
    if (on && log && log.last && log.last.length) {
      const marked = log.last.filter((x) => x.tamper);
      const tried = marked.reduce((n, x) => n + (Number(x.refused) || 0), 0);
      // a false time: the card saw it (told twice in a tap, far apart), or this phone does (the card's clock is ahead of its own)
      // (a mark made in a tap that signed for nothing is in the card's count of marked things and in no entry: new since this phone last looked)
      // A card of software 1.15 and on cannot be told a false time (its clock is block headers): the same mark, with no tap to show it, is a run of refusals.
      const blocks = !!fc.headers;
      const lost = !marked.length && !!log.since && log.since.tampers > 0;
      const falseTime = !blocks && (log.last.some((x) => x.clock) || fc.clockAhead > 0 || lost);
      if (marked.length || falseTime || (blocks && lost)) {
        notes.push({
          text: marked.length
            ? 'TAMPER: a terminal tried ' + tried + ' times to take more than this card\u2019s limit. Press here.'
            : falseTime ? 'TAMPER: this card has been told a false time. Press here.'
            : 'TAMPER: a terminal tried to take more than this card\u2019s limit, again and again. Press here.',
          tap: () => this.fcLogCard(),
        });
      }
    }

    // (software 1.16 and on can be set up without a PIN: `setUp` is a record, and before 1.16 a PIN as well)
    const fresh = !!fc && !fc.setUp && fc.pin !== 'blocked';
    const holderCut = fresh && !!fc.forHolder && !!fc.pinSet;
    const blocked = !!fc && fc.pin === 'blocked';
    // the owner's phone is offered UNBLOCK on a blocked card, which is CHANGE PIN
    const unblock = blocked && !!fc.ownedHere;
    /* The daily limit is not on these screens: this phone sets none, and a card that has one shows nothing about it. The limit on
     * one payment and the no-PIN limit are what a card's face says. */
    const tapped = !!(fc && fc.tap && fc.tap.limited);
    /* software 1.22: a card with a PIN and no owner is a holder's with no phone (set up here as the first phone to send it money, or
     * anywhere else): its balance, and VIEW AS GUEST and TIE OWNERSHIP TO THIS PHONE, and nothing that moves its money from here */
    const guest = !!fc && !!fc.guests && !fc.owner && !!fc.pinSet && !!fc.setUp && fc.pin !== 'blocked';
    const usable = !!fc && !!fc.setUp && fc.pin !== 'blocked' && !guest;
    // a card that has no PIN is offered ADD PIN where a card that has one is offered CHANGE PIN
    const addable = !!fc && !!fc.setUp && !fc.pinSet && !!fc.noPinKnown;
    // a card set up with no PIN: its limit line says so
    const noPinCard = !!fc && !!fc.setUp && !fc.pinSet;
    // what a card with a PIN pays without it in a day: the no PIN limit and what is left of it today
    const noPin = (fc && fc.setUp && fc.pinSet && fc.noPin && fc.noPin.known && fc.noPin.set) ? fc.noPin : null;
    const near = !!fc && fc.mine && fc.first > 0 && fc.first - now < this.fcRenewSecs();
    const past = near && fc.first <= now;

    /* One line on the card's own face, for what is true of the card itself
     * and is not the ordinary state: blocked, new, locked, or holding pieces
     * the mint says are spent. How fresh the mint's word is, is said once,
     * under the screen's title (`verified`, below); it was said here as well.
     * The card is drawn dark whatever the app's theme, so its inks are its
     * own. */
    const ON_CARD = 'rgba(255,255,255,.46)';
    const check = !fc ? ['', ON_CARD]
      : blocked ? ['Blocked', RED]
      : (fc.check && fc.check.spent) ? ['The mint says ' + this.fcSats(fc.check.spent, fc.unit) + ' is already spent', RED]
      : (fc.pin === 'none' && !fc.setUp) ? ['No PIN yet', AMBER]
      : !fc.hasRecord ? ['Not finished', AMBER]
      : fc.locked ? ['Locked', AMBER]
      : ['', ON_CARD];

    /* The card's mint and what it holds are in the pill, as home's are, and
     * under what it holds how much of its limit is left. LIMITS is where
     * it is changed. */
    // a card with under FC_RENEW_DAYS left before its date: said where the money waiting for a card is said, and renewed from there
    if (on && fc && near && !past && this.fcAnyMoney(fc) && !fc.rekeyDue) {
      notes.push({ text: 'This card must be renewed by ' + this.fcDay(fc.first) + '. Press here, then tap it.', tap: () => this.fcRenew() });
    }
    /* A card connected to this phone with money on it (software 1.24) whose backup has not moved here yet (the wallet's
     * `cardRekeyDue`): said in the same box, and moved the next time this phone has the card and a route (`fcRekeyMaybe`), or now
     * from here. */
    if (on && fc && fc.rekeyDue && fc.ownedHere === true) {
      notes.push({ text: 'Backup moves to this phone next time you\u2019re online.', tap: () => this.fcRekey() });
    }
    // a TRANSFER cut short with the money in this phone (the wallet's `cardTransfers`): finished from here (`fcMoveResume`)
    const moving = (on && fc && fc.key && W && W.cardTransfers) ? W.cardTransfers()[fc.key] : null;
    if (moving) {
      notes.push({ text: 'Moving this card to ' + this.mintNameOf(moving.to) + ' is not finished. Press here, then tap it.', tap: () => this.fcMoveResume() });
    }

    /* RESET, for the card's owner (software 1.17 and on): a locked card is not asked whether this phone owns it, so it is offered to
     * any phone that holds the card and the card's own word at the tap decides. */
    const resettable = !!fc && fc.owner && fc.resetKnown && (fc.ownedHere === true || fc.locked);
    // TRANSFER, for the phone that owns the card: the new mint is written into the card with this phone's proof that it owns it
    const transferable = usable && fc.ownedHere === true && !fc.locked;


    /* Under the title: how fresh the mint's word on this card is. Just now,
     * where it has just been asked; how long ago, on a phone that cannot ask
     * and has asked before about these same pieces; not verified, where it
     * never has, or where the mint says some of it is spent. A card with
     * nothing on it has nothing a mint could dispute. */
    const DIMMED = 'rgba(var(--ink-rgb),.62)';
    const nowMs = Date.now();
    /* A card of software 1.20 keeps the mint's proof with its pieces, and for it the line says more than the mint's word: that every piece on it
     * is real, which the mint's word that a piece is unspent does not. Red where the mint says a piece is spent or this phone found a proof
     * false; the time where the mint was asked (or was, for these same pieces) and every piece was found real; amber otherwise, a card
     * loaded by a build that sends no proofs among them. A card of 1.19 and before has no proofs, and its line is the mint's word alone. */
    const proofs = !!(fc && fc.proofs);
    const sound = !proofs || !(fc.count > 0) || fc.real === 'ok';
    // (the mint's word is dated by the time of day it was had, in this phone's clock: "Verified At 11:42am")
    const verified = (!fc || fresh || blocked || !fc.hasRecord) ? ['', DIMMED]
      : ((fc.check && fc.check.spent) || (proofs && fc.real === 'fake')) ? ['Not Verified', RED]
      : (fc.check === 'asking' || (proofs && fc.real === 'asking')) ? ['Verifying\u2026', DIMMED]
      : (sound && (fc.check === 'ok' || !(fc.count > 0))) ? ['Verified At ' + this.fcAt(fc.checkedAt || nowMs), DIMMED]
      : (sound && fc.checkedAt) ? ['Verified At ' + this.fcAt(fc.checkedAt), DIMMED]
      : ['Not Verified', AMBER];

    /* Under the limits: the change this card made for itself that no till has handed back (software 1.12), what it comes to and
     * where it stands, one line for each state it is in. Dollars first and the sats after, as the balance is. */
    const owes = (on && fc && fc.owes && fc.owes.parts) || [];

    const px = this.px ? this.px() : 0;
    // a dollar card's figures are its cents, as dollars with no price in them: its limit lines say them whether or not there is a price
    const U = (fc && fc.unit === 'usd') ? 'usd' : 'sat';
    const usdCard = U === 'usd';
    const sat1 = (this.satUsd && this.satUsd()) || 0;
    /* Software 1.23: a card that holds both currencies (or may) shows both pills, the dollar pill with its worth in sats under it and the
     * bitcoin pill with its worth in dollars, at the market price (`two`); its ceiling is cents for both together, said once, in dollars,
     * under them (`LU`). A card of one unit shows its one pill, as ever. */
    const two = !!(fc && fc.hasRecord && fc.v123 && fc.bal && this.fcTwoUnits(fc));
    const LU = (fc && fc.cents) ? 'usd' : U;
    /* The card's MENU, at the top right, home's own menu button and drawer (build/markup.html, `open0`): the card's settings, in this
     * order. HISTORY, what has been done with this card on this phone (`fcHistory`: its own log and the tampers it marked, for its
     * owner), the clock as home's HISTORY row has it; RENAME CARD; LIMITS, with what the card pays without its PIN under it; CHANGE PIN
     * (ADD PIN on a card that has none); TRANSFER, for the phone that owns it (`fcSwitchMint`); RESET, for its owner (software 1.17 and on).
     * Restoring a lost card is home's MENU's: a card
     * being read is not lost. LIMITS and the PIN are the owner's: only the phone that holds the words the card was set up with can
     * change them. The round button at the top left is HOME (`fcGoHome`). */
    const shut = (go) => () => { this.setState({ open0: false }); go(); };
    // (software 1.23: for both its currencies together, in dollars, `LU`)
    const noPinSub = !(noPin && fc && fc.pin !== 'blocked') ? '' : 'No PIN up to ' + this.fcPrice(noPin.limit, LU) + ' \u00b7 '
      + (noPin.left > 0 || !px || LU === 'usd' ? this.fcPrice(noPin.left, LU) : '$0.00') + ' left' + (fc.pinFirst ? '' : ' today')
      + (two ? ' \u00b7 both currencies' : '');
    // (a card this phone set up or claimed: the wallet's `cardKnownHere`)
    const renamable = !!(fc && fc.key && W && typeof W.cardKnownHere === 'function' && W.cardKnownHere(fc.key));
    const menu = !(fc && fc.hasRecord) ? [] : [
      { label: 'HISTORY', sub: '', tap: shut(() => this.fcHistory()),
        path: 'M12 7v5l3.5 2M12 3.5a8.5 8.5 0 1 0 8.5 8.5A8.5 8.5 0 0 0 12 3.5Z' },
    ].concat(!renamable ? [] : [
      // RENAME CARD: its name on this phone (26j-card-wheel.js `fcRename`), for a card this phone set up or claimed
      { label: 'RENAME CARD', sub: '', tap: shut(() => this.fcRename()),
        path: 'M4 20h4.2L19.4 8.8a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8V20ZM13.8 6l4.2 4.2' },
    ]).concat(!usable ? [] : [
      { label: 'LIMITS', sub: noPinSub, tap: shut(() => this.fcSetLimit()),
        path: 'M4.6 16.8a8.2 8.2 0 1 1 14.8 0M12 13.6l3.7-4.4M12 14.6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z' },
      { label: addable ? 'ADD PIN' : 'CHANGE PIN', sub: '', tap: shut(() => (addable ? this.fcPinAdd() : this.fcChangePin())),
        path: 'M6.4 10.4V7.6a5.6 5.6 0 0 1 11.2 0v2.8M5.2 10.4h13.6a1.4 1.4 0 0 1 1.4 1.4v7.4a1.4 1.4 0 0 1-1.4 1.4H5.2a1.4 1.4 0 0 1-1.4-1.4v-7.4a1.4 1.4 0 0 1 1.4-1.4Z' },
    ]).concat(!transferable ? [] : [
      // TRANSFER: the whole card to another mint, in one tap (`fcSwitchMint`), with the swap arrows SWAP has
      { label: 'TRANSFER', sub: '', tap: shut(() => this.fcSwitchMint()),
        path: 'M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5' },
    ]).concat(!resettable ? [] : [
      { label: 'RESET', sub: '', tap: shut(() => this.fcReset()),
        path: 'M3.8 12a8.2 8.2 0 1 0 2.5-5.9M3.8 4.2v4.4h4.4' },
    ]).map((m) => Object.assign({ indent: '0', glow: 'none', ringInk: 'transparent', ringInk2: 'transparent', ring: 'none' }, m));
    /* The row under DEPOSIT and WITHDRAW, home's own row of round-cornered buttons (21-render-values.js, `homeButtonsTwo`): SWAP,
     * which moves money between a card's two balances (software 1.23, `fcSwap`), on a card of two currencies only. Offline it is
     * greyed as home's is, and the swap says why itself. A card of one currency has no row: the room it took is the card's picture's.
     * (SCAN and PASTE, which paid from the card as SEND does with its camera, `fcOutOpen` and `fcOutPaste`, were in this row and are
     * not on this screen any more; the send screen's own card flows still reach them.) */
    const swappable = !!(fc && this.fcTwoUnits(fc));
    /* A card of two currencies swaps whenever either holds something: from the side with money into the other, which may be empty
     * (the card then holds both); where both hold, the swap screen's own from and to choose. Only a card that holds nothing at all is
     * offered SWAP greyed, with the reason when pressed. */
    const swapEarly = swappable && !!fc.bal && !(fc.bal.usd > 0) && !(fc.bal.sat > 0);
    /* SWAP is in the row for a card of two currencies only, as home's is for two pills (`homeButtonsTwo`). */
    const buttons = !usable ? [] : [].concat(swappable ? [
      { label: 'SWAP', spin: 'none', pasteHere: '',
        dim: (swapEarly || this.offlineNow()) ? '0.38' : '1',
        tap: swapEarly ? () => this.toast('Put money on the card to swap.', true) : () => this.fcSwap(),
        path: 'M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5' },
    ] : []);
    // the limit line has a card to be on, and says nothing of a blocked one
    const limitShown = !!fc && !!fc.hasRecord && fc.pin !== 'blocked';
    // what the balance says now: what the card holds, or, while it counts after money went on or off, where it has got to
    const shown = this.fcBalanceShown(fc, s);
    /* The line on the card's face: its limit on one payment, or NO LIMIT. A card with no PIN says so beside it, after a bar:
     * "NO LIMIT | NO PIN". What it pays without its PIN is not on the face: the LIMITS row of the menu says it, under it. A card whose
     * one limit is a daily one (set by an older Foxy) says nothing of limits at all: this phone sets no daily limit, and says nothing
     * about one. */
    // (a card that waits for its limit says it as the rate it makes, 26j-card-wheel.js `fcSpeedText`)
    const limitBase = !(fc && fc.hasRecord) ? '' : (
      (tapped && fc.tap.paced) ? 'PER SECOND LIMIT ' + this.fcSpeedText(fc.tap.limit, LU, this.fcKeptUsd(fc))
      : tapped ? 'PER TAP LIMIT ' + this.fcPrice(fc.tap.limit, LU)
      // another phone's card keeps its per tap limit to its owner: it is not said to have none
      : (fc.tap && fc.tap.paced && fc.ownedHere !== true && !fc.guestRead) ? ''
      // only a no PIN limit: the face says nothing of it (the LIMITS row does)
      : noPin ? ''
      : (Number(fc.limit) > 0) ? '' : 'NO LIMIT');
    const limitLine = (fc && fc.hasRecord && noPinCard) ? (limitBase ? limitBase + ' | NO PIN' : 'NO PIN') : limitBase;
    return {
      isFlashcard: on,
      fcVerified: verified[0], fcVerifiedInk: verified[1], fcVerifiedShown: !!verified[0],
      // the screen's title: the card's name on this phone (NAME CARD), ECASHCARD for a card with none, and with no card
      fcTitle: (fc && fc.key && this.fcNameKept(fc.key)) || 'ECASHCARD',
      /* The room the card's picture leaves under itself for the lines that are under it (build/markup.html, `data-card-room`): the
       * card stands upright and is as tall as the screen leaves room for, 160px at the least, and 26px less for each line under it
       * (its 14px, and the 12px between). */
      fcCardCap: (((limitShown && !!limitLine) ? 1 : 0) + (check[0] ? 1 : 0)) === 2 ? '44px' : ((limitShown && !!limitLine) || !!check[0]) ? '26px' : '0px',
      // which design the card on screen is drawn in (FC_DESIGNS)
      fcDesign: this.fcDesignOf(fc),
      // a card that has been read says what it is on its own face
      fcSub: fc ? '' : 'Ecash on a card, spent with a tap and a PIN.',
      fcNone: on && !fc,
      fcHas: !!fc,
      fcNotes: notes,
      /* Home's own money card, for a card that has a mint: headed by the card's mint alone, by the name this
       * phone knows it by (the card's own, from its record, which need not be this phone's), and home's bitcoin
       * pill with the card's sats big and their worth in dollars under them. A card with no mint yet keeps
       * CARD BALANCE. */
      fcPill: !!fc && !!fc.hasRecord,
      fcPillMint: (fc && fc.hasRecord) ? String(this.mintNameOf(fc.mint) || '') : '',
      fcMintShown: !!fc && !!fc.hasRecord && !!fc.mint,
      fcMintNone: !(fc && fc.hasRecord && fc.mint),
      fcMintName: (fc && fc.hasRecord) ? String(this.mintNameOf(fc.mint) || '').toUpperCase() : '',
      /* A dollar card has home's dollar pill instead: frost and dark ink, its cents big, and their worth in sats under them at the
       * market price where there is one, as home has it (display only: the card holds dollars). */
      // (a card set up for both shows both from the start, each at nothing where it holds none: "$0.00" with "₿ 0" under, and the other way)
      fcPillRows: two ? [{
        ...this.USD_PILL,
        label: 'This card\u2019s history',
        big: this.usd(fc.bal.usd / 100),
        small: (sat1 || !(fc.bal.usd > 0)) ? '\u20bf ' + this.group(sat1 ? Math.round(fc.bal.usd / 100 / sat1) : 0) : '',
        glow: '0 10px 24px rgba(0,0,0,.3)',
        tap: () => this.fcHistory(),
        badge: false,
      }, {
        ...this.BTC_PILL,
        label: 'This card\u2019s history',
        big: this.group(fc.bal.sat),
        small: (px > 0 || !(fc.bal.sat > 0)) ? '$' + this.usd(px > 0 ? (fc.bal.sat / 1e8) * px : 0) + ' USD' : '',
        glow: '0 10px 24px rgba(0,0,0,.3)',
        tap: () => this.fcHistory(),
        badge: false,
      }] : (fc && fc.hasRecord && usdCard) ? [{
        ...this.USD_PILL,
        label: 'This card\u2019s history',
        big: this.usd(shown / 100),
        small: sat1 ? '\u20bf ' + this.group(Math.round(shown / 100 / sat1)) : '',
        glow: '0 10px 24px rgba(0,0,0,.3)',
        tap: () => this.fcHistory(),
        badge: false,
      }] : (fc && fc.hasRecord) ? [{
        ...this.BTC_PILL,
        label: 'This card\u2019s history',
        big: this.group(shown),
        // their worth in dollars, only where there is a price to say it at
        small: px > 0 ? '$' + this.usd((shown / 1e8) * px) + ' USD' : '',
        glow: '0 10px 24px rgba(0,0,0,.3)',
        tap: () => this.fcHistory(),
        badge: false,
      }] : [],
      // what the card holds, in words: the pill's figure with its sign
      fcBalance: !fc ? '' : two ? '$ ' + this.usd(fc.bal.usd / 100) + ' \u00b7 \u20bf ' + this.group(fc.bal.sat)
        : usdCard ? '$ ' + this.usd(shown / 100) : '\u20bf ' + this.group(shown),
      /* The limit line is under the card, in the spaced capitals the card's face had it in (build/markup.html, `data-card-lines`; with
       * the card's badge above it where it has one: Blocked, Locked), in dollars first as the balance is. */
      fcLimitShown: limitShown && !!limitLine,
      fcFaceLines: (limitShown && !!limitLine) || !!check[0],
      fcLimitLine: limitLine,
      // under the limits, where the card holds pieces larger than its limit on one tap
      fcAboveShown: !!fc && !!fc.hasRecord && fc.pin !== 'blocked' && (fc.above || 0) > 0,
      fcAboveLine: (fc && fc.above > 0) ? this.fcPrice(fc.above, U).toUpperCase() + ' IN PIECES ABOVE THE LIMIT \u00b7 A TILL HOLDS LONGER FOR THOSE' : '',
      // and under those, the change it is owed
      fcOwesShown: !!fc && !!fc.hasRecord && fc.pin !== 'blocked' && owes.length > 0,
      fcOwesLines: owes.map((p) => ({ text: 'CHANGE OWED TO THIS CARD \u00b7 ' + this.fcBoth(this.fcAmt(p), U) + ' \u2014 ' + (this.FC_OWES[p.state] || '') })),
      /* And under those, what can be done about it (software 1.22): FINISH THIS CHANGE where a till's key kept it off the card and the
       * mint's answer is here, and GIVE UP THIS CHANGE for each opening that cannot be finished, and only for those. */
      fcChangeRows: (!!fc && !!fc.hasRecord && fc.pin !== 'blocked' && owes.length > 0) ? [].concat(
        this.fcMendAmount(fc) > 0 ? [{ name: 'FINISH THIS CHANGE (' + this.fcPrice(this.fcMendAmount(fc), U) + ')', sub: 'With the card\u2019s PIN', text: '', ink: 'var(--ink)', tap: () => this.fcMend() }] : [],
        ((fc.owes && fc.owes.openings) || []).filter((x) => x && x.giveUp).map((x) => ({
          name: 'GIVE UP THIS CHANGE (' + this.fcPrice(x.amount, U) + ')', sub: '', text: '', ink: 'var(--ink)', tap: () => this.fcGiveUp(x) }))) : [],
      fcCheck: check[0], fcCheckInk: check[1],
      fcHasCheck: !!check[0],
      // (what has been done with this card, on this phone, is HISTORY at the top of its menu, and its pill)
      // the row under DEPOSIT and WITHDRAW, SWAP alone, and the MENU at the top right, which is the close button where it has no rows
      fcRowShown: buttons.length > 0,
      fcButtons: buttons,
      fcMenuShown: menu.length > 0,
      fcCloseShown: !menu.length,
      fcMenuItems: menu,
      fcMenuOpen: on && !!s.open0 && menu.length > 0,
      fcNew: fresh,
      /* SET UP CARD, but not on a card whose set-up this phone began for its holder: sending it money finishes
       * that set-up (`fcSendRun`), and this phone does not become its owner */
      fcNewSetUp: fresh && !holderCut,
      fcNewLine: holderCut
        ? 'Its set-up for the person who holds it was cut short. Send it money to finish it.'
        : (fc && fc.pin === 'set' && !fc.hasRecord)
        ? 'Its set-up was cut short. Finish it to put money on it.'
        : 'Welcome to Foxy Card. Set it up to put money on it.',
      // a holder's card with no owner (software 1.22): what it is, and its two buttons
      fcGuest: guest,
      fcGuestLine: 'This card belongs to whoever holds it. It is not tied to any phone.',
      fcGuestView: () => this.fcGuestView(),
      fcGuestTie: () => this.fcGuestTie(),
      fcBlocked: blocked,
      fcUnblock: unblock,
      fcUnblockTap: () => this.fcChangePin(),
      /* A blocked card's money: gone, where the card is cash; the loader's to
       * take back, where it is not (and here, where this phone can). */
      fcBlockedLine: (fc && fc.ownedHere)
        ? 'Too many wrong PINs. This phone can unblock the card by giving it a new PIN.'
        : (fc && fc.owner)
        ? 'Too many wrong PINs. Only the phone that owns this card can unblock it, with a new PIN.'
        : (fc && !fc.recoverable)
        ? 'Too many wrong PINs. This card is cash, so what is on it cannot be got back.'
        : (fc && fc.mine && this.FC_RECOVERABLE)
        ? 'Too many wrong PINs. This phone can take its money back after its date, from RESTORE LOST CARD in the menu.'
        : 'Too many wrong PINs. Only the phone that loaded it can take its money back, after its date.',
      fcUsable: usable,
      fcTap: () => this.fcRead(),
      // DEPOSIT: money onto the card, on SET AMOUNT ("How much to deposit?")
      fcAdd: () => this.fcAdd(),
      // WITHDRAW: money off the card into this phone, straight to SET AMOUNT ("How much to withdraw?", with ALL OF IT under NEXT)
      fcSend: () => this.fcWithdraw(),
      fcWithdraw: () => this.fcWithdraw(),
      fcSetUp: () => this.fcSetUp(),
      // HOME, the round button at the top left
      fcHome: () => { if (this.fcGoHome() && this.haptic) this.haptic('light'); },
    };
  }

