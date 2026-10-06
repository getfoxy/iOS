
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

    /* ---- money onto a card --------------------------------------------------
     *
     * Two steps, so the mint is asked before the card is: `cardPrepare` makes
     * the pieces (a locked send from this phone's balance, to the card's key)
     * and files them as owed to the card; `cardWrite`, in a tap with the PIN,
     * writes whatever is owed to that card onto it. A tap that is cut short,
     * or a wrong PIN, leaves the pieces owed, and the next tap finishes it.
     * `cardAdd` is both in one tap, card first. */

    /* Pieces for `sats`, locked to this card, made and filed as owed to it.
     * `card` is what `cardLook` gave. Resolves { id, sats, hash }. */
    cardPrepare: function (card, sats) {
      var want = Math.round(Number(sats));
      if (!(want > 0)) return Promise.reject(cardError('bad-amount', 'Ask for an amount above zero.'));
      var w;
      try { w = need(); } catch (e) { return Promise.reject(e); }
      var no = cardUnusable(card, w);
      if (no && no.card !== 'empty') return Promise.reject(no);
      if (card.info.pin !== 'set' || !card.info.hasRecord) return Promise.reject(cardError('no-record', 'Set this card up first.'));
      if (card.info.locked) return Promise.reject(cardRefused('6986'));
      /* One piece for each power of two in the amount, and a few more where
       * the mint adds its fee: there must be places for them. Spent places
       * are freed at the write, so they count as room. */
      var room = card.info.empty + card.info.spent;
      if (piecesFor(want) + 4 > room) return Promise.reject(cardError('full', 'The card has no room for that. Take some money off it first.'));
      var recoverable = !!card.record.refundKey;
      var date = recoverable ? Math.floor(Date.now() / 1000) + CARD_DATE_AHEAD : 0;
      return FoxyWallet.sendToken(want, { unit: 'sat', lockTo: card.key, lockUntil: date || undefined,
                                          refundTo: recoverable ? card.record.refundKey : undefined, purpose: 'card' })
        .then(function (made) {
          // what the token must be for the card to take it: checked now, while it is only a row here
          cardPiecesOf(made.token, card);
          var row = { id: made.hash, card: card.key, token: made.token, sats: made.sats, kind: 'load', forHash: made.hash, at: Date.now() };
          mustSave(CARD_OWED, cardStore(CARD_OWED).concat([row]));
          try { amendTx(made.hash, { memo: 'to card', card: card.key }); } catch (x) {}
          try { FoxyWallet.tag(made.hash, { to: 'card' }); } catch (x2) {}
          if (recoverable) cardRemember(card, cardPiecesOf(made.token, card));
          console.log('[foxy] card: ' + made.sats + ' sats made for a card; to be written at the next tap');
          return { id: row.id, sats: made.sats, hash: made.hash };
        });
    },

    /* A tap with the PIN: everything owed to this card is written onto it.
     * Resolves { card, sats, left } with the card as it now reads. */
    cardWrite: function (link, opts) {
      var pin;
      try { pin = cardPinHex(opts && opts.pin); } catch (e) { return Promise.reject(e); }
      var t = cardTalk(link);
      var wrote;
      return cardLook(link).then(function (card) {
        if (card.info.pin === 'blocked') throw cardRefused('6983');
        return t.want(cardCommand(CARD_INS.verify, 0, pin), 'its PIN').then(function () { return cardWriteOwed(t, card); });
      }).then(function (r) {
        wrote = r;
        return cardLook(link);
      }).then(function (card) {
        if (card.record.refundKey && cardsOnFile()[card.key]) cardRemember(card, card.pieces);
        return { card: card, sats: wrote.sats, left: wrote.left.length, why: wrote.why || '' };
      });
    },

    /* Both, in one tap: read the card, make the pieces, write them. */
    cardAdd: function (link, opts) {
      var o = opts || {};
      try { cardPinHex(o.pin); } catch (e) { return Promise.reject(e); }
      return cardLook(link).then(function (card) {
        return FoxyWallet.cardPrepare(card, o.sats);
      }).then(function () {
        return FoxyWallet.cardWrite(link, { pin: o.pin });
      });
    },

    /* What is waiting to be written onto cards: [{ id, card, sats, kind }]. */
    cardOwed: function () {
      return cardStore(CARD_OWED).map(function (r) { return { id: r.id, card: r.card, sats: r.sats, kind: r.kind, forHash: r.forHash || '' }; });
    },

    /* ---- money off a card --------------------------------------------------
     *
     * `cardPay` is a receiver being paid `sats` by a card whose holder types
     * its PIN here. `cardWithdraw` is a holder emptying their own card, or
     * part of it, into this phone. They are one flow:
     *
     *   1. read the card, and refuse here, with nothing signed, anything that
     *      can be known already: another mint, too little, a card to renew,
     *      more than its limit allows, no route to the mint;
     *   2. the PIN, and the card signs for the pieces chosen. From here the
     *      card has marked them spent;
     *   3. the signed pieces are written down (TAKEN), then swapped at the
     *      mint by the ordinary receive, which is where this phone's own
     *      pieces come from and where the payment becomes true;
     *   4. change: what the pieces were worth over the amount is made into
     *      pieces locked to the card again and written back while it is still
     *      there, or left owed to it.
     *
     * `opts.on(step)` is told 'reading', 'signing', 'mint', 'change', 'done',
     * for the screen. Resolves { sats, hash, change: { sats, written } }. */
    cardPay: function (link, opts) { return cardTake(link, opts || {}, 'card'); },
    cardWithdraw: function (link, opts) { return cardTake(link, Object.assign({ all: !(opts && opts.sats) }, opts || {}), 'from card'); },

    /* Signed pieces the mint has not answered for yet: [{ id, sats, card }]. */
    cardTaken: function () {
      return cardStore(CARD_TAKEN).map(function (r) { return { id: r.id, sats: r.sats, card: r.card }; });
    },

    /* Ask the mint again about each. Resolves [{ id, state: 'paid' | 'spent' | 'waiting', sats }]. */
    cardSettle: function () {
      var out = [];
      return cardStore(CARD_TAKEN).reduce(function (chain, row) {
        return chain.then(function () {
          return cardSwapTaken(row, true).then(function (r) { out.push({ id: row.id, state: 'paid', sats: r.sats }); },
            function (e) { out.push({ id: row.id, state: (e && e.card === 'spent') ? 'spent' : 'waiting', sats: 0 }); });
        });
      }, Promise.resolve()).then(function () { return out; });
    },

