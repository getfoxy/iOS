  /* ---- the till: point of sale, for a keeper and a cashier -----------------
   *
   * A phone in the till can only receive and show what it took. Two roles. The
   * keeper is the phone whose money it is: it takes payments into its own
   * wallet as ever. A cashier is another Foxy, handed a CASHIER CODE by the
   * keeper: every payment it takes is locked (NUT-11) to a key of the keeper's
   * and sent to the keeper over Nostr (NIP-17), so the cashier's phone holds
   * the money only as something it cannot spend, and only until it is sent.
   *
   * The code (a "pass") is a URL, https://getfoxy.io/till#<base64url(JSON)>,
   * with { v, id, mint, unit, lock, to, exp }: `lock` is a key from the
   * keeper's seed-derived pool (`takeLockKey`, under 'till-<id>'), `to` the
   * Nostr key the keeper's phone made for this code and keeps in its Keychain,
   * `exp` when it ends, 72 hours after it was made.
   *
   * What a cashier takes is never in its pile, never in its balance, and is
   * not its money on any row: its history rows say `forKeeper`. The outbox
   * (K.tillOutbox) is the keeper's money until it is sent, and is written as
   * money is (`mustSave`). */

  var TILL_URL = 'https://getfoxy.io/till#';
  var TILL_TEXT_MAX = 2048;
  var TILL_PASS_MS = 72 * 60 * 60 * 1000;
  /* A pass from a phone whose clock runs a little ahead is still a pass; one
   * that says it lasts a week was not made by Foxy, and a cashier would be
   * sending a stranger's way for that long. */
  var TILL_PASS_SLACK_S = 10 * 60;
  /* How long a keeper keeps listening for a code, and keeps its key, after it
   * has ended; and how long a cashier keeps trying to send what it took by
   * one. The same week on both sides. A cashier sends at once when it can,
   * but a payment taken in the last minute of a code, or by a phone that then
   * spent the weekend in a drawer, is sent after the code has ended. At three
   * days a cashier went on sending to a key the keeper had already thrown
   * away, marked it sent when a relay took it, and nobody could read it
   * (review w2). The relays are asked from the oldest such code's start
   * (`tillListenNow`), so the whole week is inside what they are asked for. */
  var TILL_LISTEN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
  var TILL_SEND_UNTIL_MS = TILL_LISTEN_AFTER_MS;
  var TILL_PASSES_MAX = 4;
  var TILL_SEEN_MAX = 2000;
  /* What the keeper keeps of a delivery it cannot take yet (at another mint,
   * or with no route): fifty, and a megabyte in all. Only ecash the mint
   * signed, locked to the code's key, gets this far, so filling it costs
   * real money; a delivery past the cap is refused, not written over an
   * older one, and the relays still hold it for the next listen. At two
   * hundred unsigned bodies, anybody who had seen the QR code could push a
   * real payment out of it, and fill the store (review w3). */
  var TILL_INBOX_MAX = 50;
  var TILL_INBOX_BYTES = 1024 * 1024;
  // the most one delivery may be, in text and in pieces, before anything is read out of it
  var TILL_BODY_MAX = 64 * 1024;
  var TILL_PROOFS_MAX = 100;
  /* The relays are asked for wraps from the oldest listened code's start,
   * less NIP-59's two days of backdating; and never more than twelve days
   * back, which is what the phone takes (FoxyBridge+Till.swift `tillSince`):
   * a code's three days, a week after, and the two. */
  var TILL_BACKDATE_S = 2 * 24 * 60 * 60;
  var TILL_SINCE_MOST_S = 12 * 24 * 60 * 60;
  // a row sent is kept this long past its code's end, then goes with its proofs
  var TILL_SENT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
  var TILL_RETRY_MS = 60000;
  /* After this many tries a row is tried every quarter of an hour: a relay
   * that has refused thirty times in a row is not going to answer the next
   * minute, and a minute's cadence for a week is ten thousand circuits. */
  var TILL_TRIES_FAST = 30;
  var TILL_RETRY_SLOW = 15;

  var TILL_LOCK = /^0[23][0-9a-f]{64}$/;
  var TILL_TO = /^nprofile1[02-9ac-hj-np-z]{20,1200}$/;
  var TILL_ID = /^[0-9a-f]{16}$/;

  /* ---- the pass, as text ---- */

  function tillB64(text) {
    var bytes = new TextEncoder().encode(String(text));
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function tillUnB64(s) {
    var t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    var bin = atob(t);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  /* Whether this is a cashier code's address at all, before anything is read
   * out of it: what `classify` says 'till' to, so an expired or damaged one is
   * named as a cashier code and refused as one rather than "not a payment". */
  function tillUrlShape(text) {
    var t = String(text || '').trim();
    return t.length <= TILL_TEXT_MAX && t.indexOf(TILL_URL) === 0 && /^[A-Za-z0-9_-]{8,}$/.test(t.slice(TILL_URL.length));
  }

  /* The pass in `text`, checked, or why not: { pass } or { why }. Nothing here
   * throws, whatever it is given. */
  function tillRead(text) {
    var bad = { why: 'That is not a cashier code Foxy can read.' };
    if (typeof text !== 'string' || !tillUrlShape(text)) return bad;
    var j = null;
    try { j = JSON.parse(tillUnB64(text.trim().slice(TILL_URL.length))); } catch (e) { return bad; }
    return tillCheck(j);
  }

  function tillCheck(j) {
    var bad = { why: 'That is not a cashier code Foxy can read.' };
    if (!j || typeof j !== 'object' || Array.isArray(j)) return bad;
    if (j.v !== 1) return { why: 'That cashier code is from a newer Foxy. Update Foxy and scan it again.' };
    if (typeof j.id !== 'string' || !TILL_ID.test(j.id)) return bad;
    if (typeof j.mint !== 'string' || j.mint.length > 512 || mintUrlProblem(j.mint)) return bad;
    if (j.unit !== 'sat' && j.unit !== 'usd') return bad;
    if (typeof j.lock !== 'string' || !TILL_LOCK.test(j.lock)) return bad;
    if (typeof j.to !== 'string' || !TILL_TO.test(j.to)) return bad;
    if (typeof j.exp !== 'number' || !isFinite(j.exp) || Math.floor(j.exp) !== j.exp) return bad;
    var nowS = Math.floor(Date.now() / 1000);
    if (j.exp <= nowS) return { why: 'That cashier code has expired. Ask for a new one.' };
    if (j.exp > nowS + TILL_PASS_MS / 1000 + TILL_PASS_SLACK_S) return bad;
    return { pass: { v: 1, id: j.id, mint: canonicalMint(j.mint), unit: j.unit, lock: j.lock, to: j.to, exp: j.exp } };
  }

  function tillPassText(p) {
    return TILL_URL + tillB64(JSON.stringify({ v: 1, id: p.id, mint: p.mint, unit: p.unit, lock: p.lock, to: p.to, exp: p.exp }));
  }

  /* A question to the phone about one code, whose id is the message's own.
   *
   * `bridgeAsk` copies what it is given over the message, so `{ id }` there
   * would overwrite the id the phone answers to, and the answer would go to
   * nobody: the phone reads the code's id from the message's `id`
   * (FoxyBridge+Till.swift), and it answers that same id. So that id is the
   * code's, and the page waits under it. Two questions about one code at
   * once would share it; nothing asks them that way (`tillPassMake` asks
   * once for a fresh id, `tillForget` once as a code goes). */
  function tillAsk(action, passId, ms) {
    var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
    if (!mh) return Promise.reject(new Error('This needs the app.'));
    var id = String(passId);
    return new Promise(function (ok, no) {
      var settled = false;
      FoxyWallet._scans[id] = {
        ok: function (t) { if (!settled) { settled = true; ok(String(t)); } },
        no: function (e) { if (!settled) { settled = true; no(new Error(String((e && e.message) || e))); } }
      };
      mh.postMessage({ action: action, id: id });
      setTimeout(function () {
        if (!settled) {
          settled = true;
          if (FoxyWallet._scans[id]) delete FoxyWallet._scans[id];
          no(new Error(action + ' did not answer.'));
        }
      }, ms || 20000);
    });
  }

  /* ---- the keeper's codes ---- */

  function tillPassRows() {
    var all = load(K.tillPasses, []);
    return (Array.isArray(all) ? all : []).filter(function (r) {
      return r && typeof r === 'object' && TILL_ID.test(String(r.id)) && TILL_LOCK.test(String(r.lock))
        && TILL_TO.test(String(r.to)) && Number(r.exp) > 0 && typeof r.mint === 'string';
    });
  }

  // a code's Nostr key, gone from the Keychain; and its lock row, which a late token still finds by walking the seed
  function tillForget(row) {
    tillAsk('tillKeyDrop', row.id, 10000).then(null, function (e) {
      console.warn('[foxy] till: the phone did not drop a cashier code’s key:', (e && e.message) || e);
    });
    dropLockKey('till-' + row.id);
  }

  /* Codes past the time anything sent by them can still be read, dropped with
   * their keys. Answers what is left. */
  function tillPrune() {
    var rows = tillPassRows(), now = Date.now();
    var keep = rows.filter(function (r) { return Number(r.exp) * 1000 + TILL_LISTEN_AFTER_MS > now; });
    if (keep.length === rows.length) return rows;
    if (!save(K.tillPasses, keep)) return rows;
    rows.forEach(function (r) { if (keep.indexOf(r) < 0) tillForget(r); });
    console.log('[foxy] till: ' + (rows.length - keep.length) + ' ended cashier code(s) dropped');
    return keep;
  }

  function tillPassById(id) {
    var rows = tillPassRows();
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
    return null;
  }

  /* The unit a new code takes payments in: dollars where this phone holds
   * dollars and its mint issues them, sats otherwise. */
  function tillUnitNow(at) {
    var hold = '';
    try { hold = String(load(K.hold, '') || ''); } catch (e) { hold = ''; }
    var units = [];
    try { units = unitsOf(at); } catch (e) { units = []; }
    return (hold === 'dollars' || hold === 'both') && units.indexOf('usd') >= 0 ? 'usd' : 'sat';
  }

  // whether the connected mint honours a lock (NUT-11), read from what it said, sending nothing
  function tillMintLocks() {
    try {
      var nuts = (needLocal().getMintInfo() || {}).nuts || {};
      var n11 = nuts['11'] || nuts[11];
      return !!n11 && (n11.supported === undefined || n11.supported === true);
    } catch (e) { return false; }
  }

  // the nprofile the phone answered `tillKeyMake` with, as a bare string or in JSON
  function tillProfileOf(text) {
    var t = String(text || '').trim();
    if (t.charAt(0) === '{') {
      try { var j = JSON.parse(t); t = String((j && (j.nprofile || j.to || j.nostr)) || ''); } catch (e) { t = ''; }
    }
    return TILL_TO.test(t) ? t : '';
  }

  /* The newest code still live, or null. */
  function tillLiveNewest() {
    var now = Date.now();
    var live = tillPrune().filter(function (r) { return Number(r.exp) * 1000 > now; })
      .sort(function (a, b) { return Number(a.made) - Number(b.made); });
    return live.length ? live[live.length - 1] : null;
  }

  /* A code for a cashier. One at a time: while a code is live, asking again
   * answers that same code (its text, id and end), and a new one is made only
   * once none is. A code names no cashier, so every cashier can work by the
   * one on screen; and a code is never dropped while it is live. Each
   * opening of CASHIER CODE used to make a fresh one, and the fifth threw
   * the first away with its key while a cashier was still working by it:
   * everything that cashier took after went to a key nobody held (review
   * w2). Two asks at once share the one being made. */
  var tillMaking = null;

  function tillPassMake(opts) {
    var live = tillLiveNewest();
    if (live) {
      Promise.resolve().then(function () { return FoxyWallet.tillListen(); }).then(null, function () {});
      return Promise.resolve({ text: tillPassText(live), id: live.id, exp: live.exp });
    }
    if (tillMaking) return tillMaking;
    var run = tillPassMakeNew(opts);
    tillMaking = run;
    var done = function () { if (tillMaking === run) tillMaking = null; };
    run.then(done, done);
    return run;
  }

  function tillPassMakeNew(opts) {
    var o = opts || {};
    if (!wallet || !mintUrl) return Promise.reject(new Error('No mint connected yet. Call FoxyWallet.connect() first.'));
    var at = canonicalMint(mintUrl);
    if (!tillMintLocks()) {
      return Promise.reject(new Error(hostOf(at) + ' cannot lock a payment to this phone, so it cannot run a till with a cashier.'));
    }
    var unit = o.unit ? unitOf(o.unit) : tillUnitNow(at);
    if (unit !== 'sat' && unit !== 'usd') return Promise.reject(new Error('A till takes sats or dollars.'));
    if (unit === 'usd' && unitsOf(at).indexOf('usd') < 0) return Promise.reject(new Error(hostOf(at) + ' does not issue dollars.'));
    var raw = new Uint8Array(8);
    (window.crypto || window.msCrypto).getRandomValues(raw);
    var id = hexOf(raw);
    return primeLockPool().then(function () {
      var lock = takeLockKey('till-' + id, { unit: unit });
      if (!TILL_LOCK.test(String(lock || ''))) throw new Error('This phone could not make a key for the cashier code. Try again.');
      return tillAsk('tillKeyMake', id, 20000).then(function (text) {
        var to = tillProfileOf(text);
        if (!to) throw new Error('The phone did not make an address for the cashier code. Try again.');
        var now = Date.now();
        var row = { id: id, lock: lock, lockId: 'till-' + id, to: to, unit: unit, mint: at,
                    exp: Math.floor((now + TILL_PASS_MS) / 1000), made: now };
        var rows = tillPrune().concat([row]);
        /* Four at most, and only ever an ended one goes, oldest first, with
         * its keys. None other is live (a live one is answered again,
         * above), and with one live at a time four reach back past the week
         * a code is listened for after it ends, so this drops nothing that
         * could still arrive. */
        var gone = [];
        while (rows.length > TILL_PASSES_MAX) {
          var ended = rows.filter(function (r) { return r !== row && Number(r.exp) * 1000 <= now; });
          if (!ended.length) break;
          var pick = ended.slice().sort(function (a, b) { return Number(a.made) - Number(b.made); })[0];
          gone.push(pick);
          rows = rows.filter(function (r) { return r !== pick; });
        }
        try { mustSave(K.tillPasses, rows); }
        catch (e) { tillForget(row); throw e; }
        gone.forEach(tillForget);
        console.log('[foxy] till: a cashier code was made, ' + unit + ' at ' + hostOf(at) + ', for 72 hours');
        // and the phone listens for it from now on
        Promise.resolve().then(function () { return FoxyWallet.tillListen(); }).then(null, function () {});
        return { text: tillPassText(row), id: id, exp: row.exp };
      }, function (e) {
        dropLockKey('till-' + id);
        throw e;
      });
    });
  }

  /* ---- the keeper hears a payment ---- */

  function tillSeenList() {
    var l = load(K.tillSeen, []);
    return Array.isArray(l) ? l : [];
  }

  function tillSeenAdd(proofs) {
    var have = tillSeenList();
    (proofs || []).forEach(function (p) {
      var s = p && typeof p.secret === 'string' ? p.secret : '';
      if (s && have.indexOf(s) < 0) have.push(s);
    });
    save(K.tillSeen, have.slice(-TILL_SEEN_MAX));
  }

  function tillInboxRows() {
    var l = load(K.tillInbox, []);
    return Array.isArray(l) ? l.filter(function (r) { return r && typeof r.pass === 'string' && typeof r.body === 'string'; }) : [];
  }

  function tillInboxKey(passId, j) {
    return passId + ':' + piecesFingerprint(j.proofs || []);
  }

  // the secrets a kept body names, read again from its text
  function tillBodySecrets(body) {
    var j = null;
    try { j = JSON.parse(String(body || '')); } catch (e) { j = null; }
    var list = j && Array.isArray(j.proofs) ? j.proofs : [];
    return list.map(function (p) { return p && typeof p.secret === 'string' ? p.secret : ''; }).filter(Boolean);
  }

  /* Kept for later: the phone is at another mint, or has no route. `mustSave`,
   * because this body is the only copy of the money the phone has read: the
   * relay will send it again only while it is inside the inbox's window.
   * Kept once by its pieces, whatever id it came under; and past the cap
   * refused (a throw), never written over a row kept before it. */
  function tillInboxKeep(passId, j, body) {
    var key = tillInboxKey(passId, j);
    var rows = tillInboxRows();
    if (rows.some(function (r) { return r.key === key; })) return;
    var mine = Object.create(null);
    (j.proofs || []).forEach(function (p) { if (p && typeof p.secret === 'string') mine[p.secret] = true; });
    if (rows.some(function (r) { return tillBodySecrets(r.body).some(function (s) { return mine[s]; }); })) return;
    if (rows.length >= TILL_INBOX_MAX) throw new Error('the till’s inbox holds ' + TILL_INBOX_MAX + ' already; the relays still hold this one');
    var bytes = rows.reduce(function (n, r) { return n + r.body.length; }, 0);
    if (bytes + String(body).length > TILL_INBOX_BYTES) throw new Error('the till’s inbox is full; the relays still hold this one');
    rows.push({ key: key, pass: passId, body: body, at: Date.now() });
    mustSave(K.tillInbox, rows);
  }

  function tillInboxDrop(key) {
    var rows = tillInboxRows();
    var left = rows.filter(function (r) { return r.key !== key; });
    if (left.length !== rows.length) save(K.tillInbox, left);
  }

  /* A wallet holding `mint`'s keys, to check signatures by, asking the mint
   * nothing: the connected one at that mint (whose key chain holds every
   * unit's keysets), or one built from the keys kept on file for it
   * (`mintCacheFor`), which a keeper has for the mint it made the code at.
   * Null when neither is here. */
  var tillCheckers = {};

  function tillKeysAt(mint, unit) {
    var m = canonicalMint(mint || '');
    if (!m) return null;
    if (wallet && canonicalMint(mintUrl || '') === m) {
      var u = unitOf(unit) || 'sat';
      return u === 'sat' ? wallet : (unitWalletNow(u) || wallet);
    }
    var c = mintCacheFor(m);
    var CT = window.CashuTS;
    if (!c || !CT || !CT.Wallet || typeof CT.Wallet.prototype.loadMintFromCache !== 'function') return null;
    var hit = Object.prototype.hasOwnProperty.call(tillCheckers, m) ? tillCheckers[m] : null;
    if (hit && hit.at === c.at) return hit.w;
    try {
      var w = newWallet(m, {});
      w.loadMintFromCache(c.info, c.keys);
      tillCheckers[m] = { at: c.at, w: w };
      return w;
    } catch (e) {
      console.warn('[foxy] till: the keys kept for ' + hostOf(m) + ' would not load:', (e && e.message) || e);
      return null;
    }
  }

  /* Whether the mint turned a kept delivery down for good: a refusal it
   * gave (a 4xx, a coded error, signatures that do not verify), and not a
   * mint too busy for its own lock, which Nutshell says as a 400 and means
   * "again in a moment". Anything else (no answer, a 5xx, no route) is
   * worth another go. */
  function tillMintSaidNo(e) {
    var why = String((e && e.message) || e || '');
    if (lockBusy(why) || /database lock|no route|connection|timed? ?out|did not answer|not answering|offline|\bTor\b/i.test(why)) return false;
    if (mintRefused(e)) return true;
    return /verif|invalid|signature|unknown keyset|witness|not allowed|unbalanced|outputs? .*(signed|already)/i.test(why);
  }

  /* One payment at a time: two deliveries of the same money read in the same
   * second would otherwise both be past the seen check before either landed. */
  var tillArriving = Promise.resolve();

  function tillArrived(passId, body) {
    var run = tillArriving.then(function () { return tillArriveOne(passId, body); });
    tillArriving = run.then(function () {}, function () {});
    return run;
  }

  /* What a cashier sent, checked and taken: 'taken', 'kept' (for later),
   * 'seen' (taken already) or 'refused'. Never rejects: the phone calls this
   * and has nobody to tell.
   *
   * A CASHIER CODE is a QR code at a counter, so anybody who has seen one
   * can write to this function: its key and its Nostr address are in it.
   * So nothing is kept, and nothing is sent to the mint, until it is shown
   * to be the mint's own ecash: of the code's mint and unit by its keysets,
   * every piece carrying a DLEQ that verifies against that mint's keys, no
   * piece named twice, none seen before, and small. Only the lock was
   * checked, which anybody can write: unsigned bodies were kept, swapped
   * again on every listen, pushed real ones out of the inbox and filled the
   * store (review w3). */
  function tillArriveOne(passId, body) {
    /* A refusal drops a kept copy only once the mint itself has said no
     * (`key`, below): a check that fails here for want of something on this
     * phone (the mint's keys, say) leaves money kept before where it is. */
    var key = '';
    var refuse = function (why) {
      console.warn('[foxy] till: a payment from a cashier was not taken: ' + why);
      if (key) tillInboxDrop(key);
      return 'refused';
    };
    var id = String(passId || '');
    var pass = TILL_ID.test(id) ? tillPassById(id) : null;
    if (!pass) return refuse('no cashier code of this phone’s has that id');
    if (Number(pass.exp) * 1000 + TILL_LISTEN_AFTER_MS <= Date.now()) return refuse('that cashier code ended too long ago');
    var text = typeof body === 'string' ? body : (body && typeof body === 'object' ? JSON.stringify(body) : '');
    if (text.length > TILL_BODY_MAX) return refuse('it is larger than any payment (' + text.length + ' characters)');
    var j = null;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return refuse('it is not a payment');
    var mint = typeof j.mint === 'string' ? canonicalMint(j.mint) : '';
    if (!mint || mint !== canonicalMint(pass.mint)) return refuse('it is not at the code’s mint');
    var unit = unitOf(pass.unit) || 'sat';
    if ((unitOf(j.unit) || 'sat') !== unit) return refuse('it is not in the code’s unit');
    var proofs = Array.isArray(j.proofs) ? j.proofs.filter(function (p) { return p && typeof p === 'object'; }) : [];
    if (!proofs.length || proofs.length > TILL_PROOFS_MAX || proofs.length !== j.proofs.length) return refuse('it holds no usable proofs');
    if (repeatedProof(proofs)) return refuse('it names the same ecash more than once');
    if (!proofs.every(function (pr) {
      return typeof pr.secret === 'string' && typeof pr.C === 'string' && typeof pr.id === 'string' && satsOf(pr.amount) > 0;
    })) return refuse('it holds a proof Foxy cannot read');
    if (!proofs.every(function (pr) { return onlyLockedTo(pr, pass.lock); })) return refuse('it is not locked to the code’s key');
    var kw = tillKeysAt(mint, unit);
    if (!kw) return refuse('this phone has no keys on file for ' + hostOf(mint) + ' to check it by');
    var sets = keysetsOf(mint, kw);
    if (!sets || !proofs.every(function (pr) { return keysetUnit(mint, pr.id, kw, sets) === unit; })) {
      return refuse('its pieces are not of ' + hostOf(mint) + '’s ' + unit + ' keysets');
    }
    if (dleqAudit(kw, proofs).invalid || !mintSigned(kw, proofs)) return refuse('the mint’s signature on it does not check out');
    var seen = tillSeenList();
    if (proofs.some(function (pr) { return seen.indexOf(pr.secret) >= 0; })) {
      console.log('[foxy] till: a payment from a cashier that was taken already, read again; nothing more taken');
      tillInboxDrop(tillInboxKey(id, j));
      return 'seen';
    }
    // only at the code's own mint, with a route, and no late claim visiting elsewhere: otherwise kept for later
    if (!wallet || canonicalMint(mintUrl || '') !== mint || !routeOpen() || claimAway) {
      try { tillInboxKeep(id, j, text); }
      catch (e) { return refuse('it could not be written down (' + ((e && e.message) || e) + ')'); }
      console.log('[foxy] till: a payment from a cashier is kept until this phone is online at ' + hostOf(mint));
      return 'kept';
    }
    var token;
    try { token = encodeToken(mint, proofs, unit); }
    catch (e) { return refuse('it would not make a token'); }
    var at = tillInboxKey(id, j);
    return FoxyWallet.receiveToken(token, { till: true, memo: 'till' }).then(function (r) {
      tillSeenAdd(proofs);
      tillInboxDrop(at);
      console.log('[foxy] till: a payment from a cashier was taken in');
      return 'taken';
    }, function (e) {
      var why = String((e && e.message) || e);
      if (/already|spent/i.test(why)) {
        tillSeenAdd(proofs);
        key = at;
        return refuse('the mint has it as spent already');
      }
      // turned down by the mint for good: dropped, not asked again on every listen
      if (tillMintSaidNo(e)) {
        key = at;
        return refuse('the mint refused it (' + why.slice(0, 120) + ')');
      }
      // anything else is worth another go, on the next listen at this mint
      try { tillInboxKeep(id, j, text); } catch (eK) {}
      console.warn('[foxy] till: a payment from a cashier could not be taken yet, kept to try again:', why);
      return 'kept';
    });
  }

  // what was kept for later, taken now if this phone is where it can be
  function tillDrain() {
    var rows = tillInboxRows();
    if (!rows.length || !wallet || !routeOpen()) return Promise.resolve(0);
    var here = canonicalMint(mintUrl || '');
    var took = 0;
    return rows.reduce(function (chain, r) {
      var pass = tillPassById(r.pass);
      if (!pass || canonicalMint(pass.mint) !== here) return chain;
      return chain.then(function () {
        return tillArrived(r.pass, r.body).then(function (got) { if (got === 'taken') took += 1; });
      });
    }, Promise.resolve()).then(function () { return took; });
  }

  /* ---- the cashier ---- */

  function tillCashierRaw() {
    var row = load(K.tillCashier, null);
    if (!row || typeof row !== 'object' || !row.pass) return null;
    var c = tillCheck(row.pass);
    return c.pass ? { pass: c.pass, since: Number(row.since) || 0 } : { pass: null, since: 0, ended: true };
  }

  function tillClear(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  /* The till this phone works as a cashier, or null. A code that has ended
   * clears itself here and the phone goes home (`tillLeave`). */
  function tillCashierNow() {
    var row = tillCashierRaw();
    if (!row) return null;
    if (!row.pass) {
      /* The row goes; the trip back to this phone's own mint does not start
       * here. It did, and this is asked in the middle of taking a payment
       * (`tillTermsFor`, as the receive screen renews its invoice), so the
       * mint changed under a payment being paid. The screen asks `tillLeave`
       * itself, once nothing is on screen (26m-till.js `tillTick`). */
      console.log('[foxy] till: the cashier code has ended');
      tillClear(K.tillCashier);
      return null;
    }
    return row;
  }

  /* The key a till request or invoice is locked to, for the code this phone
   * works by, in its unit, at its mint: or a throw that says what is wrong. */
  function tillTermsFor(lockPub, unit, at) {
    var row = tillCashierNow();
    if (!row || !row.pass) throw new Error('This phone is not working a till.');
    var pass = row.pass;
    if (String(lockPub || '').toLowerCase() !== pass.lock) throw new Error('That key is not the till’s.');
    if ((unitOf(unit) || 'sat') !== pass.unit) throw new Error('This till takes ' + balanceWord(pass.unit) + ' only.');
    if (canonicalMint(at || '') !== pass.mint) throw new Error('This till takes payments at ' + hostOf(pass.mint) + ' only.');
    if (!tillMintLocks()) throw new Error(hostOf(pass.mint) + ' cannot lock a payment to the keeper, so this till cannot take it.');
    return pass;
  }

  // the open request's lock, for a till request: what `lockPubFor` answers when no row of this phone's names one
  function tillRequestLock(id) {
    var open = id && Object.prototype.hasOwnProperty.call(openRequests, id) ? openRequests[id] : null;
    var k = open && typeof open.tillLock === 'string' ? open.tillLock.toLowerCase() : '';
    return TILL_LOCK.test(k) ? k : '';
  }

  /* ---- the cashier's outbox ---- */

  function tillOutboxRows() {
    var l = load(K.tillOutbox, []);
    return Array.isArray(l) ? l.filter(function (r) { return r && typeof r === 'object' && Array.isArray(r.proofs); }) : [];
  }

  function tillOutboxHolds(proofs) {
    var have = {};
    tillOutboxRows().forEach(function (r) { r.proofs.forEach(function (p) { if (p && p.secret) have[p.secret] = true; }); });
    return (proofs || []).some(function (p) { return p && have[p.secret]; });
  }

  /* Rows sent long enough ago go, with their proofs: past a week after the
   * code ended nobody will ask this phone for them again. Unsent rows are
   * money and stay, however old. */
  function tillOutboxTidy(rows) {
    var now = Date.now();
    return rows.filter(function (r) {
      return !r.sentAt || !(Number(r.exp) > 0) || Number(r.exp) * 1000 + TILL_SENT_KEEP_MS > now;
    });
  }

  function tillOutboxAdd(o) {
    var rows = tillOutboxTidy(tillOutboxRows());
    var n = 1;
    rows.forEach(function (r) { if (r.passId === o.passId && Number(r.n) >= n) n = Number(r.n) + 1; });
    var row = { n: n, passId: String(o.passId || ''), to: String(o.to || ''), mint: canonicalMint(o.mint || ''),
                unit: unitOf(o.unit) || 'sat', amount: Math.round(satsOf(o.amount)), proofs: o.proofs,
                hash: String(o.hash || ''), exp: Number(o.exp) || 0, at: Date.now(), sentAt: null, tries: 0 };
    rows.push(row);
    mustSave(K.tillOutbox, rows);
    return row;
  }

  // the cashier's row: in, and the keeper's money, never this phone's
  function tillLogIn(hash, amount, unit, mint, passId) {
    logTx(unitRow(unit, {
      dir: 'in', sats: Math.round(Number(amount) || 0), feeSats: 0, settled: true, state: 'success',
      memo: 'till', hash: hash, mint: canonicalMint(mint || ''),
      till: true, who: 'cashier', tillSent: false, tillPass: passId,
      /* Not this phone's money: it went to the keeper. Whatever adds up this
       * phone's books leaves a row that says this out. */
      forKeeper: true,
    }));
  }

  function tillHistoryChanged() {
    if (typeof FoxyWallet._onHistoryChanged === 'function') {
      try { FoxyWallet._onHistoryChanged(); } catch (x) {}
    }
  }

  /* Whether a row is still to be sent: not sent, and not given up on. */
  function tillUnsent(r) { return !r.sentAt && !r.stranded; }

  /* Past the week after its code ended the keeper has thrown the code's key
   * away (`TILL_LISTEN_AFTER_MS`), and what is sent to it is read by nobody.
   * Such a row is not sent, and not marked sent either: it stays, with its
   * proofs, as `stranded`. They are locked to the keeper's key, so they are
   * still the keeper's money, handed over another way. */
  function tillOverdue(r) {
    return Number(r.exp) > 0 && Number(r.exp) * 1000 + TILL_SEND_UNTIL_MS <= Date.now();
  }

  function tillTried(r) {
    var rows = tillOutboxRows();
    rows.forEach(function (x) { if (x.passId === r.passId && x.n === r.n) x.tries = (Number(x.tries) || 0) + 1; });
    save(K.tillOutbox, rows);
  }

  /* Every unsent row sent, one at a time. Shared while it runs. A row is
   * marked sent only when a relay took it; a failure counts a try and stays,
   * and so does a row with no route to send it by. While rows are left, once
   * more a minute, route or no route (one timer, gone when nothing is left
   * to send: no poller outlives its work); and at once when the route comes
   * back (`tillOnRoute`). A row with no route was skipped with no try
   * counted and no timer armed, and nothing sent it when Tor came back in
   * the same session: the keeper's money waited for the cashier's next
   * launch (review w6). */
  var tillSending = null;
  var tillRetryTimer = null;

  function tillDeliverAll() {
    if (tillSending) return tillSending;
    var sent = 0;
    var run = Promise.resolve().then(function () {
      var unsent = tillOutboxRows().filter(tillUnsent);
      return unsent.reduce(function (chain, r) {
        return chain.then(function () {
          if (tillOverdue(r)) {
            var all = tillOutboxRows();
            all.forEach(function (x) { if (x.passId === r.passId && x.n === r.n) x.stranded = true; });
            save(K.tillOutbox, all);
            if (r.hash) amendTx(r.hash, { tillStranded: true });
            tillHistoryChanged();
            console.warn('[foxy] till: a payment for the keeper was not sent within a week of its code ending; kept, locked to the keeper');
            return null;
          }
          if (!routeOpen()) { tillTried(r); return null; }
          var body = JSON.stringify({ id: 'till:' + r.passId + ':' + r.n, mint: r.mint, unit: r.unit, proofs: r.proofs, memo: 'till' });
          return deliverOverNostr(r.to, body).then(function () {
            var rows = tillOutboxRows();
            rows.forEach(function (x) { if (x.passId === r.passId && x.n === r.n) x.sentAt = Date.now(); });
            mustSave(K.tillOutbox, tillOutboxTidy(rows));
            if (r.hash) amendTx(r.hash, { tillSent: true });
            sent += 1;
            tillHistoryChanged();
          }, function (e) {
            tillTried(r);
            console.warn('[foxy] till: a payment for the keeper was not sent yet:', (e && e.message) || e);
          });
        });
      }, Promise.resolve());
    }).then(function () {
      tillRetryArm();
      return sent;
    });
    tillSending = run;
    var done = function () { if (tillSending === run) tillSending = null; };
    run.then(done, done);
    return run;
  }

  function tillRetryArm() {
    if (tillRetryTimer) { clearTimeout(tillRetryTimer); tillRetryTimer = null; }
    var left = tillOutboxRows().filter(tillUnsent);
    if (!left.length) return;
    var ms = Number(FoxyWallet._tillRetryMs) > 0 ? Number(FoxyWallet._tillRetryMs) : TILL_RETRY_MS;
    if (left.every(function (r) { return Number(r.tries) >= TILL_TRIES_FAST; })) ms *= TILL_RETRY_SLOW;
    tillRetryTimer = setTimeout(function () {
      tillRetryTimer = null;
      tillDeliverAll().then(null, function () {});
    }, ms);
  }

  function tillDeliverSoon() {
    setTimeout(function () { tillDeliverAll().then(null, function () {}); }, 0);
  }

  // the route has come back (`_privacy`, 11-routing.js): what is waiting goes now, not at the next minute
  function tillOnRoute() {
    try { if (tillOutboxRows().some(tillUnsent)) tillDeliverSoon(); }
    catch (e) { console.warn('[foxy] till: sending on the route’s return:', (e && e.message) || e); }
  }

  /* ---- the same ecash by two doors at once ---- */

  /* The secrets of what is being taken right now, by a request, a scan or a
   * claim, until it is in the outbox or refused. The outbox is looked at
   * before the mint is asked whether the ecash is unspent, and nothing else
   * stood between that look and the outbox write: one payment posted to two
   * open requests at the same moment passed both, was PAID on both screens
   * and written twice, and the keeper got it once (review w1). Answers the
   * release, or null when any of them is being taken already. */
  var tillInFlight = Object.create(null);

  function tillHold(proofs) {
    var secrets = (Array.isArray(proofs) ? proofs : [])
      .map(function (p) { return p && typeof p.secret === 'string' ? p.secret : ''; }).filter(Boolean);
    if (secrets.some(function (s) { return tillInFlight[s]; })) return null;
    secrets.forEach(function (s) { tillInFlight[s] = true; });
    var let_go = false;
    return function () {
      if (let_go) return;
      let_go = true;
      secrets.forEach(function (s) { delete tillInFlight[s]; });
    };
  }

  var TILL_IN_FLIGHT = 'That ecash is being taken already.';

  /* ---- what a cashier takes: locked to the keeper, signed, unspent ---- */

  /* '' when these proofs may be taken for the keeper, or the sentence that
   * says why not. The mint is asked whether they are unspent, so with no
   * route nothing is taken: a cashier cannot tell a copy already spent from
   * a good one, and the keeper would be the one short. */
  function tillAccept(dw, proofs, lock) {
    var list = Array.isArray(proofs) ? proofs : [];
    if (!list.length) return Promise.resolve('That payment holds no usable proofs.');
    if (repeatedProof(list)) return Promise.resolve('That payment names the same ecash more than once.');
    if (!list.every(function (pr) { return onlyLockedTo(pr, lock); })) {
      return Promise.resolve('That ecash is not locked to the keeper, so this till cannot take it. Pay the request on screen.');
    }
    if (dleqAudit(dw, list).invalid) {
      return Promise.resolve('That ecash’s signatures do not match the keys this mint publishes, so it was not taken.');
    }
    if (!mintSigned(dw, list)) return Promise.resolve('That ecash carries no signature this phone can check, so this till cannot take it.');
    if (tillOutboxHolds(list)) return Promise.resolve('This till has taken that ecash already.');
    if (!routeOpen()) return Promise.resolve('This till needs a connection to take that.');
    var cw = dw;
    try { cw = onCircuit(dw, 'till:check') || dw; } catch (e) { cw = dw; }
    return statesOf(cw, list).then(function (states) {
      if (allUnspent(states)) return '';
      if (states.indexOf('PENDING') >= 0) return 'That ecash is being spent right now, so it was not taken.';
      return 'That ecash has been spent already, so it was not taken.';
    }, function () {
      return 'This till could not ask the mint about that ecash, so it was not taken. Try again.';
    });
  }

  /* A payment to a till request (`_requestPaid`, purpose 'till'): read by
   * `readPayment` already, so it is for this request, at its mint, in its
   * unit and not short. Exact, or over on purpose (`overpaid`): a till makes
   * no change. Accepted, it goes to the outbox, never the pile.
   *
   * A refusal over a tap whose ecash is still the payer's goes back to it
   * as the main path's does (`refundRefused`, given `body` and `over`):
   * which takes plain ecash only, so what is locked to the keeper is never
   * swapped here. */
  function tillRequestPaid(p, answer, body, over) {
    var pu = unitOf(p.unit) || 'sat';
    var dw = pu === 'sat' ? wallet : (unitWalletNow(pu) || wallet);
    var said = function (n) { return pu === 'sat' ? n + ' sats' : moneyWords(n, pu); };
    var kept = Math.max(0, Math.round(satsOf(p.amount) - (Number(p.inFee) || 0)));
    var tell = function (stage, more) {
      FoxyWallet._requestPaidListeners.forEach(function (fn) {
        try {
          fn(Object.assign({ stage: stage, unit: pu, amount: kept, sats: pu === 'sat' ? kept : 0, id: p.id, purpose: 'till',
                             asked: p.asked, till: true, convert: false }, more || {}));
        } catch (e) { console.warn('[foxy] request paid listener:', e && e.message); }
      });
    };
    if (FoxyWallet._requestsBeingPaid[p.id]) { answer(409, 'That request is being paid already.'); return Promise.resolve(false); }
    FoxyWallet._requestsBeingPaid[p.id] = true;
    var release = null;
    /* `back`: the ecash is still the payer's (422, and not for want of a
     * route or of room here), so a tap's goes back to it. */
    var no = function (status, why, back) {
      if (release) release();
      delete FoxyWallet._requestsBeingPaid[p.id];
      console.warn('[foxy] till: a payment was refused: ' + why);
      tell('failed', { amount: 0, sats: 0, refused: why });
      answer(status, why);
      if (back && over === 'tap') refundRefused(body, refundable(new Error(why)));
      return false;
    };
    var lock = tillRequestLock(p.id);
    var open = openRequests[p.id] || {};
    if (!lock || !open.tillPass || !TILL_TO.test(String(open.tillTo || ''))) {
      return Promise.resolve(no(422, 'This till has nothing on file for that request. Ask for a new one.', true));
    }
    if (Number(p.asked) > 0 && kept > Number(p.asked) && !p.overpaid) {
      return Promise.resolve(no(422, 'This till cannot give change. Send exactly ' + said(Number(p.asked)) + '.', true));
    }
    // the same ecash at another request, or scanned, at this moment: one of them takes it
    release = tillHold(p.proofs);
    if (!release) return Promise.resolve(no(409, TILL_IN_FLIGHT));
    tell('arrived');
    var checking;
    try { checking = tillAccept(dw, p.proofs, lock); } catch (e) { checking = Promise.reject(e); }
    return checking.then(function (why) {
      /* 409 where the ecash is gone or taken already: the payer reads it as
       * not confirmed and watches its token, as for any payment the mint has
       * as spent (`_requestPaid`). 422 is "not taken, still yours". */
      if (why) {
        var gone = /spent|taken that ecash already/.test(why);
        return no(gone ? 409 : 422, why, !gone && !/needs a connection|could not ask/.test(why));
      }
      var hash = 'till-' + p.id;
      try {
        tillOutboxAdd({ proofs: p.proofs, mint: p.mint, unit: pu, amount: kept, to: open.tillTo, passId: open.tillPass,
                        exp: open.tillExp, hash: hash });
      } catch (e) {
        console.error('[foxy] till: a payment could not be written down; refusing it:', (e && e.message) || e);
        return no(422, 'This phone could not write the payment down, so it was not taken. Try again.');
      }
      release();
      try { tillLogIn(hash, kept, pu, p.mint, open.tillPass); }
      catch (e) { console.warn('[foxy] till: the history row for a payment could not be written:', (e && e.message) || e); }
      delete FoxyWallet._requestsBeingPaid[p.id];
      dropOpenRequest(p.id);
      answer(200, '');
      console.log('[foxy] till: ' + said(kept) + ' taken for the keeper, locked to the keeper; sending');
      tell('paid', { result: { till: true, hash: hash } });
      tillDeliverSoon();
      return true;
    }, function (e) {
      return no(422, 'This till could not check that ecash, so it was not taken. Try again. (' + String((e && e.message) || e).slice(0, 80) + ')');
    });
  }

  /* ---- a cashier's invoice ---- */

  // the outputs a till claim is about to ask for, on its quote's record before the request leaves
  function tillQuoteNote(quoteId, rows) {
    [K.quotes, K.quotesOld].forEach(function (key) {
      var list = load(key, []);
      var hit = false;
      list.forEach(function (e) { if (e && e.quote === quoteId) { e.tillLocked = rows; hit = true; } });
      if (hit) mustSave(key, list);
    });
  }

  /* The claim, with outputs locked to the keeper (cashu-ts: the fourth
   * argument of mintProofsBolt11 is the output type, and a P2PK one names the
   * key; the third carries only the NUT-20 private key). Its outputs are
   * random, not from this seed, so they are written on the quote's record
   * before the request leaves (`watchLockedOutputs`), and a lost answer is
   * rebuilt from them (`restoreLocked`). */
  function tillMintLocked(w, entry, quoteId) {
    var stop = watchLockedOutputs(function (made) {
      var rows = made.map(lockedRow);
      if (rows.some(function (r) { return !r; })) throw new Error('a till output could not be written down');
      tillQuoteNote(quoteId, rows);
    });
    var asked;
    try {
      asked = Promise.resolve(w.mintProofsBolt11(entry.amount,
        entry.pubkey ? { quote: quoteId, pubkey: entry.pubkey } : { quote: quoteId },
        entry.privkey ? { privkey: entry.privkey } : undefined,
        { type: 'p2pk', options: { pubkey: String(entry.lockPub).toLowerCase() } }));
    } catch (e) { asked = Promise.reject(e); }
    asked.then(stop, stop);
    return asked;
  }

  /* Landed: to the outbox, the quote's record gone, a row, and sent. Nothing
   * in the pile. `drop` takes the record off. Proofs the outbox already holds
   * (a landing whose record could not be dropped, found again) are not added
   * twice. */
  function tillQuoteLanded(w, entry, quoteId, unit, fresh, drop) {
    var got = sumProofs(fresh);
    var at = mintOf(w);
    if (!fresh.every(function (pr) { return onlyLockedTo(pr, entry.lockPub); })) {
      console.error('[foxy] till: the mint signed an invoice’s ecash that is not all locked to the keeper; it is sent as it is');
    }
    /* Held while it is written, as a request's and a scan's are (`tillHold`).
     * Held elsewhere, the record is kept and the claim asked about again,
     * when the outbox has it and this adds nothing. */
    var free = tillHold(fresh);
    if (!free) throw new Error(TILL_IN_FLIGHT + ' The invoice is asked about again on the next connection.');
    var already;
    try {
      already = tillOutboxHolds(fresh);
      if (!already) {
        tillOutboxAdd({ proofs: fresh, mint: at, unit: unit, amount: got, to: entry.tillTo, passId: entry.tillPass,
                        exp: entry.tillExp, hash: quoteId });
      }
    } finally { free(); }
    drop();
    noteClaimed(quoteId, got);
    if (!already) {
      try { tillLogIn(quoteId, got, unit, at, entry.tillPass); }
      catch (e) { console.warn('[foxy] till: the history row for an invoice could not be written:', (e && e.message) || e); }
      console.log('[foxy] till: an invoice was paid, ' + formatAmount(got, unit) + ' locked to the keeper; sending');
    }
    tillDeliverSoon();
    return got;
  }

  // `_claimOnce` for a till invoice (`entry.lockPub`), inside the proof lock as every claim is
  function tillClaimQuote(w, entry, quoteId, archived, unit) {
    if (!TILL_LOCK.test(String(entry.lockPub || '').toLowerCase()) || !TILL_TO.test(String(entry.tillTo || ''))) {
      return Promise.reject(new Error('This till invoice has no keeper on file, so it was not claimed.'));
    }
    var drop = function () {
      save(K.quotes, load(K.quotes, []).filter(function (q) { return q.quote !== quoteId; }));
      if (archived) save(K.quotesOld, load(K.quotesOld, []).filter(function (q) { return q.quote !== quoteId; }));
    };
    var earlier = Array.isArray(entry.tillLocked) && entry.tillLocked.length ? entry.tillLocked : null;
    var first = earlier ? restoreLocked(w, { locked: earlier }) : Promise.resolve(null);
    return first.then(function (back) {
      if (back && back.length) {
        console.log('[foxy] till: an invoice’s earlier claim was signed and its answer lost; rebuilt');
        return back;
      }
      if (!earlier) return tillMintLocked(w, entry, quoteId);
      /* A claim went before and nothing could be rebuilt. Asked again only
       * if the mint still says PAID: an ISSUED quote whose outputs could not
       * be read back is asked about on the next connection, not claimed
       * afresh over the top of them. */
      return quoteStillPaid(w, quoteId)().then(function (paid) {
        if (!paid) throw new Error('This till invoice was claimed and the answer was lost; it is asked about again on the next connection.');
        return tillMintLocked(w, entry, quoteId);
      });
    }).then(function (fresh) {
      return tillQuoteLanded(w, entry, quoteId, unit, fresh, drop);
    });
  }

  // `recoverIssued` for a till invoice: rebuilt from the outputs on its record, or left for the next connection
  function tillRecoverQuote(w, found, quoteId, unit) {
    var entry = found.entry;
    var rows = Array.isArray(entry.tillLocked) ? entry.tillLocked : [];
    if (!rows.length) {
      console.log('[foxy] till: an invoice is ISSUED with no outputs on record; dropped');
      dropQuoteRecord(found);
      return Promise.resolve(0);
    }
    return restoreLocked(w, { locked: rows }).then(function (back) {
      if (!back || !back.length) {
        console.warn('[foxy] till: an issued invoice’s outputs could not be rebuilt yet; asked again on the next connection');
        return 0;
      }
      return tillQuoteLanded(w, entry, quoteId, unit, back, function () { dropQuoteRecord(found); });
    });
  }

  /* ---- a token scanned or pasted at the till ---- */

  function tillTake(text) {
    var row = tillCashierNow();
    if (!row || !row.pass) return Promise.reject(new Error('This phone is not working a till.'));
    var pass = row.pass;
    var tok = null;
    try { tok = FoxyWallet.tokenInfo(text); } catch (e) { tok = null; }
    if (!tok) return Promise.reject(new Error('That is not a Cashu token.'));
    var unit = unitOf(tok.unit);
    if (canonicalMint(tok.mint || '') !== pass.mint) {
      return Promise.reject(new Error('That ecash is from ' + hostOf(tok.mint || '') + '; this till takes ecash at ' + hostOf(pass.mint) + '.'));
    }
    if (unit !== pass.unit) return Promise.reject(new Error('This till takes ' + balanceWord(pass.unit) + ' only.'));
    if (!wallet || canonicalMint(mintUrl || '') !== pass.mint) {
      return Promise.reject(new Error('This phone is not at the till’s mint yet. Try again in a moment.'));
    }
    var proofs = tok.proofs || [];
    if (wrongUnitPieces(proofs, pass.mint, unit, wallet).length) {
      return Promise.reject(new Error('That token says ' + balanceWord(unit) + ' but holds another unit’s ecash, so it was not taken.'));
    }
    var hash = 'till-' + piecesFingerprint(proofs);
    if (txSeen(hash)) return Promise.reject(new Error('This till has taken that ecash already.'));
    var dw = unit === 'sat' ? wallet : (unitWalletNow(unit) || wallet);
    // the same ecash posted to a request at this moment: one of them takes it (`tillHold`)
    var held = tillHold(proofs);
    if (!held) return Promise.reject(new Error(TILL_IN_FLIGHT));
    var free = held;
    var checking;
    try { checking = tillAccept(dw, proofs, pass.lock); } catch (e) { checking = Promise.reject(e); }
    return checking.then(function (why) {
      if (why) throw new Error(why);
      var fee = 0;
      try { fee = swapFeeFor(dw, proofs); } catch (e) { fee = 0; }
      var kept = Math.max(0, Math.round(sumProofs(proofs) - fee));
      try {
        tillOutboxAdd({ proofs: proofs, mint: pass.mint, unit: unit, amount: kept, to: pass.to, passId: pass.id, exp: pass.exp, hash: hash });
      } finally { free(); }
      try { tillLogIn(hash, kept, unit, pass.mint, pass.id); }
      catch (e) { console.warn('[foxy] till: the history row for a token could not be written:', (e && e.message) || e); }
      console.log('[foxy] till: a token was taken for the keeper; sending');
      tillDeliverSoon();
      return { sats: unit === 'sat' ? kept : 0, unit: unit, amount: kept, mint: pass.mint, host: hostOf(pass.mint),
               hash: hash, switched: false, till: true };
    }).then(null, function (e) { free(); throw e; });
  }

  /* After a connect, and on the way back from the background: what the
   * cashier still has to send goes, and the keeper listens and takes what
   * was kept for this mint. Neither waits on the other, nor is waited on. */
  function tillCatchUp() {
    try {
      if (tillOutboxRows().some(tillUnsent)) tillDeliverAll().then(null, function () {});
      if (tillPassRows().length || tillInboxRows().length) {
        Promise.resolve().then(function () { return FoxyWallet.tillListen(); }).then(null, function () {});
      }
    } catch (e) {
      console.warn('[foxy] till: catching up failed:', (e && e.message) || e);
    }
  }

  /* ---- listening, joining, leaving ---- */

  /* The keeper's phone told to listen on every code whose payments can still
   * arrive, newest four (the phone takes no more), then what was kept for this
   * mint taken. Shared while it runs; called again, it asks the phone again,
   * which closes the set it had and opens this one: so a call after the phone
   * closed them for the background opens them again. */
  var tillListenRun = null;

  /* The oldest wrap the relays are asked for, in unix seconds: the start of
   * the oldest code listened on, less NIP-59's two days of backdating, and
   * never further back than the phone takes. The phone asked for five days
   * back from whenever it opened, so a keeper first back four days after a
   * code was made missed its first day's sales, though the page still
   * listened for them (review w4). */
  function tillSinceFor(rows) {
    var nowS = Math.floor(Date.now() / 1000);
    var oldest = nowS;
    (rows || []).forEach(function (r) {
      var made = Number(r.made) > 0 ? Math.floor(Number(r.made) / 1000) : Number(r.exp) - TILL_PASS_MS / 1000;
      if (made > 0 && made < oldest) oldest = made;
    });
    // a few minutes inside the phone's bound, so a clock a second on does not throw the whole answer out
    return Math.min(nowS, Math.max(oldest - TILL_BACKDATE_S, nowS - TILL_SINCE_MOST_S + 300));
  }

  function tillListenNow() {
    if (tillListenRun) return tillListenRun;
    var rows = tillPrune().slice().sort(function (a, b) { return Number(a.made) - Number(b.made); });
    var on = rows.slice(-TILL_PASSES_MAX);
    var ids = on.map(function (r) { return r.id; });
    var opened = ids.length
      ? bridgeAsk('tillInboxOpen', { ids: ids, since: tillSinceFor(on) }, 20000).then(function (n) {
          var got = Number(String(n).trim()) || 0;
          console.log('[foxy] till: listening for ' + got + ' of ' + ids.length + ' cashier code(s)');
          return got;
        }, function (e) {
          console.warn('[foxy] till: the phone did not listen for the cashier codes:', (e && e.message) || e);
          return 0;
        })
      : Promise.resolve(0);
    var run = opened.then(function (n) {
      return tillDrain().then(function () { return n; }, function () { return n; });
    });
    tillListenRun = run;
    var done = function () { if (tillListenRun === run) tillListenRun = null; };
    run.then(done, done);
    return run;
  }

  /* A cashier starts: the code checked, the mint it banks at kept (once: a
   * second code, or the same one again after a relaunch, leaves it as it
   * was), the till written, and the phone at the code's mint. Not added to
   * the person's mints: the phone goes home when the till ends. A connect
   * that fails takes it all back, so a phone is never left in a till at a
   * mint it cannot reach. */
  function tillJoinNow(given) {
    var c = typeof given === 'string' ? tillRead(given) : tillCheck(given);
    if (!c.pass) return Promise.reject(new Error(c.why || 'That is not a cashier code Foxy can read.'));
    var pass = c.pass;
    var before = tillCashierRaw();
    var homeBefore = load(K.tillHome, null);
    var home = homeBefore && typeof homeBefore === 'object' && typeof homeBefore.mint === 'string' ? homeBefore
      : { mint: canonicalMint(mintUrl || '') };
    var since = before && before.pass && before.pass.id === pass.id && before.since > 0 ? before.since : Date.now();
    var row = { pass: pass, since: since };
    try {
      mustSave(K.tillHome, home);
      mustSave(K.tillCashier, row);
    } catch (e) { return Promise.reject(e); }
    var there = !!wallet && canonicalMint(mintUrl || '') === pass.mint;
    var going = there ? Promise.resolve(null) : FoxyWallet.connect(pass.mint, null, null, { remember: false });
    return going.then(function () {
      console.log('[foxy] till: working the till for a keeper at ' + hostOf(pass.mint) + ', in ' + pass.unit);
      return { pass: pass, since: since };
    }, function (e) {
      if (before && before.pass) save(K.tillCashier, { pass: before.pass, since: before.since });
      else tillClear(K.tillCashier);
      if (!homeBefore) tillClear(K.tillHome);
      throw e;
    });
  }

  /* The cashier leaves: the till goes, and the phone goes back to the mint it
   * banks at. What it took and has not sent stays in the outbox and still
   * goes. Never rejects: leaving cannot be refused, and a failed trip home
   * leaves the phone where it is, which the next launch corrects (the mint on
   * file was never changed). */
  /* Once at a time: a second leave while the first is on its way home
   * shares it, and one after it finds nothing left to do and says so in the
   * same words (`{ left, mint, home }`). */
  var tillLeaving = null;

  function tillLeaveNow() {
    if (tillLeaving) return tillLeaving;
    var run = tillLeaveOnce();
    tillLeaving = run;
    var done = function () { if (tillLeaving === run) tillLeaving = null; };
    run.then(done, done);
    return run;
  }

  function tillLeaveOnce() {
    var home = load(K.tillHome, null);
    tillClear(K.tillCashier);
    tillClear(K.tillHome);
    if (tillOutboxRows().some(tillUnsent)) tillDeliverAll().then(null, function () {});
    var to = home && typeof home.mint === 'string' ? canonicalMint(home.mint) : '';
    if (!to || to === canonicalMint(mintUrl || '')) return Promise.resolve({ left: true, mint: canonicalMint(mintUrl || ''), home: true });
    return FoxyWallet.connect(to, null, null).then(function () {
      console.log('[foxy] till: left the till; back at ' + hostOf(to));
      return { left: true, mint: to, home: true };
    }, function (e) {
      console.warn('[foxy] till: left the till, and could not get back to ' + hostOf(to) + ':', (e && e.message) || e);
      return { left: true, mint: canonicalMint(mintUrl || ''), home: false };
    });
  }
