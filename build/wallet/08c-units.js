  /* ---- two balances at one mint: the units ---------------------------
   *
   * A mint can issue ecash in more than one unit. Forge issues sat and usd,
   * and a usd piece is worth a cent, not a sat. The rule all of this keeps:
   * the unit lives in the key of the pile and in every record, and a figure
   * is never added across units. Sats are 'sat' and dollars are 'usd' here,
   * always in their smallest unit (sats, or cents).
   *
   * What is in this part:
   *   - which units a mint issues, read from the keysets the wallet already
   *     holds or from the copy kept for a launch with no route
   *     (`keysetsOf`, `unitsOf`, `keysetUnit`);
   *   - the guard on every pile write: a piece goes only into the pile of its
   *     own keyset's unit (`unitGuard`, called by `setProofs`);
   *   - the one place a token is encoded (`encodeToken`), which refuses a
   *     token whose pieces are not all of the unit it says;
   *   - the wallet object for a unit (`walletIn`), the dollar price a mint
   *     is quoting (`noteMintRate`), money said in words (`moneyWords`), and
   *     the records of a swap between the two units (`unitSwaps`). */

  /* The units Foxy handles. Others (auth, msat, eur) are never offered. */
  var HANDLED_UNITS = { sat: true, usd: true };

  /* The keysets Foxy knows for a mint, as { id: { unit, active } }, or null
   * when nothing is known about that mint here.
   *
   * From the wallet objects first (`w`, the connected one, a unit wallet
   * already built), whose keysets cashu-ts loaded from the mint, and then
   * from the copy kept for a launch with no route (`mintCacheFor`). Every
   * keyset of every unit is in a wallet's key chain: cashu-ts keeps them all
   * and only picks by unit when it spends. */
  function keysetsOf(mint, w) {
    var m = canonicalMint(String(mint || mintUrl || ''));
    if (!m) return null;
    var out = {};
    var found = false;
    var take = function (id, k) {
      if (!id || !k || !k.unit) return;
      var active = k.isActive !== undefined ? !!k.isActive : k.active !== false;
      out[String(id)] = { unit: String(k.unit).toLowerCase(), active: active };
      found = true;
    };
    var fromChain = function (x) {
      if (!x) return;
      try { if (canonicalMint(String(mintOf(x) || '')) !== m) return; } catch (e) { return; }
      var map = null;
      try { map = x.keyChain && x.keyChain.keysets; } catch (e) { map = null; }
      if (!map || typeof map !== 'object') return;
      Object.keys(map).forEach(function (id) { take(id, map[id]); });
    };
    fromChain(w);
    fromChain(wallet);
    var cached = unitWallets || {};
    Object.keys(cached).forEach(function (u) { if (cached[u] && cached[u].ready) fromChain(cached[u].ready); });
    if (!found) {
      var c = mintCacheFor(String(mint || mintUrl || '')) || mintCacheFor(m);
      var list = (c && c.keys && Array.isArray(c.keys.keysets)) ? c.keys.keysets : [];
      list.forEach(function (k) { if (k) take(k.id, k); });
    }
    return found ? out : null;
  }

  /* The units a mint issues on its active keysets, sat first, of the units
   * Foxy handles. [] when nothing is known about the mint here. */
  function unitsOf(mint, w) {
    var sets = keysetsOf(mint, w);
    if (!sets) return [];
    var all = sets;
    var have = {};
    Object.keys(all).forEach(function (id) {
      var k = all[id];
      if (k.active && HANDLED_UNITS[k.unit]) have[k.unit] = true;
    });
    return ['sat', 'usd'].filter(function (u) { return have[u]; });
  }

  /* The unit of one keyset at a mint: 'sat', 'usd', … or '' when this phone
   * does not know the keyset. A short id (NUT-02 v2, as some tokens carry
   * it) is matched by the start of a full one. */
  function keysetUnit(mint, id, w, sets) {
    var all = sets === undefined ? keysetsOf(mint, w) : sets;
    if (!all || !id) return '';
    var k = all[String(id)];
    if (!k && String(id).length === 16) {
      var long = Object.keys(all).filter(function (x) { return x.length > 16 && x.indexOf(String(id)) === 0; });
      if (long.length === 1) k = all[long[0]];
    }
    return k ? k.unit : '';
  }

  /* The pieces of `list` that do not belong in `unit`'s pile at `mint`: a
   * known keyset of another unit, or, in a pile that is not sats, a keyset
   * the mint's list does not name.
   *
   * A keyset nobody here knows goes into the sat pile, as it always did: a
   * pile from before keysets were kept, or a test's stand-in mint, has
   * nothing to check it against. And where nothing at all is known about the
   * mint (no wallet for it and no kept copy), nothing is refused: there is
   * nothing to judge by, and refusing would strand a restore. */
  function wrongUnitPieces(list, mint, unit, w) {
    var u = unitOf(unit) || 'sat';
    var sets = keysetsOf(mint, w);
    if (!sets) return [];
    return (Array.isArray(list) ? list : []).filter(function (p) {
      if (!p) return false;
      var their = keysetUnit(mint, p.id, w, sets);
      if (their) return their !== u;
      return u !== 'sat';
    });
  }

  /* Hard rule 1: a piece goes only into the pile of its own unit.
   *
   * Called by `setProofs` before the write, so a refusal leaves the pile as
   * it was and whatever record would bring the pieces back (a swap, a held
   * melt, an invoice's outputs) where it is. Only pieces new to the pile are
   * looked at: a pile that already held a stray piece must not refuse every
   * write after it. */
  function unitGuard(list, mint, unit, w, before) {
    var had = {};
    (Array.isArray(before) ? before : []).forEach(function (p) { if (p && p.secret) had[p.secret] = true; });
    var fresh = (Array.isArray(list) ? list : []).filter(function (p) { return p && !had[p.secret]; });
    if (!fresh.length) return;
    var bad = wrongUnitPieces(fresh, mint, unit, w);
    if (!bad.length) return;
    var their = keysetUnit(mint, bad[0].id, w);
    var e = /** @type {any} */ (new Error('Foxy kept ' + (their ? unitName(their) : 'unrecognised') + ' ecash out of the '
      + unitName(unitOf(unit) || 'sat') + ' balance; nothing was lost.'));
    e.wrongUnit = true;
    console.warn('[foxy] pile: ' + bad.length + ' piece(s) of ' + (their || 'an unknown keyset')
      + ' refused from the ' + (unitOf(unit) || 'sat') + ' pile at ' + hostOf(mint));
    throw e;
  }

  /* Hard rule 2: the one token encoder. Every token Foxy makes is made here,
   * named with its unit, and refused when its pieces are not all of that
   * unit — a usd token labelled sat is a payment of cents read as sats. */
  function encodeToken(mint, proofs, unit, extra) {
    var u = unitOf(unit);
    if (!u) throw new Error('Foxy does not know the unit ' + String(unit).slice(0, 20) + '.');
    var list = Array.isArray(proofs) ? proofs : [];
    if (!list.length) throw new Error('No ecash to put in a token.');
    if (wrongUnitPieces(list, mint, u, null).length) {
      throw new Error('Those pieces are not all ' + unitName(u) + ' ecash, so no token was made.');
    }
    var body = /** @type {any} */ ({ mint: mint, proofs: list, unit: u });
    if (extra && typeof extra === 'object') Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
    return window.CashuTS.getEncodedToken(body);
  }

  /* The unit a record is in. Every record written now says; one written
   * before units were kept is sats. */
  function recordUnit(rec) {
    return (rec && unitOf(rec.unit)) || 'sat';
  }

  /* An amount said the way the screens say it: '$ 2.00', '₿ 6,500'. */
  function moneyWords(amount, unit) {
    var n = Math.round(Number(amount) || 0);
    var u = unitOf(unit) || 'sat';
    if (u === 'usd') {
      return '$ ' + (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (u === 'sat') return '₿ ' + n.toLocaleString('en-US');
    return formatAmount(n, u);
  }

  /* The word for a balance: 'dollars' or 'bitcoin'. */
  function balanceWord(unit) {
    var u = unitOf(unit) || 'sat';
    return u === 'usd' ? 'dollars' : u === 'sat' ? 'bitcoin' : unitName(u);
  }

  /* A history row in a unit. Sat rows are as they always were; another
   * unit's row carries its amount and fee in that unit with sats at 0, so no
   * sat figure ever counts it. */
  function unitRow(unit, row) {
    var u = unitOf(unit) || 'sat';
    if (u === 'sat') return row;
    var out = Object.assign({}, row);
    out.unit = u;
    out.amount = Math.round(satsOf(row.amount != null ? row.amount : row.sats) || 0);
    out.feeAmount = Math.round(Number(row.feeAmount != null ? row.feeAmount : row.feeSats) || 0);
    out.sats = 0;
    out.feeSats = 0;
    /* An over-payment's breakdown, in the row's unit too: what arrived or
     * left whole, the change, and what was too little to come back. The sat
     * names are not kept on such a row, so nothing that reads sats finds
     * cents there. */
    [['grossSats', 'grossAmount'], ['changeSats', 'changeAmount'], ['dustSats', 'dustAmount']].forEach(function (pair) {
      if (!(pair[0] in out)) return;
      var v = out[pair[0]];
      delete out[pair[0]];
      if (v === undefined || v === null) return;
      if (out[pair[1]] === undefined) out[pair[1]] = Math.round(Number(v) || 0);
    });
    return out;
  }

  /* The fields that amend an entry's amount, in its own unit: `sats` on a
   * sat entry, `amount` on any other. */
  function amountFields(unit, n, extra) {
    var u = unitOf(unit) || 'sat';
    var f = /** @type {any} */ (Object.assign({}, extra || {}));
    var v = Math.max(0, Math.round(Number(n) || 0));
    if (u === 'sat') f.sats = v; else f.amount = v;
    return f;
  }

  /* A row that is one leg of a swap between units says so, with the swap's
   * id and the mint's rate, so each unit's history shows its own leg and the
   * detail can join the two (`swapRun`). */
  function swapMarks(rec, row) {
    if (!rec || !rec.swap) return row;
    row.kind = 'swap';
    row.swap = String(rec.swap);
    if (Number(rec.mintRate) > 0) row.mintRate = Number(rec.mintRate);
    return row;
  }

  /* What a payment that did not go still cost to prepare (the split's input
   * fee). Sats go where they always went, to the fees no row carries
   * (`chargeTopUpFee`); another unit has no such store, so it gets a row of
   * its own for the fee alone, and its books still add up. */
  function meltBackFee(at, unit, fee) {
    var u = unitOf(unit) || 'sat';
    if (u === 'sat') { chargeUnsentFee(at, fee); return; }
    var n = Math.round(Number(fee) || 0);
    if (!(n > 0)) return;
    logTx({ dir: 'out', unit: u, amount: 0, feeAmount: n, sats: 0, feeSats: 0, settled: true, state: 'success',
            memo: 'fee of a payment that did not go', hash: 'fee-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            mint: canonicalMint(at) });
  }

  /* ---- the wallet object for a unit ----
   *
   * cashu-ts binds a wallet object to one unit. The connected wallet is the
   * sat one; a unit wallet (`unitWallet`, 03-seed-counters-logs.js) is built
   * once per connected wallet and kept here without a circuit. Every job puts
   * it on a circuit of its own (`sameCircuit` with the view `needNow` gives),
   * so it never outlives a spare circuit being dropped, and a connect or a
   * switch makes a new connected wallet, which is a new entry here. */
  var unitWallets = /** @type {Object<string, { base: any, made: Promise<any>, ready: any }>} */ ({});

  function unitWalletBase(unit) {
    var u = unitOf(unit);
    if (!wallet) return Promise.reject(new Error('No mint connected yet. Call FoxyWallet.connect() first.'));
    var base = wallet.foxyBase || wallet;
    var hit = unitWallets[u];
    if (hit && hit.base === base) return hit.made;
    var made = unitWallet(base, u);
    var entry = { base: base, made: made, ready: null };
    unitWallets[u] = entry;
    made.then(function (uw) { entry.ready = uw; }, function () { if (unitWallets[u] === entry) delete unitWallets[u]; });
    return made;
  }

  /* Refused before anything is built, in the words the screens use. */
  function unitRefusal(unit, mint) {
    var u = unitOf(unit);
    if (!u) return new Error('Foxy does not know the unit ' + String(unit).slice(0, 20) + '.');
    if (u === 'sat') return null;
    var known = unitsOf(mint || mintUrl);
    if (known.length && known.indexOf(u) < 0) {
      return new Error(hostOf(mint || mintUrl) + ' does not issue ' + unitName(u) + ' ecash.');
    }
    return null;
  }

  /* The connected mint's wallet for `unit`, on the circuit kept ready (or a
   * new one): the sat wallet itself for 'sat'. */
  function walletIn(unit) {
    var no = unitRefusal(unit);
    if (no) return Promise.reject(no);
    var view;
    try { view = needNow(); } catch (e) { return Promise.reject(e); }
    var u = unitOf(unit);
    if (u === 'sat') return Promise.resolve(view);
    return unitWalletBase(u).then(function (uw) { return sameCircuit(view, uw); });
  }

  /* `w`'s mint's wallet for `unit`, on `w`'s circuit: for the sweeps, which
   * may be asking a mint the phone is not connected to. */
  function unitWalletOn(w, unit) {
    var u = unitOf(unit) || 'sat';
    if (u === 'sat' || !w) return Promise.resolve(w);
    var base = w.foxyBase || w;
    var conn = wallet ? (wallet.foxyBase || wallet) : null;
    var made = base === conn ? unitWalletBase(u) : unitWallet(base, u);
    return made.then(function (uw) { return sameCircuit(w, uw); });
  }

  /* The unit wallet already built for the connected mint, or null. Local and
   * at once, for the sums a screen asks before anything is sent (`payNeed`). */
  function unitWalletNow(unit) {
    var u = unitOf(unit) || 'sat';
    if (u === 'sat') return wallet;
    var hit = unitWallets[u];
    var base = wallet ? (wallet.foxyBase || wallet) : null;
    return hit && base && hit.base === base ? hit.ready : null;
  }

  /* The connected mint's wallet for `unit`, built from what this phone
   * already knows about the mint and asking it nothing: for a phone with no
   * route that is taking or making a payment in dollars. The sat wallet for
   * 'sat'. It is the same wallet `walletIn` puts on a circuit, made without
   * one (`unitWallet` builds it from the keys the connected wallet already
   * holds, so it works offline once the mint has been seen). Rejects when
   * the mint issues no such unit, which is a refusal and never a guess. */
  function unitWalletLocal(unit) {
    var u = unitOf(unit) || 'sat';
    if (u === 'sat') {
      try { return Promise.resolve(needLocal()); } catch (e) { return Promise.reject(e); }
    }
    var no = unitRefusal(u);
    if (no) return Promise.reject(no);
    if (!wallet) return Promise.reject(new Error('No mint connected yet. Call FoxyWallet.connect() first.'));
    return unitWalletBase(u);
  }

  /* The id of the active keyset `mint` issues `unit` on, or '' when this phone
   * does not know one. */
  function unitKeysetId(unit, mint, w) {
    var u = unitOf(unit) || 'sat';
    var found = keysetsOf(mint || mintUrl, w);
    if (!found) return '';
    var sets = found;
    var ids = Object.keys(sets).filter(function (id) { return sets[id].unit === u && sets[id].active; });
    return ids[0] || '';
  }

  /* A wallet to work out fees in `unit` with, at once and with no route.
   *
   * The fee sums (`feeForInputs`, `tokenFeeFor`, `changeFor`) read the fee of
   * the wallet's own keyset, and the sat wallet's keyset is the sat one. The
   * unit wallet answers in its unit when it has been built; until then the
   * connected wallet is asked about the unit's keyset by its id, which its
   * key chain holds (cashu-ts keeps every keyset of every unit there). Null
   * when the unit's keyset is not known here. */
  function feeWalletFor(unit, w) {
    var u = unitOf(unit) || 'sat';
    var base = w || wallet;
    if (u === 'sat' || !base) return base;
    var built = unitWalletNow(u);
    if (built) return built;
    var id = unitKeysetId(u, mintOf(base), base);
    if (!id) return null;
    return {
      keysetId: id,
      keyChain: base.keyChain,
      getFeesForKeyset: function (n, k) { return base.getFeesForKeyset(n, k || id); },
      getFeesForProofs: function (l) { return base.getFeesForProofs(l); },
    };
  }

  /* The amount on a record in its own unit: `amount` where it is written,
   * and `sats` on a sat record from before amounts were (hard rule 3). */
  function amountOfRecord(rec) {
    if (!rec) return 0;
    var n = rec.amount != null ? satsOf(rec.amount) : satsOf(rec.sats);
    return isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  /* ---- the dollar price a mint is quoting ----
   *
   * No mint publishes a rate. A usd mint quote's invoice says how many msat
   * the mint wants for so many cents, and a usd melt quote says how many
   * cents it takes for an invoice of so many msat: either is the mint's
   * price at that moment. Kept in memory only, for the screens to show and
   * for sizing a swap's first quote. It never moves money. */
  var mintRates = /** @type {Object<string, { usdPerBtc: number, at: number, mint: string }>} */ ({});

  function rateFrom(cents, msat) {
    var c = Number(cents), m = Number(msat);
    if (!(c > 0) || !(m > 0)) return 0;
    // cents / 100 dollars for msat / 1e11 bitcoin
    return Math.round((c * 1e9) / m * 100) / 100;
  }

  function noteMintRate(mint, bolt11, cents) {
    var msat = 0;
    try { msat = Number(FoxyWallet.msatOf(String(bolt11 || ''))) || 0; } catch (e) { msat = 0; }
    var r = rateFrom(cents, msat);
    if (!(r > 0)) return 0;
    var m = canonicalMint(String(mint || ''));
    if (m) mintRates[m] = { usdPerBtc: r, at: Date.now(), mint: m };
    return r;
  }

  /* ---- swaps between the two units: foxy.cashu.unitswap ----
   *
   * One record per swap: { id, at, mint, from, to, total, get, amount, fee,
   * rate, mintQuote, meltQuote, state, meltLeg, mintLeg }. It is not how a swap is recovered:
   * a swap cut off anywhere is a held melt in the FROM unit and an invoice
   * record in the TO unit, and the sweeps that finish those finish it. This
   * says which two belong together, for the held amount the home screen
   * names and for the history rows. Dropped once both legs have landed. */
  function unitSwaps() {
    var l = load(K.unitSwap, []);
    return Array.isArray(l) ? l.filter(function (r) { return r && r.id; }) : [];
  }

  function putUnitSwap(rec) {
    var l = unitSwaps().filter(function (r) { return r.id !== rec.id; });
    l.push(rec);
    mustSave(K.unitSwap, l.slice(-50));
  }

  function dropUnitSwap(id) {
    var l = unitSwaps();
    var left = l.filter(function (r) { return r.id !== id; });
    if (left.length !== l.length) save(K.unitSwap, left);
  }

  /* One leg of a swap has landed ('melt' paid or given back, 'mint' claimed),
   * wherever that was noticed: the swap itself, or a sweep on a later
   * launch. Both landed, the record goes; the melt given back, it failed. */
  function unitSwapLanded(id, leg, how) {
    if (!id) return;
    var rec = unitSwaps().filter(function (r) { return r.id === id; })[0];
    if (!rec) return;
    if (leg === 'melt' && how === 'back') {
      dropUnitSwap(id);
      console.log('[foxy] swap ' + id + ': the payment did not go, so nothing was swapped');
      return;
    }
    if (leg === 'melt') rec.meltLeg = 'paid';
    if (leg === 'mint') rec.mintLeg = 'claimed';
    if (rec.meltLeg === 'paid' && rec.mintLeg === 'claimed') {
      dropUnitSwap(id);
      return;
    }
    rec.state = 'pending';
    try { putUnitSwap(rec); } catch (e) {}
  }

  /* ---- an invoice in a unit ----
   *
   * Asking the mint for a quote and writing it down are two steps: an
   * invoice writes them together (`makeQuote`), and a swap asks for its quote
   * when it shows the rate and writes it down only when the person says
   * SWAP (`askQuote`, then `keepQuote`). */

  /* The mint's quote for `amount` in `w`'s unit. Asked again on another
   * circuit after five seconds of nothing, longer at a mint that has lately
   * been slow (`askedAgain`), each asking with a
   * one-time key of its own (NUT-20), so the two share nothing the mint
   * could join them by. Resolves { q, lock, w } of the one that answered. */
  function askQuote(w, amount, memo) {
    return askedAgain(w, 'the mint’s invoice', function (via) {
      var key = quoteLock(via);
      if (key) console.log('[foxy] invoice: signed quote (NUT-20), a one-time key');
      return createQuote(via, amount, memo || '', key).then(function (made) { return { q: made, lock: key }; });
    }).then(function (won) { return { q: won.got.q, lock: won.got.lock, w: won.w }; });
  }

  /* The quote's record, in foxy.cashu.quotes, with its unit (hard rule 3)
   * and its NUT-20 key in the same write. `extra` adds fields a swap needs
   * (`swap`, `mintRate`). Throws when the write does not land: an invoice
   * whose key was lost is money the mint will not release. */
  function keepQuote(q, lock, amount, memo, unit, mint, extra) {
    var pending = load(K.quotes, []);
    var rec = /** @type {any} */ ({
      quote: q.quote, amount: amount, memo: memo || '', at: Date.now(),
      unit: unitOf(unit) || 'sat',
      expiry: Number(q.expiry) || null,
      // which mint issued it: asking another mint about this quote is a
      // 400 on every launch, forever
      mint: mint,
      // NUT-20: the key the mint will want a signature from, in this same write
      pubkey: lock ? lock.pubkey : undefined,
      privkey: lock ? lock.privkey : undefined,
      /* The invoice's payment hash. A payer's proof that they paid is a
       * preimage that hashes to this, and the invoice itself is not kept
       * once it is paid, so without this there was nothing here to hold
       * such a proof against. */
      payHash: invoicePaymentHash(q.request) || undefined,
    });
    if (extra && typeof extra === 'object') Object.keys(extra).forEach(function (k) { rec[k] = extra[k]; });
    pending.unshift(rec);
    /* Past the cap an invoice moves to an archive the sweep still checks,
     * rather than being forgotten: one paid later used to sit at the mint
     * with nothing pointing at it, and a manual claim was refused.
     *
     * Archive first, then truncate, and both must land. The quote carries its
     * NUT-20 key, and the invoice is handed to the screen next: a quote whose
     * key was lost is money the mint will not release. */
    if (pending.length > 50) {
      var older = pending.slice(50);
      mustSave(K.quotesOld, older.concat(load(K.quotesOld, [])).slice(0, 500));
      console.warn('[foxy] the unpaid invoice list is full — archived', older.length, 'older one(s)');
    }
    mustSave(K.quotes, pending.slice(0, 50));
    return rec;
  }

  function makeQuote(w, amount, memo, unit, extra) {
    return askQuote(w, amount, memo).then(function (got) {
      var rec = keepQuote(got.q, got.lock, amount, memo, unit, mintOf(w), extra);
      return { q: got.q, lock: got.lock, w: got.w, record: rec };
    });
  }

  /* Swaps this page has started, by id, so a quote is never run twice. */
  var swapsGone = /** @type {Object<string, boolean>} */ ({});

  /* The FROM leg of each swap still with the mint at `here`, in `unit`: the
   * pieces its payment holds (K.melting), out of the pile and on no row yet. */
  function unitSwapHeld(unit, here) {
    var u = unitOf(unit) || 'sat';
    var mine = {};
    unitSwaps().forEach(function (r) {
      if (recordUnit({ unit: r.from }) === u && canonicalMint(r.mint) === here && r.meltQuote) mine[r.meltQuote] = true;
    });
    var sum = 0;
    load(K.melting, []).forEach(function (e) {
      if (e && mine[e.quote] && recordUnit(e) === u) sum += sumProofs(e.proofs || []);
    });
    return sum;
  }

  /* The TO leg: the swap's invoice asked about until the mint says it is
   * paid, then claimed. Every two seconds, for half a minute at most
   * (`_swapClaimWaitMs`), slowed by a mint that has said "too many". True
   * once the claim has landed; false leaves it to `sweepQuotes`, which finds
   * the record on the next connect or return. */
  function swapClaim(tw, quoteId) {
    var until = Date.now() + (Number(FoxyWallet._swapClaimWaitMs) >= 0 && FoxyWallet._swapClaimWaitMs !== undefined
      ? Number(FoxyWallet._swapClaimWaitMs) : 30000);
    var every = Number(FoxyWallet._swapPollMs) > 0 ? Number(FoxyWallet._swapPollMs) : 2000;
    var ask = function () {
      if (!routeOpen()) return Promise.resolve(false);
      var w = tw ? onCircuit(tw, 'quote:' + quoteId) : null;
      if (!w) return Promise.resolve(false);
      return withTimeout(w.checkMintQuoteBolt11(quoteId), 20000, 'the swap’s invoice').then(function (st) {
        var s = String((st && st.state) || '').toUpperCase();
        if (s === 'PAID') return FoxyWallet.claim(quoteId).then(function () { return true; });
        if (s === 'ISSUED') return FoxyWallet.recoverIssued(quoteId).then(function () { return !quoteRecord(quoteId); });
        return null;
      }).then(function (done) {
        if (done !== null) return done;
        if (Date.now() >= until) return false;
        return new Promise(function (ok) {
          setTimeout(ok, mintBusy(mintUrl) ? Math.max(every, 5000) : every);
        }).then(ask);
      }, function (e) {
        console.warn('[foxy] swap: the invoice could not be claimed yet —', FoxyWallet.reason(e), '— left for the sweep');
        return false;
      });
    };
    return ask();
  }
