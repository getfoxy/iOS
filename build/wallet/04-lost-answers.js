  /* ---- answers the wallet never heard -----------------------------------
   *
   * A mint can do what it was asked and the answer can still be lost: the
   * connection drops after the request arrived, Tor rebuilds a circuit, the
   * app is killed. A claim then leaves its quote ISSUED, a swap leaves its
   * inputs spent, and in both the outputs the mint signed exist nowhere on
   * this device. They were derived from the seed and counters, though, so a
   * restore of exactly the counters that operation reserved (NUT-09) brings
   * them back.
   *
   * Before this, a claim whose answer was lost was dropped by the next sweep as
   * "already claimed", and a lost swap stayed hidden until reconcile removed
   * its spent inputs; either way the sats came back only from a full seed
   * restore that nothing prompted. The ranges are now written as cashu-ts
   * reserves them, and a later check restores those ranges and nothing else.
   * Only proofs the mint calls UNSPENT and this wallet does not already hold
   * are kept, so running a recovery twice adds nothing the second time. */

  /* Did the mint answer with a refusal?
   *
   * A refusal means nothing was signed: a 4xx, a coded mint error, outputs it
   * has signed before, or signatures that do not verify (which Foxy never
   * accepts, so there is nothing to recover). Anything else — no answer, a
   * timeout, a 5xx from a proxy that may have passed the request on — leaves
   * open that the mint did the work. */
  function mintRefused(e) {
    if (!e) return false;
    if (e.definite) return true;
    if (alreadySigned(e) || badSignatures(e)) return true;
    var status = Number(e.status || (e.response && e.response.status)) || 0;
    if (status >= 400 && status < 500) return true;
    // cashu-ts's own MintOperationError carries the mint's NUT error code
    if (!status && typeof e.code === 'number' && e.code >= 10000) return true;
    return false;
  }

  /* What a melt cost beyond its amount: the inputs it spent (with the split's
   * fee, where the split swapped) less the amount and the change kept. The
   * input fee a mint charges on those proofs (NUT-02) is inside that, where
   * "fee reserve less change" left it out. */
  /* `satsOf`, not `Number`.
   *
   * cashu-ts hands amounts back as an `Amount` object, and `Number(amount)`
   * reaches it through Symbol.toPrimitive — which that library deprecated and
   * says will THROW in v5. It fired on every melt, in the middle of one, which
   * is the worst place in this wallet to start throwing: the sats have left the
   * mint and the change has not come back (seen mid melt-home).
   *
   * `satsOf` asks the object for its number the way the library wants to be
   * asked, and falls back to `toString` for a build that has neither. Every
   * other amount in the wallet already goes through it; this was the one that
   * did not. */
  function meltFee(spent, amount, change) {
    return Math.max(0, satsOf(spent) - satsOf(amount) - sumProofs(change || []));
  }

  /* Does this mint issue the keyset `id`? Keyset ids are derived from a mint's
   * public keys, so one found here came from here. */
  function keysetHere(w, id) {
    if (!w || !id) return false;
    try {
      var sets = (w.keyChain && typeof w.keyChain.getKeysets === 'function') ? w.keyChain.getKeysets() : [];
      if ((sets || []).some(function (k) { return k && k.id === id; })) return true;
    } catch (e) {}
    if (keysetIdsFor(w).indexOf(id) >= 0) return true;
    return !!(w.keysetId && w.keysetId === id);
  }

  function copyRange(r) {
    return { keysetId: String(r.keysetId), start: Number(r.start) || 0, count: Number(r.count) || 0 };
  }

  /* The counter ranges one operation reserves, written as they are reserved.
   *
   * `write(list)` gets the whole list on every change, so a process that dies
   * mid-request still left the ranges on disk. An attempt the mint refused
   * signed nothing, and its ranges come off the list: a refusal for used
   * counters names counters that belong to an EARLIER operation, and restoring
   * those later would bring back that operation's outputs — a token already
   * handed to someone, counted again. */
  function outputsRecorder(w, initial, write) {
    var list = (Array.isArray(initial) ? initial : []).filter(function (r) {
      return r && r.keysetId && Number(r.count) > 0;
    }).map(copyRange);
    return {
      list: function () { return list.slice(); },
      attempt: function (run) {
        var mine = [];
        var off = watchReserved(w, function (r) {
          mine.push(r);
          list.push(r);
          write(list.map(copyRange));
        });
        var call;
        try { call = Promise.resolve(run()); } catch (e) { off(); return Promise.reject(e); }
        return call.then(function (res) { off(); return res; }, function (e) {
          off();
          if (mine.length && mintRefused(e)) {
            list = list.filter(function (r) { return mine.indexOf(r) < 0; });
            write(list.map(copyRange));
          }
          throw e;
        });
      },
    };
  }

  /* Restore the recorded ranges: [{ range, proofs }], one row per range, with
   * every proof the mint had signed there, spent or not. A range longer than
   * `cap` is cut to it; longer ranges are asked 100 at a time. */
  function restoreRanges(w, outputs, label, cap) {
    if (!w || typeof w.restore !== 'function') return Promise.resolve([]);
    var max = Number(cap) || 1000;
    var ranges = (Array.isArray(outputs) ? outputs : []).map(function (r) {
      return { id: r ? String(r.keysetId || '') : '', start: Number(r && r.start) || 0,
               count: Math.min(max, Number(r && r.count) || 0) };
    }).filter(function (r) { return r.id && r.start >= 0 && r.count > 0; });
    var rows = [];
    return ranges.reduce(function (chain, r) {
      var row = { range: r, proofs: [] };
      rows.push(row);
      for (var at = r.start; at < r.start + r.count; at += 100) {
        (function (from, n) {
          chain = chain.then(function () {
            return withTimeout(restoreFrom(w, from, n, r.id), 30000, label)
              .then(function (res) { row.proofs = row.proofs.concat((res && res.proofs) || []); });
          });
        })(at, Math.min(100, r.start + r.count - at));
      }
      return chain;
    }, Promise.resolve()).then(function () { return rows; });
  }

  /* Of these, the proofs the mint calls UNSPENT that are held nowhere here —
   * no pile, no held melt, no quarantine. */
  function liveUnheld(w, found) {
    var held = {};
    everyHeldProof().forEach(function (p) { if (p && p.secret) held[p.secret] = true; });
    var fresh = (found || []).filter(function (p) {
      if (!p || !p.secret || held[p.secret]) return false;
      held[p.secret] = true;
      return true;
    });
    if (!fresh.length) return Promise.resolve([]);
    return statesOf(w, fresh).then(function (states) {
      return fresh.filter(function (p, k) { return states[k] === 'UNSPENT'; });
    });
  }

  /* Secrets already spoken for: handed to a payment still routing, set aside in
   * quarantine, or inside a token this wallet made and sent. The mint calls all
   * of those unspent until the payment settles or the token is claimed, so a
   * seed scan must not file them as balance again. It did: switching back to an
   * emptied mint put a sent token's and a held payment's proofs back in the
   * balance (audit W1). */
  function spokenForSecrets() {
    var out = {};
    load(K.melting, []).forEach(function (m) {
      ((m && m.proofs) || []).forEach(function (p) { if (p && p.secret) out[p.secret] = true; });
    });
    /* An on-chain payout holds its proofs on its own record rather than in
     * K.melting: that sweep asks the bolt11 endpoint about everything it finds,
     * and an on-chain quote must not go to it (16a-onchain.js). Left out here,
     * a seed scan run while a payout was in flight filed those proofs as
     * balance again — W1 over again, on the newer path. */
    load(K.onchainOut, []).forEach(function (m) {
      ((m && m.proofs) || []).forEach(function (p) { if (p && p.secret) out[p.secret] = true; });
    });
    quarantineEntries().forEach(function (q) { out[q.proof.secret] = true; });
    FoxyWallet._sentTokens().forEach(function (e) {
      var info = null;
      try { info = FoxyWallet.tokenInfo(e.token); } catch (x) {}
      ((info && info.proofs) || []).forEach(function (p) { if (p && p.secret) out[p.secret] = true; });
    });
    return out;
  }

  /* ---- a claim whose answer was lost ---- */

  /* The claim's output ranges, on the quote's own record: the invoice list,
   * the archive, or the mint-switch note that carries the quote. */
  function noteQuoteOutputs(quoteId, list, mint) {
    var ranges = (list || []).map(copyRange);
    [K.quotes, K.quotesOld].forEach(function (key) {
      var all = load(key, []);
      var hit = false;
      all.forEach(function (q) {
        if (q && q.quote === quoteId) { q.outputs = ranges; q.outputsMint = mint; hit = true; }
      });
      if (hit) save(key, all);
    });
    var m = moveNote(quoteId);
    if (m) { m.outputs = ranges; m.outputsMint = mint; putMoveNote(m); }
    /* An on-chain address is a quote too, and its claim reserves counters the
     * same way. Its record lives in its own key, so none of the above found it
     * and every range was written nowhere: a claim whose answer was lost left
     * ecash the mint had already issued reachable only by a seed restore
     * (tests/onchain-faults.js). */
    var chain = load(K.onchain, []);
    var onIt = false;
    chain.forEach(function (q) {
      if (q && q.quote === quoteId) { q.outputs = ranges; q.outputsMint = mint; onIt = true; }
    });
    if (onIt) save(K.onchain, chain);
  }

  /* The record a quote's claim wrote, wherever it is: { key, entry }. */
  function quoteRecord(quoteId) {
    var keys = [K.quotes, K.quotesOld];
    for (var i = 0; i < keys.length; i++) {
      var list = load(keys[i], []);
      for (var j = 0; j < list.length; j++) {
        if (list[j] && list[j].quote === quoteId) return { key: keys[i], entry: list[j] };
      }
    }
    var m = moveNote(quoteId);
    if (m) return { key: K.move, entry: m };
    return null;
  }

  /* The notes of crossings that have paid and not yet claimed, oldest first.
   *
   * It was one note in one slot. `moveRun` wrote it before every melt and a
   * second crossing wrote over the first: with the first one's melt paid and
   * its claim still to make, the quote and the key that claims it were gone
   * — a 1,000-sat payment carried home that never arrived, and a payer down
   * 1,011 for a 500-sat payment (tools/live/offline-cross-scenarios.js
   * `carry-twice`, `move-twice`). A list, keyed by the quote; one
   * written by an older Foxy is read as a list of one. */
  function moveNotes() {
    var m = load(K.move, null);
    if (!m) return [];
    return (Array.isArray(m) ? m : [m]).filter(function (n) { return n && n.quote; });
  }
  function moveNote(quoteId) {
    return moveNotes().filter(function (n) { return n.quote === quoteId; })[0] || null;
  }
  /* `must`: the note is the only way back to a payment about to be made, so
   * a write that is refused has to stop it (mustSave). */
  function putMoveNote(note, must) {
    var l = moveNotes().filter(function (n) { return n.quote !== note.quote; });
    l.push(note);
    l = l.slice(-20);
    if (must) mustSave(K.move, l, true); else save(K.move, l);
  }
  /* The melt for this invoice was given back: it was not paid and will not
   * be, so nothing is on its way and its note is a note of nothing. */
  function dropMoveNoteFor(bolt11) {
    if (!bolt11) return;
    moveNotes().forEach(function (n) { if (n.request && n.request === bolt11) dropMoveNote(n.quote); });
  }
  function dropMoveNote(quoteId) {
    var l = moveNotes().filter(function (n) { return n.quote !== quoteId; });
    save(K.move, l.length ? l : null);
  }

  /* A wallet for a mint the phone is not connected to, built as `connect`
   * builds the one it connects with — on this phone's seed, with the phone's
   * counters — so it can claim and restore there. Connects the phone nowhere
   * and changes nothing about where it is. */
  function awayWallet(at) {
    return connectSeed().then(function (seed) {
      var ow = newWallet(at, seed ? { bip39seed: seed, secretsPolicy: 'deterministic',
                                      counterSource: sharedCounters, requireSigDleq: true } : {});
      return withTimeout(ow.loadMint(), 25000, hostOf(at)).then(function () { return ow; });
    });
  }

  /* ---- a payment taken at the payer's mint, to be brought home ----------
   *
   * A payer with no route, at another mint, can only hand over ecash its own
   * mint issued. The receiver goes there, takes it, and melts it home. Until
   * it is home it is not received: it is money at a mint this person did not
   * choose. So the job is written down BEFORE the visit —
   *
   *   { id, home, from, net, ask, at, state, reqId, hash, payerKey, kept,
   *     quote, invoice, lost, refusals }
   *
   * — and every later step finds it: the payment arriving (`carryArrived`),
   * its swap (`carryPaid`), the walk home (`carryHome`), a launch that finds
   * it unfinished (`carryResume`), and the way back to the payer when it
   * cannot be brought home at all (`carryRefund`). The visit itself is never
   * saved as the phone's own mint, so an app killed there opens at home.
   *
   * States: 'asked' (nothing has come), 'arrived' (written down, its swap
   * not known), 'paid' (this phone's, at their mint), 'moving' (a melt home
   * is made or may be), 'refunding' (being sent back). */
  function carryJobs() {
    var l = load(K.carry, []);
    return (Array.isArray(l) ? l : []).filter(function (j) { return j && j.id && j.from && j.home; });
  }
  function carryJob(id) {
    return carryJobs().filter(function (j) { return j.id === id; })[0] || null;
  }
  function putCarryJob(job, must) {
    var l = carryJobs().filter(function (j) { return j.id !== job.id; });
    l.push(job);
    l = l.slice(-20);
    if (must) mustSave(K.carry, l, true); else save(K.carry, l);
  }
  function dropCarryJob(id) {
    var l = carryJobs().filter(function (j) { return j.id !== id; });
    save(K.carry, l.length ? l : null);
  }
  function carryJobOfRequest(reqId) {
    return carryJobs().filter(function (j) { return j.reqId === reqId; })[0] || null;
  }
  /* The payment for one has been written down: which request it answered,
   * the entry it is on, and the key the payer sent for anything going back. */
  function carryArrived(p) {
    try {
      if (!p || !/^carry:/.test(String(p.purpose || ''))) return;
      var from = canonicalMint(String(p.mint || ''));
      var job = carryJobOfRequest(p.id);
      if (!job) {
        job = carryJobs().filter(function (j) {
          return j.state === 'asked' && !j.reqId && canonicalMint(j.from) === from;
        }).pop() || null;
      }
      if (!job) {
        /* Nothing was written down for it (an older page asked). Home is the
         * mint the phone has saved, which a visit never is. */
        var home = canonicalMint(load(K.mint, '') || '');
        if (!home || home === from) return;
        job = { id: 'c' + Date.now().toString(36), home: home, from: from, net: 0,
                ask: Number(p.asked) || Number(p.sats) || 0, at: Date.now() };
      }
      job.reqId = p.id;
      job.hash = 'req-' + p.id;
      job.payerKey = typeof p.changeTo === 'string' ? p.changeTo : '';
      job.state = 'arrived';
      putCarryJob(job);
    } catch (e) { console.warn('[foxy] the payment to carry home could not be noted:', e && e.message); }
  }
  /* Swapped in at their mint: this phone's now, and still to be brought home. */
  function carryPaid(reqId, kept) {
    var job = carryJobOfRequest(reqId);
    if (!job || (job.state !== 'arrived' && job.state !== 'asked')) return null;
    job.state = 'paid';
    job.kept = Math.max(0, Math.round(Number(kept) || 0));
    job.paidAt = Date.now();
    putCarryJob(job);
    return job;
  }
  /* It was not taken after all: the request is open again, or nothing is. */
  function carryGone(reqId, forGood) {
    var job = carryJobOfRequest(reqId);
    if (!job || (job.state !== 'arrived' && job.state !== 'asked')) return;
    if (forGood) { dropCarryJob(job.id); return; }
    job.state = 'asked';
    delete job.reqId; delete job.hash; delete job.payerKey;
    putCarryJob(job);
  }

  /* Back to the phone's own mint, if it is somewhere else. Never rejects. */
  function carryGoHome(home) {
    var to = canonicalMint(home || load(K.mint, '') || '');
    if (!to || canonicalMint(mintUrl || '') === to) return Promise.resolve();
    return FoxyWallet.connect(to, null, null, { remember: false }).then(function () {}, function (e) {
      console.warn('[foxy] could not get back to', hostOf(to), 'after a visit:', e && e.message);
    });
  }
  function carryVisit(at) {
    if (canonicalMint(mintUrl || '') === canonicalMint(at)) return Promise.resolve();
    return FoxyWallet.connect(at, null, null, { remember: false });
  }
  function carryWhy(e) {
    return FoxyWallet.reason ? FoxyWallet.reason(e) : String((e && e.message) || e);
  }

  /* A crossing has landed (`moveRun`, `finishMove`): if it was a payment
   * being brought home, that payment is received now, and said. */
  function moveLanded(note, sats) {
    try {
      var job = carryJobs().filter(function (j) { return j.quote && j.quote === note.quote; })[0] || null;
      if (job) {
        dropCarryJob(job.id);
        if (typeof FoxyWallet._onCarry === 'function') {
          FoxyWallet._onCarry({ state: 'home', sats: Number(sats) || 0, job: job, late: true, quote: note.quote });
        }
        return;
      }
      if (typeof FoxyWallet._onMoveFinished === 'function') {
        FoxyWallet._onMoveFinished({ sats: sats, to: note.to, from: note.from, quote: note.quote });
      }
    } catch (e) { console.warn('[foxy] a finished crossing could not be said:', e && e.message); }
  }

  /* A way home for what one payment brought, quoted now.
   *
   * It has to fit inside what the payer paid for: the amount asked, the
   * route and both mints' fees were all in the figure they agreed to, and a
   * route that has become dearer since is not this phone's to make up out of
   * its own pocket without being asked. Stepped down until it fits;
   * `lands` is what would arrive. */
  function carryPlan(job) {
    var budget = Math.max(0, (Number(job.kept) || Number(job.ask) || 0) - (Number(job.lost) || 0));
    var want = Number(job.net) > 0 ? Number(job.net) : budget;
    var step = function (amount, n) {
      if (!(amount > 0)) return Promise.reject(new Error('Bringing it home costs more than it is worth.'));
      return FoxyWallet.transferQuote(job.from, amount, { to: job.home }).then(function (plan) {
        var over = Math.max(0, Number(plan.gross) - budget);
        if (over > 0 && n < 4) return step(amount - over, n + 1);
        if (over > 0) throw new Error('The cost of bringing it home kept changing. Try again in a moment.');
        return { plan: plan, lands: amount };
      }, function (e) {
        var fits = Number(e && e.foxyFits) || 0;
        if (fits > 0 && fits < amount && n < 4) return step(fits, n + 1);
        throw e;
      });
    };
    return step(want, 0);
  }

  /* One walk home, and what became of it (the states: `carryHome`). */
  function carryGo(job, plan, onStage, o) {
    var id = job.id;
    var short = function (q) {
      job.state = 'paid'; job.short = q.lands; putCarryJob(job);
      console.log('[foxy] bringing ' + job.net + ' sats home would now land ' + q.lands + '; the person is asked');
      return { state: 'short', lands: q.lands, net: job.net, job: job, plan: q.plan };
    };
    var quoted = function (again) {
      return carryPlan(job).then(function (q) {
        if (Number(job.net) > 0 && q.lands < Number(job.net) && !o.less) return short(q);
        return run(q.plan, q.lands, again);
      }, function (e) {
        /* A mint that answered no is a refusal; twice is for good. Anything
         * else is a mint not reached, and is tried again later. */
        if (mintRefused(e) && !neverSent(e)) {
          job.refusals = (Number(job.refusals) || 0) + 1; putCarryJob(job);
          if (job.refusals >= 2) return carryBack(job, carryWhy(e));
        }
        if (/more than it is worth/i.test(String((e && e.message) || ''))
            || (e && e.foxyFits !== undefined && !(Number(e.foxyFits) > 0))) return carryBack(job, carryWhy(e));
        return { state: 'retry', why: carryWhy(e), job: job };
      });
    };
    var run = function (pl, lands, again) {
      var before = sumProofs(proofs(canonicalMint(job.from)));
      job.state = 'moving';
      job.quote = pl.mintQuote.quote;
      job.invoice = pl.mintQuote.request;
      job.lands = lands;
      delete job.short;
      putCarryJob(job);
      return carryVisit(job.from).then(function () {
        return FoxyWallet.moveRun(pl, onStage, { visit: true });
      }).then(function (done) {
        dropCarryJob(id);
        return { state: 'home', sats: Number(done && done.sats) || lands, done: done, job: job, quote: pl.mintQuote.quote };
      }, function (e) {
        var why = carryWhy(e);
        if (e && e.movePaid) {
          console.log('[foxy] the payment home was made and is not claimed yet; it is finished from here');
          return { state: 'moving', why: why, job: job };
        }
        if (e && e.pending) {
          job.state = 'waiting'; putCarryJob(job);
          return { state: 'waiting', why: why, job: job };
        }
        /* Nothing is on its way: what was to be melted is back in the pile,
         * less whatever a split that was made and not used cost. */
        var after = sumProofs(proofs(canonicalMint(job.from)));
        if (after < before) job.lost = (Number(job.lost) || 0) + (before - after);
        job.state = 'paid';
        delete job.quote; delete job.invoice;
        putCarryJob(job);
        if (e && e.definite) {
          // the mint tried and said no: once more with a fresh way home, and the second no is for good
          job.refusals = (Number(job.refusals) || 0) + 1; putCarryJob(job);
          if (job.refusals >= 2) return carryBack(job, why);
          if (!again) return quoted(true);
        }
        if (!again && /not enough ecash/i.test(String((e && e.message) || ''))) return quoted(true);
        return { state: 'retry', why: why, job: job };
      });
    };
    if (plan && plan.mintQuote) return run(plan, Number(job.net) || Number(plan.net) || 0, false);
    return quoted(false);
  }

  /* It cannot be brought home, so it goes back: the whole of what this
   * payment left at their mint, less what that mint charges to make the
   * token, locked to the key the payer sent with it.
   *
   * It is the same thing change is — ecash made at the payer's mint and
   * locked to the payer — so it travels the same way: over the link while
   * the two phones are still together, and otherwise as a code on the
   * payment's own entry for the payer to scan. The entry stops saying the
   * payment was received, because it was not. */
  function carryBack(job, why) {
    var hash = job.hash || '';
    /* Stuck is the end of the job, said once.
     *
     * It is this phone's money at their mint, and the card says so and
     * offers the screen that moves it. Left written down, the job was tried
     * again on every launch, every return and every route coming back, and
     * each try raised the same card (in testing: ten of them in nine
     * minutes). Nothing is lost by forgetting it: the sats are in that mint's
     * balance either way. */
    var stuck = function (reason) {
      dropCarryJob(job.id);
      return { state: 'stuck', why: reason, job: job };
    };
    if (!job.payerKey || !/^0[23][0-9a-f]{64}$/i.test(String(job.payerKey))) {
      console.warn('[foxy] a payment could not be brought home, and the payer sent no key to send it back to; it stays at their mint');
      return Promise.resolve(stuck((why ? why + ' ' : '') + 'The payer\u2019s phone sent nothing to send it back to.'));
    }
    return carryVisit(job.from).then(function () {
      var w = wallet;
      var owed = Math.max(0, (Number(job.kept) || 0) - (Number(job.lost) || 0));
      var back = changeFromPile(w, owed);
      if (!(back > 0)) return stuck(why);
      /* The entry first, then the swap, so a phone killed between them wakes
       * to an entry the recovered token finishes (`writeLockedSend` settles
       * change against it exactly as below). */
      var was = load(K.log, []).filter(function (e) { return e && e.hash === hash; })[0] || null;
      /* What the entry says now, less what is going back. A melt home that
       * was prepared and refused cost a split, and that is charged to this
       * same entry when it is the newest at the mint (`chargeTopUpFee`) and
       * to the mint's own tally when it is not: either way the entry keeps
       * whatever it said beyond what is owed, and no fee is counted twice. */
      job.state = 'refunding'; job.was = was ? Number(was.sats) || 0 : 0;
      putCarryJob(job);
      try {
        amendTx(hash, { sats: Math.max(0, job.was - owed), changeSats: owed, changeState: 'making',
                        refund: true, memo: 'ecash, sent back' });
      } catch (x) {}
      console.log('[foxy] a payment could not be brought home (' + (why || 'the person chose to send it back')
        + '); sending ' + back + ' sats back to the payer');
      return FoxyWallet.sendToken(back, { unit: 'sat', lockTo: job.payerKey, purpose: 'change',
                                          forHash: hash, owed: owed }).then(function (made) {
        try { FoxyWallet.tag(hash, { changeToken: String(made.token || ''), refund: true }); } catch (x) {}
        settleChangeMade(hash, owed, { sats: made.sats, fee: made.fee, back: back });
        dropCarryJob(job.id);
        var out = { state: 'refunded', sats: back, token: made.token, hash: hash, why: why, job: job, handed: false };
        var stuck = function (e) {
          owedChangeOnEntry(hash, made.token);
          try {
            if (typeof FoxyWallet._onChangeStuck === 'function') {
              FoxyWallet._onChangeStuck({ sats: back, token: made.token, hash: hash, refund: true,
                                          why: String((e && e.message) || ''), paid: owed, asked: 0 });
            }
          } catch (x) { console.warn('[foxy] the refund card could not be raised:', x && x.message); }
          return out;
        };
        if (!FoxyWallet.tapChange) return stuck(null);
        return FoxyWallet.tapChange(made.token).then(function () {
          try { amendTx(hash, { changeState: 'given back', changeKept: true }); } catch (x) {}
          out.handed = true;
          return out;
        }, stuck);
      }, function (e) {
        // not made: the entry says what it said, and the job is as it was
        try { amendTx(hash, { sats: job.was, changeSats: 0, changeState: '', refund: false, memo: 'ecash' }); } catch (x) {}
        job.state = 'paid'; putCarryJob(job);
        console.warn('[foxy] the payment could not be sent back either:', e && e.message);
        if (mintRefused(e)) return stuck(carryWhy(e));
        return { state: 'retry', why: carryWhy(e), job: job };
      });
    });
  }

  /* One job, on a launch or a connection (`carryResume`). */
  function carryStep(job) {
    var age = Date.now() - (Number(job.at) || 0);
    if (job.state === 'asked') {
      // nothing came, and the payer's patience is ninety seconds
      if (age > 180000) dropCarryJob(job.id);
      return Promise.resolve({ state: 'asked', job: job });
    }
    if (job.state === 'arrived') {
      /* Written down, and its swap not known: the late claim settles it
       * (`claimUnclaimed` marks it paid, or gone). With nothing waiting any
       * more there is nothing to bring. */
      if (!unclaimed()[job.reqId]) { dropCarryJob(job.id); return Promise.resolve(null); }
      return Promise.resolve({ state: 'arrived', job: job });
    }
    if (job.state === 'refunding') {
      var t = FoxyWallet.tagsFor(job.hash) || {};
      if (t.changeToken || t.token) {
        // made, perhaps by the recovery after a kill: it is on the entry, to be shown
        dropCarryJob(job.id);
        var token = String(t.changeToken || t.token || '');
        try { owedChangeOnEntry(job.hash, token); FoxyWallet.tag(job.hash, { changeToken: token, refund: true }); } catch (x) {}
        return Promise.resolve({ state: 'refunded', sats: 0, token: token, hash: job.hash, job: job, handed: false });
      }
      var pendingSwap = loadSwaps().some(function (r) { return r && r.pay && r.pay.forHash === job.hash; });
      if (pendingSwap) return Promise.resolve({ state: 'waiting', job: job });
      // never made: the entry goes back to what it said, and it is tried from the top
      try { amendTx(job.hash, { sats: Number(job.was) || 0, changeSats: 0, changeState: '', refund: false, memo: 'ecash' }); } catch (x) {}
      job.state = 'paid'; putCarryJob(job);
    }
    if (job.state === 'moving' || job.state === 'waiting') {
      if (job.quote && moveNote(job.quote)) {
        var held = load(K.melting, []).some(function (h) { return h && h.bolt11 === job.invoice; });
        return Promise.resolve({ state: held ? 'waiting' : 'moving', job: job });
      }
      // no note: the melt was never made, or was given back. It is at their mint still.
      job.state = 'paid'; delete job.quote; delete job.invoice; putCarryJob(job);
    }
    if (job.state !== 'paid') return Promise.resolve(null);
    /* Paid, and nothing was paid to it: not a payment.
     *
     * A job is written down when the terms are asked for, and the payment
     * is written on it when it arrives (`carryArrived`). Asked twice for one
     * payment — the link dropped while the fee was being worked out, and the
     * payer came back — there were two jobs and one payment, and the walk
     * home was started on the empty one, which a failed walk then marked
     * 'paid'. The real one came home; the empty one went on asking to bring
     * a sum home out of whatever else this phone held at that mint,
     * every time the phone woke. */
    if (!(Number(job.kept) > 0)) {
      console.log('[foxy] a payment to bring home was written down with nothing paid to it; forgotten');
      dropCarryJob(job.id);
      return Promise.resolve(null);
    }
    // a payment this phone refused and took in to send back (`refundRefused`): back it goes
    if (job.kind === 'refusal') return carryBack(job, 'refused');
    /* Still there to bring? Moved by hand from the mint screen, or spent,
     * it is no longer this job's to carry, and bringing "it" home would take
     * whatever else this phone holds at that mint. */
    var there = sumProofs(proofs(canonicalMint(job.from)));
    var owed = Math.max(1, (Number(job.kept) || 0) - (Number(job.lost) || 0));
    if (there < owed) {
      console.log('[foxy] a payment that was to be brought home is no longer at ' + hostOf(job.from)
        + ' (' + there + ' there, ' + owed + ' taken); nothing left to carry');
      dropCarryJob(job.id);
      return Promise.resolve(null);
    }
    return carryGo(job, null, null, {});
  }

  /* What a pile must hold to pay a melt of `owed` (the invoice and the
   * route's reserve), and whether it does.
   *
   * Three sums were being done in three places and they did not agree.
   * `pay`'s check and the crossing's quote both counted the invoice, the
   * reserve and the fee for swapping the pile — and left out that the pieces
   * cut for the melt pay this mint's fee again when the melt spends them
   * (includeFees). At a mint that charges, the largest amount the quote
   * allowed was one the payment then refused: "Not enough funds available to
   * send", with the fee card already agreed
   * (tools/live/offline-cross-scenarios.js `edge-move`). One
   * sum now, put to the same selection the swap makes, the way the tap
   * card's own check is (`sendShortfall`). */
  function meltNeed(w, pile, owed) {
    var n = Math.round(Number(owed) || 0);
    var bits = function (v) { return String(Math.max(0, v).toString(2)).split('1').length - 1; };
    var held = sumProofs(pile || []);
    var whole = swapFeeFor(w, pile || []);
    /* A wallet that cannot be asked what it would pick is given the plain
     * sum: the amount and the fee for swapping the whole pile. */
    if (!w || typeof w.selectProofsToSend !== 'function') {
      return { ok: held >= n + whole, need: n + whole, have: held, fee: whole };
    }
    // the melt's own fee on the pieces cut for it: one per set bit, and four to spare
    var out = n + feeForInputs(w, bits(n) + 4);
    var can = false, spend = whole, asked = true;
    try {
      var sel = w.selectProofsToSend(pile || [], out, true);
      var picked = (sel && sel.send) || [];
      can = picked.length > 0 && sumProofs(picked) - swapFeeFor(w, picked) >= out;
      if (can) spend = swapFeeFor(w, picked);
    } catch (e) { asked = false; }
    if (!asked) return { ok: held >= n + whole, need: n + whole, have: held, fee: whole };
    var need = can ? out + spend : Math.max(out + spend, held + 1);
    return { ok: can, need: need, have: held, fee: need - n };
  }

  function dropQuoteRecord(found) {
    if (found.key === K.move) { dropMoveNote(found.entry.quote); return; }
    var gone = function (p) { return !(p && p.quote === found.entry.quote); };
    save(K.quotes, load(K.quotes, []).filter(gone));
    save(K.quotesOld, load(K.quotesOld, []).filter(gone));
  }

  /* ---- a swap whose answer was lost ---- */

  /* foxy.cashu.swaps: [{ id, kind, mint, unit, at, amount, outputs, expect | inputs }].
   *
   * kind is what the swap was for. receive, reclaim and import took proofs
   * from outside, and `expect` is what their outputs add up to; send (a token)
   * and split (a payment's) took proofs from the pile, which still holds those
   * inputs after a lost answer, and `inputs` names the proofs it was handed. */
  var SWAP_IN = { receive: true, reclaim: true, import: true };
  /* The swaps this page is itself waiting on, by record id. A record that is
   * not here was written by a page that is gone — the app was killed with the
   * swap at the mint — and nothing in this one will ever hear its answer. */
  var liveSwap = {};

  function loadSwaps() {
    var l = load(K.swaps, []);
    return Array.isArray(l) ? l.filter(function (r) { return r && r.id; }) : [];
  }

  /* A record is worth keeping when it names anything the mint may have signed:
   * counter ranges, or the written-down outputs of a locked send.
   *
   * It used to be ranges alone. A locked send reserves a counter only for its
   * change, so a send whose amount the pile can make exactly — which is the
   * common case, because `tidyChange` keeps small pieces on hand for it — had
   * no range, and the whole record was dropped on the floor with the locked
   * rows inside it. A lost answer then found nothing to restore from and the
   * entire payment was destroyed: 128 sats of 400, every time.
   *
   * mustSave, not save, for the same reason the rows exist at all: a locked
   * send has no seed to fall back on, so a record that does not land is a
   * payment that cannot be recovered. A refusal throws before the swap leaves,
   * which is the whole of W6. */
  function writeSwap(rec) {
    var l = loadSwaps().filter(function (x) { return x.id !== rec.id; });
    var worth = (rec.outputs && rec.outputs.length) || (rec.locked && rec.locked.length);
    if (worth) l.push(rec);
    if (rec.locked && rec.locked.length) mustSave(K.swaps, l.slice(-50));
    else save(K.swaps, l.slice(-50));
  }

  /* When each of these was last asked about, so the sweep can space itself out.
   *
   * `recoverSwaps` walks every unresolved record over the one Tor circuit on
   * every connect and every resume, and a locked send's record is never
   * dropped — so a few of them become a fixed cost on every return to the
   * foreground, with whatever screen the person is on waiting behind it
   * (16.6 seconds in testing for one batch while a receive code
   * could not be drawn).
   *
   * Written before the walk rather than after, so a walk that never finishes —
   * backgrounded, circuit dropped — still counts. `save`, not `mustSave`: a
   * lost write here costs one extra sweep, which is the thing this is trying to
   * avoid rather than the money it is protecting.
   */
  function noteSwapTried(ids, whenS) {
    if (!ids || !ids.length) return;
    var want = {};
    ids.forEach(function (id) { want[id] = true; });
    var l = loadSwaps();
    var touched = false;
    l.forEach(function (r) {
      if (!want[r.id]) return;
      r.tried = (Number(r.tried) || 0) + 1;
      r.lastTry = whenS;
      touched = true;
    });
    if (touched) save(K.swaps, l);
  }

  /* The inputs of a swap whose answer was lost, out of the pile until the
   * mint says what became of them.
   *
   * They stayed in the pile: "the inputs a send or split spent are still in
   * the pile after its answer was lost", to be pruned once the outputs were
   * back. Between the two the wallet counted money it did not have, and
   * offline it paid five pieces to another phone of which the mint had
   * already spent one — refused as a whole, 192 sats stranded in a token
   * nobody will take. The full proofs are kept here,
   * keyed by the record, so that a swap the mint
   * never made gives them back and one it did drops them. */
  /* Only when the answer really was lost on the wire. A swap the wallet
   * itself refused before or after the request — a lock the mint cannot
   * make, a bad reply — leaves the pile as it was; it is only the mint having
   * possibly acted that puts the inputs in doubt. */
  function answerLost(e) {
    if (!e || mintRefused(e)) return false;
    /* A request that never left — the gate shut, Tor down, offline mode —
     * asked the mint nothing, so the inputs are exactly where they were.
     * "Foxy is not connected to Tor." matched /tor/ and held 16,384 sats out
     * of a balance for a swap the mint never saw. */
    if (neverSent(e)) return false;
    var m = String(e.message || e.detail || e);
    return /network|fetch|load failed|connection|did not answer|timed out|timeout|tor|no answer|abort/i.test(m);
  }

  function holdInputs(rec, e) {
    if (e !== undefined && !answerLost(e)) return 0;
    /* Checked unspent as the Tor window closed (`topUpClosing`): the piece
     * stays in the pile, spendable with no connection, and the record stays
     * so the next connection asks the mint what became of the swap. */
    if (rec.freeInputs) {
      console.log('[foxy] ' + rec.kind + ': the mint had not taken the piece when Foxy was put away; it is kept spendable, and asked about on return');
      writeSwap(rec);
      return 0;
    }
    var secrets = {};
    (rec.inputs || []).forEach(function (p) { if (p && p.secret) secrets[p.secret] = true; });
    var at = rec.mint, unit = rec.unit || 'sat';
    var pile = proofs(at, unit);
    var take = pile.filter(function (p) { return p && secrets[p.secret]; });
    if (!take.length) return 0;
    var all = load(K.held, {});
    all[rec.id] = { mint: at, unit: unit, proofs: take };
    mustSave(K.held, all);
    setProofs(pile.filter(function (p) { return !(p && secrets[p.secret]); }), at, null, unit);
    var sats = sumProofs(take);
    console.warn('[foxy] ' + formatAmount(sats, unit) + ' of a ' + rec.kind
      + ' swap that never answered is held back until the mint says whether it was made');
    return sats;
  }

  /* `back` puts them in the pile again (the mint never made the swap); otherwise
   * they were spent and are let go. */
  /* Tokens kept after they were claimed, and change kept after it was handed
   * over, are for showing — and a token of a hundred pieces is ninety
   * kilobytes. The page's store is a few megabytes and everything Foxy
   * remembers shares it, so these are capped at about a megabyte and a half:
   * past that the oldest go first. Only ever `kept` and `changeToken`, which
   * are spent or safely locked to somebody else; never `token`, which may be
   * the only copy of money nobody has taken. Changes `all` in place. */
  function trimKeptTokens(all) {
    var BUDGET = 1500000;
    var size = 0;
    var keys = Object.keys(all || {});
    keys.forEach(function (h) {
      var m = all[h] || {};
      size += (typeof m.kept === 'string' ? m.kept.length : 0)
            + (typeof m.changeToken === 'string' ? m.changeToken.length : 0);
    });
    for (var i = 0; i < keys.length && size > BUDGET; i++) {
      var m = all[keys[i]];
      if (!m) continue;
      if (typeof m.kept === 'string') { size -= m.kept.length; delete m.kept; }
      // change still owed is on `token` as well, and stays there
      if (size > BUDGET && typeof m.changeToken === 'string') { size -= m.changeToken.length; delete m.changeToken; }
    }
    return size;
  }

  /// Whether a swap record's inputs are being held back.
  function heldHas(id) {
    try { return !!load(K.held, {})[id]; } catch (e) { return false; }
  }

  function releaseHeld(id, back) {
    var all = load(K.held, {});
    var h = all[id];
    if (!h) return;
    delete all[id];
    mustSave(K.held, all);
    if (back && h.proofs && h.proofs.length) {
      setProofs(proofs(h.mint, h.unit).concat(h.proofs), h.mint, null, h.unit);
      console.log('[foxy] ' + formatAmount(sumProofs(h.proofs), h.unit || 'sat') + ' held back for a swap the mint never made is in the pile again');
    }
  }

  function dropSwap(id) {
    var l = loadSwaps();
    var left = l.filter(function (x) { return x.id !== id; });
    if (left.length !== l.length) save(K.swaps, left);
  }

  function swapKept(id) {
    return loadSwaps().some(function (x) { return x.id === id; });
  }

  /* What a swap's outputs add up to, if the mint made it: a number, or null
   * when the record cannot say.
   *
   * A receive, reclaim or import wrote it when it started: the incoming
   * proofs less the mint's input fee on them (NUT-02), which is exactly what
   * cashu-ts asks the mint to sign. A send or split was handed the whole pile
   * and cashu-ts picked from it, so the number is worked out from the mint:
   * the pile proofs it now calls SPENT are the ones the swap took, and the
   * outputs are those less their fee — kept plus sent. An input spent some
   * other way makes the number too big, which refuses a match rather than
   * adding anything. Records written before this carry neither, and give
   * null. */
  function swapExpectation(w, rec) {
    if (SWAP_IN[rec.kind]) {
      var n = Number(rec.expect);
      return Promise.resolve(rec.expect != null && isFinite(n) ? n : null);
    }
    var ins = (Array.isArray(rec.inputs) ? rec.inputs : []).filter(function (p) { return p && p.secret; });
    if (!ins.length) return Promise.resolve(null);
    return statesOf(w, ins).then(function (states) {
      var taken = ins.filter(function (p, k) { return states[k] === 'SPENT'; });
      return taken.length ? sumProofs(taken) - swapFeeFor(w, taken) : 0;
    });
  }

  /* The restored proofs that are this swap's: all of them when their sum is
   * what the swap should have made, or the one range whose sum is; otherwise
   * null.
   *
   * There was no amount check. A record whose ranges pointed at another
   * operation's outputs — two answers lost in a row, a refusal the wallet did
   * not recognise as one — added whatever unspent proofs sat there: a token
   * already handed to someone, counted as balance again. A per-range match
   * still lets a record that also holds a stray range find its own. */
  function matchExpected(rows, live, want) {
    if (want == null || !(want > 0)) return null;
    if (sumProofs(live) === want) return live;
    var ok = {};
    live.forEach(function (p) { ok[p.secret] = true; });
    var hits = rows.map(function (r) {
      var seen = {};
      return r.proofs.filter(function (p) {
        if (!p || !ok[p.secret] || seen[p.secret]) return false;
        seen[p.secret] = true;
        return true;
      });
    }).filter(function (ps) { return ps.length && sumProofs(ps) === want; });
    return hits.length === 1 ? hits[0] : null;
  }

  /* What a swap record's ranges hold: { signed, live, take }. signed counts
   * every proof the mint had signed there; live is what the mint calls
   * UNSPENT and nothing here holds; take is the part of live that matches
   * what the swap should have made (matchExpected), and is the only thing
   * ever added — null when nothing matches. */
  /* A locked send's outputs, asked for by their blinded messages.
   *
   * NUT-09's restore takes outputs, not only the counter ranges `restoreRanges`
   * walks — which is what makes a P2PK output recoverable at all, since no
   * counter ever named it. Whole or nothing: a token missing one proof is not
   * the payment that was promised, and half a payment is worse than a refusal.
   * The proofs come back locked to the receiver, so this wallet cannot spend
   * them; what it can do is hand the token over, which is what a failed
   * delivery already offers (`payRequest`). */
  function restoreLocked(w, rec) {
    var rows = (rec && Array.isArray(rec.locked) ? rec.locked : []).filter(function (r) {
      return r && r.B_ && r.id && r.secret && r.r && satsOf(r.amount) > 0;
    });
    var C = window.CashuTS;
    if (!rows.length || !w || !w.mint || typeof w.mint.restore !== 'function'
        || !C || !C.Amount || !C.OutputData) return Promise.resolve(null);
    var outs = rows.map(function (r) {
      return { amount: C.Amount.from(r.amount), B_: r.B_, id: r.id };
    });
    return withTimeout(Promise.resolve(w.mint.restore({ outputs: outs })), 30000, 'the locked restore')
      .then(function (res) {
        var sigs = (res && res.signatures) || [];
        var back = (res && res.outputs) || [];
        /* Whole means every one of ours, not merely as many as we asked for.
         * A mint that answers with one output repeated passes a count test,
         * every lookup below succeeds, and the same proof is built again and
         * again — a 21-sat payment handed over as a 48-sat token holding one
         * 16-sat proof three times. Sets, not lengths. */
        var seen = {};
        back.forEach(function (o) { if (o && o.B_) seen[String(o.B_)] = true; });
        if (sigs.length !== rows.length || back.length !== rows.length
            || Object.keys(seen).length !== rows.length
            || !rows.every(function (r) { return seen[r.B_]; })) {
          console.warn('[foxy] lost locked send: the mint signed', sigs.length, 'of', rows.length,
                       'outputs — not a whole payment, so nothing is rebuilt');
          return null;
        }
        /* Paired by blinded message, not by position: the mint answers with
         * the outputs it matched and nothing says the order is ours. */
        var byB = {};
        rows.forEach(function (r) { byB[r.B_] = r; });
        var proofs = [];
        for (var i = 0; i < back.length; i++) {
          var row = byB[String(back[i] && back[i].B_)];
          if (!row) return null;
          try { proofs.push(lockedOutput(row).toProof(sigs[i], w.keysetForSignature(sigs[i].id))); }
          catch (e) {
            console.warn('[foxy] lost locked send: an output would not rebuild —', e && e.message);
            return null;
          }
        }
        return proofs.length === rows.length ? proofs : null;
      }, function (e) {
        console.warn('[foxy] lost locked send: the mint would not say what it signed —', e && e.message);
        return null;
      });
  }

  function restoreSwap(w, rec) {
    var unit = rec.unit || 'sat';
    return restoreRanges(w, rec.outputs, 'the swap restore', 1000).then(function (rows) {
      var found = [];
      rows.forEach(function (r) { found = found.concat(r.proofs); });
      if (!found.length) return { signed: 0, live: [], take: null };
      return liveUnheld(w, found).then(/** @returns {*} */ function (live) {
        if (!live.length) return { signed: found.length, live: live, take: null };
        return swapExpectation(w, rec).then(function (want) {
          var take = matchExpected(rows, live, want);
          if (take) {
            console.log('[foxy] lost ' + rec.kind + ' swap: restored', formatAmount(sumProofs(take), unit),
              'from counters', JSON.stringify(rec.outputs));
          } else {
            console.warn('[foxy] lost ' + rec.kind + ' swap: its counters hold ' + formatAmount(sumProofs(live), unit) +
              ' unspent, ' + (want == null ? 'and the record has no amount to check it against'
                : 'not the ' + formatAmount(Math.max(0, want), unit) + ' the swap would have made') +
              ' — nothing added, the record kept; a seed restore finds what is this wallet’s. Counters',
              JSON.stringify(rec.outputs));
          }
          return { signed: found.length, live: live, take: take, want: want };
        });
      });
    });
  }

  /* The inputs a send or split spent are still in the pile after its answer
   * was lost. Once its outputs are back, the mint is asked about the pile and
   * the SPENT proofs this seed can rebuild are removed — what reconcile would
   * do on its next pass, done now so the balance is not counted twice until
   * then. Imported ones are left for reconcile, which sets them aside. */
  /// A top-up swap's fee, charged to the newest settled payment at that mint
  /// (its card then shows the full cost), or kept in the per-mint tally when
  /// no payment is there to carry it.
  /* The same for a Lightning payment that never left. The pile is split into
   * exactly what the melt needs before the melt is asked for, and that swap
   * costs this mint's fee whatever becomes of the payment: a melt that did
   * not go gave its pieces back and left a sat or two gone, on no entry
   * (tools/live/tap-scenarios.js F11). It is a fee the mint was
   * paid for a swap that was nobody's payment, which is exactly what this
   * tally is for. */
  function chargeUnsentFee(at, fee) {
    fee = Math.round(Number(fee) || 0);
    if (!(fee > 0)) return;
    console.log('[foxy] a payment that did not go through still cost ' + fee + ' sat(s) to prepare at this mint');
    chargeTopUpFee(at, fee);
  }

  function chargeTopUpFee(at, fee) {
    var here = canonicalMint(at);
    var list = load(K.log, []);
    var row = null;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || !e.hash || e.failed || e.state === 'failed') continue;
      if (e.unit && e.unit !== 'sat') continue;
      if (e.mint && canonicalMint(e.mint) !== here) continue;
      if (!(Number(e.sats) > 0) || !(e.dir === 'in' || e.dir === 'out')) continue;
      row = e;
      break;
    }
    if (row) {
      var fields = { feeSats: (Number(row.feeSats) || 0) + fee, topUpFee: (Number(row.topUpFee) || 0) + fee };
      if (row.dir === 'in') fields.sats = Math.max(0, Math.round(Number(row.sats)) - fee);
      amendTx(row.hash, fields);
      console.log('[foxy] small change: ' + fee + ' sat(s) of fee, charged to the payment before it');
      return;
    }
    try {
      var fees = load(K.topUpFees, {});
      fees[at] = (Number(fees[at]) || 0) + fee;
      save(K.topUpFees, fees);
    } catch (x) {}
  }

  /* Change that was made, settled against what was left over to make it from.
   *
   * The rule: the receiver keeps exactly what it asked
   * for, and the payer who paid over carries the cost of getting the
   * difference back. So the change is cut to what is left over LESS what it
   * costs to make and to take (`changeFor`), and normally the two sides of
   * that sum meet: what left the pile for the change is exactly what was
   * left over, and the payment's entry stands at what was asked.
   *
   * The cost is worked out before the swap and the swap is cashu-ts's to
   * shape, so it can land a sat either side. Whichever way, the entry is
   * what stayed on this phone and nothing else: `changeFee` when making it
   * cost more than was allowed for, `changeDust` when it cost less.
   *
   * Before this the whole cost was the receiver's: a request for 100 paid
   * with 128 left it 98, and one for 700 left it 698, at a mint charging
   * 150 ppk (tools/live/tap-scenarios.js 2b). And before that it was on no
   * entry at all. */
  function settleChangeMade(hash, owed, made) {
    if (!hash) return;
    var left = Math.round(Number(owed) || 0)
      - Math.round(Number(made && made.sats) || 0) - Math.round(Number(made && made.fee) || 0);
    try {
      var row = load(K.log, []).filter(function (e) { return e && e.hash === hash; })[0];
      if (!row) return;
      var fields = { changeCost: Math.max(0, Math.round(Number(owed) || 0) - Math.round(Number(made && made.back) || 0)) };
      if (left < 0) {
        fields.feeSats = (Number(row.feeSats) || 0) - left;
        fields.changeFee = (Number(row.changeFee) || 0) - left;
        fields.sats = Math.max(0, Math.round(Number(row.sats)) + left);
        console.log('[foxy] making that change cost ' + (-left) + ' sat(s) more than was allowed for, on the payment it belongs to');
      } else if (left > 0) {
        fields.changeDust = (Number(row.changeDust) || 0) + left;
        fields.sats = Math.round(Number(row.sats)) + left;
        console.log('[foxy] making that change cost ' + left + ' sat(s) less than was allowed for; they stay with the payment');
      }
      amendTx(hash, fields);
    } catch (e) { console.warn('[foxy] the change could not be settled on its entry:', e && e.message); }
  }

  /* Out of the balance at launch: what went into a locked send nobody heard
   * back from.
   *
   * A page that loses an answer holds the swap's inputs back itself
   * (`holdInputs`, in the guard's own catch). A page that was KILLED with the
   * swap at the mint never got that far: its record is on disk and the pieces
   * are still in the pile, counted, although the mint may have spent them —
   * 303 sats of a 300-sat payment shown as held and already gone, and 512
   * where one large piece went in (tools/live/tap-scenarios.js F3).
   * Held here instead, as the app opens, with or without a
   * route, until `recoverSwaps` has the mint's word on it. Only locked sends:
   * theirs is the swap where the value leaves, so theirs are the pieces that
   * must not be shown or spent on a guess. */
  function holdUnanswered(at) {
    var here = canonicalMint(at);
    var sats = 0;
    loadSwaps().forEach(function (r) {
      if (canonicalMint(r.mint) !== here || liveSwap[r.id]) return;
      if (r.kind !== 'send' || !(r.locked && r.locked.length) || r.freeInputs || heldHas(r.id)) return;
      sats += holdInputs(r);
    });
    return sats;
  }

  /* A locked send whose answer never came, asked about from its record alone.
   *
   * Resolves { state }: 'made' with the payment (`send`) and its change, when
   * the mint had signed it; 'never' when the mint says the pieces that went
   * in are unspent, so nothing happened and they are back in the pile;
   * 'kept' when it cannot be settled yet and the record stays as it is.
   *
   * `recoverSwaps` used to hand these to `restoreSwap`, which walks counter
   * ranges and nothing else. A locked payment has no counter — its outputs
   * are written down in the record as they are made — so the payment itself
   * was never looked for: with exact pieces in and no change the record had
   * no range at all, the mint was asked nothing, and after two minutes the
   * record was dropped as "never made by the mint" with the only copy of the
   * payment inside it. The live page already knew how (`restoreLocked`, in
   * the guard); this is the same question put after a relaunch. */
  /** @returns {Promise<any>} */
  function finishLockedSend(w, rec) {
    var ins = (Array.isArray(rec.inputs) ? rec.inputs : []).filter(function (p) { return p && p.secret; });
    return restoreLocked(w, rec).then(function (made) {
      if (!made) {
        /* Not signed, or not whole, or the mint would not say. Whether the
         * swap happened is the inputs' to tell: all unspent means the mint
         * never made it. Anything else and the record is the only thing that
         * can still rebuild the payment, so it is never dropped on its age. */
        if (!ins.length) return { state: 'kept' };
        return statesOf(w, ins).then(function (states) {
          var unspent = states.length === ins.length
            && states.every(function (st) { return st === 'UNSPENT'; });
          if (!unspent) {
            console.warn('[foxy] a locked payment the mint took the pieces for could not be rebuilt yet; its record is kept');
            return { state: 'kept' };
          }
          dropSwap(rec.id);
          releaseHeld(rec.id, true);
          console.log('[foxy] a locked payment that never answered was never made by the mint: its pieces are unspent and back in the balance');
          return { state: 'never' };
        });
      }
      return restoreRanges(w, rec.outputs, 'the locked send\u2019s change', 1000).then(function (rows) {
        var found = [];
        rows.forEach(function (r) { found = found.concat(r.proofs); });
        var ranges = /** @type {Array<any>} */ (rec.outputs || []);
        var wanted = ranges.reduce(function (n, r) { return n + (Number(r && r.count) || 0); }, 0);
        // both halves or neither, as in the guard: the payment without its change is not written
        if (wanted > 0 && !found.length) {
          console.warn('[foxy] a locked payment is back but its change is not; nothing is written and the record is kept');
          return { state: 'kept' };
        }
        return (found.length ? liveUnheld(w, found) : Promise.resolve([])).then(function (change) {
          return { state: 'made', send: made, change: change };
        });
      });
    });
  }

  /* The payment a relaunch rebuilt, written down as `sendToken` would have.
   *
   * The pile first — the change in, the spent pieces out, held or not — then
   * the payment on its entry, and the record last, so a write that fails
   * leaves the record to try again. The entry's id comes from the record's,
   * so a second pass amends it instead of adding another.
   *
   * It was never handed over: the page that made it died before it had the
   * token. So it goes where an undelivered payment goes — on its own entry,
   * with its token, to be shown and scanned. It is locked to the receiver, so
   * nobody else can take it and this phone cannot take it back. Change that
   * was being made for a payer goes on the payment it is the rest of. */
  function writeLockedSend(w, rec, send, change) {
    var at = rec.mint, unit = rec.unit || 'sat';
    if (change && change.length) addProofs(change, at, w, unit);
    dropInputsOf(rec);
    releaseHeld(rec.id, false);
    var token = window.CashuTS.getEncodedToken({ mint: at, proofs: send, unit: 'sat' });
    var sats = sumProofs(send);
    var fee = swapFeeFor(w, rec.inputs || []);
    var pay = rec.pay || {};
    if (pay.purpose === 'change' && pay.forHash) {
      owedChangeOnEntry(pay.forHash, token);
      try { FoxyWallet.tag(pay.forHash, { changeToken: token }); } catch (e) {}
      settleChangeMade(pay.forHash, Math.round(Number(pay.owed) || 0) || (sats + fee), { sats: sats, fee: fee });
      console.log('[foxy] change of ' + sats + ' sats that was being made when Foxy closed is on its payment\u2019s entry, to be shown');
    } else {
      var hash = 'token-' + String(rec.id).replace(/^send-/, '');
      mustSave(K.outtok, { token: token, sats: sats, mint: at, hash: hash, at: Date.now(), swapped: true });
      logTx({ dir: 'out', sats: sats, grossSats: sats, changeSats: 0, changeState: '', feeSats: fee,
              settled: true, state: 'success', memo: 'ecash', hash: hash, mint: canonicalMint(at) }, hash);
      logAudit({ hash: hash, sats: sats, feeSats: fee, kind: 'token',
                 inputs: (rec.inputs || []).slice(), outputs: (change || []).map(scrub) });
      try { FoxyWallet.tag(hash, { to: 'ecash', token: token, interrupted: true }); } catch (e2) {}
      console.log('[foxy] a locked payment of ' + sats + ' sats that was being made when Foxy closed is rebuilt;'
        + ' it is on its own entry, to be handed over');
    }
    dropSwap(rec.id);
    return { sats: sats, fee: fee, token: token };
  }

  /// A swap's inputs out of the pile on the mint's word that the swap was made.
  function dropInputsOf(rec) {
    var took = {};
    (rec && Array.isArray(rec.inputs) ? rec.inputs : []).forEach(function (p) { if (p && p.secret) took[p.secret] = true; });
    if (!Object.keys(took).length) return 0;
    var at = rec.mint, unit = rec.unit || 'sat';
    var pile = proofs(at, unit);
    var keep = pile.filter(function (p) { return !(p && took[p.secret]); });
    if (keep.length === pile.length) return 0;
    setProofs(keep, at, null, unit);
    return pile.length - keep.length;
  }

  function pruneSpent(w, at, unit, inputs) {
    /* Only the swap's inputs, when the record has them: asking about the whole
     * pile was the launch's fingerprint list again (MINT-PRIVACY.md C8). */
    var took = {};
    (Array.isArray(inputs) ? inputs : []).forEach(function (p) { if (p && p.secret) took[p.secret] = true; });
    var pile = proofs(at, unit).filter(function (p) { return p && took[p.secret]; });
    if (!pile.length) return Promise.resolve(0);
    return statesOf(w, pile).then(function (states) {
      var imported = importedSet();
      var dead = {};
      pile.forEach(function (p, k) {
        if (states[k] === 'SPENT' && seedDerived(p, imported)) dead[p.secret] = true;
      });
      var now = proofs(at, unit);
      var keep = now.filter(function (p) { return !(p && dead[p.secret]); });
      if (keep.length === now.length) return 0;
      setProofs(keep, at, w, unit);
      var gone = sumProofs(now) - sumProofs(keep);
      console.log('[foxy] removed', formatAmount(gone, unit || 'sat'), 'of spent inputs from the pile');
      return gone;
    }, function () { return 0; });
  }

  /* Did the mint refuse because some of the ecash sent was already spent? */
  function inputsSpent(e) {
    if (!e) return false;
    if (Number(e.code) === 11001) return true;
    return /already spent/i.test(String(e.message || '') + ' ' + String(e.detail || ''));
  }

  /* A payment refused because some of its ecash was already spent: which of
   * the proofs it sent, and those out of the pile.
   *
   * The whole pile used to be asked about at every launch, return and pull to
   * refresh (reconcile). The same fingerprints arriving each time let the mint
   * know this wallet whenever it came back, over any exit, and work out its
   * balance once those proofs were spent. Now a proof is asked about only here,
   * when a request carrying it was refused: the mint has just seen every one,
   * so asking tells it nothing new. Ecash spent somewhere else (the seed
   * restored in another wallet, a backup redeemed) is found when a payment
   * picks it, rather than at launch.
   *
   * SPENT proofs this seed can rebuild are removed; the rest are set aside in
   * quarantine, as reconcile does. Sats only, like the payments that call it.
   * Resolves the sats removed. */
  function dropSpentInputs(w, sent) {
    var ask = (sent || []).filter(function (p) { return p && p.secret; });
    if (!w || !ask.length) return Promise.resolve(0);
    var at = mintOf(w);
    return statesOf(w, ask).then(function (states) {
      var dead = {};
      ask.forEach(function (p, k) { if (states[k] === 'SPENT') dead[p.secret] = true; });
      var imported = importedSet();
      var pile = proofs(at);
      var gone = 0, setAside = [];
      var keep = pile.filter(function (p) {
        if (!p || !dead[p.secret]) return true;
        gone += satsOf(p.amount);
        if (!seedDerived(p, imported)) setAside.push(p);
        return false;
      });
      if (keep.length === pile.length) return 0;
      if (setAside.length) {
        var pen = load(K.quarantine, []);
        var known = {};
        quarantineEntries().forEach(function (q) { known[q.proof.secret] = true; });
        setAside.forEach(function (p) { if (!known[p.secret]) pen.push({ mint: at, proof: p }); });
        // before the pile, and throws if it does not land (W6)
        mustSave(K.quarantine, pen);
      }
      setProofs(keep, at, w);
      console.warn('[foxy] a payment found', gone, 'sats of this wallet\u2019s ecash already spent at', hostOf(at),
        '\u2014 removed' + (setAside.length ? ', ' + setAside.length + ' proof(s) set aside' : ''));
      if (typeof FoxyWallet._onSpentElsewhere === 'function') {
        try { FoxyWallet._onSpentElsewhere({ sats: gone, mint: at }); } catch (x) {}
      }
      return gone;
    });
  }

  /* A payment's swap refused for spent inputs: those removed, and the error
   * marked `foxyAgain` so the proof lock makes the payment once more from what
   * is left (99-proof-lock-and-export.js). Always rejects. Anything else, or a
   * refusal that removed nothing, is the error it was. */
  function retryWithoutSpent(w, e) {
    if (!inputsSpent(e) || !w || !w.foxySentInputs) return Promise.reject(e);
    return dropSpentInputs(w, w.foxySentInputs).then(function (gone) {
      if (gone) e.foxyAgain = true;
      throw e;
    }, function () { throw e; });
  }

  /* A swap, with its output ranges on disk until the answer is in.
   *
   * run(label, fn) makes the request (retried on used counters, as before).
   * The record is written as cashu-ts reserves the outputs, before the request
   * leaves. A refusal clears it. No answer: those ranges are restored at once.
   * If the mint had signed them, and what is unspent there adds up to what
   * this swap would have made (restoreSwap), a swap that brought proofs in resolves with
   * them as if the answer had come; one that spent the pile's own proofs puts
   * them back and still fails, since no token was made and nothing was paid.
   * If nothing is signed yet — or the mint cannot be reached — the record
   * stays for recoverSwaps on the next connect or resume.
   *
   * done() clears the record. A swap that took from the pile calls it before
   * anything is written, so a token's proofs can never later be restored as
   * balance; one that brought proofs in calls it right after adding them, and
   * a restore of proofs already held adds nothing. */
  /* meta.expect (receive, reclaim, import): what the outputs add up to, the
   * incoming amount less its input fee. meta.inputs (send, split): the proofs
   * the swap was handed, kept as secret, amount and keyset only — no
   * signature, so nothing here can be spent — for swapExpectation to ask the
   * mint about. Only a restore that matches those is ever added. */
  function swapGuard(w, kind, meta) {
    var rec = {
      id: kind + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      kind: kind,
      mint: mintOf(w),
      unit: unitOf(meta && meta.unit) || 'sat',
      at: Math.floor(Date.now() / 1000),
      amount: satsOf(meta && meta.amount) || 0,
      outputs: [],
    };
    if (meta && meta.expect != null && isFinite(Number(meta.expect))) rec.expect = Math.round(Number(meta.expect));
    // the history entry this swap finishes (a request's `req-…`), so a restore amends it rather than adding one
    if (meta && typeof meta.into === 'string' && meta.into) rec.into = meta.into;
    /* What a locked send was for: a payment, or change that is the rest of
     * one (`forHash`). If the app dies with the swap at the mint, this is all
     * that is left to say which history entry the rebuilt token belongs on
     * (`writeLockedSend`). Three short fields, nothing that can be spent. */
    if (meta && meta.pay && typeof meta.pay === 'object') {
      rec.pay = { want: Math.round(Number(meta.pay.want) || 0), owed: Math.round(Number(meta.pay.owed) || 0),
                  purpose: String(meta.pay.purpose || ''), forHash: String(meta.pay.forHash || '') };
    }
    var keep = function (list) {
      return list.filter(function (p) { return p && p.secret; }).map(function (p) {
        return { id: p.id, amount: satsOf(p.amount) || 0, secret: p.secret };
      });
    };
    if (meta && Array.isArray(meta.inputs)) {
      rec.inputs = keep(meta.inputs);
      /* cashu-ts picks from the pile inside send; the swap as it goes out says
       * which it took, and the record keeps only those. A lost answer then asks
       * the mint about what that swap sent, which it has seen, and not about
       * every proof held. */
      if (w && w.foxyCircuit) {
        w.foxyOnSwap = function (sent) {
          rec.inputs = keep(sent);
          if (swapKept(rec.id)) writeSwap(rec);
        };
      }
    }
    var recorder = outputsRecorder(w, [], function (list) { rec.outputs = list; writeSwap(rec); });
    /* A locked send's outputs carry no counter and no seed can rebuild them,
     * so they are written down as they are made rather than named by a range
     * (03-seed-counters-logs.js). Synchronously, before the request: that is
     * the whole point of the record. */
    var locked = !!(meta && meta.locked);
    return {
      record: rec,
      run: function (label, fn) {
        liveSwap[rec.id] = true;
        var settled = function () { delete liveSwap[rec.id]; };
        return this._run(label, fn).then(function (r) { settled(); return r; },
                                         function (e) { settled(); throw e; });
      },
      _run: function (label, fn) {
        /* Watched inside the retried body, not around it.
         *
         * `onceMoreIfSigned` runs the body again when the mint says it has seen
         * these outputs before, and the watch used to be armed once outside it
         * and released when the first attempt settled — so the second attempt's
         * outputs, the ones the mint actually signed, were recorded nowhere,
         * while the first attempt's refused ones stayed in the record and were
         * restored against for ever. Each attempt records its own,
         * and starts by forgetting the last one's: outputs the mint refused as
         * already signed are not this wallet's to rebuild. */
        return onceMoreIfSigned(w, label, function () {
          var stop = null;
          if (locked) {
            rec.locked = [];
            stop = watchLockedOutputs(function (made) {
              rec.locked = (rec.locked || []).concat(made.map(lockedRow).filter(Boolean));
              writeSwap(rec);
            });
          }
          var release = function () { if (stop) { stop(); stop = null; } };
          return recorder.attempt(fn).then(function (r) { release(); return r; },
                                           function (e) { release(); throw e; });
        }).catch(function (e) {
          // refused, or never sent at all: nothing of it is at the mint to restore
          if (mintRefused(e) || neverSent(e) || !swapKept(rec.id)) { dropSwap(rec.id); throw e; }
          console.warn('[foxy] ' + label + ': no answer from the mint (' + String((e && e.message) || e).slice(0, 60) +
            '); asking for the outputs it reserved');
          /* A locked send first: its outputs are the money that left, and no
           * counter names them. Whole, they are the payment, and the caller is
           * handed them to make the token it was going to make anyway. */
          var first = locked ? restoreLocked(w, rec) : Promise.resolve(null);
          return first.then(function (madeLocked) {
            if (!madeLocked) return null;
            /* The payment is back. Its change is not: those outputs are
             * ordinary and deterministic, named by the ranges the recorder
             * kept, so they come back the way every other lost answer's do.
             * Both halves or neither — handing back the payment while the
             * change stayed lost would be a worse trade than refusing. */
            return restoreRanges(w, rec.outputs, 'the locked send’s change', 1000).then(function (rows) {
              var found = [];
              rows.forEach(function (r) { found = found.concat(r.proofs); });
              /* Both halves or neither, and this is where that is decided.
               *
               * It said so and did not do it: an empty or short change restore
               * fell through as `change = []`, `sendToken` wrote that as the
               * whole remaining pile and the record — the only thing naming the
               * change's counters — was dropped straight after. 107 sats of 400
               * destroyed and reported as a success. A record that
               * reserved ranges and cannot get them back is left alone for the
               * next connect instead. */
              var ranges = /** @type {Array<any>} */ (rec.outputs || []);
              var wanted = ranges.reduce(function (n, r) { return n + (Number(r && r.count) || 0); }, 0);
              if (wanted > 0 && !found.length) {
                console.warn('[foxy] lost locked send: the payment is back but its change is not;'
                  + ' nothing is written and the record is kept');
                return null;
              }
              return (found.length ? liveUnheld(w, found) : Promise.resolve([])).then(function (change) {
                console.log('[foxy] lost locked send: the mint had signed it —',
                            formatAmount(sumProofs(madeLocked), rec.unit || 'sat'), 'rebuilt, with',
                            formatAmount(sumProofs(change), rec.unit || 'sat'), 'change');
                return { send: madeLocked, keep: change };
              });
            });
          }).then(function (both) {
          if (both) {
            /* Not dropped here. The caller writes the change first and clears
             * the record after, so a pile that cannot be written leaves the
             * record in place and the next connect tries again (W6). */
            var got = /** @type {any} */ (new Error('The mint did not answer, but it had already made the payment. ' +
              'Foxy rebuilt it; hand it over as a token.'));
            got.recovered = true;
            got.definite = true;
            got.lockedProofs = both.send;
            got.changeProofs = both.keep;
            /* Which proofs the swap actually spent. cashu-ts picks a subset of
             * the pile, so the change it made is not the whole of what is left
             * — everything it never touched is still the wallet's, and the
             * caller has to put both back or the difference is lost. */
            got.spentInputs = (rec.inputs || []).slice();
            throw got;
          }
          return restoreSwap(w, rec).then(function (got) {
            if (!got.take) {
              // signed, and none of it unspent and unheld: nothing there to add, ever.
              // Unspent but not what this swap made: the record stays, nothing is added.
              if (got.signed && !got.live.length) { dropSwap(rec.id); releaseHeld(rec.id, false); }
              else if (!got.signed) holdInputs(rec, e);
              throw e;
            }
            releaseHeld(rec.id, false);
            if (SWAP_IN[kind]) return got.take;
            addProofs(got.take, rec.mint, w, rec.unit);
            /* The spent input goes before the record does. With the input left
             * in the pile (`freeInputs`), a prune that failed after the record
             * was dropped left the piece counted with nothing to say it was
             * spent (an audit finding). The mint said so (swapExpectation):
             * it is removed on that word, and the record falls after. */
            dropInputsOf(rec);
            dropSwap(rec.id);
            return pruneSpent(w, rec.mint, rec.unit, rec.inputs).then(function () {
              var back = /** @type {any} */ (new Error('The mint did not answer, but it had already swapped the ecash. ' +
                'Foxy restored it from this wallet’s seed; nothing was sent.'));
              back.recovered = true;
              back.definite = true;
              throw back;
            });
          }, function (x) {
            if (x && x.recovered) throw x;
            // the mint could not be asked (offline): the inputs wait with the record
            if (swapKept(rec.id)) holdInputs(rec, e);
            throw e;
          });
          }, function (x) {
            if (x && x.recovered) throw x;
            if (swapKept(rec.id)) holdInputs(rec, e);
            throw e;
          });
        });
      },
      done: function () { dropSwap(rec.id); },
    };
  }

