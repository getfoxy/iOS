  /* ---- SWAP: dollars into bitcoin, or bitcoin into dollars, at this mint ----
   *
   * Four screens, the way a payment goes:
   *
   *   swap         which way: the FROM pill over the TO pill, with a round ⇅
   *                on the seam that turns them round, and NEXT
   *   amount       SET AMOUNT with flow 'swap': "How much to swap?", in dollars
   *                to start whichever way it goes, with the ⇅ to sats and back
   *                as a send has it, and ALL OF IT. What the swap moves is the
   *                FROM balance's own unit, cents or sats, exactly: typed in
   *                it, nothing converts; typed in the other, it converts at the
   *                mint's last rate, the one its confirmation will be valued
   *                at, so the dollars typed are the dollars it repeats
   *                (`swapTyped`, `swapPx`). Under the question, the mint's
   *                rate, asked as SWAP was tapped (`swapProbe`,
   *                `swapRateLine`); a figure left still is quoted in the
   *                background, so NEXT opens the confirmation filled
   *                (`swapAheadAsk`)
   *   swapConfirm  four blocks, as the owner laid them out: YOU ARE GETTING,
   *                YOU ARE SPENDING, FEE, and the mint's RATE with how long it
   *                is held for, then SWAP. A bitcoin figure is its dollar worth
   *                at the quote's rate with the sats under it; a dollar figure
   *                is exact and has no sats line
   *   swapDone     SWAPPED: what left and what arrived, each in its own colour
   *
   * The wallet does the money (16b-two-balances.js): `swapQuote` asks the mint
   * for its rate (an invoice in the TO unit, and what paying it from the FROM
   * unit costs), and `swapRun` pays one with the other. Nothing moves until
   * SWAP. A quote lives a minute at most, so the confirmation counts down and
   * asks again when it runs out, and the button then reads CONFIRM NEW RATE so
   * a tap meant for the old rate is not taken for the new one.
   *
   * A swap the mint has not finished is not lost: the wallet holds what it
   * spent until the mint says, and finishes it on the next connection. The
   * card SWAP STILL GOING THROUGH says so, and home's held pill names the
   * amount until it is done.
   *
   * At a mint with one balance none of this is reachable: home has no SWAP
   * button and the menu no SWAP row. */

  /* How long before the mint's own expiry the rate stops being offered. The
   * wallet refuses to run a quote with under fifteen seconds left (the mint
   * has to answer two requests in that time), so the countdown on screen is
   * the time left to tap, not the time left on the mint's clock. */
  SWAP_MARGIN_MS = 15000;

  /* New rates asked for by themselves while the confirmation sits untouched.
   * After that it waits for a tap: a screen left open on a table must not ask
   * the mint for a rate every minute for ever. */
  SWAP_REQUOTES = 3;

  /* Asking ahead, so the wait is spent while the person is still deciding.
   * At the SWAP tap one quote pair for a nominal amount (the probe) brings
   * the mint's own rate to SET AMOUNT; then, once a typed figure has stood
   * still this long, the real quote for it is asked in the background, so
   * NEXT can open the confirmation already filled. */
  SWAP_TYPED_MS = 600;

  /* No closer together than this from the asking ahead, counted from any
   * quote pair this phone asked the mint, the confirmation's included. */
  SWAP_AHEAD_GAP_MS = 3000;

  /* And never once this many pairs have gone in the last minute, whoever
   * asked them: a Nutshell mint answers twenty quote requests a minute per
   * address on each quote route, a pair is one on each, and most of that
   * minute is kept for the questions a person is waiting on. */
  SWAP_AHEAD_PER_MIN = 8;

  /* The mint's rate is shown as the mint's on SET AMOUNT only while it is
   * this fresh; an older one is not what the mint would quote now. */
  SWAP_RATE_FRESH_MS = 600000;

  /* A quote asked ahead is only used at NEXT with more than this many
   * seconds of its hold still to run: less, and a fresh one is asked. */
  SWAP_AHEAD_KEEP_S = 10;

  /* SWAP, from home's button or the menu's row (swapStart). Starts from the
   * balance that has something in it: dollars when both do, as drawn. */
  goSwap() {
    // (home's own SWAP: this phone's balances, not a card's, `fcSwap`)
    this._swapCard = null;
    if (this.offlineNow()) { this.toast('Swapping needs the mint.', true); return; }
    if (!this.twoUnitsOn()) { this.toast('This mint issues only bitcoin, so there is nothing to swap with.', true); return; }
    const from = this.unitBalance('usd') > 0 || !(this.unitBalance('sat') > 0) ? 'usd' : 'sat';
    console.log('[foxy] swap: opened, from ' + this.unitWord(from).toLowerCase());
    // a new screen: what was asked ahead for the last one is not this one's
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

  /* The probe, at the SWAP tap: one quote pair for a nominal amount (the
   * last swap's from this balance, else a thousand sats' worth), so that
   * SET AMOUNT shows the mint's own rate before anything is typed and the
   * swap's first pass is sized from it. Once per direction per screen
   * opened (the ⇅ asks the other way's); never offline, at a one-unit mint,
   * with a swap running, or beside another question to the mint from here
   * (one asked while another is out goes when it is answered). It blocks
   * nothing, and a failure is only logged: the market price stands in,
   * labelled as such. */
  swapProbe(fromGiven) {
    const W = window.FoxyWallet;
    const from = fromGiven === 'sat' ? 'sat' : 'usd';
    const to = from === 'usd' ? 'sat' : 'usd';
    if (!W || typeof W.swapProbe !== 'function' || (this._swapProbed && this._swapProbed[from])) return;
    if (this.offlineNow() || !this.twoUnitsOn()) return;
    if (this._swapRun || this._swapAskOut || this.state.swapBusy) return;
    if (this._swapAheadOut) { this._swapProbeWanted = from; return; }
    this._swapProbed = Object.assign({}, this._swapProbed || {}, { [from]: true });
    const last = (this._swapLast && this._swapLast[from]) || 0;
    const ask = this._swapAheadOut = Promise.resolve().then(() => W.swapProbe(from, to, last || undefined,
      { paceMs: this.SWAP_AHEAD_GAP_MS, perMin: this.SWAP_AHEAD_PER_MIN }));
    this.setState({ swapProbing: true });
    ask.then((r) => {
      if (r && r.usdPerBtc > 0) console.log('[foxy] swap: the mint’s rate, asked ahead: ' + this.swapRateText(r.usdPerBtc));
    }, (e) => {
      console.log('[foxy] swap: the rate asked ahead did not come:', (e && e.message) || e);
    }).then(() => {
      if (this._swapAheadOut === ask) this._swapAheadOut = null;
      this.setState({ swapProbing: false });
      // a figure typed while the probe was out is asked for now; else the other way's probe, if one was wanted
      const want = this._swapProbeWanted;
      this._swapProbeWanted = null;
      if (this._swapAheadWaiting) { this._swapAheadWaiting = false; this.swapAheadAsk(); }
      else if (want) this.swapProbe(want);
    });
  }

  /* The ⇅ on the seam: the other way round, and that way's rate asked, so
   * its first quote is sized from a pair the mint answered that way. */
  swapFlip() {
    const next = this.state.swapTo === 'sat' ? 'sat' : 'usd';
    this.setState(p => ({ swapFrom: p.swapTo === 'sat' ? 'sat' : 'usd', swapTo: p.swapFrom === 'sat' ? 'sat' : 'usd' }));
    if (this.state.screen === 'swap') this.swapProbe(next);
  }

  /* The swap's two units, as they stand: never the same one. */
  swapUnits() {
    const from = this.state.swapFrom === 'sat' ? 'sat' : 'usd';
    return { from: from, to: from === 'usd' ? 'sat' : 'usd' };
  }

  /* For a card's SWAP (26f-flashcard.js, `fcSwap`): what of `u` comes off the card before the swap is run, for the mint to be asked a rate
   * for it while it is still on the card (the wallet's `swapQuote`, `coming`). Nothing for this phone's own SWAP. */
  swapComing(u) {
    const c = this._swapCard;
    return (c && c.bal) ? { coming: Math.max(0, Math.round(Number(c.bal[u === 'sat' ? 'sat' : 'usd']) || 0)) } : {};
  }

  /* What there is to swap in `u`: this phone's balance, or, for a card's SWAP (26f-flashcard.js, `fcSwap`), what the card holds of it. */
  swapHave(u) {
    const c = this._swapCard;
    if (c && c.bal) return Math.max(0, Math.round(Number(c.bal[u === 'sat' ? 'sat' : 'usd']) || 0));
    return this.unitBalance(u);
  }

  /* NEXT on the swap screen: SET AMOUNT, in dollars whichever way it goes,
   * since dollars are what people think in. Without a price ever seen there
   * is nothing to convert dollars with, so bitcoin leaving is typed in sats,
   * its own unit. The unit is set here, once; after that the ⇅ is the
   * person's (`toggleUnit`). */
  swapToAmount() {
    if (this.offlineNow()) { this.toast('Swapping needs the mint.', true); return; }
    const { from } = this.swapUnits();
    if (!(this.swapHave(from) > 0)) {
      this.toast('You have no ' + this.unitWord(from).toLowerCase() + ' to swap.', true);
      return;
    }
    this.setState(p => ({
      screen: 'amount', stack: p.stack.concat([p.screen]), flow: 'swap',
      unit: (from === 'usd' || this.px()) ? 'USD' : 'SATS', amount: '', asset: '',
      note: '', noteDraft: '', recipient: '', recipientKind: '',
    }));
  }

  /* Is the keypad in the unit that leaves (dollars for dollars, sats for
   * bitcoin), so that what is typed is what moves? */
  swapExact() {
    const { from } = this.swapUnits();
    return (this.state.unit === 'SATS') === (from === 'sat');
  }

  /* The price a swap's two units are put side by side at before the mint
   * has quoted: its last rate, because the confirmation values the swap at
   * the mint's rate, and a figure converted at the market's would come back
   * a few cents off what was typed. The market's price when the mint has
   * given none; 0 with neither. The keypad's figure (`swapTyped`), the line
   * under it (`swapEstimate`), the ⇅ (`toggleUnit`) and the confirmation
   * before its rate (`swapSpec`) all read this one. */
  swapPx() {
    const W = window.FoxyWallet;
    let rate = 0;
    try { rate = this.swapRateOf(W && W.mintRate ? W.mintRate() : null); } catch (e) { rate = 0; }
    return rate > 0 ? rate : (this.px() || 0);
  }

  /* What is typed on SET AMOUNT for a swap, in the FROM unit: cents for
   * dollars, sats for bitcoin. Typed in that unit it is taken exactly. Typed
   * in the other it converts at the swap's price (`swapPx`), rounded as the
   * ⇅ rounds: dollars to the nearest sat, sats to the cent the ⇅ would show
   * (`centsOfSats`), so the cents asked for are the figure seen. No price,
   * no conversion: nought. */
  swapTyped() {
    const { from } = this.swapUnits();
    const v = parseFloat(this.state.amount) || 0;
    if (!(v > 0)) return 0;
    if (this.swapExact()) return from === 'usd' ? this.centsTyped() : Math.round(v);
    const px = this.swapPx();
    if (!px) return 0;
    return from === 'usd' ? this.centsOfSats(Math.round(v), px) : Math.round(v / px * 1e8);
  }

  /* A quote is for the amount as it stood at NEXT. The keypad changing under
   * it (a key, or the ⇅) drops it, and an answer still on its way for the
   * old figure is not kept (`swapAsk` keeps only its own latest question). */
  swapForget() {
    // the figure is changing: its own quote is asked once it stands still
    this.swapAheadLater();
    const s = this.state;
    if (!s.swapQuote && !s.swapQuoting && !s.swapNewRate) return;
    this._swapAskRun = (this._swapAskRun || 0) + 1;
    this.setState({ swapQuote: null, swapQuoting: false, swapNewRate: false });
  }

  /* A key on SET AMOUNT: the figure's own quote, asked once it has stood
   * still for SWAP_TYPED_MS. Each key starts the wait again. */
  swapAheadLater() {
    clearTimeout(this._swapTypedT);
    this._swapTypedT = setTimeout(() => { this._swapTypedT = null; this.swapAheadAsk(); }, this.SWAP_TYPED_MS);
  }

  /* The quote for the figure on the keypad, asked in the background, so the
   * confirmation can open with it (`swapNext`). One at a time: a figure
   * that changes while one is out waits for it, then is asked only if it
   * still differs. Paced as SWAP_AHEAD_GAP_MS and SWAP_AHEAD_PER_MIN say. A
   * changed figure leaves the old quote to expire at the mint: nothing was
   * committed by asking it. */
  swapAheadAsk() {
    const W = window.FoxyWallet;
    const s = this.state;
    if (!W || !W.swapQuote || s.screen !== 'amount' || s.flow !== 'swap') return;
    if (this.offlineNow() || !this.twoUnitsOn() || this._swapRun || s.swapBusy) return;
    const { from, to } = this.swapUnits();
    const amount = this.swapTyped();
    if (!(amount > 0) || amount > this.swapHave(from)) return;
    const had = this.swapAheadMine();
    if (had && (had.asking || this.swapAheadFor(had))) return;
    if (this._swapAheadOut) { this._swapAheadWaiting = true; return; }
    // the confirmation's own question still out (backed out of while it was asked): its answer first
    const wait = this._swapAskOut ? this.SWAP_TYPED_MS
      : (typeof W._swapPaceWait === 'function' ? W._swapPaceWait(this.SWAP_AHEAD_GAP_MS, this.SWAP_AHEAD_PER_MIN) : 0);
    if (wait > 0) {
      clearTimeout(this._swapTypedT);
      this._swapTypedT = setTimeout(() => { this._swapTypedT = null; this.swapAheadAsk(); }, wait);
      return;
    }
    let hurry = null;
    const mine = {
      from: from, to: to, amount: amount, keypad: this.swapKeypad(), mint: this.swapMintHere(),
      asking: true, q: null, at: Date.now(),
      // NEXT on this very figure: the person is waiting now, so its pace is let go (`_swapPaced`)
      hurry: () => { if (hurry) hurry(); },
    };
    this._swapAhead = mine;
    console.log('[foxy] swap: asking the rate for ' + this.unitFigure(amount, from) + ' as it is typed');
    const opts = Object.assign({ paceMs: this.SWAP_AHEAD_GAP_MS, perMin: this.SWAP_AHEAD_PER_MIN, hurry: new Promise((r) => { hurry = r; }) }, this.swapComing(from));
    const ask = this._swapAheadOut = W.swapQuote(from, to, amount, opts).then((q) => {
      mine.q = q;
      mine.asking = false;
    }, (e) => {
      // not said on screen: NEXT asks again and says why if it is refused there
      mine.asking = false;
      if (this._swapAhead === mine) this._swapAhead = null;
      console.log('[foxy] swap: the rate asked ahead did not come:', (e && e.message) || e);
    }).then(() => {
      if (this._swapAheadOut === ask) this._swapAheadOut = null;
      if (this._swapAheadWaiting) { this._swapAheadWaiting = false; this.swapAheadAsk(); }
    });
    mine.done = ask;
  }

  /* The keypad as it stands, unit and text: what a quote asked ahead is
   * matched on. Not the figure it converts to, because typed in the other
   * unit that moves with the mint's rate, and the quote's own answer moves
   * the rate, so the same keys would no longer match their own quote. */
  swapKeypad() {
    return (this.state.unit === 'SATS' ? 'SATS' : 'USD') + ' ' + String(this.state.amount || '');
  }

  /* The mint swaps are asked at now, in one spelling, to tell a quote
   * asked ahead at another mint from this one's. */
  swapMintHere() {
    const W = window.FoxyWallet;
    return String((W && W.mintUrl) || '').trim().replace(/\/+$/, '').toLowerCase();
  }

  /* Seconds a quote asked ahead can still be taken for, as `swapLeft`
   * counts them on the confirmation. */
  swapAheadLeft(a) {
    const q = a && a.q;
    if (!q || q.state !== 'quoted' || !(Number(q.expiresAt) > 0)) return 0;
    return Math.max(0, Math.floor((Number(q.expiresAt) - this.SWAP_MARGIN_MS - Date.now()) / 1000));
  }

  /* The quote asked ahead for the keypad as it stands, this way round and
   * at this mint, whether still on its way or answered; else null. */
  swapAheadMine() {
    const a = this._swapAhead;
    if (!a || a.from !== this.swapUnits().from || a.keypad !== this.swapKeypad()) return null;
    const here = this.swapMintHere();
    const at = a.q && a.q.mint ? String(a.q.mint).trim().replace(/\/+$/, '').toLowerCase() : a.mint;
    return a.mint === here && at === here ? a : null;
  }

  /* That quote, answered and still held long enough to be taken, or null. */
  swapAheadFor(a) {
    return a && a.q && this.swapAheadLeft(a) > this.SWAP_AHEAD_KEEP_S ? a : null;
  }

  /* The confirmation, opened on a quote asked ahead. Its hold counts on
   * from when it was asked; an answer still on its way to an older
   * question is dropped (`swapAsk`'s run). */
  swapAheadTake(a, from, to) {
    this._swapAskRun = (this._swapAskRun || 0) + 1;
    this._swapQuotedAt = a.at;
    console.log('[foxy] swap: quoted ' + this.unitFigure(a.q.total, from) + ' for ' + this.unitFigure(a.q.get, to)
      + ' (asked as it was typed)');
    this.setState({ swapQuoting: false, swapQuote: a.q, swapNewRate: false });
    this.swapClock();
  }

  /* NEXT on SET AMOUNT (or ALL OF IT): the confirmation, and the rate asked. */
  swapNext(all) {
    if (this.offlineNow()) { this.toast('Swapping needs the mint.', true); return; }
    const { from } = this.swapUnits();
    const have = this.swapHave(from);
    /* A quote asked ahead for these very keys is for the figure they meant
     * when it was asked: that figure is the swap's, even though its answer
     * has since moved the rate the keys would convert at. */
    const mine = all ? null : this.swapAheadMine();
    const amount = all ? have : mine ? mine.amount : this.swapTyped();
    if (!(amount > 0)) { this.toast('Type an amount first.', true); return; }
    if (amount > have) {
      this.toast('That is more than your ' + this.unitWord(from).toLowerCase() + ': you hold '
        + this.unitFigure(have, from) + '.', true);
      return;
    }
    clearTimeout(this._swapTypedT);
    this._swapTypedT = null;
    const { to } = this.swapUnits();
    const ahead = this.swapAheadFor(mine);
    const coming = !ahead && mine && mine.asking ? mine : null;
    this.setState(p => ({
      screen: 'swapConfirm', stack: p.stack.concat([p.screen]),
      swapAmount: amount, swapAll: !!all, swapQuote: null, swapNewRate: false,
      swapErr: '', swapErrAmount: false, swapRequotes: 0, swapLapsed: false,
      swapQuoting: !!coming,
    }));
    // asked while it was typed, and still held: the confirmation opens filled
    if (ahead) { this.swapAheadTake(ahead, from, to); return; }
    /* Being asked for this very figure already: its answer is waited for
     * rather than the same question asked twice. Too late or refused, the
     * rate is asked as it always was. */
    if (coming) {
      const run = (this._swapAskRun = (this._swapAskRun || 0) + 1);
      coming.hurry();
      coming.done.then(() => {
        if (run !== this._swapAskRun) return;
        if (this.state.screen !== 'swapConfirm') { this.setState({ swapQuoting: false }); return; }
        const got = this._swapAhead === coming ? this.swapAheadFor(coming) : null;
        if (got) this.swapAheadTake(got, from, to);
        else this.swapAsk(false, amount, !!all);
      });
      return;
    }
    // the amount handed over, not read back from state the same moment it was set
    // (a card's SWAP: ALL OF IT is the card's, asked as that figure, never as all of this phone's)
    this.swapAsk(false, amount, this._swapCard ? false : !!all);
  }

  /* The mint's rate for this swap. `again` is a rate asked for because the
   * last one ran out: the rows change under the person, so the button says
   * CONFIRM NEW RATE until it is pressed. Nothing moves by asking. */
  swapAsk(again, amountGiven, allGiven) {
    const W = window.FoxyWallet;
    const s = this.state;
    // a swap being run is not asked about again; a newer question replaces an older one (`run`)
    if (!W || !W.swapQuote || s.swapBusy || this._swapRun) return;
    const { from, to } = this.swapUnits();
    const amount = amountGiven != null ? amountGiven : (s.swapAmount || 0);
    const all = allGiven != null ? allGiven : !!s.swapAll;
    const run = (this._swapAskRun = (this._swapAskRun || 0) + 1);
    this.setState({ swapQuoting: true, swapErr: '', swapErrAmount: false, swapLapsed: false });
    // out with the mint until it answers: nothing is asked ahead beside it (`swapProbe`, `swapAheadAsk`)
    const asked = this._swapAskOut = W.swapQuote(from, to, amount, Object.assign(all ? { all: true } : {}, this.swapComing(from)));
    asked.then(() => {}, () => {}).then(() => { if (this._swapAskOut === asked) this._swapAskOut = null; });
    asked.then(q => {
      // an answer for an older question is dropped; one for a screen that has gone only ends the wait
      if (run !== this._swapAskRun) return;
      if (this.state.screen !== 'swapConfirm') { this.setState({ swapQuoting: false }); return; }
      console.log('[foxy] swap: quoted ' + this.unitFigure(q.total, from) + ' for ' + this.unitFigure(q.get, to)
        + (again ? ' (a new rate)' : ''));
      // (a card's SWAP: what the swap spends, its fee with it, comes off the card, which has to hold it)
      if (this._swapCard && Number(q.total) > this.swapHave(from)) {
        this.setState({ swapQuoting: false, swapQuote: null, swapErrAmount: true,
          swapErr: 'With the fee that is ' + this.unitFigure(q.total, from) + ', more than the card holds. Swap a little less.' });
        return;
      }
      this._swapQuotedAt = Date.now();
      this.setState({ swapQuoting: false, swapQuote: q, swapNewRate: !!again });
      this.swapClock();
    }).catch(e => {
      if (run !== this._swapAskRun) return;
      const why = W.reason ? W.reason(e) : String((e && e.message) || e);
      console.warn('[foxy] swap: no rate:', why);
      // an amount the mint will not swap is changed on the keypad; anything else is asked again
      const amountWrong = /too little|more than your|above zero/i.test(why);
      this.setState({ swapQuoting: false, swapQuote: null, swapErr: why, swapErrAmount: amountWrong });
    });
  }

  /* Seconds the rate on screen can still be taken, or 0. */
  swapLeft() {
    const q = this.state.swapQuote;
    if (!q || !(Number(q.expiresAt) > 0)) return 0;
    return Math.max(0, Math.floor((Number(q.expiresAt) - this.SWAP_MARGIN_MS - Date.now()) / 1000));
  }

  /* The countdown under the rate, ticking once a second while the
   * confirmation is up, and a new rate when it runs out. It stops by itself
   * as soon as the screen has gone, and as soon as there is no rate on it to
   * count (lapsed, refused, or dropped): no clock outlives what it is for. A
   * new rate starts it again (`swapAsk`). */
  swapClock() {
    if (this._swapClockT) return;
    this._swapClockT = setInterval(() => {
      const s = this.state;
      if (s.screen !== 'swapConfirm' || !s.swapQuote) {
        clearInterval(this._swapClockT);
        this._swapClockT = null;
        return;
      }
      if (s.swapQuoting || s.swapBusy) return;
      if (this.swapLeft() > 0) { this.setState({ swapTick: Date.now() }); return; }
      if ((s.swapRequotes || 0) >= this.SWAP_REQUOTES) {
        // left alone too long: wait for a tap rather than keep asking
        if (!s.swapLapsed) {
          console.log('[foxy] swap: the rate ran out with nobody looking; waiting for a tap');
          this.setState({ swapLapsed: true, swapQuote: null });
        }
        return;
      }
      console.log('[foxy] swap: the rate ran out, so a new one is asked for');
      this.setState({ swapRequotes: (s.swapRequotes || 0) + 1 });
      this.swapAsk(true);
    }, 1000);
  }

  /* SWAP (or CONFIRM NEW RATE): the swap, at the rate on screen. */
  swapGo() {
    const W = window.FoxyWallet;
    const s = this.state;
    const q = s.swapQuote;
    if (!q || s.swapBusy || s.swapQuoting || this._swapRun) return;
    // a card's SWAP: a tap at each end of this phone's own swap (26f-flashcard.js)
    if (this._swapCard && this.fcSwapGo) { this.fcSwapGo(q); return; }
    if (this.offlineNow()) { this.toast('Swapping needs the mint.', true); return; }
    /* A new rate has only just replaced the old one: a tap in that moment was
     * meant for the old rate, so it is not taken for the new one. */
    if (s.swapNewRate && Date.now() - (this._swapQuotedAt || 0) < 1500) return;
    if (this.swapLeft() <= 0) { this.swapAsk(true); return; }
    // and the same question every payment asks: nothing else is moving money
    if (this.moneyBusy()) {
      this.toast('Something else is moving money right now. Try again in a moment.', true);
      return;
    }
    const { from, to } = this.swapUnits();
    // the balances before, for the count-up on home once the screen is dismissed
    this._preSettle = this.balNow();
    this.setState({ swapBusy: true, swapNewRate: false, swapErr: '', swapErrAmount: false });
    this.showMelt('Swapping ' + this.unitWord(from).toLowerCase() + ' into ' + this.unitWord(to).toLowerCase() + '…', 120000);
    console.log('[foxy] swap: running ' + this.unitFigure(q.total, from) + ' into ' + this.unitFigure(q.get, to));
    this._swapRun = W.swapRun(q, (stage) => console.log('[foxy] swap: ' + stage)).then(r => {
      this._swapRun = null;
      this.hideMelt();
      this.refreshBalance();
      this.loadHistory();
      // the next probe from this balance asks at this size, the likeliest next figure
      this._swapLast = Object.assign({}, this._swapLast || {}, { [from]: Number(q.total) || 0 });
      if (r && r.state === 'done') {
        this.setState({ swapBusy: false, swapResult: r, screen: 'swapDone', stack: [] });
        return;
      }
      if (r && r.state === 'pending') { this.swapStillGoing(r); return; }
      // the mint would not take the payment: it is back in the balance, and nothing moved
      this._preSettle = null;
      this.setState({ swapBusy: false, swapQuote: null,
        swapErr: 'The mint did not make this swap. Nothing moved, and your ' + this.unitWord(from).toLowerCase()
          + ' are where they were.' });
    }).catch(e => {
      this._swapRun = null;
      this.hideMelt();
      this._preSettle = null;
      const why = W.reason ? W.reason(e) : String((e && e.message) || e);
      console.warn('[foxy] swap: did not run:', why);
      this.refreshBalance();
      if (e && e.expired) {
        // the rate ran out between the screen and the mint: a new one, said as one
        this.setState({ swapBusy: false, swapQuote: null });
        this.swapAsk(true);
        return;
      }
      if (e && e.offline) {
        this.setState({ swapBusy: false });
        this.toast('Swapping needs the mint.', true);
        return;
      }
      this.setState({ swapBusy: false, swapQuote: null, swapErr: why });
    });
  }

  /* One half paid and the other not answered yet: the card, and home, where
   * the held pill names what is with the mint until the wallet finishes it. */
  swapStillGoing(r) {
    this._preSettle = null;
    this.setState({ swapBusy: false, swapQuote: null, screen: 'home', stack: [] });
    this.swapPendingCard(r);
  }

  /* The card itself, wherever the person is: SWAP's own, and a swap into
   * dollars Foxy started by itself (`convertOnReturn`), which puts it over
   * home without taking anybody there. */
  /* `o.card`: a swap from a card (26f-flashcard.js, `fcSwapPending`): what the swap brings lands in this phone, and the
   * card says so, since the card itself is not tapped again for it. */
  swapPendingCard(r, o) {
    const from = (r && r.from) || {};
    const fig = this.unitFigure(Number(from.amount) || 0, from.unit === 'sat' ? 'sat' : 'usd');
    const to = (r && r.to && r.to.unit === 'sat') ? 'bitcoin' : 'dollars';
    this.blockedCard('swapPending', {
      tone: 'warn',
      title: 'SWAP STILL GOING THROUGH',
      reason: 'The mint has your ' + fig + ' and has not finished the swap yet. Foxy finishes it by itself '
        + 'the next time the mint answers.'
        + ((o && o.card) ? ' The ' + to + ' it brings goes to this phone; ADD FUNDS puts it on the card.' : ''),
      chip: 'Nothing is lost. Your balance shows it as pending with the mint until then.',
    });
  }

  /* Sats paid to a wallet that holds dollars, swapped into dollars at the mint.
   *
   * A person who chose dollars and was paid in sats (a payer with no dollars,
   * or with no route to pay the dollar invoice from bitcoin, by tap) is owed
   * the swap they would have made themselves. The wallet keeps which payments
   * those are and does the swap (`convertOne`, 16b-two-balances.js); this
   * decides when. Nobody is waiting on it, so it waits for a moment nothing
   * else is happening: online with the mint's own keys, not put away, no money
   * moving, no tap under way. One at a time, and `_swapRun` holds it, so SWAP,
   * a payment and a mint switch all wait for it as they wait for SWAP.
   *
   * Called when a claim puts such sats in the pile (`onConvertDue`), after the
   * sweeps on a return or a launch, when a route comes back and claims what
   * waited, and when a wallet built from storage connects for real. With money
   * moving it tries again a little later, a few times; past that, the next of
   * those moments picks it up. `due` is a fresh claim, which starts the count
   * again. */
  CONVERT_WAITS = 6;

  convertOnReturn(due) {
    const W = window.FoxyWallet;
    if (!W || !W.convertOne || !W.convertsOwed) return;
    if (due) this._convertWaits = 0;
    if (this._converting) return;
    clearTimeout(this._convertT);
    this._convertT = null;
    // with no route, put away, or on the keys from storage: a connect or a return brings it back here
    if (this.offlineNow() || !W.connected || (W.fromCache && W.fromCache()) || this._putAway) return;
    /* Nor in front of a person deciding to spend: on a confirmation, or on
     * SET AMOUNT for a payment, the pile they are looking at would move
     * under them, and SEND or SWAP would find it held. The small-change
     * top-up waits for put-away for the same reason. */
    const confirming = typeof CONFIRM_SCREENS !== 'undefined' ? CONFIRM_SCREENS : [];
    const deciding = confirming.indexOf(this.state.screen) >= 0
      || (this.state.screen === 'amount' && this.state.flow === 'send')
      || ['sendHow', 'swapConfirm', 'swap'].indexOf(this.state.screen) >= 0;
    if (this.moneyBusy() || this._tapTalking || this.state.tapArmed || deciding) { this.convertLater(); return; }
    /* The rate is judged against this phone's own price, and an old one is
     * no yardstick (`convertWantsPrice`): one is asked for first, once. */
    if (W.convertWantsPrice && W.convertWantsPrice() && this.convertWaiting()) {
      if (!this._convertPrice && W.rate) {
        const ask = this._convertPrice = W.rate({ fresh: true }).then(() => {}, () => {});
        ask.then(() => {
          this._convertPrice = null;
          if (W.convertWantsPrice()) this.convertLater(); else this.convertOnReturn();
        });
      }
      return;
    }
    /* In the units the payment came in and is swapped into: sats into dollars for a person holding dollars alone, and dollars
     * into bitcoin for one holding bitcoin alone (dollars a dollar card paid for sats asked). The record says which (`from`,
     * `to`); one from before records said is sats into dollars. */
    const said = (n, unit) => this.unitFigure(Math.round(Number(n) || 0), unit === 'usd' ? 'usd' : 'sat');
    const into = (unit) => (unit === 'sat' ? 'bitcoin' : 'dollars');
    const run = W.convertOne((stage, rec, q) => {
      if (stage !== 'start') return;
      const from = (rec && rec.from) || 'sat', to = (rec && rec.to) || 'usd';
      this.toast('You chose ' + into(to) + ', so Foxy is swapping the ' + said((rec && rec.got) || (q && q.total), from)
        + ' you were paid into ' + into(to) + '.');
    });
    this._swapRun = this._converting = run;
    run.then((r) => {
      if (this._swapRun === run) this._swapRun = null;
      this._converting = null;
      // nothing done: something held it (a swap with the mint, a top-up), or nothing is due
      if (!r) { this.convertLater(); return; }
      this._convertWaits = 0;
      const home = this.state.screen === 'home';
      if (r.outcome === 'done') {
        this.refreshBalance();
        this.loadHistory();
        if (home) this.settleAnimate('both');
      } else if (r.outcome === 'pending') {
        this.refreshBalance();
        this.loadHistory();
        if (home) this.swapPendingCard(r);
        else this.toast('The swap into ' + into((r.to && r.to.unit) || 'usd') + ' is still going through. Foxy finishes it by itself.', true);
      } else if (r.outcome === 'failed') {
        this.loadHistory();
        // once for each payment, however many times it is tried
        this._convertSaid = this._convertSaid || {};
        if (!this._convertSaid[r.id]) {
          this._convertSaid[r.id] = true;
          const got = r.rec && Number(r.rec.got) > 0 ? r.rec.got : (r.from && r.from.amount);
          const from = (r.from && r.from.unit) || 'sat', to = (r.to && r.to.unit) || 'usd';
          this.toast('Foxy could not swap the ' + said(got, from) + ' into ' + into(to) + ' just now. It stays as '
            + (from === 'usd' ? 'dollars' : 'bitcoin') + '.', true);
        }
      } else if (r.outcome === 'kept') {
        this.loadHistory();
      }
      // the next one, if another payment is waiting and has not had its go yet
      if (r.outcome !== 'offline' && this.convertWaiting()) {
        this._convertT = setTimeout(() => { this._convertT = null; this.convertOnReturn(); }, 1000);
      }
    }, () => {
      if (this._swapRun === run) this._swapRun = null;
      this._converting = null;
    });
  }

  // a payment in the pile, still to be swapped into dollars, that has not had its one go this launch
  convertWaiting() {
    const W = window.FoxyWallet;
    try { return (W.convertsOwed() || []).some(r => r && r.state === 'claimed' && !r.tried); }
    catch (e) { return false; }
  }

  /* Held by something else: a little later, a few times, longer each time.
   * Not while put away (the return asks), and not when nothing is waiting. */
  convertLater() {
    if (this._putAway || this._convertT || !this.convertWaiting()) return;
    const n = this._convertWaits = (this._convertWaits || 0) + 1;
    if (n > this.CONVERT_WAITS) {
      console.log('[foxy] sats to swap into dollars: still held after ' + this.CONVERT_WAITS + ' looks; left for the next connection');
      return;
    }
    this._convertT = setTimeout(() => { this._convertT = null; this.convertOnReturn(); }, Math.min(2000 * Math.pow(2, n - 1), 60000));
  }

  /* SWAPPED, dismissed: home, and both pills count to their new figures; a card's swap (26f-flashcard.js, `fcSwapOn`, which
   * leaves 'flashcard' under swapDone) goes back to the card's screen instead, where its pills already say what the tap wrote. */
  swapDoneClose() {
    const toCard = (this.state.stack || []).indexOf('flashcard') >= 0;
    this.setState({ screen: toCard ? 'flashcard' : 'home', stack: [], swapResult: null, swapQuote: null });
    // the card as its second tap wrote it, now that its screen is up to take it (26f-flashcard.js, `fcSwapOn`)
    // (taken either way: a card kept from a swap that closed onto home is never shown by a later swap's close)
    const wrote = this._fcSwapWrote;
    this._fcSwapWrote = null;
    if (toCard && wrote && this.fcShow) this.fcShow(wrote);
    if (!toCard) this.settleAnimate('both');
  }

  /* The wallet keeps a swap's rate as dollars per bitcoin; a row may carry it
   * as a number or as { usdPerBtc }. */
  swapRateOf(r) {
    const n = (r && typeof r === 'object') ? Number(r.usdPerBtc) : Number(r);
    return n > 0 ? n : 0;
  }

  /* "₿ 1 = $ 81,786", the way the screens say a rate. */
  swapRateText(n) { return '₿ 1 = $ ' + this.group(Math.round(n)); }

  /* "Forge's rate": whose rate it is, by the mint's own name. */
  swapRateWho() {
    const who = String(this.mintName() || 'the mint');
    return who + (/s$/i.test(who) ? '’' : '’s') + ' rate';
  }

  /* The same, as the confirmation's heading: FORGE’S RATE. */
  swapRateHead() { return this.swapRateWho().toUpperCase(); }

  /* "00:52": the time a rate is still held for, minutes and seconds. */
  swapClockText(sec) {
    const n = Math.max(0, Math.floor(Number(sec) || 0));
    return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  }

  /* An amount as the confirmation shows it, at `rate` dollars per bitcoin.
   * Dollars are exact, with no sats line. Bitcoin is its dollar worth with
   * the exact sats under it in brackets; with no rate it is the sats alone.
   * `cents` and `sats` are its worth in each, for the fee's sum. */
  swapWorth(n, unit, rate) {
    const amt = Math.max(0, Math.round(Number(n) || 0));
    const r = Number(rate) > 0 ? Number(rate) : 0;
    if (unit === 'usd') {
      return { main: this.unitFigure(amt, 'usd'), sub: '', cents: amt, sats: r ? Math.round(amt * 1e6 / r) : 0 };
    }
    if (!r) return { main: this.unitFigure(amt, 'sat'), sub: '', cents: 0, sats: amt };
    const cents = Math.round(amt * r / 1e6);
    return { main: this.swapCents(cents, amt), sub: '(' + this.unitFigure(amt, 'sat') + ')', cents: cents, sats: amt };
  }

  /* Dollars for something worth sats: not "$ 0.00" for a figure that is not
   * nothing, as `money` says it. */
  swapCents(cents, sats) {
    return (cents === 0 && sats > 0) ? '< $ 0.01' : this.unitFigure(cents, 'usd');
  }

  /* The ink a balance's figure is drawn in on a dark screen: frost for
   * dollars, fur for bitcoin. */
  swapInk(unit) { return unit === 'usd' ? '#D6EEF7' : '#F2742B'; }

  /* The rate line on SET AMOUNT for a swap, under the question: the mint's
   * own rate in the words the confirmation uses (<MINT>’S RATE ₿ 1 = $ ...),
   * "Checking the rate…" while the probe is out, and the market price,
   * said to be the market's, when the mint has given none lately
   * (SWAP_RATE_FRESH_MS). '' with no price at all. */
  swapRateLine() {
    if (this.state.swapProbing) return 'Checking the rate…';
    const W = window.FoxyWallet;
    let mint = 0;
    try {
      const r = W && W.mintRate ? W.mintRate() : null;
      if (r && Date.now() - Number(r.at) < this.SWAP_RATE_FRESH_MS) mint = this.swapRateOf(r);
    } catch (e) { mint = 0; }
    if (mint > 0) return this.swapRateHead() + ' ' + this.swapRateText(mint);
    const market = this.px() || 0;
    return market > 0 ? 'MARKET PRICE ' + this.swapRateText(market) : '';
  }

  /* The line under the keypad's figure, in the other unit, as a send has it.
   * Typed in the unit that leaves: about what the swap would give, at the
   * mint's last rate (or the market's). Typed in the other: what leaves,
   * exactly as it will be asked for. '' with nothing to say. */
  swapEstimate() {
    const { from, to } = this.swapUnits();
    const n = this.swapTyped();
    if (!(n > 0)) return '';
    if (!this.swapExact()) return this.unitFigure(n, from);
    const rate = this.swapPx();
    if (!(rate > 0)) return '';
    const got = from === 'usd' ? Math.floor(n / 100 / rate * 1e8) : Math.floor(n * rate / 1e8 * 100);
    return '≈ ' + this.unitFigure(got, to);
  }

  /* The confirmation's contents (confirmSpec), in the four blocks the owner
   * laid out, top to bottom: YOU ARE GETTING, YOU ARE SPENDING, FEE, and the
   * mint's RATE with how long it is held for. No NETWORK row, since a swap
   * never leaves the mint, and no TOTAL, since what is spent is its own
   * block. The fee is the mint's whole cost of the swap: what leaves less
   * what arrives, both at the quote's rate, in dollars with the sats under
   * it, so the three figures add up as read. */
  /** @returns {ConfirmSpec} */
  swapSpec() {
    const s = this.state;
    const { from, to } = this.swapUnits();
    const q = s.swapQuote;
    const block = (label, w, unit, opt) => this.cfRow(label, unit ? w.main + ' in ' + this.unitWord(unit) : w.main,
      Object.assign({ sub: w.sub }, opt || {}));
    // what arrives is the headline: a size up, in the ink of the balance it lands in
    const getOpt = { ink: this.swapInk(to), size: '30px' };
    const base = {
      title: 'SWAP', titleUp: true, amountLabel: '', amount: '',
      // a card's swap closes onto the card's screen it came from (26f-flashcard.js, `fcSwapOn` leaves 'flashcard' under swapDone)
      close: () => this.setState(p => ({ screen: p.stack.indexOf('flashcard') >= 0 ? 'flashcard' : 'home', stack: [] })),
    };
    if (!q) {
      /* No rate yet: what leaves, and the rest waiting on the mint. Bitcoin
       * leaving is shown as the keypad showed it, in dollars at the mint's
       * last rate with the exact sats under it (`swapPx`); with no price at
       * all it is the sats alone, with no unit word to make it read as a
       * dollar figure. */
      const word = s.swapQuoting ? 'CHECKING…' : 'UNKNOWN';
      const guess = this.swapPx();
      const spent = this.swapWorth(s.swapAmount || 0, from, guess);
      const wrong = !s.swapQuoting && !s.swapLapsed;
      const rows = [
        this.cfRow('YOU ARE GETTING', word, getOpt),
        block('YOU ARE SPENDING', spent, (from === 'usd' || guess > 0) ? from : '', wrong ? { ink: '#FF5C5C' } : {}),
        this.cfRow('FEE', word),
        this.cfRow(this.swapRateHead(), word),
      ];
      if (s.swapQuoting) {
        return Object.assign(base, { rows: rows,
          cta: 'CHECKING THE RATE…', ctaBusy: true, ctaTone: 'go', go: () => {} });
      }
      if (s.swapLapsed) {
        return Object.assign(base, { rows: rows,
          chip: 'The rate ran out. Nothing moved.',
          cta: 'GET A NEW RATE', ctaTone: 'go',
          go: () => { this.setState({ swapRequotes: 0 }); this.swapAsk(true); } });
      }
      return Object.assign(base, { rows: rows,
        warn: s.swapErr || 'The mint has not given a rate yet.',
        cta: s.swapErrAmount ? 'CHANGE AMOUNT' : 'TRY AGAIN', ctaTone: 'warn',
        go: () => { if (s.swapErrAmount) this.back(); else this.swapAsk(false); } });
    }
    const rate = this.swapRateOf(q.rate);
    const market = this.swapRateOf(q.market);
    const got = this.swapWorth(q.get, to, rate);
    const spent = this.swapWorth(q.total, from, rate);
    // with no rate to put the two sides in one unit, the mint's own fee in the unit that leaves
    const fee = rate > 0
      ? (() => {
        const c = Math.max(0, spent.cents - got.cents), n = Math.max(0, spent.sats - got.sats);
        return { main: this.swapCents(c, n), sub: '(' + this.unitFigure(n, 'sat') + ')' };
      })()
      : { main: this.unitFigure(q.fee, from), sub: '' };
    const rows = [
      block('YOU ARE GETTING', got, to, getOpt),
      block('YOU ARE SPENDING', spent, from),
      block('FEE', fee, ''),
      this.cfRow(this.swapRateHead(), rate > 0 ? this.swapRateText(rate) : 'UNKNOWN', {
        sub: 'Rate held for ' + this.swapClockText(this.swapLeft()),
        // far from the market price: the market's, in red, under the mint's
        sub2: (q.spreadWarn && market > 0) ? 'Market ' + this.swapRateText(market) : '',
        sub2Ink: '#FF5C5C',
      }),
    ];
    return Object.assign(base, {
      rows: rows,
      warn: s.swapErr || '',
      cta: s.swapBusy ? 'SWAPPING…' : s.swapNewRate ? 'CONFIRM NEW RATE' : 'SWAP',
      ctaBusy: !!s.swapBusy,
      // green, as PAY is drawn: money moves when it is pressed
      ctaTone: 'money',
      go: () => this.swapGo(),
    });
  }

  /* The SWAP screen and SWAPPED, for the template. */
  /** @param {RenderContext} c */
  renderSwap(c) {
    const { s, sc } = c;
    const LOOK = {
      usd: { bg: 'radial-gradient(circle at 18% 30%,rgba(255,255,255,.07) 0 1.2px,transparent 1.2px),'
        + 'radial-gradient(circle at 62% 70%,rgba(255,255,255,.06) 0 1.2px,transparent 1.2px),linear-gradient(160deg,#D6EEF7,#B9DCEA)',
        ink: '#10161B', inkRgb: '16,22,27', blend: 'normal', sym: '$' },
      sat: { bg: "linear-gradient(160deg,rgba(255,255,255,.18) 0%,rgba(255,255,255,0) 45%,rgba(0,0,0,.22) 100%),"
        + "url('foxy-fur.webp') center/150% auto no-repeat,linear-gradient(160deg,#F2742B,#D9561A)",
        ink: '#FFFFFF', inkRgb: '255,255,255', blend: 'normal,soft-light,normal', sym: '₿' },
    };
    const on = sc === 'swap' || sc === 'swapDone';
    const { from, to } = this.swapUnits();
    const pill = (label, u, text) => Object.assign({}, LOOK[u], {
      label: label, name: this.unitWord(u), text: text,
    });
    const rows = sc === 'swap' ? [
      pill('FROM', from, s.hidden ? '••••••' : this.unitFigure(this.swapHave(from), from)),
      pill('TO', to, s.hidden ? '••••••' : this.unitFigure(this.swapHave(to), to)),
    ] : [];
    const r = s.swapResult || null;
    const done = (sc === 'swapDone' && r) ? [
      pill('FROM', r.from && r.from.unit === 'sat' ? 'sat' : 'usd',
        '−' + this.unitFigure(Math.abs(Number(r.from && r.from.amount) || 0), r.from && r.from.unit === 'sat' ? 'sat' : 'usd')),
      pill('TO', r.to && r.to.unit === 'sat' ? 'sat' : 'usd',
        '+' + this.unitFigure(Math.abs(Number(r.to && r.to.amount) || 0), r.to && r.to.unit === 'sat' ? 'sat' : 'usd')),
    ] : [];
    const rate = r ? this.swapRateOf(r.rate) : 0;
    const feeUnit = r && r.from && r.from.unit === 'sat' ? 'sat' : 'usd';
    const FUR_CTA = "radial-gradient(120% 84% at 26% 0%,rgba(255,240,220,.26),rgba(255,240,220,0) 62%),"
      + "linear-gradient(168deg,rgba(247,154,60,.62),rgba(232,98,42,.72) 48%,rgba(194,74,27,.78)),url('foxy-fur.webp')";
    const canGo = sc === 'swap' && !this.offlineNow() && this.swapHave(from) > 0;
    return {
      isSwap: sc === 'swap',
      swapRows: rows,
      swapFlipGo: () => this.swapFlip(),
      swapBackGo: () => this.back(),
      swapCloseGo: () => this.setState(p => ({ screen: p.stack.indexOf('flashcard') >= 0 ? 'flashcard' : 'home', stack: [] })),
      swapNextGo: () => this.swapToAmount(),
      swapFoot: !on ? '' : this.offlineNow() ? 'Swapping needs the mint.'
        : 'At ' + this.swapRateWho() + '. You see the rate and the fee before anything moves.',
      swapNextBg: canGo ? 'var(--acc)' : 'rgba(var(--ink-rgb),.14)',
      swapNextFur: canGo ? FUR_CTA : 'none,none,none',
      swapNextInk: canGo ? '#fff' : 'rgba(var(--ink-rgb),.4)',
      swapNextSh: canGo ? 'inset 0 2px 0 rgba(255,255,255,.4),inset 0 -4px 0 rgba(0,0,0,.16),0 12px 24px rgba(var(--acc-rgb),.34)' : 'none',
      isSwapDone: sc === 'swapDone',
      swapDoneRows: done,
      swapDoneNote: !r ? '' : 'Fee ' + this.unitFigure(Math.max(0, Number(r.fee) || 0), feeUnit)
        + (rate > 0 ? ' · ' + this.swapRateText(rate) : ''),
      swapDoneGo: () => this.swapDoneClose(),
    };
  }
