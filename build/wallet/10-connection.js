  var FoxyWallet = {

    /* ---- connection ---------------------------------------------------- */

    get connected() { return !!wallet; },
    get mintUrl() { return mintUrl; },

    /* Where a fresh install points itself. Nothing asks; boot just connects. */
    defaultMint: 'https://mint.minibits.cash/Bitcoin',

    /* Erase this device and start over.
     *
     * Every foxy.* key goes: the seed, every mint's proofs, counters, quotes,
     * history, contacts and the mint list. There is no undo and no copy
     * anywhere else — proofs are bearer tokens, so deleting them is destroying
     * the money. The phone makes a new seed so the app has something to run on.
     */
    wipeDevice: function () {
      /* The phone erases the seed and makes the new one (seedWipe), after its
       * own Delete alert, which a script in the page cannot tap, and sets the
       * old counters aside. Nothing here is erased until it has: a No there
       * ("Nothing was erased.") rejects with everything as it was. Storage used
       * to be erased first, and the seed deleted after with no approval. No
       * words come back: the new seed's are shown on the phone. */
      return nativeJson('seedWipe', {}, PERSON_MS).then(function (j) {
        if (j.wiped !== true) throw new Error('the phone did not say it erased the seed');
        var gone = [];
        try {
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf('foxy.') === 0) gone.push(k);
          }
          gone.forEach(function (k) { localStorage.removeItem(k); });
        } catch (e) {}
        wallet = null;
        mintUrl = '';
        clearNativeSecrets(true, true);   // the secrets held were the erased seed's
        nativeSeedKnown = j.created === true;
        movedToPhone = false;             // the stamps went with storage; nothing is left to move
        seedReplaced = null;
        seedError = null;
        console.log('[foxy] wiped', gone.length, 'keys; the phone made a new seed');
        return { removed: gone.length, created: j.created === true };
      });
    },

    /* Mints this device has used, defaults excluded — the interface adds its
     * own. Ordered by when each was first connected. */
    mints: function () {
      var seen = load(K.mints, []);
      return Array.isArray(seen) ? seen.slice() : [];
    },

    /* Has this device connected to that mint before? The list of mints can be
     * pruned; this record of them is not. */
    mintUsedBefore: function (url) {
      var c = canonicalMint(url);
      if (!c) return false;
      var used = load(K.mintsUsed, []);
      var seen = load(K.mints, []);
      return (Array.isArray(used) ? used : []).concat(Array.isArray(seen) ? seen : [])
        .some(function (u) { return canonicalMint(u) === c; });
    },

    /* Drop one from the list. The proofs under it are left alone. */
    forgetMintFromList: function (url) {
      var seen = load(K.mints, []);
      if (!Array.isArray(seen)) return;
      save(K.mints, seen.filter(function (u) { return u !== url; }));
    },

    saved: function () {
      var url = load(K.mint, '');
      return url ? { url: url } : null;
    },

