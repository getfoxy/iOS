  /* ---- DLEQ (NUT-12) ----------------------------------------------------
   *
   * A mint signs every proof. A DLEQ proves the signature was made with the
   * key the mint publishes for that amount — not a key it keeps for one
   * wallet. Without checking it, a mint could sign each wallet's proofs with
   * keys of its own and recognise that wallet's ecash wherever it turns up,
   * which is exactly the linking Tor is here to prevent. Nutshell checks it;
   * cashu-ts carries the check; Foxy stripped it and never looked.
   *
   * What the mint issues is checked first by cashu-ts: a signature whose DLEQ
   * fails throws before anything is stored (OutputData.toProof), as Nutshell's
   * wallet raises "DLEQ proof invalid." So a failing proof from a mint response
   * never reaches this file. The check here, as proofs are stored, is a
   * tripwire for proofs that did not come through that path; one that fails is
   * reported, not deleted. A token from someone else is checked before it is
   * swapped, and refused if a DLEQ it carries fails. A proof with no DLEQ is
   * accepted, as in Nutshell and cashu.me: many mints do not include one. */
  var dleqSeen = {};
  var dleqQuiet = {};

  function keysetFor(w, id) {
    try {
      var ks = w && w.keyChain && w.keyChain.getKeyset(id);
      return ks && ks.hasKeys ? ks : null;
    } catch (e) { return null; }
  }

  // `bad`, if given, collects the secrets of the proofs whose DLEQ fails
  /** @param {Array<string>=} bad */
  function dleqAudit(w, list, bad) {
    var r = { valid: 0, missing: 0, invalid: 0, unknown: 0 };
    var CT = window.CashuTS;
    if (!CT || !CT.hasValidDleq) return r;
    (list || []).forEach(function (p) {
      if (!p || !p.secret) return;
      if (!p.dleq) { r.missing++; return; }
      var ks = keysetFor(w, p.id);
      if (!ks) { r.unknown++; return; }
      var ok = false;
      try { ok = CT.hasValidDleq(p, ks, { require: true }); } catch (e) { ok = false; }
      if (ok) r.valid++; else { r.invalid++; if (bad) bad.push(p.secret); }
    });
    return r;
  }

  /* Whether the mint signed every one of these, by its own published keys.
   *
   * A lock says who may spend a proof. It says nothing about whether the proof
   * is money: anybody can write a secret that names this phone's key and put
   * any point beside it. Only the mint's signature makes it ecash, and the
   * DLEQ (NUT-12) is what shows that signature without asking the mint. So
   * ecash is "already ours" only when every piece carries one that verifies
   * against a keyset this wallet holds; one missing, or from a keyset not
   * loaded, and the answer is no (audit N1: 5,000 forged sats
   * were announced as paid). */
  function mintSigned(w, list) {
    var l = list || [];
    if (!w || !l.length) return false;
    return dleqAudit(w, l).valid === l.length;
  }

  /* Stored proofs whose DLEQ does not verify, said once per call: the console,
   * and the app through onMintTrouble. Kept, not deleted. */
  function reportInvalidDleq(host, n, where) {
    console.error('[foxy] DLEQ: ' + n + ' proof(s) from ' + host + ' do not verify (' + where + ')');
    if (typeof FoxyWallet._onMintTrouble === 'function') {
      try { FoxyWallet._onMintTrouble({ mint: host, invalid: n, where: where }); } catch (e) {}
    }
  }

  /* Proofs about to be stored, checked once each per session. Only a DLEQ
   * that is present and wrong raises anything: a keyset this wallet has not
   * loaded is skipped, not blamed. */
  function checkIssued(list, where, w) {
    var ww = w || wallet;
    if (!ww) return;
    var fresh = (list || []).filter(function (p) { return p && p.secret && !dleqSeen[p.secret]; });
    if (!fresh.length) return;
    var r = dleqAudit(ww, fresh);
    fresh.forEach(function (p) { if (p.dleq && keysetFor(ww, p.id)) dleqSeen[p.secret] = 1; });
    var host = hostOf(mintOf(ww) || mintUrl || '');
    if (r.invalid) {
      reportInvalidDleq(host, r.invalid, where);
    } else if (r.missing && !dleqQuiet[host]) {
      dleqQuiet[host] = 1;
      console.warn('[foxy] DLEQ: ' + host + ' issues proofs without a DLEQ; its signatures cannot be checked');
    }
  }

  /* One at a time through the proof list.
   *
   * Every routine below that reads the proofs, talks to the mint, and writes
   * the proofs back runs inside this. Two of them at once — reconcile on
   * resume alongside the invoice sweep, say — meant the second write was
   * built from a snapshot the first had already made stale, and the result
   * was either change deleted or spent proofs resurrected. There was no lock
   * anywhere in this file.
   *
   * A promise chain, in call order. A caller that arrives while another is
   * mid-melt waits for the melt, then reads the list the melt wrote. Nothing
   * is dropped; everything is late by at most one operation. */
  var proofChain = Promise.resolve();
  var proofDepth = 0;
  /* Who holds it and since when, for the diary. "A payment is in progress"
   * was all a refusal could say, and the payment turned out to be a claim
   * waiting ninety seconds on a mint that was not answering. A name and a
   * number of seconds, nobody's money. */
  var proofHolder = '', proofSince = 0;
  var PROOF_LOCK_SLOW_MS = 10000;
  function proofLet() {
    proofDepth--;
    var held = Date.now() - proofSince;
    if (held >= PROOF_LOCK_SLOW_MS) {
      console.log('[foxy] proof lock: ' + proofHolder + ' held it for ' + Math.round(held / 1000) + 's');
    }
    if (proofDepth <= 0) { proofHolder = ''; proofSince = 0; }
  }
  /* A payment that was still waiting its turn when the person stopped waiting
   * is not made. Nothing of it has left the phone — it had not begun — so
   * dropping it is safe, and making it half a minute after they gave up, to a
   * phone that has since put its invoice away, is not what they asked for.
   * Only sends, and only ones queued before the stop. */
  var proofGaveUpAt = 0;
  function giveUpWaiting() { proofGaveUpAt = Date.now(); }
  function withProofs(label, fn) {
    var asked = Date.now();
    var run = proofChain.then(function () {
      if (proofGaveUpAt >= asked && /^(sendToken|pay|payLnurl)$/.test(String(label || ''))) {
        var stopped = /** @type {any} */ (new Error('You stopped waiting, so the payment was not made.'));
        stopped.foxyStopped = true;
        console.log('[foxy] proof lock: ' + label + ' was still waiting when the person stopped; not made');
        return Promise.reject(stopped);
      }
      proofDepth++;
      if (proofDepth > 1) console.warn('[foxy] proof lock: depth', proofDepth, 'in', label);
      proofHolder = String(label || 'something unnamed'); proofSince = Date.now();
      return Promise.resolve().then(fn);
    });
    // the chain must survive a rejection, or every later call waits forever
    proofChain = run.then(proofLet, proofLet);
    return run;
  }

  /* One-time move of the original single pile onto the mint that was connected
   * when it was written — which is whichever mint is connecting right now the
   * first time this runs. */
  function migrateProofs() {
    var legacy = load(K.proofs, null);
    if (!legacy || !legacy.length) return;
    if (load(proofKey(), []).length) return;
    /* mustSave, and the removal only after it.
     *
     * This is a one-way move of the whole pre-multi-mint balance, and `save`
     * returns false on a refused write rather than throwing. Ignoring that and
     * then removing the source unconditionally does not lose the money until a
     * restore — it destroys it, because the legacy key held the only copy of
     * those secrets. A storage-full phone now fails the connect instead, which
     * is recoverable: the pile is still under the old key and the move runs
     * again next time there is room. */
    mustSave(proofKey(), legacy);
    try { localStorage.removeItem(K.proofs); } catch (e) {}
    console.log('[foxy] moved', legacy.length, 'proofs under', mintUrl);
  }

  /* Every mint that has ever connected, in the order they were first used.
   *
   * Without this a mint reached by scanning a QR is unreachable the moment you
   * switch away: it is on no list, so nothing offers it and no restore scan
   * looks there. The proofs stay filed under it and stay yours — but nothing
   * in the app can find them. */
  /* Why a mint URL is unacceptable, or null if it is fine.
   *
   * https only. Over plain http a network attacker is the mint: they see every
   * proof offered, can redeem it at the real mint while returning errors, and
   * can feed crafted answers to every parser in this file — including "all
   * your proofs are spent", which reconcile acts on by deleting them.
   *
   * .onion is the exception. A hidden service is authenticated and encrypted
   * by the circuit itself, so http to an .onion is not cleartext in the sense
   * that matters, and for this app it is a real use case. */
  function mintUrlProblem(u) {
    var s = String(u || '').trim();
    if (!s) return 'Give the mint\u2019s full address, starting with https://';
    if (!/^https?:\/\//i.test(s)) {
      return 'Give the mint\u2019s full address, starting with https://';
    }
    /* Read the way a URL parser reads it. The host used to be cut out with a
     * pattern, which read some addresses differently from the platform: text
     * after a space, a backslash or an escaped slash could end in .onion while
     * the parser saw another host, or no address at all (tests/fuzz-parsers.js).
     * The native side refuses such requests anyway (Route.swift); the answer
     * here should not depend on that. */
    var url;
    try { url = new URL(s); } catch (e) { return 'That mint address could not be read. Check it and try again.'; }
    if (url.protocol === 'https:') return null;
    if (url.protocol === 'http:' && /\.onion$/i.test(url.hostname)) return null;
    return 'That mint address is not secure. Foxy needs https:// (or a .onion address over Tor).';
  }

  function rememberMint(url) {
    var used = load(K.mintsUsed, []);
    if (!Array.isArray(used)) used = [];
    // whether this wallet has ever been on it, which is what the answer says
    var fresh = used.indexOf(canonicalMint(url)) < 0;
    if (fresh) save(K.mintsUsed, used.concat([canonicalMint(url)]));
    var seen = load(K.mints, []);
    if (!Array.isArray(seen)) seen = [];
    if (seen.indexOf(url) >= 0) return fresh;
    seen.push(url);
    save(K.mints, seen);
    console.log('[foxy] first time on', url, '\u2014 added to the mint list');
    return fresh;
  }

  /* Add only what is not already held.
   *
   * Import concatenated blindly, so the same backup imported twice doubled
   * the displayed balance — and the mint reports proofs it has never seen as
   * unspent, so the phantoms survived reconcile until a send failed on them.
   * Matched on secret, which is what the mint uses. Returns what was added. */
  /* Park the proofs a melt is holding, keyed by its quote.
   *
   * They are neither spent nor ours until the mint says which. Keeping them
   * here means the balance does not count them — the payment may go through —
   * and the sweep can give them back if it does not. */
  function holdMelt(quote, sent, bolt11, at, payee, splitFee) {
    var list = load(K.melting, []).filter(function (e) { return e.quote !== quote.quote; });
    list.push({
      quote: quote.quote,
      amount: satsOf(quote.amount) || 0,
      feeReserve: satsOf(quote.fee_reserve) || 0,
      proofs: sent || [],
      // what the split before the melt cost in input fees, so the fee a later
      // settle logs is everything the payment cost beyond its amount
      splitFee: Number(splitFee) || 0,
      bolt11: bolt11 || '',
      // the lightning address it was fetched for, if any, lowercased for matching
      payee: payee ? String(payee).trim().toLowerCase() : undefined,
      at: Math.floor(Date.now() / 1000),
      mint: at || mintUrl,
      // the counter ranges the melt reserves for its change, filled in by
      // noteMeltOutputs as cashu-ts reserves them
      outputs: [],
    });
    /* A hold that could not be written throws, and the melt is not sent: a
     * payment in flight with no hold on disk is money a killed app forgets
     * (audit W6). pay gives the proofs back to the pile. */
    mustSave(K.melting, list, true);
    console.log('[foxy] holding', sumProofs(sent || []), 'sats against melt', quote.quote);
  }

  /* Counter reservations as cashu-ts reports them ({ keysetId, start, count }),
   * for as long as the returned function is not called. A wallet without the
   * event gives nothing, and the melt's change is then left for a restore. */
  function watchReserved(w, fn) {
    try {
      if (w && w.on && typeof w.on.countersReserved === 'function') {
        var off = w.on.countersReserved(function (r) {
          if (r && r.keysetId && Number(r.count) > 0) {
            fn({ keysetId: String(r.keysetId), start: Number(r.start) || 0, count: Number(r.count) });
          }
        });
        return typeof off === 'function' ? off : function () {};
      }
    } catch (e) {}
    return function () {};
  }

  /* The change outputs a held melt reserved, written to its hold at once, so
   * a process that dies before the melt answers still knows them. */
  function noteMeltOutputs(quoteId, ranges) {
    var list = load(K.melting, []);
    var found = false;
    list.forEach(function (e) {
      if (e && e.quote === quoteId) {
        e.outputs = ranges.map(function (r) { return { keysetId: r.keysetId, start: r.start, count: r.count }; });
        found = true;
      }
    });
    if (found) save(K.melting, list);
  }

  /* Could a seed restore bring this proof back?
   *
   * Proofs this wallet minted use secrets derived from the seed and a
   * counter, and a restore re-derives them. A proof that arrived in an import
   * carries whatever secret its original wallet chose. There is no flag for
   * this, so it is inferred from shape: a derived secret is the hex of a
   * 32-byte hash, and a P2PK secret is a JSON array. Anything else is treated
   * as unrecoverable, which is the safe direction to be wrong in. */
  /* Could a seed restore bring this proof back?
   *
   * Answered from what was recorded when the proof arrived, not from what its
   * secret looks like. The shape test this replaced classified a proof
   * imported from another NUT-13 wallet as recoverable — its secret is 64 hex
   * characters like any other — when it was derived from a different seed and
   * could never be re-derived here.
   *
   * Anything not on the imported list was minted by this wallet against this
   * seed, and a restore rebuilds it. */
  function seedDerived(p, imported) {
    var sec = p && p.secret;
    if (typeof sec !== 'string') return false;
    var set = imported || importedSet();
    return !set[sec];
  }

  /* The change of a melt whose answer was lost, back from the seed.
   *
   * A melt that settles PAID on a later check returns its change as blind
   * signatures, and those cannot be unblinded without the outputs the lost
   * request made. They were deterministic, though, and the hold records the
   * counter ranges cashu-ts reserved for them (noteMeltOutputs). A restore of
   * just those ranges (NUT-09) gives the change back as proofs. Only what the
   * mint calls UNSPENT and this wallet does not already hold is returned.
   *
   * The recorded ranges, not "from the hold to now". That span also covered
   * every token sent after the hold, and a token not yet claimed restored as
   * UNSPENT "change": the balance grew by ecash already handed to someone, and
   * spending it broke their token. A hold with no recorded ranges — written
   * before they were kept — recovers nothing here; a seed restore finds its
   * change. */
  /* The ranges are restored by restoreRanges and filtered by liveUnheld
   * (04-lost-answers.js), which a lost claim and a lost swap use the same way. */
  function recoverMeltChange(w, outputs, at) {
    return restoreRanges(w, outputs, 'the change restore', 64).then(function (rows) {
      var found = [];
      rows.forEach(function (r) { found = found.concat(r.proofs); });
      if (!found.length) return [];
      return liveUnheld(w, found).then(function (live) {
        console.log('[foxy] melt change: restored', sumProofs(live), 'sats from counters',
          JSON.stringify(rows.map(function (r) { return r.range; })));
        return live;
      });
    });
  }

  /* The change of a held payment written before `outputs` was recorded.
   *
   * Such a hold has `counters`: the snapshot holdMelt took right after the
   * payment's split, immediately before meltProofsBolt11. Its change restored
   * nothing — the span "from the snapshot to now" it once used also covered
   * every token sent since. The range itself can be worked out, though, from
   * what cashu-ts does in prepareMelt (checked at 4.10.1 and again at 4.10.2,
   * whose prepareMelt diff touches no blank-count maths): when the inputs
   * exceed the quote
   * amount it makes NUT-08 blank outputs, max(bitlength(over - 1), 1) of them
   * (ceil(log2(over)), at least one), where `over` is the inputs less the
   * amount; on the wallet's bound keyset, since pay passes no keysetId; with
   * counters reserved right after the snapshot. So exactly that many, from
   * snap[keyset], on that keyset alone.
   *
   * Accepted only when the hold's inputs are all on that keyset (the split
   * made them there; one on another means the keyset has changed since and
   * the melt's cannot be told), the snapshot has a counter for it, and what is
   * restored — UNSPENT and held nowhere here — adds up to no more than the fee
   * reserve. Anything else is left for a seed restore and said so. */
  function legacyChangeCount(over) {
    var n = Math.floor(Number(over) || 0);
    if (n <= 0) return 0;
    return Math.max(n <= 1 ? 0 : (n - 1).toString(2).length, 1);
  }

  function recoverLegacyChange(w, entry) {
    var short = String(entry && entry.quote).slice(0, 12) + '…';
    var leave = function (why) {
      console.warn('[foxy] held payment', short, 'predates recorded change outputs: ' + why + '; a seed restore finds its change');
      return [];
    };
    if (!w || typeof w.restore !== 'function') return Promise.resolve(leave('this wallet cannot restore'));
    var ins = (entry.proofs || []).filter(function (p) { return p && p.secret; });
    var reserve = satsOf(entry.feeReserve) || 0;
    var count = legacyChangeCount(sumProofs(ins) - (satsOf(entry.amount) || 0));
    // inputs no more than the amount: the melt made no change outputs, and there is no change
    if (!count) return Promise.resolve([]);
    var id = null;
    try { id = w.keysetId; } catch (e) {}
    if (!id) return Promise.resolve(leave('no keyset is bound to tell which one the melt used'));
    if (!ins.length || ins.some(function (p) { return p.id !== id; })) {
      return Promise.resolve(leave('its inputs are not all on keyset ' + id + ', so the keyset its change went to cannot be told'));
    }
    var snap = entry.counters || {};
    var start = Number(snap[id]);
    if (snap[id] == null || !isFinite(start) || start < 0) {
      return Promise.resolve(leave('its counter snapshot has nothing for keyset ' + id));
    }
    var range = { keysetId: id, start: start, count: count };
    return restoreRanges(w, [range], 'the change restore', 64).then(function (rows) {
      var found = [];
      rows.forEach(function (r) { found = found.concat(r.proofs); });
      if (!found.length) return leave('nothing is signed at counters ' + start + '+' + count);
      return liveUnheld(w, found).then(function (live) {
        var got = sumProofs(live);
        if (!live.length) return [];
        if (got > reserve) {
          return leave('counters ' + start + '+' + count + ' hold ' + got + ' sats unspent, more than its ' + reserve + ' sat fee reserve');
        }
        console.log('[foxy] melt change: restored', got, 'sats from counters', JSON.stringify([range]), '(from the hold’s snapshot)');
        return live;
      });
    });
  }

  /* Proofs this wallet made, added once each: change, and anything restored
   * from this seed's counters.
   *
   * addNewProofs is for proofs from elsewhere and marks them imported, and
   * reconcile sets an imported proof aside when the mint calls it spent rather
   * than removing it. Change went in that way, so this wallet's own change,
   * spent later, sat in the quarantine as if nothing could rebuild it.
   * `restored` says the proofs came from a NUT-09 restore, which only a seeded
   * wallet can do; otherwise the wallet says whether it has the seed
   * (newWallet), and change from one without is marked, as before. */
  function addOwnProofs(list, url, w, unit, restored) {
    var held = {};
    proofs(url, unit).forEach(function (p) { if (p && p.secret) held[p.secret] = true; });
    var fresh = [];
    (Array.isArray(list) ? list : []).forEach(function (p) {
      if (!p || !p.secret || held[p.secret]) return;
      held[p.secret] = true;
      fresh.push(p);
    });
    if (!fresh.length) return 0;
    addProofs(fresh, url, w, unit);
    if (!restored && !(w && w.foxySeeded)) markImported(fresh);
    return sumProofs(fresh);
  }

  function dropMelt(quoteId) {
    save(K.melting, load(K.melting, []).filter(function (e) { return e.quote !== quoteId; }));
  }
  /* Whether a hold really went. `save` can be refused, and anything that is
   * done once per hold — charging what its split cost — must not be done
   * again by the sweep that finds it still there. */
  function meltGone(quoteId) {
    return !load(K.melting, []).some(function (e) { return e && e.quote === quoteId; });
  }

  /* A proof, as the audit trail keeps it.
   *
   * The fields the mint needs and nothing else — no witness, no dleq. Those
   * are large, and none of them helps work out where money went. */
  function scrub(p) {
    if (!p) return null;
    return { amount: satsOf(p.amount) || 0, secret: p.secret, C: p.C, id: p.id };
  }

  function addNewProofs(list, url, w, unit) {
    var incoming = Array.isArray(list) ? list : [];
    var held = {};
    proofs(url, unit).forEach(function (p) { if (p && p.secret) held[p.secret] = true; });
    var fresh = [];
    var seen = {};
    incoming.forEach(function (p) {
      if (!p || !p.secret || held[p.secret] || seen[p.secret]) return;
      seen[p.secret] = true;
      fresh.push(p);
    });
    var skipped = incoming.length - fresh.length;
    if (skipped > 0) console.log('[foxy] import: skipped', skipped, 'proof(s) already held');
    if (fresh.length) {
      addProofs(fresh, url, w, unit);
      /* These did not come from this seed.
       *
       * A proof minted here is recoverable — restore re-derives it — so
       * reconcile may delete it. One that arrived in an import was derived
       * from somebody else's seed, and no restore here will ever bring it
       * back, whatever its secret looks like. Recorded now, while it is a
       * fact rather than something to infer later. */
      markImported(fresh);
    }
    return sumProofs(fresh);
  }

  /* Secrets that arrived from elsewhere. */
  function importedSet() {
    var list = load(K.imported, []);
    var set = {};
    if (Array.isArray(list)) list.forEach(function (s) { set[s] = true; });
    return set;
  }

  function markImported(list) {
    var have = load(K.imported, []);
    if (!Array.isArray(have)) have = [];
    var seen = {};
    have.forEach(function (s) { seen[s] = true; });
    (list || []).forEach(function (p) {
      if (p && p.secret && !seen[p.secret]) { seen[p.secret] = true; have.push(p.secret); }
    });
    /* The list only needs to cover what is still held, so it cannot grow
     * forever — but held anywhere: every mint's pile, held melts and the
     * quarantine. Pruned against the connected mint alone, an import at one
     * mint forgot the imports held at every other, and a later reconcile there
     * deleted them as if the seed could bring them back. */
    var alive = {};
    everyHeldProof().forEach(function (p) { if (p && p.secret) alive[p.secret] = true; });
    save(K.imported, have.filter(function (s) { return alive[s]; }));
  }

  /* Every pile's key starts foxy.cashu.proofs. — the other units' piles
   * (<mint>@<unit>) included — so an import held in usd at one mint is still
   * "held" when an import at another prunes the list. */
  function everyHeldProof() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && (key === K.proofs || key.indexOf(K.proofs + '.') === 0)) out = out.concat(load(key, []));
      }
    } catch (e) {}
    load(K.melting, []).forEach(function (m) { out = out.concat((m && m.proofs) || []); });
    // an on-chain payout keeps its proofs on its own record (16a-onchain.js)
    load(K.onchainOut, []).forEach(function (m) { out = out.concat((m && m.proofs) || []); });
    quarantineEntries().forEach(function (q) { out.push(q.proof); });
    return out;
  }

  /* Quarantine entries are { mint, proof }, with a unit when it is not sats.
   * Older ones were bare proofs, with no record of their mint. */
  function quarantineEntries() {
    return load(K.quarantine, []).map(function (e) {
      if (e && e.proof) return { mint: e.mint || '', proof: e.proof, unit: unitOf(e.unit) || 'sat' };
      return { mint: '', proof: e, unit: 'sat' };
    }).filter(function (e) { return e.proof && e.proof.secret; });
  }

  /* Imported proofs are checked by the mint before they count.
   *
   * Filed as they arrived, a crafted backup showed any balance it liked: a
   * mint reports a secret it has never seen as unspent, so reconcile never
   * caught it. With a mint connected they are swapped there first — the mint
   * verifies every signature, the proofs that come back are this wallet's own
   * and recoverable from its seed, and a forged backup is refused whole. A
   * DLEQ that does not verify is refused before asking. With no mint connected
   * the import is refused. */
  function importChecked(list) {
    var incoming = Array.isArray(list) ? list : [];
    var w = wallet && onCircuit(wallet);
    if (!w) return Promise.reject(new Error('Connect to the mint first, so it can check that ecash.'));
    // only a stand-in wallet without a swap (the tests) files them unchecked
    if (typeof w.receive !== 'function') return addNewProofs(incoming);
    assertRoute();
    var at = mintOf(w);
    var held = {};
    proofs(at).forEach(function (p) { if (p && p.secret) held[p.secret] = true; });
    var seen = {};
    var fresh = incoming.filter(function (p) {
      if (!p || !p.secret || held[p.secret] || seen[p.secret]) return false;
      seen[p.secret] = true;
      return true;
    });
    if (!fresh.length) return Promise.resolve(0);
    var audit = dleqAudit(w, fresh);
    if (audit.invalid) {
      return Promise.reject(new Error('That ecash\u2019s signatures do not match the keys ' + hostOf(at) +
        ' publishes, so none of it was imported.'));
    }
    /* Spent proofs are left out rather than sinking the whole import.
     *
     * One spent proof made the mint refuse the swap outright, so a backup that
     * was partly spent could not be imported at all. Asked first, only what the
     * mint calls UNSPENT is swapped, a hundred at a time. Locked proofs (a
     * NUT-10 spending condition) are left out too: this wallet holds no key
     * that could unlock them. */
    var locked = lockedProofs(fresh);
    if (locked.length) {
      fresh = fresh.filter(function (p) { return locked.indexOf(p) < 0; });
      console.log('[foxy] import: left out', sumProofs(locked), 'sats locked to a key or condition');
      if (!fresh.length) return Promise.reject(new Error(LOCKED));
    }
    return statesOf(w, fresh).then(function (states) {
      var live = fresh.filter(function (p, k) { return states[k] === 'UNSPENT'; });
      var skipped = sumProofs(fresh) - sumProofs(live);
      if (!live.length) throw new Error('The mint says that ecash has already been spent, so there was nothing to import.');
      var got = 0;
      var batches = [];
      for (var b = 0; b < live.length; b += 100) batches.push(live.slice(b, b + 100));
      return batches.reduce(function (chain, batch) {
        return chain.then(function () {
          var token = window.CashuTS.getEncodedToken({ mint: at, proofs: batch, unit: 'sat' });
          // its outputs on disk until the answer is in (swapGuard), and what they add up to
          var guard = swapGuard(w, 'import', { amount: sumProofs(batch), expect: sumProofs(batch) - swapFeeFor(w, batch) });
          return guard.run('import', function () {
            return w.receive(token);
          }).then(function (swapped) {
            addProofs(swapped, at, w);
            guard.done();
            got += sumProofs(swapped);
          }, function (e) {
            var why = FoxyWallet.reason(e);
            throw new Error(got
              ? 'Imported ' + got + ' sats; the mint would not accept the rest: ' + why
              : 'The mint would not accept that ecash, so none of it was imported: ' + why);
          });
        });
      }, Promise.resolve()).then(function () {
        console.log('[foxy] import: swapped', sumProofs(live), 'sats at the mint, received', got,
          skipped ? '(' + skipped + ' sats already spent, left out)' : '');
        return got;
      });
    });
  }

  function addProofs(list, url, w, unit) {
    if (!list || !list.length) return;
    setProofs(proofs(url, unit).concat(list), url, w, unit);
  }

  function sumProofs(list) {
    return (list || []).reduce(function (n, p) { return n + satsOf(p.amount); }, 0);
  }

  /* Where traffic goes.
   *
   * Foxy reaches the network through its own Tor. The native side owns that
   * state, pushes it here on every change, and routes every request by it: a
   * request it cannot send through Tor it refuses, unless the person using the
   * app chose to continue unprotected this session. Tor connecting clears that
   * choice, so the app moves onto Tor as soon as it can.
   *
   * This copy decides only whether to try. It is never what keeps a request
   * off the open internet — the native side does that, per request — so a copy
   * a moment out of date costs an error message, not a leak.
   *
   * It replaces vpnOk, pathOk, vpnRequired and FOXY_EMBEDDED_TOR: four answers
   * to one question, set in different places, which repeatedly disagreed. */
  var privacy = { tor: 'connecting', progress: 0, everUp: false, unprotected: false, transport: 'direct', orbot: 'none', firstSetup: false, offline: false, network: 'unknown' };

  function bridged() {
    return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy);
  }

  function applyPrivacy(text) {
    var p = null;
    try { p = JSON.parse(String(text)); } catch (e) {}
    return FoxyWallet._privacy(p);
  }

  /* May a request be attempted right now? A boolean for the pollers, which
   * run on a timer and cannot let an exception propagate. */
  /* `offline` is deliberately not here.
   *
   * Working offline is the person saying "carry on without a network", which is
   * the opposite of `unprotected` — that one says "send my traffic in the
   * clear". Nothing may be sent while offline, so the route stays shut and every
   * request is refused exactly as it is now. What the flag changes is the gate,
   * which comes down, and the copy below, which stops blaming Tor for a state
   * the person chose. The two questions are independent and stay that way. */
  function routeOpen() {
    // a desktop browser or the tests: no native side, nothing to route through
    if (!bridged()) return true;
    /* No interface, no route, whatever Tor still believes.
     *
     * `tor === 'up'` is a circuit Foxy built, and it outlives the interface for
     * as long as Tor's own deadline takes to notice — up to forty-five seconds,
     * and longer if it never does. For that whole window this said the route was
     * open and every offline protection was off: `connect` reached for the
     * network instead of the keysets on file, a send tried to swap instead of
     * using pieces on hand, a payer kept a lock it could not make, and a
     * receiver recorded the net of an over-payment whose change it then could
     * not make — history saying it had been paid 2 while it held 4.
     *
     * The gate and `setOffline` already stopped believing that stale answer;
     * this is the third of the three, and the one that decides
     * whether money moves. Only a definite 'none' counts: 'unknown', before the
     * path monitor's first word, is not an accusation that the phone is off the
     * air. */
    if (privacy.network === 'none') return false;
    return privacy.tor === 'up' || privacy.unprotected;
  }

  /* ---- a route that is on its way ------------------------------------------
   *
   * Foxy opens on the home screen and works offline until Tor is up, so for
   * the first seconds of a session the route is neither open nor absent: it
   * is coming. Every money step reads `routeOpen()` once and takes a branch,
   * and the branch for no route is a worse one where a route was two seconds
   * off: a payer drops the lock it was asked for, a receiver refuses plain
   * ecash or keeps an over-payment it could have made change for, a scanned
   * token gets the HIGH RISK card. The connection screen used to make people
   * sit those seconds out. Now the step itself does, for a few seconds at
   * most, and only while a connection really is being made.
   *
   * Coming means: a network under it, Tor at work on a circuit, and nobody
   * having chosen to go without Tor. No network is not coming, and neither is
   * a Tor that has stopped or given up: those take the offline branch at
   * once, as before. */
  var ROUTE_WAIT_MS = 6000;
  var routeWaiters = [];

  function routeComing() {
    if (!bridged() || routeOpen()) return false;
    if (privacy.network === 'none' || privacy.unprotected) return false;
    return privacy.tor === 'connecting' || privacy.tor === 'stuck';
  }

  /* Resolves true the moment the route is open, false when it is not coming
   * or `ms` have gone by. Never rejects: what follows goes on either way, by
   * whatever the route then is. */
  function routeSoon(ms) {
    if (routeOpen()) return Promise.resolve(true);
    var wait = ms === undefined ? ROUTE_WAIT_MS : Math.max(0, Number(ms) || 0);
    if (!(wait > 0) || !routeComing()) return Promise.resolve(false);
    console.log('[foxy] a connection is on its way; waiting for it, ' + Math.round(wait / 1000) + 's at most');
    return new Promise(function (done) {
      var settled = false;
      var timer = null;
      var answer = function (open) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        routeWaiters = routeWaiters.filter(function (fn) { return fn !== answer; });
        done(!!open);
      };
      timer = setTimeout(function () { answer(false); }, wait);
      routeWaiters.push(answer);
    });
  }

  /* Every change of the route, from `_privacy` and `setOffline`. */
  function routeChanged() {
    if (!routeWaiters.length) return;
    var open = routeOpen();
    if (!open && routeComing()) return;
    routeWaiters.slice().forEach(function (fn) { fn(open); });
  }

  function assertRoute() {
    // storage from a newer Foxy: nothing that could change it runs (see the header)
    if (storageNewer) throw new Error(STORAGE_NEWER);
    if (routeOpen()) return;
    throw new Error(privacy.offline
      ? (routeComing() ? SECURING_REFUSAL : OFFLINE_REFUSAL)
      : privacy.everUp
        ? 'Tor is reconnecting. Try again in a moment.'
        : 'Foxy is still connecting to Tor.');
  }

