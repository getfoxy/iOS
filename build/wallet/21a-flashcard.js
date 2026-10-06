
    /* ---- a card that holds ecash (08a-flashcard.js) --------------------- */

    /* The pure parts, for the screens and the tests. */
    cardSecret: function (nonce, cardKey, date, refundKey) { return cardSecret(nonce, cardKey, date, refundKey); },
    cardParse: { info: cardInfoOf, record: cardRecordOf, slot: cardSlotOf, piece: cardPieceBytes, proof: cardProofOf },

    /* What a card says with no PIN (`cardLook`). Rejects with `card` on the
     * error naming why: not-a-card, gone. */
    cardLook: function (link) { return cardLook(link); },

    /* A new card made this phone's: a PIN, and the record that says which mint
     * its money is at and who may take it back.
     *
     * `recoverable`: a key from this phone's words is written to the card, and
     * every piece loaded later names it, so a lost or blocked card's money
     * comes back to these words after the piece's date. Without it the card is
     * cash. The key is on file here before the card is told it, and the card
     * is told once: its record cannot change while it holds money.
     *
     * Also finishes a set-up that was cut off after the PIN was set and before
     * the record was written. */
    cardSetUp: function (link, opts) {
      var o = opts || {};
      var pin;
      try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); }
      var w;
      try { w = need(); } catch (e2) { return Promise.reject(e2); }
      var mint = mintOf(w);
      if (!mint || mint.length > 96 || /[^\x20-\x7e]/.test(mint)) {
        return Promise.reject(cardError('bad-mint', 'This mint\u2019s address is too long for a card.'));
      }
      var t = cardTalk(link);
      var card;
      return cardLook(link).then(function (c) {
        card = c;
        if (card.info.pin === 'blocked') throw cardRefused('6983');
        if (card.info.hasRecord) throw cardError('set-up', 'This card is already set up.');
        if (card.info.locked) throw cardRefused('6986');
        return o.recoverable ? cardRefundKey(card.key) : '';
      }).then(function (refund) {
        if (o.recoverable && !refund) throw cardError('no-key', 'This phone could not make the key that would bring a lost card\u2019s money back. Try again in a moment.');
        var mintHex = '';
        for (var i = 0; i < mint.length; i++) mintHex += cardByte(mint.charCodeAt(i));
        var record = '00' + (refund || new Array(67).join('0')) + cardByte(mint.length) + mintHex;
        var first = card.info.pin === 'none'
          ? t.want(cardCommand(CARD_INS.setPin, 0, pin), 'its new PIN')
          : Promise.resolve('');
        return first.then(function () {
          return t.want(cardCommand(CARD_INS.verify, 0, pin), 'its PIN');
        }).then(function () {
          return t.want(cardCommand(CARD_INS.setCard, 0, record), 'its record');
        });
      }).then(function () {
        console.log('[foxy] card: a new card is set up at ' + hostOf(mint) + (o.recoverable ? ', recoverable' : ', as cash'));
        return cardLook(link);
      });
    },

    /* The PIN changed. The card checks the old one itself; a wrong one costs a try. */
    cardChangePin: function (link, opts) {
      var o = opts || {};
      var oldPin, newPin;
      try { oldPin = cardPinHex(o.pin); newPin = cardPinHex(o.newPin); } catch (e) { return Promise.reject(e); }
      var t = cardTalk(link);
      return cardLook(link).then(function () {
        return t.want(cardCommand(CARD_INS.verify, 0, oldPin), 'its PIN');
      }).then(function () {
        return t.want(cardCommand(CARD_INS.changePin, 0, cardByte(oldPin.length / 2) + oldPin + newPin), 'its new PIN');
      }).then(function () { return true; });
    },

    /* The most one typing of the PIN may spend, in sats; 0 for no limit. */
    cardSetLimit: function (link, opts) {
      var o = opts || {};
      var pin;
      try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); }
      var sats = Math.round(Number(o.sats) || 0);
      if (!(sats >= 0 && sats <= 4294967295)) return Promise.reject(cardError('bad-limit', 'That is not a limit a card can hold.'));
      var t = cardTalk(link);
      return cardLook(link).then(function () {
        return t.want(cardCommand(CARD_INS.verify, 0, pin), 'its PIN');
      }).then(function () {
        return t.want(cardCommand(CARD_INS.setLimit, 0, ('00000000' + sats.toString(16)).slice(-8)), 'its limit');
      }).then(function () { return cardLook(link); });
    },

    /* The cards this phone has set up or loaded: { key: { mint, refundKey, at } }. */
    cardsKnown: function () { return cardsOnFile(); },

