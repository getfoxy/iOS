    /* ---- reading ------------------------------------------------------- */

    /* Instant: the balance is local, not a request. */
    balanceSats: function () {
      /* Ecash that has arrived and is waiting to be swapped counts. It is
       * locked to this phone, so it is this phone's money — the swap is the
       * only thing outstanding, and it is held back on purpose so the mint
       * does not see it land seconds after the payer's swap. Somebody who was
       * just paid should see what they were paid.
       *
       * At this mint: what is waiting at another is that mint's balance. */
      return Promise.resolve(sumProofs(proofs()) + unclaimedSats(mintUrl || ''));
    },

    /* Every pile that holds anything, in its own unit: [{ mint, unit, amount }].
     * Sats are in here too, as unit 'sat'. Amounts are never added across
     * units — a usd amount is cents, not sats. Local and instant, like
     * balanceSats, but returned directly so a render can read it. */
    balances: function () {
      var out = [];
      piles().forEach(function (p) {
        var amount = sumProofs(load(p.key, []));
        if (amount > 0) out.push({ mint: p.mint, unit: p.unit, amount: amount });
      });
      return out.sort(function (a, b) {
        if (a.mint !== b.mint) return a.mint < b.mint ? -1 : 1;
        if (a.unit === b.unit) return 0;
        if (a.unit === 'sat') return -1;
        if (b.unit === 'sat') return 1;
        return a.unit < b.unit ? -1 : 1;
      });
    },

    /* What one mint's pile in one unit holds. The connected mint when none is
     * named; sats when no unit is. */
    balanceIn: function (mint, unit) {
      var u = unitOf(unit);
      if (!u) return 0;
      var m = (mint === undefined || mint === null || mint === '') ? mintUrl : canonicalMint(mint);
      if (!m) return 0;
      return sumProofs(proofs(m, u));
    },

    /* An amount in its unit, as the screens show it: '$1.23', '€0.50',
     * '1,234 sats', '5 msat'. */
    formatAmount: function (amount, unit) { return formatAmount(amount, unit); },

    /* The short name of a unit: 'USD', 'EUR', 'sat', or the code in capitals. */
    unitName: function (unit) { return unitName(unit); },

    /* Every denomination this wallet holds at the mint it is on, and how many.
     *
     * Ascending, and only the amounts actually held: a row of zeroes for every
     * power of two up to 2^32 would tell nobody anything. Local — it reads the
     * pile, asks the mint nothing, and works with no route at all, which is the
     * point of a screen somebody opens to find out whether they can still pay
     * while offline.
     *
     * `want` is what tidyChange is aiming for at that denomination, so the screen
     * can show how near the pool is rather than only what is in it. The target
     * lives with the pool (pieceTarget) rather than being written down twice. */
    pieces: function () {
      var have = proofs();
      var count = {};
      (have || []).forEach(function (pr) {
        var a = satsOf(pr && pr.amount);
        if (a > 0) count[a] = (count[a] || 0) + 1;
      });
      /* And the pieces of payments that arrived with no route. They are locked
       * to this phone and not in the pile, and each can now be
       * signed and spent by itself — so they are change like any other, and a
       * phone that had just been paid offline was shown "no ecash on this
       * phone yet" while holding it. */
      try {
        lockedProofsFlat().forEach(function (f) {
          var a = satsOf(f.proof && f.proof.amount);
          if (a > 0) count[a] = (count[a] || 0) + 1;
        });
      } catch (e) {}
      /* The small tier is always listed, even at none held — those are the pieces
       * that decide whether an exact amount can be paid, so "1 \u00d7 0 of 12" is the
       * most useful row on the screen and leaving it out would hide the shortfall
       * entirely. Bigger denominations are listed only where some are held: nine
       * rows of zeroes climbing to 65536 would tell nobody anything. */
      var shown = {};
      smallTier().forEach(function (d) { shown[d] = true; });
      Object.keys(count).forEach(function (k) { shown[Number(k)] = true; });
      return Object.keys(shown)
        .map(function (k) { return Number(k); })
        .sort(function (a, b) { return a - b; })
        .map(function (a) { return { amount: a, count: count[a] || 0, want: pieceTarget(a) }; });
    },

    transactions: function (limit) {
      return Promise.resolve(load(K.log, []).slice(0, limit || 20));
    },

    /* No mint publishes an exchange rate, so this is the public feed only. */
    rate: function (opts) {
      var now = Date.now();
      // fresh: a real request, for the confirming check, not the minute-old copy
      if (!(opts && opts.fresh) && FoxyWallet._rate && (now - FoxyWallet._rateAt) < 60000) {
        return Promise.resolve(FoxyWallet._rate);
      }
      /* Not while the app is in the background.
       *
       * The page's refresh timer kept firing while Foxy was hidden. iOS held
       * the native requests it started, and on return they all ran at once
       * beside the confirming check's own — three price requests over Tor in
       * the same second (simulator trace). Hidden, the last price
       * stands; the check on return asks fresh once the page is visible. */
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return FoxyWallet._rate
          ? Promise.resolve(FoxyWallet._rate)
          : Promise.reject(new Error('Foxy is in the background; the price waits until it is open.'));
      }
      /* One request at a time, whoever asks.
       *
       * Coming back to the app, the confirming check, the home screen and the
       * chart each asked at once, and each started its own walk through the
       * price sources — six identical requests over Tor in the same second.
       * A caller that arrives while one is in flight gets that one. A fresh
       * request is satisfied by it too: it was made after the return. */
      if (FoxyWallet._rateInFlight) {
        /* A caller that only wants a price, while a fresh one is still on its
         * way, gets the last one now. The return check's last step — the
         * balances, through refreshBalance — used to share the request in
         * flight, and through a bridge that is a walk of up to 30 seconds: the
         * balances had loaded and the check still sat on the price, confirming
         * only when the walk gave up (simulator trial over obfs4).
         * The fresh price replaces this one when it lands. With no price yet
         * there is nothing to give instead, so that caller shares. */
        if (!(opts && opts.fresh) && FoxyWallet._rate) {
          console.log('[foxy] price: one is on its way; the last one meanwhile');
          return Promise.resolve(FoxyWallet._rate);
        }
        console.log('[foxy] price: sharing the request in flight');
        return FoxyWallet._rateInFlight;
      }
      // the routine one-a-minute ask is not said; its answer already is
      if (opts && opts.fresh) console.log('[foxy] price: asking (fresh)');
      var run = FoxyWallet._rateFetch();
      FoxyWallet._rateInFlight = run;
      var clear = function () { if (FoxyWallet._rateInFlight === run) FoxyWallet._rateInFlight = null; };
      run.then(clear, clear);
      return run;
    },

    _rateInFlight: null,

    /* A price two sources agree on, within 2%, asked fresh every time. For a
     * payment typed in dollars, where the price decides how many sats go: the
     * first source to answer could be wrong, or lying, and nothing compared it
     * with another. Refuses when no two agree. */
    agreedRate: function () {
      return FoxyWallet._rateFetch(true);
    },

    /* The price request in flight, or null: for a caller that will not wait
     * on it, but wants to know when it lands. */
    rateInFlight: function () {
      return FoxyWallet._rateInFlight || null;
    },

    _rateFetch: function (agree) {
      try { assertRoute(); } catch (e) { return Promise.reject(e); }

      function keep(n) {
        if (!isFinite(n) || n < 5000 || n > 1000000) throw new Error('no usable price');
        FoxyWallet._rate = n;
        FoxyWallet._rateAt = Date.now();
        /* Written down, not just held.
         *
         * It lived in these two variables and nowhere else, so killing the app
         * threw it away: a phone relaunched in airplane mode came up with no
         * price at all and the keypad fell back to sats, twenty-two seconds
         * after it had been told 84,746.
         *
         * Offline that is exactly when it is needed, because there is no way to
         * fetch another. Kept with its timestamp, always shown with its age, and
         * never treated as current — `rate()` only serves it for a minute
         * before asking again, which this does not change. */
        try { save(K.rate, { rate: n, at: FoxyWallet._rateAt }); } catch (e) {}
        return n;
      }

      // Native first: a file-loaded page cannot call these APIs cross-origin,
      // and Coinbase turns Tor exits away — so the price quietly stopped
      // updating once everything went over the tunnel. The native side asks
      // mempool's onion first, which no exit node can be turned away from.
      var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
      if (mh) {
        return new Promise(function (ok, no) {
          var id = 'p' + Date.now() + Math.random().toString(36).slice(2, 7);
          var settled = false;
          FoxyWallet._scans[id] = {
            ok: function (text) {
              if (settled) return; settled = true;
              try { ok(keep(Number(text))); } catch (e) { no(e); }
            },
            no: function (e) { if (!settled) { settled = true; no(new Error(e)); } }
          };
          /* A little past the native side's own limit: 12 seconds direct, 30
           * through a bridge (FoxyBridge price). Waiting 14 on a bridge dropped
           * an answer on its way, and the next ask started a second walk
           * beside the first. */
          var via = FoxyWallet.privacy ? FoxyWallet.privacy() : null;
          var bridged = !!(via && via.tor === 'up' && via.transport && via.transport !== 'direct');
          mh.postMessage(agree ? { action: 'price', id: id, agree: true } : { action: 'price', id: id });
          setTimeout(function () {
            if (!settled) { settled = true; delete FoxyWallet._scans[id]; no(new Error('price timed out')); }
          }, agree ? (bridged ? 49000 : 29000) : (bridged ? 34000 : 14000));
        });
      }

      // Browser or simulator: the same list the native side walks, in the same
      // order, so development behaves like the device. Most of these refuse a
      // cross-origin call from a file:// page — that is exactly why the native
      // path above exists — so this falls through them until one answers. The
      // first is an onion, which only the native path can reach at all: a
      // browser has no Tor to hand it to, and falls straight through.
      /** @type {Array<[string, function(*): *]>} each source: its address, and how to read the price from its answer */
      var SOURCES = [
        ['http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/api/v1/prices',
          function (j) { return j && j.USD; }],
        ['https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
          function (j) {
            var r = j && j.result, k = r && Object.keys(r)[0];
            return k && r[k].c && r[k].c[0];
          }],
        ['https://www.bitstamp.net/api/v2/ticker/btcusd/',
          function (j) { return j && j.last; }],
        ['https://blockchain.info/ticker',
          function (j) { return j && j.USD && j.USD.last; }],
        ['https://api.gemini.com/v1/pubticker/btcusd',
          function (j) { return j && j.last; }],
        ['https://api.coinbase.com/v2/prices/BTC-USD/spot',
          function (j) { return j && j.data && j.data.amount; }]
      ];

      function tryNext(i) {
        if (i >= SOURCES.length) {
          return Promise.reject(new Error('no price source answered'));
        }
        return fetch(SOURCES[i][0])
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var n = Number(SOURCES[i][1](j));
            if (!isFinite(n) || n <= 0) throw new Error('no usable figure');
            console.log('[foxy] price', n, 'from', SOURCES[i][0]);
            return keep(n);
          })
          .catch(function (e) {
            console.warn('[foxy] price source failed:', SOURCES[i][0], String(e && e.message || e));
            return tryNext(i + 1);
          });
      }

      return tryNext(0);
    },

    /* Price history for the chart, through the bridge so it sits behind the
     * gate. Resolves [{t, c}] oldest first. The browser path talks to Kraken
     * directly, which only works where CORS allows it — the device never
     * takes that path. */
    candles: function (granularity, span) {
      assertRoute();
      var g = Math.max(60, Math.round(Number(granularity) || 3600));
      var sp = Math.max(g * 4, Math.round(Number(span) || 86400));
      var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;

      if (mh) {
        return new Promise(function (ok, no) {
          var id = 'c' + Date.now() + Math.random().toString(36).slice(2, 7);
          var settled = false;
          FoxyWallet._scans[id] = {
            ok: function (text) {
              if (settled) return; settled = true;
              try {
                ok(JSON.parse(text).map(function (r) { return { t: r[0], c: r[1] }; }));
              } catch (e) { no(e); }
            },
            no: function (e) { if (!settled) { settled = true; no(new Error(e)); } }
          };
          mh.postMessage({ action: 'candles', id: id, g: g, span: sp });
          setTimeout(function () {
            if (!settled) { settled = true; delete FoxyWallet._scans[id]; no(new Error('candles timed out')); }
          }, 16000);
        });
      }

      var mins = [1, 5, 15, 30, 60, 240, 1440, 10080, 21600];
      var iv = mins.filter(function (m) { return m >= g / 60; })[0] || 21600;
      while (sp / (iv * 60) > 720) {
        var nxt = mins.filter(function (m) { return m > iv; })[0];
        if (!nxt) break;
        iv = nxt;
      }
      var since = Math.floor(Date.now() / 1000) - sp;
      return fetch('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=' + iv + '&since=' + since)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var res = (j && j.result) || {};
          var key = Object.keys(res).filter(function (k) { return Array.isArray(res[k]); })[0];
          return (res[key] || []).map(function (row) {
            return { t: Number(row[0]), c: Number(row[4]) };
          });
        });
    },

    /* The last price this phone was told, and when. Both start from storage, so
     * a launch with no route has the figure it had before rather than nothing
     * (`keep`, above). `lastPrice()` is what a screen should read: it says how
     * old the figure is and never pretends it is current. */
    /** @type {?number} */
    _rate: null,
    _rateAt: 0,

    /* What is known about the price right now: { rate, at, ageMs } with rate
     * null when this phone has never been told one. Local and synchronous. */
    lastPrice: function () {
      var n = Number(FoxyWallet._rate) || 0;
      var at = Number(FoxyWallet._rateAt) || 0;
      if (!(n > 0) || !at) return { rate: null, at: 0, ageMs: 0 };
      return { rate: n, at: at, ageMs: Math.max(0, Date.now() - at) };
    },

    /* Mint the proofs for a quote whose only record is a mint switch.
     *
     * claim() looks the quote up in the pending list, which is written by
     * invoice() — a transfer quote is created at the far mint and never goes
     * in there, so claim() rejected it as belonging to another device while
     * the money sat at the new mint, paid and unclaimed. This takes the amount
     * as an argument instead of looking it up.
     */
    /* `away`: { w } — a wallet for a mint the phone is not connected to
     * (`awayWallet`), so a crossing's claim can be made from wherever the
     * phone is (`finishMove`). */
    claimQuote: function (quoteId, amount, lock, away) {
      var w;
      try {
        if (away && away.w) assertRoute();
        w = onCircuit(away && away.w ? away.w : need(), 'quote:' + quoteId);
      } catch (e) { return Promise.reject(e); }
      var want = Math.round(Number(amount));
      if (!(want > 0)) return Promise.reject(new Error('No amount to claim.'));
      /* The claim's output ranges go on the move note as they are reserved, as
       * claim() writes them on the invoice: a claim whose answer is lost leaves
       * the quote ISSUED, and recoverIssued restores exactly these. */
      var note = moveNote(quoteId);
      var rec = outputsRecorder(w, note ? note.outputs : [], function (list) {
        noteQuoteOutputs(quoteId, list, mintOf(w));
      });
      return onceMoreIfSigned(w, 'claim', function () {
        return rec.attempt(function () { return mintQuoteProofs(w, want, quoteId, lock); });
      }, quoteStillPaid(w, quoteId)).then(function (fresh) {
        addProofs(fresh, mintOf(w), w);
        // same tick: these ranges are proofs in the pile now, never to be restored again
        var moved = moveNote(quoteId);
        if (moved && moved.outputs) {
          delete moved.outputs;
          delete moved.outputsMint;
          putMoveNote(moved);
        }
        logTx({
          dir: 'in',
          sats: sumProofs(fresh),
          feeSats: 0,
          settled: true,
          state: 'success',
          memo: 'mint switch',
          hash: quoteId,
          // where it landed, which is not always where the phone is
          mint: mintOf(w),
        });
        return sumProofs(fresh);
      });
    },

