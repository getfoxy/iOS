    /* ---- the screen lock ---------------------------------------------
     *
     * A PIN in front of the app. The PIN itself is never stored: what is kept
     * is sha256 iterated over a random salt and the digits, so the stored
     * value cannot be turned back into the PIN without trying candidates.
     *
     * Six digits is a million candidates, which an attacker holding this hash
     * can exhaust offline. The iteration count makes that cost real rather
     * than instant; it does not make it impossible. This gates the app, it
     * does not protect the seed — see THREAT-MODEL.md §7.
     */
    PIN_ROUNDS: 120000,

    /* What would this invoice cost, before committing to it?
     *
     * createMeltQuoteBolt11 asks the mint for an amount and a fee reserve and
     * commits to nothing. The confirmation screen needs it: without it the FEE
     * row read UNKNOWN until after the money had gone.
     *
     * The reserve is a ceiling. Whatever routing does not use comes back as
     * change, so the real cost is usually lower and never higher. */
    quoteFee: function (bolt11) {
      assertRoute();
      if (!wallet || !bolt11) return Promise.resolve(null);
      // on the circuit kept ready, when there is one
      var w = viewNow(wallet);
      // asked again on another circuit after five seconds of nothing (`askedTwice`)
      return withTimeout(askedTwice(w, 'the mint\u2019s fee quote', function (via) {
        return via.createMeltQuoteBolt11(String(bolt11));
      }), 20000, 'the mint\u2019s fee quote')
        .then(function (won) {
          var q = won.got;
          return {
            amount: satsOf(q.amount) || 0,
            feeReserve: satsOf(q.fee_reserve) || 0,
          };
        })
        .catch(function (e) {
          console.warn('[foxy] could not quote the fee:', FoxyWallet.reason(e));
          return null;
        });
    },

    /* Resolves once the phone has said it has a seed, and an older install
     * has been moved onto it (nativeReady). Boot calls this after the lock and
     * before any mint work.
     *
     * The phone's seed is asked whether it exists, and made if not, never read.
     * A failure is kept for connect to refuse with, and the next connect asks
     * again: a phone that could not answer is not a wallet with no seed. With no
     * bridge there is nothing to ask. */
    seedReady: function () {
      if (!bridged()) return Promise.resolve(null);
      return nativeReady().then(function () { return null; }, function (e) {
        seedError = (e && e.message) || String(e);
        console.error('[foxy] the phone could not say whether it has a seed:', seedError);
        return null;
      });
    },

    /* For the tests of native secrets (tests/run.js): how many secrets from
     * the phone the page holds, and a restore fetch into that cache. */
    _secretsHeld: function () { return secretCache.size; },
    _fetchSecrets: function (keysetId, start, count, candidate) { return fetchSecrets(keysetId, start, count, candidate || null); },

    /* Called when a mint issues proofs whose DLEQ does not verify. */
    /** @type {?function(*): void} */
    _onMintTrouble: null,
    onMintTrouble: function (fn) { FoxyWallet._onMintTrouble = fn; },

    /* What Foxy has been doing, for the ERRORS and LOGS screens: the native
     * lines and the page's own in one list, oldest first, each
     * { at, text, bad }. Redacted by the phone on the way in (FieldLog.swift)
     * — tokens, invoices, payment requests, onion addresses, nostr keys and
     * long hex are gone before the page can see them, so nothing here can copy
     * out what it never had. `bad` is the short list for ERRORS. */
    fieldLog: function (bad) {
      return bridgeAsk('fieldLog', { bad: !!bad }, 8000).then(function (text) {
        try { return JSON.parse(text) || []; } catch (e) { return []; }
      }, function () { return []; });
    },

    clearFieldLog: function () {
      return bridgeAsk('fieldLogClear', {}, 5000).then(function () { return true; },
                                                      function () { return false; });
    },

    /* The route changed: { tor, progress, everUp, unprotected, ... }.
     *
     * The home screen's banner is drawn from this, and a banner that says
     * the connection is secure must stop saying it the moment it is not —
     * waiting for whatever would have redrawn the screen next is too late
     * for that one. */
    /** @type {?function(*): void} */
    _onPrivacy: null,
    onPrivacy: function (fn) { FoxyWallet._onPrivacy = fn; },

    /* A payment found some of this wallet's ecash already spent and removed
     * it: { sats, mint }. */
    /** @type {?function(*): void} */
    _onSpentElsewhere: null,
    onSpentElsewhere: function (fn) { FoxyWallet._onSpentElsewhere = fn; },

    /* Both phones are offline and a payment has arrived that this phone cannot
     * settle: { sats, id, purpose, memo }. The handler returns a promise of true
     * to take it on trust or false to reject it, and the person is the one who
     * answers. No handler means no, which is what Foxy did before the card
     * existed — money is never taken on a question nobody was asked.
     *
     * It is asked over Bluetooth only, and only for the exact amount asked for:
     * both are settled before this is called (offlineOffer). */
    /** @type {?function(*): (boolean|Promise<boolean>)} */
    _onOfflineOffer: null,
    onOfflineOffer: function (fn) { FoxyWallet._onOfflineOffer = fn; },

    /* Change that was made and could not be handed over, said to the screen
     * the moment it happens (07-request-delivery.js, `changeBack`). */
    /* Sats held back at this mint for swaps whose answer was lost, until the
     * mint says whether it made them (04-lost-answers.js, holdInputs). Not in
     * the balance, and the history screen's audit says so. */
    heldSats: function () {
      var here = wallet ? mintOf(wallet) : '';
      var all = load(K.held, {});
      var sum = 0;
      Object.keys(all).forEach(function (id) {
        var h = all[id];
        if (!h || (h.unit && h.unit !== 'sat') || canonicalMint(h.mint) !== here) return;
        sum += sumProofs(h.proofs || []);
      });
      return sum;
    },
    /* Sats on their way back from a swap the mint answered after Foxy was
     * put away: the piece was checked unspent and left in the pile as the Tor
     * window closed (`topUpClosing`), the mint took it after all, and the
     * swap's record is still here for the next connection to collect its
     * outputs with. Out of the pile, not held, and nothing on screen said
     * where it was. Named here so the audit and the home screen can. */
    /// Input fees this mint's top-up swaps have cost, which no history row shows (tidyChange).
    topUpFeeSats: function () {
      var here = wallet ? mintOf(wallet) : '';
      var fees = load(K.topUpFees, {});
      return Math.max(0, Math.round(Number(fees[here]) || 0));
    },

    recoveringSats: function () {
      var here = wallet ? mintOf(wallet) : '';
      var pile = {};
      proofs(here).forEach(function (p) { if (p && p.secret) pile[p.secret] = true; });
      var held = {};
      try {
        var all = load(K.held, {});
        Object.keys(all).forEach(function (id) {
          ((all[id] && all[id].proofs) || []).forEach(function (p) { if (p && p.secret) held[p.secret] = true; });
        });
      } catch (e) {}
      var sum = 0;
      loadSwaps().forEach(function (r) {
        if (!r || !r.freeInputs || canonicalMint(r.mint) !== here || (r.unit && r.unit !== 'sat')) return;
        (r.inputs || []).forEach(function (p) {
          if (p && p.secret && !pile[p.secret] && !held[p.secret]) sum += satsOf(p.amount) || 0;
        });
      });
      return sum;
    },
    onChangeStuck: function (fn) { FoxyWallet._onChangeStuck = fn; },
    /** @type {?function(any): void} */
    _onChangeStuck: null,
    /* Change about to be made for a scanned payment, said before the swap so
     * the payment's confirmation can wait for the card (19-bill-split.js). */
    onChangeMaking: function (fn) { FoxyWallet._onChangeMaking = fn; },
    /** @type {?function(any): void} */
    _onChangeMaking: null,

    /* Whether a payment between two offline phones is offered at all.
     *
     * Off as it ships: the card and everything behind it
     * work, and what is unsettled is what a payer should be able to do after
     * handing money over on trust. The suites drive both sides through here, so
     * the day it comes back it comes back tested. */
    _offlineToOffline: function (on) { return offlineToOffline(on); },

    /* A payment taken on trust while both phones were offline turned out to have
     * been spent by the payer: { sats, id }. The money was shown and counted and
     * is now gone, so this is news, not bookkeeping. */
    /** @type {?function(*): void} */
    _onTrustLost: null,
    /** @type {?function(any): void} */
    _onTrustSettled: null,
    onTrustSettled: function (fn) { FoxyWallet._onTrustSettled = fn; },
    /** @type {?function(any): void} */
    _onLateClaim: null,
    onLateClaim: function (fn) { FoxyWallet._onLateClaim = fn; },
    // a locked payment Foxy was killed in the middle of, rebuilt on reopening: { sats, change }
    /** @type {?function(any): void} */
    _onSendRebuilt: null,
    /* What became of a payment being brought home (`carryHome`'s states),
     * when it is the wallet that found out: on a launch, or a claim made
     * late. */
    /** @type {?function(any): void} */
    _onCarry: null,
    onCarry: function (fn) { FoxyWallet._onCarry = fn; },
    /** @type {?function(any): void} */
    _onMoveFinished: null,
    onMoveFinished: function (fn) { FoxyWallet._onMoveFinished = fn; },
    /** @type {?function(any): void} */
    _onTakenBack: null,
    onTakenBack: function (fn) { FoxyWallet._onTakenBack = fn; },
    /* What became of ecash at risk once there was a route: { state, hash,
     * sats } with state 'safe' (swapped for fresh pieces), 'taken' (the
     * other phone redeemed it after refusing) or 'refunded' (it came back). */
    /** @type {?function(any): void} */
    _onAtRisk: null,
    onAtRisk: function (fn) { FoxyWallet._onAtRisk = fn; },
    onSendRebuilt: function (fn) { FoxyWallet._onSendRebuilt = fn; },
    // connected, and everything that was waiting for a route has been dealt with
    /** @type {?function(): void} */
    _onCaughtUp: null,
    /* Set by the app. `_putAway(true)` is the phone saying Foxy has left the
     * screen; `_tidying` is true while a small-change top-up is waiting or
     * with the mint, and the phone keeps Tor on the network while it is. */
    /** @type {((on: boolean) => void) | null} */
    _putAway: null,
    _tidying: false,
    /** @type {any} */
    _topUp: null,
    /** @param {function(): void} fn */
    onCaughtUp: function (fn) { FoxyWallet._onCaughtUp = fn; },
    onTrustLost: function (fn) { FoxyWallet._onTrustLost = fn; },

    /* A paid invoice whose claim failed: { quote, amount, mint, unclaimed }. */
    /** @type {?function(*): void} */
    _onClaimTrouble: null,
    onClaimTrouble: function (fn) { FoxyWallet._onClaimTrouble = fn; },

    /* Invoices paid at the mint but not collected, with why. */
    stuckInvoices: function () {
      return load(K.quotes, []).concat(load(K.quotesOld, [])).filter(function (q) {
        return q && q.unclaimed;
      }).map(function (q) {
        return { quote: q.quote, amount: q.amount, mint: q.mint, unclaimed: q.unclaimed };
      });
    },
    /* What stands in front of the seed (the SECURE FOXY card, 10-pin.js).
     *
     * 'device' is the seed behind Face ID or the phone's passcode, which is
     * what every Foxy did before there was a choice. 'none' moves it to the
     * older keychain item, where the phone's own lock screen is the only thing
     * in front of it. The phone does the moving and never leaves itself
     * without a seed on the way (SeedVault.setProtection). */
    seedProtection: function () {
      return nativeJson('seedProtection', {}).then(function (j) {
        return { mode: j.mode === 'none' ? 'none' : 'device', passcode: j.passcode !== false };
      }, function () { return { mode: 'device', passcode: true }; });
    },

    setSeedProtection: function (mode) {
      var want = mode === 'none' ? 'none' : 'device';
      return nativeJson('seedProtect', { mode: want }, PERSON_MS).then(function (j) {
        if (j.mode !== want) throw new Error('the phone did not change how the seed is kept');
        /* Taking Face ID off reads the seed on the way, and putting it on
         * rewrites it: either way what the page holds is stale. */
        clearNativeSecrets(false, false);
        return want;
      });
    },

    /* Forget this wallet's seed.
     *
     * The phone has no delete that leaves it without a seed. Its seedWipe
     * (after its own Delete alert) erases the seed, sets its counters aside and
     * makes a new one; that is what forgetting is. Storage here is left alone,
     * as forgetting always left it. Resolves 'replaced'. Rejects when the phone
     * does not erase it — a No in its alert, a cancelled Face ID, no answer —
     * and then nothing is forgotten (audit W7). Nothing calls it
     * today. */
    seedForget: function () {
      return nativeJson('seedWipe', {}, PERSON_MS).then(function (j) {
        if (j.wiped !== true) throw new Error('the phone did not say it erased the seed');
        clearNativeSecrets(true, true);
        nativeSeedKnown = j.created === true;
        seedReplaced = null;
        return 'replaced';
      }, function (e) {
        throw new Error('The seed was not removed from this phone (' + e.message + '). Nothing was forgotten.');
      });
    },

    /* What cashu-ts hands a customRequest, over the bridge and back.
     *
     * It receives { endpoint, method, requestBody, headers } and must return
     * the parsed response or throw. The mint's own refusals are carried
     * through with their status and body, because claimFailed() reads them to
     * tell "already spent" from "P2PK locked" from a network failure.
     */
    /* Open the road to the mint before it is needed.
     *
     * An invoice is one request, and most of its two to three seconds is not
     * the mint thinking: it is a circuit being built and a connection made on
     * it. The amount is not known until NEXT, so the invoice itself cannot be
     * asked for early, but the road can be opened while the amount is typed.
     *
     * This asked the mint for its keysets on no circuit in particular, from
     * when every request to a mint shared one. Each job has had a circuit of
     * its own since, so the invoice left on a new one and what had been
     * warmed was a road it did not take. It is the circuit kept ready that is
     * opened now, and the invoice takes that one (`warmSpare`, `needNow`). */
    warmMint: function () { return warmSpare(); },
    /* For the tests: whether a circuit is ready, and its label. */
    _spare: function () { return spareReady() ? /** @type {{ label: string }} */ (spare).label : ''; },

    nativeRequest: function (opts) {
      var o = opts || {};
      /* What this mint says about itself, if it said it a moment ago
       * (cachedKeyBody). GETs of info, keysets and keys only — a POST is never
       * answered from here, so nothing that moves money is.
       *
       * Answers are remembered per circuit as well as per url, so a question
       * asked on a fresh circuit is never answered by what another circuit
       * said — see cacheableKeyUrl. `foxyFresh` says the same thing outright
       * and stays, for a caller that wants no doubt about it:
       * checkKeysetsElsewhere asks a mint for its keysets again on a new
       * circuit, to see whether the keys it handed this wallet are keys it
       * shows anybody else — a keyset shown to one wallet alone marks
       * everything signed with it. Answered from the cache that check would
       * compare an answer with itself and never see a thing. */
      var keyUrl = o.foxyFresh ? '' : cacheableKeyUrl(o.method, o.endpoint, o.foxyCircuit);
      if (keyUrl) {
        var had = cachedKeyBody(keyUrl);
        if (had !== null) {
          try { return Promise.resolve(had ? parseBody(had) : null); }
          catch (e) { forgetMintKeys(keyUrl); }
        }
        // the same question already on its way is shared rather than asked twice
        var going = keyRequestInFlight(keyUrl);
        if (going) return going;
      }
      /* `circuit`: the job's Tor circuit (onCircuit); none, and the phone
       * gives the request one of its own. */
      var busyOnce = false;
      var ask = function (circuit) { return bridgeAsk('mintRequest', {
        url: String(o.endpoint || ''),
        method: String(o.method || 'GET'),
        headers: o.headers || null,
        circuit: circuit,
        /* cashu-ts's serialiser, not JSON's.
         *
         * Amounts are Amount value objects backed by BigInt, and
         * JSON.stringify throws on a BigInt. So every GET worked — info,
         * keysets, keys — and every POST failed silently inside a promise
         * nobody was awaiting: mint quote, swap, melt. Which is invoice
         * generation, token generation and sending.
         *
         * JSONInt is exported for exactly this. */
        body: o.requestBody ? serialiseBody(o.requestBody) : '',
      }, 65000); };
      var run = ask(o.foxyCircuit ? String(o.foxyCircuit) : '').then(function answered(text) {
        var s = String(text || '');
        var nl = s.indexOf('\n');
        var code = Number(s.slice(0, nl)) || 0;
        var raw = s.slice(nl + 1);
        /* Too many requests (429). A mint counts them by where they come
         * from, and through Tor that is an exit shared with strangers:
         * forge.flashapp.me turned away nineteen requests in twenty-one from
         * one exit, with an nginx page or `Rate limit exceeded.`, and the same
         * exit was still refused two seconds later (mint survey).
         * A refusal at the door did nothing, so the request is asked once
         * more — on a circuit of its own, which is another exit. */
        if (code === 429) noteMintBusy(String(o.endpoint || ''));
        if (code === 429 && !busyOnce) {
          busyOnce = true;
          console.log('[foxy] ' + hostOf(String(o.endpoint || '')).split('/')[0] + ' is turning requests away (429); asking once more on another circuit');
          return new Promise(function (go) { setTimeout(go, 1500); }).then(function () { return ask(''); }).then(answered);
        }
        /* Parsed the same way, or large amounts lose precision silently. */
        var parsed = null;
        try { parsed = raw ? parseBody(raw) : null; } catch (e) {}
        // any answer is a mint that is there; 502-504 is a proxy saying it is
        // not. Counted in 98-mint-health.js.
        noteMintAnswer(o.endpoint, classifyAnswer(code, null));
        if (code >= 200 && code < 300) {
          // keys this phone will not use are refused before they are cached
          var badKey = mintKeysProblem(parsed);
          if (badKey) { console.warn('[foxy]', badKey); throw new Error(badKey); }
          // a mint's own description of itself, for the next wallet to ask
          if (keyUrl) rememberKeyBody(keyUrl, raw);
          return parsed;
        }
        /* The errors cashu-ts throws itself, not a plain Error.
         *
         * cashu-ts decides by the mint's error code — and by recognising its
         * own MintOperationError. A plain Error carried neither, so everything
         * that reads the code went blind over the bridge. The costliest: a mint
         * on Nutshell 0.18 refuses a signed quote's amended NUT-20 signature
         * with 20008, and cashu-ts retries with the legacy one only on that
         * code — so every signed invoice at such a mint (testnut)
         * failed "Signature for mint request invalid" and was never claimed.
         * Shaped as cashu-ts's own request does: a 400 with a numeric code and
         * a detail is a MintOperationError, anything else an HttpResponseError.
         * status and body still ride along for claimFailed(). */
        var CT = window.CashuTS || {};
        var detail = parsed && typeof parsed.detail === 'string' ? parsed.detail : null;
        var message = detail || (parsed && typeof parsed.error === 'string' && parsed.error)
          || ('The mint answered ' + code + '.');
        // said as what it is: nothing was done, and a minute usually clears it
        if (code === 429) {
          message = hostOf(String(o.endpoint || '')).split('/')[0] + ' is turning requests away for now: too many have reached it this way. '
            + 'Nothing was done. Try again in a minute.';
        }
        var err;
        if (code === 400 && parsed && typeof parsed.code === 'number' && detail !== null
            && typeof CT.MintOperationError === 'function') {
          err = new CT.MintOperationError(parsed.code, detail);
        } else if (typeof CT.HttpResponseError === 'function') {
          err = new CT.HttpResponseError(message, code);
        } else {
          err = new Error(message);
        }
        if (parsed && typeof parsed.code === 'number' && err.code === undefined) err.code = parsed.code;
        err.status = code;
        err.body = parsed;
        throw err;
      }, function (e) {
        // no answer at all — or refused on this side, which classifyAnswer leaves out
        noteMintAnswer(o.endpoint, classifyAnswer(0, e));
        throw e;
      });
      if (keyUrl) noteKeyRequest(keyUrl, run);
      return run;
    },

    pinIsSet: function () { return !!load('foxy.pin.v1', null); },

    /* ---- what guards the SEED, and what guards the SCREEN ----------------
     *
     * Three settings overlap here and two of them were both called Face ID.
     * They answer different questions:
     *
     *   secureChoice()      the SEED. 'device' keeps it behind .userPresence
     *                       in the keychain, so a face is asked when money is
     *                       SPENT and when the twelve words are shown. 'none'
     *                       moves it to the older keychain item, where the
     *                       phone's own lock screen is the only thing in front
     *                       of it. '' is nobody having been asked yet, which
     *                       Foxy reads as 'device' — guarded until someone
     *                       says otherwise.
     *
     *   faceLock()          the SCREEN, by a face. The same stored answer read
     *                       for a second question, because somebody who wants
     *                       a face in front of their money wants one in front
     *                       of the balance and the history too.
     *
     *   faceInsteadOfPin()  the SCREEN when a PIN is already on it: may a face
     *                       be shown instead of the digits being typed. A
     *                       separate answer on purpose — see below.
     *
     * Neither of the Face ID settings used to lock the screen at
     * all. `pinLock()` opened with `if (!W.pinIsSet()) return`, so Face ID on
     * with no PIN was no lock: kill Foxy, open it again, and the balance, the
     * history and the mint were simply there.
     *
     * A face is now a lock in its own right — for somebody who asked for one.
     *
     * ASKED FOR. This read `!== 'none'`, and nobody-has-chosen is '', so a
     * wallet nobody had configured locked its screen behind a face by default:
     * Face ID on opening, Face ID on returning, Face ID at moments the person
     * had never agreed to guard. A lock the person did not choose is not security,
     * it is an obstacle with their money behind it.
     *
     * So the screen is locked by a face only where the answer is `device` —
     * chosen, in the menu. This says nothing about the SEED: `secureChoice`
     * still reads '' as guarded, so spending and showing the words ask the
     * phone exactly as they did. What changes is the balance and the history,
     * which is what a screen lock is about. */
    faceLock: function () { return FoxyWallet.secureChoice() === 'device'; },

    /* Is anything at all in front of the wallet: a PIN, or a face, or both? */
    screenLocked: function () { return FoxyWallet.pinIsSet() || FoxyWallet.faceLock(); },

    /* Face ID or Touch ID. Resolves 'yes', 'no' or 'unavailable'.
     *
     * `passcode` lets the phone's own passcode stand in for a face, and only
     * the screen lock asks for it: when Face ID is the only thing set there is
     * nothing behind it, so a face that will not scan would otherwise mean the
     * money cannot be reached at all. See handleBiometric. */
    biometric: function (reason, passcode) {
      var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
      if (!mh) return Promise.resolve('unavailable');
      return new Promise(function (ok) {
        var id = 'b' + Date.now() + Math.random().toString(36).slice(2, 7);
        var settled = false;
        FoxyWallet._scans[id] = {
          ok: function (t) { if (!settled) { settled = true; ok(String(t)); } },
          no: function () { if (!settled) { settled = true; ok('no'); } }
        };
        mh.postMessage({ action: 'biometric', id: id, reason: String(reason || 'Unlock Foxy'),
                         passcode: !!passcode });
        setTimeout(function () {
          if (!settled) { settled = true; delete FoxyWallet._scans[id]; ok('no'); }
        }, 60000);
      });
    },

    /* Which network a receive opens on.
     *
     * The NETWORK sheet answered one question — which network this screen is
     * on — and every receive still began on Lightning whatever the person
     * picked last time. The default was real but invisible and unchangeable. LIGHTNING unless they have said otherwise. */
    defaultRail: function (rail) {
      if (rail === undefined) {
        var saved = load('foxy.rail.default', 'LIGHTNING');
        return (saved === 'CASHU' || saved === 'ON-CHAIN') ? saved : 'LIGHTNING';
      }
      save('foxy.rail.default', (rail === 'CASHU' || rail === 'ON-CHAIN') ? rail : 'LIGHTNING');
      return FoxyWallet.defaultRail();
    },

    /* What they answered on the SECURE FOXY card, and what MENU changes
     * later: 'device', 'none', or '' when they have not been asked yet.
     *
     * This is the SEED's guard. It is the page's copy of where the phone
     * actually keeps the seed (seedProtection), kept here because the page
     * needs it on every wake and asking the phone means asking the keychain —
     * the two are written together in chooseProtection, and the phone's answer
     * is the one that decides. faceLock() reads this same answer for the
     * screen. */
    secureChoice: function (mode) {
      if (mode === undefined) {
        var saved = load('foxy.secure.choice', '');
        return (saved === 'device' || saved === 'none') ? saved : '';
      }
      save('foxy.secure.choice', (mode === 'device' || mode === 'none') ? mode : '');
      return FoxyWallet.secureChoice();
    },

    /* May a face be shown instead of the PIN being typed?
     *
     * Read only when a PIN exists: with no PIN there is nothing for a face to
     * stand in for, and faceLock() governs the screen on its own. Answered
     * when a PIN is set (pinConfirmWarning), and answered again every time a
     * PIN is set, so MENU > REMOVE PIN then MENU > SET PIN is the way to
     * change the answer. Off unless they said yes.
     *
     * It looks redundant beside faceLock() now that a face locks the screen by
     * itself, and it is not. secureChoice is about the SEED: 'device' means a
     * face can already spend the money and show the twelve words. This is
     * about the PIN in particular, and the two answers may honestly differ —
     * somebody sets a PIN precisely because a face is the one key an attacker
     * holding the phone can obtain, and they still want those digits typed
     * whatever guards the keychain. Governing the lock screen by faceLock()
     * instead would let a face open a screen that today only the PIN opens, on
     * every install that answered no here. That is a weaker lock, so this
     * setting stays.
     *
     * The stored key is still 'foxy.pin.bio' on purpose. The name is poor and
     * renaming it would buy a tidier string in exchange for migrating every
     * install that has already answered — and getting that migration wrong in
     * the safe-looking direction (absent reads as false) silently drops a
     * setting people rely on to get in. Not worth it. */
    faceInsteadOfPin: function (on) {
      if (on === undefined) return !!load('foxy.pin.bio', false);
      save('foxy.pin.bio', !!on);
      return !!on;
    },

    /* Wrong PINs, counted across launches.
     *
     * The count used to live in the app's memory, so closing Foxy and opening
     * it again gave five fresh tries — and each guess only delayed its own
     * check, so a burst of guesses was all checked anyway. Now the count and
     * the time of the last miss are stored, and while the wait runs a PIN is
     * not checked at all, however many are typed. Five free tries, then 1s,
     * 2s, 4s… up to an hour. A clock moved backwards restarts the wait. */
    PIN_FREE_TRIES: 5,
    PIN_MAX_WAIT_MS: 3600000,

    _pinWait: function (n) {
      return n < FoxyWallet.PIN_FREE_TRIES ? 0
        : Math.min(FoxyWallet.PIN_MAX_WAIT_MS, 1000 * Math.pow(2, n - FoxyWallet.PIN_FREE_TRIES));
    },

    /* { ok } on the right PIN; { ok: false, waitMs, locked } while waiting —
     * the PIN was not checked; { ok: false, waitMs, tries } after a miss. */
    pinAttempt: function (pin) {
      var rec = load('foxy.pin.tries', null) || { n: 0, at: 0 };
      var n = Number(rec.n) || 0, at = Number(rec.at) || 0, now = Date.now();
      var u = window.__foxyUptime;
      var up = (u && typeof u.s === 'number' && typeof u.p === 'number')
        ? u.s + (performance.now() - u.p) / 1000 : null;
      var wait = FoxyWallet._pinWait(n);
      /* Time waited: by the clock and by the phone's uptime, whichever is less.
       * The clock alone could be moved forward in Settings past every wait.
       * Uptime starts again when the phone restarts, and then the clock is
       * all there is. A clock moved back never shortens a wait. */
      var waited = now < at ? 0 : now - at;
      if (up !== null && typeof rec.up === 'number' && up >= rec.up) {
        waited = Math.min(waited, (up - rec.up) * 1000);
      }
      var left = wait - waited;
      if (wait > 0 && left > 0) return { ok: false, waitMs: left, locked: true };
      if (FoxyWallet.pinCheck(pin)) {
        FoxyWallet.pinTriesClear();
        return { ok: true, waitMs: 0 };
      }
      n += 1;
      save('foxy.pin.tries', { n: n, at: now, up: up });
      return { ok: false, waitMs: FoxyWallet._pinWait(n), tries: n };
    },

    /* Face ID, or a new PIN, is the owner: the count starts again. */
    pinTriesClear: function () {
      try { localStorage.removeItem('foxy.pin.tries'); } catch (e) {}
    },

    pinSet: function (pin) {
      var digits = String(pin || '').replace(/\D/g, '');
      if (digits.length < 4) throw new Error('A PIN needs at least four digits.');
      var salt = new Uint8Array(16);
      (window.crypto || window.msCrypto).getRandomValues(salt);
      var saltHex = Array.prototype.map.call(salt, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
      save('foxy.pin.v1', {
        salt: saltHex,
        rounds: FoxyWallet.PIN_ROUNDS,
        hash: pinHash(digits, saltHex, FoxyWallet.PIN_ROUNDS),
      });
      FoxyWallet.pinTriesClear();
      return true;
    },

    pinCheck: function (pin) {
      var rec = load('foxy.pin.v1', null);
      if (!rec) return true;                       // no PIN set: nothing to check
      var digits = String(pin || '').replace(/\D/g, '');
      var got = pinHash(digits, rec.salt, rec.rounds || FoxyWallet.PIN_ROUNDS);
      // constant-time-ish: compare every character rather than bailing early
      if (got.length !== String(rec.hash).length) return false;
      var diff = 0;
      for (var i = 0; i < got.length; i++) {
        diff |= got.charCodeAt(i) ^ String(rec.hash).charCodeAt(i);
      }
      return diff === 0;
    },

    pinClear: function () {
      try { localStorage.removeItem('foxy.pin.v1'); } catch (e) {}
      FoxyWallet.pinTriesClear();
      return true;
    },

    /* Ask the native side a question with a one-word answer. */
    _ask: function (action) {
      var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
      if (!mh) return Promise.reject(new Error('no bridge'));
      return new Promise(function (ok, no) {
        var id = 'q' + Date.now() + Math.random().toString(36).slice(2, 7);
        var settled = false;
        FoxyWallet._scans[id] = {
          ok: function (t) { if (!settled) { settled = true; ok(String(t)); } },
          no: function (e) { if (!settled) { settled = true; no(new Error(e)); } }
        };
        mh.postMessage({ action: action, id: id });
        setTimeout(function () {
          if (!settled) { settled = true; delete FoxyWallet._scans[id]; no(new Error('timed out')); }
        }, 4000);
      });
    },

    clipboard: function () {
      return new Promise(function (ok) {
        var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
        if (!mh) { ok(''); return; }
        var id = 'c' + Date.now() + Math.random().toString(36).slice(2, 7);
        var settled = false;
        var done = function (text) {
          if (settled) return;
          settled = true;
          delete FoxyWallet._scans[id];
          ok(text || '');
        };
        FoxyWallet._scans[id] = { ok: done, no: function () { done(''); } };
        mh.postMessage({ action: 'clipboard', id: id });
        /* The one bridge call that had no deadline. Every other one arms a
         * timer that settles the promise and forgets the id — an answer that
         * never comes left this promise pending for the life of the page, and
         * the paste waiting on it with it. */
        setTimeout(function () { done(''); }, 4000);
      });
    },

    /* Foxy's own page in the Settings app, for a permission refused once
     * that iOS will not ask about again (Bluetooth, the camera). Nothing else
     * can be opened: the native side opens the one URL iOS provides for this. */
    openSettings: function () {
      return bridgeAsk('openSettings', {}, 5000).catch(function () {});
    },

    /* One of the GET DOLLARS screen's companies, by name, in the phone's
     * browser. The addresses live on the native side; this can only pick. */
    openCompany: function (which) {
      return bridgeAsk('openCompany', { which: String(which || '') }, 5000).catch(function () {});
    },

    share: function (text) {
      var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
      if (!mh) return false;
      mh.postMessage({ action: 'share', id: 's' + Date.now(), text: String(text || '') });
      return true;
    },

