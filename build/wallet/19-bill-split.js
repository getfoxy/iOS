    /* ---- a bill being collected ------------------------------------------
     *
     * The invoices and their watchers lived in memory, so closing the flow
     * lost every one of them: the payers still had payable invoices, and this
     * wallet had no idea they existed. Kept on disk instead, so a pending
     * split survives a relaunch and can be picked up where it stopped.
     */
    splitSave: function (obj) {
      /* Stamp the mint on the way in.
       *
       * The rows are quote ids, and a quote belongs to the mint that issued
       * it. Without this, a reconcile running while another mint is connected
       * asks that mint about quotes it has never seen — a 400 per row, on
       * every launch. */
      if (obj && !obj.mint) obj.mint = String(mintUrl || '').replace(/\/+$/, '');
      save(K.split, obj || null);
      return obj;
    },

    splitPending: function () {
      var s = load(K.split, null);
      if (!s || !s.rows || !s.rows.length) return null;
      if (s.rows.every(function (r) { return r.paid; })) return null;
      return s;
    },

    /* The bill's record, finished or not.
     *
     * `splitPending` answers "is anything still owed", so it hides a bill the
     * moment its last share lands. The collecting screen has to see that
     * share land: it read `splitPending`, got nothing, and left the last
     * payer unticked with the money already in history (a share paid by its
     * invoice while Foxy was away, collected by the sweep on return). The
     * record stays on file until the all-paid screen is dismissed
     * (`splitClear`), and this is how that screen reads it. */
    splitRecord: function () {
      var s = load(K.split, null);
      return (s && s.rows && s.rows.length) ? s : null;
    },

    /* Settle every row the split's own watcher missed.
     *
     * Each share is watched with a poll, and a poll can die — backgrounded,
     * a dropped circuit, a timeout — leaving a row "still owed" after the
     * money has arrived. Two sources can answer what the watcher missed:
     *
     *   the ledger — free, instant, but gone if history was cleared
     *   the mint   — authoritative, cannot be deleted from the phone
     *
     * The ledger goes first for the common case. The mint is asked only about
     * rows the ledger could not settle. A row the mint reports PAID has money
     * waiting that nothing claimed, so it is claimed here; ISSUED means the
     * watcher claimed it before dying. Resolves with the number of rows newly
     * marked paid. */
    splitReconcile: function () {
      /* One walk at a time, however many things ask (see `reconciling`). */
      if (reconciling) return reconciling;
      var answer = FoxyWallet._splitReconcileOnce();
      reconciling = answer;
      var free = function () { reconciling = null; };
      answer.then(free, free);
      return answer;
    },

    _splitReconcileOnce: function () {
      var s = load(K.split, null);
      if (!s || !s.rows) return Promise.resolve(0);

      var paid = {};
      load(K.log, []).forEach(function (t) {
        if (t && t.dir === 'in' && t.settled && t.hash) paid[t.hash] = true;
      });
      var n = 0;
      s.rows.forEach(function (r) {
        if (!r.paid && r.hash && paid[r.hash]) { r.paid = true; n++; }
      });

      function finish() {
        if (!n) return n;
        if (s.rows.every(function (r) { return r.paid; })) {
          /* Marked, not deleted.
           *
           * The collecting screen reads this object on every render. Deleting
           * it the moment the last share landed pulled the data out from
           * under the screen: every amount went to $0.00 and the final payer
           * stayed pending forever, while the payment sat in history.
           *
           * splitClear() removes it when the all-paid screen is dismissed. */
          s.done = true;
          save(K.split, s);
          console.log('[foxy] split settled in full');
        } else {
          save(K.split, s);
        }
        console.log('[foxy] split: marked', n, 'row(s) paid');
        return n;
      }

      /* Only rows this mint issued.
       *
       * A split made on one mint, reconciled while another is connected,
       * asked the wrong mint about every unpaid row — a 400 each, on every
       * launch, forever. The melt sweep had the same defect. */
      var hereNow = String(mintUrl || '').replace(/\/+$/, '');
      var splitMint = String(s.mint || '').replace(/\/+$/, '');
      if (splitMint && splitMint !== hereNow) {
        console.log('[foxy] the pending split belongs to', splitMint, '\u2014 not asking', hereNow);
        return Promise.resolve(finish());
      }

      var open = s.rows.filter(function (r) { return !r.paid && r.hash; });
      var w = wallet;
      if (!open.length || !w || !w.checkMintQuoteBolt11 || !routeOpen()) return Promise.resolve(finish());

      // the ledger could not settle these — ask the mint, one at a time
      var chain = Promise.resolve();
      open.forEach(function (r) {
        chain = afterPause(chain).then(function () {
          // each row's invoice on its own circuit
          return onCircuit(w, 'quote:' + r.hash).checkMintQuoteBolt11(r.hash).then(function (q) {
            var state = q && q.state;
            if (state === 'ISSUED') { r.paid = true; n++; return; }
            if (state === 'PAID') {
              // paid and never claimed: the money is at the mint waiting
              return FoxyWallet.claim(r.hash).then(function () {
                r.paid = true; n++;
              }).catch(function (e) {
                console.warn('[foxy] split: claim of', r.hash, 'failed —', FoxyWallet.reason(e));
              });
            }
          }).catch(function (e) {
            console.warn('[foxy] split: could not check', r.hash, '—', FoxyWallet.reason(e));
          });
        });
      });
      return chain.then(function () {
        console.log('[foxy] splitReconcile: asked the mint about', open.length, 'row(s)');
        return finish();
      });
    },

    splitMarkPaid: function (hash) {
      var s = load(K.split, null);
      if (!s || !s.rows) return null;
      var hit = false;
      s.rows.forEach(function (r) { if (r.hash === hash) { r.paid = true; hit = true; } });
      if (!hit) return s;
      if (s.rows.every(function (r) { return r.paid; })) {
        // marked rather than deleted, so the screen watching it keeps its rows
        s.done = true;
        save(K.split, s);
        console.log('[foxy] split settled in full');
        return s;
      }
      save(K.split, s);
      return s;
    },

    splitClear: function () { try { localStorage.removeItem(K.split); } catch (e) {} },

    /* Has the seed been written down and checked?
     *
     * Survives relaunches, which the old in-state flag did not — so the prompt
     * kept its promise to stop asking. Cleared by a wipe, since a new seed has
     * not been backed up.
     */
    backedUp: function () { return !!load(K.backed, false); },
    setBackedUp: function (v) { save(K.backed, !!v); return !!v; },

    /* A token that was made and not yet marked as handed over. */
    lastToken: function () { return load(K.outtok, null); },

    clearLastToken: function () {
      try { localStorage.removeItem(K.outtok); } catch (e) {}
    },

    /* The launch reminder about the last token has been shown: once per token. */
    noteTokenReminded: function () {
      var out = load(K.outtok, null);
      if (out && out.token && !out.reminded) save(K.outtok, Object.assign({}, out, { reminded: true }));
    },

    /* Which mint issued this token, without needing to be connected to it.
     * Returns { mint, sats } or null. */
    tokenInfo: function (text) {
      var t = FoxyWallet.unwrap(text);
      if (!/^cashu[AB]/.test(t)) return null;

      // The connected wallet's decoder checks the token belongs to ITS mint, so
      // a token from anywhere else threw and the catch below turned that into
      // a flat "not a Cashu token". Decode with the plain reader first — the
      // whole point here is to read a token before deciding what to do with it.
      /* Two decoders, and which one works depends on the mint.
       *
       * A v2 keyset id is short and only means something alongside that mint's
       * keyset list, so the full decoder throws for any mint whose keysets are
       * not loaded — which is every mint you have not used. That is exactly
       * the case this function exists to handle. getTokenMetadata reads the
       * mint and the amounts without needing any of it.
       */
      var d = null;
      try {
        d = window.CashuTS.getDecodedToken(t, keysetIdsFor(wallet));
      } catch (e1) {
        try {
          var meta = window.CashuTS.getTokenMetadata(t);
          d = {
            mint: meta.mint,
            unit: meta.unit,
            proofs: (meta.incompleteProofs || []).map(function (pr, k) {
              return Object.assign({ amount: (meta.proofAmounts || [])[k] }, pr);
            }),
          };
        } catch (e2) {
          console.warn('[foxy] token would not decode:', (e2 && e2.message) || e2);
          return null;
        }
      }
      if (!d) return null;

      // v4 puts the proofs at the top level; v3 nests them under token[]
      var mint = d.mint;
      var proofs = d.proofs;
      if (!proofs && Array.isArray(d.token) && d.token.length) {
        proofs = [];
        d.token.forEach(function (part) {
          if (!mint) mint = part.mint;
          (part.proofs || []).forEach(function (pr) { proofs.push(pr); });
        });
      }
      if (!proofs || !proofs.length) {
        console.warn('[foxy] token decoded but held no proofs');
        return null;
      }
      /* The amount is in the token's own unit. It used to be added up as sats
       * whatever the unit, so a $1.00 usd token read as 100 sats. `sats` is
       * that amount only for a sat token; for any other unit it is null, so
       * nothing can mistake cents for sats. */
      var unit = String(d.unit || 'sat').trim().toLowerCase() || 'sat';
      /* Every proof a whole, positive amount, and a total that counts exactly.
       * A crafted token of 2^53-sat proofs added up to a wrong total
       * (tests/fuzz-parsers.js); no mint signs amounts like that. */
      var badAmount = proofs.some(function (pr) {
        var a = satsOf(pr && pr.amount);
        return !(Number.isSafeInteger(a) && a > 0);
      });
      if (badAmount || !Number.isSafeInteger(sumProofs(proofs))) {
        console.warn('[foxy] token holds an amount no mint issues');
        return null;
      }
      var amount = sumProofs(proofs);
      return {
        mint: String(mint || '').replace(/\/+$/, ''),
        unit: unit,
        amount: amount,
        sats: unit === 'sat' ? amount : null,
        proofs: proofs,
        // the token's own note, which is where a key for change rides (`changeNoteOf`)
        memo: typeof d.memo === 'string' ? d.memo.slice(0, 200) : '',
      };
    },

    /* Take a bearer token, whichever mint issued it.
     *
     * Ecash is only redeemable at the mint that signed it, so a token from
     * elsewhere means connecting there and filing it under that mint. That is
     * a real consequence — the wallet gains a mint — so the caller is told
     * which one, and whether it had to switch.
     */
    /* `opts.unlockWith`: the private key this phone put in a payment request,
     * for proofs the payer locked to it (NUT-11). Without it, a locked token is
     * refused exactly as before — a lock somebody else chose is not this
     * wallet's money. */
    /* The public half of a lock key, which both the claim and the hand-on need to
     * ask "is this locked to me". One copy: it was a local inside receiveToken,
     * and forwardLocked reaching for it is the second caller that makes it worth
     * naming once. */
    _lockPubOf: function (k) {
      return hexOf(window.CashuTS.getPubKeyFromPrivKey(bytesOfHex(k)));
    },

    /* Hand ecash locked to this phone straight on, without swapping it in first.
     *
     * A P2PK proof is spent by whoever submits it with a valid witness — NUT-11's
     * signature authorises the spend, and with SIG_INPUTS it says nothing about
     * who creates the outputs. So this phone can sign a locked proof and give it
     * away, and the next person redeems it. Signing is local: the key comes from
     * the seed on the phone, no mint is asked anything, and `assertRoute` is not
     * called because nothing leaves.
     *
     * Why it exists. Locked ecash arrives and waits in `foxy.req.unclaimed` until
     * there is a route to swap it in, and Foxy's balance counts it meanwhile —
     * "a balance that counts unswapped sats has to be able to spend them"
     * (20-helpers.js). Offline it could not. That was the one place the balance
     * lied, and it is also what made offline change a one-way ratchet: every
     * payment taken in locked ecash was money that could not go out again until
     * the phone found a network.
     *
     * What it refuses. A token not locked to a key this phone holds. A SIG_ALL
     * lock, whose signature commits to the outputs as well, so it cannot be
     * handed to somebody who will choose their own. A proof whose signature does
     * not verify once made — checked here rather than discovered by the person
     * it was given to. And a second attempt at the same proofs: the secrets go on
     * a handed-on list, because the one failure that costs somebody else money is
     * giving the same signed proof to two people.
     *
     * What it does not do. It does not know whether the recipient is online, and
     * a signed proof is bearer money from the moment the witness exists — so the
     * caller hands it over a sealed link, and only to somebody who can redeem it
     * now. That is the payer's own rule (an offline party takes only locked
     * ecash), reflected. */
    forwardLocked: function (text, opts) {
      var w;
      try { w = needLocal(); } catch (e) { return Promise.reject(e); }
      var CT = window.CashuTS;
      if (!CT || !CT.signP2PKProofs) {
        return Promise.reject(new Error('This build cannot sign locked ecash.'));
      }
      var tok = FoxyWallet.tokenInfo(text);
      if (!tok || !tok.proofs || !tok.proofs.length) {
        return Promise.reject(new Error('That is not a Cashu token.'));
      }
      var locked = lockedProofs(tok.proofs);
      if (locked.length !== tok.proofs.length) {
        return Promise.reject(new Error('That ecash is not locked, so it can be handed on as it is.'));
      }
      try { if (CT.isP2PKSigAll && CT.isP2PKSigAll(tok.proofs)) {
        return Promise.reject(new Error('That lock signs the whole payment, so it cannot be passed on.'));
      } } catch (e) {}
      /* What the callback needs, read before it: the type check cannot narrow `tok`
       * across a closure, and `receiveToken` solves the same thing the same way a
       * few lines down ("not null, in the callbacks below as well"). */
      var mineProofs = tok.proofs;
      var at = String(tok.mint || '').replace(/\/+$/, '');
      var already = mineProofs.filter(function (pr) { return handedOn(pr.secret); });
      if (already.length) {
        return Promise.reject(new Error('That ecash has already been handed on once.'));
      }
      return lockKeyMatching(lockedTo(mineProofs[0]), FoxyWallet._lockPubOf).then(function (key) {
        var mine = '';
        try { mine = key ? FoxyWallet._lockPubOf(key) : ''; } catch (e) { mine = ''; }
        var ours = mine && mineProofs.every(function (pr) { return onlyLockedTo(pr, mine); });
        if (!ours) throw new Error(LOCKED);
        var signed = CT.signP2PKProofs(mineProofs, key);
        /* Checked before it is handed over, with the same verifier a mint would
         * use, because the person who finds out otherwise is the one who was
         * given it. */
        if (CT.isP2PKSpendAuthorised) {
          var bad = signed.filter(function (pr) {
            try { return !CT.isP2PKSpendAuthorised(pr); } catch (e) { return true; }
          });
          if (bad.length) throw new Error('This phone could not sign that ecash.');
        }
        /* Written down before the token exists, and `mustSave`, for the same
         * reason the unclaimed store is: a note that does not land would let the
         * same proofs go out twice. */
        var out = window.CashuTS.getEncodedToken({ mint: at, proofs: signed, unit: 'sat' });
        /* `defer`: signed and nothing written. A payment out of several
         * locked payments signs them one after another, each a trip to the
         * keychain, and each used to be struck off as it was signed — before
         * the token that would carry it existed. Killed, or refused the
         * second key, the pieces signed first were in no pile, no waiting
         * payment and no token: 256 of 602 sats
         * (offline-cross-scenarios.js `fwd-kill`, `fwd-refuse`). The caller
         * strikes them all off together once the token is saved. */
        if (opts && opts.defer) {
          return { token: out, sats: sumProofs(signed), signed: signed };
        }
        rememberHandedOn(signed);
        // by the pieces, so a row handed on in part keeps the rest
        takeFromUnclaimed(signed);
        console.log('[foxy] handed on ' + sumProofs(signed) + ' sats of locked ecash, signed here');
        return { token: out, sats: sumProofs(signed) };
      });
    },

    /* What the balance counts and a payment cannot use: money accepted at
     * risk, which is somebody else's to spend until it has been swapped in.
     * Said where a payment falls short, because the balance on the screen
     * says there is enough (300 sats more was shown than could be spent,
     * and nothing to say why). '' when there is none. */
    _atRiskNote: function () {
      var n = 0;
      try { FoxyWallet.trustedWaiting().forEach(function (t) { n += Number(t.sats) || 0; }); } catch (e) { n = 0; }
      return n > 0 ? ' Another ' + n + ' sats were accepted at risk and cannot be spent until this phone is online.' : '';
    },

    /* A token's note asking for change: { changeTo, asked }, or null. */
    changeNoteOf: function (text) {
      var info = null;
      try { info = FoxyWallet.tokenInfo(text); } catch (e) { info = null; }
      var m = info && typeof info.memo === 'string'
        ? /^foxy:change:(0[23][0-9a-f]{64}):(\d{1,12})$/i.exec(info.memo) : null;
      if (!m) return null;
      var asked = Number(m[2]);
      if (!(Number.isSafeInteger(asked) && asked > 0)) return null;
      return { changeTo: m[1].toLowerCase(), asked: asked };
    },

    /* The change a scanned token asked for, made and shown.
     *
     * The payer had no route and no exact pieces, so it paid over and named a
     * key. This phone has the money — the swap has come back, which is the
     * whole of the risk — and makes the difference locked to that key. There
     * is no link to hand it over, so it is shown as a code for the payer to
     * scan, and kept on the payment's entry in case they have walked off.
     * Nothing is made with no route, no note, or nothing over. */
    changeForScanned: function (text, got) {
      var changeInHand = FoxyWallet._changeInHand || (FoxyWallet._changeInHand = {});
      var note = FoxyWallet.changeNoteOf(text);
      var paid = Math.round(Number(got && got.sats) || 0);
      if (!note || !got || got.kept || !(Number(got.changeDue) > 0) || !(paid > note.asked) || !routeOpen()) {
        return Promise.resolve(null);
      }
      var asked = note.asked;
      var owed = paid - asked;
      var hash = String(got.hash || '');
      /* Once. `receiveToken` calls this itself for every door a token comes
       * through (99-proof-lock-and-export.js), and anything else that called
       * it as well made the change a second time out of the receiver's own
       * money: 300 asked, 215 kept (offline-cross-scenarios.js `over-cut`).
       * A payment whose change is being made, or has been, makes none. */
      if (hash) {
        if (changeInHand[hash]) return Promise.resolve(null);
        var done = null;
        try { done = FoxyWallet.tagsFor ? FoxyWallet.tagsFor(hash) : null; } catch (eT) { done = null; }
        if (done && done.changeToken) return Promise.resolve(null);
        changeInHand[hash] = true;
      }
      // less what it costs to make and to take; nothing when that leaves nothing (`changeFor`)
      var back = changeFromPile(wallet, owed);
      if (!(back > 0)) return Promise.resolve(null);
      console.log('[foxy] a scanned token paid ' + paid + ' for ' + note.asked
        + ' and named a key: making ' + owed + ' sats of change locked to it');
      /* Said before the change is made, so the screen can hold the payment's
       * confirmation behind the change card (11-cards.js, changeStuckCard). */
      if (typeof FoxyWallet._onChangeMaking === 'function') {
        try { FoxyWallet._onChangeMaking({ sats: owed, hash: hash }); } catch (x) {}
      }
      return FoxyWallet.sendToken(back, { unit: 'sat', lockTo: note.changeTo, purpose: 'change', forHash: hash, owed: owed })
        .then(function (made) {
          if (hash) settleChangeMade(hash, owed, { sats: made.sats, fee: made.fee, back: back });
          if (hash) {
            try {
              FoxyWallet.tag(hash, { token: String(made.token || ''), handed: 'tap', owedChange: true,
                                     changeToken: String(made.token || '') });
              amendTx(hash, { changeState: 'not handed' });
            } catch (e) { console.warn('[foxy] the change could not be put on its entry:', e && e.message); }
          }
          if (typeof FoxyWallet._onChangeStuck === 'function') {
            try { FoxyWallet._onChangeStuck({ sats: owed, token: made.token, hash: hash, why: 'scanned', paid: paid, asked: asked }); }
            catch (x) { console.warn('[foxy] the change card could not be raised:', x && x.message); }
          }
          return { sats: owed, token: made.token };
        }, function (e) {
          console.warn('[foxy] change of ' + owed + ' sats for a scanned token could not be made: '
            + (e && e.message));
          // this phone kept the lot, and its entry says so
          if (hash && FoxyWallet.changeSettled) FoxyWallet.changeSettled(hash, 0);
          return null;
        });
    },

    receiveToken: function (text, opts) {
      /* The route is asserted below, once it is known what kind of token this
       * is, and not here.
       *
       * Asserted here, a token scanned or pasted with no route was refused
       * before anybody looked at it — including one locked to this very phone,
       * which needs no mint to be safe and is exactly what an offline receiver
       * is meant to be able to take. It happened face to face: the tap's
       * delivery failed, the payer showed the token instead, SCAN on the receive
       * screen said COULD NOT REACH THE MINT. */
      var unlockWith = opts && typeof opts.unlockWith === 'string' ? opts.unlockWith : '';
      /* The history entry this claim belongs to, where one is already written.
       *
       * Ecash locked to this phone is written into history the moment it
       * arrives, not when it is swapped in — the swap is bookkeeping, and it
       * is deliberately held back by minutes so the mint cannot pair it with
       * the payer's (_requestPaid). Without this the swap wrote a second entry
       * and the same sats appeared twice. Named, it amends the first. */
      var into = opts && typeof opts.hash === 'string' ? opts.hash : '';
      var info = FoxyWallet.tokenInfo(text);
      if (!info) return Promise.reject(new Error('That is not a Cashu token.'));
      var tok = info;           // not null, in the callbacks below as well
      /* Each piece once. A token is worth the sum of its pieces, and one
       * repeated was counted for each time it appeared — kept offline as 128
       * sats for 64 (`repeatedProof`). */
      if (repeatedProof(tok.proofs || [])) {
        return Promise.reject(new Error('That token names the same ecash more than once, so it is not worth what it says. Nothing was taken.'));
      }
      var unit = unitOf(tok.unit);
      if (!unit) {
        return Promise.reject(new Error('That token is in a unit Foxy does not know (' +
          String(tok.unit).slice(0, 16) + '), so it was not taken.'));
      }
      if (!tok.amount) return Promise.reject(new Error('That token is empty.'));
      /* Locked proofs, and whether they are locked to us.
       *
       * Every one of them has to name the key this phone holds. A token that
       * mixes a lock we can open with one we cannot is refused whole rather
       * than half-claimed. */
      var locked = lockedProofs(tok.proofs);
      /* A promise where this used to be three lines.
       *
       * The key a request locks ecash to is derived from the seed now
       * (07-request-delivery.js), and the seed is on the phone, so finding the
       * key that opens a token is a round trip. Nothing else about the rule
       * moved: every proof must name the one key this phone holds, and a lock
       * this phone never asked for is refused as it always was. */
      /* Already signed for, by whoever it was locked to.
       *
       * A P2PK proof carrying a witness that verifies needs no key from anybody:
       * NUT-11's signature is the authorisation, and with SIG_INPUTS it says
       * nothing about who creates the outputs — so this wallet can swap it as it
       * stands. That is what `forwardLocked` produces on the other phone.
       *
       * Checked with cashu-ts's own verifier rather than by asking whether a
       * witness is merely present, because "has a signature" and "has a signature
       * that works" are different claims and only one of them is worth anything.
       *
       * It widens what is accepted and narrows nothing: a token locked to a
       * stranger with no valid witness is refused exactly as it was, and the mint
       * remains the arbiter of whether these proofs are still unspent. */
      /* Asked of the locked proofs, not of all of them.
       *
       * An offline payer pays out of what it has: signed rows of ecash that
       * arrived locked to it earlier, PLUS plain pieces from its own pile, in
       * one token (`exactWithLocked`). That is its ordinary output, not an edge
       * case. Both tests here demanded every proof in the token be locked, so
       * a token holding one of each failed both — `signedAlready` false, `ours`
       * false — and was refused whole with LOCKED.
       *
       * Which is money stuck at both ends: the receiver cannot claim it, the
       * payer is answered 422 and has already handed over ecash only it could
       * have unlocked. Two phones in testing: a payment that
       * worked for neither.
       *
       * A plain proof needs no authorisation, so it can never be the reason to
       * refuse one. The question is only ever about the locked ones. */
      var signedAlready = (function () {
        var CT = window.CashuTS;
        if (!locked.length || !CT || !CT.isP2PKSpendAuthorised) return false;
        try { if (CT.isP2PKSigAll && CT.isP2PKSigAll(tok.proofs)) return false; } catch (e) { return false; }
        return locked.every(function (pr) {
          if (!pr || !pr.witness) return false;
          try { return CT.isP2PKSpendAuthorised(pr); } catch (e) { return false; }
        });
      })();
      if (signedAlready) {
        console.log('[foxy] this ecash is locked but already signed for; taking it as it stands');
      }

      // nothing locked, or locked and already signed for: no key is needed
      var opened = (!locked.length || signedAlready) ? Promise.resolve(unlockWith) : (
        /* No key named, but this phone may still hold the one this token is
         * locked to: a payment that arrived and was never claimed can be
         * pasted in afterwards, and by then nobody remembers which request it
         * belonged to. Only locks this phone asked for — or that its seed
         * derives — can be found that way, so a stranger's token is refused
         * exactly as before. */
        /* The first LOCKED proof, not the first proof: an offline payer's token
         * is plain pieces and then locked ones, and the key named by a plain
         * piece is no key at all. */
        unlockWith ? Promise.resolve(unlockWith) : lockKeyMatching(lockedTo(locked[0]), FoxyWallet._lockPubOf)
      ).then(function (key) {
        var mine = '';
        try { mine = key ? FoxyWallet._lockPubOf(key) : ''; } catch (e) { mine = ''; }
        /* Every proof locked to this key and to nobody else. `lockedTo` names
         * the key the lock is written to; `onlyLockedTo` asks who can actually
         * open it, which is the question, and the two differ whenever the
         * secret carries tags (00-header-and-mint-errors.js). */
        // again, only the locked proofs: a plain one is nobody's to open
        var swapNow = !!routeOpen() && !into;
        var ours = mine && locked.every(function (pr) { return onlyLockedTo(pr, mine, { swapNow: swapNow }); });
        if (!ours) {
          /* Ours, but with a deadline on it: said as that, not as somebody
           * else's. Offline it cannot be taken — the sender can have it back
           * when the time passes, and nothing here can swap it first. */
          var oursLater = !!mine && locked.some(function (pr) { return hasLocktime(pr) && sameLockKey(lockedTo(pr), mine); });
          if (oursLater) {
            throw new Error(lockedUntilWords(locked, swapNow));
          }
          throw new Error(LOCKED);
        }
        return key;
      });

      var here = String(mintUrl || '').replace(/\/+$/, '');
      var switched = tok.mint && tok.mint !== here;

      /* The seed first, before the mint is asked anything: this claim's
       * secrets come from it, and read here the Face ID belongs to the tap
       * that started the receive rather than to the middle of the swap
       * (openSeedForVisit). Nothing depends on the answer — a refusal fails
       * at the read that needs it, as it did before. */
      /* `opened` before it, and its refusal is not caught by the handler below:
       * a token locked to somebody else is refused before this wallet connects
       * to the mint that issued it, which is what it did when the check was a
       * line of its own. */
      /* ---- with no route: locked ecash is kept, nothing else is taken ------
       *
       * Locked to this phone, a token is already final. The sender had to swap
       * at the mint to make it, only this phone can ever spend it, and its DLEQ
       * verifies against the cached keyset without asking anyone anything. So it
       * is written down exactly as a delivered one is (`keepUnclaimed`) and
       * swapped in on the next connect (`claimUnclaimed`), which amends the same
       * history entry rather than adding a second.
       *
       * Anything else is refused, in the words that say why. Unlocked ecash is a
       * race the sender can win, and the only thing that settles it is this
       * phone's own swap. Refused, the sender still holds it and can hand it over
       * again when either phone has a route.
       *
       * This is the same rule `_requestPaid` applies to a payment that arrives
       * over the air; it had simply never been applied to one that arrives
       * through the camera. */
      var offlineKeep = opened.then(function (key) {
        if (routeOpen()) return null;
        /* Only for a token nobody has written down yet.
         *
         * `into` means a caller already has a row for this — `_requestPaid`'s
         * claim, or `claimUnclaimed` walking the list — and that row is the one
         * copy of the money. Keeping a second one here would count the same sats
         * twice and leave one of them behind for ever. Those callers want the
         * old answer: the claim fails, their row stays, and the next connect
         * takes it. */
        if (into) {
          throw new Error('This phone is offline, so the ecash cannot be swapped in yet.'
            + ' It is written down and will be taken when there is a connection.');
        }
        var mine = key ? FoxyWallet._lockPubOf(key) : '';
        var oursAlone = !!mine && !!locked.length && locked.length === tok.proofs.length
          && tok.proofs.every(function (pr) { return onlyLockedTo(pr, mine); });
        /* Signed by the mint, before anything else is weighed. A piece whose
         * DLEQ is there and wrong was never issued by this mint, locked or
         * not, and no card should ask anybody to trust it (audit N1). */
        var sameMint = String(tok.mint || '').replace(/\/+$/, '') === String(mintUrl || '').replace(/\/+$/, '');
        if (sameMint && dleqAudit(wallet, tok.proofs).invalid) {
          throw new Error('That token\u2019s signatures do not match the keys ' + hostOf(mintUrl || '')
            + ' publishes, so it was not taken.');
        }
        /* Plain ecash, handed over as a code, with no route to settle it.
         *
         * Refused flat until now, and the person holding the phone was never
         * asked. It is the same risk the HIGH RISK card was written for — the
         * giver keeps a copy and can spend it until this phone gets online —
         * and the same answer: it is a question about the person standing
         * there, so it is put to the person standing here.
         *
         * Only plain ecash at this phone's own mint. A lock this phone cannot
         * open is not a risk to weigh, it is money that can never be claimed,
         * and another mint's token needs a connect. No card registered means
         * no, as it always has. */
        if (!oursAlone) {
          var plainHere = !locked.length
            && String(tok.mint || '').replace(/\/+$/, '') === String(mintUrl || '').replace(/\/+$/, '');
          var ask = FoxyWallet._onOfflineOffer;
          if (!plainHere || typeof ask !== 'function') {
            throw new Error('This phone is offline, so it can only take ecash locked to it.'
              + ' Ask them to send it again when either of you is online.');
          }
          var fp = 'scan-' + FoxyWallet.piecesFingerprint(tok.proofs);
          if (unclaimed()[fp]) {
            throw new Error('You have already taken this ecash. It is waiting to be swapped in'
              + ' as soon as there is a connection.');
          }
          /* And one already swapped in, as the locked branch below asks. The
           * row goes when it is claimed, so the store above then has nothing
           * to say: the same token shown again was put to the person again,
           * counted again, and on the next connection found spent, by this
           * phone's own earlier claim. Both entries were then written "taken
           * back" and the person told the payer had taken money that was in
           * their pile. History is named after the same pieces and knows. */
          if (FoxyWallet.txSeen('req-' + fp) || takenBefore(tok.proofs)) {
            throw new Error('You have already been paid this ecash.');
          }
          return Promise.resolve(ask({ sats: tok.amount, id: fp, purpose: 'scan', scanned: true }))
            .then(function (yes) {
              if (yes !== true) {
                throw new Error('This phone is offline and that ecash was not taken. It is still theirs.');
              }
              keepUnclaimed(fp, FoxyWallet.unwrap(text), tok.amount, true);
              logTx({
                dir: 'in', sats: tok.amount, feeSats: 0, settled: false, state: 'pending',
                trusted: true, memo: 'ecash, offline', hash: 'req-' + fp,
              });
              console.log('[foxy] offline: ' + tok.amount + ' sats of plain ecash taken on trust,'
                + ' to be swapped in when there is a route');
              return { sats: tok.amount, amount: tok.amount, unit: unit, host: hostOf(mintUrl || ''),
                       hash: 'req-' + fp, switched: false, kept: true, trusted: true };
            });
        }
        var at = String(tok.mint || '').replace(/\/+$/, '');
        if (at && at !== String(mintUrl || '').replace(/\/+$/, '')) {
          throw new Error('That token is from ' + hostOf(at) + ' and this phone is offline,'
            + ' so it cannot switch mints to take it.');
        }
        /* Named after the ecash, not after the clock.
         *
         * The id used to be the second it arrived, so the same locked token
         * handed over twice — a second apart — made two rows. An offline phone
         * cannot ask the mint whether it has seen these proofs before, so it
         * counted 128 sats of pending money for one payment of 64 and showed
         * the person two payments. The balance came right on the next connect,
         * when the second claim was refused as spent; the merchant who had
         * already handed over the goods twice did not (probe).
         *
         * Derived from the secrets, a second hand-over of the same ecash lands
         * on the same id and is caught below. Different ecash for the same
         * amount in the same second, which the clock could not tell apart, now
         * has its own row as it always should have. */
        /* Locked to this phone, and signed by the mint: both, or it is not
         * final. The lock was the whole test, and a token nobody had signed
         * was counted and written into history as received. */
        if (!mintSigned(wallet, tok.proofs)) {
          throw new Error('This phone is offline and cannot check that ecash\u2019s signatures,'
            + ' so it was not taken. Scan it again when there is a connection.');
        }
        /* And only for a request this phone still has open (`lockRowFor`).
         * Locked to this phone is necessary and not enough: a request that
         * has been paid, or was made before this wallet was restored from its
         * words, has no row, and with no connection there is no telling
         * whether that payment is new. */
        var row = lockRowFor(mine);
        if (!row) {
          throw new Error('This phone is offline and has no open request that ecash answers, so it cannot'
            + ' tell whether it has been paid this before. Take it when there is a connection, or show them a new request.');
        }
        var id = 'scan-' + FoxyWallet.piecesFingerprint(tok.proofs);
        var before = lockTaken(row);
        if (before && before !== id) {
          throw new Error('That request has already been paid on this phone. Show them a new request.');
        }
        if (unclaimed()[id]) {
          throw new Error('You have already taken this ecash. It is waiting to be swapped in'
            + ' as soon as there is a connection.');
        }
        /* And one already swapped in. The row goes when it is claimed, so the
         * store above has nothing to say about ecash that has already landed —
         * the history entry does, and it is named after the same fingerprint. */
        if (FoxyWallet.txSeen('req-' + id)) {
          throw new Error('You have already been paid this ecash.');
        }
        // and one this phone is already holding under another name
        if (heldAlready(FoxyWallet.unwrap(text))) {
          throw new Error('This phone already has that ecash.');
        }
        keepUnclaimed(id, FoxyWallet.unwrap(text), tok.amount);
        markLockTaken(row, id);
        /* Received, not pending. It is locked to this phone alone: nobody else
         * can spend it and the giver cannot take it back, which is the whole of
         * what "received" means. A payment that arrives the same way over a tap
         * has always been written as settled; this one was written as pending
         * and sat in history looking unfinished, with no confirmation, for
         * money that was as final as money gets. The swap
         * on the next connect is bookkeeping and finishes this same entry. */
        logTx({
          dir: 'in', sats: tok.amount, feeSats: 0, settled: true, state: 'success',
          memo: 'ecash', hash: 'req-' + id,
        });
        console.log('[foxy] offline: ' + tok.amount + ' sats locked to this phone kept,'
          + ' to be swapped in when there is a route');
        return { sats: tok.amount, amount: tok.amount, unit: unit, host: hostOf(at || mintUrl || ''),
                 hash: 'req-' + id, switched: false, kept: true };
      });

      var ready = offlineKeep.then(function (keptAlready) {
        if (keptAlready) return keptAlready;
        return opened.then(function (key) {
          unlockWith = key;
          /* `opts.visit`: taken at its own mint and the phone left where it
           * banks (`claimUnclaimed` goes home afterwards). */
          var how = (opts && opts.visit) ? { remember: false } : undefined;
          return FoxyWallet.openSeedForVisit({ arriving: true }).then(function () {
            return switched ? FoxyWallet.connect(tok.mint, null, null, how) : null;
          }, function () {
            return switched ? FoxyWallet.connect(tok.mint, null, null, how) : null;
          });
        });
      });

      /* A token in another unit is swapped by a wallet of that unit — cashu-ts
       * refuses a token that is not in its wallet's unit — and filed in that
       * unit's pile at the mint, never the sat pile. */
      var intoMint, intoWallet, guard;
      return ready.then(function (keptAlready) {
        // kept with no route: there is nothing to swap and nothing to ask
        if (keptAlready && keptAlready.kept) return keptAlready;
        /* On the circuit kept ready when the caller is a person's wait
         * (`opts.now`: a card's payment, whose swap is the last thing between
         * a till and "paid"). */
        var connected = (opts && opts.now) ? needNow() : need();
        intoMint = mintOf(connected);
        return unit === 'sat' ? connected : unitWallet(connected, unit);
      }).then(function (w) {
        if (w && w.kept) return w;      // already kept, with no route
        intoWallet = w;
        // Swap at the mint rather than filing the proofs as they arrived.
        // The sender still holds a copy of what they sent; until these are
        // exchanged for secrets only this wallet knows, they could spend it
        // first. The swap is also what makes a second claim fail instead of
        // silently counting the same money twice.
        // Before the swap: a DLEQ this token carries must verify against the
        // mint's published keys. One that does not means the proofs were not
        // signed with those keys, and the token is refused.
        var incoming = null;
        try { incoming = w.decodeToken(FoxyWallet.unwrap(text)); } catch (e) {}
        var audit = dleqAudit(w, (incoming && incoming.proofs) || []);
        if (audit.invalid) {
          throw new Error('That token\u2019s signatures do not match the keys ' + hostOf(w.mint && w.mint.mintUrl || mintUrl || '') +
            ' publishes, so it was not accepted. Nothing was taken from you.');
        }
        var incomingProofs = (incoming && incoming.proofs) || [];
        /* Spent, or being spent, is refused before any counter is reserved
         * (refuseSpent, W5). It used to swap straight away, and each refusal
         * left counters the mint never signed. A check that cannot be made
         * swaps as before. */
        /* Not when the caller asks for the swap alone (`opts.noPrecheck`): a
         * card's pieces, which the swap refuses itself if they are spent, and
         * whose payment waits on the answer. The refusal reserves a few
         * counters the mint never signs; a question asked first is a round trip
         * over Tor in front of every payment. */
        return ((opts && opts.noPrecheck) ? Promise.resolve() : refuseSpent(w, incomingProofs.length ? incomingProofs : tok.proofs,
          'That token is already spent, so there was nothing to take. Nothing was taken from you.'
        )).then(function () {
          /* The outputs' counter ranges are on disk until the answer is in. A
           * lost answer used to leave the token's proofs spent and the fresh ones
           * nowhere: the sender's token was gone and nothing here held its value
           * until a seed restore. Now those ranges are restored at once, or by
           * recoverSwaps on the next connect or resume. */
          // with what the outputs add up to: the token less the mint's input fee on it
          // `into` goes on the record: a lost answer restored later finishes that entry, not a new one
          guard = swapGuard(w, 'receive', { unit: unit, amount: tok.amount, into: into || undefined,
            expect: incomingProofs.length ? sumProofs(incomingProofs) - swapFeeFor(w, incomingProofs) : undefined });
          return guard.run('receive', function () {
            /* Its outputs fill the pool (shapeOutputs): what comes in is the
             * pieces the next payment needs, not a few large ones to break
             * later. Only when the fee is known, which is what the amount of
             * the outputs rests on. */
            var expect = incomingProofs.length ? sumProofs(incomingProofs) - swapFeeFor(w, incomingProofs) : NaN;
            /* Not when the money is only passing through. A payment taken at
             * the payer's mint to be melted home is spent whole a second
             * later, and every piece of it costs this mint's fee to spend:
             * 1,024 sats arrived as 46 pieces, 7 sats to melt where the quote
             * had allowed 6, and the way home was refused for want of three
             * (tools/live/tap-scenarios.js 6). `opts.plain`
             * leaves the split to cashu-ts, which makes the fewest pieces. */
            var shaped = (isFinite(expect) && expect > 0 && !(opts && opts.plain))
              /* within what the mint takes in one request, less the powers of two the
               * remainder may need (a 60-piece shape at a 25-cap mint was refused, the
               * live array-cap suite) */
              ? { type: 'deterministic', counter: 0, denominations: shapeOutputs(proofs(intoMint, unit), expect, mintArrayCap(w) - 16) }
              : undefined;
            // the key unlocks the inputs; without one this is what it always was
            return unlockWith ? w.receive(FoxyWallet.unwrap(text), { privkey: unlockWith }, shaped)
                              : w.receive(FoxyWallet.unwrap(text), undefined, shaped);
          });
        });
      }).then(function (fresh) {
        // kept with no route: no proofs were swapped, so there is nothing to file
        if (fresh && fresh.kept) return fresh;
        var got = sumProofs(fresh);
        addProofs(fresh, intoMint, intoWallet, unit);
        guard.done();
        // remembered, so the same ecash offered again is said to be this phone's (`mineIfTaken`)
        try { noteTaken(tok.proofs, got); } catch (eT) {}
        if (unit !== 'sat') {
          /* History in the token's unit. sats and feeSats are 0 because no
           * sats moved; amount and feeAmount carry the figures in `unit`. */
          logTx({
            dir: 'in',
            unit: unit,
            amount: got,
            feeAmount: Math.max(0, tok.amount - got),
            sats: 0,
            feeSats: 0,
            settled: true,
            state: 'success',
            memo: 'ecash',
            hash: into || 'token-' + Date.now(),
          }, into);
          console.log('[foxy] took', formatAmount(got, unit), 'of', unitName(unit), 'ecash at', hostOf(tok.mint),
                      tok.amount !== got ? '(' + formatAmount(tok.amount - got, unit) + ' to the mint fee)' : '');
          return { sats: null, unit: unit, amount: got, mint: tok.mint, host: hostOf(tok.mint), switched: switched };
        }
        /* A sat token: its amount is its sats — unless the caller is keeping
         * less than it swapped in.
         *
         * `_requestPaid` is: an over-payment whose change goes straight back is
         * not money kept, and the entry that says 4 for a 3-sat sale is the one
         * the person reads afterwards. It passes what stays; nobody
         * else passes anything and nothing else changes. */
        // swapped in, so the request it answered is paid: its row goes with it (`lockRowFor`)
        try { dropLockKeysByPub(lockPubsOf(tok.proofs)); } catch (eL) {}
        var recorded = (opts && Number(opts.keptSats) >= 0
                        && Number(opts.keptSats) <= got) ? Number(opts.keptSats) : got;
        /* A token that paid over and named a key for its change: what stays
         * is what was asked, and the rest goes back (`changeForScanned`). Only
         * where the caller has not already said what stays. */
        // and never more than what arrived less the change that leaves again
        if (opts && Number(opts.changeSats) > 0) {
          recorded = Math.max(0, Math.min(recorded, got - Number(opts.changeSats)));
        }
        var noted = (opts && opts.keptSats != null) ? null : FoxyWallet.changeNoteOf(text);
        var noteOwed = (noted && got > noted.asked && routeOpen()) ? got - noted.asked : 0;
        if (noteOwed > 0 && !(changeFor(wallet, noteOwed) > 0)) noteOwed = 0;
        if (noted && noteOwed > 0) recorded = noted.asked;
        var entry = {
          dir: 'in',
          sats: recorded,
          feeSats: Math.max(0, tok.amount - got),
          settled: true,
          state: 'success',
          memo: (opts && typeof opts.memo === 'string' && opts.memo) || 'ecash',
          hash: into || 'token-' + Date.now(),
        };
        // the over-payment breakdown, where the caller has one, so an amend
        // does not drop what the arrival wrote
        if (opts && Number(opts.changeSats) > 0) {
          entry.grossSats = Number(opts.grossSats) || got;
          entry.changeSats = Number(opts.changeSats);
        }
        if (noteOwed > 0) { entry.grossSats = got; entry.changeSats = noteOwed; }
        /* What was already charged to this entry stays charged.
         *
         * Ecash locked to this phone is announced first and swapped in after,
         * so the change for an overpayment is made, and its cost put on this
         * entry, before this swap lands. Writing `sats` and `feeSats` afresh
         * here wiped that out, and the books were short by what the change
         * cost (found by tests/change-leg.js at a fee mint). The
         * same for a top-up's fee that reached the entry first. */
        if (into) {
          try {
            var prior = load(K.log, []).filter(function (e) { return e && e.hash === into; })[0];
            var charged = prior ? (Number(prior.changeFee) || 0) + (Number(prior.topUpFee) || 0) : 0;
            if (charged > 0) {
              entry.sats = Math.max(0, entry.sats - charged);
              entry.feeSats += charged;
            }
            // and the sat or two that making change cost less than was allowed for
            if (prior && Number(prior.changeDust) > 0) entry.sats += Number(prior.changeDust);
          } catch (e0) {}
        }
        // a new entry is filed where the pieces went; one being finished stays where it was written
        if (!into || !txSeen(into)) entry.mint = intoMint;
        logTx(entry, into);
        console.log('[foxy] took', got, 'sats of ecash at', hostOf(tok.mint),
                    tok.amount !== got ? '(' + (tok.amount - got) + ' to the mint fee)' : '');
        return { sats: got, unit: 'sat', amount: got, mint: tok.mint, host: hostOf(tok.mint), switched: switched,
                 hash: entry.hash, changeDue: noteOwed };
      }).then(null, function (e) {
        // spent, and by this phone: marked so the screen can say that, whether the check found it or the swap was refused
        throw mineIfTaken(e, tok.proofs);
      });
    },

    /* Hand out a bearer token for an amount. Splits the pile so only what is
     * being sent leaves; the rest stays. */
    /* `opts.lockTo`: a public key to lock the ecash to (NUT-11), so only the
     * phone holding the matching private key can ever spend it.
     *
     * `opts.denominations`: with a lock, the sizes of the pieces to make (powers
     * of two, summing to no more than the amount), instead of the library's own
     * choice. A card is cut into the ladder of its amount (`cardLadder`).
     *
     * A lock cannot be put on pieces already held — it lives in the secret, so
     * the proofs have to be made afresh. That means the exact-change path below
     * is skipped and the mint is asked every time, which costs a second or two
     * and needs the network. The caller decides whether that trade is worth it
     * (payRequest), because it is the difference between a stolen token being
     * useless and being money. */
    /* Can this phone cover a send, fee included — before anything is made.
     *
     * The same sum `sendToken` refuses on, asked ahead of it so the
     * confirmation can say no. A phone held 979 sats and was asked for
     * 980 at the same mint: the card said SEND, the person pressed it, and
     * only then came "Not enough ecash. That needs 991 sats including this
     * mint's fee" — three times in a row. The answer: what is
     * needed with the fee, what is held, and whether that is short. Null
     * when there is no wallet to ask; the send itself says so then. */
    sendShortfall: function (sats, opts) {
      var w;
      try { w = needLocal(); } catch (e) { return null; }
      var want = Math.round(Number(sats));
      if (!(want > 0)) return null;
      var have = proofs(mintOf(w));
      var stuck = lockedProofs(have);
      if (stuck.length) have = have.filter(function (p) { return stuck.indexOf(p) < 0; });
      var fee = swapFeeFor(w, have);
      var waiting = routeOpen() ? [] : lockedPieces();
      var waitingSats = waiting.reduce(function (n, r) { return n + (Math.round(r.sats) || 0); }, 0);
      var held = sumProofs(have) + waitingSats;
      var need = want + fee;
      var short = held < need;
      /* And what the swap itself will ask for. A token made by a swap covers
       * the receiver's fee as well (includeFees), which the sum above does not
       * count: a phone held 26 sats, was asked for 22, passed the card
       * and was refused by cashu-ts — "Not enough funds available to send" —
       * because 22 and 3 for the receiver and 1 for the swap is not 26.
       * So the question is put to the same selection the swap
       * makes. Only with a route, where a swap is what happens; and not where
       * pieces on hand make the amount exactly and no lock is asked for, which
       * goes as it is and asks the mint nothing. */
      if (!short && routeOpen()) {
        var locked = !!(opts && opts.locked);
        var exact = null;
        try { exact = locked ? null : exactPieces(w, have, want); } catch (e0) { exact = null; }
        if (!(exact && exact.length)) {
          /* What leaves is the amount and the receiver's fee on the pieces
           * the amount is cut into (includeFees). How many pieces is
           * cashu-ts's to decide, so the count is one per set bit and four
           * to spare, the allowance the locked send itself leaves; at a mint
           * that charges, that refuses a sat or two early and never a
           * payment the swap would then refuse. Then the inputs have to
           * cover that and their own fee, which is cashu-ts's selection. */
          var bits = function (n) { return String(n.toString(2)).split('1').length - 1; };
          var out = want + feeForInputs(w, bits(want) + 4);
          /* It does not refuse. Asked for more than the pile can cover it
           * hands back nothing to send and everything to keep, and the
           * refusal comes later from the swap; so it is what it picked, less
           * the fee on those pieces, that is measured. */
          var can = false;
          try {
            var sel = w.selectProofsToSend(have, out, true);
            var picked = (sel && sel.send) || [];
            can = picked.length > 0 && sumProofs(picked) - swapFeeFor(w, picked) >= out;
          } catch (e) { can = false; }
          if (!can) {
            need = Math.max(out + fee, held + 1);
            short = true;
          }
        }
      }
      return { need: need, fee: need - want, have: held, short: short };
    },

    sendToken: function (sats, opts) {
      /* Sats only. Sending another unit's ecash is not built: the amount, the
       * fee and the pile would all need their unit, and a mistake here sends
       * cents as sats or sats as cents. Refused before anything is touched. */
      var askedUnit = opts && opts.unit !== undefined ? unitOf(opts.unit) : 'sat';
      if (askedUnit !== 'sat') {
        return Promise.reject(new Error('Foxy can only send sats as ecash. Sending ' +
          (askedUnit ? unitName(askedUnit) : 'that unit\u2019s') + ' ecash is not supported yet; nothing was sent.'));
      }
      /* The route is asserted where the mint is actually asked, below, and not
       * here.
       *
       * It was asserted here, which refused an exact-change send that makes no
       * network request at all: the pieces are already held, the token is built
       * from them, and nothing leaves the phone. Fail-closed is there to stop
       * traffic escaping outside Tor, and there is no traffic to escape — so
       * the guard was refusing an operation it has nothing to say about, and
       * with it the only way a payer with no signal could pay anyone.
       *
       * Everything between here and the branch is local: the pile, the cached
       * keyset the fee comes from, and `exactPieces`. The swap branch asserts
       * before it touches the mint, so a send that needs the network is refused
       * exactly as it always was. */
      var w;
      try { w = needLocal(); } catch (e) { return Promise.reject(e); }
      var want = Math.round(Number(sats));
      if (!(want > 0)) return Promise.reject(new Error('Ask for an amount above zero.'));
      var at = mintOf(w);
      var have = proofs(at);
      /* Nothing locked leaves in a token this phone makes.
       *
       * The pile is meant to hold plain ecash and nothing else, and a send
       * picks from it without looking. So when a locked piece was in there, a
       * token made from exact change carried it out: MAKE ECASH on a phone
       * produced a token that the phone itself refused a moment later as
       * "locked to a key this wallet does not hold", and which nobody it was
       * handed to could have claimed either.
       *
       * Left where they are and out of every selection below — a swap would
       * be refused by the mint for them as surely as a receiver would — and
       * put back untouched when the pile is written. How one got into the
       * pile is `setProofs`'s to say, in the diary, the next time it happens. */
      var stuck = lockedProofs(have);
      if (stuck.length) {
        console.warn('[foxy] the pile holds ' + stuck.length + ' locked piece(s), ' + sumProofs(stuck)
          + ' sats; left out of this send');
        have = have.filter(function (p) { return stuck.indexOf(p) < 0; });
      }
      var fee = swapFeeFor(w, have);
      /* What arrived locked to this phone counts, where it can be handed on.
       *
       * It is in the balance and not in the pile, and this looked only at the
       * pile — so a phone that had been paid while offline was told
       * "you hold 0" when it tried to pay part of it. Only with no route:
       * with one, the claim swaps them into the pile before a send is reached. */
      var waiting = (!(opts && typeof opts.lockTo === 'string' && opts.lockTo) && !routeOpen())
        ? lockedPieces() : [];
      var waitingSats = waiting.reduce(function (n, r) { return n + (Math.round(r.sats) || 0); }, 0);
      if (sumProofs(have) + waitingSats < want + fee) {
        return Promise.reject(new Error('Not enough ecash. That needs ' + (want + fee) +
          ' sats including this mint\u2019s fee, and you hold ' + (sumProofs(have) + waitingSats) + '.'
          + FoxyWallet._atRiskNote()));
      }
      /* Pieces already held that add up to exactly the amount, the receiver's
       * fee on them included, go into the token as they are: no swap, nothing
       * asked of the mint. The mint then has no moment to tie a later question
       * about the token to, so its watch can ask within seconds
       * (05-paying-this-mint.js). Foxy keeps small pieces on hand for this
       * (tidyChange). */
      var lockTo = opts && typeof opts.lockTo === 'string' ? opts.lockTo : '';
      var changeNoteKey = '';
      // pieces already held carry no lock, so locking means a swap, always
      var exact = lockTo ? null : exactPieces(w, have, want);
      /* With a route, an exact set of dozens of small pieces is swapped for a
       * handful: a wallet kept deep in small change paid with 123
       * pieces, a token of 39,000 characters that would not go over the link
       * at all. The swap asks the mint once and the
       * token is a dozen pieces. With no route there is no swap, and it goes
       * as it is — the link carries that now. */
      /* Not past what the mint takes in one request: a swap of 35 inputs at a
       * mint that takes 25 is refused outright (the live array-cap suite),
       * so above the cap the pieces go as they are. */
      if (exact && exact.length > 24 && exact.length <= mintArrayCap(w) && routeOpen()) exact = null;
      /* Nothing in the pile makes it, and no route to swap for it — but ecash
       * locked to this phone might.
       *
       * It has arrived and is counted in the balance, and it is not in the pile
       * because taking it into the pile is a swap. NUT-11 with SIG_INPUTS means
       * a proof this phone signs is one anybody can spend, so it can be handed
       * straight on (`forwardLocked`). That is what makes a day of taking
       * payments with no connection into a day of also being able to make them.
       *
       * Only where the pile alone cannot do it: pieces on hand cost nobody a
       * signature and leave the receiver less to swap. And never for a locked
       * send, which is a swap by definition. */
      /** @type {any} */
      var withLocked = null;
      if (!exact && !lockTo && !routeOpen()) {
        withLocked = exactWithLocked(w, have, lockedPieces(), want);
      }
      /* No exact pieces and no route: cover it and let the change come back.
       *
       * A swap is how an awkward amount is normally made, and a swap needs a
       * mint. So offline the choice is between paying a little too much and not
       * paying at all — and paying too much costs nothing, because the receiver
       * hands the difference back locked to this phone over the same Bluetooth
       * link (changeBack, M7). Only over that link: `opts.over` is set by the
       * tap's own path, which is the one place there is a link to hand change
       * back over. Without it, exact amounts went through and
       * anything needing change died on the spot. */
      /* And piece by piece, when whole payments will not make it. The pile
       * and every locked piece are one pool, and what is picked from a row is
       * signed and handed on without the rest of that row. Tried after whole
       * rows, which are fewer signatures for the same result. */
      /** @type {{ proof: any, row: string }[]} */
      var lockedFlat = (!exact && !withLocked && !lockTo && !routeOpen()) ? lockedProofsFlat() : [];
      var partsOf = function (picked) {
        var rowOf = {};
        lockedFlat.forEach(function (f) { rowOf[String(f.proof.secret)] = f.row; });
        var groups = {}, pieces = [];
        (picked || []).forEach(function (pr) {
          var id = rowOf[String(pr.secret)];
          if (id === undefined) { pieces.push(pr); return; }
          (groups[id] = groups[id] || []).push(pr);
        });
        var at = String(mintUrl || '').replace(/\/+$/, '');
        var rows = Object.keys(groups).map(function (id) {
          return { id: id, sats: sumProofs(groups[id]), part: true,
                   token: window.CashuTS.getEncodedToken({ mint: at, proofs: groups[id], unit: 'sat' }) };
        });
        return { rows: rows, pieces: pieces };
      };
      if (lockedFlat.length) {
        var pool = have.concat(lockedFlat.map(function (f) { return f.proof; }));
        var combo = exactPieces(w, pool, want);
        if (combo && combo.length) {
          var parts = partsOf(combo);
          if (parts.rows.length) {
            withLocked = { rows: parts.rows, pieces: parts.pieces, over: 0, part: true };
          }
        }
      }
      /** @type {?{ picked: any[], total: number, over: number }} */
      var cover = null;
      if (!exact && !withLocked && !lockTo && !routeOpen() && opts && opts.cover) {
        cover = coverPieces(w, have, want);
        /* Over-paying is the person's to agree to, not this function's.
         *
         * Where the receiver has a route the difference comes straight back and
         * the question is small. Where neither phone has one it cannot come back
         * at all — the receiver would have to swap to make change — so the extra
         * is a gift, and a wallet does not give somebody's money away because the
         * arithmetic was convenient. Refused here with the figures attached, for
         * the screen to ask with. */
        /* And the payments that arrived locked, where the pile cannot cover it
         * or covers it worse. They go whole — a payment is signed as it arrived
         * — so the fewest that reach the amount are handed on and the rest
         * comes back as change like any other over-payment. */
        if (waiting.length) {
          var up = waiting.slice().sort(function (a, b) { return a.sats - b.sats; });
          var one = up.filter(function (r) { return r.sats >= want; })[0];
          /** @type {any[]} */
          var rows = one ? [one] : [];
          if (!rows.length) {
            var sum = 0;
            waiting.slice().sort(function (a, b) { return b.sats - a.sats; }).some(function (r) {
              rows.push(r); sum += r.sats; return sum >= want;
            });
            if (sum < want) rows = [];
          }
          var rowsTotal = rows.reduce(function (n, r) { return n + r.sats; }, 0);
          /* Less the receiver's fee on those pieces, which comes off what
           * arrives: payments that add up to the amount exactly land short
           * of it at a mint that charges, and are refused. */
          var rowsFee = swapFeeFor(w, rows.reduce(function (l, r) { return l.concat(r.proofs || []); }, []));
          if (rows.length && rowsTotal < want + rowsFee) rows = [];
          if (rows.length && (!cover || rowsTotal < cover.total)) {
            withLocked = { rows: rows, pieces: [], over: rowsTotal - want - rowsFee };
            cover = { picked: [], total: rowsTotal, over: rowsTotal - want - rowsFee };
          }
          /* Neither alone, but the two together: everything that is waiting,
           * and the pile on top of it. The balance counts both, so a payment
           * the balance can afford has to be one this can make. */
          if (!cover && !rows.length) {
            var all = waiting.reduce(function (n, r) { return n + r.sats; }, 0);
            // the fee is on everything in the token: the pile's pieces and the locked ones beside them
            var beside = waiting.reduce(function (l, r) { return l.concat(r.proofs || []); }, []);
            var rest = coverPieces(w, have, Math.max(1, want - all), beside);
            if (rest) {
              // what is over, of the whole token: everything in it, less the amount and the fee on every piece
              var overAll = Math.max(0, all + rest.total - want - swapFeeFor(w, rest.picked.concat(beside)));
              withLocked = { rows: waiting.slice(), pieces: rest.picked, over: overAll };
              cover = { picked: rest.picked, total: all + rest.total, over: overAll };
            }
          }
        }
        /* Change can come back to a token shown as a code, where this phone
         * can name a key to lock it to: the key rides in the token's note, the
         * receiver makes the change locked to it and shows that as a code in
         * turn. Then over-paying gives nothing away and nobody is asked. With no key to name, it is asked as before. */
        /* The same overpayment, from pieces: the least that covers it out of
         * everything held, loose or locked, when that is less than whole
         * payments would hand over. Paying 1,180 with a 23,606 payment is
         * 22,426 to wait for; with that payment's own pieces it is a few sats,
         * or none. */
        if (lockedFlat.length) {
          var cp = coverPieces(w, have.concat(lockedFlat.map(function (f) { return f.proof; })), want);
          if (cp && (!cover || cp.total < cover.total)) {
            var cparts = partsOf(cp.picked);
            if (cparts.rows.length) {
              withLocked = { rows: cparts.rows, pieces: cparts.pieces, over: cp.over, part: true };
              cover = { picked: cparts.pieces, total: cp.total, over: cp.over };
            }
          }
        }
        if (cover && !opts.overpayOk && opts.changeNote && cover.over > 0) {
          changeNoteKey = changeKeyFor('tok-' + Date.now().toString(36)
            + Math.random().toString(36).slice(2, 6)) || '';
          if (changeNoteKey) {
            console.log('[foxy] no exact pieces: paying ' + cover.total + ' for ' + want
              + ', with a key in the token for the ' + cover.over + ' sats of change');
          }
        }
        /* A key the caller already has for this payment's change — a tap puts
         * it in the message it sends — goes in the token as well. The message
         * is only one of the roads the token can take: when the link dropped
         * and the token was shown as a code instead, it named no key, the
         * receiver could lock change to nobody and kept the lot — 83 sats
         * over on a 300-sat payment (offline-cross-scenarios.js `over-cut`). */
        /* Only once paying over has been agreed to (`overpayOk`): the key
         * says where change goes, not that the person was asked. */
        if (cover && cover.over > 0 && !changeNoteKey && opts.overpayOk && typeof opts.changeKey === 'string'
            && /^0[23][0-9a-f]{64}$/i.test(opts.changeKey)) {
          changeNoteKey = opts.changeKey;
        }
        if (cover && !opts.overpayOk && !changeNoteKey) {
          var needs = /** @type {any} */ (
            new Error('This phone has no exact change for ' + want + ' sats.'));
          needs.foxyNeedsOverpay = { asked: want, pay: cover.total, over: cover.over };
          return Promise.reject(needs);
        }
      }
      var made;
      if (withLocked) {
        /* Signed now, and only the rows that are really going out: signing
         * writes them down as handed on (`rememberHandedOn`) and drops them from
         * the unclaimed store, which is what stops the same proofs leaving
         * twice. So the selection happens first and the signatures follow. */
        var lockedOut = [];
        var fromPile = withLocked.pieces || [];
        var took = {};
        fromPile.forEach(function (p) { took[p.secret] = true; });
        console.log('[foxy] no exact pieces in the pile; handing on '
          + (withLocked.part ? 'pieces of ' : '')
          + withLocked.rows.length + ' locked payment(s) that arrived earlier'
          + (fromPile.length ? ' with ' + fromPile.length + ' piece(s) beside them' : '')
          + (withLocked.over > 0 ? ', ' + withLocked.over + ' sats over, to come back as change' : ''));
        made = withLocked.rows.reduce(function (chain, row) {
          return chain.then(function () {
            return FoxyWallet.forwardLocked(row.token, { defer: true }).then(function (r) {
              (r.signed || []).forEach(function (pr) { lockedOut.push(pr); });
            });
          });
        }, Promise.resolve()).then(function () {
          return { send: fromPile.concat(lockedOut),
                   keep: have.filter(function (p) { return !took[p.secret]; }),
                   // signed, not yet struck off: that waits for the token (below)
                   handedOn: lockedOut.slice(),
                   swapped: false, over: Math.max(0, Number(withLocked.over) || 0) };
        });
      } else if (exact || cover) {
        var use = exact || (cover && cover.picked) || [];
        var out = {};
        use.forEach(function (p) { out[p.secret] = true; });
        var overBy = cover ? cover.over : 0;
        if (cover) {
          console.log('[foxy] no route and no exact pieces: paying ' + cover.total
            + ' sats for ' + want + ', with ' + overBy + ' sats of change to come back');
        }
        made = Promise.resolve({ send: use, keep: have.filter(function (p) { return !out[p.secret]; }),
                                 swapped: false, over: overBy });
      } else {
        /* The mint is about to be asked, so the route has to be there — and
         * this job needs its own circuit, which is the other half of what
         * `need()` does and the reason the swap re-acquires rather than using
         * the local view from above. The one kept ready, when there is one:
         * this is a swap somebody is standing and waiting for (`needNow`). */
        try { w = needNow(); } catch (e) { return Promise.reject(e); }
        /* The swap's output ranges are on disk until the answer is in, and
         * cleared before anything else once it is: the token's proofs must never
         * be restorable as balance after the token exists. A lost answer used to
         * leave the pile holding spent inputs and the swap's outputs nowhere. */
        // the pile it was handed, so a lost answer's restore can be checked against what the swap took
        var guard = swapGuard(w, 'send', { inputs: have, locked: !!lockTo,
          pay: { want: want, purpose: (opts && opts.purpose) || '', forHash: (opts && opts.forHash) || '',
                 owed: (opts && opts.owed) || 0 } });
        /* One large piece in, the pool's pieces back. A locked payment is a
         * swap whatever goes in, and letting it pick its own inputs spent the
         * small pieces that exact change needs, so a top-up followed every
         * payment. The smallest piece that covers the amount and
         * its fee goes in alone, and what comes back is shaped to fill the
         * pool (shapeOutputs). Without such a piece, the old way. */
        var oneIn = null, keepShape, others = [];
        if (lockTo) {
          /* Covering the amount, the input fee, and the fee cashu-ts adds to the
           * sent outputs (includeFees) — without that last, a fee mint refused a
           * one-piece send the whole pile could have made (an audit finding). */
          /* How many pieces go out: the amount's binary places, or, where the
           * caller cut them (a card is cut like a cash drawer), as many as it
           * named. The fee is paid for each. */
          var piecesOut = (opts && Array.isArray(opts.denominations) && opts.denominations.length)
            ? opts.denominations.length : String(want.toString(2)).split('1').length - 1;
          var outFee = feeForInputs(w, piecesOut + 4);
          var big = have.filter(function (p) { return satsOf(p.amount) - swapFeeFor(w, [p]) >= want + outFee; })
            .sort(function (a, b) { return satsOf(a.amount) - satsOf(b.amount); });
          if (big.length) {
            oneIn = big[0];
            /* What comes back is the piece less the input fee, the amount, and
             * the fee cashu-ts adds to the sent outputs so the receiver's own
             * swap is paid for (includeFees). That last figure depends on how
             * many pieces the amount splits into, which is cashu-ts's to
             * decide, so a generous allowance is left out of the shape and
             * cashu-ts fills the gap with powers of two: a shape that sums to
             * less than the change is padded, one that sums to more is refused. */
            var pieces = piecesOut;
            var slack = feeForInputs(w, pieces + 4);
            var back = satsOf(oneIn.amount) - swapFeeFor(w, [oneIn]) - want - slack;
            others = have.filter(function (p) { return p !== oneIn; });
            // the sent pieces and the change share one request's cap
            keepShape = { type: 'deterministic', counter: 0, denominations: shapeOutputs(others, back, mintArrayCap(w) - pieces - 20) };
          }
        }
        made = guard.run('token', function () {
          /* Locked outputs when the request asked for them: the proofs come
           * back with a P2PK secret naming the receiver's key, and only that
           * key can ever spend them. */
                         /* As cashu.me and Nutshell send: a refund to the sender
                          * after a time. Foxy never sets one for its own payments;
                          * this is for making such a token where a test needs one. */
          var lockOut = { type: 'p2pk', options: (opts && opts.lockUntil > 0)
                         ? { pubkey: lockTo, locktime: Math.floor(opts.lockUntil),
                             refundKeys: opts.refundTo ? [String(opts.refundTo)] : undefined }
                         : { pubkey: lockTo } };
          /* The pieces of a locked send, cut as the caller says (a card is cut
           * into the ladder of its amount: 08a-flashcard.js). Whatever the sum
           * of them leaves of the amount, and the fee on them, is filled by the
           * library as it always was. */
          if (lockTo && opts && Array.isArray(opts.denominations) && opts.denominations.length) {
            lockOut.denominations = opts.denominations.map(function (d) { return Math.round(Number(d)); });
          }
          return lockTo
            ? (oneIn ? w.send(want, [oneIn], { includeFees: true }, { send: lockOut, keep: keepShape })
                     : w.send(want, have, { includeFees: true }, { send: lockOut }))
            : w.send(want, have, { includeFees: true });
        }).catch(function (e) {
          /* The mint never answered, but it had signed the locked outputs and
           * the record was enough to rebuild them (`restoreLocked`). The money
           * has left this wallet and is locked to the receiver, so there is
           * nothing to put back in the pile — what there is, is the payment,
           * and the send carries on with it as if the answer had arrived. */
          if (e && e.recovered && Array.isArray(e.lockedProofs) && e.lockedProofs.length) {
            /* What is left is the swap's change *and* every proof it never
             * selected: cashu-ts takes a subset of the pile, and `setProofs`
             * below replaces the pile whole. Returning the change alone threw
             * the untouched proofs away — 272 of 400 sats on the first run of
             * tests/locked-send-lost.js, which is why that test counts the
             * whole balance rather than the token. */
            var spent = {};
            (e.spentInputs || []).forEach(function (p) { if (p && p.secret) spent[p.secret] = true; });
            var untouched = have.filter(function (p) { return p && p.secret && !spent[p.secret]; });
            return { send: e.lockedProofs, keep: untouched.concat(e.changeProofs || []),
                     swapped: true, guard: guard };
          }
          // some of that ecash was spent elsewhere: out of the pile, and made again
          return retryWithoutSpent(w, e);
        }).then(function (split) {
          /* cashu-ts hands back the keep outputs and whatever inputs it did
           * not select. With one piece in, nothing was left unselected, and
           * the rest of the pile is this wallet's to put back itself. Once
           * only: an answer that was lost and then restored (above) already
           * carries the untouched pile, and putting it back twice doubled the
           * balance (the live p2pk suite). */
          var keep = split.keep || [];
          if (oneIn) {
            var seen = {};
            keep.forEach(function (p) { if (p && p.secret) seen[p.secret] = true; });
            keep = others.filter(function (p) { return p && p.secret && !seen[p.secret]; }).concat(keep);
          }
          return { send: split.send, keep: keep, swapped: true, guard: guard };
        });
      }
      return made.then(function (split) {
        /* The rest is written, then the record cleared, then the token made.
         * The record used to be cleared first, so a pile that could not be
         * written (storage full) left the swap's outputs nowhere; now the write
         * throws with the record in place, no token exists, and recoverSwaps
         * puts everything back on the next connect (audit W6). The
         * token is still only made once the record is gone, so its proofs are
         * never restorable as balance. */
        setProofs((split.keep || []).concat(stuck), at, w);
        /* Change for an over-payment was set aside from the balance when the
         * payment landed (`holdChange`). Its pieces have just left the pile,
         * so it is let go here and nowhere later: between this line and the
         * caller hearing of it the balance would be short by the change. */
        if (opts && opts.purpose === 'change' && opts.forHash) changeHoldOver(opts.forHash);
        if (split.guard) split.guard.done();
        var token = window.CashuTS.getEncodedToken(changeNoteKey && Number(split.over) > 0
          ? { mint: at, proofs: split.send, unit: 'sat',
              memo: CHANGE_NOTE + changeNoteKey + ':' + want }
          : { mint: at, proofs: split.send, unit: 'sat' });
        /* Unique, not only the millisecond: a token made from pieces already held
         * asks the mint nothing, so two can be made in the same millisecond, and
         * a shared name lost one of them from the books (tests/interleave.js). */
        var hash = 'token-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

        /* The string IS the money now — those proofs are out of the balance
         * and exist nowhere else. Written down before anything else can go
         * wrong, so losing the screen cannot lose the sats.
         *
         * mustSave, not save: the swap guard was released a few lines above
         * and the recovery record is already gone, so a write that quietly
         * failed here left the token in no pile, no hold and no record —
         * recoverable only by a seed restore that nothing would have prompted.
         * `save` returns false on a refusal and this ignored it, which is
         * exactly what the comment above claimed could not happen. */
        mustSave(K.outtok, { token: token, sats: sumProofs(split.send), mint: at,
                             hash: hash, at: Date.now(), swapped: split.swapped });
        /* The token exists and is written down: now the locked pieces in it
         * are struck off, all of them, in the same breath. */
        if (split.handedOn && split.handedOn.length) {
          rememberHandedOn(split.handedOn);
          takeFromUnclaimed(split.handedOn);
          console.log('[foxy] handed on ' + sumProofs(split.handedOn) + ' sats of locked ecash, signed here');
        }

        /* Paid over by too little to come back. The receiver's phone does
         * the same sum from the same mint's fees (`changeFor`) and makes no
         * change, so none is waited for here: the entry is the whole of what
         * left, the link is not held open, and nothing is flagged as change
         * that never came. */
        var dust = 0;
        if (Number(split.over) > 0 && !(changeFor(w, Number(split.over)) > 0)) {
          dust = Number(split.over);
          split.over = 0;
          console.log('[foxy] ' + dust + ' sat(s) over is too little to come back at this mint; it goes with the payment');
        }
        var isChange = !!(opts && opts.purpose === 'change');
        /* What the swap cost. The pile went in, the token and the change came
         * out, and the difference is the mint's. It was written as 0, so a
         * 945-sat token that took 956 from the pile left the audit 11 short,
         * and another phone 4 short over two payments. Exact
         * pieces swap nothing and cost nothing. */
        var tokFee = split.swapped
          ? Math.max(0, sumProofs(have) - sumProofs(split.send) - sumProofs(split.keep || []))
          : 0;
        /* Change handed back writes no entry of its own.
         *
         * It is the tail of a payment that already has one, and filing it
         * separately is what showed two transactions for one sale.
         * The token is still recoverable — `K.outtok` above is
         * what the token screen reads, not this — and the payment's own entry
         * carries the figures (`changeSats`). */
        if (isChange) {
          console.log('[foxy] change of ' + sumProofs(split.send)
            + ' sats made; it belongs to the payment it came from, not to a row of its own');
        } else logTx({
          dir: 'out',
          /* What was paid, not the piece it was paid with. An offline payer
           * with no exact pieces covers the amount and the receiver hands the
           * difference back, so a 2-sat payment made with a 4-sat piece is a
           * 2-sat payment — with `grossSats` and `changeSats` beside it so the
           * detail screen can show all three, and so a report about it has the
           * figures in it. `over` is 0 on every ordinary send. */
          sats: sumProofs(split.send) - (Number(split.over) || 0),
          grossSats: sumProofs(split.send),
          changeSats: Number(split.over) || 0,
          changeState: Number(split.over) > 0 ? 'owed' : '',
          // paid over by too little to come back: said on the entry, counted in what it cost
          dustSats: dust || undefined,
          feeSats: tokFee,
          // settled as far as this wallet is concerned: the proofs left the
          // balance. Whether anyone claimed the token is the mint's business,
          // and nothing here checks after the fact.
          settled: true,
          state: 'success',
          memo: 'ecash',
          hash: hash,
          mint: at,
        });
        logAudit({
          hash: hash,
          sats: sumProofs(split.send),
          feeSats: tokFee,
          kind: 'token',
          // what went into the token, and what stayed behind as change
          inputs: (split.send || []).map(scrub),
          outputs: (split.keep || []).map(scrub),
        });
        // the token rides along with the entry, so it can be handed over again
        // if the first attempt never reached anyone
        /* Change handed back is not a payment leaving. It is the tail of one
         * that arrived, and the receiver's own screens must not announce it as
         * money going out: a receiver was paid 3 sats with a 4-sat piece and saw
         * a confirmation for 4, then a second one for 1 sat withdrawn, for a
         * single 3-sat sale.
         *
         * The entry itself stays. `sendToken` writes one either way, and it is
         * what puts an undelivered change token on the token screen instead of
         * losing it. What changes is only what it is called. */
        /* `inflight` while a payment is still on its way to somebody.
         *
         * `sendToken` writes a settled entry the moment the token exists, which
         * is before it has been handed over — and the history pass announces
         * every new settled entry as a payment that happened. On a both-offline
         * tap the receiver is reading a card, so the payer was shown a
         * confirmation of withdrawal thirteen seconds before they said no.
         * Tagged as it is written, not a
         * moment later: the pass runs on a heartbeat and would race it. */
        FoxyWallet.tag(hash, isChange ? { to: 'change', change: true, token: token }
                    : (opts && opts.inflight) ? { to: 'ecash', token: token, inflight: true }
                    : { to: 'ecash', token: token });
        return { token: token, sats: sumProofs(split.send), mint: at, hash: hash,
                 swapped: split.swapped, lockedTo: lockTo || '',
                 // what the swap cost; change has no row of its own, so its
                 // caller puts this on the payment it belongs to
                 fee: tokFee,
                 /* What was paid over the amount asked, which the receiver owes
                  * back as change. Zero on every ordinary send. */
                 over: Number(split.over) || 0, asked: want, dust: dust,
                 // whether the token names a key for its change to be locked to
                 changeAsked: !!(changeNoteKey && Number(split.over) > 0) };
      });
    },

    /* The change for a payment came back, or never did: the payment's own entry
     * is finished, rather than a second one being written.
     *
     * `hash` is the send's and `sats` is what arrived. Nothing arriving is not a
     * failure of the payment — the money left and the goods changed hands — so
     * the entry becomes what really happened: the whole piece, gone. Either way
     * the three figures stay on it, which is what a person can send in a report
     * about a payment that looked wrong. */
    changeSettled: function (hash, sats, opts) {
      var got = Number(sats) || 0;
      var rows = [];
      try { rows = (load(K.log, []) || []).filter(function (e) { return e && e.hash === hash; }); }
      catch (e) { rows = []; }
      if (!rows.length) return false;
      var one = rows[0];
      var gross = Number(one.grossSats) || Number(one.sats) || 0;
      /* The payment itself sent back (`opts.refund`), on top of change that
       * had already come: both are back. Written over the change, a payment
       * of 312 for 310 whose 2 came back and whose 310 was then returned read
       * as having cost 2, when it cost nothing (tests/crossings.js, by the
       * books). Never more than went. */
      if (got > 0 && opts && opts.refund && one.changeState === 'came back') {
        got = Math.min(gross, got + (Number(one.changeSats) || 0));
      }
      if (got > 0) {
        amendTx(hash, { changeSats: got, sats: Math.max(0, gross - got),
                        changeState: 'came back' });
        console.log('[foxy] the change for that payment came back: ' + got
          + ' sats, so it cost ' + Math.max(0, gross - got));
      } else {
        /* Which way the change was going decides what to call its absence: a
         * payer's never arrived, a receiver's never went. Either way the entry
         * becomes the gross, because that is what this phone is holding. */
        var mine = one.dir === 'in';
        amendTx(hash, { sats: gross, changeState: mine ? 'never sent' : 'never came' });
        console.warn(mine
          ? '[foxy] the change for that payment could not be sent, so this phone kept all '
            + gross + ' sats'
          : '[foxy] no change came back for that payment, so it cost the whole '
            + gross + ' sats');
      }
      return true;
    },

    /* Keep small change on hand: two of each piece from 1 to 128 sats, while
     * the balance allows. A token of an amount those pieces make needs no swap
     * (sendToken, exactPieces), and is heard about as soon as it is redeemed.
     *
     * One larger piece is swapped for what is missing, in the mint's own
     * denominations, with the rest back as powers of two. It runs when the app
     * finds a quiet moment, at a random time (the app's tidyChangeLater), on a
     * circuit of its own, so it is not tied to the payment before it. Not at a
     * mint that charges more than 1 sat for it. Resolves { split } with the
     * piece swapped, or { skipped } with why nothing was done. */
    tidyChange: function () {
      var w;
      try { w = need(); } catch (e) { return Promise.resolve({ skipped: 'no mint' }); }
      var at = mintOf(w);
      var have = proofs(at);
      var plan = changePlan(w, have);
      if (!plan.input) return Promise.resolve({ skipped: plan.why });
      var guard = swapGuard(w, 'split', { inputs: [plan.input] });
      // on the record while it is out, for `topUpClosing`
      FoxyWallet._topUp = guard.record;
      var clearTopUp = function (r) { if (FoxyWallet._topUp === guard.record) FoxyWallet._topUp = null; return r; };
      return guard.run('change', function () {
        return w.send(plan.amount, [plan.input], { includeFees: false }, {
          send: { type: 'deterministic', counter: 0, denominations: plan.denominations },
          keep: { type: 'deterministic', counter: 0 },
        });
      }).catch(function (e) {
        return retryWithoutSpent(w, e).catch(function (x) {
          // a piece spent elsewhere is out of the pile now; nothing else to do
          if (x && x.foxyAgain) return null;
          throw x;
        });
      }).then(clearTopUp, function (e) { clearTopUp(); throw e; }).then(function (split) {
        if (!split) return { skipped: 'that piece was spent elsewhere' };
        var gone = plan.input.secret;
        var now = proofs(at).filter(function (p) { return p.secret !== gone; })
          .concat(split.send || [], split.keep || []);
        setProofs(now, at, w);
        guard.done();
        console.log('[foxy] small change: a', plan.input.amount, 'sat piece into',
          (split.send || []).concat(split.keep || []).length, 'pieces');
        /* The fee this swap cost is written down, per mint. It is the one
         * fee no history row carries, and at a mint that charges one the
         * audit drifted a sat or two behind the balance with every top-up
         * (at macadamia). The audit counts it. */
        var topFee = Math.max(0, satsOf(plan.input.amount) - satsOf(plan.amount));
        if (topFee > 0) chargeTopUpFee(at, topFee);
        // whether what is still short is only the larger tiers, which can wait for a quiet phone
        var left = shortOf(now);
        return { split: satsOf(plan.input.amount),
                 deepOnly: left.length > 0 && left.every(function (d) { return d > 128; }) };
      });
    },

    /* The fee a top-up swap cost goes on the payment it followed: the newest
     * settled payment at that mint, which is the one that left the pool
     * short. A receive's amount drops by it and its FEE
     * shows it; a send's FEE grows and its total with it. Only when there is
     * no such row is it kept in the per-mint tally the audit counts. */
    /* How many swaps `tidyChange` would make from here, worked out on a copy
     * of the pile and asking no one: what MAKING CHANGE counts toward. */
    /* The Tor window is closing with a top-up swap still unanswered. The
     * mint is asked, quickly, whether it has taken the piece: if not, the
     * piece is left in the pile rather than held, so somebody who stays
     * offline can spend all they have. The record stays
     * and the next connection settles it. A request that lands at the mint
     * in the moment after this check is the one case this gets wrong; the
     * twelve-second rule on starting swaps keeps that moment rare. */
    topUpClosing: function () {
      var rec = FoxyWallet._topUp;
      if (!rec || !rec.inputs || !rec.inputs.length) return Promise.resolve(false);
      var w;
      try { w = need(); } catch (e) { return Promise.resolve(false); }
      return withTimeout(statesOf(w, rec.inputs), 4000, 'the closing check').then(function (states) {
        var free = states.length === rec.inputs.length && states.every(function (s) { return s === 'UNSPENT'; });
        if (free) { rec.freeInputs = true; writeSwap(rec); }
        console.log('[foxy] small change: the window is closing with a swap out; the piece is ' + (free ? 'still unspent, kept spendable' : 'spoken for'));
        return free;
      }, function () { return false; });
    },

    tidySteps: function () {
      var w;
      try { w = need(); } catch (e) { return 0; }
      var have = proofs(mintOf(w)).slice();
      var n = 0;
      for (; n < 24; n++) {
        var plan = changePlan(w, have);
        if (!plan.input) break;
        var input = plan.input;
        have = have.filter(function (p) { return p !== input; })
          .concat((plan.denominations || []).map(function (d) { return { amount: d, id: input.id, secret: '', C: '' }; }));
      }
      return n;
    },

    exportProofs: function () {
      var have = proofs();
      if (!have.length) throw new Error('Nothing to back up yet.');
      if (!mintUrl) throw new Error('No mint connected yet.');
      return window.CashuTS.getEncodedToken({ mint: mintUrl, proofs: have, unit: 'sat' });
    },

    /* Accepts a token, or the JSON the older builds produced. */
    importProofs: function (text) {
      var t = String(text || '').trim();
      if (t.indexOf('cashu:') === 0) t = t.slice(6);

      if (/^cashu[AB]/.test(t)) {
        // getDecodedToken needs the mint's keyset ids to resolve short ones.
        // The connected wallet knows them; without one, pass an empty list,
        // which is enough for full-length ids.
        var decoded = wallet
          ? wallet.decodeToken(t)
          : window.CashuTS.getDecodedToken(t, []);
        if (!decoded || !decoded.proofs) throw new Error('That token could not be read.');
        // a backup is sats; another unit's ecash is received as a token, into its own pile
        if (decoded.unit && unitOf(decoded.unit) !== 'sat') {
          throw new Error('That token holds ' + unitName(decoded.unit) +
            ' ecash. Import takes sats only; receive it as a token instead.');
        }
        if (mintUrl && canonicalMint(decoded.mint) !== canonicalMint(mintUrl)) {
          throw new Error('That token is from a different mint (' + decoded.mint + ').');
        }
        return importChecked(decoded.proofs);
      }

      var data;
      try {
        data = JSON.parse(t);
      } catch (e) {
        throw new Error('That is not a Cashu token or a Foxy backup.');
      }
      if (!data || !data.proofs) throw new Error('That is not a Foxy backup.');
      if (!Array.isArray(data.proofs)) throw new Error('That backup has no proofs in it.');
      // a legacy backup names no mint, so it can only be trusted to the one
      // that is connected; a mismatch is refused the same way a token is
      if (data.mint && mintUrl && canonicalMint(data.mint) !== canonicalMint(mintUrl)) {
        throw new Error('That backup is from a different mint (' + data.mint + ').');
      }
      return importChecked(data.proofs);
    },

