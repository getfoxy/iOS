    /* ---- the Cashu ID (08e-cashu-id.js, docs/CASHU-ID.md) -------------
     *
     * For the screens. MY CASHU ID shows `cashuIdMine` (its `text` is what the
     * QR holds); a pasted or scanned ID is read by `cashuIdCheck` and kept as
     * a contact by `cashuIdAdd`; `cashuIdPay` pays one; the phone hands what
     * arrives to `_cashuIdArrived`, and this seed's own copies, after a restore,
     * to `_cashuIdCopy`. What arrives at a mint this phone does not use waits for
     * its receiver in `cashuIdWaiting` (raised by `_onCashuIdOffer`), and is
     * answered by `cashuIdDecide`; a remembered answer (`cashuIdChoices`) runs
     * by itself. */

    /* A one-time request (no screen shows it now: MY CASHU ID has no ANY WALLET
     * button): a standard NUT-18 request any Cashu wallet pays, `opts.unit` 'sat' or
     * 'usd', no amount, this phone's mints that honour a lock (the default first), locked to a fresh key of the seed's
     * lock pool, delivered over Nostr to the ID's delivery key. Resolves { text (creqA…), id, pub, unit, mints, target };
     * rejects with the sentence to show. Each call takes a new key. */
    cashuIdAnyRequest: function (opts) { return cidAnyRequest(opts || {}); },

    /* PAID TO YOUR ID KEY answered: `take` true (TAKE IT ANYWAY) has the ID key sign for that delivery alone and takes
     * it; false (LEAVE IT) drops it. Resolves { state, why }; never rejects. `_onCashuIdUnblinded(view)` raises the card:
     * { key, name, mint, host, unit, amount, at, refund }. */
    cashuIdUnblinded: function (key, take) { return cidBareDecide(String(key || ''), !!take); },

    /* This phone's own ID: { text, id, nostr, sig }, from the seed's keys. */
    cashuIdMine: function () { return cidMine(); },

    /* MY CASHU ID was shown: from now on the phone listens for payments to it
     * (`cidListenNow`), at once and after every connect, and names itself to
     * the contacts it pays. */
    cashuIdShown: function () {
      cidMarkInUse();
      return cidListenNow();
    },

    /* Whether `text` is shaped like an ID string (a bad checksum still is). */
    cashuIdLooks: function (text) { return cidShape(text); },

    /* An ID string read: { id, nostr }, or null. `cashuIdProblem` says why
     * not in a sentence, '' for a good one. Never throws. */
    cashuIdDecode: function (text) { var r = cidRead(text); return r.id ? { id: r.id, nostr: r.nostr } : null; },
    cashuIdProblem: function (text) { var r = cidRead(text); return r.id ? '' : String(r.why || 'That is not a Cashu ID.'); },

    /* An ID string before it is kept: { id, nostr, text, own, name } (`name`
     * the contact's where this ID is one already). Rejects with the sentence for
     * one that is not an ID, a version 1 string among them. */
    cashuIdCheck: function (text) {
      var r = cidRead(text);
      if (!r.id) return Promise.reject(new Error(String(r.why || 'That is not a Cashu ID.')));
      return cidMine().then(function (mine) { return mine; }, function () { return null; }).then(function (mine) {
        var known = cidContactOf(r.id);
        return { id: r.id, nostr: r.nostr, text: cidEncode(r.id, r.nostr, r.sig),
                 own: !!(mine && mine.id === r.id), name: known ? known.name : '' };
      });
    },

    /* Kept as a contact under `name`: { handle, name, at, cid }. An ID that is a
     * contact already is renamed, not written twice; its address is the one the
     * ID itself signed. This phone's own is refused. */
    cashuIdAdd: function (text, name) {
      var r = cidRead(text);
      if (!r.id) return Promise.reject(new Error(String(r.why || 'That is not a Cashu ID.')));
      return cidMine().then(function (mine) {
        if (mine.id === r.id) throw new Error('That is your own Cashu ID.');
        return cidKeep(r, name);
      });
    },

    /* The contacts that are Cashu IDs, newest first. */
    cashuIdContacts: function () { return cidContactsNow(); },

    /* Pay a contact: `who` its ID string or ID key, `amount` in sats or, with
     * `opts.unit` 'usd', in cents; `opts.note` a few words they see. Resolves
     * { hash, token, sent, name, lockUntil, row } (see `cidPay`). */
    cashuIdPay: function (who, amount, opts) { return cidPay(who, amount, opts); },

    /* How long a payment waits for its contact before it comes back, in seconds. */
    cashuIdLockSeconds: function () { return CID_TESTS && Number(FoxyWallet._cashuIdLockS) > 0 ? Number(FoxyWallet._cashuIdLockS) : CID_LOCK_S; },

    /* Listen for payments to this phone's ID (once it is in use), and take what
     * was kept. Resolves 1 when a relay is listening, else 0. `cashuIdHush` stops. */
    cashuIdListen: function () { return cidListenNow(); },
    cashuIdHush: function () {
      cidListenGone();
      return bridgeAsk('cashuIdInboxClose', {}, 5000).then(function () { return true; }, function () { return false; });
    },

    /* One delivery, from the phone: 'taken', 'kept', 'waiting' (at another mint: for its receiver to decide, or too small
     * to bring home yet), 'away' (taken at another mint, its walk home left to `carryResume`), 'there' (kept at another
     * mint, now one this phone uses), 'back' (paid back to its payer), 'seen', 'held' (read before the mint was connected
     * for real, taken once it is) or 'refused'; never rejects. One every check on this phone has passed is said to the app
     * as arriving (`_onCashuIdArriving({ unit, amount, name, mint })`) before the mint swaps it, and as paid once it has. */
    _cashuIdArrived: function (body) {
      // read before the mint was connected for real: held until it is ('held', `cidHoldEarly`)
      if (cidHoldEarly(body)) return Promise.resolve('held');
      return cidArrived(body).then(null, function (e) {
        console.warn('[foxy] cashu id: a delivery could not be read:', (e && e.message) || e);
        return 'refused';
      });
    },

    /* This seed's own copy of a payment it made, read back after a restore:
     * 'rebuilt', 'seen', 'collected' or 'refused'; never rejects. */
    _cashuIdCopy: function (body) { return cidCopyArrived(body); },

    /* The ANY WALLET requests (ids, comma-separated) whose REQs every relay asked has answered to their end, or
     * failed, from the bridge (FoxyBridge+CashuID.swift): marked asked today, so the next is due by their schedule
     * (`cidAnyDue`). */
    _cashuIdAnyHeard: function (ids) {
      var list = String(ids || '').split(',').filter(function (x) { return /^[0-9a-f]{8}$/.test(x); });
      cidAnyAsked(list, cidDay());
      return list.length;
    },

    /* Payments at mints this phone does not use waiting for their receiver, newest last: { key, name, mint, host, unit,
     * amount, at, drop, back, lands, toUnit, fee, why, small, others, total, choice } (`cidOfferView`), `name` a contact's
     * only where the payer proved it, `back` whether SEND IT BACK can be offered, `lands`/`toUnit`/`fee` the way home as
     * quoted and `why` why BRING IT HOME cannot be done now. HISTORY lists them and the card asks; one not answered goes
     * back to its payer after `drop`. */
    cashuIdWaiting: function () { return cidOfferRows().map(cidOfferView); },

    /* The card's answer for waiting delivery `key`: 'home' (BRING IT HOME), 'keep' (KEEP IT THERE) or 'back' (SEND IT
     * BACK), remembered for its mint with `always`. Resolves { state, why, view } (`cidDecide`); never rejects. */
    cashuIdDecide: function (key, choice, always) { return cidDecide(String(key || ''), String(choice || ''), !!always); },

    /* The answers remembered by the card's tick, by host: [{ host, choice }]. `cashuIdChoiceClear(host)` forgets one, and
     * with no host every one: the next payment at that mint asks again. */
    cashuIdChoices: function () { return cidChoiceList(); },
    cashuIdChoiceClear: function (host) { cidChoiceClear(host); return cidChoiceList(); },

    /* Money this phone holds at a mint it does not use, brought home to its default mint as one payment (08e-cashu-id.js
     * `cidCarry`): { mint, unit, amount, toUnit?, name?, hash?, before? }. Dollars land as dollars at a default mint that
     * issues them and as sats at one that does not; sats as sats. It goes by the carry-home job, so a crossing that dies
     * after its melt is finished on the next launch, connection or return. Resolves 'taken' once home, 'away' while it
     * is still that mint's, 'refused' for nothing to bring. What a Cashu ID payment's BRING IT HOME does, for any other
     * arrival at another mint to use. */
    bringHome: function (delivery) { return cidCarry(delivery || {}); },

    /* What bringing `amount` (in `unit`) home from `mint` would land, before anything is taken: { lands, toUnit, fee,
     * why } (`cidHomeQuote`; `fee` in `unit`, `lands` 0 with `why` where the fee would take it all). `pieces`: how many
     * pieces it comes in (the swap that takes them in is part of the cost). */
    bringHomeQuote: function (mint, unit, amount, pieces) {
      var from = canonicalMint(String(mint || '')), u = unitOf(unit) || 'sat';
      var home = canonicalMint(String(load(K.mint, '') || mintUrl || ''));
      if (!from || !home || from === home) return Promise.reject(new Error('That money is at this phone’s own mint.'));
      return tillMintLoad(from, false).then(function () {
        return cidHomeQuote(from, home, u, Math.round(Number(amount) || 0), Math.max(1, Math.round(Number(pieces) || 1)), tillKeysAt(from, u));
      });
    },

    /* Send what is due, and look at what is out: { collected, back }. And the
     * copies whose moment has come. */
    cashuIdDeliver: function () { return cidDeliverAll(); },
    cashuIdCopies: function () { return cidCopyAll(); },
    cashuIdWatch: function () { return cidWatchAll(); },

    /* What was sent to contacts, newest last, without the tokens. */
    cashuIdOutbox: function () {
      return cidOutboxRows().map(function (r) {
        return { id: r.id, name: r.name, contact: r.contact, mint: r.mint, unit: r.unit, amount: r.amount, hash: r.hash,
                 at: r.at, lockUntil: r.lockUntil, sentAt: r.sentAt || null, tries: Number(r.tries) || 0, state: r.state,
                 copyAt: Number(r.copyAt) || null, copiedAt: Number(r.copiedAt) || null, restored: !!r.restored };
      });
    },

    /* For the suites only (`CID_TESTS`, read as the wallet loads): the blinding
     * with a fixed throwaway key, a piece's key from a base, the ID string, the
     * nprofile, and the waits (s, ms). A page in the app answers null and reads
     * neither wait. */
    _cashuIdBlind: function (idHex, eHex, refundHex) { return CID_TESTS ? cidBlind(idHex, eHex, refundHex) : null; },
    _cashuIdPieceKey: function (baseHex, j) { return CID_TESTS ? cidPieceKey(baseHex, j) : null; },
    _cashuIdEncode: function (idHex, nostrHex, sigHex) { return CID_TESTS ? cidEncode(idHex, nostrHex, sigHex) : null; },
    _cashuIdNprofile: function (xonlyHex, relays) { return CID_TESTS ? cidNprofile(xonlyHex, relays) : null; },
    _cashuIdDropKey: function (nostrHex, day, j) { return CID_TESTS ? cidDropKey(nostrHex, day, j) : null; },
    _cashuIdAnyKey: function (nostrHex, idHex) { return CID_TESTS ? cidAnyKey(nostrHex, idHex) : null; },
    _cashuIdListenPlan: function (nowMs) { return CID_TESTS ? cidListenPlan(nowMs) : null; },
    _cashuIdLockS: 0,
    _cashuIdRetryMs: 0,
    _cashuIdFreshMs: 0,
    _cashuIdCopyMs: 0,
    _cashuIdAheadMs: 0,

