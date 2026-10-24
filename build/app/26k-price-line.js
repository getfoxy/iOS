  /* ---- a payment across units: the line under the big number -------------
   *
   * The design's rule: when a payment crosses units, a dollar
   * holder paying an ask in sats or the other way round, the big number is
   * the unit the payer holds, and under it one line says how far that is from
   * what the ask would be at the asker's own bitcoin price, with how old each
   * price is in the app's age words (`priceAgeWords`):
   *
   *   "$ 0.05 more than asked: their rate differs from yours, theirs from 3 hours ago"
   *
   * At a difference of 2 % or more between the two prices the line is the
   * amber notice (the amount screen's price warning, in its colour). A
   * payment in one unit shows none of this, and nor does one where the
   * asker's price is not known: a request asking in dollars carries none (an
   * offline phone does not tell a stranger when it was last online,
   * 20-helpers.js `paymentRequest`), and a tap offer carries the receiver's
   * only when it is current and the receive is in bitcoin (26d-tap.js,
   * `tapOffering`).
   *
   * `o`: { askUnit, askAmount (in the ask's unit: sats, or cents), payUnit,
   *        askerRate, askerAgeMs, payerRate, payerAgeMs, side, ownWord,
   *        slackCents }.
   * `side` is which of the two this phone is: 'pay' (the default) or 'ask'.
   * "their" is always the other phone's price and "yours" this phone's, or
   * `ownWord` where the price on this side is not the person's own ('the
   * mint’s', when the mint converts a payer's dollars).
   * `slackCents`: how much of the difference can be rounding and not price.
   * The mint quotes dollars in whole cents, rounded up, so the rate worked
   * out from its quote (`rateFrom`) is off by up to a cent of the payment: on
   * 333 sats a 34¢ quote reads as a 2 % dearer price when the price is the
   * same. That cent is taken off the difference before deciding whether to
   * say anything, and the 2 % is of what is left; the sum named is the whole
   * difference, which is what the payer pays over the ask.
   * A difference that comes to less than a cent says nothing: there is no
   * sum to name.
   * Null, or { text, amber, pct }. */
  priceDiffLine(o) {
    if (!o) return null;
    const askU = o.askUnit === 'usd' ? 'usd' : 'sat';
    const payU = o.payUnit === 'usd' ? 'usd' : 'sat';
    if (askU === payU) return null;
    const ra = Number(o.askerRate) || 0;
    const rp = Number(o.payerRate) || 0;
    const n = Math.round(Number(o.askAmount) || 0);
    if (!(ra > 0) || !(rp > 0) || !(n > 0)) return null;
    const pct = ((rp - ra) / ra) * 100;
    // under a tenth of a percent is the same price, as the BITCOIN PRICE screen reads it (`priceSpec`)
    if (Math.abs(pct) < 0.1) return null;
    /* In dollars, whichever way round. Sats for a dollar ask: the sats the
     * payer's price makes of it, valued at the asker's, less what was asked.
     * Dollars for a sat ask: the sats at the payer's price, less the same sats
     * at the asker's. More is the payer paying more than the asker asked. */
    const cents = askU === 'usd' ? n * (ra / rp - 1) : (n / 1e8) * (rp - ra) * 100;
    const slack = Math.max(0, Number(o.slackCents) || 0);
    const net = Math.abs(cents) - slack;
    // said only when what is left past the rounding is a cent or more; and then the whole difference is named
    if (!(Math.round(net) >= 1)) return null;
    const size = Math.round(Math.abs(cents));
    // the prices' difference, less the part rounding could make
    const netPct = Math.abs(pct) * (net / Math.abs(cents));
    if (netPct < 0.1) return null;
    const ageOf = (ms) => (ms == null || !this.priceAgeWords ? '' : String(this.priceAgeWords(Number(ms)) || '').toLowerCase());
    const asking = o.side === 'ask';
    const theirAge = ageOf(asking ? o.payerAgeMs : o.askerAgeMs);
    const ownAge = ageOf(asking ? o.askerAgeMs : o.payerAgeMs);
    const own = o.ownWord || 'yours';
    const ages = [theirAge ? 'theirs from ' + theirAge : '', ownAge ? own + ' from ' + ownAge : ''].filter(Boolean).join(', ');
    return {
      text: this.unitFigure(size, 'usd') + ' ' + (cents > 0 ? 'more' : 'less') + ' than asked: their rate differs from '
        + own + (ages ? ', ' + ages : ''),
      amber: netPct >= 2,
      pct,
    };
  }
