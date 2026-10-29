  /* ---- storage ------------------------------------------------------- */

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  /* What a mint held back as a routing reserve the last time it was asked.
   *
   * A melt quote is the only way to learn it, and a melt quote needs an
   * invoice for a particular amount — which is the amount we are trying to
   * work out. So the first ask used to be a probe: ask for everything, be
   * told what it really costs, then ask again for the right figure. Two
   * invoices and two melt quotes, twelve seconds over Tor on a
   * phone, to move one token.
   *
   * A mint's reserve does not change between one move and the next, so it is
   * remembered and the first ask is sized with it. The loop is still there
   * and still corrects a guess that was wrong — it is the safety net rather
   * than the mechanism now, and a move from a mint this device has never
   * moved from still costs the probe.
   *
   * Kept per mint and per size band, because a reserve is usually a
   * percentage with a floor: what a 100 sat move held back says little about
   * a 100,000 sat one.
   */
  /* ---- what a mint says about itself, briefly remembered ---------------- */

  /* A mint's info, keysets and keys, kept for a few minutes.
   *
   * Every phase of a job builds its own wallet object, and a fresh wallet
   * knows nothing about the mint — so it fetches /v1/info, /v1/keysets and
   * /v1/keys before it can do anything, three requests on three Tor circuits.
   * Moving a token between two mints does that four times: once for each mint
   * while the fee is quoted, and once for each again when the move runs a
   * minute later. Nine and a half seconds of a sixty-second move were
   * spent re-learning two mints Foxy had just learned.
   *
   * None of it is for privacy. Privacy here is circuit isolation, which does
   * not depend on asking twice, and these three answers are public and the
   * same for everybody who asks — fewer requests is marginally less for a mint
   * to correlate, not more.
   *
   * What it is for is keyset rotation: a mint retires a keyset eventually, and
   * a wallet holding a stale one would sign against a key the mint no longer
   * accepts. So this is deliberately small — the body text only, GETs only, of
   * these three paths only, in memory only, for five minutes. A relaunch knows
   * nothing. A rotation is picked up within the window, and a mint keeps an
   * old keyset live far longer than that because it has to honour the proofs
   * already out there.
   *
   * The text is kept rather than the parsed object, and re-parsed on every
   * hit: the caller is handed a fresh object it can do what it likes with,
   * and amounts keep the precision parseBody gives them.
   */
  var KEY_PATH = /\/v1\/(info|keysets|keys)(\/[A-Za-z0-9_%.-]+)?$/;
  var KEY_TTL_MS = 300000;
  var keyBodies = {};        // url -> { at, raw }
  var keyWaiting = {};       // url -> the request already on its way

  /* The key to remember this answer under, or '' for a request that is none of
   * Foxy's business to cache — every POST among them, so nothing that moves
   * money is ever served from here.
   *
   * The circuit is part of the key, and that is the whole point of it.
   *
   * An answer is only an answer to the question as it was asked, and part of
   * how it was asked is which Tor circuit carried it. Keyed by url alone, a
   * request deliberately sent on a fresh circuit — to get a SECOND and
   * INDEPENDENT answer to the same question — was handed the first circuit's
   * answer out of memory, and compared it with itself. That is exactly what
   * checkKeysetsElsewhere does to catch a mint handing this wallet keys it
   * shows nobody else, and the cache silently turned it into a check that
   * could never fail. It was patched by having that one caller
   * pass foxyFresh; this makes it true of every caller, including ones nobody
   * has written yet. Normal traffic keeps its hits: the same job stays on the
   * same circuit, so it asks under the same key.
   *
   * The url comes first so forgetMintKeys can still drop a mint by prefix,
   * every circuit's copy of it at once. A newline cannot occur in a url. */
  function cacheableKeyUrl(method, url, circuit) {
    if (String(method || 'GET').toUpperCase() !== 'GET') return '';
    var u = String(url || '');
    if (!KEY_PATH.test(u.split('?')[0])) return '';
    return u + '\n' + String(circuit || '');
  }

  /* A mint's keys, looked at before they are believed.
   *
   * NUT-01: the public keys are "hex strings of compressed public keys", and
   * the spec ships two keysets it says a wallet should reject — one key a byte
   * short, one uncompressed. cashu-ts takes both. `Keyset.verify()` counts the
   * keys, checks they are distinct, and hashes the key *strings* to see that
   * they make the id the mint claimed; nothing on that path asks whether the
   * bytes are a point on the curve. So a mint serving a broken keyset under
   * the id honestly derived from it is believed wholesale, and Foxy finds out
   * mid-swap, with money moving (found with the spec's own vectors).
   *
   * Asked here because this is the one place every answer from a mint passes
   * through, and asked before the answer is remembered, so a refused keyset is
   * never served again out of the cache. It is a no-op on every other reply:
   * only `/v1/keys` carries `keysets[].keys`.
   *
   * Both halves are needed. `pointFromHex` catches the short key and anything
   * off the curve; it takes an uncompressed key, which is a real point in the
   * form NUT-01 does not allow, so the shape is checked too. */
  var KEY_HEX = /^0[23][0-9a-f]{64}$/;
  function mintKeysProblem(parsed) {
    var sets = parsed && parsed.keysets;
    if (!Array.isArray(sets)) return '';
    for (var i = 0; i < sets.length; i++) {
      var keys = sets[i] && sets[i].keys;
      if (!keys || typeof keys !== 'object') continue;
      var amounts = Object.keys(keys);
      for (var j = 0; j < amounts.length; j++) {
        var k = String(keys[amounts[j]] || '');
        var why = '';
        if (!KEY_HEX.test(k.toLowerCase())) why = 'is not a compressed public key';
        else if (window.CashuTS && window.CashuTS.pointFromHex) {
          try { window.CashuTS.pointFromHex(k); }
          catch (e) { why = 'is not a point on the curve'; }
        }
        if (why) {
          return 'This mint sent a key that ' + why + ' (keyset '
            + String((sets[i] && sets[i].id) || '?') + ', amount ' + amounts[j]
            + '). Foxy will not use it.';
        }
      }
    }
    return '';
  }

  function cachedKeyBody(url) {
    var hit = keyBodies[url];
    if (!hit) return null;
    if (Date.now() - hit.at > KEY_TTL_MS) { delete keyBodies[url]; return null; }
    return hit.raw;
  }

  function rememberKeyBody(url, raw) {
    if (typeof raw !== 'string' || !raw) return;
    keyBodies[url] = { at: Date.now(), raw: raw };
  }

  /* The answer a GET of `url` was given on `circuit`, kept as well where a
   * read with no circuit of its own looks, for the rest of its time. For a
   * connect's keysets and keys (`loadMintOnOne`), which went with no circuit
   * of their own until they shared the connect's, and which the next
   * connect, and the reads of the mint's keys after it, found here. */
  function shareKeyBody(url, circuit) {
    var from = keyBodies[cacheableKeyUrl('GET', url, circuit)];
    var to = cacheableKeyUrl('GET', url, '');
    if (from && to) keyBodies[to] = { at: from.at, raw: from.raw };
  }

  /* Everything remembered about one mint, dropped. For a keyset error, where
   * what Foxy holds is by definition not what the mint will accept. */
  function forgetMintKeys(url) {
    var prefix = String(url || '').replace(/\/+$/, '');
    Object.keys(keyBodies).forEach(function (k) {
      if (!prefix || k.indexOf(prefix) === 0) delete keyBodies[k];
    });
  }

  function keyRequestInFlight(url) { return keyWaiting[url] || null; }

  function noteKeyRequest(url, run) {
    keyWaiting[url] = run;
    var clear = function () { if (keyWaiting[url] === run) delete keyWaiting[url]; };
    run.then(clear, clear);
  }

  function reserveBand(sats) {
    var n = Math.max(1, Math.round(Number(sats) || 0));
    return String(Math.floor(Math.log(n) / Math.log(10)));   // 0-9, 10-99, 100-999 …
  }

  function reserveSeen(host, sats) {
    var all = load(K.reserves, {});
    var seen = all && all[host + '|' + reserveBand(sats)];
    return (typeof seen === 'number' && isFinite(seen) && seen >= 0) ? seen : null;
  }

  function rememberReserve(host, sats, reserve) {
    var n = Math.round(Number(reserve));
    if (!isFinite(n) || n < 0 || n > 1e9) return;
    var all = load(K.reserves, {});
    if (!all || typeof all !== 'object') all = {};
    all[host + '|' + reserveBand(sats)] = n;
    save(K.reserves, all);
  }

  /* Never throws: a value that cannot be written (refused, or not JSON) is false. Never takes from the store's reserve:
   * that is for writes that are part of moving money (`mustSave`, `saveMoney`), and nothing cosmetic or cached does. */
  function save(key, value) {
    if (storageNewer) return false;           // written by a newer Foxy: left as it is
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  /* What a write adds to the store, at the widest WebKit could count it (two bytes a character: how a string is stored is
   * not known here), twice over: the reserve is asked for that, and a margin (`spendReserve`). */
  function writeGrowth(key, text) {
    var had = null;
    try { had = localStorage.getItem(key); } catch (e) { had = null; }
    var grow = 2 * (text.length - (had === null ? 0 : had.length)) + (had === null ? 2 * String(key).length : 0);
    return 2 * Math.max(0, grow);
  }
  function fromReserve(key, value) {
    var text;
    try { text = JSON.stringify(value); } catch (e) { return false; }
    if (typeof text !== 'string' || !spendReserve(writeGrowth(key, text))) return false;
    try { localStorage.setItem(key, text); return true; } catch (e2) { return false; }
  }

  /* A write that is part of a money step but has never thrown (a payment's history entry: `logTx`): refused, it is
   * answered from the store's reserve as a must-write is, and still never throws. */
  function saveMoney(key, value) {
    if (save(key, value)) return true;
    if (storageNewer) return false;
    return fromReserve(key, value);
  }

  /* A write that must land, or say so.
   *
   * save() answers false and every caller used to go on regardless. For a
   * history line that is survivable; for proofs and counters it is not. With
   * WebKit's store full, a swap the mint had made wrote its outputs nowhere and
   * the caller carried on as if they were kept, and a counter that did not
   * advance handed the same secrets to the next request (audit W6).
   * This throws instead, with `storageFull` set so a caller can tell it from a
   * mint's answer. `unsent` says the request never left: the counters for it
   * were not written, so nothing was asked of the mint. */
  /* A refusal is answered once by making room (`trimStore`, which lets go of
   * nothing money or a recovery needs) and writing again. Only then does it
   * throw: a full store cost a phone a payment when the one write that held
   * a token was refused with history taking the room. */
  /* `afterStep`: a write made before a request leaves, and so `unsent` if refused, that follows another step of the same
   * payment which cannot be undone (a melt's hold, written after the split that cut its pieces): the reserve answers it. */
  function mustSave(key, value, unsent, afterStep) {
    if (storageNewer) throw new Error(STORAGE_NEWER);
    if (save(key, value)) return;
    /* The store's reserve first: twice what this write adds, and a margin, is given up from it and the write tried again
     * (`fromReserve`), which is what the reserve is kept for. Not for a write made before a request leaves (`unsent`):
     * refusing that one costs nothing, and the reserve is for what cannot be refused. */
    var mayReserve = !unsent || !!afterStep;
    if (mayReserve && fromReserve(key, value)) {
      console.warn('[foxy] storage refused a write to ' + key + '; it was written from the store\u2019s reserve');
      return;
    }
    // and with all of the reserve, if what was given was not enough (a string stored wider than counted)
    if (mayReserve && reserveNow() > 0) {
      try { localStorage.removeItem(RESERVE_KEY); } catch (eR) {}
      if (save(key, value)) return;
    }
    var freed = 0;
    try { freed = trimStore(true); } catch (x) { freed = 0; }
    if (freed > 0 && save(key, value)) {
      console.warn('[foxy] storage refused a write to ' + key + '; ' + freed + ' bytes of history were let go and it was written');
      return;
    }
    console.error('[foxy] storage refused a write to ' + key + ' (' + storeBytes() + ' bytes in use), and trimming did not make room');
    var e = /** @type {any} */ (new Error(unsent ? storeFullUnsent()
      : 'Foxy could not save ecash: this phone’s storage refused the write (it is full). '
        + 'Nothing is lost; it is on record and comes back when Foxy reopens with room. ' + storeFullWay() + ' Then reopen Foxy.'));
    e.storageFull = true;
    if (unsent) e.unsent = true;
    throw e;
  }

  /* ---- room in the store ----------------------------------------------------
   *
   * WebKit gives a page's localStorage about 5 MB (5 × 2^20 bytes) for its
   * origin and refuses any write past that. Everything Foxy keeps shares it:
   * the ecash, the records that bring a lost answer back, and the history and
   * its notes, which grow with every payment. On a phone that lost a payment this way
   * the store held about 5.1 million characters: the notes' token fields
   * 2.78 million over 300 notes and the audit trail 1.4 million, and the write
   * that held a locked payment's token was the one refused.
   *
   * Measured as WebKit counts it (`webkitBytes`), and the cap is 4.5 MB of
   * that, half a megabyte short of WebKit's own: nothing that sends to a mint
   * starts unless the store is under it by the most that operation writes
   * (`STORE_ROOM`). */
  var STORE_CAP_BYTES = Math.round(4.5 * 1024 * 1024);
  /* A tap that can make a card sign or let go of pieces (a withdrawal, a payment
   * to a till, a take-back, a swap between its units): what the tap writes once
   * the card has signed (the signed pieces' row in foxy.flashcard.taken, 33 KB
   * for a withdrawal of 52 pieces, and the swap's writes after it: 45 KB at its
   * peak; tests/store-full.js prints its own card's), given 256 KB, and on top
   * of that the room the
   * swap after it is asked for at the door every request goes by: that swap
   * must never be the one refused, with the card's signature already spent. */
  var CARD_ROOM_BYTES = 256 * 1024 + 512 * 1024;
  /* The most one operation adds to the store at its peak, before its records
   * go, measured on the test mint as WebKit counts (tests/store-full.js prints
   * it): a locked send of 52 pieces, as a card's top-up is cut, 108 KB (its swap
   * record with every locked output 41 KB, the audit row 44 KB, the token 46 KB
   * in the last-token slot and as much again on its note, the pile reshaped); a
   * card top-up of 32 pieces 107 KB; a plain send 9 KB; a receive 11 KB; a
   * Lightning payment 11 KB; a claim 1.3 KB. Each kind's room is several times
   * the largest of it measured (a melt's more, since a melt can carry a card's
   * pieces), so a write well past any measured still fits. */
  /* `token`: a send that asks the mint nothing (pieces on hand, or locked ones signed on), which still writes its token
   * twice (the last-token slot and its note), its entry and its audit row: about three times the token, 140 KB for one
   * of 52 pieces and a few KB for an ordinary one. */
  /* `small`: a swap that needs little, a receive or import or reclaim, or a plain send of no locked pieces and no cut of
   * the caller's: measured 9 KB to 23 KB, and a card's signed pieces swapped in (52 pieces) 45 KB. */
  var STORE_ROOM = { swap: 512 * 1024, small: 128 * 1024, melt: 128 * 1024, mint: 64 * 1024, card: CARD_ROOM_BYTES, token: 160 * 1024 };
  var STORE_FULL_START = 'Foxy’s storage on this phone is full, so nothing was sent and your money has not moved. ';

  /* What holds the store, by what it is, in bytes as WebKit counts (`storageReport`): what clearing history would let
   * go (the entries, the audit trail, claimed tokens' text, notes with no token in them), the text of sent tokens nobody
   * is known to have claimed (kept by clearing history: it can be the only copy of money), the ecash and the records
   * that bring it back, the cards' files, the reserve, and the rest. */
  function storageReport() {
    var out = { total: 0, cap: storeCap(), reserve: reserveBytes(), clearable: 0, unclaimed: 0, unclaimedCount: 0,
                money: 0, cards: 0, other: 0, tokens: /** @type {Array<string>} */ ([]) };
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = String(localStorage.key(i) || '');
        var v = localStorage.getItem(k) || '';
        var b = webkitBytes(k) + webkitBytes(v);
        out.total += b;
        if (k === RESERVE_KEY) continue;
        if (k === K.log || k === K.audit) { out.clearable += b; continue; }
        if (k === 'foxy.txmeta') {
          var meta = null;
          try { meta = JSON.parse(v); } catch (e) { meta = null; }
          var tok = 0;
          Object.keys(meta || {}).forEach(function (h) {
            var t = meta[h] && meta[h].token;
            if (typeof t === 'string' && t) { tok += 2 * t.length; out.tokens.push(t); out.unclaimedCount += 1; }
          });
          tok = Math.min(tok, b);
          out.unclaimed += tok;
          out.clearable += b - tok;
          continue;
        }
        if (k.indexOf(K.proofs) === 0 || k === K.swaps || k === K.held || k === K.melting || k === K.outtok || k === K.quotes
            || k === K.quotesOld || k === K.onchainOut || k === K.move || k === K.carry) { out.money += b; continue; }
        if (k.indexOf('foxy.flashcard.') === 0) { out.cards += b; continue; }
        out.other += b;
      }
    } catch (e) {}
    return out;
  }
  /* The words for a store with no room, true for this store: whether clearing history would free enough (it keeps every
   * token nobody is known to have claimed, `clearHistory`), and when it would not, what holds the room and what to do. */
  function storeFullWay() {
    var r = storageReport();
    var short = Math.max(0, r.total - r.reserve + STORE_ROOM.swap + reserveSize() - Math.round(5 * 1024 * 1024));
    var mb = function (n) { return (Math.round(n / 104857.6) / 10).toFixed(1) + ' MB'; };
    if (r.clearable >= short + 64 * 1024) {
      return 'Clearing history on the History screen frees ' + mb(r.clearable) + ', which is enough, and keeps every token nobody has claimed.';
    }
    // what holds the most, said as it is
    var most = /** @type {Array<[string, number]>} */ ([['unclaimed', r.unclaimed], ['money', r.money], ['cards', r.cards], ['other', r.other]])
      .sort(function (a, b) { return b[1] - a[1]; })[0];
    var held = /** @type {Object<string, string>} */ ({
      unclaimed: 'tokens you sent that nobody has claimed (' + mb(r.unclaimed) + '): copy them from the storage card, then take them back or hand them over',
      money: 'your ecash and its records (' + mb(r.money) + '): paying some of it out makes room',
      cards: 'what this phone keeps of your cards (' + mb(r.cards) + ')',
      other: 'other data on this phone (' + mb(r.other) + ')',
    })[most[0]];
    // whether what needs little can still go: room under the cap for it, and that much of the reserve (`roomFor`'s rule)
    var small = (r.total - r.reserve + STORE_ROOM.small <= r.cap) && reserveNow() >= STORE_ROOM.small;
    return 'Clearing history would free only ' + mb(r.clearable) + '. Most of the room is held by ' + held + '.'
      + (small ? ' A small payment, a receive or a claim can still go.' : '');
  }
  function storeFullUnsent() { return STORE_FULL_START + storeFullWay() + ' Then try again.'; }

  /* Bytes in use, as WebKit counts them: every key and value (`webkitBytes`). */
  /* What WebKit counts against its quota for one string: its StorageMap adds each key's and value's size in bytes, and
   * WebKit keeps a string whose every character is at or below U+00FF in one byte a character, any other in two. The
   * wallet's keys and values are JSON of ASCII almost throughout, so this is their length; counting two bytes for every
   * character made the cap twice as strict as the store's real one, and a phone near it refused every payment. */
  var WIDE_CHAR = /[^\u0000-\u00ff]/;
  function webkitBytes(s) { return s.length * (WIDE_CHAR.test(s) ? 2 : 1); }

  function storeBytes() {
    var n = 0;
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k === null || k === undefined) continue;
        var v = localStorage.getItem(k);
        n += webkitBytes(String(k)) + webkitBytes(v || '');
      }
    } catch (e) {}
    return n;
  }

  function storeCap() {
    var t = Number(FoxyWallet && FoxyWallet._storeCap);
    return t > 0 ? t : STORE_CAP_BYTES;
  }

  /* ---- the store's reserve: room kept for what must follow a step that cannot be undone ----
   *
   * A card that has signed will not sign again, and a swap or a melt that has
   * left cannot be called back. What must be written after them (the signed
   * pieces' row, the token, the pile) rested on a predicted size and on a
   * count of bytes, and WebKit counts a string by how it is stored, which can
   * be wider than its characters. So the store keeps one standing reserve: a
   * key of plain characters as large as the largest such kind's room (a
   * card's, `STORE_ROOM.card`), written at launch and grown back whenever
   * there is room after it was spent. Nothing is written or deleted for it on
   * a payment, and nothing times it.
   *
   * A money operation starts only with the reserve whole (`roomFor`, which
   * grows it back first or refuses as never sent). When a write money depends
   * on is refused all the same (`mustSave`), the reserve is cut by what that
   * write needs and a margin, or removed, and the write tried again: WebKit
   * takes a new size as the old less what is removed plus what is added, so
   * a shrink is never refused, and the store never holds more than it did
   * with the whole reserve in it. Until it is whole again, new money
   * operations are refused before they start. Its bytes are not counted as
   * use by `roomFor`: they are room kept, not room taken. */
  var RESERVE_KEY = 'foxy.store.reserve';
  var RESERVE_MARGIN = 4096;
  // the old per-operation holds (an earlier build of this fix): dropped wherever one is found
  var HOLD_PREFIX = 'foxy.store.hold.';
  function reserveSize() { return STORE_ROOM.card; }
  function reserveNow() {
    try { var v = localStorage.getItem(RESERVE_KEY); return v ? v.length : 0; } catch (e) { return 0; }
  }
  function reserveWhole() { return reserveNow() >= reserveSize(); }
  /* Grown back towards its size where the store takes it: whole if it can be, or else as large as it will go, in halves
   * down to the smallest kind's room, so a store too full for the whole reserve still keeps what it can (`roomFor`).
   * Answers the reserve as it is now. A grow is a write like any other, so the store's own count decides. */
  function growReserve() {
    if (storageNewer) return reserveNow();
    var have = reserveNow();
    for (var size = reserveSize(); size > have && size >= STORE_ROOM.mint; size = Math.floor(size / 2)) {
      try { localStorage.setItem(RESERVE_KEY, new Array(size + 1).join('r')); return size; } catch (e) {}
    }
    return have;
  }
  /* A must-write refused: the reserve gives up `need` bytes (twice the write's growth, `writeGrowth`) and a margin, all of
   * it when that is most of it. A shrink, never refused. Whether there was anything to give. */
  function spendReserve(need) {
    var have = reserveNow();
    if (!(have > 0)) return false;
    var left = have - Math.max(0, Math.ceil(Number(need) || 0)) - RESERVE_MARGIN;
    try {
      if (left > RESERVE_MARGIN) localStorage.setItem(RESERVE_KEY, new Array(left + 1).join('r'));
      else localStorage.removeItem(RESERVE_KEY);
    } catch (e) {
      try { localStorage.removeItem(RESERVE_KEY); } catch (e2) { return false; }
    }
    console.warn('[foxy] storage: a write money depends on took ' + (have - Math.max(0, left)) + ' bytes of the store\u2019s reserve; new payments wait until it is whole again');
    return true;
  }
  function reserveBytes() { var n = reserveNow(); return n ? webkitBytes(RESERVE_KEY) + n : 0; }
  // at launch: the per-operation holds an earlier build of this fix wrote
  function dropOldHolds() {
    var keys = [];
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(HOLD_PREFIX) === 0) keys.push(k); } } catch (e) {}
    keys.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
  }
  /* The moment a step that cannot be undone is under way (a card asked to sign, a swap or a melt leaving). Nothing is
   * written: the reserve is already whole. Said for the tests, which shut the store here (`_onArm`). */
  function storeStep(what) {
    try { if (typeof FoxyWallet._onArm === 'function') FoxyWallet._onArm(what); } catch (e) {}
  }


  /* An operation that would send to a mint, asked before it does: the store
   * has room for the most it writes, or room is made, or it is refused before
   * anything leaves (`unsent`, `storageFull`), with words that say what to do.
   * `kind` is 'swap', 'melt' or 'mint'. */
  /* The rule, in one place. An operation starts when the store, its reserve left out, has room under the cap for the most
   * that kind writes (`STORE_ROOM`), and the reserve (grown back first where it can be: `growReserve`) is at least that
   * same room. So with the reserve whole every kind may start; with it partial (spent, or a store too full to hold all
   * of it) the kinds that need little still do (a claim 64 KB, a melt or a small swap 128 KB: a receive, a plain send,
   * a card's signed pieces swapped in) while a large swap or a card's tap waits; and nothing starts that its own writes
   * could not be answered for after its step.
   *
   * `inner`: the request door (`nativeRequest`) or a swap of pieces a card has already signed (`cardSwapTaken`), inside
   * an operation that asked as it began or whose step is behind it: the reserve is not asked for (and not grown back
   * here, which would take room what is under way may need), only room for the request. */
  function roomFor(kind, inner) {
    var need = STORE_ROOM[kind] || STORE_ROOM.swap;
    var cap = storeCap();
    var enough = function () {
      var used = storeBytes() - reserveBytes();
      if (used + need > cap) return false;
      return !!inner || growReserve() >= need;
    };
    if (enough()) return;
    try { trimStore(true); } catch (e) {}
    if (enough()) return;
    console.error('[foxy] storage: ' + (storeBytes() - reserveBytes()) + ' bytes in use of ' + cap + ', a ' + kind + ' needs room for '
      + need + ' more, and the reserve is ' + reserveNow() + ': refused before anything was sent');
    // and sent tokens the mint says are claimed are looked for, so that the next try may find room (`tidySentTokens`)
    roomShortAt = Date.now();
    try { tidySentTokens().then(null, function () {}); } catch (x) {}
    // and the person told what holds the room, with the unclaimed tokens to copy (`onStorageFull`)
    try {
      var tell = FoxyWallet && FoxyWallet._onStorageFull;
      if (typeof tell === 'function' && Date.now() - storageToldAt > 30000) {
        storageToldAt = Date.now();
        var report = storageReport();
        var told = /** @type {function(any): void} */ (tell);
        setTimeout(function () { try { told(Object.assign(report, { kind: kind, words: storeFullWay() })); } catch (x2) {} }, 0);
      }
    } catch (x3) {}
    var e = /** @type {any} */ (new Error(storeFullUnsent()));
    e.storageFull = true;
    e.unsent = true;
    throw e;
  }
  var storageToldAt = 0;

  /* Which of `roomFor`'s kinds a request to a mint is, or '' for one that
   * moves no money (a quote, a state check, a restore, the mint's keys). */
  var MONEY_PATH = /\/v1\/(swap|melt\/(?!quote\/)[A-Za-z0-9_-]+|mint\/(?!quote\/)[A-Za-z0-9_-]+(\/batch)?)$/;
  function moneyRequestKind(o) {
    if (!o || String(o.method || 'GET').toUpperCase() !== 'POST') return '';
    var path = String(o.endpoint || '').split('?')[0];
    var m = MONEY_PATH.exec(path);
    if (!m) return '';
    // (a swap at the door is asked for the least a swap needs: the operation sized itself as it began, `roomFor`)
    return m[1] === 'swap' ? 'small' : m[1].indexOf('melt/') === 0 ? 'melt' : 'mint';
  }

  /* Making room, from what only shows what happened and nothing that money
   * or a recovery reads.
   *
   *   foxy.txmeta (the notes on payments): a sent token's text once it is
   *     claimed (`kept`) and change handed to a payer (`changeToken`), oldest
   *     first, to their budget (`trimKeptTokens`); and a card top-up's token
   *     once every one of its pieces is in this phone's file of that card
   *     (`cardLoadOnFile`), which is what a lost card's take-back is rebuilt
   *     from (`cardRemember`, a must-write): its text becomes `kept`, shown as
   *     before and let go with the rest. Being on the card (`carded`) is not
   *     enough, and a load whose pieces are on no file keeps its text.
   *     Any other token nobody has claimed (`token`) is never touched: it can
   *     be the only copy of money.
   *   foxy.cashu.audit (what each payment consumed and produced, read by the
   *     detail screen and nothing that counts): past the newest few, rows go
   *     slim, and past its budget the oldest go (`shapeAudit`).
   *
   * Never the piles, the counters, the swap and melt records, the holds, the
   * last token, a card's owed rows or its file, or any key. Idempotent: run
   * twice, the second frees nothing. `tight` is for a store short of room:
   * the budgets are smaller. Answers the bytes freed. At launch, and whenever
   * a write or an operation needs room (`mustSave`, `roomFor`). */
  function trimStore(tight) {
    var before = storeBytes();
    try {
      var raw = localStorage.getItem('foxy.txmeta');
      var meta = raw ? JSON.parse(raw) : null;
      if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
        Object.keys(meta).forEach(function (h) {
          var m = meta[h];
          if (!m || m.to !== 'card' || m.owedChange || typeof m.token !== 'string' || !m.token) return;
          /* Only when every piece of it is in this phone's file of the card (`cardLoadOnFile`): that file is what a lost card's
           * take-back is rebuilt from, so the token's text is then only for showing. `carded` alone says the card took it,
           * not that this phone could take it back without the card, and a load on no file keeps its text. */
          if (cardLoadOnFile(m.token)) {
            m.kept = m.token;
            delete m.token;
          }
        });
        trimKeptTokens(meta, tight ? KEPT_TOKENS_TIGHT : undefined);
        var out = JSON.stringify(meta);
        if (out.length < String(raw).length) save('foxy.txmeta', meta);
      }
    } catch (e) { console.warn('[foxy] storage: the notes could not be trimmed:', e && e.message); }
    try {
      var rawA = localStorage.getItem(K.audit);
      var list = rawA ? JSON.parse(rawA) : null;
      if (Array.isArray(list) && list.length) {
        var shaped = shapeAudit(list, tight);
        if (JSON.stringify(shaped).length < String(rawA).length) save(K.audit, shaped);
      }
    } catch (e) { console.warn('[foxy] storage: the audit trail could not be trimmed:', e && e.message); }
    var freed = Math.max(0, before - storeBytes());
    if (freed > 0) console.warn('[foxy] storage: ' + freed + ' bytes of history let go' + (tight ? ' to make room' : '') + '; ' + storeBytes() + ' in use');
    return freed;
  }

  /* Proofs are per mint, and have to be: a mint's ecash is only redeemable at
   * that mint. Kept in one pile, switching mints would show a balance the new
   * mint rejects on the first send, and the change left behind by a transfer
   * would be thrown away. Keyed by mint, each pile waits where it belongs. */
  /* Iterated sha256 over salt and PIN.
   *
   * Not PBKDF2 — this file already has a verified sha256 and adding a second
   * primitive to the crypto surface for this would be a poor trade. The shape
   * is the same: a salt so two wallets with the same PIN do not share a hash,
   * and enough rounds that guessing costs something. */
  function pinHash(pin, saltHex, rounds) {
    var bytes = [];
    for (var i = 0; i < saltHex.length; i += 2) {
      bytes.push(parseInt(saltHex.substr(i, 2), 16));
    }
    var enc = new TextEncoder().encode(String(pin));
    for (var j = 0; j < enc.length; j++) bytes.push(enc[j]);
    var out = sha256(bytes);
    var n = Math.max(1, Number(rounds) || 1);
    for (var r = 1; r < n; r++) out = sha256(out);
    return out.map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  /* Which pile: the mint named, or the connected one.
   *
   * Every routine that talks to a mint names that mint's pile, taken from its
   * own wallet object (mintOf). They used to write to whichever mint was
   * connected at the moment of writing — so switching mints while a claim or a
   * payment was waiting on the mint filed one mint's proofs under another's
   * key, or replaced that mint's pile outright. */
  /* And which unit. A mint can issue ecash in more than one unit — sat, usd,
   * eur — and a proof is only worth something in its own. Sats keep the key
   * they always had, foxy.cashu.proofs.<mint>; every other unit has a pile of
   * its own beside it, foxy.cashu.proofs.<mint>@<unit>. Nothing that reads the
   * sat pile ever sees another unit's proofs, so no sat figure can count them.
   * A unit that is not a short lowercase code is refused rather than filed. */
  function unitOf(unit) {
    var s = String(unit === undefined || unit === null || unit === '' ? 'sat' : unit).trim().toLowerCase();
    return /^[a-z0-9]{1,16}$/.test(s) ? s : '';
  }

  function proofKey(url, unit) {
    var u = url === undefined ? mintUrl : url;
    var n = unitOf(unit);
    if (!n) throw new Error('Foxy does not know the unit ' + String(unit).slice(0, 20) + '.');
    if (n === 'sat') return u ? K.proofs + '.' + u : K.proofs;
    // the legacy single pile was sats; another unit always belongs to a mint
    if (!u) throw new Error('No mint named for ' + n + ' ecash.');
    return K.proofs + '.' + u + '@' + n;
  }

  function proofs(url, unit) { return load(proofKey(url, unit), []); }

  /* Throws when the write does not land (mustSave). Every caller writes the
   * pile before it clears the record that could bring the proofs back — a swap
   * record, a held melt, an invoice's outputs, the quarantine — so a pile that
   * could not be written leaves that record for the next connect to act on. */
  function setProofs(list, url, w, unit) {
    var key = proofKey(url, unit);
    /* A locked piece arriving in the pile, said once and with who brought it.
     *
     * The pile is plain ecash: everything that arrives locked is swapped first
     * or waits in the unclaimed store. One got in on a phone and the
     * diary had nothing to say about how. The call path is the
     * answer, so that is what is written — function names and nothing else. */
    try {
      var incoming = (list || []).filter(function (p) {
        return p && typeof p.secret === 'string' && p.secret.charAt(0) === '[';
      });
      if (incoming.length) {
        var had = {};
        load(key, []).forEach(function (p) { if (p && p.secret) had[p.secret] = true; });
        var fresh = incoming.filter(function (p) { return !had[p.secret]; });
        if (fresh.length) {
          var by = String(new Error().stack || '').split('\n').slice(1, 7).map(function (l) {
            var m = /at ([^\s(]+)/.exec(l) || /^([^@\s]+)@/.exec(l);
            return m ? m[1] : '';
          }).filter(Boolean).join(' < ');
          console.warn('[foxy] pile: ' + fresh.length + ' LOCKED piece(s) are being filed as plain ecash, '
            + fresh.reduce(function (n, p) { return n + satsOf(p.amount); }, 0)
            + ' sats \u2014 by ' + (by || 'an unnamed caller'));
        }
      }
    } catch (e) {}
    checkIssued(list, 'store', w);
    /* And only pieces of this pile's unit (hard rule 1, 08c-units.js): a
     * usd piece in the sat pile is cents counted as sats. Refused before the
     * write, so the record that would bring them back stays where it is. */
    var at = url === undefined ? mintUrl : url;
    if (at) unitGuard(list || [], at, unitOf(unit), w, load(key, []));
    mustSave(key, list || []);
  }

  /* Every pile in storage, as { key, mint, unit }. The legacy pile with no
   * mint is left out: it is moved under a mint on the first connect. A key
   * ending in @<code> is another unit's pile; a mint URL does not end that way
   * after its host in practice. */
  function piles() {
    var out = [];
    var pre = K.proofs + '.';
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (!key || key.indexOf(pre) !== 0) continue;
        var rest = key.slice(pre.length);
        var m = /^(https?:\/\/[^/@]+.*)@([a-z0-9]{1,16})$/.exec(rest);
        if (m && m[2] !== 'sat') out.push({ key: key, mint: m[1], unit: m[2] });
        else out.push({ key: key, mint: rest, unit: 'sat' });
      }
    } catch (e) {}
    return out;
  }

  /* The other units' piles at one mint that hold anything: [{ unit, list }]. */
  function unitPilesAt(url) {
    return piles().filter(function (p) { return p.mint === url && p.unit !== 'sat'; })
      .map(function (p) { return { unit: p.unit, list: load(p.key, []) }; })
      .filter(function (p) { return Array.isArray(p.list) && p.list.length; })
      .sort(function (a, b) { return a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0; });
  }

  /* An amount in its unit, for people. usd and eur are cents; sats are sats;
   * anything else is the number with its unit code, since guessing its scale
   * would be a lie. */
  var UNIT_MONEY = { usd: { sym: '$', code: 'USD' }, eur: { sym: '\u20ac', code: 'EUR' } };

  function unitName(unit) {
    var u = unitOf(unit) || String(unit || '');
    if (UNIT_MONEY[u]) return UNIT_MONEY[u].code;
    return u === 'sat' ? 'sat' : u.toUpperCase();
  }

  function formatAmount(amount, unit) {
    var n = Number(amount) || 0;
    var u = unitOf(unit) || String(unit || '');
    var neg = n < 0 ? '-' : '';
    var abs = Math.abs(n);
    if (u === 'sat') return neg + abs.toLocaleString('en-US') + ' sats';
    if (UNIT_MONEY[u]) {
      return neg + UNIT_MONEY[u].sym + (abs / 100).toLocaleString('en-US',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return neg + abs.toLocaleString('en-US') + ' ' + u;
  }

  /* The mint a wallet object talks to, in the form piles are keyed by. */
  function mintOf(w) {
    var u = w && ((w.mint && w.mint.mintUrl) || w.mintUrl);
    return u ? canonicalMint(u) : mintUrl;
  }

