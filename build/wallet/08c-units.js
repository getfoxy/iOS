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
    /* And the unit wallets built for the connected wallet, not those of a connect before it: a mint that has since stopped
     * listing a keyset (it no longer issues dollars, say) is taken at its word, not at what an older wallet still holds. */
    var cached = unitWallets || {};
    var conn = wallet ? (wallet.foxyBase || wallet) : null;
    Object.keys(cached).forEach(function (u) { if (cached[u] && cached[u].ready && cached[u].base === conn) fromChain(cached[u].ready); });
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
    /* A swap begun from a card's screen (26f-flashcard.js `fcSwapGo`) is that card's business: both its rows name the card, so
     * the card's history shows them and home's leaves them out. `swapCard` on the record, never `card`: a melt's hold entry
     * already has a `card`, for a payment made with a card's held pieces, which is another thing. */
    if (rec.swapCard) row.card = String(rec.swapCard);
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

  /* Whether the wallet for `unit` can be built here with nothing asked of
   * the mint, with the keys of its keyset in hand: what a phone with no
   * route needs before it takes a dollar card. Local and at once.
   *
   * `unitWallet` builds from the connected wallet's own copy of the mint's
   * keys, and falls back to asking the mint where that copy is missing,
   * which with no route is half a minute of nothing in front of a till. So
   * this asks only what is in hand: the dollar wallet already built, or the
   * connected wallet's copy, which holds every unit's keysets with their
   * keys (a connect asks the mint for all of them), and the active keyset
   * of the unit with its keys among them. Never a request. The seed is a
   * separate matter: `unitWallet` refuses until the phone has answered for
   * it, and says so in its own words. True for sats wherever there is a
   * wallet. */
  function unitKeysOffline(unit) {
    var u = unitOf(unit) || 'sat';
    if (!wallet) return false;
    var base = wallet.foxyBase || wallet;
    var built = unitWalletNow(u);
    var id = unitKeysetId(u, mintOf(base), base);
    if (!id) return false;
    if (built && keysetFor(built, id)) return true;
    if (u === 'sat') return !!keysetFor(base, id);
    var cached = null;
    try { cached = { info: base.getMintInfo().cache, keys: base.keyChain.cache }; } catch (e) { cached = null; }
    if (!cached || !cached.info || !cached.keys) return false;
    return !!keysetFor(base, id);
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
   * the record on the next connect or return.
   *
   * `paidHere`: the swap's own melt has just answered PAID for this very
   * invoice, at this same mint. A mint settles a payment between two of its
   * own quotes inside the melt, so the invoice is paid by the time the melt
   * answers, and asking first only cost a round trip over Tor. The claim is
   * then made at once. Only a refusal that says the quote is not paid yet
   * (`quoteNotPaidYet`) goes back to asking, as above; anything else is left
   * to the sweep, as a failed claim always was. Nothing about the claim
   * itself changes: its counter ranges are on the invoice's record before
   * the request leaves (`_claimOnce`), so a lost answer reads ISSUED at the
   * sweep and `recoverIssued` restores exactly those. */
  function swapClaim(tw, quoteId, paidHere) {
    var wait = function () {
      return Date.now() + (Number(FoxyWallet._swapClaimWaitMs) >= 0 && FoxyWallet._swapClaimWaitMs !== undefined
        ? Number(FoxyWallet._swapClaimWaitMs) : 30000);
    };
    var until = wait();
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
    if (!paidHere) return ask();
    if (!routeOpen()) return Promise.resolve(false);
    return FoxyWallet.claim(quoteId).then(function () { return true; }, function (e) {
      if (quoteNotPaidYet(e)) {
        console.log('[foxy] swap: the mint has not marked its invoice paid yet (' + FoxyWallet.reason(e) + ') — asking until it has');
        // the half minute starts now: a slow refusal over Tor does not eat into it
        until = wait();
        return ask();
      }
      console.warn('[foxy] swap: the invoice could not be claimed yet —', FoxyWallet.reason(e), '— left for the sweep');
      return false;
    });
  }

  /* A mint's refusal to issue for a quote it has not been paid for yet, or
   * whose payment is still going through: NUT-04's 20001 ("quote not paid")
   * and 20005 ("quote is pending"), or their words from a mint that sends no
   * code. "Invoice already paid or pending" (CDK's 20006 on used counters,
   * `mintSaysPaidOrPending`) is not one of them. */
  function quoteNotPaidYet(e) {
    var code = Number(e && (e.code || (e.response && e.response.code)));
    if (code === 20001 || code === 20005) return true;
    var m = String((e && (e.message || e.detail)) || e || '');
    if (/already paid/i.test(m)) return false;
    return /\bnot (yet )?paid\b|\bunpaid\b|not been paid|quote (is )?pending/i.test(m);
  }

  /* ---- money paid in the other unit: foxy.cashu.convert ----
   *
   * Someone who chose to hold dollars can be paid in sats: a payer with no
   * dollars, or one offline, pays a dollar request with the sats it works
   * out from its own price. Those sats are swapped into dollars at the mint
   * as soon as they are in the pile here (`convertOne`, 16b-two-balances.js).
   * The mirror holds too: someone who chose to hold bitcoin can be paid in
   * dollars (a dollar card pays cents, at this phone's price, for a sats
   * ask), and those dollars are swapped into sats the same way.
   *
   * One record per payment, by request id: { id, hash, mint, at, state,
   * from, to, sats, got, usd, asked, ask, pileAt, seq, swap, tries, triedAt,
   * gotUsd, gotTo, why }. `from` and `to` are the units: the one the money
   * came in and the one it is swapped into. A record written before they
   * were kept is sats into dollars (`convertUnits`). `sats` is what was kept
   * when it arrived and `got` what the claim really put in the pile, both in
   * the FROM unit (cents for dollars into bitcoin, whatever the names say:
   * they are kept so that the records of sats into dollars read as they
   * always did). `asked` is the figure asked for in the TO unit (cents for
   * sats into dollars, sats for dollars into bitcoin), 0 when nobody said;
   * `usd` is the same where the TO unit is dollars, and 0 otherwise. `ask`
   * is the row's fields for what was agreed (`termsFields`), kept for a
   * claim that lands after the row was written without them. `pileAt` is
   * the whole FROM pile at that mint just after the claim landed and `seq`
   * the order claims landed in: what of the pile is not this payment's is
   * `pileAt` less `got`, and that is never swapped (`convertOne`). `gotTo`
   * is what the swap gave, in the TO unit, and `gotUsd` the same where that
   * is dollars. The states:
   *
   *   owed      arrived, not in the pile yet. Never converted: only a claim
   *             that lands moves it on, so sats that never arrived (spent,
   *             never issued, let go as dust) are never swapped.
   *   claimed   in the pile; may be swapped.
   *   quoting   a rate is being asked for. A quote moves nothing, so one
   *             found on a launch goes back to claimed.
   *   swapping  the swap is running or with the mint; `swap` names it, and
   *             its rows say how it ended (`convertSettle`).
   *   done      swapped; `gotTo` (and `gotUsd`, into dollars) is what arrived.
   *   kept      deliberately left as it came: too little after the fee, the
   *             person no longer holds the other unit, or the money was spent.
   *   failed    three tries spent, or paid with no dollars to show for it.
   *             Never tried again.
   *
   * A choice carried out, never money: the sats are on their own row and
   * in the pile whatever this says, and the swap is the ordinary swap with
   * its two rows. */
  var CONVERT_KEEP = 100;
  var CONVERT_FOR_MS = 30 * 24 * 3600 * 1000;
  var CONVERT_TRIES = 3;
  /* The market a swap's rate is judged against is this phone's own last
   * price, and it has to be the market: one older than an hour is not, so
   * nothing is swapped until a newer one is in (`convertOne`). */
  var CONVERT_PRICE_MS = 3600 * 1000;
  /* Tried this page load, by id: one go each per launch, so a mint that
   * keeps refusing is not asked again on every return to the screen. */
  var convertTried = /** @type {Object<string, boolean>} */ ({});
  // the one conversion running, if any: they go one at a time
  /** @type {?Promise<any>} */
  var converting = null;

  function converts() {
    var l = load(K.convert, []);
    return Array.isArray(l) ? l.filter(function (r) { return r && typeof r.id === 'string' && r.id; }) : [];
  }

  function convertRec(id) {
    return converts().filter(function (r) { return r.id === id; })[0] || null;
  }

  /* What is kept: a hundred at most, and finished ones for thirty days. One
   * still owed is kept for as long as its payment waits to be claimed, and
   * thirty days after that. Past the hundred, finished ones go first, then
   * owed ones; one that may still be swapped, or is being swapped, never
   * goes. */
  function convertPruned(list) {
    var now = Date.now();
    var waiting = unclaimed();
    var finished = function (r) { return r.state === 'done' || r.state === 'kept' || r.state === 'failed'; };
    var out = list.filter(function (r) {
      var old = now - (Number(r.triedAt) || Number(r.at) || 0) > CONVERT_FOR_MS;
      if (!old) return true;
      if (finished(r)) return false;
      if (r.state === 'owed') return Object.prototype.hasOwnProperty.call(waiting, r.id);
      return true;
    });
    [finished, function (r) { return r.state === 'owed'; }].forEach(function (drop) {
      for (var i = 0; i < out.length && out.length > CONVERT_KEEP; ) {
        if (drop(out[i])) out.splice(i, 1); else i += 1;
      }
    });
    return out;
  }

  // in its place, so the order stays the order they arrived in
  function putConvert(rec) {
    var l = converts();
    var i = -1;
    l.forEach(function (r, n) { if (r.id === rec.id) i = n; });
    if (i >= 0) l[i] = rec; else l.push(rec);
    mustSave(K.convert, convertPruned(l));
  }

  /* The unit a person's choice of what to hold is: 'usd' for dollars, 'sat'
   * for bitcoin, and '' for both or nothing chosen, which converts nothing. */
  function holdUnit(hold) { return hold === 'dollars' ? 'usd' : hold === 'bitcoin' ? 'sat' : ''; }

  /* The units of a record: { from, to }. A record written before they were
   * kept is sats into dollars, which is all there was then. */
  function convertUnits(rec) {
    var from = rec && rec.from ? (unitOf(rec.from) || 'sat') : 'sat';
    var to = rec && rec.to ? (unitOf(rec.to) || 'usd') : (from === 'usd' ? 'sat' : 'usd');
    return { from: from, to: to };
  }

  /* Whether money paid to this request in one unit is to be swapped into
   * the other.
   *
   * Every payment to one of this phone's own requests, at the mint the phone
   * is on, in the unit the person does not hold, while they hold just the
   * other there: sats while they hold dollars, and dollars while they hold
   * bitcoin. Someone who holds both keeps what came. The person's own pick
   * wins: a request they asked in that unit on purpose, picked on CURRENCY
   * for this receive (`kept`, set by `paymentRequest`), converts only what
   * was agreed for the other (`terms.convert`). Never a share of a
   * bill, a payment being carried home, change or a card's own taking-off:
   * none of those is the person being paid. Nothing at a mint with one unit,
   * and nothing while a late claim has the phone at another mint. For sats
   * this is the rule it always was: they convert only into dollars, and only
   * for a person who holds dollars. */
  function convertDue(p) {
    if (!p) return false;
    var from = unitOf(p.unit) || 'sat';
    if (from !== 'sat' && from !== 'usd') return false;
    var choice = FoxyWallet.walletChoice();
    var to = holdUnit(choice.hold);
    if (!to || to === from) return false;
    if (claimAway) return false;
    var at = canonicalMint(String(p.mint || ''));
    if (!at || at !== canonicalMint(String(mintUrl || ''))) return false;
    if (!FoxyWallet.twoUnits(at)) return false;
    var purpose = String(p.purpose || '');
    if (/^(split|carry):/.test(purpose) || purpose === 'change' || purpose === 'card') return false;
    if (p.terms && p.terms.convert === true) return true;
    return p.kept !== true;
  }

  /* What a payment was asked for in the unit it is swapped into: cents for
   * sats into dollars, sats for dollars into bitcoin, 0 when nobody said. */
  function convertAsked(t, to) {
    var x = t || {};
    var n = to === 'usd' ? Number(x.usd) : Number(x.sats);
    return n > 0 ? Math.round(n) : 0;
  }

  /* An arrival that is not in the pile yet: owed. Answers whether a record
   * now says so. A write that does not land leaves the sats as bitcoin,
   * which is the safe way to be wrong, and never stops the payment. */
  function convertOwe(p, kept) {
    try {
      var had = convertRec(p.id);
      if (had) return had.state === 'owed';
      var from = unitOf(p.unit) || 'sat';
      var to = holdUnit(FoxyWallet.walletChoice().hold) || (from === 'usd' ? 'sat' : 'usd');
      putConvert({ id: p.id, hash: 'req-' + p.id, mint: canonicalMint(String(p.mint || '')), at: Date.now(),
                   state: 'owed', from: from, to: to, sats: Math.max(0, Math.round(Number(kept) || 0)), got: 0,
                   usd: to === 'usd' ? convertAsked(p.terms, 'usd') : 0, asked: convertAsked(p.terms, to), ask: termsFields(p.terms, from),
                   swap: '', tries: 0, triedAt: 0, gotUsd: 0, gotTo: 0, why: '' });
      return true;
    } catch (e) {
      console.warn('[foxy] money paid in the other unit could not be marked to be swapped; it stays as it came:',
                   (e && e.message) || e);
      return false;
    }
  }

  /* A claim landed: `got` of `unit` (sats when not named) is in the pile at
   * `mint`. An owed record there in that unit moves to claimed, holding no
   * more than it was kept as: a dollar claim never moves a record of sats,
   * nor the other way round. With `p` (a payment swapped in as it arrived,
   * never owed) one is made claimed from the start. Only a claim that landed
   * calls this, so only money that is really here is ever swapped. Answers
   * whether one is claimed now. */
  function convertClaimed(id, got, mint, p, unit) {
    try {
      var n = Math.max(0, Math.round(Number(got) || 0));
      var at = canonicalMint(String(mint || ''));
      if (!(n > 0) || !at) return false;
      var rec = convertRec(id);
      var u = rec ? convertUnits(rec).from : (unitOf((p && p.unit) || unit) || 'sat');
      if ((unitOf(unit) || 'sat') !== u) return false;
      /* The pile as the claim left it, and where this claim comes in the
       * order they landed: the rest of that pile was there before, or came
       * by other ways, and is not this payment's to swap. */
      var pileAt = sumProofs(proofs(at, u));
      var seq = converts().reduce(function (m, r) { return Math.max(m, Number(r.seq) || 0); }, 0) + 1;
      if (rec) {
        if (rec.state !== 'owed' || canonicalMint(String(rec.mint || '')) !== at) return false;
        rec.state = 'claimed';
        rec.got = Number(rec.sats) > 0 ? Math.min(n, Number(rec.sats)) : n;
        rec.pileAt = Math.max(pileAt, rec.got);
        rec.seq = seq;
        putConvert(rec);
        return true;
      }
      if (!p || canonicalMint(String(p.mint || '')) !== at) return false;
      var to = holdUnit(FoxyWallet.walletChoice().hold) || (u === 'usd' ? 'sat' : 'usd');
      putConvert({ id: id, hash: 'req-' + id, mint: at, at: Date.now(), state: 'claimed', from: u, to: to, sats: n, got: n,
                   usd: to === 'usd' ? convertAsked(p.terms, 'usd') : 0, asked: convertAsked(p.terms, to), ask: termsFields(p.terms, u),
                   pileAt: Math.max(pileAt, n), seq: seq, swap: '', tries: 0, triedAt: 0, gotUsd: 0, gotTo: 0, why: '' });
      return true;
    } catch (e) {
      console.warn('[foxy] money paid in the other unit could not be marked as in; it stays as it came for now:',
                   (e && e.message) || e);
      return false;
    }
  }

  /* The app is told one may be swapped now, after the call that found out
   * has finished: it decides whether this is a moment to (put away, money
   * moving, a tap under way) and asks `convertOne`. */
  function convertTell(id) {
    setTimeout(function () {
      if (typeof FoxyWallet._onConvertDue !== 'function') return;
      try { FoxyWallet._onConvertDue(id); }
      catch (e) { console.warn('[foxy] convert watcher:', e && e.message); }
    }, 0);
  }

  /* A payment still owed whose ecash the mint now says is gone.
   *
   * Two different things. If this phone took those very pieces itself (a
   * claim that landed and a page that went before it could say so;
   * `takenBefore`), the sats are in the pile: that is a claim that landed,
   * and the record moves on as one. Anyone else's doing, and nothing came
   * here: kept, and the row says so, rather than "to be swapped" for good.
   * Answers whether the record is claimed now, so the caller can tell the
   * app. */
  function convertGone(id, pieces, mint) {
    try {
      var rec = convertRec(id);
      if (!rec || rec.state !== 'owed') return false;
      var mine = takenBefore(pieces || []);
      if (mine) {
        // (the note of what was taken keeps its figure in the token's own unit, which is the record's FROM unit)
        if (!convertClaimed(id, Number(mine.sats) > 0 ? mine.sats : rec.sats, mint || rec.mint, null, convertUnits(rec).from)) return false;
        amendTx(rec.hash, Object.assign({}, rec.ask || {}, { convert: 'claimed' }));
        return true;
      }
      rec.state = 'kept';
      rec.why = 'spent';
      putConvert(rec);
      amendTx(rec.hash, { convert: 'kept', convertWhy: 'spent' });
    } catch (e) {
      console.warn('[foxy] sats paid to a dollars wallet: a payment that is gone could not be marked so:',
                   (e && e.message) || e);
    }
    return false;
  }

  /* Owed, and nothing was taken after all (the mint refused the claim, or it
   * never left): the record goes, since there is nothing to swap and never
   * will be. Only an owed one: anything later has sats behind it. */
  function convertForget(id) {
    try {
      var l = converts();
      var keep = l.filter(function (r) { return !(r.id === id && r.state === 'owed'); });
      if (keep.length !== l.length) mustSave(K.convert, keep);
    } catch (e) {
      console.warn('[foxy] sats paid to a dollars wallet: a payment that never came could not be let go:',
                   (e && e.message) || e);
    }
  }

  /* A swap of one payment's money has left the pile: what it cost, from its
   * own FROM row, comes off the pile every later claim in that unit saw.
   * Those claims counted this payment's money as not theirs, and with it
   * gone that share is smaller by as much. Earlier claims never counted it
   * and are left alone, and so are claims of the other unit, whose pile it
   * never was. A record whose swap is not found is left alone too: the
   * share then stays larger, and a later payment swaps less, never more. */
  function convertSpent(rec) {
    var u = convertUnits(rec).from;
    var rows = load(K.log, []);
    var out = (Array.isArray(rows) ? rows : []).filter(function (e) {
      return e && rec.swap && e.swap === rec.swap && e.dir === 'out' && recordUnit(e) === u && e.state !== 'failed';
    })[0];
    var n = !out ? 0 : u === 'sat' ? Math.max(0, Math.round(satsOf(out.sats) + satsOf(out.feeSats)))
      : Math.max(0, Math.round(satsOf(out.amount) + satsOf(out.feeAmount)));
    if (!(n > 0) || !(Number(rec.seq) > 0)) return;
    converts().forEach(function (r) {
      if (r.id === rec.id || !(Number(r.seq) > Number(rec.seq)) || typeof r.pileAt !== 'number') return;
      if (convertUnits(r).from !== u) return;
      if (['claimed', 'quoting', 'swapping'].indexOf(r.state) < 0) return;
      r.pileAt = Math.max(0, r.pileAt - n);
      putConvert(r);
    });
  }

  /* The fields a payment's row carries for what it was agreed for: the
   * dollars asked, the payer's price and how old it was, when that was, and
   * that price as the row's own, so the row's dollars are the dollars asked.
   * The mirror for a dollar row that was asked in sats (a dollar card paying
   * a sats ask): the sats asked and the price, and no `rate` of the row's
   * own, since a dollar row's figure is its cents. `askOwn`: the price was
   * this phone's, not the payer's (both card paths). `unit`: the row's, where
   * the caller knows it. For reading only: the books never read them
   * (16-history-lists.js). */
  function termsFields(t, unit) {
    if (!t) return {};
    var f = /** @type {any} */ ({});
    if (Number(t.usd) > 0) {
      f.usdAsked = Math.round(Number(t.usd));
      if (Number(t.rate) > 0) { f.askRate = Number(t.rate); f.rate = Math.round(Number(t.rate)); }
    } else if (Number(t.sats) > 0 && (t.payUnit === 'usd' || unitOf(unit) === 'usd')) {
      f.satsAsked = Math.round(Number(t.sats));
      if (Number(t.rate) > 0) f.askRate = Number(t.rate);
    } else return {};
    if (typeof t.ageMs === 'number') f.askAgeMs = t.ageMs;
    if (typeof t.seenAt === 'number') f.askSeenAt = t.seenAt;
    if (t.own === true) f.askOwn = true;
    return f;
  }

  /* Records whose swap ended while nobody was watching, put right from the
   * rows the swap itself wrote. A swap still with the mint is left alone.
   * A row in the TO unit with the swap's id: done. A row in the FROM unit
   * with it and none in the TO unit: the money went and nothing came, which
   * is for the person and the SWAP screen to look into, so never tried
   * again. Neither: nothing left the phone, and it may be tried again. A
   * rate being asked for when the page went away moved nothing either. */
  function convertSettle() {
    var live = {};
    FoxyWallet.unitSwapsPending().forEach(function (s) { live[s.id] = true; });
    var rows = null;
    // each read afresh: settling one can change the share of the pile a later one keeps (`convertSpent`)
    converts().map(function (r) { return r.id; }).forEach(function (id) {
      var rec = convertRec(id);
      if (!rec) return;
      if (rec.state === 'quoting') {
        rec.state = 'claimed';
        putConvert(rec);
        return;
      }
      if (rec.state !== 'swapping') return;
      if (rec.swap && live[rec.swap]) return;
      rows = rows || load(K.log, []);
      var leg = function (dir, unit) {
        return (Array.isArray(rows) ? rows : []).filter(function (e) {
          return e && rec.swap && e.swap === rec.swap && e.dir === dir && recordUnit(e) === unit && e.state !== 'failed';
        })[0] || null;
      };
      var u = convertUnits(rec);
      var toIn = leg('in', u.to);
      if (toIn) {
        rec.state = 'done';
        rec.gotTo = u.to === 'sat' ? Math.round(satsOf(toIn.sats)) : Math.round(satsOf(toIn.amount));
        if (u.to === 'usd') rec.gotUsd = rec.gotTo;
        rec.why = '';
        putConvert(rec);
        amendTx(rec.hash, u.to === 'usd' ? { convert: 'done', convertUsd: rec.gotTo, convertSwap: rec.swap }
                                         : { convert: 'done', convertSats: rec.gotTo, convertSwap: rec.swap });
        convertSpent(rec);
        console.log('[foxy] ' + balanceWord(u.from) + ' paid to a ' + balanceWord(u.to) + ' wallet: its swap finished while away, '
          + moneyWords(rec.gotTo, u.to) + ' arrived');
        return;
      }
      if (leg('out', u.from)) {
        rec.state = 'failed';
        rec.why = u.to === 'usd' ? 'paid, no dollars yet' : 'paid, no bitcoin yet';
        putConvert(rec);
        amendTx(rec.hash, { convert: 'failed' });
        convertSpent(rec);
        console.warn('[foxy] ' + balanceWord(u.from) + ' paid to a ' + balanceWord(u.to) + ' wallet: its swap paid out and no '
          + balanceWord(u.to) + ' is on record; not tried again');
        return;
      }
      rec.state = 'claimed';
      rec.swap = '';
      putConvert(rec);
      amendTx(rec.hash, { convert: 'claimed' });
    });
  }
