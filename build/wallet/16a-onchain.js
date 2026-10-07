    /* ---- on chain (NUT-30) ---------------------------------------------
     *
     * Some mints settle in ordinary Bitcoin as well as Lightning. The Minibits
     * mint does (cdk-mintd): it gives an address to be paid into, credits ecash
     * once a payment has three confirmations, and pays out to an address for a
     * fee it quotes first.
     *
     * Three things make this unlike an invoice, and each one is a way to lose
     * money if it is treated like one:
     *
     *   - an address is not an invoice. It has no amount, it can be paid any
     *     number of times, and this mint gives it no expiry. So the amount the
     *     person types is only what the QR suggests (bip21), and what is
     *     watched is the quote, not a payment.
     *   - anything under the mint's floor is gone. The spec says a payment
     *     below `min_amount` does not count towards the quote and cannot be
     *     recovered, so Foxy will not show an address for less (onchainFloor).
     *   - a payout is not instant. The mint answers PENDING when it takes the
     *     ecash and PAID only once the transaction has confirmed, so a send is
     *     followed until the mint says PAID rather than settled on the spot.
     *
     * cashu-ts speaks NUT-30 itself; what is here is the wallet's side.
     */

    /* What this mint will do on chain: { receive, send } in sats, or null.
     * Read from the mint's own answer, because the amounts decide what the
     * screens allow. */
    onchainLimits: function () {
      var at = String(mintUrl || '').replace(/\/+$/, '');
      if (!at) return Promise.resolve(null);
      if (FoxyWallet._onchain && FoxyWallet._onchain.mint === at) {
        return Promise.resolve(FoxyWallet._onchain.limits);
      }
      return FoxyWallet.nativeRequest({ endpoint: at + '/v1/info', method: 'GET' }).then(function (info) {
        var nuts = (info && info.nuts) || {};
        var find = function (n) {
          var group = nuts[String(n)] || {};
          if (group.disabled) return null;
          var list = group.methods || [];
          for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (m && m.method === 'onchain' && (m.unit || 'sat') === 'sat') return m;
          }
          return null;
        };
        var mint = find(4), melt = find(5);
        var limits = (mint || melt) ? {
          receive: mint ? {
            min: onchainFloor(satsOf(mint.min_amount) || 0),
            max: satsOf(mint.max_amount) || 0,
            confirmations: Number((mint.options || {}).confirmations) || 0,
          } : null,
          send: melt ? { min: satsOf(melt.min_amount) || 0, max: satsOf(melt.max_amount) || 0 } : null,
        } : null;
        FoxyWallet._onchain = { mint: at, limits: limits };
        return limits;
      }, function () { return null; });
    },

    /** @type {any} */
    _onchain: null,

    /* An address to be paid into this wallet, kept on disk: a payment that
     * confirms tomorrow is still claimable after a restart, and this mint sets
     * no expiry, so Foxy sets its own watch window (ONCHAIN_WATCH_DAYS). */
    onchainAddress: function () {
      assertRoute();
      var w;
      try { w = need(); } catch (e) { return Promise.reject(e); }
      var lock = quoteLock(w);
      if (!lock) return Promise.reject(new Error('This mint wants a signed quote Foxy cannot make.'));
      var privkey = lock.privkey;               // kept here: the claim signs with it later
      return withTimeout(w.createMintQuoteOnchain(lock.pubkey), 30000, 'the mint’s address')
        .then(function (q) {
        var at = mintOf(w);
        var address = q && q.request;
        if (!address) throw new Error('The mint did not give an address.');
        var pending = load(K.onchain, []);
        pending.unshift({
          quote: q.quote, address: address, at: Date.now(), mint: at,
          // the whole answer: cashu-ts signs the NUT-20 message from it when claiming
          answer: q,
          privkey: privkey,
          issued: 0,
        });
        /* Trimmed by age, never by position.
         *
         * `slice(0, 30)` dropped the oldest record on the thirty-first
         * address, and its privkey with it — the key a payment to that address
         * still needs to be claimed. An address inside the watch window is
         * still live however many have been made since; what is dropped is
         * what has fallen out of the window, and only then the oldest of those
         * (audit finding 20's own pattern, found by the verification pass). */
        var window_ = Date.now() - ONCHAIN_WATCH_DAYS * 86400000;
        var live = pending.filter(function (r) { return (r && r.at) > window_; });
        var old = pending.filter(function (r) { return !((r && r.at) > window_); });
        save(K.onchain, live.concat(old.slice(0, Math.max(0, 30 - live.length))));
        console.log('[foxy] on chain: an address from', hostOf(at));
        return { quote: q.quote, address: address, mint: at };
      });
    },

    /* What the mint has seen for one address: { paid, issued }. `paid` counts
     * only what has confirmed — this mint waits for three blocks. */
    onchainSeen: function (quoteId) {
      assertRoute();
      var w;
      try { w = onCircuit(need(), 'quote:' + quoteId); } catch (e) { return Promise.reject(e); }
      return w.checkMintQuoteOnchain(String(quoteId)).then(function (q) {
        return {
          address: q.request,
          paid: satsOf(q.amount_paid),
          issued: satsOf(q.amount_issued),
          answer: q,
        };
      });
    },

    /* Claim what has confirmed and is not yet issued, up to the mint's ceiling.
     * Resolves with the sats taken, or 0 when there is nothing yet. */
    onchainClaim: function (quoteId) {
      assertRoute();
      /* What a claim writes back is what it changed, into the list as it is
       * NOW. It loaded the whole list before its round trip and saved that
       * copy after, several seconds later over Tor: an address made meanwhile
       * (the watcher claims on its own, and a person can be at RECEIVE) was
       * written into the list and then erased by the claim's save, with the
       * random key the mint needs before it releases ecash for that quote.
       * Bitcoin sent to the address on the screen was unclaimable for good.
       * `onchainAddress` is behind the proof lock as well now
       * (99-proof-lock-and-export.js), so the two never run at once. */
      var saveOnchainIssued = function (quote, issued) {
        var now = load(K.onchain, []);
        for (var k = 0; k < now.length; k++) {
          if (now[k].quote === quote) now[k].issued = issued;
        }
        save(K.onchain, now);
      };
      var pending = load(K.onchain, []);
      var record = null;
      for (var i = 0; i < pending.length; i++) if (pending[i].quote === quoteId) record = pending[i];
      if (!record) return Promise.reject(new Error('That address was not made on this device.'));
      var w;
      try { w = onCircuit(need(), 'quote:' + quoteId); } catch (e) { return Promise.reject(e); }
      if (mintOf(w) !== record.mint) {
        return Promise.reject(new Error('That address belongs to ' + hostOf(record.mint) + '.'));
      }
      return Promise.all([FoxyWallet.onchainSeen(quoteId), FoxyWallet.onchainLimits()])
        .then(function (both) {
        var seen = both[0], limits = both[1];
        var ceiling = (limits && limits.receive && limits.receive.max) || 0;
        var left = Math.max(0, seen.paid - seen.issued);
        // more than the mint will issue at once stays credited for the next pass
        var want = ceiling ? Math.min(left, ceiling) : left;

        /* Ecash the mint says it issued that this wallet never received.
         *
         * A claim whose answer was lost leaves exactly this: the mint counts
         * the outputs as issued, so `paid − issued` is nothing to claim, and
         * the sats sit in signatures the page never saw. The counters those
         * outputs came from were written down before the request
         * (noteQuoteOutputs), so they can be rebuilt here rather than waiting
         * for someone to think of a seed restore. `liveUnheld` is what keeps
         * it honest: proofs already in the pile, or spent, are not added. */
        var missed = Math.max(0, seen.issued - (Number(record.issued) || 0));
        var behind = missed > 0 && Array.isArray(record.outputs) && record.outputs.length
          ? restoreRanges(w, record.outputs, 'the on-chain claim restore', 64).then(function (rows) {
            var signed = [];
            rows.forEach(function (r) { signed = signed.concat(r.proofs); });
            if (!signed.length) return { sats: 0, hash: '' };
            return liveUnheld(w, signed).then(function (live) {
              if (!live.length) return { sats: 0, hash: '' };
              addProofs(live, mintOf(w), w);
              var back = sumProofs(live);
              var lostHash = 'onchain-' + quoteId + '-lost-' + (Number(record.issued) || 0);
              logTx({
                dir: 'in', sats: back, feeSats: 0, settled: true, state: 'success',
                hash: lostHash, to: 'on chain', network: 'ON-CHAIN', mint: mintOf(w),
              });
              FoxyWallet.tag(lostHash, { to: 'on chain' });
              record.issued = seen.issued;
              saveOnchainIssued(quoteId, record.issued);
              console.log('[foxy] on chain: a claim answer was lost \u2014 restored', back,
                          'sats from its counters');
              return { sats: back, hash: lostHash };
            });
          }, function (e) {
            console.warn('[foxy] on chain: could not rebuild a lost claim \u2014', (e && e.message) || e);
            return { sats: 0, hash: '' };
          })
          : Promise.resolve({ sats: 0, hash: '' });

        return behind.then(function (restored) {
        // nothing left to claim, but what was rebuilt is still news for the screen
        if (!want) return restored;
        var rec = outputsRecorder(w, [], function (list) { noteQuoteOutputs(quoteId, list, mintOf(w)); });
        return rec.attempt(function () {
          return w.mintProofsOnchain(want, seen.answer || record.answer, record.privkey);
        }).then(function (fresh) {
          addProofs(fresh, mintOf(w), w);
          var got = sumProofs(fresh);
          /* One address can be paid many times, so the entry is keyed by what
           * the mint had issued before this claim. The screen announcing it
           * needs the same key, and building its own from the amount just
           * taken matched nothing after a second payment to the same address. */
          var hash = 'onchain-' + quoteId + '-' + seen.issued;
          logTx({
            dir: 'in', sats: got, feeSats: 0, settled: true, state: 'success',
            hash: hash, to: 'on chain',
            network: 'ON-CHAIN', mint: mintOf(w),
          });
          FoxyWallet.tag(hash, { to: 'on chain' });
          record.issued = seen.issued + got;
          saveOnchainIssued(quoteId, record.issued);
          console.log('[foxy] on chain:', got, 'sats claimed');
          return { sats: got, hash: hash };
        });
        });
      });
    },

    /* The addresses still worth asking about at this mint: made inside the
     * watch window, and not the ones long since claimed and gone quiet. */
    onchainWatching: function () {
      var at = String(mintUrl || '').replace(/\/+$/, '');
      var cutoff = Date.now() - ONCHAIN_WATCH_DAYS * 86400000;
      return load(K.onchain, []).filter(function (r) {
        return r.mint === at && (r.at || 0) > cutoff;
      });
    },

    /* Of those, the ones worth asking about on this pass.
     *
     * An address is watched for a week, and the loop asked the mint about
     * every one of them every two minutes — on its own Tor circuit. An address
     * made in testing was still being asked about nearly five hours later,
     * 130 times over, alongside a second address and two invoices.
     * That is thousands of circuits a week for money that, if it
     * were coming, almost always arrives in the first few minutes; and it is
     * the phone's whole connection spent on asking, which is why everything
     * else on that phone was slow.
     *
     * So the cadence follows the address's age rather than being flat. It
     * never stops — the earlier bug was a watch that stopped, and a deposit
     * was lost to it — it only slows, and anything paid in the meantime is
     * still claimed the next time round.
     */
    onchainDue: function () {
      var now = Date.now();
      return FoxyWallet.onchainWatching().filter(function (r) {
        var age = now - (r.at || 0);
        var every = age < 1800000 ? 0             // the first half hour: every pass
          : age < 86400000 ? 900000               // the first day: a quarter hour
          : 3600000;                              // after that: an hour
        return (now - (r.checked || 0)) >= every;
      });
    },

    /* Remembers that this pass asked, so the pacing above has something to
     * measure from. */
    onchainAsked: function (quotes) {
      var mark = {};
      (quotes || []).forEach(function (q) { mark[q] = true; });
      if (!Object.keys(mark).length) return;
      var now = Date.now();
      save(K.onchain, load(K.onchain, []).map(function (r) {
        return r && mark[r.quote] ? Object.assign({}, r, { checked: now }) : r;
      }));
    },

    /* A quote for paying an address: what it costs, and the fees the mint
     * offers — each one a reserve and a rough wait in blocks. Nothing is spent
     * by asking, and the mint refuses an address it cannot pay, so this is also
     * where a mistyped address is caught. */
    onchainQuote: function (address, sats) {
      assertRoute();
      var w;
      try { w = need(); } catch (e) { return Promise.reject(e); }
      var to = String(address || '').trim();
      var want = Math.round(Number(sats) || 0);
      if (!to) return Promise.reject(new Error('No address to pay.'));
      if (!(want > 0)) return Promise.reject(new Error('Ask for an amount above zero.'));
      return withTimeout(w.createMeltQuoteOnchain(to, want), 30000, 'the mint’s fee quote')
        .then(function (q) {
        var options = (q.fee_options || []).map(function (o) {
          return {
            index: Number(o.fee_index),
            fee: satsOf(o.fee_reserve),
            blocks: Number(o.estimated_blocks) || 0,
          };
        }).sort(function (a, b) { return a.blocks - b.blocks || a.fee - b.fee; });
        if (!options.length) throw new Error('The mint offered no fee for that payment.');
        return {
          quote: q, id: q.quote, address: q.request || to,
          sats: satsOf(q.amount) || want,
          options: options,
          expiry: Number(q.expiry) || null,
        };
      });
    },

    /* Pay it with one of the quote's fee options.
     *
     * The mint takes the ecash and answers PENDING: it has the transaction to
     * broadcast, not a confirmation. So this resolves once the ecash is gone
     * and the payment is followed afterwards (onchainSent). */
    onchainPay: function (plan, feeIndex, onStage) {
      var stage = typeof onStage === 'function' ? onStage : function () {};
      assertRoute();
      var w;
      try { w = onCircuit(need(), 'melt:' + (plan && plan.id)); } catch (e) { return Promise.reject(e); }
      if (!plan || !plan.quote) return Promise.reject(new Error('No quote to pay.'));
      var pick = null;
      for (var i = 0; i < plan.options.length; i++) if (plan.options[i].index === feeIndex) pick = plan.options[i];
      if (!pick) return Promise.reject(new Error('That fee is not one this quote offers.'));

      var at = mintOf(w);
      var owed = plan.sats + pick.fee;
      var have = proofs(at);
      if (sumProofs(have) < owed + swapFeeFor(w, have)) {
        return Promise.reject(new Error('Not enough ecash. That payment needs ' + owed +
          ' sats including the fee reserve, and you hold ' + sumProofs(have) + '.'));
      }
      stage('quote');
      var splitGuard = swapGuard(w, 'split', { inputs: have });
      return splitGuard.run('on-chain split', function () {
        return w.send(owed, have, { includeFees: true });
      }).catch(function (e) {
        return retryWithoutSpent(w, e);
      }).then(function (split) {
        setProofs(split.keep || [], at, w);
        var spending = split.send || [];
        var splitFee = Math.max(0, sumProofs(have) - sumProofs(split.keep || []) - sumProofs(spending));

        /* Written before the melt, with the proofs in it.
         *
         * These proofs have just left the pile. If the app dies between here
         * and the mint's answer they exist nowhere else, so the record is what
         * gets them back (onchainFollow returns them when the mint says the
         * payment never happened). The Lightning path holds them in K.melting
         * for sweepMelts; an on-chain quote must not go there, because that
         * sweep asks the bolt11 endpoint about every hold it finds. */
        var sending = load(K.onchainOut, []).filter(function (r) { return r.quote !== plan.id; });
        sending.unshift({
          quote: plan.id, address: plan.address, sats: plan.sats,
          feeSats: 0, splitFee: splitFee, proofs: spending,
          at: Date.now(), mint: at, state: 'SENDING',
        });
        /* The cap keeps the list small, but a record holding proofs is the
         * only copy of them: trimming by age alone pushed the oldest payout —
         * proofs and all — off the end once thirty settled ones had piled up
         * in front of it, and those sats were then in no pile, no hold and no
         * spoken-for list. Records still holding something stay, whatever
         * their age; the settled ones are what gets trimmed. */
        var holding = sending.filter(function (r) { return ((r && r.proofs) || []).length; });
        var settled = sending.filter(function (r) { return !((r && r.proofs) || []).length; });
        mustSave(K.onchainOut, holding.concat(settled.slice(0, Math.max(0, 30 - holding.length))), true);
        /* The split's record has done its job: the proofs it was insurance for
         * are on the payout record above, which is now the thing that holds
         * them. Left open, it sat in K.swaps until the next recoverSwaps —
         * costing a restoreRanges round trip on every connect and resume,
         * refusing a seed replacement while `settling()` could see it, and
         * able to evict a genuine record from that list's last fifty. Its
         * Lightning twin has always called this (16-sending.js). */
        splitGuard.done();

        /* History, before the melt and for the same reason as the record.
         *
         * Written in the melt's error handler, this entry only existed once an
         * answer or a rejection came back — and the window it is for is the one
         * where neither ever does. An app killed there left the balance lower
         * with nothing on the history screen, and the follow that settles the
         * payment later had no entry to settle (tests/onchain-faults.js). What
         * the mint says is filled in below, on the one entry rather than a
         * second under the same hash. */
        var entry = 'onchain-' + plan.id;
        logTx({
          dir: 'out', sats: plan.sats, feeSats: splitFee, settled: false, state: 'pending',
          hash: entry, to: shortAddress(plan.address), network: 'ON-CHAIN', mint: at,
        });
        /* History names the counterparty from the tags, not the entry — and it
         * keeps the whole address beside the short one.
         *
         * `to` stays elided because several screens show it as a line of text
         * that has room for seventeen characters and not for forty-two: the
         * paid confirmation (paidTo), the announcement, the list tile. The
         * detail screen is the one place with somewhere to put an address, and
         * an address a person cannot read in full is no use for checking a
         * payment against a block explorer. So the full one
         * is its own field, and nothing that reads `to` sees any change. */
        FoxyWallet.tag(entry, { to: shortAddress(plan.address), address: plan.address });
        console.log('[foxy] on chain: holding', sumProofs(spending), 'sats against melt', plan.id);

        stage('paying');
        return w.meltProofsOnchain(plan.quote, spending, feeIndex).then(function (out) {
          /* The mint's change is read the way every other answer is: as
           * something that may be any shape at all. `(out.change || [])` let a
           * string through `change.length` and into the pile, and threw inside
           * sumProofs — in the success handler, where the sibling failure
           * handler could not see it, so a payment the mint had taken ended as
           * a TypeError on screen with the record still saying SENDING. */
          var change = usableProofs(out && out.change);
          /* The fee is measured from the proofs that actually went, not from
           * the quote's figure. With `includeFees` the split hands the melt
           * enough to cover the mint's own input fee as well as the amount and
           * the reserve, so `owed` is short by exactly that — the balance fell
           * by one sat more than the payment said it cost (testnut, live
           * on-chain run). */
          if (change.length) addProofs(change, at, w);
          // a fee that cannot be counted is not a fee: never NaN into history
          var counted = sumProofs(spending) - plan.sats - sumProofs(change);
          var paidFee = (isFinite(counted) ? Math.max(0, counted) : 0) + splitFee;
          var raw = out && (out.state || (out.quote && out.quote.state));
          /* No state means unknown, not paid: the payment is left standing and
           * onchainFollow asks the mint what became of it. */
          var state = raw ? String(raw).toUpperCase() : 'UNKNOWN';
          var gone = state === 'UNPAID' || state === 'FAILED';
          if (gone) {
            // the mint refused it: the ecash is still good, so it goes back
            addProofs(spending, at, w);
            onchainForgetOut(plan.id);
          } else {
            /* Only PAID is the end of it. PENDING means the mint holds the
             * ecash and the transaction has not confirmed, and UNKNOWN means
             * it never said what it did — and from either the quote can still
             * come back UNPAID or FAILED, at which point onchainFollow's only
             * way to give the money back is the proofs written here. Clearing
             * them on anything but PAID left nothing to return, so a payout
             * the mint dropped was gone for good. onchainFollow has always
             * cleared them on PAID alone; this now agrees with it. */
            noteOnchainOut(plan.id, state === 'PAID'
              ? { state: state, feeSats: paidFee, proofs: [] }
              : { state: state, feeSats: paidFee });
          }
          // on chain it is not done until the mint says the transaction confirmed
          amendTx(entry, {
            feeSats: paidFee,
            settled: state === 'PAID',
            state: gone ? 'failed' : state === 'PAID' ? 'success' : 'pending',
          });
          if (gone) throw new Error('The mint did not take that payment. Your ecash is still here.');
          console.log('[foxy] on chain: handed over', plan.sats, 'sats, fee', paidFee, '\u2014', state);
          return { sats: plan.sats, feeSats: paidFee, state: state, quote: plan.id,
            outpoint: (out && out.outpoint) || '' };
        }, function (e) {
          /* The mint may still have taken it: a timeout is not a refusal. The
           * proofs stay in the record and onchainFollow decides, so nothing is
           * spent twice and nothing is silently lost. */
          console.warn('[foxy] on chain: the melt did not answer cleanly \u2014', (e && e.message) || e);
          noteOnchainOut(plan.id, { state: 'UNKNOWN' });
          // the entry is already on the history screen, pending, from before the melt
          throw e;
        });
      });
    },

    /* Payments on their way out, and where they have got to. Asking the mint
     * moves them on: PENDING means broadcast is its business, PAID means the
     * transaction confirmed. */
    onchainSending: function () {
      var at = String(mintUrl || '').replace(/\/+$/, '');
      return load(K.onchainOut, []).filter(function (r) {
        return r.mint === at && r.state !== 'PAID';
      });
    },

    onchainFollow: function (quoteId) {
      assertRoute();
      var w;
      try { w = onCircuit(need(), 'melt:' + quoteId); } catch (e) { return Promise.reject(e); }
      var at = mintOf(w);
      return w.checkMeltQuoteOnchain(String(quoteId)).then(function (q) {
        var state = String(q.state || '').toUpperCase();
        var hit = /** @type {any} */ (null);
        load(K.onchainOut, []).forEach(function (r) { if (r.quote === quoteId) hit = r; });
        if (!hit) return { state: state, outpoint: q.outpoint || '', sats: 0 };

        /* The mint never took it. The proofs written down before the melt are
         * still good, so they go back to the pile rather than sitting in a
         * record forever — this is the only way back for a payment whose melt
         * was interrupted (a killed app, a dropped connection).
         *
         * Two guards, both learned on the Lightning side as W4:
         *
         *  - UNPAID is not a verdict until the record is two minutes old. A
         *    melt whose answer never arrived may still be on its way, and the
         *    mint reads UNPAID until it lands. Handed back at once, the ecash
         *    was spendable while the payout could still go through — and if it
         *    did, it was gone twice with no record left to reconcile from.
         *    FAILED is the mint's verdict on a payment it tried, and goes back
         *    at once.
         *  - Whatever the mint says, the proofs are only worth taking back if
         *    they are still unspent: `liveUnheld` asks, and drops anything the
         *    mint has already taken. */
        /* No stamp means no age, and an unknown age holds: the wait below is a
         * safety margin, so the direction to fail in is keeping the ecash. */
        var age = hit.at ? Date.now() - Number(hit.at) : 0;
        if (state === 'UNPAID' && age <= 120000) {
          console.log('[foxy] on chain: the mint reads UNPAID but the melt is only',
                      Math.round(age / 1000) + 's old \u2014 still held');
          noteOnchainOut(quoteId, { state: state });
          return { state: 'PENDING', outpoint: '', sats: hit.sats || 0 };
        }
        if (state === 'UNPAID' || state === 'FAILED') {
          var held = hit.proofs || [];
          /* Against the pile and the mint — not `liveUnheld`.
           *
           * `liveUnheld` drops whatever `everyHeldProof()` names, and since
           * these records became spoken for (so a seed scan would not count
           * them twice) this record is one of the places it looks. Every proof
           * was therefore its own reason to be dropped: nothing came back, the
           * mint was never asked, and `onchainForgetOut` then deleted the only
           * copy — a refund that destroyed exactly what it exists to return
           * (caught by tests/onchain-faults.js). */
          var mine = {};
          proofs(hit.mint || at).forEach(function (p) { if (p && p.secret) mine[p.secret] = true; });
          var candidates = held.filter(function (p) { return p && p.secret && !mine[p.secret]; });
          return (candidates.length ? statesOf(w, candidates) : Promise.resolve([])).then(function (states) {
            var live = candidates.filter(function (p, k) { return states[k] === 'UNSPENT'; });
            if (live.length) {
              // the pile first, the record after it: a write that fails leaves the way back (W6)
              addProofs(live, hit.mint || at, w);
              console.log('[foxy] on chain: the mint did not take it —', sumProofs(live), 'sats back');
            }
            if (held.length && live.length < held.length) {
              console.warn('[foxy] on chain:', held.length - live.length,
                           'of the payout\u2019s proofs are spent or already in the pile — not put back');
            }
            var log = load(K.log, []);
            log.forEach(function (e) {
              if (e.hash === 'onchain-' + quoteId) { e.state = 'failed'; e.settled = true; }
            });
            save(K.log, log);
            onchainForgetOut(quoteId);
            return { state: state, outpoint: '', sats: hit.sats || 0 };
          });
        }

        /* What it really cost, when the answer that would have said so was
         * lost. The entry written from the melt's error path knows only the
         * split's fee — the rest is read from the mint's answer, which is the
         * thing that went missing — so a payout that cost 1,022 sats showed as
         * 1,000 and one (live fault run f1). The proofs held are
         * what went to the mint, and without the answer its change is gone
         * with it, so the whole difference is the fee.
         *
         * Only when it was lost. A melt that answered wrote what the mint
         * charged onto the record (`feeSats`) and put its change back in the
         * pile, so the proofs held are no longer what the payment cost —
         * correcting from them then charged the reserve twice, and a payout
         * that cost 12 sats settled in history at 24 (the interleavings).
         * A record still carrying no fee is one whose answer
         * never arrived. */
        if (state === 'PAID' && (hit.proofs || []).length && !(Number(hit.feeSats) > 0)) {
          var went = sumProofs(hit.proofs);
          var cost = Math.max(0, went - (Number(hit.sats) || 0)) + (Number(hit.splitFee) || 0);
          var entries = load(K.log, []);
          var told = false;
          entries.forEach(function (e) {
            if (e.hash === 'onchain-' + quoteId && (Number(e.feeSats) || 0) < cost) {
              e.feeSats = cost;
              told = true;
            }
          });
          if (told) {
            save(K.log, entries);
            console.log('[foxy] on chain: the lost answer\u2019s payout really cost', cost, 'sats in fees');
          }
        }
        /* An answer with no state says nothing; writing it over the record's
         * last known state loses the little that was known. */
        noteOnchainOut(quoteId, state === 'PAID' ? { state: state, proofs: [] }
          : state ? { state: state } : {});
        if (state === 'PAID') {
          FoxyWallet.settleTx('onchain-' + quoteId);
          console.log('[foxy] on chain: a payment confirmed');
        }
        return { state: state, outpoint: q.outpoint || '', sats: hit.sats || 0 };
      });
    },

    /* BIP-21, so a payer's wallet fills the amount in for them. */
    bip21: function (address, sats) {
      var to = String(address || '').trim();
      if (!to) return '';
      var n = Math.round(Number(sats) || 0);
      if (!(n > 0)) return 'bitcoin:' + to;
      var btc = (n / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
      return 'bitcoin:' + to + '?amount=' + btc;
    },

    /* A scanned or pasted address, with the amount when the code carries one
     * (BIP-21). Null when it is not an address Foxy can pay. */
    readAddress: function (text) {
      return readBitcoinAddress(FoxyWallet.unwrap(text));
    },

