    /* ---- receiving ----------------------------------------------------- */

    /* Ask the mint for a quote. Returns the same shape the screens expect, so
     * `hash` here is the quote id rather than a payment hash. */
    invoice: function (sats, memo) {
      var amount = Math.round(Number(sats));
      if (!(amount > 0)) return Promise.reject(new Error('Ask for an amount above zero.'));
      var w;
      try { w = need(); } catch (e) { return Promise.reject(e); }

      // no default description: 'Foxy' on every invoice told the payer and the mint which wallet this is
      var lock = quoteLock(w);
      if (lock) console.log('[foxy] invoice: signed quote (NUT-20), a one-time key');
      return createQuote(w, amount, memo || '', lock).then(function (q) {
        var pending = load(K.quotes, []);
        pending.unshift({
          quote: q.quote, amount: amount, memo: memo || '', at: Date.now(),
          expiry: Number(q.expiry) || null,
          // which mint issued it: asking another mint about this quote is a
          // 400 on every launch, forever
          mint: mintOf(w),
          // NUT-20: the key the mint will want a signature from, in this same write
          pubkey: lock ? lock.pubkey : undefined,
          privkey: lock ? lock.privkey : undefined,
        });
        /* The cap stays — an unbounded list is worse — but it used to drop the
         * oldest invoice in silence. If that one is paid later the sweep never
         * looks for it and a manual claim is refused as "not on this device",
         * so the sats sit at the mint with nothing pointing at them. */
        /* Past the cap an invoice moves to an archive the sweep still checks,
         * rather than being forgotten: one paid later used to sit at the mint
         * with nothing pointing at it, and a manual claim was refused. */
        /* Archive first, then truncate, and both must land.
         *
         * The quote carries its NUT-20 key, and the invoice is handed to the
         * screen on the next line: a quote whose key was lost is money the
         * mint will not release. `save` reports a refusal by returning false
         * and neither of these was reading it, so a full store could hand out
         * a payable invoice this device had no record of. Archiving after the
         * truncation had the same shape — a refused archive write silently
         * dropped the overflow. */
        if (pending.length > 50) {
          var older = pending.slice(50);
          mustSave(K.quotesOld, older.concat(load(K.quotesOld, [])).slice(0, 500));
          console.warn('[foxy] the unpaid invoice list is full \u2014 archived', older.length, 'older one(s)');
        }
        mustSave(K.quotes, pending.slice(0, 50));

        return {
          bolt11: q.request,
          hash: q.quote,
          sats: amount,
          // the mint sets the window, not us — often minutes, not hours
          expiresIn: q.expiry ? Math.max(60, q.expiry - Math.floor(Date.now() / 1000)) : 900,
          qr: FoxyWallet.qr(q.request),
        };
      });
    },

    /* The watch on this invoice asks its mint now, and quickly for `ms` more
     * (twenty seconds unless said, a minute at most). False when nothing is
     * watching it. Nothing is believed on the strength of this: it is only
     * when the mint is asked. */
    watchKick: function (quoteId, ms) {
      var w = FoxyWallet._watches && FoxyWallet._watches[String(quoteId || '')];
      return !!(w && w.kick(ms));
    },

    /* Watch a quote until it is paid, then CLAIM it. The claim is the step a
     * server-backed wallet does not have: until it runs, the sats sit at the
     * mint and this device holds nothing. */
    watch: function (quoteId, onPaid, opts) {
      var o = opts || {};
      var started = Date.now();
      var deadline = started + (o.timeoutMs || 900000);
      var done = false;
      var timer = null;
      /* The caller let go. Its own flag, because `stop` alone only clears the
       * timer, and between passes there is no timer to clear: a pass is a
       * request over Tor and takes a second of every three, so a screen closed
       * during one had its watch armed again by the answer — with nothing left
       * holding the handle that could stop it. An invoice abandoned in testing
       * was still being asked about every three seconds a minute and a half later.
       * `done` cannot carry this: a failed claim sets it
       * back to false to try again. */
      var halted = false;
      /* The mint that made the invoice, which is the only one to ask.
       *
       * Each question went to whichever mint the wallet was on at that
       * moment. A phone that goes to a payer's mint to take a payment and
       * carry it home is on that mint for a while, with its own invoice
       * still on screen behind it: that invoice was asked about there every
       * three seconds, a quote the mint had never heard of, at a mint that
       * turns a phone away for asking too often (twenty-odd questions a
       * minute in testing, while it waited on that same mint for a fee quote
       * that then timed out). */
      var madeAt = '';
      try {
        var mineQ = load(K.quotes, []).filter(function (e) { return e && e.quote === quoteId; })[0];
        madeAt = canonicalMint(String((mineQ && mineQ.mint) || mintUrl || ''));
      } catch (e) { madeAt = canonicalMint(String(mintUrl || '')); }

      function stop() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
        if (FoxyWallet._watches && FoxyWallet._watches[quoteId] === mine) delete FoxyWallet._watches[quoteId];
      }

      /* Asked now, and every second for a little while (`watchKick`).
       *
       * An invoice two minutes old is asked about every ten seconds, which is
       * right for a QR code waiting on a stranger and wrong the moment there
       * is a reason to think it has just been paid: a payer's phone held
       * against this one, saying so. Bounded, so it cannot become a poller
       * that never slows down again. */
      var fastUntil = 0;
      var asking = false;
      var mine = {
        kick: function (ms) {
          if (done || halted) return false;
          fastUntil = Date.now() + Math.max(1000, Math.min(Number(ms) || 20000, 60000));
          /* Waiting on its clock: ask now. Mid-question: the next one comes
           * a second after the answer. Never a second question beside the
           * first — `timer` still held the clock that had just fired, so a
           * hurry during a question started another chain of them, and
           * every hurry after that another (simulator: thirteen
           * questions in ten seconds). */
          /* And not at all while the mint is saying "too many": the hurry
           * is then only a shorter wait, never an extra question. */
          if (!asking && !mintBusy(mintUrl)) { if (timer) clearTimeout(timer); timer = null; poll(); }
          return true;
        },
      };
      FoxyWallet._watches = FoxyWallet._watches || {};
      FoxyWallet._watches[quoteId] = mine;

      function nextDelay() {
        if (o.pollMs) return o.pollMs;
        // a mint that has just said "too many" is asked no more than once in five seconds
        if (mintBusy(mintUrl)) return 5000;
        if (Date.now() < fastUntil) return 1000;
        var age = Date.now() - started;
        // Only back off once the socket has actually DELIVERED something.
        // Registering a subscription is not evidence it works — over Tor or a
        // VPN the handshake can succeed and no message ever arrive, and the
        // old code slowed polling to 8s on that false signal, which is what
        // made a receive take 20 seconds to confirm.
        if (socketWorks) return age < 120000 ? 8000 : 30000;
        return age < 120000 ? 2000 : age < 900000 ? 10000 : 30000;
      }

      /* Instant path: the mint pushes the state change down an open socket.
       * Per NUT-17 it replays the current state on subscribe, so a payment that
       * landed between creating the quote and subscribing is not missed. */
      var unsub = null;
      var socketWorks = false;
      var claimFails = 0;

      /* No socket. cashu-ts would open wss://<mint>/v1/ws for NUT-17, and a
       * WebSocket from the page cannot be routed through the native side: it
       * resolves and connects in the clear whatever this app believes about
       * Tor. That socket is what leaked mint.macadamia.cash in capture 4.
       * Polling below does the same job a few seconds slower. */

      /* The next pass, from wherever this one ended.
       *
       * Every path out of poll() goes through here. The on-chain watcher died
       * of the opposite habit — an early return that set no timer — and took a
       * confirmed deposit with it (see
       * onchainWatch in build/app/26b-onchain.js). Nothing here is allowed to
       * be the pass that stops asking. */
      function again(ms) {
        if (done || halted) return;
        timer = setTimeout(poll, ms || nextDelay());
      }

      /* The screen's own callbacks, kept out of the mint's promise chain.
       *
       * onPaid used to be called inside the claim's then, so a render that
       * threw landed in the claim's catch: a claim that had SUCCEEDED was
       * filed by noteClaimTrouble as money paid and not collected, which
       * raises the stuck-invoice card, and three of them put the quote past
       * the `refused >= 3` filter in sweepQuotes for good. A page error is a
       * page error. */
      function tell(fn, arg) {
        if (typeof fn !== 'function') return;
        try { fn(arg); }
        catch (e) { console.error('[foxy] watch: the screen threw on an answer:', (e && e.message) || e); }
      }

      function settle() {
        if (done) return;
        done = true;
        stop();
        // two handlers, not then().catch(): only the mint's failure is the mint's failure
        FoxyWallet.claim(quoteId).then(function (sats) {
          tell(onPaid, { hash: quoteId, sats: sats });
        }, function (e) {
          noteClaimTrouble(quoteId, e);
          // invalid signatures: not asked again, so no more polling for it
          if (badSignatures(e)) { tell(o.onError, e); return; }
          /* Paid but unclaimed: the quote stays on file. Tried again after 12
           * and 36 seconds, then left to the stuck-invoice card and the next
           * sweep. This retried every 4 seconds for as long as the screen was
           * open, reserving counters each time. */
          claimFails += 1;
          tell(o.onError, e);
          if (claimFails >= 3) {
            console.warn('[foxy] claim: three tries failed; leaving it for the next sweep');
            return;
          }
          done = false;
          again(4000 * Math.pow(3, claimFails));
        });
      }

      function poll() {
        if (done || halted) return;
        timer = null;
        var asked;
        try {
          // every poll of this invoice on one circuit: the quote id links them anyway
          var w = wallet && onCircuit(wallet, 'quote:' + quoteId);
          // no wallet, or the gate is closed: do not ask the mint, do not die
          if (!w || !routeOpen()) { again(); return; }
          // away at another mint: it is asked when the phone is back (`madeAt`)
          if (madeAt && canonicalMint(String(mintUrl || '')) !== madeAt) { again(); return; }
          asked = w.checkMintQuoteBolt11(quoteId);
        } catch (e) {
          /* A throw on the way to the mint, rather than an answer from it: a
           * wallet object the switch left half-built, a keyset cashu-ts will
           * not use. Only the promise was guarded, so this ended the watching
           * for the rest of the session and the sats waited at the mint for a
           * sweep on the next launch. */
          console.warn('[foxy] watch: could not ask about the invoice —', FoxyWallet.reason(e));
          again();
          return;
        }

        asking = true;
        Promise.resolve(asked).then(function (q) {
          asking = false;
          if (q.state === 'PAID') { settle(); return; }
          if (q.state === 'ISSUED') {
            done = true; stop();
            /* Claimed — by this device, or by a claim whose answer was lost
             * after the mint issued. The second used to be taken for the
             * first. recoverIssued restores the claim's recorded outputs and
             * adds only what is not already held. */
            FoxyWallet.recoverIssued(quoteId).then(function (sats) {
              if (sats > 0) tell(onPaid, { hash: quoteId, sats: sats, recovered: true });
            }, function () {});
            return;
          }
          if (Date.now() > deadline) {
            done = true; stop();
            tell(o.onExpired);
            return;
          }
          again();
        }).catch(function () {
          asking = false;
          again();
        });
      }

      poll();
      return function () { halted = true; stop(); };
    },

    /* Turn a paid quote into proofs on this device. */
    claim: function (quoteId) {
      /* One claim per invoice, however many things ask.
       *
       * The screen's watcher and the resume sweep can both see the same
       * invoice turn PAID: they asked the mint about it twice within a second,
       * both called this, and the proof lock let them through one after the
       * other. The first took the money and dropped the quote from the list;
       * the second then found nothing on file and told the person "that
       * invoice is not on this device… restoring from your twelve words will
       * find it" — about money that had just arrived. Everyone waiting on the
       * same id now shares the first answer. */
      var going = claiming[quoteId];
      if (going) return going;
      var answer = FoxyWallet._claimOnce(quoteId);
      claiming[quoteId] = answer;
      var done = function () { delete claiming[quoteId]; };
      answer.then(done, done);
      return answer;
    },

    _claimOnce: function (quoteId) {
      var w;
      try { w = onCircuit(need(), 'quote:' + quoteId); }
      catch (e) {
        // no circuit, so nothing was asked and no counter reserved: this
        // failure must not spend one of CLAIM_TRIES_MAX (outputsRecorder)
        if (e && typeof e === 'object') e.noCounters = true;
        return Promise.reject(e);
      }
      /* The seed, before the mint is asked for the money. A claim derives its
       * secrets from it, so it is read either way; read here the Face ID goes
       * with the invoice being paid rather than landing partway through, over
       * the confirmation. openSeedForVisit does nothing while Foxy is hidden,
       * so a watcher claiming in the background is unchanged. */
      FoxyWallet.openSeedForVisit({ arriving: true });
      var pending = load(K.quotes, []);
      var entry = null;
      for (var i = 0; i < pending.length; i++) {
        if (pending[i].quote === quoteId) { entry = pending[i]; break; }
      }
      // an invoice pushed past the list's cap is archived, not forgotten
      var archived = false;
      if (!entry) {
        var old = load(K.quotesOld, []);
        for (var j = 0; j < old.length; j++) {
          if (old[j].quote === quoteId) { entry = old[j]; archived = true; break; }
        }
      }
      if (!entry) {
        /* Already collected, moments ago.
         *
         * A claim deletes its record, so whatever asks next finds nothing —
         * and used to be told the money might be lost, about sats that were
         * already in the balance. The split reconcile and the screen's watcher
         * do exactly this to each other. */
        var done = claimedMomentsAgo(quoteId);
        if (done) {
          console.log('[foxy] invoice', String(quoteId).slice(0, 13) + '\u2026',
                      'was already collected a moment ago \u2014', done.sats, 'sats');
          return Promise.resolve(done.sats);
        }
        return Promise.reject(new Error('That invoice is not on this device. '
          + 'If it was paid, the money is still at the mint \u2014 restoring from your '
          + 'twelve words will find it.'));
      }
      /* At the mint that made it, or not now.
       *
       * The question "is it paid" and this claim are two steps, and the
       * phone can change mints between them: the invoice was found paid, the
       * person switched mints, and the claim went to the mint they had just
       * arrived at — "quote not found", and a card saying an invoice was
       * stuck. Nothing was asked and no counter is
       * spent; the sweep collects it when the phone is on that mint again. */
      if (entry.mint && canonicalMint(String(entry.mint)) !== canonicalMint(String(mintOf(w) || ''))) {
        var away = /** @type {any} */ (new Error('That invoice is at ' + hostOf(entry.mint) + ', and this phone is on another mint just now. '
          + 'It is collected when the phone is back at ' + hostOf(entry.mint) + '.'));
        away.noCounters = true;
        away.foxyElsewhere = true;
        return Promise.reject(away);
      }
      // never asked again once the mint's signatures for it failed
      if (entry.unclaimed && entry.unclaimed.badSignatures) {
        return Promise.reject(new Error('This mint sent invalid signatures for that invoice, so Foxy will not ask it again.'));
      }

      /* The counter ranges this claim reserves go on the invoice's record as
       * they are reserved, before the request leaves. If the mint issues and
       * the answer is lost, the quote reads ISSUED and recoverIssued restores
       * exactly these. A range the mint refused is taken off (outputsRecorder). */
      var rec = outputsRecorder(w, entry.outputs, function (list) {
        noteQuoteOutputs(quoteId, list, mintOf(w));
      });
      return onceMoreIfSigned(w, 'claim', function () {
        return rec.attempt(function () { return mintQuoteProofs(w, entry.amount, quoteId, entry); });
      }, quoteStillPaid(w, quoteId)).then(function (fresh) {
        // the record goes in this same tick (below), so its ranges are never restored as well
        addProofs(fresh, mintOf(w), w);
        /* Read the list again, not the copy taken before the mint answered.
         * `invoice` is not in the proof lock: an invoice made while this claim
         * waited was written after that copy, and saving the copy erased it —
         * with its NUT-20 key — so a payment to it could never be claimed. */
        save(K.quotes, load(K.quotes, []).filter(function (p) { return p.quote !== quoteId; }));
        if (archived) save(K.quotesOld, load(K.quotesOld, []).filter(function (p) { return p.quote !== quoteId; }));
        // so a sweep or a reconcile arriving a moment later is not told the
        // money is missing (claimedMomentsAgo)
        noteClaimed(quoteId, sumProofs(fresh));
        logTx({
          dir: 'in',
          sats: sumProofs(fresh),
          feeSats: 0,
          settled: true,
          state: 'success',
          memo: entry.memo || '',
          hash: quoteId,
        });
        return sumProofs(fresh);
      });
    },

    /* Claim anything paid while the app was away. Safe to call repeatedly. */
    sweepQuotes: function () {
      if (!routeOpen()) {
        console.log('[foxy] quote sweep held \u2014 gate is closed');
        return Promise.resolve([]);
      }
      var w = wallet;
      if (!w) return Promise.resolve([]);

      /* Only this mint's quotes.
       *
       * The third place that asked whichever mint happened to be
       * connected about quotes another had issued — a 400 per entry, on every
       * launch. The melt sweep and the split reconcile had the same defect.
       * An entry with no mint predates the stamp and is left alone rather
       * than guessed at. */
      var hereQ = String(mintUrl || '').replace(/\/+$/, '');
      var nowS = Math.floor(Date.now() / 1000);
      /* Archived invoices too, 25 a pass, least recently asked first, so every
       * one gets its turn. Nothing is dropped before the mint is asked: an
       * invoice paid before it expired stays claimable after. */
      var old = load(K.quotesOld, []);
      var archivedQ = old.filter(function (e) { return e && e.mint === hereQ; })
        .sort(function (a, b) { return (a.checked || 0) - (b.checked || 0); })
        .slice(0, 25);
      if (archivedQ.length) {
        var turn = {};
        archivedQ.forEach(function (e) { turn[e.quote] = true; });
        save(K.quotesOld, old.map(function (e) {
          return e && turn[e.quote] ? Object.assign({}, e, { checked: nowS }) : e;
        }));
      }
      var pending = load(K.quotes, []).filter(function (e) { return e && e.mint === hereQ; })
        .concat(archivedQ)
        /* Not a quote Foxy has given up on. Each claim reserves new counters
         * the mint may never sign, and a long enough run of them opens a gap
         * wider than a restore looks across (audit W2) — so a
         * quote is dropped from the automatic sweep once it has cost enough,
         * whether the mint refused it or simply never answered (`gaveUp`).
         * The card offers one more try by hand.
         *
         * The two older conditions stay for records written before `gaveUp`. */
        .filter(function (e) {
          return !(e.unclaimed && (e.unclaimed.gaveUp || e.unclaimed.badSignatures
                                   || e.unclaimed.refused >= 3));
        });
      if (!pending.length) return Promise.resolve([]);

      var claimed = [];
      var chain = Promise.resolve();
      pending.forEach(function (entry) {
        chain = afterPause(chain).then(function () {
          /* A pause can outlast a trip to the background: its timer fires the
           * moment Foxy is back, before Tor is. Seen on a phone.
           * The rest wait for the next sweep. */
          if (!routeOpen()) return;
          // each invoice on its own circuit: asked together, they were one wallet's list
          return onCircuit(w, 'quote:' + entry.quote).checkMintQuoteBolt11(entry.quote).then(function (q) {
            /* ISSUED is claimed, but not necessarily by an answer that arrived.
             * It used to be dropped here in silence, and a claim whose answer
             * was lost left its sats reachable only by a full seed restore. */
            if (q.state === 'ISSUED') {
              return FoxyWallet.recoverIssued(entry.quote).then(function (sats) {
                if (sats > 0) claimed.push({ quote: entry.quote, sats: sats, recovered: true });
              });
            }
            if (q.state !== 'PAID') {
              /* When it expires: the mint's word now, or what it said when the
               * invoice was made. forge.flashapp.me (Nutshell 0.20.3.1) gives
               * the expiry with the new quote and `null` on every later
               * check, so nothing asked here ever expired and every unpaid
               * invoice made at such a mint was asked about on every launch
               * for good (mint survey). */
              var expires = Number(q.expiry) || Number(entry.expiry) || 0;
              if (expires && expires < nowS && q.state === 'UNPAID') {
                var gone = function (p) { return p.quote !== entry.quote; };
                save(K.quotes, load(K.quotes, []).filter(gone));
                save(K.quotesOld, load(K.quotesOld, []).filter(gone));
              }
              return;
            }
            return FoxyWallet.claim(entry.quote).then(function (sats) {
              claimed.push({ quote: entry.quote, sats: sats });
            }, function (e) {
              // only a claim that failed is "paid, not collected" — not an offline check
              noteClaimTrouble(entry.quote, e);
              throw e;
            });
          }).catch(function (e) {
            // A paid invoice that will not claim used to fail here in silence,
            // and the sats sat at the mint with nothing said. Say it.
            console.warn('[foxy] could not claim invoice', String(entry.quote).slice(0, 12) + '\u2026',
              '\u2014', FoxyWallet.reason(e));
          });
        });
      });
      return chain.then(function () { return claimed; });
    },

    /* One more claim on a paid invoice the mint refused three times, asked for
     * by the person. The count starts over, so a refusal here counts again. */
    retryRefusedClaim: function (quoteId) {
      [K.quotes, K.quotesOld].forEach(function (key) {
        var list = load(key, []);
        var changed = false;
        list.forEach(function (q) {
          if (q && q.quote === quoteId && q.unclaimed) {
            /* All of it: a quote Foxy gave up on for silence is held back by
             * the try count, and zeroing the refusals alone would leave the
             * TRY AGAIN button doing nothing. */
            q.unclaimed.refused = 0;
            q.unclaimed.tries = 0;
            q.unclaimed.gaveUp = '';
            changed = true;
          }
        });
        if (changed) save(key, list);
      });
      return FoxyWallet.claim(quoteId).catch(function (e) {
        noteClaimTrouble(quoteId, e);
        throw e;
      });
    },

    /* A quote the mint has ISSUED that this device still has on file.
     *
     * A successful claim removes the record in the same tick it saves the
     * proofs, so a record still here means the claim's answer never arrived —
     * or the claim was made before outputs were recorded. With recorded ranges
     * (claim, claimQuote), the ranges are restored; a range whose signed
     * proofs add up to the quote's amount is the claim's. Of those, what the
     * mint calls UNSPENT and nothing here holds goes into this mint's pile,
     * the receive is logged, and the record goes, all in one tick. Run twice,
     * the second run finds the record gone, or the proofs held, and adds
     * nothing.
     *
     * Asks the mint first, so it never acts on a quote that is only PAID. A
     * record with no ranges is dropped as before, with a note; a restore that
     * cannot reach the mint leaves the record for next time. Another mint's
     * record is left alone. Resolves the sats added. */
    recoverIssued: function (quoteId, away) {
      // `away`: { w } — the quote's own mint, when the phone is at another (`finishMove`)
      var base = away && away.w ? away.w : wallet;
      var w = base && onCircuit(base, 'quote:' + quoteId);
      if (!w || !routeOpen()) return Promise.resolve(0);
      var here = mintOf(w);
      var short = String(quoteId).slice(0, 12) + '…';
      var first = quoteRecord(quoteId);
      if (!first) return Promise.resolve(0);
      var at = canonicalMint(first.entry.outputsMint || first.entry.mint || first.entry.to || here);
      if (at !== here) return Promise.resolve(0);
      return withTimeout(w.checkMintQuoteBolt11(quoteId), 20000, 'the invoice’s state').then(function (q) {
        if (String((q && q.state) || '').toUpperCase() !== 'ISSUED') return 0;
        var found = quoteRecord(quoteId);
        if (!found) return 0;
        var entry = found.entry;
        var memo = found.key === K.move ? 'mint switch' : (entry.memo || '');
        if (!Array.isArray(entry.outputs) || !entry.outputs.length) {
          console.log('[foxy] invoice', short, 'is ISSUED with no claim outputs on record; dropped. ' +
            'If its claim answer was lost, a seed restore finds it.');
          dropQuoteRecord(found);
          return 0;
        }
        var amount = satsOf(entry.amount) || 0;
        return restoreRanges(w, entry.outputs, 'the claim restore', 64).then(function (rows) {
          var theirs = rows.filter(function (r) { return r.proofs.length && sumProofs(r.proofs) === amount; });
          if (!theirs.length) {
            console.warn('[foxy] invoice', short, 'is ISSUED but its recorded outputs hold',
              JSON.stringify(rows.map(function (r) { return sumProofs(r.proofs); })), 'not', amount,
              '— dropped; a seed restore finds it');
            dropQuoteRecord(found);
            return 0;
          }
          var signed = [];
          theirs.forEach(function (r) { signed = signed.concat(r.proofs); });
          return liveUnheld(w, signed).then(function (live) {
            /* The pile, then the record. The record went first, so a pile that
             * could not be written lost the claim's only way back (W6); now the
             * write throws and the record stays for the next sweep. */
            if (live.length) addProofs(live, here, w);
            var again = quoteRecord(quoteId);
            if (again) dropQuoteRecord(again);
            if (!live.length) return 0;
            var got = sumProofs(live);
            logTx({
              dir: 'in',
              sats: got,
              feeSats: 0,
              settled: true,
              state: 'success',
              memo: memo,
              hash: quoteId,
              mint: here,
            });
            console.log('[foxy] invoice', short, 'was issued but its answer was lost — restored', got, 'sats from its counters');
            return got;
          });
        });
      }).catch(function (e) {
        console.warn('[foxy] could not recover issued invoice', short, '—', FoxyWallet.reason(e));
        return 0;
      });
    },

    /* Swaps whose answer never arrived (foxy.cashu.swaps), settled against
     * the connected mint on connect and resume.
     *
     * Each record's ranges are restored. What the mint signed there and calls
     * UNSPENT, held nowhere here, goes into that mint's pile in the record's
     * unit, and the record goes in the same tick — but only when it adds up to
     * what the swap would have made (restoreSwap). Unspent proofs that do not
     * are some other operation's, and adding them counted a token already
     * handed over as balance; the record stays, with a note, and nothing is
     * added. A receive or reclaim is
     * logged as it would have been. A send or split also had its inputs still
     * in the pile; the SPENT ones are removed (pruneSpent). A record whose
     * ranges hold no signatures is kept for two minutes — its request may still
     * be reaching the mint — then dropped: the mint never made that swap. A
     * restore that fails keeps the record. Resolves [{ kind, unit, amount }]. */
    /* This mint's, then every other mint a record is at.
     *
     * A swap whose answer was lost holds its pieces back until the mint says
     * what became of it, and only the mint it was sent to can say. A payer
     * that moved sats to a receiver's mint, tried to pay there and got no
     * answer now goes home (it used to be left there), so the record is at a
     * mint the phone is not on: asked with a wallet made for that mint, as
     * the held melts are (`sweepMelts`), or the pieces would stay out of the
     * balance until the person happened to switch there
     * (tools/live/offline-cross-scenarios.js `move-fail`). */
    recoverSwaps: function () {
      if (!wallet || !routeOpen()) return Promise.resolve([]);
      return FoxyWallet._recoverSwapsOnce().then(function (out) {
        if (!routeOpen()) return out;
        var here = mintOf(wallet);
        var away = {};
        loadSwaps().forEach(function (r) {
          var at = canonicalMint((r && r.mint) || '');
          if (at && at !== here) away[at] = true;
        });
        return Object.keys(away).reduce(function (chain, at) {
          return chain.then(function (all) {
            return awayWallet(at).then(function (ow) { return FoxyWallet._recoverSwapsOnce({ w: ow, here: at }); })
              .then(function (more) { return all.concat(more || []); }, function (e) {
                console.warn('[foxy] could not ask', hostOf(at), 'about a swap that got no answer there \u2014', FoxyWallet.reason(e));
                return all;
              });
          });
        }, Promise.resolve(out || []));
      });
    },

    /* `other`: { w, here } — a wallet for a mint the phone is not connected
     * to, and that mint's address. Only the records there are looked at. */
    _recoverSwapsOnce: function (other) {
      var w = other ? other.w : wallet;
      if (!w || !routeOpen()) return Promise.resolve([]);
      var here = other ? canonicalMint(other.here) : mintOf(w);
      var nowS = Math.floor(Date.now() / 1000);
      /* Not every record, every time.
       *
       * This walks each unresolved record over the one Tor circuit, in turn,
       * on every connect AND every resume — and a locked send's record is
       * never dropped, because it is the only copy of its P2PK outputs. So a
       * handful of them become a fixed cost paid on every return to the
       * foreground: 16.6 seconds for one batch in testing, with a
       * receive screen waiting behind it for the code it could not draw until
       * the circuit was free.
       *
       * A record that has already been asked about twice and came back with
       * nothing is not urgent: the money it stands for is either gone or will
       * still be there in ten minutes. So the first two attempts are immediate,
       * as they were, and after that it is asked at most once every ten
       * minutes. Nothing is dropped and nothing is given up on — this is only
       * about how often the question is put, and the person waiting on a screen
       * is the one with somewhere to be. */
      var RETRY_EVERY = 600;
      var mine = loadSwaps().filter(function (r) {
        if (canonicalMint(r.mint) !== here) return false;
        var tried = Number(r.tried) || 0;
        if (tried < 2) return true;
        /* A record whose pieces are held back is asked about every few
         * seconds, not every ten minutes. The ten minutes is for a record
         * that costs nothing to leave; this one has taken money out of the
         * balance, and after two tries inside a minute a phone sat 16,384 sats
         * short with nothing due to happen until much later. */
        if (heldHas(r.id)) return nowS - (Number(r.lastTry) || 0) >= 3;
        return nowS - (Number(r.lastTry) || 0) >= RETRY_EVERY;
      });
      if (!mine.length) return Promise.resolve([]);
      var out = [];
      /* Marked before the walk, not after: a walk that never finishes — the app
       * backgrounded, the circuit dropped — must still count, or a record that
       * always times out is retried every single time for ever. */
      noteSwapTried(mine.map(function (r) { return r.id; }), nowS);
      return mine.reduce(function (chain, r) {
        return chain.then(function () {
          var unit = unitOf(r.unit) || 'sat';
          // each record on its own circuit
          var rw = onCircuit(w, 'swap:' + r.id);
          return (unit === 'sat' ? Promise.resolve(rw)
            : unitWallet(rw, unit).then(function (x) { return sameCircuit(rw, x); })).then(function (uw) {
            /* A locked send is asked about by its written-down outputs, not by
             * counter ranges, and is finished here if the mint made it
             * (`finishLockedSend`). Not one this page is still waiting on:
             * that one's own guard will hear, or will ask. */
            if (r.kind === 'send' && r.locked && r.locked.length) {
              if (liveSwap[r.id]) return null;
              return finishLockedSend(uw, r).then(function (got) {
                if (!got || got.state !== 'made') return;
                var wrote = writeLockedSend(uw, r, got.send, got.change);
                out.push({ kind: 'send', unit: unit, amount: wrote.sats, locked: true });
                if (typeof FoxyWallet._onSendRebuilt === 'function') {
                  try { FoxyWallet._onSendRebuilt({ sats: wrote.sats, change: (r.pay && r.pay.purpose) === 'change' }); }
                  catch (x) {}
                }
              });
            }
            return restoreSwap(uw, r).then(function (got) {
              if (!got.signed) {
                /* Held, and the mint has made nothing: twenty seconds is
                 * enough to ask whether the pieces that went in are still
                 * unspent. They are either spent by now or they never will
                 * be — the request that carried them ended in an error, so
                 * nothing of it is still on its way. Unspent, they go back
                 * in the balance; anything else waits the two minutes it
                 * always did. */
                var age = nowS - (Number(r.at) || 0);
                if (age > 20 && age <= 120 && heldHas(r.id) && r.inputs && r.inputs.length) {
                  return uw.checkProofsStates(r.inputs).then(function (states) {
                    var unspent = states.length === r.inputs.length && states.every(function (st) {
                      return (st && (st.state || st.State)) === 'UNSPENT';
                    });
                    if (!unspent) return;
                    dropSwap(r.id);
                    releaseHeld(r.id, true);
                    console.log('[foxy] a ' + r.kind + ' swap that never answered was never made, and its pieces are unspent: back in the balance after ' + age + 's');
                  });
                }
                if (nowS - (Number(r.at) || 0) > 120) {
                  dropSwap(r.id);
                  releaseHeld(r.id, true);
                  console.log('[foxy] a', r.kind, 'swap that never answered was never made by the mint — record dropped');
                }
                return;
              }
              /* A locked send's record is the only copy of its P2PK outputs, and no
         * seed can rebuild them — so it is never dropped for having no live
         * change. It used to be, which deleted the one thing that could still
         * turn that payment back into a token. */
        if (!got.live.length) { if (!(r && r.locked && r.locked.length)) { dropSwap(r.id); releaseHeld(r.id, false); } return; }
              // unspent, but not what this swap made: said by restoreSwap, the record kept
              if (!got.take) return;
              addProofs(got.take, here, uw, unit);
              // the input the mint took goes with the record (a `freeInputs` piece is still in the pile)
              dropInputsOf(r);
              dropSwap(r.id);
              releaseHeld(r.id, false);
              var amount = sumProofs(got.take);
              out.push({ kind: r.kind, unit: unit, amount: amount });
              if (r.kind === 'receive' || r.kind === 'reclaim') {
                /* The entry the swap was for, when the record names one: a
                 * request's payment already has its row from the moment it
                 * arrived, and a restore wrote a second — the same sats twice,
                 * and the audit off by that much once the pieces held on trust
                 * were found spent (force-quit mid swap).
                 * Amended instead, and the trust copy let go now: the mint has
                 * taken it. */
                var hashPre = r.kind === 'reclaim' ? 'reclaim-' : 'token-';
                var fee = r.amount ? Math.max(0, satsOf(r.amount) - amount) : 0;
                var into = typeof r.into === 'string' ? r.into : '';
                logTx(unit === 'sat'
                  ? { dir: 'in', sats: amount, feeSats: fee, settled: true, state: 'success', mint: here,
                      memo: r.kind === 'reclaim' ? 'reclaimed' : 'ecash', hash: into || hashPre + Date.now() }
                  : { dir: 'in', unit: unit, amount: amount, feeAmount: fee, sats: 0, feeSats: 0, settled: true, mint: here,
                      state: 'success', memo: 'ecash', hash: into || hashPre + Date.now() }, into || undefined);
                if (/^req-/.test(into)) {
                  try { dropUnclaimed(into.slice(4)); dropLockKey(into.slice(4)); } catch (x) {}
                }
              }
              if (r.kind === 'send' || r.kind === 'split') return pruneSpent(uw, here, unit, r.inputs);
            });
          }).catch(function (e) {
            console.warn('[foxy] could not settle a lost', r.kind, 'swap yet —', FoxyWallet.reason(e));
          });
        });
      }, Promise.resolve()).then(function () { return out; });
    },

    /* Quotes issued but not yet claimed — money that exists but is not yours
     * until it is fetched. Worth surfacing in the interface. */
    pendingQuotes: function () { return load(K.quotes, []); },

    /* Proofs reconcile set aside rather than deleted, and a way back.
     *
     * Deleted on the mint's word, they would be gone while possibly still
     * valid. Here they can be looked at, and put back if the mint was wrong
     * or lying. */
    quarantined: function () { return quarantineEntries(); },

    /* Back to the pile of the mint each came from. It used to go to whichever
     * mint was connected, where the proofs were worthless. Entries from before
     * the mint was recorded go to the connected mint, as they always did. */
    /* Runs in the proof lock, and asks the mint first.
     *
     * Only this mint's entries (and older ones with no mint) are looked at —
     * another mint's proofs cannot be checked from here and stay put. Of those,
     * the ones the mint now calls UNSPENT go back; the rest stay set aside,
     * marked as confirmed spent so they are not offered again. Written before
     * the quarantine is emptied, so nothing is ever in neither place.
     *
     * An entry with no mint (from before the mint was recorded) is looked at
     * only when its proof's keyset is one this mint issues. It used to be
     * checked against whichever mint was connected — and a mint calls a secret
     * it has never seen UNSPENT, so another mint's proof was filed here as
     * money. One whose keyset this mint does not know stays set aside and is
     * counted as `unknown`: where it came from cannot be told from here, so it
     * is not put back automatically.
     *
     * Resolves { back, stillSpent, elsewhere, unknown } in sats. */
    unquarantine: function () {
      var raw = load(K.quarantine, []);
      if (!raw.length) return Promise.resolve({ back: 0, stillSpent: 0, elsewhere: 0, unknown: 0 });
      var w = need();
      var here = mintOf(w);
      var entries = quarantineEntries();
      var mine = entries.filter(function (e) { return e.mint ? e.mint === here : keysetHere(w, e.proof.id); });
      var elsewhere = sumProofs(entries.filter(function (e) { return e.mint && e.mint !== here; })
        .map(function (e) { return e.proof; }));
      var unknown = sumProofs(entries.filter(function (e) { return !e.mint && !keysetHere(w, e.proof.id); })
        .map(function (e) { return e.proof; }));
      if (!mine.length) return Promise.resolve({ back: 0, stillSpent: 0, elsewhere: elsewhere, unknown: unknown });
      return statesOf(w, mine.map(function (e) { return e.proof; })).then(function (states) {
        var live = [], spent = {};
        mine.forEach(function (e, k) {
          if (states[k] === 'UNSPENT') live.push(e.proof);
          else spent[e.proof.secret] = true;
        });
        // each goes back to the pile of its own unit; `back` stays sats
        var unitOfSecret = {};
        mine.forEach(function (e) { unitOfSecret[e.proof.secret] = e.unit || 'sat'; });
        var liveSat = live.filter(function (p) { return unitOfSecret[p.secret] === 'sat'; });
        var back = liveSat.length ? addNewProofs(liveSat, here, w) : 0;   // records them as imported again
        var backUnits = {};
        live.forEach(function (p) {
          var u = unitOfSecret[p.secret];
          if (u !== 'sat') (backUnits[u] = backUnits[u] || []).push(p);
        });
        Object.keys(backUnits).forEach(function (u) {
          backUnits[u] = addNewProofs(backUnits[u], here, w, u);
        });
        var returned = {};
        live.forEach(function (p) { returned[p.secret] = true; });
        var nowS = Math.floor(Date.now() / 1000);
        save(K.quarantine, load(K.quarantine, []).filter(function (r) {
          var p = r && r.proof ? r.proof : r;
          return !(p && returned[p.secret]);
        }).map(function (r) {
          var p = r && r.proof ? r.proof : r;
          if (!(p && spent[p.secret])) return r;
          // the unit stays: marked without it, a usd entry read as sats
          var marked = { mint: (r && r.mint) || here, proof: p, confirmedSpent: nowS };
          if (r && r.proof && r.unit) marked.unit = r.unit;
          return marked;
        }));
        var stillSpent = sumProofs(mine.map(function (e) { return e.proof; })
          .filter(function (p) { return spent[p.secret]; }));
        console.log('[foxy] quarantine: put back', back, 'sats; the mint still calls', stillSpent, 'spent' +
          (unknown ? '; ' + unknown + ' sats from an unrecorded mint left set aside' : ''));
        var out = { back: back, stillSpent: stillSpent, elsewhere: elsewhere, unknown: unknown };
        if (Object.keys(backUnits).length) out.backUnits = backUnits;
        return out;
      });
    },

    /* What is worth offering back: not what the mint has already confirmed
     * spent. Sats only — another unit's proofs are not sats. */
    quarantinedSats: function () {
      return sumProofs(load(K.quarantine, []).filter(function (r) {
        return !(r && r.confirmedSpent) && !(r && r.proof && unitOf(r.unit) !== 'sat');
      }).map(function (r) { return r && r.proof ? r.proof : r; }).filter(function (p) {
        return p && p.secret;
      }));
    },

    /* Of quarantinedSats, the part whose mint is unknown: entries from before
     * the mint was recorded, on a keyset the connected mint does not issue
     * (all of them, with no mint connected). unquarantine leaves these set
     * aside and counts them as `unknown`; the app said nothing about them, so
     * a card offered to put back ecash that would never go back. */
    quarantinedUnknown: function () {
      var w = wallet;
      return sumProofs(load(K.quarantine, []).filter(function (r) {
        if (!r || r.confirmedSpent) return false;
        if (r.proof && (r.mint || unitOf(r.unit) !== 'sat')) return false;
        return true;
      }).map(function (r) { return r.proof ? r.proof : r; }).filter(function (p) {
        return p && p.secret && !keysetHere(w, p.id);
      }));
    },

    clearQuarantine: function () { save(K.quarantine, []); return true; },

    /* Melts whose outcome is not yet known, and the proofs they are holding. */
    pendingMelts: function () { return load(K.melting, []); },

    /* Ask the mint about a quote this wallet has no record of.
     *
     * For a payment that vanished — the process died before anything was
     * written, which was possible until the hold moved ahead of the melt. The
     * mint still knows: it issued the quote, and it knows whether it paid.
     *
     * Returns what the mint says. It cannot bring proofs back on its own —
     * those are gone from storage — but a seed restore can, and knowing
     * whether the payment actually went is what decides if that is worth
     * doing. */
    askMint: function (quoteId) {
      assertRoute();
      var w = wallet && onCircuit(wallet, 'melt:' + quoteId);
      if (!w) return Promise.reject(new Error('No mint is connected.'));
      return w.checkMeltQuoteBolt11(String(quoteId)).then(function (q) {
        var state = String((q && q.state) || 'unknown').toUpperCase();
        console.log('[foxy] the mint says quote', quoteId, 'is', state);
        return { state: state, quote: q };
      });
    },

    /* Ask the mint about every melt still in flight, and settle it.
     *
     * PAID files it spent, as a normal payment. FAILED gives the proofs
     * back, and so does UNPAID once the hold is two minutes old. Anything else is still routing and is left for the next
     * pass. Runs on resume, beside the quote sweep. */
    sweepMelts: function () {
      /* One sweep at a time, and everyone gets its answer (see `sweeping`). */
      if (sweeping) return sweeping;
      /* This mint's first, then every other mint a melt is held at.
       *
       * They used to be "left alone" until the phone was next connected
       * there. A payment carried home is melted at the PAYER's mint and the
       * phone goes straight back to its own, so a melt cut short there —
       * paid, with the answer lost — sat as a hold for as long as the person
       * stayed away from a mint they had no reason to visit: its entry
       * unwritten, and whatever the route did not use of the reserve
       * uncollected (tools/live/tap-scenarios.js F17: 19 of 20
       * sats). Asked now with a wallet made for that mint, which connects
       * the phone nowhere and changes nothing about where it is. */
      var answer = FoxyWallet._sweepMeltsOnce().then(function (settled) {
        if (!routeOpen()) return settled;
        var here = String(mintUrl || '').replace(/\/+$/, '');
        var away = {};
        load(K.melting, []).forEach(function (e) {
          var at = String((e && e.mint) || '').replace(/\/+$/, '');
          if (at && at !== here) away[at] = true;
        });
        return Object.keys(away).reduce(function (chain, at) {
          return chain.then(function (all) {
            /* Built as `connect` builds the wallet it connects with: on this
             * phone's seed, with the phone's counters. A bare wallet can ask
             * whether the melt was paid and cannot restore its change, and
             * the first cut of this settled the melt and let the unused
             * reserve go — 19 sats, on no entry (F17 again). */
            return awayWallet(at).then(function (ow) { return FoxyWallet._sweepMeltsOnce({ w: ow, here: at }); })
              .then(function (more) { return all.concat(more || []); }, function (e) {
                console.warn('[foxy] could not ask', hostOf(at), 'about a melt held there \u2014', FoxyWallet.reason(e));
                return all;
              });
          });
        }, Promise.resolve(settled || []));
      });
      sweeping = answer;
      var free = function () { sweeping = null; };
      answer.then(free, free);
      return answer;
    },

    /* `other`: { w, here } — a wallet for a mint the phone is not connected
     * to, and that mint's address. Only the melts held there are looked at. */
    _sweepMeltsOnce: function (other) {
      if (!routeOpen()) return Promise.resolve([]);
      var w = other ? other.w : wallet;
      var held = load(K.melting, []);
      if (!w || !held.length) return Promise.resolve([]);

      /* Only one mint's melts at a time.
       *
       * holdMelt records which mint a melt belongs to, and this did not read
       * it — so after switching mints the sweep asked the new mint about the
       * old one's quotes and got a 400 for each. Seen on device with two held
       * melts that could never settle because they were being asked of a mint
       * that had never heard of them. Each is asked of its own mint
       * (`sweepMelts`): the connected one here, the others with `other`. */
      var here = String((other ? other.here : mintUrl) || '').replace(/\/+$/, '');
      var mine = held.filter(function (e) {
        // a hold that names no mint is from before holds named one, and is the connected mint's
        return other ? String(e.mint || '').replace(/\/+$/, '') === here : (!e.mint || e.mint === here);
      });
      if (!mine.length) return Promise.resolve([]);

      var settled = [];
      var chain = Promise.resolve();
      mine.forEach(function (entry) {
        chain = chain.then(function () {
          // each held melt on its own circuit
          var mw = onCircuit(w, 'melt:' + entry.quote);
          return mw.checkMeltQuoteBolt11(entry.quote).then(function (q) {
            var state = String((q && q.state) || '').toUpperCase();
            if (state === 'PAID') {
              /* Deduplicated.
               *
               * A held melt whose quote had already settled — which is what a
               * crash recovery often is, and what a hand-made test entry
               * always is — returns change that this wallet already added
               * when the payment first completed. addProofs would put it in
               * twice, and the mint refuses any send containing a duplicate:
               * "Duplicate proof at index 47: each proof may appear only
               * once." Seen on device. */
              // blind signatures cannot be stored; restore the change from the melt's counters
              var usable = ((q && q.change) || []).filter(function (p) { return p && p.secret; });
              /* A hold from before `outputs` was recorded has only `counters`,
               * the snapshot taken just before the melt; its change used to
               * restore nothing here. recoverLegacyChange works out the one
               * range the melt reserved from that snapshot. */
              var restored = !usable.length;
              /* A restore that FAILED is not a melt with no change.
               *
               * It was swallowed here and read as "none came back": the entry
               * was written with the whole reserve as its fee and the hold
               * dropped, and with it the only note of where the change's
               * counters are. When the mint says it signed change and the
               * restore could not be made, the hold waits for a sweep that
               * can make it. */
              var restoreFailed = null;
              var getChange = usable.length
                ? Promise.resolve(usable)
                : (!Array.isArray(entry.outputs) && entry.counters
                  ? recoverLegacyChange(mw, entry)
                  : recoverMeltChange(mw, entry.outputs, here)).catch(function (e) { restoreFailed = e || true; return []; });
              return getChange.then(function (change) {
                if (restoreFailed && ((q && q.change) || []).length) {
                  console.warn('[foxy] held melt', entry.quote, 'was paid, but its change could not be restored yet \u2014',
                    FoxyWallet.reason(restoreFailed), '\u2014 left held for the next sweep');
                  return;
                }
                /* Not addNewProofs. That marks what it adds as imported, and
                 * change restored from this seed's counters is not: spent later,
                 * reconcile set it aside as if no restore could bring it back,
                 * where it removes this wallet's own spent proofs. */
                if (change.length) addOwnProofs(change, here, mw, undefined, restored);
                logTx({
                  dir: 'out',
                  sats: satsOf(entry.amount) || 0,
                  // what it cost beyond the amount, as pay's landed() logs it (meltFee)
                  feeSats: meltFee(sumProofs(entry.proofs || []) + (Number(entry.splitFee) || 0), entry.amount, change),
                  settled: true,
                  state: 'success',
                  memo: '',
                  hash: entry.quote,
                  bolt11: entry.bolt11 || '',
                  // where it was made, which is not always where the phone is now
                  mint: here,
                });
                dropMelt(entry.quote);
                settled.push({ quote: entry.quote, paid: true });
                console.log('[foxy] held melt', entry.quote, 'settled as paid');
              });
            }
            /* UNPAID only once the hold is two minutes old.
             *
             * A hold is written before its melt goes out, and a melt whose
             * answer never came may still be on its way: the mint reads UNPAID
             * until it arrives. Given back at once, the ecash was spendable
             * while the payment could still go through (W4). pay()
             * drops its own hold when the mint refused outright, so a hold
             * still here is one whose outcome was never learned. FAILED is the
             * mint's verdict on a payment it tried, and goes back at once. */
            var age = Math.floor(Date.now() / 1000) - (Number(entry.at) || 0);
            if (state === 'UNPAID' && age <= 120) {
              console.log('[foxy] held melt', entry.quote, 'reads UNPAID but is', age, 's old \u2014 left held');
              return;
            }
            if (state === 'UNPAID' || state === 'FAILED') {
              /* addOwnProofs, not addProofs: the whole sequence has to survive
               * being run twice. addProofs is a blind concat, and dropMelt
               * reports a refused write by returning false — so a store that
               * would not take the drop left the hold in place with the proofs
               * already back in the pile, and the next sweep added the same
               * proofs again. The mint then refuses any send containing them:
               * "each proof may appear only once". That is the duplicate the
               * PAID branch above was fixed for, reached from the other side.
               * `restored` because these are this wallet's own proofs coming
               * home, not ecash from anywhere else. */
              addOwnProofs(entry.proofs || [], here, mw, undefined, true);
              /* Charged only when the hold really went: a drop that was refused
               * leaves it for the next sweep, which would charge it again. */
              dropMelt(entry.quote);
              if (meltGone(entry.quote)) { chargeUnsentFee(here, entry.splitFee); dropMoveNoteFor(entry.bolt11); }
              settled.push({ quote: entry.quote, paid: false });
              console.log('[foxy] held melt', entry.quote,
                'did not go \u2014 returned', sumProofs(entry.proofs || []), 'sats');
              return;
            }
            /* PENDING with every input UNSPENT, two minutes on: the mint is not
             * spending them (see pay). Younger holds are left alone, in case the
             * melt request is still reaching the mint. */
            if (state === 'PENDING' && age > 120 && (entry.proofs || []).length) {
              return statesOf(mw, entry.proofs).then(function (states) {
                if (!allUnspent(states)) {
                  console.log('[foxy] held melt', entry.quote, 'still PENDING, inputs', states.join(','));
                  return;
                }
                // idempotent, like the UNPAID/FAILED branch above
                addOwnProofs(entry.proofs, here, mw, undefined, true);
                dropMelt(entry.quote);
                if (meltGone(entry.quote)) { chargeUnsentFee(here, entry.splitFee); dropMoveNoteFor(entry.bolt11); }
                settled.push({ quote: entry.quote, paid: false });
                console.log('[foxy] held melt', entry.quote, 'left PENDING by the mint but never spent \u2014 returned',
                  sumProofs(entry.proofs), 'sats');
              });
            }
            console.log('[foxy] held melt', entry.quote, 'still', state || 'unknown');
          }).catch(function (e) {
            console.warn('[foxy] could not check held melt', entry.quote,
              '\u2014', FoxyWallet.reason(e));
          });
        });
      });
      return chain.then(function () { return settled; });
    },

