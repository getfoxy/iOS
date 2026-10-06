  /* ---- a card that holds ecash (the Foxy card) ----------------------------
   *
   * A JavaCard that keeps pieces of ecash locked to a key only it holds, and
   * signs for one when it is tapped and its PIN is right. The applet is a fork
   * of cashu-javacard; what it does and why is in the card's own repository
   * (docs/FOXY-CARD-SPEC.md). Here are the parts of it that are only reading
   * and writing bytes, with no mint and no phone in them.
   *
   * The card does not hold a piece's secret, which is 150 characters and more.
   * It holds the 32-byte nonce and builds the rest: its own key, and, where
   * the piece has a date, the date and the key that may take the piece back
   * after it. The card signs SHA-256 of that text and nothing else, so the
   * text below IS the wire format: no spaces, this order, lowercase hex, the
   * date in decimal. tests/fixtures/flashcard-vectors.json is the applet's own
   * output, and tests/flashcard-vectors.js holds this to it byte for byte.
   *
   * It is also, to the character, what cashu-ts writes for a piece locked to
   * one key (with or without a locktime and one refund key). That is on
   * purpose, and the same test holds it: a card is loaded with an ordinary
   * locked send, and the pieces that send makes are the pieces the card can
   * sign for. An update to the library that wrote the text another way would
   * make pieces no card could spend, and fails that test first. */
  var CARD_FORMAT = 2;
  var CARD_SLOT_BYTES = 82;
  var CARD_PIECE_BYTES = 81;

  function cardHexOk(s, bytes) {
    return typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]*$/.test(s);
  }

  /* A piece's NUT-10 secret, as the card rebuilds it. `date` is its locktime
   * in seconds, 0 for none; with a date the refund key is named too. Throws on
   * anything that is not what a card could hold, since a secret built from a
   * wrong field is a piece nobody can spend. */
  function cardSecret(nonce, cardKey, date, refundKey) {
    var when = Number(date) || 0;
    if (!cardHexOk(nonce, 32)) throw new Error('That is not a card piece: its nonce is not 32 bytes.');
    if (!cardHexOk(cardKey, 33) || !/^0[23]/.test(cardKey)) throw new Error('That is not a card’s key.');
    if (!(when >= 0 && when <= 4294967295 && Math.floor(when) === when)) throw new Error('That is not a date a card can hold.');
    var text = '["P2PK",{"nonce":"' + nonce + '","data":"' + cardKey + '","tags":[';
    if (when) {
      if (!cardHexOk(refundKey, 33) || !/^0[23]/.test(refundKey)) throw new Error('A piece with a date needs the key that can take it back.');
      text += '["locktime","' + String(when) + '"],["refund","' + refundKey + '"]';
    }
    return text + ']}]';
  }

  function cardU32(hex, at) { return parseInt(hex.substr(at * 2, 8), 16); }

  /* GET_INFO's sixteen bytes. */
  function cardInfoOf(hex) {
    var h = String(hex || '').toLowerCase();
    if (!cardHexOk(h, 16)) throw new Error('The card did not say what it is.');
    var b = function (i) { return parseInt(h.substr(i * 2, 2), 16); };
    return { version: b(0) + '.' + b(1), slots: b(2), unspent: b(3), spent: b(4), empty: b(5),
             pin: b(7) === 0 ? 'none' : b(7) === 1 ? 'set' : 'blocked', format: b(8), tries: b(9),
             locked: b(10) === 1, hasRecord: b(11) === 1, limit: cardU32(h, 12) };
  }

  /* GET_CARD: format, set, unit, limit, refund key, mint. */
  function cardRecordOf(hex) {
    var h = String(hex || '').toLowerCase();
    if (!/^[0-9a-f]*$/.test(h) || h.length < 82) throw new Error('The card’s record could not be read.');
    var mintLen = parseInt(h.substr(80, 2), 16);
    if (h.length !== (41 + mintLen) * 2) throw new Error('The card’s record could not be read.');
    var refund = h.substr(14, 66);
    var mint = '';
    for (var i = 0; i < mintLen; i++) mint += String.fromCharCode(parseInt(h.substr(82 + i * 2, 2), 16));
    return { format: parseInt(h.substr(0, 2), 16), set: h.substr(2, 2) === '01', unit: parseInt(h.substr(4, 2), 16) === 0 ? 'sat' : 'other',
             limit: cardU32(h, 3), refundKey: /^0+$/.test(refund) ? '' : refund, mint: mint };
  }

  /* One slot, as GET_PROOF gives it: status, keyset, amount, nonce, C, date. */
  function cardSlotOf(hex) {
    var h = String(hex || '').toLowerCase();
    if (!cardHexOk(h, CARD_SLOT_BYTES)) throw new Error('A place on the card could not be read.');
    var status = parseInt(h.substr(0, 2), 16);
    return { state: status === 1 ? 'unspent' : status === 2 ? 'spent' : 'empty',
             keyset: h.substr(2, 16), amount: cardU32(h, 9), nonce: h.substr(26, 64), C: h.substr(90, 66), date: cardU32(h, 78) };
  }

  /* The 81 bytes LOAD_PROOF takes for a piece. */
  function cardPieceBytes(piece) {
    var u32 = function (n) { return ('00000000' + (Number(n) >>> 0).toString(16)).slice(-8); };
    var hex = String(piece.keyset) + u32(piece.amount) + String(piece.nonce) + String(piece.C) + u32(piece.date || 0);
    if (!cardHexOk(hex, CARD_PIECE_BYTES)) throw new Error('That piece does not fit a card.');
    return hex;
  }

  /* ---- which of the mint's keysets a piece is of ------------------------------
   *
   * A place on the card has eight bytes for it. A mint's older keysets are
   * named by exactly eight (sixteen hex, starting 00). Its newer ones are
   * named by thirty-three (starting 01), and NUT-02 gives those a short form
   * for exactly this: the first eight bytes, which mean something only beside
   * that mint's own list of keysets. So the card holds the short form, and the
   * phone, which has the list, turns it back into the whole name before a
   * mint is shown the piece.
   *
   * It turns back only when exactly one of the mint's keysets begins that
   * way. None, and the piece is of some other mint's keys; two, and the mint
   * has made the short form mean two things, and a piece that could be of
   * either is not guessed at. */
  function cardShortId(id) {
    var h = String(id || '').toLowerCase();
    if (/^[0-9a-f]{16}$/.test(h)) return h;
    if (/^01[0-9a-f]{64}$/.test(h)) return h.slice(0, 16);
    return '';
  }

  function cardFullId(w, short) {
    var want = String(short || '').toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(want)) return '';
    var found = keysetIdsFor(w).map(function (id) { return String(id).toLowerCase(); })
      .filter(function (id) { return cardShortId(id) === want; });
    return found.length === 1 ? found[0] : '';
  }

  /* The ecash a slot is: the proof a mint would be shown, without its witness.
   * `id` is the keyset's whole name where the caller has a mint to ask
   * (`cardFullId`); without it, the eight bytes as the card holds them. */
  function cardProofOf(slot, cardKey, refundKey, id) {
    return { id: id || slot.keyset, amount: slot.amount, C: slot.C,
             secret: cardSecret(slot.nonce, cardKey, slot.date, refundKey) };
  }

  /* ---- talking to a card ----------------------------------------------------
   *
   * A card is spoken to in commands (APDUs), each answered with data and a
   * two-byte status word. The page builds the commands and reads the answers;
   * what carries them is a `link`, an object with `send(hex)` that resolves
   * with the answer as hex and rejects when the card has gone. On a phone the
   * link is the bridge to iOS's NFC session (Foxy/Flashcard). In the tests it
   * is a model of the card (tests/flashcard-card.js), which is held to the
   * applet's own answers. So the same code that pays on a phone is what the
   * tests run. */
  /* The applet's own name, whole: its package's nine bytes and 01. Chosen by
   * the whole name and not by its first nine bytes, which a card may or may
   * not match, and which is what the phone will carry (Foxy/Flashcard/CardGate.swift). */
  var CARD_AID = 'f0464f58594341524401';
  var CARD_INS = { info: '01', key: '10', balance: '11', proof: '13', slots: '14', auth: '15', card: '16',
                   spend: '20', load: '30', clear: '31', setCard: '32', setLimit: '33',
                   verify: '40', setPin: '41', changePin: '42' };

  function cardByte(n) { return ('0' + (Number(n) & 255).toString(16)).slice(-2); }

  /* One command, as hex: class B0, the instruction, two parameters, the data
   * (with its length before it) and the length expected back. */
  function cardCommand(ins, p1, data, le) {
    var body = String(data || '');
    return 'b0' + ins + cardByte(p1 || 0) + '00' + (body ? cardByte(body.length / 2) + body : '') + (le === undefined ? '' : cardByte(le));
  }

  /* What went wrong, in a shape the screens can tell apart: `card` names it. */
  function cardError(kind, message, extra) {
    var e = /** @type {any} */ (new Error(message));
    e.card = kind;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  /* A status word that is not 9000, as the person should hear it. */
  function cardRefused(sw, doing) {
    var w = String(sw || '').toLowerCase();
    if (/^63c[0-9a-f]$/.test(w)) {
      var left = parseInt(w.slice(3), 16);
      return cardError('wrong-pin', 'Wrong PIN. ' + left + (left === 1 ? ' try' : ' tries') + ' left.', { tries: left });
    }
    if (w === '6983') return cardError('blocked', 'This card is blocked: its PIN was typed wrong too many times.', { tries: 0 });
    if (w === '6984') return cardError('no-pin', 'This card has no PIN yet.');
    if (w === '6982') return cardError('pin-needed', 'The card wants its PIN first.');
    if (w === '6a8f') return cardError('over-limit', 'That is more than this card lets one PIN entry spend.');
    if (w === '6a84') return cardError('full', 'The card has no room for more.');
    if (w === '6986') return cardError('locked', 'This card is locked: nothing more can be written to it.');
    if (w === '6a8c') return cardError('no-record', 'This card has not been set up.');
    if (w === '6a8d') return cardError('in-use', 'That cannot change while the card still holds money.');
    if (w === '6a8e') return cardError('no-refund-key', 'This card was set up as cash and cannot hold a piece that can be taken back.');
    return cardError('refused', 'The card refused ' + (doing || 'that') + ' (' + w + ').', { sw: w });
  }

  /* Ask the card one thing. `ask` answers { data, sw } whatever the status;
   * `want` answers the data and throws anything but 9000 as what it means. */
  function cardTalk(link) {
    function ask(apdu) {
      return Promise.resolve().then(function () { return link.send(apdu); }).then(function (hex) {
        var h = String(hex || '').toLowerCase();
        if (h.length < 4 || h.length % 2 || /[^0-9a-f]/.test(h)) throw cardError('gone', 'The card was taken away too soon.');
        return { data: h.slice(0, -4), sw: h.slice(-4) };
      }, function (e) {
        throw (e && e.card) ? e : cardError('gone', 'The card was taken away too soon.');
      });
    }
    return {
      ask: ask,
      want: function (apdu, doing) {
        return ask(apdu).then(function (r) {
          if (r.sw !== '9000') throw cardRefused(r.sw, doing);
          return r.data;
        });
      },
    };
  }

  /* A PIN as the card takes it: its digits, as text. Four to eight. */
  function cardPinHex(pin) {
    var text = String(pin === undefined || pin === null ? '' : pin);
    if (!/^[0-9]{4,8}$/.test(text)) throw cardError('bad-pin', 'A card PIN is 4 to 8 digits.');
    var out = '';
    for (var i = 0; i < text.length; i++) out += cardByte(text.charCodeAt(i));
    return out;
  }

  /* Read everything a card says with no PIN: what it is, its key (and that it
   * holds that key), its record, and every piece on it.
   *
   * The key is proved, not taken on the card's word: the card signs this
   * phone's sixteen random bytes with sixteen of its own (AUTH). A reader's
   * copy of what GET_PROOF gives is everything about a card but its key, so
   * without this a pretend card could show another card's balance. */
  function cardLook(link) {
    var t = cardTalk(link);
    var card = /** @type {any} */ ({});
    return t.ask('00a40400' + cardByte(CARD_AID.length / 2) + CARD_AID + '00').then(function (r) {
      if (r.sw !== '9000' || r.data.length !== 4) throw cardError('not-a-card', 'That is not a Foxy card.');
      return t.want(cardCommand(CARD_INS.info, 0, '', 0), 'to say what it is');
    }).then(function (d) {
      card.info = cardInfoOf(d);
      if (card.info.format !== CARD_FORMAT) throw cardError('not-a-card', 'That card is a kind this Foxy does not know.');
      return t.want(cardCommand(CARD_INS.key, 0, '', 0), 'to give its key');
    }).then(function (d) {
      if (!cardHexOk(d, 33) || !/^0[23]/.test(d)) throw cardError('not-a-card', 'That card\u2019s key is not a key.');
      card.key = d;
      var mine = new Uint8Array(16);
      window.crypto.getRandomValues(mine);
      card._nonce = hexOf(mine);
      return t.want(cardCommand(CARD_INS.auth, 0, card._nonce, 80), 'to prove it is the card');
    }).then(function (d) {
      if (!cardHexOk(d, 80)) throw cardError('not-a-card', 'That card could not prove it is the card it says it is.');
      var tag = sha256(Array.prototype.map.call('FoxyCard/auth', function (c) { return c.charCodeAt(0); }));
      var said = tag.concat(tag, Array.prototype.slice.call(bytesOfHex(card._nonce)),
                            Array.prototype.slice.call(bytesOfHex(d.slice(0, 32))), Array.prototype.slice.call(bytesOfHex(card.key)));
      var good = false;
      try { good = window.CashuTS.schnorrVerifyDigest(d.slice(32), new Uint8Array(sha256(said)), card.key) === true; } catch (e) { good = false; }
      delete card._nonce;
      if (!good) throw cardError('not-a-card', 'That card could not prove it is the card it says it is.');
      return t.want(cardCommand(CARD_INS.card, 0, '', 0), 'to give its record');
    }).then(function (d) {
      card.record = cardRecordOf(d);
      return t.want(cardCommand(CARD_INS.slots, 0, '', 0), 'to list what it holds');
    }).then(function (d) {
      card.slots = [];
      var walk = Promise.resolve();
      for (var i = 0; i * 2 < d.length; i++) {
        if (d.substr(i * 2, 2) === '00') continue;
        (function (at) {
          walk = walk.then(function () { return t.want(cardCommand(CARD_INS.proof, at, '', 0), 'to show a piece'); }).then(function (hex) {
            var slot = /** @type {any} */ (cardSlotOf(hex));
            slot.i = at;
            card.slots.push(slot);
          });
        })(i);
      }
      return walk;
    }).then(function () {
      card.pieces = card.slots.filter(function (x) { return x.state === 'unspent'; });
      card.balance = card.pieces.reduce(function (n, x) { return n + x.amount; }, 0);
      return card;
    });
  }

  /* ---- the cards this phone knows ---------------------------------------------
   *
   * A card this phone set up as recoverable has a key of this phone's on it:
   * the refund key every piece loaded onto it names. The row here is how that
   * key is found again: the index the phone derived it at, kept for as long as
   * the card might hold money, which is for ever. It is not in the lock-key
   * rows, which are capped and swept (07-request-delivery.js). */
  var CARDS = 'foxy.flashcard.cards';

  function cardsOnFile() {
    var all = load(CARDS, {});
    return (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
  }

  /* A refund key for this card, from the phone's words: the one already on
   * file for it, or a fresh one, written down before it is answered. '' when
   * the phone has none to give. */
  function cardRefundKey(cardKey) {
    var known = cardsOnFile()[cardKey];
    if (known && /^0[23][0-9a-f]{64}$/.test(String(known.refundKey || ''))) return Promise.resolve(known.refundKey);
    return primeLockPool().then(function () {
      var id = 'flashcard-' + cardKey;
      var pub = lockPubFor(id) || takeLockKey(id);
      if (!pub) return '';
      var row = lockKeys()[id] || {};
      var all = cardsOnFile();
      all[cardKey] = { refundKey: pub, refundIndex: Number.isInteger(row.i) ? row.i : -1,
                       mint: canonicalMint(mintUrl || ''), at: Date.now() };
      mustSave(CARDS, all);
      return pub;
    });
  }

  /* ---- money on its way to a card, and from one ------------------------------
   *
   * Two stores, both written before the thing they describe is tried.
   *
   * OWED: pieces locked to a card and not yet written onto it. A holder's
   * top-up between the swap that made it and the tap that writes it; a
   * receiver's change for a payment, or a payment's pieces going back, when
   * the card left before they were written. They are locked to the card's
   * key, so they are nobody's to spend but the card's, and this phone's only
   * job is to hand them over. Outside every balance.
   *
   * TAKEN: a card's pieces with the card's signatures on them, between the
   * tap that signed them and the mint's answer. The card has marked them
   * spent and will not sign again, so this is the only copy of the right to
   * spend them. Not this phone's money until the mint has swapped them. */
  var CARD_OWED = 'foxy.flashcard.owed';
  var CARD_TAKEN = 'foxy.flashcard.taken';
  /* A year, for a piece on a recoverable card: after it, the key that loaded
   * the card may take the piece back. A piece this close to its date is not
   * taken in payment (some mints stop honouring the card's own key then). */
  var CARD_DATE_AHEAD = 365 * 24 * 3600;
  var CARD_DATE_MARGIN = 7 * 24 * 3600;
  /* The margin is a stranger's: it is what keeps a receiver from taking a
   * piece its loader could take back days later. The phone that holds the
   * card's refund key is that loader, and has nobody to guard against but the
   * clock: ten minutes, so a swap begun before the date is not answered after
   * it. Without this a holder could not empty or renew their own card in its
   * last week, which is the week they are told to. */
  var CARD_OWN_MARGIN = 10 * 60;

  function cardStore(key) {
    var l = load(key, []);
    return Array.isArray(l) ? l : [];
  }

  /* When this phone last had the mint's word that a card's pieces were good,
   * and which pieces that word was about: { <card key>: { at, nonces } }.
   *
   * Kept so a phone with no connection can say how old its last word on a
   * card is ("verified 2 hours ago"), and only for the pieces it was about: a
   * card that holds anything newer has not been verified, however lately the
   * rest was. Twenty cards, the oldest dropped. Nothing but that line reads
   * it, so a write that does not land costs the line and nothing else. */
  var CARD_CHECKED = 'foxy.flashcard.checked';
  function cardCheckedAll() {
    var o = load(CARD_CHECKED, {});
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  }
  function cardCheckedNote(card) {
    if (!card || !card.key || !card.pieces || !card.pieces.length) return 0;
    var all = cardCheckedAll();
    var at = Date.now();
    all[card.key] = { at: at, nonces: card.pieces.map(function (x) { return String(x.nonce); }) };
    var keys = Object.keys(all).sort(function (a, b) { return (Number(all[a].at) || 0) - (Number(all[b].at) || 0); });
    while (keys.length > 20) { var oldest = keys.shift(); if (oldest !== undefined) delete all[oldest]; }
    save(CARD_CHECKED, all);
    return at;
  }
  /* When, for the card as it is now: every piece on it was among those the
   * mint vouched for. Nought when any was not, or the card was never asked
   * about here. */
  function cardCheckedAt(card) {
    if (!card || !card.key || !card.pieces || !card.pieces.length) return 0;
    var note = cardCheckedAll()[card.key];
    if (!note || !Array.isArray(note.nonces) || !(Number(note.at) > 0)) return 0;
    var had = {};
    note.nonces.forEach(function (n) { had[String(n)] = true; });
    return card.pieces.every(function (x) { return had[String(x.nonce)]; }) ? Number(note.at) : 0;
  }

  /* The fields of a locked piece's secret: its nonce, the key it is locked
   * to, its date and its refund key ('' and 0 where it has none). Null for
   * anything that is not such a secret. */
  function cardSecretParts(secret) {
    var j = null;
    try { j = JSON.parse(String(secret)); } catch (e) { return null; }
    if (!Array.isArray(j) || j[0] !== 'P2PK' || !j[1] || typeof j[1] !== 'object') return null;
    var out = { nonce: String(j[1].nonce || ''), key: String(j[1].data || ''), date: 0, refundKey: '' };
    (Array.isArray(j[1].tags) ? j[1].tags : []).forEach(function (tag) {
      if (!Array.isArray(tag)) return;
      if (tag[0] === 'locktime') out.date = Number(tag[1]) || 0;
      if (tag[0] === 'refund') out.refundKey = String(tag[1] || '');
    });
    return out;
  }

  /* A token's proofs as pieces this card can hold, or a throw saying why not.
   * Each must be locked to this card and, built again from what the card will
   * keep of it, be the same secret to the character: a piece that is not is
   * one the card could never sign for, and must not be written onto it. */
  function cardPiecesOf(token, card) {
    var tok = FoxyWallet.tokenInfo(token);
    if (!tok || !Array.isArray(tok.proofs) || !tok.proofs.length) throw cardError('misfit', 'That is not ecash for a card.');
    return tok.proofs.map(function (pr) {
      var parts = cardSecretParts(pr.secret);
      // the eight bytes the card will hold, which must lead back to this keyset and no other
      var id = cardShortId(pr.id);
      if (!parts || parts.key !== card.key) throw cardError('misfit', 'That ecash is not locked to this card.');
      if (!id) throw cardError('misfit', 'This mint\u2019s keys are a kind the card cannot hold yet.');
      if (String(pr.id).length > 16 && cardFullId(wallet, id) !== String(pr.id).toLowerCase()) {
        throw cardError('misfit', keysetIdsFor(wallet).map(function (k) { return String(k).toLowerCase(); }).indexOf(String(pr.id).toLowerCase()) < 0
          ? 'That ecash is of another mint than the one this phone is at.'
          : 'Two of this mint\u2019s sets of keys would read the same on a card, so none of their ecash is put on one.');
      }
      var built = '';
      try { built = cardSecret(parts.nonce, card.key, parts.date, card.record.refundKey); } catch (e) { built = ''; }
      if (built !== String(pr.secret)) throw cardError('misfit', 'That ecash is not written the way this card writes it.');
      return { keyset: id, amount: satsOf(pr.amount), nonce: parts.nonce, C: String(pr.C).toLowerCase(), date: parts.date };
    });
  }

  /* Write owed pieces onto the card they are for. The PIN has been verified in
   * this tap already. Spent places are freed first. A piece already on the
   * card (by its nonce) is not written twice, so a tap that was cut short is
   * finished by the next. Answers { sats, done: [ids], left: [ids] }; rejects
   * only when nothing at all could be written for a reason worth saying. */
  function cardWriteOwed(t, card) {
    var mine = cardStore(CARD_OWED).filter(function (r) { return r && r.card === card.key; });
    if (!mine.length) return Promise.resolve({ sats: 0, done: [], left: [] });
    var onCard = {};
    card.slots.forEach(function (x) { if (x.state === 'unspent') onCard[x.nonce] = true; });
    var done = [], left = [], sats = 0, stopped = null, misfit = null;
    var walk = t.want(cardCommand(CARD_INS.clear, 0, '', 1), 'to free its used places').then(function () {}, function (e) {
      // a locked card frees nothing, and may still have room
      if (!(e && e.card === 'locked')) throw e;
    });
    mine.forEach(function (row) {
      walk = walk.then(function () {
        if (stopped) { left.push(row.id); return null; }
        var pieces;
        // a row that does not fit this card here (another mint's, say) is passed over, and the rows after it still go on
        try {
          /* Of the card's own mint, by the token's own word. A keyset's short
           * name says nothing of whose it is, and a card moved to another
           * mint must not be handed what was made for it at the first. */
          var at = (FoxyWallet.tokenInfo(row.token) || {}).mint || '';
          if (at && card.record && card.record.mint && canonicalMint(at) !== canonicalMint(card.record.mint)) {
            throw cardError('other-mint', 'That ecash is at ' + hostOf(at) + ', and this card is at ' + hostOf(card.record.mint) + '.',
                            { mint: canonicalMint(at) });
          }
          pieces = cardPiecesOf(row.token, card);
        } catch (e) { misfit = misfit || e; left.push(row.id); return null; }
        var each = Promise.resolve();
        pieces.forEach(function (piece) {
          each = each.then(function () {
            if (onCard[piece.nonce]) return null;
            return t.want(cardCommand(CARD_INS.load, 0, cardPieceBytes(piece), 1), 'a piece').then(function () { onCard[piece.nonce] = true; });
          });
        });
        return each.then(function () {
          done.push(row.id);
          sats += Math.round(Number(row.sats) || 0);
          // off the list as each lands, so a card that leaves now owes only what is left
          mustSave(CARD_OWED, cardStore(CARD_OWED).filter(function (r) { return !(r && r.id === row.id); }));
          // written: marked on the token's own note, so it is never taken for one that was not (`cardAdopt`)
          try { FoxyWallet.tag(row.id, { carded: Date.now() }); } catch (x0) {}
          if (row.kind === 'change' && row.forHash) { try { amendTx(row.forHash, { changeState: 'given back', changeKept: true }); } catch (x) {} }
        }, function (e) { stopped = e; left.push(row.id); });
      });
    });
    return walk.then(function () {
      if (stopped && !done.length) throw stopped;
      var why = stopped || misfit;
      return { sats: sats, done: done, left: left, why: why ? (why.card || 'refused') : '' };
    });
  }

  /* Ecash this phone made for this card that is not on file as owed to it.
   *
   * It should never happen and it did: the pieces were made at the mint,
   * locked to the card, and the step after that threw before they were filed
   * (a mint whose keysets the card could not then hold). The token was still
   * written down, as every token this phone makes is, on its own note. But
   * nothing knew it was the card's, and only the card can spend it.
   *
   * So when a card is read, the tokens this phone still holds the text of are
   * looked through for any locked to exactly this card's key, in the card's
   * own words, that have never been written onto a card; and each is filed
   * as owed to it, to go on at the next tap with its PIN. Answers how many. */
  function cardAdopt(card) {
    if (!card || !card.key) return 0;
    var meta = load('foxy.txmeta', {});
    if (!meta || typeof meta !== 'object') return 0;
    /* Of the card's own mint, and no other. A card's key alone does not say
     * whose ecash a token is: a card set up again at another mint keeps its
     * key, and what was made for it at the first is not money it can hold at
     * the second. The card's record names its mint; a card with no record
     * yet is owed nothing. */
    var home = (card.record && card.record.mint) ? canonicalMint(card.record.mint) : '';
    if (!home) return 0;
    var before = cardStore(CARD_OWED);
    // a row adopted for this card from some other mint (an older rule filed them) is taken off the list again
    var owed = before.filter(function (r) {
      if (!r || !r.adopted || r.card !== card.key) return true;
      var at = r.mint || '';
      // a row filed before rows said their mint: the token says it
      if (!at) { try { at = (FoxyWallet.tokenInfo(r.token) || {}).mint || ''; } catch (e) { at = ''; } }
      return !at || canonicalMint(at) === home;
    });
    var filed = {};
    owed.forEach(function (r) { if (r) { filed[r.id] = true; if (r.token) filed[r.token] = true; } });
    var found = 0, sats = 0;
    Object.keys(meta).forEach(function (hash) {
      var note = meta[hash];
      if (!note || typeof note.token !== 'string' || !note.token || note.carded) return;
      if (filed[hash] || filed[note.token]) return;
      var tok = null;
      try { tok = FoxyWallet.tokenInfo(note.token); } catch (e) { tok = null; }
      if (!tok || !Array.isArray(tok.proofs) || !tok.proofs.length) return;
      if (!tok.mint || canonicalMint(tok.mint) !== home) return;
      var mine = tok.proofs.every(function (pr) {
        var parts = cardSecretParts(pr.secret);
        return !!parts && parts.key === card.key;
      });
      if (!mine) return;
      owed.push({ id: hash, card: card.key, token: note.token, sats: sumProofs(tok.proofs), kind: 'load', forHash: hash, at: Date.now(),
                  adopted: true, mint: home });
      filed[hash] = true;
      found += 1;
      sats += sumProofs(tok.proofs);
      try { amendTx(hash, { memo: 'to card', card: card.key }); } catch (x) {}
      try { FoxyWallet.tag(hash, { to: 'card' }); } catch (x2) {}
    });
    if (found || owed.length !== before.length) mustSave(CARD_OWED, owed);
    if (found) console.warn('[foxy] card: ' + sats + ' sats made for this card were not on file as owed to it; filed now, to be written at the next tap');
    return found;
  }

  /* Rows that were found and filed (`cardAdopt`), asked of the mint before
   * they are trusted. Finding goes by what this phone wrote down, and a token
   * written onto a card before such things were marked looks the same as one
   * that never was. The mint knows: pieces it has seen spent were on a card
   * once and are nobody's now, and their row is struck off and marked so it
   * is not found again. With no route nothing is asked and nothing changes.
   * Resolves how many rows went. */
  function cardOwedPrune(card) {
    var w = wallet;
    if (!w || !card || !card.key || !routeOpen()) return Promise.resolve(0);
    var here = mintOf(w);
    var rows = cardStore(CARD_OWED).filter(function (r) {
      return r && r.adopted && r.card === card.key && (!r.mint || canonicalMint(r.mint) === here);
    });
    if (!rows.length) return Promise.resolve(0);
    var gone = 0;
    return rows.reduce(function (chain, row) {
      return chain.then(function () {
        var tok = null;
        try { tok = FoxyWallet.tokenInfo(row.token); } catch (e) { tok = null; }
        if (!tok || !Array.isArray(tok.proofs) || !tok.proofs.length) return null;
        return withTimeout(Promise.resolve().then(function () { return onCircuit(w, 'card:' + card.key.slice(-16)).checkProofsStates(tok.proofs); }),
                           30000, 'the mint\u2019s word on ecash found for a card')
          .then(function (states) {
            var spent = tok.proofs.every(function (pr, i) {
              var st = (states && states[i]) || {};
              return String(st.state || st.State || '').toUpperCase() === 'SPENT';
            });
            if (!spent) return;
            mustSave(CARD_OWED, cardStore(CARD_OWED).filter(function (r) { return !(r && r.id === row.id); }));
            try { FoxyWallet.tag(row.id, { carded: Date.now() }); } catch (x) {}
            gone += 1;
            console.log('[foxy] card: ecash found for a card had been on it and spent already; struck off');
          }, function () {});
      });
    }, Promise.resolve()).then(function () { return gone; });
  }

  /* The record a card is given (SET_CARD): its unit, the key that may take
   * its pieces back or none, and its mint's address as text. Throws where the
   * address is one a card cannot hold. */
  function cardRecordHex(refundKey, mint) {
    var at = String(mint || '');
    if (!at || at.length > 96 || /[^\x20-\x7e]/.test(at)) throw cardError('bad-mint', 'This mint\u2019s address is too long for a card.');
    var hex = '';
    for (var i = 0; i < at.length; i++) hex += cardByte(at.charCodeAt(i));
    return '00' + (refundKey || new Array(67).join('0')) + cardByte(at.length) + hex;
  }

  /* A card on its way to another mint, told so.
   *
   * Money moved for a card is filed as owed to it at the mint it was moved
   * to (`cardPrepare`, `moving`). When that card is next written, at that
   * mint, its record is changed first. Only an empty card: the card itself
   * refuses to change mints under unspent pieces, and it is not asked to. So
   * a card never holds ecash of a mint it does not name, and a move cut short
   * before its second tap is finished by any later one. The PIN has been
   * verified in this tap. Answers whether it changed. */
  function cardRepointFor(t, card) {
    var w = wallet;
    if (!w || !card || !card.record) return Promise.resolve(false);
    var here = mintOf(w);
    if (canonicalMint(card.record.mint) === here) return Promise.resolve(false);
    var mine = cardStore(CARD_OWED).filter(function (r) {
      return r && r.card === card.key && r.repoint && r.mint && canonicalMint(r.mint) === here;
    });
    if (!mine.length) return Promise.resolve(false);
    if (card.pieces.length) {
      return Promise.reject(cardError('in-use', 'This card still holds money at ' + hostOf(card.record.mint) + '. Take that off it first.'));
    }
    var record;
    try { record = cardRecordHex(card.record.refundKey, here); } catch (e) { return Promise.reject(e); }
    return t.want(cardCommand(CARD_INS.setCard, 0, record), 'its new mint').then(function () {
      console.log('[foxy] card: moved from ' + hostOf(card.record.mint) + ' to ' + hostOf(here));
      // as the card now has it: what is written next is checked against this
      card.record.mint = here;
      return true;
    });
  }

  /* Whether this mint's ecash can go on a card at all, asked before any is
   * made: the keyset new pieces will be of must have a short form that leads
   * back to it and to no other. An error, or null. */
  function cardMintMisfit(w) {
    var id = String((w && w.keysetId) || '').toLowerCase();
    if (!id) return null;                     // not known yet: the pieces themselves are checked
    var short = cardShortId(id);
    if (!short) return cardError('misfit', 'This mint\u2019s keys are a kind the card cannot hold yet.');
    if (cardFullId(w, short) !== id) {
      return cardError('misfit', 'Two of this mint\u2019s sets of keys would read the same on a card, so none of their ecash is put on one.');
    }
    return null;
  }

  /* Which of a card's pieces can pay, at this mint, now: of a keyset this
   * mint has, and not within a week of its date. */
  function cardUsable(card, w, own) {
    var now = Math.floor(Date.now() / 1000);
    var margin = own ? CARD_OWN_MARGIN : CARD_DATE_MARGIN;
    var out = /** @type {{ pieces: any[], stale: number, foreign: number }} */ ({ pieces: [], stale: 0, foreign: 0 });
    card.pieces.forEach(function (x) {
      var id = cardFullId(w, x.keyset);
      if (!id) { out.foreign += x.amount; return; }
      if (x.date && x.date < now + margin) { out.stale += x.amount; return; }
      var proof = /** @type {any} */ (cardProofOf(x, card.key, card.record.refundKey, id));
      proof.slot = x.i;
      proof.date = x.date;
      out.pieces.push(proof);
    });
    return out;
  }

  /* Whether this phone is the one that may take this card back: the refund
   * key the card names is the one on file here for it. */
  function cardMine(card) {
    var row = cardsOnFile()[card.key];
    return !!(row && row.refundKey && card.record && row.refundKey === card.record.refundKey);
  }

  /* Why this card cannot be used here at all, as an error, or null. */
  function cardUnusable(card, w) {
    if (card.info.pin === 'blocked') return cardRefused('6983');
    if (card.info.pin === 'none' || !card.info.hasRecord) return cardError('empty', 'There is no money on this card.');
    if (card.record.unit !== 'sat') return cardError('not-a-card', 'That card holds something other than sats.');
    var here = mintOf(w);
    if (canonicalMint(card.record.mint) !== here) {
      return cardError('other-mint', 'This card\u2019s money is at ' + hostOf(card.record.mint) + '. This phone is at ' + hostOf(here) + '.',
                       { mint: canonicalMint(card.record.mint) });
    }
    return null;
  }

  /* Have the card sign for these pieces: the PIN, then each in turn. Answers
   * the pieces with their witnesses. If the card leaves part-way, the ones it
   * did sign are on the error as `signed`: the card has marked them spent, so
   * they are not to be dropped. */
  function cardSign(t, card, picked, pinHex) {
    var signed = [];
    return t.want(cardCommand(CARD_INS.verify, 0, pinHex), 'its PIN').then(function () {
      var walk = Promise.resolve();
      picked.forEach(function (proof) {
        walk = walk.then(function () {
          return t.want(cardCommand(CARD_INS.spend, proof.slot, '', 64), 'to sign for a piece').then(function (sig) {
            var one = { id: proof.id, amount: proof.amount, secret: proof.secret, C: proof.C,
                        witness: JSON.stringify({ signatures: [sig] }) };
            var good = false;
            try { good = window.CashuTS.isP2PKSpendAuthorised(one) === true; } catch (e) { good = false; }
            if (!good) throw cardError('bad-signature', 'The card\u2019s signature for a piece was not good. Nothing more was asked of it.');
            signed.push(one);
          });
        });
      });
      return walk;
    }).then(function () { return signed; }, function (e) {
      try { e.signed = signed; } catch (x) {}
      throw e;
    });
  }

  /* What this phone last knew to be on a card it can take back: the pieces'
   * own fields, by nonce. A card that is lost is taken back from this, so it
   * is added to whenever the card is loaded or read here, and never trimmed
   * by a read that shows less: a piece that is gone from the card has been
   * spent, and the mint will say so. */
  function cardRemember(card, pieces, whole) {
    var all = cardsOnFile();
    var row = all[card.key];
    if (!row) return;
    var seen = row.pieces && typeof row.pieces === 'object' ? row.pieces : {};
    var here = {};
    (pieces || []).forEach(function (x) {
      if (!x || !x.nonce) return;
      here[x.nonce] = true;
      seen[x.nonce] = { keyset: x.keyset, amount: x.amount, C: x.C, date: x.date || 0 };
    });
    /* `whole`: these are all the card holds, so anything else on file has
     * left it. Marked, not forgotten: a piece the card signed for and nobody
     * swapped is still unspent at the mint, the card will never sign for it
     * again, and this row is the only road by which it comes back. What a
     * screen says the card holds leaves the marked ones out (`cardsList`). */
    if (whole) cardLeft(seen, Object.keys(seen).filter(function (n) { return !here[n]; }));
    row.pieces = seen;
    row.seen = Date.now();
    all[card.key] = row;
    if (!save(CARDS, all)) console.warn('[foxy] card: what is on a card could not be written down; it can be taken back only from what was known before');
  }

  function cardLeft(seen, nonces) {
    nonces.forEach(function (n) { if (seen[n] && !seen[n].gone) seen[n].gone = Date.now(); });
  }

  /* Pieces this phone has just had its own card sign for: off the card, as
   * far as any screen is concerned, from this moment. */
  function cardSpentHere(cardKey, nonces) {
    var all = cardsOnFile();
    var row = all[cardKey];
    if (!row || !row.pieces || typeof row.pieces !== 'object') return;
    cardLeft(row.pieces, nonces);
    row.seen = Date.now();
    save(CARDS, all);
  }

  /* Swap a row of TAKEN at the mint, by the ordinary receive. The entry is
   * the row's own id, so an answer that was lost and found again finishes
   * that entry and no other. Rejects with `card: 'spent'` when the mint says
   * the pieces are gone and it was not this phone that took them. */
  /* What moving `have` sats off a card and out of its mint will take in all
   * at the most, for a plan asked before the card is touched
   * (`transferQuote`'s `quoteOnly`): the money is not in this phone yet, so
   * that plan counts the invoice and the route's reserve and nothing this
   * mint charges for the card's own pieces.
   *
   * Three things it charges: its fee to swap the card's `pieces` pieces into
   * this phone, its fee on the pieces cut for the payment, and its fee on the
   * pieces that are spent to cut them. The last depends on which pieces are
   * picked, and the picking is not the same twice (cashu-ts tries at random),
   * so it is counted at its most: the whole pile as it will be, this phone's
   * own pieces and the ones that swap will make, shaped as any receipt's are.
   *
   * Over is the side to be wrong on. A figure that is over costs nobody
   * anything: what the payment does not use stays in this phone. A figure
   * that is under is found out after the card's first tap has emptied it.
   * It was the plan's own figure, which counts the fee for swapping this
   * phone's pile as it is now: the screen showed "FEE: UP TO 20", the card
   * was emptied, and the move stopped for a fee of 23, "more than was shown"
   * (tools/live/flashcard-switch.js, from Nutshell 0.21.0 at 100 ppk).
   *
   * Asked from a mint this phone is not connected to, the allowance a
   * cross-mint tap makes for money that has not arrived (`inPadSats`). */
  function cardMoveAhead(from, have, pieces, plan) {
    var off = 0;
    try {
      var w = need();
      if (String(mintOf(w)).replace(/\/+$/, '') !== from) throw new Error('not at that mint');
      off = feeForInputs(w, Math.max(1, Math.round(Number(pieces) || 1)));
      var mine = proofs(from);
      var made = shapeOutputs(mine, Math.max(0, have - off), mintArrayCap(w) - 16);
      var base = satsOf(plan.meltQuote.amount) + plan.reserve;
      // the payment's own pieces: one for each binary place the amount has, and four to spare (`meltNeed`)
      var cut = feeForInputs(w, base.toString(2).length + 4);
      return off + base + cut + feeForInputs(w, mine.length + made.length);
    } catch (e) {
      return plan.gross + off + (plan.inPadSats || 0);
    }
  }

  function cardSwapTaken(row, again) {
    return FoxyWallet.receiveToken(row.token, { hash: row.id, memo: row.memo || 'card',
                                                keptSats: row.all ? undefined : row.sats,
                                                changeSats: row.all ? undefined : (row.over > 0 ? row.over : undefined),
                                                grossSats: row.all ? undefined : row.worth })
      .then(function (r) {
        mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && x.id === row.id); }));
        // 'card' is a move the screens say themselves; 'card payment' is announced like any other (16-history-lists.js)
        try { FoxyWallet.tag(row.id, { to: (row.memo === 'from card' || row.refund) ? 'card' : 'card payment' }); } catch (x) {}
        // and names the card, as a load's entry does: the card's own history is read from that (26f-flashcard.js)
        try { amendTx(row.id, { card: row.card }); } catch (x1) {}
        return { sats: (r && r.sats) || 0 };
      }, function (e) {
        var text = String((e && e.message) || '');
        /* "Spent, and by this phone" means two different things. Asked
         * again about a row that was already written down, it is the answer
         * that was lost, found: the payment was made. On the first asking,
         * moments after the card signed, it is the same pieces arriving a
         * second time, which is a copy of a card that has already paid here.
         * Told apart by which asking this is, and never by the mint's words:
         * taken as a found answer both times, a copied card tapped after the
         * real one was shown as paid (tests/flashcard-money.js). */
        if (e && e.foxyMine && again) {
          mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && x.id === row.id); }));
          return { sats: Number(e.foxyTakenSats) || 0 };
        }
        if ((e && e.foxyMine) || /already spent|token already|already claimed|nothing to take/i.test(text) || Number(e && e.code) === 11001) {
          mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && x.id === row.id); }));
          throw cardError('spent', 'The mint says this card\u2019s money was already spent.');
        }
        throw cardError('waiting', 'The card has signed and the mint has not answered yet. ' + text, { id: row.id });
      });
  }

  /* The one flow behind being paid by a card and emptying one (21a-flashcard.js). */
  function cardTake(link, o, memo) {
    var on = function (step) { try { if (typeof o.on === 'function') o.on(step); } catch (e) {} };
    var pin;
    try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); }
    var want = o.all ? 0 : Math.round(Number(o.sats));
    if (!o.all && !(want > 0)) return Promise.reject(cardError('bad-amount', 'Ask for an amount above zero.'));
    var w;
    try { w = need(); } catch (e2) { return Promise.reject(e2); }
    if (!routeOpen()) return Promise.reject(cardError('no-route', 'There is no connection to the mint, so the card was not asked for anything.'));
    var t = cardTalk(link);
    var card, picked, worth, fee, row, result, own;
    on('reading');
    return cardLook(link).then(function (c) {
      card = c;
      var no = cardUnusable(card, w);
      if (no) throw no;
      own = cardMine(card);
      // this phone's own card, read: what is on it now is written down, as at any other read
      if (own) cardRemember(card, card.pieces, true);
      var usable = cardUsable(card, w, own);
      var have = usable.pieces;
      if (o.all) {
        picked = have;
      } else {
        picked = exactPieces(w, have, want);
        if (!picked) {
          var cover = coverPieces(w, have, want);
          picked = cover ? cover.picked : null;
        }
      }
      if (!picked || !picked.length) {
        if (usable.stale > 0 && card.balance >= want) {
          throw own
            ? cardError('past-date', 'This card\u2019s date has passed. Its money comes back to this phone with TAKE IT BACK, and needs no card.', { stale: usable.stale })
            : cardError('renew', 'This card must be renewed by its owner before it can pay.', { stale: usable.stale });
        }
        throw cardError('not-enough', 'The card holds ' + card.balance + ' sats.', { balance: card.balance });
      }
      worth = sumProofs(picked);
      fee = swapFeeFor(w, picked);
      if (!isFinite(fee) || fee < 0) fee = 0;
      if (o.all) want = worth - fee;
      if (!(want > 0) || worth - fee < want) throw cardError('not-enough', 'The card holds ' + card.balance + ' sats.', { balance: card.balance });
      /* The card's limit, asked of it here and not found out half-way: a
       * card that signs for three pieces and refuses the fourth has spent
       * three for a payment that was not made. */
      if (card.record.limit && worth > card.record.limit) {
        throw cardError('over-limit', 'That is more than this card lets one PIN entry spend (' + card.record.limit + ' sats).', { limit: card.record.limit });
      }
      on('signing');
      return cardSign(t, card, picked, pin);
    }).then(function (signed) {
      if (own) cardSpentHere(card.key, signed.map(function (pr) { var parts = cardSecretParts(pr.secret); return parts ? parts.nonce : ''; }));
      var token = window.CashuTS.getEncodedToken({ mint: mintOf(w), proofs: signed, unit: 'sat' });
      row = { id: 'card-' + piecesFingerprint(signed), token: token, sats: want, worth: worth - fee, over: worth - fee - want,
              all: !!o.all, card: card.key, memo: memo, at: Date.now() };
      mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).concat([row]));
      on('mint');
      return cardSwapTaken(row);
    }, function (e) {
      /* The card left, or refused, part-way through signing. What it did
       * sign for it has marked spent, and those pieces are the holder's
       * money with only this phone able to move them: they go back to the
       * card, by the same road as change. */
      var some = (e && e.signed) || [];
      if (!some.length) throw e;
      var back = { id: 'card-' + piecesFingerprint(some), token: window.CashuTS.getEncodedToken({ mint: mintOf(w), proofs: some, unit: 'sat' }),
                   sats: 0, worth: sumProofs(some), over: sumProofs(some), all: false, card: card.key, memo: 'card, not completed', at: Date.now(),
                   refund: true };
      mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).concat([back]));
      console.warn('[foxy] card: the card signed for ' + some.length + ' of ' + picked.length + ' pieces and left; what it signed goes back to it');
      return cardReturn(back, card, w).then(function () { throw cardError('interrupted', 'The card was taken away too soon. Nothing was paid, and ' + sumProofs(some) + ' sats are waiting to go back on it.', { owed: sumProofs(some) }); },
        function () { throw cardError('interrupted', 'The card was taken away too soon. Nothing was paid; what it signed for will go back to it when the mint answers.', { owed: sumProofs(some) }); });
    }).then(function (got) {
      result = { sats: want, hash: row.id, change: null };
      var over = row.all ? 0 : Math.max(0, worth - fee - want);
      if (!(over > 0)) { on('done'); return result; }
      /* Change, less what it costs to make and for the card to spend again
       * (`changeFromPile`): the receiver keeps exactly what it asked for, and
       * the payer who paid over carries the cost of the difference coming
       * back, as with any other change here. Where that leaves nothing, the
       * sat or two over stay with the payment and its entry says so. */
      var back = changeFromPile(w, over);
      if (!(back > 0)) {
        try { FoxyWallet.changeSettled(row.id, 0); } catch (x) {}
        on('done');
        return result;
      }
      on('change');
      /* Locked to the card again and with the date of what it paid with: the
       * holder's wait for a lost card is not lengthened by a receiver. Made
       * from this phone's pile, which the swap has just put the whole of the
       * card's pieces into. */
      var date = picked.reduce(function (d, pr) { return Math.max(d, pr.date || 0); }, 0);
      var refund = card.record.refundKey;
      try { amendTx(row.id, { changeState: 'making' }); } catch (x) {}
      return FoxyWallet.sendToken(back, { unit: 'sat', lockTo: card.key, lockUntil: (refund && date) ? date : undefined,
                                          refundTo: (refund && date) ? refund : undefined,
                                          purpose: 'change', forHash: row.id, owed: over })
        .then(function (made) {
          settleChangeMade(row.id, over, { sats: made.sats, fee: made.fee, back: back });
          cardPiecesOf(made.token, card);
          mustSave(CARD_OWED, cardStore(CARD_OWED).concat([{ id: made.hash, card: card.key, token: made.token, sats: made.sats,
                                                             kind: 'change', forHash: row.id, at: Date.now() }]));
          try { amendTx(row.id, { changeState: 'not handed' }); } catch (x) {}
          /* Back onto the card now: the tap is still open and its PIN still
           * stands. Not read again first: choosing the applet again ends the
           * session the PIN was verified in, and what was read at the start
           * of the tap is still what is on the card but for what it spent. */
          return cardWriteOwed(t, card).then(function (wrote) {
            result.change = { sats: made.sats, written: wrote.left.length === 0 };
          }, function () {
            result.change = { sats: made.sats, written: false };
          });
        }, function (e) {
          // the payment is made; its change could not be. This phone kept the lot, and its entry says so
          console.warn('[foxy] card: the change for a card payment could not be made:', (e && e.message) || e);
          try { FoxyWallet.changeSettled(row.id, 0); } catch (x) {}
          result.change = { sats: over, written: false, unmade: true };
        }).then(function () { on('done'); return result; });
    });
  }

  /* Pieces a card signed for a payment that was not made, on their way back
   * to it: swapped into this phone and straight out again as pieces locked to
   * the card, owed to it. */
  function cardReturn(row, card, w) {
    return cardSwapTaken(row).then(function (got) {
      var owed = Math.max(0, got.sats);
      var back = changeFromPile(w, owed);
      if (!(back > 0)) return null;
      var date = 0;
      try {
        var info = FoxyWallet.tokenInfo(row.token);
        ((info && info.proofs) || []).forEach(function (pr) {
          var parts = cardSecretParts(pr.secret);
          if (parts) date = Math.max(date, parts.date);
        });
      } catch (e) {}
      var refund = card.record.refundKey;
      try { amendTx(row.id, { memo: 'card, not completed', changeState: 'making', changeSats: owed, grossSats: owed, sats: 0 }); } catch (x) {}
      return FoxyWallet.sendToken(back, { unit: 'sat', lockTo: card.key, lockUntil: (refund && date) ? date : undefined,
                                          refundTo: (refund && date) ? refund : undefined,
                                          purpose: 'change', forHash: row.id, owed: owed })
        .then(function (made) {
          settleChangeMade(row.id, owed, { sats: made.sats, fee: made.fee, back: back });
          cardPiecesOf(made.token, card);
          mustSave(CARD_OWED, cardStore(CARD_OWED).concat([{ id: made.hash, card: card.key, token: made.token, sats: made.sats,
                                                             kind: 'refund', forHash: row.id, at: Date.now() }]));
          try { amendTx(row.id, { changeState: 'not handed' }); } catch (x) {}
          return made;
        });
    });
  }

