  /* ---- the Cashu ID: a name another wallet pays, with no server ---------------
   *
   * docs/CASHU-ID.md is the whole of it. In short: the phone derives the ID key
   * and the delivery key from the seed at their own paths (Foxy/Keychain/CashuID.swift),
   * and MY CASHU ID shows their public halves, with the ID key's signature binding
   * them, as one string, `foxyid1…`. Another Foxy pastes or scans it and keeps it
   * in its contacts. To pay it, that Foxy locks the ecash to the ID by NUT-28
   * (pay-to-blinded-key), exactly as cashu-ts does with `blindKeys`: for each
   * piece a throwaway key e, E = e·G on the proof (`p2pk_e`), and every key of
   * the lock blinded by its slot,
   *
   *     rᵢ = SHA-256("Cashu_P2BK_v1" ‖ x(e·P) ‖ i),   P′ = P + rᵢ·G
   *
   * the ID at slot 0 and the payer's refund key at slot 1, with a locktime about
   * thirty days out. It gift-wraps the token over Nostr (NIP-17) to keys the
   * delivery key moves to each day (the drop boxes, below). The mint sees keys nobody has seen before, never the ID and never
   * the refund key, and nothing but this phone's seed opens them (d·E has the
   * same x as e·ID).
   *
   * The phone never answers a one-time key. With an e of its own a page could
   * take the ID key out of it (d = k − r₀), so the phone signs instead:
   * `cashuIdSign` gives NUT-11's signature for each piece whose lock key is the
   * ID blinded by that piece's E. The sender keeps the token, locked, in an
   * outbox until the mint says it is spent (collected) or the locktime has
   * passed, when the sender's own refund key brings it home. */

  var CID_PREFIX = 'foxyid1';
  /* Version 2: 1 + 33 + 32 bytes, the ID key's BIP-340 signature over
   * SHA-256("foxy-cashu-id-bind-v1" ‖ ID ‖ delivery key) (64), and four of
   * checksum: 179 characters of base64url. Version 1 (no signature) is refused
   * like any string that is not an ID: nothing in it said the delivery key was
   * the ID's own. */
  var CID_VERSION = 2;
  var CID_BYTES_V2 = 134;
  var CID_TEXT = /^foxyid1[A-Za-z0-9_-]{179}$/;
  var CID_BIND = 'foxy-cashu-id-bind-v1';
  var CID_HEX33 = /^0[23][0-9a-f]{64}$/;
  var CID_HEX32 = /^[0-9a-f]{64}$/;
  var CID_SIG = /^[0-9a-f]{128}$/;
  /* The suites' switches (`_cashuIdLockS`, `_cashuIdRetryMs` and the arithmetic
   * with a fixed key) are honoured only on a page a test loaded and marked as
   * it did (tests/harness.js, `__foxyTestHooks`), read once as the wallet loads.
   * A page in the app never has it, so nothing set later can shorten a lock. */
  var CID_TESTS = !!(typeof window !== 'undefined' && window.__foxyTestHooks === true);
  /* How long a payment waits for its contact: past it, the payer's refund key can
   * take it back, and does (`cidWatch`). The locktime is the day thirty days on,
   * at a random second of it (`cidLocktime`), so it does not say to the second
   * when the payment was made. The receiver takes nothing that falls within a
   * day (`LOCKTIME_MARGIN_S`). */
  var CID_LOCK_S = 30 * 24 * 60 * 60;
  var CID_DAY_S = 24 * 60 * 60;
  // the most one delivery may be, in text and in pieces, before anything is read out of it
  var CID_BODY_MAX = 64 * 1024;
  var CID_PROOFS_MAX = 100;
  var CID_NOTE_MAX = 140;
  var CID_NAME_MAX = 40;
  var CID_SEEN_MAX = 4000;
  /* What is kept of deliveries at a mint this phone uses that cannot be taken yet
   * (no route, the mint's keys to fetch), and only while their locktime is more
   * than a day out: a kept row goes a day before it, when its payer could take
   * the money back. */
  var CID_INBOX_MAX = 50;
  var CID_INBOX_BYTES = 1024 * 1024;
  /* Deliveries at a mint this phone does not use are the receiver's to decide
   * (`cidForeign`): brought home, kept there, or sent back. At most five such
   * deliveries an hour make this phone ask a mint it does not use anything, the
   * count kept in storage so a restart does not reset it (`K.cidForeign`). What
   * waits for an answer, or is smaller than its crossing's fee, waits
   * (`K.cidOffers`), unasked again: at most ten, the oldest dropped, a quarter
   * of a megabyte in all. */
  var CID_OFFERS_MAX = 10;
  var CID_OFFERS_BYTES = 256 * 1024;
  var CID_OFFER_RATE = 5;
  var CID_OFFER_RATE_MS = 60 * 60 * 1000;
  /* A copy of each payment to a contact goes to this phone's own recovery key
   * (m/129373'/20'/3'/0'/0') once a relay has taken the payment, between one and
   * thirty minutes later at a random second (`cidCopyDelay`), so the relays do not
   * see the two in the same second. A restore from the words listens on that key
   * for a week (`CID_RECOVER_MS`), back the same thirty-two days, and rebuilds the
   * outbox from the copies (`cidCopyArrived`). */
  var CID_COPY_MIN_MS = 60 * 1000;
  var CID_COPY_MAX_MS = 30 * 60 * 1000;
  var CID_RECOVER = 'foxy.cid.recover';
  var CID_RECOVER_MS = 7 * 24 * 60 * 60 * 1000;
  /* A mint of this phone's whose keys could not be fetched is asked again no
   * sooner than a minute after, then two, four… and never more than once an hour. */
  var CID_BACKOFF_MIN_MS = 60 * 1000;
  var CID_BACKOFF_MAX_MS = 60 * 60 * 1000;
  /* A delivery the relays took is sent again once a day until the mint says it
   * is spent or its locktime has passed: a relay that drops it costs a day. */
  var CID_RESEND_MS = 24 * 60 * 60 * 1000;
  var CID_RETRY_MS = 60000;
  var CID_TRIES_FAST = 30;
  var CID_RETRY_SLOW = 15;
  /* The relays are asked for wraps from thirty-two days back: a payment waits
   * thirty for its receiver, and NIP-59 backdates a wrap up to two. The phone
   * reads them page by page (FoxyBridge+CashuID.swift). */
  var CID_SINCE_S = 32 * 24 * 60 * 60;
  /* A listen this recent is not opened again by a connect's catch-up or by the route coming up (`cidListenNow`,
   * `ifClosed`): what was kept is taken from the inbox that is open. Every open closes the one before and asks the
   * relays for the whole window again, which left a phone deaf for two seconds on every return and read each of the
   * month's payments once more. A return from the background always opens it again: the phone closed it. */
  var CID_FRESH_MS = 60 * 1000;
  /* Deliveries read while the wallet is still the one built from storage, held in memory until the mint is connected
   * for real (`cidHoldEarly`): at most this many, and this much. The relays hold every one of them. */
  var CID_EARLY_MAX = 20;
  var CID_EARLY_BYTES = 512 * 1024;
  /* The most pieces one payment's throwaway keys are made for: more than any
   * split of an amount, with a retried swap's second set. */
  var CID_PIECES_MAX = 256;
  /* The drop boxes (CashuID.swift `dropTweak`, docs/CASHU-ID.md "The drop boxes"). A payment is wrapped to one of
   * the sixteen keys the ID's delivery key moves to on the UTC day it is posted, picked at random, and once more, a
   * few seconds later (`cidAheadDelay`), to one of the next day's: so the receiver asks only for the day's keys and
   * for the days it was away, never the same key on two days, and never the delivery key itself. The phone keeps the
   * last UTC day a listen finished (`CID_HEARD`), and each ANY WALLET request it showed (`CID_ANY_KEYS`: the id, when
   * it was made and the day it was last asked for), each listened for a year: at every listen in its first day, once
   * a UTC day in its first month, once a week after. Day numbers and ids, no key. */
  var CID_DROP_TAG = 'foxy-cashu-id-drop-v1';
  var CID_ANY_TAG = 'foxy-cashu-id-any-v1';
  var CID_SLOTS = 16;
  var CID_DAY_MS = 24 * 60 * 60 * 1000;
  var CID_HEARD = 'foxy.cid.heard';
  var CID_ANY_KEYS = 'foxy.cid.any';
  var CID_WINDOW_DAYS = 32;
  var CID_ANY_KEEP_MS = 365 * CID_DAY_MS;
  var CID_ANY_FRESH_MS = CID_DAY_MS;
  var CID_ANY_DAILY_MS = 30 * CID_DAY_MS;
  var CID_ANY_WEEK_DAYS = 7;
  // the most codes kept (FoxyBridge+CashuID.swift `cashuIdMostAny`): one more drops the oldest
  var CID_ANY_MOST = 960;
  /* A wrap's envelope carries a random run of filler (`pad`) a NIP-44 bucket or more long, fresh for every wrap: a
   * payment's two wraps and its daily resends do not always land in the same size bucket (docs/CASHU-ID.md, Posting). */
  var CID_PAD_MIN = 256;
  // the most a Nostr send may carry (FoxyBridge+Delivery.swift: half of NIP-44's longest message), filler included
  var CID_SEND_MAX = 32767;

  /* ---- the string ---- */

  function cidB64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function cidUnB64(text) {
    var t = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    var bin = atob(t);
    var out = [];
    for (var i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i));
    return out;
  }

  function cidHexBytes(hex) { return Array.prototype.slice.call(bytesOfHex(hex)); }
  function cidUtf8(text) { return Array.prototype.slice.call(new TextEncoder().encode(String(text))); }

  /* What the ID key signs once to bind its delivery key: SHA-256(prefix ‖ ID ‖ delivery key), hex. */
  function cidBindDigest(idHex, nostrHex) {
    return hexOf(sha256(cidUtf8(CID_BIND).concat(cidHexBytes(idHex), cidHexBytes(nostrHex))));
  }

  function cidBound(idHex, nostrHex, sigHex) {
    try { return window.CashuTS.schnorrVerifyDigest(String(sigHex), cidBindDigest(idHex, nostrHex), String(idHex)) === true; }
    catch (e) { return false; }
  }

  /* The ID string for an ID key, a delivery key and the ID key's signature
   * binding them, all lowercase hex: version 2. With no signature the suites'
   * version 1, which `cidRead` refuses. */
  function cidEncode(idHex, nostrHex, sigHex) {
    var sig = sigHex && CID_SIG.test(String(sigHex)) ? cidHexBytes(sigHex) : null;
    var body = [sig ? 2 : 1].concat(cidHexBytes(idHex), cidHexBytes(nostrHex), sig || []);
    return CID_PREFIX + cidB64(body.concat(sha256(body).slice(0, 4)));
  }

  /* Whether `text` is shaped like an ID string at all, before its checksum is
   * read: what `classify` calls 'cashuid', so a mistyped one is refused as an
   * ID and not as "not a payment". */
  function cidShape(text) {
    return CID_TEXT.test(String(text || '').trim());
  }

  /* { id, nostr, sig, version } from an ID string, or { why } in words. Never throws. */
  function cidRead(text) {
    var bad = { why: 'That is not a Cashu ID.' };
    var t = String(text || '').trim();
    if (!CID_TEXT.test(t)) return bad;
    var bytes;
    try { bytes = cidUnB64(t.slice(CID_PREFIX.length)); } catch (e) { return bad; }
    if (bytes.length !== CID_BYTES_V2) return bad;
    var body = bytes.slice(0, bytes.length - 4);
    var sum = sha256(body).slice(0, 4);
    for (var i = 0; i < 4; i++) if (sum[i] !== bytes[bytes.length - 4 + i]) return bad;
    if (body[0] > CID_VERSION) return { why: 'That Cashu ID is from a newer Foxy. Update Foxy and try again.' };
    if (body[0] !== 2) return bad;
    var id = hexOf(body.slice(1, 34));
    var nostr = hexOf(body.slice(34, 66));
    var sig = hexOf(body.slice(66, 130));
    // both keys points on the curve: a payment to one that is not could never be opened
    try {
      var CT = window.CashuTS;
      CT.pointFromHex(id);
      CT.pointFromHex('02' + nostr);
    } catch (e) { return bad; }
    if (!CID_HEX33.test(id) || !CID_HEX32.test(nostr)) return bad;
    // the ID key itself said this delivery key is its own
    if (!cidBound(id, nostr, sig)) return bad;
    return { id: id, nostr: nostr, sig: sig, version: body[0] };
  }

  /* ---- this phone's own ---- */

  // the public keys from the phone, once a page load and again after the seed changes (`clearNativeSecrets`)
  var cidMineCache = null;
  // the recovery key's x-only public half, from the same answer: the copies go to it and it is said nowhere else
  var cidRecoveryKey = '';

  function cidForget() { cidMineCache = null; cidRecoveryKey = ''; }

  function cidMine() {
    if (cidMineCache) return cidMineCache;
    var run = nativeJson('cashuIdPublic', {}, 60000).then(function (j) {
      var id = String((j && j.id) || '').toLowerCase();
      var nostr = String((j && j.nostr) || '').toLowerCase();
      var sig = String((j && j.sig) || '').toLowerCase();
      var recovery = String((j && j.recovery) || '').toLowerCase();
      if (!CID_HEX33.test(id) || !CID_HEX32.test(nostr)) throw new Error('the phone’s Cashu ID was not a pair of keys');
      if (!CID_SIG.test(sig) || !cidBound(id, nostr, sig)) throw new Error('the phone’s Cashu ID did not come with its own signature');
      // the recovery key goes nowhere but the copies' address (`cidCopyAll`): not on what the screens are given
      cidRecoveryKey = CID_HEX32.test(recovery) && recovery !== nostr ? recovery : '';
      return { id: id, nostr: nostr, sig: sig, text: cidEncode(id, nostr, sig) };
    });
    cidMineCache = run;
    run.then(null, function () { if (cidMineCache === run) cidMineCache = null; });
    return run;
  }

  /* Whether this phone's ID is in use: MY CASHU ID was shown on it, or its
   * words were restored (`cidRestored`). Until then it does not listen, and it
   * names itself to nobody it pays (`cidBody`). */
  var CID_SHOWN = 'foxy.cid.shown';

  function cidInUse() {
    try { return !!localStorage.getItem(CID_SHOWN); } catch (e) { return false; }
  }

  function cidMarkInUse() {
    try { if (!localStorage.getItem(CID_SHOWN)) localStorage.setItem(CID_SHOWN, String(Date.now())); } catch (e) {}
  }

  /* Words restored (`adoptCandidate`): the ID they give may be in somebody's
   * contacts, with money on its way, so this phone listens for it from now on
   * without MY CASHU ID being opened, and derives it at once. */
  function cidRestored() {
    cidForget();
    cidMarkInUse();
    // and for a week it reads back the copies of what this seed paid and nobody has collected (`cidCopyArrived`)
    try { mustSave(CID_RECOVER, Date.now()); } catch (e) { console.warn('[foxy] cashu id: the restore could not be noted for the copies:', (e && e.message) || e); }
    cidMine().then(function () { return cidListenNow(); }).then(null, function (e) {
      console.warn('[foxy] cashu id: the restored seed’s ID was not read yet:', (e && e.message) || e);
    });
  }

  /* ---- NUT-28's arithmetic, the payer's half ---- */

  var CID_N = null;
  function cidOrder() {
    if (CID_N === null) CID_N = window.CashuTS.pointFromHex('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798').constructor.Fn.ORDER;
    return CID_N;
  }

  /* Piece j's throwaway key from a payment's base (CashuID.payBase):
   * SHA-256(base ‖ j as two bytes), once more with 0xFF appended when that is 0
   * or not below n. 64 hex. */
  function cidPieceKey(baseHex, j) {
    var head = cidHexBytes(baseHex).concat([(j >> 8) & 255, j & 255]);
    var n = cidOrder();
    var e = hexOf(sha256(head));
    var v = BigInt('0x' + e);
    if (v === BigInt(0) || v >= n) { e = hexOf(sha256(head.concat([255]))); v = BigInt('0x' + e); }
    if (v === BigInt(0) || v >= n) throw new Error('No throwaway key could be made for that payment.');
    return e;
  }

  /* ---- the drop boxes: the payer's half ----
   *
   * key(day, j) = x(lift_x(Q) + t·G), t = SHA-256("foxy-cashu-id-drop-v1" ‖ Q ‖ day (4, big-endian) ‖ j), once more
   * with 0xFF appended when that is 0 or not below n; Q the ID's delivery key (x-only), `day` the unix time over
   * 86,400. An ANY WALLET request's key: the same with SHA-256("foxy-cashu-id-any-v1" ‖ Q ‖ its 4-byte id). The
   * phone holds the matching secrets (CashuID.swift); the page never does. 64 hex. */
  function cidDay(ms) { return Math.floor((ms == null ? Date.now() : Number(ms)) / CID_DAY_MS); }

  function cidMoveBy(bytes) {
    var n = cidOrder();
    var t = BigInt('0x' + hexOf(sha256(bytes)));
    if (t === BigInt(0) || t >= n) t = BigInt('0x' + hexOf(sha256(bytes.concat([255]))));
    if (t === BigInt(0) || t >= n) throw new Error('No key for that Cashu ID could be made.');
    return t;
  }

  function cidMoved(nostrHex, t) {
    var CT = window.CashuTS;
    var P = CT.pointFromHex('02' + nostrHex);
    var G = CT.pointFromHex('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
    return P.add(G.multiply(t)).toHex(true).slice(2);
  }

  function cidDropKey(nostrHex, day, j) {
    var d = Math.floor(Number(day));
    var slot = Math.floor(Number(j));
    if (!CID_HEX32.test(String(nostrHex)) || !(d >= 0 && d < 4294967296) || !(slot >= 0 && slot < CID_SLOTS)) throw new Error('That is not a Cashu ID.');
    var bytes = cidUtf8(CID_DROP_TAG).concat(cidHexBytes(nostrHex), [(d >>> 24) & 255, (d >>> 16) & 255, (d >>> 8) & 255, d & 255], [slot]);
    return cidMoved(String(nostrHex), cidMoveBy(bytes));
  }

  function cidAnyKey(nostrHex, idHex) {
    if (!CID_HEX32.test(String(nostrHex)) || !/^[0-9a-f]{8}$/.test(String(idHex))) throw new Error('That is not a Cashu ID.');
    return cidMoved(String(nostrHex), cidMoveBy(cidUtf8(CID_ANY_TAG).concat(cidHexBytes(nostrHex), cidHexBytes(idHex))));
  }

  // a slot picked at random, for one wrap
  function cidSlot() { return window.CashuTS.createRandomSecretKey()[0] % CID_SLOTS; }

  // where a payment to the delivery key `nostrHex` goes when it is posted on `day`: an nprofile of one of that day's keys
  function cidDropTarget(nostrHex, day) { return cidNprofile(cidDropKey(nostrHex, day, cidSlot())); }

  /* The keys of a payment to `idHex` with `refundHex` as cashu-ts makes them,
   * for a piece's throwaway key `eHex`: { E, L, R } (the ID blinded at slot 0,
   * the refund key at slot 1). */
  function cidBlind(idHex, eHex, refundHex) {
    var keys = refundHex ? [String(idHex).toLowerCase(), String(refundHex).toLowerCase()] : [String(idHex).toLowerCase()];
    var got = window.CashuTS.deriveP2BKBlindedPubkeys(keys, bytesOfHex(eHex));
    return { E: got.Ehex, L: got.blinded[0], R: got.blinded[1] || '' };
  }

  /* NIP-19's nprofile for a delivery key, naming no relays: the phone then
   * sends to its own three (NostrDelivery.fallbackRelays), which are the three
   * the receiver's inbox listens on. */
  /* `relays` (ANY WALLET's request, `cidAnyRequest`): each as NIP-19's TLV 1, so a wallet that is not Foxy knows where
   * to send. The ID's own nprofile names none. */
  function cidNprofile(xonlyHex, relays) {
    var CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    var data = [0, 32].concat(cidHexBytes(xonlyHex));
    (Array.isArray(relays) ? relays : []).forEach(function (r) {
      var b = cidUtf8(String(r));
      if (b.length > 0 && b.length < 256) data = data.concat([1, b.length], b);
    });
    var five = [], acc = 0, bits = 0;
    for (var i = 0; i < data.length; i++) {
      acc = (acc << 8) | data[i]; bits += 8;
      while (bits >= 5) { bits -= 5; five.push((acc >> bits) & 31); }
    }
    if (bits) five.push((acc << (5 - bits)) & 31);
    var hrp = 'nprofile';
    var mod = b32Polymod(b32Expand(hrp).concat(five, [0, 0, 0, 0, 0, 0])) ^ 1;
    var sum = [];
    for (var k = 0; k < 6; k++) sum.push((mod >>> (5 * (5 - k))) & 31);
    return hrp + '1' + five.concat(sum).map(function (v) { return CHARSET.charAt(v); }).join('');
  }

  /* ---- contacts ---- */

  function cidContactsNow() {
    return (FoxyWallet.book() || []).filter(function (c) { return c && c.cid && CID_HEX33.test(String(c.cid.id || '')); });
  }

  function cidContactOf(idHex) {
    var want = String(idHex || '').toLowerCase();
    var hit = cidContactsNow().filter(function (c) { return c.cid.id === want; })[0];
    return hit || null;
  }

  function cidCleanName(name) {
    return String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CID_NAME_MAX);
  }

  /* The contact for an ID string, written: a contact with the same ID is
   * updated where it is in the list, never written twice. Its delivery key
   * changes only on the ID's own signature, which every string `cidRead` takes
   * carries. */
  function cidKeep(read, name) {
    if (!read || !read.sig || !cidBound(read.id, read.nostr, read.sig)) throw new Error('That is not a Cashu ID.');
    var list = FoxyWallet.book() || [];
    var text = cidEncode(read.id, read.nostr, read.sig);
    var clean = cidCleanName(name) || 'Cashu ID';
    var cid = /** @type {any} */ ({ id: read.id, nostr: read.nostr, sig: read.sig });
    var row = { handle: text, name: clean, at: Date.now(), cid: cid };
    var at = -1;
    list.forEach(function (c, i) { if (at < 0 && c && c.cid && c.cid.id === read.id) at = i; });
    if (at >= 0) list[at] = Object.assign({}, list[at], row);
    else list.unshift(row);
    // the same ID under a handle written before, once more, goes: one contact per ID
    var seen = false;
    list = list.filter(function (c) {
      if (!(c && c.cid && c.cid.id === read.id)) return true;
      if (seen) return false;
      seen = true;
      return true;
    });
    mustSave('foxy.contacts', list.slice(0, 50));
    return row;
  }

  /* ---- what arrived ---- */

  // what came in by the Cashu ID, by the first 16 bytes of each secret's SHA-256, so a delivery read twice is taken once
  function cidSeenKey(secret) { return hexOf(sha256(cidUtf8(secret)).slice(0, 16)); }

  function cidSeenList() {
    var l = load(K.cidSeen, []);
    return Array.isArray(l) ? l : [];
  }

  function cidSeenAdd(proofs) {
    var have = cidSeenList();
    (proofs || []).forEach(function (p) {
      var s = p && typeof p.secret === 'string' ? cidSeenKey(p.secret) : '';
      if (s && have.indexOf(s) < 0) have.push(s);
    });
    save(K.cidSeen, have.slice(-CID_SEEN_MAX));
  }

  function cidSeenAny(proofs) {
    var have = cidSeenList();
    return proofs.some(function (pr) { return have.indexOf(cidSeenKey(pr.secret)) >= 0; });
  }

  function cidRowsOf(key) {
    var l = load(key, []);
    return Array.isArray(l) ? l.filter(function (r) { return r && typeof r.key === 'string' && typeof r.body === 'string'; }) : [];
  }

  function cidInboxRows() {
    var now = Date.now();
    var rows = cidRowsOf(K.cidInbox);
    // a kept row goes a day before its locktime: its payer may have it back then
    var left = rows.filter(function (r) { return Number(r.drop) > now; });
    if (left.length !== rows.length) {
      save(K.cidInbox, left);
      console.log('[foxy] cashu id: ' + (rows.length - left.length) + ' kept deliveries let go, a day before their locktime');
    }
    return left;
  }

  /* Kept for later, as the till keeps a delivery (`tillInboxKeep`): once by its
   * pieces, within a cap, refused past it (the relays still hold it, and the
   * payer sends it again). `mustSave`: this may be the only copy read. */
  function cidInboxKeep(key, body, mint, drop) {
    var rows = cidInboxRows();
    if (rows.some(function (r) { return r.key === key; })) return;
    if (rows.length >= CID_INBOX_MAX) throw new Error('the Cashu ID’s inbox holds ' + CID_INBOX_MAX + ' already; the relays still hold this one');
    var bytes = rows.reduce(function (n, r) { return n + r.body.length; }, 0);
    if (bytes + String(body).length > CID_INBOX_BYTES) throw new Error('the Cashu ID’s inbox is full; the relays still hold this one');
    rows.push({ key: key, body: String(body), at: Date.now(), mint: mint, drop: drop });
    mustSave(K.cidInbox, rows);
  }

  function cidInboxDrop(key) {
    var rows = cidRowsOf(K.cidInbox);
    var left = rows.filter(function (r) { return r.key !== key; });
    if (left.length !== rows.length) save(K.cidInbox, left);
  }

  /* ---- a mint this phone does not use: the receiver's choice ---- */

  /* What came at a mint this phone does not use and waits for its receiver: a
   * card asks (BRING IT HOME, KEEP IT THERE, SEND IT BACK), and until it is
   * answered the delivery waits here, unasked again, listed in HISTORY, until a
   * day before its locktime, when its payer may have it back. One smaller than
   * the fee of crossing it home waits the same way. Each row keeps what the way
   * home was quoted at (`q`: what would land, in which unit, the fee, or why it
   * cannot), and the payer's ID where it was proved and this phone knows where
   * to send it back (`from`). */
  function cidOfferRows() {
    var now = Date.now();
    var rows = cidRowsOf(K.cidOffers);
    var left = rows.filter(function (r) { return Number(r.drop) > now; });
    if (left.length !== rows.length) save(K.cidOffers, left);
    return left;
  }

  /* A waiting row written, or one already there given its newer quote: the
   * newest last, the oldest dropped past ten or a quarter of a megabyte.
   * `mustSave`: it may be the only copy read. */
  function cidOfferKeep(row) {
    var rows = cidOfferRows();
    var had = rows.filter(function (r) { return r.key === row.key; })[0];
    if (had) {
      Object.assign(had, { q: row.q || had.q, from: row.from || had.from || '', name: row.name || had.name || '' });
      mustSave(K.cidOffers, rows);
      return true;
    }
    rows.push(row);
    while (rows.length > CID_OFFERS_MAX) rows.shift();
    while (rows.length > 1 && rows.reduce(function (n, r) { return n + r.body.length; }, 0) > CID_OFFERS_BYTES) rows.shift();
    if (rows.reduce(function (n, r) { return n + r.body.length; }, 0) > CID_OFFERS_BYTES) return false;
    mustSave(K.cidOffers, rows);
    return true;
  }

  function cidOfferDrop(key) {
    var rows = cidRowsOf(K.cidOffers);
    var left = rows.filter(function (r) { return r.key !== key; });
    if (left.length !== rows.length) save(K.cidOffers, left);
  }

  // the way home, quoted for the whole of what waits at one mint in one unit, written on each of those rows
  function cidOfferQuoteAll(mint, unit, q) {
    var rows = cidRowsOf(K.cidOffers);
    var hit = false;
    rows.forEach(function (r) { if (r.mint === mint && (unitOf(r.unit) || 'sat') === unit) { r.q = q; hit = true; } });
    if (hit) save(K.cidOffers, rows);
  }

  /* What HISTORY and the card show of one: no token. `back`: SEND IT BACK can
   * be offered (its payer proved who it is, and this phone knows where to send
   * it). `lands`, `toUnit`, `fee` (in the delivery's unit): the way home as it
   * was quoted for everything waiting at that mint in that unit (`total`, of
   * `others` more); `why`: why BRING IT HOME cannot be done now. */
  function cidOfferView(r) {
    var unit = unitOf(r.unit) || 'sat';
    var q = (r.q && typeof r.q === 'object') ? r.q : {};
    var same = cidOfferRows().filter(function (x) { return x.mint === r.mint && (unitOf(x.unit) || 'sat') === unit; });
    var total = same.reduce(function (n, x) { return n + (satsOf(x.amount) || 0); }, 0) || satsOf(r.amount) || 0;
    return { key: r.key, name: String(r.name || ''), mint: r.mint, host: hostOf(r.mint), unit: unit, amount: satsOf(r.amount) || 0,
             at: r.at, drop: Number(r.drop) || 0, back: !!(r.from && cidBackTo(r.from)),
             lands: Math.max(0, Math.round(Number(q.lands) || 0)), toUnit: unitOf(q.toUnit) || unit, fee: Math.max(0, Math.round(Number(q.fee) || 0)),
             why: String(q.why || (q.lands > 0 ? '' : 'The way home has not been quoted yet.')), small: !!q.small,
             others: Math.max(0, same.length - 1), total: total, choice: cidChoiceOf(r.mint) };
  }

  /* What the receiver chose for a mint, remembered by the card's tick ("Always
   * do this for <mint>"): 'home' (brought home by itself, as every one was
   * before there was a card), 'keep' or 'back'. By host, one key each. Cleared
   * from SETTINGS > OTHER MINTS (26o-cashu-id.js). */
  var CID_CHOICE = 'foxy.cid.choice.';
  var CID_CHOICES = { home: 1, keep: 1, back: 1 };
  function cidChoiceKey(mint) { return CID_CHOICE + hostOf(canonicalMint(String(mint || ''))); }
  function cidChoiceOf(mint) {
    var v = load(cidChoiceKey(mint), '');
    return Object.prototype.hasOwnProperty.call(CID_CHOICES, v) ? v : '';
  }
  function cidChoiceSet(mint, choice) {
    if (!Object.prototype.hasOwnProperty.call(CID_CHOICES, choice) || !canonicalMint(String(mint || ''))) return;
    save(cidChoiceKey(mint), choice);
  }
  function cidChoiceList() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i) || '';
        if (k.indexOf(CID_CHOICE) !== 0) continue;
        var v = load(k, '');
        if (Object.prototype.hasOwnProperty.call(CID_CHOICES, v)) out.push({ host: k.slice(CID_CHOICE.length), choice: v });
      }
    } catch (e) {}
    return out.sort(function (a, b) { return a.host < b.host ? -1 : a.host > b.host ? 1 : 0; });
  }
  // one host's, or every one with none named
  function cidChoiceClear(host) {
    var h = String(host || '');
    cidChoiceList().forEach(function (c) {
      if (!h || c.host === h) { try { localStorage.removeItem(CID_CHOICE + c.host); } catch (e) {} }
    });
  }

  /* Where a payment can be sent back to: its payer's ID, with the delivery key
   * to wrap it for, from the contacts or from what this phone has paid that ID
   * before. null when this phone does not know where. */
  function cidBackTo(idHex) {
    var id = String(idHex || '').toLowerCase();
    if (!CID_HEX33.test(id)) return null;
    var c = cidContactOf(id);
    if (c && CID_HEX32.test(String(c.cid.nostr || ''))) return { id: id, nostr: c.cid.nostr, name: c.name || '' };
    var out = cidOutboxRows().filter(function (r) { return r.contact === id && CID_HEX32.test(String(r.to || '')); }).pop();
    // a row kept by a build that named the ID differently says 'a Foxy ID'; it is no name either
    var nm = cidCleanName(out && out.name);
    return out ? { id: id, nostr: out.to, name: nm === 'a Cashu ID' || nm === 'a Foxy ID' ? '' : nm } : null;
  }

  /* Who sent a delivery, as far as it can be proved: `name` a contact's (the
   * authenticated-from rule, `cidFromName`), and `back` where its payer proved
   * its ID by the tag and this phone knows where to send it (`cidBackTo`).
   * Never rejects. */
  function cidWho(got) {
    var none = { name: '', back: null };
    if (!got.from || !got.tag || !CID_HEX33.test(got.E)) return Promise.resolve(none);
    if (!got.proofs.some(function (pr) { return String(pr.p2pk_e || '').toLowerCase() === got.E; })) return Promise.resolve(none);
    var to = cidBackTo(got.from);
    if (!to) return Promise.resolve(none);
    return nativeJson('cashuIdTag', { peer: got.from, e: got.E }, 60000).then(function (j) {
      var tag = String((j && j.tag) || '').toLowerCase();
      if (!tag || tag !== got.tag) { console.warn('[foxy] cashu id: a delivery named a payer without proving it'); return none; }
      var c = cidContactOf(got.from);
      return { name: c ? c.name : '', back: to };
    }, function () { return none; });
  }

  /* Whether this phone may ask one more mint it does not use about a delivery
   * this hour, and if so, counted. Five an hour, kept in storage so that
   * starting Foxy again does not start the count again. */
  function cidForeignSpend() {
    var now = Date.now();
    var l = load(K.cidForeign, []);
    var times = (Array.isArray(l) ? l : []).map(Number).filter(function (t) { return t > now - CID_OFFER_RATE_MS && t <= now + 60000; });
    if (times.length >= CID_OFFER_RATE) return false;
    times.push(now);
    save(K.cidForeign, times);
    return true;
  }

  /* ---- the mints this phone uses ---- */

  /* Whether `mint` is one this phone uses: the one it is on, the one it calls
   * home, every mint it has connected to or used, and the till's. A delivery
   * at any other is the receiver's to decide (`cidForeign`). */
  function cidListedMint(mint) {
    var m = canonicalMint(String(mint || ''));
    if (!m) return false;
    var mine = [mintUrl || '', load(K.mint, '')];
    try { mine = mine.concat(tillPinnedMints()); } catch (e) {}
    if (mine.some(function (u) { return canonicalMint(String(u || '')) === m; })) return true;
    /* A mint this phone first met by bringing a payment home from it (`cidBringHome`) is in its lists from that visit,
     * and is still not one it uses: what comes there later is brought home too. */
    if (cidBroughtFrom(m)) return false;
    var list = [];
    var a = load(K.mints, []), b = load(K.mintsUsed, []);
    if (Array.isArray(a)) list = list.concat(a);
    if (Array.isArray(b)) list = list.concat(b);
    return list.some(function (u) { return canonicalMint(String(u || '')) === m; });
  }

  // the mints this phone visited only to bring a Cashu ID payment home, by `cidBringHome`, at most fifty
  var CID_BROUGHT = 'foxy.cid.brought';
  function cidBroughtFrom(m) {
    var l = load(CID_BROUGHT, []);
    return Array.isArray(l) && l.indexOf(m) >= 0;
  }
  function cidBroughtNote(m) {
    if (cidBroughtFrom(m)) return;
    var l = load(CID_BROUGHT, []);
    save(CID_BROUGHT, (Array.isArray(l) ? l : []).concat([m]).slice(-50));
  }

  /* KEEP IT THERE, or money that could not be sent back: from now on a mint
   * this phone uses, in its lists like any other (SWITCH MINT), no longer one
   * it only brought money home from, and what arrives there is taken as at any
   * of its mints. */
  function cidUseMint(m) {
    var c = canonicalMint(String(m || ''));
    if (!c) return;
    var l = load(CID_BROUGHT, []);
    if (Array.isArray(l) && l.indexOf(c) >= 0) save(CID_BROUGHT, l.filter(function (x) { return x !== c; }));
    rememberMint(c);
    console.log('[foxy] cashu id: ' + hostOf(c) + ' is a mint this phone uses now');
  }

  // a mint of this phone's whose keys would not come: { next, wait } by host, for this page load
  var cidBackoff = Object.create(null);

  function cidBackedOff(mint) {
    var b = cidBackoff[canonicalMint(mint)];
    return !!b && b.next > Date.now();
  }

  function cidBackOff(mint) {
    var m = canonicalMint(mint);
    var b = cidBackoff[m];
    var wait = b ? Math.min(b.wait * 2, CID_BACKOFF_MAX_MS) : CID_BACKOFF_MIN_MS;
    cidBackoff[m] = { next: Date.now() + wait, wait: wait };
    console.warn('[foxy] cashu id: the keys of ' + hostOf(m) + ' did not come; asked again in ' + Math.round(wait / 60000) + ' min at the soonest');
  }

  /* ---- reading a delivery ---- */

  // the same ecash by two doors at once (the relays send one wrap from each of three): one is taken, the other waits for it
  var cidInFlight = Object.create(null);

  function cidHold(proofs) {
    var secrets = proofs.map(function (p) { return String(p.secret); });
    if (secrets.some(function (s) { return cidInFlight[s]; })) return null;
    secrets.forEach(function (s) { cidInFlight[s] = true; });
    return function () { secrets.forEach(function (s) { delete cidInFlight[s]; }); };
  }

  // the locktime a proof's secret names, in seconds, 0 for none, -1 for one that is not a number
  function cidLocktimeOf(pr) {
    try {
      var tags = JSON.parse(pr.secret)[1].tags || [];
      var t = tags.filter(function (x) { return Array.isArray(x) && x[0] === 'locktime'; })[0];
      if (!t) return 0;
      var n = Number(t[1]);
      return Number.isSafeInteger(n) && n > 0 ? n : -1;
    } catch (e) { return -1; }
  }

  /* Why a proof is not one a delivery may carry, or ''. Only shape: what the
   * mint and the phone say comes after. Its E must be a point (NUT-28's
   * `p2pk_e`) and its DLEQ there (NUT-12), so a forged piece is dropped before
   * anything is written. */
  function cidProofProblem(pr) {
    if (!pr || typeof pr !== 'object') return 'it holds something that is not a proof';
    if (typeof pr.secret !== 'string' || pr.secret.length > 1024 || typeof pr.C !== 'string' || !CID_HEX33.test(pr.C.toLowerCase())
        || !(satsOf(pr.amount) > 0)) return 'it holds a proof that is not ecash Foxy can read';
    var lock = String(lockedTo(pr) || '').toLowerCase();
    if (!CID_HEX33.test(lock)) return 'it holds a proof that is not locked to a key';
    var e = typeof pr.p2pk_e === 'string' ? pr.p2pk_e.toLowerCase() : '';
    if (!CID_HEX33.test(e)) return 'it holds a proof that carries no one-time key';
    try { window.CashuTS.pointFromHex(e); } catch (x) { return 'it holds a proof whose one-time key is not a point'; }
    var d = pr.dleq;
    if (!d || typeof d !== 'object' || ![d.e, d.s, d.r].every(function (v) { return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v); })) {
      return 'it holds a proof without the mint’s proof (DLEQ)';
    }
    if (cidLocktimeOf(pr) < 0) return 'it holds a proof whose locktime is not a time';
    return '';
  }

  /* A delivery, read: a Foxy's envelope { v: 2, type, token, E, from, tag, note }
   * or another wallet's NUT-18 PaymentRequestPayload { mint, unit, proofs, memo }
   * (E on each proof, none on the envelope). { mint, unit, proofs, from, tag, E,
   * note, token } or { why }. Never throws. */
  function cidReadDelivery(text, kw) {
    var j = null;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { why: 'it is not a payment' };
    var out = /** @type {any} */ ({ from: '', tag: '', E: '', note: '' });
    if (j.type === 'foxy-cashu-id' || j.v !== undefined) {
      if (j.v === 1) return { why: 'it is from an earlier test build of Foxy' };
      if (j.v !== 2 || j.type !== 'foxy-cashu-id' || typeof j.token !== 'string') return { why: 'it is from a newer Foxy' };
      var d = null;
      try {
        var t = FoxyWallet.unwrap(j.token);
        d = window.CashuTS.getDecodedToken(t, keysetIdsFor(kw || wallet));
      } catch (e1) { d = null; }
      if (!d) {
        var info = null;
        try { info = FoxyWallet.tokenInfo(j.token); } catch (e2) { info = null; }
        if (!info) return { why: 'it holds no token' };
        d = { mint: info.mint, unit: info.unit, proofs: info.proofs };
      }
      out.mint = d.mint; out.unit = d.unit; out.proofs = d.proofs; out.token = j.token;
      out.E = typeof j.E === 'string' ? j.E.toLowerCase() : '';
      out.from = typeof j.from === 'string' && CID_HEX33.test(j.from.toLowerCase()) ? j.from.toLowerCase() : '';
      out.tag = typeof j.tag === 'string' && CID_HEX32.test(j.tag.toLowerCase()) ? j.tag.toLowerCase() : '';
      out.note = typeof j.note === 'string' ? j.note : '';
    } else if (typeof j.mint === 'string' && Array.isArray(j.proofs)) {
      out.mint = j.mint; out.unit = typeof j.unit === 'string' ? j.unit : 'sat'; out.proofs = j.proofs;
      out.note = typeof j.memo === 'string' ? j.memo : '';
    } else {
      return { why: 'it is not a payment' };
    }
    out.proofs = (Array.isArray(out.proofs) ? out.proofs : []).map(function (pr) {
      if (!pr || typeof pr !== 'object') return pr;
      var c = Object.assign({}, pr);
      if (c.amount !== undefined && typeof c.amount !== 'number') c.amount = satsOf(c.amount);
      return c;
    });
    return out;
  }

  /* The proofs as the mint is to see them: no E (NUT-28 strips it before a
   * spend), and the witness the phone signed for. */
  function cidForMint(proofs, sigs) {
    return proofs.map(function (pr, i) {
      var c = Object.assign({}, pr);
      delete c.p2pk_e;
      if (sigs) c.witness = JSON.stringify({ signatures: [String(sigs[i])] });
      return c;
    });
  }

  var cidArriving = Promise.resolve();

  /* One at a time, as the till takes them: two copies of one delivery read in
   * the same second are otherwise both past the seen check. */
  function cidArrived(body, opts) {
    var o = opts || {};
    // this phone's own ID, to know a delivery paid to it unblinded (`cidBare`); '' when it cannot be read
    var run = cidArriving.then(function () {
      return cidMine().then(function (m) { return String((m && m.id) || ''); }, function () { return ''; });
    }).then(function (me) { o.me = me; return cidArriveOne(body, o); });
    cidArriving = run.then(function () {}, function () {});
    return run;
  }

  /* The name a delivery's payer gave, proved (H1): `from` and `tag` are only
   * believed when the tag is SHA-256("foxy-cashu-id-from-v1" ‖ x(d·from) ‖ E),
   * worked out by this phone from its own ID key, with E one of the proofs'.
   * The contact's name, or '' for anyone else. Never rejects. */
  function cidFromName(got) {
    if (!got.from || !got.tag || !CID_HEX33.test(got.E)) return Promise.resolve('');
    if (!got.proofs.some(function (pr) { return String(pr.p2pk_e || '').toLowerCase() === got.E; })) return Promise.resolve('');
    var who = cidContactOf(got.from);
    if (!who) return Promise.resolve('');
    return nativeJson('cashuIdTag', { peer: got.from, e: got.E }, 60000).then(function (j) {
      var tag = String((j && j.tag) || '').toLowerCase();
      if (tag && tag === got.tag) return who.name;
      console.warn('[foxy] cashu id: a delivery named a contact as its payer without proving it');
      return '';
    }, function () { return ''; });
  }

  /* What a payer sent, checked and taken: 'taken', 'kept' (for when this phone
   * can take it), 'waiting' (at a mint this phone does not use: for its
   * receiver to decide, or smaller than the fee to bring it home), 'away'
   * (taken at a mint this phone does not use, on its way home: `carryResume`
   * finishes it), 'there' (taken and kept at that mint, now one this phone
   * uses), 'back' (taken there and paid back to its payer), 'seen' (taken
   * already) or 'refused'. Never rejects. `opts.choice`: the receiver's answer
   * on the card ('home', 'keep', 'back', `cidDecide`).
   *
   * Anyone holding this phone's ID can write to it, so nothing is kept, nothing
   * is asked of any mint and the phone signs nothing until the delivery is
   * shown to be shaped like money (an E and a DLEQ on every piece); and nothing
   * is taken until it is the mint's own ecash: of a keyset of its unit, every
   * DLEQ verifying, no piece twice, and small. Then the phone signs only for
   * pieces whose lock is the ID blinded by their own E. At a mint this phone
   * does not use, the mint is asked only within the hourly cap and outside its
   * backoff, and the money is taken only once the way home has been quoted
   * (`cidForeign`). */
  function cidArriveOne(body, opts, loaded) {
    var o = opts || {};
    var key = '';
    var refuse = function (why) {
      console.warn('[foxy] cashu id: a delivery was not taken: ' + why);
      if (key) cidInboxDrop(key);
      // for a card's answer (`cidDecide`): what to say
      o.said = String(why || '');
      return 'refused';
    };
    var text = typeof body === 'string' ? body : (body && typeof body === 'object' ? JSON.stringify(body) : '');
    if (!text || text.length > CID_BODY_MAX) return Promise.resolve(refuse('it is larger than any payment'));
    var first = cidReadDelivery(text, null);
    if (first.why) return Promise.resolve(refuse(first.why));
    var mint = canonicalMint(String(first.mint || ''));
    if (!mint || mintUrlProblem(mint)) return Promise.resolve(refuse('its mint is not one Foxy would use'));
    var unit = unitOf(first.unit);
    if (unit !== 'sat' && unit !== 'usd') return Promise.resolve(refuse('it is in a unit Foxy does not take'));
    var kw0 = tillKeysAt(mint, unit);
    var got = kw0 ? cidReadDelivery(text, kw0) : first;
    if (got.why) return Promise.resolve(refuse(got.why));
    var proofs = got.proofs;
    if (!proofs.length || proofs.length > CID_PROOFS_MAX) return Promise.resolve(refuse('it holds no usable proofs'));
    /* Paid to the ID key itself, unblinded: never signed for by itself. The receiver is asked (`cidBare`). */
    var me = String(o.me || '').toLowerCase();
    var bare = CID_HEX33.test(me) ? proofs.filter(function (pr) { return cidIsBare(pr, me); }).length : 0;
    if (bare && bare < proofs.length) return Promise.resolve(refuse('it mixes pieces locked to the ID key itself with others'));
    if (bare) return cidBare({ text: text, got: got, proofs: proofs, mint: mint, unit: unit, refuse: refuse, opts: o });
    /* ANY WALLET's request answered (`cidAnyRequest`): no E anywhere, every piece locked to one of this seed's lock
     * keys, taken as any locked ecash is (`cidPoolTake`). */
    if (cidPoolShaped(got, proofs)) return cidPoolTake({ got: got, proofs: proofs, mint: mint, unit: unit, refuse: refuse });
    for (var i = 0; i < proofs.length; i++) {
      var no = cidProofProblem(proofs[i]);
      if (no) return Promise.resolve(refuse(no));
    }
    if (repeatedProof(proofs)) return Promise.resolve(refuse('it names the same ecash more than once'));
    var at = 'cid:' + piecesFingerprint(proofs);
    if (cidSeenAny(proofs)) {
      cidInboxDrop(at);
      cidOfferDrop(at);
      console.log('[foxy] cashu id: a delivery taken already, read again; nothing more taken');
      return Promise.resolve('seen');
    }
    var amount = proofs.reduce(function (n, pr) { return n + satsOf(pr.amount); }, 0);
    var locktimes = proofs.map(cidLocktimeOf);
    var soonest = locktimes.some(function (t) { return t === 0; }) ? 0 : Math.min.apply(null, locktimes);
    /* At a mint this phone does not use: brought home, or, smaller than the fee
     * of that, waiting for more there. */
    if (!cidListedMint(mint)) {
      return cidForeign({ text: text, got: got, mint: mint, unit: unit, proofs: proofs, at: at, amount: amount, soonest: soonest,
                          kw: kw0, loaded: !!loaded, refuse: refuse, opts: o });
    }
    /* Kept (H2) only while its payer cannot have it back: every piece with a
     * locktime more than a day out. The row goes a day before the soonest. */
    var keep = function (why) {
      if (!(soonest > 0) || soonest * 1000 - CID_DAY_S * 1000 <= Date.now()) {
        return refuse('it cannot be taken now and has no locktime far enough out to keep it for (' + why + ')');
      }
      try { cidInboxKeep(at, text, mint, soonest * 1000 - CID_DAY_S * 1000); }
      catch (e) { return refuse('it could not be written down (' + ((e && e.message) || e) + ')'); }
      console.log('[foxy] cashu id: a delivery is kept until ' + why);
      return 'kept';
    };
    var kw = kw0;
    var sets = kw ? keysetsOf(mint, kw) : null;
    var known = !!sets && proofs.every(function (pr) { return typeof pr.id === 'string' && !!keysetUnit(mint, pr.id, kw, sets); });
    if (!kw || !known) {
      var here = !!wallet && canonicalMint(mintUrl || '') === mint;
      // a mint's keys are fetched for a delivery at a mint this phone uses, and never in a backoff
      if (!loaded && !here && wallet && routeOpen() && !cidBackedOff(mint)) {
        return tillMintLoad(mint, !!kw).then(function () {
          delete cidBackoff[mint];
          return cidArriveOne(text, o, true);
        }, function () {
          cidBackOff(mint);
          return keep('the keys of ' + hostOf(mint) + ' can be had');
        });
      }
      if (here || loaded) return Promise.resolve(refuse('its pieces are not of ' + hostOf(mint) + '’s keysets'));
      return Promise.resolve(keep('this phone can fetch the keys of ' + hostOf(mint)));
    }
    // from here every check is the mint's own keys': one that fails drops a kept copy
    key = at;
    var bad = cidMintProblem(mint, unit, kw, sets, proofs);
    if (bad) return Promise.resolve(refuse(bad));
    key = '';
    if (!wallet || !routeOpen() || claimAway) return Promise.resolve(keep('this phone is online'));
    return cidTakeIn({ got: got, proofs: proofs, mint: mint, unit: unit, at: at }).then(function (t) {
      if (t.taken) return 'taken';
      if (t.later) return keep(t.later);
      key = t.drop ? at : '';
      return t.seen ? 'seen' : refuse(t.why);
    });
  }

  /* The checks by the mint's own keys, in hand: every piece of a keyset of the
   * delivery's unit, and every DLEQ verifying. Why not, or ''. */
  function cidMintProblem(mint, unit, kw, sets, proofs) {
    if (!proofs.every(function (pr) { return keysetUnit(mint, pr.id, kw, sets) === unit; })) {
      return 'its pieces are not of ' + hostOf(mint) + '’s ' + unit + ' keysets';
    }
    if (dleqAudit(kw, proofs).invalid || !mintSigned(kw, proofs)) return 'the mint’s signature on it does not check out';
    return '';
  }

  /* One delivery whose every check by the mint's keys has passed, signed for by
   * the phone and swapped in at its mint (`receiveToken`, away from the mint the
   * phone is on where it is another). Resolves { taken, r, name }, or { later }
   * (it may be taken later: the words why), or { why, drop, seen } (never). */
  function cidTakeIn(d) {
    var proofs = d.proofs, mint = d.mint, unit = d.unit, at = d.at, got = d.got;
    var held = cidHold(proofs);
    if (!held) return Promise.resolve({ seen: true, why: 'it is being taken already' });
    var free = held;
    var pieces = proofs.map(function (pr) { return { secret: pr.secret, e: String(pr.p2pk_e).toLowerCase() }; });
    return nativeJson('cashuIdSign', { pieces: pieces }, 60000).then(function (signedBy) {
      var sigs = Array.isArray(signedBy && signedBy.sigs) ? signedBy.sigs : [];
      if (sigs.length !== proofs.length) throw new Error('the phone’s signatures were not for what was asked');
      // locked to its own blinded key alone, its locktime far enough out to take it now, and nothing else asked of it
      if (!proofs.every(function (pr) { return onlyLockedTo(pr, lockedTo(pr), { swapNow: true }); })) {
        return { why: 'it is not locked to one key alone, or its time lock is too near', drop: true };
      }
      var CT = window.CashuTS;
      var signed = cidForMint(proofs, sigs);
      if (!signed.every(function (pr) { try { return CT.isP2PKSpendAuthorised(pr) === true; } catch (e) { return false; } })) {
        throw new Error('the phone’s signatures did not check out');
      }
      return cidFromName(got).then(function (name) {
        var token = encodeToken(mint, signed, unit);
        var memo = name ? 'From ' + name : 'From a Cashu ID';
        var away = canonicalMint(mintUrl || '') !== mint;
        /* Said at once as arriving: every check this phone can make has passed (the mint's keys and DLEQs, the lock, its
         * own signatures), and the mint's swap is what is left. Not counted anywhere until that lands, and never said as
         * received before it (`_onCashuIdPaid`). Not for one being brought home, which is said once it is home. */
        if (!d.quiet) {
          var coming = proofs.reduce(function (n, pr) { return n + satsOf(pr.amount); }, 0);
          console.log('[foxy] cashu id: a payment checked on this phone; the mint is swapping it');
          if (typeof FoxyWallet._onCashuIdArriving === 'function') {
            try { FoxyWallet._onCashuIdArriving({ unit: unit, amount: coming, name: name, mint: mint }); } catch (x) {}
          }
        }
        return FoxyWallet.receiveToken(token, { memo: memo, away: away }).then(function (r) {
          cidSeenAdd(proofs);
          cidInboxDrop(at);
          cidOfferDrop(at);
          if (r && r.hash) {
            try { amendTx(r.hash, { memo: memo, cid: 'in' }); } catch (x) {}
            var note = got.note ? cidCleanName(String(got.note).slice(0, CID_NOTE_MAX)) : '';
            if (note) { try { FoxyWallet.tag(r.hash, { note: note }); } catch (x) {} }
          }
          console.log('[foxy] cashu id: a payment was taken in at ' + hostOf(mint));
          return { taken: true, r: r, name: name };
        }, function (e) {
          var why = String((e && e.message) || e);
          if (/already|spent/i.test(why)) {
            cidSeenAdd(proofs);
            cidOfferDrop(at);
            return { why: 'the mint has it as spent already', drop: true };
          }
          if (tillMintSaidNo(e)) { cidOfferDrop(at); return { why: 'the mint refused it (' + why.slice(0, 120) + ')', drop: true }; }
          return { later: 'it can be taken (' + why.slice(0, 80) + ')' };
        });
      });
    }, function (e) {
      var why = String((e && e.message) || e);
      // the phone's own no: not locked to the key this seed derives for that E, which nothing will change
      if (/not locked to this Cashu ID|not a payment to this Cashu ID|bad request/i.test(why)) {
        cidOfferDrop(at);
        return { why: 'it is not locked to the key this phone works out from it (' + why.slice(0, 80) + ')', drop: true };
      }
      return { later: 'the phone can sign for it (' + why.slice(0, 80) + ')' };
    }).then(function (r) {
      free();
      // a payment being brought home is said once it is home (`cidCameHome`)
      if (r && r.taken && !d.quiet && typeof FoxyWallet._onCashuIdPaid === 'function') {
        try { FoxyWallet._onCashuIdPaid({ unit: unit, amount: r.r && r.r.amount, sats: r.r && r.r.sats, hash: r.r && r.r.hash, name: r.name, mint: mint }); } catch (x) {}
      }
      return r;
    }, function (e) { free(); throw e; });
  }

  /* ---- a mint this phone does not use: the receiver's choice ----
   *
   * The money there is this phone's to take, and where it goes is its
   * receiver's to say. Before anything is signed or swapped the way home is
   * quoted (`cidHomeQuote`), and a card asks (26o-cashu-id.js):
   *
   *   BRING IT HOME   taken there and crossed to the default mint by the road a
   *                   payment taken at a payer's mint takes (`bringHome`,
   *                   `carryHome`, 04-lost-answers.js): sats as sats, dollars as
   *                   dollars at a default mint that issues them and as sats at
   *                   one that does not;
   *   KEEP IT THERE   taken there, and that mint is one this phone uses from now
   *                   on (`cidUseMint`);
   *   SEND IT BACK    taken there and paid straight back to its payer's ID, at the
   *                   same mint, as any payment to a contact (`cidSendBack`), where
   *                   the payer proved who it is and this phone knows where to send.
   *
   * Until it is answered it waits (`K.cidOffers`), listed in HISTORY. The card's
   * tick remembers the answer for that mint (`cidChoiceOf`), and a remembered one
   * runs without a card: "home" is what every one did before there was a card. A
   * mint whose way home cannot be quoted (a fake one, one that does not answer)
   * is backed off; a remembered "home" then takes nothing, and a card says BRING
   * IT HOME cannot be done and why. One smaller than its crossing's fee waits
   * until a later one at the same mint, in the same unit, makes the whole worth
   * crossing; its card still offers the other two. */
  function cidForeign(d) {
    var refuse = d.refuse, mint = d.mint, unit = d.unit;
    var o = d.opts || {};
    // the receiver's own answer, from the card: not counted against the hour's five, nor stopped by a backoff
    var decided = Object.prototype.hasOwnProperty.call(CID_CHOICES, o.choice) ? o.choice : '';
    if (!decided && cidOfferRows().some(function (r) { return r.key === d.at; })) return Promise.resolve('waiting');
    var drop = d.soonest > 0 ? d.soonest * 1000 - CID_DAY_S * 1000 : Date.now() + CID_LOCK_S * 1000;
    if (!(drop > Date.now())) return Promise.resolve(refuse('its payer can have it back within the day'));
    var home = canonicalMint(String(load(K.mint, '') || mintUrl || ''));
    if (!home || home === mint) return Promise.resolve(refuse('this phone has no mint of its own to bring it to'));
    if (!wallet || !routeOpen() || claimAway) return Promise.resolve(refuse('it is at a mint this phone does not use, and cannot be looked at now (the relays still hold it)'));
    if (!decided && cidBackedOff(mint)) return Promise.resolve(refuse(hostOf(mint) + ' failed a moment ago and is not asked again yet'));
    if (!d.loaded) {
      if (!decided && !cidForeignSpend()) return Promise.resolve(refuse('too many payments at mints this phone does not use have come in the last hour'));
      return tillMintLoad(mint, true).then(function () {
        delete cidBackoff[mint];
        return cidArriveOne(d.text, o, true);
      }, function (e) {
        cidBackOff(mint);
        return refuse('the keys of ' + hostOf(mint) + ' did not come (' + String((e && e.message) || e).slice(0, 80) + ')');
      });
    }
    var kw = d.kw;
    var sets = kw ? keysetsOf(mint, kw) : null;
    if (!kw || !sets || !d.proofs.every(function (pr) { return typeof pr.id === 'string' && !!keysetUnit(mint, pr.id, kw, sets); })) {
      cidBackOff(mint);
      return Promise.resolve(refuse('its pieces are not of ' + hostOf(mint) + '’s keysets'));
    }
    var bad = cidMintProblem(mint, unit, kw, sets, d.proofs);
    if (bad) { cidBackOff(mint); return Promise.resolve(refuse(bad)); }
    var item = { text: d.text, got: d.got, proofs: d.proofs, at: d.at, amount: d.amount, opts: o };
    return cidWho(d.got).then(function (who) {
      var choice = decided || cidChoiceOf(mint);
      // a remembered SEND IT BACK for a payer this phone cannot send to: the card asks instead
      if (choice === 'back' && !who.back) {
        if (decided) return refuse('its payer did not prove who it is, so it cannot be sent back');
        choice = '';
      }
      if (choice === 'keep') return cidKeepThere(item, mint, unit);
      if (choice === 'back') return cidSendBack(item, mint, unit, home, who);
      // what waits at the same mint in the same unit, read again by its keys: the whole is what the way home is quoted for
      var items = /** @type {any[]} */ ([item]);
      cidOfferRows().forEach(function (r) {
        if (r.mint !== mint || r.key === d.at || (unitOf(r.unit) || 'sat') !== unit) return;
        var g = cidReadDelivery(r.body, kw);
        var ps = g.why ? [] : g.proofs;
        if (!ps.length || ps.some(function (pr) { return !!cidProofProblem(pr); }) || cidMintProblem(mint, unit, kw, sets, ps)) {
          cidOfferDrop(r.key);
          console.warn('[foxy] cashu id: a payment waiting at ' + hostOf(mint) + ' no longer checks out; let go');
          return;
        }
        items.push({ text: r.body, got: g, proofs: ps, at: r.key, amount: ps.reduce(function (n, pr) { return n + satsOf(pr.amount); }, 0) });
      });
      var total = items.reduce(function (n, it) { return n + it.amount; }, 0);
      var pieces = items.reduce(function (n, it) { return n + it.proofs.length; }, 0);
      // it waits, with what the way home was quoted at, and the card is raised where nobody has chosen yet
      var wait = function (q) {
        var row = { key: d.at, body: d.text, at: Date.now(), mint: mint, unit: unit, amount: d.amount, name: who.name,
                    from: who.back ? who.back.id : '', drop: drop, q: q };
        var kept = false;
        try { kept = cidOfferKeep(row); } catch (e) { kept = false; }
        if (!kept) return refuse('it could not be written down to wait for its receiver');
        cidOfferQuoteAll(mint, unit, q);
        console.log('[foxy] cashu id: a payment at ' + hostOf(mint) + ', a mint this phone does not use, waits'
          + (q.lands > 0 ? ' for its receiver to choose' : ' (' + q.why + ')'));
        cidHistoryChanged();
        if (!choice && typeof FoxyWallet._onCashuIdOffer === 'function') {
          var mine = cidOfferRows().filter(function (r) { return r.key === d.at; })[0];
          if (mine) { try { FoxyWallet._onCashuIdOffer(cidOfferView(mine)); } catch (x) {} }
        }
        o.said = q.why || '';
        return 'waiting';
      };
      return cidHomeQuote(mint, home, unit, total, pieces, kw).then(function (q) {
        if (choice === 'home' && q.lands > 0) return cidBringHome(mint, home, items, unit, q);
        return wait(q);
      }, function (e) {
        cidBackOff(mint);
        var why = 'The way home from ' + hostOf(mint) + ' could not be quoted: ' + String((e && e.message) || e).slice(0, 100);
        // remembered, or asked for: nothing is taken (the relays still hold it); otherwise the card says why
        if (choice === 'home' && !decided) return refuse(why + ', so nothing was taken');
        return wait({ lands: 0, toUnit: '', fee: 0, why: why, at: Date.now() });
      });
    });
  }

  /* The unit a payment in `unit` lands in at `home`: sats as sats, and dollars
   * as dollars where home issues them on an active keyset, else as sats. */
  function cidHomeUnit(home, unit) {
    if ((unitOf(unit) || 'sat') === 'sat') return 'sat';
    var here = wallet && canonicalMint(mintUrl || '') === canonicalMint(home) ? wallet : undefined;
    return unitsOf(canonicalMint(home), here).indexOf('usd') >= 0 ? 'usd' : 'sat';
  }

  var CID_TOO_SMALL = 'Too small to bring home: the fee would take all of it.';

  /* The way home for `total` (in `unit`) taken at `from`, quoted before
   * anything is signed: what would land at `home` (`lands`, in `toUnit`) after
   * the crossing's whole cost, which is the invoice's reserve, both mints' fees
   * for spending the pieces, and the swap that takes them in; and that cost
   * less what lands is worth, in `unit` (`fee`). Asked of both mints with
   * nothing in hand (`transferQuote`'s `quoteOnly`), stepped down as
   * `carryPlan` steps until the cost fits inside the total: by what it is over
   * in one unit, and in proportion across two, from a first figure in the
   * landing unit that a quote for 10,000 sats prices. `lands` 0, with `why`,
   * where it does not fit. Rejects where a mint cannot quote it. */
  function cidHomeQuote(from, home, unit, total, pieces, kw) {
    var toUnit = cidHomeUnit(home, unit);
    var takeFee = 0;
    try { takeFee = Number(feeForInputs(kw, Math.max(1, pieces))) || 0; } catch (e) { takeFee = 0; }
    var how = /** @type {any} */ ({ to: home, quoteOnly: true });
    if (unit !== 'sat') how.unit = unit;
    if (toUnit !== 'sat') how.toUnit = toUnit;
    var small = { lands: 0, toUnit: toUnit, fee: 0, why: CID_TOO_SMALL, small: true, at: Date.now() };
    var step = function (want, n) {
      if (!(want > 0)) return Promise.resolve(small);
      return FoxyWallet.transferQuote(from, want, how).then(function (plan) {
        var cost = Number(plan.gross) + (Number(plan.inPadSats) || 0) + takeFee;
        var over = cost - total;
        if (over > 0 && n < 4) return step(unit === toUnit ? want - over : Math.min(want - 1, Math.floor(want * total / cost)), n + 1);
        if (over > 0) return small;
        var worth = unit === toUnit ? want : Math.round(Number(plan.amountUnit) || 0);
        return { lands: want, toUnit: toUnit, fee: Math.max(0, cost - worth), why: '', small: false, at: Date.now() };
      });
    };
    if (!(total - takeFee > 0)) return Promise.resolve(small);
    if (unit === toUnit) return step(total - takeFee, 0);
    // dollars to sats: a first figure from what 10,000 sats cost at that mint, in its cents
    var PROBE = 10000;
    return FoxyWallet.transferQuote(from, PROBE, how).then(function (plan) {
      var each = Number(plan.amountUnit) || 0;
      if (!(each > 0)) throw new Error(hostOf(from) + ' gave no price for the way home');
      return step(Math.floor((total - takeFee) * PROBE / each), 0);
    });
  }

  /* Every item taken at `mint` (signed for, swapped in there, in `unit`), and the
   * sum carried home as one payment (`bringHome`), whose history row at home says
   * who sent it, from where, what it landed as, and the fee (`cidCameHome`).
   * Resolves 'taken' once it is home, 'away' when it is this phone's at that
   * mint and the walk home is left to `carryResume`, 'refused' when nothing
   * could be taken. */
  function cidBringHome(mint, home, items, unit, q) {
    var before = sumProofs(proofs(mint, unit));
    // its visit puts it in this phone's lists; it is still not a mint this phone uses (`cidListedMint`)
    cidBroughtNote(mint);
    var kept = 0, hash = '', name = '';
    return items.reduce(function (chain, it) {
      return chain.then(function () {
        return cidTakeIn({ got: it.got, proofs: it.proofs, mint: mint, unit: unit, at: it.at, quiet: true }).then(function (t) {
          if (t.taken) {
            kept += Math.round(satsOf(t.r && (t.r.amount != null ? t.r.amount : t.r.sats))) || 0;
            if (!hash && t.r && t.r.hash) hash = t.r.hash;
            if (!name && t.name) name = t.name;
            return;
          }
          // a waiting one that cannot be taken any more (its payer took it back, or the mint says no) goes
          if (it.at !== items[0].at) cidOfferDrop(it.at);
          console.warn('[foxy] cashu id: a payment at ' + hostOf(mint) + ' was not taken: ' + (t.why || t.later || 'it is being taken'));
        });
      });
    }, Promise.resolve()).then(function () {
      if (!(kept > 0)) return 'refused';
      return cidCarry({ mint: mint, home: home, unit: unit, toUnit: q && q.toUnit, amount: kept, guess: q && q.lands,
                        before: before, name: name, hash: hash });
    });
  }

  /* `bringHome`: money this phone holds at a mint it does not use, `amount` in
   * `unit`, carried home to the default mint as one payment, by the carry-home
   * job (04-lost-answers.js), so a crossing that dies after the melt is finished
   * on the next launch, connection or return (`carryResume`, `finishMove`). It
   * lands in `toUnit`: by default dollars as dollars where home issues them, and
   * everything else as sats. Its row at home is written by `cidCameHome`, with
   * `name` ("a Cashu ID" without one). Resolves 'taken' once it is home, or
   * 'away' when it is still at that mint, this phone's, for the walk home to
   * finish. Never rejects. */
  function cidCarry(dl) {
    var mint = canonicalMint(String(dl.mint || ''));
    var unit = unitOf(dl.unit) || 'sat';
    var home = canonicalMint(String(dl.home || load(K.mint, '') || mintUrl || ''));
    var kept = Math.round(satsOf(dl.amount) || 0);
    if (!mint || !home || mint === home || !(kept > 0)) return Promise.resolve('refused');
    var toUnit = unitOf(dl.toUnit) || cidHomeUnit(home, unit);
    var job = /** @type {any} */ ({ id: 'cid' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
                home: home, from: mint, net: 0, ask: kept, kept: kept, state: 'paid', paidAt: Date.now(), at: Date.now(),
                unit: unit, hash: String(dl.hash || ''),
                cid: { name: String(dl.name || ''), before: Number(dl.before) || 0 } });
    if (toUnit !== 'sat') job.toUnit = toUnit;
    // across units, the first figure is in the landing unit (`carryPlan`)
    if (toUnit !== unit && Number(dl.guess) > 0) job.guess = Math.round(Number(dl.guess));
    var said = function (n, u) { return u === 'usd' ? cidSaid(n, 'usd') : n + ' sats'; };
    try { putCarryJob(job, true); }
    catch (e) {
      console.warn('[foxy] cashu id: ' + said(kept, unit) + ' taken at ' + hostOf(mint) + ' could not be written down to bring home; they stay there');
      return Promise.resolve('away');
    }
    console.log('[foxy] cashu id: ' + said(kept, unit) + ' taken at ' + hostOf(mint) + ', a mint this phone does not use; bringing them home'
      + (toUnit !== unit ? ' as ' + (toUnit === 'usd' ? 'dollars' : 'sats') : ''));
    return FoxyWallet.carryHome(job.id, null, function () {}, {}).then(function (r) {
      var state = String((r && r.state) || '');
      if (state === 'home') return 'taken';
      console.warn('[foxy] cashu id: the payment from ' + hostOf(mint) + ' is not home yet (' + state + (r && r.why ? ': ' + String(r.why).slice(0, 80) : '') + ')');
      return 'away';
    }, function () { return 'away'; });
  }

  // an amount in words for a history row: "3,901 sats", "1 sat", "$2.94"
  function cidSaid(n, unit) {
    var v = Math.round(Number(n) || 0);
    if ((unitOf(unit) || 'sat') === 'usd') {
      return (v < 0 ? '-$' : '$') + (Math.abs(v) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return v.toLocaleString('en-US') + (v === 1 ? ' sat' : ' sats');
  }

  /* A payment taken at another mint has landed at home (`carryGo`, or late by
   * `moveLanded`): its row at home says who sent it, where it came from, and
   * what bringing it cost, in the unit it left in: what it was, less any change
   * the route's reserve left at that mint, less what landed was worth there (the
   * same figure in one unit; across two, what the invoice cost at that mint).
   * Sats that land as sats keep the row they always had ("…, fee 2 sats"); a
   * crossing from dollars says what it landed as ("…, as 3,901 sats, fee $0.06"). */
  function cidCameHome(job, quote, sats, done) {
    var c = job && job.cid;
    if (!c) return;
    var ju = unitOf(job.unit) || 'sat', tu = unitOf(job.toUnit) || 'sat';
    var kept = Math.round(Number(job.kept) || 0);
    var landed = Math.round(Number(sats) || 0);
    var left = done ? sumProofs(proofs(canonicalMint(job.from), ju)) : 0;
    var base = done ? Math.round(Number(c.before) || 0) : 0;
    var worth = ju === tu ? landed : Math.round(Number(job.priceUnit) || 0);
    var fee = Math.max(0, base + kept - (done ? left : 0) - worth);
    var who = c.name || 'a Cashu ID';
    var memo = ju === 'sat' && tu === 'sat'
      ? 'From ' + who + ', came home from ' + hostOf(job.from) + ', fee ' + fee + (fee === 1 ? ' sat' : ' sats')
      : 'From ' + who + ', came home from ' + hostOf(job.from) + ' as ' + cidSaid(landed, tu) + ', fee ' + cidSaid(fee, ju);
    try { amendTx(quote, { memo: memo, cid: 'in' }); } catch (x) {}
    if (job.hash) { try { amendTx(job.hash, { memo: 'From ' + who + ', brought home', cid: 'in' }); } catch (x) {} }
    console.log('[foxy] cashu id: a payment from ' + hostOf(job.from) + ' came home, ' + cidSaid(landed, tu) + ', fee ' + cidSaid(fee, ju));
    cidHistoryChanged();
    if (typeof FoxyWallet._onCashuIdPaid === 'function') {
      try {
        FoxyWallet._onCashuIdPaid({ unit: tu, amount: landed, sats: tu === 'sat' ? landed : 0, hash: quote, name: c.name || '',
                                    mint: canonicalMint(job.home), fee: fee, feeUnit: ju });
      } catch (x) {}
    }
  }

  /* KEEP IT THERE: the mint becomes one this phone uses (`cidUseMint`), and this
   * delivery is taken as one at any of its mints is, swapped in there where the
   * phone is not; so is every other one waiting there. 'there' once taken. */
  function cidKeepThere(item, mint, unit) {
    cidUseMint(mint);
    var took = function (body, at) {
      return cidArriveOne(body, {}, true).then(function (r) {
        // taken, kept for when it can be, or refused: no longer for its receiver to decide either way
        cidOfferDrop(at);
        return r;
      });
    };
    return took(item.text, item.at).then(function (r) {
      var others = cidOfferRows().filter(function (x) { return x.mint === mint; });
      return others.reduce(function (chain, x) { return chain.then(function () { return took(x.body, x.key); }); }, Promise.resolve()).then(function () {
        cidHistoryChanged();
        console.log('[foxy] cashu id: a payment at ' + hostOf(mint) + ' is kept there (' + r + ')');
        return r === 'taken' ? 'there' : r;
      });
    });
  }

  /* SEND IT BACK: taken at that mint, and at once paid back to its payer's ID at
   * the same mint, as a payment to a contact is (`cidPay`: a one-time key, a
   * locktime, a refund key, its copy to this seed's recovery key), for what was
   * taken less what that mint charges to make it (`changeFromPile`). No
   * crossing, and no fee but the mint's own. A pay-back that fails after the
   * take leaves the money at that mint, this phone's, and the mint is one it
   * uses from then on; the row says so. 'back' once it is on its way to them,
   * 'there' when it stayed. */
  function cidSendBack(item, mint, unit, home, who) {
    var o = item.opts || {};
    var to = who.back;
    var name = cidCleanName(who.name || to.name) || 'a Cashu ID';
    return cidTakeIn({ got: item.got, proofs: item.proofs, mint: mint, unit: unit, at: item.at, quiet: true }).then(function (t) {
      if (!t.taken) {
        if (t.later) return 'waiting';
        return t.seen ? 'seen' : 'refused';
      }
      cidOfferDrop(item.at);
      var kept = Math.round(satsOf(t.r && (t.r.amount != null ? t.r.amount : t.r.sats))) || 0;
      var hash = (t.r && t.r.hash) || '';
      var from = 'From ' + (t.name || name);
      // the visit puts it in this phone's lists; it is still not a mint this phone uses, unless the money stays there
      if (!cidListedMint(mint)) cidBroughtNote(mint);
      var stayed = function (e) {
        var why = String(FoxyWallet.reason ? FoxyWallet.reason(e) : ((e && e.message) || e)).slice(0, 120);
        cidUseMint(mint);
        if (hash) { try { amendTx(hash, { memo: from + ', kept at ' + hostOf(mint) + ': it could not be sent back', cid: 'in' }); } catch (x) {} }
        console.warn('[foxy] cashu id: a payment could not be sent back; it stays at ' + hostOf(mint) + ': ' + why);
        o.said = why;
        return 'there';
      };
      return carryVisit(mint).then(function () {
        return unit === 'sat' ? wallet : unitWalletLocal(unit);
      }).then(function (w) {
        var back = changeFromPile(w, kept, unit);
        if (!(back > 0)) throw new Error('What came is too small to send back after ' + hostOf(mint) + '’s fee.');
        return cidPay(to.id, back, { unit: unit, name: name, memo: 'Sent back to ' + name, read: { id: to.id, nostr: to.nostr } });
      }).then(function () {
        if (hash) { try { amendTx(hash, { memo: from + ', sent back', cid: 'in' }); } catch (x) {} }
        console.log('[foxy] cashu id: a payment at ' + hostOf(mint) + ' was sent back to its payer');
        return 'back';
      }, stayed).then(function (r) {
        return carryGoHome(home).then(function () { cidHistoryChanged(); return r; });
      });
    });
  }

  /* The receiver's answer on the card: 'home', 'keep' or 'back' for the waiting
   * delivery `key`, remembered for its mint with `always`. One at a time, with
   * the deliveries (`cidArrived`). Resolves { state, why }: the states of
   * `cidArriveOne`, and 'gone' for one no longer waiting. Never rejects. */
  function cidDecide(key, choice, always) {
    var run = cidArriving.then(function () {
      var row = cidOfferRows().filter(function (r) { return r.key === key; })[0];
      if (!row) return { state: 'gone', why: 'That payment is no longer waiting.' };
      if (!Object.prototype.hasOwnProperty.call(CID_CHOICES, choice)) return { state: 'refused', why: 'Foxy does not know that answer.' };
      if (choice === 'back' && !(row.from && cidBackTo(row.from))) {
        return { state: 'refused', why: 'Its payer did not say who it is, so it cannot be sent back.' };
      }
      if (!wallet || !routeOpen()) return { state: 'later', why: 'This needs a connection. It waits until there is one.' };
      if (always) cidChoiceSet(row.mint, choice);
      var o = /** @type {any} */ ({ choice: choice });
      return cidArriveOne(row.body, o).then(function (state) {
        cidHistoryChanged();
        var still = cidOfferRows().filter(function (r) { return r.key === key; })[0];
        return { state: state, why: String(o.said || (still && still.q && still.q.why) || ''), view: still ? cidOfferView(still) : null };
      });
    }).then(null, function (e) {
      return { state: 'refused', why: String((e && e.message) || e) };
    });
    cidArriving = run.then(function () {}, function () {});
    return run;
  }

  /* What was kept for later, taken now that there is a route: not a row whose
   * mint is in its backoff, which would only be kept again. */
  function cidDrain() {
    var rows = cidInboxRows();
    if (!rows.length || !wallet || !routeOpen()) return Promise.resolve(0);
    var took = 0;
    return rows.reduce(function (chain, r) {
      return chain.then(function () {
        if (r.mint && cidBackedOff(r.mint)) return null;
        return cidArrived(r.body).then(function (got) { if (got === 'taken') took += 1; });
      });
    }, Promise.resolve()).then(function () { return took; });
  }

  /* ---- ANY WALLET: a standard payment request, for a wallet that cannot blind ----
   *
   * MY CASHU ID's second button. A NUT-18 request (`creqA…`) any Cashu wallet pays today: no amount, the unit the
   * phone is in, this phone's mints that honour a lock (the default first), locked (NUT-11 through `nut10`) to a fresh
   * key from the seed-derived lock pool (`takeLockKey`, the key a receive request takes, filed as `cid-any-<id>`), and
   * a Nostr transport to a key of the request's own (`cidAnyKey`: the delivery key moved by the request's id, listened
   * for a year), its nprofile naming the three relays its inbox listens on. Every
   * opening takes a new key, so no two payers lock to the same one and the mint sees a key once; a key handed out
   * twice (a code shown again, a payer that pays twice) still opens what is locked to it, once per delivery. The
   * payment arrives on the ID's inbox as a NUT-18 payload with no E, and is taken as any ecash locked to this seed
   * (`cidPoolTake`, `receiveToken`): a key no row names is found by the walk (`lockKeyMatching`), as after a restore
   * from the words, at most five such walks an hour. */
  // NostrDelivery.fallbackRelays, the three the ID's inbox listens on (tests/cashu-id-any.js holds the two the same)
  var CID_RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.minibits.cash'];
  var CID_ANY = 'cid-any-';
  var CID_ANY_MINTS = 5;
  var CID_WALKS = 'foxy.cid.walks';
  var CID_WALKS_MAX = 5;

  /* The mints a request names: the default first, then the one the phone is on and the others it has connected to,
   * each one this phone uses, that issues the unit and that honours a lock; at most five. */
  function cidAnyMints(unit) {
    var home = canonicalMint(String(load(K.mint, '') || mintUrl || ''));
    var here = canonicalMint(String(mintUrl || ''));
    var all = [home, here];
    var known = load(K.mints, []);
    if (Array.isArray(known)) all = all.concat(known);
    var out = [];
    all.forEach(function (u) {
      var m = canonicalMint(String(u || ''));
      if (!m || out.indexOf(m) >= 0 || out.length >= CID_ANY_MINTS || mintUrlProblem(m) || !cidListedMint(m)) return;
      var has = unitsOf(m);
      if (unit === 'sat' ? (has.length > 0 && has.indexOf('sat') < 0) : has.indexOf(unit) < 0) return;
      if (!tillMintLocks(m)) return;
      out.push(m);
    });
    return out;
  }

  /* The request: { text, id, pub, unit, mints, target }. Rejects with the sentence to show. */
  function cidAnyRequest(opts) {
    var o = opts || {};
    var CT = window.CashuTS;
    var unit = unitOf(o.unit || 'sat');
    if (unit !== 'sat' && unit !== 'usd') return Promise.reject(new Error('Foxy asks only in sats or dollars.'));
    if (!CT || !CT.PaymentRequest || !wallet || !mintUrl) return Promise.reject(new Error('Connect to a mint first.'));
    if (claimAway) return Promise.reject(new Error('Foxy is finishing a payment at another mint. Try again in a moment.'));
    return cidMine().then(function (mine) {
      var mints = cidAnyMints(unit);
      if (!mints.length) {
        throw new Error(unit === 'usd' ? 'None of your mints takes dollars locked to a key.' : 'None of your mints honours a payment locked to a key.');
      }
      return primeLockPool().then(function () {
        var idBytes = new Uint8Array(4);
        (window.crypto || window.msCrypto).getRandomValues(idBytes);
        var id = hexOf(idBytes);
        var pub = String(takeLockKey(CID_ANY + id, { unit: unit, amount: 0 }) || '').toLowerCase();
        // and the pool filled behind it, so the next opening has one
        primeLockPool();
        if (!CID_HEX33.test(pub)) throw new Error('No key to lock it to could be made. Try again in a moment.');
        // a key of this request's own, which the phone listens on for a year (`cidAnyKeep`): never the delivery key
        var target = cidNprofile(cidAnyKey(mine.nostr, id), CID_RELAYS);
        cidAnyKeep(id);
        var transport = [{ type: CT.PaymentRequestTransportType.NOSTR, target: target, tags: [['n', '17']] }];
        var text = new CT.PaymentRequest(transport, id, undefined, unit, mints, undefined, true,
                                         { kind: 'P2PK', data: pub, tags: [] }).toEncodedRequest();
        // a payment to it comes to the ID's inbox: the phone listens from now on
        cidMarkInUse();
        Promise.resolve(cidListenNow()).then(null, function () {});
        console.log('[foxy] cashu id: ANY WALLET: a request at ' + mints.length + ' mint(s) in ' + unit + ', locked to a fresh key of the pool');
        return { text: text, id: id, pub: pub, unit: unit, mints: mints, target: target };
      });
    });
  }

  // a proof with no E, P2PK-locked to one key that is not this phone's ID: what a wallet paying ANY WALLET sends
  function cidPoolShaped(got, proofs) {
    if (got.E) return false;
    return proofs.every(function (pr) {
      return pr && typeof pr === 'object' && !pr.p2pk_e && CID_HEX33.test(String(lockedTo(pr) || '').toLowerCase());
    });
  }

  // whether a lock row of this phone's names `pub`
  function cidPoolNamed(pub) {
    var all = lockKeys();
    return Object.keys(all).some(function (k) { return lockPubOf(all[k]) === pub; });
  }

  // one more walk of the seed for a key no row names, five an hour, kept across a restart (as `cidForeignSpend`)
  function cidWalkSpend() {
    var now = Date.now();
    var l = load(CID_WALKS, []);
    var times = (Array.isArray(l) ? l : []).map(Number).filter(function (t) { return t > now - CID_OFFER_RATE_MS && t <= now + 60000; });
    if (times.length >= CID_WALKS_MAX) return false;
    times.push(now);
    save(CID_WALKS, times);
    return true;
  }

  /* A payment to ANY WALLET's request: at a mint this phone uses, locked to a key of this seed, taken as any locked
   * ecash (`receiveToken`, away from the mint the phone is on where it is another), once. History: "From another
   * wallet". Resolves the states of `cidArriveOne`. */
  function cidPoolTake(d) {
    var proofs = d.proofs, mint = d.mint, unit = d.unit, refuse = d.refuse;
    for (var i = 0; i < proofs.length; i++) {
      var pr = proofs[i];
      if (typeof pr.secret !== 'string' || pr.secret.length > 1024 || typeof pr.C !== 'string' || !CID_HEX33.test(pr.C.toLowerCase())
          || typeof pr.id !== 'string' || !(satsOf(pr.amount) > 0)) return Promise.resolve(refuse('it holds a proof that is not ecash Foxy can read'));
    }
    if (repeatedProof(proofs)) return Promise.resolve(refuse('it names the same ecash more than once'));
    if (cidSeenAny(proofs)) { console.log('[foxy] cashu id: a payment from another wallet, taken already, read again'); return Promise.resolve('seen'); }
    if (!cidListedMint(mint)) return Promise.resolve(refuse('it is at ' + hostOf(mint) + ', a mint this phone does not use, which no request of this phone names'));
    var lock = String(lockedTo(proofs[0]) || '').toLowerCase();
    if (!proofs.every(function (x) { return String(lockedTo(x) || '').toLowerCase() === lock; })) return Promise.resolve(refuse('its pieces are locked to more than one key'));
    if (!wallet || !routeOpen() || claimAway) return Promise.resolve(refuse('this phone cannot reach the mint now (the relays still hold it)'));
    if (!cidPoolNamed(lock) && !cidWalkSpend()) return Promise.resolve(refuse('no request of this phone’s names its key, and the seed was walked five times this hour'));
    var hold = cidHold(proofs);
    if (!hold) return Promise.resolve('seen');
    var held = hold;
    var memo = 'From another wallet';
    var away = canonicalMint(mintUrl || '') !== mint;
    var token;
    try { token = encodeToken(mint, cidForMint(proofs, null), unit); }
    catch (e) { held(); return Promise.resolve(refuse('it would not make a token')); }
    return FoxyWallet.receiveToken(token, { memo: memo, away: away }).then(function (r) {
      cidSeenAdd(proofs);
      if (r && r.hash) {
        try { amendTx(r.hash, { memo: memo, cid: 'any' }); } catch (x) {}
        var note = d.got.note ? cidCleanName(String(d.got.note).slice(0, CID_NOTE_MAX)) : '';
        if (note) { try { FoxyWallet.tag(r.hash, { note: note }); } catch (x) {} }
      }
      console.log('[foxy] cashu id: a payment from another wallet (ANY WALLET) was taken in at ' + hostOf(mint));
      if (typeof FoxyWallet._onCashuIdPaid === 'function') {
        try { FoxyWallet._onCashuIdPaid({ unit: unit, amount: r && r.amount, sats: r && r.sats, hash: r && r.hash, name: '', mint: mint }); } catch (x) {}
      }
      return 'taken';
    }, function (e) {
      var why = String((e && e.message) || e);
      if (/already|spent/i.test(why)) { cidSeenAdd(proofs); return refuse('the mint has it as spent already'); }
      return refuse('it was not taken (' + why.slice(0, 120) + ')');
    }).then(function (st) { held(); return st; }, function (e) { held(); throw e; });
  }

  /* ---- paid to the ID key itself, unblinded ----
   *
   * A payer that locks to the ID as it is (a wallet handed the ID's key with no word to blind it) shows the mint the
   * ID at the claim: every such payment linked there, to this ID. The phone signs nothing for it by itself. The
   * receiver is asked, once a page load for each delivery (`_onCashuIdUnblinded`, the card PAID TO YOUR ID KEY):
   * LEAVE IT, the default, drops it (`foxy.cid.left`) and, where it carried a locktime and a refund key, its payer
   * has it back then; TAKE IT ANYWAY has the ID key itself sign for this delivery alone (`cashuIdSignUnblinded`,
   * logged on the phone) and takes it as any receipt, "From <name>, unblinded". Only at a mint this phone uses. */
  var CID_LEFT = 'foxy.cid.left';
  var CID_LEFT_MAX = 500;
  var cidBareWaiting = Object.create(null);

  function cidIsBare(pr, me) {
    var l = String(lockedTo(pr) || '').toLowerCase();
    return CID_HEX33.test(l) && l.slice(2) === me.slice(2);
  }

  function cidLeftHas(key) { var l = load(CID_LEFT, []); return Array.isArray(l) && l.indexOf(key) >= 0; }
  function cidLeftAdd(key) {
    var l = load(CID_LEFT, []);
    l = Array.isArray(l) ? l.filter(function (k) { return k !== key; }) : [];
    save(CID_LEFT, l.concat([key]).slice(-CID_LEFT_MAX));
  }

  function cidBareView(w) {
    return { key: w.key, name: w.name, mint: w.mint, host: hostOf(w.mint), unit: w.unit, amount: w.amount, at: w.at, refund: w.refund };
  }

  function cidBare(d) {
    var proofs = d.proofs, mint = d.mint, unit = d.unit, refuse = d.refuse, o = d.opts || {};
    for (var i = 0; i < proofs.length; i++) {
      var pr = proofs[i];
      if (typeof pr.secret !== 'string' || pr.secret.length > 1024 || typeof pr.C !== 'string' || !CID_HEX33.test(pr.C.toLowerCase())
          || typeof pr.id !== 'string' || !(satsOf(pr.amount) > 0)) return Promise.resolve(refuse('it holds a proof that is not ecash Foxy can read'));
      if (cidLocktimeOf(pr) < 0) return Promise.resolve(refuse('it holds a proof whose locktime is not a time'));
    }
    if (repeatedProof(proofs)) return Promise.resolve(refuse('it names the same ecash more than once'));
    var key = 'cid:' + piecesFingerprint(proofs);
    if (cidSeenAny(proofs)) return Promise.resolve('seen');
    if (cidLeftHas(key)) { console.log('[foxy] cashu id: a delivery paid to the ID key itself, left before, read again'); return Promise.resolve('left'); }
    if (!cidListedMint(mint)) return Promise.resolve(refuse('it is paid to the ID key itself, unblinded, at ' + hostOf(mint) + ', a mint this phone does not use'));
    var amount = proofs.reduce(function (n, x) { return n + satsOf(x.amount); }, 0);
    if (!o.bareOk) {
      if (cidBareWaiting[key]) return Promise.resolve('unblinded');
      console.warn('[foxy] cashu id: a delivery is locked to the ID key itself, unblinded: nothing signed; its receiver is asked');
      return cidFromName(d.got).then(function (name) {
        var refund = proofs.some(function (x) { return cidLocktimeOf(x) > 0; });
        var w = { key: key, text: d.text, name: name, mint: mint, unit: unit, amount: amount, at: Date.now(), refund: refund };
        cidBareWaiting[key] = w;
        if (typeof FoxyWallet._onCashuIdUnblinded === 'function') {
          try { FoxyWallet._onCashuIdUnblinded(cidBareView(w)); } catch (x) {}
        }
        return 'unblinded';
      });
    }
    // TAKE IT ANYWAY, for this delivery alone
    if (!wallet || !routeOpen() || claimAway) return Promise.resolve(refuse('this phone cannot reach the mint now'));
    if (!proofs.every(function (x) { return onlyLockedTo(x, lockedTo(x), { swapNow: true }); })) {
      return Promise.resolve(refuse('it is not locked to the ID key alone, or its time lock is too near'));
    }
    var hold = cidHold(proofs);
    if (!hold) return Promise.resolve('seen');
    var held = hold;
    console.warn('[foxy] cashu id: TAKE IT ANYWAY: the ID key itself is asked to sign ' + proofs.length + ' piece(s) of one delivery');
    return nativeJson('cashuIdSignUnblinded', { secrets: proofs.map(function (x) { return x.secret; }) }, 60000).then(function (j) {
      var sigs = Array.isArray(j && j.sigs) ? j.sigs : [];
      if (sigs.length !== proofs.length) throw new Error('the phone’s signatures were not for what was asked');
      var signed = cidForMint(proofs, sigs);
      var CT = window.CashuTS;
      if (!signed.every(function (x) { try { return CT.isP2PKSpendAuthorised(x) === true; } catch (e) { return false; } })) {
        throw new Error('the phone’s signatures did not check out');
      }
      return cidFromName(d.got).then(function (name) {
        var memo = 'From ' + (name || 'someone') + ', unblinded';
        var away = canonicalMint(mintUrl || '') !== mint;
        return FoxyWallet.receiveToken(encodeToken(mint, signed, unit), { memo: memo, away: away }).then(function (r) {
          cidSeenAdd(proofs);
          delete cidBareWaiting[key];
          if (r && r.hash) {
            try { amendTx(r.hash, { memo: memo, cid: 'bare' }); } catch (x) {}
            var note = d.got.note ? cidCleanName(String(d.got.note).slice(0, CID_NOTE_MAX)) : '';
            if (note) { try { FoxyWallet.tag(r.hash, { note: note }); } catch (x) {} }
          }
          console.log('[foxy] cashu id: a payment to the ID key itself was taken, on its receiver’s word');
          if (typeof FoxyWallet._onCashuIdPaid === 'function') {
            try { FoxyWallet._onCashuIdPaid({ unit: unit, amount: r && r.amount, sats: r && r.sats, hash: r && r.hash, name: name, mint: mint }); } catch (x) {}
          }
          return 'taken';
        }, function (e) {
          var why = String((e && e.message) || e);
          if (/already|spent/i.test(why)) { cidSeenAdd(proofs); delete cidBareWaiting[key]; return refuse('the mint has it as spent already'); }
          return refuse('it was not taken (' + why.slice(0, 120) + ')');
        });
      });
    }, function (e) {
      return refuse('the phone did not sign for it (' + String((e && e.message) || e).slice(0, 80) + ')');
    }).then(function (st) { held(); return st; }, function (e) { held(); return refuse(String((e && e.message) || e)); });
  }

  /* The card's answer for delivery `key`: `take` true is TAKE IT ANYWAY, false LEAVE IT. Resolves { state, why }:
   * 'taken', 'left', 'gone' (asked no longer), or a state of `cidArriveOne`. Never rejects. */
  function cidBareDecide(key, take) {
    var w = cidBareWaiting[key];
    if (!w) return Promise.resolve({ state: 'gone', why: 'That payment is no longer waiting.' });
    if (!take) {
      delete cidBareWaiting[key];
      cidLeftAdd(key);
      console.log('[foxy] cashu id: a delivery paid to the ID key itself was left' + (w.refund ? '; its payer has it back after its locktime' : ''));
      return Promise.resolve({ state: 'left', why: '' });
    }
    var o = /** @type {any} */ ({ bareOk: true });
    return cidArrived(w.text, o).then(function (state) { return { state: state, why: String(o.said || '') }; },
      function (e) { return { state: 'refused', why: String((e && e.message) || e) }; });
  }

  /* ---- listening ---- */

  /* ---- read before the mint was connected for real ----
   *
   * A launch builds the wallet from what is on file and speaks to the mint behind it (`connectForRealOnceOnline`). A
   * delivery the inbox reads before that is held here, in memory and unread: nothing is signed, nothing asked of the
   * mint, nothing counted, and it is taken by every check as ever once the connect lands (`cidOnConnect`). The keysets
   * on file may be older than the mint's, which would refuse a payment in a new one. Past the cap one is not held:
   * the relays still have it, and the inbox is opened again after the connect. */
  var cidEarly = /** @type {string[]} */ ([]);
  var cidEarlyMissed = false;

  function cidHoldEarly(body) {
    if (!wallet || !wallet.foxyFromCache || !routeOpen()) return false;
    var text = typeof body === 'string' ? body : '';
    if (!text || text.length > CID_BODY_MAX) return false;
    if (cidEarly.indexOf(text) < 0) {
      var bytes = cidEarly.reduce(function (n, t) { return n + t.length; }, 0);
      if (cidEarly.length >= CID_EARLY_MAX || bytes + text.length > CID_EARLY_BYTES) cidEarlyMissed = true;
      else cidEarly.push(text);
    }
    console.log('[foxy] cashu id: a delivery read before the mint was connected; taken once it is');
    return true;
  }

  /* A connect has landed for real (11-routing.js): what was held is taken now, one at a time, and the inbox, open
   * since the route came up, is kept, or opened if it is not, which also takes what was kept. Behind the connect's
   * answer, not inside it. */
  function cidOnConnect() {
    setTimeout(function () {
      var held = cidEarly;
      var missed = cidEarlyMissed;
      cidEarly = [];
      cidEarlyMissed = false;
      held.reduce(function (chain, text) {
        return chain.then(function () { return cidArrived(text).then(null, function () { return 'refused'; }); });
      }, Promise.resolve()).then(function () {
        return cidListenNow(missed ? null : { ifClosed: true });
      }).then(null, function (e) {
        console.warn('[foxy] cashu id: after the connect:', (e && e.message) || e);
      });
    }, 0);
  }

  /* Whether this phone's words were restored in the last week (`cidRestored`):
   * then, and only then, it reads back the copies on its recovery key. */
  function cidRecovering() {
    var at = Number(load(CID_RECOVER, 0)) || 0;
    if (!at) return false;
    if (Date.now() - at < CID_RECOVER_MS) return true;
    try { localStorage.removeItem(CID_RECOVER); } catch (e) {}
    return false;
  }

  /* Only once the ID is in use on this phone (`cidInUse`): an ID nobody was
   * given has nothing to listen for, and a phone that never showed one tells
   * no relay it is there. */
  var cidListenRun = null;
  // when the phone last said a relay was listening; 0 once it may not be (a return, the route gone, a hush)
  var cidOpenedAt = 0;

  function cidListenGone() {
    cidOpenedAt = 0;
    if (cidDayTimer) { clearTimeout(cidDayTimer); cidDayTimer = null; }
  }

  /* What one listen asks the phone for (`cashuIdInboxOpen`): { days, any }. `days`: today (UTC) and every day since
   * the last listen that finished, at most the window's thirty-two back, newest first; the whole window when this
   * phone has never finished one (a first listen, or storage restored from nothing). `any`: the ANY WALLET requests
   * due (`cidAnyDue`). The delivery key itself is never asked for: it is all a relay needs to work out every day. */
  function cidListenPlan(nowMs) {
    var now = nowMs == null ? Date.now() : nowMs;
    var today = cidDay(now);
    var heard = Math.floor(Number(load(CID_HEARD, 0)) || 0);
    var from = heard > 0 && heard <= today ? Math.max(heard + 1, today - CID_WINDOW_DAYS) : today - CID_WINDOW_DAYS;
    if (heard > today) from = today;
    var days = [];
    for (var d = today; d >= from; d--) days.push(d);
    if (!days.length) days.push(today);
    var any = cidAnyKeys(now).filter(function (r) { return cidAnyDue(r, now); }).map(function (r) { return r.id; });
    return { days: days, any: any, today: today };
  }

  /* Whether an ANY WALLET request is asked for at a listen at `now`: always in its first day; in its first month,
   * when it was not asked today; after that, when it was not asked in the last week. */
  function cidAnyDue(r, now) {
    var age = now - Number(r.at);
    var today = cidDay(now);
    var asked = Math.floor(Number(r.asked)) || 0;
    if (age < CID_ANY_FRESH_MS) return true;
    if (age < CID_ANY_DAILY_MS) return asked !== today;
    return today - asked >= CID_ANY_WEEK_DAYS;
  }

  // the ANY WALLET requests still listened for: [{ id, at, asked }], each for a year from when it was made
  function cidAnyKeys(nowMs) {
    var now = nowMs == null ? Date.now() : nowMs;
    var l = load(CID_ANY_KEYS, []);
    var rows = (Array.isArray(l) ? l : []).filter(function (r) {
      return r && /^[0-9a-f]{8}$/.test(String(r.id)) && Number(r.at) > 0 && Number(r.at) + CID_ANY_KEEP_MS > now;
    });
    if (rows.length !== (Array.isArray(l) ? l.length : 0)) save(CID_ANY_KEYS, rows);
    return rows;
  }

  function cidAnyKeep(id) {
    var rows = cidAnyKeys().filter(function (r) { return r.id !== id; });
    rows.push({ id: id, at: Date.now(), asked: 0 });
    while (rows.length > CID_ANY_MOST) rows.shift();
    save(CID_ANY_KEYS, rows);
  }

  // the requests the relays have answered to the end of every REQ (`_cashuIdAnyHeard`, from the bridge), marked asked today
  function cidAnyAsked(ids, today) {
    if (!ids.length) return;
    var rows = cidAnyKeys();
    rows.forEach(function (r) { if (ids.indexOf(r.id) >= 0) r.asked = today; });
    save(CID_ANY_KEYS, rows);
  }

  /* A listen open across midnight (UTC) asks for the day it opened on: at a random moment in the first hour of the
   * next day it is closed, and a random 0 to 60 seconds later opened again on the new day's keys, so the end of one
   * listen and the start of the next are not one instant. */
  var cidDayTimer = null;
  function cidDayArm() {
    if (cidDayTimer) { clearTimeout(cidDayTimer); cidDayTimer = null; }
    var next = (cidDay() + 1) * CID_DAY_MS;
    var r = window.CashuTS.createRandomSecretKey();
    var wait = next - Date.now() + (((r[0] << 16) | (r[1] << 8) | r[2]) % (60 * 60 * 1000));
    cidDayTimer = setTimeout(function () {
      cidDayTimer = null;
      if (!cidOpenedAt) return;
      cidOpenedAt = 0;
      bridgeAsk('cashuIdInboxClose', {}, 5000).then(null, function () {}).then(function () {
        var g = window.CashuTS.createRandomSecretKey();
        var gap = ((g[0] << 8) | g[1]) % 60001;
        cidDayTimer = setTimeout(function () {
          cidDayTimer = null;
          // opened meanwhile (the wake, MY CASHU ID shown): nothing to do
          if (!cidOpenedAt) cidListenNow().then(null, function () {});
        }, gap);
      });
    }, Math.max(1000, wait));
  }

  function cidFreshMs() { return CID_TESTS && Number(FoxyWallet._cashuIdFreshMs) > 0 ? Number(FoxyWallet._cashuIdFreshMs) : CID_FRESH_MS; }

  /* `opts.ifClosed`: an inbox opened less than `CID_FRESH_MS` ago is left open, and only what was kept is taken
   * (`cidDrain`). Without it (the wake, MY CASHU ID shown, a restore) it is always opened again. */
  function cidListenNow(opts) {
    if (cidListenRun) return cidListenRun;
    if (!cidInUse()) return Promise.resolve(0);
    if (opts && opts.ifClosed && cidOpenedAt && Date.now() - cidOpenedAt < cidFreshMs()) {
      return cidDrain().then(function () { return 1; }, function () { return 1; });
    }
    var plan = cidListenPlan();
    var run = bridgeAsk('cashuIdInboxOpen', { days: plan.days, any: plan.any }, 120000).then(function (n) {
      // "1" only once the relay has answered every REQ to its end (EOSE): a listen cut short asks the same days again
      var got = Number(String(n).trim()) || 0;
      cidOpenedAt = got ? Date.now() : 0;
      if (got) {
        // the ANY WALLET codes are marked when their own REQs have ended (`_cashuIdAnyHeard`), not here
        save(CID_HEARD, plan.today);
        cidDayArm();
      }
      console.log('[foxy] cashu id: ' + (got ? 'listening on ' + plan.days.length + ' day(s) of keys' : 'no relay is listening'));
      return got;
    }, function (e) {
      cidOpenedAt = 0;
      console.warn('[foxy] cashu id: the phone did not listen:', (e && e.message) || e);
      return 0;
    }).then(function (n) {
      // after a restore, and for a week: this seed's own copies of what it paid, read back (`cidCopyArrived`)
      if (!cidRecovering()) return n;
      var since = Math.floor(Date.now() / 1000) - CID_SINCE_S + 300;
      return bridgeAsk('cashuIdCopiesOpen', { since: since }, 70000).then(function (c) {
        console.log('[foxy] cashu id: ' + ((Number(String(c).trim()) || 0) ? 'reading back this seed’s copies' : 'no relay is holding this seed’s copies yet'));
        return n;
      }, function (e) {
        console.warn('[foxy] cashu id: the copies were not read back:', (e && e.message) || e);
        return n;
      });
    }).then(function (n) {
      return cidDrain().then(function () { return n; }, function () { return n; });
    });
    cidListenRun = run;
    var done = function () { if (cidListenRun === run) cidListenRun = null; };
    run.then(done, done);
    return run;
  }

  /* ---- the payer's outbox ---- */

  function cidOutboxRows() {
    var l = load(K.cidOutbox, []);
    return Array.isArray(l) ? l.filter(function (r) { return r && typeof r === 'object' && typeof r.id === 'string' && typeof r.token === 'string'; }) : [];
  }

  function cidOutboxPut(row) {
    var rows = cidOutboxRows().filter(function (r) { return r.id !== row.id; });
    rows.push(row);
    mustSave(K.cidOutbox, rows);
  }

  function cidOutboxAmend(id, fields) {
    var rows = cidOutboxRows();
    var hit = null;
    rows.forEach(function (r) { if (r.id === id) { Object.assign(r, fields); hit = r; } });
    if (hit) save(K.cidOutbox, rows);
    return hit;
  }

  // rows done with (collected or come back) go a week after, with their tokens
  var CID_DONE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

  function cidOutboxTidy() {
    var rows = cidOutboxRows();
    var now = Date.now();
    var left = rows.filter(function (r) { return r.state === 'out' || !(Number(r.doneAt) > 0) || Number(r.doneAt) + CID_DONE_KEEP_MS > now; });
    if (left.length !== rows.length) save(K.cidOutbox, left);
  }

  function cidHistoryChanged() {
    if (typeof FoxyWallet._onHistoryChanged === 'function') {
      try { FoxyWallet._onHistoryChanged(); } catch (x) {}
    }
  }

  /* Filler for one wrap: a random length from none to half the token or `CID_PAD_MIN`, whichever is more, and never
   * more than `room` (what is left under `CID_SEND_MAX`, so a large payment still goes). NIP-44 pads
   * a message to a bucket (32 bytes up to 256, then an eighth of the next power of two), so this moves a wrap across
   * one bucket or two: what a relay sees of the size is the bucket, drawn afresh for every wrap. */
  function cidPad(tokenLength, room) {
    var r = window.CashuTS.createRandomSecretKey();
    var most = Math.min(Math.max(CID_PAD_MIN, Math.floor(Number(tokenLength) / 2) || 0), Math.max(0, Math.floor(Number(room)) || 0));
    return new Array(((r[0] << 16) | (r[1] << 8) | r[2]) % (most + 1) + 1).join('0');
  }

  /* The envelope: the token, the E its tag is bound to, and this phone's ID
   * with the tag that proves it (`cidFromName`), only where this phone's ID is
   * in use (M6) and the tag was made; and filler of its own (`cidPad`). */

  function cidBody(row) {
    var j = /** @type {any} */ ({ v: 2, type: 'foxy-cashu-id', token: row.token, E: row.E });
    if (row.from && row.tag) { j.from = row.from; j.tag = row.tag; }
    if (row.note) j.note = String(row.note).slice(0, CID_NOTE_MAX);
    // the room left for filler: the send limit less the envelope with an empty `pad`, counted in UTF-8 bytes as the bridge does
    j.pad = '';
    var text = JSON.stringify(j), bare;
    // a lone surrogate cannot be encoded: counted at the most it could take
    try { bare = encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, 'x').length; } catch (e) { bare = text.length * 3; }
    var pad = cidPad(String(row.token).length, CID_SEND_MAX - bare);
    // no filler fits: no `pad` at all, so an envelope within its nine bytes of the limit still goes, as before filler
    if (pad) j.pad = pad; else delete j.pad;
    return JSON.stringify(j);
  }

  // whether a row is due to go: never taken by a relay, or taken a day ago and not collected; and inside its locktime
  function cidDue(r, now) {
    if (r.state !== 'out') return false;
    if (Number(r.lockUntil) * 1000 <= now) return false;
    return !r.sentAt || now - (Number(r.lastSentAt) || Number(r.sentAt) || 0) >= CID_RESEND_MS;
  }

  // whether a row is one to ask its mint about: out, and sent, or past its locktime whether a relay took it or not (M3)
  function cidWatched(r, now) {
    return r.state === 'out' && (!!r.sentAt || Number(r.lockUntil) * 1000 <= now);
  }

  var cidSending = null;
  var cidRetryTimer = null;

  function cidRetryMs() { return CID_TESTS && Number(FoxyWallet._cashuIdRetryMs) > 0 ? Number(FoxyWallet._cashuIdRetryMs) : CID_RETRY_MS; }

  /* Every row due, sent, one at a time. A row is marked sent only once a
   * relay took it; a failure counts a try. While a row has never been taken by
   * a relay, once more a minute (a quarter of an hour after thirty tries), and
   * at once when the route comes back: the till's outbox rules. */
  function cidDeliverAll() {
    if (cidSending) return cidSending;
    var sent = 0;
    var now = Date.now();
    var due = cidOutboxRows().filter(function (r) { return cidDue(r, now); });
    var run = due.reduce(function (chain, r) {
      return chain.then(function () {
        if (!routeOpen()) { cidOutboxAmend(r.id, { tries: (Number(r.tries) || 0) + 1 }); return null; }
        // to one of the sixteen keys of today (UTC), never to the delivery key itself
        var day = cidDay();
        return deliverOverNostr(cidDropTarget(r.to, day), cidBody(r)).then(function () {
          var at = Date.now();
          // and once more, a while later, to one of tomorrow's: a receiver that listened today before it came asks only tomorrow's
          var fields = /** @type {any} */ ({ sentAt: r.sentAt || at, lastSentAt: at, aheadDay: day + 1, aheadAt: at + cidAheadDelay() });
          // the first time a relay took it: its copy to this seed's recovery key goes a while later (`cidCopyAll`)
          if (!r.copyAt && !r.copiedAt) fields.copyAt = at + cidCopyDelay();
          cidOutboxAmend(r.id, fields);
          if (r.hash && !r.sentAt) { try { amendTx(r.hash, { cidSent: true }); } catch (x) {} }
          sent += 1;
          cidHistoryChanged();
        }, function (e) {
          cidOutboxAmend(r.id, { tries: (Number(r.tries) || 0) + 1 });
          console.warn('[foxy] cashu id: a payment was not sent yet:', (e && e.message) || e);
        });
      });
    }, Promise.resolve()).then(function () {
      cidRetryArm();
      cidCopyArm();
      return sent;
    }, function (e) {
      console.warn('[foxy] cashu id: the outbox could not be sent:', (e && e.message) || e);
      cidRetryArm();
      cidCopyArm();
      return sent;
    });
    cidSending = run;
    var done = function () { if (cidSending === run) cidSending = null; };
    run.then(done, done);
    return run;
  }

  function cidRetryArm() {
    if (cidRetryTimer) { clearTimeout(cidRetryTimer); cidRetryTimer = null; }
    var left = cidOutboxRows().filter(function (r) { return r.state === 'out' && !r.sentAt && Number(r.lockUntil) * 1000 > Date.now(); });
    if (!left.length) return;
    var ms = cidRetryMs();
    if (left.every(function (r) { return Number(r.tries) >= CID_TRIES_FAST; })) ms *= CID_RETRY_SLOW;
    cidRetryTimer = setTimeout(function () {
      cidRetryTimer = null;
      cidDeliverAll().then(null, function () {});
    }, ms);
  }

  /* ---- the copy, to this seed's own recovery key ----
   *
   * The outbox is the only copy of an uncollected payment's token, and the
   * words do not bring storage back. So once a relay has taken a payment, a
   * copy of its row goes, gift-wrapped (NIP-17) as the payment went, to the
   * recovery key's own public half (m/129373'/20'/3'/0'/0', never the delivery
   * key, in no string, and the key of nothing else), between one and thirty
   * minutes later at a random moment: never in the same second as the payment,
   * so the relays cannot pair the two by when they came. A restore from the
   * words reads the copies back (`cidCopyArrived`) and the outbox's watch brings
   * home what nobody collected. A payment collected before its copy is due
   * sends none. */
  var CID_COPY_V = 1;
  var cidCopyTimer = null;
  var cidCopying = null;

  function cidCopyDelay() {
    if (CID_TESTS && Number(FoxyWallet._cashuIdCopyMs) > 0) return Number(FoxyWallet._cashuIdCopyMs);
    var r = window.CashuTS.createRandomSecretKey();
    var span = CID_COPY_MAX_MS - CID_COPY_MIN_MS;
    return CID_COPY_MIN_MS + (((r[0] << 16) | (r[1] << 8) | r[2]) % (span + 1));
  }

  // what goes to the recovery key: the row, everything a restore needs to watch it and bring it back
  function cidCopyBody(r) {
    return JSON.stringify({ v: CID_COPY_V, type: 'foxy-cashu-id-copy', token: r.token, E: r.E, contact: r.contact, to: r.to,
                            locktime: Number(r.lockUntil), index: Number(r.index), refund: r.refundPub, name: String(r.name || ''),
                            mint: r.mint, unit: r.unit, amount: r.amount, at: r.at, sentAt: r.sentAt || null });
  }

  function cidCopyDue(r, now) {
    return r.state === 'out' && !r.copiedAt && Number(r.copyAt) > 0 && Number(r.copyAt) <= now && Number(r.lockUntil) * 1000 > now;
  }

  /* Every copy whose moment has come, sent; one no relay took is given another
   * moment, one to thirty minutes on. */
  function cidCopyAll() {
    if (cidCopying) return cidCopying;
    var now = Date.now();
    var due = cidOutboxRows().filter(function (r) { return cidCopyDue(r, now); });
    if (!due.length || !routeOpen()) { cidCopyArm(); return Promise.resolve(0); }
    var sent = 0;
    var run = cidMine().then(function () {
      if (!CID_HEX32.test(cidRecoveryKey)) throw new Error('the phone gave no recovery key');
      var to = cidNprofile(cidRecoveryKey);
      return due.reduce(function (chain, r) {
        return chain.then(function () {
          return deliverOverNostr(to, cidCopyBody(r)).then(function () {
            cidOutboxAmend(r.id, { copiedAt: Date.now() });
            sent += 1;
          }, function (e) {
            cidOutboxAmend(r.id, { copyAt: Date.now() + cidCopyDelay(), copyTries: (Number(r.copyTries) || 0) + 1 });
            console.warn('[foxy] cashu id: a payment’s copy was not sent yet:', (e && e.message) || e);
          });
        });
      }, Promise.resolve());
    }).then(function () {
      if (sent) console.log('[foxy] cashu id: ' + sent + ' payment cop' + (sent === 1 ? 'y' : 'ies') + ' sent to this seed’s recovery key');
      return sent;
    }, function (e) {
      console.warn('[foxy] cashu id: the copies could not be sent:', (e && e.message) || e);
      return sent;
    });
    cidCopying = run;
    var done = function () { if (cidCopying === run) cidCopying = null; cidCopyArm(); };
    run.then(done, done);
    return run;
  }

  /* ---- the next day's wrap ----
   *
   * Each time a relay takes a payment, the same envelope goes once more, one to five seconds later with filler of its
   * own (`cidPad`), wrapped to one of the next UTC day's keys (`aheadDay`): a receiver whose phone listened today
   * before the payment was posted does not ask today's keys again tomorrow, and finds it among tomorrow's. One whose
   * day has already gone by when it is finally sent (the page slept) goes to today's keys, and a new next-day wrap is
   * set behind it. */
  var cidAheadSending = null;

  // one to five seconds: the page is surely still awake, and the wrap goes to another day's key on its own circuit
  function cidAheadDelay() {
    if (CID_TESTS && Number(FoxyWallet._cashuIdAheadMs) > 0) return Number(FoxyWallet._cashuIdAheadMs);
    var r = window.CashuTS.createRandomSecretKey();
    return 1000 + (((r[0] << 8) | r[1]) % 4001);
  }

  function cidAheadDue(r, now) {
    return r.state === 'out' && Number(r.aheadAt) > 0 && Number(r.aheadAt) <= now && Number(r.lockUntil) * 1000 > now;
  }

  function cidAheadAll() {
    if (cidAheadSending) return cidAheadSending;
    var now = Date.now();
    var due = cidOutboxRows().filter(function (r) { return cidAheadDue(r, now); });
    if (!due.length || !routeOpen()) return Promise.resolve(0);
    var sent = 0;
    var run = due.reduce(function (chain, r) {
      return chain.then(function () {
        var day = Number(r.aheadDay) || 0;
        var today = cidDay();
        /* Anything but tomorrow is late (the page slept between the two, even into the wrap's own day, when the receiver
         * may have finished that day's listen already): it goes to today's keys instead, and a new next-day wrap is set
         * behind it. A day this phone's clock cannot have meant is today's too. */
        var late = day !== today + 1;
        var to = late ? today : day;
        return deliverOverNostr(cidDropTarget(r.to, to), cidBody(r)).then(function () {
          cidOutboxAmend(r.id, late ? { aheadDay: today + 1, aheadAt: Date.now() + cidAheadDelay(), aheadSentAt: Date.now(), aheadTries: 0 }
                                    : { aheadAt: 0, aheadSentAt: Date.now(), aheadTries: 0 });
          sent += 1;
        }, function (e) {
          // tried again on the first wrap's schedule (`cidRetryArm`): once a minute, a quarter of an hour after thirty tries
          var tries = (Math.floor(Number(r.aheadTries)) || 0) + 1;
          cidOutboxAmend(r.id, { aheadAt: Date.now() + cidRetryMs() * (tries >= CID_TRIES_FAST ? CID_RETRY_SLOW : 1), aheadTries: tries });
          console.warn('[foxy] cashu id: a payment’s second wrap was not sent yet:', (e && e.message) || e);
        });
      });
    }, Promise.resolve()).then(function () { return sent; }, function () { return sent; });
    cidAheadSending = run;
    var done = function () { if (cidAheadSending === run) cidAheadSending = null; cidCopyArm(); };
    run.then(done, done);
    return run;
  }

  // the next copy's or next-day wrap's moment, kept by one timer (and on every catch-up, for a page that slept through it)
  function cidCopyArm() {
    if (cidCopyTimer) { clearTimeout(cidCopyTimer); cidCopyTimer = null; }
    var next = cidOutboxRows().filter(function (r) { return r.state === 'out'; }).reduce(function (all, r) {
      if (!r.copiedAt && Number(r.copyAt) > 0) all.push(Number(r.copyAt));
      // one already due while the route is down waits for the route's return (`cidOnRoute`), not for this timer
      if (Number(r.aheadAt) > 0 && (Number(r.aheadAt) > Date.now() || routeOpen())) all.push(Number(r.aheadAt));
      return all;
    }, /** @type {number[]} */ ([])).sort(function (a, b) { return a - b; })[0];
    if (!next) return;
    cidCopyTimer = setTimeout(function () {
      cidCopyTimer = null;
      var now = Date.now();
      if (cidOutboxRows().some(function (r) { return cidAheadDue(r, now); })) cidAheadAll().then(null, function () {});
      cidCopyAll().then(null, function () {});
    }, Math.max(1000, next - Date.now()));
  }

  /* ---- a restore: the copies read back ---- */

  var cidCopyChain = Promise.resolve();

  /* A copy from the recovery key's inbox (`cashuIdCopiesOpen`), one at a time.
   * 'rebuilt', 'seen' (the outbox has it), 'collected' (the mint has it all as
   * spent: nothing to bring back), or 'refused'. Never rejects.
   *
   * Believed only where this seed made it: its refund key is this seed's lock
   * key at the index it names, and every piece's E is one of the throwaway keys
   * this seed's paying key gives for that contact, index and locktime, with the
   * contact's ID blinded by it at slot 0 and the refund key at slot 1. Nobody
   * without the words can make one of those, so a copy anyone else sends to the
   * recovery key (its public half is on every wrap a relay holds) is dropped. */
  function cidCopyArrived(body) {
    var run = cidCopyChain.then(function () { return cidCopyOne(body); }).then(null, function (e) {
      console.warn('[foxy] cashu id: a copy could not be read:', (e && e.message) || e);
      return 'refused';
    });
    cidCopyChain = run.then(function () {}, function () {});
    return run;
  }

  function cidTokenKey(token) { return hexOf(sha256(cidUtf8(String(token))).slice(0, 16)); }

  function cidCopyOne(body) {
    var no = function (why) { console.warn('[foxy] cashu id: a copy was dropped: ' + why); return 'refused'; };
    var text = typeof body === 'string' ? body : '';
    if (!text || text.length > CID_BODY_MAX) return no('it is larger than any payment');
    var j = null;
    try { j = JSON.parse(text); } catch (e) { j = null; }
    if (!j || typeof j !== 'object' || j.type !== 'foxy-cashu-id-copy' || j.v !== CID_COPY_V) return no('it is not a copy of a payment');
    var contact = String(j.contact || '').toLowerCase(), to = String(j.to || '').toLowerCase(), refund = String(j.refund || '').toLowerCase();
    var locktime = Number(j.locktime), index = Number(j.index);
    if (typeof j.token !== 'string' || !CID_HEX33.test(contact) || !CID_HEX32.test(to) || !CID_HEX33.test(refund)
        || !Number.isSafeInteger(locktime) || locktime <= 0 || !Number.isInteger(index) || index < 0 || index > 0x7fffffff) {
      return no('it is not shaped like one');
    }
    var tk = cidTokenKey(j.token);
    if (cidOutboxRows().some(function (r) { return (r.tokenKey || cidTokenKey(r.token)) === tk; })) return 'seen';
    var info = null;
    try { info = FoxyWallet.tokenInfo(j.token); } catch (e) { info = null; }
    var mint = info ? canonicalMint(String(info.mint || '')) : '';
    var unit = info ? unitOf(info.unit) : '';
    var ps = (info && info.proofs) || [];
    if (!mint || mintUrlProblem(mint) || (unit !== 'sat' && unit !== 'usd')) return no('its token is not one Foxy would hold');
    if (!ps.length || ps.length > CID_PIECES_MAX) return no('its token holds no pieces');
    var tagOf = function (pr, name) {
      try { var t = (JSON.parse(pr.secret)[1].tags || []).filter(function (x) { return Array.isArray(x) && x[0] === name; })[0]; return t ? String(t[1]) : ''; }
      catch (e) { return ''; }
    };
    if (!ps.every(function (pr) {
      return CID_HEX33.test(String(pr.p2pk_e || '').toLowerCase()) && CID_HEX33.test(String(lockedTo(pr) || '').toLowerCase())
        && Number(tagOf(pr, 'locktime')) === locktime && CID_HEX33.test(tagOf(pr, 'refund').toLowerCase());
    })) return no('its pieces are not a payment to a contact');
    // the refund key: this seed's lock key at that index
    return nativeJson('p2pkPubkeys', { start: index, count: 1 }, 60000).then(function (k) {
      var pub = String(((k && k.pubkeys) || [])[0] || '').toLowerCase();
      if (pub !== refund) return no('its refund key is not this seed’s');
      // and every E this seed's own, for that contact, index and locktime
      return nativeJson('cashuIdEphemeral', { to: contact, index: index, locktime: locktime }, 60000).then(function (e0) {
        var base = String((e0 && e0.base) || '').toLowerCase();
        if (!CID_HEX32.test(base)) return no('the phone gave no keys for it');
        var want = {};
        ps.forEach(function (pr) { want[String(pr.p2pk_e).toLowerCase()] = pr; });
        var left = ps.length;
        for (var jx = 0; jx < CID_PIECES_MAX && left > 0; jx++) {
          var b = cidBlind(contact, cidPieceKey(base, jx), refund);
          var pr = want[b.E];
          if (!pr) continue;
          if (String(lockedTo(pr) || '').toLowerCase() !== b.L || tagOf(pr, 'refund').toLowerCase() !== b.R) return no('a piece is not locked as this seed locks');
          delete want[b.E];
          left -= 1;
        }
        if (left > 0) return no('its pieces were not made by this seed');
        return cidCopyKeep(j, info, mint, unit, contact, to, refund, locktime, index, tk);
      });
    });
  }

  /* A copy that checks out: into the outbox as the row it was, unless the mint
   * has every piece as spent already (collected: nothing to bring back). The
   * watch then does the rest (`cidWatchAll`): resent daily while it waits,
   * collected, or brought back by the refund key after its locktime. */
  function cidCopyKeep(j, info, mint, unit, contact, to, refund, locktime, index, tk) {
    var here = !!wallet && canonicalMint(mintUrl || '') === mint;
    var asking = !wallet || !routeOpen() ? Promise.reject(new Error('no route'))
      : (here ? Promise.resolve(wallet) : awayWallet(mint));
    return asking.then(function (w) { return statesOf(w, info.proofs); }).then(function (states) {
      return (states || []).length === info.proofs.length && states.every(function (st) { return String(st) === 'SPENT'; });
    }, function () { return false; }).then(function (collected) {
      if (collected) { console.log('[foxy] cashu id: a copy of a payment its contact collected; nothing to bring back'); return 'collected'; }
      if (cidOutboxRows().some(function (r) { return (r.tokenKey || cidTokenKey(r.token)) === tk; })) return 'seen';
      var now = Date.now();
      var row = { id: 'cidr' + tk.slice(0, 16), to: to, contact: contact, name: cidCleanName(j.name) || 'a Cashu ID',
                  E: CID_HEX33.test(String(j.E || '').toLowerCase()) ? String(j.E).toLowerCase() : String(info.proofs[0].p2pk_e).toLowerCase(),
                  token: j.token, tokenKey: tk, mint: mint, unit: unit, amount: Math.round(satsOf(j.amount) || 0) || sumProofs(info.proofs),
                  hash: '', at: Number(j.at) || now, lockUntil: locktime, index: index, refundRow: '', refundPub: refund,
                  from: '', tag: '', note: '', sentAt: Number(j.sentAt) || now, lastSentAt: now, tries: 0, state: 'out',
                  copiedAt: now, restored: true };
      cidOutboxPut(row);
      console.log('[foxy] cashu id: a payment to ' + row.name + ' nobody has collected was found again from this seed’s copy');
      cidHistoryChanged();
      if (routeOpen()) cidWatchAll().then(null, function () {});
      return 'rebuilt';
    });
  }

  /* ---- collected, or come back ---- */

  var cidWatching = null;

  /* Every row still out that a relay took, or whose locktime has passed whether
   * or not one did, asked of its mint (with a route): all spent is collected;
   * past its locktime with pieces unspent, those come back with this phone's
   * refund key (`cidTakeBack`). Resolves { collected, back }. */
  function cidWatchAll() {
    if (cidWatching) return cidWatching;
    var out = { collected: 0, back: 0 };
    var now = Date.now();
    var rows = cidOutboxRows().filter(function (r) { return cidWatched(r, now); });
    if (!rows.length || !wallet || !routeOpen()) return Promise.resolve(out);
    var run = rows.reduce(function (chain, r) {
      return chain.then(function () {
        var info = null;
        try { info = FoxyWallet.tokenInfo(r.token); } catch (e) { info = null; }
        if (!info || !info.proofs || !info.proofs.length) return null;
        var due = Number(r.lockUntil) * 1000 <= Date.now();
        var here = canonicalMint(mintUrl || '') === canonicalMint(String(info.mint || ''));
        var asking = here ? Promise.resolve(wallet) : awayWallet(canonicalMint(String(info.mint)));
        return asking.then(function (w) {
          return statesOf(w, info.proofs).then(function (states) {
            var spent = states.filter(function (st) { return String(st) === 'SPENT'; }).length;
            if (spent === info.proofs.length) {
              cidOutboxAmend(r.id, { state: 'collected', doneAt: Date.now() });
              if (r.hash) { try { amendTx(r.hash, { cidCollected: true }); FoxyWallet.settleTx(r.hash); FoxyWallet.forgetClaimedToken(r.token); } catch (x) {} }
              console.log('[foxy] cashu id: a payment to a contact was collected');
              out.collected += 1;
              cidHistoryChanged();
              return null;
            }
            if (!due) return null;
            return cidTakeBack(r, info, states).then(function (n) { if (n) out.back += 1; });
          });
        }).then(null, function (e) {
          console.warn('[foxy] cashu id: a payment out could not be looked at yet:', (e && e.message) || e);
        });
      });
    }, Promise.resolve()).then(function () { cidOutboxTidy(); return out; });
    cidWatching = run;
    var done = function () { if (cidWatching === run) cidWatching = null; };
    run.then(done, done);
    return run;
  }

  /* Past its locktime: the pieces still unspent are this phone's again, by its
   * refund key R (the lock-key index the row kept, or found again from the words
   * where the row has gone), whose blinding by each piece's E (slot 1) cashu-ts
   * works out as it signs (`signP2PKProofs`). Taken in as any locked ecash
   * signed for is. The mint refuses the refund key before the locktime
   * (NUT-11), so nothing here can take back money the contact can still
   * collect. Resolves the amount taken back. */
  function cidTakeBack(r, info, states) {
    var live = info.proofs.filter(function (pr, i) { return String(states[i]) === 'UNSPENT'; });
    if (!live.length) return Promise.resolve(0);
    return lockKeyMatching(String(r.refundPub || ''), FoxyWallet._lockPubOf).then(function (key) {
      if (!key) throw new Error('this phone’s seed does not give the key that payment comes back to');
      if (FoxyWallet._lockPubOf(key) !== String(r.refundPub || '').toLowerCase()) throw new Error('the key that payment comes back to is not this seed’s');
      var CT = window.CashuTS;
      var signed = CT.signP2PKProofs(live, key).map(function (pr) {
        var c = Object.assign({}, pr, { witness: typeof pr.witness === 'string' ? pr.witness : JSON.stringify(pr.witness) });
        delete c.p2pk_e;
        return c;
      });
      if (!signed.every(function (pr) { try { return CT.isP2PKSpendAuthorised(pr) === true; } catch (e) { return false; } })) {
        throw new Error('the refund key cannot take it back yet');
      }
      var memo = 'Came back: ' + r.name + ' did not collect it';
      var mint = canonicalMint(String(info.mint));
      var token = encodeToken(mint, signed, unitOf(info.unit) || 'sat');
      return FoxyWallet.receiveToken(token, { memo: memo, away: canonicalMint(mintUrl || '') !== mint }).then(function (got) {
        cidOutboxAmend(r.id, { state: 'back', doneAt: Date.now() });
        if (got && got.hash) { try { amendTx(got.hash, { memo: memo, cid: 'back' }); } catch (x) {} }
        if (r.hash) { try { amendTx(r.hash, { cidBack: true }); FoxyWallet.forgetClaimedToken(r.token); } catch (x) {} }
        dropLockKey(r.refundRow);
        var n = Math.round(satsOf(got && (got.amount != null ? got.amount : got.sats)));
        console.log('[foxy] cashu id: a payment its contact did not collect came back');
        cidHistoryChanged();
        if (typeof FoxyWallet._onTakenBack === 'function') {
          try { FoxyWallet._onTakenBack({ sats: unitOf(info.unit) === 'usd' ? 0 : n, unit: unitOf(info.unit) || 'sat', amount: n, hash: got && got.hash }); } catch (x) {}
        }
        return n;
      });
    });
  }

  /* ---- paying a contact ---- */

  /* The locktime of a payment made now: the day thirty days on, at a random
   * second of it, so the mint, which reads it at every claim, is not told when
   * the payment was made to the second (M4). In the suites, `_cashuIdLockS`
   * seconds on exactly. */
  function cidLocktime(nowMs) {
    var now = Math.floor((nowMs || Date.now()) / 1000);
    if (CID_TESTS && Number(FoxyWallet._cashuIdLockS) > 0) return now + Math.floor(Number(FoxyWallet._cashuIdLockS));
    var day = Math.floor((now + CID_LOCK_S) / CID_DAY_S) * CID_DAY_S;
    var r = window.CashuTS.createRandomSecretKey();
    var offset = ((r[0] << 16) | (r[1] << 8) | r[2]) % CID_DAY_S;
    return day + offset;
  }

  // one payment to a contact at a time: its throwaway keys are handed to the send by the contact's key (`p2bkSources`)
  var cidPaying = null;

  /* `who`: a contact's ID string or its ID key. `amount`: sats, or cents for
   * dollars (`opts.unit`). Resolves { hash, token, sent, name, lockUntil, row }:
   * `sent` once a relay has taken it, otherwise it waits in the outbox and goes
   * as soon as one will. Nothing that unlocks the token is kept here, and its
   * throwaway keys are the seed's (CashuID.payBase over the contact's ID, the
   * refund key's index and the locktime), so this phone's words find its E and
   * its blinded refund key again. */
  function cidPay(who, amount, opts) {
    var o = opts || {};
    var read = /** @type {any} */ (null);
    var text = String(who || '').trim();
    // (a payment sent back, `cidSendBack`: the payer's ID and delivery key as this phone knows them, a contact or not)
    if (o.read && CID_HEX33.test(String(o.read.id || '')) && CID_HEX32.test(String(o.read.nostr || ''))) {
      read = { id: String(o.read.id), nostr: String(o.read.nostr) };
    } else if (CID_HEX33.test(text.toLowerCase())) {
      var c0 = cidContactOf(text);
      read = c0 ? { id: c0.cid.id, nostr: c0.cid.nostr } : null;
    } else {
      var r0 = /** @type {any} */ (cidRead(text));
      read = r0.id ? r0 : null;
    }
    if (!read) return Promise.reject(new Error('That is not a Cashu ID.'));
    var contact = cidContactOf(read.id);
    var name = cidCleanName(o.name || (contact && contact.name)) || 'a Cashu ID';
    var unit = unitOf(o.unit) || 'sat';
    var want = Math.round(Number(amount) || 0);
    if (!(want > 0)) return Promise.reject(new Error('Ask for an amount above zero.'));
    if (!routeOpen()) return Promise.reject(new Error('Paying a Cashu ID needs a connection. Nothing was sent.'));
    // as a till checks before it makes a code (08d-till.js): a mint that does not honour a lock would let anyone spend it
    if (!tillMintLocks(mintUrl)) {
      return Promise.reject(new Error((mintUrl ? hostOf(canonicalMint(mintUrl)) : 'This mint') + ' does not say it honours a lock (NUT-11), so a contact cannot be paid from it. Nothing was sent.'));
    }
    if (cidPaying) return Promise.reject(new Error('A payment to a contact is being made. Try again in a moment.'));
    var rowId = 'cid' + Date.now().toString(36) + hexOf(window.CashuTS.createRandomSecretKey()).slice(0, 8);
    var refundRow = 'cid-refund-' + rowId;
    var run = cidMine().then(function (mine) {
      if (mine.id === read.id) throw new Error('That is your own Cashu ID.');
      return primeLockPool().then(function () { return mine; });
    }).then(function (mine) {
      var refundPub = takeLockKey(refundRow, { unit: unit });
      if (!refundPub) throw new Error('This phone could not set a key for the money to come back to. Nothing was sent.');
      var index = Number((lockKeys()[refundRow] || {}).i);
      if (!Number.isInteger(index) || index < 0) throw new Error('This phone could not set a key for the money to come back to. Nothing was sent.');
      var lockUntil = cidLocktime();
      return nativeJson('cashuIdEphemeral', { to: read.id, index: index, locktime: lockUntil }, 60000).then(function (j) {
        var base = String((j && j.base) || '').toLowerCase();
        if (!CID_HEX32.test(base)) throw new Error('The phone did not give the keys for that payment. Nothing was sent.');
        var j0 = 0;
        var E0 = '';
        p2bkSources[read.id] = function () {
          if (j0 >= CID_PIECES_MAX) throw new Error('That payment needs more pieces than one payment to a contact may carry.');
          var e = cidPieceKey(base, j0);
          if (j0 === 0) E0 = cidBlind(read.id, e).E;
          j0 += 1;
          return bytesOfHex(e);
        };
        var sending = FoxyWallet.sendToken(want, { unit: unit, lockTo: read.id, lockUntil: lockUntil, refundTo: refundPub, blindKeys: true });
        return sending.then(function (made) {
          delete p2bkSources[read.id];
          return { made: made, E0: E0 };
        }, function (e) { delete p2bkSources[read.id]; throw e; });
      }).then(function (sent) {
        var made = sent.made;
        var info = FoxyWallet.tokenInfo(made.token);
        var proofs = (info && info.proofs) || [];
        // every piece blinded, its E on it, and no piece locked to the ID or the refund key as they are
        if (!proofs.length || !proofs.every(function (pr) {
          var lock = String(lockedTo(pr) || '').toLowerCase();
          return CID_HEX33.test(String(pr.p2pk_e || '').toLowerCase()) && lock !== read.id && lock !== refundPub;
        })) {
          console.error('[foxy] cashu id: a payment was made whose pieces are not blinded; it is kept to come back after its locktime');
        }
        var E = proofs.some(function (pr) { return String(pr.p2pk_e || '').toLowerCase() === sent.E0; })
          ? sent.E0 : String((proofs[0] && proofs[0].p2pk_e) || '').toLowerCase();
        // the payer's name, proved, only where this phone's ID is in use
        var naming = cidInUse() && CID_HEX33.test(E)
          ? nativeJson('cashuIdTag', { peer: read.id, e: E }, 60000).then(function (t) {
              var tag = String((t && t.tag) || '').toLowerCase();
              return CID_HEX32.test(tag) ? { from: mine.id, tag: tag } : null;
            }, function () { return null; })
          : Promise.resolve(null);
        return naming.then(function (me) {
          var row = { id: rowId, to: read.nostr, contact: read.id, name: name, E: E, token: made.token,
                      mint: canonicalMint(String((info && info.mint) || mintUrl || '')), unit: unit, amount: want,
                      hash: made.hash || '', at: Date.now(), lockUntil: lockUntil, index: index, refundRow: refundRow, refundPub: refundPub,
                      from: me ? me.from : '', tag: me ? me.tag : '',
                      note: o.note ? cidCleanName(String(o.note).slice(0, CID_NOTE_MAX)) : '',
                      sentAt: null, lastSentAt: null, tries: 0, state: 'out' };
          // a shop's payout to a collaborator: its own name, so it is never made twice (08g-shop-collect.js `shopPayOut`)
          if (o.shopPay) row.shopPay = String(o.shopPay).slice(0, 400);
          cidOutboxPut(row);
          if (made.hash) {
            try { amendTx(made.hash, { memo: o.memo ? String(o.memo).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80) : 'To ' + name, cid: 'out' }); } catch (x) {}
          }
          cidHistoryChanged();
          return cidDeliverAll().then(function () {
            var now = cidOutboxRows().filter(function (x) { return x.id === rowId; })[0] || row;
            return { hash: row.hash, token: row.token, sent: !!now.sentAt, name: name, lockUntil: lockUntil, row: rowId };
          });
        });
      }, function (e) {
        /* The send failed (L5): the refund key's row goes with it, unless the
         * swap's record was kept to rebuild a locked payment the mint may have
         * made and could not write down (`keepSentToken`: storage full), whose refund key must still be found. */
        if (!(e && (e.storageFull || e.definite))) {
          try { dropLockKey(refundRow); } catch (x) {}
        }
        throw e;
      });
    }).then(function (r) { cidPaying = null; return r; }, function (e) {
      cidPaying = null;
      throw e;
    });
    cidPaying = run;
    return run;
  }

  /* After a connect, and on the way back from the background: the outbox
   * goes, rows out are looked at, and the inbox listens. None waits on another. */
  function cidCatchUp() {
    try {
      var now = Date.now();
      if (cidOutboxRows().some(function (r) { return cidDue(r, now); })) cidDeliverAll().then(null, function () {});
      if (cidOutboxRows().some(function (r) { return cidWatched(r, now); })) cidWatchAll().then(null, function () {});
      if (cidOutboxRows().some(function (r) { return cidAheadDue(r, now); })) cidAheadAll().then(null, function () {});
      if (cidOutboxRows().some(function (r) { return cidCopyDue(r, now); })) cidCopyAll().then(null, function () {});
      else cidCopyArm();
      Promise.resolve().then(function () { return cidListenNow({ ifClosed: true }); }).then(null, function () {});
      // and the shops this phone collects for (08g-shop-collect.js), a moment after, not on a visit
      if (!claimAway) shopResume();
    } catch (e) {
      console.warn('[foxy] cashu id: catching up failed:', (e && e.message) || e);
    }
  }

  /* The route has come back (`_privacy`, 11-routing.js): what waits to go, goes now, and the inbox listens at once.
   * It listened only at the end of a connect's catch-up, ten to eighteen seconds after Tor was up at a launch: a
   * payment read before the mint is connected for real is held until it is (`cidHoldEarly`). */
  function cidOnRoute() {
    try {
      Promise.resolve().then(function () { return cidListenNow({ ifClosed: true }); }).then(null, function () {});
      if (cidOutboxRows().some(function (r) { return cidDue(r, Date.now()); })) setTimeout(function () { cidDeliverAll().then(null, function () {}); }, 0);
      if (cidOutboxRows().some(function (r) { return cidCopyDue(r, Date.now()); })) setTimeout(function () { cidCopyAll().then(null, function () {}); }, 0);
      if (cidOutboxRows().some(function (r) { return cidAheadDue(r, Date.now()); })) setTimeout(function () { cidAheadAll().then(null, function () {}); }, 0);
      // and the shops' collection, which waited for the route
      if (!shopRunning && !claimAway) shopResume();
    }
    catch (e) { console.warn('[foxy] cashu id: sending on the route’s return:', (e && e.message) || e); }
  }
