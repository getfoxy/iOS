
    /* ---- a card that holds ecash (08a-flashcard.js) --------------------- */

    /* The pure parts, for the screens and the tests. */
    cardSecret: function (nonce, cardKey, date, refundKey) { return cardSecret(nonce, cardKey, date, refundKey); },
    cardParse: { info: cardInfoOf, record: cardRecordOf, slot: cardSlotOf, piece: cardPieceBytes, proof: cardProofOf },

