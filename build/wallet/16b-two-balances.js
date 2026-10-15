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
     * to be handed back); dollars are the same in cents. Local and at once.
     * The connected mint when none is named. */
    balanceOf: function (unit, mint) {
      var u = unitOf(unit);
      if (!u) return 0;
      var m = mint ? canonicalMint(mint) : mintUrl;
      if (!m) return 0;
      if (u === 'sat') return Math.max(0, sumProofs(proofs(m)) + unclaimedSats(m) - changeLeavingSats(m));
      /* The same sum in the unit: the pile, what arrived in this unit and
       * waits to be swapped in (kept offline, locked to this phone), less
       * change in this unit about to be handed back. No row of another unit
       * ever adds to it. */
      return Math.max(0, sumProofs(proofs(m, u)) + unclaimedIn(u, m) - changeLeavingIn(u, m));
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
     * The same roads a sat send takes, in this unit and from this unit's
     * pile alone, and never the sat change pool (`tidyChange` stays sats):
     *
     *   with a route, locked (`lockTo`): the pile is swapped into pieces
     *     locked to the receiver on the dollar keyset, with the record a
     *     locked send writes before it leaves (`swapGuard`, `locked`), so a
     *     lost answer is rebuilt (`restoreLocked`, `writeLockedSend`). Change
     *     for an over-payment goes back this way (`purpose: 'change'`).
     *   with a route, not locked: pieces that make the amount exactly go as
     *     they are; otherwise the mint cuts them.
     *   with no route: pieces of the pile that make it exactly; else dollar
     *     rows that arrived locked to this phone, signed and handed on
     *     (`exactWithLocked`, `forwardLocked`), whole or piece by piece; else,
     *     on a tap only (`cover`), the least that covers it, with the change
     *     to come back locked to `changeKey` and the person's word that they
     *     will pay over (`overpayOk`). A token for showing (no `cover`) is
     *     made from exact pieces or rows only.
     *
     * Every amount is in the unit (cents for dollars). */
    _sendUnitToken: function (amount, unit, opts) {
      var o = opts || {};
      var u = unitOf(unit);
      var no = unitRefusal(u);
      if (no) return Promise.reject(no);
      var want = Math.round(Number(amount));
      if (!(want > 0)) return Promise.reject(new Error('Ask for an amount above zero.'));
      // a card's one-signature pieces and cut ladders are sats only (08a-flashcard.js)
      if (o.sigAll || (Array.isArray(o.denominations) && o.denominations.length)) {
        return Promise.reject(new Error('Cards are bitcoin only; nothing was sent.'));
      }
      var lockTo = typeof o.lockTo === 'string' ? o.lockTo : '';
      var online = routeOpen();
      if (lockTo && !online) {
        return Promise.reject(new Error('A locked payment needs the mint, and this phone is offline. Nothing was sent.'));
      }
      if (o.purpose === 'change' && !lockTo) {
        return Promise.reject(new Error('Change goes back locked to the payer, or not at all; nothing was sent.'));
      }
      var isChange = o.purpose === 'change';
      var said = function (n) { return moneyWords(n, u); };
      var at = '';
      try { at = mintOf(needLocal()); } catch (e) { return Promise.reject(e); }
      // with a route, the wallet on a circuit of its own; with none, the same wallet built from what is known here
      return (online ? walletIn(u) : unitWalletLocal(u)).then(function (w) {
        var have = proofs(at, u);
        var stuck = lockedProofs(have);
        if (stuck.length) have = have.filter(function (p) { return stuck.indexOf(p) < 0; });
        var held = sumProofs(have);
        var fee = swapFeeFor(w, have);
        // dollar rows that arrived locked to this phone count where they can be handed on: no route, no lock
        var waiting = (!online && !lockTo) ? lockedPieces(u) : [];
        var waitingAmt = waiting.reduce(function (n, r) { return n + amountOfRecord(r); }, 0);
        if (held + waitingAmt < want + fee) {
          throw new Error(notEnoughWords({ need: want + fee, have: held + waitingAmt }, u));
        }
        var exact = null;
        if (!lockTo) {
          try { exact = exactPieces(w, have, want); } catch (e) { exact = null; }
          if (!exactGoesAsIs(w, exact)) exact = null;
        }
        var made, changeNoteKey = '';
        /** @type {any} */
        var withLocked = null;
        /** @type {?{ picked: any[], total: number, over: number }} */
        var cover = null;
        if (!exact && !lockTo && !online) {
          // whole rows first: fewer signatures for the same amount
          withLocked = exactWithLocked(w, have, waiting, want);
          // and piece by piece, the pile and every locked piece as one pool
          var flat = withLocked ? [] : lockedProofsFlat(u);
          var partsOf = function (picked) {
            var rowOf = {};
            flat.forEach(function (f) { rowOf[String(f.proof.secret)] = f.row; });
            var groups = {}, pieces = [];
            (picked || []).forEach(function (pr) {
              var id = rowOf[String(pr.secret)];
              if (id === undefined) { pieces.push(pr); return; }
              (groups[id] = groups[id] || []).push(pr);
            });
            var rows = Object.keys(groups).map(function (id) {
              return { id: id, amount: sumProofs(groups[id]), unit: u, part: true, token: encodeToken(at, groups[id], u) };
            });
            return { rows: rows, pieces: pieces };
          };
          if (!withLocked && flat.length) {
            var combo = exactPieces(w, have.concat(flat.map(function (f) { return f.proof; })), want);
            if (combo && combo.length) {
              var parts = partsOf(combo);
              if (parts.rows.length) withLocked = { rows: parts.rows, pieces: parts.pieces, over: 0, part: true };
            }
          }
          /* Nothing makes it exactly. On a tap the least that covers it is
           * paid and the rest comes back as change, locked to this phone;
           * anywhere else (a token to show) nothing is made. */
          if (!withLocked) {
            if (!o.cover) {
              throw new Error('This phone is offline and has no ' + balanceWord(u).replace(/s$/, '')
                + ' pieces that make ' + said(want) + ' exactly. Nothing was sent.');
            }
            cover = coverPieces(w, have, want);
            if (flat.length) {
              var cp = coverPieces(w, have.concat(flat.map(function (f) { return f.proof; })), want);
              if (cp && (!cover || cp.total < cover.total)) {
                var cparts = partsOf(cp.picked);
                if (cparts.rows.length) {
                  withLocked = { rows: cparts.rows, pieces: cparts.pieces, over: cp.over, part: true };
                  cover = { picked: cparts.pieces, total: cp.total, over: cp.over };
                }
              }
            }
            if (!cover) {
              throw new Error('This phone is offline and its ' + balanceWord(u) + ' cannot make ' + said(want)
                + '. Nothing was sent.');
            }
            if (cover.over > 0 && !o.overpayOk) {
              var needs = /** @type {any} */ (new Error('This phone has no exact change for ' + said(want) + '.'));
              needs.foxyNeedsOverpay = { asked: want, pay: cover.total, over: cover.over, unit: u };
              throw needs;
            }
            if (cover.over > 0 && typeof o.changeKey === 'string' && /^0[23][0-9a-f]{64}$/i.test(o.changeKey)) {
              changeNoteKey = o.changeKey;
            }
          }
        }
        if (withLocked) {
          /* Signed now, and only the rows that are really going out; struck
           * off once the token is written down (below), as `sendToken` does. */
          var lockedOut = [];
          var fromPile = withLocked.pieces || [];
          var took = {};
          fromPile.forEach(function (p) { took[p.secret] = true; });
          console.log('[foxy] no exact ' + balanceWord(u) + ' pieces in the pile; handing on '
            + (withLocked.part ? 'pieces of ' : '') + withLocked.rows.length + ' locked payment(s) that arrived earlier'
            + (fromPile.length ? ' with ' + fromPile.length + ' piece(s) beside them' : ''));
          made = withLocked.rows.reduce(function (chain, row) {
            return chain.then(function () {
              return FoxyWallet.forwardLocked(row.token, { defer: true }).then(function (r) {
                (r.signed || []).forEach(function (pr) { lockedOut.push(pr); });
              });
            });
          }, Promise.resolve()).then(function () {
            return { send: fromPile.concat(lockedOut), keep: have.filter(function (p) { return !took[p.secret]; }),
                     handedOn: lockedOut.slice(), swapped: false, over: Math.max(0, Number(withLocked.over) || 0) };
          });
        } else if (exact || cover) {
          var use = exact || (cover && cover.picked) || [];
          var out = {};
          use.forEach(function (p) { out[p.secret] = true; });
          if (cover) {
            console.log('[foxy] no route and no exact ' + balanceWord(u) + ' pieces: paying ' + said(cover.total)
              + ' for ' + said(want) + ', with ' + said(cover.over) + ' of change to come back');
          }
          made = Promise.resolve({ send: use, keep: have.filter(function (p) { return !out[p.secret]; }),
                                   swapped: false, over: cover ? cover.over : 0 });
        } else {
          /* The mint is asked: the swap's record is on disk before the request
           * leaves, with the locked outputs written down as they are made, so
           * a lost answer is rebuilt and a payment killed half way is not
           * lost (`recoverSwaps`, `finishLockedSend`). */
          var guard = swapGuard(w, 'send', { inputs: have, unit: u, locked: !!lockTo,
            pay: { want: want, purpose: o.purpose || '', forHash: o.forHash || '', owed: o.owed || 0 } });
          made = guard.run('token', function () {
            return lockTo
              ? w.send(want, have, { includeFees: true }, { send: { type: 'p2pk', options: { pubkey: lockTo } } })
              : w.send(want, have, { includeFees: true });
          }).catch(function (e) {
            /* The mint never answered and it had made the payment: rebuilt
             * from the record, it is carried on with as if the answer had
             * come, and every piece the swap did not take goes back. */
            if (e && e.recovered && Array.isArray(e.lockedProofs) && e.lockedProofs.length) {
              var spentIn = {};
              (e.spentInputs || []).forEach(function (p) { if (p && p.secret) spentIn[p.secret] = true; });
              var untouched = have.filter(function (p) { return p && p.secret && !spentIn[p.secret]; });
              return { send: e.lockedProofs, keep: untouched.concat(e.changeProofs || []), swapped: true, guard: guard };
            }
            return retryWithoutSpent(w, e);
          }).then(function (split) {
            return { send: split.send, keep: split.keep || [], swapped: true, guard: split.guard || guard };
          });
        }
        return made.then(function (split) {
          // the rest of the pile first, then the record cleared, then the token (as `sendToken`)
          setProofs((split.keep || []).concat(stuck), at, w, u);
          // change set aside for an over-payment leaves with its pieces (`holdChange`)
          if (isChange && o.forHash) changeHoldOver(o.forHash);
          if (split.guard) split.guard.done();
          var over = Number(split.over) || 0;
          var token = encodeToken(at, split.send, u, changeNoteKey && over > 0
            ? { memo: CHANGE_NOTE + changeNoteKey + ':' + want } : null);
          var hash = 'token-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          var sent = sumProofs(split.send);
          var tokFee = split.swapped
            ? Math.max(0, sumProofs(have) - sent - sumProofs(split.keep || []))
            : 0;
          // the string is the money now: written down before anything else
          mustSave(K.outtok, { token: token, sats: 0, unit: u, amount: sent, mint: at,
                               hash: hash, at: Date.now(), swapped: split.swapped });
          // the locked pieces in it struck off, all of them, now that the token is written down
          if (split.handedOn && split.handedOn.length) {
            rememberHandedOn(split.handedOn);
            takeFromUnclaimed(split.handedOn);
            console.log('[foxy] handed on ' + said(sumProofs(split.handedOn)) + ' of locked ecash, signed here');
          }
          // paid over by too little to come back: it goes with the payment (`changeFor`, the receiver's sum)
          var dust = 0;
          if (over > 0 && !(changeFor(w, over) > 0)) {
            dust = over;
            over = 0;
            console.log('[foxy] ' + said(dust) + ' over is too little to come back at this mint; it goes with the payment');
          }
          if (isChange) {
            console.log('[foxy] change of ' + said(sent) + ' made; it belongs to the payment it came from, not to a row of its own');
          } else {
            logTx(unitRow(u, { dir: 'out', sats: sent - over, grossSats: over > 0 ? sent : undefined,
                               changeSats: over > 0 ? over : undefined, changeState: over > 0 ? 'owed' : '',
                               dustSats: dust || undefined, feeSats: tokFee, settled: true, state: 'success',
                               memo: 'ecash', hash: hash, mint: at }));
          }
          logAudit({ hash: hash, sats: 0, feeSats: 0, unit: u, amount: sent, kind: 'token',
                     inputs: (split.send || []).map(scrub), outputs: (split.keep || []).map(scrub) });
          FoxyWallet.tag(hash, isChange ? { to: 'change', change: true, token: token, unit: u }
            : o.inflight ? { to: 'ecash', token: token, unit: u, inflight: true }
            : { to: 'ecash', token: token, unit: u });
          return { token: token, unit: u, amount: sent, sats: 0, mint: at, hash: hash,
                   swapped: split.swapped, lockedTo: lockTo || '', fee: tokFee, over: over, asked: want, dust: dust,
                   changeAsked: !!(changeNoteKey && over > 0) };
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

