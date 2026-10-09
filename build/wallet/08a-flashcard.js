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
  var CARD_SLOT_BYTES = 82;
  var CARD_PIECE_BYTES = 81;
  /* A mint's address as the card keeps it: 80 characters at the most, so that
   * the owner's proof and the whole record fit one command (the card's spec,
   * docs/FOXY-CARD-DAILY-LIMIT.md in https://github.com/getfoxy/card, section 4). */
  var CARD_MINT_MAX = 77;   // 80 before the design (card software 1.10): the proof, the record, the mint and it in one APDU
  var CARD_DAY = 86400;

  /* ---- INTERIM: the key a card checks the time against -------------------------
   *
   * A card keeps a clock of its own and a daily limit counted against it. The
   * clock is told the time under a signature, which the card checks against the
   * time key in its record, and this is that key's public half: set-up writes it
   * to every card. Its private half is built into this app (Foxy/Flashcard/
   * CardTime.swift), because there is no server yet.
   *
   * That is exactly as weak as trusting the receiving phone's own clock, and no
   * stronger. Anyone can take the private half out of the app and sign any time
   * they like, so a terminal built to cheat can tell a card it is a day later,
   * again and again in one tap. The limit bounds an honest receiver and the
   * holder's own overspending, and nothing else. A real signer replaces this by
   * provisioning: cards are given its public key instead (an owner does it, with
   * a card that is empty), and the card's code does not change. */
  var CARD_TIME_KEY = '04403d6dc56a7e17ce887410e510f6214ff8699d5e09bf43dbbbb4159a9856cd0fe0737a186bbc8cbdaa924c49c3e5bc390968348d30c1c5406ba530a040fb17f8';

  function cardHexOk(s, bytes) {
    return typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]*$/.test(s);
  }

  /* A piece's NUT-10 secret, as the card rebuilds it. `date` is its locktime
   * in seconds, 0 for none; with a date the refund key is named too. Throws on
   * anything that is not what a card could hold, since a secret built from a
   * wrong field is a piece nobody can spend. */
  function cardSecret(nonce, cardKey, date, refundKey, format) {
    var when = Number(date) || 0;
    var all = Number(format) === CARD_FORMAT_ALL;
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

  function cardIsAll(card) { return !!(card && card.info && card.info.format === CARD_FORMAT_ALL); }

  function cardU32(hex, at) { return parseInt(hex.substr(at * 2, 8), 16); }

  /* GET_INFO's twenty-nine bytes. `limit` is the most the card signs for in a
   * day, in sats, and 0 is no limit. `owner`: whether the card has an owner,
   * which changing its PIN, its limit and its record, and loading it with no
   * PIN, need the proof of. `now` is the card's own clock (0 until it has been
   * told the time), `windowStart` when its current day began and `spentToday`
   * what it has signed for since. */
  function cardInfoOf(hex) {
    var h = String(hex || '').toLowerCase();
    /* 42 bytes from a card that has the limit on one tap (1.3, asked with P1 = 1);
     * 30 from one that has not, which answers the same question with the thirty
     * it knows; a card of version 1.1 gives 29, without the last, and may still be read. */
    if (!cardHexOk(h, 42) && !cardHexOk(h, 30) && !cardHexOk(h, 29)) throw new Error('The card did not say what it is.');
    var tapKnown = h.length === 84;
    var b = function (i) { return parseInt(h.substr(i * 2, 2), 16); };
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
             tapStart: tapKnown ? cardU32(h, 34) : 0, tapSpent: tapKnown ? cardU32(h, 38) : 0,
             /* This tap is the one after a payment: the card lets pieces be put
              * on with no PIN (the change). Said by the card for this tap only. */
             changeDue: h.length >= 60 && b(29) === 1,
             /* `ownChange`: the card makes a payment's change itself (software
              * 1.12 and on; the capability byte does not say so, the version
              * does). A terminal names only how much, so nothing it chooses can
              * take the change; the limits and the wait are held to what leaves
              * the card for good; and the card keeps what the change is made of
              * until its pieces are written back (`cardOpenings`). */
             ownChange: b(8) === CARD_FORMAT_ALL && (b(0) > 1 || (b(0) === 1 && b(1) >= 12)) };
  }

  /* GET_CARD: format, set, unit, limit, refund key, time key, mint, and, from
   * card software 1.10, the card's design after the mint: a code of three
   * characters naming its face (docs/CARD-DESIGNS.md), or three zeros for none.
   * A card before 1.10 answers nothing after the mint. */
  function cardRecordOf(hex) {
    var h = String(hex || '').toLowerCase();
    if (!/^[0-9a-f]*$/.test(h) || h.length < 212) throw new Error('The card’s record could not be read.');
    var mintLen = parseInt(h.substr(210, 2), 16);
    var withDesign = h.length === (109 + mintLen) * 2;
    if (h.length !== (106 + mintLen) * 2 && !withDesign) throw new Error('The card’s record could not be read.');
    var refund = h.substr(14, 66);
    var timeKey = h.substr(80, 130);
    var mint = '';
    for (var i = 0; i < mintLen; i++) mint += String.fromCharCode(parseInt(h.substr(212 + i * 2, 2), 16));
    var design = '';
    if (withDesign) {
      for (var k = 0; k < 3; k++) design += String.fromCharCode(parseInt(h.substr(212 + (mintLen + k) * 2, 2), 16));
      if (!/^[A-Z0-9]{3}$/.test(design)) design = '';
    }
    return { format: parseInt(h.substr(0, 2), 16), set: h.substr(2, 2) === '01', unit: parseInt(h.substr(4, 2), 16) === 0 ? 'sat' : 'other',
             limit: cardU32(h, 3), refundKey: /^0+$/.test(refund) ? '' : refund, timeKey: /^0+$/.test(timeKey) ? '' : timeKey, mint: mint,
             design: design, designKnown: withDesign };
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
  function cardDesignNoted(key) {
    var all = load(CARD_DESIGNS, {});
    var code = (all && typeof all === 'object' && !Array.isArray(all)) ? String(all[key] || '') : '';
    return /^[A-Z0-9]{3}$/.test(code) ? code : '';
  }

  /* Whether a card's software carries a design in its record (1.10 and on): a
   * card before that refuses a record with one, by its length. */
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
   * under a limit. */
  function cardDayOf(info) {
    var limit = Number(info && info.limit) || 0;
    if (!limit) return { limited: false, limit: 0, spent: 0, left: null, turns: 0, now: Number(info && info.now) || 0, noTime: false };
    var now = Number(info.now) || 0;
    var begun = Number(info.windowStart) || 0;
    var over = now >= begun + CARD_DAY;
    var spent = over ? 0 : (Number(info.spentToday) || 0);
    return { limited: true, limit: limit, spent: spent, left: Math.max(0, limit - spent), turns: over ? 0 : begun + CARD_DAY,
             now: now, noTime: now === 0 };
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
   * one payment at once. It refuses nothing over it. For every limit's worth,
   * whole or in part, it does CARD_WAIT_SIGNS signatures of work before it
   * signs, one for each SPEND_ALL_SIGN it is sent, and answers each with "not
   * yet". It counts against no clock and remembers nothing from one payment to
   * the next, so there is nothing a terminal can replay or reset: a payment is
   * judged by its own size, every time.
   *
   * What the wait is charged on depends on the card. From software 1.12 it is
   * what leaves the card for good: the pieces less the change the card makes
   * for itself (`cardWaitSigns`), which is the price and the mint's fee on the
   * pieces, so overpaying costs no wait; and a payment within the limit that
   * makes change waits one limit's worth, three seconds, which a payment that
   * makes none does not. Before it, it was what the PIECES come to, the first
   * limit's worth free (`cardWaitSignsBefore`), which is why the pieces for
   * such a card were chosen to overpay the least.
   *
   * The dollars its holder set it in are kept here (CARD_PACE), because the
   * card can hold only sats and has no price: the holder's own phone sets the
   * card's sats to match again when it reads the card and the price has moved
   * (`cardLook`, `price`). */
  var CARD_WAIT_SIGNS = 4;
  // the longest a till asks anybody to hold a card for, in seconds: a payment that would wait longer is not begun
  var CARD_WAIT_MOST = 40;
  // and that many seconds as answers of "not yet", for a card that does not say how long it will be
  var CARD_WAIT_POLLS = 54;
  var CARD_PACE = 'foxy.flashcard.pace';
  // how far the price may move before the card's sats are set again
  var CARD_PACE_DRIFT = 0.02;

  /* What a payment waits under a limit of `limit` sats on one payment, in
   * signatures of work, by the rule of software 1.12: the card counts what
   * leaves it for good (`net`: the price and the mint's fee on the pieces; the
   * pieces less the change the card makes for itself), and a payment within the
   * limit that makes no change goes at once. Otherwise every limit's worth,
   * whole or in part, is a unit: ceil(net / limit) of them, and a payment within
   * the limit that makes change (`change`) is one. */
  function cardWaitSigns(limit, net, change) {
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

  function cardPaceAll() {
    var o = load(CARD_PACE, {});
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  }
  /* The dollars a card's limit was set in, or none (`usd` 0: set in sats, or no limit). */
  function cardPaceNote(cardKey, usd) {
    var all = cardPaceAll();
    if (usd > 0) all[cardKey] = { usd: Math.round(Number(usd) * 100) / 100, at: Date.now() };
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
   * two minutes on, which no phone's clock does (`clock`). */
  function cardLogOf(hex, wide) {
    var h = String(hex || '').toLowerCase();
    var each = wide ? 32 : 24;
    if (!/^[0-9a-f]*$/.test(h) || h.length < 32 || (h.length - 32) % each !== 0 || h.length > 32 + 8 * each) throw new Error('The card\u2019s log could not be read.');
    var taps = [];
    for (var at = 32; at < h.length; at += each) {
      var flags = parseInt(h.substr(at + 20, 2), 16);
      taps.push({ time: cardU32(h, at / 2), sats: cardU32(h, at / 2 + 4), pieces: parseInt(h.substr(at + 16, 2), 16),
                  refused: parseInt(h.substr(at + 18, 2), 16), tamper: (flags & 1) === 1,
                  // a payment in that tap was over the card's limit on one payment, and was waited for
                  waited: (flags & 2) === 2, clock: (flags & 4) === 4,
                  loads: wide ? parseInt(h.substr(at + 22, 2), 16) : 0, loaded: wide ? cardU32(h, at / 2 + 12) : 0 });
    }
    return { taps: cardU32(h, 0), sats: cardU32(h, 4), refused: cardU32(h, 8), tampers: cardU32(h, 12), last: taps };
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
    return t.ask(cardCommand(CARD_INS.log, 0, '', 0)).then(function (r) {
      if (r.sw !== '9000') return card;
      var log;
      try { log = /** @type {any} */ (cardLogOf(r.data, !!card.info.quick)); } catch (e) { return card; }
      var all = cardLogSeen();
      var was = all[card.key];
      // counts that are behind what was seen are another card's software (it was put on anew): no "since" from those
      var known = !!(was && log.taps >= was.taps && log.sats >= was.sats && log.refused >= was.refused && log.tampers >= was.tampers);
      log.since = known ? { taps: log.taps - was.taps, sats: log.sats - was.sats, refused: log.refused - was.refused,
                            tampers: log.tampers - was.tampers, at: Number(was.at) || 0 } : null;
      all[card.key] = { taps: log.taps, sats: log.sats, refused: log.refused, tampers: log.tampers, at: Date.now() };
      try { save(CARD_LOG_SEEN, all); } catch (e2) {}
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

  /* GET_LOG, P1 = 1: the count (4), then receipts of 73 bytes, newest first. */
  function cardReceiptsOf(hex) {
    var h = String(hex || '').toLowerCase();
    if (!/^[0-9a-f]*$/.test(h) || h.length < 8 || (h.length - 8) % 146 !== 0 || h.length > 8 + 3 * 146) throw new Error('The card\u2019s receipts could not be read.');
    var list = [];
    for (var at = 8; at < h.length; at += 146) {
      list.push({ time: cardU32(h, at / 2), sats: cardU32(h, at / 2 + 4), hash: h.substr(at + 16, 64), out: h.substr(at + 80, 66) });
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
    var page = function (back, count) {
      return t.ask(cardCommand(CARD_INS.log, 1, '', 0, back)).then(function (r) {
        if (r.sw !== '9000') return null;
        var got = cardReceiptsOf(r.data);
        if (mine && got.count < Number(mine.count)) have = [];
        var known = (mine && got.count >= Number(mine.count)) ? Number(mine.count) : 0;
        got.list.forEach(function (x, k) {
          var n = got.count - back - k;
          if (n > known) fresh.push({ n: n, time: x.time, sats: x.sats, hash: x.hash, out: x.out });
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
      card.receipts = { count: count, list: list, fresh: fresh.length };
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
            if (slot.state !== 'unspent' || slot.amount !== satsOf(p.amount) || (Number(slot.date) || 0) !== (Number(p.date) || 0)
                || cardFullId(w, slot.keyset) !== String(p.id).toLowerCase()) {
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
                   spend: '20', begin: '22', outputs: '23', signAll: '24', again: '25', change: '26', load: '30', clear: '31', setCard: '32', setLimit: '34', time: '35',
                   verify: '40', setPin: '41', changePin: '42', setOwner: '43', nonce: '44', allowLoad: '45' };

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
   * is where the card knows no other way. */
  function cardVerify(t, card, pinHex) {
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

  /* The card told the time, under the phone's signature of its own clock
   * (`cardTime`: INTERIM, see CARD_TIME_KEY). Resolves the card's clock as it
   * stands. A card that has no record yet has no time key to check against and
   * says so: it is read as it was, and the answer is 0. A card at another signer
   * is not a card this Foxy can use. */
  function cardTold(t) {
    return nativeJson('cardTime', {}, 20000).then(function (j) {
      var time = Number(j && j.time);
      var sig = String((j && j.sig) || '').toLowerCase();
      if (!(time > 0 && time <= 4294967295 && Math.floor(time) === time) || !/^(?:[0-9a-f]{2}){8,72}$/.test(sig)) throw new Error('not a time');
      return { time: time, sig: sig };
    }).then(function (signed) {
      // this phone's own clock, as it has just told the card: what the card's is held to (`cardLook`, `clockAhead`)
      t.phoneTime = signed.time;
      return t.ask(cardCommand(CARD_INS.time, 0, cardU32Hex(signed.time) + cardByte(signed.sig.length / 2) + signed.sig, 4)).then(function (r) {
        if (r.sw === '6a8c' || r.sw === '6d00') return 0;
        if (r.sw !== '9000') throw cardRefused(r.sw, 'the time');
        return cardU32(r.data, 0);
      });
    }, function (e) {
      if (e && e.card) throw e;
      throw cardError('no-time-source', 'This phone could not sign the time for the card.');
    });
  }

  /* The card's limit set to `sats` with the owner's proof, in this tap (zero is
   * no limit). No PIN: the owner's phone does not know it. A card that has
   * never been told the time takes none but zero (`cardTold` first). Rejects
   * `not-owner` where this phone's words are not the ones the card was set up
   * with, and `no-owner` where it has none. */
  /* `tapSats`, where given, sets the limit on one tap in the same command (the
   * day's, then the tap's: eight bytes). There a limit whose number does not
   * change keeps its window and its count, so setting one of the two does not
   * begin the other again. Without it the command is the four bytes it always
   * was, and the tap's limit is left as it is. */
  function cardLimitTo(t, cardKey, sats, tapSats) {
    var n = Math.round(Number(sats));
    if (!(n >= 0 && n <= 4294967295)) return Promise.reject(cardError('bad-limit', 'That is not a limit a card can hold.'));
    var value = cardU32Hex(n);
    if (tapSats !== undefined && tapSats !== null) {
      var m = Math.round(Number(tapSats));
      if (!(m >= 0 && m <= 4294967295)) return Promise.reject(cardError('bad-limit', 'That is not a limit a card can hold.'));
      value += cardU32Hex(m);
    }
    return cardOwned(t, cardKey, 'set-limit', value).then(function (data) {
      return t.want(cardCommand(CARD_INS.setLimit, 0, data), 'its limit');
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
   * time first (every tap does: `cardTold`), so what it says of its day is
   * what it will act on.
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
   * `opts.mine`: this phone's own reading of a card, for its holder's screen and
   * for what only an owner does. The card is asked whether this phone is its
   * owner (`card.mine`, by the grant to load, which also lets this tap load with
   * no PIN); and a limit that an earlier tap lifted and did not put back is put
   * back now. */
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
    return t.ask('00a40400' + cardByte(CARD_AID.length / 2) + CARD_AID + '00').then(function (r) {
      if (r.sw !== '9000' || r.data.length !== 4) throw cardError('not-a-card', 'That is not a Foxy card.');
      mark('chosen');
      if (o.noTime || (one && one.told)) return 0;
      return cardTold(t).then(function (x) { if (one) one.told = true; return x; });
    }).then(function () {
      mark('time');
      // P1 = 1: with the limit on one tap, from a card that has one; an older card answers as it always did
      return t.want(cardCommand(CARD_INS.info, 1, '', 0), 'to say what it is');
    }).then(function (d) {
      card.info = cardInfoOf(d);
      if (card.info.format !== CARD_FORMAT && card.info.format !== CARD_FORMAT_ALL) throw cardError('not-a-card', 'That card is a kind this Foxy does not know.');
      mark('what it is');
      if (one && one.key) return one.key;
      return t.want(cardCommand(CARD_INS.key, 0, '', 0), 'to give its key');
    }).then(function (d) {
      if (!cardHexOk(d, 33) || !/^0[23]/.test(d)) throw cardError('not-a-card', 'That card\u2019s key is not a key.');
      card.key = d;
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
      card.record = cardRecordOf(d);
      // the design the card names for its face, where its software carries one; a phone's own file may say otherwise for an older card
      card.design = card.record.design || '';
      mark('record');
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
      card.balance = card.pieces.reduce(function (n, x) { return n + x.amount; }, 0);
      card.day = cardDayOf(card.info);
      card.tap = cardTapOf(card.info);
      /* A card's clock that is ahead of this phone's: somebody has told it a
       * time that had not come. The card cannot know, and takes any later
       * time it is told; this phone can, by its own. Five minutes is allowed
       * for a phone whose clock is a little out. */
      var here = Number(t.phoneTime) || Math.floor(Date.now() / 1000);
      card.clockAhead = (card.info.now > here + 300) ? card.info.now - here : 0;
      if (card.clockAhead) console.warn('[foxy] card: its clock is ' + card.clockAhead + ' seconds ahead of this phone\u2019s: it has been told a time that had not come');
      if (!o.mine || !card.info.owner || card.info.locked) return said(card);
      /* Whether this phone is the owner, and a limit it lifted and did not put back */
      return cardGrant(t, card.key).then(function (yes) {
        card.mine = yes;
        /* The quicker card says its limit on one payment to its owner only,
         * with the grant just given: asked again, now that it knows this
         * phone is that. To anybody else it says none (`cardTapOf`, `hidden`). */
        if (!yes || !card.info.quick) return yes;
        return t.want(cardCommand(CARD_INS.info, 1, '', 0), 'to say its limit').then(function (d) {
          card.info.tapLimit = cardInfoOf(d).tapLimit;
          card.tap = cardTapOf(card.info);
          return yes;
        });
      }).then(function (yes) {
        var note = cardLiftedAll()[card.key];
        if (!yes || !note || card.info.limit !== 0 || card.info.tapLimit !== 0) return card;
        var tapBack = card.info.tapKnown ? (Number(note.tap) || 0) : undefined;
        return cardLimitTo(t, card.key, note.limit, tapBack).then(function () {
          cardLiftNote(card.key, 0);
          // as the card has it now: the limits back, and a day and a tap begun at its clock with nothing spent
          card.info.limit = note.limit; card.record.limit = note.limit;
          card.info.windowStart = card.info.now; card.info.spentToday = 0;
          if (tapBack) { card.info.tapLimit = tapBack; card.info.tapStart = card.info.now; card.info.tapSpent = 0; }
          card.day = cardDayOf(card.info);
          card.tap = cardTapOf(card.info);
          card.restored = note.limit || tapBack || 0;
          console.log('[foxy] card: a limit lifted for a withdrawal and not put back is put back now');
          return card;
        }, function () { return card; });
      }).then(function (c) {
        mark('owner');
        /* The limit on one payment was set in dollars, and the price has
         * moved: the card's sats are set to match, with the owner's proof. */
        var want = (c.mine && c.info.paced) ? cardPaceSats(c.key, o.price) : 0;
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
  /* DUE: change a card is owed for a payment, which the swap that makes it
   * failed to make. The payment stands, and this phone holds the change (its
   * entry says the gross, 'never sent') until `cardDueRetry`, on every
   * connection, makes it and owes it to the card like any other change. It
   * was kept for good, before, and the card's holder never told. Given up
   * after CARD_DUE_DAYS, when the receiver keeps it as before. */
  var CARD_DUE = 'foxy.flashcard.due';
  var CARD_DUE_DAYS = 30;
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
  // the most pieces one load onto a wide card is, and the most its change is cut into
  var CARD_WIDE_LOAD = 112;
  var CARD_WIDE_CHANGE = 32;

  /* As `cardLadder`, for a card with a deep drawer. `extra` is always 0, but
   * where not even the plain powers of two fit `most` pieces: then the amount
   * is cut as a card of fewer places would have it (`cardLadder`), which may
   * round it up. */
  function cardDeepLadder(sats, most, biggest, have) {
    var n = Math.max(0, Math.floor(Number(sats) || 0));
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
    for (var deep = CARD_DEEP; deep >= 0; deep--) {
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
    return cardIsDeep(card) ? cardDeepLadder(sats, most, biggest, have) : cardLadder(sats, most, biggest, have);
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
    var limit = Math.floor(Number(card && card.info && card.info.tapLimit) || 0);
    if (!(limit > 0) || !cardIsDeep(card)) return most;
    var cap = 1;
    while (cap * 2 <= limit) cap *= 2;
    return most > 0 ? Math.min(cap, most) : cap;
  }

  /* What a card holds in pieces larger than its limit on one tap: the money a
   * till holds longer for. 0 where there is no limit, or none are. */
  function cardAboveLimit(card) {
    var limit = Math.floor(Number(card && card.info && card.info.tapLimit) || 0);
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
    var gone = {}, onCard = {}, out = [];
    (except || []).forEach(function (nonce) { gone[nonce] = true; });
    ((card && card.pieces) || []).forEach(function (x) {
      onCard[x.nonce] = true;
      if (!gone[x.nonce]) out.push(satsOf(x.amount));
    });
    cardStore(CARD_OWED).forEach(function (r) {
      if (!r || !card || r.card !== card.key || r.stuck) return;
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
    return cardChangeFor(sats, cardRoomFor(card, except), top, cardHeldAmounts(card, except), cardIsDeep(card));
  }

  /* The same cut from its parts: `sats` of change in no more than `room` pieces
   * for a card that holds `held` (amounts). A payment is chosen by what this
   * would give back (`cardPick`), so the choosing and the making are one rule. */
  function cardChangeFor(sats, room, top, held, wide) {
    var cut = wide ? cardDeepLadder(sats, room, top, held) : cardLadder(sats, room, top, held);
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
      try { built = cardSecret(parts.nonce, card.key, parts.date, card.record.refundKey, card.info && card.info.format); } catch (e) { built = ''; }
      if (built !== String(pr.secret)) throw cardError('misfit', 'That ecash is not written the way this card writes it.');
      return { keyset: id, amount: satsOf(pr.amount), nonce: parts.nonce, C: String(pr.C).toLowerCase(), date: parts.date };
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
   * `cardOweBack`). */
  var CARD_CHANGE_MOST = 8;
  var CARD_CHANGE_PAGE = 3;
  /* And the pieces one payment asks the card to make. Each costs the card half a
   * second to a second of its own work while it is held to the phone (the card's
   * hardware notes: the hash to the curve), so eight is the longest tap this can
   * make, and a change that is fewer pieces holds it for less. The card's
   * capacity is the most there can be; this is how many are asked for. */
  var CARD_CHANGE_PIECES = 8;

  function cardOwnChange(card) { return !!(card && card.info && card.info.ownChange); }

  /* GET_CHANGE, the pages of it: the openings of the change the card has made
   * for itself and not yet been handed. Three to a page, each an amount (4), a
   * keyset (8), a date (4), a nonce (32) and a blinding factor (32). No PIN. */
  function cardOpenings(t) {
    var out = [];
    var page = function (n) {
      return t.want(cardCommand(CARD_INS.getChange, n, '', 0), 'to say what its change is made of').then(function (d) {
        var h = String(d || '').toLowerCase();
        var count = parseInt(h.substr(0, 2), 16);
        if (!/^[0-9a-f]+$/.test(h) || !(count >= 0 && count <= CARD_CHANGE_PAGE) || h.length !== 2 + count * 160) {
          throw cardError('refused', 'The card did not say what its change is made of.', { sw: '' });
        }
        for (var k = 0; k < count; k++) {
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
        pieces.push({ keyset: hit.keyset, amount: amount, nonce: hit.nonce, C: C, date: hit.date });
      } catch (e) { stuck.push({ blind: b, why: 'signature' }); }
    });
    return { pieces: pieces, stuck: stuck };
  }

  /* The change a payment's card has made for itself and is owed, by the payment's entry (`forHash`): the rows, and what they come to. */
  function cardBlindOwed(forHash) {
    var rows = cardStore(CARD_OWED).filter(function (r) { return r && Array.isArray(r.blind) && r.forHash === forHash; });
    return { rows: rows, sats: rows.reduce(function (n, r) { return n + (r.stuck ? 0 : Math.round(Number(r.sats) || 0)); }, 0) };
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
    return { id: 'change-' + spec.id, card: ch.card, kind: 'change', mint: ch.mint, blind: blind,
             sats: blind.reduce(function (n, b) { return n + b.amount; }, 0), date: Number(ch.date) || 0, forHash: ch.forHash, at: Date.now() };
  }

  /* A signature as the mint gave it, in the plain form a row keeps. */
  function cardSigOf(s) {
    var d = s && s.dleq && s.dleq.e && s.dleq.s ? { e: String(s.dleq.e), s: String(s.dleq.s) } : undefined;
    return { id: String(s.id), amount: Number(String(s.amount)), C_: String(s.C_).toLowerCase(), dleq: d };
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
    var CT = window.CashuTS;
    var outs = spec.change.outs.map(function (o) { return { amount: CT.Amount.from(o.amount), B_: o.B_, id: spec.keyset }; });
    return withTimeout(Promise.resolve(w.mint.restore({ outputs: outs })), 30000, 'the mint’s word on the card’s change').then(function (res) {
      var back = (res && res.outputs) || [], list = (res && res.signatures) || [], sigs = {};
      back.forEach(function (o, i) { if (o && o.B_ && list[i]) sigs[String(o.B_).toLowerCase()] = cardSigOf(list[i]); });
      var made = cardBlindRow(spec, sigs, w);
      if (!made) throw cardError('waiting', 'The mint has not said what it signed for the card’s change yet.', { id: row.id });
      var ours = made.id;
      mustSave(CARD_OWED, cardStore(CARD_OWED).filter(function (r) { return !(r && r.id === ours); }).concat([made]));
      cardSwapDrop(spec.id);
      console.log('[foxy] card: the card’s own change of a payment whose answer was lost is had from the mint, ' + made.sats + ' sats');
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
   * finished (`stuck`) is kept, marked, and left out of what is owed. */
  function cardWriteOwed(t, card, progress) {
    var mine = cardStore(CARD_OWED).filter(function (r) { return r && r.card === card.key && !r.stuck; });
    if (!mine.length) return Promise.resolve({ sats: 0, back: 0, change: 0, refund: 0, done: [], left: [] });
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
    var openings = null;
    var openingsOf = function () {
      if (openings) return Promise.resolve(openings);
      return cardOpenings(t).then(function (list) { openings = list; return list; });
    };
    var tell = function (info) { try { if (typeof progress === 'function') progress(info); } catch (e) {} };
    var done = [], left = [], sats = 0, back = 0, change = 0, refund = 0, stopped = null, misfit = null;
    // its used places freed first, where it has any: a card with none is not asked
    var walk = !(card.info && card.info.spent > 0) ? Promise.resolve() : t.want(cardCommand(CARD_INS.clear, 0, '', 1), 'to free its used places').then(function () {}, function (e) {
      // a locked card frees nothing, and may still have room
      if (!(e && e.card === 'locked')) throw e;
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
          // the card's own change is finished from its openings; any other row is the pieces its token holds
          got = row.blind ? openingsOf().then(function (list) { return cardBlindPieces(row, card, list); })
                          : Promise.resolve({ pieces: cardPiecesOf(row.token, card), stuck: [] });
        } catch (e) { misfit = misfit || e; left.push(row.id); return null; }
        return got.then(function (prep) {
          var pieces = prep.pieces;
          /* Three pieces to a command on a card that takes them (`quick`), one
           * on a card that does not: a command each was most of what loading
           * took. The card answers the place of each piece it stored; fewer
           * than were sent, and the next one was refused, so it is sent alone
           * to hear why, and the ones after it follow one at a time. */
          var todo = pieces.filter(function (piece) { return !onCard[piece.nonce]; });
          var size = (card.info && card.info.quick) ? 3 : 1;
          var send = function (some) {
            tell({ step: 'writing', i: written + 1, n: Math.max(toWrite, written + 1) });
            return t.want(cardCommand(CARD_INS.load, 0, some.map(cardPieceBytes).join(''), some.length), some.length > 1 ? 'some pieces' : 'a piece').then(function (d) {
              var stored = some.length === 1 ? 1 : Math.min(some.length, Math.floor(String(d || '').length / 2));
              for (var k = 0; k < stored; k++) { onCard[some[k].nonce] = true; written += 1; }
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
          var each = Promise.resolve();
          for (var from = 0; from < todo.length; from += size) {
            (function (some) { each = each.then(function () { return send(some); }); })(todo.slice(from, from + size));
          }
          return each.then(function () {
            // what could not be finished stays on file, marked, and is no longer owed: what is promised is what can be done
            var lost = prep.stuck.reduce(function (n, x) { return n + satsOf(x.blind.amount); }, 0);
            var worth = Math.max(0, Math.round(Number(row.sats) || 0) - lost);
            if (prep.stuck.length) {
              var kept = Object.assign({}, row, { blind: prep.stuck.map(function (x) { return x.blind; }), sats: lost, stuck: true,
                                                  why: prep.stuck[0].why, stuckAt: Date.now() });
              mustSave(CARD_OWED, cardStore(CARD_OWED).map(function (r) { return (r && r.id === row.id) ? kept : r; }));
              console.warn('[foxy] card: ' + lost + ' sats of the card’s own change cannot be finished (' + kept.why + '); kept, and not promised');
            } else {
              done.push(row.id);
              // off the list as each lands, so a card that leaves now owes only what is left
              mustSave(CARD_OWED, cardStore(CARD_OWED).filter(function (r) { return !(r && r.id === row.id); }));
            }
            sats += worth;
            // this phone's own card: what has just gone onto it is written down here, since a short read after it lists no nonces
            try { if (card.record && card.record.refundKey && cardsOnFile()[card.key]) cardRemember(card, pieces); } catch (xR) {}
            // a payment the mint refused, put back: said apart from a load or change, and each of those by what it was for
            if (row.kind === 'putback') back += worth;
            if (row.kind === 'change') change += worth;
            if (row.kind === 'refund') refund += worth;
            if (prep.stuck.length) return;
            // written: marked on the token's own note, so it is never taken for one that was not (`cardAdopt`). A payment put back has no note, nor has the card's own change
            if (row.kind !== 'putback' && !row.blind) { try { FoxyWallet.tag(row.id, { carded: Date.now() }); } catch (x0) {} }
            if (row.kind === 'change' && row.forHash) { try { amendTx(row.forHash, { changeState: 'given back', changeKept: true }); } catch (x) {} }
          }, function (e) { stopped = e; left.push(row.id); });
        }, function (e) { stopped = e; left.push(row.id); });
      });
    });
    return walk.then(function () {
      /* Nothing finished, but some pieces went on before the card left: said on
       * the error (`wrote`), so the screen can ask for the tap that finishes it
       * at once, as for any write cut short part way. */
      if (stopped && !done.length) {
        if (written > 0 && stopped && typeof stopped === 'object') { try { stopped.wrote = written; } catch (x) {} }
        throw stopped;
      }
      var why = stopped || misfit;
      return { sats: sats, back: back, change: change, refund: refund, done: done, left: left, why: why ? (why.card || 'refused') : '' };
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
   * its pieces back or none, the key its time is signed by, and its mint's
   * address as text. Throws where the address is one a card cannot hold.
   * `timeKey` is the card's own where it has one (a card moved to another mint
   * keeps its clock), and otherwise the interim key. */
  function cardRecordHex(refundKey, mint, timeKey, design) {
    var at = String(mint || '');
    if (!at || at.length > CARD_MINT_MAX || /[^\x20-\x7e]/.test(at)) throw cardError('bad-mint', 'This mint\u2019s address is too long for a card.');
    var key = String(timeKey || CARD_TIME_KEY).toLowerCase();
    if (!/^04[0-9a-f]{128}$/.test(key)) throw cardError('bad-key', 'That is not a key a card can check a time against.');
    var hex = '';
    for (var i = 0; i < at.length; i++) hex += cardByte(at.charCodeAt(i));
    // the design after the mint, only for a card whose software takes it (`cardCanDesign`): a code of three characters
    var code = String(design || '').toUpperCase();
    var tail = '';
    if (/^[A-Z0-9]{3}$/.test(code)) for (var k = 0; k < 3; k++) tail += cardByte(code.charCodeAt(k));
    return '00' + (refundKey || new Array(67).join('0')) + key + cardByte(at.length) + hex + tail;
  }

  /* A card on its way to another mint, told so.
   *
   * Money moved for a card is filed as owed to it at the mint it was moved
   * to (`cardPrepare`, `moving`). When that card is next written, at that
   * mint, its record is changed first. Only an empty card: the card itself
   * refuses to change mints under unspent pieces, and it is not asked to. So
   * a card never holds ecash of a mint it does not name, and a move cut short
   * before its second tap is finished by any later one. The record is the
   * owner's to change, with the owner's proof and no PIN, and it keeps the
   * time key the card has, so its clock stays. Answers whether it changed. */
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
    try { record = cardRecordHex(card.record.refundKey, here, card.record.timeKey, cardCanDesign(card) ? card.record.design : ''); } catch (e) { return Promise.reject(e); }
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
   * mint has, and not within a week of its date. */
  function cardUsable(card, w, own) {
    var now = Math.floor(Date.now() / 1000);
    var margin = own ? CARD_OWN_MARGIN : CARD_DATE_MARGIN;
    var out = /** @type {{ pieces: any[], stale: number, foreign: number }} */ ({ pieces: [], stale: 0, foreign: 0 });
    card.pieces.forEach(function (x) {
      var id = cardFullId(w, x.keyset);
      if (!id) { out.foreign += x.amount; return; }
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
      var after = back > 0 ? rest.concat(cardChangeFor(back, room, top, rest, cardIsDeep(card))) : rest;
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
    var back = function () {
      if (!lifted) return Promise.resolve();
      return cardLimitTo(t, card.key, card.record.limit, tapWas).then(function () {
        lifted = false;
        cardLiftNote(card.key, 0);
      }, function () { /* the note stays, and the next tap of this phone puts it back */ });
    };
    return cardVerify(t, card, pinHex).then(function () {
      if (!lift) return null;
      cardLiftNote(card.key, card.record.limit, tapWas);
      return cardLimitTo(t, card.key, 0, tapWas === undefined ? undefined : 0).then(function () { lifted = true; }, function (e) {
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
  // a top-up keeps the card's date while it is this far off, and takes a new one after
  var CARD_DATE_REUSE = 90 * 24 * 3600;

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
    return Promise.resolve().then(function () {
      // a token gathers the pieces of one keyset together: read back from one, they are in the order the swap will have them
      var token = CT.getEncodedToken({ mint: mintOf(w), proofs: bare, unit: 'sat' });
      // shaped as any receipt is, to fill this phone's own pile (`receiveToken`)
      /* As many of the pool's missing pieces as leave the whole swap at
       * CARD_OUTPUTS_MOST outputs or fewer, counting the powers of two the
       * library adds for the rest; none, where even a few are too many. */
      var pile = proofs(mintOf(w), 'sat'), shape = [];
      var ones = function (n) { var c = 0; while (n > 0) { c += n % 2; n = Math.floor(n / 2); } return c; };
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
      var plan = { id: piecesFingerprint(inputs), keyset: range.keysetId, counter: range.start,
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
    var old = Date.now() - (CARD_DATE_AHEAD + 35 * 24 * 3600) * 1000;
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
   * as the row the card is owed, before this returns (`cardBlindRow`). */
  function cardSwapFixed(w, text, spec) {
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
      if (!marks.length) return mine;
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
       * same sets are taken, for the change they bring back. */
      if (least) {
        var most = upper === null ? 281474976710655 : upper;
        for (i = 0; i < groups.length; i++) {
          var cheap = cardPickUnder(w, groups[i], want, most);
          if (cheap && cheap.length && cheap.length <= many) return cardRefillPick(w, groups[i], want, most, card, cheap, many);
        }
        /* The cheapest set is more pieces than one signature takes (a deep
         * drawer's small pieces, by the dozen): then the fewest pieces that
         * cover the price, and of those the cheapest. Not the set that keeps
         * the drawer whole, below: on a card that waits by what its pieces
         * come to, that one may be its largest piece, and a wait longer than
         * anybody holds a card. */
        for (i = 0; i < groups.length; i++) {
          var few = cardFewestCover(w, groups[i], want, upper, null);
          if (few && few.length && few.length <= many) return cardRefillPick(w, groups[i], want, most, card, few, many);
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
   * a year from now, every time. A one-signature card keeps the date it
   * already has (on it, or owed to it) while that is CARD_DATE_REUSE off or
   * more, so that what is put on it today can be spent in one signature with
   * what was put on it last month. */
  function cardDateFor(card) {
    var now = Math.floor(Date.now() / 1000);
    var fresh = now + CARD_DATE_AHEAD;
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
    return held >= now + CARD_DATE_REUSE ? held : fresh;
  }

  /* The sizes of the outputs the card is asked to make for itself (software
   * 1.12) of a payment's `back`, the pieces' worth over the price and the mint's
   * fee: cut for the card as its change always was, to fill the gaps in the
   * drawer it will then have (`cardChangeFor`), but in no more pieces than the card
   * keeps openings for (CARD_CHANGE_MOST), the places it will have, and the
   * outputs a request to the mint takes beside this phone's own. A change that
   * is more pieces than that gives the largest of them; what is left is made
   * here, after the swap, the way change was made before 1.12 (`cardOweBack`).
   * None where the card's outputs would not be of a keyset the mint signs for:
   * the card makes them in the keyset of its first piece, which has to be the
   * one in use. Largest first. */
  function cardOwnChangeCut(w, card, group, back) {
    var inUse = '';
    try { inUse = String(w.getOutputKeyset().id).toLowerCase(); } catch (e) { inUse = ''; }
    if (!inUse || !group.every(function (p) { return String(p.id).toLowerCase() === inUse; })) return [];
    var except = group.map(function (p) { var parts = cardSecretParts(p.secret); return parts ? parts.nonce : ''; });
    var room = Math.min(CARD_CHANGE_PIECES, CARD_CHANGE_MOST, cardRoomFor(card, except), Math.max(0, mintArrayCap(w) - CARD_OUTPUTS_MOST));
    if (!(room >= 1)) return [];
    return cardChangeFor(back, room, cardMaxPiece(w), cardHeldAmounts(card, except), cardIsDeep(card)).slice(0, room);
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
    return cardSwapPlan(w, group, split ? { want: wantN, split: split } : undefined).then(function (plan) {
      mark('set out');
      var slots = plan.inputs.map(function (p) { return slotOf[p.secret]; });
      var first0 = cardSecretParts(plan.inputs[0].secret);
      plan.changeInfo = { card: card.key, forHash: 'card-' + plan.id, date: first0 ? first0.date : 0, mint: canonicalMint(mintOf(w)) };
      // said in the log: how the change is made, and what is left of it for the second swap
      if (note && note.own && !note.all && plan.net > wantN) {
        console.log('[foxy] card: ' + (plan.change.length ? 'the card makes ' + plan.cardChange + ' sats of the change itself, in ' + plan.change.length + ' piece(s)' : 'no change is asked of the card')
          + (plan.net - wantN - plan.cardChange > 0 ? '; ' + (plan.net - wantN - plan.cardChange) + ' sats more are made here after the swap' : ''));
      }
      /* Written down before the card is asked. From SIGN on, what the card did
       * is not known until it answers, and this row is what its next tap is
       * read against. */
      cardSwapWrite(plan, { card: card.key, proofs: plan.inputs, want: wantN,
                            all: !!(note && note.all), memo: String((note && note.memo) || ''), at: Date.now() });
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
        return plan.change.reduce(function (chain, c) {
          return chain.then(function () {
            return t.ask(cardCommand(CARD_INS.change, 0, cardU32Hex(c.amount), 33));
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
          return t.want(cardCommand(CARD_INS.signAll, 0, '', 64), 'to sign for a payment').then(function (d) {
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
             * what it may be until it goes on past that. */
            try { if (typeof progress === 'function') progress({ step: 'waiting', polls: polls, seconds: Math.max(1, Math.round((Date.now() - since) / 1000)),
                                                                sum: plan.leaves, want: wantN, making: plan.cardChange > 0 && polls <= CARD_WAIT_SIGNS }); } catch (e) {}
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
    // how this card writes a piece's secret, for taking it back with no card to ask
    if (card.info && card.info.format) row.format = card.info.format;
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
  function cardSwapTaken(row, again) {
    return FoxyWallet.receiveToken(row.token, { hash: row.id, memo: row.memo || 'card',
                                                keptSats: row.all ? undefined : row.sats,
                                                changeSats: row.all ? undefined : (row.over > 0 ? row.over : undefined),
                                                grossSats: row.all ? undefined : row.worth,
                                                // what of the token went to outputs the card made for itself: not this phone's, and no fee
                                                toCard: row.all ? undefined : (row.cardChange > 0 ? row.cardChange : undefined),
                                                noPrecheck: !again, now: !again })
      .then(function (r) {
        mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && x.id === row.id); }));
        // 'card' is a move the screens say themselves; 'card payment' is announced like any other (16-history-lists.js)
        try { FoxyWallet.tag(row.id, { to: (row.memo === 'from card' || row.refund) ? 'card' : 'card payment' }); } catch (x) {}
        // and names the card, as a load's entry does: the card's own history is read from that (26f-flashcard.js)
        try { amendTx(row.id, { card: row.card }); } catch (x1) {}
        return cardChangeKept(row).then(function () { return { sats: (r && r.sats) || 0 }; });
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
          return cardChangeKept(row).then(function () { return { sats: Number(e.foxyTakenSats) || 0 }; });
        }
        var spent = !!(e && e.foxyMine) || /already spent|token already|already claimed|nothing to take/i.test(text) || Number(e && e.code) === 11001;
        /* An answer that was lost and then found by the wallet's own recovery
         * (`recoverSwaps`) has put the ecash in the pile and written the entry,
         * and the mint now calls the pieces spent, because they were: this
         * phone's own swap spent them. That is the payment, made. */
        if (again && spent && !(e && e.foxyMine) && FoxyWallet.txSeen(row.id)) {
          mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && x.id === row.id); }));
          try { FoxyWallet.tag(row.id, { to: (row.memo === 'from card' || row.refund) ? 'card' : 'card payment' }); } catch (x2) {}
          try { amendTx(row.id, { card: row.card, memo: row.memo || 'card' }); } catch (x3) {}
          // what this phone has of it: the card's own change (1.12) was never in its pile
          return cardChangeKept(row).then(function () { return { sats: Math.max(0, (Number(row.worth) || 0) - (Number(row.cardChange) || 0)) }; });
        }
        // a restored answer is not a refusal: the mint did the swap, and the ecash is back in the pile
        var status = Number((e && (e.status || (e.response && e.response.status))) || 0);
        var busy = status === 408 || status === 425 || status === 429;      // asked too often, or too soon: not a "no" to the pieces
        if (spent || (mintRefused(e) && !(e && e.recovered) && !busy)) return cardRefusal(row, e, !!(e && e.foxyMine));
        throw cardError('waiting', 'The card has signed and the mint has not answered yet. ' + text, { id: row.id });
      });
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
      var token = window.CashuTS.getEncodedToken({ mint: mintOf(w), unit: 'sat',
        proofs: good.map(function (p) { return { id: p.id, amount: p.amount, secret: p.secret, C: p.C }; }) });
      // owed first, then struck off: never in neither
      mustSave(CARD_OWED, cardStore(CARD_OWED).filter(function (r) { return !(r && r.id === 'back-' + row.id); })
        .concat([{ id: 'back-' + row.id, card: row.card, token: token, sats: sats, kind: 'putback', forHash: row.id, at: Date.now() }]));
      strike();
      console.warn('[foxy] card: the mint refused a payment the card had signed for (' + String((e && (e.message || e.detail)) || e).slice(0, 80)
        + '); ' + sats + ' sats of it are owed back to the card, ' + (sumProofs(all) - sats) + ' are spent');
      throw cardError('putback', 'The mint refused this payment, and the card has already signed for it. ' + sats
        + ' sats are waiting to go back onto the card at its next tap.', { owed: sats, lost: sumProofs(all) - sats, limited: !!row.limited, id: row.id });
    });
  }

  /* ---- a till with no route -------------------------------------------------
   *
   * Paid needs the mint's swap, and a phone with no route cannot ask. It can
   * still be handed a card's pieces, signed, and keep them to swap in when it
   * can, as it can be handed plain ecash and keep that on trust. The same risk
   * is run and the same question put to the person first, in front of the amount
   * (the HIGH RISK card): until this phone is online, the card's holder may still
   * spend what they have just paid with, from a copy of the card or by any
   * route to the mint, and the person who accepts it is the one who bears that.
   *
   * It is the card's own decision, and a switch of its own: plain ecash between
   * two offline phones stays as `OFFLINE_TO_OFFLINE` has it. One constant turns
   * this off, and a till with no route then refuses a card as it did.
   *
   * What it takes: an exact set of pieces only (a till with no route cannot make
   * change), a payment and not a withdrawal, and only when the person has said
   * yes (`o.trusted === true`, which the screen sets after the question). The
   * card's time and its day work as ever (the time is signed on this phone), and
   * every signature the card gives is checked here before anything is kept. The
   * pieces are kept as a trusted row of the unclaimed store, with a PENDING
   * entry, and `claimUnclaimed` swaps them in when there is a route, or marks
   * them taken back if the mint says they were spent. "Paid" is never said
   * here. */
  var CARD_OFFLINE = true;

  function cardOffline(on) {
    if (on !== undefined) CARD_OFFLINE = !!on;
    return CARD_OFFLINE;
  }

  /* The question, put to the person by the screen that registered for it
   * (`onOfflineOffer`). No screen means no. Resolves true only for a yes. */
  function cardOfflineAsk(sats) {
    var ask = FoxyWallet._onOfflineOffer;
    if (!CARD_OFFLINE || typeof ask !== 'function') return Promise.resolve(false);
    var asked;
    try { asked = ask({ sats: Math.round(Number(sats) || 0), id: 'card', purpose: 'card', scanned: true }); }
    catch (e) { return Promise.resolve(false); }
    return Promise.resolve(asked).then(function (yes) { return yes === true; }, function () { return false; });
  }

  /* The signed pieces, kept on trust. They are written down first as TAKEN, as
   * for any payment (the card has burned them and this is the only copy), and
   * moved into the unclaimed store; the row is struck off TAKEN once it is
   * safely there. */
  function cardKeepOnTrust(row, signed, card, w) {
    if (dleqAudit(w, signed).invalid) {
      throw cardError('bad-pieces', 'The card gave pieces the mint did not sign. Nothing was taken.', { id: row.id });
    }
    var already = unclaimed()[row.id];
    if (!already) keepUnclaimed(row.id, row.token, row.worth, true);
    logTx({ dir: 'in', sats: row.sats, feeSats: 0, settled: false, state: 'pending', trusted: true,
            memo: 'card, offline', card: card.key, hash: 'req-' + row.id }, 'req-' + row.id);
    mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && x.id === row.id); }));
    console.log('[foxy] offline: ' + row.sats + ' sats signed by a card taken on trust, to be swapped in when there is a route');
    return { sats: row.sats, hash: 'req-' + row.id };
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
    if (!w || !routeOpen()) return Promise.resolve({ sats: Number(r.worth) || 0, made: false });
    return cardReturn(plain, null, w, null).then(function (made) {
      return { sats: (made && made.sats) || 0, made: !!made };
    }, function () { return { sats: 0, made: false }; });
  }

  /* The one flow behind being paid by a card and emptying one (21a-flashcard.js). */
  function cardTake(link, o, memo) {
    // `info`: what a step is about, where the screen needs it (the payment's entry, for a step after the card has signed)
    var on = function (step, info) { try { if (typeof o.on === 'function') o.on(step, info); } catch (e) {} };
    var pin;
    try { pin = cardPinHex(o.pin); } catch (e) { return Promise.reject(e); }
    var want = o.all ? 0 : Math.round(Number(o.sats));
    if (!o.all && !(want > 0)) return Promise.reject(cardError('bad-amount', 'Ask for an amount above zero.'));
    var w;
    /* No route: refused, as it always was, unless this is a payment the person
     * has said yes to taking on trust (`cardKeepOnTrust`). */
    var offline = !routeOpen();
    if (offline && !(CARD_OFFLINE && o.trusted === true && !o.lift && !o.all)) {
      try { need(); } catch (e2) { return Promise.reject(e2); }
      return Promise.reject(cardError('no-route', 'There is no connection to the mint, so the card was not asked for anything.'));
    }
    try { w = offline ? needLocal() : need(); } catch (e3) { return Promise.reject(e3); }
    var t = cardTalk(link);
    var card, picked, worth, fee, row, result, own, cap, tapCap = null, lift = false, released = false, signedNonces = [];
    // a one-signature card (format 4): the signatures it is asked for, and rows beside this payment's own to swap with it
    var all4 = false, groups = [], moreRows = [], cheaper = null;
    // a card that makes a payment's change itself (software 1.12): it is asked to, for a payment made online (`cardOwnChangeCut`)
    var ownChange = false;
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
      var no = cardUnusable(card, w);
      if (no) throw no;
      all4 = cardIsAll(card);
      ownChange = all4 && cardOwnChange(card) && !o.all && !offline;
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
            var token = window.CashuTS.getEncodedToken({ mint: mintOf(w), proofs: f.signed, unit: 'sat' });
            // the change the card made for itself in that swap (software 1.12), which is not this phone's to give back and not a fee
            var madeBy = f.spec.change && Array.isArray(f.spec.change.outs) ? f.spec.change.outs.reduce(function (n, x) { return n + satsOf(x.amount); }, 0) : 0;
            var kept = a.all
              ? { id: id, token: token, sats: Math.max(0, sum - cost), worth: Math.max(0, sum - cost), over: 0, all: true, card: card.key,
                  memo: a.memo || memo, at: Date.now(), partial: true }
              : { id: id, token: token, sats: 0, worth: sum, over: sum, all: false, card: card.key, memo: 'card, not completed',
                  at: Number(a.at) || Date.now(), refund: true, resume: { want: a.want }, cardChange: madeBy };
            mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).concat([kept]));
            if (a.all && (o.all || o.lift) && !offline) moreRows.push(kept);
          }
          cardSwapSettled(f.spec.id);
        });
      });
    }).then(function () {
      own = cardMine(card);
      // this phone's own card, read and proved: what is on it now is written down, as at any other read
      if (own && card.proved) cardRemember(card, card.pieces, true);
      var usable = cardUsable(card, w, own);
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
      cap = (day.limited && !lift) ? day.left : null;
      /* From 1.12 the day is charged what leaves the card for good, the price and the mint's fee on the pieces, and not the pieces
       * whole: so no set is turned away for being worth more than the day has left, and the day is held to the price below. */
      var capSets = ownChange ? null : cap;
      /* And what is left of this tap, where the card has a limit on one: no
       * set of pieces may come to more, and one that would is not asked for.
       * It is not something a larger piece uses up for later, as the day is,
       * so a set chosen to keep the drawer whole is still chosen under it. */
      // a limit on one payment that is waited for caps nothing (`paced`): it is paid for in time, below
      tapCap = (tap.limited && !tap.paced && !lift) ? tap.left : null;
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
        if (tornSats > 0) console.warn('[foxy] card: ' + tornSats + ' sats the card signed as it was taken away never reached this phone; that piece cannot be spent');
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
        cheaper = ownChange ? null : ((picked && /** @type {any} */ (picked).fallback) || null);
      }
      /* Taken up, and the card cannot make the rest (often because of a piece
       * lost as it left): the payment cannot be finished with this card, and
       * what it signed for it goes back to it now. */
      if (held && rest > 0 && (!picked || !picked.length)) {
        var heldNow = held;
        return cardHeldRelease(heldNow, offline ? null : w).then(function (back) {
          throw cardError('not-enough', 'The card holds ' + card.balance + ' sats, and ' + rest + ' of this payment were still to pay.'
            + (tornSats > 0 ? ' ' + tornSats + ' sats it signed as it was taken away never reached this phone.' : ''),
            { balance: card.balance, still: rest, held: heldWorth, torn: tornSats, letGo: back });
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
          throw cardError('limit', 'This card can spend ' + cap + ' sats more today, and this payment needs more than that.',
                          { left: cap, need: need, turns: turns, limit: day.limit });
        }
        if (need > 0 && tapCap !== null && need > tapCap) {
          throw cardError('tap-limit', 'This card can spend ' + tapCap + ' sats in this tap, and this payment needs more than that.',
                          { left: tapCap, need: need, turns: tap.turns, limit: tap.limit });
        }
      }
      if (offline && (!picked || !picked.length) && card.balance >= rest && !(usable.stale > 0 && usable.pieces.length === 0)) {
        throw cardError('inexact', 'This phone is offline, so it cannot give change, and this card does not hold pieces that make exactly '
          + want + ' sats. Pay an amount it can make, or pay when this phone is online.', { balance: card.balance });
      }
      /* A one-signature card that holds enough, in pieces of more than one
       * date (it was topped up near the end of its year): one payment is of one
       * date's pieces, and no date's alone will do. Said as what it can pay. */
      if (all4 && (!picked || !picked.length) && !offline && sumProofs(have) >= rest) {
        var most = cardDateGroups(have).reduce(function (n, g) { return Math.max(n, sumProofs(g)); }, 0);
        if (most < sumProofs(have)) {
          throw cardError('two-dates', 'This card’s money was put on it at two different times, and one payment can use only one of them. '
            + 'The most it can pay at once is ' + most + ' sats: take the payment in two parts.', { balance: card.balance, most: most });
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
          throw cardError('too-many', 'This card can pay ' + atOnce + ' sats at once, and no more: its money is in more pieces than it signs for in one go. Take it in parts.',
                          { balance: card.balance, most: atOnce });
        }
      }
      if (!picked || !picked.length) {
        if (usable.stale > 0 && card.balance >= rest) {
          throw own
            ? cardError('past-date', 'This card\u2019s date has passed. Its money comes back to this phone with TAKE IT BACK, and needs no card.', { stale: usable.stale })
            : cardError('renew', 'This card must be renewed by its owner before it can pay.', { stale: usable.stale });
        }
        throw cardError('not-enough', 'The card holds ' + card.balance + ' sats.', { balance: card.balance });
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
      if (groups.length > 1 && !o.all) throw cardError('not-enough', 'The card holds ' + card.balance + ' sats.', { balance: card.balance });
      if (groups.length > 1) {
        fee = groups.reduce(function (n, g) { var f = swapFeeFor(w, g); return n + ((isFinite(f) && f > 0) ? f : 0); }, 0);
      }
      /* What the card will make this payment wait, known before its PIN is
       * sent: said to the screen, and where it is longer than anybody holds a
       * card, the payment is not begun and the most that can be taken is said. */
      if (tap.paced && tap.limited && !lift) {
        // from 1.12 what leaves the card (the price and the fee on the pieces) and whether it makes change; before, the pieces whole
        var signs = ownChange ? cardWaitSigns(tap.limit, want + fee, worth - fee > want)
          : groups.reduce(function (n, g) { return n + cardWaitSignsBefore(tap.limit, sumProofs(g)); }, 0);
        var secs = cardWaitSeconds(signs);
        if (secs > CARD_WAIT_MOST) {
          var mostNow = (Math.floor(CARD_WAIT_MOST / cardWaitSeconds(CARD_WAIT_SIGNS)) + 1) * tap.limit;
          throw cardError('tap-limit', 'This card would have to be held for ' + secs + ' seconds to pay this. Take it in parts of '
            + mostNow + ' sats or less.', { left: mostNow, need: sumProofs(picked), limit: tap.limit, wait: secs, paced: true });
        }
        if (signs > 0) { try { if (typeof o.progress === 'function') o.progress({ step: 'waiting', left: signs, seconds: secs, ahead: true }); } catch (eW) {} }
      }
      if (o.all) want = worth - fee;
      if (!(want > 0) || worth - fee < want) throw cardError('not-enough', 'The card holds ' + card.balance + ' sats.', { balance: card.balance });
      /* A card that signs for three pieces and refuses the fourth has spent
       * three for a payment that was not made, so the limit is checked for the
       * whole set before the first is asked for. */
      // what was held is already in the card's day: only what is signed now is charged to it
      if (cap !== null && (ownChange ? want + fee : sumProofs(picked)) > cap) {
        throw cardError('limit', 'This card can spend ' + cap + ' sats more today, and this payment needs more than that.',
                        { left: cap, need: ownChange ? want + fee : sumProofs(picked), turns: turns, limit: day.limit });
      }
      if (tapCap !== null && sumProofs(picked) > tapCap) {
        throw cardError('tap-limit', 'This card can spend ' + tapCap + ' sats in this tap, and this payment needs more than that.',
                        { left: tapCap, need: sumProofs(picked), turns: tap.turns, limit: tap.limit });
      }
      // chosen from the brief listing: the pieces themselves are asked for now, before the PIN
      return cardFill(t, card, picked, w);
    }).then(function (early) {
      // a payment that ended above (a held one let go) has its answer already
      if (early !== undefined) return early;
      on('signing');
      if (!all4) return cardSign(t, card, picked, pin, lift, o.progress);
      /* Each signature's row is written down as it arrives, before the card is
       * asked for the next: the row, with the outputs it was signed for
       * (CARD_SWAPS), is the only copy of the right to spend those pieces. */
      return cardSignAll(t, card, w, groups, pin, lift, o.progress, function (signedNow, plan) {
        var kept = { id: 'card-' + plan.id, token: window.CashuTS.getEncodedToken({ mint: mintOf(w), proofs: signedNow, unit: 'sat' }),
                     // what was signed for, which is the cheaper set where the card would have waited for the other
                     // `over`: what this phone makes of the change after the swap; `cardChange`: what the card made of it itself (1.12)
                     sats: o.all ? plan.net : want, worth: plan.net, over: o.all ? 0 : plan.net - want - plan.cardChange, cardChange: o.all ? 0 : plan.cardChange,
                     all: !!o.all, card: card.key, memo: memo, at: Date.now(), limited: !!(card.day && card.day.limited) };
        mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && held && x.id === held.id); }).concat([kept]));
        return kept;
      }, { want: want, all: !!o.all, memo: memo, own: ownChange },
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
      if (made.length) {
        row = made[0];
        moreRows = moreRows.concat(made.slice(1));
      } else {
        var token = window.CashuTS.getEncodedToken({ mint: mintOf(w), proofs: signed, unit: 'sat' });
        // a payment taken up that was signed with the card's own change in it: that part of the change is not this phone's to make
        var spec0 = cardSwapFor(signed);
        var cc0 = (spec0 && spec0.change && Array.isArray(spec0.change.outs)) ? spec0.change.outs.reduce(function (n, x) { return n + satsOf(x.amount); }, 0) : 0;
        row = { id: 'card-' + piecesFingerprint(signed), token: token, sats: want, worth: worth - fee, over: Math.max(0, worth - fee - want - cc0), cardChange: cc0,
                all: !!o.all, card: card.key, memo: memo, at: Date.now(), limited: !!(card.day && card.day.limited) };
        // written down before the card is let go: from here this row is the only copy of the right to spend the pieces (and the held one is part of it)
        mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && held && x.id === held.id); }).concat([row]));
      }
      if (offline) {
        var kept = cardKeepOnTrust(row, signed, card, w);
        on('done');
        return { sats: kept.sats, hash: kept.hash, trusted: true, change: null };
      }
      /* The card has done its part, and the mint's work takes as long as Tor
       * does: it is let go now, and the person is told so, and the rest is
       * done with Foxy's own screen saying so (`cardLetGo`). */
      // whether anything is coming back to the card in this sheet: its change, or a payment held for another amount
      var changeComing = row.over > 0 || row.cardChange > 0 || !!letGoAfter;
      return cardLetGo(link, o, changeComing).then(function () {
        released = !o.hold;
        if (!o.hold) console.log('[foxy] card: let go ' + (Date.now() - signedAt) + ' ms after it signed' + (changeComing ? ' (its sheet is kept for the change)' : ''));
        on(released ? 'checking' : 'mint', { hash: row.id });
        return cardSwapTaken(row, false);
      }).then(function (got) {
        // the other signatures of a whole card taken off, each its own swap
        return moreRows.reduce(function (chain, r) {
          return chain.then(function (sum) {
            return cardSwapTaken(r, false).then(function (g) { return { sats: (sum.sats || 0) + ((g && g.sats) || 0) }; });
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
            return cardSwapTaken(r, false).then(function (g) { return { sats: sum.sats + ((g && g.sats) || 0) }; });
          });
        }, Promise.resolve({ sats: 0 })).then(function (sum) {
          throw cardError('partial', 'The card was taken away before it had signed for all of it. ' + sum.sats
            + ' sats came off it into this phone; tap it again for the rest.',
            { sats: sum.sats, left: Math.max(0, card.balance - sumProofs(donePieces)), hash: doneRows[0].id });
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
                     token: window.CashuTS.getEncodedToken({ mint: mintOf(w), proofs: holding, unit: 'sat' }),
                     sats: 0, worth: sumProofs(holding), over: sumProofs(holding), all: false, card: card.key,
                     memo: 'card, not completed', at: Date.now(), refund: true, resume: { want: want, torn: torn } };
        mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && held && x.id === held.id); }).concat([keep]));
        console.warn('[foxy] card: the card signed for ' + some.length + ' of ' + picked.length + ' pieces and left; '
          + sumProofs(holding) + ' of ' + want + ' sats are held for its next tap, which signs the rest');
        throw cardError('interrupted', 'The card was taken away before it had signed for all of it. Nothing is paid yet: tap it again to finish.',
                        { owed: sumProofs(holding), held: sumProofs(holding), want: want, resumable: true, made: false });
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
        var part = { id: 'card-' + piecesFingerprint(some), token: window.CashuTS.getEncodedToken({ mint: mintOf(w), proofs: some, unit: 'sat' }),
                     sats: partKeep, worth: partNet, over: partNet - partKeep, all: !!o.all, card: card.key, memo: memo, at: Date.now(),
                     limited: !!(card.day && card.day.limited), partial: true };
        var partNonces = some.map(function (pr) { var parts = cardSecretParts(pr.secret); return parts ? parts.nonce : ''; });
        if (own) cardSpentHere(card.key, partNonces);
        mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).concat([part]));
        console.warn('[foxy] card: the card signed for ' + some.length + ' of ' + picked.length + ' pieces and left; what it signed is kept as part of the withdrawal');
        var rest = o.all ? Math.max(0, card.balance - sumProofs(some)) : Math.max(0, want - partKeep);
        return cardSwapTaken(part, false).then(function (got) {
          return cardOweBack(part, w, card, partNonces, got);
        }).then(function () {
          throw cardError('partial', 'The card was taken away before it had signed for all of it. ' + partKeep
            + ' sats came off it into this phone; tap it again for the rest.', { sats: partKeep, left: rest, hash: part.id });
        });
      }
      var back = { id: 'card-' + piecesFingerprint(some), token: window.CashuTS.getEncodedToken({ mint: mintOf(w), proofs: some, unit: 'sat' }),
                   sats: 0, worth: sumProofs(some), over: sumProofs(some), all: false, card: card.key, memo: 'card, not completed', at: Date.now(),
                   refund: true };
      mustSave(CARD_TAKEN, cardStore(CARD_TAKEN).filter(function (x) { return !(x && held && x.id === held.id); }).concat([back]));
      console.warn('[foxy] card: the card signed for ' + some.length + ' of ' + picked.length + ' pieces and left; what it signed goes back to it');
      var signedHere = some.map(function (pr) { var parts = cardSecretParts(pr.secret); return parts ? parts.nonce : ''; });
      return cardReturn(back, card, w, signedHere).then(function (made) {
        if (made) throw cardError('interrupted', 'The card was taken away too soon. Nothing was paid, and ' + sumProofs(some) + ' sats are waiting to go back on it.', { owed: sumProofs(some), made: true });
        throw cardError('interrupted', 'The card was taken away too soon. Nothing was paid; what it signed for will go back to it when the mint answers.', { owed: sumProofs(some), made: false });
      }, function () {
        throw cardError('interrupted', 'The card was taken away too soon. Nothing was paid; what it signed for will go back to it when the mint answers.', { owed: sumProofs(some), made: false });
      });
    }).then(function (got) {
      // held for another amount: let go now this payment is done (offline, at the next settling)
      if (offline) { if (letGoAfter) cardHeldRelease(letGoAfter, null); return got; }
      result = { sats: want, hash: row.id, change: null, torn: tornSats };
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
          var viaCard = promised > 0 ? cardBlindOwed(row.id).sats : 0;
          var madeHere = (!owe.unmade && owe.sats > 0) ? owe.sats : 0;
          var total = viaCard + madeHere;
          if (!(total > 0) && (owe.unmade || promised > 0)) { result.change = { sats: owe.unmade ? owe.owed : promised, written: false, unmade: true }; return null; }
          if (!(total > 0)) return null;
          /* The card has gone: its change waits for the next tap (RECEIVE). */
          if (released) { result.change = { sats: total, written: false }; return null; }
          /* Back onto the card now: the tap is still open and its PIN still
           * stands. Not read again first: choosing the applet again ends the
           * session the PIN was verified in, and what was read at the start
           * of the tap is still what is on the card but for what it spent. */
          return cardWriteOwed(t, card, o.progress).then(function (wrote) {
            result.change = { sats: total, written: wrote.left.length === 0 };
          }, function () {
            result.change = { sats: total, written: false };
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
    });
  }

  /* The card's part is over: it has signed, and nothing more is asked of it.
   * Its sheet is ended ("Done. Remove the card.") and the mint, which takes
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
      var line = 'Verifying the payment. Keep this open for your change.';
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
    var refundRow = !!row.refund;
    var owed = refundRow
      ? Math.max(0, Math.round(Number((got && got.sats) || row.worth) || 0))
      : (row.all ? 0 : Math.max(0, Math.round(Number(row.over) || 0)));
    /* What the card made of the change itself (software 1.12) is not made here and is owed
     * already (`cardSwapFixed`); the entry says so, with what is made here if any is. `owed` is
     * the part this phone makes, after the swap, from its own pile: all of the change before 1.12, and after it the
     * part the card was not asked for (more pieces than it keeps openings for, say). */
    var viaCard = row.all ? 0 : Math.max(0, Math.round(Number(row.cardChange) || 0));
    if (!(owed > 0)) {
      if (viaCard > 0) cardChangeNote(row, viaCard);
      return Promise.resolve({ sats: 0, owed: 0, kept: false });
    }
    var already = cardStore(CARD_OWED).some(function (r) { return r && !r.blind && r.forHash === row.id; });
    var entry = null;
    try { entry = (load(K.log, []) || []).filter(function (e) { return e && e.hash === row.id; })[0] || null; } catch (x0) { entry = null; }
    var settledState = entry && /^(not handed|given back|never came|never sent|came back)$/.test(String(entry.changeState || ''));
    // a retry (`opts.retry`) is of change that was never sent, and is made now (the card's own change, owed beside it, has said 'not handed' already)
    if (settledState && o.retry && (entry.changeState === 'never sent' || viaCard > 0)) settledState = false;
    if (already || settledState) return Promise.resolve({ sats: 0, owed: owed, kept: false });
    var back = changeFromPile(w, owed);
    if (!(back > 0)) {
      try { FoxyWallet.changeSettled(row.id, 0); } catch (x) {}
      return Promise.resolve({ sats: 0, owed: owed, kept: true });
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
      amendTx(row.id, refundRow ? { memo: 'card, not completed', changeState: 'making', changeSats: owed + viaCard, grossSats: owed + viaCard, sats: 0 }
                                : { changeState: 'making', sats: Math.max(0, Math.round(Number(row.sats) || 0)),
                                    grossSats: Math.max(0, Math.round(Number(row.worth) || 0)), changeSats: owed + viaCard });
    } catch (x1) {}
    try { if (typeof o.making === 'function') o.making(); } catch (x2) {}
    return FoxyWallet.sendToken(back, { unit: 'sat', lockTo: key, lockUntil: dated ? date : undefined,
                                        refundTo: dated ? refundKey : undefined, sigAll: sigAll,
                                        denominations: cardChangeCut(w, back, card, signedNonces),
                                        purpose: 'change', forHash: row.id, owed: owed })
      .then(function (made) {
        settleChangeMade(row.id, owed, { sats: made.sats, fee: made.fee, back: back });
        if (card) cardPiecesOf(made.token, card);
        mustSave(CARD_OWED, cardStore(CARD_OWED).concat([{ id: made.hash, card: key, token: made.token, sats: made.sats,
                                                           kind: refundRow ? 'refund' : 'change', forHash: row.id, at: Date.now() }]));
        try { amendTx(row.id, { changeState: 'not handed' }); } catch (x3) {}
        return { sats: made.sats, owed: owed, kept: false, made: made };
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
        return { sats: 0, owed: owed, kept: true, unmade: true, due: true };
      });
  }

  /* The entry of a payment whose change the card made for itself says it is owed to the card and not yet back on it
   * (as change made here does, `cardOweBack`): what was kept, what came in, and what goes back. Not over what has been written already. */
  function cardChangeNote(row, sats) {
    try {
      var entry = (load(K.log, []) || []).filter(function (e) { return e && e.hash === row.id; })[0];
      if (entry && entry.changeState === 'given back') return;
      amendTx(row.id, { changeState: 'not handed', sats: Math.max(0, Math.round(Number(row.sats) || 0)),
                        grossSats: Math.max(0, Math.round(Number(row.worth) || 0)), changeSats: sats });
    } catch (e) {}
  }

  /* Change that could not be had yet, written down to be had again whenever this phone connects. `blind`: the card's
   * own change (software 1.12), whose signatures the mint has made and this phone has not heard, rather than change this
   * phone could not make; it is asked for (`cardChangeOwe`), and the two are noted apart, for a payment may owe both. */
  function cardDueNote(row, owed, blind) {
    var due = cardStore(CARD_DUE);
    if (due.some(function (d) { return d && d.forHash === row.id && !!d.blind === !!blind; })) return;
    mustSave(CARD_DUE, due.concat([{ forHash: row.id, card: row.card, token: row.token, sats: row.sats, worth: row.worth,
                                     owed: blind ? Math.round(Number(row.cardChange) || 0) : owed, refund: !!row.refund,
                                     blind: !!blind, cardChange: Math.round(Number(row.cardChange) || 0), at: Date.now() }]));
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
    return due.reduce(function (chain, d) {
      return chain.then(function () {
        if (!d || !d.forHash) return null;
        var drop = function () { mustSave(CARD_DUE, cardStore(CARD_DUE).filter(function (x) { return !(x && x.forHash === d.forHash && !!x.blind === !!d.blind); })); };
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
            out.push({ forHash: d.forHash, state: made ? 'made' : 'kept', sats: made ? made.sats : 0 });
          }, function () { out.push({ forHash: d.forHash, state: 'waiting', sats: 0 }); });
        }
        if (cardStore(CARD_OWED).some(function (r) { return r && !r.blind && r.forHash === d.forHash; })) { drop(); return null; }
        var tags = {};
        try { tags = FoxyWallet.tagsFor(d.forHash) || {}; } catch (x) { tags = {}; }
        // the recovery puts the change it found on the payment's entry, as a code to hand over (`owedChangeOnEntry`)
        var found = String(tags.changeToken || (tags.owedChange ? tags.token : '') || '');
        if (found) {
          var made = 0;
          try { made = sumProofs((FoxyWallet.tokenInfo(found) || {}).proofs || []); } catch (x1) { made = 0; }
          if (made > 0) {
            mustSave(CARD_OWED, cardStore(CARD_OWED).concat([{ id: 'due-' + d.forHash, card: d.card, token: found, sats: made,
                                                               kind: d.refund ? 'refund' : 'change', forHash: d.forHash, at: Date.now() }]));
            // the card's, now, and not a code for this phone to hand over
            try { FoxyWallet.tag(d.forHash, { changeToken: '', token: '', owedChange: false, handed: '' }); } catch (x2) {}
            try { amendTx(d.forHash, { changeState: 'not handed' }); } catch (x3) {}
            drop();
            out.push({ forHash: d.forHash, state: 'made', sats: made });
            return null;
          }
        }
        if (loadSwaps().some(function (r) { return r && r.pay && r.pay.forHash === d.forHash; })) {
          out.push({ forHash: d.forHash, state: 'waiting', sats: 0 });
          return null;
        }
        if (Date.now() - (Number(d.at) || 0) > CARD_DUE_DAYS * 86400000) {
          console.warn('[foxy] card: change due to a card for ' + CARD_DUE_DAYS + ' days was never made; the payment keeps it');
          drop();
          out.push({ forHash: d.forHash, state: 'kept', sats: 0 });
          return null;
        }
        var row = { id: d.forHash, token: d.token, sats: d.sats, worth: d.worth, over: d.owed, all: false, card: d.card, refund: !!d.refund,
                    cardChange: Math.round(Number(d.cardChange) || 0) };
        return cardOweBack(row, w, null, null, d.refund ? { sats: d.owed } : null, { retry: true }).then(function (r) {
          if (r && r.made) { drop(); out.push({ forHash: d.forHash, state: 'made', sats: r.sats }); return; }
          // too small to make after all: the payment keeps it, as a tap's would
          if (r && r.kept && !r.unmade) { drop(); out.push({ forHash: d.forHash, state: 'kept', sats: 0 }); return; }
          out.push({ forHash: d.forHash, state: 'waiting', sats: 0 });
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

