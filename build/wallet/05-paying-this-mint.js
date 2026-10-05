  /* ---- paying someone who uses the same mint ------------------------------
   *
   * Two people on one mint who pay by Lightning hand that mint both halves of
   * the payment: it makes the receiver's invoice and is asked to pay it by the
   * sender, so it knows which wallet paid which. A token handed over directly
   * leaves it only amount and timing (MINT-PRIVACY.md C6). The app offers a
   * token when an invoice was made by the mint this wallet pays from.
   *
   * An invoice is the mint's when the Lightning node that signed it is the
   * mint's node. That node is learned from invoices the mint makes for this
   * wallet, and once, if none has been made yet, from a small invoice asked for
   * on a circuit of its own and never paid. A fee quote cannot tell: a CDK mint
   * (Minibits among them) quotes a fee reserve for its own invoices too.
   * Checked in testing: minibits, macadamia, coinos and both testnut mints
   * each signed two invoices with one node key. A node a mint shares with other
   * services (coinos runs a wallet on its own) can make an invoice from that
   * service look like the mint's; the card still lets the payment go by
   * Lightning. */

  /* Pieces of `have` that add up to `want` plus the receiver's fee on them,
   * largest first; null when no such set is found. The fee depends on how many
   * pieces there are, so it is tried again with the fee added. */
  /* `beside`: pieces that go in the same token from somewhere else — ecash
   * locked to this phone, signed and handed on. The receiver pays the mint's
   * fee on those too, so it is counted here, on everything that travels
   * together. It was counted on the pile's pieces alone: a payment of ten
   * locked pieces and four loose ones added 1 sat for a fee of 3, landed 2
   * short and was refused (tools/live/offline-cross-scenarios.js
   * `soak-payer`). With `beside`, an empty pick is an answer:
   * the locked pieces cover the amount and there is no fee to find. */
  function exactPieces(w, have, want, beside) {
    var sorted = (have || []).filter(function (p) { return p && p.secret && satsOf(p.amount) > 0; })
      .slice().sort(function (a, b) { return satsOf(b.amount) - satsOf(a.amount); });
    var along = beside || [];
    var target = want;
    for (var round = 0; round < 4; round++) {
      var left = target, picked = [];
      for (var i = 0; i < sorted.length && left > 0; i++) {
        if (satsOf(sorted[i].amount) <= left) { picked.push(sorted[i]); left -= satsOf(sorted[i].amount); }
      }
      if (left !== 0 || (!picked.length && !along.length)) return null;
      var fee = swapFeeFor(w, picked.concat(along));
      if (!isFinite(fee)) return null;
      if (want + fee === target) return picked;
      target = want + fee;
    }
    return null;
  }

  /* Pieces that cover an amount this wallet cannot make exactly, with the least
   * over-payment it can manage.
   *
   * For a payer with no route. A swap is the ordinary way to make an awkward
   * amount and it needs a mint, so offline the choice is between paying a little
   * too much and not paying at all. Paying too much is only useful because the
   * change comes back: the receiver — who does have a route, or the payment
   * would have been refused before this — swaps and hands back the difference
   * locked to the payer, over the same Bluetooth link the payment went over
   * (changeBack, M7). Nobody has to see a QR and nobody has to trust anybody:
   * the change is locked to a key only the payer holds.
   *
   * Two candidates and the cheaper wins: the smallest single piece that covers
   * it, and the smallest ascending run that reaches it. That is not the optimal
   * subset — that is a knapsack, and this runs inside a render — but with a pool
   * of powers of two it is within one piece of optimal, and it is predictable,
   * which matters more when somebody is about to be told what change to expect.
   *
   * Returns { picked, total, over } or null when nothing covers it. `over` is
   * what the payer is owed back; a caller must not send without a key for it. */
  /* The same amount, made from pieces on hand AND ecash locked to this phone.
   *
   * Locked ecash cannot be broken up — a row is one token and `forwardLocked`
   * signs it whole — so each row is all or nothing, and the pile makes up
   * whatever is left. That is the whole trick: a stall that took 28 sats of
   * change this morning can pay 28 sats this afternoon without ever having had
   * a route.
   *
   * Fewest rows first, then fewest pieces: handing on two rows is two signatures
   * and two things for the receiver to swap, and the point of exact change is
   * that neither phone has to ask anybody anything.
   *
   * Returns { rows, pieces } or null. `rows` are whole locked rows to sign and
   * hand on; `pieces` come out of the pile as they always did. The fee is the
   * receiver's, over everything that ends up in the token. */
  /** @returns {?{ rows: any[], pieces: any[] }} */
  function exactWithLocked(w, have, rows, want) {
    if (!rows || !rows.length || !(want > 0)) return null;
    /* Capped, and it is not a limit anybody meets: rows are payments that
     * arrived while offline, and 2^12 subsets is instant. A wallet with more
     * than twelve waiting has a route to fix that. */
    var use = rows.slice(0, 12);
    /** @type {?{ rows: any[], pieces: any[] }} */
    var best = null;
    var consider = function (chosen) {
      var fromRows = 0;
      chosen.forEach(function (r) { fromRows += Number(r.sats) || 0; });
      if (fromRows > want) return;
      var left = want - fromRows;
      /* What the pile adds is what the rows leave, and the receiver's fee on
       * every piece in the token: the rows' own and the pile's. Where the
       * rows make the amount exactly and the mint charges nothing, that is
       * no pieces at all. */
      var along = [];
      chosen.forEach(function (r) { along = along.concat(r.proofs || []); });
      var pieces = exactPieces(w, have, left, along);
      if (!pieces) return;
      if (!best || chosen.length < best.rows.length
          || (chosen.length === best.rows.length && pieces.length < best.pieces.length)) {
        best = { rows: chosen, pieces: pieces };
      }
    };
    for (var mask = 1; mask < (1 << use.length); mask++) {
      var chosen = [];
      for (var i = 0; i < use.length; i++) if (mask & (1 << i)) chosen.push(use[i]);
      consider(chosen);
    }
    return best;
  }

  /** @returns {?{ picked: any[], total: number, over: number }} */
  function coverPieces(w, have, want, beside) {
    var usable = (have || []).filter(function (p) { return p && p.secret && satsOf(p.amount) > 0; });
    if (!usable.length || !(want > 0)) return null;
    // pieces that travel in the same token: the receiver's fee is on them too (`exactPieces`)
    var along = beside || [];
    var up = usable.slice().sort(function (a, b) { return satsOf(a.amount) - satsOf(b.amount); });

    /** @type {?{ picked: any[], total: number, over: number }} */
    var best = null;
    var consider = function (picked) {
      if (!picked || !picked.length) return;
      var total = 0;
      picked.forEach(function (p) { total += satsOf(p.amount); });
      /* The receiver's fee comes off what arrives, so it has to be covered too,
       * or the payment lands short and is refused for being under the amount. */
      var fee = swapFeeFor(w, picked.concat(along));
      if (!isFinite(fee)) return;
      if (total < want + fee) return;
      if (!best || total < best.total
          || (total === best.total && picked.length < best.picked.length)) {
        best = { picked: picked, total: total, over: total - want - fee };
      }
    };

    /* Until it covers the amount AND the receiver's fee on what was picked.
     * Both loops stopped at the amount, so at a mint that charges for a swap
     * the first candidate was always a sat or two short, was thrown out by
     * `consider`, and nothing else was tried: a wallet holding plenty was told
     * it needed a connection. */
    var enough = function (picked, total) {
      var fee = swapFeeFor(w, picked.concat(along));
      return isFinite(fee) && total >= want + fee;
    };
    // the smallest single piece that covers it on its own
    for (var i = 0; i < up.length; i++) {
      if (enough([up[i]], satsOf(up[i].amount))) { consider([up[i]]); break; }
    }
    /* And the largest that fit, topped up by the smallest piece that finishes.
     *
     * The two above are the extremes — one big piece, or everything small —
     * and between them is nearly always something much closer. With pieces of
     * 8192, 2048, 1024, 256, 128, 64, 32 and 1, paying 2,349 was 3,553 from
     * the bottom up, 1,204 over; 2048 + 256 + 64 is 2,368, 19 over. Walk
     * down from the largest taking each piece that still fits, and at every
     * step also try "what is picked so far, plus the smallest unused piece
     * that covers the rest". */
    var down = up.slice().reverse();
    var taken = [], takenSum = 0, used = {};
    for (var d = 0; d <= down.length; d++) {
      var short = want - takenSum;
      if (short > 0) {
        // the smallest piece not taken that covers what is still short, fee included
        for (var u = 0; u < up.length; u++) {
          if (used[u]) continue;
          var trial = taken.concat([up[u]]);
          if (enough(trial, takenSum + satsOf(up[u].amount))) { consider(trial); break; }
        }
      } else if (enough(taken, takenSum)) {
        consider(taken.slice());
      }
      if (d === down.length) break;
      var amt = satsOf(down[d].amount);
      if (amt <= want - takenSum) {
        taken.push(down[d]);
        takenSum += amt;
        used[up.length - 1 - d] = true;
      }
    }
    // and the smallest pieces, added until they reach it
    var run = [], sum = 0;
    for (var j = 0; j < up.length; j++) {
      run.push(up[j]);
      sum += satsOf(up[j].amount);
      if (enough(run, sum)) { consider(run.slice()); break; }
    }
    return best;
  }

  /* The pool: deep in the pieces that make exact amounts, then wide.
   *
   * Twelve of each from 1 to 128. That makes any amount up to 3,060 sats exactly,
   * and — the part that matters — it is twelve payments deep. `tidyChange` cannot
   * run without a route, so an offline wallet cannot top itself up: whatever it
   * set out with is all it has. Three of each ran dry after a handful of
   * payments; twelve is a day of them.
   *
   * Then, and only once every one of those is full, one denomination at a time
   * upward: eight 256s, then eight 512s, then eight 1024s, and on. One at a time
   * because each of those is worth more than the whole tier beneath it, and a
   * pile half way through 4096s makes exact amounts worse than one that finished
   * its 256s.
   *
   *     tier        each   pieces   sats
   *     1 – 128       12       96   3,060
   *     256            8        8   2,048
   *     512            8        8   4,096
   *     1024           8        8   8,192
   *     … and upward, as the balance allows
   *
   * Nothing caps this against the balance and nothing needs to: `changePlan` can
   * only work by breaking a piece bigger than what it is filling, so a wallet
   * that has broken everything it holds runs out of inputs and stops on its own
   * ("no larger piece to break"). A small wallet therefore ends up entirely in
   * small change, which is the right answer for one, and a large one climbs the
   * tiers until the targets are met. */
  var SMALL_PIECES = [1, 2, 4, 8, 16, 32, 64, 128];
  var PIECES_EACH = 12;
  var DEEP_PIECES = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
  var DEEP_EACH = 8;
  // a tier is refilled when it is down to this many, not before
  var PIECES_LOW = 6;
  var DEEP_LOW = 4;
  // and in one swap, no more than this many shaped pieces, nor more than this many of any one size
  var SHAPE_MOST = 60;
  var SHAPE_EACH = 6;

  /* What the pool is aiming for at a given denomination, or 0 for one it does not
   * keep. Read by the SEE CHANGE screen, so the target lives in one place rather
   * than being written down twice. */
  /* The small tier, for a screen that wants to list it whether any are held or
   * not. A copy, so nothing outside can reorder the pool's own list. */
  function smallTier() { return SMALL_PIECES.slice(); }

  function pieceTarget(amount) {
    if (SMALL_PIECES.indexOf(amount) >= 0) return PIECES_EACH;
    if (DEEP_PIECES.indexOf(amount) >= 0) return DEEP_EACH;
    return 0;
  }

  /* What the pile is short of: the whole small tier at once, or else the one deep
   * denomination next in line. Ascending, which is also the order they are
   * filled in — all the 1s, then all the 2s, and so on. */
  /* `all`: every tier below its target, at most six pieces each (SHAPE_EACH),
   * which is what a swap that is happening anyway fills. Without it, only the
   * tiers low enough to call for a swap (PIECES_LOW, DEEP_LOW): a tier with
   * seven of twelve does not start one, but is topped up by the next. */
  function shortOf(have, all) {
    var count = {};
    SMALL_PIECES.concat(DEEP_PIECES).forEach(function (d) { count[d] = 0; });
    (have || []).forEach(function (p) {
      var a = satsOf(p.amount);
      if (count[a] !== undefined) count[a]++;
    });
    var missing = [];
    /* Refilled only once it is half gone. Topping a tier up the moment one
     * piece is spent meant a swap after nearly every payment; a tier with
     * seven of its twelve still has change to give, and is left alone. An
     * empty wallet's first payment finds every tier at nought and fills
     * them all. */
    if (all) {
      SMALL_PIECES.concat(DEEP_PIECES).forEach(function (d) {
        var target = pieceTarget(d);
        for (var k = count[d]; k < target && k - count[d] < SHAPE_EACH; k++) missing.push(d);
      });
      return missing;
    }
    SMALL_PIECES.forEach(function (d) {
      if (count[d] > PIECES_LOW) return;
      for (var k = count[d]; k < PIECES_EACH; k++) missing.push(d);
    });
    if (missing.length) return missing;
    for (var i = 0; i < DEEP_PIECES.length; i++) {
      var d = DEEP_PIECES[i];
      if (count[d] <= DEEP_LOW) {
        var want = [];
        for (var k = count[d]; k < DEEP_EACH; k++) want.push(d);
        return want;
      }
    }
    return [];
  }

  /* What tidyChange would swap: { input, amount, denominations }, or { why }. */
  /* The pieces a swap should hand back, given what the pile holds beside
   * them: the pool's missing pieces first, smallest up, as many as the amount
   * covers, and the rest as powers of two. The swap a payment or a receipt
   * makes anyway then does the top-up's work, and a second swap is rarely
   * needed. */
  function shapeOutputs(have, amount, most) {
    var left = Math.max(0, Math.floor(Number(amount) || 0));
    var out = [];
    if (left <= 0) return out;
    // sixty, or fewer where the mint takes fewer outputs in one request (max_array_length); a cap of nought is one, not none
    var room = Math.max(1, Math.min(SHAPE_MOST, (most === undefined || most === null) ? SHAPE_MOST : Number(most)));
    // every tier that is low, smallest first — not only the first large one, as a top-up swap takes them
    shortOf(have, true).forEach(function (d) {
      if (d <= left && out.length < room) { out.push(d); left -= d; }
    });
    for (var bit = 1; left > 0; bit *= 2) {
      if (left & bit) { out.push(bit); left -= bit; }
    }
    return out;
  }

  function changePlan(w, have) {
    var low = shortOf(have);
    if (!low.length) return { why: 'enough small change' };
    var biggest = low.reduce(function (a, b) { return b > a ? b : a; }, 0);
    // what the swap makes: every tier below its target, six at most each, the low ones among them
    var missing = shortOf(have, true);
    var big = (have || []).filter(function (p) { return satsOf(p.amount) > biggest; })
      .sort(function (a, b) { return satsOf(a.amount) - satsOf(b.amount); });
    if (!big.length) return { why: 'no larger piece to break' };
    /* The piece that fills everything that is missing in one swap, where there
     * is one, and the biggest there is where there is not.
     *
     * It was the smallest piece bigger than what was being filled, which for
     * the small tier is a 256: a dozen swaps to fill a pool, minutes apart, so
     * a wallet that had been online and busy for ten minutes was still holding
     * three 1s when it needed exact change. */
    var wanted = missing.reduce(function (a, b) { return a + b; }, 0);
    var whole = big.filter(function (p) { return satsOf(p.amount) - 1 >= wanted; });
    var input = whole.length ? whole[0] : big[big.length - 1];
    var fee = swapFeeFor(w, [input]);
    if (!isFinite(fee) || fee > 1) return { why: 'this mint charges ' + fee + ' sats a swap' };
    var amount = satsOf(input.amount) - fee;
    // the smallest missing pieces first, as many as this piece covers, within the same limits a payment's swap keeps to
    /* And no more than the mint takes in one request, with seventeen left for
     * the remainder's powers of two: a top-up of sixty shaped pieces at a
     * 25-cap mint was refused every put-away, and each refusal burned the
     * counters it had reserved toward the restore gap (an audit finding). */
    var room = Math.max(1, Math.min(SHAPE_MOST, mintArrayCap(w) - 17));
    var denominations = [], used = 0;
    missing.sort(function (a, b) { return a - b; }).forEach(function (d) {
      if (used + d <= amount && denominations.length < room) { denominations.push(d); used += d; }
    });
    if (!denominations.length) return { why: 'the piece is too small' };
    var rest = amount - used;
    for (var bit = 1; rest > 0; bit *= 2) {
      if (rest & bit) { denominations.push(bit); rest -= bit; }
    }
    return { input: input, amount: amount, denominations: denominations };
  }

  var BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var CURVE_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  var CURVE_G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

  /* Five-bit words as bytes; `pad` keeps a last partial byte, zero-filled. */
  function wordsToBytes(words, pad) {
    var value = 0, bits = 0, out = [];
    for (var i = 0; i < words.length; i++) {
      value = (value << 5) | words[i];
      bits += 5;
      while (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xff); }
      value &= (1 << bits) - 1;
    }
    if (pad && bits > 0) out.push((value << (8 - bits)) & 0xff);
    return out;
  }

  /** @returns {bigint} */
  function bigOfBytes(bytes) {
    return BigInt('0x' + (hexOf(bytes) || '0'));
  }

  /** @param {bigint} a @param {bigint} m @returns {bigint} */
  function modInverse(a, m) {
    var zero = BigInt(0), one = BigInt(1);
    /** @type {bigint} */ var r0 = ((a % m) + m) % m;
    /** @type {bigint} */ var r1 = m;
    /** @type {bigint} */ var x0 = one;
    /** @type {bigint} */ var x1 = zero;
    while (r1 !== zero) {
      var q = r0 / r1;
      var r2 = r0 - q * r1; r0 = r1; r1 = r2;
      var x2 = x0 - q * x1; x0 = x1; x1 = x2;
    }
    return ((x0 % m) + m) % m;
  }

  /* A BOLT11 invoice's payment hash, as hex, or ''. Its `p` field: 52 words,
   * 256 bits and four of padding. The payer's preimage hashes to this, so it
   * is what ties a payment somebody says they made to an invoice this phone
   * asked for. Tested against BOLT11's own example invoice. */
  function invoicePaymentHash(bolt11) {
    try {
      var t = String(bolt11 || '').trim().toLowerCase().replace(/^lightning:/, '');
      if (!/^ln(bc|tb|bcrt)/.test(t)) return '';
      var sep = t.lastIndexOf('1');
      if (sep < 1 || t.length - sep - 1 < 7 + 104 + 6) return '';
      var words = [];
      for (var i = sep + 1; i < t.length - 6; i++) {
        var v = BECH32.indexOf(t.charAt(i));
        if (v < 0) return '';
        words.push(v);
      }
      var data = words.slice(0, words.length - 104);
      var at = 7;
      while (at + 3 <= data.length) {
        var type = data[at], len = data[at + 1] * 32 + data[at + 2], start = at + 3;
        if (start + len > data.length) return '';
        if (type === 1 && len === 52) return hexOf(wordsToBytes(data.slice(start, start + len), false).slice(0, 32));
        at = start + len;
      }
      return '';
    } catch (e) { return ''; }
  }

  /* The node that signed a BOLT11 invoice, as compressed public key hex, or
   * null. Its `n` field when it has one; otherwise recovered from the
   * signature, which BOLT11 makes over SHA-256 of the human-readable part and
   * the data words as bytes. Tested against BOLT11's own example invoice. */
  function invoicePayee(bolt11) {
    try {
      var CT = window.CashuTS;
      var t = String(bolt11 || '').trim().toLowerCase().replace(/^lightning:/, '');
      if (!/^ln(bc|tb|bcrt)/.test(t)) return null;
      var sep = t.lastIndexOf('1');
      if (sep < 1 || t.length - sep - 1 < 7 + 104 + 6) return null;
      var words = [];
      for (var i = sep + 1; i < t.length - 6; i++) {
        var v = BECH32.indexOf(t.charAt(i));
        if (v < 0) return null;
        words.push(v);
      }
      var data = words.slice(0, words.length - 104);
      var at = 7;
      while (at + 3 <= data.length) {
        var type = data[at], len = data[at + 1] * 32 + data[at + 2], start = at + 3;
        if (start + len > data.length) return null;
        if (type === 19) return len === 53 ? hexOf(wordsToBytes(data.slice(start, start + len), false).slice(0, 33)) : null;
        at = start + len;
      }
      if (!CT || typeof CT.pointFromHex !== 'function') return null;
      var sig = wordsToBytes(words.slice(words.length - 104), false);
      if (sig.length !== 65 || sig[64] > 1) return null;
      var hrp = t.slice(0, sep);
      var msg = [];
      for (var h = 0; h < hrp.length; h++) msg.push(hrp.charCodeAt(h));
      var e = bigOfBytes(sha256(msg.concat(wordsToBytes(data, true)))) % CURVE_N;
      var r = bigOfBytes(sig.slice(0, 32)), s = bigOfBytes(sig.slice(32, 64));
      var zero = BigInt(0);
      if (r === zero || s === zero || r >= CURVE_N || s >= CURVE_N) return null;
      var R = CT.pointFromHex((sig[64] ? '03' : '02') + r.toString(16).padStart(64, '0'));
      var ri = modInverse(r, CURVE_N);
      var u1 = ((CURVE_N - e) % CURVE_N) * ri % CURVE_N;
      var u2 = s * ri % CURVE_N;
      var Q = u1 === zero ? R.multiply(u2) : CT.pointFromHex(CURVE_G).multiply(u1).add(R.multiply(u2));
      return String(Q.toHex(true)).toLowerCase();
    } catch (x) {
      return null;
    }
  }

  function mintNodeOf(mint) {
    var all = load(K.mintNodes, {});
    return (all && typeof all === 'object' && all[canonicalMint(mint)]) || null;
  }

  /* An invoice this mint just made for this wallet names its node. */
  function learnMintNode(mint, bolt11) {
    var m = canonicalMint(mint);
    var node = m ? invoicePayee(bolt11) : null;
    if (!node) return;
    var all = load(K.mintNodes, {});
    if (!all || typeof all !== 'object') all = {};
    if (all[m] === node) return;
    all[m] = node;
    save(K.mintNodes, all);
  }

  /* A mint whose node is not known yet is asked for one small invoice, on a
   * circuit nothing else uses: once a session, 10 to 40 seconds after
   * connecting, and at once when an invoice is scanned before then
   * (learnThisMintNode). The invoice is never paid and never kept. Only in the
   * app; tests set `FoxyWallet._nodeProbeDelay`.
   *
   * It waited 45 seconds to 3 minutes, and nothing asked when an invoice came
   * first: on a phone, invoices from Minibits and cashu.me at the Minibits mint
   * were paid by Lightning with no card, until an invoice Foxy made taught it
   * the node. */
  var nodeProbed = Object.create(null);
  var nodeAsking = Object.create(null);

  function askMintNode(u, w) {
    if (nodeAsking[u]) return nodeAsking[u];
    var amount = 1;
    try {
      var methods = (w.getMintInfo().nuts[4] || {}).methods || [];
      methods.forEach(function (m) {
        if (m && m.method === 'bolt11' && m.unit === 'sat' && satsOf(m.min_amount) > amount) amount = satsOf(m.min_amount);
      });
    } catch (e) {}
    var asked = withTimeout(onCircuit(w).createMintQuoteBolt11(amount), 12000, 'the mint’s node').then(function (q) {
      if (q && q.request) learnMintNode(u, q.request);
      return mintNodeOf(u);
    });
    nodeAsking[u] = asked;
    asked.then(function () { delete nodeAsking[u]; }, function () { delete nodeAsking[u]; });
    return asked;
  }

  function probeMintNode(u, w) {
    if (!bridged() || !w || nodeProbed[u] || mintNodeOf(u)) return;
    nodeProbed[u] = true;
    probeMintNodeIn(u, w, 0);
  }

  /* At once, on a mint this wallet has never been on. The wait above is so the
   * probe is not tied to a connect, which matters for a mint that has seen
   * this wallet before; a first connect has nothing earlier to be tied to.
   * And a new wallet that goes offline inside those forty seconds never
   * learns the node, so an invoice from its own mint scanned offline was
   * refused as somebody else's. */
  function probeMintNodeNow(u, w) {
    // a delay somebody set is one they meant, and the ordinary probe keeps it
    if (FoxyWallet._nodeProbeDelay) { probeMintNode(u, w); return; }
    if (!bridged() || !w || mintNodeOf(u) || !routeOpen()) return;
    nodeProbed[u] = true;
    console.log('[foxy] first time on this mint: asking for its node now');
    /* After the connect has returned, and never through it: a mint that
     * cannot be asked is a probe that failed, not a connect that did. */
    setTimeout(function () {
      try { askMintNode(u, w).then(null, function () { nodeProbed[u] = false; }); }
      catch (e) { nodeProbed[u] = false; }
    }, 0);
  }

  /* The one wait this probe gets, which a closed gate must not spend.
   *
   * The wait is 10 to 40 seconds, and Tor dropping inside it — a phone
   * changing network, which is most of a walk — used to end the probe: the
   * flag was put back and nothing called probeMintNode again until the next
   * connect. A mint whose node is unknown pays its own invoices over Lightning
   * with a routing fee, so the pass that finds the gate shut waits again
   * instead, up to eight times. Same failure as the on-chain watcher's early
   * return: a timer that stops on a pass that did nothing. */
  function probeMintNodeIn(u, w, waits) {
    var range = FoxyWallet._nodeProbeDelay || [10000, 40000];
    var lo = Number(range[0]) || 0, hi = Math.max(lo, Number(range[1]) || 0);
    setTimeout(function () {
      // already known, or the wallet has moved on: this probe has no work left
      if (mintNodeOf(u) || canonicalMint(mintUrl) !== canonicalMint(u)) { nodeProbed[u] = false; return; }
      if (!routeOpen()) {
        if (waits < 8) { probeMintNodeIn(u, w, waits + 1); return; }
        nodeProbed[u] = false;
        return;
      }
      askMintNode(u, w).then(null, function () { nodeProbed[u] = false; });
    }, lo + Math.floor(Math.random() * (hi - lo + 1)));
  }

  /* ---- has a token been redeemed? -------------------------------------------
   *
   * A token made to pay someone is watched until it is redeemed, so the person
   * who made it hears when it lands. Asked the most private way Foxy has:
   *
   * - Only the token's own fingerprints (Ys) go to the mint, never anything
   *   else this wallet holds, from a circuit used for that token alone.
   * - The first question waits 15 to 45 seconds after the token is made, so it
   *   does not follow the swap that made it by the moment; the mint would
   *   otherwise tie the question, and so the token, to the wallet that paid.
   * - After that, every 6 to 12 seconds while the token's screen is open, every
   *   30 to 90 seconds elsewhere, each wait random. After a return from the
   *   background the first question waits 15 to 45 seconds again, out of the
   *   burst a return makes. iOS runs nothing while Foxy is in the background,
   *   so a token redeemed then is heard about after the return.
   * - It stops once redeemed, and after a day.
   *
   * A token made from pieces already held, with no swap (sendToken), has no
 * such moment to be tied to: its first question comes within seconds.
 *
 * The record holds the Ys and the amount, not the token: a Y cannot be spent.
   * A watch not marked `persist` lasts only while its screen is open (the app
   * drops it). The timing is the app's (07-history-tokens-mints.js). */
  var TOKEN_WATCH_MS = 24 * 3600 * 1000;

  function tokenYsOf(text) {
    var CT = window.CashuTS;
    var info = FoxyWallet.tokenInfo(text);
    if (!CT || !CT.hashToCurve || !info || !info.proofs || !info.proofs.length) return null;
    var enc = new TextEncoder();
    return info.proofs.map(function (p) { return String(CT.hashToCurve(enc.encode(String(p.secret))).toHex(true)); });
  }

  function tokenTextFor(hash) {
    var meta = load('foxy.txmeta', {});
    if (meta && meta[hash] && typeof meta[hash].token === 'string') return meta[hash].token;
    var last = load(K.outtok, null);
    return last && last.hash === hash ? String(last.token || '') : '';
  }

  /* A watched token taken back by this wallet, or received here again, is not
   * a payment someone received: its watch goes before it can say so. Seen on a
   * phone: a token reclaimed at once was announced as sent seven
   * minutes later, when its watch next asked. */
  function dropTokenWatchesFor(text) {
    var ys = tokenYsOf(text);
    if (!ys) return;
    var mine = {};
    ys.forEach(function (y) { mine[y] = true; });
    var list = tokenWatches();
    var left = list.filter(function (r) { return !r.ys.some(function (y) { return mine[y]; }); });
    if (left.length !== list.length) save(K.tokenWatch, left);
  }

  function tokenWatches() {
    var now = Date.now();
    var list = load(K.tokenWatch, []);
    if (!Array.isArray(list)) return [];
    var live = list.filter(function (r) { return r && r.hash && Array.isArray(r.ys) && r.ys.length && r.until > now; });
    if (live.length !== list.length) save(K.tokenWatch, live);
    return live;
  }
