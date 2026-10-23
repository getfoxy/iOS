    /* ---- sending ------------------------------------------------------- */

    /* Melt: hand proofs to the mint, it pays the invoice.
     * The fee reserve is a ceiling, not a price — whatever routing did not use
     * comes back as change, which is why the change proofs are stored below. */
    /* opts.payee: the lightning address this invoice was fetched for, kept
     * with the hold so a second payment to that address can be refused while
     * the first is unsettled — each fetch returns a fresh invoice, so the
     * invoice alone never matches. */
    pay: function (bolt11, onStage, opts) {
      var stage = typeof onStage === 'function' ? onStage : function () {};
      var inv = String(bolt11 || '').trim().replace(/^lightning:/i, '');
      if (!/^ln(bc|tb|bcrt)/i.test(inv)) {
        return Promise.reject(new Error('That is not a Lightning invoice.'));
      }
      /* From a unit: 'sat' (the default, as every call before units) or
       * 'usd'. A usd payment melts usd ecash (NUT-05 in usd): the mint quotes
       * the invoice in cents, takes cents, and gives change in cents. The
       * invoice itself is in bitcoin as every invoice is; the mint converts
       * at its rate. */
      var unit = unitOf(opts && opts.unit);
      var refused = unitRefusal(opts && opts.unit);
      if (refused) return Promise.reject(refused);
      var w;
      // on the circuit kept ready, when there is one (`needNow`)
      try { w = needNow(); } catch (e) { return Promise.reject(e); }

      /* An invoice with no amount on it, and the amount the person typed.
       *
       * Foxy used to refuse these outright, on the grounds that "LNbits needs
       * the amount at pay time, which is a different call" — a note from before
       * Foxy paid through a mint at all. NUT-05 has the call: a mint that
       * advertises `options.amountless` for this method and unit takes an
       * `amount_msat` beside the request, and cashu-ts passes it through
       * (`supportsAmountless`, `createMeltQuoteBolt11`). A zero-amount invoice
       * is what an LNURL withdrawal and most "pay me what you like" links hand
       * you, so refusing them refused a whole ordinary way of being asked for
       * money.
       *
       * The amount is only ever sent for an invoice that carries none. cashu-ts
       * throws if both are given, and it would be the wrong thing to allow
       * anyway: the invoice is what the payee signed. */
      var asked = Math.round(Number((opts && opts.sats) || 0));
      var carries = FoxyWallet.msatOf(inv);
      /* Dollars pay only an invoice that names its amount: the amount typed
       * for one that names none is sats, which a dollar balance does not
       * have, and Forge pays no amountless invoice in any unit. */
      if (!carries && unit !== 'sat') {
        return Promise.reject(new Error('Paying an invoice with no amount from dollars is not possible. Ask for one with the amount on it.'));
      }
      if (!carries && !(asked > 0)) {
        return Promise.reject(new Error('That invoice names no amount, so Foxy needs one to send.'));
      }
      if (carries && asked > 0 && asked !== Math.round(carries / 1000)) {
        return Promise.reject(new Error('That invoice already names an amount, so it is paid as it stands.'));
      }
      if (!carries && typeof w.mintInfo !== 'object' && typeof w.getMintInfo !== 'function') {
        return Promise.reject(new Error('Foxy could not ask this mint whether it pays invoices with no amount.'));
      }
      var quoteFor = function (via) {
        if (carries) return via.createMeltQuoteBolt11(inv);
        var info = null;
        try { info = via.getMintInfo ? via.getMintInfo() : null; } catch (e) { info = null; }
        var can = false;
        try { can = !!(info && info.supportsAmountless && info.supportsAmountless('bolt11', unit)); }
        catch (e) { can = false; }
        if (!can) {
          throw new Error(hostOf(mintOf(via)) + ' does not pay invoices that name no amount. '
            + 'Ask for one with the amount on it, or move to a mint that does.');
        }
        return via.createMeltQuoteBolt11(inv, asked * 1000);
      };

      // Every other mint call is wrapped; this one was not, so a dead circuit
      // left the send sitting at 0% with no error and no way back. A melt
      // quote is a plain request — if it has not answered in 30 seconds it is
      // not going to.
      /* And asked again on another circuit after five seconds of nothing,
       * longer at a mint that has lately been slow (`askedAgain`): a quote
       * commits to nothing, so several cost nothing.
       * The payment then goes by the circuit that answered. The split and the
       * melt are never asked twice, and a road that would not carry a quote
       * is no road to send them down.
       *
       * Or not asked at all: the confirmation screen asked the same question
       * seconds ago (`quoteFee`), and its answer is handed in as `opts.quote`.
       * While it is fresh (a minute, and the mint's own expiry at least half a
       * minute off) and for this very invoice, that quote and the circuit it
       * came by are used, which takes one round trip over Tor off the front
       * of the payment. An invoice with no amount is always quoted anew: the
       * confirmation quotes without one. */
      var kept = opts && opts.quote;
      /* And only a quote in the unit being paid from: a sat quote says sats,
       * and paying it from dollars would melt cents against a figure in sats. */
      var keptUnit = kept ? (kept.unit === undefined ? 'sat' : unitOf(kept.unit)) : '';
      // a swap between units (`swapRun`) has already refused a rate with less than fifteen seconds left
      var swapId = opts && opts.swap ? String(opts.swap) : '';
      /* Paid from a card's pieces held for it (`opts.held`, 08a-flashcard.js `cardOutHold`): the card was charged for this
       * quote's amount and fee, so it is the one paid with while the mint still honours it (its own expiry half a minute off,
       * however long the card took to read), on the circuit kept ready. A PIN and a second tap can be more than a minute. */
      var heldId = (opts && typeof opts.held === 'string') ? opts.held : '';
      var unsent = function (message) {
        var e = /** @type {any} */ (new Error(message));
        e.unsent = true;
        if (heldId) e.held = heldId;
        return e;
      };
      /* A card holds one unit, and its pieces pay in that unit and no other: a dollar card's by a melt in dollars, a bitcoin
       * card's in sats. Asked of the hold itself, before anything is quoted. */
      var hold0 = heldId ? load(K.held, {})[heldId] : null;
      if (heldId && hold0 && recordUnit(hold0) !== unit) {
        return Promise.reject(unsent('This card\u2019s money is in ' + balanceWord(hold0.unit) + ', so it pays in ' + balanceWord(hold0.unit) + '. Nothing was paid.'));
      }
      var reuse = !!(kept && kept.quote && kept.w && carries && kept.bolt11 === inv && keptUnit === unit
        && (heldId || (Date.now() - Number(kept.at || 0)) < (Number(FoxyWallet._quoteReuseMs) > 0 ? Number(FoxyWallet._quoteReuseMs) : 60000))
        && (!(Number(kept.quote.expiry) > 0) || Number(kept.quote.expiry) * 1000 > Date.now() + (swapId ? 10000 : 30000)));
      if (reuse) console.log('[foxy] the fee quote the confirmation showed is fresh; paying with it, on its circuit');
      /* A swap pays the melt whose price it showed, or nothing: asked again,
       * the mint names a new price for the same invoice, and the person said
       * SWAP to the old one. Refused before anything moves; the screen asks
       * for a new rate (`e.expired`). */
      if (swapId && !reuse) {
        var late = /** @type {any} */ (new Error('The rate has run out. Confirm the new rate.'));
        late.expired = true;
        return Promise.reject(late);
      }
      /* A payment from dollars costs what the mint's price says at the
       * moment it is quoted, and the confirmation showed one such price. Asked
       * again (the shown quote went stale), the new one may be dearer: then it
       * is refused before anything moves, in dollars, and the person confirms
       * the new figure. Sats are as they were: the invoice fixes their amount. */
      var shownMost = (kept && kept.quote && keptUnit === unit && unit !== 'sat' && kept.bolt11 === inv)
        ? satsOf(kept.quote.amount) + satsOf(kept.quote.fee_reserve) : 0;
      /* A card's pieces are melted on the circuit kept ready (`w`), by the wallet of their unit: a dollar card's by the dollar
       * wallet, on that same circuit. */
      var quoted = reuse ? ((heldId && unit !== 'sat') ? unitWalletOn(w, unit).then(function (uw) { return { got: kept.quote, w: uw }; })
                                                     : Promise.resolve({ got: kept.quote, w: heldId ? w : kept.w }))
        : unitWalletOn(w, unit).then(function (uw) {
          return withTimeout(askedAgain(uw, 'the mint\u2019s fee quote', quoteFor), 30000, 'the mint\u2019s fee quote');
        });
      return quoted
        .then(function (won) {
        var quote = won.got;
        w = won.w;
        stage('quote');
        var owed = satsOf(quote.amount) + satsOf(quote.fee_reserve);
        if (!reuse && shownMost > 0 && owed > shownMost) {
          var dearer = /** @type {any} */ (new Error('The mint’s price moved: this payment now needs ' + moneyWords(owed, unit)
            + ' with the mint\u2019s fees, not the ' + moneyWords(shownMost, unit) + ' you confirmed. Nothing was sent.'));
          dearer.definite = true;
          dearer.repriced = true;
          throw dearer;
        }
        var at = mintOf(w);
        // the mint's dollar price in this quote, for the screens (`mintRate`)
        var rateHere = unit === 'usd' ? rateFrom(satsOf(quote.amount), carries || 0) : 0;
        if (rateHere > 0) mintRates[canonicalMint(at)] = { usdPerBtc: rateHere, at: Date.now(), mint: canonicalMint(at) };
        /* A card's pieces, held for this payment: they are what is melted, every one, with no split of the pile and nothing
         * of the pile's added. Short of the quote (the fee rose while the card was read) or not there at all, nothing is sent
         * and the hold is left as it is, for the card. What they come to over the quote comes back as the melt's change. */
        var hold = heldId ? load(K.held, {})[heldId] : null;
        // (with its unit, so a hold made again from these pieces is of their unit: `cardOutReturn`)
        /* (and whether it is this phone's own, held for its own invoice: a hold made again is kept by it too, `cardOutKeep`) */
        var cardHold = hold ? Object.assign({ card: hold.card || '', forHash: hold.forHash || '', token: hold.token || '', unit: recordUnit(hold) },
                                            hold.tillKeeps ? { tillKeeps: true } : {}) : null;
        if (heldId) {
          if (!hold || hold.kind !== 'card out' || !(hold.proofs || []).length) throw unsent('The card\u2019s pieces for this payment are not here any more. Nothing was paid.');
          if (canonicalMint(hold.mint) !== canonicalMint(at)) throw unsent('The card\u2019s pieces are at another mint than this payment. Nothing was paid.');
          var heldWorth = sumProofs(hold.proofs) - feeForInputs(w, hold.proofs.length);
          if (heldWorth < owed) throw unsent('The fee went up while the card was read, so the card\u2019s ' + (unit === 'sat' ? sumProofs(hold.proofs) + ' sats do' : moneyWords(sumProofs(hold.proofs), unit) + ' does') + ' not cover it. Nothing was paid.');
        }
        var have = heldId ? hold.proofs.slice() : proofs(at, unit);
        // the split itself costs this mint's input fee, on top of the melt
        /* Said with the figure it is refused on. It named the invoice and the
         * reserve and left this mint's fee out, so a refusal read "needs 1020
         * sats … and you hold 1024" (tools/live/tap-scenarios.js 6). */
        /* The one sum (`meltNeed`): the invoice, the reserve, this mint's
         * fee for the split, and its fee again on the pieces the melt
         * spends. The confirmation asks the same sum before it offers SEND
         * (`payNeed`) and says it in the same words (`notEnoughWords`), so
         * what it refuses a payment on and what this refuses it on cannot
         * differ; the reserve can still move between that quote and this
         * one, which is when this is the one that says it. */
        var mn = heldId ? { ok: true } : meltNeed(w, have, owed);
        if (!mn.ok) throw new Error(notEnoughWords(mn, unit));

        /* A swap between units pays its melt with pieces of the pile as they
         * are, when it can (`meltAsIs`): exact pieces, or the pieces the split
         * would have spent with the rest back as the melt's change. Either
         * way no split, so one round trip fewer before the payment. Every
         * other payment is split as it always was. */
        var asIs = (heldId || !swapId) ? null : meltAsIs(w, have, owed, quote);
        var path = heldId ? 'card' : asIs ? (asIs.path === 'exact' ? 'exact pieces' : 'change on the melt') : 'shaped';
        if (!heldId) {
          console.log('[foxy] melt ' + String(quote.quote).slice(0, 12) + '\u2026: ' + path + ', '
            + (asIs ? formatAmount(sumProofs(asIs.send), unit) + ' in ' + asIs.send.length + ' piece(s)'
              + (asIs.over ? ', ' + formatAmount(asIs.over, unit) + ' over, back as change' : '')
              : formatAmount(owed, unit) + ' cut from ' + formatAmount(sumProofs(have), unit))
            + ' for ' + formatAmount(owed, unit) + ' with the reserve');
        }
        // split the pile into exactly what the melt needs, and what stays;
        // its output ranges are on disk until the answer is in (swapGuard)
        var splitGuard = (heldId || asIs) ? { done: function () {} } : swapGuard(w, 'split', { inputs: have, unit: unit });
        var splitting = heldId ? Promise.resolve({ send: have, keep: null })
          : asIs ? Promise.resolve({ send: asIs.send, keep: asIs.keep })
          : splitGuard.run('payment split', function () {
            return w.send(owed, have, { includeFees: true });
          }).catch(function (e) {
            // some of that ecash was spent elsewhere: out of the pile, and made again
            return retryWithoutSpent(w, e);
          });
        return splitting.then(function (split) {
          /* The pile and the hold are written before the split's record is
           * cleared. The record used to go first, so a pile that could not be
           * written (storage full) left the split's outputs nowhere; now the
           * write throws with the record in place, and recoverSwaps puts them
           * back on the next connect (audit W6). Clearing it after
           * the hold adds nothing to a later restore: every output is then held
           * in the pile or the hold, and a restore adds only what is held
           * nowhere. */
          // (a card's held pieces were never in the pile, and the pile is not touched)
          if (!heldId) setProofs(split.keep || [], at, w, unit);
          // the split's own input fee: what left the pile and did not go to the melt
          var splitFee = heldId ? 0 : Math.max(0, sumProofs(have) - sumProofs(split.keep || []) - sumProofs(split.send || []));

          /* Held before the melt, not after it.
           *
           * The proofs have just left storage. If this process dies before
           * the melt answers, nothing else will run — no catch, no PENDING
           * branch — and the sats would exist only in a local variable inside
           * a promise nobody will ever resolve. Found on device: a send
           * force-quit at "stage melting" left a balance 50 sats lower with
           * no history entry and nothing to look at.
           *
           * Written here, sweepMelts finds it on the next launch and asks the
           * mint what became of it. */
          var meltOutputs = [];      // the change outputs the melt reserves, as cashu-ts reports them
          try {
            holdMelt(quote, split.send, inv, at, opts && opts.payee, splitFee, unit,
                     heldId ? { cardOut: heldId, card: (opts && opts.card) || (cardHold && cardHold.card) || '', cardHold: cardHold,
                                // the melt's change is the card's (`opts.changeToCard`), however late the melt is settled
                                changeToCard: (opts && opts.changeToCard) || undefined }
                       : swapId ? { swap: swapId, mintRate: (opts && opts.mintRate) || rateHere,
                         // a swap from a card's screen: the card it is for, on the record only; the row names no card (`swapMarks`)
                         swapCard: (opts && opts.swapCard) || undefined,
                         // paid over its need: what comes back is checked when the sweep settles it too
                         changeOnMelt: (asIs && asIs.path === 'change') || undefined } : null);
            /* The card's pieces are the melt's now: out of their hold, once the melt's hold has them (never in neither). A hold
             * that cannot be let go is a melt that is not sent: the pieces stay where they were. */
            if (heldId) {
              var heldAll = load(K.held, {});
              delete heldAll[heldId];
              try { mustSave(K.held, heldAll); } catch (eH) { dropMelt(quote.quote); throw eH; }
            }
          } catch (e) {
            // no hold on disk, so no melt: the proofs go back, and a pile that
            // cannot take them either keeps the split's record for recoverSwaps
            // (a card's pieces are still in their own hold, and stay there)
            if (!heldId) addProofs(split.send || [], at, w, unit);
            splitGuard.done();
            var unheld = /** @type {any} */ (new Error('Foxy could not write to this phone’s storage (it may be full), ' +
              'so the payment was not sent. Your ecash is still here. Free up space, then try again.'));
            unheld.storageFull = true;
            unheld.unsent = true;
            throw unheld;
          }
          splitGuard.done();
          stage('melting');
          // the melt is now in flight — say so before waiting on it, not after,
          // or this stage and success land in the same millisecond
          stage('inflight');
          /* The melt resolving is not the same as the payment succeeding.
           *
           * A mint answers PENDING while the Lightning payment is still
           * routing. This used to read the resolve as success: the payment
           * was logged settled, and the proofs it spent had already been
           * dropped. If that payment then failed, the mint released the
           * proofs back and the wallet had forgotten it ever held them —
           * reconcile only removes, so a seed restore was the only way back.
           *
           * Now the state is read. Only PAID is final. */
          /* A mint that accepts the connection and never answers used to
           * leave this at 50% forever, with the proofs already out of
           * storage. After 90 seconds it is treated as pending — not as
           * failed — so the proofs are held and the sweep settles them
           * against the mint later. */
          /* The payment went: drop the hold, keep the change, log it. */
          function landed(change, restored, preimage) {
            /* The change before the hold goes: a pile that cannot be written
             * throws (W6) and leaves the hold, which sweepMelts settles as PAID
             * with the change restored from its recorded outputs. */
            /* Unspent fee reserve returns as change. It went in through
             * addNewProofs, which marks what it adds as imported — and change
             * is this wallet's own, from its seed and counters, whether it came
             * in the answer or was restored after the answer was lost. Marked
             * imported, spending it elsewhere later had reconcile set it aside
             * instead of removing it. */
            /* A card paying this phone's invoice from another mint (`opts.changeToCard`, 26f-flashcard.js `fcXmMelt`): the reserve
             * the payment did not use is the card's, and goes into a hold of its own for it (`<id>-change`, owed to it by the
             * caller, `cardOutBack`), as an on-chain payment's does (16a-onchain.js); this phone receives the invoice and no more. */
            var changeToCard = !!(heldId && opts && opts.changeToCard && (change || []).length);
            if (changeToCard) cardOutReturn(heldId + '-change', change, at, Object.assign({}, cardHold || {}, { change: true, payment: quote.quote }));
            else addOwnProofs(change || [], at, w, unit, restored);
            dropMelt(quote.quote);
            /* Paid with more than it needed: a mint that gave back less than
             * it owed is said, and paid only what a melt needs from then on
             * (`noteMeltChangeBack`). What it kept is in the fee below, so the
             * books still close. */
            if (asIs && asIs.path === 'change') noteMeltChangeBack(w, at, split.send, quote.amount, change, unit, quote.quote);
            /* Everything the payment cost beyond its amount: the proofs it spent,
             * and the split's fee, less the change kept. This was the fee
             * reserve less the change, which left out the melt inputs' own fee
             * (NUT-02) and the split's — about 2 sats low on a live mint. */
            var feeSats = meltFee(sumProofs(split.send || []) + splitFee, quote.amount, change);
            /* One line for the log: what the mint kept of its reserve, and what came back. The owner asked after a card paid
             * his dollar code whether Forge had charged anything, and the log said only what was reserved. */
            try {
              // (the reserve may be the library's own Amount, which warns when coerced)
              var fr = quote.fee_reserve;
              fr = (fr && typeof fr === 'object' && typeof fr.toNumber === 'function') ? fr.toNumber() : (Number(fr) || 0);
              console.log('[foxy] melt ' + String(quote.quote).slice(0, 12) + '\u2026: paid ' + formatAmount(quote.amount, unit) + ', reserved '
                + formatAmount(Math.max(0, fr), unit) + ', the mint kept ' + formatAmount(Math.max(0, feeSats), unit)
                + ', ' + formatAmount(sumProofs(change || []), unit) + ' back as change');
            } catch (eLog) { /* a line for the log, nothing more */ }
            if (heldId) FoxyWallet.cardOutDone(heldId);
            // in the unit paid from (hard rule 4): a usd row is cents, with sats at 0
            logTx(unitRow(unit, swapMarks(swapId ? { swap: swapId, mintRate: (opts && opts.mintRate) || rateHere, swapCard: (opts && opts.swapCard) || undefined } : null, {
              dir: 'out',
              sats: satsOf(quote.amount),
              feeSats: Math.max(0, feeSats),
              settled: true,
              state: 'success',
              // paid with a card's pieces (SEND from the card's screen): said so on the entry, with the card
              memo: heldId ? 'paid from card' : swapId ? 'swap' : '',
              fromCard: heldId ? ((opts && opts.card) || (cardHold && cardHold.card) || undefined) : undefined,
              hash: quote.quote,
              bolt11: inv,
              // the proof that this invoice was paid, when the mint gave one (`preimageOf`)
              preimage: preimage || undefined,
              // where it was paid from, which is not always where the phone is by now (`logTx`)
              mint: at,
              // the mint's price in this payment, when it converted dollars
              mintRate: rateHere > 0 ? rateHere : undefined,
            })));
            logAudit({
              hash: quote.quote,
              sats: unit === 'sat' ? satsOf(quote.amount) : 0,
              feeSats: unit === 'sat' ? Math.max(0, feeSats) : 0,
              unit: unit === 'sat' ? undefined : unit,
              amount: unit === 'sat' ? undefined : satsOf(quote.amount),
              kind: 'melt',
              inputs: (split.send || []).map(scrub),
              outputs: (change || []).map(scrub),
            });
            if (swapId) unitSwapLanded(swapId, 'melt');
            return Object.assign({ hash: quote.quote, unit: unit, amount: satsOf(quote.amount), fee: Math.max(0, feeSats),
                     feeSats: unit === 'sat' ? Math.max(0, feeSats) : 0 },
                     // the card's change, held for it: the caller owes it to the card (`cardOutBack`)
                     changeToCard ? { cardChange: { id: heldId + '-change', amount: sumProofs(change), sats: unit === 'sat' ? sumProofs(change) : 0, unit: unit } } : {});
          }

          /* It did not go: drop the hold and take the proofs back. */
          function notSent(message) {
            /* The proofs back before the hold goes, so a pile that cannot take
             * them keeps the hold (W6) — and added the deduplicating way, so a
             * dropMelt whose write was refused cannot have sweepMelts put the
             * same proofs back a second time. */
            // a card's pieces go back to their hold, for the card, and not into the pile
            if (heldId) cardOutReturn(heldId, split.send || [], at, cardHold || {});
            else addOwnProofs(split.send || [], at, w, unit, true);
            dropMelt(quote.quote);
            // the split before it was made and paid for, whatever became of the melt
            if (unit !== 'sat') { if (meltGone(quote.quote)) meltBackFee(at, unit, splitFee); }
            else if (meltGone(quote.quote)) chargeUnsentFee(at, splitFee);
            if (swapId) unitSwapLanded(swapId, 'melt', 'back');
            var e = /** @type {any} */ (new Error(message || 'That payment could not be routed. Nothing was sent.'));
            e.definite = true;
            if (heldId) e.held = heldId;
            return e;
          }

          // written to the hold as they are reserved, so a later settle restores exactly these
          var stopWatching = watchReserved(w, function (r) {
            meltOutputs.push(r);
            noteMeltOutputs(quote.quote, meltOutputs);
          });
          var meltCall;
          try { meltCall = Promise.resolve(w.meltProofsBolt11(quote, split.send)); }
          catch (e) { stopWatching(); throw e; }
          meltCall.then(stopWatching, stopWatching);
          // the mint's own refusal of the melt, for pieces it says were spent (below)
          var refusedWith = /** @type {any} */ (null);
          var meltRace = Promise.race([
            // no retry: a melt pays; but a refusal for used outputs still moves the counters on
            meltCall.catch(function (e) {
              if (alreadySigned(e)) skipSignedCounters(w, 10).catch(function () {});
              throw e;
            }),
            new Promise(function (_, reject) {
              setTimeout(function () {
                var e = /** @type {any} */ (new Error('The mint did not answer in 90 seconds.'));
                e.unanswered = true;
                reject(e);
              }, 90000);
            }),
          ]);
          return meltRace.then(function (res) {
            /* No state means unknown, not success.
             *
             * This defaulted to 'PAID', so a response in a shape this did not
             * recognise was logged as a completed payment and the hold
             * dropped — money gone and recorded as fine, with nothing left to
             * recover from. An unknown answer is held instead, and sweepMelts
             * asks the mint what happened on the next resume.
             *
             * The parentheses mattered too: written as
             * String(x || 'PAID'.toUpperCase()), the case fold applied to the
             * literal and never to the mint's answer, so a lowercase 'paid'
             * would have fallen through every branch. */
            var raw = res && (res.state || (res.quote && res.quote.state));
            var state = raw ? String(raw).toUpperCase() : 'UNKNOWN';

            if (state === 'UNKNOWN') {
              // held; the sweep asks the mint on the next resume
              console.warn('[foxy] the mint answered without a state \u2014 proofs stay held');
              return { hash: quote.quote, unit: unit, amount: satsOf(quote.amount), fee: 0, feeSats: 0, pending: true };
            }

            if (state === 'PENDING') {
              // already held, from before the request went out
              return { hash: quote.quote, unit: unit, amount: satsOf(quote.amount), fee: 0, feeSats: 0, pending: true };
            }

            if (state === 'UNPAID' || state === 'FAILED') throw notSent();

            // it landed: the hold is no longer needed
            return landed(res.change || [], false, preimageOf(res));
          }).catch(function (e) {
            // the payment may still have gone through; its change could not be verified
            if (badSignatures(e)) reportBadSignatures(hostOf(at), 'pay');
            if (e && !e.definite && !e.unsent) refusedWith = e;
            /* Storage refused a write. `unsent`: the melt's change counters were
             * not stored, so cashu-ts never sent it, and the proofs go back.
             * Otherwise the mint answered and the pile could not take what came
             * of it; the hold stays for sweepMelts (W6). */
            if (e && e.unsent) throw notSent(e.message);
            if (e && (e.definite || e.storageFull)) throw e;
            /* The mint is asked what happened, not read from its wording.
             *
             * This used to treat any error whose text said "quote" or
             * "already" as a refusal and hand the proofs back — and a message
             * like "quote is pending" matched, returning proofs to a payment
             * still routing. Now the quote's state decides: UNPAID gives them
             * back, PAID is a payment that went, and anything else — a timeout,
             * no answer, PENDING — stays held for the sweep. */
            var msg = String((e && e.message) || e);
            /* Did the mint read the melt and say no, or did it never answer?
             *
             * A melt that timed out (the native request gives up at 60 s, this
             * race at 90) or lost its connection may still be on its way to
             * the mint. A state check made meanwhile reads UNPAID, and this
             * used to give the proofs back and drop the hold on that word — a
             * retry could then pay twice. Only a refusal the mint actually
             * sent (mintRefused: a 4xx or a coded error) proves the melt
             * arrived. Otherwise UNPAID, like PENDING, stays held, and
             * sweepMelts gives it back once the hold is old enough that
             * nothing can still be in flight. */
            var answered = mintRefused(e);
            return withTimeout(w.checkMeltQuoteBolt11(quote.quote), 20000, 'the payment\u2019s state')
              .then(function (q) {
                return { state: String((q && q.state) || '').toUpperCase(), change: (q && q.change) || [],
                         preimage: preimageOf(q) };
              }, function () { return { state: 'UNKNOWN', change: [], preimage: '' }; })
              .then(function (r) {
                // FAILED is the mint's verdict on a payment it tried; UNPAID only counts once it answered
                if (r.state === 'FAILED' || (r.state === 'UNPAID' && answered)) throw notSent(msg);
                if (r.state === 'PAID') {
                  // change as proofs if the answer carried them; otherwise from the reserved counters
                  var usable = (r.change || []).filter(function (p) { return p && p.secret; });
                  if (usable.length) return landed(usable, false, r.preimage);
                  return recoverMeltChange(w, meltOutputs, at)
                    .then(function (proofs) { return landed(proofs, true, r.preimage); },
                          function () { return landed([], false, r.preimage); });
                }
                function stillHeld() {
                  console.warn('[foxy] melt outcome unknown (' + (r.state || 'no answer') + '), proofs stay held:', msg.slice(0, 80));
                  var held = /** @type {any} */ (new Error('That payment may still be going through. '
                    + 'Foxy is holding the ecash until the mint says either way.'));
                  held.pending = true;
                  return held;
                }
                /* PENDING, but the mint answered with an error and never took the ecash.
                 *
                 * Nutshell can refuse a melt and leave its quote PENDING for good —
                 * seen on testnut, a refused payment's quote still PENDING hours on,
                 * while a restore found its proofs UNSPENT. Held on the quote's word
                 * alone, those sats were gone from the balance with nothing to settle
                 * them. A payment that is really routing has its inputs PENDING at
                 * the mint, so all UNSPENT after an answer means it did not take them.
                 * A melt that never answered is left held: it may not have arrived. */
                if (r.state !== 'PENDING' || !answered) throw stillHeld();
                return statesOf(w, split.send || []).then(function (states) {
                  if (allUnspent(states)) {
                    console.warn('[foxy] the mint left the quote PENDING but never took the ecash \u2014 giving it back');
                    throw notSent(msg);
                  }
                  throw stillHeld();
                }, function () { throw stillHeld(); });
              });
          }).catch(function (x) {
            /* Pieces paid as they are meet the mint first in the melt rather
             * than in the split, so a piece spent elsewhere (the words restored
             * in another wallet) is refused here. They are back in the pile by
             * now (`notSent`); the spent ones come out of it, as the split's own
             * refusal does (`retryWithoutSpent`). The swap is not made again:
             * its rate was for this melt, and the screen asks for a new one. */
            if (!asIs || !(x && x.definite) || !inputsSpent(refusedWith)) throw x;
            return dropSpentInputs(w, split.send || []).then(function () { throw x; }, function () { throw x; });
          });
        });
      });
    },

    /* Whether a melt of these inputs can hand back all it may owe in the
     * blanks that go with it (`meltChangeFits`, 04-lost-answers.js). Here so
     * that `meltAsIs` asks it by name, and a suite can ask it directly or
     * stand in a smaller answer. */
    /** @param {number=} count */
    _meltChangeFits: function (w, inputs, amount, reserve, inputFee, count) {
      return meltChangeFits(w, inputs, amount, reserve, inputFee, count);
    },

    /* A lightning address or LNURL, asked for an invoice of `sats`, and every
     * check on what comes back. Nothing is paid and no mint is asked: the
     * well-known request and the callback both go to the recipient's server.
     * Resolves { pr, addr, sats, at }, the invoice and what it was asked for.
     *
     * Its own function, with `payLnurl` after it, because the confirmation
     * screen looks the address up while the person reads it (the button says
     * CHECKING until it has, and the fee on this invoice is quoted), and SEND
     * then pays this very invoice instead of asking the address again. */
    lookupLnurl: function (addr, sats, comment, onStage) {
      var a = String(addr || '').trim().replace(/^lightning:/i, '');
      var amount = Math.round(Number(sats));
      if (!(amount > 0)) return Promise.reject(new Error('Enter an amount first.'));

      var well;
      var m = /^([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(a);
      if (m) {
        well = 'https://' + m[2] + '/.well-known/lnurlp/' + m[1];
      } else if (/^lnurl1/i.test(a)) {
        try { well = FoxyWallet.decodeLnurl(a); }
        catch (e) { return Promise.reject(e); }
      } else if (/^https:\/\//i.test(a)) {
        well = a;
      } else {
        return Promise.reject(new Error('That is not a lightning address or LNURL.'));
      }

      var stage = typeof onStage === 'function' ? onStage : function () {};
      stage('resolving');

      try { assertRoute(); } catch (e) { return Promise.reject(e); }

      /* Both of these need a deadline.
       *
       * Every other network call in this file has one; these two did not. Over
       * Tor an address server that accepts the connection and never answers
       * leaves the promise pending forever — the progress overlay ends, no
       * error is thrown, no card appears, and the app sits on "sending" with
       * no way out. Seen on device against a lightning address.
       *
       * 20 seconds each: this is a web server being asked for an invoice, not
       * a payment being routed. */
      /* Through the native side, like every mint call.
       *
       * These two fetches go to whoever owns the lightning address — a third
       * party chosen by the person being paid, not by the user, and one that
       * learns their address the moment it is looked up. Routing the mint and
       * leaving this in the clear would be most of the way to nothing. */
      /* Forty-five seconds, not twenty.
       *
       * The deadline exists because these two inherited nativeRequest's
       * 65-second bridge timeout, and a minute of a motionless sending screen
       * is indistinguishable from a frozen app: a tester killed Foxy rather
       * than wait it out. Twenty was the number that felt short
       * enough.
       *
       * It is too short for the second hop over Tor. A Wallet of Satoshi
       * callback took 17889 ms once and timed out flat on the next attempt —
       * `that address did not answer within 20s` — while Foxy was also
       * building fresh circuits for its own quote polls, which is exactly when
       * a hop is slowest.
       * Two hops, a cold circuit each, and a server that has taken eighteen
       * seconds: twenty is inside the ordinary range rather than past it.
       *
       * Still well under the bridge's own ceiling, so the screen still ends by
       * itself rather than sitting there for a minute. */
      var REACH_MS = Number(FoxyWallet._reachMs) > 0 ? Number(FoxyWallet._reachMs) : 45000;
      /* And asked again on a fresh circuit every five seconds it goes
       * unanswered, up to five askings, the first answer being the answer
       * (`askedAgain`), the way a fee quote is.
       *
       * Each of these goes out on one Tor circuit, and now and then a circuit
       * goes nowhere: the request sat there until the deadline above while the
       * same server answers the next circuit in a second or two. Both are plain
       * GETs. The well-known request changes nothing at the address; the
       * callback makes the address's server write an invoice, and only the
       * first one to come back is looked at, paid or not: the others lapse at
       * the server by themselves. The deadline stays the cap on all of them,
       * and says the same words when none of them answers. */
      var get = function (u, label) {
        if (bridged()) {
          // `foxyNoPace`: an address's server is no mint, and its answer times pace none (`askAgainWait`)
          var asked = askedAgain('', label, function (circuit) {
            return FoxyWallet.nativeRequest({ endpoint: u, method: 'GET', foxyCircuit: circuit, foxyNoPace: true });
          }, newCircuitLabel, REACH_MS).then(function (won) { return won.got; });
          return withTimeout(asked, REACH_MS, label);
        }
        return withTimeout(fetch(u), REACH_MS, label).then(function (r) {
          if (!r.ok) throw new Error('That address did not answer (' + r.status + ').');
          return r.json();
        });
      };

      var described = null;   // the metadata the address sent, which its invoice must be for
      return get(well, 'that address').then(function (meta) {
        described = meta ? meta.metadata : null;
        if (!meta || meta.tag !== 'payRequest' || !meta.callback) {
          throw new Error('That address is not set up to receive payments.');
        }
        var msat = amount * 1000;
        if (meta.minSendable && msat < meta.minSendable) {
          throw new Error('That address needs at least ' + Math.ceil(meta.minSendable / 1000) + ' sats.');
        }
        if (meta.maxSendable && msat > meta.maxSendable) {
          throw new Error('That address takes at most ' + Math.floor(meta.maxSendable / 1000) + ' sats.');
        }
        var cb = meta.callback + (meta.callback.indexOf('?') >= 0 ? '&' : '?') + 'amount=' + msat;
        if (comment && meta.commentAllowed) {
          cb += '&comment=' + encodeURIComponent(String(comment).slice(0, meta.commentAllowed));
        }
        return get(cb, 'that address');
      }).then(function (res) {
        if (!res || !res.pr) {
          throw new Error((res && res.reason) || 'No invoice came back from that address.');
        }
        /* Pay what was asked for, not what came back.
         *
         * The server on the other end of a lightning address chooses the
         * invoice. Nothing downstream compares it to the request — the mint
         * quotes whatever it is handed — so a malicious or compromised address
         * server could return an invoice for the whole balance and have it
         * paid. This is the only place that knows both numbers. */
        /* To the millisat. Compared in rounded sats, an invoice for up to half
         * a sat more than asked (10.4 sats for 10) passed. */
        var want = Math.round(Number(sats) || 0);
        var gotMsat = FoxyWallet.msatOf(res.pr);
        if (gotMsat === null || !gotMsat) {
          throw new Error('That address returned an invoice with no amount on it. Not paying it.');
        }
        if (gotMsat !== want * 1000) {
          console.warn('[foxy] address invoice mismatch: asked', want * 1000, 'msat, got', gotMsat);
          throw new Error('That address asked for ' + (gotMsat / 1000).toLocaleString()
            + ' sats instead of ' + want.toLocaleString() + '. Not paying it.');
        }
        /* And for what the address described (LUD-06): the invoice's
         * description hash is the sha256 of the metadata it sent. The amount
         * alone let through an invoice for the right sum to someone else. */
        if (typeof described !== 'string' || !described) {
          throw new Error('That address did not say what the payment is for. Not paying it.');
        }
        var wantHash = sha256(Array.prototype.slice.call(new TextEncoder().encode(described)))
          .map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        var gotHash = FoxyWallet.descriptionHashOf(res.pr);
        if (gotHash !== wantHash) {
          /* Both values, and the difference between the two ways this fails.
           *
           * It said only "is not for the metadata it sent", which reads the
           * same whether the hash was wrong or the invoice carried no `h` tag
           * at all — `descriptionHashOf` answers null for both. Three refusals
           * at one address could not be told apart from the
           * diary, so there was no way to know whether the server was
           * misbehaving or simply describing itself the other legal way.
           * Neither is payable without checking, but they are different bugs
           * and the log has to say which. */
          console.warn('[foxy] address invoice is not for the metadata it sent:'
            + ' wanted ' + wantHash.slice(0, 16) + '\u2026, invoice says '
            + (gotHash ? gotHash.slice(0, 16) + '\u2026' : 'nothing (no description hash on it)')
            + '; the metadata was ' + described.length + ' characters');
          throw new Error(gotHash
            ? 'That address returned an invoice for something other than what it described. Not paying it.'
            : 'That address returned an invoice that does not say what it is for, so Foxy cannot check it '
              + 'against what the address described. Not paying it.');
        }
        return { pr: res.pr, addr: a, sats: amount, at: Date.now() };
      });
    },

    /* A lightning address or LNURL: resolve it to an invoice, then melt.
     * The well-known request goes to the recipient's server, not the mint.
     *
     * `opts.found` is the invoice the confirmation screen already looked up
     * for this address and amount (`lookupLnurl`), and `opts.quote` the fee
     * quote it asked on that invoice (`quoteFee`). While the invoice is a
     * minute old at most, and for this very address and amount, it is paid as
     * it stands: the address is not asked again, and `pay` takes the quote on
     * the same terms as for any invoice. Older, or for something else, and it
     * is looked up anew, which is all this did before the screen looked. */
    payLnurl: function (addr, sats, comment, onStage, opts) {
      var a = String(addr || '').trim().replace(/^lightning:/i, '');
      var amount = Math.round(Number(sats));
      var kept = opts && opts.found;
      /* Paid from a card's pieces held for it (`opts.held`): the card was charged for this very invoice's fee, so it is the
       * invoice paid however long the card took to read; the mint says if it has expired, and the pieces go back. */
      var fresh = !!(kept && kept.pr && amount > 0 && kept.addr === a && kept.sats === amount
        && ((opts && opts.held) || (Date.now() - Number(kept.at || 0)) < (Number(FoxyWallet._lookReuseMs) > 0 ? Number(FoxyWallet._lookReuseMs) : 60000)));
      var looked;
      if (fresh) {
        console.log('[foxy] the address was looked up a moment ago; paying the invoice it gave');
        if (typeof onStage === 'function') onStage('resolving');
        looked = Promise.resolve(kept);
      } else {
        looked = FoxyWallet.lookupLnurl(addr, sats, comment, onStage);
      }
      return looked.then(function (found) {
        /* Asked in sats, always: a Lightning address names msat. Paid from
         * the unit the person chose; from dollars the mint's quote says what
         * that costs in cents. From a card's held pieces, in sats. */
        return FoxyWallet.pay(found.pr, onStage, { payee: a, quote: opts && opts.quote, unit: opts && opts.unit,
                                                    held: (opts && opts.held) || undefined, card: (opts && opts.card) || undefined });
      });
    },

    payAddress: function (a, s, c, onStage) { return FoxyWallet.payLnurl(a, s, c, onStage); },

