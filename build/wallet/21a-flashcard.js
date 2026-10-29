
    /* ---- a card that holds ecash (08a-flashcard.js) --------------------- */

    /* The pure parts, for the screens and the tests. */
    cardSecret: function (nonce, cardKey, date, refundKey, format) { return cardSecret(nonce, cardKey, date, refundKey, format); },
    cardParse: { info: cardInfoOf, record: cardRecordOf, slot: cardSlotOf, page: cardPageOf, short: cardShortOf, seal: cardSeal, pinBlock: cardPinBlock, piece: cardPieceBytes, proof: cardProofOf, shortId: cardShortId, day: cardDayOf,
                 noPin: cardNoPinOf, tap: cardTapOf, log: cardLogOf, receipts: cardReceiptsOf, header: headerParse,
                 // (1.23: GET_CARD P1 = 2, the table of keysets; GET_BALANCE P1 = 1, each unit's pieces and sum)
                 table: cardTableOf, balances: cardBalancesOf },
    /* The clock of a card of software 1.15 and on is the newest Bitcoin block header it has been shown, and this phone keeps
     * the newest it can get, from two block explorers over Tor (08b-block-headers.js). A tap uses what is kept and never
     * waits for the fetch. `headerKept` is { hex, time, hash, bits, at } or null; `headerRefresh` fetches if what is kept is
     * older than two minutes and there is a route (`opts.force`: regardless), and resolves { kept, fetched, why };
     * `headerShort` is a block hash as a line of text says it. `_headersOff` is for the suites: the fetches that happen on
     * their own (Tor up, the app back, a card tapped) are not made. */
    headerKept: function () { return headerKept(); },
    headerHeightOf: function (hash) { return headerHeightOf(hash); },
    headerRefresh: function (opts) { return headerRefresh(opts); },
    headerShort: function (hash) { return headerShort(hash); },
    _headersOff: false,
    // how long after Tor comes up, or the app comes back, the header is asked for, in ms (the suites set it short)
    _headerAfterMs: 4000,
    // how long one request to one explorer may take before that explorer is given up on, in ms (the suites set it short)
    _headerAskMs: 25000,
    cardPick: function (w, have, want, cap, card, tapCap) { return cardPick(w, have, want, cap, card, tapCap); },
    // a token's pieces as the card would hold them, or the refusal (`misfit`): for the suites, which hold it to the card's unit
    _cardPiecesOf: function (token, card) { return cardPiecesOf(token, card); },
    cardReach: function (amounts) { return cardReach(amounts); },
    /* What a payment waits, in signatures of the card's work, by the rule of the card's software: 1.13 and on (`leaves`, the
     * pieces less the change the card makes; `made`, the pieces of it; `second`, a payment signed in this time in the field
     * already; `costed`, a card of 1.14 or later, whose change counts for what it cost, two signatures for every three pieces,
     * where 1.13 took one off for each: `info.costed`), 1.12, and before it (the pieces whole). */
    cardWaitSigns: function (limit, leaves, made, second, costed, over) { return cardWaitSigns(limit, leaves, made, second, costed, over); },
    cardWaitSigns12: function (limit, net, change) { return cardWaitSigns12(limit, net, change); },
    cardWaitSignsBefore: function (limit, sats) { return cardWaitSignsBefore(limit, sats); },
    cardExactPick: function (w, have, want, cap) { return cardExactPick(w, have, want, cap); },
    /* The pieces a card that signs once for a payment is paid with (`least`: one that waits, which a till takes for every card of its kind). */
    cardPickAll: function (w, have, want, cap, card, tapCap, exactOnly, least) { return cardPickAll(w, have, want, cap, card, tapCap, exactOnly, least); },
    /* What goes onto a card is cut like a cash drawer, to fill the gaps in what it holds (08a-flashcard.js). */
    cardLadder: function (sats, most, biggest, have, plain) { return cardLadder(sats, most, biggest, have, plain); },
    // (`depth`: four for a card of 1.23 that holds both units, eight where not given)
    cardDeepLadder: function (sats, most, biggest, have, depth) { return cardDeepLadder(sats, most, biggest, have, depth); },
    /* What a card holds, as the amounts of its pieces, for cutting more for it. */
    cardHeld: function (card, except) { return cardHeldAmounts(card, except); },
    // (`unit`: the card's; a dollar card's largest piece is the dollar keyset's, in cents)
    cardMaxPiece: function (unit) { try { return (unitOf(unit) || 'sat') === 'sat' ? cardMaxPiece(need()) : cardMaxPiece(cardWalletNow(unit)); } catch (e) { return 0; } },
    /* A till with no route: whether a card may pay it at all (the card's own switch), whether this phone has a route,
     * and the question once put to the person first (no screen asks it now). */
    cardOffline: function (on) { return cardOffline(on); },
    cardOnline: function () { return routeOpen(); },
    cardOfflineAsk: function (sats) { return cardOfflineAsk(sats); },
    /* The card payments this phone took with no route and the mint has not swapped yet: [{ id, unit, amount, sats, date, state, at }]
     * (`amount` in `unit`, and `sats` the same for a bitcoin card's and 0 for a dollar card's),
     * `id` the unclaimed row's ('card-…', its entry is 'req-' and that), `date` the pieces' date in seconds (0 for none: the
     * card's owner can never take them back), `state` kept or posting. `cardKept(id)` is one record whole, as a copy, in any
     * state (kept, posting, settled, spent, retired, unwound), or null. */
    cardKeptWaiting: function () { return cardKeptWaiting(); },
    cardKept: function (id) { return cardKept(id); },
    // how near its date a card's money is renewed when its owner reads it online, in seconds (twenty days)
    cardRefreshLeft: function () { return CARD_REFRESH_LEFT; },

    /* Whether a card (as `cardLook` gave it) will ask for its PIN to sign for a payment that takes `net` sats off it (software
     * 1.16 and on): false for a card with no PIN and for one whose no-PIN allowance (`card.noPin`) has `net` left; true for
     * any other card with a PIN, and for every card before 1.16. The card's own answer at its signature (`pin-needed`) is
     * the truth: this is what the read says. A till knows `net` to be at least the price and the mint's fee. */
    cardNeedsPin: function (card, net) { return cardNeedsPin(card, net); },

    /* A card of software 1.23 (dollars and sats at its one mint): what it holds in each, as `cardLook` sorted its pieces, sats first:
     * [{ unit, balance, pieces }], one entry for each unit it holds or may (a card of format 5 lists both, a card of one unit its record's);
     * null for a card before 1.23. `cardBoth`: whether it holds both, or may (format 5). `cardInUnit`: the card as one of its units, its
     * pieces and balance that unit's, for the sums the screens ask (`cardLoadFits`, `cardNeedsPin`). */
    /* (A card its owner set up on this phone to hold both (`cardHoldOf` 'both') lists both from the moment it is set up, each at
     * nothing where it holds none: the choice made at set-up is what the screen shows, not only what the card holds yet. A card
     * set up here for one currency lists that one; a card read as a guest, or set up on another phone, lists what it holds or
     * may (format 5). A card before 1.23 has no `units` and is null here whatever its row says: one pill, as ever.) */
    cardUnits: function (card) {
      if (!card || !card.units) return null;
      var ru = card.record && card.record.unit === 'usd' ? 'usd' : 'sat';
      var both = cardBoth(card) || cardHoldOf(card) === 'both';
      return ['sat', 'usd'].filter(function (u) { return both || u === ru || card.units[u].balance > 0; })
        .map(function (u) { return { unit: u, balance: card.units[u].balance, pieces: card.units[u].pieces.length }; });
    },
    cardBoth: function (card) { return cardBoth(card); },
    /* What this phone promised a card of 1.23 to hold when it set it up (`cardHoldOf`): 'usd' or 'sat' (offer only that one when adding
     * to it), 'both' (ask which), or '' (no promise: ask, as for both). */
    cardHold: function (card) { return cardHoldOf(card); },
    cardInUnit: function (card, unit) { return cardInUnit(card, unit); },
    /* The rate a card of 1.23 would be given at `price` (dollars a bitcoin): floor(100,000,000 / price) sats a dollar, 0 for none. */
    cardRateOf: function (price) { return cardRateOf(price); },

    /* What a card says with no PIN (`cardLook`), after telling it the time.
     * `opts.mine`: also whether this phone is its owner (`card.mine`), for a
     * holder's own screen. Rejects with `card` on the error naming why:
     * not-a-card, wrong-signer, gone.
     *
     * `opts.change`, with `mine` and a card of software 1.12 or later whose owner
     * this phone is: the change the card has made for itself and nobody has handed
     * back is looked into as well (`cardOwnerChange`). Its openings are read; what
     * this phone owes already is the till's to write; what it does not is fetched
     * from the mint (NUT-09) and, in this tap, put on the card with the owner's
     * grant. `card.owes` says where it stands: { sats, count, parts: [{ state, sats,
     * count }], wrote, later }, and the card is read again if anything went on.
     * `opts.on` is told 'mint' while the mint is asked and 'writing' as the pieces
     * go on; `opts.progress` of what the card is held for ({ step: 'fetching' }) and of
     * each piece written. A tap that cannot wait for the mint goes on (`_cardFetchWait`),
     * and `owes.later` is a promise of the same once it has answered. */
    cardLook: function (link, opts) {
      return cardLook(link, opts).then(function (card) {
        return (opts && opts.change) ? cardOwnerFinish(link, opts, card) : card;
      }).then(function (card) {
        // a card this phone can take back: what is on it now is written down for the day it is lost
        var mine = cardsOnFile()[card.key];
        if (mine && mine.refundKey && mine.refundKey === card.record.refundKey) cardRemember(card, card.pieces, true);
        // the design it is drawn in: the card's own word where it has one, else what this phone wrote down for it at set-up
        if (!card.design) card.design = cardDesignNoted(card.key);
        // a set-up this phone began for the card's holder and did not finish (`cardSetUpFor`): the next send takes it up again
        card.forHolder = !card.info.owner && cardHolderNoted(card.key);
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
     * comes back to these words after the piece's date. On unless it is
     * `false`: every card is set up this way, and only a test makes one that is
     * cash. The key is on file here before the card is told it, and the card
     * is told once: its record cannot change while it holds money. */
    /* `opts.unit`: what the card holds, 'sat' (the default) or 'usd' (the mint's dollars), chosen here and changed only by
     * RESET and setting it up again. A dollar card is set up only at a mint that issues dollars: refused (`no-dollars-here`)
     * before anything is asked of the card. Any other unit is `bad-unit`. */
    /* `opts.tapLimit` and `opts.noPin`: the holder's two numbers, chosen on the set-up's screens, in the card's unit (zero or none is
     * none): the limit on one payment and the no-PIN allowance. On a card of software 1.21 and on they go in SET_LIMIT's PIN form,
     * under the PIN just given and before the claim, while the card has no owner (`cardPinLimits`); on an older card, with the owner's
     * proof once it is the owner (`cardLimitTo`). `opts.tapUsd` and `opts.noPinUsd`: the dollars a bitcoin card's figures were chosen in,
     * kept so that the card's sats follow the price, as LIMITS keeps them (`cardPaceNote`). */
    /* `opts.hold`, on a card of software 1.23: what its owner chose it to hold, 'usd', 'sat' (its record's unit: one currency) or 'both'
     * (either), kept on this phone's row for it (`cardHoldNote`) once the card is set up, and never told the card. */
    cardSetUp: function (link, opts) {
      var o = opts || {};
      var recoverable = o.recoverable !== false;
      var unit = (o.unit === undefined || o.unit === null || o.unit === '') ? 'sat' : unitOf(o.unit);
      if (unit !== 'sat' && unit !== 'usd') return Promise.reject(cardError('bad-unit', 'A card holds bitcoin or dollars.'));
      var hold = (o.hold === undefined || o.hold === null || o.hold === '') ? '' : o.hold === 'both' ? 'both' : unitOf(o.hold);
      if (hold && hold !== 'both' && hold !== unit) return Promise.reject(cardError('bad-unit', 'A card that holds one currency is set up in it.'));
      /* `o.pin` empty or absent: a card with no PIN (software 1.16 and on). It pays without one, and its per tap and daily limits are
       * set later by its owner as for any card; no allowance exists on it. A PIN can be added later (`cardAddPin`). */
      var pin = '';
      var noPin = (o.pin === undefined || o.pin === null || o.pin === '');
      if (!noPin) { try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); } }
      var tapLimit = Math.max(0, Math.round(Number(o.tapLimit) || 0)), noPinLimit = noPin ? 0 : Math.max(0, Math.round(Number(o.noPin) || 0));
      var limits = tapLimit > 0 || noPinLimit > 0;
      var w;
      try { w = need(); } catch (e2) { return Promise.reject(e2); }
      var mint = mintOf(w);
      if (!mint || mint.length > CARD_MINT_MAX || /[^\x20-\x7e]/.test(mint)) {
        return Promise.reject(cardError('bad-mint', 'This mint\u2019s address is too long for a card.'));
      }
      if (unit === 'usd' && unitsOf(mint, w).indexOf('usd') < 0) {
        return Promise.reject(cardError('no-dollars-here', hostOf(mint) + ' does not issue dollars, so a card here can hold bitcoin only.'));
      }
      var t = cardTalk(link);
      var card, ownerPub;
      // read the short way: what is on the card is no part of setting it up
      return cardLook(link, { short: true }).then(function (c) {
        card = c;
        if (card.info.locked) throw cardRefused('6986');
        /* A card with an owner is not open, set up or not: it is its owner's, and
         * only that owner's proof changes it. */
        if (card.info.owner) throw cardError('set-up', 'This card already belongs to a Foxy. Only that Foxy, or one restored from its seed phrase, can set it up again.');
        // a card before 1.16 cannot be without a PIN: it would take no record and no owner; nor can a card from 1.21, which holds no money without one
        if (noPin && (!card.info.noPinKnown || cardIs121(card))) throw cardError('old-card', 'This card needs a PIN. It cannot be set up without one.');
        // and a card that has a PIN already (a set-up cut off after it) cannot be set up without it: that PIN is not known here
        if (noPin && card.info.pinSet) throw cardError('has-pin', 'This card already has a PIN. Set it up with that PIN.');
        // (1.23: its figures are cents, and a figure chosen in sats needs a price to be turned into them; said before anything is written;
        // and limits on a card of bitcoin with no price to write its rate at are refused: its sats could pay nothing until a price came)
        if (cardIs123(card) && cardSetUpCents(unit, o, tapLimit, noPinLimit).rate <= 0 && limits && unit === 'sat') throw cardNoPrice(true);
        return cardOwnerPub(card.key);
      }).then(function (pub) {
        ownerPub = pub;
        return recoverable ? cardRefundKey(card.key, unit) : '';
      }).then(function (refund) {
        if (recoverable && !refund) throw cardError('no-key', 'This phone could not make the key that would bring a lost card\u2019s money back. Try again in a moment.');
        // the design chosen for it (`o.design`) goes in the record where the card's software takes one (1.10), and on this phone's file either way
        // a card that names a design already (written at the factory, or by hand) keeps it; else the one this phone chose
        var design = cardCanDesign(card) ? String((card.record && card.record.design) || o.design || '') : '';
        var record = cardRecordHex(refund, mint, design, unit);
        // sealed to the card's own PIN key, where it has one: a PIN is not sent in the clear to a card that can take it otherwise
        /* A card of 1.22 whose set-up was cut short after its record (a PIN, a record, no owner) is a holder's card: its PIN is
         * replaced only under itself, so the PIN typed is shown first. It is the one typed for this set-up, tried again. */
        var resumed = !noPin && !!card.info.guests && !!card.info.pinSet && !!card.info.hasRecord;
        return (noPin ? Promise.resolve() : (resumed ? cardVerify(t, card, pin) : Promise.resolve()).then(function () {
          return cardFirstPin(t, card, pin);
        }).then(function () {
          return cardVerify(t, card, pin);
        })).then(function () {
          return t.want(cardCommand(CARD_INS.setCard, 0, record), 'its record');
        }).then(function () {
          // the holder's numbers, under the PIN, while the card has no owner (1.21 and on)
          // (1.23: in cents with the rate, twelve bytes, `cardSetUpCents`)
          if (cardIs123(card)) {
            var c23 = cardSetUpCents(unit, o, tapLimit, noPinLimit);
            return (limits || c23.rate > 0) ? cardPinLimits(t, c23.tap, c23.noPin, c23.rate) : null;
          }
          return (cardIs121(card) && limits) ? cardPinLimits(t, tapLimit, noPinLimit) : null;
        }).then(function () {
          if (!cardIs121(card)) return t.want(cardCommand(CARD_INS.setOwner, 0, ownerPub), 'its owner');
          /* From 1.21 the card takes an owner only after a held count of askings, each answered 6A98 ("keep holding") after real
           * work, about ten seconds in all: a till that sees the PIN cannot make itself the owner in a moment. Each asking is told
           * to the screen (`o.onHold`, the number asked so far), which says KEEP HOLDING. */
          return cardHoldOn(t, cardCommand(CARD_INS.setOwner, 0, ownerPub), o.onHold, 'its owner');
        }).then(function () {
          // an older card's numbers, with the owner's proof now that it has its owner: none for the day, the one payment's and the allowance
          if (cardIs121(card) || !limits) return null;
          if (!card.info.tapKnown) return null;
          return cardLimitTo(t, card.key, 0, tapLimit, (card.info.noPinKnown && !noPin) ? noPinLimit : undefined);
        });
      }).then(function () {
        // (a card of 1.23 keeps its figures in cents and its rate follows the price: no note of dollars is kept for it)
        if (limits && unit === 'sat' && !cardIs123(card)) {
          cardPaceNote(card.key, tapLimit > 0 ? Number(o.tapUsd) || 0 : 0);
          cardPaceNoPinNote(card.key, noPinLimit > 0 ? Number(o.noPinUsd) || 0 : 0);
        }
        console.log('[foxy] card: a new card is set up at ' + hostOf(mint) + ' in ' + balanceWord(unit) + (recoverable ? ', recoverable' : ', as cash') + ', with ' + (noPin ? 'no PIN and ' : '')
          + (limits ? 'its holder\u2019s limits' : 'no limit'));
        /* The design this phone chose for it (`o.design`, a code of three
         * characters), written down here for a card whose software cannot
         * carry it (before 1.10): its own note, not the list of cards this
         * phone can take back, which a cash card is never on. */
        cardDesignNote(card.key, (card.record && card.record.design) || o.design);
        // (what its owner chose it to hold, on a card of 1.23; a set-up with nothing chosen takes off what an earlier one left)
        if (cardIs123(card)) cardHoldNote(card.key, hold);
        return FoxyWallet.cardLook(link, { mine: true });
      });
    },

    /* ---- the card of a holder with no phone (software 1.22) ---------------------------------------------------------------
     *
     * A card with a PIN and no owner is its holder's, and the holder may have no phone. The first Foxy that sends such a card money
     * sets it up for them (`cardSetUpFor`): the holder types a PIN on that phone, chooses what it holds and its two numbers, and the
     * money goes on under the PIN. That phone never becomes the card's owner and writes no key of its own into it: the card is cash,
     * and its dated pieces are nobody's to take back if it is lost. On any Foxy the holder can then see the card's history as a guest
     * (`cardGuestLook`), under the PIN and after holding the card still for a few seconds, which a till taking a payment does not do;
     * and, with the card empty, tie it to a phone of their own (`cardClaim`), which is set-up's own held claim. */

    /* Set-up for somebody else, in one tap: the PIN (`opts.pin`), sealed where the card takes it so, the PIN shown, the record (this
     * phone's mint, `opts.unit`, the design, and no refund key: 33 zeros), and the holder's numbers in SET_LIMIT's PIN form
     * (`opts.tapLimit`, `opts.noPin`, in the card's unit; none where both are none). No owner is given, and nothing about the card is
     * written down here but its design: the card shows on this phone, as on any other, as somebody else's. Resolves the card as read
     * after it (short). Rejects, with `card`: `bad-pin`, `bad-unit`, `bad-mint`, `no-dollars-here`, `locked`, `set-up` (it has an owner),
     * `has-pin` (it has a PIN already and money on it, or it was set up elsewhere: money goes on it with that PIN), `blocked`,
     * `wrong-pin` (with `tries`: a set-up taken up again whose PIN was not the one the card has), `old-card` (software before 1.22,
     * which takes no money on a card with no owner), `gone`.
     *
     * A set-up cut short is taken up again here, by any phone where the card has a PIN and no record yet (the card takes a new PIN
     * then: 1.22's rule 9), and by this phone where it began the set-up and the card has its record and is still empty: the PIN is
     * shown first, then the record and the numbers are written again (`cardHolderNote`). Nothing is lost by writing them twice. */
    cardSetUpFor: function (link, opts) {
      var o = opts || {};
      var unit = (o.unit === undefined || o.unit === null || o.unit === '') ? 'sat' : unitOf(o.unit);
      if (unit !== 'sat' && unit !== 'usd') return Promise.reject(cardError('bad-unit', 'A card holds bitcoin or dollars.'));
      var pin;
      try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); }
      var tapLimit = Math.max(0, Math.round(Number(o.tapLimit) || 0)), noPinLimit = Math.max(0, Math.round(Number(o.noPin) || 0));
      var w;
      try { w = need(); } catch (e2) { return Promise.reject(e2); }
      var mint = mintOf(w);
      if (!mint || mint.length > CARD_MINT_MAX || /[^\x20-\x7e]/.test(mint)) {
        return Promise.reject(cardError('bad-mint', 'This mint\u2019s address is too long for a card.'));
      }
      if (unit === 'usd' && unitsOf(mint, w).indexOf('usd') < 0) {
        return Promise.reject(cardError('no-dollars-here', hostOf(mint) + ' does not issue dollars, so a card here can hold bitcoin only.'));
      }
      var t = cardTalk(link);
      var card;
      return cardLook(link, { short: true }).then(function (c) {
        card = c;
        if (card.info.locked) throw cardRefused('6986');
        if (card.info.owner) throw cardError('set-up', 'This card already belongs to a Foxy. Only that Foxy, or one restored from its seed phrase, can set it up again.');
        if (!card.info.guests) throw cardError('old-card', 'This card is new, and its software cannot be set up on somebody else\u2019s phone. Its holder sets it up on their own Foxy first.');
        var empty = !(card.info.unspent > 0) && !card.info.changeDue;
        // taken up again: a card with a PIN and no record (anyone's to take up), or one this phone began to set up for its holder
        var again = card.info.pinSet && empty && (!card.info.hasRecord || cardHolderNoted(card.key));
        if (card.info.pinSet && !again) throw cardError('has-pin', 'This card already has a PIN. Money goes on it with that PIN.');
        // a card with its record keeps its PIN (rule 9): it is shown, not set, and a blocked one cannot be; one with none takes the PIN typed now
        var keep = again && card.info.hasRecord;
        if (keep && card.info.pin === 'blocked') throw cardRefused('6983');
        // (1.23: a figure chosen in sats needs a price to be turned into cents, said before anything is written)
        // (and limits on a card of bitcoin with no price to write its rate at are refused: with no owner, nothing could give it one later)
        if (cardIs123(card) && cardSetUpCents(unit, o, tapLimit, noPinLimit).rate <= 0 && (tapLimit > 0 || noPinLimit > 0) && unit === 'sat') throw cardNoPrice(true);
        var design = String((card.record && card.record.design) || o.design || '');
        var record = cardRecordHex('', mint, design, unit);
        cardHolderNote(card.key, true);
        return (keep ? Promise.resolve() : cardFirstPin(t, card, pin)).then(function () {
          return cardVerify(t, card, pin);
        }).then(function () {
          return t.want(cardCommand(CARD_INS.setCard, 0, record), 'its record');
        }).then(function () {
          // (1.23: in cents with the rate, twelve bytes)
          if (cardIs123(card)) {
            var c23 = cardSetUpCents(unit, o, tapLimit, noPinLimit);
            return (tapLimit > 0 || noPinLimit > 0 || c23.rate > 0) ? cardPinLimits(t, c23.tap, c23.noPin, c23.rate) : null;
          }
          return (tapLimit > 0 || noPinLimit > 0) ? cardPinLimits(t, tapLimit, noPinLimit) : null;
        });
      }).then(function () {
        console.log('[foxy] card: a new card is set up for its holder at ' + hostOf(mint) + ' in ' + balanceWord(unit) + ', as cash, with no owner'
          + (tapLimit > 0 ? ', a limit on one payment' : '') + (noPinLimit > 0 ? ', a no-PIN allowance' : ''));
        cardHolderNote(card.key, false);
        cardDesignNote(card.key, (card.record && card.record.design) || o.design);
        return cardLook(link, { short: true });
      });
    },

    /* VIEW AS GUEST: a card with a PIN and no owner (software 1.22), read whole and then, under its PIN (`opts.pin`), its history,
     * held for: the card answers keep holding nine times and then gives it (`opts.onHold(n)` is told each asking), then its receipts
     * and its limit on one payment (`cardGuestRead`). Nothing is paid in the tap, and the card pays nothing in it after. Nothing of
     * the history is kept on this phone. Resolves the card with `log`, `receipts`, `tap` and `guest: true`. Rejects, with `card`:
     * `bad-pin`, `wrong-pin` (with `tries`), `blocked`, `no-pin` (a card with no PIN has no history to hold for), `has-owner` (its
     * history is its owner's phone's to read), `old-card` (software before 1.22), `paid-here` (the card paid in this tap: 6985),
     * `keep-holding` (the card stopped answering keep holding before it answered), `gone`.
     *
     * A card owed change (software 1.22) has it looked into in the same held tap (`cardGuestChange`): what the mint signed for it goes
     * on, a piece a till bound to a key of its own included, since the PIN and the hold are its holder's say; `card.owes` says where it
     * stands, and nothing of it is kept here either. `opts.on` is told 'mint' and 'writing' as `cardLook`'s owner's read tells them. */
    cardGuestLook: function (link, opts) {
      var o = opts || {};
      var pin;
      try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); }
      var t = cardTalk(link);
      var card;
      return cardLook(link, {}).then(function (c) {
        card = c;
        if (!card.info.guests) throw cardError('old-card', 'This card\u2019s software has no guest view.');
        if (card.info.owner) throw cardError('has-owner', 'This card belongs to a Foxy. Its history is on that phone.');
        if (!card.info.pinSet) throw cardRefused('6984');
        if (card.info.pin === 'blocked') throw cardRefused('6983');
        return cardVerify(t, card, pin);
      }).then(function () {
        return cardGuestRead(t, card, o.onHold);
      }).then(function (c) {
        console.log('[foxy] card: read as a guest: ' + c.log.last.length + ' tap(s) of its log, ' + c.receipts.list.length + ' receipt(s), kept nowhere');
        /* Change owed to it, in the same held tap: what the mint signed goes on, an opening a till bound to a key of its own
         * included (the PIN and the hold are the holder's say), and nothing of it is kept here (`cardGuestChange`). */
        if (!c.info.changeDue) return c;
        return cardGuestChange(t, c, { on: o.on }).then(function (owes) {
          if (owes) { c.owes = owes; c.balance = (Number(c.balance) || 0) + (Number(owes.wrote) || 0); }
          return c;
        }, function (e) {
          if (e && e.card === 'gone') throw e;
          return c;
        });
      });
    },

    /* The change a till bound to a key that is not the mint's, mended (software 1.22): the mint's answer for the opening's blinded
     * message (NUT-09 restore, as the owner's read fetches change) goes on under the mint's own key, which the card takes only under
     * the PIN given in this tap (`opts.pin`), in a tap that has paid nothing, and with the holder's say: on a card with an owner this
     * phone's grant (ALLOW_LOAD), on one with none the history held for (GET_LOG asked until it answers, `opts.onHold(n)` told each
     * asking). Every other piece of the card's own change that can go on goes on with it. One tap: VERIFY_PIN, ALLOW_LOAD or the held
     * GET_LOG, GET_CHANGE, then LOAD_CHANGE for each opening.
     *
     * Resolves { card, amount, unit, refused, owes }: the card as it reads after, `amount` what went on (in its unit), `refused` how
     * many of the card's openings it would not take under the mint's key (the mint's answer does not fit it: it can only be given up,
     * `cardGiveUp`), and `owes` where the card's change stands now. Rejects, with `card`: `bad-pin`, `old-card` (software before
     * 1.22: "This card’s software cannot do that."), `locked`, `no-pin`, `blocked`, `wrong-pin`, `not-owner`, `paid-here`, `gone`. */
    cardMend: function (link, opts) {
      var o = opts || {};
      var pin;
      try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); }
      // room for what the mending writes once the card has acted, or the card is asked nothing (`cardRoom`)
      var noRoom = cardRoom();
      if (noRoom) return Promise.reject(noRoom);
      var t = cardTalk(link);
      var card;
      return cardLook(link, { short: true }).then(function (c) {
        card = c;
        if (!card.info.guests) throw cardError('old-card', 'This card\u2019s software cannot do that.');
        if (card.info.locked) throw cardRefused('6986');
        if (!card.info.pinSet) throw cardRefused('6984');
        if (card.info.pin === 'blocked') throw cardRefused('6983');
        return cardVerify(t, card, pin);
      }).then(function () {
        if (card.info.owner) {
          return cardGrant(t, card.key).then(function (yes) {
            if (!yes) throw cardRefused('6a91');
            card.mine = true;
          });
        }
        return cardHoldOn(t, cardCommand(CARD_INS.log, 0, '', 0), o.onHold, 'its history').then(function () { card.guest = true; }, function (e) {
          if (e && e.sw === '6985') throw cardError('paid-here', 'This card has just paid, so it does not take this change in the same tap. Take it away from the phone and tap it again.');
          throw e;
        });
      }).then(function () {
        return card.info.owner ? cardOwnerChange(t, card, { mend: true, on: o.on, progress: o.progress }) : cardGuestChange(t, card, { on: o.on });
      }).then(function (owes) {
        if (owes && owes.error && owes.error.card === 'gone' && !(owes.wrote > 0)) throw owes.error;
        if (owes && owes.error && owes.error.card === 'paid-here') throw owes.error;
        var amount = owes ? Number(owes.wrote) || 0 : 0;
        console.log('[foxy] card: mended: ' + amount + ' of its change went on' + (owes && owes.refused ? ', ' + owes.refused + ' refused by the card' : ''));
        var unit = (card.record && card.record.unit) || 'sat';
        var after = amount > 0 ? cardLook(link, card.info.owner ? { mine: true, short: true } : { short: true }).then(null, function () {
          card.balance = (Number(card.balance) || 0) + amount;
          return card;
        }) : Promise.resolve(card);
        return after.then(function (fresh) {
          fresh.owes = owes || null;
          if (!card.info.owner) fresh.guest = true;
          return { card: fresh, amount: amount, unit: unit, refused: owes ? Number(owes.refused) || 0 : 0, owes: owes || null };
        });
      });
    },

    /* One opening of the card's own change given up (software 1.22, RESET_CARD with P1 = 1 and P2 = its number, `opts.number`): its
     * piece is never loaded, and its money is gone. For an opening nothing can load: a till bound it to a key that is not the mint's
     * and the mint has no answer for it, or the card would not take the one it has. On a card with an owner, this phone's proof over
     * "FoxyCard/reset", a nonce the card gives and the number, then the number (and the PIN on a locked card); on one with none, the
     * PIN (`opts.pin`) and the history held for (`opts.onHold(n)`), then the number alone. The card writes it in its log (bit 4 of the
     * tap's flags). What this phone held toward that opening is dropped.
     *
     * The opening is named by its number and by its blinded message (`opts.B_`, as the read that offered it had it), and nothing is sent
     * for it unless the card's opening of that number is still that one: numbers are used again once an opening is closed, and a screen
     * left open must not give up the change of a later payment.
     *
     * Resolves { card, amount, unit, number }: the card as it reads after, and what the opening was worth (in its unit). Rejects, with
     * `card`: `old-card` ("This card’s software cannot do that.": said of a card before 1.22 before anything is sent, and of a card
     * that answers 6B00), `nothing-owed` (the opening waits for nothing now, or is another's), `on-card` (its piece is on the card already: nothing was lost), `bad-pin`, `wrong-pin`, `blocked`, `no-pin`,
     * `not-owner`, `locked`, `paid-here`, `gone`. */
    cardGiveUp: function (link, opts) {
      var o = opts || {};
      var n = Number(o.number);
      var named = String(o.B_ || '').toLowerCase();
      if (!(n >= 0 && n <= 7 && Math.floor(n) === n) || !/^0[23][0-9a-f]{64}$/.test(named)) return Promise.reject(cardError('refused', 'That is not change owed to the card.'));
      // room for what is written once the card has let go, or the card is asked nothing (`cardRoom`)
      var noRoom = cardRoom();
      if (noRoom) return Promise.reject(noRoom);
      var pin = '';
      if (!(o.pin === undefined || o.pin === null || o.pin === '')) { try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); } }
      var t = cardTalk(link);
      var card, op;
      var cannot = function () { return cardError('old-card', 'This card\u2019s software cannot do that.'); };
      return cardLook(link, { short: true }).then(function (c) {
        card = c;
        // 1.22 and on: a card before it has no let-go, and is sent nothing for one
        if (!card.info.ownChange || !cardIs121(card) || !card.info.guests) throw cannot();
        if (card.info.owner) return card.info.locked && pin ? cardVerify(t, card, pin) : null;
        // a card with no owner: its holder's PIN and the held history
        if (!card.info.pinSet) throw cardRefused('6984');
        if (card.info.pin === 'blocked') throw cardRefused('6983');
        if (!pin) throw cardError('bad-pin', 'A card PIN is 4 to 8 digits.');
        return cardVerify(t, card, pin).then(function () {
          return cardHoldOn(t, cardCommand(CARD_INS.log, 0, '', 0), o.onHold, 'its history');
        }).then(null, function (e) {
          if (e && e.sw === '6985') throw cardError('paid-here', 'This card has just paid, so it gives up nothing in the same tap. Take it away from the phone and tap it again.');
          throw e;
        });
      }).then(function () {
        return cardOpenings(t);
      }).then(function (list) {
        op = list.filter(function (x) { return x.number === n; })[0];
        // the opening the screen showed, and not one that has taken its number since
        if (!op || String(op.B_ || '').toLowerCase() !== named || (o.amount !== undefined && o.amount !== op.amount)) throw cardError('nothing-owed', 'That change is not owed to the card any more.');
        if (!card.info.owner) return t.ask(cardCommand(CARD_INS.reset, 1, cardByte(n), undefined, n));
        // the owner's proof over the reset's label, the nonce and the number, then the number
        return cardOwned(t, card.key, 'reset', cardByte(n)).then(function (data) {
          return t.ask(cardCommand(CARD_INS.reset, 1, data, undefined, n));
        });
      }).then(function (r) {
        if (r.sw === '6b00') throw cannot();
        if (r.sw === '6a88') throw cardError('nothing-owed', 'That change is not owed to the card any more.');
        if (r.sw === '6a94') throw cardError('on-card', 'That change is on the card already.');
        if (r.sw === '6982' && card.info.owner) throw cardError('locked', 'This card is locked. Its change can be given up only with its PIN.');
        if (r.sw === '6985') throw cardError('paid-here', 'This card has just paid, so it gives up nothing in the same tap. Take it away from the phone and tap it again.');
        if (r.sw !== '9000') throw cardRefused(r.sw, 'to give up its change');
        // what this phone held toward that opening is nobody's now
        var gone = String(op.B_ || '').toLowerCase();
        if (gone) {
          var rows = cardStore(CARD_OWED).map(function (row) {
            if (!(row && row.card === card.key && Array.isArray(row.blind))) return row;
            var keep = row.blind.filter(function (b) { return !(b && String(b.B_).toLowerCase() === gone); });
            if (keep.length === row.blind.length) return row;
            return keep.length ? Object.assign({}, row, { blind: keep }, cardFig(cardRowUnit(row), keep.reduce(function (m, b) { return m + satsOf(b.amount); }, 0))) : null;
          }).filter(function (row) { return row !== null; });
          mustSave(CARD_OWED, rows);
        }
        console.log('[foxy] card: an opening of its change, ' + op.amount + ', is given up');
        return cardLook(link, card.info.owner ? { mine: true, short: true } : { short: true }).then(null, function () { return card; });
      }).then(function (fresh) {
        if (!card.info.owner) fresh.guest = true;
        return { card: fresh, amount: op.amount, unit: (card.record && card.record.unit) || 'sat', number: n };
      });
    },

    /* TIE OWNERSHIP TO THIS PHONE: the claim of set-up (software 1.21 and on), on a card that has a PIN and no owner: the PIN
     * (`opts.pin`) shown, and this phone's owner key asked for six times in a row, the card answering keep holding to the first five
     * (`opts.onHold(n)`). Only of an EMPTY card: one with money on it, or change owed to it, is refused before anything is sent
     * (`has-money`), and so is the card's own 6A8D. Once it is this phone's, the card is given this phone's refund key in its record,
     * with the owner's proof, so that its money can be taken back if it is lost, as every card this phone sets up can; a card that
     * will not take it stays as it was, cash, and that is a line in the log. Resolves the card as its owner reads it. Rejects, with
     * `card`: `bad-pin`, `wrong-pin`, `blocked`, `no-pin`, `set-up` (it has an owner), `old-card` (before 1.21), `has-money`,
     * `no-owner-key`, `gone`, and `refused` with `sw` 6985 for a tap that paid. */
    cardClaim: function (link, opts) {
      var o = opts || {};
      var pin;
      try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); }
      var t = cardTalk(link);
      var card, ownerPub;
      var money = function () { return cardError('has-money', 'Spend or move the money on this card first. Only an empty card can be tied to a phone.'); };
      return cardLook(link, { short: true }).then(function (c) {
        card = c;
        if (card.info.locked) throw cardRefused('6986');
        if (card.info.owner) throw cardError('set-up', 'This card already belongs to a Foxy. Only that Foxy, or one restored from its seed phrase, can change that.');
        if (!cardIs121(card)) throw cardError('old-card', 'This card\u2019s software cannot be tied to a phone this way.');
        if (!card.info.pinSet) throw cardRefused('6984');
        if (card.info.pin === 'blocked') throw cardRefused('6983');
        if (card.info.unspent > 0 || card.info.changeDue) throw money();
        return cardOwnerPub(card.key);
      }).then(function (pub) {
        ownerPub = pub;
        return cardVerify(t, card, pin);
      }).then(function () {
        return cardHoldOn(t, cardCommand(CARD_INS.setOwner, 0, ownerPub), o.onHold, 'its owner').then(null, function (e) {
          if (e && e.card === 'in-use') throw money();
          throw e;
        });
      }).then(function () {
        console.log('[foxy] card: this phone has claimed a card that had no owner');
        var unit = (card.record && card.record.unit) || 'sat';
        return cardRefundKey(card.key, unit).then(function (refund) {
          if (!refund || !card.record || !card.record.mint) return null;
          var record = cardRecordHex(refund, card.record.mint, cardCanDesign(card) ? card.record.design : '', unit);
          return cardOwned(t, card.key, 'set-card', record).then(function (data) {
            return t.want(cardCommand(CARD_INS.setCard, 0, data), 'this phone\u2019s key');
          });
        }).then(null, function (e) {
          if (e && e.card === 'gone') throw e;
          console.warn('[foxy] card: the claimed card kept its record, with no key to take it back:', (e && e.message) || e);
        });
      }).then(function () {
        return FoxyWallet.cardLook(link, { mine: true });
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
      // read the short way: a PIN changes, and what is on the card is not looked at
      return cardLook(link, { short: true }).then(function (card) {
        // said before anything is signed: nothing here can change a card that has no owner
        if (!card.info.owner) throw cardRefused('6a90');
        if (card.info.locked) throw cardRefused('6986');
        // the owner's proof over the new PIN, and the PIN sealed where the card takes it so
        return cardNewPin(t, card, newPin);
      }).then(function () { return true; });
    },

    /* A PIN added to a card that has none (software 1.16 and on), by the card's owner: the owner's grant in this tap, then the PIN
     * sealed to the card, exactly as at set-up. One tap. The card then asks for the PIN for every payment, as it has no no-PIN
     * allowance (the allowance is 0 when a PIN is added) until its owner sets one (`cardSetLimit`, `noPin`). Resolves the card
     * as its owner reads it after. Rejects: `no-owner`, `locked`, `old-card` (software before 1.16), `has-pin` (the card has a
     * PIN already: that is `cardChangePin`), `not-owner` (this phone's words are not the ones the card was set up with: costs
     * nothing and changes nothing), `bad-pin`. */
    cardAddPin: function (link, opts) {
      var o = opts || {};
      var pin;
      try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); }
      var t = cardTalk(link);
      // read as its owner (the grant is given in the read, and stands for this tap)
      return cardLook(link, { short: true, mine: true }).then(function (card) {
        if (!card.info.owner) throw cardRefused('6a90');
        if (card.info.locked) throw cardRefused('6986');
        if (!card.info.noPinKnown) throw cardError('old-card', 'This card\u2019s software cannot be without a PIN, so there is none to add.');
        if (card.info.pinSet) throw cardError('has-pin', 'This card has a PIN already.');
        if (!card.mine) throw cardRefused('6a91');
        return cardFirstPin(t, card, pin);
      }).then(function () {
        console.log('[foxy] card: a PIN is added to a card that had none; every payment asks for it until a no-PIN limit is set');
        return cardLook(link, { mine: true, short: true });
      });
    },

    /* RESET (software 1.17 and on): the owner gives the card back to what it was in its packet, so that another person can set it up.
     * Under the owner's proof over "FoxyCard/reset" and nothing else; a LOCKED card also needs its PIN, verified in this tap
     * (`opts.pin`), and an unlocked one needs none (a blocked PIN is no bar). The card then has no PIN (three tries), no owner,
     * no record, no limits, allowance, log or receipts, and a NEW KEY; it keeps its clock and its software. It must hold no money:
     * it is `has-money` while any piece is unspent (`cardEmptyAndReset` takes the money off first). One tap. Resolves
     * { reset: true, key: <the card's old key> }. After it, everything this phone kept under the old key that is not money (the
     * pace rows, the receipts it copied, a lifted limit's note, the day's note of when it was checked, its design, and where it had read
     * the log to) is dropped, and the same tap's later reads ask the card for its new key.
     *
     * Rejects, with `card`: `old-card` (software before 1.17), `no-owner`, `not-owner` (these words are not the ones the card was set
     * up with: costs no try and changes nothing), `has-money` ("Take the money off the card first."), `locked` (a locked card, no PIN
     * given, or the card's 6982), `bad-pin` (a PIN that is not 4 to 8 digits), `wrong-pin` (with `tries`), `blocked` (a locked card
     * whose PIN is blocked cannot be reset), `gone`, `change-owed` and `unsettled`.
     *
     * `change-owed` ("The card is owed change from its last payment. Tap it once more first."): the card keeps what the change it made for
     * itself is made of, and a reset wipes it; the change is locked to the key the reset destroys, so it would be lost. The owner's read
     * first finishes it (asks the mint for what it signed, puts it on the card, in this same tap); where that cannot be done now (no road to
     * the mint, the till has not made its swap) the card is not reset and nothing is changed, `e.owes` says what ({ openings, sats }). What was
     * put on by it is money on the card (`has-money` for `cardReset`; `cardEmptyAndReset` takes it off with the rest).
     *
     * `unsettled` is this phone's own guard, not the card's: the reset wipes the card's memory of the change it made for itself
     * and the signature it would give again, and this phone's own rows of money owed to the card (ecash locked to the old key,
     * which nothing could ever write to the card again). While any of it is open the card is not reset and nothing is changed:
     * `e.owes` says what ({ openings, owed, due, asked, held, sats }). `opts.abandon: true` resets all the same, and the rows owed to the
     * old key are dropped, which loses what they hold (the pieces stay locked to the old key; a card set up as recoverable gives
     * them back to this phone's key after their date, `cardTakeBack`). */
    cardReset: function (link, opts) {
      var o = opts || {};
      var pin = '';
      if (!(o.pin === undefined || o.pin === null || o.pin === '')) { try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); } }
      var t = cardTalk(link);
      var card;
      return cardResetLook(link, t, o, pin).then(function (c) {
        card = c;
        if (card.info.unspent > 0) throw cardError('has-money', 'Take the money off the card first.', Object.assign(cardGot(card.record.unit, card.balance), { cardUnit: card.record.unit }));
        return card.info.locked && pin ? cardVerify(t, card, pin) : null;
      }).then(function () {
        // the owner's proof over the label and an empty value; the card's own word is the truth (a card that is not this phone's says 6A91)
        return cardOwned(t, card.key, 'reset', '');
      }).then(function (data) {
        return t.ask(cardCommand(CARD_INS.reset, 0, data, undefined, CARD_RESET_CONFIRM));
      }).then(function (r) {
        if (r.sw === '6a8d') throw cardError('has-money', 'Take the money off the card first.');
        if (r.sw === '6982') throw cardError('locked', 'This card is locked. It can be reset only with its PIN.');
        if (r.sw !== '9000') throw cardRefused(r.sw, 'to be reset');
        // the card is another card now: its key, and the proof of it, are asked for again in this tap
        if (link && link.one) { delete link.one.key; link.one.proved = null; }
        cardForget(card.key, !!o.abandon);
        console.log('[foxy] card: a card is reset; this phone has forgotten what it kept for its old key');
        return { reset: true, key: card.key };
      });
    },

    /* RESET for the app: a card that holds money has all of it taken off to this phone first (as `cardWithdraw` all does, with the
     * owner's proof and the PIN where the card wants it: `opts.pin`), and is then reset, in the one tap. Resolves
     * { reset: true, key, withdrew: <sats> } (`withdrew` is 0 for an empty card, which is just `cardReset`). Everything is checked
     * that can be before the money is moved, so a card that cannot be reset is not emptied: the rejections are `cardReset`'s.
     * A failure after the money came off carries `e.withdrew` (the sats now on this phone) and `e.hashes`; the card is then
     * empty and the next tap resets it (`cardReset`). `opts.on` and `opts.progress` are `cardWithdraw`'s. */
    cardEmptyAndReset: function (link, opts) {
      var o = opts || {};
      // the money comes off first (`cardWithdraw`), and that is a signature: room for it, before the card is read (`cardRoom`)
      var noRoom = cardRoom();
      if (noRoom) return Promise.reject(noRoom);
      var pin = '';
      if (!(o.pin === undefined || o.pin === null || o.pin === '')) { try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); } }
      var t = cardTalk(link);
      var withdrew = 0, hash = '', unit = 'sat', also = null;
      var late = function (e) { if (e && typeof e === 'object' && withdrew > 0) { e.withdrew = withdrew; e.unit = unit; e.hash = hash; if (also) e.also = also; } throw e; };
      return cardResetLook(link, t, Object.assign({}, o, { money: true }), pin).then(function (card) {
        if (!(card.info.unspent > 0)) return null;
        return FoxyWallet.cardWithdraw(link, { pin: pin ? o.pin : undefined, on: o.on, progress: o.progress, hold: true }).then(function (got) {
          // in the card's unit (cents for a dollar card), which `unit` says
          withdrew = got.amount; hash = got.hash; unit = got.unit || 'sat';
          // (a card of 1.23 that held both: the other, apart, never added in)
          if (got.also) also = got.also;
        });
      }).then(function () {
        return FoxyWallet.cardReset(link, o);
      }).then(function (r) {
        var out = /** @type {any} */ ({ reset: true, key: r.key, withdrew: withdrew, unit: unit, hash: hash });
        if (also) out.also = also;
        return out;
      }).then(null, late);
    },

    /* The card's daily limit: the most it signs for in one day, in sats, set to
     * `sats` (zero removes it). The owner's proof and no PIN: only a phone that
     * holds the words the card was set up with can, and it does not need to know
     * the PIN. A limit starts a new day at the card's clock, so the card has
     * been told the time first (`cardLook` does it). */
    /* `opts.tap`: the limit on ONE TAP is the one set (the most the card signs
     * for in ten seconds of its own clock), and the day's is left as it is.
     * Both go in the one command, the day's as the card has it, so the day's
     * window and count are not begun again. A card whose software has no such
     * limit says so (`old-card`). */
    /* `opts.noPin` (software 1.16 and on): the NO-PIN ALLOWANCE is the one set, the most the card signs for in a day without its
     * PIN (zero is none: every payment asks for it). `noPin: true` takes the figure from `opts.sats`, as `tap: true` does; a
     * number is the figure itself. The command is the twelve-byte one, the day's limit and the limit on one tap as the card has
     * them (so neither's window or count begins again) and then the allowance. A card with no PIN has no allowance to set
     * (`no-pin`), and a card before 1.16 has none at all (`old-card`). `opts.usd` is the dollars it was set in, where it was,
     * and the card's sats follow the price from then on, as the limit on one tap's do (`cardLook`, `cardPaceNoPinNote`). */
    cardSetLimit: function (link, opts) {
      var o = opts || {};
      var npGiven = o.noPin !== undefined && o.noPin !== null && o.noPin !== false;
      var sats = Math.round(Number(npGiven ? (o.noPin === true ? o.sats : o.noPin) : o.sats));
      if (!(sats >= 0 && sats <= 4294967295)) return Promise.reject(cardError('bad-limit', 'That is not a limit a card can hold.'));
      var t = cardTalk(link);
      var key, dollars = false;
      /* Read the short way: a limit is set, and what is on the card is not looked at. The allowance's twelve bytes carry the limit
       * on one tap as the card has it, which only its owner is told, so that one is read as its owner. */
      return cardLook(link, npGiven ? { short: true, mine: true } : { short: true }).then(function (card) {
        if (!card.info.owner) throw cardRefused('6a90');
        if (card.info.locked) throw cardRefused('6986');
        key = card.key;
        /* A card of 1.23: one figure for both its currencies, in cents, with the rate (`cardSetLimit23`): `opts.unit` the unit `sats` is
         * in (the record's where not named), `opts.usd` the dollars where typed in them; `opts.rateOk` and `opts.keepRate` answer `rate-far`.
         * No note of dollars is kept: its figures are cents on the card, and its rate follows the price. */
        if (cardIs123(card)) {
          if (npGiven && !card.info.noPinKnown) throw cardError('old-card', 'This card’s software has no limit for payments without a PIN.');
          if (npGiven && sats > 0 && !card.info.pinSet) throw cardError('no-pin', 'A card with no PIN has no limit for payments without one. Add a PIN first.');
          return cardSetLimit23(t, card, o, npGiven ? 'noPin' : o.tap ? 'tap' : 'day', sats).then(function () {
            cardPaceNote(key, 0);
            cardPaceNoPinNote(key, 0);
          });
        }
        /* A dollar card's limits are cents, set in dollars and held in dollars: no note of dollars to follow the price is kept
         * for it (and any there was is cleared), so nothing ever re-pegs it (`cardLook`). */
        dollars = card.record && card.record.unit === 'usd';
        if (npGiven) {
          if (!card.info.noPinKnown) throw cardError('old-card', 'This card\u2019s software has no limit for payments without a PIN.');
          if (sats > 0 && !card.info.pinSet) throw cardError('no-pin', 'A card with no PIN has no limit for payments without one. Add a PIN first.');
          if (!card.mine) throw cardRefused('6a91');
          return cardLimitTo(t, key, card.info.limit, card.info.tapLimit, sats).then(function () {
            cardPaceNoPinNote(key, (sats > 0 && !dollars) ? Number(o.usd) || 0 : 0);
          });
        }
        if (o.tap) {
          if (!card.info.tapKnown) throw cardError('old-card', 'This card\u2019s software has no limit on one tap.');
          return cardLimitTo(t, key, card.info.limit, sats).then(function () {
            // the dollars it was set in, where it was (`o.usd`), so that the card's sats follow the price (`cardLook`)
            cardPaceNote(key, (sats > 0 && !dollars) ? Number(o.usd) || 0 : 0);
          });
        }
        return cardLimitTo(t, key, sats);
      }).then(function () {
        /* What the owner has just chosen is the limit now. A note of a limit
         * lifted for a withdrawal and not put back is older than this, and the
         * read below would act on it: a card told NO LIMIT on purpose would be
         * given the old limit back in the same tap. */
        cardLiftNote(key, 0);
        // as its owner, for the screen: short, since nothing of what is on the card has changed
        return cardLook(link, { mine: true, short: true });
      }).then(function (card) {
        /* A limit on one tap set on a card that holds pieces larger than it:
         * with the PIN (`o.pin`), the card's money is taken off and put back
         * cut under the limit, in this same tap (`cardLimitCap`), so that no
         * payment under the limit falls on a piece the card waits for. Without
         * the PIN the card is left as it is, and `aboveLimit` says how much of
         * its money is in such pieces. A card of sixty-four places, or one
         * that signs for eight at a time, is not cut that way at all. */
        card.aboveLimit = cardAboveLimit(card);
        // (a card with no PIN needs none to be emptied and filled)
        // (not a card of 1.23 that holds both: its money would come off in two units and go back in one)
        if (!(o.tap && !npGiven && sats > 0 && (o.pin || !card.info.pinSet) && card.aboveLimit > 0 && cardIsDeep(card)) || cardBoth(card)) return card;
        var on = function (step) { try { if (typeof o.on === 'function') o.on(step); } catch (e) {} };
        return FoxyWallet.cardWithdraw(link, { pin: o.pin, on: o.on, progress: o.progress, hold: true }).then(function (got) {
          return cardLook(link, { mine: true, short: true }).then(function (c) { return FoxyWallet.cardPrepare(c, got.amount); });
        }).then(function () {
          on('writing');
          return FoxyWallet.cardWrite(link, { owner: true, progress: o.progress });
        }).then(function (r) {
          var c = r.card;
          c.recut = true;
          c.aboveLimit = cardAboveLimit(c);
          console.log('[foxy] card: its money is cut again under its new limit on one tap, in ' + c.pieces.length + ' pieces');
          return c;
        });
      });
    },

    /* The rate guard's yes (software 1.23): the card's owner read it and was asked once whether to write a rate more than twice, or under
     * half, the card's (`card.rateAsk` from `cardLook`, or `rate-far` from `cardSetLimit`), and said yes. One tap: the owner's grant, the
     * figures as the card has them, and the rate at `opts.price`. Resolves the card as its owner reads it after (short). */
    cardSetRate: function (link, opts) {
      var o = opts || {};
      var t = cardTalk(link);
      var rate = cardRateOf(cardPriceFor(o.price));
      if (!(rate > 0)) return Promise.reject(cardError('no-price', 'This phone has no Bitcoin price to give the card.'));
      return cardLook(link, { short: true, mine: true }).then(function (card) {
        if (!cardIs123(card)) throw cardError('old-card', 'This card’s software keeps no rate.');
        if (!card.mine) throw cardRefused('6a91');
        return cardLimit23(t, card, { rate: rate });
      }).then(function () {
        console.log('[foxy] card: its owner said yes, and its rate is set to ' + rate + ' sats a dollar');
        return cardLook(link, { mine: true, short: true });
      });
    },
    /* The rate guard's no: not asked again at this price (`cardRepeg23`). */
    cardRateNo: function (key, rate) { if (key && Number(rate) > 0) cardRateDeclined[key] = Number(rate); },

    /* The cards on file here: those this phone set up with a key to take their money back, and those it claimed (TIE OWNERSHIP),
     * { key: { mint, refundKey, at, ... } }. Not a card it only loaded, nor one it set up as cash for somebody else. */
    cardsKnown: function () { return cardsOnFile(); },
    // the hold a card's pieces are dated ahead by, in seconds (thirty days; a local test build may shorten it)
    cardHoldSecs: function () { return cardHoldSecs(); },
    /* And the margins that scale with it, in seconds: `ahead` (a piece's date from now), `offline` (what a receiver with no route
     * needs left), `online` (one with a route), `own` (the card's own phone), `reuse` (a top-up keeps a date this far off). At the
     * thirty days: 30 d, 7 d, 24 h, 10 min, 20 d. */
    cardMargins: function () {
      return { hold: cardHoldSecs(), ahead: cardDateAhead(), offline: cardDateMargin(), online: cardOnlineMargin(), own: cardOwnMargin(), reuse: cardDateReuse() };
    },
    // the last card read in any flow (its key and info), or null
    cardLastRead: function () { return lastCardRead; },

    /* Whether `key` is a card on file here (`cardsKnown`: set up by this phone with a key to take its money back, or claimed by it;
     * not a card it only loaded): its entries are the card's business, shown in the card's own history and left out of home's
     * (26-render-history-and-contacts.js `renderHistory`). */
    cardKnownHere: function (key) {
      return typeof key === 'string' && !!key && Object.prototype.hasOwnProperty.call(cardsOnFile(), key);
    },

    /* A card's name on this phone ('' for none: the app then says what it always said), and naming it (`name` '' takes it off). The
     * name is cut at 24 characters and trimmed; what is kept is answered. Nothing is told to the card. */
    cardName: function (key) { return cardNameOf(key); },
    cardSetName: function (key, name) { return cardNameKeep(key, name); },

    /* The same, for a screen: what each held when last seen, and when it can
     * be taken back. Newest first. Each in the unit it holds (`unit`, a row from
     * before cards held dollars is bitcoin): `amount`, and `sats` the same for a
     * bitcoin card and 0 for a dollar card. */
    cardsList: function () {
      var all = cardsOnFile();
      var now = Math.floor(Date.now() / 1000);
      return Object.keys(all).map(function (key) {
        var row = all[key] || {};
        var unit = unitOf(row.unit) || 'sat';
        var pieces = row.pieces && typeof row.pieces === 'object' ? row.pieces : {};
        var sats = 0, first = 0, last = 0;
        Object.keys(pieces).forEach(function (n) {
          var x = pieces[n];
          // off the card when this phone last read it, kept on file only for the taking back; or spent, as the mint has said (`cardsStillAtMint`)
          if (!x || x.gone || x.spent) return;
          sats += satsOf(x.amount);
          if (x.date) { first = first ? Math.min(first, x.date) : x.date; last = Math.max(last, x.date); }
        });
        return { key: key, mint: row.mint || '', at: row.at || 0, seen: row.seen || 0, unit: unit, amount: sats, sats: unit === 'sat' ? sats : 0,
                 // `first` the soonest of its pieces' dates, when the first of it can be taken back (`due` from then)
                 date: last, first: first, due: !!first && first <= now, takenBack: row.takenBack || 0 };
      }).sort(function (a, b) { return (b.seen || b.at) - (a.seen || a.at); });
    },

    /* RESTORE CARD's look (26f-flashcard.js `fcAskAtMint`): of the pieces this phone knew on a card and has not seen leave it, which
     * the mint still holds unspent. One request for the card (`cardFiledStates`, the take-back's own), and nothing spent or swapped.
     * Resolves { unit, amount, sats, spent }: what is still at the mint in the unit the card's row says it holds (`amount`, all of it,
     * due or not: the take-back brings what is due and says the rest is for later), `sats` the same for a bitcoin card and 0 for a
     * dollar one, and `spent` what the mint said is spent, in that unit too. The spent pieces are stamped on the card's row (`cardFiledSpent`), so what the
     * list says it held (`cardsList`) is that much less from now on. A piece the mint calls pending is neither: not at the mint for
     * the take-back, and not spent yet. What the card was given that this phone never saw is not known either way.
     *
     * Resolves null, and never rejects: a card not on file or already taken back, one whose money is at a mint this phone is not
     * connected to (not asked at all), no wallet, no route, no piece to ask about, or no answer from the mint. */
    cardsStillAtMint: function (cardKey) {
      var row = cardsOnFile()[cardKey];
      if (!row || row.takenBack) return Promise.resolve(null);
      var w;
      try { w = need(); } catch (e) { return Promise.resolve(null); }
      if (canonicalMint(row.mint) !== mintOf(w) || !routeOpen()) return Promise.resolve(null);
      var pieces = row.pieces && typeof row.pieces === 'object' ? row.pieces : {};
      var asked = [], nonces = [];
      Object.keys(pieces).forEach(function (nonce) {
        var x = pieces[nonce];
        if (!x || x.gone || x.spent) return;
        try { asked.push(cardFiledProof(w, cardKey, row, nonce, x)); nonces.push(nonce); } catch (e) {}
      });
      if (!asked.length) return Promise.resolve(null);
      var unit = unitOf(row.unit) || 'sat';
      return cardFiledStates(w, cardKey, asked).then(function (states) {
        var left = 0, spent = 0, gone = [];
        asked.forEach(function (pr, i) {
          if (states[i] === 'UNSPENT') left += satsOf(pr.amount);
          else if (states[i] === 'SPENT') { spent += satsOf(pr.amount); gone.push(nonces[i]); }
        });
        cardFiledSpent(cardKey, gone);
        console.log('[foxy] card: the mint holds ' + cardSaid(left, unit) + ' of what this phone knew on a card' + (spent ? '; ' + cardSaid(spent, unit) + ' of it is spent' : ''));
        return Object.assign(cardGot(unit, left), { spent: spent });
      }).then(null, function (e) {
        console.warn('[foxy] card: the mint did not say what is left of a card: ' + ((e && e.message) || e));
        return null;
      });
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
     * Resolves { unit, amount, sats, hash, later }: in the unit the card's row
     * says it holds (bitcoin for a row from before cards held dollars), `sats`
     * the same for a bitcoin card and 0 for a dollar one; `later` is what is not
     * due yet, in that unit too. The pieces are taken back by the wallet of
     * their own keyset's unit, a dollar card's by the dollar wallet: a card's
     * row holds one unit, and one that somehow holds two has each taken back
     * apart (and said so in the log).
     * The pieces taken back, and those the mint says are spent, are stamped spent on the card's row (`cardFiledSpent`), so the
     * list says only what is left; and the row is marked taken back only when nothing is left for later. A card loaded on two
     * dates is taken back twice, each part on its own date: marked taken back after the first, the rest could not be asked for.
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
      // room for the signed pieces' row and the swap after it, before this phone's key signs anything (`cardRoom`)
      var noRoom = cardRoom();
      if (noRoom) return Promise.reject(noRoom);
      var now = Math.floor(Date.now() / 1000);
      var pieces = row.pieces && typeof row.pieces === 'object' ? row.pieces : {};
      var due = [], dueNonces = [], later = 0, soonest = 0;
      Object.keys(pieces).forEach(function (nonce) {
        var x = pieces[nonce];
        if (!x || !x.date) return;
        if (x.date > now) {
          // (not what the mint has said is spent: that is not coming back on any date)
          if (!x.gone && !x.spent) { later += satsOf(x.amount); soonest = soonest ? Math.min(soonest, x.date) : x.date; }
          return;
        }
        try { due.push(cardFiledProof(w, cardKey, row, nonce, x)); dueNonces.push(nonce); } catch (e) {}
      });
      if (!due.length) {
        return Promise.reject(later > 0
          ? cardError('too-soon', 'That card can be taken back after its date.', { date: soonest, sats: later })
          : cardError('nothing', 'Nothing is known to be left on that card.'));
      }
      var CT = window.CashuTS;
      return cardFiledStates(w, cardKey, due)
        .then(function (states) {
          var live = due.filter(function (pr, i) { return states[i] === 'UNSPENT'; });
          var liveNonces = dueNonces.filter(function (n, i) { return states[i] === 'UNSPENT'; });
          cardFiledSpent(cardKey, dueNonces.filter(function (n, i) { return states[i] === 'SPENT'; }));
          var rowUnit = unitOf(row.unit) || 'sat';
          if (!live.length) return Object.assign(cardGot(rowUnit, 0), { hash: '', later: later });
          return nativeJson('p2pkKey', { index: row.refundIndex }, 60000).then(function (j) {
            var key = String((j && j.privkey) || '').toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(key) || String((j && j.pubkey) || '').toLowerCase() !== row.refundKey) {
              throw cardError('no-key', 'This phone\u2019s words do not give the key that card was set up with.');
            }
            // what came back, by unit, and the first row's id
            var totals = {}, firstId = '';
            var done = function () {
              // what was swapped in is off the card's row; the row is taken back once nothing is left for a later date
              cardFiledSpent(cardKey, liveNonces);
              var all = cardsOnFile();
              if (all[cardKey] && !(later > 0)) { all[cardKey].takenBack = Date.now(); save(CARDS, all); }
              Object.keys(totals).forEach(function (u) {
                console.log('[foxy] card: ' + cardSaid(totals[u], u) + ' taken back from a card with this phone\u2019s own key');
              });
              var out = /** @type {any} */ (Object.assign(cardGot(rowUnit, totals[rowUnit] || 0), { hash: firstId, later: later }));
              // the other unit, where a card's row held both (it should not): said apart, never added in
              var also = Object.keys(totals).filter(function (u) { return u !== rowUnit; });
              if (also.length) {
                console.warn('[foxy] card: a card taken back held pieces of more than one unit; each was taken back apart');
                out.also = also.map(function (u) { return cardGot(u, totals[u]); });
              }
              return out;
            };
            // by the unit of each piece's keyset (`keysetUnit`): the row's own where the keyset is not known here
            var byUnit = {};
            live.forEach(function (pr) {
              var u = keysetUnit(row.mint, pr.id, w) || rowUnit;
              (byUnit[u] = byUnit[u] || []).push(pr);
            });
            return Object.keys(byUnit).reduce(function (chain, u) {
              return chain.then(function () { return cardWalletFor(u, w, false); }).then(function (uw) {
                return takeBackIn(uw, u, byUnit[u]);
              });
            }, Promise.resolve()).then(done);
            function takeBackIn(uw, u, mine) {
            totals[u] = totals[u] || 0;
            /* A one-signature card's pieces: this phone's key signs once for
             * the pieces of each date, over the swap they come back in, as
             * the card itself would have (`cardSwapPlan`). */
            // (format 5, a card of 1.23 that held both units, is filed as 4: its secrets are format 4's)
            if (cardAllFormat(row.format)) {
              return cardAllGroups(mine, CARD_SWAP_MOST).reduce(function (chain, group) {
                return chain.then(function () { return cardSwapPlan(uw, group); }).then(function (plan) {
                  // the library's own signer, given the whole message: (proofs, key, logger, message)
                  var by = CT.signP2PKProofs([plan.inputs[0]], key, undefined, plan.message)[0];
                  var one = /** @type {any} */ ({ id: plan.inputs[0].id, amount: plan.inputs[0].amount, secret: plan.inputs[0].secret, C: plan.inputs[0].C,
                                                  witness: typeof by.witness === 'string' ? by.witness : JSON.stringify(by.witness) });
                  var good = false;
                  try { good = CT.isP2PKSpendAuthorised(one, undefined, plan.message) === true; } catch (e) { good = false; }
                  if (!good) throw cardError('too-soon', 'The mint would not take this phone\u2019s key for that card yet.');
                  cardSwapWrite(plan, null);
                  var pieces = [one].concat(plan.inputs.slice(1));
                  var back = Object.assign({ id: 'cardback-' + plan.id, token: encodeToken(mintOf(uw), pieces, u),
                                             worth: sumProofs(pieces), over: 0, all: true, card: cardKey, memo: 'from card', lost: true, at: Date.now() }, cardFig(u, 0));
                  mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).concat([back]));
                  firstId = firstId || back.id;
                  return cardSwapTaken(back).then(function (got) { totals[u] += (got && got.amount) || 0; });
                });
              }, Promise.resolve());
            }
            var signed = CT.signP2PKProofs(mine, key);
            var bad = signed.filter(function (pr) { try { return !CT.isP2PKSpendAuthorised(pr); } catch (e) { return true; } });
            if (bad.length) throw cardError('too-soon', 'The mint would not take this phone\u2019s key for that card yet.');
            var taken = Object.assign({ id: 'cardback-' + piecesFingerprint(signed), token: encodeToken(mintOf(uw), signed, u),
                                        worth: sumProofs(signed), over: 0, all: true, card: cardKey, memo: 'from card', lost: true, at: Date.now() }, cardFig(u, 0));
            mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).concat([taken]));
            firstId = firstId || taken.id;
            return cardSwapTaken(taken).then(function (got) { totals[u] += (got && got.amount) || 0; });
            }
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

    /* Does a load of `sats` fit the card, before anything is made? The keypad
     * asks as the amount is typed (ADD FUNDS), with the card it read a moment
     * ago, and refuses an amount the card has no room for, so THE CARD IS FULL
     * is said at the keypad and not after the tap.
     *
     * The very cut `cardPrepare` makes and refuses on (`cardLoadCut`), in the
     * words it refuses in. Answers { ok, why, sats, rounded, room }: `why`
     * empty when it fits, `sats` what the cut comes to and `rounded` how many
     * of those the places forced on top of the amount asked, `room` the
     * card's free places. Null where the wallet cannot say: no wallet, no
     * card, or one that has not been set up. Local, and at once. */
    /* `sats` is in the card's own unit (cents for a dollar card), whose keyset the cut is made with (`cardWalletNow`). */
    /* (`unit`: on a card of 1.23 the unit the load is in, either of its two; the card as that unit is cut, `cardInUnit`) */
    cardLoadFits: function (card, sats, unit) {
      var want = Math.round(Number(sats));
      if (!(want > 0) || !card || !card.info || !card.info.setUp) return null;
      if (card.units) card = cardInUnit(card, unit || card.record.unit);
      var w = cardWalletNow((card.record && card.record.unit) || 'sat');
      if (!w) return null;
      var cut = cardLoadCut(w, card, want);
      return { ok: !cut.full, why: cut.full ? CARD_FULL_WORDS : '', sats: cut.ladder.sats,
               rounded: cut.ladder.extra, room: cut.room };
    },

    /* Pieces for `sats`, locked to this card, made and filed as owed to it.
     * `card` is what `cardLook` gave. Resolves { id, unit, amount, sats, hash,
     * rounded, pieces }.
     *
     * In the card's own unit: `sats` is the figure in it (cents for a dollar
     * card, which is loaded from this phone's dollars, on the dollar keyset and
     * at its fee, its drawer cut in cents from one cent up). `amount` in the
     * result is that figure, and `sats` the same for a bitcoin card and 0 for a
     * dollar one. `opts.unit`, where given (the unit the amount was typed in),
     * must be the card's: refused (`wrong-unit`) before anything is made. */
    cardPrepare: function (card, sats, opts) {
      /* `opts.moving`: the card is still at another mint and is on its way to
       * this one (`cardMoveLoad`). The pieces are made here, and their row
       * says so, so that the card is told its new mint before they are
       * written (`cardRepointFor`). */
      var moving = !!(opts && opts.moving);
      /* `opts.visit`: made on a card's visit to its own mint, as part of it (`cardLoadAcross`): not held for this phone to be home,
       * which is what everything else started during a visit waits for (99-proof-lock-and-export.js). */
      var onVisit = !!(opts && opts.visit && cardAway);
      /* `opts.only`: the key of the card these pieces are for (a card's swap, whose second tap is held to the card on the screen,
       * 26f-flashcard.js `fcSwapOn`). Any other card read at the tap is refused (`wrong-card`) before anything is made for it, so
       * nothing is owed to it and nothing is written on it. */
      if (opts && opts.only && !(card && card.key === opts.only)) {
        return Promise.reject(cardError('wrong-card', 'That is not the card on the screen. Nothing was put on it.'));
      }
      var want = Math.round(Number(sats));
      if (!(want > 0)) return Promise.reject(cardError('bad-amount', 'Ask for an amount above zero.'));
      var unit = (card && card.record && card.record.unit) || 'sat';
      /* A card of 1.23 holds both units at its one mint: a load of either is made for it, as the card in that unit (`cardInUnit`: its drawer,
       * its rows, its depth), and the card's own table says at the write whether it may take it. Before 1.23 a card takes its own unit alone. */
      var asked = (opts && opts.unit !== undefined && opts.unit !== null && opts.unit !== '') ? unitOf(opts.unit) : '';
      // (a card of 1.23 read without its pieces sorted by unit is sorted here, so it is never taken for a card of its record's unit alone)
      if (card && cardIs123(card) && card.record && !card.units) cardSortUnits(card);
      if (card && card.units && (asked === 'sat' || asked === 'usd' || !asked)) {
        card = cardInUnit(card, asked || unit);
        unit = card.record.unit;
      }
      if (asked && asked !== unit) {
        return Promise.reject(cardError('wrong-unit', 'This card holds ' + balanceWord(unit) + ', so it is loaded from your ' + balanceWord(unit) + '.',
                                        { cardUnit: unit, askUnit: asked }));
      }
      /* Sats for a card of 1.23 that has a limit and no rate, which would refuse them (6A99): said before anything is made, where the card
       * said its rate (to its holder) and this phone is not its owner, which would give it one at the write. */
      if (card && card.info && card.info.units && unit === 'sat' && card.info.rateSaid && !(Number(card.info.rate) > 0) && !card.mine
          && ((Number(card.info.limit) || 0) > 0 || (Number(card.info.tapLimit) || 0) > 0 || (Number(card.info.noPin && card.info.noPin.limit) || 0) > 0)) {
        return Promise.reject(cardError('no-rate', 'This card cannot take bitcoin until its owner’s phone sets it again. Nothing was put on it.'));
      }
      var w0;
      try { w0 = need(); } catch (e) { return Promise.reject(e); }
      var no = cardUnusable(card, w0, null, true);
      if (no && no.card !== 'empty' && !(moving && no.card === 'other-mint')) return Promise.reject(no);
      // a bitcoin card's load is made with the sat wallet at once, as ever; a dollar card's with the dollar wallet
      if (unit === 'sat') return cardPrepareIn(w0);
      return cardWalletFor(unit, w0, false).then(cardPrepareIn);
      function cardPrepareIn(w) {
      if (!card.info.setUp) return Promise.reject(cardError('no-record', 'Set this card up first.'));
      if (card.info.locked) return Promise.reject(cardRefused('6986'));
      /* A card with no owner cannot be loaded: nobody could change its PIN or its
       * limit, and a terminal that had the PIN could never be bounded or
       * corrected. Said before any money is made for it. */
      /* (From software 1.22 a card with a PIN and no owner is a holder's with no phone, and is loaded under that PIN: its
       * numbers are the holder's, set with the PIN.) */
      if (!card.info.owner && !(card.info.guests && card.info.pinSet)) return Promise.reject(cardError('no-owner', 'This card has no owner, so it cannot be loaded.'));
      /* The amount is cut like a cash drawer, to fill the gaps in what the card
       * holds (and has owed to it): the small rungs a few deep for paying small
       * amounts offline with exact change, the big value in a handful of large
       * proofs, and no more than CARD_LOAD_PIECES pieces (about half the card's
       * places), so the rest stay free for an online payment's change. An amount
       * that needs more has a shallower drawer, and is rounded up only where even
       * that is too many; `rounded` says by how much. A few more places are kept
       * for what the mint's fee may add. */
      // a card of 128 places is cut deep instead: eight of each small size, as far as the money goes (`cardDeepLadder`)
      /* And nothing larger than its limit on one tap, where it has one this phone was told
       * (`cardLimitCap`): a payment under the limit is then never made from a piece the
       * card waits for. Where that is more pieces than the places left, the rest goes in
       * larger ones (`cardCutUnder`), and `above` says how much. */
      var cut = cardLoadCut(w, card, want);
      var ladder = cut.ladder;
      if (cut.full) return Promise.reject(cardError('full', CARD_FULL_WORDS));
      if (ladder.above > 0) console.log('[foxy] card: ' + cardSaid(ladder.above, unit) + ' of a top-up go on in pieces above the card\u2019s limit on one tap: the places for smaller ran out');
      /* Whether this mint's ecash fits a card, asked before any is made. It
       * was asked after: the pieces were made, locked to the card, found not
       * to fit, and the error left them filed nowhere. */
      var misfit = cardMintMisfit(w);
      if (misfit) return Promise.reject(misfit);
      var recoverable = !!card.record.refundKey;
      var date = recoverable ? cardDateFor(card) : 0;
      // `ladder.sats` is the cut's figure, in the card's unit (cents for a dollar card)
      return FoxyWallet.sendToken(ladder.sats, { unit: unit, lockTo: card.key, lockUntil: date || undefined,
                                                 refundTo: recoverable ? card.record.refundKey : undefined, sigAll: cardIsAll(card),
                                                 denominations: ladder.denominations, purpose: 'card', cardVisit: onVisit || undefined })
        .then(function (made) {
          var n = cardMade(made);
          /* Filed first, whatever else is true of it. From this line the
           * pieces exist, only this card can spend them, and this row is how
           * they reach it: nothing that can throw comes before it. */
          var row = /** @type {any} */ (Object.assign({ id: made.hash, card: card.key, token: made.token, kind: 'load', forHash: made.hash, at: Date.now() }, cardFig(unit, n)));
          if (moving) { row.mint = mintOf(w); row.repoint = true; }
          mustSave(CARD_OWED, cardStore(CARD_OWED).concat([row]));
          try { amendTx(made.hash, { memo: 'to card', card: card.key }); } catch (x) {}
          try { FoxyWallet.tag(made.hash, { to: 'card' }); } catch (x2) {}
          // what the token must be for the card to take it. Not so, it stays owed, and the error says that it is kept
          try { cardPiecesOf(made.token, card); } catch (e) {
            throw cardError('misfit-kept', String((e && e.message) || 'That ecash does not fit this card.')
              + ' It is kept for the card: nothing is lost, and it cannot be written yet.', Object.assign(cardGot(unit, n), { hash: made.hash }));
          }
          if (recoverable) cardRemember(card, cardPiecesOf(made.token, card));
          console.log('[foxy] card: ' + cardSaid(n, unit) + ' made for a card, in ' + cardPiecesOf(made.token, card).length + ' pieces'
            + (ladder.extra ? ' (' + ladder.extra + ' more than asked, so there are fewer)' : '') + '; to be written at the next tap');
          return Object.assign({ id: row.id }, cardGot(unit, n), { hash: made.hash, rounded: ladder.extra, pieces: cardPiecesOf(made.token, card).length });
        });
      }
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
      var pinGiven = !(o.pin === undefined || o.pin === null || o.pin === '');
      /* No PIN given is a card with none (software 1.16): found out below, once the card is read, and written to by whoever
       * holds it, as the card takes it: no PIN and no grant. A card that has a PIN is refused as before, for want of one. */
      if (!o.owner && !o.change && pinGiven) { try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); } }
      var t = cardTalk(link);
      var wrote;
      var asOwner = !!o.owner;
      /* A till putting change back (or anything, under the PIN) reads a card
       * of 128 places the short way, before and after: it wants what the card
       * comes to and nothing else of what is on it. Its owner's phone reads
       * it whole, as it always has. */
      /* Its owner's phone too, now: what it writes it writes down itself
       * (`cardWriteOwed`), and what else is on the card it reads whole on
       * the card's own screen, which is where the bookkeeping is. */
      var how = { short: true };
      return cardLook(link, how).then(function (card) {
        if (card.info.pin === 'blocked') throw cardRefused('6983');
        if (!o.owner && !o.change && !pin && card.info.pinSet) throw cardError('bad-pin', 'A card PIN is 4 to 8 digits.');
        if (asOwner && !card.info.owner) throw cardRefused('6a90');
        // not the tap after a payment after all (a read came between, say): the PIN is what writes
        if (o.change && !o.owner && !card.info.changeDue) throw cardRefused('6982');
        // what was found for this card is asked of the mint before any of it is written
        return cardOwedPrune(card).then(null, function () { return 0; }).then(function () {
          if (o.change && !o.owner) return null;
          // a card with no PIN (1.16) is written by whoever holds it: nothing to give
          if (!asOwner && !pin) return null;
          /* (1.23: under the PIN, and with the owner's grant too where this phone is the card's owner, as before every ADD FUNDS of such a
           * card: the holder's say in the tap, which a new currency on it wants and marks; a phone that is not its owner loads under the
           * PIN alone, as a till does) */
          if (!asOwner) {
            return cardVerify(t, card, pin).then(function () {
              card.pinGiven = true;
              if (!(cardIs123(card) && card.info.owner)) return null;
              return cardGrant(t, card.key).then(function (yes) { if (yes) { card.granted = true; card.mine = true; } }, function (e) {
                if (e && e.card === 'gone') throw e;
              });
            });
          }
          return cardGrant(t, card.key).then(function (yes) {
            if (!yes) throw cardRefused('6a91');
            // (1.23: the holder's say in this tap, which marks a keyset it enters, and lets this phone give the card a rate it lacks, `cardLoadSend`)
            card.granted = true;
          });
        }).then(function () {
          return cardRepointFor(t, card);
        }).then(function () {
          // (1.23: the price a rate is written at where the card wants one, and the held tap's askings for the screen)
          card.price = o.price;
          card.onHold = o.onHold;
          return cardWriteOwed(t, card, o.progress);
        });
      }).then(function (r) {
        wrote = r;
        // after the write, what the card comes to: the short way for an owner as for a till
        return cardLook(link, asOwner ? { mine: true, short: true } : { short: true });
      }).then(function (card) {
        // a short read lists no nonces, and says nothing of which pieces have left the card
        if (!card.bare && card.record.refundKey && cardsOnFile()[card.key]) cardRemember(card, card.pieces, true);
        // what went on, in the card's unit: `amount`, and `sats` for a bitcoin card only (`back`, `change` and `refund` are in it too)
        var out = /** @type {any} */ ({ card: card, unit: wrote.unit || 'sat', amount: wrote.amount || 0, sats: wrote.sats, back: wrote.back || 0, change: wrote.change || 0, refund: wrote.refund || 0,
                 left: wrote.left.length, why: wrote.why || '' });
        // (a card of 1.23 written in both units in the tap: the other, apart)
        if (wrote.also) out.also = wrote.also;
        return out;
      });
    },

    /* Both, in one tap: read the card, make the pieces, write them (`opts.owner`
     * or `opts.pin`, as `cardWrite`). The figure is `opts.amount` or `opts.sats`,
     * in the card's unit, and `opts.unit` (where given) must be the card's
     * (`cardPrepare`). */
    cardAdd: function (link, opts) {
      var o = opts || {};
      if (!o.owner && !(o.pin === undefined || o.pin === null || o.pin === '')) { try { cardPinHex(o.pin); } catch (e) { return Promise.reject(e); } }
      // the short way, as its owner: the cut needs the sizes of what is on the card, its room and its limit, not the pieces themselves
      return cardLook(link, { short: true, mine: true }).then(function (card) {
        // a card that has a PIN is written with it, or by its owner's grant: said before any money is made for it
        if (!o.owner && (o.pin === undefined || o.pin === null || o.pin === '') && card.info.pinSet) throw cardError('bad-pin', 'A card PIN is 4 to 8 digits.');
        return FoxyWallet.cardPrepare(card, (o.amount !== undefined && o.amount !== null) ? o.amount : o.sats, { unit: o.unit });
      }).then(function () {
        return FoxyWallet.cardWrite(link, { owner: !!o.owner, pin: o.pin, price: o.price, onHold: o.onHold });
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
      // a dollar card's money crosses only through this phone (a guard: the screen refuses first)
      if (opts && (unitOf(opts.unit) === 'usd' || (opts.card && opts.card.record && opts.card.record.unit === 'usd'))) {
        return Promise.reject(cardError('wrong-unit', 'A card\u2019s dollars move between mints only through this phone.', { cardUnit: 'usd' }));
      }
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
      if (card && card.record && card.record.unit === 'usd') {
        return Promise.reject(cardError('wrong-unit', 'A card\u2019s dollars move between mints only through this phone.', { cardUnit: 'usd' }));
      }
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
      // read the short way: whether it holds anything is all that is asked of what is on it
      return cardLook(link, { short: true }).then(function (card) {
        if (card.info.pin === 'blocked') throw cardRefused('6983');
        if (!card.info.setUp) throw cardError('no-record', 'Set this card up first.');
        if (canonicalMint(card.record.mint) === here) return null;
        if (card.pieces.length) throw cardError('in-use', 'This card still holds money at ' + hostOf(card.record.mint) + '. Take that off it first.');
        // a dollar card goes only to a mint that issues dollars, and keeps its unit there
        if (card.record.unit === 'usd' && unitsOf(here, w).indexOf('usd') < 0) {
          throw cardError('no-dollars-here', hostOf(here) + ' does not issue dollars. RESET this card and set it up again to hold bitcoin there.');
        }
        if (!card.info.owner) throw cardRefused('6a90');
        var record = cardRecordHex(card.record.refundKey, here, cardCanDesign(card) ? card.record.design : '', card.record.unit);
        return cardOwned(t, card.key, 'set-card', record).then(function (data) {
          return t.want(cardCommand(CARD_INS.setCard, 0, data), 'its new mint');
        }).then(function () {
          console.log('[foxy] card: an empty card moved from ' + hostOf(card.record.mint) + ' to ' + hostOf(here));
        });
      }).then(function () { return FoxyWallet.cardLook(link); });
    },

    // how long an owner's tap waits for the mint's word on the change a card is owed, in milliseconds; the suites set it short
    _cardFetchWait: CARD_FETCH_WAIT,

    /* What is waiting to be written onto cards: [{ id, card, sats, kind, mint, out, payment }]. Not what cannot be: a card's
     * own change (1.12) that its card no longer has the means to finish (`cardStuck`) is kept, and not promised. `out`: it
     * came of a payment the card made out of this phone (SEND on its screen), whose card was gone by the time it was owed;
     * `payment`, that payment's entry where it is its change. */
    /* Each in its own unit (`unit`, `amount`; `sats` the same for a bitcoin card's row and 0 for a dollar card's). */
    cardOwed: function () {
      return cardStore(CARD_OWED).filter(function (r) { return r && !r.stuck; }).map(function (r) {
        var at = r.mint || '';
        if (!at && r.token) { try { at = (FoxyWallet.tokenInfo(r.token) || {}).mint || ''; } catch (e) { at = ''; } }
        return Object.assign({ id: r.id, card: r.card }, cardGot(cardRowUnit(r), cardRowAmt(r)),
                             { kind: r.kind, forHash: r.forHash || '', mint: at ? canonicalMint(at) : '',
                               out: !!(r.outBack || r.outChange), payment: r.payment || '' });
      });
    },
    /* The card's own change that could not be finished and is kept: [{ id, card, sats, forHash, why, blind }], `blind`
     * being what the mint signed for each output (the blinded message, its signature and the key), which is what
     * a restore of the card's openings by the owner's phone (NUT-09) would be given. */
    cardStuck: function () {
      return cardStore(CARD_OWED).filter(function (r) { return r && r.stuck; }).map(function (r) {
        return Object.assign({ id: r.id, card: r.card }, cardGot(cardRowUnit(r), cardRowAmt(r)),
                             { forHash: r.forHash || '', why: r.why || '', blind: (r.blind || []).slice() });
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
     *      (its sheet ends, "Done."): its part is over. Foxy's
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
     * `opts.pin` is optional (software 1.16): with none, the card is shown none, and signs if it has no PIN or its no-PIN
     * allowance covers the payment. Otherwise it rejects with `pin-needed`, with nothing asked of the card or nothing left
     * pending (`early: true` when the read said so before the card was asked, `sw: '6a94'` when the card did), and the
     * sheet it ends reads `Enter the card's PIN`; the card is then tapped again with `opts.pin`.
     *
     * `opts.on(step)` is told 'reading', 'signing', 'checking' (the card has been
     * let go), 'making' (the change), 'done' for the screen; with `hold`, 'mint'
     * and 'change' for the same. Resolves { sats, hash, change: { sats, written } }. */
    /* `opts.holdFor` and `opts.only`: the card paying out of this phone (SEND from its own screen, 26f-flashcard.js). The tap is a
     * till's in every way, and the pieces the swap gives for the price are held for the payment (`cardOutHold`): the result
     * names the hold (`held`, `heldSats`) for `pay` to melt. `only` is the key of the card on the screen, and any other card is
     * refused (`wrong-card`) before anything is asked of it. */
    /* In a unit: a card holds bitcoin or dollars, and pays only the kind it holds. `opts.asks` is what the till takes, one
     * figure a unit ([{ unit, amount, terms }]: a dollar receive that would take sats as well, say), and the card's unit
     * says which is paid; `opts.sats` alone is [{ unit: 'sat', amount: sats }], as every caller before dollar cards (and
     * `opts.unit` with it names another unit). `terms`, on the ask a card pays: what was agreed for it in the other unit,
     * which a payment kept with no route writes on its entry. With no ask in the card's unit it is refused before any PIN
     * or BEGIN: `other-unit` for a dollar card asked for sats at a mint that issues both (with `unit`, `asked`, `balance`
     * in cents, `mint`, `pinSet`, `noPinLeft` and `key`, for the screen to work out a figure in dollars the holder agrees
     * to), `wrong-unit` for a bitcoin card asked for dollars. A dollar card at a mint that no longer issues dollars is
     * `no-dollars-here`, and with no route, one this phone holds no dollar keys for is `offline-no-keys`. Every figure of
     * the result is in the card's unit: `unit`, `amount`, and `sats` the same for a bitcoin card and 0 for a dollar card
     * (`change`, `heldAmount` likewise); every refusal once the card is read has `cardUnit`. */
    cardPay: function (link, opts) { return cardTake(link, opts || {}, 'card'); },
    // paying out of this phone from a card: what it costs, the way back, the ones left behind, and a payment done with its hold
    // (`unit`: the card's, whose keyset's fee it is; sats when not named)
    cardOutTotal: function (amount, reserve, unit) { return cardOutTotal(amount, reserve, unit); },
    // a till paid by a card at another mint: what that mint asks for the till's invoice, in the card's unit (`cardCrossQuote`)
    cardCrossQuote: function (at, bolt11, unit, card) { return cardCrossQuote(at, bolt11, unit, card); },
    // a card at another mint loaded from this phone: what it costs, asked of both mints (`cardLoadCrossQuote`), and the load made (`cardLoadAcross`)
    cardLoadQuote: function (at, amount, opts) { return cardLoadCrossQuote(at, amount, opts); },
    /* The same plan's invoice, paid from this phone's other balance (`payUnit`): this phone's mint asked again, the card's mint not. */
    cardLoadRepay: function (plan, payUnit) {
      if (!plan || !plan.invoice || !plan.mintQuote) return Promise.reject(new Error('No load to quote.'));
      return cardLoadCrossPay(plan, unitOf(payUnit) || 'sat');
    },
    cardLoadAcross: function (plan, card, onStage) { return cardLoadAcross(plan, card, onStage); },
    /* this phone at a card's mint for what is done there, and home after (`cardVisit`: resolves { end }, `end()` resolving once
     * home); whether a card's visit has it away now; and what card payments left at other mints, settled there (`cardAwayLeft`) */
    cardVisit: function (at) { return cardVisit(at); },
    cardAwayNow: function () { return cardAway ? cardAway.mint : ''; },
    cardAwayLeft: function (opts) { return cardAwayLeft(opts); },
    cardOutBack: function (id) { return cardOutBack(id); },
    // a hold for this phone's own invoice whose payment was not made: this phone's, into its pile (`cardOutKeep`)
    cardOutKeep: function (id) { return cardOutKeep(id); },
    cardOutsLeft: function () { return cardOutsLeft(); },
    cardOutDone: function (id) { cardOutDone(id); },
    cardOutHeld: function () {
      var all = load(K.held, {});
      return Object.keys(all).filter(function (id) { return all[id] && all[id].kind === 'card out'; })
        .map(function (id) { return Object.assign({ id: id, card: all[id].card }, cardGot(recordUnit(all[id]), sumProofs(all[id].proofs || [])), { at: Number(all[id].at) || 0 }); });
    },
    /* A withdrawal that holds the card (`opts.hold`) ends by reading it once
     * more, for its holder's screen (`card` on the result). Only this one: a
     * till being paid learns no more of a card than it needs. A card that has
     * left by then is no failure: the money moved, and the result simply has no
     * card on it. One that was let go when it had signed is not read again, and
     * its result carries the card as the tap knows it instead: what was read at
     * its start less the pieces it signed for (`cardAfterTake`). It is on the
     * error too, if the mint has not answered (`after`, on `waiting`). */
    /* (A card of 1.23 that holds both units: `opts.unit` the one taken from, `opts.sats` in it; all of it with no unit named is both, one
     * after the other in the same tap, the second said in `also` (in its own unit, never added in) and its entry in `alsoHash`.) */
    cardWithdraw: function (link, opts) {
      var o0 = opts || {};
      // the holder's own: where this phone is the card's owner, the day's limit is lifted, with its proof, for the taking, and put back
      return cardTake(link, Object.assign({ all: !(opts && opts.sats), lift: true }, opts || {}, o0.unit ? { from: o0.unit } : {}), 'from card').then(function (r) {
        if (!(r && r.more)) return r;
        return cardTake(link, Object.assign({}, o0, { all: true, lift: true, sats: undefined, from: r.more }), 'from card').then(function (r2) {
          r.also = [cardGot(r2.unit, r2.amount)];
          r.alsoHash = r2.hash;
          if (r2.card) r.card = r2.card;
          return r;
        }, function (e) {
          // the first unit is in this phone; the other is still on the card, and the next taking-off takes it
          console.warn('[foxy] card: its ' + balanceWord(r.more) + ' did not come off in the same tap:', (e && e.message) || e);
          r.moreLeft = r.more;
          return r;
        });
      }).then(function (r) {
        // the card has been let go once it signed (`opts.hold` keeps it), and is not read again: the next tap shows it as it is
        if (!(opts && opts.hold)) return r;
        return FoxyWallet.cardLook(link, { mine: true }).then(function (card) { r.card = card; return r; }, function () { return r; });
      });
    },

    /* A card's money given a new date, in one tap: all of it off the card and
     * on again. The pieces that come back carry a date thirty days from now, which
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
        // in the card's own unit: cents for a dollar card
        /* (a card of 1.23 that held both: each comes off in its own unit, `got.also`, and each goes back on in it, made apart and written in
         * the one tap) */
        return cardLook(link).then(function (card) {
          var again = [{ unit: got.unit || 'sat', amount: got.amount }].concat(Array.isArray(got.also) ? got.also : []).filter(function (x) { return x && x.amount > 0; });
          if (!card.units) return FoxyWallet.cardPrepare(card, got.amount);
          // (one currency came off: it goes back on in that one, which is not always the record's)
          if (again.length < 2) return FoxyWallet.cardPrepare(card, got.amount, { unit: got.unit || 'sat' });
          return again.reduce(function (chain, x) {
            return chain.then(function (prev) {
              return FoxyWallet.cardPrepare(card, x.amount, { unit: x.unit }).then(function (m) { if (prev) hashes.push(prev.hash); return m; });
            });
          }, Promise.resolve(/** @type {any} */ (null)));
        });
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
    /* What a card holds in pieces larger than its limit on one tap, as its owner read it: a till holds longer for those. */
    cardAboveLimit: function (card) { return cardAboveLimit(card); },
    /* What a card cut deep holds, in its record's currency, in pieces larger than `limit` (in `unit`, the record's where not named: cents for
     * 'usd'), for the screen's line and the limit's confirmation. On a card of 1.23 the limit and each piece are weighed in cents, as the card
     * weighs them, at the card's rate where it said it, else this phone's price (`price`); a piece with no rate to weigh it at counts for
     * nothing. A card before 1.23 compares the figures as they are. */
    cardAboveFor: function (card, limit, unit, price) {
      if (!card || !card.info || !card.info.wide || !card.info.many) return 0;
      var lim = Math.max(0, Math.round(Number(limit) || 0));
      if (!(lim > 0)) return 0;
      var ru = (card.record && card.record.unit === 'usd') ? 'usd' : 'sat';
      var pieces = (card.units && card.units[ru]) ? card.units[ru].pieces : (card.pieces || []);
      if (!card.info.cents) return pieces.reduce(function (n, x) { return satsOf(x.amount) > lim ? n + satsOf(x.amount) : n; }, 0);
      var rate = cardRateNow(card, price);
      var limSaid = cardCentsOf(lim, unit ? (unitOf(unit) || 'sat') : ru, rate);
      if (limSaid === null) return 0;
      var limC = Number(limSaid);
      return pieces.reduce(function (n, x) {
        var c = cardCentsOf(x.amount, ru, rate);
        return (c !== null && c > limC) ? n + satsOf(x.amount) : n;
      }, 0);
    },

    cardCheck: function (card) {
      var w;
      try { w = need(); } catch (e) { return Promise.reject(e); }
      if (!card || !card.pieces || !card.pieces.length) return Promise.resolve({ sats: 0, spent: 0 });
      // a short read lists sizes and no nonces: there is nothing to ask the mint about
      if (card.bare) return Promise.resolve({ sats: card.balance, spent: 0, at: 0, unchecked: true });
      if (canonicalMint(card.record.mint) !== mintOf(w)) {
        return Promise.reject(cardError('other-mint', 'This card\u2019s money is at ' + hostOf(card.record.mint) + '.', { mint: canonicalMint(card.record.mint) }));
      }
      if (!routeOpen()) return Promise.reject(cardError('no-route', 'There is no connection to the mint.'));
      var proofs = card.pieces.map(function (x) { return cardProofOf(x, card.key, card.record.refundKey, cardFullId(w, x.keyset), card.info.format); });
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

    /* Whether the pieces of a card of software 1.20 are real, which the mint's word that they are unspent does not say: the mint's proofs
     * the card was read for (`cardLook`'s `opts.real`) are checked with the keys this wallet has (08a-flashcard.js, `cardRealCheck`).
     * Resolves 'ok' (every piece on the card is real), 'fake' (a proof does not verify) or 'unproven' (not every piece is shown real, and
     * none is shown false); null for a read that lists no nonces (`bare`). Never rejects. What it finds real is kept by nonce. */
    cardRealCheck: function (card) { return cardRealCheck(wallet, card); },

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
      return cardStore(CARD_DUE).map(function (d) { return Object.assign({ forHash: d.forHash, card: d.card }, cardGot(cardRowUnit(d), Math.round(Number(d.owed) || 0))); });
    },

    /* A payment a card left part way through and this phone holds for its next
     * tap (`cardHeld`): { card, held, want, at, fresh } or null. `cardHeldLetGo(key)`
     * gives it back instead (all held, with no key): what it signed is made into
     * pieces for the card and owed to it. Resolves { sats, made }. */
    cardHeldPayment: function (key) {
      var r = cardHeld(key);
      // `held` and `want` in the card's unit (`unit`)
      return r ? { card: r.card, unit: cardRowUnit(r), held: Number(r.worth) || 0, want: Number(r.resume.want) || 0, at: Number(r.at) || 0, fresh: cardHeldFresh(r) } : null;
    },
    /* Signatures this phone asked a card for and never saw: how many are still open (`cardAskedBack`). */
    cardAskedOpen: function () { return cardStore(CARD_SWAPS).filter(function (r) { return r && r.asked; }).length; },
    /* The limit on one payment, as its holder set it: the dollars, or 0 (`cardPaceNote`); and what a payment
     * that leaves the card for `sats` waits on a card of software 1.13 or later with that limit, in seconds: `made`, how many
     * pieces of change the card is asked to make (each counts as one signature done on the card of 1.13, two for every three
     * on a card that is `costed`, 1.14 and on: `info.costed`), and `second`, that a payment has been signed in the same time
     * in the field already and the owner's grant is not in the tap (`cardWaitSigns`). */
    cardPaceUsd: function (key) { var r = cardPaceAll()[key]; return (r && r.usd > 0) ? r.usd : 0; },
    // and the no-PIN allowance's (software 1.16): the dollars it was set in, or 0
    cardNoPinUsd: function (key) { var r = cardPaceAll()[key]; return (r && r.noPinUsd > 0) ? r.noPinUsd : 0; },
    /* `over` (the sixth): the card's `info.waitOver`, the signatures for the first limit's worth over (7 to software 1.16, 10 from 1.17);
     * without it the answer is by the older rule. */
    cardWait: function (limit, sats, made, second, costed, over) { return cardWaitSeconds(cardWaitSigns(limit, sats, made, second, costed, over)); },
    /* The receipts this phone has read from its own card: [{ n, time, sats, hash, out }], oldest first (08a-flashcard.js). */
    cardReceipts: function (key) { var r = cardReceiptsAll()[key]; return (r && Array.isArray(r.list)) ? r.list.slice() : []; },
    /* With no key, the cards held may hold different units, and sats and cents are never added together: the answer is the
     * first unit's, and `also` the rest, [{ unit, amount, sats, made }] a unit (as `cardTakeBack` answers). */
    cardHeldLetGo: function (key) {
      var w = null;
      try { w = need(); } catch (e) { w = null; }
      var rows = cardStore(CARD_TAKEN).filter(function (r) { return r && r.resume && (!key || r.card === key); });
      var by = {}, order = [];
      return rows.reduce(function (chain, r) {
        return chain.then(function () {
          return cardHeldRelease(r, w).then(function (x) {
            var u = x.unit || cardRowUnit(r);
            if (!by[u]) { by[u] = { amount: 0, made: false }; order.push(u); }
            by[u].amount += x.amount || 0;
            by[u].made = by[u].made || !!x.made;
          });
        });
      }, Promise.resolve()).then(function () {
        if (!order.length) return Object.assign(cardGot('sat', 0), { made: false });
        var each = order.map(function (u) { return Object.assign(cardGot(u, by[u].amount), { made: by[u].made }); });
        return each.length > 1 ? Object.assign(each[0], { also: each.slice(1) }) : each[0];
      });
    },

    /* Signed pieces the mint has not answered for yet: [{ id, sats, card }]. */
    cardTaken: function () {
      return cardStore(CARD_TAKEN).map(function (r) { return Object.assign({ id: r.id }, cardGot(cardRowUnit(r), cardRowAmt(r)), { card: r.card }); });
    },

    /* Ask the mint again about each. Resolves [{ id, state: 'paid' | 'spent' | 'bad' | 'putback' | 'waiting', sats }];
     * `bad` is pieces the mint never signed, `putback` a refusal with some of the pieces
     * still good: they are owed back to the card (`owed`, and `limited` where its day
     * stays charged for them). */
    cardSettle: function () {
      var out = [];
      /* A TAKEN row a card's payment kept with no route left behind (a tap cut off before its last step) is that payment's
       * copy, not another payment: struck here first, never posted (`cardKeptTidy`, 08a-flashcard.js). */
      try { cardKeptTidy(); } catch (eTidy) { console.warn('[foxy] card: kept payments could not be looked over:', (eTidy && eTidy.message) || eTidy); }
      var here = '';
      try { here = canonicalMint(mintOf(need())); } catch (eHere) { here = ''; }
      return cardStore(CARD_TAKEN).reduce(function (chain, row) {
        return chain.then(function () {
          /* A row of a card at another mint than this phone's (one that paid this phone from there, 26f-flashcard.js `fcXmPay`)
           * is settled at that mint, on a visit (`cardAwayLeft`): asked here, its pieces would be taken for this mint's, and what
           * it owes the card made from this mint's pile. */
          var rowAt = cardRowMint(row);
          if (here && rowAt && rowAt !== here) { out.push(Object.assign({ id: row.id, state: 'waiting', away: rowAt }, cardGot(cardRowUnit(row), 0))); return null; }
          /* A payment the card left part way through, held for its next tap
           * (`cardHeld`): left alone while it is fresh, and given back once it
           * is not. */
          if (row && row.resume) {
            if (cardHeldFresh(row)) { out.push(Object.assign({ id: row.id, state: 'held' }, cardGot(cardRowUnit(row), 0))); return null; }
            var wl = null;
            try { wl = need(); } catch (x0) { wl = null; }
            return cardHeldRelease(row, wl).then(function (r) { out.push({ id: row.id, state: 'released', unit: r.unit, amount: 0, sats: 0, owed: r.amount, refund: true, made: r.made }); });
          }
          /* Found paid: what it owes the card back (its over-payment, or all of a
           * refund) is made now, as the tap would have made it, and waits for the
           * card's next tap. Missing, a receiver whose answer was lost kept it. */
          return cardSwapTaken(row, true).then(function (r) {
            var w = null;
            try { w = need(); } catch (x) { w = null; }
            /* A card paying out of this phone (`row.send`) whose answer came late: the payment it was for was never made, so
             * none of it is this phone's. All of it goes back to the card, as a refund does. */
            var owing = row.send ? Object.assign({}, row, { refund: true }) : row;
            var owe = w ? cardOweBack(owing, w, null, null, r) : Promise.resolve({ amount: 0 });
            // the change the card made for itself (1.12) is owed to it already, and goes back with any made here
            var itself = function () { return row.all ? 0 : cardBlindOwed(row.id).amount; };
            // in the row's unit: `amount`, and `sats` for a bitcoin card's only
            return owe.then(function (o) {
              out.push(Object.assign({ id: row.id, state: 'paid' }, cardGot(r.unit, r.amount), { change: ((o && o.amount) || 0) + itself(), refund: !!(row.refund || row.send), send: !!row.send }));
            }, function () {
              out.push(Object.assign({ id: row.id, state: 'paid' }, cardGot(r.unit, r.amount), { change: itself(), refund: !!(row.refund || row.send), send: !!row.send }));
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
      var said = { stage: String(ev.stage || ''), text: String(ev.text || '') };
      // a card read at this tap says its design ('seen'), for the screen behind the sheet to draw it as itself
      if (ev.design !== undefined) said.design = String(ev.design || '');
      try { fn(said); } catch (e) { console.warn('[foxy] card progress watcher:', e && e.message); }
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

    /* `opts.again(e)`: where `fn` failed because the card left part way through
     * and what was done stands (a payment held, a withdrawal kept, pieces
     * written), the line for the sheet to ask for the card again with, and
     * '' otherwise. The sheet then stays up and looks for the card
     * (`link.again`), and `fn` runs again in it: the person sees the same sheet
     * ask for the card, not a sheet that ends in red and a card to press. A
     * sheet dismissed or timed out while it looks rejects with `fn`'s error and
     * `sheetClosed`, and the screen says what is left. */
    cardSession: function (text, fn, opts) {
      var link = {
        released: false,
        // what is true of the card for as long as this sheet is up, and no longer (08a-flashcard.js, `cardProvedHere`)
        one: {},
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
          return bridgeAsk('cardEnd', { text: String(line || 'Done.') }, 5000).then(function () {}, function () {});
        },
        /* The card left part way through: the sheet stays up and looks for it
         * again (`cardAgain`). Resolves when a card is there. Rejects
         * `cancelled` when the sheet was dismissed or timed out, and with
         * `unsupported` from a phone whose native side has no such step. */
        again: function (line) {
          if (link.released) return Promise.reject(cardError('cancelled', 'The card was not tapped.'));
          return bridgeAsk('cardAgain', { text: String(line || 'Tap behind the phone.') }, 63000).then(function () {
            // a card back in the field is powered up afresh: it has not been told the time this time (its key, if the same card, is proved still)
            // and it has signed nothing in it (`cardPaid`: a second payment in one time in the field waits)
            link.one.told = false; link.one.key = ''; link.one.paid = 0;
          }, function (e) {
            var x = cardError('cancelled', 'The card was not tapped.');
            x.unsupported = /unknown action/i.test(String((e && e.message) || ''));
            throw x;
          });
        },
      };
      /* A tap that goes on to the mint opens the road to it as the sheet opens
       * (`opts.warm`), while the card is found and read and signs: the swap that
       * comes after takes the circuit made ready, and is not the one that waits
       * for a new one (`warmMint`). */
      if (opts && opts.warm) { try { FoxyWallet.warmMint(); } catch (e) {} }
      // and the newest block header, if the one kept is old: for the next tap, not this one (`cardClock`)
      headerSoon();
      var ended = function (e) {
        /* `e.sheetText`: the flow put things right in the sheet before it
         * failed (a refused payment's pieces put back on the card), and the
         * sheet ends saying so, not in red. */
        if (e && e.sheetText) return bridgeAsk('cardEnd', { text: String(e.sheetText).slice(0, 110) }, 5000).then(function () { throw e; }, function () { throw e; });
        /* A refusal the app's own screen explains (the card holds the other currency, is at another mint, has not enough, wants
         * its PIN, is somebody else's): the sheet ends with its tick and "Card read", and the screen says the rest. Red is for the
         * card itself going wrong: taken away too soon, lost, the sheet cancelled, a chip error. Taken away too soon includes a card
         * not held long enough (`keep-holding`, 6A98) and one taken away before it signed for all of it (`partial`). Red too for a
         * card that is not what it claims (`fraud`): a fake, a piece with a bad signature or the wrong signer, or pieces a copy of
         * the card has already spent; a tick on such a card would be the wrong word. */
        var physical = { gone: 1, cancelled: 1, interrupted: 1, partial: 1, 'keep-holding': 1, lost: 1, timeout: 1, unknown: 1, chip: 1 };
        var fraud = { fake: 1, 'bad-signature': 1, 'wrong-signer': 1, spent: 1 };
        if (e && e.card && !physical[String(e.card)] && !fraud[String(e.card)]) return bridgeAsk('cardEnd', { text: 'Card read' }, 5000).then(function () { throw e; }, function () { throw e; });
        var say = (e && e.card === 'gone') ? 'Card taken away too soon.' : String((e && e.message) || 'That did not work').slice(0, 90);
        return bridgeAsk('cardEnd', { error: say }, 5000).then(function () { throw e; }, function () { throw e; });
      };
      var tries = 0;
      /* The error that said what was kept (a payment held, a withdrawal taken
       * part way): a later tap of the same sheet that only lost the card again
       * says nothing new, and must not hide it. */
      var kept = null;
      var worst = function (e) { return (kept && e && (e.card === 'gone' || e.card === 'cancelled') && e !== kept) ? kept : e; };
      var run = function () {
        return Promise.resolve().then(function () { return fn(link); }).then(function (r) {
          if (link.released) return r;
          // `link.doneText`: what the sheet ends with, where `fn` has more to say than "done" (the change back on the card)
          return bridgeAsk('cardEnd', { text: String(link.doneText || 'Done.') }, 5000).then(function () { return r; }, function () { return r; });
        }, function (e) {
          // the sheet was ended when the card was let go, and has nothing to say about what came after
          if (link.released) throw e;
          if (e && (e.resumable || e.card === 'partial')) kept = e;
          var line = '';
          try { line = (opts && typeof opts.again === 'function' && tries < 6) ? String(opts.again(e) || '') : ''; } catch (x0) { line = ''; }
          if (!line) return ended(worst(e));
          tries += 1;
          return link.again(line).then(run, function (x) {
            // a phone with no such step: closed as it always was, and the screen takes it up
            if (x && x.unsupported) return ended(worst(e));
            var said = worst(e);
            try { said.sheetClosed = true; } catch (x1) {}
            throw said;
          });
        });
      };
      return bridgeAsk('cardBegin', { text: String(text || 'Tap behind the phone.') }, 63000).then(run, function (e) {
        var why = String((e && e.message) || '');
        if (/not available|cannot read|no nfc/i.test(why)) throw cardError('no-nfc', 'This phone cannot read a card.');
        throw cardError('cancelled', /timed out|did not answer/i.test(why) ? 'No card was tapped.' : 'The card was not tapped.');
      });
    },

