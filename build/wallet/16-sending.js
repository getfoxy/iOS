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
        try { can = !!(info && info.supportsAmountless && info.supportsAmountless('bolt11', 'sat')); }
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
      /* And asked again on another circuit after five seconds of nothing
       * (`askedTwice`): a quote commits to nothing, so two cost nothing. The
       * payment then goes by the circuit that answered. The split and the
       * melt are never asked twice, and a road that would not carry a quote
       * is no road to send them down. */
      return withTimeout(askedTwice(w, 'the mint\u2019s fee quote', quoteFor), 30000, 'the mint\u2019s fee quote')
        .then(function (won) {
        var quote = won.got;
        w = won.w;
        stage('quote');
        var owed = satsOf(quote.amount) + satsOf(quote.fee_reserve);
        var at = mintOf(w);
        var have = proofs(at);
        // the split itself costs this mint's input fee, on top of the melt
        /* Said with the figure it is refused on. It named the invoice and the
         * reserve and left this mint's fee out, so a refusal read "needs 1020
         * sats … and you hold 1024" (tools/live/tap-scenarios.js 6). */
        /* The one sum (`meltNeed`): the invoice, the reserve, this mint's
         * fee for the split, and its fee again on the pieces the melt
         * spends. */
        var mn = meltNeed(w, have, owed);
        if (!mn.ok) {
          throw new Error('Not enough ecash. That payment needs ' + mn.need +
            ' sats including the fee reserve' + (mn.need > owed ? ' and this mint\u2019s fee' : '')
            + ', and you hold ' + mn.have + '.');
        }

        // split the pile into exactly what the melt needs, and what stays;
        // its output ranges are on disk until the answer is in (swapGuard)
        var splitGuard = swapGuard(w, 'split', { inputs: have });
        return splitGuard.run('payment split', function () {
          return w.send(owed, have, { includeFees: true });
        }).catch(function (e) {
          // some of that ecash was spent elsewhere: out of the pile, and made again
          return retryWithoutSpent(w, e);
        }).then(function (split) {
          /* The pile and the hold are written before the split's record is
           * cleared. The record used to go first, so a pile that could not be
           * written (storage full) left the split's outputs nowhere; now the
           * write throws with the record in place, and recoverSwaps puts them
           * back on the next connect (audit W6). Clearing it after
           * the hold adds nothing to a later restore: every output is then held
           * in the pile or the hold, and a restore adds only what is held
           * nowhere. */
          setProofs(split.keep || [], at, w);
          // the split's own input fee: what left the pile and did not go to the melt
          var splitFee = Math.max(0, sumProofs(have) - sumProofs(split.keep || []) - sumProofs(split.send || []));

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
            holdMelt(quote, split.send, inv, at, opts && opts.payee, splitFee);
          } catch (e) {
            // no hold on disk, so no melt: the proofs go back, and a pile that
            // cannot take them either keeps the split's record for recoverSwaps
            addProofs(split.send || [], at, w);
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
            addOwnProofs(change || [], at, w, undefined, restored);
            dropMelt(quote.quote);
            /* Everything the payment cost beyond its amount: the proofs it spent,
             * and the split's fee, less the change kept. This was the fee
             * reserve less the change, which left out the melt inputs' own fee
             * (NUT-02) and the split's — about 2 sats low on a live mint. */
            var feeSats = meltFee(sumProofs(split.send || []) + splitFee, quote.amount, change);
            logTx({
              dir: 'out',
              sats: satsOf(quote.amount),
              feeSats: Math.max(0, feeSats),
              settled: true,
              state: 'success',
              memo: '',
              hash: quote.quote,
              bolt11: inv,
              // the proof that this invoice was paid, when the mint gave one (`preimageOf`)
              preimage: preimage || undefined,
              // where it was paid from, which is not always where the phone is by now (`logTx`)
              mint: at,
            });
            logAudit({
              hash: quote.quote,
              sats: satsOf(quote.amount),
              feeSats: Math.max(0, feeSats),
              kind: 'melt',
              inputs: (split.send || []).map(scrub),
              outputs: (change || []).map(scrub),
            });
            return { hash: quote.quote, feeSats: Math.max(0, feeSats) };
          }

          /* It did not go: drop the hold and take the proofs back. */
          function notSent(message) {
            /* The proofs back before the hold goes, so a pile that cannot take
             * them keeps the hold (W6) — and added the deduplicating way, so a
             * dropMelt whose write was refused cannot have sweepMelts put the
             * same proofs back a second time. */
            addOwnProofs(split.send || [], at, w, undefined, true);
            dropMelt(quote.quote);
            // the split before it was made and paid for, whatever became of the melt
            if (meltGone(quote.quote)) chargeUnsentFee(at, splitFee);
            var e = /** @type {any} */ (new Error(message || 'That payment could not be routed. Nothing was sent.'));
            e.definite = true;
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
              return { hash: quote.quote, feeSats: 0, pending: true };
            }

            if (state === 'PENDING') {
              // already held, from before the request went out
              return { hash: quote.quote, feeSats: 0, pending: true };
            }

            if (state === 'UNPAID' || state === 'FAILED') throw notSent();

            // it landed: the hold is no longer needed
            return landed(res.change || [], false, preimageOf(res));
          }).catch(function (e) {
            // the payment may still have gone through; its change could not be verified
            if (badSignatures(e)) reportBadSignatures(hostOf(at), 'pay');
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
          });
        });
      });
    },

    /* A lightning address or LNURL: resolve it to an invoice, then melt.
     * The well-known request goes to the recipient's server, not the mint. */
    payLnurl: function (addr, sats, comment, onStage) {
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
      var REACH_MS = 45000;
      var get = function (u, label) {
        if (bridged()) {
          return withTimeout(FoxyWallet.nativeRequest({ endpoint: u, method: 'GET' }), REACH_MS, label);
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
        return FoxyWallet.pay(res.pr, onStage, { payee: a });
      });
    },

    payAddress: function (a, s, c, onStage) { return FoxyWallet.payLnurl(a, s, c, onStage); },

