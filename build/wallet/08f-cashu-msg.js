  /* ---- messages between Cashu IDs ----------------------------------------------
   *
   * docs/CASHU-ID.md, "Messages", is the whole of it. Two Foxys that hold each
   * other's ID work out one secret, natively, from their ID keys
   * (SHA-256("foxy-msg-pair-v1" ‖ x(d_mine·ID_peer)), Foxy/Keychain/CashuMsg.swift),
   * and from it a chain of keys for each direction: message i from one to the other
   * goes to the x-only half of k_i = SHA-256("foxy-msg-recv-v1" ‖ secret ‖ dir ‖ i),
   * a key used once, and its seal is signed by s_i, which only the two can work
   * out. The relays see gift wraps to keys that never repeat.
   *
   * This page never holds the secret or any of the keys. It keeps, per contact:
   *
   *   out    the index its next message to them takes;
   *   base   the lowest index of theirs it has not had, and `got`, the ones above it
   *          it has had: the phone listens on the next eight it has not had
   *          (`cmsgWindow`), so a message that arrives moves the window on;
   *   known  whether they are listening on this phone's chain: false for a contact
   *          new to messages and after a restore, and again (`resync`) when their
   *          `next` says they are a window or more behind. While it is false, a
   *          message goes once to their public delivery key instead, with this
   *          phone's ID proved (`from`, `tag`, `E`, as a payment names its payer)
   *          and the index it stands for: "ratchet from now". The receiver's window
   *          for this phone starts after it. With no answer, every eighth message
   *          past what they last said they read (`ack`) goes that way too
   *          (`cmsgFirstDue`), in case their window stopped on messages the relays lost.
   *
   * Every message carries `next`, the sender's own `base` for the receiver, so each
   * side learns how far the other has read. A message is padded to 512, 1,024 or
   * 2,048 bytes, waits 0 to 20 seconds at random before it goes, and is tried
   * until a relay takes it (the Cashu ID's outbox rules: once a minute, every
   * quarter of an hour after thirty tries, at once when the route comes back).
   *
   * A restored phone has none of this: its words find its contacts' IDs only once
   * they are added again. Then it listens from 0 on both chains of each one, its
   * own messages included (both phones can open both chains), walks forward as
   * they come, and so resumes where the relays still hold it. It tells each one
   * where it stands at once, silently (CMSG_STAND, `cmsgStandOut`), and its first
   * message to each goes by the delivery key. */

  var CMSG_THREADS = 'foxy.msg.threads';
  var CMSG_OUTBOX = 'foxy.msg.outbox';
  var CMSG_SEEN = 'foxy.msg.seen';
  var CMSG_TYPE = 'foxy-msg';
  // a restored phone's "where I stand" to a contact: by the delivery key only, no text, never a line of a conversation
  var CMSG_STAND = 'foxy-msg-stand';
  var CMSG_V = 1;
  // what one message may say, and the sizes its plaintext is padded to
  var CMSG_TEXT_MAX = 1000;
  var CMSG_BUCKETS = [512, 1024, 2048];
  var CMSG_BODY_MAX = 4096;
  // the keys listened on past the lowest not yet had, per contact (CashuMsg.window)
  var CMSG_WINDOW = 8;
  /* the highest index a message may take: the window of eight above it still fits below 2^32, so a window is never
   * empty and the phone never names a contact with nothing to listen on */
  var CMSG_INDEX_MAX = 4294967295 - CMSG_WINDOW;
  // what is kept: the last 200 messages with each contact, a megabyte in all, ten people who are not contacts
  var CMSG_PER_PEER = 200;
  var CMSG_BYTES = 1024 * 1024;
  var CMSG_STRANGERS = 10;
  // of the megabyte, what the people who are not contacts may take between them: their oldest go first, before a contact's
  var CMSG_STRANGER_BYTES = 128 * 1024;
  // a first message's id, kept with its sender's conversation so that one read again is known
  var CMSG_FIRSTS = 64;
  // an `at` further back than the relays keep is brought up to that (CID_SINCE_S, 32 days)
  var CMSG_PAST_MS = CID_SINCE_S * 1000;
  var CMSG_PEERS_MAX = 60;
  var CMSG_SEEN_MAX = 500;
  var CMSG_OUTBOX_MAX = 100;
  // a message waits 0 to 20 s at random before it goes, so a relay cannot pair it with a tap on SEND
  var CMSG_DELAY_MS = 20000;
  var CMSG_REOPEN_MS = 1500;
  var CMSG_ID = /^[0-9a-f]{32}$/;

  function cmsgUtf8Len(text) { return cidUtf8(String(text)).length; }

  function cmsgRandom(n) {
    var out = [];
    while (out.length < n) {
      var r = window.CashuTS.createRandomSecretKey();
      for (var i = 0; i < r.length && out.length < n; i++) out.push(r[i]);
    }
    return out;
  }

  function cmsgNewId() { return hexOf(cmsgRandom(16)); }

  /* The message's text as it is kept and sent: no control characters but line breaks (C0, DEL and C1 become spaces), no
   * marks that turn the direction of a line (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069 become spaces),
   * no invisible spaces (U+200B, U+2060, U+FEFF go; the joiners U+200C and U+200D stay, emoji and scripts need them),
   * trimmed; '' when there is nothing, null when it is longer than a message may be. */
  function cmsgClean(text) {
    var t = String(text == null ? '' : text).replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
      .replace(/[\u200b\u2060\ufeff]/g, '').trim();
    if (Array.from(t).length > CMSG_TEXT_MAX) return null;
    return t;
  }

  /* The plaintext, padded with random characters to the smallest size that holds it. Throws past the largest. */
  function cmsgPadded(j) {
    var o = Object.assign({}, j, { pad: '' });
    var n = cmsgUtf8Len(JSON.stringify(o));
    var size = CMSG_BUCKETS.filter(function (b) { return b >= n; })[0];
    if (!size) throw new Error('That message is too long.');
    var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    o.pad = cmsgRandom(size - n).map(function (b) { return A.charAt(b & 63); }).join('');
    return JSON.stringify(o);
  }

  function cmsgDelay() {
    if (CID_TESTS && FoxyWallet._cashuMsgDelayMs !== undefined && Number(FoxyWallet._cashuMsgDelayMs) >= 0) return Number(FoxyWallet._cashuMsgDelayMs);
    var r = cmsgRandom(3);
    return ((r[0] << 16) | (r[1] << 8) | r[2]) % (CMSG_DELAY_MS + 1);
  }

  function cmsgRetryMs() { return CID_TESTS && Number(FoxyWallet._cashuMsgRetryMs) > 0 ? Number(FoxyWallet._cashuMsgRetryMs) : CID_RETRY_MS; }

  /* ---- what is kept ---- */

  // { mine: <this phone's ID when it was written>, threads: { <peer ID hex>: thread } }
  function cmsgAll() {
    var a = load(CMSG_THREADS, null);
    if (!a || typeof a !== 'object' || Array.isArray(a) || !a.threads || typeof a.threads !== 'object') a = { mine: '', threads: {} };
    return a;
  }

  function cmsgNewThread(peer) {
    return { peer: peer, out: 0, base: 0, got: [], known: false, resync: false, ack: 0, unread: 0, msgs: [], card: '', nostr: '', at: 0,
      lost: cidRecovering(), firsts: [], firstAt: 0 };
  }

  function cmsgThread(all, peer, make) {
    var t = all.threads[peer];
    if (!t && make) { t = cmsgNewThread(peer); all.threads[peer] = t; }
    return t || null;
  }

  /* Kept within its caps: 200 messages a contact, the oldest going first; the people who are not contacts within their
   * own 128 KB, their oldest going first; and a megabyte in all, the oldest message of someone who is not a contact going
   * first and then the oldest of any. So people nobody added cannot push a contact's messages out. */
  function cmsgTrim(all) {
    var strangers = [];
    Object.keys(all.threads).forEach(function (p) {
      var t = all.threads[p];
      if (t.msgs.length > CMSG_PER_PEER) t.msgs = t.msgs.slice(t.msgs.length - CMSG_PER_PEER);
      if (!cidContactOf(p)) strangers.push(p);
    });
    // the oldest message of the threads named, or null
    var oldestOf = function (peers) {
      var oldest = /** @type {{ p: string, m: any } | null} */ (null);
      peers.forEach(function (p) {
        var m = all.threads[p].msgs[0];
        if (m && (!oldest || Number(m.at) < Number(oldest.m.at))) oldest = { p: p, m: m };
      });
      return oldest;
    };
    var bytesOf = function (m) { return cmsgUtf8Len(JSON.stringify(m)) + 1; };
    var theirs = strangers.reduce(function (a, p) { return a + cmsgUtf8Len(JSON.stringify(all.threads[p].msgs)); }, 0);
    while (theirs > CMSG_STRANGER_BYTES) {
      var o = oldestOf(strangers);
      if (!o) break;
      theirs -= bytesOf(all.threads[o.p].msgs.shift());
    }
    var size = cmsgUtf8Len(JSON.stringify(all));
    while (size > CMSG_BYTES) {
      var oldest = oldestOf(strangers) || oldestOf(Object.keys(all.threads));
      if (!oldest) break;
      all.threads[oldest.p].msgs.shift();
      size = cmsgUtf8Len(JSON.stringify(all));
    }
    return all;
  }

  function cmsgSave(all) { return save(CMSG_THREADS, cmsgTrim(all)); }

  function cmsgOutbox() {
    var l = load(CMSG_OUTBOX, []);
    return Array.isArray(l) ? l.filter(function (r) { return r && typeof r.id === 'string' && typeof r.body === 'string'; }) : [];
  }

  function cmsgSeenList() {
    var l = load(CMSG_SEEN, []);
    return Array.isArray(l) ? l : [];
  }

  function cmsgChanged(peer) {
    if (typeof FoxyWallet._onCashuMsg === 'function') {
      try { FoxyWallet._onCashuMsg(peer); } catch (x) {}
    }
  }

  // the contact's name, or '' for someone who is not one
  function cmsgNameOf(peer) {
    var c = cidContactOf(peer);
    return c ? String(c.name || 'Cashu ID') : '';
  }

  // their delivery key: the contact's, or from the ID string they sent with their first message
  function cmsgNostrOf(peer, t) {
    var c = cidContactOf(peer);
    if (c && CID_HEX32.test(String(c.cid.nostr || ''))) return c.cid.nostr;
    return t && CID_HEX32.test(String(t.nostr || '')) ? t.nostr : '';
  }

  /* The keys to listen on for one thread: their next eight indices this phone has not had, and while they are not
   * listening on this phone's chain (`known` false: new, or restored), its own next eight, read back. */
  function cmsgWindow(t) {
    var inward = [];
    for (var i = Number(t.base) || 0; inward.length < CMSG_WINDOW && i < 4294967296; i++) {
      if ((t.got || []).indexOf(i) < 0) inward.push(i);
    }
    var outward = [];
    if (!t.known) for (var j = Number(t.out) || 0; outward.length < CMSG_WINDOW && j < 4294967296; j++) outward.push(j);
    return { peer: t.peer, in: inward, out: outward };
  }

  /* ---- a message in ---- */

  /* A message's body, read: the object, or null when it is not one this Foxy writes. `i` the index it came to, or
   * null for a first message by the delivery key. A "where I stand" (CMSG_STAND) only by the delivery key, and only with
   * no text: it is never a line of a conversation. No index above CMSG_INDEX_MAX: a window of eight past it would not fit
   * below 2^32. */
  function cmsgRead(body, i) {
    var text = String(body || '');
    if (text.length > CMSG_BODY_MAX || CMSG_BUCKETS.indexOf(cmsgUtf8Len(text)) < 0) return null;
    var j = null;
    try { j = JSON.parse(text); } catch (e) { return null; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    var stand = j.type === CMSG_STAND && i === null;
    if (j.v !== CMSG_V || (j.type !== CMSG_TYPE && !stand) || typeof j.id !== 'string' || !CMSG_ID.test(j.id)) return null;
    if (typeof j.text !== 'string' || cmsgClean(j.text) === null || (stand && j.text !== '')) return null;
    if (stand && !Number.isInteger(j.next)) return null;
    if (!Number.isInteger(j.i) || j.i < 0 || j.i > CMSG_INDEX_MAX || (i !== null && j.i !== i)) return null;
    if (typeof j.at !== 'number' || !isFinite(j.at)) return null;
    if (j.next !== undefined && (!Number.isInteger(j.next) || j.next < 0)) return null;
    return j;
  }

  function cmsgHas(t, id) { return t.msgs.some(function (m) { return m.id === id; }); }

  // a message's time as kept: never ahead of now, never further back than the relays keep
  function cmsgAt(at, now) { return Math.min(Math.max(now - CMSG_PAST_MS, Number(at) || 0), now); }

  // the newest time of theirs this conversation holds: a first message's, or a message's
  function cmsgNewestIn(t) {
    return t.msgs.reduce(function (a, m) { return m.dir === 'in' ? Math.max(a, Number(m.at) || 0) : a; }, Number(t.firstAt) || 0);
  }

  // what their `next` says: how far they have read this phone's chain, and whether they are a window or more behind
  function cmsgHeard(t, next) {
    t.ack = Math.max(Number(t.ack) || 0, next);
    if ((Number(t.out) || 0) - next >= CMSG_WINDOW) t.resync = true;
  }

  /* A first message from them to go by the delivery key: theirs did not know this phone's place (`known` false), they
   * said they are a window behind (`resync`), or this phone is eight, sixteen … past what they last said they read, with
   * no answer: their window may have stopped on messages the relays lost. */
  function cmsgFirstDue(t) {
    var ahead = (Number(t.out) || 0) - (Number(t.ack) || 0);
    return !t.known || !!t.resync || (ahead >= CMSG_WINDOW && ahead % CMSG_WINDOW === 0);
  }

  /* Taken into its thread: 'kept' or 'seen'. `first`: it came by the delivery key, and its index starts their chain.
   *
   * A first message is known again by its id, kept with its sender's conversation (CMSG_FIRSTS of them, which nobody else
   * can push out), and never moves the window back when it is read again: below the window, only one newer than all of
   * theirs this phone holds moves it (a phone of theirs that started its chain again after a restore); an older one never
   * had (it came late) is kept as a line and the window stays. */
  function cmsgTakeIn(all, t, j, first) {
    if (cmsgHas(t, j.id)) return 'seen';
    var i = j.i;
    var now = Date.now();
    if (first) {
      var fid = j.id.slice(0, 16);
      t.firsts = Array.isArray(t.firsts) ? t.firsts : [];
      if (t.firsts.indexOf(fid) >= 0) return 'seen';
      var newer = Number(j.at) > cmsgNewestIn(t);
      // older than what is kept of a full conversation: it was had, and let go
      if (i < t.base && !newer && t.msgs.length >= CMSG_PER_PEER && Number(j.at) < Number(t.msgs[0].at)) return 'seen';
      t.firsts = t.firsts.concat([fid]).slice(-CMSG_FIRSTS);
      if (newer) t.firstAt = Math.min(Number(j.at), now);
      if (i >= t.base) {
        // "ratchet from now": their next message comes to index i + 1
        t.base = i + 1;
        t.got = (t.got || []).filter(function (x) { return x > i; });
      } else if (newer) {
        // their chain started again: what was had above it was of the old one
        t.base = i + 1;
        t.got = [];
      }
      /* a first message says they have this phone in their book, and listen on its chain from their `next`. Not on a
       * conversation begun in the week after this phone's words were restored (`lost`): one read again from the relays
       * says nothing of where they listen now, and this phone's own first message goes by the delivery key, saying
       * where it stands, before the ratchet. */
      if (!t.lost) t.known = true;
    } else {
      if (i < t.base || (t.got || []).indexOf(i) >= 0) return 'seen';
      t.got = (t.got || []).concat([i]);
    }
    cmsgAdvance(t);
    if (Number.isInteger(j.next)) cmsgHeard(t, j.next);
    t.msgs.push({ id: j.id, dir: 'in', text: cmsgClean(j.text), at: cmsgAt(j.at, now), i: i });
    if (first && i < t.base - 1) t.msgs.sort(function (a, b) { return Number(a.at) - Number(b.at); });
    t.unread = (Number(t.unread) || 0) + 1;
    t.at = now;
    cmsgSave(all);
    return 'kept';
  }

  /* The window moved past what has come: the lowest index not had is the new base. With eight had above a gap, the gap
   * is given up (a message the relays lost), so `got` stays short and the window keeps moving. */
  function cmsgAdvance(t) {
    t.got = (t.got || []).slice().sort(function (a, b) { return a - b; });
    if (t.got.length >= CMSG_WINDOW) t.base = Math.max(t.base, t.got[0]);
    while (t.got.indexOf(t.base) >= 0) {
      var at = t.base;
      t.got = t.got.filter(function (x) { return x !== at; });
      t.base += 1;
    }
    t.got = t.got.filter(function (x) { return x > t.base; });
  }

  var cmsgArriving = Promise.resolve();

  /* One message from the phone, opened by its key and sealed by the right one (`cashuIdMsgOpen`). `way`: 'in' for
   * theirs, 'out' for this phone's own read back after a restore. 'kept', 'seen' or 'refused'; never rejects. */
  function cmsgArrived(peer, way, i, body) {
    var run = cmsgArriving.then(function () {
      var p = String(peer || '').toLowerCase();
      if (!CID_HEX33.test(p) || !Number.isInteger(i)) return 'refused';
      var j = cmsgRead(body, i);
      if (!j) { console.warn('[foxy] messages: a message was not one Foxy writes'); return 'refused'; }
      var all = cmsgAll();
      // a contact's conversation is made when its first message comes, if it was not when the phone was asked to listen
      var t = cmsgThread(all, p, !!cidContactOf(p));
      if (!t) return 'refused';
      var got;
      if (way === 'out') {
        // this phone's own, from before a restore: kept as sent, and its chain goes on after it
        t.out = Math.max(Number(t.out) || 0, i + 1);
        if (cmsgHas(t, j.id)) { cmsgSave(all); return 'seen'; }
        t.msgs.push({ id: j.id, dir: 'out', text: cmsgClean(j.text), at: cmsgAt(j.at, Date.now()), i: i, state: 'relay' });
        t.msgs.sort(function (a, b) { return Number(a.at) - Number(b.at); });
        cmsgSave(all);
        got = 'kept';
      } else {
        got = cmsgTakeIn(all, t, j, false);
      }
      if (got === 'kept') { cmsgReopenSoon(); cmsgChanged(p); }
      return got;
    }).then(null, function (e) {
      console.warn('[foxy] messages: a message could not be read:', (e && e.message) || e);
      return 'refused';
    });
    cmsgArriving = run.then(function () {}, function () {});
    return run;
  }

  // a delivery to the public key that is a message, not a payment
  function cmsgIsFirst(body) {
    try { var j = JSON.parse(String(body || '')); return !!j && (j.type === CMSG_TYPE || j.type === CMSG_STAND); } catch (e) { return false; }
  }

  /* A first message, by the delivery key (`_cashuIdArrived`): believed only where its tag is the one this phone works
   * out from its own ID key, `from` and `E` (as a payment's payer is proved, `cidFromName`), and from someone who is a
   * contact or sent the ID string that is theirs. At most ten people who are not contacts. 'kept', 'seen' or 'refused'. */
  function cmsgFirstArrived(body) {
    var run = cmsgArriving.then(function () {
      if (!cidInUse()) return 'refused';
      var j = cmsgRead(body, null);
      if (!j) return 'refused';
      var from = typeof j.from === 'string' ? j.from.toLowerCase() : '';
      var tag = typeof j.tag === 'string' ? j.tag.toLowerCase() : '';
      var E = typeof j.E === 'string' ? j.E.toLowerCase() : '';
      if (!CID_HEX33.test(from) || !CID_HEX32.test(tag) || !CID_HEX33.test(E)) return 'refused';
      if (cmsgSeenList().indexOf(j.id.slice(0, 16)) >= 0) return 'seen';
      return cidMine().then(function (mine) {
        if (mine.id === from) return 'refused';
        return nativeJson('cashuIdTag', { peer: from, e: E }, 60000).then(function (k) {
          if (String((k && k.tag) || '').toLowerCase() !== tag) {
            console.warn('[foxy] messages: a first message did not prove who sent it');
            return 'refused';
          }
          var all = cmsgAll();
          var t = cmsgThread(all, from, false);
          if (j.type === CMSG_STAND) return cmsgStandIn(all, t, from, j, mine);
          var card = null;
          if (typeof j.card === 'string') { var r = cidRead(j.card); if (r.id === from) card = r; }
          if (!t) {
            if (!cidContactOf(from)) {
              if (!card) return 'refused';
              var strangers = Object.keys(all.threads).filter(function (p) { return !cidContactOf(p); }).length;
              if (strangers >= CMSG_STRANGERS) { console.warn('[foxy] messages: too many people who are not contacts'); return 'refused'; }
            }
            t = cmsgThread(all, from, true);
          }
          if (card) { t.card = cidEncode(card.id, card.nostr, card.sig); t.nostr = card.nostr; }
          all.mine = mine.id;
          var got = cmsgTakeIn(all, t, j, true);
          var seen = cmsgSeenList().concat([j.id.slice(0, 16)]);
          save(CMSG_SEEN, seen.slice(Math.max(0, seen.length - CMSG_SEEN_MAX)));
          if (got === 'kept') { cmsgReopenSoon(); cmsgChanged(from); }
          return got;
        });
      });
    }).then(null, function (e) {
      console.warn('[foxy] messages: a first message could not be read:', (e && e.message) || e);
      return 'refused';
    });
    cmsgArriving = run.then(function () {}, function () {});
    return run;
  }

  /* A contact's "where I stand" (a phone of theirs restored from the words, the conversation added back): no line and
   * nothing unread; what it says is how far they have read this phone's chain, so a window or more behind, this phone's
   * next message goes by the delivery key. Only from a contact, or someone this phone already has a conversation with. */
  function cmsgStandIn(all, t, from, j, mine) {
    if (!t && !cidContactOf(from)) return 'refused';
    if (!t) t = cmsgThread(all, from, true);
    var fid = j.id.slice(0, 16);
    t.firsts = Array.isArray(t.firsts) ? t.firsts : [];
    if (t.firsts.indexOf(fid) >= 0) return 'seen';
    t.firsts = t.firsts.concat([fid]).slice(-CMSG_FIRSTS);
    // what they say now, not the most they ever said: their stored state is gone
    t.ack = j.next;
    if ((Number(t.out) || 0) - j.next >= CMSG_WINDOW) t.resync = true;
    all.mine = mine.id;
    cmsgSave(all);
    var seen = cmsgSeenList().concat([fid]);
    save(CMSG_SEEN, seen.slice(Math.max(0, seen.length - CMSG_SEEN_MAX)));
    return 'kept';
  }

  /* ---- listening ---- */

  var cmsgListenRun = null;
  var cmsgReopenTimer = null;

  /* The phone listens on every contact's next keys, and on those of the people who are not contacts that wrote, in one
   * request (`cashuIdMsgOpen`), only once this phone's ID is in use. A store written under another ID (the words
   * changed) is let go first. */
  function cmsgListenNow() {
    if (cmsgListenRun) return cmsgListenRun;
    if (!cidInUse()) return Promise.resolve(0);
    var run = cidMine().then(function (mine) {
      var all = cmsgAll();
      if (all.mine && all.mine !== mine.id) { all = { mine: mine.id, threads: {} }; save(CMSG_OUTBOX, []); }
      all.mine = mine.id;
      var added = [];
      cidContactsNow().forEach(function (c) {
        if (c.cid.id === mine.id || all.threads[c.cid.id]) return;
        var t = cmsgThread(all, c.cid.id, true);
        if (t.lost) added.push(t.peer);
      });
      cmsgSave(all);
      // a contact added back on a phone restored from the words: it is told where this phone stands (`cmsgStandOut`)
      added.forEach(cmsgStandOut);
      // a conversation with nothing left to listen on (a window at the very end of its chain) is left out, not refused
      var list = Object.keys(all.threads).map(function (p) { return all.threads[p]; })
        .sort(function (a, b) { return (Number(b.at) || 0) - (Number(a.at) || 0); })
        .slice(0, CMSG_PEERS_MAX)
        .map(cmsgWindow)
        .filter(function (w) { return w.in.length + w.out.length > 0; });
      if (!list.length) return 0;
      var since = Math.floor(Date.now() / 1000) - CID_SINCE_S + 300;
      return bridgeAsk('cashuIdMsgOpen', { since: since, peers: list }, 70000).then(function (n) {
        return Number(String(n).trim()) || 0;
      }, function (e) {
        console.warn('[foxy] messages: the phone did not listen:', (e && e.message) || e);
        return 0;
      });
    });
    cmsgListenRun = run;
    var done = function () { if (cmsgListenRun === run) cmsgListenRun = null; };
    run.then(done, done);
    return run;
  }

  // a message moved a window on: the phone listens on the next keys, once the messages arriving together are in
  function cmsgReopenSoon() {
    if (cmsgReopenTimer) clearTimeout(cmsgReopenTimer);
    var ms = CID_TESTS && Number(FoxyWallet._cashuMsgReopenMs) > 0 ? Number(FoxyWallet._cashuMsgReopenMs) : CMSG_REOPEN_MS;
    cmsgReopenTimer = setTimeout(function () {
      cmsgReopenTimer = null;
      Promise.resolve(cmsgListenRun).then(function () { return cmsgListenNow(); }).then(null, function () {});
    }, ms);
  }

  /* ---- a message out ---- */

  /* Write `text` to `peer` (an ID key, or a contact's ID string): kept in its thread as sent and in the outbox, and
   * gone after its random wait. { id, i, first }. Rejects in words, and keeps nothing, for no ID in use, someone who is
   * not a contact and never wrote, a message too long or empty. */
  function cmsgSend(who, text) {
    if (!cidInUse()) return Promise.reject(new Error('Open MY CASHU ID first: messages go from your own Cashu ID.'));
    var clean = cmsgClean(text);
    if (clean === null) return Promise.reject(new Error('That message is too long. A message is at most ' + CMSG_TEXT_MAX + ' characters.'));
    if (!clean) return Promise.reject(new Error('Type a message first.'));
    var w = String(who || '').trim();
    var peer = CID_HEX33.test(w.toLowerCase()) ? w.toLowerCase() : (cidRead(w).id || '');
    if (!peer) return Promise.reject(new Error('That is not a Cashu ID.'));
    return cidMine().then(function (mine) {
      if (peer === mine.id) throw new Error('That is your own Cashu ID.');
      var all = cmsgAll();
      if (all.mine && all.mine !== mine.id) all = { mine: mine.id, threads: {} };
      all.mine = mine.id;
      var t = cmsgThread(all, peer, false);
      if (!t && !cidContactOf(peer)) throw new Error('Add them to your contacts first.');
      if (!t) t = cmsgThread(all, peer, true);
      var first = cmsgFirstDue(t);
      var nostr = cmsgNostrOf(peer, t);
      if (first && !nostr) throw new Error('Foxy does not know where to reach them yet.');
      if (cmsgOutbox().length >= CMSG_OUTBOX_MAX) throw new Error('Too many messages are waiting to go. Try again once they have.');
      var i = Number(t.out) || 0;
      var j = /** @type {any} */ ({ v: CMSG_V, type: CMSG_TYPE, id: cmsgNewId(), text: clean, at: Date.now(), i: i, next: Number(t.base) || 0 });
      var named = first ? cmsgProve(peer, mine, j) : Promise.resolve(j);
      return named.then(function (body) {
        var text = cmsgPadded(body);
        // read again: another message may have been written while the tag was made
        var now = cmsgAll();
        var tt = cmsgThread(now, peer, true);
        if ((Number(tt.out) || 0) !== i) { body.i = Number(tt.out) || 0; text = cmsgPadded(body); }
        tt.out = body.i + 1;
        if (first) tt.resync = false;
        var made = tt.msgs.length === 0;
        tt.msgs.push({ id: body.id, dir: 'out', text: clean, at: body.at, i: body.i, state: 'out' });
        tt.at = Date.now();
        now.mine = mine.id;
        if (!cmsgSave(now)) throw new Error('Foxy could not keep that message: this phone’s storage is full.');
        var rows = cmsgOutbox();
        rows.push({ id: body.id, peer: peer, i: body.i, first: first, to: first ? nostr : '', body: text, sendAt: Date.now() + cmsgDelay(), tries: 0 });
        save(CMSG_OUTBOX, rows);
        cmsgChanged(peer);
        cmsgArm();
        // a conversation new to this phone: its keys are listened on from now
        if (made) cmsgReopenSoon();
        return { id: body.id, i: body.i, first: first };
      });
    });
  }

  /* A restored phone's "where I stand" to a contact added back: by the delivery key, proved as a first message is, with
   * no text and its `next` (how far it has read their chain), so that a contact a window or more ahead goes by the
   * delivery key to it. It takes no index and leaves `known` as it is: this phone's own next message still goes by the
   * delivery key. Its body is made when it goes, after the random wait, so `next` says what was read back by then. */
  function cmsgStandOut(peer) {
    var rows = cmsgOutbox();
    if (rows.length >= CMSG_OUTBOX_MAX || rows.some(function (r) { return r.stand && r.peer === peer; })) return;
    var nostr = cmsgNostrOf(peer, null);
    if (!nostr) return;
    rows.push({ id: cmsgNewId(), peer: peer, i: 0, first: true, stand: true, to: nostr, body: '', sendAt: Date.now() + cmsgDelay(), tries: 0 });
    save(CMSG_OUTBOX, rows);
    cmsgArm();
  }

  // the stand's body, as it goes
  function cmsgStandBody(r) {
    return cidMine().then(function (mine) {
      var t = cmsgThread(cmsgAll(), r.peer, false);
      var j = /** @type {any} */ ({ v: CMSG_V, type: CMSG_STAND, id: r.id, text: '', at: Date.now(), i: t ? Number(t.out) || 0 : 0,
        next: t ? Number(t.base) || 0 : 0 });
      return cmsgProve(r.peer, mine, j).then(cmsgPadded);
    });
  }

  /* A first message names its sender, proved as a payment's payer is: this phone's ID, a fresh E, the tag
   * SHA-256("foxy-cashu-id-from-v1" ‖ x(d·their ID) ‖ E) the phone works out, and this phone's ID string so that
   * someone who has not added it can. */
  function cmsgProve(peer, mine, j) {
    var e = window.CashuTS.createRandomSecretKey();
    var E = hexOf(window.CashuTS.getPubKeyFromPrivKey(e));
    return nativeJson('cashuIdTag', { peer: peer, e: E }, 60000).then(function (k) {
      var tag = String((k && k.tag) || '').toLowerCase();
      if (!CID_HEX32.test(tag)) throw new Error('This phone could not sign the message as yours.');
      return Object.assign(j, { from: mine.id, tag: tag, E: E, card: mine.text });
    });
  }

  var cmsgSending = null;
  var cmsgTimer = null;

  /* The message of an outbox row, marked as a relay took it: true once that is written (or there is nothing to mark). */
  function cmsgMarkSent(r) {
    var all = cmsgAll();
    var t = cmsgThread(all, r.peer, false);
    if (!t) return true;
    // a stand leaves the chain as it is: this phone's next message still goes by the delivery key
    if (r.first && !r.stand) { t.known = true; t.lost = false; }
    t.msgs.forEach(function (m) { if (m.id === r.id) m.state = 'relay'; });
    return cmsgSave(all);
  }

  // whether an outbox row's message is marked sent already (the row outlived the mark: an app killed between the two)
  function cmsgMarked(all, r) {
    var t = all.threads[r.peer];
    return !!t && t.msgs.some(function (m) { return m.id === r.id && m.state === 'relay'; });
  }

  /* Every row whose wait is over, one at a time: to the delivery key by `nostrSend` for a first message, to the next
   * key of the chain by `cashuIdMsgSend` otherwise. A row goes from the outbox only once a relay took it and its message
   * is marked sent: a relay that took it while the store was full leaves the row `taken`, and only the mark is tried
   * again, until there is room. */
  function cmsgDeliverAll() {
    if (cmsgSending) return cmsgSending;
    var sent = 0;
    var now = Date.now();
    var kept = cmsgAll();
    var stale = cmsgOutbox().filter(function (r) { return cmsgMarked(kept, r); });
    if (stale.length) save(CMSG_OUTBOX, cmsgOutbox().filter(function (r) { return !cmsgMarked(kept, r); }));
    var due = cmsgOutbox().filter(function (r) { return Number(r.sendAt) <= now; })
      .sort(function (a, b) { return (a.peer === b.peer ? a.i - b.i : Number(a.sendAt) - Number(b.sendAt)); });
    var run = due.reduce(function (chain, r) {
      return chain.then(function () {
        var tried = function (e) {
          var rows = cmsgOutbox();
          rows.forEach(function (x) {
            if (x.id !== r.id) return;
            x.tries = (Number(x.tries) || 0) + 1;
            x.sendAt = Date.now() + cmsgRetryMs() * (x.tries >= CID_TRIES_FAST ? CID_RETRY_SLOW : 1);
          });
          save(CMSG_OUTBOX, rows);
          if (e) console.warn('[foxy] messages: a message was not sent yet:', (e && e.message) || e);
        };
        // a relay took it, the mark not yet written: the mark again, a retry's wait from now
        var markLater = function () {
          var rows = cmsgOutbox();
          rows.forEach(function (x) { if (x.id === r.id) { x.taken = true; x.sendAt = Date.now() + cmsgRetryMs(); } });
          save(CMSG_OUTBOX, rows);
        };
        if (r.taken) {
          if (cmsgMarkSent(r)) { save(CMSG_OUTBOX, cmsgOutbox().filter(function (x) { return x.id !== r.id; })); cmsgChanged(r.peer); }
          else markLater();
          return null;
        }
        if (!routeOpen()) { tried(null); return null; }
        var body = r.stand && !r.body ? cmsgStandBody(r) : Promise.resolve(r.body);
        var go = body.then(function (text) {
          return r.first ? deliverOverNostr(cidNprofile(r.to), text)
            : bridgeAsk('cashuIdMsgSend', { peer: r.peer, i: r.i, body: text }, 40000);
        });
        return go.then(function () {
          if (cmsgMarkSent(r)) save(CMSG_OUTBOX, cmsgOutbox().filter(function (x) { return x.id !== r.id; }));
          else markLater();
          sent += 1;
          cmsgChanged(r.peer);
        }, tried);
      });
    }, Promise.resolve()).then(function () { cmsgArm(); return sent; }, function (e) {
      console.warn('[foxy] messages: the outbox could not be sent:', (e && e.message) || e);
      cmsgArm();
      return sent;
    });
    cmsgSending = run;
    var done = function () { if (cmsgSending === run) cmsgSending = null; };
    run.then(done, done);
    return run;
  }

  // the next row's moment, armed
  function cmsgArm() {
    if (cmsgTimer) { clearTimeout(cmsgTimer); cmsgTimer = null; }
    var rows = cmsgOutbox();
    if (!rows.length) return;
    var next = Math.min.apply(null, rows.map(function (r) { return Number(r.sendAt) || 0; }));
    cmsgTimer = setTimeout(function () {
      cmsgTimer = null;
      Promise.resolve(cmsgSending).then(function () { return cmsgDeliverAll(); }).then(null, function () {});
    }, Math.max(0, next - Date.now()));
  }

  // the route has come back: whatever was tried and waits goes now (its random wait is not taken again)
  function cmsgOnRoute() {
    try {
      var rows = cmsgOutbox();
      if (!rows.some(function (r) { return Number(r.tries) > 0; })) return;
      var now = Date.now();
      rows.forEach(function (r) { if (Number(r.tries) > 0) r.sendAt = Math.min(Number(r.sendAt) || now, now); });
      save(CMSG_OUTBOX, rows);
      setTimeout(function () { cmsgDeliverAll().then(null, function () {}); }, 0);
    } catch (e) { console.warn('[foxy] messages: sending on the route’s return:', (e && e.message) || e); }
  }

  /* ---- for the screens ---- */

  function cmsgMarkWord(m) {
    if (m.dir !== 'out') return '';
    // the keeper's words (2026-11-05): "sending…" until a relay has taken it, "sent" after
    return m.state === 'relay' ? 'sent' : 'sending\u2026';
  }

  function cmsgView(t) {
    var name = cmsgNameOf(t.peer);
    return {
      peer: t.peer, name: name || 'A Cashu ID', contact: !!name, card: name ? '' : String(t.card || ''),
      unread: Number(t.unread) || 0,
      msgs: t.msgs.map(function (m) { return { id: m.id, dir: m.dir, text: m.text, at: Number(m.at) || 0, mark: cmsgMarkWord(m) }; }),
    };
  }

  function cmsgThreadsNow() {
    if (!cidInUse()) return [];
    var all = cmsgAll();
    return Object.keys(all.threads).map(function (p) {
      var t = all.threads[p];
      var last = t.msgs[t.msgs.length - 1] || null;
      var name = cmsgNameOf(p);
      return { peer: p, name: name || 'A Cashu ID', contact: !!name, unread: Number(t.unread) || 0,
        lastAt: last ? Number(last.at) || 0 : 0, lastText: last ? last.text : '' };
    }).filter(function (v) { return v.contact || v.lastAt > 0; });
  }

  /* INBOX's payments (26p-cashu-msg.js `renderInbox`): { peer, dir, unit, amount, at } for each payment to or from a
   * Cashu ID this phone can put a name to, `at` in milliseconds. Out: every payment to a contact this phone made, which
   * the outbox keeps (`cidPay`). In: the history rows whose payer proved to be a contact (`cidFromName`), which carry
   * its ID key as `cidPeer`; a payer who did not prove who they are is no one's. Not only with the ID in use: a contact
   * can be paid without it. */
  function cmsgPaymentsNow() {
    var list = [];
    cidOutboxRows().forEach(function (r) {
      var p = String(r.contact || '').toLowerCase();
      if (!CID_HEX33.test(p)) return;
      list.push({ peer: p, dir: 'out', unit: unitOf(r.unit) || 'sat', amount: Math.round(satsOf(r.amount)), at: Number(r.at) || 0 });
    });
    (load(K.log, []) || []).forEach(function (e) {
      if (!e || e.cid !== 'in' || e.state === 'failed') return;
      var p = String(e.cidPeer || '').toLowerCase();
      if (!CID_HEX33.test(p)) return;
      var unit = unitOf(e.unit) || 'sat';
      var amount = satsOf(unit === 'sat' && e.sats != null ? e.sats : e.amount);
      var at = Number(e.at) || 0;
      list.push({ peer: p, dir: 'in', unit: unit, amount: Math.round(amount || 0), at: at > 1e11 ? at : at * 1000 });
    });
    return list.sort(function (a, b) { return b.at - a.at; });
  }

  function cmsgRead1(peer) {
    var all = cmsgAll();
    var t = cmsgThread(all, String(peer || '').toLowerCase(), false);
    if (!t || !t.unread) return;
    t.unread = 0;
    cmsgSave(all);
  }
