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

  /* The ecash a slot is: the proof a mint would be shown, without its witness. */
  function cardProofOf(slot, cardKey, refundKey) {
    return { id: slot.keyset, amount: slot.amount, C: slot.C,
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
  var CARD_AID = 'f0464f585943415244';
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

