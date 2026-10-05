    /* ---- backup -------------------------------------------------------- */

    /* The proofs ARE the money. This string is the only backup that exists. */
    /* The backup is a standard Cashu token, not a private format.
     *
     * It used to be JSON of its own devising, which meant it could only ever be
     * restored into Foxy. A token is the portable form every Cashu wallet
     * understands, so the same string restores here or anywhere else.
     *
     * It is still a bearer instrument: whoever holds it can spend it. And note
     * that restoring it somewhere else moves the money — the copy here becomes
     * worthless once the other wallet swaps the proofs at the mint.
     */
    /* Ask the mint which proofs are still good, and drop the ones that are not.
     *
     * A mint keeps no account, so this wallet only ever learns its proofs are
     * dead by trying to spend them. Restore a backup somewhere else, or have a
     * send fail halfway, and the balance here keeps counting money that no
     * longer exists. This reconciles the local view against the mint.
     *
     * Resolves { before, after, removed, spent } in sats.
     *
     * The app no longer calls this at launch, on a return or on pull to
     * refresh. It sends the fingerprint of every proof held in one request,
     * and the same fingerprints arriving each time let the mint recognise this
     * wallet over any exit and work out its balance as the proofs were spent.
     * Spent ecash is now found when a payment picks it (dropSpentInputs). Kept
     * for a check the person asks for, knowing what it tells the mint.
     */
    reconcile: function () {
      var w;
      try { w = need(); } catch (e) { return Promise.reject(e); }

      var at = mintOf(w);
      var have = proofs(at);
      /* The other units' piles at this mint are checked in the same request.
       * A proof's state is asked by its secret, whatever its unit, so one ask
       * covers them all; each pile is then judged and written on its own. The
       * sat figures in the result are sats only, as they always were. */
      var others = /** @type {Array<{unit: string, list: Array<*>, from?: number}>} */ (unitPilesAt(at));
      if (!have.length && !others.length) return Promise.resolve({ before: 0, after: 0, removed: 0, spent: 0 });
      var asked = have.slice();
      others.forEach(function (o) { o.from = asked.length; asked = asked.concat(o.list); });

      var before = sumProofs(have);
      return w.checkProofsStates(asked).then(function (allStates) {
        var states = allStates.slice(0, have.length);
        var units = null;
        if (others.length) {
          units = {};
          var imp = importedSet();
          var pen = load(K.quarantine, []);
          var known = {};
          quarantineEntries().forEach(function (q) { known[q.proof.secret] = true; });
          var penned = 0, writes = [];
          others.forEach(function (o) {
            var keepU = [], spentU = 0, setAside = [];
            o.list.forEach(function (p, k) {
              var s = allStates[/** @type {number} */ (o.from) + k];
              var st = s && (s.state || s.State);
              if (st === 'SPENT') {
                spentU += satsOf(p.amount);
                if (!seedDerived(p, imp)) setAside.push(p);
                return;
              }
              keepU.push(p);
            });
            setAside.forEach(function (p) {
              if (known[p.secret]) return;
              known[p.secret] = true;
              pen.push({ mint: at, unit: o.unit, proof: p });
              penned++;
            });
            if (spentU > 0) {
              writes.push({ unit: o.unit, list: keepU });
              console.warn('[foxy] reconcile:', formatAmount(spentU, o.unit), 'in', unitName(o.unit),
                'ecash at', hostOf(at), 'is spent' + (setAside.length ? ', ' + setAside.length + ' proof(s) set aside' : ''));
            }
            units[o.unit] = { before: sumProofs(o.list), after: sumProofs(keepU),
                              removed: o.list.length - keepU.length, spent: spentU };
          });
          /* The quarantine, then the piles. A quarantine that does not land
           * throws with every pile as it was; written after them, and with its
           * failure ignored, an imported proof could leave its pile with
           * nowhere to be put back from (audit W6). */
          if (penned) mustSave(K.quarantine, pen);
          writes.forEach(function (x) { setProofs(x.list, at, w, x.unit); });
        }
        return reconcileSats(states).then(function (r) {
          if (units) /** @type {any} */ (r).units = units;
          return r;
        });
      });

      function reconcileSats(states) {
        if (!have.length) return Promise.resolve({ before: 0, after: 0, removed: 0, spent: 0 });
        return Promise.resolve(states).then(function (states) {
        /* Quarantine what cannot be re-derived, delete what can.
         *
         * A proof this wallet minted has a secret derived from the seed and
         * a counter, so a restore brings it back and deleting it here costs
         * nothing. A proof imported from a backup carries a random secret:
         * once deleted it is gone while still valid at the mint. And the only
         * evidence for deleting either is the mint's own word, which a
         * hostile or impersonated mint can give freely.
         *
         * So the recoverable ones are dropped and the rest are set aside. */
        var keep = [], spent = 0, quarantined = [];
        var imported = importedSet();
        for (var i = 0; i < have.length; i++) {
          var st = states[i] && (states[i].state || states[i].State);
          // Number() matters: proof amounts are Amount objects, and adding one
          // straight to a number concatenates their digits instead of summing.
          if (st === 'SPENT') {
            spent += satsOf(have[i].amount);
            if (!seedDerived(have[i], imported)) quarantined.push(have[i]);
            continue;
          }
          keep.push(have[i]);
        }
        if (quarantined.length) {
          var pen = load(K.quarantine, []);
          var known = {};
          quarantineEntries().forEach(function (q) { known[q.proof.secret] = true; });
          quarantined.forEach(function (p) { if (!known[p.secret]) pen.push({ mint: at, proof: p }); });
          // before the pile, and throws if it does not land (W6)
          mustSave(K.quarantine, pen);
          console.warn('[foxy] quarantined', quarantined.length,
            'proof(s) worth', sumProofs(quarantined),
            'sats \u2014 the mint calls them spent and the seed cannot re-derive them');
        }
        if (spent > 0) setProofs(keep, at, w);
        var after = sumProofs(keep);
        return { before: before, after: after, removed: have.length - keep.length, spent: spent };
      });
      }
    },

