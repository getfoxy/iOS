
    /* ---- the till: point of sale (08d-till.js) --------------------------
     *
     * For the screens. A keeper makes CASHIER CODEs (`tillPassMake`) and
     * listens for what cashiers send (`tillListen`, the phone calling
     * `_tillArrived`); a cashier joins by one (`tillJoin`), takes payments
     * locked to the keeper into an outbox that is sent at once
     * (`tillDeliver`), and leaves (`tillLeave`). */

    /* A cashier code's text, checked: { v, id, mint, unit, lock, to, exp },
     * or null (malformed, ended, or not a till address). Never throws.
     * `tillProblem` says why in a sentence, '' for a good one. */
    tillDecode: function (text) {
      try { var c = tillRead(text); return c.pass || null; } catch (e) { return null; }
    },
    tillProblem: function (text) {
      try { var c = tillRead(text); return c.pass ? '' : String(c.why || 'That is not a cashier code Foxy can read.'); }
      catch (e) { return 'That is not a cashier code Foxy can read.'; }
    },

    /* Keeper: the code for cashiers, at the connected mint, for 72 hours.
     * Resolves { text, id, exp } (`exp` in unix seconds); `text` is what the
     * QR shows. While a code is live this answers that one again, for every
     * cashier; a new one is made only once none is. `opts.unit` ('sat' or
     * 'usd') picks a new one's unit; without it, dollars where this phone
     * holds dollars at a mint that issues them. A live code is never
     * dropped; up to four are kept, and only an ended one goes. */
    tillPassMake: function (opts) { return tillPassMake(opts); },

    /* Keeper: the codes still live, newest last: { id, unit, mint, exp, made,
     * text }. Codes long past the time anything sent by them could still be
     * read are dropped on the way, with their keys. */
    tillPasses: function () {
      var now = Date.now();
      return tillPrune().filter(function (r) { return Number(r.exp) * 1000 > now; })
        .sort(function (a, b) { return Number(a.made) - Number(b.made); })
        .map(function (r) {
          return { id: r.id, unit: r.unit, mint: r.mint, exp: r.exp, made: r.made, text: tillPassText(r) };
        });
    },

    /* Keeper: the phone listens on the codes, and what was kept for this mint
     * is taken. Resolves how many the phone opened (0 when none). Safe to
     * call as often as anything likes. `tillHush` closes them. */
    tillListen: function () { return tillListenNow(); },
    tillHush: function () {
      return bridgeAsk('tillInboxClose', {}, 5000).then(function () { return true; }, function () { return false; });
    },

    /* Keeper: one delivery from a cashier, called by the phone with the code's
     * id and the payment as sent (NUT-18's { id, mint, unit, proofs, memo }).
     * Resolves 'taken', 'kept' (for when this phone is online at that mint),
     * 'seen' or 'refused'; never rejects. */
    _tillArrived: function (id, body) { return tillArrived(id, body); },

    /* Cashier: work the till by this code (the decoded pass, or its text).
     * Resolves { pass, since } once the phone is at the code's mint. */
    tillJoin: function (pass) { return tillJoinNow(pass); },

    /* Cashier: the till this phone works, { pass, since }, or null. Null once
     * the code has ended, which clears it and takes the phone home. */
    tillCashier: function () {
      var row = tillCashierNow();
      return row && row.pass ? { pass: row.pass, since: row.since } : null;
    },

    /* Cashier: leave the till, and go back to the mint this phone banks at.
     * What was taken and not yet sent still goes. Never rejects; a second
     * call shares the first, or once it is over does nothing and answers
     * the same shape, { left, mint, home }. */
    tillLeave: function () { return tillLeaveNow(); },

    /* Cashier: send every payment not yet sent to its keeper. Resolves how
     * many went. While any are left, tried again once a minute (a quarter
     * of an hour after thirty tries), and at once when the route comes back. */
    tillDeliver: function () { return tillDeliverAll(); },

    /* Cashier: what was taken for the keeper, newest last, without the
     * proofs: { n, passId, mint, unit, amount, hash, at, sentAt, tries,
     * stranded }. `stranded`: not sent within a week of its code ending,
     * so no longer sent; kept, proofs and all, locked to the keeper. */
    tillOutbox: function () {
      return tillOutboxRows().map(function (r) {
        return { n: r.n, passId: r.passId, mint: r.mint, unit: r.unit, amount: r.amount, hash: r.hash,
                 at: r.at, sentAt: r.sentAt || null, tries: Number(r.tries) || 0, stranded: !!r.stranded };
      });
    },

    /* Cashier: a token scanned or pasted at the till, taken for the keeper:
     * locked to the keeper's key, signed by the mint, unspent, at the code's
     * mint in its unit. Resolves as `receiveToken` does, with `till: true`;
     * nothing goes into this phone's pile. */
    tillTakeToken: function (text) { return tillTake(text); },

    // for the suites: a row put in the outbox as a payment would put it, and the wait between tries (ms)
    _tillOutboxAdd: function (o) { return tillOutboxAdd(o); },
    _tillRetryMs: 0,
