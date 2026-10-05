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

  function save(key, value) {
    if (storageNewer) return false;           // written by a newer Foxy: left as it is
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
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
  function mustSave(key, value, unsent) {
    if (storageNewer) throw new Error(STORAGE_NEWER);
    if (save(key, value)) return;
    console.error('[foxy] storage refused a write to', key);
    var e = /** @type {any} */ (new Error(unsent
      ? 'Foxy could not write to this phone’s storage (it may be full), so nothing was sent to the mint. '
        + 'Free up space, then try again.'
      : 'Foxy could not save ecash: this phone’s storage refused the write (it may be full). '
        + 'Nothing is lost; it is on record and comes back when Foxy reopens with room. Free up space, then reopen Foxy.'));
    e.storageFull = true;
    if (unsent) e.unsent = true;
    throw e;
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

