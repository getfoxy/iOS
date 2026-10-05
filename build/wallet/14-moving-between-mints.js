    /* ---- moving between mints ------------------------------------------ */

    /* The host of the connected mint, for the interface to show. */
    mintHost: function () {
      return String(mintUrl || '').replace(/^https?:\/\//, '');
    },

    /* What it would cost to move everything here to another mint.
     *
     * There is no direct route: ecash from one mint is worthless at another, so
     * a move is a real lightning payment. The destination issues an invoice,
     * this mint melts proofs to pay it. That costs the route fee plus whatever
     * either mint charges, so less arrives than left.
     *
     * Resolves the whole plan — including both quotes — so confirming does not
     * have to ask again and get a different number.
     */
    moveQuote: function (toUrl) {
      var moveLock = null;   // NUT-20 key for the quote at the destination, if it takes one
      assertRoute();
      var from = mintUrl;
      var to = canonicalMint(toUrl);
      if (!from) return Promise.reject(new Error('No mint is connected.'));
      var badTo = mintUrlProblem(to);
      if (badTo) return Promise.reject(new Error(badTo));
      if (to === from) return Promise.reject(new Error('You are already on that mint.'));
      if (!window.CashuTS) {
        return Promise.reject(new Error('cashu-ts.js did not load.'));
      }

      var balance = sumProofs(proofs());
      var old;
      try { old = need(); } catch (e) { return Promise.reject(e); }
      var dest = newWallet(to);
      // Held back so the split that funds the melt can pay this mint's own
      // input fee. Everything below sizes against what is left, not the total.
      // The split has to pay this mint's input fee, and the amount it lands on
      // has to be buildable from the proofs on hand — which can cost one more
      // swap than the arithmetic suggests. Sizing to the last sat leaves the
      // split with nothing to work with, so a few sats stay behind.
      var swapFee = swapFeeFor(old, proofs());
      var MARGIN = 20;
      var spendable = balance - swapFee - MARGIN;
      console.log('[foxy] move sizing: balance', balance, 'swap fee', swapFee,
                  'margin', MARGIN, '-> spendable', spendable);

      // Nothing to move: no invoice, no fee, just a change of address.
      if (sumProofs(proofs()) <= 0) {
        return withTimeout(dest.loadMint(), 25000, 'loading ' + hostOf(to)).then(function () {
          return { from: from, to: to, balance: 0, moving: 0, feeSats: 0, empty: true };
        });
      }

      console.log('[foxy] loading', hostOf(to), '\u2026');
      return withTimeout(dest.loadMint(), 25000, 'loading ' + hostOf(to)).then(function () {
        // Ask the destination for an invoice, ask this mint what melting it
        // costs, and if the fee will not fit, ask for a smaller invoice. The
        // second pass already knows the real reserve, so it settles there.
        function attempt(amount, pass) {
          if (amount <= 0) {
            throw new Error('The balance here is smaller than the fee to move it.');
          }
          amount = Math.floor(amount);
          // No description on this one. A memo rides along to the mint's
          // lightning backend, and a backend that does not take one answers
          // "could not fetch bolt11 from backend" rather than saying why.
          console.log('[foxy] asking', hostOf(to), 'for an invoice for', amount, '\u2026');
          return withTimeout(createQuote(dest, amount, undefined, (moveLock = quoteLock(dest))).then(function (q) { if (moveLock) q.foxyLock = moveLock; return q; }), 25000,
                             hostOf(to) + ' invoice').catch(function (e) {
            var why = (e && e.message) || String(e);
            // Is it the size or the node? Ask the same mint for a token
            // invoice. If that works, the node is fine and the amount is the
            // problem — a different fix, and worth saying which one it is.
            // The probe quote is never paid; it expires on its own.
            return withTimeout(dest.createMintQuoteBolt11(64), 15000,
                               hostOf(to) + ' probe invoice').then(function () {
              throw new Error(hostOf(to) + ' will invoice 64 sats but not ' +
                amount + ', so it is the amount, not the node: ' + why);
            }, function () {
              throw new Error(hostOf(to) + ' would not issue an invoice at all. ' +
                'Its lightning node is not answering: ' + why);
            });
          }).then(function (mq) {
            console.log('[foxy] asking', hostOf(from), 'what melting it costs \u2026');
            return withTimeout(old.createMeltQuoteBolt11(mq.request), 25000,
                               hostOf(from) + ' melt quote').catch(function (e) {
              throw new Error(hostOf(from) + ' could not quote that payment: ' +
                ((e && e.message) || e));
            }).then(function (xq) {
              var owed = satsOf(xq.amount) + satsOf(xq.fee_reserve);
              console.log('[foxy] move pass', pass, ': asking', amount,
                          'melt says amount', satsOf(xq.amount),
                          'reserve', satsOf(xq.fee_reserve), 'owed', owed);
              if (owed <= spendable) {
                return {
                  from: from, to: to,
                  balance: balance,
                  moving: amount,
                  feeSats: balance - amount,
                  mintQuote: mq,
                  meltQuote: xq,
                };
              }
              if (pass >= 3) throw new Error('The fee kept changing. Try again in a moment.');
              return attempt(spendable - (owed - amount), pass + 1);
            });
          });
        }
        return attempt(spendable, 1);
      });
    },

    /* Price a sweep before any of it happens.
     *
     * Quoting needs no balance: the destination is asked for an invoice and
     * the source mint is asked what melting it would cost. So a token can be
     * priced while it is still just a string, and refused without ever having
     * been claimed.
     */
    sweepQuote: function (fromUrl, sats) {
      var moveLock = null;   // NUT-20 key for the quote at the destination, if it takes one
      assertRoute();
      var from = String(fromUrl || '').replace(/\/+$/, '');
      var to = String(mintUrl || '').replace(/\/+$/, '');
      var gross = Math.round(Number(sats) || 0);
      if (!to) return Promise.reject(new Error('No mint is connected to send it to.'));
      if (from === to) return Promise.reject(new Error('That token is already from this mint.'));
      if (!window.CashuTS) return Promise.reject(new Error('cashu-ts.js did not load.'));

      /* Headroom over the mint's own reserve.
       *
       * This was 20, which is why a sweep left 20 behind: the reserve is a
       * ceiling the route comes in under, and anything unspent returns as
       * change at the source mint. 8 still covers a proof split and the input
       * fee, and leaves far less stranded. The loop below adjusts if it is
       * too tight, so a smaller number costs an extra round trip at worst.
       */
      var MARGIN = 8;
      var spendable = gross - MARGIN;
      var src = newWallet(from);
      var dest = newWallet(to);
      console.log('[foxy] sweep sizing: token', gross, 'margin', MARGIN, '-> spendable', spendable);

      /* Both mints at once. They are different mints on different circuits
       * with nothing to say to each other, and asking them in turn put one
       * full round trip of waiting on the VERIFYING ECASH screen for nothing.
       * Neither mint sees two requests at once, so this correlates nothing. */
      return Promise.all([
        withTimeout(src.loadMint(), 25000, hostOf(from)),
        withTimeout(dest.loadMint(), 25000, hostOf(to)),
      ])
        .then(function () {
          function attempt(amount, pass) {
            if (amount <= 0) {
              throw new Error('The fee to move it is more than the token is worth.');
            }
            amount = Math.floor(amount);
            return withTimeout(createQuote(dest, amount, undefined, (moveLock = quoteLock(dest))).then(function (q) { if (moveLock) q.foxyLock = moveLock; return q; }), 25000, hostOf(to) + ' invoice')
              .then(function (mq) {
                return withTimeout(src.createMeltQuoteBolt11(mq.request), 25000,
                                   hostOf(from) + ' melt quote').then(function (xq) {
                  var owed = satsOf(xq.amount) + satsOf(xq.fee_reserve);
                  console.log('[foxy] sweep pass', pass, ': asking', amount, 'owed', owed);
                  // what this mint really holds back, for the next move from it
                  rememberReserve(hostOf(from), gross, owed - amount);
                  if (owed <= spendable) {
                    /* What is actually taken is rarely what is quoted.
                     *
                     * gross - amount holds three things: the mint's own input
                     * fee, the lightning fee reserve, and the 20-sat margin.
                     * The reserve is a ceiling the route usually comes in
                     * under, and the margin is headroom that mostly returns as
                     * change — so quoting the total as "the fee" overstates it
                     * badly. 30 quoted, 2 charged, in the case that prompted
                     * this. Report the floor and the ceiling instead.
                     */
                    var reserve = satsOf(xq.fee_reserve);
                    var total = gross - amount;
                    return {
                      from: from, to: to,
                      balance: gross, gross: gross,
                      moving: amount, net: amount,
                      feeSats: total,
                      feeMax: total,
                      feeMin: Math.max(0, total - reserve - MARGIN),
                      reserve: reserve,
                      margin: MARGIN,
                      mintQuote: mq, meltQuote: xq,
                    };
                  }
                  if (pass >= 3) throw new Error('The fee kept changing. Try again in a moment.');
                  return attempt(spendable - (owed - amount), pass + 1);
                });
              });
          }
          /* One ask, where this mint's reserve is already known. A guess that
           * is too small costs the pass it always cost; too large is not
           * possible — it is what the mint itself asked for last time, and a
           * reserve that has since gone up is caught by the same loop. */
          var guess = reserveSeen(hostOf(from), gross);
          var first = (guess !== null && spendable - guess > 0) ? spendable - guess : spendable;
          if (first !== spendable) {
            console.log('[foxy] sweep: ' + hostOf(from) + ' held back ' + guess
              + ' last time, so asking ' + first + ' straight off');
          }
          return attempt(first, 1);
        });
    },

    /* Moving an amount you chose between two mints you hold.
     *
     * The difference from sweepQuote is which figure is fixed. A sweep starts
     * with a token worth exactly so much and works out what can land after the
     * fee; a transfer starts with the amount that should land, and the fee is
     * paid on top of it. Asking for 50 used to move 40 and take 41: the typed figure was being spent, not delivered.
     *
     * Same plan shape as sweepQuote, so moveRun carries either out.
     */
    /* `o.to` names the destination instead of taking it from whichever mint is
     * connected. The transfer screen connects first and then quotes, which is
     * fine there — the person is on the destination already. Paying somebody at
     * another mint is not: the quote happens while a card is still asking
     * whether to pay the fee at all, and flipping the wallet's mint under a
     * question nobody has answered is a side effect with no consent behind it.
     * `moveRun` has always carried `to` in the plan, so nothing downstream
     * cares which mint was connected when the plan was made.
     *
     * `o.quoteOnly` skips the "can you afford it" test, for a quote asked on
     * behalf of money that has not arrived yet: the receiver in a cross-mint
     * tap works out the fee before the payer has sent anything, so the proofs
     * it will move are not in its pile and never were.
     *
     * `o.land` says the figure is what somebody must end up holding after this
     * phone has *also* paid it out at the far mint, which is the cross-mint
     * tap: the sats are moved there and then spent there, and the far mint's
     * own fee for spending them would come out of the amount. The receiver
     * asked for a number and the number is what they get — so the move is
     * padded by that fee and the payer carries it, along with the routing fee.
     * Padding that the payment does not use stays at the far mint and is still
     * the payer's; being a few sats over costs nobody anything, and being a
     * sat under leaves the receiver short. */
    transferQuote: function (fromUrl, sats, o) {
      var opts = o || {};
      var moveLock = null;
      assertRoute();
      var from = String(fromUrl || '').replace(/\/+$/, '');
      var to = String(opts.to || mintUrl || '').replace(/\/+$/, '');
      var want = Math.round(Number(sats) || 0);
      if (!to) return Promise.reject(new Error('No mint is connected to move it to.'));
      if (!from) return Promise.reject(new Error('No mint to move it from.'));
      if (from === to) return Promise.reject(new Error('That is the mint it is already at.'));
      if (!(want > 0)) return Promise.reject(new Error('Ask for an amount above zero.'));
      if (!window.CashuTS) return Promise.reject(new Error('cashu-ts.js did not load.'));

      var src = newWallet(from);
      var dest = newWallet(to);
      var have = sumProofs(proofs(from));
      /* Both mints at once. They are different mints on different circuits
       * with nothing to say to each other, and asking them in turn put one
       * full round trip of waiting on the VERIFYING ECASH screen for nothing.
       * Neither mint sees two requests at once, so this correlates nothing. */
      /* The figure the far mint is asked to issue. With `o.land` it is the
       * amount plus what that mint charges to spend it again, so what leaves
       * there afterwards is the whole of what was asked for. */
      var pad = 0;
      var issue = want;
      return Promise.all([
        withTimeout(src.loadMint(), 25000, hostOf(from)),
        withTimeout(dest.loadMint(), 25000, hostOf(to)),
      ])
        .then(function () {
          if (opts.land) {
            /* Padded on the generous side, and deliberately.
             *
             * The payment made at the far mint spends pieces, and the mint
             * charges per piece. Guess that fee too low and the move has
             * already happened — a real Lightning payment, gone — when the
             * payment it was for comes up short: 101 sats claimed at Nutshell
             * for a 100-sat payment, and "Not enough funds available to send"
             * (tools/live/cross-mint.js, against Nutshell 0.21.0).
             *
             * Guess it too high and a few sats stay at the far mint, still the
             * payer's, spendable, and transferable. The two mistakes are not
             * the same size, so this does not try to predict the split: it asks
             * what thirty-two inputs cost, which is more than any payment out
             * of a freshly claimed pile will spend, and adds one.
             *
             * Nothing at all at a mint that charges nothing per piece, which is
             * most of them, so `land` usually changes no number whatever. */
            var perPiece = feeForInputs(dest, 32);
            pad = perPiece ? perPiece + 1 : 0;
            issue = want + pad;
            if (pad) console.log('[foxy] transfer: padding by', pad,
                                 'so', want, 'still lands after', hostOf(to), 'takes its fee');
          }
          return withTimeout(createQuote(dest, issue, undefined, (moveLock = quoteLock(dest)))
            .then(function (q) { if (moveLock) q.foxyLock = moveLock; return q; }),
          25000, hostOf(to) + ' invoice');
        })
        .then(function (mq) {
          return withTimeout(src.createMeltQuoteBolt11(mq.request), 25000,
                             hostOf(from) + ' melt quote').then(function (xq) {
            var reserve = satsOf(xq.fee_reserve);
            /* What leaves the source: the invoice, the route's reserve, and the
             * mint's own fee for splitting the proofs. The reserve is a ceiling
             * — whatever the route does not use comes back as change — so the
             * screen shows this as the most it can cost. */
            var swapFee = swapFeeFor(src, proofs(from));
            var owed = satsOf(xq.amount) + reserve + swapFee;
            /* In hand, it is the sum the payment itself will be refused on
             * (`meltNeed`), so a quote that says yes is a payment that goes. */
            var mn = opts.quoteOnly ? null : meltNeed(src, proofs(from), satsOf(xq.amount) + reserve);
            if (mn && mn.ok) owed = mn.need;
            if (mn && !mn.ok) {
              owed = mn.need;
              /** @type {Error & { foxyFits?: number, foxyHave?: number }} */
              var short = new Error('Moving ' + want + ' sats costs up to ' + owed +
                ' with the fee, and you hold ' + have + ' at ' + hostOf(from) + '.');
              /* And what would fit, so the screen can offer it.
               *
               * The fee is only knowable by asking, and it is asked after the
               * amount has been typed — so being told the amount is too big by
               * the width of a fee used to mean going back to the keypad and
               * working out the difference by hand. The
               * reserve in `owed` is a ceiling, so this is the conservative
               * figure: whatever the route does not spend comes back as change.
               *
               * Stepped down until the same sum says yes. It was the amount
               * less the shortfall, which the fee on a different set of
               * pieces could still refuse. */
              var fits = Math.max(0, want - (owed - have));
              var base = satsOf(xq.amount) + reserve;
              for (var tries = 0; fits > 0 && tries < 64; tries++) {
                if (meltNeed(src, proofs(from), base - (want - fits)).ok) break;
                fits -= 1;
              }
              short.foxyFits = Math.max(0, fits);
              short.foxyHave = have;
              throw short;
            }
            console.log('[foxy] transfer:', issue, 'to land at', hostOf(to), '— up to', owed,
                        'from', hostOf(from));
            return {
              from: from, to: to,
              balance: have, gross: owed,
              /* `moving` is what the far mint issues and `net` what the person
               * asked for. They are the same number on an ordinary transfer and
               * differ by the padding on a cross-mint payment. */
              moving: issue, net: want, padSats: pad,
              /* What the source mint will charge to spend proofs it has not
               * issued yet. Only meaningful on a quote asked before the money
               * arrives (`o.quoteOnly`): the receiver in a cross-mint tap melts
               * the payer's pieces, and the fee for doing so is the payer's
               * like every other fee on that path. Zero in hand, because then
               * `swapFee` above is the real number. */
              /* The same allowance at the source, for a quote asked before the
               * money arrives: the receiver melts the payer's pieces and the
               * fee for spending them is the payer's, like every other. */
              inPadSats: opts.quoteOnly
                ? (feeForInputs(src, 32) ? feeForInputs(src, 32) + 1 : 0) : 0,
              feeSats: owed - want,
              feeMax: owed - want,
              feeMin: 0,
              reserve: reserve,
              margin: 0,
              mintQuote: mq, meltQuote: xq,
            };
          });
        });
    },

    /* Carry out a plan from moveQuote.
     *
     * The order matters. The quote is written down BEFORE the melt, because
     * between paying the invoice and claiming at the far end the money is at
     * the destination mint and nowhere else — if the app dies in that window,
     * this note is the only way back to it. pendingMove() reports it and
     * connect() to that mint can finish the claim.
     */
    moveRun: function (plan, onStage, opts) {
      var stage = typeof onStage === 'function' ? onStage : function () {};
      if (!plan || !plan.to) return Promise.reject(new Error('No transfer to run.'));
      /* `opts.visit`: the far mint is somewhere this phone is going to pay
       * from and come back, not a mint it is moving to. It is connected to
       * and not saved as the phone's own, so an app killed there opens at
       * home. */
      var visit = !!(opts && opts.visit);
      var how = visit ? { remember: false } : undefined;

      if (plan.empty) {
        return FoxyWallet.connect(plan.to, null, null, how).then(function (w) {
          return { sats: 0, feeSats: 0, mint: plan.to, name: w && w.name };
        });
      }

      /* mustSave, and `unsent`: nothing has left yet, so a refused write must
       * stop the move rather than let it start. The comment above says why —
       * between paying the invoice and claiming at the far end this note is
       * the only way back to the money, and `save` reports a refusal by
       * returning false, which nothing was reading.
       *
       * Added to the others, not written over them (`moveNotes`). */
      var quoteId = plan.mintQuote.quote;
      liveMove[quoteId] = true;
      var notLive = function () { delete liveMove[quoteId]; };
      try { putMoveNote({
        to: plan.to, from: plan.from,
        quote: quoteId,
        // the invoice the melt pays: a melt given back takes its note with it (`dropMoveNoteFor`)
        request: plan.mintQuote.request,
        amount: plan.moving,
        // the quote's NUT-20 key, written before the melt like the quote itself
        lock: plan.mintQuote.foxyLock || null,
        at: Date.now(),
      }, true); } catch (eNote) { notLive(); return Promise.reject(eNote); }

      /* The far mint has to hear that its invoice was paid before it will
       * issue, and it does not always hear in the instant the near one says
       * "paid": the claim was refused "Quote not paid" with the melt already
       * made, and the crossing reported as failed (`rev-po`). Asked again
       * for a few seconds, which is all the lag ever is. */
      var claimPatiently = function (left) {
        return FoxyWallet.claimQuote(quoteId, plan.moving, plan.mintQuote.foxyLock).catch(function (e) {
          var notYet = /not paid|unpaid|not been paid/i.test(String((e && e.message) || e));
          if (!notYet || left <= 0) throw e;
          return new Promise(function (r) { setTimeout(r, 2000); }).then(function () { return claimPatiently(left - 1); });
        });
      };

      var moved = FoxyWallet.pay(plan.mintQuote.request, stage).then(null, function (e) {
        /* It did not go. If nothing is being held for it, nothing is on its
         * way, and the note would be a note of nothing: left behind, every
         * launch asked the far mint to issue a quote nobody had paid
         * (`carry-drop`). A melt that may still be going through keeps its
         * hold, and so keeps its note. */
        var held = load(K.melting, []).some(function (h) { return h && h.bolt11 === plan.mintQuote.request; });
        if (!held) dropMoveNote(quoteId);
        throw e;
      }).then(function (paid) {
        /* "It may still be going through" is not "it went". The claim was
         * tried all the same, refused, and the crossing reported as failed
         * with a melt still held. The hold and the note both stay: the sweep
         * settles the one and `finishMove` the other. */
        if (paid && paid.pending) {
          var later = /** @type {any} */ (new Error('That payment may still be going through. '
            + 'Foxy is holding the ecash until the mint says either way.'));
          later.pending = true;
          later.moveQuote = quoteId;
          throw later;
        }
        stage('switching');
        // Change from the unspent fee reserve stays under the old mint's key,
        // where it is still spendable if you ever switch back.
        return FoxyWallet.connect(plan.to, null, null, how).then(function (w) {
          stage('claiming');
          return claimPatiently(8).then(function (sats) {
            dropMoveNote(quoteId);
            // change from the unspent reserve, still sitting at the source mint
            var left = sumProofs(load(K.proofs + '.' + plan.from, []));
            if (left) console.log('[foxy]', left, 'sats change left at', hostOf(plan.from));
            return {
              sats: sats, feeSats: plan.feeSats, mint: plan.to,
              name: w && w.name, leftBehind: left, from: plan.from,
            };
          });
        }).catch(function (e) {
          /* Paid here, and not yet claimed there: said on the error, so
           * nobody downstream tells a person that nothing was sent. The note
           * is still on file and `finishMove` claims it from wherever the
           * phone is. */
          try { if (!e.pending) { e.movePaid = true; e.moveTo = plan.to; e.moveSats = plan.moving; e.moveQuote = quoteId; } } catch (x) {}
          throw e;
        });
      });
      moved.then(notLive, notLive);
      return moved;
    },

    /* ---- a payment taken at the payer's mint, brought home ---------------
     * (the job and its states: 04-lost-answers.js) */

    /* Before the visit: the job is written down, and then this phone goes to
     * their mint without saving it as its own. Resolves the job's id. */
    carryBegin: function (terms) {
      if (!terms || !terms.from || !terms.to) return Promise.reject(new Error('No way home was worked out.'));
      var job = { id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
                  home: canonicalMint(terms.to), from: canonicalMint(terms.from),
                  net: Math.round(Number(terms.net) || 0), ask: Math.round(Number(terms.ask) || 0),
                  at: Date.now(), state: 'asked' };
      try { putCarryJob(job, true); } catch (e) { return Promise.reject(e); }
      return FoxyWallet.connect(terms.from, null, null, { remember: false }).then(function () { return job.id; }, function (e) {
        dropCarryJob(job.id);
        throw e;
      });
    },

    /* Nothing came of it: the job goes, if nothing arrived for it, and the
     * phone goes home. */
    carryEnd: function (id, stay) {
      var job = carryJob(id);
      if (job && job.state === 'asked') dropCarryJob(id);
      // `stay`: another asking has taken the phone where it needs to be
      if (stay) return Promise.resolve();
      return carryGoHome(job ? job.home : '');
    },

    carryJobsOpen: function () { return carryJobs(); },

    /* Bring one home. `plan` is the way home quoted when it was asked for;
     * without it a fresh one is quoted. `opts.less`: the person has agreed to
     * what fits. Never rejects. Resolves { state, sats, why, job, ... }:
     *
     *   'home'      it landed; `sats` at the phone's own mint
     *   'moving'    the Lightning payment home was made and is not claimed
     *               yet; `finishMove` claims it, from wherever the phone is
     *   'waiting'   the payment may still be going through; held
     *   'short'     bringing it home now costs more than the payer paid for;
     *               `lands` is what would arrive — the person is asked
     *   'retry'     a mint could not be reached; tried again on the next
     *               launch or connection
     *   'refunded'  it could not be brought home, and went back to the payer
     *               (`token`, and `handed` when it crossed the link)
     *   'stuck'     it could not be brought home or sent back; it is at
     *               their mint, and the person moves it by hand
     *
     * The phone is at its own mint when this resolves, whatever happened. */
    carryHome: function (id, plan, onStage, opts) {
      var job = carryJob(id);
      if (!job) return Promise.resolve({ state: 'none' });
      /* Only a payment is carried, and the one that was paid.
       *
       * The caller holds the id of the job it began, and the payment is
       * written on whichever job of that visit was waiting when it arrived
       * (`carryArrived`). Asked twice, those are two jobs: the one named here
       * may be the spare, with nothing paid to it. The spare goes, and the
       * walk is the paid one's — on a fresh way home, since the one handed in
       * was quoted for the spare. With no paid one there is nothing to walk. */
      if (!(Number(job.kept) > 0)) {
        var from = canonicalMint(job.from), home = canonicalMint(job.home);
        var paid = carryJobs().filter(function (j) {
          return j.id !== job.id && j.state === 'paid' && Number(j.kept) > 0
            && canonicalMint(j.from) === from && canonicalMint(j.home) === home;
        }).pop() || null;
        if (job.state === 'asked' || job.state === 'paid') dropCarryJob(job.id);
        if (!paid) return carryGoHome(job.home).then(function () { return { state: 'none' }; });
        console.log('[foxy] the payment was written on another asking of this visit; that is the one brought home');
        job = paid; id = paid.id; plan = null;
      }
      // one worker per payment: whoever is already bringing it home says what became of it
      if (carryBusy[id]) return Promise.resolve({ state: 'busy', job: job });
      carryBusy[id] = true;
      var free = function () { delete carryBusy[id]; };
      var walk = carryGo(job, plan || null, onStage, opts || {}).then(null, function (e) {
        console.warn('[foxy] bringing a payment home failed in a way nobody planned for:', e && e.message);
        return { state: 'retry', why: FoxyWallet.reason ? FoxyWallet.reason(e) : String((e && e.message) || e), job: job };
      }).then(function (r) {
        return carryGoHome(job.home).then(function () { return r; });
      });
      walk.then(free, free);
      return walk;
    },

    /* Send one back to the payer: the person's own choice, where bringing it
     * home would cost more than was paid for or cannot be done. */
    carryRefund: function (id) {
      var job = carryJob(id);
      if (!job) return Promise.resolve({ state: 'none' });
      if (carryBusy[id]) return Promise.resolve({ state: 'busy', job: job });
      if (job.state !== 'paid') return Promise.resolve({ state: job.state === 'moving' ? 'moving' : 'waiting', job: job });
      // nothing was paid to it, so there is nothing to send back (`carryStep`)
      if (!(Number(job.kept) > 0)) { dropCarryJob(id); return Promise.resolve({ state: 'none' }); }
      carryBusy[id] = true;
      var free = function () { delete carryBusy[id]; };
      var walk = carryBack(job, '').then(null, function (e) {
        return { state: 'retry', why: FoxyWallet.reason ? FoxyWallet.reason(e) : String((e && e.message) || e), job: job };
      }).then(function (r) {
        return carryGoHome(job.home).then(function () { return r; });
      });
      walk.then(free, free);
      return walk;
    },

    /* Every payment still to be brought home, tried. On a launch, a return
     * from the background and a route coming back; after the melt sweep and
     * `finishMove`, so a melt that was cut has been settled either way by the
     * time this looks. It finishes by itself when the fresh cost fits inside
     * what the payer paid, and asks (`_onCarry`, state 'short') when it does
     * not. Resolves the results; each is also given to `_onCarry`. */
    carryResume: function () {
      if (carrying) return carrying;
      var jobs = carryJobs();
      if (!jobs.length || !wallet || !routeOpen()) return Promise.resolve([]);
      var home = canonicalMint(load(K.mint, '') || mintUrl || '');
      var looked = false;
      var run = jobs.reduce(function (chain, j) {
        return chain.then(function (out) {
          var job = carryJob(j.id);
          if (!job || carryBusy[job.id]) return out;
          looked = true;
          carryBusy[job.id] = true;
          var done = function () { delete carryBusy[job.id]; };
          var step = carryStep(job);
          step.then(done, done);
          return step.then(function (r) {
            if (r) {
              out.push(r);
              if (r.state !== 'asked' && r.state !== 'arrived' && typeof FoxyWallet._onCarry === 'function') {
                try { FoxyWallet._onCarry(r); } catch (x) { console.warn('[foxy] carry watcher:', x && x.message); }
              }
            }
            return out;
          }, function (e) {
            console.warn('[foxy] a payment to bring home was not looked at:', e && e.message);
            return out;
          });
        });
      }, Promise.resolve([])).then(function (out) {
        /* Home again, if this pass took the phone anywhere. With every job
         * in somebody else's hands it took it nowhere, and going "home" then
         * pulled the wallet off the payer's mint under the walk that was on
         * it: the melt was made there and written down as this mint's
         * (`logTx` names the mint the wallet is on), so two mints' entries
         * each stopped adding up (tools/live/offline-cross-scenarios.js
         * `rev-po` on a loaded machine). */
        if (!looked) return out;
        return carryGoHome(home).then(function () { return out; });
      });
      carrying = run;
      var free = function () { carrying = null; };
      run.then(free, free);
      return run;
    },

    /* Is anything left between two mints: a crossing paid and not claimed, a
     * payment taken at a payer's mint and not home, a payment somebody
     * refused and not yet taken back? Local and instant. */
    crossingsWaiting: function () {
      // pieces still held and flagged; not the notes kept of ones that were redeemed
      if (moveNotes().length || carryJobs().length || atRiskGroups().length) return true;
      var meta = load('foxy.txmeta', {});
      return Object.keys(meta).some(function (h) { return meta[h] && meta[h].refused === true && !!meta[h].token; });
    },

    /* All three, in the order they depend on each other: a crossing's claim
     * first, because a payment brought home is finished by it. Never rejects. */
    catchUpCrossings: function () {
      return FoxyWallet.finishMove()
        .then(function () { return FoxyWallet.carryResume(); })
        .then(function () { return FoxyWallet.takeBackRefused(); })
        .then(function () { return FoxyWallet.settleAtRisk(); })
        .then(null, function (e) { console.warn('[foxy] the crossings were not caught up:', e && e.message); return null; });
    },

    /* A transfer that paid but never claimed, if there is one — the oldest. */
    pendingMove: function () { return moveNotes()[0] || null; },
    pendingMoves: function () { return moveNotes(); },

    /* Finish every one. Safe to call on any launch, and from any mint: each
     * note is claimed at the mint it names, with a wallet for that mint when
     * the phone is somewhere else (`awayWallet`).
     *
     * It used to wait for the phone to be connected to the mint the money
     * went to, which after a failed crossing is exactly where the app has
     * just left: the payer went home, a receiver carrying a payment home was
     * at home already, and a paid invoice sat unclaimed until somebody
     * switched mints by hand (`move-cut`, `carry-wake`). Resolves the sats
     * that arrived, or null. */
    finishMove: function () {
      if (finishing) return finishing;
      // not the ones this page is in the middle of making (`liveMove`)
      var notes = moveNotes().filter(function (n) { return !liveMove[n.quote]; });
      if (!notes.length || !wallet || !routeOpen()) return Promise.resolve(null);
      var total = 0;
      var run = notes.reduce(function (chain, m) {
        return chain.then(function () {
          var away = canonicalMint(m.to) !== canonicalMint(mintUrl);
          return (away ? awayWallet(m.to) : Promise.resolve(null)).then(function (ow) {
            var using = ow ? { w: ow } : null;
            return FoxyWallet.claimQuote(m.quote, m.amount, m.lock, using).then(function (sats) {
              dropMoveNote(m.quote);
              total += Number(sats) || 0;
              console.log('[foxy] finished an interrupted crossing:', sats, 'sats at', hostOf(m.to));
              moveLanded(m, sats);
            }, function (e) {
              console.warn('[foxy] could not finish a crossing to', hostOf(m.to), 'yet:', e && e.message);
              if (!routeOpen()) return null;
              /* Refused because the quote is ISSUED: an earlier claim's answer was
               * lost. It used to be asked again on every launch, refused every time,
               * with the sats reachable only by a seed restore. */
              var w = onCircuit(ow || wallet, 'quote:' + m.quote);
              return withTimeout(w.checkMintQuoteBolt11(m.quote), 20000, 'the crossing quote\u2019s state').then(function (q) {
                var state = String((q && q.state) || '').toUpperCase();
                if (state === 'ISSUED') {
                  return FoxyWallet.recoverIssued(m.quote, using).then(function (sats) {
                    total += Number(sats) || 0;
                    if (sats) moveLanded(m, sats);
                  });
                }
                /* Never paid, nothing held that could still pay it, and an
                 * hour old: the melt it was written for did not happen. */
                var held = load(K.melting, []).length > 0;
                if (state === 'UNPAID' && !held && Date.now() - (Number(m.at) || 0) > 3600000) {
                  dropMoveNote(m.quote);
                  console.log('[foxy] a crossing note whose invoice was never paid is dropped');
                }
                return null;
              }).catch(function () { return null; });
            });
          }, function (e) {
            console.warn('[foxy] could not reach', hostOf(m.to), 'to finish a crossing:', e && e.message);
          });
        });
      }, Promise.resolve()).then(function () { return total || null; });
      finishing = run;
      var free = function () { finishing = null; };
      run.then(free, free);
      return run;
    },

