
    /* ---- a card that holds ecash (08a-flashcard.js) --------------------- */

    /* The pure parts, for the screens and the tests. */
    cardSecret: function (nonce, cardKey, date, refundKey) { return cardSecret(nonce, cardKey, date, refundKey); },
    cardParse: { info: cardInfoOf, record: cardRecordOf, slot: cardSlotOf, piece: cardPieceBytes, proof: cardProofOf },

    /* What a card says with no PIN (`cardLook`). Rejects with `card` on the
     * error naming why: not-a-card, gone. */
    cardLook: function (link) {
      return cardLook(link).then(function (card) {
        // a card this phone can take back: what is on it now is written down for the day it is lost
        var mine = cardsOnFile()[card.key];
        if (mine && mine.refundKey && mine.refundKey === card.record.refundKey) cardRemember(card, card.pieces, true);
        return card;
      });
    },

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

    /* The same, for a screen: what each held when last seen, and when it can
     * be taken back. Newest first. */
    cardsList: function () {
      var all = cardsOnFile();
      var now = Math.floor(Date.now() / 1000);
      return Object.keys(all).map(function (key) {
        var row = all[key] || {};
        var pieces = row.pieces && typeof row.pieces === 'object' ? row.pieces : {};
        var sats = 0, first = 0, last = 0;
        Object.keys(pieces).forEach(function (n) {
          var x = pieces[n];
          // off the card when this phone last read it; kept on file only for the taking back
          if (!x || x.gone) return;
          sats += satsOf(x.amount);
          if (x.date) { first = first ? Math.min(first, x.date) : x.date; last = Math.max(last, x.date); }
        });
        return { key: key, mint: row.mint || '', at: row.at || 0, seen: row.seen || 0, sats: sats,
                 date: last, due: !!first && first <= now, takenBack: row.takenBack || 0 };
      }).sort(function (a, b) { return (b.seen || b.at) - (a.seen || a.at); });
    },

    /* A lost or blocked card's money, taken back with no card.
     *
     * Every piece this phone knew to be on the card names this phone's key as
     * the one that may spend it once its date has passed. So: the pieces
     * whose date has passed, asked of the mint, and those still unspent are
     * signed with that key (the phone derives it from its words) and swapped
     * in like any signed piece. What the card was given by somebody else
     * after this phone last read it (a receiver's change) is not known here
     * and is not taken back.
     *
     * Resolves { sats, hash, later }: `later` is what is not due yet.
     * Rejects with `card`: unknown, other-mint, no-route, too-soon. */
    cardTakeBack: function (cardKey) {
      var row = cardsOnFile()[cardKey];
      if (!row || !row.refundKey || !(row.refundIndex >= 0)) return Promise.reject(cardError('unknown', 'This phone cannot take that card back: it did not set it up.'));
      var w;
      try { w = need(); } catch (e) { return Promise.reject(e); }
      if (canonicalMint(row.mint) !== mintOf(w)) {
        return Promise.reject(cardError('other-mint', 'That card\u2019s money is at ' + hostOf(row.mint) + '. Switch to it first.', { mint: canonicalMint(row.mint) }));
      }
      if (!routeOpen()) return Promise.reject(cardError('no-route', 'There is no connection to the mint.'));
      var now = Math.floor(Date.now() / 1000);
      var pieces = row.pieces && typeof row.pieces === 'object' ? row.pieces : {};
      var due = [], later = 0, soonest = 0;
      Object.keys(pieces).forEach(function (nonce) {
        var x = pieces[nonce];
        if (!x || !x.date) return;
        if (x.date > now) {
          if (!x.gone) { later += satsOf(x.amount); soonest = soonest ? Math.min(soonest, x.date) : x.date; }
          return;
        }
        try {
          due.push({ id: x.keyset, amount: x.amount, C: x.C, secret: cardSecret(nonce, cardKey, x.date, row.refundKey) });
        } catch (e) {}
      });
      if (!due.length) {
        return Promise.reject(later > 0
          ? cardError('too-soon', 'That card can be taken back after its date.', { date: soonest, sats: later })
          : cardError('nothing', 'Nothing is known to be left on that card.'));
      }
      var CT = window.CashuTS;
      var asking = onCircuit(w, 'card:' + cardKey.slice(-16));
      return withTimeout(Promise.resolve().then(function () { return asking.checkProofsStates(due); }), 30000, 'the mint\u2019s word on a card\u2019s pieces')
        .then(function (states) {
          var live = due.filter(function (pr, i) {
            var st = (states && states[i]) || {};
            return String(st.state || st.State || '').toUpperCase() === 'UNSPENT';
          });
          if (!live.length) return { sats: 0, hash: '', later: later };
          return nativeJson('p2pkKey', { index: row.refundIndex }, 60000).then(function (j) {
            var key = String((j && j.privkey) || '').toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(key) || String((j && j.pubkey) || '').toLowerCase() !== row.refundKey) {
              throw cardError('no-key', 'This phone\u2019s words do not give the key that card was set up with.');
            }
            var signed = CT.signP2PKProofs(live, key);
            var bad = signed.filter(function (pr) { try { return !CT.isP2PKSpendAuthorised(pr); } catch (e) { return true; } });
            if (bad.length) throw cardError('too-soon', 'The mint would not take this phone\u2019s key for that card yet.');
            var taken = { id: 'cardback-' + piecesFingerprint(signed), token: CT.getEncodedToken({ mint: mintOf(w), proofs: signed, unit: 'sat' }),
                          sats: 0, worth: sumProofs(signed), over: 0, all: true, card: cardKey, memo: 'from card', at: Date.now() };
            mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).concat([taken]));
            return cardSwapTaken(taken).then(function (got) {
              var all = cardsOnFile();
              if (all[cardKey]) { all[cardKey].takenBack = Date.now(); save(CARDS, all); }
              console.log('[foxy] card: ' + got.sats + ' sats taken back from a card with this phone\u2019s own key');
              return { sats: got.sats, hash: taken.id, later: later };
            });
          });
        });
    },

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
        if (card.record.refundKey && cardsOnFile()[card.key]) cardRemember(card, card.pieces, true);
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

    /* A card's money given a new date, in one tap: all of it off the card and
     * on again. The pieces that come back carry a date a year from now, which
     * is the only way a piece's date changes: it is part of the piece. At a
     * mint that charges for inputs this costs what a withdrawal and a top-up
     * cost. A tap cut short between the two leaves the money in this phone
     * and the pieces for the card owed to it, as with any top-up.
     * Resolves { sats, left, card } as `cardWrite` does. */
    cardRenew: function (link, opts) {
      var o = opts || {};
      var hashes = [];
      var failed = function (e) { if (e && typeof e === 'object') e.hashes = hashes; throw e; };
      return FoxyWallet.cardWithdraw(link, { pin: o.pin, on: o.on }).then(function (got) {
        hashes.push(got.hash);
        if (typeof o.on === 'function') { try { o.on('writing'); } catch (e) {} }
        return cardLook(link).then(function (card) { return FoxyWallet.cardPrepare(card, got.sats); });
      }).then(function (made) {
        hashes.push(made.hash);
        return FoxyWallet.cardWrite(link, { pin: o.pin });
      }).then(function (r) { return Object.assign({ hashes: hashes }, r); }, failed);
    },

    /* The mint's word on the pieces a card shows as unspent. A card is a
     * list of pieces and a promise not to sign twice; a copy of it, or a card
     * whose money was taken back, lists pieces the mint has already seen
     * spent. Resolves { sats, spent }: what the card says it holds, and how
     * much of that the mint says is gone. Rejects `other-mint`, `no-route`. */
    cardCheck: function (card) {
      var w;
      try { w = need(); } catch (e) { return Promise.reject(e); }
      if (!card || !card.pieces || !card.pieces.length) return Promise.resolve({ sats: 0, spent: 0 });
      if (canonicalMint(card.record.mint) !== mintOf(w)) {
        return Promise.reject(cardError('other-mint', 'This card\u2019s money is at ' + hostOf(card.record.mint) + '.', { mint: canonicalMint(card.record.mint) }));
      }
      if (!routeOpen()) return Promise.reject(cardError('no-route', 'There is no connection to the mint.'));
      var proofs = card.pieces.map(function (x) { return cardProofOf(x, card.key, card.record.refundKey); });
      var asking = onCircuit(w, 'card:' + card.key.slice(-16));
      return withTimeout(Promise.resolve().then(function () { return asking.checkProofsStates(proofs); }), 30000, 'the mint\u2019s word on a card\u2019s pieces')
        .then(function (states) {
          var spent = 0;
          proofs.forEach(function (pr, i) {
            var st = (states && states[i]) || {};
            if (String(st.state || st.State || '').toUpperCase() === 'SPENT') spent += satsOf(pr.amount);
          });
          return { sats: card.balance, spent: spent };
        }, function () { throw cardError('no-route', 'The mint did not answer.'); });
    },

    /* Whether this phone is the one that can take this card back. */
    cardIsMine: function (card) { return !!(card && card.key && card.record && cardMine(card)); },

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

    /* ---- a tap ------------------------------------------------------------
     *
     * One tap of a card on this phone: iOS's NFC session, opened with a line
     * of text for its sheet, and a `link` the functions above talk through
     * while it is open (Foxy/Flashcard/CardLink.swift). `fn(link)` is what to
     * do with the card; when it settles, the sheet is closed with a word of
     * how it went, and its result or its error is this call's.
     *
     * `link.say(text)` changes the sheet's line as the tap goes on. The PIN
     * is not this function's business: whoever calls has it, passes it to the
     * card through the functions above, and lets go of it.
     *
     * Rejects with `card: 'cancelled'` when the sheet was dismissed or timed
     * out with no card, and `card: 'no-nfc'` on a phone that cannot read one.
     *
     * `cardStop` takes the sheet down from the page's side: a session waiting
     * for a card then ends as cancelled, and one in the middle of a card as
     * the card having gone. */
    cardStop: function () { return bridgeAsk('cardEnd', { error: 'Cancelled' }, 5000).then(null, function () {}); },

    cardSession: function (text, fn) {
      var link = {
        send: function (apdu) { return bridgeAsk('cardSend', { apdu: String(apdu) }, 15000); },
        say: function (line) { return bridgeAsk('cardSay', { text: String(line || '') }, 5000).then(null, function () {}); },
      };
      return bridgeAsk('cardBegin', { text: String(text || 'Hold the card to the top of the phone') }, 70000).then(function () {
        return Promise.resolve().then(function () { return fn(link); }).then(function (r) {
          return bridgeAsk('cardEnd', { text: 'Done' }, 5000).then(function () { return r; }, function () { return r; });
        }, function (e) {
          var say = (e && e.card === 'gone') ? 'The card was taken away too soon' : String((e && e.message) || 'That did not work').slice(0, 90);
          return bridgeAsk('cardEnd', { error: say }, 5000).then(function () { throw e; }, function () { throw e; });
        });
      }, function (e) {
        var why = String((e && e.message) || '');
        if (/not available|cannot read|no nfc/i.test(why)) throw cardError('no-nfc', 'This phone cannot read a card.');
        throw cardError('cancelled', /timed out|did not answer/i.test(why) ? 'No card was tapped.' : 'The card was not tapped.');
      });
    },

