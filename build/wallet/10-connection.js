  var FoxyWallet = {

    /* ---- connection ---------------------------------------------------- */

    get connected() { return !!wallet; },
    get mintUrl() { return mintUrl; },
    /* Whether a late claim has the wallet at another mint just now, and a
     * promise for when it is home (`claimAway`). For the screens: a balance
     * read in between is the other mint's. */
    awayClaiming: function () { return !!claimAway; },
    whenHome: function () { return homeFirst(function () { return Promise.resolve(); }); },

    /* Where a fresh install points itself. Nothing asks; boot just connects. Forge, which issues dollars as well as bitcoin. */
    defaultMint: 'https://forge.flashapp.me',

    /* The mint hosts whose requests carry a test mark (`requestMarkFor`).
     * Empty: only tests, and a debug build launched with -FoxyRequestIdHosts
     * (FoxyWebView), fill it. */
    requestIdHosts: (function () {
      var given = typeof window !== 'undefined' && window.__foxyRequestIdHosts;
      return Array.isArray(given) ? given.map(String) : [];
    }()),

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

    /* Did the person choose this mint (`mintsChosen`): the phone's own mint, one it was saved on, or one passed through
     * the lock's gate for adding a mint? A mint only visited is not. For the page's gate (09-melt-paste-switch.js,
     * `mintOnPhone`). */
    mintChosen: function (url) {
      var c = canonicalMint(String(url || ''));
      if (!c) return false;
      if (canonicalMint(String(load(K.mint, '') || '')) === c) return true;
      return mintsChosen().indexOf(c) >= 0;
    },

    /* The person passed the gate for adding this mint: chosen from now (`mintsChosen`). */
    chooseMint: function (url) { chooseMint(url); },

    /* Drop one from the list. The proofs under it are left alone. It is no longer chosen either: adding it again asks the
     * lock, as any new mint does (`mintsChosen`). */
    forgetMintFromList: function (url) {
      var seen = load(K.mints, []);
      if (!Array.isArray(seen)) return;
      mintsChosen();
      save(K.mints, seen.filter(function (u) { return u !== url; }));
      var c = canonicalMint(String(url || ''));
      if (c) save(K.mintsChosen, mintsChosen().filter(function (u) { return u !== c; }));
    },

    /* Removing a mint from the list (SWITCH MINT's bin, 27-render-mints-restore-backup.js `mrTrash`). */

    /* What still holds money at `url`, or is on its way there, in plain words: [] when nothing does. Each is a reason the
     * mint is not removed yet: an invoice asked for and not yet paid or collected, a payment arriving and not yet swapped
     * in, a card's load whose pieces are at it, a payment still routing, a
     * transfer in flight from or to it, a payment being brought home from or to it, a swap between its two balances, an
     * on-chain address there still watched, a payment to a Foxy ID still waiting to be collected, a till open at it, a
     * cashier code that names it while the code lives, and a cashier's till at it. Local, and at once. */
    mintRemoveHolds: function (url) {
      var c = canonicalMint(String(url || ''));
      if (!c) return [];
      var at = function (u) { return !!u && canonicalMint(String(u)) === c; };
      var now = Date.now();
      var out = [];
      var add = function (why) { if (out.indexOf(why) < 0) out.push(why); };
      var tokenAt = function (text) {
        var info = null;
        try { info = FoxyWallet.tokenInfo(String(text || '')); } catch (e) { info = null; }
        return !!(info && at(info.mint));
      };
      [K.quotes, K.quotesOld].forEach(function (key) {
        var l = load(key, []);
        (Array.isArray(l) ? l : []).forEach(function (q) {
          if (!q || !at(q.mint)) return;
          var live = q.unclaimed || !(Number(q.expiry) > 0) || Number(q.expiry) * 1000 > now;
          if (live) add('An invoice there is not paid or collected yet.');
        });
      });
      if (unclaimedIn('sat', c) > 0 || unclaimedIn('usd', c) > 0 || arrivingIn('sat', c) > 0 || arrivingIn('usd', c) > 0) {
        add('A payment there is still arriving.');
      }
      /* A token sent from there and not claimed does not hold it (the keeper, 2026-11-07: "let it through"): it stays on its
       * note, and the page names it (`mintUnclaimedSent`). A card's load does. */
      var meta = load('foxy.txmeta', {}) || {};
      Object.keys(meta).forEach(function (h) {
        var m = meta[h];
        if (!m || m.to !== 'card' || typeof m.token !== 'string' || !m.token || !tokenAt(m.token)) return;
        add('A card holds money loaded from there.');
      });
      (load(K.melting, []) || []).forEach(function (h) { if (h && at(h.mint)) add('A payment from there is still going through.'); });
      moveNotes().forEach(function (n) { if (at(n.from) || at(n.to)) add('A transfer from or to it is still in flight.'); });
      carryJobs().forEach(function (j) { if (at(j.from) || at(j.home)) add('A payment is still being brought home from or to it.'); });
      unitSwaps().forEach(function (r) { if (at(r.mint)) add('A swap between its two balances has not finished.'); });
      converts().forEach(function (r) { if (at(r.mint)) add('A swap between its two balances has not finished.'); });
      var watchFrom = now - ONCHAIN_WATCH_DAYS * 86400000;
      (load(K.onchain, []) || []).forEach(function (r) {
        if (r && at(r.mint) && Number(r.at) > watchFrom) add('An on-chain address there is still watched.');
      });
      (load(K.onchainOut, []) || []).forEach(function (r) { if (r && at(r.mint)) add('An on-chain payment from there has not confirmed.'); });
      cidOutboxRows().forEach(function (r) { if (tokenAt(r.token)) add('A payment to a Foxy ID from there is not collected yet.'); });
      var till = tillKeeperNow();
      if (till && till.mints.some(at)) add('Your till is open at it.');
      (load(K.tillPasses, []) || []).forEach(function (r) {
        if (!r || !(Number(r.exp) * 1000 > now)) return;
        if (at(r.mint) || (Array.isArray(r.mints) && r.mints.some(at))) add('A cashier code names it until the code ends.');
      });
      var cashier = tillCashierRaw();
      if (cashier && cashier.pass && (at(cashier.pass.mint) || (cashier.pass.mints || []).some(at))) add('A cashier\u2019s till is open at it.');
      return out;
    },

    /* The tokens sent from `url` that nobody has claimed yet (a card's loads aside), each on its note: { count, sat, usd }.
     * They do not hold the mint on the list; the page names them before it is removed. */
    mintUnclaimedSent: function (url) {
      var c = canonicalMint(String(url || ''));
      var out = { count: 0, sat: 0, usd: 0 };
      if (!c) return out;
      var seen = {};
      var one = function (text) {
        var t = String(text || '');
        if (!t || seen[t]) return;
        var info = null;
        try { info = FoxyWallet.tokenInfo(t); } catch (e) { info = null; }
        if (!info || canonicalMint(String(info.mint || '')) !== c) return;
        seen[t] = true;
        out.count += 1;
        if ((unitOf(info.unit) || 'sat') === 'usd') out.usd += satsOf(info.amount) || 0;
        else out.sat += Number(info.sats) || satsOf(info.amount) || 0;
      };
      var meta = load('foxy.txmeta', {}) || {};
      Object.keys(meta).forEach(function (h) { var m = meta[h]; if (m && m.to !== 'card' && typeof m.token === 'string') one(m.token); });
      var last = load(K.outtok, null);
      if (last && typeof last.token === 'string') one(last.token);
      return out;
    },

    /* Off the list: off `K.mints` and not chosen (`forgetMintFromList`), and hidden (`K.mintsHidden`), which keeps a
     * shipped mint off too until it is chosen again through the gate or a connect takes money there. Nothing else is
     * touched: the history rows at it stay, and so do any pieces left in its pile (too little to move). The page moves the
     * phone off it first; a mint the phone is on, or is saved on, is refused. */
    removeMint: function (url) {
      var c = canonicalMint(String(url || ''));
      if (!c) throw new Error('No mint to remove.');
      if (canonicalMint(String(mintUrl || '')) === c || canonicalMint(String(load(K.mint, '') || '')) === c) {
        throw new Error('Foxy is on ' + hostOf(c) + '. Move to another mint first.');
      }
      var seen = load(K.mints, []);
      (Array.isArray(seen) ? seen : []).forEach(function (u) { if (canonicalMint(String(u || '')) === c) FoxyWallet.forgetMintFromList(u); });
      FoxyWallet.forgetMintFromList(c);
      var hid = mintsHidden();
      if (hid.indexOf(c) < 0) mustSave(K.mintsHidden, hid.concat([c]));
      console.log('[foxy] ' + hostOf(c) + ' removed from the mint list');
      return true;
    },

    // the mints removed (`K.mintsHidden`), and whether one is
    mintsHidden: function () { return mintsHidden(); },
    mintHidden: function (url) { return mintHidden(url); },
    // a removed mint money came back to: shown, and not the phone's own until chosen (`K.mintsReturned`)
    mintReturned: function (url) { var c = canonicalMint(String(url || '')); return !!c && mintsReturned().indexOf(c) >= 0; },

    /* A choice undone (a mint added for a removal that was then dropped): not chosen, off the list, and hidden again with
     * `o.hide` (it had been removed before). Its pile, if any, untouched. Refused for the mint the phone is on or saved on. */
    unchooseMint: function (url, o) {
      var c = canonicalMint(String(url || ''));
      if (!c) return false;
      if (canonicalMint(String(mintUrl || '')) === c || canonicalMint(String(load(K.mint, '') || '')) === c) return false;
      var seen = load(K.mints, []);
      (Array.isArray(seen) ? seen : []).forEach(function (u) { if (canonicalMint(String(u || '')) === c) FoxyWallet.forgetMintFromList(u); });
      FoxyWallet.forgetMintFromList(c);
      if (o && o.hide) { var hid = mintsHidden(); if (hid.indexOf(c) < 0) save(K.mintsHidden, hid.concat([c])); }
      return true;
    },
    /* A restore from words: every removed mint back on the list, so the scan looks at them as at any mint and money the
     * words hold there, or left there at the removal, is found. Back as a mint visited is: on the list, not chosen. */
    unhideAllMints: function () {
      var hid = mintsHidden();
      if (!hid.length) { save(K.mintsReturned, []); return; }
      mintsChosen();
      var seen = load(K.mints, []);
      if (!Array.isArray(seen)) seen = [];
      hid.forEach(function (c) {
        if (!seen.some(function (u) { return canonicalMint(String(u || '')) === c; })) seen.push(c);
      });
      save(K.mints, seen);
      save(K.mintsHidden, []);
      // and the ones money came back to are chosen like the rest of the list, as a restore finds them
      save(K.mintsReturned, []);
    },

    saved: function () {
      var url = load(K.mint, '');
      return url ? { url: url } : null;
    },

