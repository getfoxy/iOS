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

