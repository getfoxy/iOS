    /* ---- seed phrase ----------------------------------------------------
     *
     * Twelve words that recover everything. Written down once, whenever the
     * person gets round to it — the wallet works either way, because the seed
     * exists from the first launch. The words are the phone's: shown and typed
     * on its own screens, never in this page.
     */
    hasSeed: function () {
      return nativeSeedKnown;   // the phone's last seedStatus, or a seed it made or adopted since
    },

    /* False when the phone said it has no passcode: nothing stands before the
     * seed screen, a replace or a delete but an alert, and the app warns. */
    phoneHasPasscode: function () {
      return phonePasscode;
    },

    /* The phone shows the twelve words, and with `verify` its quiz. Resolves
     * { verified }; a quiz passed there marks the wallet backed up here, where
     * that flag has always lived. */
    showSeedNative: function (opts) {
      var verify = !!(opts && opts.verify);
      return nativeJson('seedShow', { verify: verify }, PERSON_MS).then(function (j) {
        var verified = j.verified === true;
        if (verified) {
          FoxyWallet.setBackedUp(true);
          console.log('[foxy] seed phrase verified on the phone');
        }
        // DELETE ALL DATA held on the phone's screen: the page asks before any wipe
        // and whether TAP TO REVEAL was pressed, which is what VERIFY WORDS waits for
        return { verified: verified, deleteAsked: j.delete === true, revealed: j.revealed === true };
      });
    },

    /* RESTORE's twelve words, typed on the phone's own screen. Resolves the
     * candidate the phone holds them under, for scanSeed({ candidate }) and
     * adoptScan(rows, { candidate }), or null when the person cancelled. */
    enterSeedNative: function () {
      return nativeJson('seedEnter', {}, PERSON_MS).then(function (j) {
        if (typeof j.candidate !== 'string' || !j.candidate) throw new Error('the phone’s answer to seedEnter was not understood');
        return j.candidate;
      }, function (e) {
        if (String(e && e.message) === 'cancelled') return null;
        throw e;
      });
    },

    /* The phone forgets words typed into RESTORE that were not adopted, or are
     * no longer needed by a scan. The phone keeps an adopted candidate until
     * this is asked, so it is asked only once every scan still using the
     * candidate has ended: a mint answering after the adopt is still walked
     * with the words (review M6). */
    forgetSeedCandidate: function (candidate) {
      if (!candidate) return Promise.resolve(false);
      var c = String(candidate);
      return candidateFree(c).then(function () {
        delete adoptedCandidates[c];
        delete candidateKeysets[c];
        return nativeJson('seedCandidateForget', { candidate: c });
      }).then(function (j) {
        return j.forgotten === true;
      });
    },

    /* A seed in the keychain and nothing else this app has ever written.
     *
     * Keychain items outlive app deletion, so this is what a reinstall looks
     * like: the seed survived and every file the app wrote is gone. Confirmed
     * on device — hasSeed() returns true on a genuinely fresh install, with a
     * balance of zero because the proofs went with the app.
     *
     * AN UPDATE MUST NEVER LOOK LIKE THIS. Updating through the App Store
     * replaces the binary and leaves the container alone, so mints, proofs,
     * history and counters all survive. Any one of them being present is
     * enough to say this is a running wallet, and the test is deliberately
     * generous in that direction: a single foxy.* key with content means no.
     *
     * Scanning for the prefix rather than naming keys is also deliberate. An
     * earlier version listed six key names and three of them did not exist,
     * and a key that is never written is always empty — so half the evidence
     * meant nothing.
     */
    looksLikeReinstall: function () {
      /* The seed is the phone's, and whether it exists is seedStatus's answer
       * (seedReady asks it); the question is unchanged. */
      if (!nativeSeedKnown) return false;
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (!k || k.indexOf('foxy.') !== 0) continue;
          if (k === LEGACY_SEED_KEY) continue;   // an older install's seed, which is the question
          if (k === SCHEMA_KEY) continue;        // stamped on every launch, even a fresh one
          if (k === COUNTERS_SENT_KEY) continue; // the one-time moves onto the phone
          if (k === SEED_MOVED_KEY) continue;
          var v = localStorage.getItem(k);
          if (v && v !== '[]' && v !== '{}' && v !== 'null' && v !== '""' && v !== '0') {
            return false;                        // something is here: not a reinstall
          }
        }
      } catch (e) {
        return false;                            // cannot tell, so do not claim it
      }
      return true;
    },

    /* Read a NUT-18 payment request.
     *
     * creq + base64url CBOR. Just enough of a CBOR reader for the shapes the
     * spec uses: maps, arrays, integers, text and byte strings. Returns what
     * is being asked for, and how they wanted it delivered.
     */
    decodeRequest: function (text) {
      /* cashu-ts's decoder, not a hand-written CBOR reader.
       *
       * Foxy used to parse payment requests itself, and had to be taught that
       * a declared length is a claim, not a fact, after a crafted QR code froze
       * the app. The library's decoder passes the NUT-18 vectors, as Foxy's
       * did (tests/nut-vectors.js), and reads creqB as well — one less parser
       * in the wallet to get wrong. The shape returned is unchanged. */
      var t = FoxyWallet.unwrap(text);
      if (!/^creq[ab]/i.test(t)) return null;
      var CT = window.CashuTS;
      if (!CT || typeof CT.decodePaymentRequest !== 'function') return null;
      var r;
      try { r = CT.decodePaymentRequest(t); } catch (e) { return null; }
      if (!r || typeof r !== 'object') return null;
      var sats = 0;
      sats = satsOf(r.amount);
      /* Text where text is expected, and nothing else. A crafted request put
       * a number where the id, the unit or the description goes, and the
       * reader handed it on as it was (tests/fuzz-parsers.js,
       * seeds 1–5: id -21, unit -16, description -14132). */
      var str = function (v) { return typeof v === 'string' ? v : ''; };
      return {
        id: str(r.id),
        sats: isFinite(sats) ? sats : 0,
        unit: str(r.unit) || 'sat',
        /* The key the payer must lock its ecash to, if this request asks for
         * one. Checked for shape here so nothing downstream has to wonder: a
         * compressed secp256k1 point and nothing else. */
        lockTo: (function () {
          var n10 = r.nut10;
          if (!n10 || n10.kind !== 'P2PK' || typeof n10.data !== 'string') return '';
          return /^0[23][0-9a-f]{64}$/i.test(n10.data) ? n10.data : '';
        })(),
        // text only: a crafted request carried numbers and byte arrays here
        mints: Array.isArray(r.mints) ? r.mints.filter(function (m) { return typeof m === 'string'; }) : [],
        description: str(r.description),
        /* What a phone with no route asked for, when it asked in dollars: the
         * amount in cents and the price it last saw, both written into the
         * description (`paymentRequest`). Zeroes when this is an ordinary
         * request, which is every request with a sat amount on it. */
        usd: (function () {
          var m = /foxy1 usd=(\d{1,9})/.exec(String(r.description || ''));
          return m ? Number(m[1]) : 0;
        })(),
        theirRate: (function () {
          var m = /foxy1 [^\n]*rate=(\d{1,12})/.exec(String(r.description || ''));
          return m ? Number(m[1]) : 0;
        })(),
        theirRateAt: (function () {
          var m = /foxy1 [^\n]*at=(\d{1,12})/.exec(String(r.description || ''));
          return m ? Number(m[1]) * 1000 : 0;
        })(),
        transports: (r.transport || []).map(function (x) { return x && x.type; }).filter(Boolean),
        // how Foxy pays it straight to them, when it can (07-request-delivery.js)
        delivery: deliveryFor(r.transport),
        /* Set by whoever opened it, never by the request itself: paying over
         * the tap link is only safe when this request is the one that came
         * over that link. A request scanned from a screen must never be paid
         * to whichever phone happens to be connected at the time. */
        viaTap: false,
        deliverable: !!deliveryFor(r.transport),
      };
    },

    /* Take back a token nobody claimed.
     *
     * The proofs in it are still ours until somebody else swaps them, so this
     * is just a receive of our own token. Whoever swaps first wins: if they
     * already took it, the mint refuses and says so.
     *
     * Foxy never locks what it sends, so a locked token is not one of ours.
     */
    reclaimToken: function (text) {
      assertRoute();
      var info = FoxyWallet.tokenInfo(text);
      if (!info) return Promise.reject(new Error('That is not a Cashu token.'));
      var tok = info;           // not null, in the callbacks below as well
      // Foxy only ever sends sats, so a token in another unit is not one of ours
      if (tok.unit !== 'sat') {
        return Promise.reject(new Error('That token holds ' + unitName(tok.unit) +
          ' ecash, which Foxy never sends, so there is nothing to take back. Receive it as a token instead.'));
      }
      if (lockedProofs(tok.proofs).length) return Promise.reject(new Error(LOCKED));

      var here = String(mintUrl || '').replace(/\/+$/, '');
      var from = String(tok.mint || '').replace(/\/+$/, '');
      var ready = (from && from !== here) ? FoxyWallet.connect(from) : Promise.resolve(null);

      var intoMint, intoWallet, guard;
      return ready.then(function () {
        var w = need();
        intoWallet = w;
        intoMint = mintOf(w);
        var decoded = null;
        try { decoded = w.decodeToken(FoxyWallet.unwrap(text)); } catch (e) {}
        var incoming = (decoded && decoded.proofs) || [];
        // asked before any counter is reserved (refuseSpent, W5): a token already taken uses none
        return refuseSpent(w, incoming.length ? incoming : tok.proofs,
          'That token is already spent: whoever you sent it to has taken it, so there is nothing to take back.'
        ).then(function () {
          // its outputs on disk until the answer is in (swapGuard), with what they add up to:
          // the token less the mint's input fee on it, as cashu-ts asks the mint to sign
          // (a sat token, so its amount is its sats)
          guard = swapGuard(w, 'reclaim', { amount: tok.amount,
            expect: incoming.length ? sumProofs(incoming) - swapFeeFor(w, incoming) : undefined });
          return guard.run('receive', function () {
            return w.receive(FoxyWallet.unwrap(text));
          });
        });
      }).then(function (fresh) {
        var got = sumProofs(fresh);
        addProofs(fresh, intoMint, intoWallet);
        guard.done();
        logTx({
          dir: 'in',
          sats: got,
          feeSats: Math.max(0, tok.amount - got),
          settled: true,
          state: 'success',
          memo: 'reclaimed',
          hash: 'reclaim-' + Date.now(),
          mint: intoMint,
        });
        console.log('[foxy] reclaimed', got, 'sats at', hostOf(tok.mint));
        return { sats: got, host: hostOf(tok.mint) };
      });
    },

    /* Has the outstanding token been claimed?
     *
     * Asked only while the token's screen is open (watchToken), on a circuit
     * of its own. Asks the mint whether the proofs inside it are spent. That is the only
     * authority — the token is a bearer instrument, so nothing tells us it
     * moved except the mint refusing to sign for it twice.
     *
     * Resolves 'claimed', 'waiting', or null when there is nothing to watch.
     */
    tokenState: function () {
      var out = load(K.outtok, null);
      if (!out || !out.token) return Promise.resolve(null);
      var info = FoxyWallet.tokenInfo(out.token);
      if (!info || !info.proofs.length) return Promise.resolve(null);
      var w;
      // one circuit for this token's checks, used for nothing else
      try { w = onCircuit(need(), out.hash ? 'token:' + out.hash : null); } catch (e) { return Promise.resolve('waiting'); }
      if (String(out.mint || '').replace(/\/+$/, '') !== String(mintUrl).replace(/\/+$/, '')) {
        // watching would mean asking the wrong mint
        return Promise.resolve('waiting');
      }
      var sent = info.proofs;
      return w.checkProofsStates(sent).then(function (states) {
        var spent = states.filter(function (st) {
          return (st && (st.state || st.State)) === 'SPENT';
        }).length;
        return spent === sent.length ? 'claimed' : 'waiting';
      }).catch(function () { return 'waiting'; });
    },

    /* Flip a logged transaction to settled. */
    settleTx: function (hash) {
      var list = load(K.log, []);
      var hit = false;
      list.forEach(function (e) {
        if (e.hash === hash) { e.settled = true; e.state = 'success'; hit = true; }
      });
      if (hit) save(K.log, list);
      return hit;
    },

    /* The hash of the entry for the outstanding token, if there is one. */
    lastTokenHash: function () {
      var out = load(K.outtok, null);
      return (out && out.hash) || null;
    },

