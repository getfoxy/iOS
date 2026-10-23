  /* ---- a card's set-up: its questions, in order, and the wheel ------------------------------------------------------
   *
   * The owner's set-up of a card (software 1.21 and on, which holds no money without a PIN), in his own order:
   *
   *   CREATE A PIN       the PIN pad every card PIN is typed on (`fcAskPin`), four to eight digits
   *   RE-ENTER PIN       the same again; two that differ start it again
   *   CURRENCY           what the card holds, on the CURRENCY screen (`fcUnitAsk`), at a mint with two balances; at a mint
   *                      with one, nothing is asked and the card holds bitcoin. Its rows are FC_SETUP_UNITS: a third, a card
   *                      that holds both, is a row to add there when cards hold two balances, which none does yet
   *   SMALL AMOUNTS      "Do you want to pay small amounts without entering your PIN?" YES or NO; YES turns the wheel for
   *                      how much (the no-PIN allowance)
   *   MAX PER TAP        "Do you want to set a max per tap?" YES or NO; YES turns the wheel for the limit on one payment,
   *                      with the line "It will take N seconds to pay $X." under it
   *
   * Both wheels are in the card's own money, as the owner asked: a dollar card's in dollars and nothing else; a bitcoin card's in
   * dollars or in sats, by a DOLLARS / SATS switch above the wheel (dollars first where this phone has a price; sats alone where it
   * has none, since dollars could not be turned into the sats the card holds), the other shown under each figure. What the card is
   * sent is what it takes, whichever is chosen: cents for a dollar card, sats for a bitcoin card.
   *   the tap            one tap writes all of it (`fcSetUpStepsRun`), with Keep holding on the sheet while the card holds
   *
   * The same steps set a card up for somebody else, from SEND > FLASHCARD on a new card (`fcSendSetUp`): the holder types the
   * PIN on this phone, and the words say it is theirs; what the card holds is what is being sent, so CURRENCY is not asked; and
   * the tap writes no owner and no key of this phone's, then the money under the holder's PIN.
   *
   * The way back is the round back button of the pad and of the wheel: one step back, and from the first, to where the set-up
   * began. A question's card goes when it is tapped beside, and the set-up with it. */

  /* What a card can hold, as the set-up's CURRENCY step offers it, in order. */
  FC_SETUP_UNITS = ['usd', 'sat'];

  /* The wheel's figures. A dollar card's in dollars (its cents), with nothing under them. A bitcoin card's in the unit chosen on the
   * switch: dollars, with their sats at this phone's price under each, or sats, with their dollars under each where there is a price.
   * The no-PIN amount is $0 to $20, $2 unless turned (or 0 to 20,000 sats, 2,000); the limit on one payment is $1 to $100, $10 unless
   * turned (or 1,000 to 100,000 sats, 10,000). */
  FC_WHEEL = {
    noPin: { usd: [0, 0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 12.5, 15, 20], usdAt: 2,
             sat: [0, 250, 500, 1000, 2000, 3000, 5000, 10000, 20000], satAt: 2000 },
    tap: { usd: [1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100], usdAt: 10,
           sat: [1000, 2000, 5000, 10000, 20000, 50000, 100000], satAt: 10000 },
  };
  // the height of one figure on the wheel, in pixels, and how many are in sight
  FC_WHEEL_ROW = 64;
  FC_WHEEL_SHOW = 5;

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
      this.fcUnitAsk((unit) => { su.unit = unit; this.fcSuNoPin(); });
      return;
    }
    this.fcSuNoPin();
  }

  /* The unit the card will hold, for the wheel's figures: what was chosen, or bitcoin. */
  fcSuUnitNow() {
    const su = this._fcSu;
    return (su && su.unit === 'usd') ? 'usd' : 'sat';
  }

  fcSuNoPin() {
    const su = this._fcSu;
    if (!su) return;
    this.blockedCard('fc-su-nopin', {
      tone: 'ask', title: 'SMALL AMOUNTS',
      reason: 'Do you want to pay small amounts without entering your PIN?',
      retry: 'YES', go: () => this.fcSuWheel('noPin', () => this.fcSuNoPin(), () => this.fcSuTap()),
      shut: { label: 'NO', pill: true, tap: () => { su.noPin = 0; su.noPinUsd = 0; this.fcSuTap(); } },
    });
  }

  fcSuTap() {
    const su = this._fcSu;
    if (!su) return;
    this.blockedCard('fc-su-tap', {
      tone: 'ask', title: 'MAX PER TAP',
      reason: 'Do you want to set a max per tap?',
      retry: 'YES', go: () => this.fcSuWheel('tap', () => this.fcSuTap(), () => this.fcSuGo()),
      shut: { label: 'NO', pill: true, tap: () => { su.tapLimit = 0; su.tapUsd = 0; this.fcSuGo(); } },
    });
  }

  /* The wheel for one of the two (`which`: 'noPin' or 'tap'), in the card's unit. `back` is the question again, `next` the
   * step after. */
  fcSuWheel(which, back, next) {
    const su = this._fcSu;
    if (!su) return;
    const rows = this.fcWheelRows(which, this.fcSuUnitNow(), su.as);
    const tap = which === 'tap';
    /* A bitcoin card's figures in dollars or in sats, by the switch (where this phone has a price to turn dollars into sats); the
     * choice stands for the other wheel of the same set-up. A dollar card has no switch: dollars and nothing else. */
    const both = rows.unit === 'sat' && ((this.px && this.px()) || 0) > 0;
    this.fcWheel({
      title: tap ? 'MAX PER TAP' : 'NO PIN AMOUNT',
      question: tap ? 'The most the card pays in one tap straight away. More than this waits, and the card is held longer.'
        : 'Up to this much, the card pays with a tap and no PIN.',
      rows: rows.list, at: rows.at,
      units: both ? { at: rows.as, pick: (as) => { su.as = as; this.fcSuWheel(which, back, next); } } : null,
      line: tap ? (r) => this.fcWaitLine(r.amount, rows.unit, rows.as) : null,
      cta: (r) => 'SET ' + r.main,
      back,
      done: (r) => {
        if (tap) { su.tapLimit = r.amount; su.tapUsd = r.usd; } else { su.noPin = r.amount; su.noPinUsd = r.usd; }
        next();
      },
    });
  }

  /* The wheel's rows for `which` on a card that holds `unit`, its figures in `as` ('usd' or 'sat', a bitcoin card's choice on the
   * switch; dollars where none is made and there is a price): [{ amount (the card's unit), usd (the dollars it was chosen in, for a
   * bitcoin card; 0 otherwise, so a figure chosen in sats is not kept at any dollars), main, sub }], where it stands at first, and
   * `as`, the unit its figures are in. A dollar card's are dollars and nothing else, whatever the price. */
  fcWheelRows(which, unit, as) {
    const spec = this.FC_WHEEL[which];
    const px = (this.px && this.px()) || 0;
    if (unit === 'usd') {
      const list = spec.usd.map((d) => ({ amount: Math.round(d * 100), usd: 0, main: '$' + this.usd(d), sub: '' }));
      return { list, at: Math.max(0, spec.usd.indexOf(spec.usdAt)), unit, as: 'usd' };
    }
    if (px > 0 && as !== 'sat') {
      const list = spec.usd.map((d) => {
        const sats = Math.round(d / px * 1e8);
        return { amount: sats, usd: d, main: '$' + this.usd(d), sub: '₿ ' + this.group(sats) };
      });
      return { list, at: Math.max(0, spec.usd.indexOf(spec.usdAt)), unit, as: 'usd' };
    }
    // in sats: chosen so, or with no price to say dollars at; their dollars under them where there is one
    const list = spec.sat.map((n) => ({ amount: n, usd: 0, main: '₿ ' + this.group(n), sub: px > 0 ? '$' + this.usd(n / 1e8 * px) : '' }));
    return { list, at: Math.max(0, spec.sat.indexOf(spec.satAt)), unit, as: 'sat' };
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
    if (c.unit) how.unit = c.unit;
    this.fcTap({}, (link, on) => { on('writing'); how.onHold = () => on('writing'); return W.cardSetUp(link, how); })
      .then((card) => {
        this.fcShow(card);
        this.haptic && this.haptic('success');
        this.toast(c.unit === 'usd' ? 'The card is set up. It holds dollars.' : 'The card is set up.');
      }, (e) => this.fcFailed(e, { again: () => this.fcSetUpStepsRun(c) }));
  }

  /* A wheel of amounts to turn, for a figure the owner asked to be chosen this way ("price is right"): one figure in the band at
   * the middle, dollars first and their sats under them, turned by a finger or chosen by a tap. The round back button at the top
   * left, as on every screen; one button under it that says what it sets ("SET $2.00"). `o`: { title, question, rows, at, line,
   * cta, back, done, units } — `rows` [{ main, sub, ... }], `at` the row it stands at first, `line(row)` the words under the wheel or
   * null, `cta(row)` the button's words, `done(row)` on the button, `back()` on back, and `units` { at, pick(as) } for a bitcoin
   * card's DOLLARS / SATS switch above the wheel ('usd' or 'sat'), or null for none. */
  fcWheel(o) {
    this.fcWheelDismiss();
    const el = (style, text) => {
      const d = document.createElement('div');
      d.style.cssText = style;
      if (text != null) d.textContent = text;
      return d;
    };
    const ROW = this.FC_WHEEL_ROW, SHOW = this.FC_WHEEL_SHOW;
    const root = el('position:fixed;inset:0;z-index:2147483647;background:var(--bg,#050505);display:flex;flex-direction:column;'
      + 'align-items:center;padding:118px 26px 26px;box-sizing:border-box;font-family:SatSymbol,Sora,system-ui,sans-serif;animation:foxyIn .16s ease');
    root.setAttribute('data-wheel', '1');
    root.appendChild(el('font-size:26px;font-weight:800;letter-spacing:-0.02em;color:var(--ink,#F5F1EC);text-align:center', o.title || ''));
    root.appendChild(el('margin-top:10px;font-size:17px;font-weight:500;line-height:1.4;color:rgba(245,241,236,.6);text-align:center;text-wrap:pretty',
      o.question || ''));
    /* The switch between dollars and sats, in the pill the screens' chips are drawn in: the unit chosen filled, the other plain. A tap
     * on the other turns the wheel into it. */
    if (o.units) {
      const sw = el('margin-top:18px;flex:none;display:flex;gap:4px;padding:4px;border-radius:999px;background:var(--frost-chip,rgba(245,241,236,.08));'
        + 'border:1px solid var(--frost-chip-edge,rgba(245,241,236,.16));box-sizing:border-box');
      sw.setAttribute('data-wheel-units', '1');
      [['usd', 'DOLLARS'], ['sat', 'SATS']].forEach(([key, label]) => {
        const on = o.units.at === key;
        const seg = el('padding:8px 18px;border-radius:999px;font-size:15px;font-weight:800;letter-spacing:0.04em;cursor:pointer;'
          + (on ? 'background:var(--ink,#F5F1EC);color:var(--bg,#050505)' : 'color:rgba(245,241,236,.6)'), label);
        seg.setAttribute('data-wheel-unit', key);
        seg.setAttribute('role', 'button');
        if (on) seg.setAttribute('aria-pressed', 'true');
        seg.addEventListener('click', () => { if (!on) { this.haptic && this.haptic('light'); o.units.pick(key); } });
        sw.appendChild(seg);
      });
      root.appendChild(sw);
    }
    const frame = el('position:relative;margin-top:30px;width:100%;max-width:336px;height:' + (ROW * SHOW) + 'px;flex:none');
    frame.appendChild(el('position:absolute;left:0;right:0;top:' + (ROW * Math.floor(SHOW / 2)) + 'px;height:' + ROW + 'px;border-radius:20px;'
      + 'background:rgba(245,241,236,.08);border:1.5px solid rgba(242,128,46,.65);box-sizing:border-box;pointer-events:none'));
    const list = el('position:absolute;inset:0;overflow-y:auto;scroll-snap-type:y mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;'
      + 'padding:' + (ROW * Math.floor(SHOW / 2)) + 'px 0;box-sizing:border-box;'
      + '-webkit-mask-image:linear-gradient(180deg,transparent,#000 32%,#000 68%,transparent);mask-image:linear-gradient(180deg,transparent,#000 32%,#000 68%,transparent)');
    list.setAttribute('data-wheel-list', '1');
    const rows = (o.rows || []).map((r, i) => {
      const row = el('height:' + ROW + 'px;scroll-snap-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer');
      row.setAttribute('data-wheel-row', String(i));
      const main = el('font-size:28px;font-weight:800;letter-spacing:-0.01em;color:var(--ink,#F5F1EC);transition:opacity .12s ease', r.main);
      main.setAttribute('data-wheel-main', '1');
      row.appendChild(main);
      if (r.sub) row.appendChild(el('font-size:14px;font-weight:600;color:rgba(245,241,236,.5)', r.sub));
      list.appendChild(row);
      return row;
    });
    frame.appendChild(list);
    root.appendChild(frame);
    const line = el('margin-top:22px;min-height:24px;font-size:17px;font-weight:600;line-height:1.4;color:rgba(245,241,236,.75);text-align:center');
    line.setAttribute('data-wheel-line', '1');
    root.appendChild(line);
    // the SET AMOUNT screen's NEXT, as the PIN pad's button is (10-pin.js): it can always be pressed, since a figure is always chosen
    const cta = el('margin-top:auto;align-self:stretch;margin-left:2px;margin-right:2px;height:60px;border-radius:30px;display:flex;align-items:center;'
      + 'justify-content:center;font-family:SatSymbol,Sora,sans-serif;font-size:22px;font-weight:800;letter-spacing:0.02em;color:#fff;cursor:pointer;'
      + 'background-color:var(--acc,#E8622A);background-image:radial-gradient(120% 84% at 26% 0%,rgba(255,240,220,.26),rgba(255,240,220,0) 62%),'
      + "linear-gradient(168deg,rgba(247,154,60,.62),rgba(232,98,42,.72) 48%,rgba(194,74,27,.78)),url('foxy-fur.webp');"
      + 'background-repeat:no-repeat,no-repeat,no-repeat;background-size:auto,auto,150% auto;background-position:center,center,50% 34%;'
      + 'box-shadow:inset 0 2px 0 rgba(255,255,255,.4),inset 0 -4px 0 rgba(0,0,0,.16),0 12px 24px rgba(232,98,42,.34);white-space:nowrap');
    cta.setAttribute('data-wheel-cta', '1');
    root.appendChild(cta);
    let at = Math.max(0, Math.min(rows.length - 1, Math.round(Number(o.at) || 0)));
    const pick = (i, turn) => {
      at = Math.max(0, Math.min(rows.length - 1, i));
      rows.forEach((row, k) => { /** @type {any} */ (row.firstChild).style.opacity = k === at ? '1' : '.38'; });
      const r = o.rows[at];
      line.textContent = (typeof o.line === 'function' && r) ? o.line(r) : '';
      cta.textContent = r ? o.cta(r) : '';
      if (turn) { try { list.scrollTop = at * ROW; } catch (e) {} }
    };
    // where the finger leaves it, the figure in the band; a little after the last movement, so a fling settles first
    let settle = null;
    list.addEventListener('scroll', () => {
      clearTimeout(settle);
      settle = setTimeout(() => { if (this._fcWheelEl === root) pick(Math.round(list.scrollTop / ROW), false); }, 90);
    }, { passive: true });
    rows.forEach((row, i) => row.addEventListener('click', () => { pick(i, true); this.haptic && this.haptic('light'); }));
    cta.addEventListener('click', () => {
      const r = o.rows[at];
      this.fcWheelDismiss();
      if (r && typeof o.done === 'function') o.done(r);
    });
    const b = el('position:absolute;left:22px;top:56px;width:52px;height:52px;border-radius:50%;'
      + 'background:linear-gradient(180deg,var(--lift,#2A2B2E),var(--sink,#151618)),var(--chip,#1C1D20);'
      + 'border-top:1px solid var(--lift-edge,rgba(255,255,255,.14));'
      + 'box-shadow:inset 0 2px 0 var(--lift-edge,rgba(255,255,255,.14)),inset 0 -3px 0 var(--sink-edge,rgba(0,0,0,.5)),0 8px 16px rgba(0,0,0,.34);'
      + 'box-sizing:border-box;display:flex;align-items:center;justify-content:center;cursor:pointer');
    b.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--ink,#F5F1EC)" '
      + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12H5m0 0 6-6m-6 6 6 6"></path></svg>';
    b.setAttribute('data-wheel-back', '1');
    b.setAttribute('role', 'button');
    b.setAttribute('aria-label', 'Back');
    b.addEventListener('click', () => { this.fcWheelDismiss(); if (typeof o.back === 'function') o.back(); });
    root.appendChild(b);
    document.body.appendChild(root);
    this._fcWheelEl = root;
    pick(at, true);
    return root;
  }

  fcWheelDismiss() {
    if (this._fcWheelEl) { this._fcWheelEl.remove(); this._fcWheelEl = null; }
  }
