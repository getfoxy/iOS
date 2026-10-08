
    /* ---- a card that holds ecash (08a-flashcard.js) --------------------- */

    /* The pure parts, for the screens and the tests. */
    cardSecret: function (nonce, cardKey, date, refundKey) { return cardSecret(nonce, cardKey, date, refundKey); },
    cardParse: { info: cardInfoOf, record: cardRecordOf, slot: cardSlotOf, page: cardPageOf, piece: cardPieceBytes, proof: cardProofOf, shortId: cardShortId, day: cardDayOf },
    /* The key a card's time is checked against, which set-up writes (INTERIM: see 08a-flashcard.js). */
    cardTimeKey: CARD_TIME_KEY,
    cardPick: function (w, have, want, cap) { return cardPick(w, have, want, cap); },
    cardExactPick: function (w, have, want, cap) { return cardExactPick(w, have, want, cap); },
    /* What goes onto a card is cut like a cash drawer, to fill the gaps in what it holds (08a-flashcard.js). */
    cardLadder: function (sats, most, biggest, have, plain) { return cardLadder(sats, most, biggest, have, plain); },
    /* What a card holds, as the amounts of its pieces, for cutting more for it. */
    cardHeld: function (card, except) { return cardHeldAmounts(card, except); },
    cardMaxPiece: function () { try { return cardMaxPiece(need()); } catch (e) { return 0; } },
    /* A till with no route: whether a card may be taken on trust at all (the card's own switch), whether this
     * phone has a route, and the question put to the person first. */
    cardOffline: function (on) { return cardOffline(on); },
    cardOnline: function () { return routeOpen(); },
    cardOfflineAsk: function (sats) { return cardOfflineAsk(sats); },

    /* What a card says with no PIN (`cardLook`), after telling it the time.
     * `opts.mine`: also whether this phone is its owner (`card.mine`), for a
     * holder's own screen. Rejects with `card` on the error naming why:
     * not-a-card, wrong-signer, gone. */
    cardLook: function (link, opts) {
      return cardLook(link, opts).then(function (card) {
        // a card this phone can take back: what is on it now is written down for the day it is lost
        var mine = cardsOnFile()[card.key];
        if (mine && mine.refundKey && mine.refundKey === card.record.refundKey) cardRemember(card, card.pieces, true);
        // anything this phone made for this card and lost track of is found again here (`cardAdopt`)
        try { cardAdopt(card); } catch (e) { console.warn('[foxy] card: looking for ecash made for this card failed:', (e && e.message) || e); }
        return card;
      });
    },

    /* A new card made this phone's: a PIN, the record that says which mint its
     * money is at and who may take it back (with the key its time is signed by),
     * and, last, this phone as its owner. One tap. No limit is set: a new card
     * has none, and one is set later from CHANGE LIMIT.
     *
     * The card is open until it has an owner: while it has none it takes a PIN
     * and a record from anybody, and cannot be loaded. So the owner is given
     * last, and nothing before it needs a proof. A set-up cut off anywhere is
     * finished by the next, because every step is allowed again on a card that
     * still has no owner. The owner's public key is what native makes for this
     * card from the seed (`cardOwnerKey`); the private key never leaves it.
     *
     * `recoverable`: a key from this phone's words is written to the card, and
     * every piece loaded later names it, so a lost or blocked card's money
     * comes back to these words after the piece's date. Without it the card is
     * cash. The key is on file here before the card is told it, and the card
     * is told once: its record cannot change while it holds money. */
    cardSetUp: function (link, opts) {
      var o = opts || {};
      var pin;
      try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); }
      var w;
      try { w = need(); } catch (e2) { return Promise.reject(e2); }
      var mint = mintOf(w);
      if (!mint || mint.length > CARD_MINT_MAX || /[^\x20-\x7e]/.test(mint)) {
        return Promise.reject(cardError('bad-mint', 'This mint\u2019s address is too long for a card.'));
      }
      var t = cardTalk(link);
      var card, ownerPub;
      return cardLook(link).then(function (c) {
        card = c;
        if (card.info.locked) throw cardRefused('6986');
        /* A card with an owner is not open, set up or not: it is its owner's, and
         * only that owner's proof changes it. */
        if (card.info.owner) throw cardError('set-up', 'This card already belongs to a Foxy. Only that Foxy, or one restored from its seed phrase, can set it up again.');
        return cardOwnerPub(card.key);
      }).then(function (pub) {
        ownerPub = pub;
        return o.recoverable ? cardRefundKey(card.key) : '';
      }).then(function (refund) {
        if (o.recoverable && !refund) throw cardError('no-key', 'This phone could not make the key that would bring a lost card\u2019s money back. Try again in a moment.');
        var record = cardRecordHex(refund, mint);
        return t.want(cardCommand(CARD_INS.setPin, 0, pin), 'its new PIN').then(function () {
          return t.want(cardCommand(CARD_INS.verify, 0, pin), 'its PIN');
        }).then(function () {
          return t.want(cardCommand(CARD_INS.setCard, 0, record), 'its record');
        }).then(function () {
          return t.want(cardCommand(CARD_INS.setOwner, 0, ownerPub), 'its owner');
        });
      }).then(function () {
        console.log('[foxy] card: a new card is set up at ' + hostOf(mint) + (o.recoverable ? ', recoverable' : ', as cash') + ', with no limit');
        return cardLook(link, { mine: true });
      });
    },

    /* The PIN changed by the card's owner: this phone's proof over the new PIN,
     * and nothing else. The old PIN is not asked for, because this phone does
     * not know it and the cards that most need this are the blocked and the
     * forgotten. It sets the new PIN, gives the tries back and unblocks a blocked
     * card. A phone that does not hold the words the card was set up with is
     * refused with `not-owner`, which costs no try and changes nothing. */
    cardChangePin: function (link, opts) {
      var o = opts || {};
      var newPin;
      try { newPin = cardPinHex(o.newPin); } catch (e) { return Promise.reject(e); }
      var t = cardTalk(link);
      var key;
      return cardLook(link).then(function (card) {
        // said before anything is signed: nothing here can change a card that has no owner
        if (!card.info.owner) throw cardRefused('6a90');
        if (card.info.locked) throw cardRefused('6986');
        key = card.key;
        return cardOwned(t, key, 'change-pin', newPin);
      }).then(function (data) {
        return t.want(cardCommand(CARD_INS.changePin, 0, data), 'its new PIN');
      }).then(function () { return true; });
    },

    /* The card's daily limit: the most it signs for in one day, in sats, set to
     * `sats` (zero removes it). The owner's proof and no PIN: only a phone that
     * holds the words the card was set up with can, and it does not need to know
     * the PIN. A limit starts a new day at the card's clock, so the card has
     * been told the time first (`cardLook` does it). */
    cardSetLimit: function (link, opts) {
      var o = opts || {};
      var sats = Math.round(Number(o.sats));
      if (!(sats >= 0 && sats <= 4294967295)) return Promise.reject(cardError('bad-limit', 'That is not a limit a card can hold.'));
      var t = cardTalk(link);
      var key;
      return cardLook(link).then(function (card) {
        if (!card.info.owner) throw cardRefused('6a90');
        if (card.info.locked) throw cardRefused('6986');
        key = card.key;
        return cardLimitTo(t, key, sats);
      }).then(function () {
        /* What the owner has just chosen is the limit now. A note of a limit
         * lifted for a withdrawal and not put back is older than this, and the
         * read below would act on it: a card told NO LIMIT on purpose would be
         * given the old limit back in the same tap. */
        cardLiftNote(key, 0);
        return cardLook(link, { mine: true });
      });
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
          // of a keyset this mint no longer lists, a piece is asked about by the eight bytes there are
          due.push({ id: cardFullId(w, x.keyset) || x.keyset, amount: x.amount, C: x.C, secret: cardSecret(nonce, cardKey, x.date, row.refundKey) });
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
    cardPrepare: function (card, sats, opts) {
      /* `opts.moving`: the card is still at another mint and is on its way to
       * this one (`cardMoveLoad`). The pieces are made here, and their row
       * says so, so that the card is told its new mint before they are
       * written (`cardRepointFor`). */
      var moving = !!(opts && opts.moving);
      var want = Math.round(Number(sats));
      if (!(want > 0)) return Promise.reject(cardError('bad-amount', 'Ask for an amount above zero.'));
      var w;
      try { w = need(); } catch (e) { return Promise.reject(e); }
      var no = cardUnusable(card, w);
      if (no && no.card !== 'empty' && !(moving && no.card === 'other-mint')) return Promise.reject(no);
      if (card.info.pin !== 'set' || !card.info.hasRecord) return Promise.reject(cardError('no-record', 'Set this card up first.'));
      if (card.info.locked) return Promise.reject(cardRefused('6986'));
      /* A card with no owner cannot be loaded: nobody could change its PIN or its
       * limit, and a terminal that had the PIN could never be bounded or
       * corrected. Said before any money is made for it. */
      if (!card.info.owner) return Promise.reject(cardError('no-owner', 'This card has no owner, so it cannot be loaded.'));
      /* The amount is cut like a cash drawer, to fill the gaps in what the card
       * holds (and has owed to it): the small rungs a few deep for paying small
       * amounts offline with exact change, the big value in a handful of large
       * proofs, and no more than CARD_LOAD_PIECES pieces (about half the card's
       * places), so the rest stay free for an online payment's change. An amount
       * that needs more has a shallower drawer, and is rounded up only where even
       * that is too many; `rounded` says by how much. A few more places are kept
       * for what the mint's fee may add. */
      var ladder = cardLadder(want, cardRoomFor(card, null, CARD_CHANGE_ROOM), cardMaxPiece(w), cardHeldAmounts(card));
      var room = card.info.empty + card.info.spent;
      if (ladder.denominations.length + 4 > room) return Promise.reject(cardError('full', 'The card has no room for that. Take some money off it first.'));
      /* Whether this mint's ecash fits a card, asked before any is made. It
       * was asked after: the pieces were made, locked to the card, found not
       * to fit, and the error left them filed nowhere. */
      var misfit = cardMintMisfit(w);
      if (misfit) return Promise.reject(misfit);
      var recoverable = !!card.record.refundKey;
      var date = recoverable ? Math.floor(Date.now() / 1000) + CARD_DATE_AHEAD : 0;
      return FoxyWallet.sendToken(ladder.sats, { unit: 'sat', lockTo: card.key, lockUntil: date || undefined,
                                                 refundTo: recoverable ? card.record.refundKey : undefined,
                                                 denominations: ladder.denominations, purpose: 'card' })
        .then(function (made) {
          /* Filed first, whatever else is true of it. From this line the
           * pieces exist, only this card can spend them, and this row is how
           * they reach it: nothing that can throw comes before it. */
          var row = /** @type {any} */ ({ id: made.hash, card: card.key, token: made.token, sats: made.sats, kind: 'load', forHash: made.hash, at: Date.now() });
          if (moving) { row.mint = mintOf(w); row.repoint = true; }
          mustSave(CARD_OWED, cardStore(CARD_OWED).concat([row]));
          try { amendTx(made.hash, { memo: 'to card', card: card.key }); } catch (x) {}
          try { FoxyWallet.tag(made.hash, { to: 'card' }); } catch (x2) {}
          // what the token must be for the card to take it. Not so, it stays owed, and the error says that it is kept
          try { cardPiecesOf(made.token, card); } catch (e) {
            throw cardError('misfit-kept', String((e && e.message) || 'That ecash does not fit this card.')
              + ' It is kept for the card: nothing is lost, and it cannot be written yet.', { sats: made.sats, hash: made.hash });
          }
          if (recoverable) cardRemember(card, cardPiecesOf(made.token, card));
          console.log('[foxy] card: ' + made.sats + ' sats made for a card, in ' + cardPiecesOf(made.token, card).length + ' pieces'
            + (ladder.extra ? ' (' + ladder.extra + ' more than asked, so there are fewer)' : '') + '; to be written at the next tap');
          return { id: row.id, sats: made.sats, hash: made.hash, rounded: ladder.extra, pieces: cardPiecesOf(made.token, card).length };
        });
    },

    /* A tap: everything owed to this card is written onto it. Resolves
     * { card, sats, left } with the card as it now reads.
     *
     * Three ways to be allowed to, and one of them is asked for:
     *   `owner: true`  this phone's own proof that it owns the card lets this tap
     *                  load with no PIN (the card's grant): the PIN is never
     *                  asked for, and never known to this phone after set-up. A
     *                  phone that is not the owner is refused, with everything
     *                  still owed to the card;
     *   `change: true` the tap after a payment: the card lets pieces on with no
     *                  PIN then, once, for the change (`card.info.changeDue`,
     *                  which it says of this tap). A card that does not is
     *                  refused ('pin-needed'), with everything still owed, and
     *                  the PIN is asked for;
     *   `pin`          the card's PIN is typed, as a till's is.
     * The card's day is not touched any way: loading gives it nothing back. */
    cardWrite: function (link, opts) {
      var o = opts || {};
      var pin = '';
      if (!o.owner && !o.change) {
        try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); }
      }
      var t = cardTalk(link);
      var wrote;
      return cardLook(link).then(function (card) {
        if (card.info.pin === 'blocked') throw cardRefused('6983');
        if (o.owner && !card.info.owner) throw cardRefused('6a90');
        // not the tap after a payment after all (a read came between, say): the PIN is what writes
        if (o.change && !o.owner && !card.info.changeDue) throw cardRefused('6982');
        // what was found for this card is asked of the mint before any of it is written
        return cardOwedPrune(card).then(null, function () { return 0; }).then(function () {
          if (o.change && !o.owner) return null;
          if (!o.owner) return t.want(cardCommand(CARD_INS.verify, 0, pin), 'its PIN');
          return cardGrant(t, card.key).then(function (yes) {
            if (!yes) throw cardRefused('6a91');
          });
        }).then(function () {
          return cardRepointFor(t, card);
        }).then(function () { return cardWriteOwed(t, card, o.progress); });
      }).then(function (r) {
        wrote = r;
        return cardLook(link, { mine: !!o.owner });
      }).then(function (card) {
        if (card.record.refundKey && cardsOnFile()[card.key]) cardRemember(card, card.pieces, true);
        return { card: card, sats: wrote.sats, back: wrote.back || 0, change: wrote.change || 0, refund: wrote.refund || 0,
                 left: wrote.left.length, why: wrote.why || '' };
      });
    },

    /* Both, in one tap: read the card, make the pieces, write them (`opts.owner`
     * or `opts.pin`, as `cardWrite`). */
    cardAdd: function (link, opts) {
      var o = opts || {};
      if (!o.owner) { try { cardPinHex(o.pin); } catch (e) { return Promise.reject(e); } }
      return cardLook(link).then(function (card) {
        return FoxyWallet.cardPrepare(card, o.sats);
      }).then(function () {
        return FoxyWallet.cardWrite(link, { owner: !!o.owner, pin: o.pin });
      });
    },

    /* ---- a card moved to another mint ----------------------------------------
     *
     * A card's money is at one mint, the one its record names. Moving the
     * card is moving the money: off the card into this phone (`cardWithdraw`,
     * a tap), across by Lightning as any move between this phone's mints
     * goes (`moveRun`, no card needed), and back on at the far mint, where
     * the card is told its new mint and then written (`cardWrite`, a second
     * tap). Three things here are the card's: how much of what came off it
     * can cross, what is put back on, and a card with nothing on it. */

    /* A plan for moving `sats` that came off a card, paid for by those sats
     * alone. An ordinary move asks for an amount to land and takes its fee on
     * top, out of whatever else is at that mint. A card's money pays its own
     * way: the amount is taken down until what leaves is no more than what
     * came off the card, and what is left over is a few sats in this phone at
     * the mint it left. Resolves a plan for `moveRun`; `plan.net` lands.
     *
     * `opts.quoteOnly` asks before the card is touched, for the figure a
     * person agrees to: `sats` is then the card's balance and `opts.pieces`
     * how many pieces that is, and the plan's `gross` is what will have left
     * the card by the end, the swap that takes it off included. */
    cardMoveQuote: function (fromUrl, toUrl, sats, opts) {
      var have = Math.round(Number(sats) || 0);
      var tries = 0;
      var ask = function (n) {
        if (!(n > 0)) return Promise.reject(cardError('too-little', 'That is too little to move by Lightning: the fee would take it all.'));
        return FoxyWallet.transferQuote(fromUrl, n, Object.assign({ to: toUrl }, opts || {})).then(function (plan) {
          // asked before the card is touched, what leaves is worked out as it will be (`cardMoveAhead`)
          if (opts && opts.quoteOnly) plan.gross = cardMoveAhead(String(fromUrl || '').replace(/\/+$/, ''), have, opts.pieces, plan);
          var over = plan.gross - have;
          if (!(over > 0)) return plan;
          if (tries >= 6) throw cardError('too-little', 'That is too little to move by Lightning: the fee would take it all.');
          tries += 1;
          return ask(n - over);
        }, function (e) {
          var fits = Number(e && e.foxyFits);
          if (!(e && e.foxyFits !== undefined) || tries >= 6) throw e;
          tries += 1;
          return ask(Math.min(Math.max(0, fits), n - 1));
        });
      };
      return ask(have);
    },

    /* What landed at this mint for a card, made into pieces for it and owed
     * to it, less what the pieces cost to make here. Called at the far mint,
     * after the move. Resolves as `cardPrepare`. */
    cardMoveLoad: function (card, landed) {
      var w;
      try { w = need(); } catch (e) { return Promise.reject(e); }
      var back = changeFromPile(w, Math.round(Number(landed) || 0));
      if (!(back > 0)) {
        return Promise.reject(cardError('too-little', 'What arrived is too little to put on a card. It is in this phone, at ' + hostOf(mintOf(w)) + '.'));
      }
      return FoxyWallet.cardPrepare(card, back, { moving: true });
    },

    /* A card with nothing on it, told it is at this phone's mint, by its owner:
     * the owner's proof, no PIN. One tap. */
    cardRepoint: function (link) {
      var w;
      try { w = need(); } catch (e2) { return Promise.reject(e2); }
      var here = mintOf(w);
      var t = cardTalk(link);
      return cardLook(link).then(function (card) {
        if (card.info.pin === 'blocked') throw cardRefused('6983');
        if (card.info.pin !== 'set' || !card.info.hasRecord) throw cardError('no-record', 'Set this card up first.');
        if (canonicalMint(card.record.mint) === here) return null;
        if (card.pieces.length) throw cardError('in-use', 'This card still holds money at ' + hostOf(card.record.mint) + '. Take that off it first.');
        if (!card.info.owner) throw cardRefused('6a90');
        var record = cardRecordHex(card.record.refundKey, here, card.record.timeKey);
        return cardOwned(t, card.key, 'set-card', record).then(function (data) {
          return t.want(cardCommand(CARD_INS.setCard, 0, data), 'its new mint');
        }).then(function () {
          console.log('[foxy] card: an empty card moved from ' + hostOf(card.record.mint) + ' to ' + hostOf(here));
        });
      }).then(function () { return FoxyWallet.cardLook(link); });
    },

    /* What is waiting to be written onto cards: [{ id, card, sats, kind, mint }]. */
    cardOwed: function () {
      return cardStore(CARD_OWED).map(function (r) {
        var at = r.mint || '';
        if (!at) { try { at = (FoxyWallet.tokenInfo(r.token) || {}).mint || ''; } catch (e) { at = ''; } }
        return { id: r.id, card: r.card, sats: r.sats, kind: r.kind, forHash: r.forHash || '', mint: at ? canonicalMint(at) : '' };
      });
    },

    /* ---- money off a card --------------------------------------------------
     *
     * `cardPay` is a receiver being paid `sats` by a card whose holder types
     * its PIN here. `cardWithdraw` is a holder emptying their own card, or
     * part of it, into this phone. They are one flow:
     *
     *   1. read the card, and refuse here, with nothing signed, anything that
     *      can be known already: another mint, too little, a card to renew,
     *      more than the card's limit has left (a till: the holder's own phone
     *      raises it, with the owner's proof), no route to the mint;
     *   2. the PIN, and the card signs for the pieces chosen. From here the
     *      card has marked them spent;
     *   3. the signed pieces are written down (TAKEN), and the card is let go
     *      (its sheet ends, "Done. Remove the card."): its part is over. Foxy's
     *      own screen goes on saying it is checking with the mint;
     *   4. the pieces are swapped at the mint by the ordinary receive, with no
     *      question first (the swap refuses spent pieces itself), which is where
     *      this phone's own pieces come from and where the payment becomes true.
     *      If the mint refuses, whatever of the pieces is still good is owed back
     *      to the card and the next tap puts it there (`putback`); if it does not
     *      answer, the swap record and the row wait for the wallet's own recovery;
     *   5. change: what the pieces were worth over the amount is made into
     *      pieces locked to the card again, cut to fill the gaps in what it holds,
     *      and left owed to it for its next tap.
     *
     * `opts.hold` keeps the card in the field instead (a renewal writes to it
     * next, a move reads it last): then the mint is asked with the card still
     * there, and change is written back in the same tap if it stays.
     *
     * `opts.on(step)` is told 'reading', 'signing', 'checking' (the card has been
     * let go), 'making' (the change), 'done' for the screen; with `hold`, 'mint'
     * and 'change' for the same. Resolves { sats, hash, change: { sats, written } }. */
    cardPay: function (link, opts) { return cardTake(link, opts || {}, 'card'); },
    /* A withdrawal that holds the card (`opts.hold`) ends by reading it once
     * more, for its holder's screen (`card` on the result). Only this one: a
     * till being paid learns no more of a card than it needs. A card that has
     * left by then is no failure: the money moved, and the result simply has no
     * card on it. One that was let go when it had signed is not read again. */
    cardWithdraw: function (link, opts) {
      // the holder's own: where this phone is the card's owner, the day's limit is lifted, with its proof, for the taking, and put back
      return cardTake(link, Object.assign({ all: !(opts && opts.sats), lift: true }, opts || {}), 'from card').then(function (r) {
        // the card has been let go once it signed (`opts.hold` keeps it), and is not read again: the next tap shows it as it is
        if (!(opts && opts.hold)) return r;
        return FoxyWallet.cardLook(link, { mine: true }).then(function (card) { r.card = card; return r; }, function () { return r; });
      });
    },

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
      // the card is held for all of it: it is written to as soon as it is empty
      return FoxyWallet.cardWithdraw(link, { pin: o.pin, on: o.on, progress: o.progress, hold: true }).then(function (got) {
        hashes.push(got.hash);
        if (typeof o.on === 'function') { try { o.on('writing'); } catch (e) {} }
        return cardLook(link).then(function (card) { return FoxyWallet.cardPrepare(card, got.sats); });
      }).then(function (made) {
        hashes.push(made.hash);
        // the limit was put back when the money came off, and what it was signed for then is no more than that day's
        return FoxyWallet.cardWrite(link, { pin: o.pin, progress: o.progress });
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
      var proofs = card.pieces.map(function (x) { return cardProofOf(x, card.key, card.record.refundKey, cardFullId(w, x.keyset)); });
      var asking = onCircuit(w, 'card:' + card.key.slice(-16));
      return withTimeout(Promise.resolve().then(function () { return asking.checkProofsStates(proofs); }), 30000, 'the mint\u2019s word on a card\u2019s pieces')
        .then(function (states) {
          var spent = 0;
          proofs.forEach(function (pr, i) {
            var st = (states && states[i]) || {};
            if (String(st.state || st.State || '').toUpperCase() === 'SPENT') spent += satsOf(pr.amount);
          });
          // every piece good: written down with the time, for a phone that later has no connection to ask again
          return { sats: card.balance, spent: spent, at: spent > 0 ? 0 : cardCheckedNote(card) };
        }, function () { throw cardError('no-route', 'The mint did not answer.'); });
    },

    /* When this phone last had the mint's word that everything now on this
     * card was good, in milliseconds; nought when it never had (`cardCheck`
     * writes it down). */
    cardCheckedAt: function (card) { return cardCheckedAt(card); },

    /* Ecash found for this card (`cardAdopt`), asked of the mint: what was on
     * a card once and spent is struck off. Resolves how many rows went. */
    cardOwedCheck: function (card) { return cardOwedPrune(card); },

    /* Whether this phone is the one that can take this card back. */
    cardIsMine: function (card) { return !!(card && card.key && card.record && cardMine(card)); },

    /* Change due to cards that could not be made when they paid, made now
     * where it can be (`cardDueRetry`): [{ forHash, state, sats }]. */
    cardDueRetry: function () { return cardDueRetry(); },
    /* What is due: [{ forHash, card, sats }]. */
    cardDue: function () {
      return cardStore(CARD_DUE).map(function (d) { return { forHash: d.forHash, card: d.card, sats: Math.round(Number(d.owed) || 0) }; });
    },

    /* Signed pieces the mint has not answered for yet: [{ id, sats, card }]. */
    cardTaken: function () {
      return cardStore(CARD_TAKEN).map(function (r) { return { id: r.id, sats: r.sats, card: r.card }; });
    },

    /* Ask the mint again about each. Resolves [{ id, state: 'paid' | 'spent' | 'bad' | 'putback' | 'waiting', sats }];
     * `bad` is pieces the mint never signed, `putback` a refusal with some of the pieces
     * still good: they are owed back to the card (`owed`, and `limited` where its day
     * stays charged for them). */
    cardSettle: function () {
      var out = [];
      return cardStore(CARD_TAKEN).reduce(function (chain, row) {
        return chain.then(function () {
          /* Found paid: what it owes the card back (its over-payment, or all of a
           * refund) is made now, as the tap would have made it, and waits for the
           * card's next tap. Missing, a receiver whose answer was lost kept it. */
          return cardSwapTaken(row, true).then(function (r) {
            var w = null;
            try { w = need(); } catch (x) { w = null; }
            var owe = w ? cardOweBack(row, w, null, null, r) : Promise.resolve({ sats: 0 });
            return owe.then(function (o) {
              out.push({ id: row.id, state: 'paid', sats: r.sats, change: (o && o.sats) || 0, refund: !!row.refund });
            }, function () {
              out.push({ id: row.id, state: 'paid', sats: r.sats, change: 0, refund: !!row.refund });
            });
          },
            function (e) {
              var kind = e && e.card;
              out.push({ id: row.id, state: kind === 'spent' ? 'spent' : kind === 'bad-pieces' ? 'bad' : kind === 'putback' ? 'putback' : 'waiting', sats: 0,
                         owed: (e && e.owed) || 0, limited: !!(e && e.limited) });
            });
        });
      }, Promise.resolve()).then(function () { return out; });
    },

    /* What the phone's card link says is happening, pushed from Swift
     * (Foxy/Flashcard/CardLink.swift through FoxyBridge+Flashcard.swift):
     * { stage: 'connected' | 'say' | 'end' | 'lost', text }. The card screen
     * shows the same line the sheet does. */
    /** @type {?function(*): void} */
    _onCard: null,
    onCard: function (fn) { FoxyWallet._onCard = typeof fn === 'function' ? fn : null; },
    _card: function (ev) {
      var fn = FoxyWallet._onCard;
      if (typeof fn !== 'function' || !ev || typeof ev !== 'object') return;
      try { fn({ stage: String(ev.stage || ''), text: String(ev.text || '') }); } catch (e) { console.warn('[foxy] card progress watcher:', e && e.message); }
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

    cardSession: function (text, fn, opts) {
      var link = {
        released: false,
        send: function (apdu) {
          // once let go, nothing more is asked of the card; the sheet is gone
          if (link.released) return Promise.reject(new Error('the card was let go'));
          return bridgeAsk('cardSend', { apdu: String(apdu) }, 15000);
        },
        say: function (line) {
          if (link.released) return Promise.resolve();
          return bridgeAsk('cardSay', { text: String(line || '') }, 5000).then(null, function () {});
        },
        /* The card has done its part and the rest (the mint) needs no card: the
         * sheet ends now with its tick and a word, and what `fn` still has to do
         * goes on with no sheet. The end is not said twice. Resolves when the
         * phone has been told. */
        release: function (line) {
          if (link.released) return Promise.resolve();
          link.released = true;
          return bridgeAsk('cardEnd', { text: String(line || 'Done. Remove the card.') }, 5000).then(function () {}, function () {});
        },
      };
      /* A tap that goes on to the mint opens the road to it as the sheet opens
       * (`opts.warm`), while the card is found and read and signs: the swap that
       * comes after takes the circuit made ready, and is not the one that waits
       * for a new one (`warmMint`). */
      if (opts && opts.warm) { try { FoxyWallet.warmMint(); } catch (e) {} }
      return bridgeAsk('cardBegin', { text: String(text || 'Hold the card to the top of the phone') }, 70000).then(function () {
        return Promise.resolve().then(function () { return fn(link); }).then(function (r) {
          if (link.released) return r;
          return bridgeAsk('cardEnd', { text: 'Done. Remove the card.' }, 5000).then(function () { return r; }, function () { return r; });
        }, function (e) {
          // the sheet was ended when the card was let go, and has nothing to say about what came after
          if (link.released) throw e;
          var say = (e && e.card === 'gone') ? 'The card was taken away too soon' : String((e && e.message) || 'That did not work').slice(0, 90);
          return bridgeAsk('cardEnd', { error: say }, 5000).then(function () { throw e; }, function () { throw e; });
        });
      }, function (e) {
        var why = String((e && e.message) || '');
        if (/not available|cannot read|no nfc/i.test(why)) throw cardError('no-nfc', 'This phone cannot read a card.');
        throw cardError('cancelled', /timed out|did not answer/i.test(why) ? 'No card was tapped.' : 'The card was not tapped.');
      });
    },

