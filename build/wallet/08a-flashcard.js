  /* ---- a card that holds ecash (the Foxy card) ----------------------------
   *
   * A JavaCard that keeps pieces of ecash locked to a key only it holds, and
   * signs for one when it is tapped and its PIN is right. The applet is a fork
   * of cashu-javacard; what it does and why is in the card's own repository,
   * https://github.com/getfoxy/card (docs/FOXY-CARD-SPEC.md). Here are the parts of it that are only reading
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
   * A card of format 4 signs once for a whole payment, and its pieces' secrets
   * end with one more tag, `["sigflag","SIG_ALL"]` (`cardSignAll`, below);
   * tests/fixtures/flashcard-vectors-4.json is that applet's output.
   *
   * It is also, to the character, what cashu-ts writes for a piece locked to
   * one key (with or without a locktime and one refund key, and with that
   * flag where it is asked for). That is on
   * purpose, and the same test holds it: a card is loaded with an ordinary
   * locked send, and the pieces that send makes are the pieces the card can
   * sign for. An update to the library that wrote the text another way would
   * make pieces no card could spend, and fails that test first. */
  var CARD_FORMAT = 3;
  /* And the format of a card that signs once for a whole payment (NUT-11
   * SIG_ALL): every piece's secret ends with that flag as its last tag, and the
   * card's one signature is over all the pieces and all the outputs they are
   * swapped for (`cardSignAll`). Both kinds of card are read here; a piece is
   * written the way its own card writes it. */
  var CARD_FORMAT_ALL = 4;
  /* And the format a card of software 1.23 says while it holds a keyset of the other unit than its record's (dollars and sats at its
   * one mint, the card repository's docs/FOXY-CARD-KEYSETS.md): its pieces' secrets are format 4's, and its table has to be read
   * before a piece can be counted (`cardTableOf`). Every comparison of a format with 4 takes 5 as the same (`cardAllFormat`). */
  var CARD_FORMAT_UNITS = 5;
  function cardAllFormat(format) { var f = Number(format); return f === CARD_FORMAT_ALL || f === CARD_FORMAT_UNITS; }
  var CARD_SLOT_BYTES = 82;
  var CARD_PIECE_BYTES = 81;
  /* A mint's address as the card keeps it: 80 characters at the most, so that
   * the owner's proof and the whole record fit one command (the card's spec,
   * docs/FOXY-CARD-DAILY-LIMIT.md in https://github.com/getfoxy/card, section 4). */
  var CARD_MINT_MAX = 77;   // 80 before the design (card software 1.10): the proof, the record, the mint and it in one APDU
  var CARD_DAY = 86400;

  function cardHexOk(s, bytes) {
    return typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]*$/.test(s);
  }

  /* A piece's NUT-10 secret, as the card rebuilds it. `date` is its locktime
   * in seconds, 0 for none; with a date the refund key is named too. Throws on
   * anything that is not what a card could hold, since a secret built from a
   * wrong field is a piece nobody can spend. */
  function cardSecret(nonce, cardKey, date, refundKey, format) {
    var when = Number(date) || 0;
    var all = cardAllFormat(format);
    if (!cardHexOk(nonce, 32)) throw new Error('That is not a card piece: its nonce is not 32 bytes.');
    if (!cardHexOk(cardKey, 33) || !/^0[23]/.test(cardKey)) throw new Error('That is not a card’s key.');
    if (!(when >= 0 && when <= 4294967295 && Math.floor(when) === when)) throw new Error('That is not a date a card can hold.');
    var text = '["P2PK",{"nonce":"' + nonce + '","data":"' + cardKey + '","tags":[';
    if (when) {
      if (!cardHexOk(refundKey, 33) || !/^0[23]/.test(refundKey)) throw new Error('A piece with a date needs the key that can take it back.');
      text += '["locktime","' + String(when) + '"],["refund","' + refundKey + '"]' + (all ? ',' : '');
    }
    // the flag is the last tag, which is where the library puts it
    return text + (all ? '["sigflag","SIG_ALL"]' : '') + ']}]';
  }

  function cardIsAll(card) { return !!(card && card.info && cardAllFormat(card.info.format)); }

  function cardU32(hex, at) { return parseInt(hex.substr(at * 2, 8), 16); }

  /* GET_INFO's twenty-nine bytes. `limit` is the most the card signs for in a
   * day, in sats, and 0 is no limit. `owner`: whether the card has an owner,
   * which changing its PIN, its limit and its record, and loading it with no
   * PIN, need the proof of. `now` is the card's own clock (0 until it has been
   * told the time: before software 1.15, a time under a signature; from it, the
   * time in the newest block header it has been shown), `windowStart` when its
   * current day began and `spentToday` what it has signed for since. */
  function cardInfoOf(hex) {
    var h = String(hex || '').toLowerCase();
    /* 42 bytes from a card that has the limit on one tap (1.3, asked with P1 = 1);
     * 30 from one that has not, which answers the same question with the thirty
     * it knows; a card of version 1.1 gives 29, without the last, and may still be read. */
    /* (and 51 from a card of 1.23 asked with P1 = 3: the 43 of P1 = 2, then the book's format, the rate, the entries in use, those
     * without the mark and the last payment's unit) */
    if (!cardHexOk(h, 51) && !cardHexOk(h, 42) && !cardHexOk(h, 30) && !cardHexOk(h, 29)) throw new Error('The card did not say what it is.');
    var tapKnown = h.length === 84 || h.length === 102;
    var b = function (i) { return parseInt(h.substr(i * 2, 2), 16); };
    // the format of a card that signs once for a payment: 4, or (1.23) 5 for one that holds both units
    var all4 = cardAllFormat(b(8));
    var headers = all4 && (b(0) > 1 || (b(0) === 1 && b(1) >= 15));
    // software 1.16 and on: the PIN is optional, and bytes 34 to 41 of the long answer are the no-PIN allowance and what is spent of it
    var noPinKnown = tapKnown && all4 && (b(0) > 1 || (b(0) === 1 && b(1) >= 16));
    // software 1.17 and on: the owner can reset the card to what it was in its packet (RESET, `FoxyWallet.cardReset`)
    var resetKnown = all4 && (b(0) > 1 || (b(0) === 1 && b(1) >= 17));
    // 1.18: each further limit's worth over waits four askings, not three
    var moreKnown = all4 && (b(0) > 1 || (b(0) === 1 && b(1) >= 18));
    // 1.20: the card keeps the mint's proof (NUT-12) with each piece it is loaded with one for, and gives it back (`cardRealCheck`)
    var proofsKnown = all4 && (b(0) > 1 || (b(0) === 1 && b(1) >= 20));
    // 1.21: a PIN before any money, every load under it, the owner claimed in a held tap (`cardIs121`, by the card's own version)
    var pinFirst = all4 && (b(0) > 1 || (b(0) === 1 && b(1) >= 21));
    /* 1.22: a card with a PIN and no owner is the card of a holder with no phone: set up, loaded and read under its PIN (`guests`),
     * its history held for (`cardGuestLook`), and tied to a phone of the holder's own only while it is empty (`cardClaim`) */
    var guests = all4 && (b(0) > 1 || (b(0) === 1 && b(1) >= 22));
    /* 1.23: dollars and sats at its one mint (`units`): every figure of its ceiling is cents whatever its record's unit (`cents`),
     * and with P1 = 3 it says its book (`book`) and, to its holder, the rate it weighs a payment in sats at (`rate`, sats per dollar,
     * 0 for none or not said). `twoUnits`: format 5, a keyset of the other unit in its table. */
    var units = all4 && (b(0) > 1 || (b(0) === 1 && b(1) >= 23));
    var bookSaid = units && h.length === 102;
    var unitSaid = function (v) { return v === 0x80 ? 'record' : v === 0xa0 ? 'other' : ''; };
    return { version: b(0) + '.' + b(1), slots: b(2), unspent: b(3), spent: b(4), empty: b(5),
             pin: b(7) === 0 ? 'none' : b(7) === 1 ? 'set' : 'blocked', format: b(8), tries: b(9),
             locked: b(10) === 1, hasRecord: b(11) === 1, limit: cardU32(h, 12), owner: b(16) === 1,
             now: cardU32(h, 17), windowStart: cardU32(h, 21), spentToday: cardU32(h, 25),
             /* The limit on one tap: the most the card signs for in CARD_TAP
              * seconds of its own clock, when the current tap began, and what
              * it has signed for in it. `tapKnown`: this card has such a limit
              * to set (an older card's software has none). */
             /* `paced`: the limit on one tap is not a window that refuses but a
              * limit on one payment that makes a larger one wait (`cardWaitSigns`):
              * the card says so in what it can do. */
             paced: (b(6) & 8) !== 0,
             /* `quick`: the card has the brief listing of its pieces and gives
              * named places whole (`cardSlotsRead`, `cardFill`), and takes
              * several pieces to one load (`cardWriteOwed`). */
             quick: (b(6) & 16) !== 0,
             /* `wide`: a card of more than sixty-four places (128). A place's
              * number is seven bits of a listing's tag where it was six, and
              * its short listing is a shorter one (`cardShortOf`). */
             wide: (b(6) & 32) !== 0,
             /* `many`: the card burns a payment's pieces without holding them
              * all in one transaction, so a payment may be of every place it
              * has (`CARD_ALL_MOST` is what a card that does not say so takes). */
             many: (b(6) & 64) !== 0,
             /* `sealed`: the card takes its PIN enciphered to a key of its own
              * (`cardSeal`), and this phone then sends it no other way. */
             sealed: (b(6) & 128) !== 0,
             tapKnown: tapKnown, tapLimit: tapKnown ? cardU32(h, 30) : 0,
             tapStart: (tapKnown && !noPinKnown) ? cardU32(h, 34) : 0, tapSpent: (tapKnown && !noPinKnown) ? cardU32(h, 38) : 0,
             /* `noPinKnown`: the card's software is 1.16 or later, whose PIN is optional: a card may have none and pay without
              * it, and one with a PIN may let a day's worth be signed for without it (`noPin`, the allowance and what is spent
              * of it in the day; said to anybody, since a till needs it to know whether to ask for the PIN). `pinSet` is
              * whether a PIN exists (a blocked one does). `setUp`: the card has its record and can be used: before 1.16 that
              * needed a PIN as well. */
             noPinKnown: noPinKnown, noPin: { limit: noPinKnown ? cardU32(h, 34) : 0, spent: noPinKnown ? cardU32(h, 38) : 0 },
             pinSet: b(7) !== 0,
             /* `setUp`: a record and, before 1.16, a PIN; from 1.16 a record and an OWNER, which set-up writes last: a card
              * whose record was written by hand (a design put on it before it is set up) is not set up, and reads as new */
             /* (1.22: a record and an owner, or a record and a PIN: a card with no owner is a holder's with no phone, set up by the
              * first phone that sent it money, and used as any card is) */
             setUp: b(11) === 1 && (guests ? (b(16) === 1 || b(7) !== 0) : noPinKnown ? b(16) === 1 : b(7) !== 0),
             pinFirst: pinFirst, guests: guests,
             /* `resetKnown`: the card's software is 1.17 or later, whose owner can reset it (the version says so, as for `costed`):
              * no PIN, no owner, no record, no limits, no log and a new key, with its clock and its software kept. */
             resetKnown: resetKnown,
             /* `waitOver`: the signatures a card of this software asks for the first limit's worth over its limit on one payment:
              * seven on 1.13 to 1.16, ten from 1.17 (`cardWaitSigns`). */
             waitOver: resetKnown ? CARD_WAIT_OVER_17 : CARD_WAIT_OVER,
             // `waitMore`: the askings for each further limit's worth: four from 1.18, three before (`cardWaitSigns`)
             waitMore: moreKnown ? CARD_WAIT_MORE_18 : CARD_WAIT_MORE,
             /* This tap is the one after a payment: the card lets pieces be put
              * on with no PIN (the change). Said by the card for this tap only. */
             changeDue: h.length >= 60 && b(29) === 1,
             /* `ownChange`: the card makes a payment's change itself (software
              * 1.12 and on; the capability byte does not say so, the version
              * does). A terminal names only how much, so nothing it chooses can
              * take the change; the limits and the wait are held to what leaves
              * the card for good; and the card keeps what the change is made of
              * until its pieces are written back (`cardOpenings`). */
             ownChange: all4 && (b(0) > 1 || (b(0) === 1 && b(1) >= 12)),
             /* `shaped`: the card's wait is the one of software 1.13 and on (the
              * version says so, as for `ownChange`): nothing within the limit,
              * change or no change; about five seconds over it, and two more for
              * every further limit's worth; the change it made counted toward
              * that; and one payment a tap at full speed (`cardWaitSigns`). Its
              * change is cut plainly, in the powers of two the amount is made of
              * (`cardOwnChangeCut`). */
             shaped: all4 && (b(0) > 1 || (b(0) === 1 && b(1) >= 13)),
             /* `costed`: the change the card made counts toward that wait for what it
              * cost, two signatures for every three pieces (software 1.14 and on; the
              * version says so, as for `shaped`): a piece is about two thirds of a
              * signature's work. Software 1.13 took one off for each piece, which was
              * more than a piece costs (`cardWaitSigns`). */
             costed: all4 && (b(0) > 1 || (b(0) === 1 && b(1) >= 14)),
             /* `headers`: the card's clock is the time in the newest Bitcoin block header it has been shown (software 1.15
              * and on; the version says so, as for `costed`). It has no time key and takes no signed time; it is shown a
              * header (SET_HEADER) and told the phone's own time as a note (TELL_TIME); its receipts are 77 bytes and its
              * log entries 20; and it spends its first day on trust, with a limit and no header yet (`cardClock`,
              * `cardDayOf`). `headerTime` is its clock, the time in the last header that moved it. `headerBits` and
              * `headerHash` are the hardest difficulty it has taken and the hash of the last header taken: the card's
              * record says them (GET_CARD), and `cardLook` puts them here. */
             headers: headers, headerTime: headers ? cardU32(h, 17) : 0, headerBits: '', headerHash: '',
             /* `proofs`: the card is of software 1.20 or later (the version says so, as for `costed`): a piece can be loaded with the mint's
              * proof for it (LOAD_PROOF with P1 = 1, one piece to a command), and the proof is read back with GET_DLEQ. The card checks
              * nothing; this phone does (`cardRealCheck`). Nothing in GET_INFO says whether the card has room for proofs: the answer to
              * a load does. A card of 1.19 and before knows neither command, and is not sent them. */
             proofs: proofsKnown,
             units: units, cents: units, twoUnits: units && b(8) === CARD_FORMAT_UNITS,
             /* (the rate is said to the card's holder alone, the owner's grant or a guest's held tap, and is zeros to anyone else: whether
              * this read was the holder's is the reader's to know, which sets `rateSaid`: `cardLook`'s owner's asking, `cardGuestRead`,
              * `cardSetLimit23`, `cardRateFirst`) */
             rate: bookSaid ? cardU32(h, 44) : 0, rateSaid: false,
             book: bookSaid ? { format: b(43), entries: b(48), unmarked: b(49), last: unitSaid(b(50)) } : null };
  }

  /* Software 1.23 and on: dollars and sats on one card at its one mint (`info.units`). */
  function cardIs123(card) { return !!(card && card.info && card.info.units); }

  /* GET_INFO's P1 for a card: 3 for a card of 1.23 (its book and, to its holder, its rate), 1 for every other (its limit on one tap). */
  function cardInfoP1(card) { return cardIs123(card) ? 3 : 1; }

  /* GET_CARD with P1 = 2 (1.23): the table of keysets the card holds, a count and nine bytes an entry (the keyset as a piece holds it,
   * and a state byte: 40 in use, 80 the mark, bit 0 the unit code, 00 sats or 01 dollars). Answers { list: [{ keyset, unit, marked }],
   * of: { keyset: unit } }. Throws where it is not a table. */
  function cardTableOf(hex) {
    var h = String(hex || '').toLowerCase();
    var bad = function () { return new Error('The card’s table of keysets could not be read.'); };
    if (!/^[0-9a-f]*$/.test(h) || h.length < 2) throw bad();
    var n = parseInt(h.substr(0, 2), 16);
    if (n > 6 || h.length !== 2 + n * 18) throw bad();
    var list = [], of = {};
    for (var k = 0; k < n; k++) {
      var at = 2 + k * 18, state = parseInt(h.substr(at + 16, 2), 16);
      if (!(state & 0x40) || (state & 0x3e)) throw bad();
      var e = { keyset: h.substr(at, 16), unit: (state & 1) ? 'usd' : 'sat', marked: (state & 0x80) !== 0 };
      if (of[e.keyset]) throw bad();
      list.push(e);
      of[e.keyset] = e.unit;
    }
    return { list: list, of: of };
  }

  /* A card of 1.23's pieces by unit, on `card.units`: { sat: { pieces, balance }, usd: { pieces, balance } }, each piece with its `unit`.
   * On format 5 a piece's unit is its keyset's in the table (`card.table`), and a piece whose keyset the table does not name is of no
   * unit: counted nowhere and never paid with (`card.unitsForeign`). On format 4 every piece is the record's unit. `card.pieces` stays
   * every piece (the mint's word on them, `cardRealCheck`); a card before 1.23 has no `units`. */
  function cardSortUnits(card) {
    if (!cardIs123(card) || !card.record) return card;
    var ru = card.record.unit === 'usd' ? 'usd' : 'sat';
    var units = { sat: { pieces: [], balance: 0 }, usd: { pieces: [], balance: 0 } };
    var foreign = 0;
    (card.pieces || []).forEach(function (x) {
      var u = card.table ? card.table.of[x.keyset] : ru;
      if (u !== 'sat' && u !== 'usd') { foreign += satsOf(x.amount); x.unit = ''; return; }
      x.unit = u;
      units[u].pieces.push(x);
      units[u].balance += satsOf(x.amount);
    });
    card.units = units;
    card.unitsForeign = foreign;
    if (foreign > 0) console.warn('[foxy] card: ' + foreign + ' on the card is of a keyset its table does not name; it is counted nowhere');
    return card;
  }

  /* GET_BALANCE with P1 = 1 (1.23): how many units the card holds, then for each, sats first, its code (1), its pieces (1) and their sum (4).
   * Answers { sat: { pieces, sum }, usd: { pieces, sum } }; throws where it is not that. */
  function cardBalancesOf(hex) {
    var h = String(hex || '').toLowerCase();
    var bad = function () { return new Error('The card\u2019s balances could not be read.'); };
    if (!/^[0-9a-f]*$/.test(h) || h.length < 2) throw bad();
    var n = parseInt(h.substr(0, 2), 16);
    if (n > 2 || h.length !== 2 + n * 12) throw bad();
    var out = { sat: { pieces: 0, sum: 0 }, usd: { pieces: 0, sum: 0 } };
    for (var k = 0; k < n; k++) {
      var at = 2 + k * 12, code = parseInt(h.substr(at, 2), 16);
      if (code !== 0 && code !== 1) throw bad();
      out[code ? 'usd' : 'sat'] = { pieces: parseInt(h.substr(at + 2, 2), 16), sum: cardU32(h, at / 2 + 2) };
    }
    return out;
  }

  /* Whether a card of 1.23 holds both units, or may (format 5: a keyset of the other unit in its table, its pieces perhaps spent). */
  function cardBoth(card) { return !!(card && card.info && card.info.twoUnits && card.units); }

  /* A card of 1.23 as one of its units: the same card, its record's unit said as `unit`, its pieces and balance that unit's alone. What
   * pays from a card, loads it or takes money off it works on one unit (a payment is of one unit: the card refuses two, 6A9A), and is
   * handed this; the card itself is unchanged (`whole` is it, and `recordUnit` what its record says). A card before 1.23 is itself. */
  function cardInUnit(card, unit) {
    if (!card || !card.units) return card;
    var u = (unitOf(unit) || 'sat') === 'usd' ? 'usd' : 'sat';
    var whole = card.whole || card;
    var v = /** @type {any} */ (Object.assign({}, whole));
    v.record = Object.assign({}, whole.record, { unit: u });
    v.recordUnit = whole.record.unit === 'usd' ? 'usd' : 'sat';
    v.pieces = whole.units[u].pieces.slice();
    v.balance = whole.units[u].balance;
    v.viewUnit = u;
    v.whole = whole;
    return v;
  }

  /* ---- the rate (software 1.23): sats per dollar, written with the ceiling ------------------------------------------
   *
   * Every limit on a card of 1.23 is in cents, whatever its record's unit, and a payment in sats is weighed in cents at a rate the owner's
   * phone writes with the limits: R = floor(100,000,000 / P), P the price in dollars a bitcoin this phone shows (the one SET AMOUNT uses),
   * rounded down so that a sat is never counted for less than it is worth. 0 is none. With no price, nothing is written. */
  function cardRateOf(price) {
    var p = Number(price) || 0;
    if (!(p > 0)) return 0;
    var r = Math.floor(100000000 / p);
    return r >= 1 && r <= 4294967295 ? r : 0;
  }
  /* The price to write a rate at: the one the screen gave (`price`), else the last this phone was told, where it is not too old. 0 for none. */
  function cardPriceFor(price) {
    var p = Number(price) || 0;
    if (p > 0) return p;
    try {
      var lp = FoxyWallet.lastPrice();
      if (lp && Number(lp.rate) > 0 && !(FoxyWallet.priceTooOld && FoxyWallet.priceTooOld(lp.at))) return Number(lp.rate);
    } catch (e) {}
    return 0;
  }
  /* A figure in `unit` as the card's ceiling counts it, in cents: a dollar figure as it is; sats at the rate R, rounded up as the card
   * rounds them (ceil(S x 100 / R)); with no rate, null. */
  function cardCentsOf(n, unit, rate) {
    var v = Math.max(0, Math.round(Number(n) || 0));
    if ((unitOf(unit) || 'sat') === 'usd') return v;
    var r = Math.round(Number(rate) || 0);
    if (!(r > 0)) return null;
    return Math.min(4294967295, Math.ceil(v * 100 / r));
  }
  /* The rate a card's ceiling is weighed at, as this phone best knows it: the card's own where it said it (to its holder), else this phone's
   * from the price (a till is not told the card's rate, and guesses with its own, as the design has it). 0 where neither is known. */
  function cardRateNow(card, price) {
    var said = card && card.info && card.info.rateSaid ? Number(card.info.rate) || 0 : 0;
    return said > 0 ? said : cardRateOf(cardPriceFor(price));
  }
  /* A ceiling in cents as sats at a rate: the most sats a payment can be and be within it (floor(C x R / 100)), or 0 with no rate. */
  function cardSatsUnder(cents, rate) {
    var c = Math.max(0, Math.round(Number(cents) || 0)), r = Math.round(Number(rate) || 0);
    return r > 0 ? Math.floor(c * r / 100) : 0;
  }

  /* The rate of a card of 1.23, kept near the market by its owner's phone (design 6.5): at each read of the card as its owner, where the
   * price this phone shows has moved more than CARD_PACE_DRIFT from the rate the card says it holds, the rate is written again with the
   * figures as the card has them, in the tap and with nothing said. A card with no rate is given one where it has a limit to weigh a
   * payment in sats against (a card with no limit weighs nothing). The guard: a rate more than twice the card's, or under half of it, is
   * not written: the read says so (`card.rateAsk`: the price now and the one the card last knew, in dollars a bitcoin), and the owner is
   * asked once (`FoxyWallet.cardSetRate`). Never on a first write. A guard the owner said no to is not asked again at the same price
   * (`cardRateDeclined`). Never fails the read. */
  var cardRateDeclined = /** @type {Object<string, number>} */ ({});
  function cardRepeg23(t, c, o) {
    if (!c.mine || !c.info.rateSaid) return Promise.resolve(c);
    var price = cardPriceFor(o && o.price);
    var want = cardRateOf(price), has = Number(c.info.rate) || 0;
    if (!(want > 0)) return Promise.resolve(c);
    var limited = (Number(c.info.limit) || 0) > 0 || (Number(c.info.tapLimit) || 0) > 0 || (Number(c.info.noPin && c.info.noPin.limit) || 0) > 0;
    if (!has && !limited) return Promise.resolve(c);
    if (has && Math.abs(want - has) <= has * CARD_PACE_DRIFT) return Promise.resolve(c);
    if (has && (want > 2 * has || want * 2 < has)) {
      var no = cardRateDeclined[c.key];
      if (no && Math.abs(want - no) <= no * CARD_PACE_DRIFT) return Promise.resolve(c);
      c.rateAsk = { now: Math.round(price), was: Math.round(100000000 / has), rate: want, had: has };
      console.log('[foxy] card: its rate is far from this phone’s price ($' + Math.round(100000000 / has) + ' against $' + Math.round(price) + '); its owner is asked before it is written');
      return Promise.resolve(c);
    }
    return cardLimit23(t, c, { rate: want }).then(function () {
      console.log('[foxy] card: its rate is set to this phone’s price, ' + want + ' sats a dollar' + (has ? ' (it was ' + has + ')' : ''));
      c.repegged = want;
      return c;
    }, function (e) {
      if (e && e.card === 'gone') throw e;
      console.warn('[foxy] card: its rate could not be written:', (e && e.message) || e);
      return c;
    });
  }

  /* A figure of a card's ceiling, chosen in the card's unit (`n`: cents for a dollar card, sats for a bitcoin card) or in dollars (`usd`, where
   * the wheel or the keypad was in dollars), as a card of 1.23 keeps it: cents. Dollars as they are; sats turned at the rate written in the
   * same tap (`rate`), rounded up so that a payment of exactly the sats chosen is within it. Throws `no-price` for sats with no rate. */
  function cardFigCents(n, unit, usd, rate) {
    var v = Math.max(0, Math.round(Number(n) || 0));
    if (!(v > 0)) return 0;
    if ((unitOf(unit) || 'sat') === 'usd') return v;
    if (Number(usd) > 0) return Math.round(Number(usd) * 100);
    var c = cardCentsOf(v, 'sat', rate);
    if (c === null) throw cardError('no-price', 'This phone has no Bitcoin price, so a limit in sats cannot be written to this card. Choose it in dollars, or get online once.');
    return c;
  }
  /* Whether a card of 1.23 is of bitcoin or holds any (its record's unit, or sats pieces): its limit then weighs sats at its rate. */
  function cardMayHoldSats(card) {
    if (!card) return false;
    if (!(card.record && card.record.unit === 'usd')) return true;
    var whole = card.whole || card;
    return !!(whole.units && whole.units.sat && whole.units.sat.balance > 0);
  }
  function cardNoPrice(setUp) {
    if (setUp) return cardError('no-price', 'This phone has no Bitcoin price, so the card was not set up: a card of bitcoin needs a price for its limits. Get online once and try again.');
    return cardError('no-price', 'This phone has no Bitcoin price, so the card\u2019s limit was not written: the card weighs its bitcoin against the limit at a price. Get online once and try again.');
  }
  /* A card of 1.23's set-up figures (`o.tapLimit`, `o.noPin` in its unit, `o.tapUsd`, `o.noPinUsd` where chosen in dollars) as the PIN form
   * writes them: { tap, noPin } in cents and the rate at this phone's price (`o.price`, else the last it was told). */
  function cardSetUpCents(unit, o, tapLimit, noPinLimit) {
    var rate = cardRateOf(cardPriceFor(o && o.price));
    return { tap: cardFigCents(tapLimit, unit, o && o.tapUsd, rate), noPin: cardFigCents(noPinLimit, unit, o && o.noPinUsd, rate), rate: rate };
  }

  /* CHANGE LIMIT on a card of 1.23: one figure of its ceiling (`which`: 'day', 'tap' or 'noPin'), for both units together, in cents, written
   * with the rate in the one sixteen-byte command, the other figures as the card has them. The owner's grant first (the card says its limit
   * on one payment and its rate to that alone), then GET_INFO P1 = 3 for the figures as they stand. `n` is the figure in `o.unit` (the
   * card's record's unit where not named), or `o.usd` dollars where it was typed in them; a figure in sats is turned into cents at the rate
   * written in the same command. The rate is this phone's (`o.price`); where it is more than twice the card's or under half of it, nothing is
   * written and `rate-far` says both prices (`now`, `was`, dollars a bitcoin) for the owner to answer once: `o.rateOk` writes it, `o.keepRate`
   * keeps the card's. Never on a first rate (the card has none). With no price, the card's rate is kept. */
  function cardSetLimit23(t, card, o, which, n) {
    var grant = card.mine === true ? Promise.resolve(true) : cardGrant(t, card.key);
    return grant.then(function (yes) {
      if (!yes) throw cardRefused('6a91');
      card.mine = true;
      return t.want(cardCommand(CARD_INS.info, 3, '', 0), 'to say its limits');
    }).then(function (d) {
      var now = cardInfoOf(d);
      // (asked with the owner's grant in the tap: the holder's read, the rate said)
      now.rateSaid = true;
      ['limit', 'windowStart', 'spentToday', 'tapLimit', 'noPin', 'rate', 'rateSaid', 'book'].forEach(function (k) { card.info[k] = now[k]; });
      var price = cardPriceFor(o && o.price), want = cardRateOf(price), has = Number(now.rate) || 0;
      var rate = want > 0 ? want : has;
      if (want > 0 && has > 0 && (want > 2 * has || want * 2 < has) && !(o && o.rateOk)) {
        if (o && o.keepRate) rate = has;
        else {
          throw cardError('rate-far', 'Bitcoin’s price is now $' + Math.round(price).toLocaleString('en-US') + '; the card last knew $'
            + Math.round(100000000 / has).toLocaleString('en-US') + '. Update it?', { now: Math.round(price), was: Math.round(100000000 / has), rate: want, had: has });
        }
      }
      var unit = (o && o.unit) ? (unitOf(o.unit) || 'sat') : (card.record && card.record.unit === 'usd' ? 'usd' : 'sat');
      var cents = cardFigCents(n, unit, o && o.usd, rate);
      /* With no price, no write (design 9.1): a limit put on a card that holds bitcoin, or is of it, with no rate would leave its sats unable
       * to pay at all (6A99) until a price came. A card of dollars alone is as a dollar card always was: its limit needs no price. */
      if (cents > 0 && !(rate > 0) && cardMayHoldSats(card)) throw cardNoPrice();
      var fig = /** @type {any} */ ({ rate: rate });
      fig[which === 'noPin' ? 'noPin' : which === 'tap' ? 'tap' : 'day'] = cents;
      console.log('[foxy] card: its ' + (which === 'noPin' ? 'no-PIN allowance' : which === 'tap' ? 'limit on one payment' : 'daily limit') + ' is set to '
        + cents + ' cents for both its currencies, at ' + rate + ' sats a dollar');
      return cardLimit23(t, card, fig);
    });
  }

  /* SET_LIMIT on a card of 1.23 (the owner's form, 0x34, sixteen bytes): the daily limit, the limit on one payment and the no-PIN
   * allowance, in cents, and the rate. Each figure not given is sent as the card has it (`card.info`), so that nothing begins its window
   * or its count again for being written; the rate not given is the card's own where it said it, else 0 is never sent for it: a write
   * that would put 0 over a rate the card holds is refused here. `fig`: { day, tap, noPin, rate }. */
  function cardLimit23(t, card, fig) {
    var f = fig || {};
    var info = card.info || {};
    var pick = function (v, had) { return (v === undefined || v === null) ? (Number(had) || 0) : Math.round(Number(v)); };
    var day = pick(f.day, info.limit), tap = pick(f.tap, info.tapLimit), np = pick(f.noPin, info.noPin && info.noPin.limit);
    var rate = (f.rate === undefined || f.rate === null) ? (info.rateSaid ? Number(info.rate) || 0 : -1) : Math.round(Number(f.rate));
    if (rate < 0) return Promise.reject(cardError('no-rate-known', 'The card did not say its rate, so its limit was not written.'));
    var ok = function (n) { return n >= 0 && n <= 4294967295; };
    if (!ok(day) || !ok(tap) || !ok(np) || !ok(rate)) return Promise.reject(cardError('bad-limit', 'That is not a limit a card can hold.'));
    var value = cardU32Hex(day) + cardU32Hex(tap) + cardU32Hex(np) + cardU32Hex(rate);
    return cardOwned(t, card.key, 'set-limit', value).then(function (data) {
      return t.want(cardCommand(CARD_INS.setLimit, 0, data), 'its limit');
    }).then(function () {
      // as the card has them now: a figure that changed begins its window or its count again, as the card's own rules say
      if (day !== (Number(info.limit) || 0)) { info.limit = day; info.windowStart = info.now; info.spentToday = 0; if (card.record) card.record.limit = day; }
      info.tapLimit = tap;
      if (np !== (Number(info.noPin && info.noPin.limit) || 0)) info.noPin = { limit: np, spent: 0 };
      info.rate = rate;
      info.rateSaid = true;
      card.day = cardDayOf(info);
      card.tap = cardTapOf(info);
      card.noPin = cardNoPinOf(info);
      return card;
    });
  }

  /* GET_CARD: format, set, unit, limit, refund key, time key, mint, and, from
   * card software 1.10, the card's design after the mint: a code of three
   * characters naming its face (docs/CARD-DESIGNS.md), or three zeros for none.
   * A card before 1.10 answers nothing after the mint. From 1.15 the 65 bytes
   * where the time key was say something else: the hardest block header's `bits`
   * (4 bytes, as the header carries them; zeros if it has taken none, or since a new
   * record let that ratchet go), the hash of the
   * last header it took (32 bytes, as Bitcoin shows a block hash) and 29 zeros. The
   * bytes alone do not say which, so the card's software does: `info` is what
   * `cardInfoOf` made of its GET_INFO (`info.headers`), and without it the old
   * layout is read. */
  function cardRecordOf(hex, info) {
    var h = String(hex || '').toLowerCase();
    if (!/^[0-9a-f]*$/.test(h) || h.length < 212) throw new Error('The card’s record could not be read.');
    var mintLen = parseInt(h.substr(210, 2), 16);
    var withDesign = h.length === (109 + mintLen) * 2;
    if (h.length !== (106 + mintLen) * 2 && !withDesign) throw new Error('The card’s record could not be read.');
    var refund = h.substr(14, 66);
    var clocked = !!(info && info.headers);
    var headerBits = clocked ? h.substr(80, 8) : '', headerHash = clocked ? h.substr(88, 64) : '';
    var mint = '';
    for (var i = 0; i < mintLen; i++) mint += String.fromCharCode(parseInt(h.substr(212 + i * 2, 2), 16));
    var design = '';
    if (withDesign) {
      for (var k = 0; k < 3; k++) design += String.fromCharCode(parseInt(h.substr(212 + (mintLen + k) * 2, 2), 16));
      if (!/^[A-Z0-9]{3}$/.test(design)) design = '';
    }
    // the unit byte: 00 bitcoin, 01 dollars (`cardUnitByte`); anything else is a card this phone does not use
    var unitByte = parseInt(h.substr(4, 2), 16);
    return { format: parseInt(h.substr(0, 2), 16), set: h.substr(2, 2) === '01', unit: unitByte === 0 ? 'sat' : unitByte === 1 ? 'usd' : 'other',
             limit: cardU32(h, 3), refundKey: /^0+$/.test(refund) ? '' : refund, mint: mint,
             design: design, designKnown: withDesign,
             // from 1.15: the hardest difficulty taken and the last header's hash ('' for none)
             headerBits: /^0*$/.test(headerBits) ? '' : headerBits, headerHash: /^0*$/.test(headerHash) ? '' : headerHash };
  }

  /* The design this phone chose for a card whose software cannot carry one
   * (before 1.10), by the card's key: { key: code }. Its own small note, apart
   * from the cards this phone can take back (`cardsOnFile`), which a cash
   * card is never on. */
  var CARD_DESIGNS = 'foxy.flashcard.designs';
  function cardDesignNote(key, design) {
    var code = String(design || '').toUpperCase();
    if (!key || !/^[A-Z0-9]{3}$/.test(code)) return;
    var all = load(CARD_DESIGNS, {});
    if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
    all[key] = code;
    save(CARD_DESIGNS, all);
  }
  /* A card this phone began to set up for its holder (`cardSetUpFor`, software 1.22) and did not finish: a set-up cut off after its
   * PIN, or after its record and before the holder's two numbers. Kept by the card's key until the set-up is finished, so that the
   * next send to it from this phone takes the set-up up again, under the holder's PIN, rather than loading a card whose numbers were
   * never written, and so that this phone never offers to set it up as its own. Nothing else: no PIN, no numbers. */
  var CARD_FOR_HOLDER = 'foxy.flashcard.forholder';
  function cardHolderNote(key, on) {
    if (!key) return;
    var all = load(CARD_FOR_HOLDER, {});
    if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
    if (on) all[key] = true; else if (Object.prototype.hasOwnProperty.call(all, key)) delete all[key]; else return;
    save(CARD_FOR_HOLDER, all);
  }
  function cardHolderNoted(key) {
    var all = load(CARD_FOR_HOLDER, {});
    return !!(all && typeof all === 'object' && !Array.isArray(all) && all[key] === true);
  }
  function cardDesignNoted(key) {
    var all = load(CARD_DESIGNS, {});
    var code = (all && typeof all === 'object' && !Array.isArray(all)) ? String(all[key] || '') : '';
    return /^[A-Z0-9]{3}$/.test(code) ? code : '';
  }

  /* Whether a card's software carries a design in its record (1.10 and on): a
   * card before that refuses a record with one, by its length. */
  /* Software 1.21 and on: a PIN before any money, the card's own change bound to the mint's key when it is made and loaded by
   * LOAD_CHANGE (the card takes its blinding factor off itself), and an owner claimed by a held count of askings (6A98). */
  function cardIs121(card) {
    var v = String((card && card.info && card.info.version) || '').split('.');
    return Number(v[0]) > 1 || (Number(v[0]) === 1 && Number(v[1]) >= 21);
  }

  function cardCanDesign(card) {
    var v = String((card && card.info && card.info.version) || '').split('.');
    return Number(v[0]) > 1 || (Number(v[0]) === 1 && Number(v[1]) >= 10);
  }

  /* What a card has left of its day, worked out from what it says of itself:
   * the same sum it does when it is asked to sign (the window turns 86,400
   * seconds after it began, and nothing is spent in a new one). `left` is null
   * where the card has no limit. `turns` is when this day ends, in seconds, or
   * 0 where there is no day in hand (no limit, or the last one is over and the
   * next begins with the next signature it gives). The card's clock is what it was just
   * told: a card that has never been told the time (`noTime`) will not sign
   * under a limit, until software 1.15, where there is no such card: one with a
   * limit and no block header yet (`onTrust`) has a day with no start, which the
   * first header it is shown gives, and spends what the limit allows in the
   * meantime on trust. */
  function cardDayOf(info) {
    var limit = Number(info && info.limit) || 0;
    var headers = !!(info && info.headers);
    if (!limit) return { limited: false, limit: 0, spent: 0, left: null, turns: 0, now: Number(info && info.now) || 0, noTime: false };
    var now = Number(info.now) || 0;
    var begun = Number(info.windowStart) || 0;
    if (headers && now === 0 && begun === 0) {
      var counted = Number(info.spentToday) || 0;
      return { limited: true, limit: limit, spent: counted, left: Math.max(0, limit - counted), turns: 0, now: 0, noTime: false, onTrust: true };
    }
    var over = now >= begun + CARD_DAY;
    var spent = over ? 0 : (Number(info.spentToday) || 0);
    return { limited: true, limit: limit, spent: spent, left: Math.max(0, limit - spent), turns: over ? 0 : begun + CARD_DAY,
             now: now, noTime: !headers && now === 0 };
  }

  /* The same for the NO-PIN ALLOWANCE (software 1.16 and on): how many sats a day the card signs for without its PIN. It
   * shares the day's window with the daily limit, and only payments made without the PIN count against it. `set` is
   * whether there is one (a card with no PIN has none, and nothing asks for one; a card with a PIN and no allowance asks
   * for the PIN every time); `left` is what remains of it in this day, or all of it where the day is over (the card counts
   * from nothing then) and where the card has no clock yet (no header: the window has no start and does not end, and the
   * count runs from set-up, `onTrust`). `known` is whether the card's software has an allowance at all. */
  function cardNoPinOf(info) {
    var known = !!(info && info.noPinKnown);
    var limit = known ? (Number(info.noPin && info.noPin.limit) || 0) : 0;
    if (!limit) return { known: known, set: false, limit: 0, spent: 0, left: 0, turns: 0, now: Number(info && info.now) || 0 };
    var now = Number(info.now) || 0;
    var begun = Number(info.windowStart) || 0;
    var counted = Number(info.noPin && info.noPin.spent) || 0;
    if (now === 0 && begun === 0) {
      return { known: true, set: true, limit: limit, spent: counted, left: Math.max(0, limit - counted), turns: 0, now: 0, onTrust: true };
    }
    var over = now >= begun + CARD_DAY;
    var spent = over ? 0 : counted;
    return { known: true, set: true, limit: limit, spent: spent, left: Math.max(0, limit - spent), turns: over ? 0 : begun + CARD_DAY, now: now };
  }

  /* Whether the card will ask for its PIN to sign for a payment that takes `net` sats off it (the pieces less the change the
   * card makes for itself: for a till, at least the price and the mint's fee). A card with no PIN never does. A card with
   * a PIN does unless an allowance covers the whole payment (it is never split), and a card of software before 1.16 always
   * does. The card's own answer is the truth (`pin-needed`, 6A94); this is what the read can tell before asking it. */
  /* (1.23: the allowance is cents whatever the card's unit, and `net` is in the unit the payment is of, `card.record.unit` of the card as
   * that unit (`cardInUnit`): a payment in sats is weighed in cents first, at the card's rate where it said it and this phone's price where
   * not, rounded as the card rounds (`cardCeil`). With neither, the guess errs toward asking.) */
  function cardNeedsPin(card, net) {
    var info = card && card.info;
    if (!info || !info.pinSet) return false;
    if (info.pin === 'blocked') return true;
    var np = card.noPin || cardNoPinOf(info);
    if (!np.known || !np.set) return true;
    var c = cardCeil(card, net);
    if (c === null) return true;
    return c > np.left;
  }

  /* A figure of a payment as a card's ceiling counts it: on a card before 1.23 the figure itself (its limits are in its own unit); on one
   * of 1.23 in cents, a figure in sats (the card as its sats, `cardInUnit`) turned at the card's rate or, where it did not say it, at this
   * phone's price (`cardRateNow`). Null where a sats figure has no rate to be weighed at. */
  function cardCeil(card, n, price) {
    var v = Math.max(0, Math.round(Number(n) || 0));
    if (!(card && card.info && card.info.cents)) return v;
    var u = (card.record && card.record.unit) === 'usd' ? 'usd' : 'sat';
    return cardCentsOf(v, u, cardRateNow(card, price));
  }
  /* And back: a figure of the ceiling (cents on a card of 1.23) as the most of the card's unit a payment can be within it (sats at the
   * rate, rounded down); on a card before 1.23 the figure itself. 0 for a sats card of 1.23 with no rate known. */
  function cardCeilBack(card, cents, price) {
    var v = Math.max(0, Math.round(Number(cents) || 0));
    if (!(card && card.info && card.info.cents)) return v;
    if ((card.record && card.record.unit) === 'usd') return v;
    return cardSatsUnder(v, cardRateNow(card, price));
  }

  /* The same for the limit on one tap: what the card has left of the tap it is
   * in. A tap, to the card, is CARD_TAP seconds of its own clock from the first
   * piece it signs: nothing a terminal sends begins a new one (the PIN again, a
   * new SELECT, a reset), only time. `left` is null where there is no such
   * limit; `turns` is when this tap ends, 0 where none is in hand. */
  var CARD_TAP = 10;
  function cardTapOf(info) {
    var limit = Number(info && info.tapLimit) || 0;
    var known = !!(info && info.tapKnown);
    if (!limit) return { known: known, paced: !!(info && info.paced), limited: false, limit: 0, spent: 0, left: null, turns: 0, noTime: false };
    /* A card whose limit is on one payment, and is waited for: nothing is
     * counted, nothing is left or used up, and no clock is asked. */
    // (said to its owner's phone only on the quicker card: to anybody else `limit` is 0 here, and the card waits all the same)
    if (info.paced) return { known: known, paced: true, limited: true, limit: limit, spent: 0, left: null, turns: 0, noTime: false };
    var now = Number(info.now) || 0;
    var begun = Number(info.tapStart) || 0;
    var over = now >= begun + CARD_TAP;
    var spent = over ? 0 : (Number(info.tapSpent) || 0);
    return { known: known, paced: false, limited: true, limit: limit, spent: spent, left: Math.max(0, limit - spent),
             turns: over ? 0 : begun + CARD_TAP, noTime: now === 0 };
  }

  /* ---- the limit on one payment, which is waited for ---------------------------
   *
   * A card that says it is `paced` keeps one number, the most it signs for in
   * one payment at once. It refuses nothing over it. Over it, it does signatures
   * of work before it signs, one for each SPEND_ALL_SIGN it is sent, and answers
   * each with "not yet". It counts against no clock and remembers nothing from
   * one payment to the next, so there is nothing a terminal can replay or reset:
   * a payment is judged by its own size, every time.
   *
   * How many depends on the card's software. From 1.13 (`info.shaped`), so that
   * whoever holds it can feel that a payment was over the limit (`cardWaitSigns`):
   * nothing within the limit, change or no change (that change is coming is this
   * phone's to say, in words on its sheet, and not the card's); seven signatures, about
   * five seconds, for the first limit's worth over it; three, two seconds, for
   * every limit's worth after that; the change the card made (about half a second
   * of its work a piece) counted toward them as work done, for what it cost: from
   * 1.14 (`info.costed`) two signatures for every three pieces, a piece being about
   * two thirds of a signature's work, where 1.13 took one off for each piece, which
   * was more than a piece costs and let a till buy the wait down with pieces of a
   * sat; and one payment a tap at full speed, a second one in the same time in the
   * field waiting as one over the limit does, limit or no limit, unless the owner's
   * grant is in the tap. The charge is what leaves the card for good: the pieces
   * less the change the card makes for itself.
   *
   * Software 1.12 charged four signatures for every limit's worth of that, a part
   * counting as one, and four for a payment within the limit that made change
   * (`cardWaitSigns12`). Before it, it was what the PIECES come to, the first
   * limit's worth free (`cardWaitSignsBefore`), which is why the pieces for
   * such a card were chosen to overpay the least.
   *
   * The dollars its holder set it in are kept here (CARD_PACE), because the
   * card can hold only sats and has no price: the holder's own phone sets the
   * card's sats to match again when it reads the card and the price has moved
   * (`cardLook`, `price`). */
  var CARD_WAIT_SIGNS = 4;
  // software 1.13: the signatures for the first limit's worth over the limit, and for each further one; at most 255 limits' worth count
  var CARD_WAIT_OVER = 7;
  /* and from software 1.17 the first limit's worth over takes ten (`info.waitOver` says which a card has; the version says so,
   * as for `costed`): the further ones are three still. */
  var CARD_WAIT_OVER_17 = 10;
  var CARD_WAIT_MORE = 3;
  // and from software 1.18 each further limit's worth waits four (`info.waitMore`)
  var CARD_WAIT_MORE_18 = 4;
  var CARD_WAIT_UNITS = 255;
  // the longest a till asks anybody to hold a card for, in seconds: a payment that would wait longer is not begun
  var CARD_WAIT_MOST = 40;
  // and that many seconds as answers of "not yet", for a card that does not say how long it will be
  var CARD_WAIT_POLLS = 54;
  var CARD_PACE = 'foxy.flashcard.pace';
  // how far the price may move before the card's sats are set again
  var CARD_PACE_DRIFT = 0.02;

  /* What a payment waits under a limit of `limit` sats on one payment, in
   * signatures of work, by the rule of software 1.13 and on. `leaves` is what leaves the
   * card for good (the pieces less the change the card makes for itself: the price
   * and the mint's fee on the pieces, and any part of the change not made by the
   * card), `made` the pieces of change the card is asked to make, `second`
   * that a payment has been signed already in this time in the field with no
   * owner's grant in the tap (`cardPaid`), and `costed` that the card is of
   * software 1.14 or later (`info.costed`), whose change counts for what it cost.
   *
   *     leaves <= limit + limit/32        0  (a limit set in dollars at one moment and a price in
   *                                           dollars at another lands a few sats over)
   *     otherwise              7 + 3 * (ceil(leaves / limit) - 2)      (10 + ... on a card of software 1.17 and on: `over`)
   *
   * less what the change made counts for, never below 0: two for every three pieces
   * (floor(2 * made / 3)) on a card that is `costed`, one for each piece on the card of
   * 1.13. A second payment is at least one limit's worth over, 7, with a limit or
   * without one, and takes the same off.
   * `over`: the signatures for the first limit's worth over the limit, which the card says by its software (`info.waitOver`):
   * 7 from 1.13 to 1.16 (and where it is not given), 10 from 1.17. */
  function cardWaitSigns(limit, leaves, made, second, costed, over, more) {
    var first = Number(over) > 0 ? Math.round(Number(over)) : CARD_WAIT_OVER;
    var step = Number(more) > 0 ? Math.round(Number(more)) : CARD_WAIT_MORE;
    var l = Math.round(Number(limit) || 0), n = Math.round(Number(leaves) || 0);
    var pieces = Math.max(0, Math.round(Number(made) || 0));
    var done = costed ? Math.floor(2 * pieces / 3) : pieces;
    if (!(l > 0)) return second ? Math.max(0, first - done) : 0;
    var units = n <= l + Math.floor(l / 32) ? 1 : Math.min(CARD_WAIT_UNITS, Math.ceil(n / l));
    if (second && units <= 1) units = 2;
    if (units <= 1) return 0;
    return Math.max(0, first + step * (units - 2) - done);
  }
  /* The most limits' worth a payment can be of and still be waited for in no more
   * than CARD_WAIT_MOST seconds (software 1.13 and on), to say what can be taken. It
   * takes nothing off for change, so it is the same whatever the card counts that
   * for (`costed`) and a part of that size is waited for no longer than that. */
  function cardWaitUnitsMost(over, more) {
    var first = Number(over) > 0 ? Math.round(Number(over)) : CARD_WAIT_OVER;
    var step = Number(more) > 0 ? Math.round(Number(more)) : CARD_WAIT_MORE;
    var units = 2;
    while (units < CARD_WAIT_UNITS && cardWaitSeconds(first + step * (units - 1)) <= CARD_WAIT_MOST) units += 1;
    return units;
  }
  /* The same by the rule of software 1.12: the card counts what leaves it for
   * good (`net`: the price and the mint's fee on the pieces; the pieces less the
   * change the card makes for itself), and a payment within the limit that makes
   * no change goes at once. Otherwise every limit's worth, whole or in part, is a
   * unit: ceil(net / limit) of them, and a payment within the limit that makes
   * change (`change`) is one. Four signatures to a unit. */
  function cardWaitSigns12(limit, net, change) {
    var l = Math.round(Number(limit) || 0), n = Math.round(Number(net) || 0);
    if (!(l > 0)) return 0;
    var units = n > l ? Math.min(255, Math.ceil(n / l)) : (change ? 1 : 0);
    return units * CARD_WAIT_SIGNS;
  }
  /* The same for the card before 1.12, which counted the pieces whole (the
   * change a terminal wrote back was nothing it could check) and let the first
   * limit's worth go free. */
  function cardWaitSignsBefore(limit, sats) {
    var l = Math.round(Number(limit) || 0), n = Math.round(Number(sats) || 0);
    if (!(l > 0) || !(n > l)) return 0;
    return Math.min(255, Math.ceil(n / l) - 1) * CARD_WAIT_SIGNS;
  }
  function cardWaitSeconds(signs) { return Math.ceil((Number(signs) || 0) * (CARD_SIGN_SECONDS + 0.06)); }

  /* Whether a payment has been signed in this time in the field (`link.one.paid`,
   * which a sheet of the phone has and nothing else does, and which a card that
   * left and came back empties) with no owner's grant in the tap: the card then
   * makes the next one wait as one over the limit (software 1.13). The holder's
   * own phone, reading its card as the owner (`card.mine`), has given the grant
   * before it signs anything and is not slowed. */
  function cardPaid(link, card) {
    return !!(link && link.one && Number(link.one.paid) > 0) && !(card && card.mine);
  }

  function cardPaceAll() {
    var o = load(CARD_PACE, {});
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  }
  /* The dollars a card's limit was set in, or none (`usd` 0: set in sats, or no limit). */
  function cardPaceNote(cardKey, usd) {
    var all = cardPaceAll();
    var row = all[cardKey] || {};
    var noPin = row.noPinUsd > 0 ? { noPinUsd: row.noPinUsd, noPinAt: row.noPinAt } : null;
    if (usd > 0) all[cardKey] = Object.assign({ usd: Math.round(Number(usd) * 100) / 100, at: Date.now() }, noPin || {});
    else if (noPin) all[cardKey] = noPin;
    else delete all[cardKey];
    save(CARD_PACE, all);
  }
  /* The same for the no-PIN allowance (software 1.16): the dollars it was set in, kept in the same row beside the limit on one
   * tap's, or none (`usd` 0). */
  function cardPaceNoPinNote(cardKey, usd) {
    var all = cardPaceAll();
    var row = all[cardKey] || {};
    var tap = row.usd > 0 ? { usd: row.usd, at: row.at } : null;
    if (usd > 0) all[cardKey] = Object.assign({}, tap || {}, { noPinUsd: Math.round(Number(usd) * 100) / 100, noPinAt: Date.now() });
    else if (tap) all[cardKey] = tap;
    else delete all[cardKey];
    save(CARD_PACE, all);
  }
  /* What that figure is in sats at `price` (dollars a bitcoin), or 0 where there is no figure or no price. */
  function cardPaceSats(cardKey, price) {
    var row = cardPaceAll()[cardKey];
    var p = Number(price) || 0;
    if (!row || !(row.usd > 0) || !(p > 0)) return 0;
    return Math.max(1, Math.round(row.usd / p * 100000000));
  }
  function cardPaceNoPinSats(cardKey, price) {
    var row = cardPaceAll()[cardKey];
    var p = Number(price) || 0;
    if (!row || !(row.noPinUsd > 0) || !(p > 0)) return 0;
    return Math.max(1, Math.round(row.noPinUsd / p * 100000000));
  }

  /* GET_LOG: the card's own account of its taps. Only the card writes it: a
   * spend, in the step that burns the piece, and a spend refused for being
   * over a limit, before it is refused. No command clears it, and its counts
   * only go up. Four counts (taps, sats signed for, spends refused for being
   * over a limit, runs of three such refusals inside ten seconds of the card's
   * clock), then the last eight taps, newest first: when (the clock the card
   * had been told), sats signed for, pieces, refusals, and whether the tap is
   * marked (`tamper`: a third refusal of a run, or one after it, was in it).
   * A tap here is one time in a phone's field. */
  /* `wide`: the quicker card's entries, sixteen bytes: after what was signed
   * for, the pieces and the sats that were PUT ON in the tap. And one flag
   * more: the card was told the time twice in that tap, the second more than
   * two minutes on, which no phone's clock does (`clock`).
   * `told`: the entries of software 1.15, twenty bytes: the sixteen, and then the time
   * the terminal told the card at that tap (`told`, seconds; 0 if it told none), a note
   * the card trusts for nothing. `time` is then the card's own clock, the time in the
   * newest block header it had when the tap began, and there is no flag for a clock
   * moved twice: the clock cannot be moved by a time that is told. From software 1.16 a flag of 8 says a payment in
   * that tap was signed for under the no-PIN allowance, a PIN set and none shown (`noPin`). From 1.22 a flag of 16 says an
   * opening of the card's own change was given up in that tap, its piece never loaded (RESET_CARD's let-go, `letGo`). */
  /* `units` (software 1.23, asked with P1 = 2): the head is twenty bytes, the four counts and then what was signed for in the other unit
   * than the record's, ever (`other`); and a flag of 32 says an entry is of that other unit (`otherUnit`): a tap whose payment or load was
   * of both units is two entries, each of one. `recordUnit`, where given ('sat' or 'usd'), names each entry's unit (`unit`). */
  function cardLogOf(hex, wide, told, units, recordUnit) {
    var h = String(hex || '').toLowerCase();
    var each = told ? 40 : wide ? 32 : 24;
    var head = units ? 40 : 32;
    if (!/^[0-9a-f]*$/.test(h) || h.length < head || (h.length - head) % each !== 0 || h.length > head + 8 * each) throw new Error('The card\u2019s log could not be read.');
    var ru = recordUnit === 'usd' ? 'usd' : 'sat', ou = ru === 'usd' ? 'sat' : 'usd';
    var taps = [];
    for (var at = head; at < h.length; at += each) {
      var flags = parseInt(h.substr(at + 20, 2), 16);
      taps.push({ time: cardU32(h, at / 2), sats: cardU32(h, at / 2 + 4), pieces: parseInt(h.substr(at + 16, 2), 16),
                  refused: parseInt(h.substr(at + 18, 2), 16), tamper: (flags & 1) === 1,
                  // a payment in that tap was over the card's limit on one payment, and was waited for
                  waited: (flags & 2) === 2, clock: !told && (flags & 4) === 4,
                  // a payment in that tap was signed for under the no-PIN allowance (software 1.16 and on: a PIN set and none shown; a card with no PIN marks nothing)
                  noPin: !!told && (flags & 8) === 8,
                  // an opening of the card's own change given up in that tap (software 1.22; no card before it sets the bit)
                  letGo: !!told && (flags & 16) === 16,
                  loads: (wide || told) ? parseInt(h.substr(at + 22, 2), 16) : 0, loaded: (wide || told) ? cardU32(h, at / 2 + 12) : 0,
                  told: told ? cardU32(h, at / 2 + 16) : 0,
                  // (1.23: the entry is of the other unit than the record's; its figures are in that unit)
                  otherUnit: !!units && (flags & 32) === 32, unit: (!!units && (flags & 32) === 32) ? ou : ru });
    }
    var out = /** @type {any} */ ({ taps: cardU32(h, 0), sats: cardU32(h, 4), refused: cardU32(h, 8), tampers: cardU32(h, 12), last: taps });
    // (1.23: the record's unit's count is `sats`, the other's `other`, each in its own unit)
    if (units) { out.other = cardU32(h, 16); out.otherUnit = ou; }
    return out;
  }

  /* What this phone saw in a card's log when it last read it: the four counts,
   * by the card's key. The next reading says what has been added since
   * (`since`), which no terminal can have hidden: the ring holds eight taps and
   * could be pushed round, but the counts count them all. */
  var CARD_LOG_SEEN = 'foxy.flashcard.logseen';
  function cardLogSeen() {
    var o = load(CARD_LOG_SEEN, {});
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  }

  /* The log read from a card this phone owns (the owner's grant opens it with
   * no PIN), put on `card.log` with what is new since this phone last looked.
   * A card whose software keeps no log is left without one. Never fails the
   * reading it is part of. */
  function cardLogRead(t, card) {
    if (!card || card.mine !== true || !(card.info && card.info.tapKnown)) return Promise.resolve(card);
    // (1.23: P1 = 2, with the other unit's count and each entry's unit)
    var u23 = cardIs123(card), ru = (card.record && card.record.unit) || 'sat';
    return t.ask(cardCommand(CARD_INS.log, u23 ? 2 : 0, '', 0)).then(function (r) {
      if (r.sw !== '9000') return card;
      var log;
      try { log = /** @type {any} */ (cardLogOf(r.data, !!card.info.quick, !!card.info.headers, u23, ru)); } catch (e) { return card; }
      var all = cardLogSeen();
      var was = all[card.key];
      // counts that are behind what was seen are another card's software (it was put on anew): no "since" from those
      var known = !!(was && log.taps >= was.taps && log.sats >= was.sats && log.refused >= was.refused && log.tampers >= was.tampers);
      log.since = known ? { taps: log.taps - was.taps, sats: log.sats - was.sats, refused: log.refused - was.refused,
                            tampers: log.tampers - was.tampers, at: Number(was.at) || 0 } : null;
      all[card.key] = { taps: log.taps, sats: log.sats, refused: log.refused, tampers: log.tampers, at: Date.now() };
      try { save(CARD_LOG_SEEN, all); } catch (e2) {}
      /* The card's own counts are plain numbers in what it holds (its `sats` are cents on a dollar card: the card keeps no unit
       * of its own beyond its record's byte), so the log says which, for the screen that reads it. */
      log.unit = (card.record && card.record.unit) || 'sat';
      card.log = log;
      return cardReceiptsRead(t, card);
    }, function () { return card; });
  }

  /* ---- receipts ---------------------------------------------------------------
   *
   * For every payment it signs, the quicker card keeps a receipt: when (its
   * clock), what the pieces were worth, SHA-256 of the message it signed, and
   * the first output of the swap the money went into. It gives them to its
   * owner's phone and to nobody else, sixteen back at the most.
   *
   * The message names every output of the one swap the mint took the
   * signature for, and an output is made from its receiver's seed. Nobody can
   * tell whose an output is by looking at it; anybody who is later shown a
   * wallet's seed can make that wallet's outputs again and find this one
   * among them. So a receipt is what a holder has to show for a payment they
   * did not mean to make: it does not name who took it, and it lets a wallet
   * be proved to be the one, or not to be.
   *
   * The card's ring is short, so this phone keeps what it reads (CARD_RECEIPTS,
   * by the card's key and the payment's number), for as long as it is asked to. */
  var CARD_RECEIPTS = 'foxy.flashcard.receipts';
  var CARD_RECEIPTS_KEPT = 200;

  function cardReceiptsAll() {
    var o = load(CARD_RECEIPTS, {});
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  }

  /* GET_LOG, P1 = 1: the count (4), then receipts, newest first. Of 73 bytes: the card's clock,
   * the sats, the hash and the output. From software 1.15 (`told`), 77: the card's clock (the
   * time in its newest block header), then the time the terminal told it at that tap (0 if it
   * told none; a note the card trusts for nothing), then the rest as before. */
  /* `units` (software 1.23, asked with P1 = 3): each receipt is one byte longer, its payment's unit after it, relative to the record's
   * (80 the record's, A0 the other, 00 none: a receipt from before the card's book); `recordUnit` names it (`unit`, '' for none). */
  function cardReceiptsOf(hex, told, units, recordUnit) {
    var h = String(hex || '').toLowerCase();
    var each = (told ? 154 : 146) + (units ? 2 : 0), after = told ? 8 : 0;
    var ru = recordUnit === 'usd' ? 'usd' : 'sat', ou = ru === 'usd' ? 'sat' : 'usd';
    if (!/^[0-9a-f]*$/.test(h) || h.length < 8 || (h.length - 8) % each !== 0 || h.length > 8 + 3 * each) throw new Error('The card\u2019s receipts could not be read.');
    var list = [];
    for (var at = 8; at < h.length; at += each) {
      // `told` is there only for a card that keeps one (1.15 and on), even if it is 0: a receipt of 73 bytes has no such field
      var x = /** @type {any} */ ({ time: cardU32(h, at / 2), told: told ? cardU32(h, at / 2 + 4) : undefined, sats: cardU32(h, at / 2 + 4 + after / 2),
                  hash: h.substr(at + 16 + after, 64), out: h.substr(at + 80 + after, 66) });
      if (units) { var ub = parseInt(h.substr(at + each - 2, 2), 16); x.unit = ub === 0x80 ? ru : ub === 0xa0 ? ou : ''; }
      list.push(x);
    }
    return { count: cardU32(h, 0), list: list };
  }

  /* Read what this phone has not got yet of its own card's receipts. One
   * command where nothing is new. A card that will not give them (an older
   * one, or not this phone's) is left as it is. */
  function cardReceiptsRead(t, card) {
    if (!card || card.mine !== true || !(card.info && card.info.quick)) return Promise.resolve(card);
    var all = cardReceiptsAll();
    var mine = all[card.key];
    // counts that are behind what was kept are another card's software, put on anew: what was kept is of the card before it
    var have = (mine && Array.isArray(mine.list)) ? mine.list.slice() : [];
    var fresh = [];
    // (1.23: P1 = 3, each receipt with its unit)
    var u23 = cardIs123(card), ru = (card.record && card.record.unit) || 'sat';
    var page = function (back, count) {
      return t.ask(cardCommand(CARD_INS.log, u23 ? 3 : 1, '', 0, back)).then(function (r) {
        if (r.sw !== '9000') return null;
        var got = cardReceiptsOf(r.data, !!card.info.headers, u23, ru);
        if (mine && got.count < Number(mine.count)) have = [];
        var known = (mine && got.count >= Number(mine.count)) ? Number(mine.count) : 0;
        got.list.forEach(function (x, k) {
          var n = got.count - back - k;
          if (n > known) fresh.push(Object.assign({ n: n, time: x.time, told: x.told, sats: x.sats, hash: x.hash, out: x.out }, x.unit !== undefined ? { unit: x.unit } : {}));
        });
        // more that are new and still on the card (it holds sixteen)
        var wanted = Math.min(16, got.count - known);
        if (got.list.length === 3 && back + 3 < wanted) return page(back + 3, got.count);
        return got.count;
      });
    };
    return page(0, 0).then(function (count) {
      if (count === null) return card;
      var list = have.concat(fresh.sort(function (a, b) { return a.n - b.n; })).slice(-CARD_RECEIPTS_KEPT);
      if (fresh.length || !mine || Number(mine.count) !== count) {
        all[card.key] = { count: count, list: list, at: Date.now() };
        try { save(CARD_RECEIPTS, all); } catch (e) {}
      }
      // what each receipt was worth is in the card's unit (`sats` is cents on a dollar card), which this says
      card.receipts = { count: count, list: list, fresh: fresh.length, unit: (card.record && card.record.unit) || 'sat' };
      return card;
    }, function () { return card; });
  }

  /* One slot, as GET_PROOF gives it: status, keyset, amount, nonce, C, date. */
  function cardSlotOf(hex) {
    var h = String(hex || '').toLowerCase();
    if (!cardHexOk(h, CARD_SLOT_BYTES)) throw new Error('A place on the card could not be read.');
    var status = parseInt(h.substr(0, 2), 16);
    return { state: status === 1 ? 'unspent' : status === 2 ? 'spent' : 'empty',
             keyset: h.substr(2, 16), amount: cardU32(h, 9), nonce: h.substr(26, 64), C: h.substr(90, 66), date: cardU32(h, 78) };
  }

  /* How many places a card has: what it says, on a card that has more than
   * sixty-four (`wide`), and sixty-four on every card before it. */
  function cardPlaces(info) {
    var n = Number(info && info.slots) || 0;
    return (info && info.wide && n > 0 && n <= 128) ? n : 64;
  }

  /* One page of GET_PIECES: the first place it does not cover (the number of
   * places when there is nothing more to ask for), then an entry for each place
   * that is not empty, in order. An entry is a tag, and for an unspent place the
   * 81 bytes of its piece (what GET_PROOF gives after its status byte). The tag
   * of a card of sixty-four places is (state << 6) | place, with state 1 for
   * unspent and 2 for spent; of a card with more (`info.wide`), the place, and
   * 0x80 where it is spent. A place in the range with no entry is
   * empty. Answers { next, slots: [slot as cardSlotOf gives it, with `i`] }; a spent place is
   * { state: 'spent', i } and nothing else, because the card sends nothing more of
   * it and nothing here reads it. Throws where the page is not a whole page that
   * moves on from `from`. */
  function cardPageOf(hex, from, info) {
    var h = String(hex || '').toLowerCase();
    var bad = function () { return new Error('A place on the card could not be read.'); };
    if (!/^[0-9a-f]+$/.test(h) || h.length % 2 || h.length < 2 || h.length > 510) throw bad();
    var wide = !!(info && info.wide), end = cardPlaces(info);
    var next = parseInt(h.substr(0, 2), 16);
    if (!(next > from && next <= end)) throw bad();
    var at = 2, last = from - 1, slots = [];
    while (at < h.length) {
      var tag = parseInt(h.substr(at, 2), 16);
      var state = wide ? ((tag & 128) ? 2 : 1) : tag >> 6, place = wide ? (tag & 127) : (tag & 63);
      at += 2;
      if ((state !== 1 && state !== 2) || place <= last || place < from || place >= next) throw bad();
      last = place;
      if (state === 2) { slots.push({ state: 'spent', i: place }); continue; }
      if (at + CARD_PIECE_BYTES * 2 > h.length) throw bad();
      var slot = /** @type {any} */ (cardSlotOf('01' + h.substr(at, CARD_PIECE_BYTES * 2)));
      slot.i = place;
      slots.push(slot);
      at += CARD_PIECE_BYTES * 2;
    }
    return { next: next, slots: slots };
  }

  /* One page of the brief listing (GET_PIECES, P2 = 1): as `cardPageOf`, but an
   * unspent place is sixteen bytes: keyset, amount, date. */
  function cardBriefOf(hex, from) {
    var h = String(hex || '').toLowerCase();
    var bad = function () { return new Error('A place on the card could not be read.'); };
    if (!/^[0-9a-f]+$/.test(h) || h.length % 2 || h.length < 2 || h.length > 510) throw bad();
    var next = parseInt(h.substr(0, 2), 16);
    if (!(next > from && next <= 64)) throw bad();
    var at = 2, last = from - 1, slots = [];
    while (at < h.length) {
      var tag = parseInt(h.substr(at, 2), 16);
      var state = tag >> 6, place = tag & 63;
      at += 2;
      if ((state !== 1 && state !== 2) || place <= last || place < from || place >= next) throw bad();
      last = place;
      if (state === 2) { slots.push({ state: 'spent', i: place }); continue; }
      if (at + 32 > h.length) throw bad();
      slots.push({ state: 'unspent', i: place, bare: true, keyset: h.substr(at, 16), amount: cardU32(h, (at + 16) / 2),
                   nonce: '', C: '', date: cardU32(h, (at + 24) / 2) });
      at += 32;
    }
    return { next: next, slots: slots };
  }

  /* One page of a wide card's short listing (GET_PIECES, P2 = 3): the first
   * place it does not cover, then an entry for each UNSPENT place, in order:
   * the place, with 0x80 where its keyset (8) and date (4) follow (they do in
   * the first entry of every page, and wherever they are not the last entry's);
   * then the power of two it is worth, or 0xFF and the amount (4). A card of
   * a hundred pieces is one page, where the brief listing was eight. Spent
   * places are not in it: GET_INFO counts them. Answers as `cardBriefOf`. */
  function cardShortOf(hex, from, end) {
    var h = String(hex || '').toLowerCase();
    var bad = function () { return new Error('A place on the card could not be read.'); };
    if (!/^[0-9a-f]+$/.test(h) || h.length % 2 || h.length < 2 || h.length > 510) throw bad();
    var next = parseInt(h.substr(0, 2), 16);
    if (!(next > from && next <= end)) throw bad();
    var at = 2, last = from - 1, slots = [], keyset = '', date = 0, named = false;
    while (at < h.length) {
      var tag = parseInt(h.substr(at, 2), 16);
      var place = tag & 127;
      at += 2;
      if (place <= last || place < from || place >= next) throw bad();
      last = place;
      if (tag & 128) {
        if (at + 24 > h.length) throw bad();
        keyset = h.substr(at, 16);
        date = cardU32(h, (at + 16) / 2);
        named = true;
        at += 24;
      } else if (!named) {
        throw bad();
      }
      if (at + 2 > h.length) throw bad();
      var size = parseInt(h.substr(at, 2), 16), amount = 0;
      at += 2;
      if (size === 255) {
        if (at + 8 > h.length) throw bad();
        amount = cardU32(h, at / 2);
        at += 8;
      } else if (size <= 31) {
        amount = Math.pow(2, size);
      }
      if (!(amount > 0)) throw bad();
      slots.push({ state: 'unspent', i: place, bare: true, keyset: keyset, amount: amount, nonce: '', C: '', date: date });
    }
    return { next: next, slots: slots };
  }

  /* The places a till has chosen from the brief listing, made whole: asked
   * for by name, three to a command, and each held to what the listing said
   * of it (unspent still, and the same keyset, amount and date) before its
   * nonce and its C are believed. `picked` are the pieces as `cardUsable`
   * made them, and are filled in where they stand. */
  function cardFill(t, card, picked, w) {
    var bare = (picked || []).filter(function (p) { return p && p.bare; });
    if (!bare.length) return Promise.resolve();
    var walk = Promise.resolve();
    for (var at = 0; at < bare.length; at += 3) {
      (function (some) {
        walk = walk.then(function () {
          return t.want(cardCommand(CARD_INS.pieces, 0, some.map(function (p) { return cardByte(p.slot); }).join(''), 0, 2), 'to show the pieces chosen');
        }).then(function (d) {
          if (!cardHexOk(d, some.length * CARD_SLOT_BYTES)) throw cardError('refused', 'The card did not show the pieces chosen.', { sw: '' });
          some.forEach(function (p, k) {
            var slot = cardSlotOf(d.substr(k * CARD_SLOT_BYTES * 2, CARD_SLOT_BYTES * 2));
            // (a card of 1.23 that holds both units: the keyset among the mint's of the unit its table names)
            var tu = (card.table && cardBoth(card.whole || card)) ? (card.table.of[slot.keyset] || 'none') : undefined;
            if (slot.state !== 'unspent' || slot.amount !== satsOf(p.amount) || (Number(slot.date) || 0) !== (Number(p.date) || 0)
                || cardFullId(w, slot.keyset, tu) !== String(p.id).toLowerCase()) {
              throw cardError('refused', 'The card\u2019s pieces are not what it said they were.', { sw: '' });
            }
            var whole = cardProofOf(slot, card.key, card.record.refundKey, p.id, card.info.format);
            p.secret = whole.secret;
            p.C = whole.C;
            delete p.bare;
          });
        });
      })(bare.slice(at, at + 3));
    }
    return walk;
  }

  /* The 81 bytes LOAD_PROOF takes for a piece. */
  function cardPieceBytes(piece) {
    var u32 = function (n) { return ('00000000' + (Number(n) >>> 0).toString(16)).slice(-8); };
    var hex = String(piece.keyset) + u32(piece.amount) + String(piece.nonce) + String(piece.C) + u32(piece.date || 0);
    if (!cardHexOk(hex, CARD_PIECE_BYTES)) throw new Error('That piece does not fit a card.');
    return hex;
  }

  /* The mint's proof for a piece (NUT-12) as a card of software 1.20 keeps it: e, s and the blinding factor r, 32 bytes each, as hex.
   * Null unless all three are there and well formed: a piece with a part of a proof is a piece with none, and is written plain. Not
   * all zeros either: a card refuses 96 zero bytes (6A80), which are what "no proof" is kept as. A part a few characters short (a
   * number written without its leading zeros) is padded back to 32 bytes. */
  function cardDleqOf(d) {
    if (!d || typeof d !== 'object') return null;
    var whole = function (v) {
      var h = String(v === undefined || v === null ? '' : v).toLowerCase();
      return /^[0-9a-f]{1,64}$/.test(h) ? ('0000000000000000000000000000000000000000000000000000000000000000' + h).slice(-64) : '';
    };
    var e = whole(d.e), s = whole(d.s), r = whole(d.r);
    if (!e || !s || !r || /^0+$/.test(e + s + r)) return null;
    return { e: e, s: s, r: r };
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

  /* `unit` (a card of 1.23 that holds both units, whose table names each keyset's): only among the mint's keysets of that unit, so that a
   * piece the table says is cents is never taken for one of the mint's sats keysets, and the other way round. */
  function cardFullId(w, short, unit) {
    var want = String(short || '').toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(want)) return '';
    var u = unit ? (unitOf(unit) || String(unit)) : '';
    var at = u ? mintOf(w) : '', sets = u ? keysetsOf(at, w) : null;
    var found = keysetIdsFor(w).map(function (id) { return String(id).toLowerCase(); })
      .filter(function (id) { return cardShortId(id) === want && (!u || keysetUnit(at, id, w, sets) === u); });
    return found.length === 1 ? found[0] : '';
  }

  /* The ecash a slot is: the proof a mint would be shown, without its witness.
   * `id` is the keyset's whole name where the caller has a mint to ask
   * (`cardFullId`); without it, the eight bytes as the card holds them. */
  function cardProofOf(slot, cardKey, refundKey, id, format) {
    return { id: id || slot.keyset, amount: slot.amount, C: slot.C,
             secret: cardSecret(slot.nonce, cardKey, slot.date, refundKey, format) };
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
  var CARD_INS = { info: '01', key: '10', balance: '11', proof: '13', slots: '14', auth: '15', card: '16', pieces: '17', log: '18', getChange: '19',
                   /* 1a is GET_DLEQ (1.20 and on): the mint's proof kept with an unspent piece, for one place or two. */
                   dleq: '1a',
                   spend: '20', begin: '22', outputs: '23', signAll: '24', again: '25', change: '26', loadChange: '53', load: '30', clear: '31', setCard: '32', setLimit: '34',
                   /* 33 is SET_LIMIT's PIN form: from 1.21 the holder's numbers on a card with no owner (`cardPinLimits`) */
                   setLimitPin: '33',
                   /* 35 was SET_TIME, a time under a signature, for cards of software 1.14 and before, and is gone (a card answers 6d00).
                    * The card's clock is the newest Bitcoin block header it has been shown (36), and the phone's own time is a note it is told (37). */
                   header: '36', tell: '37',
                   verify: '40', setPin: '41', changePin: '42', setOwner: '43', nonce: '44', allowLoad: '45',
                   /* 50 is LOCK_CARD, which this phone never sends (a lock is for ever, and the owner's key cannot be asked to sign for it).
                    * 51 is RESET (1.17 and on): the owner's proof over "FoxyCard/reset" and P2 = CARD_RESET_CONFIRM. */
                   reset: '51' };
  var CARD_RESET_CONFIRM = 0xad;

  function cardByte(n) { return ('0' + (Number(n) & 255).toString(16)).slice(-2); }

  /* One command, as hex: class B0, the instruction, two parameters, the data
   * (with its length before it) and the length expected back. */
  function cardCommand(ins, p1, data, le, p2) {
    var body = String(data || '');
    return 'b0' + ins + cardByte(p1 || 0) + cardByte(p2 || 0) + (body ? cardByte(body.length / 2) + body : '') + (le === undefined ? '' : cardByte(le));
  }

  /* What went wrong, in a shape the screens can tell apart: `card` names it. */
  function cardError(kind, message, extra) {
    var e = /** @type {any} */ (new Error(message));
    e.card = kind;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  /* What the sheet ends saying when the card wants its PIN for a payment (`pin-needed` with no PIN given): it is not an error, and the
   * sheet is not red. The person is asked for the PIN and the card is tapped again. */
  var CARD_PIN_SHEET = 'Enter the card\u2019s PIN';

  /* A status word that is not 9000, as the person should hear it. */
  function cardRefused(sw, doing) {
    var w = String(sw || '').toLowerCase();
    if (/^63c[0-9a-f]$/.test(w)) {
      var left = parseInt(w.slice(3), 16);
      return cardError('wrong-pin', 'Wrong PIN. ' + left + (left === 1 ? ' try' : ' tries') + ' left.', { tries: left });
    }
    if (w === '6983') return cardError('blocked', 'This card is blocked: its PIN was typed wrong too many times.', { tries: 0 });
    if (w === '6984') return cardError('no-pin', 'This card has no PIN yet.');
    if (w === '6982') return cardError('pin-needed', 'Card needs PIN entered.');
    if (w === '6a8f') return cardError('limit', 'This payment is over what the card can spend in a day.');
    if (w === '6a95') return cardError('tap-limit', 'This payment is over what the card can spend in one tap.');
    if (w === '6a90') return cardError('no-owner', 'This card has no owner, so it cannot be loaded, and its PIN and its limit cannot be changed.');
    if (w === '6a91') return cardError('not-owner', 'This phone does not hold the seed phrase this card was set up with, so it cannot change the card’s PIN or limit.');
    if (w === '6a92') return cardError('no-time', 'The card has not been told the time.');
    if (w === '6a93') return cardError('wrong-signer', 'That card keeps its time by another signer than this Foxy.');
    if (w === '6a84') return cardError('full', 'The card has no room for more.');
    if (w === '6986') return cardError('locked', 'This card is locked: nothing more can be written to it.');
    if (w === '6a8c') return cardError('no-record', 'This card has not been set up.');
    if (w === '6a8d') return cardError('in-use', 'That cannot change while the card still holds money.');
    if (w === '6a8e') return cardError('no-refund-key', 'This card was set up as cash and cannot hold a piece that can be taken back.');
    if (w === '6a94') return cardError('on-card', 'That piece is on the card already.');
    if (w === '6a96') return cardError('too-many', 'That is more pieces than the card signs for at once.');
    // 1.21: a card with no PIN takes nothing and pays nothing; and a held tap let go before it was through
    if (w === '6a97') return cardError('pin-first', 'This card has no PIN yet. It is given one when it is set up.');
    if (w === '6a98') return cardError('keep-holding', 'The card was not held long enough. Hold it to the phone and try again.');
    /* 1.23, a card of dollars and sats: a payment in sats where the card has a limit and no rate to weigh it at; a payment of both
     * currencies at once; money of the currency the card holds that keyset as the other of; a table with no room; and a new currency
     * that only the card's owner may start. Nothing is taken or written for any of them. */
    if (w === '6a99') return cardError('no-rate', 'This card cannot pay in bitcoin until its owner’s phone sets it again.');
    if (w === '6a9a') return cardError('two-units', 'The card was asked to pay from both currencies at once. Nothing was taken.');
    if (w === '6a9b') return cardError('unit-taken', 'That money is the other currency on this card. Nothing was put on it.');
    if (w === '6a9c') return cardError('table-full', 'This card has no room for another kind of money until its owner’s phone clears it.');
    if (w === '6a9d') return cardError('owner-unit', 'Only the card’s owner can add a new currency to it.');
    return cardError('refused', 'The card refused ' + (doing || 'that') + ' (' + w + ').', { sw: w });
  }

  /* Ask the card one thing. `ask` answers { data, sw } whatever the status;
   * `want` answers the data and throws anything but 9000 as what it means. */
  function cardTalk(link) {
    function ask(apdu) {
      return Promise.resolve().then(function () { return link.send(apdu); }).then(function (hex) {
        var h = String(hex || '').toLowerCase();
        if (h.length < 4 || h.length % 2 || /[^0-9a-f]/.test(h)) throw cardError('gone', 'Card taken away too soon.');
        return { data: h.slice(0, -4), sw: h.slice(-4) };
      }, function (e) {
        throw (e && e.card) ? e : cardError('gone', 'Card taken away too soon.');
      });
    }
    return {
      link: link,
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

  /* ---- the card's owner ---------------------------------------------------
   *
   * A card has an owner: a P-256 public key it was given at set-up. On a card
   * with an owner, changing the PIN, setting the limit, the record or the
   * owner, and adding funds with no PIN all need the owner's proof, and the PIN
   * alone changes none of them: a terminal that has been handed the PIN could
   * otherwise take the card over, or change the PIN and lock the holder out.
   *
   * The key is this phone's to make again from its twelve words, and it is made
   * and kept in the phone's native side. This page never holds it and never sees
   * a secret from the seed: native gives it the owner's PUBLIC key for a card
   * (`cardOwnerKey`, for the one command that gives it to the card), and signs,
   * on request, for one of five fixed labels over a nonce the card has just
   * given and the value the command carries (`cardOwnerSign`). The proof is an
   * ECDSA signature the card checks with its own verifier, so a new phone
   * restored from the same words is the owner of the same cards, and one that
   * does not hold them is refused (`not-owner`, which costs no PIN tries and
   * changes nothing). */
  function cardU32Hex(n) { return ('00000000' + (Number(n) >>> 0).toString(16)).slice(-8); }

  /* The owner's public key for a card, as the card takes it: 130 hex, from 04. */
  function cardOwnerPub(cardKey) {
    return nativeJson('cardOwnerKey', { key: cardKey }, 60000).then(function (j) {
      var pub = String((j && j.pub) || '').toLowerCase();
      if (!/^04[0-9a-f]{128}$/.test(pub)) throw new Error('not a key');
      return pub;
    }).then(null, function () {
      throw cardError('no-owner-key', 'This phone could not make the key that shows it owns this card. Its seed phrase may be missing.');
    });
  }

  /* The owner's proof for one command, answered to a nonce the card gives now:
   * `name` is one of the five (change-pin, set-limit, set-owner, set-card,
   * load), `value` what the command carries, as hex. Resolves the command's
   * data: the proof's length, the proof, and the value. */
  function cardOwned(t, cardKey, name, value) {
    var tail = String(value || '');
    return t.want(cardCommand(CARD_INS.nonce, 0, '', 16), 'a nonce for its owner').then(function (nonce) {
      if (!cardHexOk(nonce, 16)) throw cardError('refused', 'The card did not give a nonce.');
      return cardProof(cardKey, name, nonce, tail).then(function (sig) { return cardByte(sig.length / 2) + sig + tail; });
    });
  }

  /* The owner's signature over `name`, a nonce the card gave and `value`, made
   * by the phone (which holds the owner's key and never shows it). */
  function cardProof(cardKey, name, nonce, value) {
    return nativeJson('cardOwnerSign', { key: cardKey, label: name, nonce: nonce, value: String(value || '') }, 60000).then(function (j) {
      var sig = String((j && j.sig) || '').toLowerCase();
      if (!/^(?:[0-9a-f]{2}){8,72}$/.test(sig)) throw new Error('not a signature');
      return sig;
    }, function () {
      throw cardError('no-owner-key', 'This phone could not make the key that shows it owns this card. Its seed phrase may be missing.');
    });
  }

  /* ---- the PIN, sealed to the card ----------------------------------------------
   *
   * A PIN typed at a till crossed the air to the card as it was typed, and
   * anybody listening to the tap had it: the PIN, and later the card, is all a
   * thief needs. A bank card's PIN is enciphered to a key of the card's, and
   * so is this one, on a card that says it can (`info.sealed`).
   *
   * The card has a key of its own for this and nothing else (not the key it
   * signs payments with). In one answer it gives sixteen fresh bytes, that
   * key, and its signing key's signature over that key (`cardSealKey`). The
   * phone makes a key pair for the one message, agrees a secret with the
   * card's key (the x of the shared point), and from it, the two keys' public
   * halves, the card's sixteen bytes and the command, hashes a keystream and
   * a tag. What is sent is the phone's public key, the PIN block under the
   * keystream, and the tag. The card does the same sum and opens it.
   *
   * The sixteen bytes are the card's, fresh each time and good once, so what
   * was heard at one tap opens nothing at another. An envelope the card
   * cannot open costs a try of the PIN, as a wrong PIN does. The PIN block is
   * always nine bytes, so its length says nothing of the PIN's.
   *
   * What it does not do: a till still has the PIN (it was typed on it), and a
   * false card can still ask for one. It is the listener it stops. */
  var CARD_SEAL_LABEL = 'FoxyCard/seal';
  var CARD_PINKEY_LABEL = 'FoxyCard/pinkey';
  var cardAscii = function (text) { return Array.prototype.map.call(String(text), function (c) { return c.charCodeAt(0); }); };
  var cardBytesOf = function (hex) { return Array.prototype.slice.call(bytesOfHex(hex)); };

  /* A PIN as the block that is sealed: its length, the PIN, and zeros to eight. */
  function cardPinBlock(pinHex) {
    var n = String(pinHex).length / 2;
    return cardByte(n) + String(pinHex) + '00'.repeat(Math.max(0, 8 - n));
  }

  /* Sixteen fresh bytes from the card and its PIN key, held to the card's own
   * key: { nonce, pub } (hex). The nonce is good for one sealed command, or
   * for one owner's proof and the sealing of the command that carries it. */
  function cardSealKey(t, card) {
    return t.want(cardCommand(CARD_INS.nonce, 1, '', 113), 'its PIN key').then(function (d) {
      if (!cardHexOk(d, 113)) throw cardError('refused', 'The card did not give its PIN key.');
      var nonce = d.substr(0, 32), pub = d.substr(32, 66), sig = d.substr(98, 128);
      var good = false;
      try {
        var digest = sha256(cardAscii(CARD_PINKEY_LABEL).concat(cardBytesOf(pub)));
        good = /^0[23]/.test(pub) && window.CashuTS.schnorrVerifyDigest(sig, new Uint8Array(digest), card.key) === true;
      } catch (e) { good = false; }
      if (!good) throw cardError('not-a-card', 'That card\u2019s PIN key is not signed by the card. The PIN was not sent.');
      return { nonce: nonce, pub: pub };
    });
  }

  /* `clear` (hex) sealed for the command `ins` under what `cardSealKey` gave:
   * this message's public key (65), the bytes under the keystream, the tag
   * (16). `eph`, where given, is the message's secret key (32 bytes, for a
   * test that needs the same envelope twice). */
  function cardSeal(key, ins, clear, eph) {
    var CT = window.CashuTS;
    var secret = eph || CT.createRandomSecretKey();
    var mine = hexOf(CT.pointFromHex(hexOf(CT.getPubKeyFromPrivKey(secret))).toBytes(false));
    var shared = hexOf(CT.pointFromHex(key.pub).multiply(BigInt('0x' + hexOf(secret))).toBytes(false)).substr(2, 64);
    var head = cardBytesOf(shared).concat(cardBytesOf(mine), cardBytesOf(key.nonce), [parseInt(ins, 16)]);
    var block = function (i, more) { return sha256(cardAscii(CARD_SEAL_LABEL).concat([i], head, more || [])); };
    var plain = cardBytesOf(clear), out = [];
    for (var at = 0; at < plain.length; at += 32) {
      var ks = block(1 + at / 32);
      for (var k = 0; k < 32 && at + k < plain.length; k++) out.push(plain[at + k] ^ ks[k]);
    }
    var tag = block(0, out).slice(0, 16);
    return mine + hexOf(out) + hexOf(tag);
  }

  /* The PIN shown to the card: sealed where the card takes it so, and as it
   * is where the card knows no other way. With no PIN (`pinHex` empty) nothing is shown. */
  function cardVerify(t, card, pinHex) {
    // no PIN given: none is shown (a card with no PIN asks for none, and one with a PIN that has an allowance may sign without it; the card says if it will not)
    if (!pinHex) return Promise.resolve();
    if (!(card && card.info && card.info.sealed)) return t.want(cardCommand(CARD_INS.verify, 0, pinHex), 'its PIN');
    return cardSealKey(t, card).then(function (key) {
      return t.want(cardCommand(CARD_INS.verify, 1, cardSeal(key, CARD_INS.verify, cardPinBlock(pinHex))), 'its PIN');
    });
  }

  /* A new card's first PIN, the same way. */
  function cardFirstPin(t, card, pinHex) {
    if (!(card && card.info && card.info.sealed)) return t.want(cardCommand(CARD_INS.setPin, 0, pinHex), 'its new PIN');
    return cardSealKey(t, card).then(function (key) {
      return t.want(cardCommand(CARD_INS.setPin, 1, cardSeal(key, CARD_INS.setPin, cardPinBlock(pinHex))), 'its new PIN');
    });
  }

  /* And a PIN changed by the card's owner: the owner's proof is over the new
   * PIN and the card's sixteen bytes, and the same sixteen bytes seal the
   * command that carries both. */
  function cardNewPin(t, card, pinHex) {
    if (!(card && card.info && card.info.sealed)) {
      return cardOwned(t, card.key, 'change-pin', pinHex).then(function (data) {
        return t.want(cardCommand(CARD_INS.changePin, 0, data), 'its new PIN');
      });
    }
    return cardSealKey(t, card).then(function (key) {
      return cardProof(card.key, 'change-pin', key.nonce, pinHex).then(function (sig) {
        var clear = cardByte(sig.length / 2) + sig + cardPinBlock(pinHex);
        return t.want(cardCommand(CARD_INS.changePin, 1, cardSeal(key, CARD_INS.changePin, clear)), 'its new PIN');
      });
    });
  }

  /* A card whose clock is block headers (software 1.15 and on) is told two things at a tap, and neither is a signature.
   *
   * The phone's own time (TELL_TIME), once in each time in the field (`link.one.told`; a card that left and came
   * back has forgotten it): a note the card keeps in its RAM and writes into the receipts and log entries made in
   * that time, so that its owner's screen can say when a payment was to the second. The card trusts it for nothing, so
   * nothing it is told can move its clock or its day.
   *
   * And, if the newest block header this phone has kept (08b-block-headers.js) is later than the clock the card
   * reads out (GET_INFO's `now`, read already), that header (SET_HEADER). The card moves its clock to the time in it if
   * the work in it is real and enough, and refuses it otherwise; an older header changes nothing and is no fault. When
   * the clock moved, the card's day may have too (a limit set before any header begins its window with the first), so
   * GET_INFO is read again. The log says the clock before and after.
   *
   * Neither fails the tap. A card that refuses the header keeps the clock it had, and the day it counts is the day it was
   * counting; a refusal is a line in the log. Only a card that is gone throws. `card.clock` says what was done:
   * { was, now, sent, told, refused }. A tap uses the header that is kept and never waits for one to be fetched. */
  function cardClock(t, card, one, o) {
    var info = card.info;
    card.clock = { was: info.now, now: info.now, sent: false, told: false, refused: '' };
    if (!info.headers || (o && o.noTime)) return Promise.resolve(card);
    var tell = (one && one.told) ? Promise.resolve() : t.ask(cardCommand(CARD_INS.tell, 0, cardU32Hex(Math.floor(Date.now() / 1000)))).then(function (r) {
      if (r.sw !== '9000') { console.warn('[foxy] card: it took no note of this phone\u2019s time (' + r.sw + ')'); return; }
      card.clock.told = true;
      if (one) one.told = true;
    });
    return tell.then(function () {
      var kept = headerKept();
      // the log says why nothing was shown: the owner's screen shows the card's clock, and a clock that does not move is a question
      if (!kept) { console.log('[foxy] card: its clock is at ' + info.now + '; this phone has no block header to show it'); return card; }
      if (!(Number(kept.time) > info.now)) {
        console.log('[foxy] card: its clock is at ' + info.now + ', not behind this phone’s newest block ' + headerShort(kept.hash) + ' (time ' + kept.time + '): nothing to show it');
        return card;
      }
      var block = headerShort(kept.hash), blockTime = kept.time;
      card.clock.sent = true;
      return t.ask(cardCommand(CARD_INS.header, 0, kept.hex, 4)).then(function (r) {
        if (r.sw !== '9000' || r.data.length !== 8) {
          card.clock.refused = r.sw;
          console.warn('[foxy] card: it would not take block ' + block + ' (' + r.sw + '); its clock stays at ' + info.now);
          return card;
        }
        var now = cardU32(r.data, 0);
        card.clock.now = now;
        console.log('[foxy] card: its clock was ' + info.now + ', block ' + block + ' (time ' + blockTime + ') moved it to ' + now);
        if (now === info.now) return card;
        return t.want(cardCommand(CARD_INS.info, cardInfoP1(card), '', 0), 'to say what it is').then(function (d) {
          card.info = cardInfoOf(d);
          return card;
        });
      });
    });
  }

  /* The card's limit set to `sats` with the owner's proof, in this tap (zero is
   * no limit). No PIN: the owner's phone does not know it. A card that has
   * never been shown a block header takes none but zero. Rejects
   * `not-owner` where this phone's words are not the ones the card was set up
   * with, and `no-owner` where it has none. */
  /* `tapSats`, where given, sets the limit on one tap in the same command (the
   * day's, then the tap's: eight bytes). There a limit whose number does not
   * change keeps its window and its count, so setting one of the two does not
   * begin the other again. Without it the command is the four bytes it always
   * was, and the tap's limit is left as it is.
   * `noPinSats`, where given (software 1.16 and on, and with `tapSats`), makes it twelve bytes: the day's, the tap's and the
   * no-PIN allowance, which is set to it (zero is none). A limit whose number does not change keeps its window and count in
   * all three forms, and the forms of four and eight bytes leave the allowance as it is. A card with no PIN refuses an
   * allowance above zero (6985): there is no PIN for it to be an allowance against. */
  function cardLimitTo(t, cardKey, sats, tapSats, noPinSats) {
    var n = Math.round(Number(sats));
    if (!(n >= 0 && n <= 4294967295)) return Promise.reject(cardError('bad-limit', 'That is not a limit a card can hold.'));
    var value = cardU32Hex(n);
    if (tapSats !== undefined && tapSats !== null) {
      var m = Math.round(Number(tapSats));
      if (!(m >= 0 && m <= 4294967295)) return Promise.reject(cardError('bad-limit', 'That is not a limit a card can hold.'));
      value += cardU32Hex(m);
      if (noPinSats !== undefined && noPinSats !== null) {
        var q = Math.round(Number(noPinSats));
        if (!(q >= 0 && q <= 4294967295)) return Promise.reject(cardError('bad-limit', 'That is not a limit a card can hold.'));
        value += cardU32Hex(q);
      }
    }
    return cardOwned(t, cardKey, 'set-limit', value).then(function (data) {
      return t.want(cardCommand(CARD_INS.setLimit, 0, data), 'its limit');
    });
  }

  /* SET_LIMIT's PIN form (0x33, software 1.21 and on), on a card with no owner: the holder's numbers, under the PIN given in this
   * tap. The limit on one payment and the no-PIN allowance, in the card's unit (zero is none for either), in the one command of
   * eight bytes. The card takes it while nothing is on it and nothing is owed to it (6A8D), and not once it has an owner (6A91).
   * The daily limit is not the PIN's to set, and this phone sets none. */
  /* `rate` (a card of 1.23, which takes twelve bytes: the two figures in cents and the rate, sats per dollar, 0 none): undefined for the eight
   * bytes of a card before it, which never gets a rate. */
  function cardPinLimits(t, tapSats, noPinSats, rate) {
    var a = Math.round(Number(tapSats) || 0), b = Math.round(Number(noPinSats) || 0);
    if (!(a >= 0 && a <= 4294967295) || !(b >= 0 && b <= 4294967295)) return Promise.reject(cardError('bad-limit', 'That is not a limit a card can hold.'));
    var r = (rate === undefined || rate === null) ? -1 : Math.round(Number(rate) || 0);
    if (r > 4294967295) return Promise.reject(cardError('bad-limit', 'That is not a limit a card can hold.'));
    return t.want(cardCommand(CARD_INS.setLimitPin, 0, cardU32Hex(a) + cardU32Hex(b) + (r >= 0 ? cardU32Hex(r) : '')), 'its limits');
  }

  /* A held tap (software 1.21 and on): the same command asked again for as long as the card answers 6A98, keep holding, each
   * answer after a signature's work of the card's own, until it answers. `most` is how many askings in all this phone will make
   * (the card wants six for a claim and ten for a history); `onHold(n)`, where given, is told each asking before it is made, so
   * that the screen says KEEP HOLDING and counts. Resolves the answer's data. 6A98 is not 9000: a phone that stops at the first
   * has done nothing. */
  var CARD_HOLD_MOST = 40;
  function cardHoldOn(t, apdu, onHold, doing, most) {
    var top = Number(most) > 0 ? Number(most) : CARD_HOLD_MOST;
    var ask = function (n) {
      try { if (typeof onHold === 'function') onHold(n); } catch (e) {}
      return t.ask(apdu).then(function (r) {
        if (r.sw === '9000') return r.data;
        if (r.sw === '6a98' && n < top) return ask(n + 1);
        throw cardRefused(r.sw, doing);
      });
    };
    return ask(1);
  }

  /* The history of a card with no owner (software 1.22), read by its holder as a guest on any Foxy: the PIN has been given in this
   * tap, the log is asked for and held for (`cardHoldOn`), then the receipts, which the same held tap opens, and the limit on one
   * payment, which the card says to the PIN in a tap that read its history. Put on `card.log`, `card.receipts`, `card.info.tapLimit`
   * and `card.tap`. Nothing of it is written down on this phone: the history is the holder's, and this phone is a friend's.
   * 6985 is a tap that paid already: `paid-here`. */
  function cardGuestRead(t, card, onHold) {
    var told = !!card.info.headers;
    // (1.23: P1 = 2 and 3, the other unit's count, each entry's unit and each receipt's)
    var u23 = cardIs123(card), ru = (card.record && card.record.unit) || 'sat';
    return cardHoldOn(t, cardCommand(CARD_INS.log, u23 ? 2 : 0, '', 0), onHold, 'its history').then(function (data) {
      var log = /** @type {any} */ (cardLogOf(data, !!card.info.quick, told, u23, ru));
      log.since = null;
      log.unit = (card.record && card.record.unit) || 'sat';
      card.log = log;
      var list = [];
      var page = function (back) {
        return t.want(cardCommand(CARD_INS.log, u23 ? 3 : 1, '', 0, back), 'its receipts').then(function (d) {
          var got = cardReceiptsOf(d, told, u23, ru);
          got.list.forEach(function (x, k) { list.push(Object.assign({ n: got.count - back - k, time: x.time, told: x.told, sats: x.sats, hash: x.hash, out: x.out }, x.unit !== undefined ? { unit: x.unit } : {})); });
          if (got.list.length === 3 && back + 3 < Math.min(16, got.count)) return page(back + 3);
          return got.count;
        });
      };
      return page(0).then(function (count) {
        card.receipts = { count: count, list: list.sort(function (a, b) { return a.n - b.n; }), fresh: 0, unit: log.unit, guest: true };
      });
    }).then(function () {
      return t.want(cardCommand(CARD_INS.info, cardInfoP1(card), '', 0), 'to say its limit');
    }).then(function (d) {
      var again = cardInfoOf(d);
      card.info.tapLimit = again.tapLimit;
      // (1.23: and the rate, said to the PIN in a tap that read the history)
      if (again.units && again.book) { card.info.rate = again.rate; card.info.rateSaid = true; }
      card.tap = cardTapOf(card.info);
      card.guest = true;
      return card;
    }, function (e) {
      if (e && e.sw === '6985') throw cardError('paid-here', 'This card has just paid, so it does not show its history in the same tap. Take it away from the phone and tap it again.');
      throw e;
    });
  }

  /* Whether this phone is the card's owner, found out by asking for the grant to
   * load (`ALLOW_LOAD`) and being answered or refused. Resolves true or false;
   * costs no PIN tries and changes nothing but that this tap may load with no PIN.
   * Anything but the card saying no (the card leaving, say) is thrown. */
  function cardGrant(t, cardKey) {
    return cardOwned(t, cardKey, 'load', '').then(function (data) {
      return t.ask(cardCommand(CARD_INS.allowLoad, 0, data)).then(function (r) {
        if (r.sw === '9000') return true;
        if (r.sw === '6a91' || r.sw === '6a90') return false;
        throw cardRefused(r.sw, 'to be loaded');
      });
    }, function (e) {
      if (e && (e.card === 'no-owner-key')) return false;
      throw e;
    });
  }

  /* ---- a limit lifted for a withdrawal, and put back -----------------------------
   *
   * Taking money off a card the holder owns is not stopped by the day's limit: in
   * the same tap the phone lifts the limit with its proof, spends, and puts the
   * old limit back, even when the spending fails part way. The old limit is
   * written down before it is lifted, so that a tap that ends between the two
   * leaves a note, and the next tap of this phone puts it back
   * (`cardLookHere`'s restore). */
  var CARD_LIFTED = 'foxy.flashcard.lifted';
  function cardLiftedAll() {
    var o = load(CARD_LIFTED, {});
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  }
  function cardLiftNote(cardKey, limit, tap) {
    var all = cardLiftedAll();
    var day = Number(limit) || 0, one = Number(tap) || 0;
    if (day > 0 || one > 0) all[cardKey] = { limit: day, tap: one, at: Date.now() }; else delete all[cardKey];
    mustSave(CARD_LIFTED, all);
  }

  /* Every place on the card that is not empty, as `cardSlotOf` gives them (a
   * spent place is `{ state: 'spent', i }` only). GET_PIECES says it all in a
   * page for each three pieces; a card that does not know that command (an
   * older applet), or whose answer to it is anything but a page, is read the old
   * way, the states and then each place in turn. Nothing is asked when `info`
   * says the card holds nothing. */
  /* `brief`: the card's short listing, for a till that is about to choose a
   * few pieces: for each unspent place its keyset, amount and date and no
   * more (sixteen bytes where the whole piece is eighty-one, so fourteen
   * places to a command where the whole form has three). A place read that
   * way has no nonce and no C (`bare`), and the ones chosen are asked for
   * whole before anything is signed (`cardFill`). */
  function cardSlotsRead(t, info, brief) {
    var slots = [];
    var expect = info.unspent + info.spent;
    if (!expect) return Promise.resolve(slots);
    var end = cardPlaces(info);
    if (brief) {
      var turns = 0;
      var page = function (from) {
        // a card of more than sixty-four places has a shorter listing still (`cardShortOf`)
        return t.want(cardCommand(CARD_INS.pieces, from, '', 0, info.wide ? 3 : 1), 'to list what it holds').then(function (d) {
          var got = info.wide ? cardShortOf(d, from, end) : cardBriefOf(d, from);
          got.slots.forEach(function (x) { slots.push(x); });
          turns += 1;
          if (got.next >= end || turns >= end) return slots;
          return page(got.next);
        });
      };
      return page(0);
    }
    var oldWay = function () {
      return t.want(cardCommand(CARD_INS.slots, 0, '', 0), 'to list what it holds').then(function (d) {
        var walk = Promise.resolve();
        for (var i = 0; i * 2 < d.length; i++) {
          if (d.substr(i * 2, 2) === '00') continue;
          (function (at) {
            walk = walk.then(function () { return t.want(cardCommand(CARD_INS.proof, at, '', 0), 'to show a piece'); }).then(function (hex) {
              var slot = /** @type {any} */ (cardSlotOf(hex));
              slot.i = at;
              slots.push(slot);
            });
          })(i);
        }
        return walk;
      });
    };
    var pages = 0;
    var more = function (from) {
      return t.ask(cardCommand(CARD_INS.pieces, from, '', 0)).then(function (r) {
        if (r.sw !== '9000') {
          // the first page refused: an applet without it, read the old way. A page after the first has no old way to go back to
          if (from === 0 && !slots.length) return oldWay();
          throw cardRefused(r.sw, 'to show what it holds');
        }
        var page = cardPageOf(r.data, from, info);
        page.slots.forEach(function (x) { slots.push(x); });
        pages += 1;
        if (page.next >= end || pages >= end) return null;
        return more(page.next);
      });
    };
    return more(0).then(function () { return slots; });
  }

  /* Read everything a card says with no PIN: what it is, its key (and that it
   * holds that key), its record, and every piece on it. The card is told the
   * time first (every tap does), so what it says of its day is what it will act
   * on: in the newest block header this phone
   * has, if the card's clock is behind it, and in the phone's own time as a note
   * (`cardClock`), after it has said what its clock reads.
   *
   * The key is proved, not taken on the card's word: the card signs this
   * phone's sixteen random bytes with sixteen of its own (AUTH). A reader's
   * copy of what GET_PROOF gives is everything about a card but its key, so
   * without this a pretend card could show another card's balance. It is the
   * card's slowest answer (the card's own Schnorr signature, most of a second),
   * so a read that only goes on to be paid by the card leaves it out
   * (`opts.noAuth`): there the card's signatures are proof enough of its key,
   * because every piece it signs is checked against that key before anything is
   * kept, and the mint's swap is what says paid. `card.proved` says whether
   * the key was proved here.
   *
   * `opts.real`: the card's own screen is reading it (and nothing a payment does): on a card of
   * software 1.20, read whole, the mint's proof is asked for each piece this phone does not
   * know to be real (`cardProofsRead`), to be checked afterwards (`cardRealCheck`).
   *
   * `opts.mine`: this phone's own reading of a card, for its holder's screen and
   * for what only an owner does. The card is asked whether this phone is its
   * owner (`card.mine`, by the grant to load, which also lets this tap load with
   * no PIN); and a limit that an earlier tap lifted and did not put back is put
   * back now. */
  /* The last card any flow read here: its key and what it is (`info`), for the app to know the card in hand off its own screen. */
  var lastCardRead = null;

  function cardLook(link, opts) {
    var o = opts || {};
    var t = cardTalk(link);
    var card = /** @type {any} */ ({ proved: false });
    /* How long each part of the read took, for the one line the log gets of
     * it: times and nothing else. A read that has grown slow says where. */
    var began = Date.now(), last = began, took = [];
    var mark = function (name) { var now = Date.now(); took.push(name + ' ' + (now - last)); last = now; };
    var said = function (c) {
      try { console.log('[foxy] card: read in ' + (Date.now() - began) + ' ms (' + took.join(', ') + ')'); } catch (e) {}
      return c;
    };
    /* Within one tap the card is told the time once, and its key is asked for
     * once: a second read in the same tap (a write's look after it, say) has
     * both from the first (`link.one`, which a sheet of the phone has and
     * nothing else does, and which a re-tap empties: a card that has left the
     * field has not been told this time it is powered up). */
    var one = (link && link.one) || null;
    var clocked = false, said23 = false;
    return t.ask('00a40400' + cardByte(CARD_AID.length / 2) + CARD_AID + '00').then(function (r) {
      if (r.sw !== '9000' || r.data.length !== 4) throw cardError('not-a-card', 'That is not a Foxy card.');
      mark('chosen');
      // its software, as it said on being chosen: from 1.15 its clock is block headers, and it is told after it has said what it reads (below)
      var major = parseInt(r.data.substr(0, 2), 16), minor = parseInt(r.data.substr(2, 2), 16);
      clocked = major > 1 || (major === 1 && minor >= 15);
      // 1.23 and on: asked with P1 = 3, its book and (to its holder) its rate as well (`cardInfoP1`)
      said23 = major > 1 || (major === 1 && minor >= 23);
      return 0;
    }).then(function () {
      mark('time');
      // P1 = 1: with the limit on one tap, from a card that has one; an older card answers as it always did
      return t.want(cardCommand(CARD_INS.info, said23 ? 3 : 1, '', 0), 'to say what it is');
    }).then(function (d) {
      card.info = cardInfoOf(d);
      /* Format 3 and 4, and 5 from a card of 1.23 that holds both units, whose secrets are format 4's; a format past that (or 5 from a card
       * that does not say it knows units) is a kind this phone does not know. */
      if (card.info.format !== CARD_FORMAT && card.info.format !== CARD_FORMAT_ALL && !(card.info.format === CARD_FORMAT_UNITS && card.info.units)) {
        throw cardError('not-a-card', 'That card is a kind this Foxy does not know.');
      }
      mark('what it is');
      // a card of 1.15 and on: the phone's time as a note, and the newest block header if the card's clock is behind it
      return clocked ? cardClock(t, card, one, o) : null;
    }).then(function (clock) {
      if (clock) mark('clock');
      if (one && one.key) return one.key;
      return t.want(cardCommand(CARD_INS.key, 0, '', 0), 'to give its key');
    }).then(function (d) {
      if (!cardHexOk(d, 33) || !/^0[23]/.test(d)) throw cardError('not-a-card', 'That card\u2019s key is not a key.');
      card.key = d;
      // the last card read, whatever the flow: the app's PIN-first rule for a change or a load asks it (`cardLastRead`)
      lastCardRead = { key: card.key, info: card.info, at: Date.now() };
      if (one) one.key = d;
      mark('key');
      if (link && link.one && link.one.proved === card.key) { card.proved = true; return null; }
      if (o.noAuth) return null;
      /* Proved once in this sheet, a key is not proved again in it (`link.one`,
       * which a session of the phone's sheet has and nothing else does). The
       * proof is the card's slowest answer, most of a second and often two,
       * and a tap that writes used to ask for it before the write and again
       * after: the same card, in the same session, with the same key. A card
       * that has signed a payment here has proved it too (`cardProvedHere`).
       * (Looked at above, before this read's own leave to skip the proof.) */
      var mine = new Uint8Array(16);
      window.crypto.getRandomValues(mine);
      card._nonce = hexOf(mine);
      return t.want(cardCommand(CARD_INS.auth, 0, card._nonce, 80), 'to prove it is the card').then(function (a) {
        if (!cardHexOk(a, 80)) throw cardError('not-a-card', 'That card could not prove it is the card it says it is.');
        var tag = sha256(Array.prototype.map.call('FoxyCard/auth', function (c) { return c.charCodeAt(0); }));
        var said = tag.concat(tag, Array.prototype.slice.call(bytesOfHex(card._nonce)),
                              Array.prototype.slice.call(bytesOfHex(a.slice(0, 32))), Array.prototype.slice.call(bytesOfHex(card.key)));
        var good = false;
        try { good = window.CashuTS.schnorrVerifyDigest(a.slice(32), new Uint8Array(sha256(said)), card.key) === true; } catch (e) { good = false; }
        delete card._nonce;
        if (!good) throw cardError('not-a-card', 'That card could not prove it is the card it says it is.');
        card.proved = true;
        cardProvedHere(link, card.key);
      });
    }).then(function () {
      if (!o.noAuth) mark('proof');
      return t.want(cardCommand(CARD_INS.card, 0, '', 0), 'to give its record');
    }).then(function (d) {
      card.record = cardRecordOf(d, card.info);
      // the screen behind the sheet draws the card as itself from here on
      try { if (FoxyWallet._card) FoxyWallet._card({ stage: 'seen', text: '', design: card.record.design || '' }); } catch (e) {}
      // a card of 1.15 and on says its clock's proof in its record: the hardest difficulty it has taken, and the hash of the last header
      if (card.info.headers) { card.info.headerBits = card.record.headerBits; card.info.headerHash = card.record.headerHash; }
      // the design the card names for its face, where its software carries one; a phone's own file may say otherwise for an older card
      card.design = card.record.design || '';
      mark('record');
      /* A card of 1.23 that holds a keyset of the other unit (format 5): its table, before a piece can be counted (GET_CARD P1 = 2). On
       * format 4 every piece is the record's unit and the table is not asked. */
      if (!(card.info.units && card.info.format === CARD_FORMAT_UNITS)) return null;
      return t.want(cardCommand(CARD_INS.card, 2, '', 0), 'to give its table of keysets').then(function (d2) {
        card.table = cardTableOf(d2);
        mark('table');
      });
    }).then(function () {
      /* The brief listing, where the caller is a till about to choose pieces
       * (`o.brief`) and the card has it. Not where this phone holds anything
       * of this card's that is told by a piece's nonce: a signature it asked
       * for and never saw (`cardAskedBack`), or a payment held from a tap cut
       * short. Those are settled by which pieces are still on the card. */
      /* `o.short`: a read that is about to write and has no use for what is
       * on the card but what it comes to (a till putting change back), on a
       * card of 128 places, where the whole listing of a deep drawer is
       * thirty commands and the short one is one. */
      card.bare = !!(((o.brief && card.info.quick) || (o.short && card.info.wide)) && !cardNoncesWanted(card.key));
      // a read that would have been short and is whole instead says why: the log is what shows a tap that reads more than it needs
      if (!card.bare && ((o.brief && card.info.quick) || (o.short && card.info.wide))) {
        var askedRows = cardStore(CARD_SWAPS).filter(function (r) { return r && r.asked && r.asked.card === card.key; }).length;
        var heldRows = cardStore(CARD_TAKEN).filter(function (r) { return r && r.resume && r.card === card.key; }).length;
        console.log('[foxy] card: read whole where a short read would do: ' + askedRows + ' signature(s) asked of this card and not settled, ' + heldRows + ' payment(s) held from a tap cut short');
      }
      return cardSlotsRead(t, card.info, card.bare);
    }).then(function (slots) {
      mark('pieces');
      card.slots = slots;
      card.pieces = card.slots.filter(function (x) { return x.state === 'unspent'; });
      // a card of 1.23: its pieces by unit (`card.units`)
      cardSortUnits(card);
      /* And on its holder's own reading of a card of both (`o.mine`, `o.real`), the card's own sums of each (GET_BALANCE P1 = 1), held to
       * what the table sorted: a difference is said in the log, and the pieces as sorted are what is shown. Never fails the read. */
      if (!(card.units && card.info.twoUnits && (o.mine || o.real))) return null;
      return t.ask(cardCommand(CARD_INS.balance, 1, '', 0)).then(function (r) {
        if (r.sw !== '9000') return;
        var sums;
        try { sums = cardBalancesOf(r.data); } catch (e) { return; }
        card.unitSums = sums;
        ['sat', 'usd'].forEach(function (u) {
          if (sums[u].sum !== card.units[u].balance % 4294967296 && !card.bare) {
            console.warn('[foxy] card: its own sum of ' + balanceWord(u) + ' is ' + sums[u].sum + ', and its pieces come to ' + card.units[u].balance);
          }
        });
      }, function (e) { if (e && e.card === 'gone') throw e; });
    }).then(function () {
      /* The mint's proof for each piece this phone does not know to be real, for the card's own screen (`o.real`) and nothing a payment
       * does: a read that lists the pieces whole, of a card that keeps proofs. It is kept on the piece for `cardRealCheck`, which the
       * screen calls once the card is let go; nothing is checked while the card is held. */
      if (!(o.real && card.info.proofs && !card.bare)) return null;
      return cardProofsRead(t, card).then(function () { mark('proofs'); }, function (e) {
        // a card that leaves is a read that failed, as ever; nothing else about the proofs is allowed to fail it
        if (e && e.card) throw e;
        console.warn('[foxy] card: its proofs could not be read:', (e && e.message) || e);
        mark('proofs');
      });
    }).then(function () {
      card.balance = card.pieces.reduce(function (n, x) { return n + x.amount; }, 0);
      /* (a card of 1.23 that holds both units: its balance is the record's unit's, as the card's own GET_BALANCE says it, and never a sum
       * across units; each unit's is in `card.units`) */
      if (card.units) card.balance = card.units[card.record.unit === 'usd' ? 'usd' : 'sat'].balance;
      card.day = cardDayOf(card.info);
      card.tap = cardTapOf(card.info);
      // software 1.16 and on: what the card signs for without its PIN, and what is left of it today
      card.noPin = cardNoPinOf(card.info);
      if (card.info.headers) {
        /* A card of 1.15 and on has been shown a block header, which no one can have made for a time that has not come, so
         * its clock cannot be ahead of the network's. This phone's newest header can be behind the card's, though (another
         * phone or a till showed the card a later block than this phone has fetched), and the card's clock is compared with
         * it instead of with this phone's own: ahead of it by more than three hours is a header too old to be this phone's
         * idea of the time. That is a line in the log and a number here, and nothing on any screen (`fcShow` leaves it out). */
        var newest = headerKept();
        card.clockAhead = (newest && card.info.now > Number(newest.time) + HEADER_SKEW) ? card.info.now - Number(newest.time) : 0;
        if (card.clockAhead) console.warn('[foxy] card: its clock is ' + card.clockAhead + ' seconds ahead of the newest block header this phone has');
      } else {
        // a card of 1.14 or before took its time from whoever signed it; this app tells none, and has nothing to compare
        card.clockAhead = 0;
      }
      if (!o.mine || !card.info.owner || card.info.locked) return said(card);
      /* Whether this phone is the owner, and a limit it lifted and did not put back */
      return cardGrant(t, card.key).then(function (yes) {
        card.mine = yes;
        /* The quicker card says its limit on one payment to its owner only,
         * with the grant just given: asked again, now that it knows this
         * phone is that. To anybody else it says none (`cardTapOf`, `hidden`). */
        if (!yes || !card.info.quick) return yes;
        return t.want(cardCommand(CARD_INS.info, cardInfoP1(card), '', 0), 'to say its limit').then(function (d) {
          var again = cardInfoOf(d);
          card.info.tapLimit = again.tapLimit;
          // (1.23: and the rate, which the grant opens as it opens the limit)
          if (again.units && again.book) { card.info.rate = again.rate; card.info.rateSaid = true; card.info.book = again.book; }
          card.tap = cardTapOf(card.info);
          return yes;
        });
      }).then(function (yes) {
        var note = cardLiftedAll()[card.key];
        if (!yes || !note || card.info.limit !== 0 || card.info.tapLimit !== 0) return card;
        var tapBack = card.info.tapKnown ? (Number(note.tap) || 0) : undefined;
        // (1.23: the sixteen bytes, the allowance and the rate as the card has them)
        return (cardIs123(card) ? cardLimit23(t, card, { day: note.limit, tap: tapBack || 0 }) : cardLimitTo(t, card.key, note.limit, tapBack)).then(function () {
          cardLiftNote(card.key, 0);
          // as the card has it now: the limits back, and a day and a tap begun at its clock with nothing spent
          card.info.limit = note.limit; card.record.limit = note.limit;
          card.info.windowStart = card.info.now; card.info.spentToday = 0;
          // the day's window began again, and the no-PIN allowance counts in the same window
          if (card.info.noPinKnown) card.info.noPin = { limit: card.info.noPin.limit, spent: 0 };
          if (tapBack) { card.info.tapLimit = tapBack; card.info.tapStart = card.info.now; card.info.tapSpent = 0; }
          card.day = cardDayOf(card.info);
          card.tap = cardTapOf(card.info);
          card.noPin = cardNoPinOf(card.info);
          card.restored = note.limit || tapBack || 0;
          console.log('[foxy] card: a limit lifted for a withdrawal and not put back is put back now');
          return card;
        }, function () { return card; });
      }).then(function (c) {
        mark('owner');
        // a card of 1.23: its figures are cents and never move; its rate does, silently, and a rate far off is asked about first (`cardRepeg23`)
        if (cardIs123(c)) return cardRepeg23(t, c, o).then(function (c2) { mark('rate'); return c2; });
        /* The limit on one payment was set in dollars, and the price has
         * moved: the card's sats are set to match, with the owner's proof.
         * Only a bitcoin card's: a dollar card's limits are cents already,
         * and no price ever moves them. */
        var want = (c.mine && c.info.paced && c.record.unit === 'sat') ? cardPaceSats(c.key, o.price) : 0;
        var has = Number(c.info.tapLimit) || 0;
        if (!(want > 0) || !(has > 0) || Math.abs(want - has) <= has * CARD_PACE_DRIFT) return c;
        return cardLimitTo(t, c.key, c.info.limit, want).then(function () {
          console.log('[foxy] card: its limit on one payment is set to the sats its dollars are worth now');
          c.info.tapLimit = want;
          c.tap = cardTapOf(c.info);
          c.repaced = want;
          mark('limit');
          return c;
        }, function () { return c; });
      }).then(function (c) {
        /* And the no-PIN allowance, set in dollars the same way (software 1.16): the card's sats are set to match when the
         * price has moved, in the one command that carries the day's limit and the tap's as they stand. */
        var wantNp = (c.mine && c.info.noPinKnown && c.info.pinSet && c.record.unit === 'sat' && !cardIs123(c)) ? cardPaceNoPinSats(c.key, o.price) : 0;
        var hasNp = Number(c.info.noPin && c.info.noPin.limit) || 0;
        if (!(wantNp > 0) || !(hasNp > 0) || Math.abs(wantNp - hasNp) <= hasNp * CARD_PACE_DRIFT) return c;
        return cardLimitTo(t, c.key, c.info.limit, Number(c.info.tapLimit) || 0, wantNp).then(function () {
          console.log('[foxy] card: its no-PIN allowance is set to the sats its dollars are worth now');
          c.info.noPin = { limit: wantNp, spent: 0 };
          c.noPin = cardNoPinOf(c.info);
          c.repacedNoPin = wantNp;
          mark('no-PIN limit');
          return c;
        }, function () { return c; });
      }).then(function (c) {
        // and the card's own log, which the owner's grant opens
        return cardLogRead(t, c);
      }).then(function (c) { mark('log'); return said(c); });
    });
  }

  /* Whether this phone holds anything of this card's that only the pieces'
   * nonces can settle. */
  function cardNoncesWanted(key) {
    return cardStore(CARD_SWAPS).some(function (r) { return r && r.asked && r.asked.card === key; })
      || cardStore(CARD_TAKEN).some(function (r) { return r && r.resume && r.card === key; });
  }

  /* This card has shown, in this session, that it holds its key: by AUTH, or by a
   * signature for a payment that was good for that key. */
  function cardProvedHere(link, key) {
    if (link && link.one && key) link.one.proved = key;
  }

  /* The mint's proof for each unspent piece of a card that this phone does not know to be real (`cardRealSet`), read from the card
   * with GET_DLEQ, two places to a command, and kept on the piece: `dleq: { e, s, r }` as hex, or null where the card gave none (`00`:
   * a piece loaded with no proof, a card with no room for proofs, or an answer that is not the shape of one). Checked by nobody here:
   * the card has not checked it and this does not either (`cardRealCheck`). Resolves how many proofs there were. A card that leaves
   * rejects, as it does in any read. */
  function cardProofsRead(t, card) {
    var had = cardRealSet(card.key);
    var want = (card.pieces || []).filter(function (x) { return x && !had[String(x.nonce)] && Number.isInteger(x.i); });
    var got = 0;
    var walk = Promise.resolve();
    for (var from = 0; from < want.length; from += 2) {
      (function (two) {
        walk = walk.then(function () {
          return t.ask(cardCommand(CARD_INS.dleq, two[0].i, '', 0, two.length > 1 ? two[1].i : 255));
        }).then(function (r) {
          var list = cardDleqParse(r.sw === '9000' ? r.data : '', two.length);
          two.forEach(function (x, k) { x.dleq = list[k]; if (list[k]) got += 1; });
        });
      })(want.slice(from, from + 2));
    }
    return walk.then(function () { return got; });
  }

  /* One answer to GET_DLEQ, for `n` places (one or two): for each, in order, `{ e, s, r }` as hex, or null where the card gave
   * none (`00`). An answer that is not whole, or has anything after the last proof, is no proof for any of them. */
  function cardDleqParse(hex, n) {
    var h = String(hex || ''), at = 0, list = [], whole = true;
    for (var k = 0; k < n; k++) {
      var tag = h.substr(at, 2);
      if (tag === '00') { list.push(null); at += 2; continue; }
      if (tag === '01' && h.length >= at + 194) {
        list.push({ e: h.substr(at + 2, 64), s: h.substr(at + 66, 64), r: h.substr(at + 130, 64) });
        at += 194;
        continue;
      }
      whole = false;
      break;
    }
    if (!whole || at !== h.length) return Array.from({ length: n }, function () { return null; });
    return list;
  }

  /* What the mint's proofs on a card show of its pieces, once they have been read (`cardProofsRead`): for each unspent piece the secret is
   * built again as the card builds it (`cardSecret`), the piece's whole keyset name (`cardFullId`) and the mint's key for its amount are
   * had from this wallet, and `hasValidDleq` is asked whether that key signed it (NUT-12, with the blinding factor the card kept). A piece
   * whose nonce is in the real store already is not asked again. It answers, as a promise:
   *   'ok'        every unspent piece on the card is real, here and now (the store has them all);
   *   'fake'      a proof was read and does not verify: the card holds a piece the mint did not sign;
   *   'unproven'  none was shown fake, but not every piece is known real: one has no proof, or the mint's keys for it are not at hand
   *               (keys that are not at hand never make 'fake'), or the card was not read for them.
   * The store is cut down to the pieces on the card, and the pieces that verify are written down as real. Null for a read that lists
   * no nonces (`bare`) and for a card that keeps no proofs, which say nothing. A few pieces at a time, with the page let breathe between, since each takes a little time
   * of its own and a card holds a hundred and twenty-eight. One line in the log: how many were proven, had no proof, and failed (never
   * a secret, a nonce or a point). Never rejects. */
  function cardRealCheck(w, card) {
    var CT = window.CashuTS;
    // a card that keeps no proofs, or a read that lists no nonces, has nothing to say
    if (!card || !card.key || card.bare || !Array.isArray(card.pieces) || !(card.info && card.info.proofs)) return Promise.resolve(null);
    var began = Date.now();
    var pieces = card.pieces;
    // the list is cut down to the pieces on the card now, before the work, so that a piece a write notes while it goes on is not cut with it
    try { cardRealNote(card.key, [], pieces.map(function (x) { return String(x.nonce); })); } catch (e0) {}
    var had = cardRealSet(card.key);
    var found = [], proven = 0, none = 0, away = 0, fake = 0, checked = 0;
    var one = function (x) {
      if (had[String(x.nonce)]) { proven += 1; return; }
      var d = cardDleqOf(x.dleq);
      // none read, or an answer that is not a whole proof: a piece with no proof is not shown real, and is not shown fake either
      if (!d) { if (x.dleq) fake += 1; else none += 1; return; }
      var id = '', ks = null, key = '', secret = '';
      try {
        id = cardFullId(w, x.keyset);
        ks = id ? keysetFor(w, id) : null;
        key = (ks && ks.keys) ? String(ks.keys[String(satsOf(x.amount))] || '') : '';
        secret = cardSecret(x.nonce, card.key, x.date, card.record && card.record.refundKey, card.info && card.info.format);
      } catch (e) { key = ''; }
      if (!key) { away += 1; return; }
      var good = false;
      checked += 1;
      try { good = !!CT && CT.hasValidDleq({ id: id, amount: satsOf(x.amount), C: String(x.C), secret: secret, dleq: d }, ks, { require: true }) === true; } catch (e2) { good = false; }
      if (good) { found.push(String(x.nonce)); proven += 1; } else fake += 1;
    };
    var at = 0;
    var step = function () {
      for (var end = at + 4; at < pieces.length && at < end; at++) one(pieces[at]);
      if (at >= pieces.length) return Promise.resolve();
      return new Promise(function (go) { setTimeout(go, 0); }).then(step);
    };
    /* The keys of a keyset this wallet has not loaded (an older one of the mint's, after it has changed its keys) are asked for first,
     * where a piece that waits to be checked is of one, as the card's own change does it (`cardAskChange`): once, and not for long.
     * Keys that do not come leave those pieces unproven, and never fake. A keyset that is not this mint's has no name here (`cardFullId`)
     * and is not asked for. */
    var need = {};
    pieces.forEach(function (x) {
      if (had[String(x.nonce)] || !cardDleqOf(x.dleq)) return;
      var id = '';
      try { id = cardFullId(w, x.keyset); } catch (e) { id = ''; }
      if (id && !keysetFor(w, id)) need[id] = true;
    });
    var missing = Object.keys(need);
    var loaded = (missing.length && w && typeof w.ensureOperableKeysets === 'function')
      ? withTimeout(Promise.resolve().then(function () { return w.ensureOperableKeysets(missing); }), CARD_REAL_KEYS_MS, 'the keys of a card\u2019s keyset').then(function () {}, function () {})
      : Promise.resolve();
    return loaded.then(step).then(function () {
      try { cardRealNote(card.key, found); } catch (e) {}
      console.log('[foxy] card: its proofs: ' + proven + ' piece(s) proven (' + checked + ' checked now), ' + none + ' with no proof, ' + away
        + ' that cannot be checked here, ' + fake + ' that fail, in ' + (Date.now() - began) + ' ms');
      return fake ? 'fake' : (proven === pieces.length ? 'ok' : 'unproven');
    }).then(null, function () { return 'unproven'; });
  }

  /* The pieces a card is about to pay a phone with no route, proved before anything is asked of it: the mint's proof for each
   * (NUT-12) read from the card with GET_DLEQ, two places to a command, for the places picked and no others, and checked here
   * against the mint's keys this phone has kept. With no route the mint cannot be asked whether the pieces are its own, and
   * this is the one thing that says so. It says nothing of whether they are spent: a copy of the card could spend them
   * first, and the swap at the first connection is what finds that out (`cardKeptFailed`).
   *
   * Every piece is proved afresh, every time: the store of pieces known real (`cardRealSet`) is by nonce alone, and is not
   * trusted for money taken with no route. Each piece's secret is the card's, locked to its key with the one-signature flag,
   * and its date (which the mint's signature covers, being in the secret) is far enough off to be swapped before it.
   *
   * Resolves how many were proved. Rejects, before any PIN and before the card is asked to sign:
   *   'fake'              a proof was read and does not verify: the card holds money the mint did not sign;
   *   'offline-unproven'  a piece with no proof, keys not at hand for it, or an answer that was not whole;
   *   'renew'             a piece nearer its date than a week, by the clock with the most evidence behind it (`cardOfflineNow`).
   * A card that leaves rejects as it does in any read. One line in the log: counts and time, never a nonce or a point. */
  function cardOfflineProve(t, card, picked, w) {
    var CT = window.CashuTS;
    var began = Date.now();
    var list = (picked || []).filter(function (p) { return !!p; });
    var read = [];
    var walk = Promise.resolve();
    for (var from = 0; from < list.length; from += 2) {
      (function (two) {
        walk = walk.then(function () {
          if (!two.every(function (p) { return Number.isInteger(p.slot); })) return two.map(function () { return null; });
          return t.ask(cardCommand(CARD_INS.dleq, two[0].slot, '', 0, two.length > 1 ? two[1].slot : 255)).then(function (r) {
            return cardDleqParse(r.sw === '9000' ? r.data : '', two.length);
          });
        }).then(function (got) {
          two.forEach(function (p, k) { read.push({ p: p, d: got[k] }); });
        });
      })(list.slice(from, from + 2));
    }
    return walk.then(function () {
      var proven = 0, none = 0, away = 0, fake = 0, odd = 0, near = 0;
      // (the card's own phone, being paid by it, holds it to its own margin, as `cardUsable` did)
      var floor = cardOfflineNow(card, true) + (cardMine(card) ? cardOwnMargin() : cardDateMargin());
      read.forEach(function (x) {
        var p = x.p, d = cardDleqOf(x.d);
        // none given, or an answer that was not whole: nothing says this piece is the mint's, and nothing says it is not
        if (!d) { none += 1; return; }
        var id = String(p.id), ks = null, key = '';
        try {
          ks = keysetFor(w, id);
          key = (ks && ks.keys) ? String(ks.keys[String(satsOf(p.amount))] || '') : '';
        } catch (e) { key = ''; }
        if (!key) { away += 1; return; }
        /* Of the card's own unit: a piece of sats on a dollar card (or of dollars on a bitcoin card) is a card that was written
         * wrong, and its money is not what it says. Refused as money the mint did not sign for it. */
        if (String((ks && ks.unit) || 'sat') !== String((card.record && card.record.unit) || 'sat')) { fake += 1; return; }
        /* The lock is the card's own and the one signature's: that is what makes the signature to come this phone's alone.
         * It and the date below cannot fail as the pieces are read today (the secret is made from the card's key, and
         * `cardFill` held each place's date to the margin already); they are here so that a change to either of those
         * cannot let a piece through unasked. */
        var parts = cardSecretParts(p.secret);
        if (!parts || parts.key !== card.key || parts.all !== true) { odd += 1; return; }
        // the date the mint signed (it is in the secret), held to the margin again
        if (parts.date && parts.date < floor) { near += 1; return; }
        var good = false;
        try { good = !!CT && CT.hasValidDleq({ id: id, amount: satsOf(p.amount), C: String(p.C), secret: String(p.secret), dleq: d }, ks, { require: true }) === true; }
        catch (e2) { good = false; }
        if (good) proven += 1; else fake += 1;
      });
      console.log('[foxy] card: offline, its pieces proved: ' + proven + ' of ' + read.length + ' proven, ' + none + ' with no proof, ' + away
        + ' with no keys here, ' + odd + ' not locked as a card locks, ' + near + ' too near their date, ' + fake + ' that fail, in '
        + (Date.now() - began) + ' ms (' + Math.ceil(read.length / 2) + ' more command(s) to the card)');
      if (fake) throw cardError('fake', 'This card holds money the mint did not sign. Nothing was taken.');
      if (near) throw cardError('renew', CARD_OFFLINE_NEAR, { stale: near });
      if (proven !== list.length || !list.length) {
        throw cardError('offline-unproven', 'This card cannot prove its money to a phone that is offline. Take this payment when this phone is online.',
                        { proven: proven, none: none + away + odd });
      }
      return proven;
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
   * the phone has none to give. `unit`: what the card is being set up to hold,
   * which its row says (a row that says none is bitcoin), so that what is
   * taken back from it later is taken in that unit. */
  function cardRefundKey(cardKey, unit) {
    var u = unitOf(unit) || 'sat';
    var known = cardsOnFile()[cardKey];
    if (known && /^0[23][0-9a-f]{64}$/.test(String(known.refundKey || ''))) {
      // a set-up cut short and done again may be in the other unit: the record the card is given says, and so does its row
      if ((unitOf(known.unit) || 'sat') !== u) {
        var mine = cardsOnFile();
        mine[cardKey] = Object.assign({}, known, { unit: u });
        mustSave(CARDS, mine);
      }
      return Promise.resolve(known.refundKey);
    }
    return primeLockPool().then(function () {
      var id = 'flashcard-' + cardKey;
      var pub = lockPubFor(id) || takeLockKey(id);
      if (!pub) return '';
      var row = lockKeys()[id] || {};
      var all = cardsOnFile();
      all[cardKey] = { refundKey: pub, refundIndex: Number.isInteger(row.i) ? row.i : -1,
                       mint: canonicalMint(mintUrl || ''), unit: u, at: Date.now() };
      mustSave(CARDS, all);
      return pub;
    });
  }

  /* What its owner chose a card of software 1.23 to hold when this phone set it up: 'usd' or 'sat' for one currency, 'both' for
   * either, kept as `hold` on the card's row here (`CARDS`). It is this phone's promise and not the card's, which takes either
   * currency whatever was chosen: a one-currency card is offered only that one when this phone adds to it. `hold` '' or absent
   * takes the note off (a set-up with nothing chosen, or a card before 1.23). Nothing is written where the card has no row. */
  function cardHoldNote(cardKey, hold) {
    var h = hold === 'usd' || hold === 'sat' || hold === 'both' ? hold : '';
    var all = cardsOnFile();
    var row = all[cardKey];
    if (!row || (row.hold || '') === h) return;
    if (h) row.hold = h; else delete row.hold;
    all[cardKey] = row;
    mustSave(CARDS, all);
  }

  /* A card's name, given on this phone (NAME CARD in the set-up, RENAME CARD in the card's menu; 26j-card-wheel.js `fcNameOpen`). The card is
   * told nothing of it: it is this phone's word for the card, kept as `name` on the card's row here (`CARDS`), and, for a card this phone
   * has no row for (one set up for somebody else, which is never on that list, and must not be put on it), in a note of its own by the
   * card's key (`CARD_NAMES`). Trimmed, cut at CARD_NAME_MAX characters and put in capitals, as a card's name is shown everywhere;
   * '' takes the name off. */
  var CARD_NAMES = 'foxy.flashcard.names';
  var CARD_NAME_MAX = 24;
  function cardNameClean(name) {
    var t = String(name === undefined || name === null ? '' : name).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    // (in capitals before the cut: a letter's capital can be two, ß as SS, and the cut is of what is kept)
    return Array.from(t.toUpperCase()).slice(0, CARD_NAME_MAX).join('').trim();
  }
  function cardNameNotes() {
    var all = load(CARD_NAMES, {});
    return (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
  }
  function cardNameOf(cardKey) {
    if (typeof cardKey !== 'string' || !cardKey) return '';
    var row = cardsOnFile()[cardKey];
    var own = row && typeof row.name === 'string' ? cardNameClean(row.name) : '';
    if (own) return own;
    var noted = cardNameNotes()[cardKey];
    return typeof noted === 'string' ? cardNameClean(noted) : '';
  }
  function cardNameKeep(cardKey, name) {
    if (typeof cardKey !== 'string' || !cardKey) return '';
    var n = cardNameClean(name);
    var all = cardsOnFile();
    var notes = cardNameNotes();
    if (all[cardKey]) {
      var row = all[cardKey];
      if (n) row.name = n; else delete row.name;
      all[cardKey] = row;
      mustSave(CARDS, all);
      // (one place for it: a note from before the card had a row here goes)
      if (Object.prototype.hasOwnProperty.call(notes, cardKey)) { delete notes[cardKey]; save(CARD_NAMES, notes); }
      return n;
    }
    if (n) notes[cardKey] = n; else if (Object.prototype.hasOwnProperty.call(notes, cardKey)) delete notes[cardKey]; else return n;
    mustSave(CARD_NAMES, notes);
    return n;
  }

  /* The same for a card as `cardLook` gave it: 'usd' or 'sat' where it was set up here to hold that one and holds nothing of the
   * other; 'both' where it was set up for both, or holds the other or may (format 5: it was given some, here or on another phone);
   * '' where this phone made it no promise (not its row, a row whose key is not on the card, a card before 1.23, nothing chosen). */
  function cardHoldOf(card) {
    if (!cardIs123(card) || !card.record || !card.key) return '';
    var row = cardsOnFile()[card.key];
    if (!row || !row.refundKey || row.refundKey !== card.record.refundKey) return '';
    var h = row.hold === 'usd' || row.hold === 'sat' || row.hold === 'both' ? row.hold : '';
    if (h !== 'usd' && h !== 'sat') return h;
    var other = h === 'usd' ? 'sat' : 'usd';
    var whole = card.whole || card;
    if (cardBoth(whole) || (whole.units && whole.units[other] && whole.units[other].balance > 0)) return 'both';
    return h;
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
  /* DUE: change a card is owed for a payment, which the swap that makes it
   * failed to make. The payment stands, and this phone holds the change (its
   * entry says the gross, 'never sent') until `cardDueRetry`, on every
   * connection, makes it and owes it to the card like any other change. It
   * was kept for good, before, and the card's holder never told. Given up
   * after CARD_DUE_DAYS, when the receiver keeps it as before. */
  var CARD_DUE = 'foxy.flashcard.due';
  var CARD_DUE_DAYS = 30;
  /* Thirty days, for a piece on a recoverable card: after it, the key that
   * loaded the card may take the piece back. A piece this close to its date is
   * not taken in payment (some mints stop honouring the card's own key then). */
  /* The hold: how far ahead a piece's date is set, thirty days. A test build may shorten it (the native side sets
   * `window.__foxyCardHoldSecs`, a Debug-only key of a local build; never in the app as shipped): every margin below
   * scales with it, so a ten-minute hold behaves as the thirty-day one does, only faster. Read at use, never kept. */
  var CARD_HOLD_DEFAULT = 30 * 24 * 3600;
  function cardHoldSecs() {
    var h = 0;
    try { h = Math.round(Number(typeof window !== 'undefined' && window.__foxyCardHoldSecs) || 0); } catch (e) { h = 0; }
    return h > 0 ? h : CARD_HOLD_DEFAULT;
  }
  function cardDateAhead() { return cardHoldSecs(); }
  // the receiver's margin offline: a week of the thirty days, scaled
  function cardDateMargin() { return Math.round(cardHoldSecs() * 7 / 30); }
  // the owner's own margin: ten minutes of the thirty days; of a shorter hold, a twentieth, ten seconds at least
  function cardOwnMargin() { var h = cardHoldSecs(); return h === CARD_HOLD_DEFAULT ? 10 * 60 : Math.max(10, Math.round(h / 20)); }
  // a one-signature card keeps a date that is still twenty of the thirty days off, scaled
  function cardDateReuse() { return Math.round(cardHoldSecs() * 20 / 30); }
  /* A week: what a phone with no route needs left on a piece. It keeps what the
   * card signed until it is online again, and has to reach the mint before the
   * piece's date, when its loader may take it back. */
  // (CARD_DATE_MARGIN became cardDateMargin(), which scales with the hold)
  /* A day: what a phone with a route needs. It swaps the pieces in at once, so
   * the date only has to be far enough off that the swap is not answered after
   * it. A week here would stop a card that only meets strangers from paying
   * three weeks after its money went on, a week before its date. */
  var CARD_ONLINE_MARGIN = 24 * 3600;
  // a day of the thirty days when the receiver is online; of a shortened hold, a thirtieth, ten seconds at least
  function cardOnlineMargin() { var h = cardHoldSecs(); return h === CARD_HOLD_DEFAULT ? CARD_ONLINE_MARGIN : Math.max(10, Math.round(h / 30)); }
  /* Those margins are a stranger's: they keep a receiver from taking a piece
   * its loader could take back before the receiver's swap is made. The phone
   * that holds the card's refund key is that loader, and has nobody to guard
   * against but the clock: ten minutes, so a swap begun before the date is not
   * answered after it. Without this a holder could not empty or renew their
   * own card in its last days. */
  // (CARD_OWN_MARGIN became cardOwnMargin())
  /* Twenty days: a card its owner reads online with less than this left on its
   * money is renewed for thirty days more (the owner's refresh, on the card's
   * screen). A top-up keeps a date only while it has this much left too
   * (CARD_DATE_REUSE), so it never joins money that is about to be renewed. */
  var CARD_REFRESH_LEFT = 20 * 24 * 3600;

  /* KEPT: a card's payment to this phone while it had no route, signed over to
   * this phone and proved by the mint's own proofs, between the tap and the
   * mint's swap (`cardKeepSigned`). One record a payment:
   *   { id, at, state, card, format, software, mint, unit, sats, asked, fee, sum,
   *     request: { inputs, outputs }, swap: { keyset, counter, amounts, digest },
   *     dates: { first, last }, refundKey, proven, clock: { phone, used }, cacheAt,
   *     tries, triedAt, why, endedAt, terms }
   * `state` is kept, posting (the mint is being asked), or one that is over:
   * settled, spent (the card's pieces were spent first, by a copy of it), retired
   * (the mint will not take the swap now: its keys or its fee changed) or unwound
   * (its date passed, and the money went back to the card's owner). The row in
   * the unclaimed store is what counts it in the balance and what the walk on
   * every connection swaps in (`claimUnclaimed`); this is what that walk is told
   * about it, and the whole request again, should the row or the swap's own row
   * (CARD_SWAPS) be lost. Records that are over are kept for CARD_KEPT_KEEP_MS,
   * and the others for ever. */
  var CARD_KEPT = 'foxy.flashcard.kept';
  var CARD_KEPT_KEEP_MS = 60 * 24 * 3600 * 1000;
  // how near its date a payment that has not settled is said to be late (once a session)
  var CARD_KEPT_WARN = 2 * 24 * 3600;

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
   * about here. A card of software 1.20 (`info.proofs`) is also held to what this phone has found real
   * (`cardRealSet`): the mint's word that its pieces are unspent is not its word that they are real, so
   * with a piece on it that is not known real the mint's word of an hour ago is worth nothing here. */
  function cardCheckedAt(card) {
    if (!card || !card.key || !card.pieces || !card.pieces.length) return 0;
    var note = cardCheckedAll()[card.key];
    if (!note || !Array.isArray(note.nonces) || !(Number(note.at) > 0)) return 0;
    var had = {};
    note.nonces.forEach(function (n) { had[String(n)] = true; });
    if (!card.pieces.every(function (x) { return had[String(x.nonce)]; })) return 0;
    if (card.info && card.info.proofs) {
      var real = cardRealSet(card.key);
      if (!card.pieces.every(function (x) { return real[String(x.nonce)]; })) return 0;
    }
    return Number(note.at);
  }

  /* ---- which of a card's pieces this phone knows are real ---------------------------------------
   *
   * The mint's word that a card's pieces are unspent (above) is not its word that they are real: a made-up C reads unspent until
   * somebody tries to spend it. From software 1.20 a card keeps the mint's NUT-12 proof with a piece it is loaded with one for, and
   * this phone checks it with the mint's keys (`cardRealCheck`). What it has found real is kept by the piece's nonce, as the store above
   * is: { <card key>: { at, nonces } }, twenty cards and the oldest dropped, and at most CARD_REAL_NONCES nonces a card, cut down to the
   * pieces on the card at each read of it that checks it. A nonce goes in when this phone wrote that piece onto the card and the card
   * said it stored it, the piece being one this phone had from the mint itself (`cardWriteOwed`), or when a proof read from the card
   * verified. A piece that came off a card and is written back as it was is real only if its nonce was here already. A nonce says
   * nothing of what is spent; the store is read by the line under the card's title and by nothing else, so a write that does not land
   * costs a proof read from the card again and nothing more. */
  var CARD_REAL = 'foxy.flashcard.real';
  var CARD_REAL_CARDS = 20;
  var CARD_REAL_NONCES = 128;
  // how long the keys of a keyset this wallet has not loaded are waited for before the pieces of it are left unproven (`cardRealCheck`)
  var CARD_REAL_KEYS_MS = 10000;
  function cardRealAll() {
    var o = load(CARD_REAL, {});
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  }
  // the nonces this phone knows to be real on a card, as a set
  function cardRealSet(cardKey) {
    var row = cardRealAll()[cardKey];
    var had = {};
    if (row && Array.isArray(row.nonces)) row.nonces.forEach(function (n) { had[String(n)] = true; });
    return had;
  }
  /* `add`: nonces found real; `only`, where given, the nonces of the pieces on the card now, which the card's list is cut down to first.
   * Written only when the list changes. */
  function cardRealNote(cardKey, add, only) {
    if (!cardKey) return;
    var all = cardRealAll();
    var row = all[cardKey];
    var was = (row && Array.isArray(row.nonces)) ? row.nonces.map(String) : [];
    var list = was.slice();
    if (Array.isArray(only)) {
      var on = {};
      only.forEach(function (n) { on[String(n)] = true; });
      list = list.filter(function (n) { return on[n]; });
    }
    var has = {};
    list.forEach(function (n) { has[n] = true; });
    (add || []).forEach(function (n) {
      var nonce = String(n || '');
      if (nonce && !has[nonce]) { has[nonce] = true; list.push(nonce); }
    });
    if (list.length > CARD_REAL_NONCES) list = list.slice(-CARD_REAL_NONCES);
    if (list.length === was.length && list.every(function (n, i) { return n === was[i]; })) return;
    if (list.length) all[cardKey] = { at: Date.now(), nonces: list }; else delete all[cardKey];
    var keys = Object.keys(all).sort(function (a, b) { return (Number(all[a].at) || 0) - (Number(all[b].at) || 0); });
    while (keys.length > CARD_REAL_CARDS) { var oldest = keys.shift(); if (oldest !== undefined) delete all[oldest]; }
    save(CARD_REAL, all);
  }

  /* The fields of a locked piece's secret: its nonce, the key it is locked
   * to, its date and its refund key ('' and 0 where it has none). Null for
   * anything that is not such a secret. */
  function cardSecretParts(secret) {
    var j = null;
    try { j = JSON.parse(String(secret)); } catch (e) { return null; }
    if (!Array.isArray(j) || j[0] !== 'P2PK' || !j[1] || typeof j[1] !== 'object') return null;
    // `all`: the piece is of a card that signs once for a payment (its secret carries SIG_ALL)
    var out = { nonce: String(j[1].nonce || ''), key: String(j[1].data || ''), date: 0, refundKey: '', all: false };
    (Array.isArray(j[1].tags) ? j[1].tags : []).forEach(function (tag) {
      if (!Array.isArray(tag)) return;
      if (tag[0] === 'sigflag') out.all = tag[1] === 'SIG_ALL';
      if (tag[0] === 'locktime') out.date = Number(tag[1]) || 0;
      if (tag[0] === 'refund') out.refundKey = String(tag[1] || '');
    });
    return out;
  }

  /* ---- what is cut for a card ------------------------------------------------
   *
   * A card signs one piece at a time, and the signing is the card's own work: most
   * of a second for each. A card is paid from by the piece, and a price that no set
   * of its pieces makes exactly has to be paid with a piece that is too big and
   * made up for in change, which is a second swap and a second tap. So money for a
   * card is cut like the float in a cash drawer: every power of two from 1 up to the
   * largest that fits is there at least once, and the rest of the amount comes after
   * them in powers of two. Pieces like that make every price up to the whole
   * of what is on the card exactly, and a payment signs only the few it needs.
   *
   * The largest that fits is the largest whose drawer, 1 + 2 + 4 + … up to it, is no
   * more than what the card will hold, and the rest of the amount comes after it
   * in powers of two: with that, every price up to the whole of what is on the
   * card is exact. Nothing is made that is not a power of two, and none above
   * the mint's own largest key.
   *
   * One of each rung makes one exact payment: the payment takes the rungs its
   * price is made of, and the next price needs some of the same. A till's
   * drawer has several of each coin for that, and so does a card's: with the
   * places a load has left, the smallest rungs are deepened, to
   * CARD_DRAWER_DEEP of each (two where three do not fit), the rest of the
   * amount cut again after them. 2,000 sats is 1 to 512 once, two more of each
   * of 1 to 128, and 256, 128, 64, 16, 2 and 1: thirty-two pieces. 50,000 is 1
   * to 16384 once, two more of each of 1 to 4096, and 512, 256, 64, 16, 2 and
   * 1: forty-seven. A load is at most CARD_LOAD_PIECES pieces — about half the
   * card's 64 places — so that a drawer deep enough to pay small amounts
   * offline with exact change still leaves room for the larger proofs a load's
   * big value is carried in, and for the change an online payment writes back.
   * Deeper than CARD_DRAWER_DEEP was tried and is worse: the card fills with
   * small pieces, and what is left over from one day is still on it the next.
   *
   * A card that holds pieces already is cut for: the gaps in its drawer, the
   * powers of two it has none of, are filled first, smallest first, then the
   * rest of the amount, and then the smallest rungs are deepened with what is
   * left of the places, as above. A card with 512 and 64 on it, given 300 more,
   * gets 1, 2, 4, 8, 16, 32, 128, what is left of the 300, and more of its
   * smallest rungs where the places allow. Change written back is cut the same
   * way, so a card keeps its drawer as it is spent from.
   *
   * A load is at most CARD_LOAD_PIECES pieces, and no more than the card has
   * places for. Where the drawer and the rest are more than that, the drawer has
   * fewer rungs, the biggest taken off first: their worth is carried by bigger
   * pieces, and the small rungs, which make the small prices, stay. An amount
   * that is more than that even with no drawer at all is rounded up, its
   * smallest pieces first, until it fits: the card is given a few sats more than
   * were asked for, and the screen says so. (The sats are the holder's own, on a
   * card instead of in the phone.)
   *
   * The cost of a deep drawer is pieces: a card holds more of them, and taking
   * everything off it signs every one (most of a second each): the holder's
   * choice, for change at every payment. */
  var CARD_LOAD_PIECES = 32;
  var CARD_DRAWER_DEEP = 3;

  /* The largest piece this mint's current keys can make: the biggest amount in
   * the keyset. 0 where it is not known, and the ladder is then not limited by it. */
  function cardMaxPiece(w) {
    try {
      var ks = keysetFor(w, String((w && w.keysetId) || ''));
      var amounts = Object.keys((ks && ks.keys) || {}).map(Number).filter(function (n) { return n > 0 && isFinite(n); });
      return amounts.length ? Math.max.apply(null, amounts) : 0;
    } catch (e) { return 0; }
  }

  /* The pieces for `sats` to go onto a card that holds `have` (their amounts, none
   * for an empty card): the drawer's gaps, then the rest in powers of two, no piece
   * larger than `biggest` (the mint's own largest, where it is known: more of that
   * one then), and no more than `most` pieces. `extra` is what rounding up added.
   * `plain`: no drawer and no limit on how many, only the powers of two the amount
   * is made of, for money that is exactly what is owed and cannot be rounded
   * (change). Largest first. */
  function cardLadder(sats, most, biggest, have, plain) {
    var n = Math.max(0, Math.floor(Number(sats) || 0));
    var cap = Math.max(1, Math.floor(Number(most) || CARD_LOAD_PIECES));
    var top = Math.max(0, Math.floor(Number(biggest) || 0));
    // what the card has: how many of each size, and in all
    var held = {}, heldSum = 0;
    (Array.isArray(have) ? have : []).forEach(function (a) {
      var v = Math.floor(Number(a) || 0);
      if (v > 0) { held[v] = (held[v] || 0) + 1; heldSum += v; }
    });
    var cut = function (amount) {
      var out = [];
      var d = 1;
      while (d * 2 <= amount && (!top || d * 2 <= top)) d *= 2;
      for (var rest = amount; d >= 1; d /= 2) {
        while (rest >= d) { out.push(d); rest -= d; }
      }
      return out;
    };
    /* The pieces for `amount` with `r` rungs, `deep` of each rung below the
     * `m`th and one of the others, what the card holds counting towards each;
     * null where that is more than the amount or more than `cap` pieces. */
    var build = function (amount, r, deep, m) {
      var gaps = [], spend = 0;
      for (var j = 0; j < r; j++) {
        var d = Math.pow(2, j);
        for (var k = held[d] || 0; k < (j < m ? deep : 1); k++) { gaps.push(d); spend += d; }
      }
      if (spend > amount) return null;
      var all = gaps.concat(cut(amount - spend));
      return all.length <= cap ? all : null;
    };
    /* The drawer for `amount`: the most rungs, one of each, that come to no more
     * than `cap` pieces in all (every price up to the whole is exact then); and
     * then, with the pieces left under the cap, the smallest rungs deepened, to
     * CARD_DRAWER_DEEP of each where there is room and to two where not. Null
     * when not even the rest alone fits. */
    var drawer = function (amount) {
      var total = heldSum + amount;
      var rungs = 0;
      while (Math.pow(2, rungs + 1) - 1 <= total && (!top || Math.pow(2, rungs) <= top)) rungs += 1;
      var base = null, r;
      for (r = rungs; r >= 0 && !base; r--) base = build(amount, r, 1, 0);
      if (!base) return null;
      r += 1;
      for (var deep = CARD_DRAWER_DEEP; deep >= 2; deep--) {
        for (var m = r; m >= 1; m--) {
          var deeper = build(amount, r, deep, m);
          if (deeper) return deeper;
        }
      }
      return base;
    };
    var asked = n;
    var pieces = plain ? cut(n) : drawer(n);
    for (var guard = 0; !plain && !pieces && n > 0 && guard < 64; guard++) {
      var low = 1;
      while (Math.floor(n / low) % 2 === 0) low *= 2;
      // already all of the mint's largest piece: rounding up cannot make fewer
      if (top && low >= top) break;
      n += low;
      pieces = drawer(n);
    }
    if (!pieces) pieces = cut(n);
    pieces.sort(function (a, b) { return b - a; });
    return { sats: n, extra: n - asked, denominations: pieces };
  }

  /* ---- a deep drawer, for a card with the places for one ---------------------
   *
   * A card of sixty-four places has three of each of its smallest sizes, and
   * that is not many: a price typed in dollars is an odd number of sats, so
   * every payment needs a 1 or a 2 or a 4 of its own, and nothing larger can
   * stand in for one (two 256s make a 512; nothing but 1s makes a 1). Three
   * deep, the third payment in a row was already being paid with a piece too
   * big and made up for in change.
   *
   * A card of 128 places (`info.wide`) is cut deep instead: CARD_DEEP of each
   * size from 1 up to CARD_DEEP_TOP, smallest first as far as the money goes,
   * and what is left of the amount in powers of two. Smallest first, because
   * the small sizes are the ones a payment cannot do without; and the money
   * that does not reach a size is no loss to it, since a payment is one
   * signature however many pieces it is made of, and smaller pieces make a
   * larger one. Eight of each size from 1 to 1,024 are eighty-eight pieces and
   * 16,376 sats, and pay eight prices in a row exactly, whatever they are, up
   * to 2,047 each.
   *
   * What the card holds counts towards each size, so a top-up and the change
   * of a payment fill what has been spent from. Where the places do not allow
   * eight of each (change is CARD_WIDE_CHANGE pieces at the most, so that the
   * tap that writes it stays short), it is seven of each, or six, down to one,
   * and below that the plain powers of two. Nothing is rounded: the pieces
   * come to exactly the amount. */
  var CARD_DEEP = 8;
  var CARD_DEEP_TOP = 1024;
  /* And a card of software 1.23 that holds dollars and sats (or is about to: a load of its other unit): four of each size in each unit,
   * 1 to 1,024 sats and 1 to 1,024 cents, 44 pieces a unit and 88 in all, as one unit eight deep is. Four of each pays four prices in a
   * row exactly in each unit. The first unit's eight-deep drawer is not cut down when the second goes on: it drains to four as it is
   * paid from, and its refills go to four. */
  var CARD_DEEP_BOTH = 4;
  /* How deep a card's drawer is cut, for the unit it is being cut in (`card` as that unit, `cardInUnit`). */
  function cardDepthFor(card) {
    if (!cardIs123(card)) return CARD_DEEP;
    var whole = (card && card.whole) || card;
    if (cardBoth(whole)) return CARD_DEEP_BOTH;
    var ru = whole && whole.record && whole.record.unit === 'usd' ? 'usd' : 'sat';
    return (card.viewUnit && card.viewUnit !== ru) ? CARD_DEEP_BOTH : CARD_DEEP;
  }
  // the most pieces one load onto a wide card is, and the most its change is cut into
  var CARD_WIDE_LOAD = 112;
  var CARD_WIDE_CHANGE = 32;

  /* As `cardLadder`, for a card with a deep drawer. `extra` is always 0, but
   * where not even the plain powers of two fit `most` pieces: then the amount
   * is cut as a card of fewer places would have it (`cardLadder`), which may
   * round it up. */
  /* `depth`: how many of each size the drawer is cut to (CARD_DEEP where not given). A card of 1.23 that holds both units, or is about to,
   * is cut to CARD_DEEP_BOTH of each in each unit (`cardDepthFor`, design 9.2): both units deep are the 88 pieces one unit eight deep was. */
  function cardDeepLadder(sats, most, biggest, have, depth) {
    var n = Math.max(0, Math.floor(Number(sats) || 0));
    var deepest = Math.max(0, Math.min(CARD_DEEP, Math.floor(Number(depth) || CARD_DEEP)));
    var cap = Math.max(1, Math.floor(Number(most) || CARD_WIDE_LOAD));
    var top = Math.max(0, Math.floor(Number(biggest) || 0));
    var held = {};
    (Array.isArray(have) ? have : []).forEach(function (a) {
      var v = Math.floor(Number(a) || 0);
      if (v > 0) held[v] = (held[v] || 0) + 1;
    });
    var cut = function (amount) {
      var out = [];
      var d = 1;
      while (d * 2 <= amount && (!top || d * 2 <= top)) d *= 2;
      for (var rest = amount; d >= 1; d /= 2) {
        while (rest >= d) { out.push(d); rest -= d; }
      }
      return out;
    };
    var build = function (deep) {
      var out = [], rest = n;
      for (var d = 1; d <= CARD_DEEP_TOP && (!top || d <= top); d *= 2) {
        var short = Math.max(0, deep - (held[d] || 0));
        var take = Math.min(short, Math.floor(rest / d));
        for (var k = 0; k < take; k++) out.push(d);
        rest -= take * d;
        // the money has run out at this size: what is left is less than one more of it
        if (take < short) break;
      }
      return out.concat(cut(rest));
    };
    for (var deep = deepest; deep >= 0; deep--) {
      var pieces = build(deep);
      if (pieces.length <= cap) {
        pieces.sort(function (a, b) { return b - a; });
        return { sats: n, extra: 0, denominations: pieces };
      }
    }
    return cardLadder(sats, most, biggest, have);
  }

  /* The pieces for `sats` to go onto `card`: a deep drawer where the card has
   * the places for one, and the drawer of a card of sixty-four where not. */
  function cardCutFor(card, sats, most, biggest, have) {
    return cardIsDeep(card) ? cardDeepLadder(sats, most, biggest, have, cardDepthFor(card)) : cardLadder(sats, most, biggest, have);
  }

  /* Whether a card is cut deep: it has the places for it (`wide`), and it
   * signs for as many pieces at once as a payment may need (`many`). A deep
   * drawer holds a card's money in small pieces; on a card that signs for
   * eight at a time, most of that money could not be paid in one go. */
  function cardIsDeep(card) {
    return !!(card && card.info && card.info.wide && card.info.many);
  }

  /* The largest piece a top-up cuts for a card with a limit on one tap: the
   * largest power of two at or under the limit. A payment up to the limit is
   * then made from pieces that never need the holding a larger piece does
   * (a piece above the limit is paid from only with the card's wait). Only
   * where the card is cut deep and its reader knows the limit, which the
   * card says to its owner's phone and to no till; and never above the mint's
   * own largest (`biggest`), which bounds every cut. 0: no such cap. */
  function cardLimitCap(card, biggest) {
    var most = Math.max(0, Math.floor(Number(biggest) || 0));
    // (1.23: the limit is cents; the pieces are of the unit loaded, which a sats limit is turned into at the card's rate)
    var limit = Math.floor(cardCeilBack(card, card && card.info && card.info.tapLimit));
    if (!(limit > 0) || !cardIsDeep(card)) return most;
    var cap = 1;
    while (cap * 2 <= limit) cap *= 2;
    return most > 0 ? Math.min(cap, most) : cap;
  }

  /* What a card holds in pieces larger than its limit on one tap: the money a
   * till holds longer for. 0 where there is no limit, or none are. */
  function cardAboveLimit(card) {
    var limit = Math.floor(cardCeilBack(card, card && card.info && card.info.tapLimit));
    if (!(limit > 0) || !cardIsDeep(card)) return 0;
    return ((card && card.pieces) || []).reduce(function (n, x) { var a = satsOf(x.amount); return a > limit ? n + a : n; }, 0);
  }

  /* The pieces for `sats` to go onto `card`, no piece above `cap`
   * (`cardLimitCap`) where they fit the room. Where the money is too much for
   * the places at that size, as much of it as fits is cut under the cap and
   * the rest goes in the plain powers of two, no larger than the mint's own
   * (`biggest`): `above` says how much is in such pieces, for the screen. */
  function cardCutUnder(card, sats, room, cap, biggest, have) {
    var n = Math.max(0, Math.floor(Number(sats) || 0));
    var most = Math.max(1, Math.floor(Number(room) || 1));
    var top = Math.max(0, Math.floor(Number(biggest) || 0));
    var fits = function (cut, places) { return !!cut && !(cut.extra > 0) && cut.denominations.length <= places; };
    if (!(cap > 0) || (top > 0 && cap >= top)) return Object.assign({ above: 0 }, cardCutFor(card, n, most, top, have));
    var whole = cardCutFor(card, n, most, cap, have);
    if (fits(whole, most)) return Object.assign({ above: 0 }, whole);
    for (var under = n - cap; under >= 0; under -= cap) {
      var over = cardLadder(n - under, most, top, null, true);
      var left = most - over.denominations.length;
      if (over.extra > 0 || left < 1) continue;
      var small = under > 0 ? cardCutFor(card, under, left, cap, have) : { sats: 0, extra: 0, denominations: [] };
      if (!fits(small, left)) continue;
      return { sats: n, extra: 0, above: n - under,
               denominations: over.denominations.concat(small.denominations).sort(function (a, b) { return b - a; }) };
    }
    return Object.assign({ above: 0 }, whole);
  }

  /* What a card holds, as the amounts of its pieces, for cutting more for it
   * (`cardLadder`'s `have`): the pieces it was read with, less the ones named in
   * `except` (nonces; they have been signed and are leaving), and the pieces
   * this phone has made for it and not yet written. */
  function cardHeldAmounts(card, except) {
    // (a card of 1.23: one unit's pieces and rows, the card as that unit, its record's where it is not one already: a top-up of dollars fills the dollar rungs only)
    if (card && card.units && !card.viewUnit) card = cardInUnit(card, card.record.unit);
    var unitNow = (card && card.units && card.record) ? card.record.unit : '';
    var gone = {}, onCard = {}, out = [];
    (except || []).forEach(function (nonce) { gone[nonce] = true; });
    ((card && card.pieces) || []).forEach(function (x) {
      onCard[x.nonce] = true;
      if (!gone[x.nonce]) out.push(satsOf(x.amount));
    });
    cardStore(CARD_OWED).forEach(function (r) {
      if (!r || !card || r.card !== card.key || r.stuck) return;
      if (unitNow && cardRowUnit(r) !== unitNow) return;
      // the card's own change (1.12) is owed by the outputs the mint signed for it: their sizes are what will be on the card
      if (Array.isArray(r.blind)) { r.blind.forEach(function (b) { if (b && satsOf(b.amount) > 0) out.push(satsOf(b.amount)); }); return; }
      try {
        ((FoxyWallet.tokenInfo(r.token) || {}).proofs || []).forEach(function (pr) {
          var parts = cardSecretParts(pr.secret);
          if (parts && onCard[parts.nonce]) return;
          out.push(satsOf(pr.amount));
        });
      } catch (e) {}
    });
    return out;
  }

  /* How many pieces a load onto this card may be: the places it has free and
   * the ones a write frees first (spent, and `signed` pieces that have just
   * been), less `keep` places, and never more than a load is. A few are kept
   * for what the mint's fee may add; a load keeps CARD_CHANGE_ROOM, so an
   * online payment's change (a large piece's worth, cut in halves, is at
   * most a dozen pieces) always has somewhere to go. */
  var CARD_CHANGE_ROOM = 12;
  function cardRoomFor(card, signed, keep) {
    var info = (card && card.info) || {};
    var hold = Math.max(4, Number(keep) || 0);
    var room = (Number(info.empty) || 0) + (Number(info.spent) || 0) + ((signed && signed.length) || 0) - hold;
    // a card cut deep: a load (it is a load that keeps places back) may be most of the card; change is kept short
    var most = !cardIsDeep(card) ? CARD_LOAD_PIECES : (Number(keep) > 0 ? CARD_WIDE_LOAD : CARD_WIDE_CHANGE);
    return Math.max(1, Math.min(most, room));
  }

  /* What a load of `want` sats onto `card` is cut into, and whether the card
   * has the room for it: the one cut `cardPrepare` makes and refuses on, and
   * `cardLoadFits` asks ahead of it, so the keypad that says no and the load
   * that says no are never at different amounts.
   *
   * The pieces are cut to the places a load may fill (`cardRoomFor`) and to the
   * mint's largest key; a card whose free places (`empty` and `spent`) cannot
   * hold those pieces and the four a write keeps back is full for it. */
  var CARD_FULL_WORDS = 'The card has no room for that. Take some money off it first.';
  function cardLoadCut(w, card, want) {
    var biggest = cardMaxPiece(w);
    var ladder = cardCutUnder(card, want, cardRoomFor(card, null, CARD_CHANGE_ROOM), cardLimitCap(card, biggest), biggest, cardHeldAmounts(card));
    var room = card.info.empty + card.info.spent;
    return { ladder: ladder, room: room, full: ladder.denominations.length + 4 > room };
  }

  /* The pieces change is made in: exactly `sats`, never rounded, cut for the
   * card it goes back on as a load is — filling the gaps in its drawer (the
   * card as it will be, without the pieces that have just been signed), in the
   * room it has — so the small denominations an offline exact payment needs are
   * kept stocked as the card is spent from. Too many for a drawer, it is the
   * plain powers of two. */
  function cardChangeCut(w, sats, card, except) {
    var top = cardMaxPiece(w);
    // no card read (a lost answer found later): its drawer is not known, so the plain powers of two
    if (!card) return cardLadder(sats, 64, top, null, true).denominations;
    return cardChangeFor(sats, cardRoomFor(card, except), top, cardHeldAmounts(card, except), cardIsDeep(card), cardDepthFor(card));
  }

  /* The same cut from its parts: `sats` of change in no more than `room` pieces
   * for a card that holds `held` (amounts). A payment is chosen by what this
   * would give back (`cardPick`), so the choosing and the making are one rule. */
  function cardChangeFor(sats, room, top, held, wide, depth) {
    var cut = wide ? cardDeepLadder(sats, room, top, held, depth) : cardLadder(sats, room, top, held);
    return (cut.extra > 0 ? cardLadder(sats, 64, top, null, true) : cut).denominations;
  }

  /* How far a card's pieces reach: the most N for which every amount from 1 to
   * N is made exactly by some of them. Taken smallest first, a piece adds to
   * the reach when it is no more than one above the sum of those before it;
   * the first that is more is a gap, and nothing above it is exact for every
   * amount. A drawer with no gap reaches its whole sum. */
  function cardReach(amounts) {
    var up = (amounts || []).map(function (a) { return Math.floor(Number(a) || 0); })
      .filter(function (a) { return a > 0; }).sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var i = 0; i < up.length; i++) {
      if (up[i] > sum + 1) break;
      sum += up[i];
    }
    return sum;
  }

  /* A token's proofs as pieces this card can hold, or a throw saying why not.
   * Each must be locked to this card and, built again from what the card will
   * keep of it, be the same secret to the character: a piece that is not is
   * one the card could never sign for, and must not be written onto it. */
  function cardPiecesOf(token, card) {
    var tok = FoxyWallet.tokenInfo(token);
    if (!tok || !Array.isArray(tok.proofs) || !tok.proofs.length) throw cardError('misfit', 'That is not ecash for a card.');
    var cu = (card.record && card.record.unit) || 'sat';
    var home = wallet ? mintOf(wallet) : '', sets = home ? keysetsOf(home, wallet) : null;
    return tok.proofs.map(function (pr) {
      var parts = cardSecretParts(pr.secret);
      // the eight bytes the card will hold, which must lead back to this keyset and no other
      var id = cardShortId(pr.id);
      if (!parts || parts.key !== card.key) throw cardError('misfit', 'That ecash is not locked to this card.');
      /* And of the card's own money: a keyset's short name says nothing of its unit, and a piece of sats written onto a dollar
       * card would be read back as cents (or the other way round). Every unit's keysets are in the wallet's key chain, so the
       * short name alone would let one through. */
      var ku = sets ? keysetUnit(home, pr.id, wallet, sets) : '';
      if (cu === 'sat' ? (ku && ku !== 'sat') : ku !== cu) throw cardError('misfit', 'That ecash is not in this card\u2019s money.');
      if (!id) throw cardError('misfit', 'This mint\u2019s keys are a kind the card cannot hold yet.');
      // (a card of 1.23: among the mint's keysets of the unit it is being loaded in, as the card's table will hold it)
      if (String(pr.id).length > 16 && cardFullId(wallet, id, cardIs123(card) ? cu : undefined) !== String(pr.id).toLowerCase()) {
        throw cardError('misfit', keysetIdsFor(wallet).map(function (k) { return String(k).toLowerCase(); }).indexOf(String(pr.id).toLowerCase()) < 0
          ? 'That ecash is of another mint than the one this phone is at.'
          : 'Two of this mint\u2019s sets of keys would read the same on a card, so none of their ecash is put on one.');
      }
      var built = '';
      try { built = cardSecret(parts.nonce, card.key, parts.date, card.record.refundKey, card.info && card.info.format); } catch (e) { built = ''; }
      if (built !== String(pr.secret)) throw cardError('misfit', 'That ecash is not written the way this card writes it.');
      /* The mint's proof that goes with it (`proof`: e, s, r), where the token has the whole of one: this phone made the blinding factor and
       * the mint's signature came with the rest, and a token this phone made keeps all three. Rows filed by builds that kept less have none. */
      return { keyset: id, amount: satsOf(pr.amount), nonce: parts.nonce, C: String(pr.C).toLowerCase(), date: parts.date, proof: cardDleqOf(pr.dleq) };
    });
  }

  /* ---- the change a card makes for itself (software 1.12) -----------------------
   *
   * A payment's pieces are rarely worth its price. The difference used to come
   * back as pieces this phone made after the swap and locked to the card, which
   * the card cannot check, so its limits and its wait had to count the pieces
   * whole. From 1.12 the card makes that change itself: for each output of it
   * the terminal names an amount (SPEND_ALL_CHANGE), and the card draws the
   * nonce and the blinding factor, writes the secret as it writes its own
   * pieces' (locked to its own key), hashes it to the curve, blinds it, and
   * answers the blinded message. That goes in the swap beside this phone's own
   * outputs, the card signs for all of them at once, and it keeps what its
   * output is made of (its nonce and factor, an "opening", `GET_CHANGE`) until
   * the piece is written back.
   *
   * So this phone never holds what the card's piece is made of, and nothing it
   * chooses can take the change. It keeps what the mint signed for each output
   * (`blind`, in the row the card is owed: the blinded message, the signature,
   * its DLEQ and the mint's key for that size) and finishes the pieces at the
   * change tap from the card's openings: the nonce gives the secret, the factor
   * takes the blinding off the signature as any wallet takes it off an output of
   * its own, and the piece is written with the others.
   *
   * At most eight outputs, as many as the card keeps openings for (those of
   * payments whose pieces are not back yet count). A change that would be more,
   * or a card with no opening free, is made the way it was before 1.12 (below,
   * `cardOweBack`).
   *
   * From software 1.13 it is at most four, cut plainly. See CARD_CHANGE_PIECES. */
  var CARD_CHANGE_MOST = 8;
  var CARD_CHANGE_PAGE = 3;
  /* And the pieces one payment asks the card to make. Each costs the card about
   * half a second of its own work over NFC (the hash to the curve) while it is
   * held to the phone, in the first tap, and change may add no more than two
   * seconds to that tap. So a card of software 1.13 is asked for FOUR at the most,
   * the four largest of the powers of two the change is made of (`cardLadder`'s
   * `plain`: 2,357 sats is 2048 + 256 + 32 + 16, and the 5 that are left are made
   * here after the swap, `cardOweBack`, and written at the change tap as before
   * 1.12). Restocking a drawer's small sizes is the owner's phone's job at a top-up
   * (`cardAdd`), and not a till's, which is why the change is not cut to the
   * drawer. The card's capacity (CARD_CHANGE_MOST) is the most there can be. */
  var CARD_CHANGE_PIECES = 4;
  // and the card of 1.12, which was asked for eight, cut to fill the gaps in its drawer
  var CARD_CHANGE_PIECES_BEFORE = 8;

  function cardOwnChange(card) { return !!(card && card.info && card.info.ownChange); }
  // a card of software 1.13 or later: its wait is shaped (`cardWaitSigns`) and its change is cut plainly (`cardOwnChangeCut`)
  function cardIsShaped(card) { return !!(card && card.info && card.info.shaped); }
  // a card of software 1.14 or later: the change it made counts toward its wait for what it cost, two for every three pieces (`cardWaitSigns`)
  function cardIsCosted(card) { return !!(card && card.info && card.info.costed); }

  /* GET_CHANGE, the pages of it: the openings of the change the card has made
   * for itself and not yet been handed. Three to a page, each an amount (4), a
   * keyset (8), a date (4), a nonce (32) and a blinding factor (32). No PIN. */
  function cardOpenings(t) {
    var out = [];
    var page = function (n) {
      return t.want(cardCommand(CARD_INS.getChange, n, '', 0), 'to say what its change is made of').then(function (d) {
        var h = String(d || '').toLowerCase();
        var count = parseInt(h.substr(0, 2), 16);
        /* 80 bytes a record up to 1.20 (amount, keyset, date, nonce, factor); 83 from 1.21, which never gives the factor or the nonce:
         * its number, amount, keyset, date, the blinded message it answered and the mint's key it was bound to. */
        var wide = !!(count > 0 && h.length === 2 + count * 166);
        if (!/^[0-9a-f]+$/.test(h) || !(count >= 0 && count <= CARD_CHANGE_PAGE) || !(wide || h.length === 2 + count * 160)) {
          throw cardError('refused', 'The card did not say what its change is made of.', { sw: '' });
        }
        for (var k = 0; k < count; k++) {
          if (wide) {
            var q = h.substr(2 + k * 166, 166);
            out.push({ number: parseInt(q.substr(0, 2), 16), amount: cardU32(q, 1), keyset: q.substr(10, 16), date: cardU32(q, 13), B_: q.substr(34, 66), K: q.substr(100, 66) });
            continue;
          }
          var o = h.substr(2 + k * 160, 160);
          out.push({ amount: cardU32(o, 0), keyset: o.substr(8, 16), date: cardU32(o, 12), nonce: o.substr(32, 64), r: o.substr(96, 64) });
        }
        return (count === CARD_CHANGE_PAGE && out.length < CARD_CHANGE_MOST) ? page(n + 1) : out;
      });
    };
    return page(0);
  }

  /* The blinded message an opening is: the secret its nonce makes (the card's own
   * form, `cardSecret`), hashed to the curve, and its factor times G added. The
   * card answered this when it made the output; made again here, it is what
   * says which of its openings an output of ours is. '' for one that cannot be. */
  function cardOpeningB(card, op) {
    if (op && op.B_) return String(op.B_).toLowerCase();
    try {
      var secret = cardSecret(op.nonce, card.key, op.date, card.record.refundKey, card.info && card.info.format);
      var bytes = new Uint8Array(secret.length);
      for (var i = 0; i < secret.length; i++) bytes[i] = secret.charCodeAt(i) & 255;
      return window.CashuTS.blindMessage(bytes, BigInt('0x' + op.r)).B_.toHex(true);
    } catch (e) { return ''; }
  }

  /* The pieces a row of the card's own change comes to, from its openings: each
   * output of it that has one is unblinded (the factor, and the mint's key for the
   * size) and its DLEQ checked where the mint gave one, as the wallet checks what
   * it receives (`dleqAudit`), and made a piece for the card to hold. Answers
   * { pieces, stuck }.
   *
   * An output with no opening listed is not lost: the card lets an opening go
   * when its piece is on it, as the pieces a tap cut short had gone on are. Only
   * if the card shows nothing it could be (no piece of that size, keyset and date,
   * and no place that was spent, which a piece written and paid out leaves) is it
   * one that cannot be finished: the card was wiped and set up again, and what
   * the output was made of went with it. And one whose signature does not check
   * out is not written. Both are `stuck`, with why. */
  function cardBlindPieces(row, card, openings) {
    var CT = window.CashuTS;
    var seen = (openings || []).map(function (op) { return { op: op, B_: cardOpeningB(card, op) }; });
    var date = Number(row.date) || 0;
    var onIt = {};
    (card.pieces || []).forEach(function (x) { onIt[x.keyset + '|' + satsOf(x.amount) + '|' + (Number(x.date) || 0)] = true; });
    var maybePaid = !!(card.info && Number(card.info.spent) > 0);
    var pieces = [], stuck = [];
    (row.blind || []).forEach(function (b) {
      var amount = satsOf(b.amount), short = cardShortId(b.id), hit = /** @type {any} */ (null);
      seen.forEach(function (s) {
        if (!hit && s.B_ && s.B_ === String(b.B_).toLowerCase() && s.op.amount === amount && s.op.keyset === short) hit = s.op;
      });
      if (!hit) {
        if (onIt[short + '|' + amount + '|' + date] || maybePaid) return;
        stuck.push({ blind: b, why: 'opening' });
        return;
      }
      try {
        var C = CT.unblindSignature(CT.pointFromHex(String(b.C_)), BigInt('0x' + hit.r), CT.pointFromHex(String(b.K))).toHex(true);
        if (b.dleq && b.dleq.e && b.dleq.s) {
          var keys = {};
          keys[String(amount)] = String(b.K);
          var proof = { id: String(b.id), amount: amount, C: C, dleq: { e: String(b.dleq.e), s: String(b.dleq.s), r: hit.r },
                        secret: cardSecret(hit.nonce, card.key, hit.date, card.record.refundKey, card.info && card.info.format) };
          if (CT.hasValidDleq(proof, { id: String(b.id), keys: keys }, { require: true }) !== true) { stuck.push({ blind: b, why: 'signature' }); return; }
        }
        /* With the mint's proof where it gave one: its e and s, and the blinding factor the card kept in the opening, which the DLEQ above
         * was checked with. The card's own change is as much a piece with a proof as any other. */
        pieces.push({ keyset: hit.keyset, amount: amount, nonce: hit.nonce, C: C, date: hit.date,
                      proof: (b.dleq && b.dleq.e && b.dleq.s) ? cardDleqOf({ e: b.dleq.e, s: b.dleq.s, r: hit.r }) : null });
      } catch (e) { stuck.push({ blind: b, why: 'signature' }); }
    });
    return { pieces: pieces, stuck: stuck };
  }

  /* The mint's key for an opening's amount in its keyset, compressed, as this phone has the keyset: '' where the keyset or the size
   * is not known here. */
  function cardMintKeyFor(w, op) {
    try {
      var id = op && op.keyset ? cardFullId(w, op.keyset) : '';
      var ks = id ? keysetFor(w, id) : null;
      var K = ks && ks.keys ? String(ks.keys[String(op.amount)] || '').toLowerCase() : '';
      return /^0[23][0-9a-f]{64}$/.test(K) ? K : '';
    } catch (e) { return ''; }
  }

  /* An opening (software 1.21 and on) bound to a key that is not the mint's for its amount: the till named another at
   * SPEND_ALL_CHANGE, and the mint's answer, which is under its real key, can never be loaded under the bound one. Only the
   * holder's own say mends it (`cardMend`: LOAD_CHANGE under the real key, with the PIN and the owner's grant or the held tap,
   * software 1.22); else it can only be given up (`cardGiveUp`). False where the mint's key is not known here. */
  function cardPoisoned(w, op) {
    if (!op || !op.K) return false;
    var real = cardMintKeyFor(w, op);
    return !!real && real !== String(op.K).toLowerCase();
  }

  /* The card's own change of one row written by LOAD_CHANGE (1.21): for each output, the card's opening with the same blinded
   * message, and the mint's signature, its key (uncompressed, as the card takes points) and its proof sent to it. The card checks
   * the key against the one it kept, checks the proof, takes its factor off and answers the place and the piece. Answers
   * { pieces, stuck } as `cardBlindPieces` does, the pieces already on the card (`landed` is told each). An output whose opening is
   * gone was written already, or is beyond reach, as there; one with no proof from the mint cannot be loaded at all.
   *
   * An opening bound to a key that is not the mint's (a till named another at the payment: GET_CHANGE says the key it kept) takes
   * the mint's answer under the mint's own key only with the holder's say in this tap (`mend`, software 1.22: the PIN given and the
   * owner's grant, or with no owner the history held for, and no payment in it). Without it nothing is sent for it (the card would
   * answer 6A80) and it is `stuck` as `key`, to be mended (`cardMend`). With it, a refusal of the proof is `signature` and counted
   * in `refused`; 6982 and 6985 (no say, or a tap that paid) stop the write, as a card that leaves does. */
  function cardLoadChange(t, card, row, openings, landed, mend) {
    var CT = window.CashuTS;
    var date = Number(row.date) || 0, onIt = {}, pieces = [], stuck = [], refused = 0, mended = 0;
    (card.pieces || []).forEach(function (x) { onIt[x.keyset + '|' + satsOf(x.amount) + '|' + (Number(x.date) || 0)] = true; });
    var maybePaid = !!(card.info && Number(card.info.spent) > 0);
    var wide = function (hex) { return CT.pointFromHex(String(hex)).toHex(false); };
    return (row.blind || []).reduce(function (chain, b) {
      return chain.then(function () {
        var amount = satsOf(b.amount), short = cardShortId(b.id), hit = /** @type {any} */ (null);
        (openings || []).forEach(function (op) {
          if (!hit && op.B_ === String(b.B_).toLowerCase() && op.amount === amount && op.keyset === short) hit = op;
        });
        if (!hit) {
          if (onIt[short + '|' + amount + '|' + date] || maybePaid) return null;
          stuck.push({ blind: b, why: 'opening' });
          return null;
        }
        if (!(b.dleq && b.dleq.e && b.dleq.s)) { stuck.push({ blind: b, why: 'no-proof' }); return null; }
        // the key the card kept with the opening, against the mint's for the size: another is a till's, and wants the holder's say
        var other = false;
        try { other = !!hit.K && CT.pointFromHex(String(b.K)).toHex(true).toLowerCase() !== String(hit.K).toLowerCase(); } catch (eK) { other = true; }
        if (other && !mend) { stuck.push({ blind: b, why: 'key' }); return null; }
        var data;
        try { data = wide(b.C_) + wide(b.K) + String(b.dleq.e).toLowerCase() + String(b.dleq.s).toLowerCase(); }
        catch (e) { stuck.push({ blind: b, why: 'signature' }); return null; }
        if (other) console.log('[foxy] card: an opening of ' + amount + ' was bound to a key that is not the mint\u2019s; the mint\u2019s answer is sent under its own key');
        return t.ask(cardCommand(CARD_INS.loadChange, hit.number, data, 83)).then(function (r) {
          if (r.sw === '6a80') { stuck.push({ blind: b, why: 'signature' }); if (other) refused += 1; return null; }
          if (r.sw === '6a88') return null;
          if (other && r.sw === '6985') throw cardError('paid-here', 'This card has just paid, so it does not take this change in the same tap. Take it away from the phone and tap it again.');
          if (r.sw !== '9000' || !cardHexOk(r.data, 83)) throw cardRefused(r.sw === '9000' ? '' : r.sw, 'to take its change');
          var h = String(r.data).toLowerCase();
          var piece = { keyset: h.substr(4, 16), amount: cardU32(h, 10), nonce: h.substr(28, 64), C: h.substr(92, 66), date: cardU32(h, 79) };
          pieces.push(piece);
          if (other) mended += amount;
          try { landed(piece); } catch (e) {}
          return null;
        });
      });
    }, Promise.resolve()).then(function () { return { pieces: pieces, stuck: stuck, refused: refused, mended: mended }; });
  }

  /* The change a payment's card has made for itself and is owed, by the payment's entry (`forHash`): the rows, and what they come to. */
  function cardBlindOwed(forHash) {
    var rows = cardStore(CARD_OWED).filter(function (r) { return r && Array.isArray(r.blind) && r.forHash === forHash; });
    // in the rows' own unit, which is the card's
    return { rows: rows, amount: rows.reduce(function (n, r) { return n + (r.stuck ? 0 : cardRowAmt(r)); }, 0) };
  }

  /* The row the card is owed for its own change, from the swap it was set out in
   * (`spec`, as `cardSwapWrite` wrote it) and what the mint signed for each output
   * of it (`sigs`, by blinded message: { id, amount, C_, dleq }). Null where the
   * mint has not signed every one, or its key for a size is not known: the row is
   * the only thing that can finish those pieces. */
  function cardBlindRow(spec, sigs, w) {
    var ch = spec && spec.change;
    if (!ch || !Array.isArray(ch.outs) || !ch.outs.length) return null;
    var ks = keysetFor(w, spec.keyset);
    var blind = [];
    for (var i = 0; i < ch.outs.length; i++) {
      var o = ch.outs[i], s = sigs[String(o.B_).toLowerCase()];
      var K = ks && ks.keys ? String(ks.keys[String(o.amount)] || '') : '';
      if (!s || !K || satsOf(s.amount) !== satsOf(o.amount)) return null;
      blind.push({ amount: satsOf(o.amount), id: String(spec.keyset), B_: String(o.B_).toLowerCase(), C_: String(s.C_).toLowerCase(), dleq: s.dleq || undefined, K: K });
    }
    /* Its figure in the unit of the keyset the card made it in: cents for a dollar card's change. Asked of the mint's list,
     * then of the keyset itself, the swap's row (CARD_SWAPS rows say their unit) and the wallet that has the keyset; never
     * guessed as sats, which would put a dollar card's cents under a sats name. None of them knowing makes no row. */
    // (`unitOf` of nothing is sats, so each is asked only where it names something)
    var said = function (u) { return u ? unitOf(u) : ''; };
    var unit = keysetUnit(ch.mint || mintOf(w), spec.keyset, w) || said(ks && ks.unit) || said(spec.unit) || said(w && w.unit);
    if (!unit) { console.warn('[foxy] card: change in a keyset of no unit known here; no row is made of it'); return null; }
    var row = { id: 'change-' + spec.id, card: ch.card, kind: 'change', mint: ch.mint, blind: blind,
                date: Number(ch.date) || 0, forHash: ch.forHash, at: Date.now() };
    return Object.assign(row, cardFig(unit, blind.reduce(function (n, b) { return n + b.amount; }, 0)));
  }

  /* A signature as the mint gave it, in the plain form a row keeps. */
  function cardSigOf(s) {
    var d = s && s.dleq && s.dleq.e && s.dleq.s ? { e: String(s.dleq.e), s: String(s.dleq.s) } : undefined;
    return { id: String(s.id), amount: Number(String(s.amount)), C_: String(s.C_).toLowerCase(), dleq: d };
  }

  /* The signatures the mint has already given for some blinded messages, asked for by them (NUT-09 restore): by blinded
   * message, in the form `cardSigOf` keeps. `outs`: [{ amount, B_, id }], `id` the keyset's whole name. The mint answers
   * the outputs it knows and no others (an output it never signed is not in the answer), and an answer is paired to its
   * blinded message by what the mint says it is for. Rejects where the mint does not answer in half a minute. */
  function cardRestoreSigs(w, outs, label) {
    var CT = window.CashuTS;
    var asked = outs.map(function (o) { return { amount: CT.Amount.from(o.amount), B_: o.B_, id: o.id }; });
    return withTimeout(Promise.resolve(w.mint.restore({ outputs: asked })), 30000, label).then(function (res) {
      var back = (res && res.outputs) || [], list = (res && res.signatures) || [], sigs = {};
      back.forEach(function (o, i) { if (o && o.B_ && list[i]) sigs[String(o.B_).toLowerCase()] = cardSigOf(list[i]); });
      return sigs;
    });
  }

  /* The card's own change of a payment the mint has swapped, owed to it. Where the
   * swap's answer was there it is done already (`cardSwapFixed`). Where the answer
   * was lost and found after, the mint is asked for the signatures by the blinded
   * messages, as a lost locked send's outputs are (NUT-09): the card's change is
   * not made of anything this phone holds, but the mint remembers whom it signed
   * for. Resolves the row, or null when the payment made none. Rejects where the
   * mint cannot say yet; the caller notes it as due (`cardDueNote`). */
  function cardChangeOwe(row) {
    var spec = null;
    try { spec = cardSwapFor((FoxyWallet.tokenInfo(row.token) || {}).proofs || []); } catch (e) { spec = null; }
    if (!spec || !spec.change || !Array.isArray(spec.change.outs) || !spec.change.outs.length) return Promise.resolve(null);
    var have = cardStore(CARD_OWED).filter(function (r) { return r && r.id === 'change-' + spec.id; })[0];
    if (have) { cardSwapDrop(spec.id); return Promise.resolve(have); }
    var w;
    try { w = need(); } catch (e0) { return Promise.reject(e0); }
    if (!routeOpen()) return Promise.reject(cardError('no-route', 'There is no connection to the mint.'));
    var outs = spec.change.outs.map(function (o) { return { amount: o.amount, B_: o.B_, id: spec.keyset }; });
    return cardRestoreSigs(w, outs, 'the mint’s word on the card’s change').then(function (sigs) {
      var made = cardBlindRow(spec, sigs, w);
      if (!made) throw cardError('waiting', 'The mint has not said what it signed for the card’s change yet.', { id: row.id });
      var ours = made.id;
      mustSave(CARD_OWED, cardStore(CARD_OWED).filter(function (r) { return !(r && r.id === ours); }).concat([made]));
      cardSwapDrop(spec.id);
      console.log('[foxy] card: the card’s own change of a payment whose answer was lost is had from the mint, ' + cardSaid(cardRowAmt(made), cardRowUnit(made)));
      return made;
    });
  }

  /* The swap of a card's payment is made, however it came to be known (the answer
   * in hand, or found again after it was lost): its change that the card made for
   * itself is owed to it, from the answer or, failing that, from the mint
   * (`cardChangeOwe`). Never fails the payment, which is made: where the mint
   * cannot say yet it is written down as due and asked again whenever this
   * phone connects (`cardDueRetry`). */
  function cardChangeKept(row) {
    return cardChangeOwe(row).then(null, function (e) {
      console.warn('[foxy] card: the card\u2019s own change of a payment that is made could not be had yet:', (e && e.message) || e);
      try { cardDueNote(row, 0, true); } catch (x) {}
      return null;
    });
  }

  /* Write owed pieces onto the card they are for. The PIN has been verified in
   * this tap already. Spent places are freed first. A piece already on the
   * card (by its nonce) is not written twice, so a tap that was cut short is
   * finished by the next. Answers { sats, done: [ids], left: [ids] }; rejects
   * only when nothing at all could be written for a reason worth saying.
   *
   * A row of the card's own change (`blind`) is finished here from the card's
   * openings, read once for all of them (`cardBlindPieces`). One that cannot be
   * finished (`stuck`) is kept, marked, and left out of what is owed.
   *
   * `only`, where given, is the ids of the rows to write and no others (the owner's
   * phone, writing the change it fetched: `cardOwnerChange`), and `known` the
   * card's openings where they have been read in this tap already.
   *
   * `mend`: the PIN and the holder's say are in this tap (`cardMend`), and an opening of the card's own change that a till bound to
   * a key that is not the mint's is sent the mint's answer under the mint's key (`cardLoadChange`). Without it such an opening is kept
   * as stuck, `key`, and is what the holder's phone mends. The answer says how much was mended (`mended`) and how many the card
   * refused (`refused`). */
  /* LOAD_PROOF, as the card's software takes it: on a card of 1.23 labelled (P2 = 1) with the pieces' unit first, the record's unit too, so
   * that the card checks every piece against its table; on a card before it plain, as ever (a labelled load is a length it refuses, 6700).
   * `p1` 1 for one piece and the mint's proof. Two refusals of 1.23 are met here where they can be:
   *   6A99, sats onto a card with a limit and no rate: where this phone gave the owner's grant in the tap (`card.granted`), the rate is
   *         written first, at this phone's price, with the figures as the card says them, and the load sent again; otherwise said plainly;
   *   6A9D, a new currency on a card with no owner under the PIN alone: the holder's say is the history held for in the tap
   *         (`cardHoldOn`), and the load is sent again. */
  function cardLoadSend(t, card, p1, body, le, doing, unit) {
    var labelled = cardIs123(card);
    var apdu = cardCommand(CARD_INS.load, p1, (labelled ? cardUnitByte(unit) : '') + body, le, labelled ? 1 : 0);
    var tried = { rate: false, hold: false };
    var go = function () {
      return t.want(apdu, doing).then(null, function (e) {
        if (e && e.card === 'no-rate' && card.granted && !tried.rate) { tried.rate = true; return cardRateFirst(t, card).then(go); }
        if (e && e.card === 'owner-unit' && !(card.info && card.info.owner) && card.pinGiven && !tried.hold) {
          tried.hold = true;
          console.log('[foxy] card: a new currency on a card with no owner: its history is held for, the holder’s say');
          return cardHoldOn(t, cardCommand(CARD_INS.log, 0, '', 0), card.onHold, 'its history').then(go);
        }
        if (e && e.card === 'no-rate') throw cardError('no-rate', 'This card cannot take bitcoin until its owner’s phone sets it again. Nothing was put on it.');
        throw e;
      });
    };
    return go();
  }
  /* The rate written before a load of sats that the card refused for want of one (6A99), in a tap with the owner's grant: the card's figures
   * read again (GET_INFO P1 = 3, which the grant opens) and written back as they are with the rate (`cardLimit23`). */
  function cardRateFirst(t, card) {
    return t.want(cardCommand(CARD_INS.info, 3, '', 0), 'to say its limits').then(function (d) {
      var now = cardInfoOf(d);
      // (asked with the owner's grant in the tap: the holder's read, the rate said)
      now.rateSaid = true;
      var rate = cardRateOf(cardPriceFor(card.price));
      if (!(rate > 0)) throw cardError('no-rate', 'This card has a limit and no rate, and this phone has no Bitcoin price to give it one. Get online once and try again.');
      ['limit', 'windowStart', 'spentToday', 'tapLimit', 'noPin', 'rate', 'rateSaid', 'book'].forEach(function (k) { card.info[k] = now[k]; });
      console.log('[foxy] card: it has a limit and no rate; its rate is written first, ' + rate + ' sats a dollar');
      return cardLimit23(t, card, { day: now.limit, tap: now.tapLimit, noPin: now.noPin.limit, rate: rate });
    });
  }

  function cardWriteOwed(t, card, progress, only, known, mend) {
    var mine = cardStore(CARD_OWED).filter(function (r) { return r && r.card === card.key && !r.stuck && (!Array.isArray(only) || only.indexOf(r.id) >= 0); });
    /* From 1.21 the card's own change goes on with no PIN and anything else wants it: the change first, so that a refusal of a
     * later row for want of the PIN never stops the change from going on. */
    if (cardIs121(card)) mine = mine.filter(function (r) { return !!r.blind; }).concat(mine.filter(function (r) { return !r.blind; }));
    if (!mine.length) return Promise.resolve({ unit: (card.record && card.record.unit) || 'sat', amount: 0, sats: 0, back: 0, change: 0, refund: 0, done: [], left: [], mended: 0, refused: 0 });
    /* What is on the card already, by nonce, where the read gave nonces. A
     * short read gives none: then the card itself says which pieces it
     * holds, by refusing them (`on-card`, below). */
    var onCard = {};
    card.slots.forEach(function (x) { if (x.state === 'unspent' && x.nonce) onCard[x.nonce] = true; });
    /* How many pieces there are to write, for the line that says "writing 2 of
     * 4": those in the rows that fit this card, that are not on it yet. */
    var toWrite = 0, written = 0;
    mine.forEach(function (row) {
      if (row.blind) { toWrite += row.blind.length; return; }
      try { cardPiecesOf(row.token, card).forEach(function (piece) { if (!onCard[piece.nonce]) toWrite += 1; }); } catch (e) {}
    });
    var openings = Array.isArray(known) ? known : null;
    var openingsOf = function () {
      if (openings) return Promise.resolve(openings);
      return cardOpenings(t).then(function (list) { openings = list; return list; });
    };
    var tell = function (info) { try { if (typeof progress === 'function') progress(info); } catch (e) {} };
    var done = [], left = [], sats = 0, back = 0, change = 0, refund = 0, stopped = null, misfit = null, mended = 0, refusedMend = 0;
    // (a card of 1.23 written in both units in one tap: what went on in each, never added across them)
    var byUnit = /** @type {Object<string, number>} */ ({});
    /* For the one line this write leaves in the log (how many pieces went on, how many with the mint's proof, how many of those the card kept,
     * and how long the loading took), and for the real store: the nonces of the pieces that went on and are from the mint itself. A card that
     * says it has no room for proofs (`noRoom`, once, as the answer to a load with one) is sent the rest plain, three to a command. */
    var sentWith = 0, kept = 0, noRoom = false, loadBegan = 0, fresh = [];
    // its used places freed first, where it has any: a card with none is not asked
    var walk = !(card.info && card.info.spent > 0) ? Promise.resolve() : t.want(cardCommand(CARD_INS.clear, 0, '', 1), 'to free its used places').then(function () {}, function (e) {
      // a locked card frees nothing, and may still have room; nor does a 1.21 card with no PIN given in this tap
      if (!(e && (e.card === 'locked' || e.card === 'pin-needed'))) throw e;
    });
    mine.forEach(function (row) {
      walk = walk.then(function () {
        if (stopped) { left.push(row.id); return null; }
        var got;
        // a row that does not fit this card here (another mint's, say) is passed over, and the rows after it still go on
        try {
          /* Of the card's own mint, by the token's own word (a row of the
           * card's own change says its mint itself). A keyset's short name says
           * nothing of whose it is, and a card moved to another mint must not
           * be handed what was made for it at the first. */
          var at = row.blind ? (row.mint || '') : ((FoxyWallet.tokenInfo(row.token) || {}).mint || '');
          if (at && card.record && card.record.mint && canonicalMint(at) !== canonicalMint(card.record.mint)) {
            throw cardError('other-mint', 'That ecash is at ' + hostOf(at) + ', and this card is at ' + hostOf(card.record.mint) + '.',
                            { mint: canonicalMint(at) });
          }
          // and of the card's own unit: a row in the other unit is passed over the same way, and stays owed
          var ru = cardRowUnit(row), cu = (card.record && card.record.unit) || 'sat';
          /* (a card of 1.23 holds both: a row of either goes on, labelled with its unit, and the card itself says whether it may take it,
           * 6A9B, 6A9C, 6A9D; checked against the card as that unit, `cardInUnit`) */
          var as = card;
          if (cardIs123(card) && (ru === 'sat' || ru === 'usd')) as = cardInUnit(card, ru);
          else if (ru !== cu) {
            throw cardError('wrong-unit', 'That money is in ' + balanceWord(ru) + ', and this card holds ' + balanceWord(cu) + '.', { cardUnit: cu, unit: ru });
          }
          // the card's own change is finished from its openings; any other row is the pieces its token holds
          got = row.blind ? openingsOf().then(function (list) {
                              return cardIs121(card) ? cardLoadChange(t, card, row, list, function (piece) {
                                onCard[piece.nonce] = true; written += 1; sentWith += 1; kept += 1; fresh.push(piece.nonce);
                                tell({ step: 'writing', i: written, n: Math.max(toWrite, written) });
                              }, mend).then(function (got) { mended += got.mended || 0; refusedMend += got.refused || 0; return got; }) : cardBlindPieces(row, card, list);
                            })
                          : Promise.resolve({ pieces: cardPiecesOf(row.token, as), stuck: [] });
        } catch (e) { misfit = misfit || e; left.push(row.id); return null; }
        return got.then(function (prep) {
          var pieces = prep.pieces;
          /* Where the pieces came from: the mint's own answer to a swap of this phone's (a top-up, change, a refund, the card's own change,
           * what the mint signed again on a restore), or a card's own pieces written back as they came off it (a payment the mint refused:
           * `putback`). Only the first are known real by being written (`cardRealNote`): the second are real if they were known to be already. */
          var fromMint = row.kind !== 'putback';
          /* Three pieces to a command on a card that takes them (`quick`), one
           * on a card that does not: a command each was most of what loading
           * took. The card answers the place of each piece it stored; fewer
           * than were sent, and the next one was refused, so it is sent alone
           * to hear why, and the ones after it follow one at a time.
           * A piece that has the whole of the mint's proof goes onto a card of software 1.20 alone, with P1 = 1, which takes the piece
           * and the proof together (177 bytes) and answers its place and whether the proof was kept (`sendProved`). */
          var todo = pieces.filter(function (piece) { return !onCard[piece.nonce]; });
          var size = (card.info && card.info.quick) ? 3 : 1;
          var proved = function (piece) { return !noRoom && !!(card.info && card.info.proofs) && !!piece.proof; };
          var send = function (some) {
            tell({ step: 'writing', i: written + 1, n: Math.max(toWrite, written + 1) });
            if (!loadBegan) loadBegan = Date.now();
            return cardLoadSend(t, card, 0, some.map(cardPieceBytes).join(''), some.length, some.length > 1 ? 'some pieces' : 'a piece', ru).then(function (d) {
              var stored = some.length === 1 ? 1 : Math.min(some.length, Math.floor(String(d || '').length / 2));
              for (var k = 0; k < stored; k++) { onCard[some[k].nonce] = true; written += 1; if (fromMint) fresh.push(some[k].nonce); }
              return some.slice(stored).reduce(function (chain, piece) {
                return chain.then(function () { return send([piece]); });
              }, Promise.resolve());
            }, function (e) {
              /* After a short read (`card.bare`), which lists no nonces: the card
               * holds this piece already, and says so: a tap that was cut short
               * wrote it. It is on the card, which is all that was wanted.
               * (Of several sent together it is the first that was refused:
               * each is sent by itself, to hear which.) */
              if (!(card.bare && e && e.card === 'on-card')) throw e;
              if (some.length === 1) { onCard[some[0].nonce] = true; return null; }
              return some.reduce(function (chain, piece) {
                return chain.then(function () { return send([piece]); });
              }, Promise.resolve());
            });
          };
          var sendProved = function (piece) {
            tell({ step: 'writing', i: written + 1, n: Math.max(toWrite, written + 1) });
            if (!loadBegan) loadBegan = Date.now();
            return cardLoadSend(t, card, 1, cardPieceBytes(piece) + piece.proof.e + piece.proof.s + piece.proof.r, 2, 'a piece', ru).then(function (d) {
              // the place, and 01 where the proof was kept or 00 where the card has no room for proofs: the piece is on it either way
              var h = String(d || '').toLowerCase();
              onCard[piece.nonce] = true;
              written += 1;
              sentWith += 1;
              if (fromMint) fresh.push(piece.nonce);
              if (h.length === 4 && h.substr(2, 2) === '01') kept += 1;
              else if (h.length === 4 && h.substr(2, 2) === '00' && !noRoom) {
                noRoom = true;
                console.log('[foxy] card: this card has no room for the mint\u2019s proofs; its pieces go on without them');
              }
            }, function (e) {
              // a piece the card holds already (a tap cut short wrote it, with its proof): it is on the card, which is all that was wanted
              if (!(card.bare && e && e.card === 'on-card')) throw e;
              onCard[piece.nonce] = true;
              return null;
            });
          };
          var next = function (from) {
            if (from >= todo.length) return Promise.resolve();
            if (proved(todo[from])) return sendProved(todo[from]).then(function () { return next(from + 1); });
            var some = [todo[from]];
            while (some.length < size && from + some.length < todo.length && !proved(todo[from + some.length])) some.push(todo[from + some.length]);
            return send(some).then(function () { return next(from + some.length); });
          };
          var each = next(0);
          return each.then(function () {
            // what could not be finished stays on file, marked, and is no longer owed: what is promised is what can be done
            var lost = prep.stuck.reduce(function (n, x) { return n + satsOf(x.blind.amount); }, 0);
            var worth = Math.max(0, cardRowAmt(row) - lost);
            if (prep.stuck.length) {
              // each output with why it is stuck: `key` (a till's key, to be mended) apart from those that cannot be finished at all
              var kept = Object.assign({}, row, { blind: prep.stuck.map(function (x) { return Object.assign({}, x.blind, { why: x.why }); }), stuck: true,
                                                  why: prep.stuck[0].why, stuckAt: Date.now() }, cardFig(cardRowUnit(row), lost));
              mustSave(CARD_OWED, cardStore(CARD_OWED).map(function (r) { return (r && r.id === row.id) ? kept : r; }));
              console.warn('[foxy] card: ' + cardSaid(lost, cardRowUnit(row)) + ' of the card’s own change cannot be finished (' + kept.why + '); kept, and not promised');
            } else {
              done.push(row.id);
              // off the list as each lands, so a card that leaves now owes only what is left
              mustSave(CARD_OWED, cardStore(CARD_OWED).filter(function (r) { return !(r && r.id === row.id); }));
            }
            sats += worth;
            byUnit[cardRowUnit(row)] = (byUnit[cardRowUnit(row)] || 0) + worth;
            // this phone's own card: what has just gone onto it is written down here, since a short read after it lists no nonces
            try { if (card.record && card.record.refundKey && cardsOnFile()[card.key]) cardRemember(card, pieces); } catch (xR) {}
            // a payment the mint refused, put back: said apart from a load or change, and each of those by what it was for
            if (row.kind === 'putback') back += worth;
            if (row.kind === 'change') change += worth;
            if (row.kind === 'refund') refund += worth;
            if (prep.stuck.length) return;
            // written: marked on the token's own note, so it is never taken for one that was not (`cardAdopt`). A payment put back has no note, nor has the card's own change
            if (row.kind !== 'putback' && !row.blind) { try { FoxyWallet.tag(row.id, { carded: Date.now() }); } catch (x0) {} }
            // a payment's change out of this phone: its own entry says it is back on the card as well
            if (row.kind === 'change' && row.payment) { try { amendTx(row.payment, { changeState: 'given back' }); } catch (xP) {} }
            if (row.kind === 'change' && row.forHash) { try { amendTx(row.forHash, { changeState: 'given back', changeKept: true }); } catch (x) {} }
            // change this phone fetched for a payment it does not know the entry of (`cardOwnerChange`)
            else if (row.fetched) { try { cardFetchedNote(row); } catch (x2) {} }
          }, function (e) { stopped = e; left.push(row.id); });
        }, function (e) { stopped = e; left.push(row.id); });
      });
    });
    return walk.then(function () {
      /* What went on, from the mint itself, is real (`cardRealNote`); and the one line of it, so that the time it took can be read off a phone:
       * how many pieces, how many of them were sent with the mint's proof (and how many of those the card kept), and the milliseconds from
       * the first load command to the last answer. No secret, nonce or point in it. */
      if (fresh.length && card.info && card.info.proofs) { try { cardRealNote(card.key, fresh); } catch (xr) {} }
      if (written > 0) {
        console.log('[foxy] card: wrote ' + written + ' piece(s), ' + sentWith + ' with the mint\u2019s proof' + (sentWith ? ' (' + kept + ' kept by the card)' : '')
          + ', in ' + (Date.now() - (loadBegan || Date.now())) + ' ms');
      }
      /* Nothing finished, but some pieces went on before the card left: said on
       * the error (`wrote`), so the screen can ask for the tap that finishes it
       * at once, as for any write cut short part way. */
      if (stopped && !done.length) {
        if (written > 0 && stopped && typeof stopped === 'object') { try { stopped.wrote = written; } catch (x) {} }
        throw stopped;
      }
      var why = stopped || misfit;
      // in the card's own unit: `amount`, and `sats` only for a bitcoin card
      var cu2 = (card.record && card.record.unit) || 'sat';
      /* (a card of 1.23: in the unit that went on, and where both did, the other in `also`, never added in; `back`, `change` and `refund`
       * are in the first's) */
      var wroteIn = Object.keys(byUnit);
      var also = null;
      if (cardIs123(card) && wroteIn.length) {
        cu2 = wroteIn.indexOf(cu2) >= 0 ? cu2 : wroteIn[0];
        sats = byUnit[cu2];
        if (wroteIn.length > 1) also = wroteIn.filter(function (u) { return u !== cu2; }).map(function (u) { return cardGot(u, byUnit[u]); });
      }
      var out = /** @type {any} */ ({ unit: cu2, amount: sats, sats: cu2 === 'sat' ? sats : 0, back: back, change: change, refund: refund, done: done, left: left,
               why: why ? (why.card || 'refused') : '', mended: mended, refused: refusedMend });
      if (also) out.also = also;
      return out;
    });
  }

  /* ---- change a till never handed over (software 1.12; the card's owner finishes it) -----
   *
   * A till that owes a card's change finishes the pieces at the second tap, from the
   * card's openings and the signatures it kept (`cardWriteOwed`). One that never taps
   * the card again (its phone died, or it was simply never held to the card a second
   * time) leaves them. The change is at the mint all the same, locked to the card's key,
   * so that nobody but the card can spend it, and the card still has what each piece is
   * made of until the piece is written back. So the card's owner finishes it, with no
   * help from the till:
   *
   *   1. the openings are read from the card (`GET_CHANGE`, no PIN);
   *   2. each makes the blinded message it was (`cardOpeningB`);
   *   3. the mint is asked for the signatures it already gave for them (NUT-09 restore,
   *      `cardRestoreSigs`), which it keeps for every output it has signed;
   *   4. what comes back is kept as the row the till would have kept (`cardBlindRow`,
   *      marked `fetched`), before anything else is done with it;
   *   5. and written onto the card in the same tap, with the owner's grant and no PIN, if
   *      the tap allows (`cardWriteOwed`: the blinding taken off, the DLEQ checked, three
   *      pieces to a command), the card letting each opening go as its piece lands.
   *
   * What the mint has not signed is still an opening, and nothing can be done for it from
   * here: the till never made the swap, the holder's money is in the pieces the card
   * burned, and the take-back by the refund key brings them home after their date. It
   * is said as that (`unmade`). What this phone owes already, as the till (a row of
   * `blind` for the same outputs), is the till's to finish, as before.
   *
   * The wait on the mint is what the card can be held for: a tap that cannot wait goes
   * on, the answer is kept when it comes (the row is filed whenever the mint says), and the
   * next tap of its owner writes it. */
  var CARD_FETCH_WAIT = 15000;
  // the mint's word on a card's openings while it is being asked, by card and the blinded messages: a second asking joins the first
  var cardFetches = {};
  var CARD_OWES_ORDER = ['put', 'fetched', 'mend', 'fetching', 'unmade', 'offline', 'away', 'silent', 'stuck'];

  /* Which of a card's openings this phone has an answer for already, and which not: each as { op, B_ }, by
   *   `stuck`  a row of the change kept as one that cannot be finished (`cardWriteOwed`);
   *   `here`   a row of it, owed to the card, to be written (the till's own, or fetched earlier);
   *   `ask`    nothing: the mint is asked;
   *   `bad`    an opening that is not a blinded message at all. */
  function cardOwesPlan(card, openings) {
    var by = {};
    cardStore(CARD_OWED).forEach(function (r) {
      if (!r || r.card !== card.key || !Array.isArray(r.blind)) return;
      r.blind.forEach(function (b) { if (b && b.B_) by[String(b.B_).toLowerCase()] = r; });
    });
    var plan = /** @type {{ stuck: any[], here: any[], ask: any[], bad: any[] }} */ ({ stuck: [], here: [], ask: [], bad: [] });
    openings.forEach(function (op) {
      var item = /** @type {any} */ ({ op: op, B_: cardOpeningB(card, op), state: '', row: null });
      if (!item.B_) { plan.bad.push(item); return; }
      var row = by[item.B_.toLowerCase()];
      if (!row) { plan.ask.push(item); return; }
      item.row = row;
      (row.stuck ? plan.stuck : plan.here).push(item);
    });
    return plan;
  }

  /* Why the mint cannot be asked from here, or '': there is no road to it, or the card is at another one. */
  function cardFetchBar(card) {
    var w = wallet;
    if (!w || !routeOpen()) return 'offline';
    if (!card.record || canonicalMint(card.record.mint) !== mintOf(w)) return 'away';
    return '';
  }

  /* The mint asked for its signatures on openings: Resolves { rows, unmade, blocked }, `rows` being the rows of change to be
   * written (not filed: `cardFetching` does that), `unmade` the openings the mint has not signed, and `blocked` those that
   * cannot be finished from here ({ item, why }: the card's keyset is none of this mint's, or its keys for the size are not
   * to be had). A keyset this mint no longer signs with is loaded first, as its keys are needed to take the blinding off. */
  function cardAskChange(w, card, items) {
    var blocked = [], sendable = [], ids = {};
    items.forEach(function (it) {
      var id = cardFullId(w, it.op.keyset);
      if (!id) { blocked.push({ item: it, why: 'keyset' }); return; }
      it.id = id;
      sendable.push(it);
      ids[id] = true;
    });
    var missing = Object.keys(ids).filter(function (id) { return !keysetFor(w, id); });
    var loaded = (missing.length && typeof w.ensureOperableKeysets === 'function')
      ? withTimeout(Promise.resolve(w.ensureOperableKeysets(missing)), 20000, 'the keys of a card’s keyset').then(function () {}, function () {})
      : Promise.resolve();
    return loaded.then(function () {
      sendable = sendable.filter(function (it) {
        var ks = keysetFor(w, it.id);
        if (ks && ks.keys && ks.keys[String(it.op.amount)]) return true;
        blocked.push({ item: it, why: 'keys' });
        return false;
      });
      if (!sendable.length) return { rows: [], unmade: [], blocked: blocked };
      return cardRestoreSigs(w, sendable.map(function (it) { return { amount: it.op.amount, B_: it.B_, id: it.id }; }), 'the mint’s word on the change a card is owed').then(function (sigs) {
        var groups = {}, unmade = [], rows = [];
        sendable.forEach(function (it) {
          var s = sigs[it.B_.toLowerCase()];
          // the mint's answer for this blinded message, of this size and this keyset and no other
          if (!s || satsOf(s.amount) !== it.op.amount || String(s.id).toLowerCase() !== it.id.toLowerCase()) { unmade.push(it); return; }
          var k = it.id + '|' + it.op.date;
          (groups[k] = groups[k] || []).push(it);
        });
        Object.keys(groups).forEach(function (k) {
          var g = groups[k];
          // as the till would have kept it: the outputs of one keyset and one date, with the mint's signature for each and its key for the size
          var spec = { id: '', keyset: g[0].id, change: { card: card.key, mint: canonicalMint(mintOf(w)), date: g[0].op.date, forHash: '',
                       outs: g.map(function (it) { return { amount: it.op.amount, B_: it.B_ }; }) } };
          var row = cardBlindRow(spec, sigs, w);
          if (!row) { g.forEach(function (it) { blocked.push({ item: it, why: 'keys' }); }); return; }
          row.id = 'fetch-' + piecesFingerprint(row.blind.map(function (b) { return { secret: b.B_ }; }));
          row.fetched = true;
          rows.push(row);
        });
        return { rows: rows, unmade: unmade, blocked: blocked };
      });
    });
  }

  /* The rows fetched, filed as owed to the card before anyone is told of them. No output that is owed already is filed again
   * (a second asking that landed first, or a set of openings that overlaps one asked after earlier): the signatures are the
   * same, and a piece is written once. */
  function cardFileFetched(rows) {
    if (!rows.length) return;
    var have = {};
    cardStore(CARD_OWED).forEach(function (r) {
      if (!r || !Array.isArray(r.blind)) return;
      r.blind.forEach(function (b) { if (b && b.B_) have[String(b.B_).toLowerCase()] = true; });
    });
    var fresh = [];
    rows.forEach(function (row) {
      var keep = row.blind.filter(function (b) { return !have[String(b.B_).toLowerCase()]; });
      if (!keep.length) return;
      if (keep.length === row.blind.length) { fresh.push(row); return; }
      fresh.push(Object.assign({}, row, { blind: keep, id: 'fetch-' + piecesFingerprint(keep.map(function (b) { return { secret: b.B_ }; })) },
                               cardFig(cardRowUnit(row), keep.reduce(function (n, b) { return n + b.amount; }, 0))));
    });
    if (!fresh.length) return;
    mustSave(CARD_OWED, cardStore(CARD_OWED).concat(fresh));
  }

  /* The asking, once for each set of openings at a time, and its rows filed whenever the mint's word comes, in the tap that
   * asked or after it. */
  function cardFetching(w, card, items) {
    var key = card.key + '|' + items.map(function (it) { return it.B_.toLowerCase(); }).sort().join(',');
    if (cardFetches[key]) return cardFetches[key];
    var asking = Promise.resolve().then(function () { return cardAskChange(w, card, items); }).then(function (r) {
      delete cardFetches[key];
      cardFileFetched(r.rows);
      return r;
    }, function (e) { delete cardFetches[key]; throw e; });
    cardFetches[key] = asking;
    return asking;
  }

  /* A promise's outcome within `ms`: { value }, { error } or { late } (still going), and never a rejection. The clock is
   * stopped as soon as there is an outcome. */
  function cardWithin(promise, ms) {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve({ late: true }); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve({ value: v }); }, function (e) { clearTimeout(timer); resolve({ error: e }); });
    });
  }

  /* Where a card's openings stand, as the screen says it. `items` are { op, state }; the states, in the order they are
   * said, are in CARD_OWES_ORDER: `put` (fetched and written in this tap), `fetched` (the signatures are here and the
   * pieces are to go on), `fetching` (the mint has not answered yet), `unmade` (it has not signed them: the till has not
   * made its swap), `offline` (no road to the mint), `away` (the card is at another mint), `silent` (the mint did not
   * answer), `stuck` (cannot be finished). And `mend` (software 1.22): a till bound it to a key that is not the mint's, and the
   * mint's answer, which this phone has, goes on under the card's PIN (`cardMend`). Answers { unit, amount, sats, count, parts:
   * [{ state, amount, sats, count }], wrote, openings }: in the card's `unit`, `amount` the figure and `sats` the same for a bitcoin
   * card, and 0 for a dollar one; `openings` each opening by its number on the card (1.21 and on), its amount, its state and whether
   * it may be given up (`giveUp`, `cardGiveUp`): one a till bound to a key of its own that the mint has no answer for (or, before 1.22,
   * that cannot be mended), one whose opening cannot be read, and one whose piece the card would not take under the mint's own key
   * (`why`). Never one that waits on something that may yet come: the mint's keys not fetched in this tap (`keys`), a keyset this phone
   * does not know of now (`keyset`), or an answer from the mint without its proof (`no-proof`), which the till that made the change may
   * still put on with its own: money given up is gone for good. */
  var CARD_GIVE_UP_WHY = { opening: true, signature: true };
  function cardGiveUpFits(it) {
    if (typeof it.op.number !== 'number') return false;
    if (it.state === 'unmade') return !!it.poisoned;
    return it.state === 'stuck' && (!!it.poisoned || CARD_GIVE_UP_WHY[String(it.why || '')] === true);
  }
  function cardOwesFrom(items, wrote, unit) {
    var u = unitOf(unit) || 'sat';
    var by = {};
    items.forEach(function (it) {
      var x = by[it.state] = by[it.state] || { state: it.state, amount: 0, sats: 0, count: 0 };
      x.amount += it.op.amount;
      if (u === 'sat') x.sats += it.op.amount;
      x.count += 1;
    });
    var parts = [];
    CARD_OWES_ORDER.forEach(function (s) { if (by[s]) parts.push(by[s]); });
    var all = items.reduce(function (n, it) { return n + it.op.amount; }, 0);
    // the opening's blinded message with it, so that what is given up is the opening the screen showed and no other (`cardGiveUp`)
    var openings = items.map(function (it) { return { number: it.op.number, amount: it.op.amount, B_: it.B_ || '', state: it.state, giveUp: cardGiveUpFits(it) }; });
    return { unit: u, amount: all, sats: u === 'sat' ? all : 0, count: items.length, parts: parts, wrote: wrote || 0, openings: openings };
  }

  /* A card that lists no openings has had every piece written, by whoever got there first (the till, late, or another phone of
   * its owner's), or has lost them. The rows this phone fetched for it that are still on file are settled as a write would settle
   * them, with nothing put on the card, so that a line saying change is waiting to go on is not left standing for money that is
   * on it. Resolves null: the card owes nothing. */
  function cardFetchedStale(t, card, o) {
    var ids = cardStore(CARD_OWED).filter(function (r) {
      return r && r.card === card.key && r.fetched && !r.stuck && Array.isArray(r.blind);
    }).map(function (r) { return r.id; });
    if (!ids.length) return Promise.resolve(null);
    return cardWriteOwed(t, card, o.progress, ids, []).then(function () { return null; }, function () { return null; });
  }

  /* Why an output of a row of the card's own change is stuck: its own word, or the row's. */
  function cardStuckWhy(row, B_) {
    var b = (row && Array.isArray(row.blind) ? row.blind : []).filter(function (x) { return x && String(x.B_).toLowerCase() === String(B_).toLowerCase(); })[0];
    return String((b && b.why) || (row && row.why) || '');
  }

  /* The rows of a card's own change kept as stuck for a till's key (`key`), made owed again: the holder's say is in this tap
   * (`cardMend`), and they are what it mends. Answers how many. */
  function cardUnstickKeyed(cardKey) {
    var n = 0;
    var all = cardStore(CARD_OWED).map(function (r) {
      if (!(r && r.card === cardKey && r.stuck && Array.isArray(r.blind) && r.blind.some(function (b) { return cardStuckWhy(r, b && b.B_) === 'key'; }))) return r;
      n += 1;
      var blind = r.blind.map(function (b) { var c = Object.assign({}, b); delete c.why; return c; });
      var back = Object.assign({}, r, { stuck: false, blind: blind }, cardFig(cardRowUnit(r), blind.reduce(function (m, b) { return m + satsOf(b.amount); }, 0)));
      delete back.why;
      delete back.stuckAt;
      return back;
    });
    if (n) mustSave(CARD_OWED, all);
    return n;
  }

  /* The owner's phone, reading its card (`opts.mine`, the grant given): the openings are read, and the change a till has not
   * handed over is fetched and, in this tap, put on. Resolves what `cardOwesFrom` says, with `wrote` (sats put on the card now)
   * and, where the mint was still being asked as the tap went on, `later`: a promise of the same as it stands once it has
   * answered. Null when the card has no openings. `opts.on` is told 'mint' while the mint is asked, and `opts.progress` of
   * each piece written. Never rejects for the mint, nor for a card that leaves: those are what it says.
   *
   * `opts.mend` (`cardMend`, software 1.22): the PIN and the owner's grant are in this tap and it has paid nothing, so an opening a till
   * bound to a key that is not the mint's is put on too, with the mint's answer under the mint's key, and every row of the card's own
   * change this phone holds goes on (a till's own as well as what was fetched). Then `refused` says how many of those the card
   * would not take, and `why` what stopped the write, if anything did. */
  function cardOwnerChange(t, card, opts) {
    var o = opts || {};
    var items = /** @type {any[]} */ ([]), openings = /** @type {any[]} */ ([]);
    var later = /** @type {any} */ (null);
    var wrote = /** @type {any} */ (null), stopped = /** @type {any} */ (null);
    // 1.22: an output kept for a till's key is the holder's to mend; on a card before it nothing can be, and it cannot be finished
    var keyed = function (row, B_) { return cardStuckWhy(row, B_) === 'key' && !!(card.info && card.info.guests); };
    if (o.mend) cardUnstickKeyed(card.key);
    return cardOpenings(t).then(function (list) {
      openings = list;
      if (!list.length) return cardFetchedStale(t, card, o);
      var plan = cardOwesPlan(card, list);
      plan.stuck.concat(plan.bad).forEach(function (it) {
        it.state = (it.row && keyed(it.row, it.B_)) ? 'mend' : 'stuck';
        it.why = it.row ? cardStuckWhy(it.row, it.B_) : 'opening';
        items.push(it);
      });
      plan.here.forEach(function (it) { it.state = 'fetched'; items.push(it); });
      var ask = plan.ask;
      items = items.concat(ask);
      var bar = ask.length ? cardFetchBar(card) : '';
      if (bar) ask.forEach(function (it) { it.state = bar; });
      var answered = Promise.resolve();
      if (ask.length && !bar) {
        try { if (typeof o.on === 'function') o.on('mint'); } catch (e) {}
        // said on the sheet and the screen: what the card is being held for
        // in the card's unit: `amount`, and `sats` for a bitcoin card only
        try { if (typeof o.progress === 'function') o.progress(Object.assign({ step: 'fetching' }, cardGot((card.record && card.record.unit) || 'sat', ask.reduce(function (n, it) { return n + it.op.amount; }, 0)))); } catch (e3) {}
        console.log('[foxy] card: ' + ask.length + ' piece(s) of its change, ' + ask.reduce(function (n, it) { return n + it.op.amount; }, 0)
          + ' sats, are not owed by this phone; the mint is asked what it signed for them');
        var w;
        try { w = need(); } catch (e0) { w = null; }
        if (!w) {
          ask.forEach(function (it) { it.state = 'offline'; });
        } else {
          var asking = cardFetching(w, card, ask);
          // what the mint said, on the openings: a row (fetched), nothing (not made yet), or something that cannot be done from here
          var apply = function (r) {
            var rowOf = {}, why = {};
            r.rows.forEach(function (row) { row.blind.forEach(function (b) { rowOf[String(b.B_).toLowerCase()] = row; }); });
            r.blocked.forEach(function (x) { why[x.item.B_.toLowerCase()] = x.why; });
            ask.forEach(function (it) {
              var k = it.B_.toLowerCase();
              if (rowOf[k]) { it.state = 'fetched'; it.row = rowOf[k]; }
              else if (why[k]) { it.state = 'stuck'; it.why = why[k]; }
              else it.state = 'unmade';
            });
            var made = r.rows.reduce(function (n, row) { return n + cardRowAmt(row); }, 0), none = r.unmade.reduce(function (n, it) { return n + it.op.amount; }, 0);
            console.log('[foxy] card: the mint signed ' + made + ' sats of the change the card is owed' + (none > 0 ? '; ' + none + ' sats it has not signed (the till has not made its swap)' : ''));
          };
          var wait = Number(FoxyWallet._cardFetchWait);
          answered = cardWithin(asking, wait >= 0 ? wait : CARD_FETCH_WAIT).then(function (res) {
            if (res.late) {
              ask.forEach(function (it) { it.state = 'fetching'; });
              // the answer is filed when it comes (`cardFetching`); what the screen says of it then is told after
              later = asking.then(apply, function () { ask.forEach(function (it) { it.state = 'silent'; }); }).then(function () { return cardOwesFrom(items, 0, card.record && card.record.unit); });
              console.log('[foxy] card: the mint has not answered yet; its word on the card’s change is kept when it does, and the next tap puts it on');
              return;
            }
            if (res.error) {
              console.warn('[foxy] card: the mint would not say what it signed for the card’s change:', (res.error && res.error.message) || res.error);
              ask.forEach(function (it) { it.state = 'silent'; });
              return;
            }
            apply(res.value);
          });
        }
      }
      return answered.then(function () {
        /* What this phone fetched is put on the card in this tap: the owner's grant lets it, and the card is there. Under the holder's say
         * (`o.mend`), every row of the card's own change this phone holds for it. */
        var ids = cardStore(CARD_OWED).filter(function (r) {
          return r && r.card === card.key && (r.fetched || o.mend) && !r.stuck && Array.isArray(r.blind);
        }).map(function (r) { return r.id; });
        var mine = items.filter(function (it) { return it.row && (it.row.fetched || o.mend) && it.state === 'fetched'; });
        if (!ids.length || !mine.length) return null;
        try { if (typeof o.on === 'function') o.on('writing'); } catch (e2) {}
        return cardWriteOwed(t, card, o.progress, ids, openings, !!o.mend).then(function (r) { wrote = r; }, function (e) {
          stopped = e;
          // the card left, or would not take it: the rows are still owed, and the next tap writes them
          console.warn('[foxy] card: the change fetched for it could not be put on in this tap:', (e && e.message) || e);
        });
      }).then(function () {
        /* Each opening by where its output stands now, in whatever row holds it: gone from the store is written; kept apart
         * because it cannot be finished is stuck (or, kept for a till's key, to be mended); otherwise it is still to go on. One that
         * never had a row is as the mint left it. */
        var byB = {};
        cardStore(CARD_OWED).forEach(function (r) {
          if (r && Array.isArray(r.blind)) r.blind.forEach(function (b) { if (b && b.B_) byB[String(b.B_).toLowerCase()] = r; });
        });
        var w1 = wallet;
        items.forEach(function (it) {
          // bound to a key that is not the mint's: what decides whether an opening the mint never answered may be given up
          it.poisoned = !!w1 && cardPoisoned(w1, it.op);
          if (!it.row) return;
          var cur = byB[it.B_.toLowerCase()];
          if (!cur) { if (it.row.fetched || o.mend) it.state = 'put'; return; }
          if (cur.stuck) { it.state = keyed(cur, it.B_) ? 'mend' : 'stuck'; it.why = cardStuckWhy(cur, it.B_); }
        });
        // what went on in this tap is what its openings were worth: the card listed each only while its piece was not on it
        var put = items.reduce(function (n, it) { return it.state === 'put' ? n + it.op.amount : n; }, 0);
        var owes = /** @type {any} */ (cardOwesFrom(items, put, card.record && card.record.unit));
        if (later) owes.later = later;
        if (o.mend) { owes.refused = (wrote && wrote.refused) || 0; owes.why = stopped ? (stopped.card || 'refused') : ''; owes.error = stopped || null; }
        return owes;
      });
    });
  }

  /* The change of a card with no owner, looked into in a tap its holder holds for (software 1.22: the PIN given and the history held
   * for, `cardGuestLook` and `cardMend`): the openings are read, the mint is asked what it signed for them, and what it signed goes on
   * in the same tap, an opening a till bound to a key of its own included, under the mint's own key (`cardLoadChange` with `mend`).
   * Nothing is filed on this phone: the card is its holder's, and what is not put on now stays on the card as an opening, for the next
   * tap. Resolves what `cardOwesFrom` says, with `refused` (outputs the card would not take) and `error` (what stopped the write, if
   * anything did), or null for a card owed nothing. Never rejects for the mint. */
  function cardGuestChange(t, card, opts) {
    var o = opts || {};
    var unit = (card.record && card.record.unit) || 'sat';
    if (!(card.info && card.info.ownChange)) return Promise.resolve(null);
    var refused = 0, put = 0, stopped = /** @type {any} */ (null);
    return cardOpenings(t).then(function (list) {
      if (!list.length) return null;
      var items = list.map(function (op) { return /** @type {any} */ ({ op: op, B_: cardOpeningB(card, op), state: '', row: null }); });
      var good = items.filter(function (it) { if (!it.B_) { it.state = 'stuck'; it.why = 'opening'; } return !!it.B_; });
      var bar = cardFetchBar(card);
      var w = wallet;
      var done = function () {
        items.forEach(function (it) { it.poisoned = !!w && cardPoisoned(w, it.op); });
        var owes = /** @type {any} */ (cardOwesFrom(items, put, unit));
        owes.refused = refused;
        owes.error = stopped;
        return owes;
      };
      if (bar || !w) { good.forEach(function (it) { it.state = bar || 'offline'; }); return done(); }
      try { if (typeof o.on === 'function') o.on('mint'); } catch (e) {}
      var wait = Number(FoxyWallet._cardFetchWait);
      return cardWithin(cardAskChange(w, card, good), wait >= 0 ? wait : CARD_FETCH_WAIT).then(function (res) {
        // nothing is kept for a later answer: the openings stay on the card for the next tap
        if (res.late || res.error) { good.forEach(function (it) { it.state = 'silent'; }); return null; }
        var r = res.value, rowOf = {}, why = {};
        r.rows.forEach(function (row) { row.blind.forEach(function (b) { rowOf[String(b.B_).toLowerCase()] = row; }); });
        r.blocked.forEach(function (x) { why[x.item.B_.toLowerCase()] = x.why; });
        good.forEach(function (it) {
          var k = it.B_.toLowerCase();
          it.state = rowOf[k] ? 'fetched' : why[k] ? 'stuck' : 'unmade';
          it.why = rowOf[k] ? '' : (why[k] || '');
          it.row = rowOf[k] || null;
        });
        if (!r.rows.length) return null;
        try { if (typeof o.on === 'function') o.on('writing'); } catch (e2) {}
        return r.rows.reduce(function (chain, row) {
          return chain.then(function () {
            return cardLoadChange(t, card, row, list, function () {}, true).then(function (got) {
              refused += got.refused || 0;
              var no = {};
              got.stuck.forEach(function (x) { no[String(x.blind.B_).toLowerCase()] = x.why || 'signature'; });
              good.forEach(function (it) {
                if (it.row !== row) return;
                it.state = no[it.B_.toLowerCase()] ? 'stuck' : 'put';
                it.why = no[it.B_.toLowerCase()] || '';
                if (it.state === 'put') put += it.op.amount;
              });
            });
          });
        }, Promise.resolve()).then(null, function (e) {
          stopped = e;
          console.warn('[foxy] card: the change of a card with no owner could not be put on in this tap:', (e && e.message) || e);
        });
      }).then(done);
    });
  }

  /* The owner's read of a card, with its change finished (`opts.change` of `FoxyWallet.cardLook`): the card as read, with
   * `owes` on it where it has openings, and, if change was put on it in this tap, the card as it now is. Never fails the read. */
  function cardOwnerFinish(link, opts, card) {
    var o = opts || {};
    if (!(card && card.mine === true && card.info && card.info.ownChange && !card.info.locked && card.info.pin !== 'blocked')) return Promise.resolve(card);
    var t = cardTalk(link);
    return cardOwnerChange(t, card, o).then(function (owes) {
      if (!owes) return card;
      if (!(owes.wrote > 0)) { card.owes = owes; return card; }
      // what is on the card now, for the screen: read again as it was, without the change
      var again = Object.assign({}, o);
      delete again.change;
      return cardLook(link, again).then(function (fresh) {
        fresh.owes = owes;
        return fresh;
      }, function () {
        // gone as it was put on: the card as it was read, with what went on added to its balance
        card.balance = (Number(card.balance) || 0) + owes.wrote;
        card.owes = owes;
        return card;
      });
    }, function (e) {
      console.warn('[foxy] card: the change a till never handed over could not be looked into:', (e && e.message) || e);
      return card;
    });
  }

  /* The entries of this phone's own that were waiting for change, now that it has been fetched and put on the card. A payment
   * this phone took as a till and lost the row of change for is the only one with an entry here; nothing says which payment a
   * card's openings were for, so an entry is taken where the sums say so and not otherwise: the one whose change is what was
   * written, or all of the card's that are waiting if together they are. Those with a row of their own still owed are left to it. */
  function cardFetchedNote(row) {
    // in the row's own unit, against entries of that unit only (a dollar card's change is in cents, on dollar entries)
    var sats = cardRowAmt(row), ru = cardRowUnit(row);
    var list = load(K.log, []);
    var owedFor = {};
    cardStore(CARD_OWED).forEach(function (r) { if (r && r.forHash) owedFor[r.forHash] = true; });
    cardStore(CARD_DUE).forEach(function (d) { if (d && d.forHash) owedFor[d.forHash] = true; });
    var waiting = (Array.isArray(list) ? list : []).filter(function (e) {
      return e && e.dir === 'in' && e.card === row.card && recordUnit(e) === ru && e.changeState === 'not handed'
        && cardEntryFig(e, 'changeSats') > 0 && !owedFor[e.hash];
    });
    // the list is newest first: the oldest entry that fits is the payment longest waiting
    var exact = waiting.filter(function (e) { return Math.round(cardEntryFig(e, 'changeSats')) === sats; });
    var pick = exact.length ? exact.slice(-1)
      : (waiting.length && waiting.reduce(function (n, e) { return n + Math.round(cardEntryFig(e, 'changeSats')); }, 0) === sats ? waiting : []);
    pick.forEach(function (e) { amendTx(e.hash, { changeState: 'given back', changeKept: true }); });
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
      // in the token's own unit (a dollar card's load is cents)
      owed.push(Object.assign({ id: hash, card: card.key, token: note.token, kind: 'load', forHash: hash, at: Date.now(),
                                adopted: true, mint: home }, cardFig(unitOf(tok.unit) || 'sat', sumProofs(tok.proofs))));
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
   * its pieces back or none, the key its time is signed by, and its mint's
   * address as text. Throws where the address is one a card cannot hold.
   * The 65 bytes where a card of 1.14 and before kept its time key are zeros: a card reads none.
   * `unit`: 'sat' (or none) or 'usd', the one byte the record starts with (`cardUnitByte`);
   * a card moved keeps the one it has. */
  function cardRecordHex(refundKey, mint, design, unit) {
    var at = String(mint || '');
    if (!at || at.length > CARD_MINT_MAX || /[^\x20-\x7e]/.test(at)) throw cardError('bad-mint', 'This mint\u2019s address is too long for a card.');
    var key = new Array(131).join('0');
    var hex = '';
    for (var i = 0; i < at.length; i++) hex += cardByte(at.charCodeAt(i));
    // the design after the mint, only for a card whose software takes it (`cardCanDesign`): a code of three characters
    var code = String(design || '').toUpperCase();
    var tail = '';
    if (/^[A-Z0-9]{3}$/.test(code)) for (var k = 0; k < 3; k++) tail += cardByte(code.charCodeAt(k));
    return cardUnitByte(unit) + (refundKey || new Array(67).join('0')) + key + cardByte(at.length) + hex + tail;
  }

  /* A card on its way to another mint, told so.
   *
   * Money moved for a card is filed as owed to it at the mint it was moved
   * to (`cardPrepare`, `moving`). When that card is next written, at that
   * mint, its record is changed first. Only an empty card: the card itself
   * refuses to change mints under unspent pieces, and it is not asked to. So
   * a card never holds ecash of a mint it does not name, and a move cut short
   * before its second tap is finished by any later one. The record is the
   * owner's to change, with the owner's proof and no PIN, and  Answers whether it changed. */
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
    // a dollar card goes only to a mint that issues dollars, and keeps its unit
    if (card.record.unit === 'usd' && unitsOf(here, w).indexOf('usd') < 0) {
      return Promise.reject(cardError('no-dollars-here', hostOf(here) + ' does not issue dollars. RESET this card and set it up again to hold bitcoin there.'));
    }
    var record;
    try { record = cardRecordHex(card.record.refundKey, here, cardCanDesign(card) ? card.record.design : '', card.record.unit); } catch (e) { return Promise.reject(e); }
    return cardOwned(t, card.key, 'set-card', record).then(function (data) {
      return t.want(cardCommand(CARD_INS.setCard, 0, data), 'its new mint');
    }).then(function () {
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
   * mint has, and not too near its date. Near is ten minutes for the card's
   * owner, a day for a phone with a route, and a week for one with none
   * (`offline`), which keeps what the card signs until it can reach the mint.
   * `now` is in seconds, this phone's clock where it is not given; with no
   * route it is `cardOfflineNow`. */
  function cardUsable(card, w, own, now, offline) {
    if (!(Number(now) > 0)) now = Math.floor(Date.now() / 1000);
    var margin = own ? cardOwnMargin() : (offline ? cardDateMargin() : cardOnlineMargin());
    var out = /** @type {{ pieces: any[], stale: number, foreign: number }} */ ({ pieces: [], stale: 0, foreign: 0 });
    var cu = (card.record && card.record.unit) || 'sat';
    var at = mintOf(w), sets = keysetsOf(at, w);
    // (a card of 1.23 that holds both units: a piece's keyset is looked for among the mint's keysets of the unit its table names, `x.unit`)
    var both = cardBoth(card.whole || card);
    card.pieces.forEach(function (x) {
      var id = cardFullId(w, x.keyset, both ? (x.unit || 'none') : undefined);
      if (!id) { out.foreign += x.amount; return; }
      /* Of the card's own unit only, as an unknown keyset is not: a piece of the other unit on a card is a card that was
       * written wrong, and it never pays (a dollar card's pieces are dollars, and a bitcoin card's are not). */
      var ku = keysetUnit(at, id, w, sets);
      if (cu === 'sat' ? (ku && ku !== 'sat') : ku !== cu) { out.foreign += x.amount; return; }
      if (x.date && x.date < now + margin) { out.stale += x.amount; return; }
      /* Read briefly, it has no nonce and no C yet: it is chosen by what it is
       * worth, under a name that is its place and nothing else, and made
       * whole before it is signed for (`cardFill`). */
      var proof = /** @type {any} */ (x.bare
        ? { id: id, amount: x.amount, C: '', secret: 'place ' + x.i, bare: true }
        : cardProofOf(x, card.key, card.record.refundKey, id, card.info.format));
      proof.slot = x.i;
      proof.date = x.date;
      out.pieces.push(proof);
    });
    return out;
  }

  /* The time a phone with no route holds a card's dates to, in seconds: the
   * latest it has evidence for. Its own clock; the newest block header it has
   * kept (whose time may run up to two hours ahead, which only makes this
   * stricter); the card's own clock, from the headers it has been shown (a card
   * that says a later time only gets itself refused); when this phone last had
   * the mint's keys; and the newest card payment it has kept. A clock set back
   * cannot pass a piece this phone has seen evidence is near its date; one set
   * forward only refuses more. Which source was used is said in the log when it
   * is not the phone's own clock (`quiet`: not again, for a tap that has said). */
  function cardOfflineNow(card, quiet) {
    var best = Math.floor(Date.now() / 1000), from = 'phone';
    var seen = function (t, name) { t = Math.floor(Number(t) || 0); if (t > best) { best = t; from = name; } };
    try { var h = headerKept(); if (h) seen(h.time, 'header'); } catch (e) {}
    try { if (card && card.info && card.info.headers) seen(card.info.now, 'card'); } catch (e1) {}
    try { seen((mintCacheFor(mintUrl) || {}).at, 'mint keys'); } catch (e2) {}
    try { cardKeptAll().forEach(function (r) { if (r) seen((Number(r.at) || 0) / 1000, 'a kept payment'); }); } catch (e3) {}
    if (from !== 'phone' && !quiet) console.log('[foxy] card: offline, its dates are held to the time from ' + from + ', ' + (best - Math.floor(Date.now() / 1000)) + ' s past this phone’s clock');
    return best;
  }

  /* Whether this phone is the one that may take this card back: the refund
   * key the card names is the one on file here for it. */
  function cardMine(card) {
    var row = cardsOnFile()[card.key];
    return !!(row && row.refundKey && card.record && row.refundKey === card.record.refundKey);
  }

  /* ---- a card of one unit: bitcoin, or dollars ----------------------------------
   *
   * A card holds one kind of money, chosen when it is set up: bitcoin (sats) or the
   * mint's dollars (usd ecash, in cents). The card itself keeps the unit in its record
   * and never reads it: its limits and its waits are plain numbers, in whatever the
   * card holds. Everything that moves a dollar card's money does it with the dollar
   * wallet, so the dollar keyset, its fee and its counters, and every figure written
   * down for it is in cents under the names a row of another unit uses (08c-units.js:
   * `amount`, never `sats`). A bitcoin card is moved with the sat wallet itself, the
   * same object as ever, so nothing about it changes. */

  /* The unit byte of a card's record: 00 for bitcoin (and for none said), 01 for dollars. Any other is refused. */
  function cardUnitByte(unit) {
    var u = (unit === undefined || unit === null || unit === '') ? 'sat' : unitOf(unit);
    if (u === 'sat') return '00';
    if (u === 'usd') return '01';
    throw cardError('bad-unit', 'A card holds bitcoin or dollars.');
  }

  /* The unit a card row, an owed row or a kept record is in: its own word, else its token's, else (the card's own change, which
   * has no token) its keyset's; sats for a row from before rows said. */
  /* A unit a row names that this phone does not know is answered as it is named, not as sats: a row of it then matches no
   * card and no pile (it stays where it is), and its figure is read from `amount`, never from a `sats` it does not have. */
  function cardRowUnit(row) {
    if (!row) return 'sat';
    var named = function (u) { return unitOf(u) || String(u).trim().toLowerCase() || 'sat'; };
    if (row.unit) return named(row.unit);
    if (row.token) {
      try { var info = FoxyWallet.tokenInfo(row.token); if (info && info.unit) return named(info.unit); } catch (e) {}
    }
    if (Array.isArray(row.blind) && row.blind[0] && row.blind[0].id) {
      var ku = keysetUnit(row.mint || mintUrl, row.blind[0].id);
      if (ku) return ku;
    }
    return 'sat';
  }

  /* The figure of a card row in its own unit: `sats` on a sat row, `amount` on any other. */
  function cardRowAmt(row) {
    if (!row) return 0;
    var n = cardRowUnit(row) === 'sat' ? satsOf(row.sats) : satsOf(row.amount);
    return isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  /* A row's figure, written in its unit's names: { unit: 'sat', sats } for bitcoin, { unit, amount, sats: 0 } for any other.
   * No cents ever sit under a field named sats. */
  /* The unit a figure is given in: sats where none is named, as every caller before units; a unit named that this phone cannot
   * read is kept as it is named, never taken for sats (its figure is then `amount`, with no sats). */
  function cardFigUnit(unit) {
    if (unit === undefined || unit === null || unit === '') return 'sat';
    return unitOf(unit) || String(unit).trim().toLowerCase() || 'sat';
  }

  function cardFig(unit, n) {
    var u = cardFigUnit(unit);
    var v = Math.max(0, Math.round(Number(n) || 0));
    return u === 'sat' ? { unit: 'sat', sats: v } : { unit: u, amount: v, sats: 0 };
  }

  /* A figure as a result says it: `amount` in `unit`, and `sats` the same for bitcoin and 0 for any other. */
  function cardGot(unit, n) {
    var u = cardFigUnit(unit);
    var v = Math.max(0, Math.round(Number(n) || 0));
    return { unit: u, amount: v, sats: u === 'sat' ? v : 0 };
  }

  /* What a send made (`sendToken`), in its own unit: a dollar send says `amount` and 0 sats. */
  function cardMade(made) {
    if (!made) return 0;
    return Math.round(Number(made.unit && made.unit !== 'sat' ? made.amount : made.sats) || 0);
  }

  /* A figure said in a card's words: as the sat words always were ("2000 sats"), and dollars as dollars. */
  function cardSaid(n, unit) {
    var u = unitOf(unit) || 'sat';
    return u === 'sat' ? Math.round(Number(n) || 0) + ' sats' : moneyWords(n, u);
  }

  /* The names of an entry's figures in a unit other than sats (08c-units.js, `unitRow`). */
  var CARD_FIG_NAMES = /** @type {Object<string, string>} */ ({ sats: 'amount', feeSats: 'feeAmount', grossSats: 'grossAmount', changeSats: 'changeAmount', dustSats: 'dustAmount' });

  /* An entry amended from card code, its figures in the entry's own unit: as written for a sat entry, and under the names of a
   * row of another unit for a dollar one (`sats` is `amount`, `grossSats` is `grossAmount`, and so on, with `sats` 0). The unit
   * is the entry's own where it is written down already, and `unit` (the row's) where it is not. */
  function cardAmend(hash, fields, unit) {
    var u = unitOf(unit) || 'sat';
    try {
      var e = (load(K.log, []) || []).filter(function (x) { return x && x.hash === hash; })[0];
      if (e) u = recordUnit(e);
    } catch (x0) {}
    if (u === 'sat') return amendTx(hash, fields);
    var out = /** @type {any} */ ({});
    Object.keys(fields || {}).forEach(function (k) {
      if (CARD_FIG_NAMES[k]) out[CARD_FIG_NAMES[k]] = fields[k]; else out[k] = fields[k];
    });
    out.unit = u;
    out.sats = 0;
    if ('feeAmount' in out) out.feeSats = 0;
    return amendTx(hash, out);
  }

  /* One of an entry's figures by its sat name, read in the entry's own unit (`changeSats` is `changeAmount` on a dollar entry). */
  function cardEntryFig(e, name) {
    if (!e) return 0;
    var n = recordUnit(e) === 'sat' ? Number(e[name]) : Number(e[CARD_FIG_NAMES[name] || name]);
    return isFinite(n) ? n : 0;
  }

  /* The wallet a card's money is moved with: the sat wallet as it is today for a bitcoin card (the same object, so nothing
   * about a bitcoin card changes), and for a dollar card the dollar wallet on the same circuit (`unitWalletOn`), or, with no
   * route (`offline`), built from what this phone already knows of the mint and asking it nothing (`unitWalletLocal`). */
  function cardWalletFor(unit, w0, offline) {
    var u = unitOf(unit) || 'sat';
    if (u === 'sat') return Promise.resolve(w0);
    return offline ? unitWalletLocal(u) : unitWalletOn(w0, u);
  }

  /* The same, at once, for sums only (no swap): the cut, the fee, the biggest piece. The dollar wallet where it is built, and
   * otherwise one that answers for the dollar keyset by its id (`feeWalletFor`). Null where the unit's keyset is not known. */
  function cardWalletNow(unit) {
    var u = unitOf(unit) || 'sat';
    if (u === 'sat') { try { return needLocal(); } catch (e) { return null; } }
    try { return unitWalletNow(u) || feeWalletFor(u, needLocal()); } catch (e2) { return null; }
  }

  /* A card asked for a payment in a unit it does not hold. A dollar card asked for sats at a mint that issues both is not
   * refused outright: the phone being paid can work out the cents at its own price, or ask the mint, and the holder agrees by
   * tapping again (`other-unit`, with what the screen needs to say the figure). A bitcoin card asked for dollars is refused:
   * the phone being paid has its own way to take bitcoin for a dollar receive (a sats ask). Said before any PIN, BEGIN or
   * signature. */
  function cardWrongUnit(cardUnit, askUnit, card) {
    if (cardUnit === 'usd' && askUnit === 'sat') {
      return cardError('other-unit', 'This card holds dollars here, not bitcoin.',
        { unit: 'usd', asked: 'sat', cardUnit: 'usd', askUnit: 'sat', balance: card ? card.balance : 0,
          mint: card && card.record ? canonicalMint(card.record.mint) : '', pinSet: !!(card && card.info && card.info.pinSet),
          noPinLeft: (card && card.noPin) ? card.noPin.left : 0, key: card ? card.key : '',
          // (a card of 1.23 that holds bitcoin too, too little of it for this: what it holds, for the till to say why the dollars are asked)
          satsToo: (card && (card.whole || card).units) ? ((card.whole || card).units.sat.balance || 0) : 0 });
    }
    if (cardUnit === 'sat' && askUnit === 'usd') {
      return cardError('wrong-unit', 'This card holds bitcoin here, not dollars.', { cardUnit: 'sat', askUnit: 'usd' });
    }
    return cardError('wrong-unit', 'This card holds ' + balanceWord(cardUnit) + ', not ' + balanceWord(askUnit) + '.',
                     { cardUnit: cardUnit, askUnit: askUnit });
  }

  /* Why this card cannot be used here at all, as an error, or null.
   *
   * `ask`: the unit a payment is asked in, where there is one. `w` is the wallet the card's money is to be moved with; `before`
   * says it is not that wallet yet (the sat wallet, asked before the card's unit is known), and the last check is left out: a
   * wallet of another unit than the card's is never handed its pieces. The card's mint is said before its unit, so a dollar
   * card at another mint is told it is at another mint. */
  function cardUnusable(card, w, ask, before) {
    if (card.info.pin === 'blocked') return cardRefused('6983');
    // a card of software 1.16 may have no PIN and still be set up (`info.setUp`); before it, no PIN is a card with nothing on it
    if (!card.info.setUp) return cardError('empty', 'There is no money on this card.');
    var cu = card.record.unit;
    if (cu !== 'sat' && cu !== 'usd') return cardError('not-a-card', 'That card holds something other than bitcoin or dollars.');
    var here = mintOf(w);
    if (canonicalMint(card.record.mint) !== here) {
      /* With what a till needs to have the card pay it from there (26f-flashcard.js, `fcXmBegin`): the card's unit, its key, what it
       * holds, and whether it will want its PIN. Said before any PIN, BEGIN or signature, as ever. */
      var otherMint = cardError('other-mint', 'This card\u2019s money is at ' + hostOf(card.record.mint) + '. This phone is at ' + hostOf(here) + '.',
                       { mint: canonicalMint(card.record.mint), cardUnit: cu === 'usd' ? 'usd' : 'sat', key: card.key || '', balance: card.balance || 0,
                         pinSet: !!(card.info && card.info.pinSet), noPinLeft: (card.noPin && card.noPin.left) || 0 });
      /* (a card of 1.23: what it holds in each currency, for its holder to be asked which pays from there, as at its own mint) */
      if (card.units && !card.viewUnit) otherMint.units = { usd: card.units.usd.balance, sat: card.units.sat.balance };
      // and the card as read, in memory only, for what its mint will charge on the pieces it would pay with (`cardCrossQuote`)
      try { Object.defineProperty(otherMint, 'cardRead', { value: card, enumerable: false }); } catch (eR) {}
      return otherMint;
    }
    if (cu === 'usd' && unitsOf(here, w).indexOf('usd') < 0) {
      return cardError('no-dollars-here', hostOf(here) + ' does not issue dollars now, so this card cannot be used here.', { cardUnit: 'usd' });
    }
    if (ask && unitOf(ask) !== cu) return cardWrongUnit(cu, unitOf(ask), card);
    // a bug guard: never a card's pieces to a wallet of another unit, which would set out a swap the mint refuses after the card has signed
    if (!before && recordUnit(w) !== cu) {
      return cardError('wrong-unit', 'This card holds ' + balanceWord(cu) + ', so it is paid with the ' + balanceWord(cu) + ' wallet.', { cardUnit: cu });
    }
    return null;
  }

  /* The pieces to take from a card for `want`: the fewest that cover it, over-
   * paying, so a tap signs one or two pieces and stays under three seconds. The
   * card signs most of a second a piece, so the lever that keeps a payment fast
   * is signing few: one piece larger than the price where the card holds one, or
   * the fewest that together cover it (`coverPieces`). The difference comes back
   * as change, made by the receiver and written onto the card at a second tap
   * (the SEND then RECEIVE of a card payment); where the fewest-covering set is
   * itself exact, no change is owed. Exactness is not chased at the cost of more
   * signatures: a six-piece exact set is slower than one piece and its change.
   *
   * Of the sets that small, the one taken is the least-overpaying that leaves
   * the card's drawer with no gap, counting the change as it will be cut
   * (`cardFewPick`, `cardWholeAfter`): a card that paid online with its middle
   * pieces was left unable to pay most prices exactly, and exactly is the only
   * way a till with no route can be paid.
   *
   * A card's day is charged the whole worth of each piece it signs, and not
   * the price, and change written back gives it nothing back. So the pieces
   * never come to more than `cap`, what is left of today's limit (null where
   * there is none to keep to: no limit, or the holder's own phone, which lifts
   * it to take money off). Where the fewest-covering set is over the cap, the
   * pieces that fit under it are searched for. Null when nothing fits. */
  /* The budget a tap has: a card signs about CARD_SIGN_SECONDS a piece, a read
   * is about CARD_READ_SECONDS, and a tap should stay under three seconds, so a
   * payment signs at most this many pieces. Two, on these timings. */
  var CARD_SIGN_SECONDS = 0.74;
  var CARD_READ_SECONDS = 1.2;
  function cardSignBudget() {
    return Math.max(1, Math.floor((3 - CARD_READ_SECONDS) / CARD_SIGN_SECONDS));
  }

  /* The least-overpaying set of no more than `most` pieces that covers `want`
   * and the receiver's fee on it, or null when no set that small does. Within
   * the time budget (`most` keeps the tap under three seconds) it over-pays as
   * little as it can, so that a 743 from 512 and 256 is two pieces and twenty-
   * five over, not one piece of 2048 and thirteen hundred over. Fewer pieces
   * breaks a tie. The card holds few pieces, so one- and two-piece sets are
   * searched in full. */
  /* `whole(picked, total, fee)`, where given, says whether the card would be
   * left with no gap in its drawer (`cardWholeAfter`): the least-overpaying set
   * that leaves none is taken before one that over-pays less and leaves one.
   * A 3,000 paid with the last 2048 and 1024 leaves a card of large pieces and
   * small change that can pay nothing in between exactly, which is every price
   * a till with no route can take; paid with a 4096, the change is cut to fill
   * the drawer and it can still pay anything. Where no set leaves it whole,
   * the least-overpaying set stands. */
  function cardFewPick(w, pool, want, most, whole, upper) {
    var list = (pool || []).filter(function (p) { return p && p.secret && satsOf(p.amount) > 0; });
    if (!list.length || !(want > 0)) return null;
    var up = list.slice().sort(function (a, b) { return satsOf(a.amount) - satsOf(b.amount); });
    /** @type {{ picked: any[], total: number, fee: number }[]} */
    var covering = [];
    var consider = function (picked) {
      var total = 0;
      picked.forEach(function (p) { total += satsOf(p.amount); });
      var fee = swapFeeFor(w, picked);
      if (!isFinite(fee) || total < want + fee) return;
      // `upper`: the most a set may come to (what the day and the tap leave), where there is one
      if (upper !== null && upper !== undefined && total > upper) return;
      covering.push({ picked: picked, total: total, fee: fee });
    };
    for (var i = 0; i < up.length; i++) consider([up[i]]);
    if (most >= 2) {
      for (var a = 0; a < up.length; a++) {
        for (var b = a + 1; b < up.length; b++) consider([up[a], up[b]]);
      }
    }
    if (!covering.length) return null;
    // least over-paid first, fewer pieces breaking a tie
    covering.sort(function (x, y) { return (x.total - y.total) || (x.picked.length - y.picked.length); });
    var found = covering[0];
    if (typeof whole === 'function') {
      // sets of the same worth and size leave the same card: one of each is asked about
      var asked = {};
      for (var k = 0; k < covering.length; k++) {
        var c = covering[k];
        var name = c.picked.map(function (p) { return satsOf(p.amount); }).sort().join('+');
        if (asked[name]) continue;
        asked[name] = true;
        if (whole(c.picked, c.total, c.fee)) { found = c; break; }
      }
    }
    // signed largest first, as every other pick here is
    return found.picked.slice().sort(function (x, y) { return satsOf(y.amount) - satsOf(x.amount); });
  }

  /* A question for `cardFewPick`: would this card have no gap in its drawer
   * after paying `want` with a set of its pieces? What it would hold is what
   * it holds now (`card` as read, and what this phone owes it; or `pool`, where
   * there is no card to ask), less the set, and the change the till would make
   * (`changeFor`), cut as the till cuts it (`cardChangeFor`). */
  function cardWholeAfter(w, card, pool, want) {
    var top = cardMaxPiece(w);
    var base = card ? cardHeldAmounts(card, null)
      : (pool || []).map(function (p) { return satsOf(p && p.amount); }).filter(function (a) { return a > 0; });
    return function (picked, total, fee) {
      var rest = base.slice();
      picked.forEach(function (p) {
        var at = rest.indexOf(satsOf(p.amount));
        if (at >= 0) rest.splice(at, 1);
      });
      var back = changeFor(w, total - fee - want);
      var room = card ? cardRoomFor(card, picked) : CARD_LOAD_PIECES;
      var after = back > 0 ? rest.concat(cardChangeFor(back, room, top, rest, cardIsDeep(card), cardDepthFor(card))) : rest;
      var sum = 0;
      after.forEach(function (a) { sum += a; });
      return cardReach(after) === sum;
    };
  }

  /* The fewest pieces that cover `want` and the fee on them, and of those
   * the set that over-pays least, within `bound`. How few is found the way a
   * cashier would, largest first; which of that many is searched, by size,
   * largest first, with a budget of steps (a card's pieces are powers of two,
   * a few of each, so the search is small), and where the budget runs out
   * the cashier's set stands. Null when nothing covers it. `whole`, where
   * given, is asked of a set as `cardFewPick` asks it: of that many pieces,
   * the least-overpaying set that leaves the card's drawer with no gap. */
  function cardFewestCover(w, pool, want, bound, whole) {
    var list = (pool || []).filter(function (p) { return p && p.secret && satsOf(p.amount) > 0; })
      .sort(function (a, b) { return satsOf(b.amount) - satsOf(a.amount); });
    if (!list.length || !(want > 0)) return null;
    var feeOf = function (set) { var f = swapFeeFor(w, set); return (isFinite(f) && f > 0) ? f : 0; };
    var covers = function (set, total) { return total >= want + feeOf(set) && (bound === null || total <= bound); };
    // how few: the largest first, until they cover it
    var k = 0, run = 0;
    while (k < list.length) {
      run += satsOf(list[k].amount);
      k += 1;
      if (run >= want + feeOf(list.slice(0, k))) break;
    }
    if (run < want + feeOf(list.slice(0, k))) return null;
    // which k: by size, largest first, least total kept
    var bySize = {};
    list.forEach(function (p) { var a = satsOf(p.amount); (bySize[a] = bySize[a] || []).push(p); });
    var sizes = Object.keys(bySize).map(Number).sort(function (a, b) { return b - a; });
    var best = covers(list.slice(0, k), run) ? { set: list.slice(0, k), total: run } : null;
    var steps = 0;
    var walk = function (i, left, total, chosen) {
      if (++steps > 50000) return;
      if (best && total >= best.total) return;
      if (left === 0) {
        if (covers(chosen, total)) best = { set: chosen.slice(), total: total };
        return;
      }
      if (i >= sizes.length) return;
      // the most the rest can come to with `left` more pieces: short of the price, nothing below covers it
      var most = total, room = left;
      for (var j = i; j < sizes.length && room > 0; j++) {
        var take = Math.min(room, bySize[sizes[j]].length);
        most += take * sizes[j];
        room -= take;
      }
      if (room > 0 || most < want) return;
      var size = sizes[i], have = bySize[size];
      for (var n = Math.min(left, have.length); n >= 0; n--) {
        walk(i + 1, left - n, total + n * size, chosen.concat(have.slice(0, n)));
      }
    };
    walk(0, k, 0, []);
    if (!best || typeof whole !== 'function') return best ? best.set : null;
    /* That many pieces, and the card left with no gap (`cardWholeAfter`): the
     * least-overpaying set of them that leaves none, looked for the same way,
     * with a budget of sets asked about. The least-overpaying of all stands
     * where it leaves none itself, or nothing that few does. */
    var least = /** @type {{ set: any[], total: number }} */ (best);
    if (whole(least.set, least.total, feeOf(least.set))) return least.set;
    /** @type {{ set: any[], total: number } | null} */
    var kept = null;
    var asked = 0;
    steps = 0;
    var look = function (i, left, total, chosen) {
      if (++steps > 50000 || asked > 300) return;
      if (kept && total >= kept.total) return;
      if (left === 0) {
        if (!covers(chosen, total)) return;
        asked += 1;
        if (whole(chosen, total, feeOf(chosen))) kept = { set: chosen.slice(), total: total };
        return;
      }
      if (i >= sizes.length) return;
      var most = total, room = left;
      for (var j = i; j < sizes.length && room > 0; j++) {
        var take = Math.min(room, bySize[sizes[j]].length);
        most += take * sizes[j];
        room -= take;
      }
      if (room > 0 || most < want) return;
      var size = sizes[i], have = bySize[size];
      // fewer of the largest first here: the sets that over-pay least are asked about first
      for (var n = 0; n <= Math.min(left, have.length); n++) {
        look(i + 1, left - n, total + n * size, chosen.concat(have.slice(0, n)));
      }
    };
    look(0, k, 0, []);
    var keeps = /** @type {{ set: any[], total: number } | null} */ (kept);
    return keeps ? keeps.set : least.set;
  }

  /* `card`: the card as read, where there is one, for what a set would leave
   * it holding. Under a day's limit (`cap`) the least-overpaying set stands:
   * the day is charged the whole worth of what is signed, and a larger piece
   * taken to keep the drawer whole would use up the day. */
  /* `tapCap`: what is left of this tap, on a card with a limit on one. No set
   * comes to more than it, or than `cap`; but unlike the day it is not used up
   * for later by a larger piece, so the drawer is still kept whole under it. */
  function cardPick(w, have, want, cap, card, tapCap) {
    var bound = (cap === null || cap === undefined) ? null : Math.max(0, Number(cap) || 0);
    var one = (tapCap === null || tapCap === undefined) ? null : Math.max(0, Number(tapCap) || 0);
    var upper = bound === null ? one : (one === null ? bound : Math.min(bound, one));
    var within = upper === null ? have : (have || []).filter(function (p) { return satsOf(p.amount) <= /** @type {number} */ (upper); });
    // the fewest signatures that cover the price (one or two pieces), over-paying; change comes back
    var whole = bound === null ? cardWholeAfter(w, card || null, have, want) : null;
    var few = cardFewPick(w, within, want, cardSignBudget(), whole, upper);
    if (few) return few;
    /* No two pieces cover it: still the fewest that do, since every piece is
     * most of a second of holding the card; then the least-overpay set of any
     * size, an exact set, and what fits under the cap. */
    var fewest = cardFewestCover(w, within, want, upper, whole);
    var cover = coverPieces(w, within, want);
    var covered = (cover && (upper === null || cover.total <= upper)) ? cover.picked : null;
    if (fewest && (!covered || fewest.length < covered.length)) return fewest;
    if (covered) return covered;
    var exact = cardExactPick(w, within, want, upper);
    if (exact) return exact;
    return upper === null ? null : cardPickUnder(w, within, want, upper);
  }

  /* The fewest pieces that come to exactly `want` and the receiver's fee on
   * them, or null when no set does.
   *
   * The fee depends on how many pieces there are, so each fee it could be is
   * tried in turn: a set is the answer for a fee of F when it sums to want + F
   * and the mint would charge exactly F for it. The search takes pieces of one
   * size together, largest first, and gives up after a fixed number of steps
   * for each fee (a card holds 128 pieces at most, in a few sizes, and the
   * first set it comes to is the one a cashier would make, which is the
   * fewest). A fee less than the mint charges for one piece is no set's, and
   * is not searched: with a deep drawer that search found nothing, slowly, and
   * left no steps for the fee that was right. No more than `bound` in all,
   * when there is one. */
  function cardExactPick(w, pool, want, bound) {
    var list = (pool || []).filter(function (p) { return p && p.secret && satsOf(p.amount) > 0; });
    if (!list.length || !(want > 0)) return null;
    // pieces of one size together, largest size first
    var bySize = {};
    list.forEach(function (p) { var a = satsOf(p.amount); (bySize[a] = bySize[a] || []).push(p); });
    var sizes = Object.keys(bySize).map(Number).sort(function (a, b) { return b - a; });
    var total = sumProofs(list);
    var feeMost = swapFeeFor(w, list);
    if (!isFinite(feeMost) || feeMost < 0) feeMost = 0;
    // what is left in the sizes from i on, to stop where the rest cannot make up the sum
    var left = sizes.map(function (a, i) {
      var n = 0;
      for (var j = i; j < sizes.length; j++) n += sizes[j] * bySize[sizes[j]].length;
      return n;
    });
    // the least a set can be charged: one piece, of whichever keyset charges least
    var feeLeast = Infinity, asked = {};
    list.forEach(function (p) {
      if (asked[p.id]) return;
      asked[p.id] = true;
      var f = swapFeeFor(w, [p]);
      if (isFinite(f) && f >= 0 && f < feeLeast) feeLeast = f;
    });
    if (!isFinite(feeLeast)) feeLeast = 0;
    /** @type {?any[]} */
    var best = null;
    var steps = 0;
    for (var fee = Math.min(feeLeast, feeMost); fee <= feeMost; fee++) {
      var target = want + fee;
      if (target > total || (bound !== null && bound !== undefined && target > bound)) break;
      var picked = [];
      steps = 0;
      var walk = function (i, rem) {
        if (steps++ > 30000) return;
        if (rem === 0) {
          if (picked.length && (!best || picked.length < best.length) && swapFeeFor(w, picked) === fee) best = picked.slice();
          return;
        }
        if (i >= sizes.length || left[i] < rem) return;
        // more pieces cannot beat a set already found with this many
        if (best && picked.length + 1 >= best.length) return;
        var a = sizes[i], group = bySize[a];
        for (var c = Math.min(group.length, Math.floor(rem / a)); c >= 0; c--) {
          for (var k = 0; k < c; k++) picked.push(group[k]);
          walk(i + 1, rem - c * a);
          for (var k2 = 0; k2 < c; k2++) picked.pop();
        }
      };
      walk(0, target);
    }
    return best;
  }

  /* The cheapest set of pieces that pays `want` and the receiver's fee and is
   * worth no more than `cap`: a search by size, largest first, that gives up
   * after a fixed number of steps. Of each size it first takes as many as go
   * into what is still to pay (what a cashier would), then one more (which
   * covers it), and only then fewer: with pieces that are powers of two the
   * least there is to pay is among the first two, so a card of 128 pieces in
   * a dozen sizes is answered at once. Fewer pieces breaks a tie. */
  function cardPickUnder(w, pool, want, cap) {
    var list = (pool || []).filter(function (p) { return p && p.secret && satsOf(p.amount) > 0; });
    if (!list.length || !(want > 0)) return null;
    var bySize = {};
    list.forEach(function (p) { var a = satsOf(p.amount); (bySize[a] = bySize[a] || []).push(p); });
    var sizes = Object.keys(bySize).map(Number).sort(function (a, b) { return b - a; });
    // what the sizes from i on come to, to stop where the rest cannot reach the price
    var left = sizes.map(function (a, i) {
      var n = 0;
      for (var j = i; j < sizes.length; j++) n += sizes[j] * bySize[sizes[j]].length;
      return n;
    });
    /** @type {?{ picked: any[], sum: number }} */
    var best = null;
    var steps = 0;
    var picked = [];
    var walk = function (i, sum) {
      if (steps++ > 40000 || sum > cap) return;
      if (picked.length) {
        var fee = swapFeeFor(w, picked);
        if (isFinite(fee) && sum >= want + fee) {
          // more pieces only add to it
          if (!best || sum < best.sum || (sum === best.sum && picked.length < best.picked.length)) best = { picked: picked.slice(), sum: sum };
          return;
        }
      }
      if (i >= sizes.length || (best && sum >= best.sum) || sum + left[i] < want) return;
      var a = sizes[i], group = bySize[a];
      var fit = Math.min(group.length, Math.max(0, Math.floor((want - sum) / a)));
      var order = [fit];
      for (var more = fit + 1; more <= Math.min(group.length, fit + 2); more++) order.push(more);
      for (var fewer = fit - 1; fewer >= 0; fewer--) order.push(fewer);
      order.forEach(function (c) {
        for (var k = 0; k < c; k++) picked.push(group[k]);
        walk(i + 1, sum + c * a);
        for (var k2 = 0; k2 < c; k2++) picked.pop();
      });
    };
    walk(0, 0);
    var found = /** @type {any} */ (best);
    return found ? found.picked : null;
  }

  /* What every signing is done under: the card's PIN, verified first, and for
   * the holder's own phone the limits lifted (`lift`), with `work` done between
   * and the limits put back after, whether it went well or not.
   *
   * A card that signs for each piece (`cardSign`) answers the pieces with
   * their witnesses; if it leaves part-way, the ones it did sign are on the
   * error as `signed`: the card has marked them spent, so they are not to be
   * dropped. A card that signs once for a payment is `cardSignAll`.
   *
   * `lift`: the holder's own phone is taking money off a card that has a daily
   * limit. After the PIN, and before the first piece is asked for, the limit is
   * lifted with the owner's proof; and it is put back at the end, whether the
   * signing went well or not. The old limit is written down first, so a tap that
   * ends between the two is finished by the next one (`cardLook`, `mine`). */
  function cardUnderPin(t, card, pinHex, lift, work) {
    var lifted = false;
    // a card that has the limit on one tap is given both numbers in the one command
    var tapWas = card.info && card.info.tapKnown ? (Number(card.info.tapLimit) || 0) : undefined;
    var dayWas = Number(card.info && card.info.limit) || 0;
    var back = function () {
      if (!lifted) return Promise.resolve();
      // (1.23: the sixteen bytes, the allowance and the rate as the card has them)
      return (cardIs123(card) ? cardLimit23(t, card, { day: dayWas, tap: tapWas || 0 }) : cardLimitTo(t, card.key, card.record.limit, tapWas)).then(function () {
        lifted = false;
        cardLiftNote(card.key, 0);
      }, function () { /* the note stays, and the next tap of this phone puts it back */ });
    };
    return cardVerify(t, card, pinHex).then(function () {
      if (!lift) return null;
      cardLiftNote(card.key, card.record.limit, tapWas);
      return (cardIs123(card) ? cardLimit23(t, card, { day: 0, tap: 0 }) : cardLimitTo(t, card.key, 0, tapWas === undefined ? undefined : 0)).then(function () { lifted = true; }, function (e) {
        if (e && e.card === 'not-owner') cardLiftNote(card.key, 0);
        throw e;
      });
    }).then(work).then(function (r) { return back().then(function () { return r; }); },
                       function (e) { return back().then(function () { throw e; }); });
  }

  /* A card that signs for each piece (format 3): each in turn, under the PIN. */
  function cardSign(t, card, picked, pinHex, lift, progress) {
    var signed = [];
    return cardUnderPin(t, card, pinHex, lift, function () {
      var walk = Promise.resolve();
      picked.forEach(function (proof) {
        walk = walk.then(function () {
          // said before the card is asked, so the line is up for the whole of its work on this piece
          try { if (typeof progress === 'function') progress({ step: 'signing', i: signed.length + 1, n: picked.length }); } catch (e) {}
          return t.want(cardCommand(CARD_INS.spend, proof.slot, '', 64), 'to sign for a piece').then(function (sig) {
            var one = { id: proof.id, amount: proof.amount, secret: proof.secret, C: proof.C,
                        witness: JSON.stringify({ signatures: [sig] }) };
            var good = false;
            try { good = window.CashuTS.isP2PKSpendAuthorised(one) === true; } catch (e) { good = false; }
            if (!good) throw cardError('bad-signature', 'The card’s signature for a piece was not good. Nothing more was asked of it.');
            signed.push(one);
          });
        });
      });
      return walk.then(function () { return signed; });
    }).then(null, function (e) {
      try { e.signed = signed; } catch (x) {}
      throw e;
    });
  }

  /* ---- one signature for a payment (a card of format 4, NUT-11 SIG_ALL) --------
   *
   * A card of format 3 signs for each piece, most of a second apiece, and a
   * piece's signature is good for any swap: whoever holds it decides where the
   * money goes. A card of format 4 signs ONCE, over every piece of the payment
   * and every output those pieces are swapped for:
   *
   *     secret_0 C_0 ... secret_n C_n   amount_0 B_0 ... amount_m B_m
   *
   * as text, each C and B_ in hex and each amount in decimal, hashed with
   * SHA-256 (NUT-11 as CDK and Nutshell both check it; the card's spec, section
   * "SPEND_ALL"). So the swap has to exist before the card is asked: its
   * outputs are made first (`cardSwapPlan`), the card is told the places and
   * the outputs and signs (`cardSignGroup`), and the mint is then sent exactly
   * that swap and no other (`cardSwapFixed`). The signature is the first
   * piece's witness; the others carry none.
   *
   * What it changes for the rest of this file:
   *
   *   one date   a mint takes one signature only for pieces whose secrets
   *              agree in everything but the nonce, so a signature is for
   *              pieces of one date (`cardDateGroups`). A card is topped up
   *              with the date it already has while that is far enough off
   *              (`cardDateFor`), so it is mostly of one date;
   *   exactly    signing costs the same for one piece as for thirty-two, so a
   *              payment is made of pieces that come to exactly the price
   *              where the card holds them (`cardPickAll`): no change, and no
   *              second tap to take it back;
   *   all or nothing   the card burns every piece as it signs, in one
   *              transaction. A card that leaves before its answer arrives has
   *              signed or it has not, and its next tap here says which: the
   *              pieces are still on it, or it is asked for the signature
   *              again (`cardAskedBack`), which it keeps until it gives another.
   *
   * CARD_SWAPS is what makes the second and third of those safe: for every
   * signature asked for, the outputs it is over, by the counter they were made
   * at. A row is written before the card is asked and is the only thing that
   * can make the same outputs again; without it the signed pieces could not be
   * swapped by anybody. `asked` is on a row from then until the signature is
   * in hand: the pieces, and what the payment was for. */
  /* The most outputs a card payment's swap is set out with. Every output is
   * 37 bytes sent to the card and hashed by it, six to a command, while the
   * card is held: shaped to fill this phone's whole pool, a swap had fifty of
   * them and nine commands. Twelve is two commands, and what the pool still
   * lacks is made up by the next swap it does anyway. */
  var CARD_OUTPUTS_MOST = 12;
  var CARD_SWAPS = 'foxy.flashcard.swaps';
  /* The pieces one signature may be for. The card burns every piece of a
   * payment in one transaction, and the chip's transaction holds few: on the
   * card itself eleven pieces were signed for and thirty-two were refused
   * (`6A96`, nothing burned), which no simulator shows, since a simulator's
   * transaction has no size. Eight leaves room for what else the transaction
   * writes (a day's limit, the log). A card that says it burns any number
   * (`info.many`) is asked for as many as it has. */
  var CARD_ALL_MOST = 8;
  var CARD_ALL_WIDE = 128;
  // and what such a card is asked for where a set that few pays
  var CARD_ALL_EASY = 32;
  // a swap signed with this phone's own key (a card taken back): no card's bound, only how many pieces a swap is asked to take
  var CARD_SWAP_MOST = 32;
  // a top-up keeps the card's date while it is this far off, and takes a new one after: the line the owner's refresh renews at
  // (CARD_DATE_REUSE became cardDateReuse())

  function cardSwapRow(id) {
    return cardStore(CARD_SWAPS).filter(function (r) { return r && r.id === id; })[0] || null;
  }
  function cardSwapDrop(id) {
    var all = cardStore(CARD_SWAPS);
    var left = all.filter(function (r) { return !(r && r.id === id); });
    if (left.length !== all.length) save(CARD_SWAPS, left);
  }
  /* The signature is in hand (or was never given): the row is the outputs and nothing else. */
  function cardSwapSettled(id) {
    mustSave(CARD_SWAPS, cardStore(CARD_SWAPS).map(function (r) {
      if (!r || r.id !== id || !r.asked) return r;
      var plain = {};
      Object.keys(r).forEach(function (k) { if (k !== 'asked') plain[k] = r[k]; });
      return plain;
    }));
  }

  /* The outputs these pieces were signed for, or null where they are not a
   * one-signature card's (asked by every swap of a token: `receiveToken`). */
  function cardSwapFor(list) {
    var first = Array.isArray(list) && list.length ? cardSecretParts(list[0].secret) : null;
    if (!first || !first.all) return null;
    return cardSwapRow(piecesFingerprint(list));
  }

  function cardAllMessage(inputs, outputs) {
    return inputs.map(function (p) { return String(p.secret) + String(p.C).toLowerCase(); }).join('')
      + outputs.map(function (o) { return String(o.amount) + String(o.B_).toLowerCase(); }).join('');
  }
  function cardAllDigest(inputs, outputs) {
    var text = cardAllMessage(inputs, outputs);
    var bytes = [];
    // a secret is JSON of hex and digits and a C is hex: one byte a character
    for (var i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 255);
    return hexOf(sha256(bytes));
  }
  function cardOutsOf(outputData) {
    return (outputData || []).map(function (o) {
      return { amount: satsOf(o.blindedMessage.amount), B_: String(o.blindedMessage.B_).toLowerCase() };
    });
  }
  function cardNotSent(message) {
    var e = /** @type {any} */ (new Error(message));
    e.noCounters = true;       // the mint was asked nothing (`neverSent`)
    return e;
  }

  /* The powers of two an amount is, largest first, none above `top` (the mint's
   * largest key, where it is known). */
  function cardBinary(n, top) {
    var out = [], d = 1, cap = top > 0 ? top : 1e15;
    while (d * 2 <= n && d * 2 <= cap) d *= 2;
    for (var rest = Math.max(0, Math.floor(Number(n) || 0)); d >= 1; d /= 2) {
      while (rest >= d) { out.push(d); rest -= d; }
    }
    return out;
  }

  /* The swap a set of a card's pieces will be spent in, made before the card
   * is asked to sign: the outputs (from this wallet's seed, at counters taken
   * now and never handed out again), in the order the mint will be sent them,
   * and the pieces in the order a token keeps them. Nothing is asked of the
   * mint, so this is made with no route too.
   *
   * `opts.want` and `opts.split`: the card makes its own change (software
   * 1.12, `cardOwnChangeCut`). The outputs of this phone's are then for the
   * price alone (and what the card cannot make change of), and the card's are
   * named after them: `opts.split(back, net)` answers the amounts of the
   * outputs the card is to make, for the `back` the pieces come to over the
   * price. They are in the plan as `change`, with no blinded message until the
   * card has made them. Counters are taken for them too, with the rest (the
   * library makes the outputs of one amount together), and the card's are left
   * unused: the plan's counters are the first of them, and this phone's own. */
  function cardSwapPlan(w, pieces, opts) {
    var CT = window.CashuTS;
    var o = opts || {};
    var bare = pieces.map(function (p) { return { id: p.id, amount: p.amount, secret: p.secret, C: p.C }; });
    var fee = swapFeeFor(w, bare);
    if (!isFinite(fee) || fee < 0) fee = 0;
    var net = sumProofs(bare) - fee;
    if (!(net > 0)) return Promise.reject(cardError('not-enough', 'Those pieces are worth less than the mint charges to take them.'));
    // the card's own change: named by the amounts of its outputs, which the pieces come to over the price
    var change = [];
    if (typeof o.split === 'function' && o.want > 0 && net > o.want) {
      change = (o.split(net - o.want, net) || []).map(function (a) { return Math.round(Number(a)); }).filter(function (a) { return a > 0; });
    }
    var cc = change.reduce(function (n, a) { return n + a; }, 0);
    // what this phone's own outputs come to: the rest, with the part of the change the card is not asked to make
    var own = net - cc;
    if (change.length && !(own > 0)) return Promise.reject(cardNotSent('Foxy could not set out the swap for this payment, so the card was not asked to sign.'));
    var ranges = [];
    var saw = function (r) {
      if (!r || !r.keysetId || !(Number(r.count) > 0)) return;
      var same = ranges.some(function (x) { return x.keysetId === String(r.keysetId) && x.start === (Number(r.start) || 0); });
      if (!same) ranges.push({ keysetId: String(r.keysetId), start: Number(r.start) || 0, count: Number(r.count) });
    };
    var off = watchReserved(w, saw);
    // in the wallet's own unit, which is the card's (`cardWalletFor`): a dollar card's swap is set out on the dollar wallet
    var unit = recordUnit(w);
    return Promise.resolve().then(function () {
      // a token gathers the pieces of one keyset together: read back from one, they are in the order the swap will have them
      var token = encodeToken(mintOf(w), bare, unit);
      // shaped as any receipt is, to fill this phone's own pile (`receiveToken`)
      /* As many of the pool's missing pieces as leave the whole swap at
       * CARD_OUTPUTS_MOST outputs or fewer, counting the powers of two the
       * library adds for the rest; none, where even a few are too many. */
      var pile = proofs(mintOf(w), unit), shape = [];
      var ones = function (n) { var c = 0; while (n > 0) { c += n % 2; n = Math.floor(n / 2); } return c; };
      /* A card paying out of this phone (SEND from the card's screen, `o.exact`): the pieces that come in are about to be
       * melted, every one of the price and none more, so they are cut as the price in powers of two and the rest after it.
       * Then the price is always an exact set of them, and what is over stays in this phone for the card's change. */
      /* Only where the mint takes that many outputs in one request: a swap it refuses after the card has signed for it can
       * be made with no other outputs, and the pieces would be lost. Otherwise cut as ever, and the payment holds all of
       * what comes in (`cardOutHold`), the melt giving back what it does not use. */
      var top = cardMaxPiece(w);
      var exact = (o.exact && o.want > 0 && own >= o.want) ? cardBinary(o.want, top).concat(cardBinary(own - o.want, top)) : [];
      if (exact.length && exact.length + change.length <= mintArrayCap(w)) {
        return w.prepareSwapToReceive(token, { onCountersReserved: saw }, { type: 'deterministic', counter: 0, denominations: exact.concat(change) });
      }
      [CARD_OUTPUTS_MOST, 8, 4, 0].some(function (most) {
        shape = most ? shapeOutputs(pile, own, Math.min(mintArrayCap(w) - 16, most)) : [];
        var sum = shape.reduce(function (a, b) { return a + (Number(b) || 0); }, 0);
        return shape.length + ones(Math.max(0, own - sum)) <= CARD_OUTPUTS_MOST;
      });
      if (!change.length) {
        return w.prepareSwapToReceive(token, { onCountersReserved: saw }, shape.length ? { type: 'deterministic', counter: 0, denominations: shape } : { type: 'deterministic', counter: 0 });
      }
      // said whole, for the library to keep in this order: the shape, the rest of this phone's own as powers of two, and the card's after them
      var sum2 = shape.reduce(function (a, b) { return a + (Number(b) || 0); }, 0);
      var every = shape.concat(cardBinary(own - sum2, cardMaxPiece(w))).concat(change);
      return w.prepareSwapToReceive(token, { onCountersReserved: saw }, { type: 'deterministic', counter: 0, denominations: every });
    }).then(function (pre) {
      off();
      var all = cardOutsOf(pre.keepOutputs);
      var outs = all.slice(0, all.length - change.length);
      var inputs = pre.inputs.map(function (p) { return { id: String(p.id), amount: satsOf(p.amount), secret: String(p.secret), C: String(p.C) }; });
      var range = ranges[0];
      if (ranges.length !== 1 || range.count !== all.length || range.keysetId !== String(pre.keysetId) || inputs.length !== bare.length) {
        throw cardNotSent('Foxy could not set out the swap for this payment, so the card was not asked to sign.');
      }
      // the card's outputs are the last of them, of the sizes asked for, and this phone's own come to the rest
      if (change.length && (all.slice(outs.length).map(function (x) { return x.amount; }).join(',') !== change.join(',')
          || outs.reduce(function (n, x) { return n + x.amount; }, 0) !== own || !outs.length)) {
        throw cardNotSent('Foxy could not set out the swap for this payment, so the card was not asked to sign.');
      }
      var plan = { id: piecesFingerprint(inputs), keyset: range.keysetId, counter: range.start, unit: unit,
                   amounts: outs.map(function (x) { return x.amount; }), outputs: outs, inputs: inputs,
                   sum: sumProofs(inputs), net: net, own: own, cardChange: cc, change: change.map(function (a) { return { amount: a, B_: '' }; }),
                   // what leaves the card for good: the pieces less the change it makes for itself (the price, what is made up here, and the mint's fee)
                   leaves: sumProofs(inputs) - cc };
      cardSealPlan(plan);
      return plan;
    }, function (e) { off(); throw e; });
  }

  /* The message the card signs and its digest, over the pieces and then every
   * output of the swap in the order the mint will be sent them: this phone's own,
   * and the card's after them, once the card has made them. */
  function cardSealPlan(plan) {
    var every = plan.outputs.concat((plan.change || []).filter(function (c) { return c.B_; }));
    plan.message = cardAllMessage(plan.inputs, every);
    plan.digest = cardAllDigest(plan.inputs, every);
  }

  /* The row of a swap, which is what the pieces are swapped by: written down before the card is asked to sign
   * (`cardSwapWrite`), and made whole as the card answers for its change (`cardSwapAmend`). */
  function cardSwapRowOf(plan, asked) {
    var row = /** @type {any} */ ({ id: plan.id, keyset: plan.keyset, counter: plan.counter, amounts: plan.amounts, digest: plan.digest, at: Date.now() });
    // for reading only: the keyset names the unit, and a swap is set out from that alone
    if (plan.unit) row.unit = plan.unit;
    if (asked) row.asked = asked;
    /* The card's own change, which the mint will sign blind: its sizes at first, and then
     * the blinded message the card made for each. `card`, `forHash` and `date` are what the row the card
     * is owed will need once the mint has signed (`cardBlindRow`). */
    if (plan.change && plan.change.length) {
      var info = plan.changeInfo || {};
      row.change = { card: info.card || '', forHash: info.forHash || '', date: Number(info.date) || 0, mint: info.mint || '',
                     outs: plan.change.map(function (c) { return { amount: c.amount, B_: c.B_ }; }) };
    }
    return row;
  }

  function cardSwapWrite(plan, asked) {
    var row = cardSwapRowOf(plan, asked);
    // rows nothing has come back for in longer than any card's date is off are let fall
    var old = Date.now() - (cardDateAhead() + 35 * 24 * 3600) * 1000;
    // never sent on a write that did not land: the card is not asked for a signature nothing could use
    mustSave(CARD_SWAPS, cardStore(CARD_SWAPS).filter(function (r) { return r && r.id !== plan.id && !(Number(r.at) < old); }).concat([row]), true);
  }

  /* The card's change, answered, goes into its swap's row before the card is
   * asked for anything else (`cardSignGroup`): a signature must never exist
   * without the row having every output it is over. */
  function cardSwapAmend(plan) {
    var now = cardSwapRowOf(plan, null);
    mustSave(CARD_SWAPS, cardStore(CARD_SWAPS).map(function (r) {
      if (!r || r.id !== plan.id) return r;
      var amended = Object.assign({}, r, { digest: now.digest });
      if (now.change) amended.change = now.change;
      return amended;
    }), true);
  }

  /* The same outputs again, from the counter they were made at. The phone
   * gives a counter's secret once to be used and any number of times to be
   * restored, and this is a restore: the counters do not move. */
  function cardOutputsAt(w, spec) {
    var amounts = (spec.amounts || []).map(function (a) { return Math.round(Number(a)); });
    var total = amounts.reduce(function (n, a) { return n + a; }, 0);
    var ready = (w && w.foxyNativeSecrets)
      ? fetchSecrets(spec.keyset, Number(spec.counter), amounts.length, w.foxyCandidate || null)
      : Promise.resolve();
    return ready.then(function () {
      return w.createOutputData(total, w.getOutputKeyset(spec.keyset), { type: 'deterministic', counter: Number(spec.counter), denominations: amounts });
    });
  }

  /* The card's outputs in a swap, as the library wants them: output data. It
   * has the blinded message; it does not have, and this phone never will, the
   * secret and the blinding factor (they are the card's), so it is given ones that
   * stand in: enough for the library to put the blinded message in the request and
   * to check the mint's signature on it, which is a DLEQ over that blinded message
   * and the signature and needs neither. What it makes of the signature from the
   * stand-ins is nothing anybody keeps. The signature as the mint gave it is
   * kept (`caught`, by blinded message): it is what the card's piece is made of. */
  function cardStandIns(spec, caught, marks) {
    var CT = window.CashuTS;
    return (spec.change.outs || []).map(function (o) {
      var out = new CT.OutputData({ amount: CT.Amount.from(o.amount), B_: o.B_, id: spec.keyset }, BigInt(1), new window.Uint8Array(1));
      var real = out.toProof;
      out.toProof = function (sig, keyset) {
        // the library's own checks first: the signature's keyset, and its DLEQ
        var made = real.call(out, sig, keyset);
        caught[String(o.B_).toLowerCase()] = cardSigOf(sig);
        marks.push(made);
        return made;
      };
      return out;
    });
  }

  /* The swap of pieces a card has signed for, with the outputs it signed for
   * and no others. What is about to be sent is hashed again and held to the
   * row first: a swap the signature is not over would only be refused, and
   * one that cannot be set out as it was is not sent at all.
   *
   * The card's own change (software 1.12) is in it, as outputs this phone can
   * name and not make (`cardStandIns`). What comes back is this phone's own
   * proofs, as ever; the mint's signatures on the card's outputs are written down
   * as the row the card is owed, before this returns (`cardBlindRow`).
   *
   * `superseded()`: the swap was found at the mint while this request was still out, and finished from there (`swapGuard`).
   * An answer that comes after that writes nothing: the card's change is had from the mint by the payment's entry
   * (`cardChangeOwe`), and a row written now could be owed to the card a second time, long after the first was written back. */
  function cardSwapFixed(w, text, spec, superseded) {
    var caught = {}, marks = [];
    return cardOutputsAt(w, spec).then(function (outputs) {
      var stands = spec.change && Array.isArray(spec.change.outs) && spec.change.outs.length ? cardStandIns(spec, caught, marks) : [];
      return w.prepareSwapToReceive(text, { keysetId: spec.keyset }, { type: 'custom', data: outputs.concat(stands) });
    }).then(function (pre) {
      if (cardAllDigest(pre.inputs, cardOutsOf(pre.keepOutputs)) !== spec.digest) {
        throw cardNotSent('This payment’s swap could not be set out as the card signed for it, so it was not sent.');
      }
      return pre;
    }, function (e) {
      // not set out at all (the mint's fee or its keys have changed since): nothing was asked of it
      try { e.noCounters = true; } catch (x) {}
      throw e;
    }).then(function (pre) {
      return w.completeSwap(pre);
    }).then(function (done) {
      var mine = ((done && done.keep) || []).filter(function (p) { return marks.indexOf(p) < 0; });
      if (!marks.length || (superseded && superseded())) return mine;
      // owed to the card before anything else is done with the answer
      var row = cardBlindRow(spec, caught, w);
      if (!row) throw cardError('refused', 'The mint did not sign all of the card’s change.', { id: spec.id });
      var rid = row.id;
      mustSave(CARD_OWED, cardStore(CARD_OWED).filter(function (r) { return !(r && r.id === rid); }).concat([row]));
      return mine;
    });
  }

  /* A card's pieces by their date, earliest first (the undated together). */
  function cardDateGroups(pieces) {
    var by = {}, dates = [];
    (pieces || []).forEach(function (p) {
      var d = Number(p && p.date) || 0;
      if (!by[d]) { by[d] = []; dates.push(d); }
      by[d].push(p);
    });
    return dates.sort(function (a, b) { return a - b; }).map(function (d) { return by[d]; });
  }

  /* What a set of pieces is signed for in: one signature for the pieces of one
   * date, CARD_ALL_MOST at the most (taking a whole card off is the only thing
   * that needs more than one). */
  function cardAllGroups(pieces, many) {
    var out = [], size = Math.max(1, Number(many) || CARD_ALL_MOST);
    cardDateGroups(pieces).forEach(function (g) {
      if (g.length <= size) { out.push(g); return; }
      /* More than one signature takes: dealt out by size, largest first, a
       * piece to each signature in turn, so that each has its share of the
       * money. Cut in the order they lay, a deep drawer's small pieces made
       * a signature's worth that came to no more than the mint's fee on
       * them, and the taking stopped there with the rest still on the card. */
      var n = Math.ceil(g.length / size), parts = [];
      for (var k = 0; k < n; k++) parts.push([]);
      g.slice().sort(function (a, b) { return satsOf(b.amount) - satsOf(a.amount); }).forEach(function (p, i) { parts[i % n].push(p); });
      parts.forEach(function (part) { out.push(part); });
    });
    return out;
  }

  /* The pieces a one-signature card pays `want` with: of one date, and
   * exactly the price (and the fee on them) where a date's pieces make it;
   * otherwise the set `cardPick` would take from one date, over-paying, with
   * change to come back. The earliest date that can pay is the one that does,
   * so the oldest money goes first. With no route (`exactOnly`) only exactly. */
  function cardPickAll(w, have, want, cap, card, tapCap, exactOnly, least) {
    var bound = (cap === null || cap === undefined) ? null : Math.max(0, Number(cap) || 0);
    var one = (tapCap === null || tapCap === undefined) ? null : Math.max(0, Number(tapCap) || 0);
    var upper = bound === null ? one : (one === null ? bound : Math.min(bound, one));
    var groups = cardDateGroups(have);
    var pass = function (many) {
      var i;
      for (i = 0; i < groups.length; i++) {
        var exact = /** @type {any} */ (cardExactPick(w, groups[i], want, upper));
        if (exact && exact.length && exact.length <= many) return exact;
      }
      if (exactOnly) return null;
      /* `least`: a card that waits. Before 1.12 it waits by what its pieces come
       * to (`cardWaitSignsBefore`), so the set that overpays the least is the
       * quickest, whatever its size. From 1.12 by what leaves it (`cardWaitSigns`),
       * which the pieces do not change, and a payment with no change is the
       * quickest of all: an exact set was taken above, and where there is none the
       * same sets are taken, for the change they bring back. A card of 1.13 makes
       * that change in four pieces at the most, cut plainly, so among the sets that
       * overpay least one whose change is that few is taken (`cardPlainPick`). */
      if (least) {
        var most = upper === null ? 281474976710655 : upper;
        var tidy = cardIsShaped(card);
        for (i = 0; i < groups.length; i++) {
          var cheap = cardPickUnder(w, groups[i], want, most);
          if (cheap && cheap.length && cheap.length <= many) {
            return tidy ? cardPlainPick(w, groups[i], want, most, card, cheap, many) : cardRefillPick(w, groups[i], want, most, card, cheap, many);
          }
        }
        /* The cheapest set is more pieces than one signature takes (a deep
         * drawer's small pieces, by the dozen): then the fewest pieces that
         * cover the price, and of those the cheapest. Not the set that keeps
         * the drawer whole, below: on a card that waits by what its pieces
         * come to, that one may be its largest piece, and a wait longer than
         * anybody holds a card. */
        for (i = 0; i < groups.length; i++) {
          var few = cardFewestCover(w, groups[i], want, upper, null);
          if (few && few.length && few.length <= many) {
            return tidy ? cardPlainPick(w, groups[i], want, most, card, few, many) : cardRefillPick(w, groups[i], want, most, card, few, many);
          }
        }
      }
      for (i = 0; i < groups.length; i++) {
        var cover = cardPick(w, groups[i], want, cap, card, tapCap);
        if (cover && cover.length && cover.length <= many) return cover;
      }
      return null;
    };
    /* A card that burns a dozen pieces at once and no more is asked for
     * CARD_ALL_MOST or fewer: with a larger piece and change, if need be. A
     * card that burns any number (`info.many`) is asked for thirty-two or
     * fewer wherever such a set pays (every piece is a little time in the
     * card's hands), and for more only where nothing that few does: a deep
     * drawer holds its money in small pieces, and a payment of most of it
     * is many. */
    var any = !!(card && card.info && card.info.many);
    var picked = pass(any ? CARD_ALL_EASY : CARD_ALL_MOST);
    if (!picked && any) picked = pass(CARD_ALL_WIDE);
    return picked;
  }

  /* The change a set of pieces brings back for `want`: what they come to, less the mint's fee on them and the price. */
  function cardOverOf(w, set, want) {
    var fee = swapFeeFor(w, set);
    return sumProofs(set) - ((isFinite(fee) && fee > 0) ? fee : 0) - want;
  }

  /* The set of this `pool` that brings back the least change from `from` to `to`
   * (sats) that the card makes whole in `room` pieces at the most, cut plainly
   * (`cardPlainPieces`), or null where none does. Each change is asked of
   * `cardExactPick` as a price that much higher, which finds the fewest pieces that
   * come to it and the fee on them exactly. Not more than CARD_TIDY_TRIES changes
   * are asked about. */
  var CARD_TIDY_TRIES = 48;
  // and how much more than the least a set may overpay for it to bring back change that few pieces make (an eighth of the price, and this much at the least)
  var CARD_TIDY_MIN = 64;
  function cardTidySet(w, pool, want, from, to, bound, many, room, top) {
    var tried = 0;
    for (var c = Math.max(1, Math.floor(from)); c <= to && tried < CARD_TIDY_TRIES; c++) {
      if (cardPlainPieces(c, top) > room) continue;
      tried += 1;
      var set = /** @type {any} */ (cardExactPick(w, pool, want + c, bound));
      if (set && set.length && set.length <= many) return set;
    }
    return null;
  }

  /* The set a card of software 1.13 is paid with when no set comes to the price
   * exactly. Its change is made by the card, in four pieces at the most, cut
   * plainly (`cardOwnChangeCut`); what is more than that is made here, after the
   * swap, and written at the change tap: a second swap at the mint, and a part of
   * the change that leaves the card with the price as far as its day and its wait
   * are concerned. So among the sets that overpay least the one is taken whose
   * change is that few pieces, and only where no set that overpays a little more
   * is (an eighth of the price, at the least CARD_TIDY_MIN sats, and not past
   * CARD_REFILL_MOST) does the least of all stand, and the tail of its change take
   * the road after the swap.
   *
   * A deep drawer's refill (`cardRefillPick`) is not done for such a card: it
   * overpaid by CARD_REFILL or more so that the change, cut to the gaps in the
   * drawer, stocked its small sizes again. A plain cut stocks whatever sizes the
   * change happens to be made of, so the refill only made every payment's change
   * a few hundred sats; stocking the drawer is a top-up's job (`cardAdd`). */
  function cardPlainPick(w, pool, want, most, card, cheap, many) {
    var top = cardMaxPiece(w);
    var room = cardChangeRoom(w, card, cheap);
    var least = cardOverOf(w, cheap, want);
    if (cardPlainPieces(least, top) <= room) return cheap;
    var slack = Math.min(CARD_REFILL_MOST, Math.max(CARD_TIDY_MIN, Math.floor(want / 8)));
    return cardTidySet(w, pool, want, least + 1, least + slack, most, many, room, top) || cheap;
  }

  /* Change worth going back for, on a card with a deep drawer.
   *
   * A payment that no set of pieces makes exactly is one the drawer has run
   * short for: some small size is used up. Paid with the set that overpays
   * least, it brings back a sat or two, which is one piece; and the payment
   * after it is short again. Every one of those is a second tap, and the
   * wait for the mint before it.
   *
   * So where the least there is to overpay is less than CARD_REFILL, the set
   * taken is one that overpays by that much (and by no more than
   * CARD_REFILL_MOST), in as few pieces as do it: its change is cut to fill
   * the drawer's small sizes (`cardChangeCut`), and the next several payments
   * are exact again. A second tap every several payments, where it was every
   * other one.
   *
   * It does not make money: what comes back is what the larger piece was
   * worth over the price, and a card whose small pieces are spent pays from
   * its large ones, with change, about as often as it did before. A top-up
   * is what fills a drawer.
   *
   * The larger set may be one a card before 1.12 would make the payer wait for,
   * over a limit a till is not told. The card says so before it has signed
   * anything (`cardSignGroup`), and the payment is then made with the cheapest set
   * after all: that one is kept on the set as its `fallback`. A card of 1.12
   * waits by what leaves it, which is the same for both sets, and the cheapest
   * makes change too: it has no fallback (`cardTake`). */
  var CARD_REFILL = 256;
  var CARD_REFILL_MOST = 1024;
  function cardRefillPick(w, pool, want, most, card, cheap, many) {
    if (!cardIsDeep(card)) return cheap;
    var fee = swapFeeFor(w, cheap);
    if (!isFinite(fee) || fee < 0) fee = 0;
    var over = sumProofs(cheap) - fee - want;
    // nothing to bring back, or enough already
    if (!(over > 0) || over >= CARD_REFILL) return cheap;
    /* The fewest pieces that do it, and of those the cheapest: one larger
     * piece where the card has one. The cheapest set of any size got to the
     * amount with whatever small pieces were left, which are the ones the
     * change is wanted for. Where no set that few is within the bound, the
     * cheapest of any size. */
    var top = Math.min(most, want + CARD_REFILL_MOST);
    var full = /** @type {any} */ (cardFewestCover(w, pool, want + CARD_REFILL, top, null) || cardPickUnder(w, pool, want + CARD_REFILL, top));
    if (!full || !full.length || full.length > (many || CARD_ALL_MOST) || !(sumProofs(full) > sumProofs(cheap))) return cheap;
    full.fallback = cheap;
    return full;
  }

  /* The date a top-up's pieces take. A card that signs for each piece is given
   * thirty days from now, every time. A one-signature card keeps the date it
   * already has (on it, or owed to it) while that is CARD_DATE_REUSE off or
   * more, so that what is put on it today can be spent in one signature with
   * what was put on it last week. */
  function cardDateFor(card) {
    var now = Math.floor(Date.now() / 1000);
    var fresh = now + cardDateAhead();
    if (!cardIsAll(card)) return fresh;
    var held = 0;
    (card.pieces || []).forEach(function (x) { if (x && Number(x.date) > held) held = Number(x.date); });
    cardStore(CARD_OWED).forEach(function (r) {
      if (!r || r.card !== card.key) return;
      // the card's own change carries the date of the pieces it was made from
      if (Array.isArray(r.blind)) { if (!r.stuck && Number(r.date) > held) held = Number(r.date); return; }
      try {
        ((FoxyWallet.tokenInfo(r.token) || {}).proofs || []).forEach(function (pr) {
          var parts = cardSecretParts(pr.secret);
          if (parts && parts.date > held) held = parts.date;
        });
      } catch (e) {}
    });
    return held >= now + cardDateReuse() ? held : fresh;
  }

  /* The sizes of the outputs the card is asked to make for itself (software
   * 1.12) of a payment's `back`, the pieces' worth over the price and the mint's
   * fee, in no more pieces than the card keeps openings for (CARD_CHANGE_MOST),
   * the places it will have, and the outputs a request to the mint takes beside
   * this phone's own. A change that is more pieces than that gives the largest of
   * them; what is left is made here, after the swap, the way change was made
   * before 1.12 (`cardOweBack`). None where the card's outputs would not be of a
   * keyset the mint signs for: the card makes them in the keyset of its first
   * piece, which has to be the one in use. Largest first.
   *
   * A card of 1.12 is asked for up to eight, cut as its change always was, to fill
   * the gaps in the drawer it will then have (`cardChangeFor`). A card of 1.13 is
   * asked for FOUR at the most (CARD_CHANGE_PIECES), the four largest of the powers
   * of two the amount is made of (`cardLadder`, `plain`): each piece is about half
   * a second of the first tap, which change may add two seconds to and no more. */
  function cardOwnChangeCut(w, card, group, back) {
    var inUse = '';
    try { inUse = String(w.getOutputKeyset().id).toLowerCase(); } catch (e) { inUse = ''; }
    if (!inUse || !group.every(function (p) { return String(p.id).toLowerCase() === inUse; })) return [];
    var room = cardChangeRoom(w, card, group);
    if (!(room >= 1)) return [];
    var except = group.map(function (p) { var parts = cardSecretParts(p.secret); return parts ? parts.nonce : ''; });
    if (cardIsShaped(card)) return cardLadder(back, 64, cardMaxPiece(w), null, true).denominations.slice(0, room);
    return cardChangeFor(back, room, cardMaxPiece(w), cardHeldAmounts(card, except), cardIsDeep(card), cardDepthFor(card)).slice(0, room);
  }

  /* How many pieces of change the card is asked to make for a payment of `signed`
   * pieces: what it is asked for at most (CARD_CHANGE_PIECES, by its software), and
   * the openings it keeps, the places it will have and the outputs a request to the
   * mint takes beside this phone's own bound that. */
  function cardChangeRoom(w, card, signed) {
    var except = (signed || []).map(function (p) { var parts = cardSecretParts(p.secret); return parts ? parts.nonce : ''; });
    return Math.min(cardIsShaped(card) ? CARD_CHANGE_PIECES : CARD_CHANGE_PIECES_BEFORE, CARD_CHANGE_MOST, cardRoomFor(card, except),
                    Math.max(0, mintArrayCap(w) - CARD_OUTPUTS_MOST));
  }

  /* The pieces a change of `sats` is cut into plainly (`cardLadder`'s `plain`): one for each
   * power of two it is made of, none above the mint's largest (`top`). */
  function cardPlainPieces(sats, top) {
    return cardLadder(sats, 64, top, null, true).denominations.length;
  }

  /* Have the card sign once for `group`. Resolves { plan, signed }: the pieces
   * in the swap's order, the first with the signature. `note` is what the
   * payment is for ({ want, all, memo, own }), kept with the asking; `own`: the
   * card is asked to make its own change (`cardOwnChangeCut`), and `plain`
   * says it is not this time (it had no opening free for it).
   *
   * The conversation is the pieces (BEGIN), this phone's outputs, the card's
   * own change one output a command, and then the signature. The row of the
   * swap holds the sizes of the card's change before the card is asked for
   * anything, and each blinded message as the card answers it: the signature is
   * over every one, and must never exist without the row having them. */
  function cardSignGroup(t, card, w, group, progress, note, other, plain) {
    var slotOf = {};
    group.forEach(function (p) { slotOf[p.secret] = p.slot; });
    // how long each part took, for one line of the log: times and counts and nothing else
    var began = Date.now(), last = began, took = [], waited = false;
    var mark = function (name) { var now = Date.now(); took.push(name + ' ' + (now - last)); last = now; };
    var wantN = Math.round(Number(note && note.want) || 0);
    var split = (note && note.own && !plain && !note.all && wantN > 0)
      ? function (back) { return cardOwnChangeCut(w, card, group, back); } : null;
    var exact = !!(note && note.exact && !note.all && wantN > 0);
    return cardSwapPlan(w, group, split ? { want: wantN, split: split, exact: exact } : (exact ? { want: wantN, exact: true } : undefined)).then(function (plan) {
      mark('set out');
      var slots = plan.inputs.map(function (p) { return slotOf[p.secret]; });
      var first0 = cardSecretParts(plan.inputs[0].secret);
      plan.changeInfo = { card: card.key, forHash: 'card-' + plan.id, date: first0 ? first0.date : 0, mint: canonicalMint(mintOf(w)) };
      // said in the log: how the change is made and split, and what is left of it for the second swap
      if (note && note.own && !note.all && plan.net > wantN) {
        var tail = plan.net - wantN - plan.cardChange;
        console.log('[foxy] card: ' + (plan.change.length
          ? 'the card makes ' + plan.cardChange + ' sats of the change itself, in ' + plan.change.length + ' piece' + (plan.change.length === 1 ? '' : 's')
            + ' (' + plan.change.map(function (c) { return c.amount; }).join(' + ') + ')'
          : 'no change is asked of the card')
          + (tail > 0 ? '; ' + tail + ' sat' + (tail === 1 ? '' : 's') + ' more ' + (tail === 1 ? 'is' : 'are') + ' made here after the swap, at the change tap' : ''));
      }
      /* Written down before the card is asked. From SIGN on, what the card did
       * is not known until it answers, and this row is what its next tap is
       * read against. */
      cardSwapWrite(plan, { card: card.key, proofs: plan.inputs, want: wantN,
                            all: !!(note && note.all), memo: String((note && note.memo) || ''), at: Date.now(),
                            // its pieces proved with the mint's proofs before it was asked, with no route (`cardOfflineProve`)
                            proved: !!(note && note.proved) });
      try { if (typeof progress === 'function') progress({ step: 'signing', i: 1, n: 1, all: true }); } catch (e) {}
      var asked = false;
      return t.want(cardCommand(CARD_INS.begin, 0, slots.map(cardByte).join(''), 4), 'to take the pieces of a payment').then(function (d) {
        if (!cardHexOk(d, 4) || cardU32(d, 0) !== plan.sum) throw cardError('refused', 'The card does not hold what it said it holds.', { sw: '' });
        mark(slots.length + ' pieces');
        var walk = Promise.resolve();
        // six to a command: 37 bytes each
        for (var at = 0; at < plan.outputs.length; at += 6) {
          (function (some) {
            walk = walk.then(function () {
              return t.want(cardCommand(CARD_INS.outputs, 0, some.map(function (o) { return cardU32Hex(o.amount) + o.B_; }).join('')), 'to take where a payment goes');
            });
          })(plan.outputs.slice(at, at + 6));
        }
        return walk;
      }).then(function () {
        mark(plan.outputs.length + ' outputs');
        /* The card's own change, one command for each output, after all of
         * this phone's (it takes none after its own). It is told the amount and
         * answers the blinded message it made; that is what goes in the swap
         * and in the message it signs. A blinded message that is no point at
         * all would only be refused by the mint after the card had signed, so
         * it is looked at here. */
        return plan.change.reduce(function (chain, c, k) {
          return chain.then(function () {
            /* Said before the card is asked, so the line is up for the whole of its work on this piece (about half a
             * second of it over NFC): with several pieces that was seconds of a sheet that said nothing, and the holder
             * took the card away. */
            try { if (typeof progress === 'function') progress({ step: 'change', i: k + 1, n: plan.change.length }); } catch (e) {}
            /* From 1.21 the card is told the mint's key for the amount too, and keeps it: its change can then be loaded only as the
             * mint's real signature under that key (LOAD_CHANGE). The key is the keyset's own, compressed. */
            var data = cardU32Hex(c.amount);
            if (cardIs121(card)) {
              var ks = keysetFor(w, plan.keyset);
              var K = ks && ks.keys ? String(ks.keys[String(c.amount)] || '').toLowerCase() : '';
              if (!/^0[23][0-9a-f]{64}$/.test(K)) throw cardError('refused', 'The mint\u2019s key for this change is not known here.', { sw: '' });
              data += K;
            }
            return t.ask(cardCommand(CARD_INS.change, 0, data, 33));
          }).then(function (r) {
            if (r.sw === '6a84') { var full = /** @type {any} */ (new Error('the card has no opening free for its change')); full.cardNoOpening = true; throw full; }
            if (r.sw !== '9000') throw cardRefused(r.sw, 'to make its change');
            var good = cardHexOk(r.data, 33) && /^0[23]/.test(r.data);
            if (good) { try { window.CashuTS.pointFromHex(r.data); } catch (eP) { good = false; } }
            if (!good) throw cardError('refused', 'The card did not make its change as it should.', { sw: '' });
            c.B_ = r.data;
            // in the row before the card is asked for anything else
            cardSwapAmend(plan);
          });
        }, Promise.resolve());
      }).then(function () {
        if (plan.change.length) { cardSealPlan(plan); cardSwapAmend(plan); mark(plan.change.length + ' change'); }
        /* SIGN, and SIGN again while the card says it is waiting (two bytes:
         * "not yet"). Nothing is burned until the last of them, so a card that
         * leaves in the wait has signed nothing, and is known to have signed
         * nothing because the card itself said more were to come. Only the
         * SIGN that may be the signing one is not known about if its answer
         * is lost. */
        /* The card does not say how many are to come (that would say what its
         * limit is), so every SIGN may be the one that signs, and a card that
         * leaves in the wait is asked about at its next tap like any other
         * (`cardAskedBack`: its pieces are still on it, and it never signed).
         * A wait longer than anybody holds a card is given up here, with
         * nothing signed: the last answer was "not yet", and nothing more is
         * asked. The day's limit is held at the first SIGN from 1.12 (it was
         * at BEGIN): a refusal there gives the payment up, and its row with it. */
        var polls = 0, since = Date.now();
        var again = function () {
          asked = true;
          return t.ask(cardCommand(CARD_INS.signAll, 0, '', 64)).then(function (r) {
            /* 6A94: the card has a PIN, was shown none, and the no-PIN allowance does not cover this payment (or there is none).
             * It signed nothing and gave the payment up, as it does for a limit: this one's row goes with it (below), and the
             * person is asked for the PIN and taps again. */
            if (r.sw === '6a94') throw cardError('pin-needed', 'Card needs PIN entered.', { sw: r.sw, need: plan.leaves, sheetText: CARD_PIN_SHEET });
            if (r.sw !== '9000') throw cardRefused(r.sw, 'to sign for a payment');
            return r.data;
          }).then(function (d) {
            if (!cardHexOk(d, 2)) return d;
            /* Not yet, at the first asking, and there is a cheaper set that
             * pays (`other`: this one was chosen for the change it brings
             * back, `cardRefillPick`). The card has signed nothing and said
             * so; the payer is not made to wait for change. */
            if (polls === 0 && other && other.group && other.group.length) {
              asked = false;
              cardSwapDrop(plan.id);
              var turn = /** @type {any} */ (new Error('a cheaper set'));
              turn.cardOther = true;
              throw turn;
            }
            if (polls === 0) mark('first wait');
            waited = true;
            polls += 1;
            if (polls > CARD_WAIT_POLLS) {
              asked = false;
              cardSwapDrop(plan.id);
              throw cardError('tap-limit', 'This card would have to be held longer than a tap lasts to pay this. Take it in smaller parts.',
                              { paced: true, hidden: true, wait: Math.round((Date.now() - since) / 1000), need: plan.leaves });
            }
            /* `sum` and `want`: what leaves the card (the pieces, less the change it made for itself) and what is being paid, so the screen can
             * say which of the two the wait is for. `making`: the first limit's worth of waiting, of a payment in which the card made change,
             * which is what a payment within the limit waits for, and a payment over it too: the card does not say which, and it is said for
             * what it may be until it goes on past that. A card of 1.13 does not wait for change, only for the limit, and says so: the work of
             * making it is said as it is done (`progress`, `change`, above). */
            try { if (typeof progress === 'function') progress({ step: 'waiting', over: (typeof card !== 'undefined' && card && card.info && card.info.waitOver) || 7, more: (typeof card !== 'undefined' && card && card.info && card.info.waitMore) || 3, polls: polls, seconds: Math.max(1, Math.round((Date.now() - since) / 1000)),
                                                                sum: plan.leaves, want: wantN, making: !cardIsShaped(card) && plan.cardChange > 0 && polls <= CARD_WAIT_SIGNS }); } catch (e) {}
            return again();
          });
        };
        return again();
      }).then(function (sig) {
        var first = /** @type {any} */ ({ id: plan.inputs[0].id, amount: plan.inputs[0].amount, secret: plan.inputs[0].secret, C: plan.inputs[0].C,
                                          witness: JSON.stringify({ signatures: [sig] }) });
        var good = false;
        try { good = cardHexOk(sig, 64) && window.CashuTS.isP2PKSpendAuthorised(first, undefined, plan.message) === true; } catch (e) { good = false; }
        if (!good) {
          cardSwapDrop(plan.id);
          throw cardError('bad-signature', 'The card’s signature for this payment was not good. Nothing more was asked of it.');
        }
        // a signature good for its key is the card proving it holds that key: nothing in this session asks it to again
        cardProvedHere(t.link, card.key);
        // and a payment signed in this time in the field: the card makes the next one wait (software 1.13, `cardPaid`)
        if (t.link && t.link.one) t.link.one.paid = (Number(t.link.one.paid) || 0) + 1;
        mark(waited ? 'waits and signature' : 'signature');
        try { console.log('[foxy] card: signed in ' + (Date.now() - began) + ' ms (' + took.join(', ') + ')'); } catch (eL) {}
        return { plan: plan, signed: [first].concat(plan.inputs.slice(1)) };
      }, function (e) {
        // the card would have waited, and there is a cheaper set: that one, with nothing asked of this one
        if (e && e.cardOther && other) {
          try { console.log('[foxy] card: it would wait for ' + plan.leaves + ' sats; paid with ' + sumProofs(other.group) + ' instead'); } catch (eL) {}
          return Promise.resolve(typeof other.fill === 'function' ? other.fill() : null).then(function () {
            return cardSignGroup(t, card, w, other.group, progress, note);
          });
        }
        /* The card has no opening free for its change (the openings of change
         * not yet written back count, and eight is all it keeps), and gave the
         * payment up. It is made again, with the change made here after the
         * swap as it was before 1.12; the plan's counters are left unused. */
        if (e && e.cardNoOpening) {
          cardSwapDrop(plan.id);
          try { console.log('[foxy] card: it has no opening free for its change; the payment is begun again, with the change made here'); } catch (eL) {}
          return cardSignGroup(t, card, w, group, progress, note, other, true);
        }
        // given up in the wait (above): the asking is forgotten already, and the refusal is said as it is
        if (e && e.card === 'tap-limit') throw e;
        /* Gone with SIGN asked and no answer: it may have signed, and burned
         * the pieces as it did. The asking is kept, and its next tap here is
         * asked for that signature again (`cardAskedBack`). Anything else is a
         * card that signed nothing. */
        if (asked && e && e.card === 'gone') {
          throw cardError('interrupted', 'The card was taken away as it was signing. Nothing is paid yet: tap it again to finish.',
                          { owed: plan.sum, held: plan.sum, want: wantN, resumable: true, made: false });
        }
        cardSwapDrop(plan.id);
        throw e;
      });
    });
  }

  /* The PIN, then a signature for each group in turn (one, but for a whole
   * card taken off). `keep(signed, plan)` writes a group's row down as soon as
   * its signature is in hand, and answers it. Resolves { rows, signed }; if
   * the card leaves between two groups, the rows it did sign for are on the
   * error as `rows`, with their pieces as `signedAll`. */
  function cardSignAll(t, card, w, groups, pinHex, lift, progress, keep, note, other) {
    var rows = [], signedAll = [];
    return cardUnderPin(t, card, pinHex, lift, function () {
      var walk = Promise.resolve();
      groups.forEach(function (group) {
        walk = walk.then(function () {
          // `other`: a cheaper set for a payment of one signature, should the card make this one wait
          return cardSignGroup(t, card, w, group, progress, note, groups.length === 1 ? other : null).then(function (got) {
            rows.push(keep(got.signed, got.plan));
            signedAll = signedAll.concat(got.signed);
            cardSwapSettled(got.plan.id);
          });
        });
      });
      return walk.then(function () { return { rows: rows, signed: signedAll }; });
    }).then(null, function (e) {
      try { e.rows = rows; e.signedAll = signedAll; } catch (x) {}
      throw e;
    });
  }

  /* What became of signatures this phone asked this card for and never saw
   * (the card left as it signed). Pieces still on the card were never signed
   * for, and the asking is forgotten. Pieces gone from it were: the card is
   * asked for its last signature again, under its PIN, and where that is good
   * for what was asked the payment is in hand after all. Resolves those, as
   * [{ spec, signed }]. A signature that is not to be had (the card has signed
   * for something else since) leaves pieces nobody can spend until their date,
   * as a piece lost in the air always has. */
  function cardAskedBack(t, card, pinHex) {
    if (!cardIsAll(card)) return Promise.resolve([]);
    var mine = cardStore(CARD_SWAPS).filter(function (r) { return r && r.asked && r.asked.card === card.key; });
    if (!mine.length) return Promise.resolve([]);
    var onCard = {};
    (card.pieces || []).forEach(function (x) { if (x && x.nonce) onCard[x.nonce] = true; });
    var open = mine.filter(function (r) {
      var still = (r.asked.proofs || []).some(function (p) { var parts = cardSecretParts(p.secret); return !!(parts && onCard[parts.nonce]); });
      if (still) cardSwapDrop(r.id);
      return !still && (r.asked.proofs || []).length > 0;
    });
    if (!open.length) return Promise.resolve([]);
    return cardVerify(t, card, pinHex).then(function () {
      return t.ask(cardCommand(CARD_INS.again, 0, '', 64));
    }).then(function (r) {
      // asked with no PIN of a card that has one, and it wants it for this: the signature stays asked for, and the PIN is asked of the person
      if (r.sw === '6982' && !pinHex) throw cardError('pin-needed', 'Card needs PIN entered.', { sw: r.sw, again: true, sheetText: CARD_PIN_SHEET });
      var sig = r.sw === '9000' ? r.data : '';
      var found = [];
      open.forEach(function (row) {
        var good = false;
        try { good = cardHexOk(sig, 64) && window.CashuTS.schnorrVerifyDigest(sig, bytesOfHex(row.digest), card.key) === true; } catch (e) { good = false; }
        if (!good) {
          console.warn('[foxy] card: ' + sumProofs(row.asked.proofs) + ' sats it was asked to sign for are gone from it, and its signature for them is not to be had');
          cardSwapDrop(row.id);
          return;
        }
        var p0 = row.asked.proofs[0];
        var first = { id: p0.id, amount: p0.amount, secret: p0.secret, C: p0.C, witness: JSON.stringify({ signatures: [sig] }) };
        found.push({ spec: row, signed: [first].concat(row.asked.proofs.slice(1)) });
      });
      if (found.length) console.log('[foxy] card: a signature it gave as it was taken away is had again; that payment is in hand');
      return found;
    });
  }

  /* ---- a card reset (software 1.17): what is checked first, and what is forgotten after ----------------------------------------
   *
   * The card wipes everything it keeps, and some of that is the only record of money: the openings of the change it made for itself
   * (the nonce and blinding factor the mint's signatures are unblinded with) and the signature it would give again. This phone keeps
   * rows of money made for the old key, which nothing can write to the card again. So before it resets a card this phone looks at
   * what is open, and says so (`unsettled`) rather than lose it; the owner's `abandon` is the way to give that money up. */

  /* What is open for this card, from this phone's own rows: { owed, due, asked, held, unit, amount, sats }, counts of each and what
   * the owed and due rows come to, in the card's unit (`sats` the same for a bitcoin card's, 0 for a dollar card's). */
  function cardOpenRows(key, cardUnit) {
    var owed = cardStore(CARD_OWED).filter(function (r) { return r && r.card === key; });
    var due = cardStore(CARD_DUE).filter(function (d) { return d && d.card === key; });
    var asked = cardStore(CARD_SWAPS).filter(function (r) { return r && r.asked && r.asked.card === key; });
    var held = cardStore(CARD_TAKEN).filter(function (r) { return r && r.resume && r.card === key; });
    var all = owed.concat(due);
    var unit = cardUnit ? (unitOf(cardUnit) || 'sat') : (all.length ? cardRowUnit(all[0]) : 'sat');
    var n = 0;
    all.forEach(function (r) { n += cardRowAmt(r); });
    return Object.assign({ owed: owed.length, due: due.length, asked: asked.length, held: held.length }, cardGot(unit, n));
  }

  /* The card as its owner reads it for a reset, with everything refused that can be known before anything is asked of it:
   * `old-card`, `no-owner`, `not-owner`, `locked` (no PIN given), `change-owed` and `unsettled`. The money on it is the caller's to judge
   * (`o.money`: it is not refused here). The change the card made for itself is looked into first (`opts.change` of `cardLook`),
   * so that what the mint has signed is fetched and put on the card, which the caller then finds there. */
  function cardResetLook(link, t, o, pin) {
    var card;
    return FoxyWallet.cardLook(link, { short: true, mine: true, change: true }).then(function (c) {
      card = c;
      var info = card.info;
      if (!info.resetKnown) throw cardError('old-card', 'This card’s software cannot be reset.');
      if (!info.owner) throw cardRefused('6a90');
      // an unlocked card is asked to accept this phone's grant in the read; a locked one is not, and the reset command is the proof
      if (card.mine === false) throw cardRefused('6a91');
      if (!o.money && info.unspent > 0) throw cardError('has-money', 'Take the money off the card first.', Object.assign(cardGot(card.record.unit, card.balance), { cardUnit: card.record.unit }));
      if (info.locked && !pin) throw cardError('locked', 'This card is locked. It can be reset only with its PIN.');
      if (o.abandon) return card;
      var open = cardOpenRows(card.key, card.record.unit);
      var count = function () { return open.owed + open.due + open.asked + open.held; };
      var openings = info.ownChange ? cardOpenings(t) : Promise.resolve([]);
      return openings.then(function (list) {
        open.openings = list.length;
        // in the card's unit, with `sats` the same only for a bitcoin card
        open.amount += list.reduce(function (n, x) { return n + x.amount; }, 0);
        open.sats = open.unit === 'sat' ? open.amount : 0;
        if (open.openings > 0) {
          /* The card wipes the openings of the change it made for itself, and that change is locked to the key it destroys: it would be lost.
           * The owner's read above has already tried to fetch it and put it on (the card then holds it, and the caller takes it off);
           * what is left is change the mint has not signed or cannot be asked for now. */
          console.log('[foxy] card: not reset: it is owed ' + open.openings + ' piece(s) of change');
          throw cardError('change-owed', 'The card is owed change from its last payment. Tap it once more first.', { owes: open, unit: open.unit, amount: open.amount, sats: open.sats });
        }
        if (count() > 0) {
          console.log('[foxy] card: not reset: ' + open.owed + ' row(s) owed to it, ' + open.due + ' due, ' + open.asked + ' signature(s) asked of it, ' + open.held + ' payment(s) held');
          throw cardError('unsettled', 'This card still has money on its way. Let that finish first, then reset it.', { owes: open, unit: open.unit, amount: open.amount, sats: open.sats });
        }
        return card;
      });
    });
  }

  /* Everything this phone kept under a card's key that is not money, dropped; and, if the owner gives up what is open
   * (`abandon`), the rows of money owed to that key and the signatures asked of it too. The card's row in the cards this phone can
   * take back (`CARDS`) is kept: a piece the card signed away that its receiver never swapped is this phone's to take back after
   * its date, whatever the card has become. */
  function cardForget(key, abandon) {
    var drop = function (store) {
      var all = load(store, {});
      if (all && typeof all === 'object' && !Array.isArray(all) && Object.prototype.hasOwnProperty.call(all, key)) { delete all[key]; save(store, all); }
    };
    [CARD_PACE, CARD_RECEIPTS, CARD_LIFTED, CARD_CHECKED, CARD_REAL, CARD_DESIGNS, CARD_LOG_SEEN, CARD_FOR_HOLDER, CARD_NAMES].forEach(drop);
    // (and its name: a card reset is set up again, and named again there)
    var rows = cardsOnFile();
    if (rows[key] && Object.prototype.hasOwnProperty.call(rows[key], 'name')) { delete rows[key].name; save(CARDS, rows); }
    if (!abandon) return;
    var keep = function (r) { return !(r && r.card === key); };
    var owed = cardStore(CARD_OWED);
    if (owed.filter(keep).length !== owed.length) mustSave(CARD_OWED, owed.filter(keep));
    var due = cardStore(CARD_DUE);
    if (due.filter(keep).length !== due.length) mustSave(CARD_DUE, due.filter(keep));
    cardStore(CARD_SWAPS).filter(function (r) { return r && r.asked && r.asked.card === key; }).forEach(function (r) { cardSwapSettled(r.id); });
  }

  /* What this phone last knew to be on a card it can take back: the pieces'
   * own fields, by nonce. A card that is lost is taken back from this, so it
   * is added to whenever the card is loaded or read here, and never trimmed
   * by a read that shows less: a piece that is gone from the card has been
   * spent, and the mint will say so. */
  function cardRemember(card, pieces, whole) {
    // (a card of 1.23 as one unit, `cardInUnit`: written down as the whole card, and "all it holds" is both units' pieces)
    if (card && card.whole) { if (whole) pieces = card.whole.pieces; card = card.whole; }
    var all = cardsOnFile();
    var row = all[card.key];
    if (!row) return;
    var seen = row.pieces && typeof row.pieces === 'object' ? row.pieces : {};
    var here = {};
    (pieces || []).forEach(function (x) {
      if (!x || !x.nonce) return;
      here[x.nonce] = true;
      seen[x.nonce] = { keyset: x.keyset, amount: x.amount, C: x.C, date: x.date || 0 };
      // (a card of 1.23 that holds both units: the piece's unit, as the card's table says it, for taking it back by its own keysets)
      if (x.unit === 'sat' || x.unit === 'usd') seen[x.nonce].unit = x.unit;
    });
    /* `whole`: these are all the card holds, so anything else on file has
     * left it. Marked, not forgotten: a piece the card signed for and nobody
     * swapped is still unspent at the mint, the card will never sign for it
     * again, and this row is the only road by which it comes back. What a
     * screen says the card holds leaves the marked ones out (`cardsList`). */
    if (whole) cardLeft(seen, Object.keys(seen).filter(function (n) { return !here[n]; }));
    row.pieces = seen;
    row.seen = Date.now();
    /* A card taken back and then found and given money again: it holds pieces dated after now, which were never taken back, so it
     * is not a card whose money came back any more, and RESTORE CARD offers it again on their date (`cardsList`, `cardTakeBack`). */
    var nowSecs = Math.floor(Date.now() / 1000);
    if (row.takenBack && (pieces || []).some(function (x) { return x && Number(x.date) > nowSecs; })) delete row.takenBack;
    // how this card writes a piece's secret, for taking it back with no card to ask
    // (format 5, a card of 1.23 that holds both units, writes its secrets as format 4 does, and is filed as 4)
    if (card.info && card.info.format) row.format = cardAllFormat(card.info.format) ? CARD_FORMAT_ALL : card.info.format;
    /* Its software as last read, and whether that wants its PIN before any load (1.21 and on, `pinFirst`): SEND > FLASHCARD asks
     * the PIN ahead only of cards known to want it (26f-flashcard.js `fcSendPinFirst`). A row from before this was kept has neither. */
    if (card.info) {
      row.pinFirst = !!card.info.pinFirst;
      row.software = String(card.info.version || '');
    }
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

  /* A piece on file (`cardRemember`, by its nonce) as the mint is shown it: its keyset's whole name where this mint lists it (of a
   * keyset it no longer lists, the eight bytes there are; a piece of a card of 1.23 that held both units among its unit's keysets, as
   * the card's table had it), and the secret the card wrote for it. Throws where that secret cannot be built (`cardSecret`). */
  function cardFiledProof(w, cardKey, row, nonce, x) {
    return { id: cardFullId(w, x.keyset, x.unit || undefined) || x.keyset, amount: x.amount, C: x.C, date: x.date,
             secret: cardSecret(nonce, cardKey, x.date, row.refundKey, row.format) };
  }

  /* The mint's word on pieces of a card on file (`cardFiledProof`): one request (NUT-07, by each secret's Y) on the card's own
   * circuit, answered as the states in the order asked, 'UNSPENT', 'SPENT' or 'PENDING' ('' where the mint said nothing of one).
   * Nothing is spent by it. The take-back (`cardTakeBack`) asks by it before it swaps, and RESTORE CARD's look
   * (`cardsStillAtMint`) asks by it and swaps nothing. */
  function cardFiledStates(w, cardKey, proofs) {
    var asking = onCircuit(w, 'card:' + cardKey.slice(-16));
    return withTimeout(Promise.resolve().then(function () { return asking.checkProofsStates(proofs); }), 30000, 'the mint\u2019s word on a card\u2019s pieces')
      .then(function (states) {
        return proofs.map(function (pr, i) {
          var st = (states && states[i]) || {};
          return String(st.state || st.State || '').toUpperCase();
        });
      });
  }

  /* Pieces on file the mint has said are spent, or that this phone's take-back has swapped in: kept, stamped `spent`, and left out
   * of what a screen says the card holds (`cardsList`), so that figure only ever goes down by the mint's word or by money that came
   * back. Spent is for good. A read of the card that still shows one writes it down afresh (`cardRemember`), and it is asked about
   * again. */
  function cardFiledSpent(cardKey, nonces) {
    if (!nonces.length) return;
    var all = cardsOnFile();
    var row = all[cardKey];
    if (!row || !row.pieces || typeof row.pieces !== 'object') return;
    var at = Date.now();
    nonces.forEach(function (n) { if (row.pieces[n] && !row.pieces[n].spent) row.pieces[n].spent = at; });
    save(CARDS, all);
  }

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

  /* Swap a row of TAKEN at the mint, by the ordinary receive. The entry is
   * the row's own id, so an answer that was lost and found again finishes
   * that entry and no other.
   *
   * The first asking is a person waiting, and is made with nothing asked of the
   * mint before it: the swap refuses spent pieces itself, and a question
   * first is another round trip over Tor in front of a till (the pieces' state
   * was 9 to 24 seconds of a payment). It leaves on the circuit kept ready. A
   * later asking (`again`, the wallet's own on a connect) is nobody's wait, and
   * keeps its question so that a swap that would be refused reserves nothing.
   *
   * Four ways out besides paid:
   *   `putback`  the mint refused, and some of the pieces are still good: they
   *              are filed to go back onto the card at its next tap;
   *   `spent`    the mint says the pieces are gone (or this phone swapped
   *              them already, and this is a copy of a card that has paid);
   *   `bad-pieces` the mint never signed them: nothing to put back;
   *   `waiting`  no answer, or one that settles nothing: the swap record and the
   *              row stay, and the wallet's own recovery settles it. */
  /* A card paying out of this phone (`row.send`): on the first asking the pieces this phone is given for the price are not put
   * in its pile but held to one side for the payment (`holdAs`, 19-bill-split.js), and the entry is the holder's own move
   * (`to: 'card'`), never announced as money received. A later asking (`again`: the answer was lost, and the payment never
   * made) puts them in the pile as any swap does, and the settling owes them all back to the card (`cardSettle`). */
  function cardSwapTaken(row, again) {
    var holdAs = (row.send && !again) ? { id: 'cardout-' + row.id, card: row.card, forHash: row.id, token: row.token, tillKeeps: !!row.tillKeeps } : undefined;
    /* What stays, what goes back and what came, under the names of the row's own unit (`receiveToken`): a dollar card's are
     * `keptAmount`, `changeAmount` and `grossAmount`, in cents. */
    var u = cardRowUnit(row);
    var kept = row.all ? undefined : cardRowAmt(row);
    var over = row.all ? undefined : (row.over > 0 ? row.over : undefined);
    var gross = row.all ? undefined : row.worth;
    var told = { hash: row.id, memo: row.memo || 'card', holdAs: holdAs,
                 // what of the token went to outputs the card made for itself: not this phone's, and no fee
                 toCard: row.all ? undefined : (row.cardChange > 0 ? row.cardChange : undefined),
                 noPrecheck: !again, now: !again,
                 // made on a card's visit to its mint, as part of it (`cardVisit`)
                 cardVisit: !!cardAway || undefined };
    if (u === 'sat') { told.keptSats = kept; told.changeSats = over; told.grossSats = gross; }
    else { told.keptAmount = kept; told.changeAmount = over; told.grossAmount = gross; }
    // what this phone has of it, in the row's unit: `amount`, and `sats` for a bitcoin card only
    var got = function (n) { var v = Math.max(0, Math.round(Number(n) || 0)); return { unit: u, amount: v, sats: u === 'sat' ? v : 0 }; };
    return FoxyWallet.receiveToken(row.token, told)
      .then(function (r) {
        mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && x.id === row.id); }));
        // 'card' is a move the screens say themselves; 'card payment' is announced like any other (16-history-lists.js)
        /* (a payment held for this phone's own invoice, `row.tillKeeps`, is a payment to this phone like any other: the screen
         * that asked for it keeps it quiet, and announces the sats it buys) */
        try { FoxyWallet.tag(row.id, { to: (row.memo === 'from card' || row.refund || (row.send && !row.tillKeeps)) ? 'card' : 'card payment' }); } catch (x) {}
        // and names the card, as a load's entry does: the card's own history is read from that (26f-flashcard.js)
        try { amendTx(row.id, cardRowMarks(row, {})); } catch (x1) {}
        return cardChangeKept(row).then(function () { return got(r && (r.amount != null ? r.amount : r.sats)); });
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
          // (the note of what was taken keeps its figure in the token's own unit)
          return cardChangeKept(row).then(function () { return got(e.foxyTakenSats); });
        }
        var spent = !!(e && e.foxyMine) || /already spent|token already|already claimed|nothing to take/i.test(text) || Number(e && e.code) === 11001;
        /* An answer that was lost and then found by the wallet's own recovery
         * (`recoverSwaps`) has put the ecash in the pile and written the entry,
         * and the mint now calls the pieces spent, because they were: this
         * phone's own swap spent them. That is the payment, made. */
        if (again && spent && !(e && e.foxyMine) && FoxyWallet.txSeen(row.id)) {
          mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && x.id === row.id); }));
          try { FoxyWallet.tag(row.id, { to: (row.memo === 'from card' || row.refund || (row.send && !row.tillKeeps)) ? 'card' : 'card payment' }); } catch (x2) {}
          try { amendTx(row.id, cardRowMarks(row, { memo: row.memo || 'card' })); } catch (x3) {}
          // what this phone has of it: the card's own change (1.12) was never in its pile
          return cardChangeKept(row).then(function () { return got((Number(row.worth) || 0) - (Number(row.cardChange) || 0)); });
        }
        /* Spent, asked again, with this phone's own record of the swap still waiting for its answer (`swapGuard`, `into` the
         * row): the mint did this swap, and the answer is what was lost (it said nothing, then the pieces were spent). Not a
         * refusal: the record is asked about now (`recoverSwaps`), which restores what the swap made onto this row's entry, and
         * then it is the payment, made. A record that finds nothing yet is `waiting`, as an answer not had is; never "already
         * spent", which left the money in this phone's pile as plain ecash and the card told it had paid nothing. */
        if (again && spent && !(e && e.foxyMine) && cardSwapOpen(row.id)) {
          return cardSwapAsk(row.id).then(function () {
            if (!FoxyWallet.txSeen(row.id)) throw cardError('waiting', 'The card has signed and the mint has not said what became of its swap yet.', { id: row.id });
            mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && x.id === row.id); }));
            try { FoxyWallet.tag(row.id, { to: (row.memo === 'from card' || row.refund || (row.send && !row.tillKeeps)) ? 'card' : 'card payment' }); } catch (x4) {}
            try { amendTx(row.id, cardRowMarks(row, { memo: row.memo || 'card' })); } catch (x5) {}
            return cardChangeKept(row).then(function () { return got((Number(row.worth) || 0) - (Number(row.cardChange) || 0)); });
          });
        }
        // a restored answer is not a refusal: the mint did the swap, and the ecash is back in the pile
        var status = Number((e && (e.status || (e.response && e.response.status))) || 0);
        var busy = status === 408 || status === 425 || status === 429;      // asked too often, or too soon: not a "no" to the pieces
        if (spent || (mintRefused(e) && !(e && e.recovered) && !busy)) return cardRefusal(row, e, !!(e && e.foxyMine));
        throw cardError('waiting', 'The card has signed and the mint has not answered yet. ' + text, { id: row.id });
      });
  }

  /* What a taken row's entry is marked with: the card it names, and `lost` for the take-back of a lost card (RESTORE LOST CARD,
   * 21a-flashcard.js `cardTakeBack`), which home's history keeps since that card's own list cannot be opened. */
  function cardRowMarks(row, more) {
    var f = /** @type {any} */ (Object.assign({ card: row.card }, more || {}));
    if (row.lost) f.lost = true;
    return f;
  }

  // whether this phone's record of a swap for a card's row is still open (its answer not had: `swapGuard`, `into`)
  function cardSwapOpen(id) {
    try { return loadSwaps().some(function (r) { return r && r.into === id; }); } catch (e) { return false; }
  }
  /* That record asked about now, whatever its turn (`_recoverSwapsOnce` asks a record tried twice only every ten minutes): it is a
   * person's payment waiting on it. */
  function cardSwapAsk(id) {
    try {
      loadSwaps().forEach(function (r) {
        if (r && r.into === id && (Number(r.tried) || 0) >= 2) { r.tried = 1; r.lastTry = 0; writeSwap(r); }
      });
    } catch (e) { /* asked in its turn, then */ }
    return FoxyWallet.recoverSwaps().then(null, function () { return null; });
  }

  /* The mint's "no" to pieces a card has signed for. The card marked them spent
   * when it signed, so what the mint has not spent of them is the holder's money
   * that only this card can hold, and it has to go back on it.
   *
   * Which of them are still good is the mint's to say, and is asked here, after
   * the card has been let go and not while it is held. Those that are go to the
   * owed store as they stand (the card's own pieces, without the signatures), and
   * the next tap on the card clears the places the signing burned and loads them
   * again. The card's day stays charged: loading gives the day nothing back, and
   * only the owner's phone can set it right. Said as `putback`, with how much.
   *
   * A mint that cannot be asked, or says some are pending, has not said: the row
   * is kept and this is `waiting`, as a lost answer is. */
  function cardRefusal(row, e, mine) {
    var w;
    try { w = need(); } catch (x) { return Promise.reject(cardError('waiting', 'The card has signed and the mint has not answered yet.', { id: row.id })); }
    var tok = null;
    try { tok = FoxyWallet.tokenInfo(row.token); } catch (x1) { tok = null; }
    var all = (tok && tok.proofs) || [];
    var strike = function () { mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (r) { return !(r && r.id === row.id); })); };
    // pieces the mint never signed are worth nothing, and are not put back on a card
    if (Number(e && e.code) === 10003) {
      strike();
      return Promise.reject(cardError('bad-pieces', 'The card gave pieces the mint did not sign. Nothing was paid.', { id: row.id }));
    }
    var asked = (mine || !all.length) ? Promise.resolve(all.map(function () { return 'SPENT'; }))
      : statesOf(onCircuit(w, 'card:' + String(row.card).slice(-16)), all).then(null, function () { return null; });
    return asked.then(function (states) {
      var known = !!states && states.length === all.length && states.every(function (st) { return st === 'UNSPENT' || st === 'SPENT'; });
      if (!known) throw cardError('waiting', 'The card has signed and the mint has not said what became of its pieces yet.', { id: row.id });
      var good = all.filter(function (p, i) { return states[i] === 'UNSPENT'; });
      if (!good.length) {
        strike();
        throw cardError('spent', 'The mint says this card’s money was already spent.');
      }
      var sats = sumProofs(good);
      // in the row's own unit: a dollar card's pieces go back as dollars
      var u = cardRowUnit(row);
      var token = encodeToken(mintOf(w),
        good.map(function (p) { return { id: p.id, amount: p.amount, secret: p.secret, C: p.C }; }), u);
      // owed first, then struck off: never in neither
      mustSave(CARD_OWED, cardStore(CARD_OWED).filter(function (r) { return !(r && r.id === 'back-' + row.id); })
        .concat([Object.assign({ id: 'back-' + row.id, card: row.card, token: token, kind: 'putback', forHash: row.id, at: Date.now() }, cardFig(u, sats))]));
      strike();
      console.warn('[foxy] card: the mint refused a payment the card had signed for (' + String((e && (e.message || e.detail)) || e).slice(0, 80)
        + '); ' + cardSaid(sats, u) + ' of it are owed back to the card, ' + cardSaid(sumProofs(all) - sats, u) + ' are spent');
      throw cardError('putback', 'The mint refused this payment, and the card has already signed for it. ' + (u === 'sat' ? sats + ' sats are' : moneyWords(sats, u) + ' is')
        + ' waiting to go back onto the card at its next tap.', { owed: sats, lost: sumProofs(all) - sats, limited: !!row.limited, id: row.id, unit: u, cardUnit: u });
    });
  }

  /* ---- a till with no route -------------------------------------------------
   *
   * Paid needs the mint's swap, and a phone with no route cannot ask. A card of
   * one signature (format 4) can still pay it: the swap is set out here from
   * this phone's own seed (no mint is asked for that), the card signs it over,
   * and the signature is good for those outputs and no others. Nobody but this
   * phone can use it, and the phone keeps it whole and posts it the first time
   * it is online.
   *
   * What it takes, and when it refuses, all before the PIN and before the card
   * is asked to sign:
   *   - a card that keeps the mint's proofs (software 1.20), whose pieces prove
   *     here, against the mint's keys this phone kept, that the mint signed them
   *     (`cardOfflineProve`). An older card, or one that cannot prove its money,
   *     is refused offline and can pay as ever once this phone is online;
   *   - pieces with a week or more to their date by the latest clock this phone
   *     has evidence for (`cardOfflineNow`): after the date the card's owner may
   *     take them back, and this phone must reach the mint before that. Pieces
   *     with no date (a card that is like cash) have nothing to race;
   *   - an exact set (a till with no route cannot make change), and a payment,
   *     never a withdrawal.
   * No question is put to the person: the card proves its money, signs it to
   * this phone, and burns its pieces as it signs. What is kept is a record of
   * the whole swap (CARD_KEPT, `cardKeepSigned`) and a row of the unclaimed
   * store, with an entry that says received at once, waiting for the mint, and
   * counts in the balance. `claimUnclaimed` posts it on every connection until
   * the mint answers (`cardKeptPost`, `cardKeptSettled`, `cardKeptFailed`).
   *
   * The risk left is a copy of the card: its pieces are the mint's, and a copy
   * could spend them first. The mint says so at the first connection, the
   * payment is marked failed, and the person is told (`onCardKeptLost`).
   *
   * One switch: CARD_OFFLINE. Off, a till with no route refuses a card as it
   * always did and does not speak to it. It does not touch what is already
   * kept, which is settled whatever it says, nor the cards' dates, nor a till
   * with a route. Plain ecash between two offline phones stays as
   * `OFFLINE_TO_OFFLINE` has it. */
  var CARD_OFFLINE = true;
  // the refusal of a piece too near its date, said where this phone has no route
  var CARD_OFFLINE_NEAR = 'This card’s money runs out in less than 7 days, so this phone cannot take it while offline. Its owner renews it by tapping it on their phone.';

  function cardOffline(on) {
    if (on !== undefined) CARD_OFFLINE = !!on;
    return CARD_OFFLINE;
  }

  /* The question a card taken on trust was once asked under (the HIGH RISK
   * card). No screen asks it now, since a card proves its money and signs it to
   * this phone; it stays for a screen that still calls it. No screen means no.
   * Resolves true only for a yes. */
  function cardOfflineAsk(sats) {
    var ask = FoxyWallet._onOfflineOffer;
    if (!CARD_OFFLINE || typeof ask !== 'function') return Promise.resolve(false);
    var asked;
    try { asked = ask({ sats: Math.round(Number(sats) || 0), id: 'card', purpose: 'card', scanned: true }); }
    catch (e) { return Promise.resolve(false); }
    return Promise.resolve(asked).then(function (yes) { return yes === true; }, function () { return false; });
  }

  /* The kept card payments, as stored (`CARD_KEPT`). */
  function cardKeptAll() {
    var l = load(CARD_KEPT, []);
    return Array.isArray(l) ? l.filter(function (r) { return r && typeof r.id === 'string'; }) : [];
  }
  function cardKeptRow(id) {
    return cardKeptAll().filter(function (r) { return r.id === id; })[0] || null;
  }
  // a record whose payment is over, one way or the other
  function cardKeptOver(r) { return !!r && r.state !== 'kept' && r.state !== 'posting'; }
  /* One record written, in place of the one with its id. Records that are over
   * and older than CARD_KEPT_KEEP_MS fall out as it is; one that is waiting
   * never does. Throws where the write does not land. */
  function cardKeptPut(rec) {
    var old = Date.now() - CARD_KEPT_KEEP_MS;
    var rest = cardKeptAll().filter(function (r) {
      return r.id !== rec.id && !(cardKeptOver(r) && (Number(r.endedAt) || Number(r.at) || 0) < old);
    });
    mustSave(CARD_KEPT, rest.concat([rec]));
  }
  // the same, where a write that does not land is said and not thrown: the record is a note on the row, which carries on
  function cardKeptNote(rec) {
    try { cardKeptPut(rec); } catch (e) { console.warn('[foxy] card: a kept payment’s record could not be written:', (e && e.message) || e); }
  }
  /* One record, as a copy: what the screens may read and not change. */
  function cardKept(id) {
    var r = cardKeptRow(String(id || ''));
    return r ? JSON.parse(JSON.stringify(r)) : null;
  }
  /* What a kept record is worth, in its own unit: `amount` where it says (every record from dollar cards on), `sats` on one
   * written before. */
  function cardKeptAmt(r) {
    if (!r) return 0;
    var n = r.amount != null ? satsOf(r.amount) : satsOf(r.sats);
    return isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  /* The card payments waiting for the mint: kept, or being posted. Each in its own unit: `amount`, and `sats` for a bitcoin
   * card's (0 for a dollar card's). */
  function cardKeptWaiting() {
    return cardKeptAll().filter(function (r) { return !cardKeptOver(r); }).map(function (r) {
      var u = recordUnit(r), n = cardKeptAmt(r);
      return { id: r.id, unit: u, amount: n, sats: u === 'sat' ? n : 0, date: Number(r.dates && r.dates.first) || 0, state: r.state, at: Number(r.at) || 0 };
    });
  }

  /* The signed pieces, kept for the mint. They were written down as TAKEN
   * first, as for any payment (the card has burned them, and this is the only
   * copy), and each step after that is written before the next:
   *   1. the pieces are held to the mint's keys, as any ecash is (`dleqAudit`);
   *   2. the record of the whole swap (CARD_KEPT);
   *   3. the row of the unclaimed store, which counts it in the balance;
   *   4. the entry, received and settled, as a held payment's is: the money is
   *      this phone's alone now, and the swap at the next connection is
   *      bookkeeping unless a copy of the card got there first;
   *   5. what a wallet that holds dollars owes itself in dollars, where it does;
   *   6. the TAKEN row struck off.
   * Something that fails before 3 leaves the TAKEN row, which `cardSettle` posts
   * as an ordinary card payment once there is a route: money is never lost. A
   * record written at 2 whose row at 3 did not land is struck again before the
   * error goes on, so that it does not wait for a row that will never come (and
   * where even that does not land, `cardKeptTidy` finds it). Nothing after 3
   * throws. The swap's own row (CARD_SWAPS) stays: it is what
   * makes the signed pieces this phone's to post (`cardSwapFor`). */
  function cardKeepSigned(row, signed, card, w, o) {
    var opts = o || {};
    if (dleqAudit(w, signed).invalid) {
      throw cardError('bad-pieces', 'The card gave pieces the mint did not sign. Nothing was taken.', { id: row.id });
    }
    var planId = String(row.id).slice(5);
    var copy = row.swapCopy || null;
    var spec = (copy && copy.spec) || cardSwapRow(planId);
    var outs = (copy && Array.isArray(copy.outputs)) ? copy.outputs : null;
    if (!spec) console.error('[foxy] card: a payment kept offline has no swap on file; it is kept, and its swap is the TAKEN row’s to find');
    else if (!outs) console.warn('[foxy] card: a payment kept offline was kept without its outputs; the swap is set out again from its counter');
    var first = 0, last = 0;
    (signed || []).forEach(function (p) {
      var parts = cardSecretParts(p && p.secret);
      var d = parts ? Number(parts.date) || 0 : 0;
      if (d && (!first || d < first)) first = d;
      if (d > last) last = d;
    });
    // in the card's own unit (the wallet's: `cardWalletFor`), cents for a dollar card
    var unit = recordUnit(w);
    var worth = Math.round(Number(row.worth) || 0);
    var asked = cardRowAmt(row);
    if (worth !== asked) {
      console.warn('[foxy] card: a payment kept offline comes to ' + cardSaid(worth, unit) + ' for ' + cardSaid(asked, unit) + ' asked; ' + cardSaid(worth, unit) + ' is what this phone will hold');
    }
    var fee = swapFeeFor(w, signed);
    var rec = {
      id: row.id, at: Date.now(), state: 'kept',
      card: card.key, format: card.info.format, software: String(card.info.version || ''),
      // the figure is `amount` in the record's unit; `sats` is the same for a bitcoin card, and 0 for a dollar one
      mint: mintOf(w), unit: unit, amount: worth,
      sats: unit === 'sat' ? worth : 0, asked: asked, fee: (isFinite(fee) && fee > 0) ? fee : 0, sum: sumProofs(signed),
      request: { inputs: signed, outputs: (outs || []).map(function (x) { return { amount: satsOf(x.amount), id: spec ? spec.keyset : '', B_: String(x.B_) }; }) },
      swap: spec ? { keyset: spec.keyset, counter: Number(spec.counter), amounts: (spec.amounts || []).slice(), digest: spec.digest } : null,
      dates: { first: first, last: last },
      refundKey: (card.record && card.record.refundKey) || '',
      proven: Math.round(Number(card.offlineProven) || 0),
      clock: { phone: Math.floor(Date.now() / 1000), used: cardOfflineNow(card, true) },
      cacheAt: (mintCacheFor(mintUrl) || {}).at || 0,
      tries: 0, triedAt: 0, why: '', endedAt: 0,
      terms: opts.terms || null,
    };
    cardKeptPut(rec);
    try {
      if (!unclaimed()[row.id]) keepUnclaimed(row.id, row.token, worth, false, false, unit, { card: card.key, cardKept: true, date: first });
    } catch (eRow) {
      try { mustSave(CARD_KEPT, cardKeptAll().filter(function (r) { return r.id !== row.id; })); }
      catch (eStrike) { console.warn('[foxy] card: a kept payment’s record outlived its row; the next settling sets it right'); }
      throw eRow;
    }
    /* Whether a wallet that holds just the other unit takes this in that unit once it has settled (08c-units.js): sats paid to
     * one that holds dollars, or dollars paid to one that holds bitcoin. Decided before the entry is written, so that the entry
     * says so from the first, as a request's does. `opts.kept`: the till's person picked this receive's unit for it (the app's
     * `recvPicked`), so what is paid in it stays in it, as a request's `kept` does. */
    var owes = false;
    try {
      var p = { id: row.id, unit: unit, mint: mintOf(w), purpose: 'card-offline', terms: opts.terms || null, kept: opts.kept === true };
      owes = convertDue(p) && convertOwe(p, worth);
    } catch (eConv) { console.warn('[foxy] card: a payment kept offline was not set to be swapped into the unit held:', (eConv && eConv.message) || eConv); }
    try {
      // the figures in the record's unit (`unitRow` puts a dollar card's under `amount`, with sats 0)
      var entry = /** @type {any} */ (unitRow(unit, { dir: 'in', sats: worth, feeSats: 0, settled: true, state: 'success', memo: 'card, offline', card: card.key,
                                                      cardKept: 'waiting', cardDate: first, hash: 'req-' + row.id }));
      // what was asked in the other unit, and at whose price (08c-units.js)
      if (opts.terms) Object.assign(entry, termsFields(opts.terms, unit));
      if (owes) entry.convert = 'owed';
      logTx(entry, 'req-' + row.id);
    } catch (eLog) { console.warn('[foxy] card: a payment kept offline was not written into history:', (eLog && eLog.message) || eLog); }
    try { mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && x.id === row.id); })); }
    catch (eT) { console.warn('[foxy] card: a payment kept offline is still in the TAKEN store; the first to post it settles it'); }
    console.log('[foxy] card: offline, ' + cardSaid(worth, unit) + ' signed over to this phone and kept, ' + rec.proven + ' piece(s) proved; to be swapped in at the first connection');
    return { unit: unit, amount: worth, sats: unit === 'sat' ? worth : 0, hash: 'req-' + row.id, date: first };
  }

  /* ---- settling a kept card payment (from `claimUnclaimed`) -------------------
   *
   * The unclaimed row is walked as any other, and three calls tell this store
   * what became of it. `cardKeptPost(id)`, before the swap is asked for:
   * 'post' (the record now says `posting`, with one more try), or 'drop' for a
   * row whose payment is over already, which the walk lets go of unposted. The
   * swap's own row is put back first where it has gone, since `receiveToken`
   * posts the pieces only for the outputs on it. Posting a record found in
   * `posting` (a crash while the mint was asked) again is safe: the request is
   * the same, and the mint either makes it or says the pieces are spent, which
   * is then found to be this phone's own doing (`cardKeptFailed`). */
  /* The order the walk takes unclaimed rows in, after those taken on trust: a
   * card's kept payments first, the nearest date first (its owner may take it
   * back after it), the undated after them, and every other row after those,
   * which are locked to this phone and have no date to race. */
  function cardKeptOrder(a, b) {
    var ka = !!(a && a.cardKept), kb = !!(b && b.cardKept);
    if (ka !== kb) return ka ? -1 : 1;
    if (!ka) return 0;
    var da = Number(a.date) || Infinity, db = Number(b.date) || Infinity;
    return da === db ? 0 : (da < db ? -1 : 1);
  }

  function cardKeptPost(id) {
    var rec = cardKeptRow(id);
    if (!rec) return 'post';
    if (cardKeptOver(rec)) return 'drop';
    var planId = String(id).slice(5);
    try {
      if (rec.swap && !cardSwapRow(planId)) {
        mustSave(CARD_SWAPS, cardStore(CARD_SWAPS).concat([{ id: planId, keyset: rec.swap.keyset, counter: rec.swap.counter,
                                                              amounts: rec.swap.amounts, digest: rec.swap.digest, at: rec.at, unit: recordUnit(rec) }]), true);
        console.warn('[foxy] card: a payment kept offline had lost its swap’s row; put back from its record');
      }
    } catch (eS) { console.warn('[foxy] card: a kept payment’s swap could not be put back:', (eS && eS.message) || eS); }
    rec.state = 'posting';
    rec.tries = (Number(rec.tries) || 0) + 1;
    rec.triedAt = Date.now();
    cardKeptNote(rec);
    return 'post';
  }

  /* The mint swapped it: this phone's money, and the entry that said waiting
   * says settled. Its swap's row goes, if `receiveToken` has not let it go, and
   * so does a TAKEN row of the same pieces left by a tap cut off before it was
   * struck: posted, that would be the same money in a second entry.
   *
   * `claim`: found settled anywhere but the walk's own success block (an answer
   * found again, a restore, a tidy), which is where a wallet that holds dollars
   * otherwise claims what landed for the swap into dollars (20-helpers.js). */
  function cardKeptSettled(id, got, claim) {
    var rec = cardKeptRow(id);
    if (rec) {
      rec.state = 'settled';
      rec.why = '';
      rec.endedAt = Date.now();
      cardKeptNote(rec);
    }
    try { amendTx('req-' + id, { cardKept: 'settled' }); } catch (e) {}
    cardSwapDrop(String(id).slice(5));
    cardKeptStrikeTaken(id);
    // `got`: what landed, in the record's own unit (cents for a dollar card's: `receiveToken` answers `amount` for either)
    var u = recordUnit(rec);
    var n = Math.round(Number(got) || 0) || cardKeptAmt(rec);
    if (claim) {
      try {
        if (convertClaimed(id, n, (rec && rec.mint) || mintUrl, null, u)) {
          amendTx('req-' + id, Object.assign({}, (convertRec(id) || {}).ask || {}, { convert: 'claimed' }));
          convertTell(id);
        }
      } catch (eC) { console.warn('[foxy] card: a kept payment settled, and its swap into the unit held could not be set:', (eC && eC.message) || eC); }
    }
    console.log('[foxy] card: a payment kept offline is settled: ' + cardSaid(Math.round(Number(got) || 0), u));
  }

  /* A TAKEN row with a kept payment's id: the tap's own copy, which `cardKeepSigned` strikes as its last step. Found
   * still there, the kept record is the payment's, and that copy is struck. */
  function cardKeptStrikeTaken(id) {
    try {
      var all = cardStore(CARD_TAKEN);
      if (all.some(function (x) { return x && x.id === id; })) {
        mustSave(CARD_TAKEN, all.filter(function (x) { return !(x && x.id === id); }));
        console.warn('[foxy] card: a kept payment’s TAKEN copy was still there; struck, the kept payment is the one');
      }
    } catch (e) { console.warn('[foxy] card: a kept payment’s TAKEN copy could not be struck:', (e && e.message) || e); }
  }

  /* Kept payments put right by what else is on file, where a step that should have moved them did not land (a page
   * gone between two writes, a write refused): run before the walk that settles them and before TAKEN rows are posted.
   *
   *   A TAKEN row of the same id next to a kept payment that has its row, or that is over: the kept payment is the
   *   one, and the TAKEN copy goes (posted, the same money would be in two entries).
   *   Waiting with no row in the unclaimed store:
   *     with its TAKEN row: it never got as far as its row, the TAKEN row is the payment, and the record goes;
   *     its entry saying how it ended: the record follows the entry;
   *     its pieces swapped by this phone (`takenBefore`): settled;
   *     anything else: its row is put back from the record, which holds the whole request, and the walk settles it. */
  function cardKeptTidy() {
    var rows = unclaimed();
    var taken = cardStore(CARD_TAKEN);
    var log = load(K.log, []);
    cardKeptAll().forEach(function (rec) {
      var id = rec.id;
      var hasTaken = taken.some(function (x) { return x && x.id === id; });
      try {
        if (cardKeptOver(rec) || rows[id]) { if (hasTaken) cardKeptStrikeTaken(id); return; }
        if (hasTaken) {
          mustSave(CARD_KEPT, cardKeptAll().filter(function (r) { return r.id !== id; }));
          console.warn('[foxy] card: a kept payment never got its row; its TAKEN row is the payment, and settles as one');
          return;
        }
        var entry = (Array.isArray(log) ? log : []).filter(function (x) { return x && x.hash === 'req-' + id; })[0] || null;
        var said = entry ? String(entry.cardKept || '') : '';
        if (said === 'settled' || ((said === 'spent' || said === 'retired' || said === 'unwound') && entry.state === 'failed')) {
          rec.state = said;
          rec.endedAt = rec.endedAt || Date.now();
          cardKeptNote(rec);
          console.warn('[foxy] card: a kept payment’s record had not been told it was ' + said + '; it is now');
          return;
        }
        var inputs = (rec.request && rec.request.inputs) || [];
        var mine = takenBefore(inputs);
        // (the note of what was taken keeps its figure in the token's own unit, which is the record's)
        if (mine) { cardKeptSettled(id, mine.sats || cardKeptAmt(rec), true); return; }
        if (!inputs.length) return;
        var ru = recordUnit(rec);
        keepUnclaimed(id, encodeToken(rec.mint || mintUrl, inputs, ru), cardKeptAmt(rec), false, false, ru,
                      { card: rec.card, cardKept: true, date: Number(rec.dates && rec.dates.first) || 0 });
        console.warn('[foxy] card: a kept payment had lost its row; put back from its record, to be settled');
      } catch (e) { console.warn('[foxy] card: a kept payment could not be put right:', (e && e.message) || e); }
    });
  }

  // which kept payments have been said to be late in this session
  var cardKeptLate = /** @type {Object<string, boolean>} */ ({});

  /* Whether the mint has changed since the tap in a way the signed swap cannot
   * follow: the keyset of its outputs gone, or a fee on its pieces other than
   * the one it was set out with. Asked of a wallet that has the mint's own word
   * (not one built from storage). */
  function cardKeptChanged(rec, w) {
    if (!w || !rec || !rec.request) return false;
    try {
      if (rec.swap && !keysetFor(w, rec.swap.keyset)) return true;
      var fee = swapFeeFor(w, rec.request.inputs || []);
      return isFinite(fee) && fee !== (Number(rec.fee) || 0);
    } catch (e) { return false; }
  }

  /* Whether the swap of a kept payment was made at the mint after all, by
   * this phone (an answer lost) or by anybody holding a copy of the request:
   * the outputs it was signed for are this phone's, from its seed, and are
   * asked for by their counters (NUT-09). Where the mint has signed every one
   * of them it was made; those of them that are unspent and held nowhere here
   * are put in the pile (none, where a restore has already done it). Resolves
   * { made, unit, amount, sats, added } in the record's unit (`sats` for a bitcoin record only), and rejects where the
   * mint could not be asked. */
  function cardKeptFind(rec) {
    var s = rec && rec.swap;
    var u = recordUnit(rec);
    var none = function () { return Object.assign(cardGot(u, 0), { made: false, added: 0 }); };
    if (!s || !Array.isArray(s.amounts) || !s.amounts.length) return Promise.resolve(none());
    // asked of the wallet of the record's unit, which is the one its outputs were made on (a dollar card's: the dollar wallet)
    return cardWalletFor(u, need(), false).then(function (w) {
      return restoreRanges(w, [{ keysetId: s.keyset, start: Number(s.counter), count: s.amounts.length }], 'a card payment kept offline', 1000)
        .then(function (rows) {
          var found = [];
          rows.forEach(function (r) { found = found.concat(r.proofs || []); });
          if (found.length < s.amounts.length) return Promise.resolve(none());
          return liveUnheld(w, found).then(function (live) {
            if (live.length) addProofs(live, mintOf(w), w, u);
            // in the record's unit, under its names: what is known of the swap, read by `cardKeptFailed` alone
            return Object.assign(cardGot(u, sumProofs(found)), { made: true, added: sumProofs(live) });
          });
        });
    });
  }

  /* The mint did not swap a kept payment. Resolves null; the walk goes on.
   *
   *   Not an answer about the pieces (no route, the mint silent or busy, a
   *   request never sent): back to `kept`, tried again at the next connection,
   *   and said once a session to be late when its date is near.
   *   The swap cannot be set out as signed, on a wallet built from storage: the
   *   same, until the mint has been asked for its keys.
   *   The swap cannot be set out, or is refused, by a mint whose keys or fee
   *   have changed since: `retired`. The mint will never take that signature.
   *   The mint says the outputs' keyset is inactive or unknown: `retired`.
   *   (Those words from this phone's own library, setting the swap out, are not
   *   the mint's: they go with the two rules above.)
   *   The pieces spent: first, whether that was this phone (a lost answer, or
   *   a copy of the request posted elsewhere, which makes this phone's own
   *   outputs): `settled`. Otherwise `spent`, or `unwound` from just before its
   *   date, when the card's owner may take them back.
   *   The mint refuses the card's signature: over (`unwound` from just before
   *   its date, when some mints stop honouring the card's key, else `retired`),
   *   said as the signature and not as the mint's keys or the owner.
   * A payment that is over is written down (`cardKeptEnd`).
   *
   * A row with no record (the store lost) is held to the same rules with a
   * record made from the row, so that it ends as any other does and is not
   * counted in the balance for good. */
  function cardKeptFailed(id, one, e, text) {
    var rec = cardKeptRow(id);
    var why = String((e && (e.message || e.detail)) || e || '');
    if (!rec) {
      var info = null;
      try { info = FoxyWallet.tokenInfo(text); } catch (eT) { info = null; }
      console.warn('[foxy] card: a payment kept offline has no record; one is made from its row (' + why.slice(0, 60) + ')');
      // in the row's unit (its token's): a dollar card's is cents, under `amount`
      var lostUnit = unitOf((one && one.unit) || (info && info.unit)) || 'sat';
      var lostAmt = Math.round(Number(one && (one.amount || one.sats)) || 0);
      rec = { id: id, at: Date.now(), state: 'kept', card: String((one && one.card) || ''), mint: (info && info.mint) || mintUrl, unit: lostUnit,
              amount: lostAmt, sats: lostUnit === 'sat' ? lostAmt : 0, request: { inputs: (info && info.proofs) || [], outputs: [] },
              swap: null, dates: { first: Number(one && one.date) || 0, last: Number(one && one.date) || 0 },
              tries: 1, triedAt: Date.now(), why: '', endedAt: 0, terms: null };
    }
    var now = Math.floor(Date.now() / 1000);
    var first = Number(rec.dates && rec.dates.first) || 0;
    var code = Number(e && (e.code || (e.response && e.response.code))) || 0;
    var late = function () {
      rec.state = 'kept';
      rec.why = why.slice(0, 120);
      cardKeptNote(rec);
      console.warn('[foxy] card: a payment kept offline is not settled yet (' + why.slice(0, 80) + '); tried ' + rec.tries + ' time(s)');
      if (first && now >= first - CARD_KEPT_WARN && !cardKeptLate[id]) {
        cardKeptLate[id] = true;
        cardKeptTell(cardKeptSays(rec, { id: id, cause: 'late', date: first }));
      }
      return null;
    };
    var ours = function (sats) {
      cardKeptSettled(id, sats, true);
      dropUnclaimed(id);
      return null;
    };
    /* The swap was found at the mint as this request went unanswered, and restored: made, and this phone's. (Belt and
     * braces: posted again, the same request is spent and found to be this phone's by `takenBefore` below; this only
     * spares that round trip.) */
    if (e && e.recovered) return Promise.resolve(ours(cardKeptAmt(rec)));
    var spent = /already spent|nothing to take|token already|already claimed/i.test(why) || code === 11001 || notIssued(e) || !!(e && e.foxyMine);
    if (spent) {
      var mine = takenBefore((rec.request && rec.request.inputs) || []);
      if (mine) return Promise.resolve(ours(mine.sats || cardKeptAmt(rec)));
      return Promise.resolve().then(function () { return FoxyWallet.recoverSwaps(); }).then(null, function () { return null; })
        .then(/** @returns {Promise<any>} */ function () {
          var again = takenBefore((rec.request && rec.request.inputs) || []);
          if (again) return Promise.resolve({ made: true, sats: again.sats || cardKeptAmt(rec) });
          return cardKeptFind(rec);
        }).then(function (found) {
          if (found && found.made) {
            console.log('[foxy] card: the mint had made a kept payment’s swap already; it is this phone’s');
            return ours(cardKeptAmt(rec));
          }
          var back = first > 0 && now >= first - cardOwnMargin();
          return cardKeptEnd(id, rec, back ? 'unwound' : 'spent', why);
        }, function (eFind) {
          // the mint could not say whose the swap was: nothing is decided on that
          why = why + ' (and its outputs could not be asked about: ' + String((eFind && eFind.message) || eFind).slice(0, 60) + ')';
          return late();
        });
    }
    /* The mint's own answer, and not this phone's library failing to set the swap out (`noCounters`), whose words can
     * name a keyset too ("Could not resolve unknown keyset"): only the mint's answer ends a payment by its words. The
     * library says a mint's 12001 and 12002 as a stale keyset. */
    var mintSaid = !(e && e.noCounters) && (code >= 10000 || mintRefused(e) || !!(e && e.name === 'StaleKeysetError'));
    if (code === 12001 || code === 12002 || (mintSaid && (/stale keyset/i.test(why) || (/keyset/i.test(why) && /inactive|unknown|not found/i.test(why))))) {
      return Promise.resolve(cardKeptEnd(id, rec, 'retired', why));
    }
    if (mintSaid && /signature|witness|locktime/i.test(why)) {
      return Promise.resolve(cardKeptEnd(id, rec, (first > 0 && now >= first - cardOwnMargin()) ? 'unwound' : 'retired', 'signature: ' + why, 'signature'));
    }
    /* The mint's fee or keys changed since the tap. Not decided by a wallet built from storage, whose keys may be old: the
     * real connect says. Seen either by this wallet's own keys (the swap could not be set out as signed, or the fee on the
     * pieces is not what it was), or by the mint refusing the swap as not adding up, which a request whose pieces and
     * outputs are both fixed by a signature never will again (NUT error 11002). */
    var cached = false;
    try { cached = FoxyWallet.fromCache(); } catch (eC) { cached = false; }
    var unbalanced = code === 11002 || /do not balance|not balanced|unbalanced/i.test(why);
    if (!cached && (unbalanced || (((e && e.noCounters) || mintRefused(e)) && cardKeptChanged(rec, wallet)))) {
      return Promise.resolve(cardKeptEnd(id, rec, 'retired', 'the mint\u2019s keys or fee changed: ' + why));
    }
    return Promise.resolve(late());
  }

  /* A kept payment that is over without being settled: the record says how,
   * the entry turns failed (it was received; it is not), the row, the swap's row
   * and any TAKEN copy go, and the person is told.
   *
   * What the payment was counted for is undone with it. A wallet that holds
   * dollars owed itself its swap into dollars: kept as it is, with why, since
   * nothing came to swap. A share of a split bill it paid was ticked at the tap
   * (its entry was received): open again, with nothing paid on it, and its
   * invoice can be paid as before. `kind`: 'signature' where the mint refused
   * the card's signature, which is said as that. */
  function cardKeptEnd(id, rec, state, why, kind) {
    var first = Number(rec.dates && rec.dates.first) || 0;
    rec.state = state;
    rec.why = String(why || '').slice(0, 160);
    rec.endedAt = Date.now();
    cardKeptNote(rec);
    try {
      // in the record's unit (`unitRow`: a dollar card's under `amount`, with sats 0)
      var failed = /** @type {any} */ (unitRow(recordUnit(rec), { dir: 'in', sats: cardKeptAmt(rec), feeSats: 0, settled: false, state: 'failed', memo: 'card, offline — not settled', card: rec.card,
                                                                cardKept: state, cardDate: first, hash: 'req-' + id }));
      if (kind) failed.cardWhy = kind;
      logTx(failed, 'req-' + id);
    } catch (e) {}
    dropUnclaimed(id);
    cardSwapDrop(String(id).slice(5));
    cardKeptStrikeTaken(id);
    try {
      var cv = convertRec(id);
      if (cv && cv.state === 'owed') {
        cv.state = 'kept';
        cv.why = state;
        putConvert(cv);
        amendTx('req-' + id, { convert: 'kept', convertWhy: state });
      }
    } catch (eC) { console.warn('[foxy] card: a kept payment that did not settle; its swap into dollars could not be let go:', (eC && eC.message) || eC); }
    var shares = [];
    try {
      var bill = load(K.split, null);
      if (bill && Array.isArray(bill.rows)) {
        bill.rows.forEach(function (r, i) { if (r && r.card === 'req-' + id) { r.paid = false; delete r.card; shares.push(i); } });
        if (shares.length) { delete bill.done; mustSave(K.split, bill); }
      }
    } catch (eS) { console.warn('[foxy] card: a kept payment that did not settle; the share of the bill it paid could not be opened again:', (eS && eS.message) || eS); }
    console.warn('[foxy] card: a payment kept offline did not settle (' + state + (kind ? ', ' + kind : '') + '): ' + cardSaid(cardKeptAmt(rec), recordUnit(rec))
      + (shares.length ? '; ' + shares.length + ' share(s) of the bill open again' : ''));
    var told = /** @type {any} */ (cardKeptSays(rec, { id: id, cause: state, date: first }));
    if (kind) told.why = kind;
    if (shares.length) told.shares = shares;
    cardKeptTell(told);
    return null;
  }

  /* What the screen is told of a kept payment that did not settle, or is late: its figure in its own unit (`amount`, `unit`),
   * and `sats` as it always was for a bitcoin card's (0 for a dollar card's). */
  function cardKeptSays(rec, info) {
    var u = recordUnit(rec), n = cardKeptAmt(rec);
    return Object.assign({ unit: u, amount: n, sats: u === 'sat' ? n : 0 }, info);
  }

  function cardKeptTell(info) {
    if (typeof FoxyWallet._onCardKeptLost !== 'function') return;
    try { FoxyWallet._onCardKeptLost(info); } catch (x) { console.warn('[foxy] card-kept-lost watcher:', x && x.message); }
  }

  /* A payment the card left part way through is HELD, not given back at once.
   *
   * The pieces it signed before it left are the start of that same payment:
   * they stay in CARD_TAKEN as a refund row with `resume` ({ want }), and the
   * card's next tap here for the same amount signs only the rest (`cardTake`),
   * and the two are swapped as one payment. They used to be given back at once,
   * which took a second tap to write them back and left the card short until
   * then, even when the person tapped again straight away to pay the same thing.
   *
   * A held payment is let go (`cardHeldRelease`: it becomes the refund row it
   * always was, given back by `cardReturn` now, or by the next settling where
   * there is no route) when the person cancels it, when the card pays another
   * amount here, or when CARD_RESUME_MS have passed (`cardSettle` leaves a
   * fresh one alone, and lets an old one go). */
  var CARD_RESUME_MS = 3 * 60 * 1000;
  function cardHeld(key) {
    return cardStore(CARD_TAKEN).filter(function (r) { return r && r.resume && r.card === key; })[0] || null;
  }
  function cardHeldFresh(r) {
    return !!(r && r.resume && Date.now() - (Number(r.at) || 0) < CARD_RESUME_MS);
  }
  function cardHeldProofs(r) {
    try { return ((FoxyWallet.tokenInfo(r.token) || {}).proofs) || []; } catch (e) { return []; }
  }
  function cardHeldRelease(r, w) {
    var plain = {};
    Object.keys(r).forEach(function (k) { if (k !== 'resume') plain[k] = r[k]; });
    mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).map(function (x) { return (x && x.id === r.id) ? plain : x; }));
    console.log('[foxy] card: a payment it left part way through is let go; what it signed goes back to it');
    // in the row's unit: `amount`, and `sats` for a bitcoin card's only
    var u = cardRowUnit(r);
    if (!w || !routeOpen()) return Promise.resolve(Object.assign(cardGot(u, Number(r.worth) || 0), { made: false }));
    return cardReturn(plain, null, w, null).then(function (made) {
      return Object.assign(cardGot(u, cardMade(made)), { made: !!made });
    }, function () { return Object.assign(cardGot(u, 0), { made: false }); });
  }

  /* The card as a holder's own taking-off leaves it, for the screen that has to show it. The card is let go as soon as it has signed and
   * is not read again, so this is what was read at the start of the tap, less the pieces it signed for (their places are spent now).
   * A limit that was lifted and put back begins the day again (`cardUnderPin`): nothing of it is spent, the no-PIN allowance's count goes
   * with it, and the day turns 24 hours on from the card's own clock. Change made for the card and anything else that goes on it later
   * is not in it: the card's next tap shows that. Null for a read that does not list the pieces whole (`bare`). */
  function cardAfterTake(card, nonces, lifted) {
    if (!card || card.bare || !Array.isArray(card.pieces) || !card.info) return null;
    // (a card of 1.23 paid from as one unit, `cardInUnit`: the whole card after it, both units)
    if (card.whole) card = card.whole;
    var gone = {};
    (nonces || []).forEach(function (n) { if (n) gone[n] = true; });
    var left = card.pieces.filter(function (x) { return !(x && gone[x.nonce]); });
    var info = Object.assign({}, card.info, { unspent: left.length, spent: card.info.spent + (card.pieces.length - left.length) });
    if (lifted && Number(info.limit) > 0) {
      info.windowStart = info.now;
      info.spentToday = 0;
      info.noPin = Object.assign({}, info.noPin, { spent: 0 });
    }
    var after = Object.assign({}, card, {
      info: info, pieces: left, balance: left.reduce(function (n, x) { return n + x.amount; }, 0),
      slots: (card.slots || []).map(function (x) { return (x && x.state === 'unspent' && gone[x.nonce]) ? { state: 'spent', i: x.i } : x; }),
      day: cardDayOf(info), noPin: cardNoPinOf(info),
    });
    if (after.units) { cardSortUnits(after); after.balance = after.units[after.record.unit === 'usd' ? 'usd' : 'sat'].balance; }
    return after;
  }

  /* Which unit a payment from a card of 1.23 is of (one unit a payment: the card refuses two, 6A9A). The card never chooses, and nor does
   * this phone where both could pay: the holder is asked every time (the owner's answer: always ask), on the app's own currency question,
   * and the payment is asked again with the unit chosen (`o.from`). Answers { unit } or { choose: [...] }:
   *   - `o.all` or a holder's own taking-off (`o.lift`): the unit named (`o.from`, `o.unit`), else the record's;
   *   - a payment: the units the till asks in that the card holds money of; where both cover what is asked, the holder chooses (a unit that
   *     cannot cover it is said short and not offered); where one covers, that one; where neither does, the one asked that the card holds,
   *     to say what it holds; and where the card holds none of what is asked, the unit it holds money of, which the till's own words for
   *     the other currency then take (`cardWrongUnit`: a dollar card asked for sats is offered the cents). */
  function cardPayUnit(card, asks, o) {
    var ru = card.record.unit === 'usd' ? 'usd' : 'sat';
    // (a unit named only where one is: `unitOf` takes none for sats)
    var says = function (u) { return (u === undefined || u === null || u === '') ? '' : ((unitOf(u) === 'usd' || unitOf(u) === 'sat') ? unitOf(u) : ''); };
    var named = (o.fromKey && o.fromKey !== card.key) ? '' : says(o.from);
    var held = ['usd', 'sat'].filter(function (u) { return card.units[u].balance > 0; });
    /* (all of a card with no unit named: the record's where it holds any, else the other's, so a card whose record's unit is empty and that
     * holds the other is emptied, renewed and reset all the same) */
    if (o.all && !named && !says(o.unit)) return { unit: (card.units[ru].balance > 0 || !held.length) ? ru : held[0] };
    if (o.all || (o.lift && !(asks[0] && asks[0].unit))) return { unit: named || says(o.unit) || ru };
    var asked = function (u) { return asks.filter(function (a) { return a.unit === u || a.unit === ''; })[0] || null; };
    var candidates = held.filter(function (u) { return !!asked(u); });
    if (named) return { unit: named };
    var covering = candidates.filter(function (u) { return card.units[u].balance >= asked(u).amount; });
    if (covering.length > 1) {
      return { choose: ['usd', 'sat'].map(function (u) { var a = asked(u); return { unit: u, balance: card.units[u].balance, amount: a ? a.amount : 0, short: !a || card.units[u].balance < a.amount }; }) };
    }
    if (covering.length === 1) return { unit: covering[0] };
    /* (none of what is asked covers it, and the card holds money of a unit the till did not ask in: that unit, which the till's own words for
     * the other currency then take, as for a card of that unit alone: a dollar card asked for sats is offered the cents, `cardWrongUnit`) */
    var unasked = held.filter(function (u) { return !asked(u); });
    if (unasked.length) return { unit: unasked[0] };
    if (candidates.length) return { unit: candidates.indexOf(ru) >= 0 ? ru : candidates[0] };
    return { unit: held.length ? held[0] : ru };
  }

  /* What a till asks a card for: one figure in each unit it will take, as [{ unit, amount, terms }]. `o.asks` where the screen
   * gives the list (a dollar receive that would take bitcoin as well, say, and the card's unit says which); otherwise the one
   * figure `o.sats` (or `o.amount`) in `o.unit` (sats when not named), which is every caller from before cards held dollars.
   * A taking-off of all of a card (`o.all`) asks for nothing: it is the card's own unit. So is a holder's own taking-off of
   * some of it (`o.lift`) that names no unit: its figure is in the card's unit, whatever that is (unit '', taken as the
   * card's). Throws `bad-amount` for a figure that is not above zero, or a unit asked twice. */
  function cardAsks(o) {
    if (o.all) return [];
    var given = (Array.isArray(o.asks) && o.asks.length) ? o.asks
      : [{ unit: (o.lift && !o.unit) ? '' : o.unit, amount: o.amount !== undefined && o.amount !== null ? o.amount : o.sats, terms: o.terms }];
    var seen = {};
    return given.map(function (a) {
      var u = (a && a.unit === '') ? '' : (unitOf(a && a.unit) || 'sat');
      var n = Math.round(Number(a && a.amount));
      if (!(n > 0) || seen[u]) throw cardError('bad-amount', 'Ask for an amount above zero.');
      seen[u] = true;
      return { unit: u, amount: n, terms: (a && a.terms) || null };
    });
  }

  /* The one flow behind being paid by a card and emptying one (21a-flashcard.js). */
  function cardTake(link, o, memo) {
    // `info`: what a step is about, where the screen needs it (the payment's entry, for a step after the card has signed)
    var on = function (step, info) { try { if (typeof o.on === 'function') o.on(step, info); } catch (e) {} };
    /* The PIN is optional: a card of software 1.16 has none, or pays without it within its no-PIN allowance. A payment made with
     * no PIN (`o.pin` absent) shows the card none; where the card will not sign without it, the read says so before anything is
     * asked of the card, or the card says so at its signature (6A94), and both are `pin-needed` with nothing pending (see
     * `cardNeedsPin`): the PIN is asked of the person, and the card is tapped again. */
    var pin;
    try { pin = (o.pin === undefined || o.pin === null || o.pin === '') ? '' : cardPinHex(o.pin); } catch (e) { return Promise.reject(e); }
    /* What is asked, in each unit the till takes (`cardAsks`). Which of them is paid is the card's to say: its unit is known only
     * once it is read, and the figure in that unit is `want`, in the card's own unit from then on (cents for a dollar card). */
    var asks;
    try { asks = cardAsks(o); } catch (eAsk) { return Promise.reject(eAsk); }
    var want = 0, ask = null, cu = 'sat';
    /* `o.holdFor`: the card is paying out of this phone (SEND from the card's own screen, 26f-flashcard.js), and what it pays
     * is not this phone's to keep. It is read as a till reads it, and the pieces the swap gives this phone are kept to one side
     * (`cardOutHold`) for the payment they are about to make, and for nothing else. Only a payment, with a route to the mint:
     * never all of a card, its owner's lifting of the limit, a tap held for a write after, or a payment kept with no route. */
    if (o.holdFor && (o.all || o.lift || o.hold || o.offline || o.trusted)) return Promise.reject(cardError('bad-amount', 'A card pays out of this phone only as a payment.'));
    var w;
    /* No route: refused, as it always was, unless this is a payment the screen
     * asked for with no route (`o.offline`; `o.trusted`, its old name, is the
     * same), which a card of one signature proves and signs over to this phone
     * (`cardOfflineProve`, `cardKeepSigned`). Never all of a card, its owner's
     * taking-off, a tap held for a write after, or a payment out of this phone. */
    var offline = !routeOpen();
    var offlineOk = CARD_OFFLINE && (o.offline === true || o.trusted === true) && !o.lift && !o.all && !o.holdFor && !o.hold;
    if (offline && !offlineOk) {
      try { need(); } catch (e2) { return Promise.reject(e2); }
      return Promise.reject(cardError('no-route', 'There is no connection to the mint, so the card was not asked for anything.'));
    }
    try { w = offline ? needLocal() : need(); } catch (e3) { return Promise.reject(e3); }
    // what the payment's kept record is told (`cardKeepSigned`): the terms of the ask the card pays, where it has its own
    var keepOpts = o;
    var t = cardTalk(link);
    var card, picked, worth, fee, row, result, own, cap, tapCap = null, lift = false, released = false, signedNonces = [];
    // the card as a holder's own taking-off leaves it (`cardAfterTake`), for the result and for a mint that has not answered
    var afterCard = null;
    // (a card of 1.23 that holds both units, all of it taken off: the unit still to take, `result.more`)
    var allOther = '';
    // a one-signature card (format 4): the signatures it is asked for, and rows beside this payment's own to swap with it
    var all4 = false, groups = [], moreRows = [], cheaper = null;
    // a card that makes a payment's change itself (software 1.12): it is asked to, for a payment made online (`cardOwnChangeCut`)
    var ownChange = false;
    // and one whose wait is shaped (1.13): nothing within the limit, and its change cut plainly in four pieces at the most
    var shaped = false;
    // and one that counts the change it made toward that wait for what it cost (1.14): two for every three pieces, and not one for each
    var costed = false;
    // a payment of this card's held from a tap cut short (`cardHeld`), and one held for another amount, let go after this one
    var held = null, heldProofs = [], heldWorth = 0, letGoAfter = null, tornSats = 0;
    on('reading');
    /* A till does not ask the card to prove its key (AUTH: the card's slowest
     * answer): it is about to be paid in pieces the card signs, and a signature
     * that is not good for the key in a piece's secret is refused below, before
     * anything is kept. A pretend card gets nothing from that, and the mint's
     * swap is what says paid. The holder's own phone reads it the full way: it
     * signs for the owner there. */
    /* Nor does the holder's own phone, taking money off: the signature it is
     * about to ask for is checked against the card's key before anything is
     * kept, which is the same proof and costs nothing more. (AUTH was most of
     * a second, and often two or three, at the start of every withdrawal.)
     * What is on the card is then not written down from this read
     * (`card.proved`); what it signs for is, as it always was. */
    return cardLook(link, { mine: !!o.lift, noAuth: true, brief: !o.lift && !o.all }).then(function (c) {
      card = c;
      /* `o.only`: the card the screen is for, by its key. Another card held to the phone is said to be another card here, before
       * any PIN or signature is asked of it (paying out of this phone from a card's screen pays from that card and no other). */
      if (o.only && card.key !== o.only) throw cardError('wrong-card', 'That is not the card on the screen. Nothing was taken from it.');
      // what is true of any card at this phone's mint, said before its unit is looked at: another mint, no dollars here
      var no0 = cardUnusable(card, w, null, true);
      if (no0) throw no0;
      /* A card of 1.23 pays from one unit (`cardPayUnit`): the holder chooses where both could pay, before any PIN, BEGIN or signature
       * (`choose-unit`, with the two balances and what is asked in each, for the screen's currency question). From here the card is that
       * unit (`cardInUnit`): its pieces and its balance are that unit's, and everything below is as for a card of one unit. */
      if (card.units) {
        var pu = cardPayUnit(card, asks, o);
        if (pu.choose) {
          throw cardError('choose-unit', 'This card holds dollars and bitcoin. Choose which pays.',
                          { units: pu.choose, key: card.key, pinSet: !!card.info.pinSet, noPinLeft: (card.noPin && card.noPin.left) || 0,
                            mint: canonicalMint(card.record.mint), cardUnit: card.record.unit === 'usd' ? 'usd' : 'sat' });
        }
        // all of a card that holds both, its other unit named for the next taking-off (`cardWithdraw` takes it in the same tap)
        var otherU = pu.unit === 'usd' ? 'sat' : 'usd';
        if (o.all && !o.from && !o.unit && card.units[otherU].balance > 0) {
          allOther = otherU;
          // the card is kept for that, in the same tap
          o = Object.assign({}, o, { hold: true });
        }
        card = cardInUnit(card, pu.unit);
      }
      /* The ask in the card's own unit: what it pays. With none, the card is told so before any PIN, BEGIN or signature (a
       * dollar card asked for sats only: `other-unit`, which the screen can turn into a figure in dollars for the holder to
       * agree to; a bitcoin card asked for dollars only: `wrong-unit`). */
      cu = card.record.unit;
      if (!o.all) {
        ask = asks.filter(function (a) { return a.unit === cu || a.unit === ''; })[0] || null;
        if (!ask) throw cardWrongUnit(cu, asks[0].unit, card);
        if (!ask.unit) ask = Object.assign({}, ask, { unit: cu });
        want = ask.amount;
        if (ask.terms) keepOpts = Object.assign({}, o, { terms: ask.terms });
      }
      /* A bitcoin card is paid with the sat wallet itself, at once, as ever; a dollar card with the dollar wallet, and with no
       * route only where this phone holds the mint's dollar keys already (nothing is asked of the mint for them, which with no
       * route is half a minute of nothing at a till). */
      if (cu === 'sat') return cardTook();
      if (offline && !unitKeysOffline(cu)) {
        throw cardError('offline-no-keys', 'This phone has not seen the mint\u2019s dollar keys yet, so it cannot check a dollar card while offline.', { cardUnit: cu });
      }
      return cardWalletFor(cu, w, offline).then(function (uw) { w = uw; return cardTook(); }, function (eW) {
        if (!offline) throw eW;
        // the wallet's own words: the seed not ready yet, or a mint that does not issue dollars (never "no route" for those)
        throw cardError('no-route', String((eW && eW.message) || 'This phone cannot take a dollar card while offline just now.'), { cardUnit: cu });
      });
      // the rest of the read, once `w` is the wallet of the card's unit (written at the depth it always was)
      function cardTook() {
      var no = cardUnusable(card, w, ask ? ask.unit : null);
      if (no) throw no;
      /* With no route, only a card that signs once for a payment and keeps the mint's proofs (software 1.20): the one
       * signature is what makes the payment this phone's alone, and the proofs are what say the money is the mint's. */
      if (offline && (!cardIsAll(card) || !(card.info && card.info.proofs))) {
        throw cardError('offline-old', 'This card is too old to pay a phone that is offline. Take this payment when this phone is online.');
      }
      /* And within what this phone holds before it settles (`tillRefusal`), said before any PIN, BEGIN or signature. A
       * card's payment counts toward what is held in all and toward no payer's own cap: the owner's rule is "when card
       * pays, it's safe" (the card proves its money and signs it to this phone), so it is held to the total alone. */
      if (offline && want > 0) {
        var capNo = tillRefusal(want, cu, '', true);
        if (capNo) throw cardError('till-full', capNo, { cardUnit: cu });
      }
      all4 = cardIsAll(card);
      ownChange = all4 && cardOwnChange(card) && !o.all && !offline;
      shaped = ownChange && cardIsShaped(card);
      costed = shaped && cardIsCosted(card);
      /* A signature this phone asked this card for and never saw, had again
       * (`cardAskedBack`). A payment's is held as a payment the card left part
       * way through always was: this tap finishes it if it is for the same
       * amount, and it goes back to the card if it is not (`cardHeld`). The
       * holder's own taking-off is theirs already, and is swapped with this one. */
      return cardAskedBack(t, card, pin).then(function (found) {
        found.forEach(function (f) {
          var a = f.spec.asked, id = 'card-' + f.spec.id;
          var sum = sumProofs(f.signed);
          var cost = swapFeeFor(w, f.signed);
          if (!isFinite(cost) || cost < 0) cost = 0;
          if (!cardStore(CARD_TAKEN).some(function (r) { return r && r.id === id; })) {
            var token = encodeToken(mintOf(w), f.signed, cu);
            // the change the card made for itself in that swap (software 1.12), which is not this phone's to give back and not a fee
            var madeBy = f.spec.change && Array.isArray(f.spec.change.outs) ? f.spec.change.outs.reduce(function (n, x) { return n + satsOf(x.amount); }, 0) : 0;
            // every figure in the card's unit, and the row's own under its unit's names (`cardFig`)
            var kept = a.all
              ? Object.assign({ id: id, token: token, worth: Math.max(0, sum - cost), over: 0, all: true, card: card.key,
                                memo: a.memo || memo, at: Date.now(), partial: true }, cardFig(cu, Math.max(0, sum - cost)))
              : Object.assign({ id: id, token: token, worth: sum, over: sum, all: false, card: card.key, memo: 'card, not completed',
                                at: Number(a.at) || Date.now(), refund: true, resume: { want: a.want, proved: !!a.proved }, cardChange: madeBy }, cardFig(cu, 0));
            mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).concat([kept]));
            if (a.all && (o.all || o.lift) && !offline) moreRows.push(kept);
          }
          cardSwapSettled(f.spec.id);
        });
      });
      }
    }).then(function () {
      own = cardMine(card);
      // this phone's own card, read and proved: what is on it now is written down, as at any other read
      if (own && card.proved) cardRemember(card, card.pieces, true);
      var usable = offline ? cardUsable(card, w, own, cardOfflineNow(card), true) : cardUsable(card, w, own);
      var have = usable.pieces;
      /* What a till may take is what is left of the card's day, read here and
       * not found out half-way: the PIN is not sent to a card that cannot cover
       * the payment. The holder's own phone (`o.lift`) lifts the limit, with
       * its proof, to take money off the card, and puts it back; a phone that is
       * not the card's owner is a till like any other. */
      var day = card.day;
      var tap = card.tap || cardTapOf(card.info);
      var turns = day.turns;
      lift = !!(o.lift && (day.limited || tap.limited) && card.mine);
      /* (1.23: the day and the tap are counted in cents; the pieces are chosen, and a payment refused, in the card's unit as it pays, so
       * what is left of each is turned back into it at the rate, rounded down, which is exactly what fits (`cardCeilBack`). A sats card
       * with no rate known here has no figure to be held to by this phone: the card's own word decides.) */
      var capBack = function (c) {
        if (c === null || c === undefined || !(card.info && card.info.cents)) return c;
        if (card.record.unit !== 'usd' && !(cardRateNow(card) > 0)) return null;
        return cardCeilBack(card, c);
      };
      cap = (day.limited && !lift) ? capBack(day.left) : null;
      /* From 1.12 the day is charged what leaves the card for good, the price and the mint's fee on the pieces, and not the pieces
       * whole: so no set is turned away for being worth more than the day has left, and the day is held to the price below. */
      var capSets = ownChange ? null : cap;
      /* And what is left of this tap, where the card has a limit on one: no
       * set of pieces may come to more, and one that would is not asked for.
       * It is not something a larger piece uses up for later, as the day is,
       * so a set chosen to keep the drawer whole is still chosen under it. */
      // a limit on one payment that is waited for caps nothing (`paced`): it is paid for in time, below
      tapCap = (tap.limited && !tap.paced && !lift) ? capBack(tap.left) : null;
      if (((day.limited && day.noTime) || (tap.limited && !tap.paced && tap.noTime)) && !lift) throw cardError('no-time', 'The card has not been told the time, and cannot spend under a limit until it has.');
      /* The same payment, taken up again: what the card signed for it before
       * it left counts, and only the rest is signed now. Held for another
       * amount, or too long ago, it is let go once this payment is done. */
      if (!o.lift && !o.all) {
        held = cardHeld(card.key);
        if (held && !(cardHeldFresh(held) && Number(held.resume.want) === want)) { letGoAfter = held; held = null; }
        heldProofs = held ? cardHeldProofs(held) : [];
        if (held && !heldProofs.length) { letGoAfter = held; held = null; }
        heldWorth = sumProofs(heldProofs);
      }
      var heldFee = heldProofs.length ? swapFeeFor(w, heldProofs) : 0;
      if (!isFinite(heldFee) || heldFee < 0) heldFee = 0;
      var rest = held ? want + heldFee - heldWorth : want;
      /* One signature is for the pieces it was given and no others: a payment
       * held from such a card is whole, or it is not this payment. */
      if (held && all4 && rest > 0) { letGoAfter = held; held = null; heldProofs = []; heldWorth = 0; heldFee = 0; rest = want; }
      if (held) console.log('[foxy] card: taking up a payment it left part way through: ' + heldWorth + ' of ' + want + ' sats signed, the rest now');
      /* With no route, a payment the card left part way through is taken up only where what it signed was proved here
       * before it was asked to (`proved`, on the row it was asked by). One begun while this phone was online was never
       * proved; what it signed stays held, and goes back to the card if it is not finished online. */
      if (offline && held && !(held.resume && held.resume.proved)) {
        throw cardError('offline-unproven', 'This card cannot prove to a phone that is offline what it signed before it was taken away. That goes back on it once this phone is online.',
                        { proven: 0, none: heldProofs.length, held: true });
      }
      /* A piece the card was signing as it left: it may have signed it and
       * marked it spent with the answer lost in the air. Then the piece is gone
       * from the card and its signature from everywhere: it can never be spent
       * (a card with a refund key: its owner's phone takes it back after its
       * date). Found here, by the piece not being on the card any more. */
      tornSats = 0;
      if (held && held.resume && Array.isArray(held.resume.torn)) {
        var stillOn = {};
        (card.pieces || []).forEach(function (x) { if (x && x.nonce) stillOn[x.nonce] = true; });
        held.resume.torn.forEach(function (tp) { if (tp && tp.nonce && !stillOn[tp.nonce]) tornSats += satsOf(tp.amount) || 0; });
        if (tornSats > 0) console.warn('[foxy] card: ' + cardSaid(tornSats, cu) + ' the card signed as it was taken away never reached this phone; that piece cannot be spent');
      }
      /* Offline, only an exact set: change cannot be made without a route, and
       * a till that paid it out of its own pile would lose the payment and the
       * change both to a payer who spent their copy. */
      var least = function (a, b) { return a === null ? b : b === null ? a : Math.min(a, b); };
      var choose = function (limit, one) {
        /* Overpaying the least, on a card that waits by what its pieces come
         * to: whether it has a limit to wait for is its owner's to know, so a
         * till chooses as if it had. */
        if (all4) return cardPickAll(w, have, rest, limit, card, one, offline, !!(tap.paced && !lift));
        return offline ? cardExactPick(w, have, rest, least(limit, one)) : cardPick(w, have, rest, limit, card, one);
      };
      if (o.all) {
        picked = have;
      } else if (held && rest <= 0) {
        // signed in full before it left after all: nothing more to sign, only the PIN to give again
        picked = [];
      } else {
        picked = choose(capSets, tapCap);
        /* A set chosen for the change it brings back has the cheapest set with it, for a card that would wait (`cardRefillPick`).
         * Not from 1.12: the wait is by what leaves the card, which is the same for both sets, and the cheapest makes change too. */
        // (never with no route: only the set that was proved may be signed)
        cheaper = (ownChange || offline) ? null : ((picked && /** @type {any} */ (picked).fallback) || null);
      }
      /* Taken up, and the card cannot make the rest (often because of a piece
       * lost as it left): the payment cannot be finished with this card, and
       * what it signed for it goes back to it now. */
      if (held && rest > 0 && (!picked || !picked.length)) {
        var heldNow = held;
        return cardHeldRelease(heldNow, offline ? null : w).then(function (back) {
          throw cardError('not-enough', 'The card holds ' + cardSaid(card.balance, cu) + ', and ' + (cu === 'sat' ? rest + ' of this payment were' : moneyWords(rest, cu) + ' of this payment was') + ' still to pay.'
            + (tornSats > 0 ? ' ' + cardSaid(tornSats, cu) + ' it signed as it was taken away never reached this phone.' : ''),
            { balance: card.balance, still: rest, held: heldWorth, torn: tornSats, letGo: back, cardUnit: cu });
        });
      }
      if (!(held && rest <= 0)) {
      if ((!picked || !picked.length) && (capSets !== null || tapCap !== null) && !o.all) {
        /* The least any set that pays this comes to, to say which limit it is
         * over: asked with a bound no card reaches, since with no bound at all
         * the set is the one that keeps the drawer whole, which may be larger
         * than the payment needs (and was then said to be over the day when
         * it was the tap it was over). */
        var free = all4 ? cardPickAll(w, have, rest, 281474976710655, card, null, offline)
          : (offline ? cardExactPick(w, have, rest, null) : cardPick(w, have, rest, 281474976710655, card, null));
        var need = (free && free.length) ? sumProofs(free) : 0;
        if (need > 0 && capSets !== null && need > capSets) {
          throw cardError('limit', 'This card can spend ' + cardSaid(cap, cu) + ' more today, and this payment needs more than that.',
                          { left: cap, need: need, turns: turns, limit: capBack(day.limit), cardUnit: cu });
        }
        if (need > 0 && tapCap !== null && need > tapCap) {
          throw cardError('tap-limit', 'This card can spend ' + cardSaid(tapCap, cu) + ' in this tap, and this payment needs more than that.',
                          { left: tapCap, need: need, turns: tap.turns, limit: capBack(tap.limit), cardUnit: cu });
        }
      }
      if (offline && (!picked || !picked.length) && card.balance >= rest && !(usable.stale > 0 && usable.pieces.length === 0)) {
        throw cardError('inexact', 'This phone is offline, so it cannot give change, and this card does not hold pieces that make exactly '
          + cardSaid(want, cu) + '. Pay an amount it can make, or pay when this phone is online.', { balance: card.balance, cardUnit: cu });
      }
      /* A one-signature card that holds enough, in pieces of more than one
       * date (it was topped up near the end of its thirty days): one payment is of one
       * date's pieces, and no date's alone will do. Said as what it can pay. */
      if (all4 && (!picked || !picked.length) && !offline && sumProofs(have) >= rest) {
        var most = cardDateGroups(have).reduce(function (n, g) { return Math.max(n, sumProofs(g)); }, 0);
        if (most < sumProofs(have)) {
          throw cardError('two-dates', 'This card’s money was put on it at two different times, and one payment can use only one of them. '
            + 'The most it can pay at once is ' + cardSaid(most, cu) + ': take the payment in two parts.', { balance: card.balance, most: most, cardUnit: cu });
        }
      }
      /* A one-signature card that holds enough, in more pieces than it signs
       * for at once: said as that, with the most it can pay in one go (its
       * largest pieces, as many as a signature takes). */
      if (all4 && (!picked || !picked.length) && !offline && sumProofs(have) >= rest) {
        var cap4 = (card.info && card.info.many) ? CARD_ALL_WIDE : CARD_ALL_MOST;
        var atOnce = cardDateGroups(have).reduce(function (n, g) {
          var top = g.slice().sort(function (a, b) { return satsOf(b.amount) - satsOf(a.amount); }).slice(0, cap4);
          return Math.max(n, sumProofs(top));
        }, 0);
        if (atOnce < rest) {
          throw cardError('too-many', 'This card can pay ' + cardSaid(atOnce, cu) + ' at once, and no more: its money is in more pieces than it signs for in one go. Take it in parts.',
                          { balance: card.balance, most: atOnce, cardUnit: cu });
        }
      }
      if (!picked || !picked.length) {
        if (usable.stale > 0 && card.balance >= rest) {
          throw own
            ? cardError('past-date', 'This card\u2019s date has passed. Its money comes back to this phone with TAKE IT BACK, and needs no card.', { stale: usable.stale })
            : cardError('renew', offline ? CARD_OFFLINE_NEAR : 'This card must be renewed by its owner before it can pay.', { stale: usable.stale });
        }
        throw cardError('not-enough', 'The card holds ' + cardSaid(card.balance, cu) + '.', { balance: card.balance, cardUnit: cu });
      }
      }
      worth = sumProofs(picked) + heldWorth;
      fee = swapFeeFor(w, picked.concat(heldProofs));
      if (!isFinite(fee) || fee < 0) fee = 0;
      /* A one-signature card: a signature for each date's pieces, thirty-two
       * at the most. A payment is one; a whole card taken off may be several,
       * each swapped by itself and each paying the mint's fee on its own. */
      // a card that burns any number signs once for a date's pieces; one that does not, for CARD_ALL_MOST at a time
      groups = all4 ? cardAllGroups(picked, (card.info && card.info.many) ? CARD_ALL_WIDE : CARD_ALL_MOST) : [];
      if (groups.length > 1 && !o.all) throw cardError('not-enough', 'The card holds ' + cardSaid(card.balance, cu) + '.', { balance: card.balance, cardUnit: cu });
      if (groups.length > 1) {
        fee = groups.reduce(function (n, g) { var f = swapFeeFor(w, g); return n + ((isFinite(f) && f > 0) ? f : 0); }, 0);
      }
      /* The most the mint's fee on the card's own pieces may be (`o.feeMost`): what a confirmation showed before the PIN (a card
       * at another mint paying this phone from there, `cardCrossQuote`). More, and the card is not asked for anything. */
      if (o.feeMost !== undefined && o.feeMost !== null && fee > Math.max(0, Number(o.feeMost) || 0)) {
        throw cardError('fee-more', 'The card\u2019s mint charges ' + cardSaid(fee, cu) + ' on the pieces this card would pay with, more than was shown. Nothing was taken.',
                        { fee: fee, shown: Math.max(0, Number(o.feeMost) || 0), cardUnit: cu });
      }
      /* What the card will make this payment wait, known before its PIN is
       * sent: said to the screen, and where it is longer than anybody holds a
       * card, the payment is not begun and the most that can be taken is said.
       * From 1.13 a payment is counted by what leaves the card, the pieces less the
       * change it is asked to make (`cardOwnChangeCut`: the part of the change it
       * does not make leaves it as the price does), with that change counted toward
       * it (two for every three pieces from 1.14, one for each before: `costed`),
       * and a second payment in this time in the field waits whether or not the
       * limit is known (`cardPaid`): a till is not told the limit, and says what it
       * can. */
      var second = shaped && !lift && cardPaid(link, card);
      if ((tap.paced && tap.limited && !lift) || second) {
        var signs, secs, unitsMost = 0;
        if (shaped) {
          var back = worth - fee - want;
          var cut = back > 0 ? cardOwnChangeCut(w, card, groups[0] || [], back) : [];
          var madeBy = cut.reduce(function (n, a) { return n + a; }, 0);
          // (1.23: what leaves the card, in cents, as the card weighs it; with no rate to weigh sats at, the limit's part of the guess is left out)
          var leavesC = cardCeil(card, worth - madeBy);
          signs = cardWaitSigns((tap.limited && leavesC !== null) ? tap.limit : 0, leavesC === null ? 0 : leavesC, cut.length, second, costed, card.info.waitOver, card.info.waitMore);
          unitsMost = cardWaitUnitsMost(card.info.waitOver, card.info.waitMore);
        } else {
          // 1.12: what leaves the card (the price and the fee on the pieces) and whether it makes change; before, the pieces whole
          signs = ownChange ? cardWaitSigns12(tap.limit, want + fee, worth - fee > want)
            : groups.reduce(function (n, g) { return n + cardWaitSignsBefore(tap.limit, sumProofs(g)); }, 0);
        }
        secs = cardWaitSeconds(signs);
        if (secs > CARD_WAIT_MOST) {
          var mostNow = unitsMost ? unitsMost * tap.limit : (Math.floor(CARD_WAIT_MOST / cardWaitSeconds(CARD_WAIT_SIGNS)) + 1) * tap.limit;
          // (1.23: said in the unit paid in: the cents turned back into sats at the rate)
          mostNow = cardCeilBack(card, mostNow);
          throw cardError('tap-limit', 'This card would have to be held for ' + secs + ' seconds to pay this. Take it in parts of '
            + cardSaid(mostNow, cu) + ' or less.', { left: mostNow, need: sumProofs(picked), limit: cardCeilBack(card, tap.limit), wait: secs, paced: true, cardUnit: cu });
        }
        if (signs > 0) { try { if (typeof o.progress === 'function') o.progress({ step: 'waiting', over: (typeof card !== 'undefined' && card && card.info && card.info.waitOver) || 7, more: (typeof card !== 'undefined' && card && card.info && card.info.waitMore) || 3, left: signs, seconds: secs, ahead: true, second: second }); } catch (eW) {} }
      }
      if (o.all) want = worth - fee;
      if (!(want > 0) || worth - fee < want) throw cardError('not-enough', 'The card holds ' + cardSaid(card.balance, cu) + '.', { balance: card.balance, cardUnit: cu });
      /* A card that signs for three pieces and refuses the fourth has spent
       * three for a payment that was not made, so the limit is checked for the
       * whole set before the first is asked for. */
      // what was held is already in the card's day: only what is signed now is charged to it
      // (1.23: the day is cents, and the payment weighed in them)
      // (`cap` in the card's unit as it pays: on a card of 1.23 the cents left turned back at the rate, which is exactly what fits)
      var capNeed = ownChange ? want + fee : sumProofs(picked);
      if (cap !== null && capNeed > cap) {
        throw cardError('limit', 'This card can spend ' + cardSaid(cap, cu) + ' more today, and this payment needs more than that.',
                        { left: cap, need: capNeed, turns: turns, limit: capBack(day.limit), cardUnit: cu });
      }
      if (tapCap !== null && sumProofs(picked) > tapCap) {
        throw cardError('tap-limit', 'This card can spend ' + cardSaid(tapCap, cu) + ' in this tap, and this payment needs more than that.',
                        { left: tapCap, need: sumProofs(picked), turns: tap.turns, limit: capBack(tap.limit), cardUnit: cu });
      }
      /* A card that has a PIN and will not sign this payment without it (no allowance, or less left of it than the payment takes
       * off the card, never less than the price and the mint's fee): said now, before the card is asked for anything, so the
       * sheet can end and the PIN be asked of the person. The card's own word at its signature is the truth; this only spares
       * a tap that would be refused. */
      if (!pin && card.info.pinSet && picked && picked.length) {
        var leastNet = o.all ? sumProofs(picked) : want + fee;
        if (cardNeedsPin(card, leastNet)) {
          throw cardError('pin-needed', 'Card needs PIN entered.',
                          { early: true, need: leastNet, set: !!(card.noPin && card.noPin.set), left: card.noPin ? card.noPin.left : 0, blocked: card.info.pin === 'blocked',
                            sheetText: CARD_PIN_SHEET, cardUnit: cu });
        }
      }
      // chosen from the brief listing: the pieces themselves are asked for now, before the PIN; with no route, proved after
      /* A payment held from an earlier tap and whole already (`picked` empty) signs nothing new, so there is nothing new to
       * prove: what it holds was proved before the card was asked for it (`proved` on its row, held to above). */
      return cardFill(t, card, picked, w).then(function () {
        return (offline && picked && picked.length) ? cardOfflineProve(t, card, picked, w).then(function (n) { card.offlineProven = n; }) : undefined;
      }).then(function () { return undefined; });
    }).then(function (early) {
      // a payment that ended above (a held one let go) has its answer already
      if (early !== undefined) return early;
      on('signing');
      if (!all4) return cardSign(t, card, picked, pin, lift, o.progress);
      /* Each signature's row is written down as it arrives, before the card is
       * asked for the next: the row, with the outputs it was signed for
       * (CARD_SWAPS), is the only copy of the right to spend those pieces. */
      return cardSignAll(t, card, w, groups, pin, lift, o.progress, function (signedNow, plan) {
        var kept = Object.assign({ id: 'card-' + plan.id, token: encodeToken(mintOf(w), signedNow, cu),
                     // what was signed for, which is the cheaper set where the card would have waited for the other
                     // `over`: what this phone makes of the change after the swap; `cardChange`: what the card made of it itself (1.12)
                     worth: plan.net, over: o.all ? 0 : plan.net - want - plan.cardChange, cardChange: o.all ? 0 : plan.cardChange,
                     all: !!o.all, card: card.key, memo: memo, at: Date.now(), limited: !!(card.day && card.day.limited) },
                     // what is kept, in the card's unit, under that unit's names
                     cardFig(cu, o.all ? plan.net : want));
        // paying out of this phone: what the swap gives is held for the payment (`cardSwapTaken`), and a late answer goes back to the card (`cardSettle`)
        if (o.holdFor) kept.send = true;
        // (held for this phone's own payment of its invoice: kept by it if that payment is not made, `cardOutKeep`)
        if (o.holdFor && o.holdKeep) kept.tillKeeps = true;
        /* With no route: the outputs as they were signed for and the swap's row, for the kept payment's record (`cardKeepSigned`),
         * which keeps the whole request. Not written with the TAKEN row: the record is made from this in memory. */
        var swapCopy = offline ? { outputs: plan.outputs.map(function (x) { return { amount: x.amount, B_: x.B_ }; }),
                                   spec: { id: plan.id, keyset: plan.keyset, counter: plan.counter, amounts: plan.amounts.slice(), digest: plan.digest } } : null;
        mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && held && x.id === held.id); }).concat([kept]));
        if (swapCopy) Object.defineProperty(kept, 'swapCopy', { value: swapCopy, enumerable: false });
        return kept;
      }, { want: want, all: !!o.all, memo: memo, own: ownChange, exact: !!o.holdFor, proved: offline },
      (cheaper && !o.all) ? { group: cheaper, fill: function () { return cardFill(t, card, cheaper, w); } } : null);
    }).then(function (answer) {
      // when the card had signed, to say in the log how long after it its sheet was told to go
      var signedAt = Date.now();
      // a card that signs for each piece answers the pieces; a one-signature card, its rows and the pieces
      var made = (answer && !Array.isArray(answer) && answer.rows) || [];
      var fresh = Array.isArray(answer) ? answer : ((answer && answer.signed) || []);
      /* This phone's own card has now proved its key, by signing: what was
       * read from it at the start of this tap is written down, as a proved
       * read's always was, and then what it has just signed for is marked.
       * Not from a brief read, which has no nonces to write down. */
      if (own && fresh.length && !card.proved && !card.bare) cardRemember(card, card.pieces, true);
      if (own) cardSpentHere(card.key, fresh.map(function (pr) { var parts = cardSecretParts(pr.secret); return parts ? parts.nonce : ''; }));
      // with what was signed for this payment before the card left, where it was taken up again
      var signed = heldProofs.concat(fresh);
      signedNonces = signed.map(function (pr) { var parts = cardSecretParts(pr.secret); return parts ? parts.nonce : ''; });
      // a holder's own taking-off lets the card go and does not read it again (`opts.hold` does): what is on it is worked out from the read
      if (o.lift && !o.hold) afterCard = cardAfterTake(card, signedNonces, lift);
      if (made.length) {
        row = made[0];
        moreRows = moreRows.concat(made.slice(1));
      } else {
        var token = encodeToken(mintOf(w), signed, cu);
        // a payment taken up that was signed with the card's own change in it: that part of the change is not this phone's to make
        var spec0 = cardSwapFor(signed);
        var cc0 = (spec0 && spec0.change && Array.isArray(spec0.change.outs)) ? spec0.change.outs.reduce(function (n, x) { return n + satsOf(x.amount); }, 0) : 0;
        row = Object.assign({ id: 'card-' + piecesFingerprint(signed), token: token, worth: worth - fee, over: Math.max(0, worth - fee - want - cc0), cardChange: cc0,
                all: !!o.all, card: card.key, memo: memo, at: Date.now(), limited: !!(card.day && card.day.limited),
                // paying out of this phone (`o.holdFor`): what the swap gives is held for the payment (`cardSwapTaken`)
                send: !!o.holdFor }, (o.holdFor && o.holdKeep) ? { tillKeeps: true } : {}, cardFig(cu, want));
        // written down before the card is let go: from here this row is the only copy of the right to spend the pieces (and the held one is part of it)
        mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && held && x.id === held.id); }).concat([row]));
      }
      if (offline) {
        var kept = cardKeepSigned(row, signed, card, w, keepOpts);
        on('done');
        return { unit: kept.unit, amount: kept.amount, sats: kept.sats, hash: kept.hash, kept: true, date: kept.date, change: null };
      }
      /* The card has done its part, and the mint's work takes as long as Tor
       * does: it is let go now, and the person is told so, and the rest is
       * done with Foxy's own screen saying so (`cardLetGo`). */
      // whether anything is coming back to the card in this sheet: its change, or a payment held for another amount
      var changeComing = row.over > 0 || row.cardChange > 0 || !!letGoAfter;
      return cardLetGo(link, o, changeComing).then(function () {
        released = !o.hold;
        if (!o.hold) console.log('[foxy] card: let go ' + (Date.now() - signedAt) + ' ms after it signed' + (changeComing ? ' (its sheet is kept for the change)' : ''));
        /* `change`: something is coming back to the card in this sheet, so its holder is told the second tap is on its way
         * (26f-flashcard.js: three buzzes), as the sheet is kept open for it. */
        on(released ? 'checking' : 'mint', { hash: row.id, change: changeComing });
        return cardSwapTaken(row, false);
      }).then(function (got) {
        // the other signatures of a whole card taken off, each its own swap
        return moreRows.reduce(function (chain, r) {
          return chain.then(function (sum) {
            return cardSwapTaken(r, false).then(function (g) { return cardGot(cu, (sum.amount || 0) + ((g && g.amount) || 0)); });
          });
        }, Promise.resolve(got));
      });
    }, function (e) {
      /* A one-signature card taken away between two signatures of a whole
       * card being taken off: what it signed for is off it and is the
       * holder's, written down already (`cardSignAll`). It is swapped in, and
       * the next tap takes the rest. */
      var doneRows = (e && Array.isArray(e.rows)) ? e.rows : [];
      if (doneRows.length) {
        var donePieces = (e && e.signedAll) || [];
        if (own) cardSpentHere(card.key, donePieces.map(function (pr) { var parts = cardSecretParts(pr.secret); return parts ? parts.nonce : ''; }));
        console.warn('[foxy] card: the card signed for ' + doneRows.length + ' of ' + groups.length + ' parts and left; what it signed is kept as part of the withdrawal');
        return moreRows.concat(doneRows).reduce(function (chain, r) {
          return chain.then(function (sum) {
            return cardSwapTaken(r, false).then(function (g) { return cardGot(cu, sum.amount + ((g && g.amount) || 0)); });
          });
        }, Promise.resolve(cardGot(cu, 0))).then(function (sum) {
          throw cardError('partial', 'The card was taken away before it had signed for all of it. ' + cardSaid(sum.amount, cu)
            + ' came off it into this phone; tap it again for the rest.',
            { unit: cu, cardUnit: cu, amount: sum.amount, sats: sum.sats, left: Math.max(0, card.balance - sumProofs(donePieces)), hash: doneRows[0].id });
        });
      }
      /* The card left, or refused, part-way through signing. What it did
       * sign for it has marked spent, and those pieces are the holder's
       * money with only this phone able to move them: they go back to the
       * card, by the same road as change. */
      var some = (e && e.signed) || [];
      if (!some.length) throw e;
      /* A payment the card left part way through: what it signed is held for
       * its next tap here, which signs only the rest (`cardHeld`), with what was
       * held from an earlier tap of the same payment. Nothing is paid yet, and
       * nothing has to be written back to the card. */
      if (!o.lift && e && e.card === 'gone') {
        var holding = heldProofs.concat(some);
        // the piece it was signing when it left, which it may have signed with the answer lost (`tornSats`)
        var inFlight = picked && picked[(e.signed || []).length];
        var flightParts = inFlight ? cardSecretParts(inFlight.secret) : null;
        var torn = ((held && held.resume && held.resume.torn) || []).slice();
        if (flightParts && flightParts.nonce) torn.push({ nonce: flightParts.nonce, amount: satsOf(inFlight.amount) });
        var keep = { id: 'card-' + piecesFingerprint(holding),
                     token: encodeToken(mintOf(w), holding, cu), unit: cu,
                     sats: 0, worth: sumProofs(holding), over: sumProofs(holding), all: false, card: card.key,
                     memo: 'card, not completed', at: Date.now(), refund: true,
                     // proved here with no route, all of it: this tap's pieces, and those held from before
                     resume: { want: want, torn: torn, proved: !!(offline && (!heldProofs.length || (held && held.resume && held.resume.proved))) } };
        mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && held && x.id === held.id); }).concat([keep]));
        console.warn('[foxy] card: the card signed for ' + some.length + ' of ' + picked.length + ' pieces and left; '
          + sumProofs(holding) + ' of ' + cardSaid(want, cu) + ' are held for its next tap, which signs the rest');
        throw cardError('interrupted', 'The card was taken away before it had signed for all of it. Nothing is paid yet: tap it again to finish.',
                        { owed: sumProofs(holding), held: sumProofs(holding), want: want, resumable: true, made: false, cardUnit: cu, key: card.key });
      }
      // a refusal or a bad signature is not taken up again: what was held from before goes back with what was signed now
      if (!o.lift && heldProofs.length) some = heldProofs.concat(some);
      /* A holder taking money off their own card, and not holding it for a
       * write after (`o.lift`, not `o.hold`): what the card signed before it
       * left is already off the card, and is theirs. It is kept, in this
       * phone, as a withdrawal of that much, and the next tap takes the rest.
       * It used to go back onto the card, so a withdrawal cut short came to
       * nothing, and one of many pieces, held for longer than a person holds
       * a card, could never finish. */
      if (o.lift && !o.hold) {
        var partNet = sumProofs(some) - (function () { var f = swapFeeFor(w, some); return (isFinite(f) && f > 0) ? f : 0; })();
        partNet = Math.max(0, partNet);
        var partKeep = o.all ? partNet : Math.min(want, partNet);
        var part = Object.assign({ id: 'card-' + piecesFingerprint(some), token: encodeToken(mintOf(w), some, cu),
                     worth: partNet, over: partNet - partKeep, all: !!o.all, card: card.key, memo: memo, at: Date.now(),
                     limited: !!(card.day && card.day.limited), partial: true }, cardFig(cu, partKeep));
        var partNonces = some.map(function (pr) { var parts = cardSecretParts(pr.secret); return parts ? parts.nonce : ''; });
        if (own) cardSpentHere(card.key, partNonces);
        mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).concat([part]));
        console.warn('[foxy] card: the card signed for ' + some.length + ' of ' + picked.length + ' pieces and left; what it signed is kept as part of the withdrawal');
        var rest = o.all ? Math.max(0, card.balance - sumProofs(some)) : Math.max(0, want - partKeep);
        return cardSwapTaken(part, false).then(function (got) {
          return cardOweBack(part, w, card, partNonces, got);
        }).then(function () {
          throw cardError('partial', 'The card was taken away before it had signed for all of it. ' + cardSaid(partKeep, cu)
            + ' came off it into this phone; tap it again for the rest.', { unit: cu, cardUnit: cu, amount: partKeep, sats: cu === 'sat' ? partKeep : 0, left: rest, hash: part.id });
        });
      }
      var back = { id: 'card-' + piecesFingerprint(some), token: encodeToken(mintOf(w), some, cu), unit: cu,
                   sats: 0, worth: sumProofs(some), over: sumProofs(some), all: false, card: card.key, memo: 'card, not completed', at: Date.now(),
                   refund: true };
      mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && held && x.id === held.id); }).concat([back]));
      console.warn('[foxy] card: the card signed for ' + some.length + ' of ' + picked.length + ' pieces and left; what it signed goes back to it');
      var signedHere = some.map(function (pr) { var parts = cardSecretParts(pr.secret); return parts ? parts.nonce : ''; });
      return cardReturn(back, card, w, signedHere).then(function (made) {
        if (made) throw cardError('interrupted', 'The card was taken away too soon. Nothing was paid, and ' + (cu === 'sat' ? sumProofs(some) + ' sats are' : moneyWords(sumProofs(some), cu) + ' is') + ' waiting to go back on it.', { owed: sumProofs(some), made: true, cardUnit: cu });
        throw cardError('interrupted', 'The card was taken away too soon. Nothing was paid; what it signed for will go back to it when the mint answers.', { owed: sumProofs(some), made: false, cardUnit: cu });
      }, function () {
        throw cardError('interrupted', 'The card was taken away too soon. Nothing was paid; what it signed for will go back to it when the mint answers.', { owed: sumProofs(some), made: false, cardUnit: cu });
      });
    }).then(function (got) {
      // held for another amount: let go now this payment is done (offline, at the next settling)
      if (offline) { if (letGoAfter) cardHeldRelease(letGoAfter, null); return got; }
      // in the card's unit: `amount`, and `sats` for a bitcoin card only (0 for a dollar card: no cents under that name)
      result = /** @type {any} */ ({ unit: cu, amount: want, sats: cu === 'sat' ? want : 0, hash: row.id, change: null, torn: tornSats });
      if (afterCard) result.card = afterCard;
      if (allOther) result.more = allOther;
      /* Paying out of this phone: the pieces the swap gave for the payment, held to one side (`cardOutHold`), by the name the
       * payment asks for them by (`pay`, `opts.held`). Marked as being in hand, so the sweep for ones left behind leaves them. */
      if (row.send) {
        var heldId = 'cardout-' + row.id;
        var heldNow = load(K.held, {})[heldId];
        // in the card's unit: `heldAmount`, and `heldSats` the same for a bitcoin card (0 for a dollar card's)
        if (heldNow) {
          result.held = heldId; result.heldAmount = sumProofs(heldNow.proofs || []); result.heldSats = cu === 'sat' ? result.heldAmount : 0;
          cardOutBusy[heldId] = Date.now();
        }
      }
      /* Change: what the card paid over, less what it costs to make and for the
       * card to spend again (`changeFromPile`), locked to the card again with
       * the date of what it paid with, cut to fill the gaps in its drawer, and
       * owed to it (`cardOweBack`). The receiver keeps exactly what it asked for;
       * where the change is too small to make, the sat or two over stay with the
       * payment and its entry says so. */
      return cardOweBack(row, w, card, signedNonces, got, { making: function () { on(released ? 'making' : 'change', { hash: row.id }); } })
        .then(function (owe) {
          /* The change the card made for itself (software 1.12) is owed to it already, from the swap's answer; it goes back
           * with whatever was made here. One whose signatures this phone has not heard yet (the answer was lost) is written
           * down as due, and said as change not made yet. */
          var promised = row.all ? 0 : Math.round(Number(row.cardChange) || 0);
          var viaCard = promised > 0 ? cardBlindOwed(row.id).amount : 0;
          var madeHere = (!owe.unmade && owe.amount > 0) ? owe.amount : 0;
          var total = viaCard + madeHere;
          // the change in the card's unit, as the result says it: `amount`, and `sats` for a bitcoin card only
          var said = function (n, more) { return Object.assign(cardGot(cu, n), more); };
          if (!(total > 0) && (owe.unmade || promised > 0)) { result.change = said(owe.unmade ? owe.owed : promised, { written: false, unmade: true }); return null; }
          if (!(total > 0)) return null;
          /* The card has gone: its change waits for the next tap (RECEIVE). */
          if (released) { result.change = said(total, { written: false }); return null; }
          /* Back onto the card now: the tap is still open and its PIN still
           * stands. Not read again first: choosing the applet again ends the
           * session the PIN was verified in, and what was read at the start
           * of the tap is still what is on the card but for what it spent. */
          return cardWriteOwed(t, card, o.progress).then(function (wrote) {
            result.change = said(total, { written: wrote.left.length === 0 });
          }, function () {
            result.change = said(total, { written: false });
          });
        }).then(function () {
          if (!letGoAfter) return null;
          // made into pieces for the card and owed to it, so the same second tap that takes the change puts it back
          return cardHeldRelease(letGoAfter, w).then(function (back) { result.letGo = back; });
        }).then(function () {
          // a sheet kept for the change says nothing of being done: what comes next (the change, or the end) says it
          if (!o.keepSheet) on('done');
          return result;
        });
    }).then(null, function (e) {
      // the mint has not answered: the card is as the tap left it all the same, and the screen that waits for the answer shows that
      if (e && e.card === 'waiting' && afterCard) e.after = afterCard;
      // every refusal once the card is read says its unit, so a figure on it is said in that unit (`pin-needed` from the card's own word too)
      if (e && typeof e === 'object' && e.card && card && card.record && e.cardUnit === undefined) { try { e.cardUnit = card.record.unit; } catch (x) {} }
      throw e;
    });
  }

  /* The card's part is over: it has signed, and nothing more is asked of it.
   * Its sheet is ended ("Done.") and the mint, which takes
   * as long as it takes, is asked with the card gone. Not for a flow that
   * goes on to speak to the card again (`o.hold`: a renewal writes to it, a move
   * reads it last), and nothing is sent to a link that has no way to let go
   * (a test's bare model: it is simply not spoken to again). Resolves
   * when the sheet has been told. */
  function cardLetGo(link, o, more) {
    if (o.hold || !link) return Promise.resolve();
    /* `o.keepSheet`: the card may go, and the sheet stays up, for the tap that
     * takes its change back in the same sheet once the mint has answered
     * (26f-flashcard.js, fcChangeInSheet). A second sheet opened for that tap
     * was refused by iOS as often as not. What it says asks for the sheet to
     * be left open: "Remove the card" beside the sheet's own Cancel read as
     * finished, the sheet was closed, and the change had no sheet to go in. */
    /* Paid in pieces that come to exactly the price (`more` false: which a
     * card that signs once for a payment mostly is), there is no change to
     * keep the sheet open for. The card's part is over, and its sheet goes at
     * once, with nothing on it to read: a line that said the card could be
     * removed was one more thing to read on a sheet that had nothing left to
     * do. The phone's own tick is all it shows as it closes (a single space
     * is the least a sheet can be told), and Foxy's own screen says the rest. */
    if (o.keepSheet && more === false && typeof link.release === 'function') {
      return Promise.resolve().then(function () { return link.release(' '); }).then(function () {}, function () {});
    }
    if (o.keepSheet && typeof link.say === 'function') {
      /* "Paid" first: the card has signed, and the payment is made as far as
       * the card is concerned; what follows is the change going on. The phone
       * asks for three buzzes at this moment too (26f-flashcard.js,
       * `fcChangeBuzz`), but iOS plays no haptic of an app's while its own
       * sheet is up, so these words are what says it. */
      var line = 'Hold for change.';
      return Promise.resolve().then(function () { return link.say(line); }).then(function () {}, function () {});
    }
    if (typeof link.release !== 'function') return Promise.resolve();
    return Promise.resolve().then(function () { return link.release(); }).then(function () {}, function () {});
  }

  /* Pieces a card signed for a payment that was not made, on their way back
   * to it: swapped into this phone and straight out again as pieces locked to
   * the card, owed to it (`cardOweBack`). */
  function cardReturn(row, card, w, signedNonces) {
    return cardSwapTaken(row).then(function (got) {
      return cardOweBack(row, w, card, signedNonces, got).then(function (r) { return r.made || null; });
    });
  }

  /* What a card's row owes the card back once its swap has landed: a payment's
   * over-payment (`row.over`), or the whole of a refund row (pieces the card
   * signed for a payment that was not made, `row.refund`). Made from this
   * phone's pile, locked to the card with the latest date its pieces had (and
   * the refund key their secrets name), and filed as owed to the card, so its
   * next tap writes it back.
   *
   * One road for both times it happens: in the tap, after the swap, and later,
   * when an answer that was lost is found (`cardSettle`). The second was missing,
   * and a receiver whose answer was lost kept the card's over-payment. Never
   * twice for one row: change already filed for it, or an entry that already
   * says where its change went, is left alone.
   *
   * `card` is the card as read in this tap (the change is cut to fill its
   * drawer), or null on a later settle (the change is its plain powers of two).
   * `got` is what the swap gave, for a refund row. `opts.making` is told just
   * before the change is made. Resolves { sats, owed, kept, made }: `kept` where
   * the change was too small to make (or could not be made), and the payment
   * keeps it, its entry then the gross. */
  function cardOweBack(row, w, card, signedNonces, got, opts) {
    var o = opts || {};
    /* In the row's own unit, made with that unit's wallet: a dollar card's change is cents from this phone's dollar pile. A
     * caller that has the sat wallet in hand (a settling, a retry) is given the dollar wallet here, on its circuit. */
    var u = cardRowUnit(row);
    if (u !== 'sat' && w && recordUnit(w) !== u) {
      return cardWalletFor(u, w, false).then(function (uw) { return cardOweBack(row, uw, card, signedNonces, got, opts); });
    }
    var refundRow = !!row.refund;
    // (what a swap gave, as `cardSwapTaken` says it: `amount` in the row's unit, or `sats` from a caller that says only that)
    var gotN = got ? (got.amount != null ? got.amount : got.sats) : 0;
    var owed = refundRow
      ? Math.max(0, Math.round(Number(gotN || row.worth) || 0))
      : (row.all ? 0 : Math.max(0, Math.round(Number(row.over) || 0)));
    /* What the card made of the change itself (software 1.12) is not made here and is owed
     * already (`cardSwapFixed`); the entry says so, with what is made here if any is. `owed` is
     * the part this phone makes, after the swap, from its own pile: all of the change before 1.12, and after it the
     * part the card was not asked for (more pieces than it keeps openings for, say). */
    var viaCard = row.all ? 0 : Math.max(0, Math.round(Number(row.cardChange) || 0));
    // what this answers is in the row's unit: `amount`, with `sats` the same for a bitcoin card's and 0 for a dollar card's
    var answer = function (n, more) { return Object.assign(cardGot(u, n), more); };
    if (!(owed > 0)) {
      if (viaCard > 0) cardChangeNote(row, viaCard);
      return Promise.resolve(answer(0, { owed: 0, kept: false }));
    }
    /* `row.outBack`: the price of a payment a card was to make out of this phone, which was not made, going back to the card
     * whole (`cardOutBack`). Its entry has said what the card made of its own change already, which is no reason to keep this:
     * only a put-back already filed for it is. */
    var outBack = !!row.outBack;
    /* `row.outChange`: the change of a payment a card made out of this phone (the reserve an on-chain payment did not use), owed
     * to the card the same way. The payment was made, so its entries say change and not "not completed"; and its own is
     * filed apart from the card's own change for the same tap, which this neither stands for nor is stood for by. */
    var outChange = !!row.outChange;
    var already = cardOwedFor(row.id, outChange, outBack);
    var entry = null;
    try { entry = (load(K.log, []) || []).filter(function (e) { return e && e.hash === row.id; })[0] || null; } catch (x0) { entry = null; }
    var settledState = !outBack && !outChange && entry && /^(not handed|given back|never came|never sent|came back)$/.test(String(entry.changeState || ''));
    // a retry (`opts.retry`) is of change that was never sent, and is made now (the card's own change, owed beside it, has said 'not handed' already)
    if (settledState && o.retry && (entry.changeState === 'never sent' || viaCard > 0)) settledState = false;
    if (already || settledState) return Promise.resolve(answer(0, { owed: owed, kept: false }));
    var back = changeFromPile(w, owed, u);
    if (!(back > 0)) {
      try { FoxyWallet.changeSettled(row.id, 0); } catch (x) {}
      return Promise.resolve(answer(0, { owed: owed, kept: true }));
    }
    var key = (card && card.key) || row.card;
    var date = 0, refundKey = '', sigAll = cardIsAll(card);
    try {
      ((FoxyWallet.tokenInfo(row.token) || {}).proofs || []).forEach(function (pr) {
        var parts = cardSecretParts(pr.secret);
        if (!parts) return;
        // written as the pieces it paid with were: a one-signature card's carry its flag
        if (parts.all) sigAll = true;
        date = Math.max(date, parts.date || 0);
        if (parts.refundKey) refundKey = parts.refundKey;
      });
    } catch (e) {}
    if (card && card.record && card.record.refundKey) refundKey = card.record.refundKey;
    var dated = !!(refundKey && date);
    /* The entry says what was kept, what came in and what goes back, whoever
     * wrote it first: the tap's own receive does, but the wallet's own recovery
     * of a lost answer writes a plain receive of the gross. */
    try {
      /* Paying out of this phone, put back: the entry had the price come off the card into this phone, and the price goes
       * back now, so it is taken off what the entry says stayed (and the card's own list says it is going back on). */
      // (each figure in the entry's own unit: `cardAmend`, `cardEntryFig`)
      if (outBack) cardAmend(row.id, { memo: 'card, not completed', changeState: 'making', changeSats: owed, grossSats: owed,
                                       sats: Math.max(0, Math.round(cardEntryFig(entry, 'sats')) - owed) }, u);
      /* Its change, going back: what came off the card stays what it was (`grossSats`), and what this phone kept of it is less
       * the change, which is added to any the card already had back from the same tap. */
      else if (outChange) {
        var was = Math.round(cardEntryFig(entry, 'sats'));
        cardAmend(row.id, { changeState: 'making', changeSats: Math.round((entry && entry.changeState ? cardEntryFig(entry, 'changeSats') : 0) || 0) + owed,
                            grossSats: Math.round(cardEntryFig(entry, 'grossSats')) || was, sats: Math.max(0, was - owed) }, u);
      }
      else cardAmend(row.id, refundRow ? { memo: 'card, not completed', changeState: 'making', changeSats: owed + viaCard, grossSats: owed + viaCard, sats: 0 }
                                  : { changeState: 'making', sats: cardRowAmt(row),
                                      grossSats: Math.max(0, Math.round(Number(row.worth) || 0)), changeSats: owed + viaCard }, u);
    } catch (x1) {}
    try { if (typeof o.making === 'function') o.making(); } catch (x2) {}
    return FoxyWallet.sendToken(back, { unit: u, lockTo: key, lockUntil: dated ? date : undefined,
                                        // (made on a card's visit to its mint, as part of it: `cardVisit`)
                                        cardVisit: !!cardAway || undefined,
                                        refundTo: dated ? refundKey : undefined, sigAll: sigAll,
                                        denominations: cardChangeCut(w, back, card, signedNonces),
                                        purpose: 'change', forHash: row.id, owed: owed })
      .then(function (made) {
        // what the send made, in its unit (`cardMade`): `settleChangeMade` reads the entry's own names
        var madeN = cardMade(made);
        settleChangeMade(row.id, owed, { sats: madeN, fee: made.fee, back: back });
        if (card) cardPiecesOf(made.token, card);
        mustSave(CARD_OWED, cardStore(CARD_OWED).concat([Object.assign({ id: made.hash, card: key, token: made.token,
                                                           kind: refundRow ? 'refund' : 'change', forHash: row.id, at: Date.now(),
                                                           outBack: outBack || undefined, outChange: outChange || undefined,
                                                           payment: (outChange && row.payment) || undefined }, cardFig(u, madeN))]));
        try { amendTx(row.id, { changeState: 'not handed' }); } catch (x3) {}
        // and the payment's own entry says what of it is going back to the card, until it is on it (`cardWrite`)
        if (outChange && row.payment) {
          try {
            var paid = (load(K.log, []) || []).filter(function (e) { return e && e.hash === row.payment; })[0];
            if (paid) cardAmend(row.payment, { changeSats: owed, changeState: 'not handed',
                                               grossSats: Math.round(cardEntryFig(paid, 'sats')) + Math.max(0, Math.round(cardEntryFig(paid, 'feeSats'))) + owed }, u);
          } catch (x6) {}
        }
        return answer(madeN, { owed: owed, kept: false, made: made });
      }, function (e) {
        /* The payment is made; its change could not be. This phone holds it, its
         * entry says the gross, and it is written down as due to the card, to be
         * made at the next connection (`cardDueRetry`). Where the swap is still
         * being asked about (its answer lost), the entry is left as it is: the
         * wallet's own recovery finishes it, and the retry hands the change on. */
        console.warn('[foxy] card: the change for a card payment could not be made yet:', (e && e.message) || e);
        var asking = false;
        try { asking = loadSwaps().some(function (r) { return r && r.pay && r.pay.forHash === row.id; }); } catch (x5) { asking = false; }
        if (!asking) { try { FoxyWallet.changeSettled(row.id, 0); } catch (x4) {} }
        cardDueNote(row, owed);
        return answer(0, { owed: owed, kept: true, unmade: true, due: true });
      });
  }

  /* Is what a card's row owes it filed already? Asked before anything is made for it, by the tap and its later settle
   * (`cardOweBack`) and by the retry of what could not be made (`cardDueRetry`), in one place so the two cannot disagree.
   * Three kinds are filed apart for one payment: the price of one out of this phone that was not made (`outBack`), the
   * change of one that was (`outChange`), and the change of a tap (neither), which the first stands for and the second
   * does not. */
  function cardOwedFor(forHash, outChange, outBack) {
    return cardStore(CARD_OWED).some(function (r) {
      return r && !r.blind && r.forHash === forHash && (outChange ? !!r.outChange : outBack ? !!r.outBack : !r.outChange);
    });
  }

  /* The entry of a payment whose change the card made for itself says it is owed to the card and not yet back on it
   * (as change made here does, `cardOweBack`): what was kept, what came in, and what goes back. Not over what has been written already. */
  function cardChangeNote(row, sats) {
    try {
      var entry = (load(K.log, []) || []).filter(function (e) { return e && e.hash === row.id; })[0];
      if (entry && entry.changeState === 'given back') return;
      // the figures in the entry's own unit (a dollar card's: `amount`, `grossAmount`, `changeAmount`, in cents)
      cardAmend(row.id, { changeState: 'not handed', sats: cardRowAmt(row),
                          grossSats: Math.max(0, Math.round(Number(row.worth) || 0)), changeSats: sats }, cardRowUnit(row));
    } catch (e) {}
  }

  /* Change that could not be had yet, written down to be had again whenever this phone connects. `blind`: the card's
   * own change (software 1.12), whose signatures the mint has made and this phone has not heard, rather than change this
   * phone could not make; it is asked for (`cardChangeOwe`), and the two are noted apart, for a payment may owe both. */
  function cardDueNote(row, owed, blind) {
    var due = cardStore(CARD_DUE);
    if (due.some(function (d) { return d && d.forHash === row.id && !!d.blind === !!blind && !!d.outBack === !!(!blind && row.outBack)
                                       && !!d.outChange === !!(!blind && row.outChange); })) return;
    // in the row's unit, under that unit's names; `worth`, `owed` and `cardChange` are in it too
    mustSave(CARD_DUE, due.concat([Object.assign({ forHash: row.id, card: row.card, token: row.token, worth: row.worth,
                                     owed: blind ? Math.round(Number(row.cardChange) || 0) : owed, refund: !!row.refund,
                                     outBack: (!blind && row.outBack) || undefined,
                                     outChange: (!blind && row.outChange) || undefined, payment: (!blind && row.outChange && row.payment) || undefined,
                                     blind: !!blind, cardChange: Math.round(Number(row.cardChange) || 0), at: Date.now() },
                                   cardFig(cardRowUnit(row), cardRowAmt(row)))]));
  }

  /* Change due to cards, made now where it can be (`CARD_DUE`). One at a time,
   * and each settled by whichever of these is true first: it is owed to the
   * card already; the wallet's own recovery of a lost answer made it (its
   * token is on the payment's entry), and it is owed to the card from there;
   * its swap is still being asked about, and it waits; it is older than
   * CARD_DUE_DAYS, and the receiver keeps it; or it is made now, from this
   * phone's pile, as the tap would have made it. Resolves
   * [{ forHash, state: 'made' | 'kept' | 'waiting', sats }]. */
  function cardDueRetry() {
    var due = cardStore(CARD_DUE);
    if (!due.length) return Promise.resolve([]);
    var w;
    try { w = need(); } catch (e) { return Promise.resolve([]); }
    if (!routeOpen()) return Promise.resolve([]);
    var out = [];
    var hereDue = canonicalMint(mintOf(w));
    return due.reduce(function (chain, d) {
      return chain.then(function () {
        if (!d || !d.forHash) return null;
        /* Due at another mint than this phone's (a card that paid this phone from its own mint, `cardAwayLeft`): made there, on a
         * visit. Made here, it was made from this mint's pile, as ecash of a mint the card is not at. */
        var dAt = cardRowMint(d);
        if (dAt && dAt !== hereDue) { out.push(Object.assign({ forHash: d.forHash, state: 'waiting', away: dAt }, cardGot(cardRowUnit(d), 0))); return null; }
        var drop = function () { mustSave(CARD_DUE, cardStore(CARD_DUE).filter(function (x) { return !(x && x.forHash === d.forHash && !!x.blind === !!d.blind && !!x.outBack === !!d.outBack && !!x.outChange === !!d.outChange); })); };
        // the card's own change, which the mint signed and this phone did not hear: asked of the mint by the blinded messages
        if (d.blind) {
          if (cardStore(CARD_OWED).some(function (r) { return r && r.blind && r.forHash === d.forHash; })) { drop(); return null; }
          if (Date.now() - (Number(d.at) || 0) > CARD_DUE_DAYS * 86400000) {
            console.warn('[foxy] card: the card\u2019s own change was not had from the mint in ' + CARD_DUE_DAYS + ' days; the card still has what it is made of');
            drop();
            out.push({ forHash: d.forHash, state: 'kept', sats: 0 });
            return null;
          }
          return cardChangeOwe({ id: d.forHash, token: d.token, card: d.card }).then(function (made) {
            drop();
            out.push(Object.assign({ forHash: d.forHash, state: made ? 'made' : 'kept' }, cardGot(cardRowUnit(d), made ? cardRowAmt(made) : 0)));
          }, function () { out.push(Object.assign({ forHash: d.forHash, state: 'waiting' }, cardGot(cardRowUnit(d), 0))); });
        }
        if (cardOwedFor(d.forHash, !!d.outChange, !!d.outBack)) { drop(); return null; }
        var tags = {};
        try { tags = FoxyWallet.tagsFor(d.forHash) || {}; } catch (x) { tags = {}; }
        // the recovery puts the change it found on the payment's entry, as a code to hand over (`owedChangeOnEntry`)
        // (not a payment's change out of this phone: that was never a code of a till's, and is made below)
        var found = d.outChange ? '' : String(tags.changeToken || (tags.owedChange ? tags.token : '') || '');
        // every figure here in the row's own unit (a dollar card's: cents)
        var du = cardRowUnit(d);
        if (found) {
          var made = 0, fu = du;
          try { var fi = /** @type {any} */ (FoxyWallet.tokenInfo(found) || {}); made = sumProofs(fi.proofs || []); fu = unitOf(fi.unit) || du; } catch (x1) { made = 0; }
          if (made > 0) {
            mustSave(CARD_OWED, cardStore(CARD_OWED).concat([Object.assign({ id: 'due-' + d.forHash, card: d.card, token: found,
                                                               kind: d.refund ? 'refund' : 'change', forHash: d.forHash, at: Date.now() }, cardFig(fu, made))]));
            // the card's, now, and not a code for this phone to hand over
            try { FoxyWallet.tag(d.forHash, { changeToken: '', token: '', owedChange: false, handed: '' }); } catch (x2) {}
            try { amendTx(d.forHash, { changeState: 'not handed' }); } catch (x3) {}
            drop();
            out.push(Object.assign({ forHash: d.forHash, state: 'made' }, cardGot(fu, made)));
            return null;
          }
        }
        if (loadSwaps().some(function (r) { return r && r.pay && r.pay.forHash === d.forHash; })) {
          out.push(Object.assign({ forHash: d.forHash, state: 'waiting' }, cardGot(du, 0)));
          return null;
        }
        if (Date.now() - (Number(d.at) || 0) > CARD_DUE_DAYS * 86400000) {
          console.warn('[foxy] card: change due to a card for ' + CARD_DUE_DAYS + ' days was never made; the payment keeps it');
          drop();
          out.push(Object.assign({ forHash: d.forHash, state: 'kept' }, cardGot(du, 0)));
          return null;
        }
        var row = Object.assign({ id: d.forHash, token: d.token, worth: d.worth, over: d.owed, all: false, card: d.card, refund: !!d.refund,
                    cardChange: Math.round(Number(d.cardChange) || 0), outBack: !!d.outBack, outChange: !!d.outChange, payment: d.payment || '' },
                    cardFig(du, cardRowAmt(d)));
        // made with the wallet of the row's unit (`cardOweBack` takes it from the sat wallet given)
        return cardOweBack(row, w, null, null, d.refund ? cardGot(du, d.owed) : null, { retry: true }).then(function (r) {
          if (r && r.made) { drop(); out.push(Object.assign({ forHash: d.forHash, state: 'made' }, cardGot(du, r.amount))); return; }
          // too small to make after all: the payment keeps it, as a tap's would
          if (r && r.kept && !r.unmade) { drop(); out.push(Object.assign({ forHash: d.forHash, state: 'kept' }, cardGot(du, 0))); return; }
          out.push(Object.assign({ forHash: d.forHash, state: 'waiting' }, cardGot(du, 0)));
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  /* ---- a card paying out of this phone (SEND from the card's screen) ------------------------------------------------------
   *
   * The card pays this phone exactly as it pays a till (`cardTake`, `o.holdFor`), and what the swap gives this phone for the
   * price is held to one side, out of the pile, under the name 'cardout-' and the payment's row (K.held, the store a lost
   * swap's inputs wait in: written with mustSave, counted by the books and by `heldSats`, and touched by nothing else that
   * does not ask for it by name). The payment then melts those pieces and no others (`pay`, `opts.held`). Every way it can
   * end leaves them somewhere:
   *
   *   paid                    spent at the mint; over Lightning, what the fee reserve did not use comes back to this phone
   *                           as melt change; on chain it is the card's (held as '<id>-change' and owed to it, `outChange`);
   *   refused, or never tried the payment puts them back in the hold, and `cardOutBack` makes them into pieces for the card,
   *                           owed to it, and its next tap puts them back on (no PIN, as after any payment);
   *   left behind             Foxy closed between the swap and the melt, or the melt's answer lost and then UNPAID: the
   *                           connect's sweep (`cardOutsLeft`) does the same once nothing is using them. */
  var CARD_OUT_STALE_MS = 120000;
  // the holds a payment is using now, by name, and since when: the sweep leaves them alone for ten minutes
  var cardOutBusy = {};
  function cardOutInUse(id) {
    var at = Number(cardOutBusy[id]) || 0;
    return at > 0 && Date.now() - at < 600000;
  }
  // a payment has finished with its hold, however it went
  function cardOutDone(id) { delete cardOutBusy[id]; }

  /* What a card pays out of this phone for an invoice of `amount` the mint quoted `reserve` of fee for: the two, and the
   * mint's own fee for spending the pieces they are cut into (one piece to a binary place of the total, which is how
   * `cardSwapPlan` cuts them). Nothing more at a mint that charges no fee. `unit`: the card's (sats when not named), whose
   * keyset's fee it is: a dollar card pays an invoice by a melt in dollars, all of it in cents. */
  function cardOutTotal(amount, reserve, unit) {
    var base = Math.max(0, Math.round(Number(amount) || 0)) + Math.max(0, Math.round(Number(reserve) || 0));
    var w;
    var u = unitOf(unit) || 'sat';
    if (u === 'sat') { try { w = need(); } catch (e) { return base; } }
    else { w = cardWalletNow(u); if (!w) return base; }
    var total = base;
    for (var i = 0; i < 6; i++) {
      var next = base + feeForInputs(w, piecesFor(total));
      if (next === total) break;
      total = Math.max(total, next);
    }
    return total;
  }

  /* A till at one mint paid by a card at another (26f-flashcard.js, `fcXmBegin`): what the card's mint asks to pay the till's own
   * invoice, in the card's unit, asked before the card is touched and with this phone still at its own mint. A melt quote commits to
   * nothing, so a wallet is made for that mint for the asking alone, with no seed in it. `total` is what the card pays: the amount,
   * the reserve, and that mint's fee for spending the pieces they are cut into (as `cardOutTotal`, at that mint's keyset). The till
   * receives the invoice's amount at its own mint, exactly. The quote is kept whole (`quote`), for `pay` to melt with once the
   * phone is at that mint. Rejects with the mint's own words where it will not quote. */
  /* `card`: the card as it was read at the tap that found it at another mint (`cardUnusable`'s `other-mint`, which carries it). With
   * it, the fee that mint charges to swap the card's own pieces for this payment is counted in too (`cardFee`), worked out from the
   * pieces the tap will pick, as `cardTake` picks them: shown before the PIN, and held to at the tap (`opts.feeMost`), so the card is
   * never charged more than was shown. `want` is what the tap asks of the card for its hold (the amount, the reserve and the fee
   * on the hold's own pieces); `total` is that and the card's own fee, the most that comes off it. */
  function cardCrossQuote(at, bolt11, unit, card) {
    try { assertRoute(); } catch (e) { return Promise.reject(e); }
    var from = canonicalMint(at);
    var u = unitOf(unit) || 'sat';
    var inv = String(bolt11 || '').trim().replace(/^lightning:/i, '');
    if (!from) return Promise.reject(new Error('No mint to pay from.'));
    if (from === canonicalMint(mintUrl || '')) return Promise.reject(new Error('That card is at this phone\u2019s own mint.'));
    if (!/^ln(bc|tb|bcrt)/i.test(inv)) return Promise.reject(new Error('There is no invoice to pay.'));
    var w;
    try { w = newWallet(from, u === 'sat' ? undefined : { unit: u }); } catch (e1) { return Promise.reject(e1); }
    return withTimeout(w.loadMint(), 25000, hostOf(from)).then(function () {
      if (u !== 'sat') {
        var sets = [];
        try { sets = (w.keyChain && w.keyChain.getKeysets) ? w.keyChain.getKeysets() : []; } catch (e2) { sets = []; }
        if (!sets || !sets.length) throw new Error(hostOf(from) + ' does not issue ' + unitName(u) + ' ecash.');
      }
      return withTimeout(w.createMeltQuoteBolt11(inv), 25000, hostOf(from) + ' melt quote');
    }).then(function (q) {
      var amount = satsOf(q.amount) || 0;
      var reserve = satsOf(q.fee_reserve) || 0;
      if (!(amount > 0)) throw new Error(hostOf(from) + ' could not say what this invoice costs.');
      var base = amount + reserve, total = base;
      for (var i = 0; i < 6; i++) {
        var next = base + feeForInputs(w, piecesFor(total));
        if (next === total) break;
        total = Math.max(total, next);
      }
      var want = total, cardFee = cardCrossFee(w, card, want, u);
      total = want + cardFee;
      console.log('[foxy] card: ' + hostOf(from) + ' quotes ' + cardSaid(amount, u) + ' and ' + cardSaid(reserve, u) + ' of reserve; the card pays at most ' + cardSaid(total, u)
                  + (cardFee > 0 ? ', ' + cardSaid(cardFee, u) + ' of it the mint\u2019s fee on the card\u2019s own pieces' : ''));
      // `quote` in the shape `pay` takes (`opts.quote`, as `quoteFee` gives it), with the wallet it was asked by
      return { mint: from, unit: u, amount: amount, feeReserve: reserve, want: want, cardFee: cardFee, total: total, fee: total - amount,
               quote: { unit: u, amount: amount, feeReserve: reserve, quote: q, w: w, bolt11: inv, at: Date.now() } };
    });
  }

  /* What the card's mint charges to swap the pieces a tap would pick from `card` for `want` (`cardTake`'s own choice, with no limit
   * to pick under: a limit only narrows the choice, and a set that costs more than this is refused at the tap, `opts.feeMost`).
   * 0 with no card, or no set. A card of 1.23 is weighed in the unit it pays in (`unit`), its pieces of that unit alone (`cardInUnit`). */
  function cardCrossFee(w, card, want, unit) {
    if (card && card.units && unit) card = cardInUnit(card, unit);
    if (!card || !Array.isArray(card.pieces) || !card.record || !(want > 0)) return 0;
    try {
      var have = cardUsable(card, w, false).pieces;
      var pick = cardIsAll(card) ? cardPickAll(w, have, want, null, card, null, false, false) : cardPick(w, have, want, null, card, null);
      if (!pick || !pick.length) return 0;
      var f = swapFeeFor(w, pick);
      return (isFinite(f) && f > 0) ? f : 0;
    } catch (e) {
      console.warn('[foxy] card: what its mint charges on its own pieces could not be worked out:', (e && e.message) || e);
      return 0;
    }
  }

  /* ---- a card at another mint, loaded from this phone -----------------------------------------------------------------
   *
   * SEND > FLASHCARD and ADD FUNDS for a card whose money is at another mint than this phone's (26f-flashcard.js, `fcXlBegin`).
   * The money crosses by Lightning, as a move between this phone's own mints does (14-moving-between-mints.js): the card's mint
   * makes an invoice for the amount in the card's unit, and this phone's mint pays it from this phone's balance. Then, on a visit
   * to the card's mint (`cardVisit`), the invoice is claimed there and the pieces for the card are made of it (`cardPrepare`),
   * owed to the card and written at the next tap. This phone pays every fee: the Lightning reserve, its own mint's fee on the
   * pieces it melts, and the card's mint's fee on the pieces it makes for the card, which the invoice is padded by so that the
   * amount asked is what goes on the card.
   *
   * `cardLoadCrossQuote` asks both mints and commits to nothing (the invoice is a mint quote nobody has paid). It resolves what goes
   * on the card (`amount`, in the card's unit), the most that leaves this phone (`total`, in the unit that pays: the very sum `pay`
   * refuses on, `payNeed`), and the fee (`fee`: that total less what the amount is worth in the unit that pays, at the card's
   * mint's own price for it, `worth`). `short`, with `why`, where this phone cannot cover the total. `opts`: `cardUnit`, the unit
   * the card is loaded in; `payUnit`, the balance of this phone's that pays; `card`, the card as read, so that the pieces are cut
   * as `cardPrepare` will cut them there. */
  function cardLoadCrossQuote(at, amount, opts) {
    var o = opts || {};
    try { assertRoute(); } catch (e) { return Promise.reject(e); }
    var to = canonicalMint(at);
    var home = canonicalMint(mintUrl || '');
    var cu = unitOf(o.cardUnit) || 'sat';
    var pu = unitOf(o.payUnit) || 'sat';
    var want = Math.round(Number(amount) || 0);
    if (!to) return Promise.reject(new Error('No mint to load the card at.'));
    if (!home) return Promise.reject(new Error('No mint is connected.'));
    if (to === home) return Promise.reject(new Error('That card is at this phone’s own mint.'));
    if (!(want > 0)) return Promise.reject(cardError('bad-amount', 'Ask for an amount above zero.'));
    /* What `cardPrepare` would refuse at the card's mint, refused here, before anything has moved: the money would otherwise cross
     * and then not go on, and be this phone's at a mint it is not at. */
    var c0 = o.card || null;
    if (c0 && c0.info) {
      if (c0.info.pin === 'blocked') return Promise.reject(cardRefused('6983'));
      if (!c0.info.setUp) return Promise.reject(cardError('no-record', 'Set this card up first.'));
      if (c0.info.locked) return Promise.reject(cardRefused('6986'));
      if (!c0.info.owner && !(c0.info.guests && c0.info.pinSet)) return Promise.reject(cardError('no-owner', 'This card has no owner, so it cannot be loaded.'));
    }
    var dest;
    try { dest = newWallet(to, cu === 'sat' ? undefined : { unit: cu }); } catch (e1) { return Promise.reject(e1); }
    return withTimeout(dest.loadMint(), 25000, hostOf(to)).then(function () {
      if (cu !== 'sat') {
        var sets = [];
        try { sets = (dest.keyChain && dest.keyChain.getKeysets) ? dest.keyChain.getKeysets() : []; } catch (e2) { sets = []; }
        if (!sets || !sets.length) {
          throw cardError('no-dollars-here', hostOf(to) + ' does not issue ' + unitName(cu) + ' ecash now, so this card cannot be loaded there.', { cardUnit: cu });
        }
      }
      var misfit = cardMintMisfit(dest);
      if (misfit) throw misfit;
      // the pieces, cut for the card as `cardPrepare` will cut them at its mint: what lands is what they come to
      var card = o.card || null;
      if (card && cardIs123(card) && card.record && !card.units) cardSortUnits(card);
      if (card && card.units) card = cardInUnit(card, cu);
      var land = want;
      if (card && card.info && card.record) {
        var cut = cardLoadCut(dest, card, want);
        if (cut.full) throw cardError('full', CARD_FULL_WORDS);
        land = cut.ladder.sats;
      }
      // and the card's mint's fee for making them, from what is claimed there: the pieces a claim of that much comes in
      var issue = land;
      for (var i = 0; i < 6; i++) {
        var next = land + feeForInputs(dest, piecesFor(issue));
        if (next <= issue) break;
        issue = next;
      }
      var lock = quoteLock(dest);
      return withTimeout(createQuote(dest, issue, undefined, lock), 25000, hostOf(to) + ' invoice').then(function (mq) {
        if (lock) mq.foxyLock = lock;
        return cardLoadCrossPay({ mint: to, home: home, cardUnit: cu, amount: want, land: land, issue: issue, invoice: mq.request, mintQuote: mq }, pu);
      });
    });
  }

  /* The plan's invoice at the card's mint, paid from this phone's balance in `pu`: this phone's mint's melt quote for it, the most that
   * leaves this phone (`total`), and the fee over what goes on the card (`land`, the pieces as cut, which can differ from the amount
   * asked: `worth` is what that is worth in `pu`). Also for a plan already made, quoted again in this phone's other balance
   * (`cardLoadRepay`, 21a-flashcard.js): the same invoice, nothing asked of the card's mint again. */
  function cardLoadCrossPay(base, pu) {
    var to = base.mint, home = base.home, cu = unitOf(base.cardUnit) || 'sat';
    try { assertRoute(); } catch (e) { return Promise.reject(e); }
    if (canonicalMint(mintUrl || '') !== home) return Promise.reject(new Error('This phone is not at ' + hostOf(home) + ' now.'));
    return FoxyWallet.quoteFee(base.invoice, { unit: pu }).then(function (kq) {
      if (!kq) throw new Error(hostOf(home) + ' could not say what paying ' + hostOf(to) + ' costs.');
      var mn = FoxyWallet.payNeed(kq.amount, kq.feeReserve, { unit: pu });
      var total = mn ? mn.need : kq.amount + kq.feeReserve;
      var worth = Math.round(kq.amount * base.land / base.issue);
      console.log('[foxy] card: ' + cardSaid(base.land, cu) + ' to go on a card at ' + hostOf(to) + ' (' + cardSaid(base.issue, cu) + ' asked there); '
                  + hostOf(home) + ' pays it with at most ' + cardSaid(total, pu));
      return { mint: to, home: home, cardUnit: cu, payUnit: pu, amount: base.amount, land: base.land, issue: base.issue, invoice: base.invoice,
               mintQuote: base.mintQuote, melt: kq, total: total, worth: worth, fee: Math.max(0, total - worth),
               short: !!(mn && !mn.ok), why: (mn && !mn.ok) ? mn.why : '', at: Date.now() };
    });
  }

  /* The load carried out, the card's PIN typed already where it wants one: `plan` from `cardLoadCrossQuote`, `card` as read. The
   * crossing is written down before the melt, as every crossing's is (`putMoveNote`): between the payment and the claim the money is
   * at the card's mint and nowhere else, and the note is how it is claimed from wherever this phone is (`finishMove`). Then the melt
   * here, held as any melt is; then a visit to the card's mint (`cardVisit`), the claim there, and the pieces made for the card
   * there (`cardPrepare`: owed to it, and written at the next tap). Resolves { made, visit, paid }, the visit still open for that
   * tap: whoever called ends it (`visit.end()`). Rejects with what happened, the visit over: `pending`, the melt not answered (held,
   * and the sweeps settle it: paid, what it pays is this phone's at the card's mint; not, it is back here); `movePaid`, paid and not
   * yet made into pieces for the card (the money is this phone's at the card's mint, claimed by `finishMove` where it was not); or
   * neither, and nothing left this phone. */
  function cardLoadAcross(plan, card, onStage) {
    var stage = typeof onStage === 'function' ? onStage : function () {};
    if (!plan || !plan.mintQuote || !plan.invoice || !card) return Promise.reject(new Error('No load to make.'));
    try { assertRoute(); } catch (e) { return Promise.reject(e); }
    if (canonicalMint(mintUrl || '') !== plan.home) return Promise.reject(new Error('This phone is not at ' + hostOf(plan.home) + ' now. Nothing was taken.'));
    var quoteId = plan.mintQuote.quote;
    var cu = unitOf(plan.cardUnit) || 'sat';
    liveMove[quoteId] = true;
    var notLive = function () { delete liveMove[quoteId]; };
    try {
      putMoveNote({ to: plan.mint, from: plan.home, quote: quoteId, request: plan.invoice, amount: plan.issue,
                    unit: cu === 'sat' ? undefined : cu, lock: plan.mintQuote.foxyLock || null, card: card.key || undefined, at: Date.now() }, true);
    } catch (eNote) { notLive(); return Promise.reject(eNote); }
    // the card's mint hears of the payment a moment after this one says paid (`moveRun`): asked again for a few seconds
    var claimPatiently = function (left) {
      return Promise.resolve().then(function () { return unitWalletOn(need(), cu); }).then(function (uw) {
        return FoxyWallet.claimQuote(quoteId, plan.issue, plan.mintQuote.foxyLock, cu === 'sat' ? undefined : { w: uw });
      }).catch(function (e) {
        var notYet = /not paid|unpaid|not been paid/i.test(String((e && e.message) || e));
        if (!notYet || left <= 0) throw e;
        return new Promise(function (r) { setTimeout(r, 2000); }).then(function () { return claimPatiently(left - 1); });
      });
    };
    var run = FoxyWallet.pay(plan.invoice, stage, { unit: plan.payUnit, quote: plan.melt }).then(null, function (e) {
      // not paid, and nothing held that could still pay it: the note would be a note of nothing
      var held = load(K.melting, []).some(function (h) { return h && h.bolt11 === plan.invoice; });
      if (!held) dropMoveNote(quoteId);
      throw e;
    }).then(function (paid) {
      if (paid && paid.pending) {
        var later = /** @type {any} */ (new Error('That payment may still be going through. Foxy is holding the ecash until the mint says either way.'));
        later.pending = true;
        later.moveQuote = quoteId;
        throw later;
      }
      stage('switching');
      return cardVisit(plan.mint).then(function (v) {
        stage('claiming');
        return claimPatiently(8).then(function () {
          dropMoveNote(quoteId);
          return FoxyWallet.cardPrepare(card, plan.amount, { unit: cu, visit: true });
        }).then(function (made) { return { made: made, visit: v, paid: paid }; }, function (e) {
          v.end();
          throw e;
        });
      }).then(null, function (e) {
        try { e.movePaid = true; e.moveTo = plan.mint; e.moveAmount = plan.issue; e.moveUnit = cu; } catch (x) {}
        throw e;
      });
    });
    run.then(notLive, notLive);
    return run;
  }

  /* ---- a visit to a card's mint ---------------------------------------------------------------------------------------
   *
   * A card at another mint pays this phone from there (26f-flashcard.js, `fcXmGo`), and what that leaves at its mint is settled
   * there (`cardAwayLeft`): both with this phone at the card's mint for as long as that takes, and home after. A visit, as a late
   * claim's is (`claimAway`): never saved as this phone's mint, and what a person starts meanwhile (an invoice, a payment, a
   * switch, the late-claim walk) waits for it to be home, where it used to be done at the card's mint. The visit's own calls say
   * so (`cardVisit: true` in their options, 99-proof-lock-and-export.js). The way home is tried until it is made: a mint at home
   * that does not answer once leaves this phone at the card's mint only until it does (`cardVisitHome`).
   *
   * One visit at a time; a second to the same mint joins it, and home is after the last of them ends. Resolves { end }, `end()`
   * resolving when this phone is home. */
  var cardAway = /** @type {any} */ (null);
  var CARD_HOME_RETRY_MS = [1000, 2000, 4000, 8000, 15000];
  function cardVisit(at) {
    var to = canonicalMint(at);
    if (!to) return Promise.reject(new Error('No mint to go to.'));
    try { assertRoute(); } catch (e) { return Promise.reject(e); }
    var handle = function (v) {
      var ended = false;
      return { mint: to, end: function () {
        if (ended) return v ? v.finished : Promise.resolve();
        ended = true;
        return v ? cardVisitEnd(v) : Promise.resolve();
      } };
    };
    // a visit on its way home, or to another mint, is waited for; and so is a late claim's walk, which goes where it likes
    if (cardAway && (cardAway.homing || cardAway.mint !== to)) return cardAway.finished.then(function () { return cardVisit(at); });
    if (cardAway) {
      cardAway.uses += 1;
      var joined = cardAway;
      return joined.ready.then(function () { return handle(joined); }, function (e) { return cardVisitEnd(joined).then(function () { throw e; }); });
    }
    if (claimAway || claimingLate) {
      return Promise.resolve(claimAway || claimingLate).then(null, function () { return null; }).then(function () { return cardVisit(at); });
    }
    var home = canonicalMint(mintUrl || '');
    if (!home || home === to) return Promise.resolve(handle(null));
    var done = /** @type {any} */ (null);
    var finished = new Promise(function (res) { done = res; });
    var v = /** @type {any} */ ({ mint: to, home: home, uses: 1, homing: false, finished: finished, done: done, ready: null });
    cardAway = v;
    claimAway = finished;
    console.log('[foxy] card: this phone visits ' + hostOf(to) + ', where a card\u2019s money is; what is started meanwhile waits until it is back on ' + hostOf(home));
    v.ready = FoxyWallet.connect(to, null, null, { remember: false, noSweep: true });
    return v.ready.then(function () { return handle(v); }, function (e) {
      // not there: still home (a failed connect leaves the wallet where it was), and the visit over
      return cardVisitEnd(v).then(function () { throw e; });
    });
  }

  function cardVisitEnd(v) {
    v.uses -= 1;
    if (v.uses > 0 || v.homing) return v.finished;
    v.homing = true;
    cardVisitHome(v, 0);
    return v.finished;
  }

  function cardVisitHome(v, tries) {
    var over = function () {
      if (cardAway === v) cardAway = null;
      if (claimAway === v.finished) claimAway = null;
      v.done();
    };
    if (canonicalMint(mintUrl || '') === v.home) { over(); return; }
    FoxyWallet.connect(v.home, null, null, { remember: false }).then(function () {
      console.log('[foxy] card: back on ' + hostOf(v.home) + ' after a visit to ' + hostOf(v.mint));
      over();
    }, function (e) {
      // (a test sets its own waits, `_cardHomeRetryMs`)
      var waits = (Array.isArray(FoxyWallet._cardHomeRetryMs) && FoxyWallet._cardHomeRetryMs.length) ? FoxyWallet._cardHomeRetryMs : CARD_HOME_RETRY_MS;
      var wait = Number(waits[Math.min(tries, waits.length - 1)]) || 2000;
      console.warn('[foxy] card: could not get back to ' + hostOf(v.home) + ' yet (' + ((e && e.message) || e) + '); trying again in ' + Math.round(wait / 1000) + 's');
      setTimeout(function () { cardVisitHome(v, tries + 1); }, wait);
    });
  }

  /* The mints other than this phone's where a card's payment left something to settle: a hold out of a card that never went
   * (`cardOutsLeft`), a signature whose answer was lost (`cardSettle`), or change due to a card that could not be made then
   * (`cardDueRetry`). Each is visited, settled there, and this phone comes
   * home (`cardVisit`). Asked at the end of a connect's sweep (11-routing.js), and by the screens when a payment from another
   * mint ends unsettled. Not more than once a minute for one mint. Resolves the mints settled at. */
  var cardAwayAsked = {};
  function cardAwayMints() {
    var here = canonicalMint(mintUrl || '');
    var at = {};
    var melting = load(K.melting, []) || [];
    var held = load(K.held, {});
    Object.keys(held).forEach(function (id) {
      var h = held[id];
      if (!h || h.kind !== 'card out' || cardOutInUse(id)) return;
      if (melting.some(function (m) { return m && m.cardOut === id; })) return;
      var m = canonicalMint(h.mint || '');
      if (m && m !== here) at[m] = true;
    });
    cardStore(CARD_TAKEN).forEach(function (row) {
      var m = cardRowMint(row);
      if (m && m !== here) at[m] = true;
    });
    /* Change due to a card that could not be made then (too little to make at a mint that charges for it, often): asked again there,
     * but not on every connect, which would be a visit to another mint at every launch for days. Marked 'due' for that. */
    cardStore(CARD_DUE).forEach(function (row) {
      var m = cardRowMint(row);
      if (m && m !== here && !at[m]) at[m] = 'due';
    });
    return Object.keys(at).map(function (m) { return { mint: m, due: at[m] === 'due' }; });
  }
  /* `opts.skipDue`: not for change due alone (the screens' asking, just home from that mint, where it was tried a moment ago). */
  function cardAwayLeft(opts) {
    if (cardAway || !routeOpen()) return Promise.resolve([]);
    var skipDue = !!(opts && opts.skipDue);
    var mints = cardAwayMints().filter(function (x) { return !(skipDue && x.due) && !(Date.now() - (cardAwayAsked[x.mint] || 0) < (x.due ? 1800000 : 60000)); })
      .map(function (x) { return x.mint; });
    var out = /** @type {string[]} */ ([]);
    return mints.reduce(function (chain, m) {
      return chain.then(function () {
        cardAwayAsked[m] = Date.now();
        /* (counted from the asking, made or not: a card's mint that does not answer would otherwise hold what a person starts at
         * every connect for as long as the visit takes to fail) */
        return cardVisit(m).then(function (v) {
          var settle = function () {
            return FoxyWallet.recoverSwaps().then(null, function () { return null; })
              .then(function () { return cardStore(CARD_TAKEN).length ? FoxyWallet.cardSettle() : null; }).then(null, function () { return null; })
              .then(function () { return FoxyWallet.cardOutHeld().length ? cardOutsLeft() : null; }).then(null, function () { return null; })
              .then(function () { return cardStore(CARD_DUE).length ? cardDueRetry() : null; }).then(null, function () { return null; });
          };
          return settle().then(function () { out.push(m); return v.end(); }, function () { return v.end(); });
        }, function (e) {
          console.warn('[foxy] card: could not visit ' + hostOf(m) + ' to settle what a card left there:', (e && e.message) || e);
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  // the mint a card's TAKEN row's pieces are of
  function cardRowMint(row) {
    try { return canonicalMint(String(((FoxyWallet.tokenInfo(row && row.token)) || {}).mint || '')); } catch (e) { return ''; }
  }

  /* The hold of a payment that was not made, back to the card: into the pile (under the proof lock, as anything that writes
   * the pile is), then made into pieces locked to the card with the dates of what it paid with and owed to it, the way a
   * refund of a till's is (`cardOweBack`, `outBack`). Resolves { sats, made }: `made` false where there is no route to make
   * them (the hold stays, and the connect's sweep does it), or the making failed (owed later, `cardDueRetry`). */
  function cardOutBack(id) {
    var h = load(K.held, {})[id];
    if (!h || h.kind !== 'card out') return Promise.resolve({ unit: 'sat', amount: 0, sats: 0, made: false });
    // a hold for this phone's own invoice is this phone's money, paid to it: never the card's again (`cardOutKeep`)
    if (h.tillKeeps) return cardOutKeep(id).then(function (r) { return Object.assign(r, { made: false }); });
    var sats = sumProofs(h.proofs || []);
    // (in the hold's own unit: a dollar card's are cents, never under a sats name)
    var hu0 = recordUnit(h);
    var w;
    /* Not made now (no wallet, no route, or this phone on another mint): the payment is over with its hold all the same, so
     * it is no longer in use, and is aged as one left behind, for the next sweep (`cardOutsLeft`) to give back at once rather
     * than in ten minutes. */
    var later = function () {
      cardOutDone(id);
      try {
        var all = load(K.held, {});
        if (all[id]) { all[id].at = 0; save(K.held, all); }
      } catch (e) { /* the sweep still takes it once it is old enough */ }
      return Promise.resolve(Object.assign(cardGot(hu0, sats), { made: false }));
    };
    try { w = need(); } catch (e) { return later(); }
    if (!routeOpen() || canonicalMint(mintOf(w)) !== canonicalMint(h.mint)) return later();
    cardOutBusy[id] = Date.now();
    var released = false;
    return withProofs('cardOutBack', function () {
      if (!load(K.held, {})[id]) return;
      releaseHeld(id, true);
      released = true;
    }).then(function () {
      if (!released) return Object.assign(cardGot(hu0, 0), { made: false });
      /* A hold of a payment's change (`h.change`: the reserve an on-chain payment did not use, 16a-onchain.js) is the card's
       * as well, and goes the same road; only what its entries say differs: the payment was made (`outChange`). */
      // in the hold's own unit (a dollar card's: cents, made with the dollar wallet by `cardOweBack`)
      var hu = recordUnit(h);
      console.log('[foxy] card: ' + (h.change ? 'the change of a payment out of this phone; ' : 'a payment out of this phone was not made; ') + cardSaid(sats, hu) + ' go back to the card');
      var row = h.change
        ? { id: h.forHash, token: h.token, card: h.card, refund: false, outChange: true, payment: h.payment || '', worth: sats, unit: hu, sats: 0, over: sats, all: false, cardChange: 0 }
        : { id: h.forHash, token: h.token, card: h.card, refund: true, outBack: true, worth: sats, unit: hu, sats: 0, over: sats, all: false, cardChange: 0 };
      return cardOweBack(row, w, null, null, cardGot(hu, sats)).then(function (r) {
        return Object.assign(cardGot(hu, (r && r.made) ? r.amount : sats), { made: !!(r && r.made) });
      });
    }).then(function (r) { cardOutDone(id); return r; }, function (e) { cardOutDone(id); throw e; });
  }

  /* A hold made for this phone's own invoice (`tillKeeps`: a dollar card paying a bitcoin receive, 26f-flashcard.js `fcBtcPay`)
   * whose payment was not made: the card paid this phone, and the pieces are this phone's, into its pile of their unit (under
   * the proof lock). The melt then spent exactly the card's pieces and nothing of this phone's, and where it does not go, the
   * money is where a payment to this phone always is. Resolves { unit, amount, sats, kept }. */
  function cardOutKeep(id) {
    var h0 = load(K.held, {})[id];
    if (!h0 || h0.kind !== 'card out') return Promise.resolve({ unit: 'sat', amount: 0, sats: 0, kept: false });
    var hu = recordUnit(h0);
    var n = 0;
    return withProofs('cardOutKeep', function () {
      var h = load(K.held, {})[id];
      if (!h) return;
      n = sumProofs(h.proofs || []);
      releaseHeld(id, true);
    }).then(function () {
      cardOutDone(id);
      if (n > 0) console.log('[foxy] card: ' + cardSaid(n, hu) + ' a card paid this phone are in its pile; the payment they were held for was not made');
      return Object.assign(cardGot(hu, n), { kept: n > 0 });
    }, function (e) { cardOutDone(id); throw e; });
  }

  /* Holds left behind: older than CARD_OUT_STALE_MS, not in a payment now, and not the pieces of a melt that is still being
   * asked about (K.melting names its hold). Each goes back to its card. Asked when the wallet connects. */
  function cardOutsLeft() {
    var all = load(K.held, {});
    var melting = load(K.melting, []) || [];
    var ids = Object.keys(all).filter(function (id) {
      var h = all[id];
      if (!h || h.kind !== 'card out' || cardOutInUse(id)) return false;
      if (Date.now() - (Number(h.at) || 0) < CARD_OUT_STALE_MS) return false;
      return !melting.some(function (m) { return m && m.cardOut === id; });
    });
    var out = [];
    return ids.reduce(function (chain, id) {
      return chain.then(function () {
        return cardOutBack(id).then(function (r) { out.push(Object.assign({ id: id }, cardGot(r.unit, r.amount), { made: r.made, kept: !!r.kept })); },
                                    function () { out.push({ id: id, unit: 'sat', amount: 0, sats: 0, made: false }); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  /* What a card's swap gave this phone, as it lands (`receiveToken`, `opts.holdAs`): the pieces that make `keep` (the price, an
   * exact set, which the swap was cut to have) are held for the payment under `holdAs.id`, and the rest is answered, for the
   * pile. With no exact set (a card that does not sign once for a payment, cut otherwise) all of it is held, and the melt gives
   * back what it did not use. Written with mustSave: a hold that cannot be written fails the swap's landing, and its record
   * puts the pieces back by the ordinary recovery. `unit`: the swap's, which is the card's (sats when not named). */
  function cardOutHold(holdAs, fresh, mint, keep, unit) {
    var sorted = (fresh || []).slice().sort(function (a, b) { return satsOf(b.amount) - satsOf(a.amount); });
    var left = Math.max(0, Math.round(Number(keep) || 0)), pick = [], rest = [];
    sorted.forEach(function (p) {
      var a = satsOf(p.amount);
      if (left > 0 && a <= left) { pick.push(p); left -= a; } else rest.push(p);
    });
    if (left !== 0 || !pick.length) { pick = (fresh || []).slice(); rest = []; }
    var all = load(K.held, {});
    var u = unitOf(unit) || 'sat';
    all[holdAs.id] = Object.assign({ mint: mint, unit: u, proofs: pick, kind: 'card out', card: holdAs.card || '', forHash: holdAs.forHash || '',
                       token: holdAs.token || '', at: Date.now() }, holdAs.tillKeeps ? { tillKeeps: true } : {});
    mustSave(K.held, all);
    cardOutBusy[holdAs.id] = Date.now();
    console.log('[foxy] card: ' + cardSaid(sumProofs(pick), u) + ' it paid are held for its payment out of this phone' + (rest.length ? '; ' + cardSaid(sumProofs(rest), u) + ' to this phone\u2019s pile' : ''));
    return rest;
  }

  /* Pieces of a payment's melt that did not go, back into the hold they came from rather than the pile (`pay`, `sweepMelts`):
   * the card is owed them, and only `cardOutBack` gives them to it. Each piece once. */
  /* `when`: the time the hold is to have, and so how soon the sweep takes it (the sweep's own gives 0: it goes back at once). */
  function cardOutReturn(id, list, mint, extra, when) {
    var all = load(K.held, {});
    // a hold made again keeps the unit it is given (`extra.unit`, the pieces' own), sats when none is
    var h = all[id] || Object.assign({ mint: mint, unit: 'sat', proofs: [], kind: 'card out', at: Date.now() }, extra || {});
    var have = {};
    (h.proofs || []).forEach(function (p) { if (p && p.secret) have[p.secret] = true; });
    (list || []).forEach(function (p) { if (p && p.secret && !have[p.secret]) { have[p.secret] = true; h.proofs.push(p); } });
    // a hold given back by a payment is a fresh one: the sweep leaves it for CARD_OUT_STALE_MS, for the screen that is putting it back now
    h.at = when === undefined ? Date.now() : when;
    all[id] = h;
    mustSave(K.held, all);
    // given back by the sweep, it is nobody's payment any more: the next sweep for ones left behind takes it
    if (when !== undefined) cardOutDone(id);
  }

