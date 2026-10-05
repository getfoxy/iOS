    /* ---- native bridges, unchanged ------------------------------------- */

    scan: function (prompt) {
      return new Promise(function (ok, no) {
        var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
        if (!mh) { no(new Error('No camera bridge. This only works inside the app.')); return; }
        var id = 's' + Date.now() + Math.random().toString(36).slice(2, 7);
        FoxyWallet._scans[id] = {
          ok: function (t) { FoxyWallet._noteScan(t, ''); ok(t); },
          no: function (e) { FoxyWallet._noteScan('', (e && e.message) || 'nothing'); no(e); },
        };
        mh.postMessage({ action: 'scan', id: id, prompt: prompt || '' });
      });
    },

    _scans: {},

    /* The NUT-01 key check, for tests. Every mint answer goes through it
     * inside nativeRequest; this is the same function, reachable without a
     * mint on the other end. */
    _mintKeysProblem: function (parsed) { return mintKeysProblem(parsed); },

    _scanResult: function (id, text, err) {
      var w = FoxyWallet._scans[id];
      if (!w) return;
      delete FoxyWallet._scans[id];
      if (err) w.no(new Error(err)); else w.ok(String(text || ''));
    },

    /* What the camera read, said once per scan.
     *
     * Not in `_scanResult`: that is the bridge's one resolver for every native
     * request there is, so a line there was printed for every mint reply as
     * well — which is how the first version of this filled the diary with
     * "scan: read something else, 468 chars" while no camera was open.
     *
     * The kind and the length only. A token or a request is money, or points at
     * it, and the diary is shared. */
    _noteScan: function (text, err) {
      var t = String(text || '');
      var kind = err ? 'nothing' :
        /^ln(bc|tb|bcrt)/i.test(t) ? 'an invoice' :
        /^cashu/i.test(t) ? 'a token' :
        /^creq/i.test(t) ? 'a request' :
        /^ur:/i.test(t) ? 'one frame of an animated code' :
        /^(bitcoin:)?(bc1|tb1|[13])/i.test(t) ? 'an address' :
        /^https?:/i.test(t) ? 'a web address' : t ? 'something else' : 'nothing';
      console.log('[foxy] scan: the camera read ' + kind
        + (t ? ', ' + t.length + ' chars' : '')
        + (err ? ' (' + err + ')' : ''));
    },

    /* Tells the app how many things to scan at sign-in. The LNbits build needs
     * an address and an admin key; a mint needs only its URL. */
    pairing: 'mint',

    /* Pairing here is a mint address, not a key — nothing secret in the QR. */
    pair: function (url) {
      var u = String(url || '').trim();
      if (!/^https?:\/\//.test(u)) {
        return Promise.reject(new Error('That QR is not a mint address.'));
      }
      return FoxyWallet.connect(u);
    },

    /* ---- tap to pay, over Bluetooth (TAP-TO-PAY.md) ---------------------- */

    /* Advertise this Lightning invoice until tapReceiveStop. A payer's code
     * arrives through onTap as { side: 'receive', stage: 'code', code }. */
    /* Hold the screen awake, or let it sleep again.
     *
     * For screens somebody looks at without touching: an invoice held up for
     * another phone to read, and the connecting screen. iOS dims and locks in
     * the middle of both otherwise. The flag belongs to the app, so whoever
     * turns it on turns it off when their screen goes, and the native side
     * drops it as Foxy leaves the foreground. */
    keepAwake: function (on) {
      return bridgeAsk('awake', { on: !!on }, 5000).catch(function () {});
    },

    /* A shake presses TAP (TAP-TO-PAY.md): armed only while the receive
     * invoice screen has something a payer could pay; errors swallowed like
     * `keepAwake`. */
    shakeSense: function (on) {
      return bridgeAsk(on ? 'shakeStart' : 'shakeStop', {}, 5000).catch(function () {});
    },

    /* What this phone is offering a payer who taps: a Lightning invoice, a
     * Cashu payment request, or both, as the JSON TapProtocol.isPayload
     * describes. Two Foxys on one mint use the request. */
    tapReceive: function (payload, early) {
      // `early`: on the air from the amount screen, with nothing to pay yet —
      // a payer warms its link but shows no CONNECT TO PAY card until NEXT
      return bridgeAsk('tapReceiveStart', { payload: String(payload || ''), early: !!early }, 5000);
    },
    tapReceiveStop: function () {
      return bridgeAsk('tapReceiveStop', {}, 5000).catch(function () {});
    },

    /* Find the closest receiver and take what it offers: resolves
     * { payload, code }, and rejects when tapPayStop ends it. Progress arrives
     * through onTap as { side: 'pay', stage }.
     *
     * `payload` is the offer JSON (TapProtocol.isPayload) — an invoice, a
     * Cashu payment request, or both — which the page reads with tapOfferOf.
     * It was `invoice` until the request half was added, and this line went on
     * checking for the old name: every tap reached "payload received and nonce
     * accepted" on the native side and was then thrown away here, so nothing
     * happened at all. */
    /* TAP TO PAY pressed: take the receiver the toast is for, without the
     * phones touching. Rides `tapPayStart`, which is already allowed here. */
    tapPayNow: function () {
      return bridgeAsk('tapPayStart', { now: true }, 5000);
    },

    tapPay: function () {
      return bridgeAsk('tapPayStart', {}, 30 * 60 * 1000).then(function (text) {
        var got = null;
        try { got = JSON.parse(String(text)); } catch (e) {}
        if (!got || typeof got.payload !== 'string' || !/^[0-9]{4}$/.test(String(got.code))) {
          throw new Error('Nothing usable came over Bluetooth.');
        }
        return { payload: got.payload, code: String(got.code) };
      });
    },
    /* Hand the payment to the receiver over the link this tap already holds,
     * and resolve with what they said became of it.
     *
     * M6 used to be sealed by the receiver's radio the instant the bytes
     * arrived, before its page had parsed or written down anything, and this
     * resolved 'ok' for all of them — so `payRequest` resolved,
     * `requestDelivered` ran, and `forgetClaimedToken` deleted the payer's only
     * copy of a payment the receiver may have refused a moment later.
     * M6 is now the page's own word, with the same statuses
     * `inboxAnswer` carries over Tor.
     *
     *   'settled'      200 — written down where a force-quit cannot lose it
     *   'unconfirmed'  409, 504, or an answer this cannot read: it may have
     *                  landed and may not, so the caller keeps its token and
     *                  watches, as a Nostr delivery does
     *   throws         422 — refused, and `foxyRefused` so the caller does not
     *                  fall back: they heard it and said no, and every refusal
     *                  is the same refusal over the other transport
     *
     * Rejects with no marker when the link itself has gone, which is the one
     * case the fallback was ever for.
     *
     * A receiver from before this says `{"ok":true}` with no code even when it
     * refused — that was the bug — so it reads as unconfirmed and the payer
     * keeps its token. Safe, and it needs no version on the wire. */
    tapSend: function (body) {
      // 40s, so the receiver's own 25s give-up always beats this to the answer —
      // and a second more for every two kilobytes, which is what the link carries:
      // a payment of many pieces is half a minute crossing before anyone can answer
      var text0 = String(body || '');
      return bridgeAsk('tapSend', { body: text0 }, 40000 + Math.ceil(text0.length / 2000) * 1000).then(function (text) {
        var got = null;
        try { got = JSON.parse(String(text || '')); } catch (e) {}
        if (!got || typeof got !== 'object') return 'unconfirmed';
        var code = Math.round(Number(got.code));
        if (code === 200 && got.ok === true) return 'settled';
        if (!(code > 0) || code === 409 || code === 504) return 'unconfirmed';
        var why = typeof got.why === 'string' ? got.why.slice(0, 200) : '';
        var e = /** @type {any} */ (new Error(why || 'Their wallet did not take the payment.'));
        e.foxyRefused = true;
        throw e;
      });
    },

    /* The receiver hands change back over the link the payment came in on.
     *
     * Its own action, not `inboxAnswer`: that one is shared with the onion path
     * and clamps to a status and three hundred characters, and a token is neither.
     * Rejects when the link has gone, so the caller learns rather than believing
     * change went out. */
    /* Change the payer could not swap in, because it arrived with no route.
     *
     * Kept rather than claimed, in the store a locked payment waits in, so the
     * claim that runs on any screen money could leave from takes it when there is
     * a route. Safe to hold: it is locked to a key only this phone has. */
    repairOwedChange: function () { return repairOwedChange(); },
    // native: the payer said it kept the change after this phone had stopped waiting for it
    _tapChangeKeptLate: function () { tapChangeKeptLate(); },
    stampRates: function () { return stampRates(); },

    /* Whether change that has just arrived may be kept ({ok, why, signed, sats}). */
    /* What a change token is worth to this phone: its pieces less this
     * mint's fee for swapping them in. */
    changeNet: function (token) {
      var info = null;
      try { info = FoxyWallet.tokenInfo(String(token || '')); } catch (e) {}
      var list = (info && info.proofs) || [];
      var sum = list.reduce(function (a, pr) { return a + (satsOf(pr && pr.amount) || 0); }, 0);
      var fee = 0;
      try { fee = wallet ? swapFeeFor(wallet, list) : 0; } catch (e2) { fee = 0; }
      return Math.max(0, sum - fee);
    },

    checkChange: function (token, owed) {
      return checkChange(String(token || ''), Number(owed) || 0);
    },

    keepChange: function (token, sats, forId) {
      return keepChange(String(token || ''), Number(sats) || 0, forId || '');
    },

    tapChange: function (token) {
      return bridgeAsk('tapChange', { body: String(token || '') }, 30000);
    },

    /* "A person is reading a card" — sent up the link so the payer waits for
     * them rather than for a clock.
     *
     * The receiver's page has 25 seconds to answer M5 and the payer drops the
     * link at 30. Both are right for a page doing a swap and wrong for a person
     * reading a warning, and a payer's phone frozen for twenty seconds with
     * nothing on it reads as a broken app. This becomes M9, which stretches both
     * clocks and puts words on the payer's screen. */
    tapAsking: function () {
      return bridgeAsk('tapAsking', {}, 5000);
    },

    /* "This payment owes change back" — said the moment the amount is read, so
     * the link is not retired while the swap that makes the change is still at
     * the mint. It sends nothing; `tapChange` is what carries the money. */
    /* M10: this phone's price, and the sats it makes of the dollar amount a
     * receiver with no route asked for. Nothing moves on it. */
    tapQuote: function (body) {
      return bridgeAsk('tapQuote', { body: String(body || '') }, 10000);
    },

    /* M11: the receiver agreed that price; here is the request, now in sats. */
    tapTerms: function (body) {
      return bridgeAsk('tapTerms', { body: String(body || '') }, 10000);
    },

    /* The payer's page hearing a receiver's dollar offer answered, and the
     * receiver's page hearing the payer's price. One listener each, like
     * `_tapChange`. */
    _tapQuote: function (text) {
      /* "I am about to pay this" is the wallet's to answer, at once and by
       * itself: nobody is asked, and nothing on screen changes. */
      var said = null;
      try { said = JSON.parse(String(text || '')); } catch (e0) { said = null; }
      if (said && typeof said === 'object' && said.intend && typeof said.intend === 'object') {
        var answer = answerIntent(said.intend);
        console.log('[foxy] tap: asked first about ' + (Math.round(Number(said.intend.sats)) || 0) + ' sats — '
          + (answer.go ? 'go' : 'no: ' + answer.why));
        FoxyWallet.tapTerms(JSON.stringify(answer)).catch(function (e) {
          console.warn('[foxy] tap: the answer to their question could not be sent:', e && e.message);
        });
        return;
      }
      /* "I have paid your invoice", from a payer that paid it over
       * Lightning: nothing crossed this link, so this phone would otherwise
       * learn of it from its mint, on its own clock. It is a reason to ask
       * the mint now and nothing more — the payer's word is not a payment —
       * so all that is kept of it is which invoice it names. */
      if (said && typeof said === 'object' && said.paid && typeof said.paid === 'object') {
        var tail = typeof said.paid.tail === 'string' ? said.paid.tail.slice(0, 32) : '';
        if (typeof FoxyWallet._onTapPaid === 'function') {
          try { FoxyWallet._onTapPaid({ tail: tail }); }
          catch (e1) { console.error('[foxy] tap paid:', e1 && e1.message); }
        }
        return;
      }
      if (typeof FoxyWallet._onTapQuote === 'function') {
        try { FoxyWallet._onTapQuote(String(text || '')); }
        catch (e) { console.error('[foxy] tap quote:', e && e.message); }
      }
    },
    onTapQuote: function (fn) { FoxyWallet._onTapQuote = fn; },
    /** @type {?function({tail: string}): void} */
    _onTapPaid: null,
    onTapPaid: function (fn) { FoxyWallet._onTapPaid = fn; },

    _tapTerms: function (text) {
      // the answer to `askFirst`, when one is being waited for
      var got = null;
      try { got = JSON.parse(String(text || '')); } catch (e0) { got = null; }
      if (got && typeof got === 'object' && typeof got.intent === 'string') {
        var waiter = FoxyWallet._askWaiter;
        if (waiter && waiter.id === got.intent) waiter.done({ go: got.go === true, why: typeof got.why === 'string' ? got.why.slice(0, 200) : '' });
        return;
      }
      if (typeof FoxyWallet._onTapTerms === 'function') {
        try { FoxyWallet._onTapTerms(String(text || '')); }
        catch (e) { console.error('[foxy] tap terms:', e && e.message); }
      }
    },
    onTapTerms: function (fn) { FoxyWallet._onTapTerms = fn; },

    tapChangeDue: function () {
      return bridgeAsk('tapChangeDue', {}, 5000).catch(function (e) {
        console.warn('[foxy] could not hold the link for the change:', e && e.message);
      });
    },

    /* And the payer's page saying it has the change written down.
     *
     * This is what becomes M8. The receiver holds the link open until it comes,
     * because change is money leaving and bytes arriving says nothing about money
     * kept — the same reason M6 is the page's word and not the radio's. */
    tapChangeKept: function (kept) {
      return bridgeAsk('tapChangeKept', { kept: !!kept }, 15000);
    },

    /* Change arriving, from the native side. One listener, like `_tap`. */
    _tapChange: function (text) {
      // a refused payment coming back is the wallet's own business (`refundArrived`)
      try { if (refundArrived(String(text || ''))) return; }
      catch (e0) { console.error('[foxy] tap refund:', e0 && e0.message); }
      if (typeof FoxyWallet._onTapChange === 'function') {
        try { FoxyWallet._onTapChange(String(text || '')); }
        catch (e) { console.error('[foxy] tap change:', e && e.message); }
      }
    },
    onTapChange: function (fn) { FoxyWallet._onTapChange = fn; },

    /* Ask the receiver before making anything: resolves { go, why, silent }.
     *
     * `how.locked`: the payment will be locked to them. `how.mint`: where it
     * will be made, when that is not where this phone is now (a crossing asks
     * before it moves anything). Six seconds, and no answer is a no — nothing
     * has been made, so nothing is lost by stopping. */
    askFirst: function (req, how) {
      var id = String((req && req.id) || '');
      var intent = { id: id, sats: Math.round(Number(req && req.sats) || 0),
                     mint: String((how && how.mint) || mintUrl || '').replace(/\/+$/, ''),
                     locked: !!(how && how.locked) };
      try { if (wallet && wallet.keysetId && !(how && how.mint)) intent.keyset = String(wallet.keysetId); } catch (e) {}
      return new Promise(function (resolve) {
        var done = false;
        var t = null;
        var finish = function (a) {
          if (done) return;
          done = true;
          clearTimeout(t);
          if (FoxyWallet._askWaiter && FoxyWallet._askWaiter.id === id) FoxyWallet._askWaiter = null;
          resolve(a);
        };
        t = setTimeout(function () {
          finish({ go: false, silent: true, why: 'They did not answer. Nothing was sent.' });
        }, Number(FoxyWallet._askWaitMs) || 6000);
        FoxyWallet._askWaiter = { id: id, done: finish };
        FoxyWallet.tapQuote(JSON.stringify({ intend: intent })).catch(function (e) {
          finish({ go: false, silent: true, why: (FoxyWallet.reason ? FoxyWallet.reason(e) : '') || 'That phone is no longer connected.' });
        });
      });
    },
    /** @type {any} */
    _askWaiter: null,
    /** @type {any} */
    _refundWait: null,
    _askWaitMs: 0,
    _refundWaitMs: 0,

    /* Ecash another phone has seen and refused, back in this wallet and not
     * yet swapped: [{ hash, sats, at, why }], and the total at this mint. In
     * the balance, spendable, and what the home screen rings red for. */
    atRisk: function () {
      return atRiskGroups().map(function (g) { return { hash: g.hash, sats: g.sats, at: g.at, why: g.why, mint: g.mint }; });
    },
    atRiskSats: function () { return atRiskSats(); },

    tapPayStop: function () {
      return bridgeAsk('tapPayStop', {}, 5000).catch(function () {});
    },

    onTap: function (fn) {
      if (typeof fn === 'function') FoxyWallet._tapListeners.push(fn);
    },
    /* The phone the other way up, or back, from the native side. The invoice
     * screen turns itself round on it, so a phone laid on a table top-down
     * shows its code the right way up to the person across it. */
    _upsideDown: false,
    upsideDown: function () { return !!FoxyWallet._upsideDown; },
    /** @type {?function(boolean): void} */
    _onTurned: null,
    onTurned: function (fn) { FoxyWallet._onTurned = fn; },
    _turned: function (on) {
      FoxyWallet._upsideDown = !!on;
      if (typeof FoxyWallet._onTurned === 'function') {
        try { FoxyWallet._onTurned(!!on); } catch (e) { console.warn('[foxy] turned listener:', e && e.message); }
      }
    },
    /** @type {Array<function(any): void>} */
    _tapListeners: [],
    _tap: function (ev) {
      if (!ev || typeof ev !== 'object') return;
      FoxyWallet._tapListeners.forEach(function (fn) {
        try { fn(ev); } catch (e) { console.warn('[foxy] tap listener:', e && e.message); }
      });
    },

