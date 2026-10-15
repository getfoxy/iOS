    /* ---- two balances at one mint --------------------------------------
     *
     * A mint that issues sat and usd keysets (Forge does) holds two balances
     * for one person: bitcoin in sats and dollars in cents. They are two
     * piles, two kinds of record and two sets of books, and nothing here ever
     * adds one to the other (08c-units.js says why and how). Every amount in
     * this part is an integer in its own unit. The screens ask:
     *
     *   mintUnits, twoUnits   whether to show any of it at all
     *   walletChoice          what the person said they hold, and the unit a
     *                         receive and a send start in
     *   balanceOf, heldIn …   each balance, and what is held back from it
     *   mintRate              the mint's dollar price, from its last quote
     *   quoteFeeBoth          a Lightning invoice quoted from both balances
     *   swapQuote, swapRun    dollars to bitcoin and back, at this mint */

    /* The units the mint issues on active keysets, of the two Foxy handles,
     * sat first: ['sat'], ['sat', 'usd'], or [] when nothing is known here
     * about the mint. Local and at once. The connected mint when none is
     * named. */
    mintUnits: function (mint) {
      return unitsOf(mint ? canonicalMint(mint) : mintUrl);
    },

    /* Whether the mint issues both. Every WALLET chip, the CURRENCY screen,
     * the question of what to hold and SWAP wait on this: a one-unit mint
     * never asks. */
    twoUnits: function (mint) {
      var u = FoxyWallet.mintUnits(mint);
      return u.indexOf('sat') >= 0 && u.indexOf('usd') >= 0;
    },

    /* The connected mint's wallet object for a unit, on a circuit of its own
     * (08c-units.js, `walletIn`). */
    walletIn: function (unit) { return walletIn(unit); },

    /* What the person said they want to hold ('dollars', 'bitcoin', 'both',
     * or '' when never asked), and the unit a receive and a send start in
     * ('sat', 'usd', or '' when the CURRENCY screen should ask). */
    walletChoice: function () {
      var pick = function (key, ok) {
        var v = load(key, '');
        return typeof v === 'string' && ok.indexOf(v) >= 0 ? v : '';
      };
      return {
        hold: pick(K.hold, ['dollars', 'bitcoin', 'both']),
        recv: pick(K.recv, ['sat', 'usd']),
        send: pick(K.send, ['sat', 'usd']),
      };
    },

    /* The choice, written. Dollars or bitcoin sets both starting units to
     * that one; both clears them, so each flow asks once. `recv` and `send`
     * set one each: the last unit a receive or a send used, or the one the
     * WALLET chip was changed to. Anything else is refused whole, before
     * anything is written. Answers the choice as it now stands. */
    setWalletChoice: function (patch) {
      var p = patch || {};
      var bad = function () { return new Error('Foxy does not know that choice.'); };
      if (typeof p !== 'object') throw bad();
      if (p.hold !== undefined && ['dollars', 'bitcoin', 'both'].indexOf(p.hold) < 0) throw bad();
      if (p.recv !== undefined && ['sat', 'usd'].indexOf(p.recv) < 0) throw bad();
      if (p.send !== undefined && ['sat', 'usd'].indexOf(p.send) < 0) throw bad();
      if (p.hold !== undefined) {
        var both = p.hold === 'dollars' ? 'usd' : p.hold === 'bitcoin' ? 'sat' : '';
        save(K.hold, p.hold);
        save(K.recv, both);
        save(K.send, both);
      }
      if (p.recv !== undefined) save(K.recv, p.recv);
      if (p.send !== undefined) save(K.send, p.send);
      return FoxyWallet.walletChoice();
    },

    /* One balance, in its own unit. Sats are what `balanceSats` says (the
     * pile, what has arrived and waits to be swapped in, less change about
     * to be handed back); dollars are the usd pile, cents. Local and at once.
     * The connected mint when none is named. */
    balanceOf: function (unit, mint) {
      var u = unitOf(unit);
      if (!u) return 0;
      var m = mint ? canonicalMint(mint) : mintUrl;
      if (!m) return 0;
      if (u === 'sat') return Math.max(0, sumProofs(proofs(m)) + unclaimedSats(m) - changeLeavingSats(m));
      return sumProofs(proofs(m, u));
    },

    /* Held back from a balance until the mint says what became of it: a swap
     * whose answer was lost (`holdInputs`), and, for dollars, the pieces of a
     * swap between units whose payment is still with the mint. Sats are what
     * they always were (`heldSats`). */
    heldIn: function (unit) {
      var u = unitOf(unit) || 'sat';
      if (u === 'sat') return FoxyWallet.heldSats();
      var here = wallet ? mintOf(wallet) : '';
      var sum = 0;
      var all = load(K.held, {});
      Object.keys(all || {}).forEach(function (id) {
        var h = all[id];
        if (!h || recordUnit(h) !== u || canonicalMint(h.mint) !== here) return;
        sum += sumProofs(h.proofs || []);
      });
      return sum + unitSwapHeld(u, here);
    },

    /* What a swap took after Foxy was put away, on its way back (`recoveringSats`). */
    recoveringIn: function (unit) {
      var u = unitOf(unit) || 'sat';
      if (u === 'sat') return FoxyWallet.recoveringSats();
      var here = wallet ? mintOf(wallet) : '';
      var pile = {};
      proofs(here, u).forEach(function (p) { if (p && p.secret) pile[p.secret] = true; });
      var held = {};
      var all = load(K.held, {});
      Object.keys(all || {}).forEach(function (id) {
        ((all[id] && all[id].proofs) || []).forEach(function (p) { if (p && p.secret) held[p.secret] = true; });
      });
      var sum = 0;
      loadSwaps().forEach(function (r) {
        if (!r || !r.freeInputs || canonicalMint(r.mint) !== here || recordUnit(r) !== u) return;
        (r.inputs || []).forEach(function (p) {
          if (p && p.secret && !pile[p.secret] && !held[p.secret]) sum += satsOf(p.amount) || 0;
        });
      });
      return sum;
    },

    /* Fees no row carries: the top-ups of the sat change pool. Dollars have
     * no change pool, so none. */
    topUpFeesIn: function (unit) {
      var u = unitOf(unit) || 'sat';
      return u === 'sat' ? FoxyWallet.topUpFeeSats() : 0;
    },

    /* The dollar price the mint quoted last, { usdPerBtc, at, mint }, or null.
     * Read off its last usd quote; in memory only, and never used to move
     * money (08c-units.js, `noteMintRate`). */
    mintRate: function (mint) {
      var m = canonicalMint(String(mint || mintUrl || ''));
      var r = m ? mintRates[m] : null;
      return r ? { usdPerBtc: r.usdPerBtc, at: r.at, mint: r.mint } : null;
    },

    /* A Lightning invoice quoted from both balances at once, { sat, usd },
     * each what `quoteFee` answers or null. Melt quotes commit to nothing, so
     * the confirmation asks both and can switch to the balance that covers
     * the payment. At a one-unit mint `usd` is null and nothing is asked. */
    quoteFeeBoth: function (bolt11) {
      var two = FoxyWallet.twoUnits();
      return Promise.all([
        FoxyWallet.quoteFee(bolt11, { unit: 'sat' }),
        two ? FoxyWallet.quoteFee(bolt11, { unit: 'usd' }) : Promise.resolve(null),
      ]).then(function (both) { return { sat: both[0], usd: both[1] }; });
    },

    /* A token in dollars (or another unit Foxy handles beyond sats), from the
     * connected mint's pile of that unit. Called by `sendToken` inside the
     * proof lock; not on its own.
     *
     * Plainer than a sat send on purpose: with a route only, never locked,
     * never covering an amount with change to come back, no change pool. The
     * pieces that make the amount exactly go as they are; otherwise the mint
     * cuts them (a swap, with its record on disk until the answer is in). */
    _sendUnitToken: function (amount, unit, opts) {
      var o = opts || {};
      var u = unitOf(unit);
      var no = unitRefusal(u);
      if (no) return Promise.reject(no);
      var want = Math.round(Number(amount));
      if (!(want > 0)) return Promise.reject(new Error('Ask for an amount above zero.'));
      if ((typeof o.lockTo === 'string' && o.lockTo) || o.cover || o.changeNote || o.overpayOk || o.sigAll
          || o.purpose === 'change' || !routeOpen()) {
        return Promise.reject(new Error('Offline and locked payments are bitcoin only for now; nothing was sent.'));
      }
      var at = '';
      try { at = mintOf(needLocal()); } catch (e) { return Promise.reject(e); }
      return walletIn(u).then(function (w) {
        var have = proofs(at, u);
        var stuck = lockedProofs(have);
        if (stuck.length) have = have.filter(function (p) { return stuck.indexOf(p) < 0; });
        var held = sumProofs(have);
        var fee = swapFeeFor(w, have);
        if (held < want + fee) throw new Error(notEnoughWords({ need: want + fee, have: held }, u));
        var exact = null;
        try { exact = exactPieces(w, have, want); } catch (e) { exact = null; }
        if (!exactGoesAsIs(w, exact)) exact = null;
        var made;
        if (exact) {
          var out = {};
          exact.forEach(function (p) { out[p.secret] = true; });
          made = Promise.resolve({ send: exact, keep: have.filter(function (p) { return !out[p.secret]; }), swapped: false });
        } else {
          var guard = swapGuard(w, 'send', { inputs: have, unit: u });
          made = guard.run('token', function () {
            return w.send(want, have, { includeFees: true });
          }).catch(function (e) {
            return retryWithoutSpent(w, e);
          }).then(function (split) {
            return { send: split.send, keep: split.keep || [], swapped: true, guard: guard };
          });
        }
        return made.then(function (split) {
          // the rest of the pile first, then the record cleared, then the token (as `sendToken`)
          setProofs((split.keep || []).concat(stuck), at, w, u);
          if (split.guard) split.guard.done();
          var token = encodeToken(at, split.send, u);
          var hash = 'token-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          var sent = sumProofs(split.send);
          var tokFee = split.swapped
            ? Math.max(0, held - sent - sumProofs(split.keep || []))
            : 0;
          // the string is the money now: written down before anything else
          mustSave(K.outtok, { token: token, sats: 0, unit: u, amount: sent, mint: at,
                               hash: hash, at: Date.now(), swapped: split.swapped });
          logTx(unitRow(u, { dir: 'out', sats: sent, feeSats: tokFee, settled: true, state: 'success',
                             memo: 'ecash', hash: hash, mint: at }));
          logAudit({ hash: hash, sats: 0, feeSats: 0, unit: u, amount: sent, kind: 'token',
                     inputs: (split.send || []).map(scrub), outputs: (split.keep || []).map(scrub) });
          FoxyWallet.tag(hash, { to: 'ecash', token: token, unit: u });
          return { token: token, unit: u, amount: sent, sats: 0, mint: at, hash: hash,
                   swapped: split.swapped, lockedTo: '', fee: tokFee, over: 0, asked: want, dust: 0, changeAsked: false };
        });
      });
    },

    /* ---- swap between units ------------------------------------------
     *
     * No mint swaps one unit for another in one request (NUT-03 needs one
     * unit on both sides). At one mint it is two Lightning legs: a mint quote
     * in the unit wanted (an invoice), paid by a melt from the unit given. The
     * mint's rate is in those two quotes and nowhere else. A quote at Forge
     * lives sixty seconds, so the rate is held for that long at most.
     *
     * Nothing new recovers a swap. Cut off anywhere, it is a held melt in the
     * FROM unit (`holdMelt`, unit and swap id on it) and an invoice record in
     * the TO unit (`keepQuote`, the same): `sweepMelts` and `sweepQuotes`
     * finish those on the next connect or return, and each leg's row says
     * kind 'swap' with the swap's id. foxy.cashu.unitswap only says which two
     * belong together (`unitSwaps`). */

    /* The rate for swapping `amount` of `from` into `to`, held by the mint.
     * `amount` is what leaves, the mint's fee included; `opts.all` is the
     * whole of the FROM balance. Two passes at most (four requests): the
     * first at the rate last seen, the second sized from what the first
     * said. Resolves { id, mint, from, to, total, amount, fee, get, rate,
     * market, spread, spreadWarn, expiresAt, state: 'quoted' }. */
    swapQuote: function (from, to, amount, opts) {
      var f = unitOf(from), t = unitOf(to);
      if (!f || !HANDLED_UNITS[f]) return Promise.reject(new Error('Foxy does not know the unit ' + String(from).slice(0, 20) + '.'));
      if (!t || !HANDLED_UNITS[t]) return Promise.reject(new Error('Foxy does not know the unit ' + String(to).slice(0, 20) + '.'));
      if (f === t) return Promise.reject(new Error('Pick two different balances to swap.'));
      var offline = function () {
        var e = /** @type {any} */ (new Error('Swapping needs the mint.'));
        e.offline = true;
        return e;
      };
      if (!wallet) return Promise.reject(offline());
      var at = mintOf(wallet);
      if (!FoxyWallet.twoUnits(at)) {
        return Promise.reject(new Error(hostOf(at) + ' issues only bitcoin, so there is nothing to swap with.'));
      }
      if (!routeOpen()) return Promise.reject(offline());
      var have = sumProofs(proofs(at, f));
      var total = (opts && opts.all) ? have : Math.round(Number(amount));
      if (!(total > 0)) return Promise.reject(new Error('Ask for an amount above zero.'));
      if (total > have) {
        return Promise.reject(new Error('That is more than your ' + balanceWord(f) + ': you hold ' + moneyWords(have, f) + '.'));
      }
      var view;
      try { view = needNow(); } catch (e) { return Promise.reject(offline()); }
      // one job, one circuit: both quotes, the melt and the claim go the same way
      var tw = null, fw = null;
      var known = FoxyWallet.mintRate(at);
      var guess = (known && known.usdPerBtc) || Number(FoxyWallet._rate) || 100000;
      var convert = function (n, rate) {
        return f === 'usd' ? Math.floor(n / 100 / rate * 1e8) : Math.floor(n * rate / 1e8 * 100);
      };
      // one pass: an invoice in TO for `get`, and what paying it from FROM costs
      var pass = function (get) {
        return askQuote(tw, get, '').then(function (got) {
          return withTimeout(askedAgain(fw, 'the mint’s fee quote', function (via) {
            return via.createMeltQuoteBolt11(String(got.q.request));
          }), 30000, 'the mint’s fee quote').then(function (won) {
            var melt = won.got;
            var amt = satsOf(melt.amount) || 0, fee = satsOf(melt.fee_reserve) || 0;
            return { get: get, q: got.q, lock: got.lock, melt: melt, fw: won.w, amount: amt, fee: fee, total: amt + fee };
          });
        });
      };
      var refuseLow = function () { return new Error('That is too little to swap after the mint’s fee.'); };
      var mintRefusal = function (e) {
        if (e && (e.offline || neverSent(e))) throw offline();
        throw e;
      };
      return Promise.all([unitWalletOn(view, t), unitWalletOn(view, f)]).then(function (ws) {
        tw = ws[0]; fw = ws[1];
        var first = Math.max(1, Math.floor(convert(total, guess) * 0.97));
        return pass(first);
      }).then(function (one) {
        if (one.fee >= total || !(one.amount > 0)) throw refuseLow();
        // sized from the first answer, whether the fee is fixed or a share
        var byTotal = Math.floor(one.get * total / one.total);
        var byAmount = Math.floor(one.get * (total - one.fee) / one.amount);
        var next = Math.floor(Math.min(byTotal, byAmount) * 0.998);
        if (!(next > 0)) throw refuseLow();
        return pass(next).then(function (two) {
          if (two.total <= total) return two;
          // the rate moved between the two: once more, a little under
          var again = Math.floor(next * total / two.total * 0.99);
          if (!(again > 0)) throw refuseLow();
          return pass(again).then(function (three) {
            if (three.total > total) throw new Error('The mint would not hold a rate. Try again.');
            return three;
          });
        });
      }, mintRefusal).then(function (got) {
        var msat = 0;
        try { msat = Number(FoxyWallet.msatOf(String(got.q.request))) || 0; } catch (e) { msat = 0; }
        /* The rate the person gets, before the fee: cents against sats as
         * the two quotes priced them. */
        var usdPerBtc = f === 'usd' ? rateFrom(got.amount, got.get * 1000) : rateFrom(got.get, got.amount * 1000);
        if (!(usdPerBtc > 0) && msat) usdPerBtc = f === 'usd' ? rateFrom(got.amount, msat) : rateFrom(got.get, msat);
        if (usdPerBtc > 0) mintRates[canonicalMint(at)] = { usdPerBtc: usdPerBtc, at: Date.now(), mint: canonicalMint(at) };
        var market = Number(FoxyWallet._rate) > 0 ? Number(FoxyWallet._rate) : null;
        // how far the mint's rate is from the market, against the person: buying bitcoin dear, or selling it cheap
        var spread = market && usdPerBtc > 0
          ? Math.round(((f === 'usd' ? usdPerBtc - market : market - usdPerBtc) / market) * 10000) / 10000
          : 0;
        var now = Date.now();
        var ends = [now + 60000];
        if (Number(got.q.expiry) > 0) ends.push(Number(got.q.expiry) * 1000);
        if (Number(got.melt.expiry) > 0) ends.push(Number(got.melt.expiry) * 1000);
        var quote = /** @type {any} */ ({
          id: 'uswap-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          mint: at, from: f, to: t,
          total: got.total, amount: got.amount, fee: got.fee, get: got.get,
          rate: { usdPerBtc: usdPerBtc, by: hostOf(at) },
          market: market, spread: spread, spreadWarn: spread > 0.02,
          expiresAt: Math.min.apply(null, ends),
          state: 'quoted',
        });
        // the two quotes and the wallets they came by, kept off anything that is copied or shown
        Object.defineProperty(quote, '_mintQuote', { value: got.q, enumerable: false });
        Object.defineProperty(quote, '_lock', { value: got.lock, enumerable: false });
        Object.defineProperty(quote, '_melt', { value: got.melt, enumerable: false });
        Object.defineProperty(quote, '_w', { value: got.fw, enumerable: false });
        Object.defineProperty(quote, '_tw', { value: tw, enumerable: false });
        return quote;
      });
    },

    /* The swap, at the rate `swapQuote` held. In this order: the swap's own
     * record, the invoice's record in the TO unit, the payment from the FROM
     * unit (`pay`, which holds its pieces until the mint answers), then the
     * claim of the invoice. `onStage` hears 'paying', 'paid', 'claiming',
     * 'done'. Resolves { id, state, from: { unit, amount }, to: { unit,
     * amount }, fee, rate }: 'done'; 'pending' when the payment or the claim
     * has not answered (the sweeps finish it); 'failed' when the payment did
     * not go and its pieces are back. */
    swapRun: function (quote, onStage) {
      var stage = typeof onStage === 'function' ? onStage : function () {};
      var q = quote || {};
      if (!q.id || !q._melt || !q._mintQuote || q.state !== 'quoted' || swapsGone[q.id]) {
        return Promise.reject(new Error('That swap has already gone.'));
      }
      if (!wallet || !routeOpen()) {
        var off = /** @type {any} */ (new Error('Swapping needs the mint.'));
        off.offline = true;
        return Promise.reject(off);
      }
      if (!(Number(q.expiresAt) - Date.now() >= 15000)) {
        var late = /** @type {any} */ (new Error('The rate has run out. Confirm the new rate.'));
        late.expired = true;
        return Promise.reject(late);
      }
      swapsGone[q.id] = true;
      q.state = 'running';
      var mq = q._mintQuote, melt = q._melt;
      var rate = (q.rate && Number(q.rate.usdPerBtc)) || 0;
      var result = function (state, spent, fee) {
        return { id: q.id, state: state, from: { unit: q.from, amount: spent }, to: { unit: q.to, amount: q.get },
                 fee: fee, rate: q.rate };
      };
      try {
        putUnitSwap({ id: q.id, at: Date.now(), mint: q.mint, from: q.from, to: q.to, total: q.total, amount: q.amount,
                      fee: q.fee, get: q.get, rate: rate, mintQuote: mq.quote, meltQuote: melt.quote, state: 'paying' });
        keepQuote(mq, q._lock, q.get, 'swap', q.to, q.mint, { swap: q.id, mintRate: rate || undefined });
      } catch (e) {
        dropUnitSwap(q.id);
        q.state = 'failed';
        return Promise.reject(e);
      }
      stage('paying');
      var held = function () { return load(K.melting, []).some(function (e) { return e && e.quote === melt.quote; }); };
      var forget = function () {
        dropUnitSwap(q.id);
        dropQuoteRecord({ key: K.quotes, entry: { quote: mq.quote } });
      };
      return FoxyWallet.pay(String(mq.request), function () {}, {
        unit: q.from, swap: q.id, mintRate: rate,
        quote: { quote: melt, w: q._w, bolt11: String(mq.request), at: Date.now(), unit: q.from },
      }).then(function (paid) {
        if (paid && paid.pending) {
          q.state = 'pending';
          return result('pending', q.total, q.fee);
        }
        var spent = (Number(paid && paid.amount) || 0) + (Number(paid && paid.fee) || 0);
        var fee = Number(paid && paid.fee) || 0;
        stage('paid');
        stage('claiming');
        return swapClaim(q._tw, mq.quote).then(function (ok) {
          if (!ok) { q.state = 'pending'; return result('pending', spent, fee); }
          q.state = 'done';
          stage('done');
          return result('done', spent, fee);
        });
      }, function (e) {
        if (e && e.pending) { q.state = 'pending'; return result('pending', q.total, q.fee); }
        if (e && e.definite) {
          // the payment did not go and its pieces are back in the pile: nothing moved
          q.state = 'failed';
          forget();
          return result('failed', 0, 0);
        }
        // a melt still held is with the mint; the sweeps say what became of it
        if (held()) { q.state = 'pending'; return result('pending', q.total, q.fee); }
        // refused before anything left (not enough, storage): nothing moved, nothing to keep
        q.state = 'failed';
        forget();
        throw e;
      });
    },

    /* Swaps between units still with the mint: [{ id, at, from: { unit,
     * amount }, to: { unit, amount } }], for the held pill on the home screen
     * ("$ 10.00 pending with the mint") and for `heldIn`. */
    unitSwapsPending: function () {
      /* Only a swap with something still at the mint: its payment held
       * (K.melting), or paid with its invoice not yet claimed. One cut off
       * before its payment was held never left the phone (the hold is written
       * before the melt is sent), and one whose two legs have both landed is
       * done: either is dropped here, or it said "pending with the mint" for
       * good. A swap this page started is left to finish itself. */
      var held = {};
      load(K.melting, []).forEach(function (e) { if (e && e.quote) held[e.quote] = true; });
      var all = unitSwaps();
      var live = all.filter(function (r) {
        if (swapsGone[r.id]) return true;
        if (r.meltQuote && held[r.meltQuote]) return true;
        return r.meltLeg === 'paid' && !!(r.mintQuote && quoteRecord(r.mintQuote));
      });
      all.forEach(function (r) { if (live.indexOf(r) < 0) dropUnitSwap(r.id); });
      return live.map(function (r) {
        return { id: r.id, at: Number(r.at) || 0, from: { unit: recordUnit({ unit: r.from }), amount: Number(r.total) || 0 },
                 to: { unit: recordUnit({ unit: r.to }), amount: Number(r.get) || 0 } };
      });
    },

    /* A swap in one call, quoted and run at once: for the suites. The screens
     * show the quote first and run it on SWAP. */
    swapUnits: function (from, to, amount, opts, onStage) {
      return FoxyWallet.swapQuote(from, to, amount, opts).then(function (q) { return FoxyWallet.swapRun(q, onStage); });
    },

