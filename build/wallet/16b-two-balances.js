    /* ---- two balances at one mint --------------------------------------
     *
     * A mint that issues sat and usd keysets (Forge does) holds two balances
     * for one person: bitcoin in sats and dollars in cents. They are two
     * piles, two kinds of record and two sets of books, and nothing here ever
     * adds one to the other (08c-units.js says why and how). Every amount in
     * this part is an integer in its own unit. The screens ask:
     *
     *   mintUnits, twoUnits   whether to show any of it at all
     *   walletChoice          what the person said they hold
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

    /* Whether the connected mint's wallet for `unit` can be built with no
     * request, its keys in hand (08c-units.js, `unitKeysOffline`): what a till
     * with no route asks before it takes a dollar card. Local, at once, a
     * boolean. */
    unitKeysOffline: function (unit) { return unitKeysOffline(unit); },

    /* What the person said they want to hold ('dollars', 'bitcoin', 'both',
     * or '' when never asked), and the unit that makes the one balance their
     * money goes into and comes from ('usd' for dollars, 'sat' for bitcoin, ''
     * for both or never asked) as `recv` and `send`. Nothing else is kept:
     * with both, every receive and send asks which (the CURRENCY screen). */
    walletChoice: function () {
      var v = load(K.hold, '');
      var hold = typeof v === 'string' && ['dollars', 'bitcoin', 'both'].indexOf(v) >= 0 ? v : '';
      var one = holdUnit(hold);
      return { hold: hold, recv: one, send: one };
    },

    /* The choice, written: `hold` only. A balance for receives or sends to
     * start in (`recv`, `send`) is no longer kept, and asking to keep one is
     * refused, as is anything else, before anything is written. Answers the
     * choice as it now stands. */
    setWalletChoice: function (patch) {
      var p = patch || {};
      var bad = function () { return new Error('Foxy does not know that choice.'); };
      if (typeof p !== 'object') throw bad();
      if (p.hold !== undefined && ['dollars', 'bitcoin', 'both'].indexOf(p.hold) < 0) throw bad();
      if (p.recv !== undefined || p.send !== undefined) throw bad();
      if (p.hold !== undefined) save(K.hold, p.hold);
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
      if (u === 'sat') return Math.max(0, sumProofs(proofs(m)) + unclaimedSats(m) + arrivingGross('sat', m) - changeLeavingSats(m));
      /* The same sum in the unit: the pile, what arrived in this unit and
       * waits to be swapped in (kept offline, locked to this phone), what has
       * been taken and is being swapped in now (`arrivingGross`), less change in
       * this unit about to be handed back. No row of another unit ever adds
       * to it. */
      return Math.max(0, sumProofs(proofs(m, u)) + unclaimedIn(u, m) + arrivingGross(u, m) - changeLeavingIn(u, m));
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
     * the payment. At a one-unit mint `usd` is null and nothing is asked.
     *
     * `onEach(unit, quote)`, when given, is told each one as it lands, not
     * when both have: the confirmation lets its button go on the balance that
     * pays as soon as that one's quote is in, and does not wait on the
     * circuit carrying the other (03-send.js, `feeQuoteIn`). What this
     * resolves with is the same either way.
     *
     * `stop()`, when given, says the confirmation has stopped asking (PAY
     * pressed on the other's quote, or another question begun): a quote not
     * in by then is asked no more on fresh circuits (`quoteFee`, `opts.stop`),
     * which would only be built beside the payment for an answer nobody
     * reads. */
    quoteFeeBoth: function (bolt11, onEach, stop) {
      var two = FoxyWallet.twoUnits();
      var told = function (unit) {
        return function (q) {
          if (typeof onEach === 'function') {
            try { onEach(unit, q); } catch (e) { console.warn('[foxy] a fee quote could not be handed on as it came:', e && e.message); }
          }
          return q;
        };
      };
      return Promise.all([
        FoxyWallet.quoteFee(bolt11, { unit: 'sat', stop: stop }).then(told('sat')),
        (two ? FoxyWallet.quoteFee(bolt11, { unit: 'usd', stop: stop }) : Promise.resolve(null)).then(told('usd')),
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
      var lockTo = typeof o.lockTo === 'string' ? o.lockTo : '';
      /* A card's one-signature pieces, and the drawer they are cut into, are a
       * locked send's (a dollar card's load and its change, 08a-flashcard.js):
       * never pieces anybody could take. */
      if ((o.sigAll || (Array.isArray(o.denominations) && o.denominations.length)) && !lockTo) {
        return Promise.reject(new Error('A card’s pieces are locked to the card; nothing was sent.'));
      }
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
            /* Locked as the sat send locks (19-bill-split.js): a refund to the
             * card's owner after its date where one is named, the one-signature
             * flag a card of format 4 signs under, and the pieces cut as the
             * caller says (a card's drawer). Whatever the cut leaves of the
             * amount, and the fee on it, the library fills as it always did. */
            var lockOut = /** @type {any} */ ({ type: 'p2pk', options: (o.lockUntil > 0)
              ? { pubkey: lockTo, locktime: Math.floor(o.lockUntil), refundKeys: o.refundTo ? [String(o.refundTo)] : undefined }
              : { pubkey: lockTo } });
            if (o.sigAll) lockOut.options.sigFlag = 'SIG_ALL';
            if (Array.isArray(o.denominations) && o.denominations.length) {
              lockOut.denominations = o.denominations.map(function (d) { return Math.round(Number(d)); });
            }
            return lockTo
              ? w.send(want, have, { includeFees: true }, { send: lockOut })
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

    /* The last few quote pairs seen for each mint and direction, in memory
     * only, newest first: [{ get, amount, fee, total, at }], keyed
     * 'mint|from|to'. What a pair cost is the best guide to sizing the next
     * one, fee and all, so a swap whose rate and fee are already known can
     * land in one pair instead of two; two pairs of different sizes tell a
     * fixed fee from a share. Never used to move money; a quote is always
     * asked before that. */
    _swapSeen: {},

    /* One quote pair: an invoice in the TO unit for `get` (from `tw`), and
     * what paying it from the FROM unit costs (from `fw`). Shared by the swap
     * itself and the probe the SWAP screen sends ahead. Commits to nothing:
     * neither quote is written down, and an unused one simply expires. */
    _swapPass: function (tw, fw, get) {
      return askQuote(tw, get, '').then(function (got) {
        return withTimeout(askedAgain(fw, 'the mint’s fee quote', function (via) {
          return via.createMeltQuoteBolt11(String(got.q.request));
        }), 30000, 'the mint’s fee quote').then(function (won) {
          var melt = won.got;
          var amt = satsOf(melt.amount) || 0, fee = satsOf(melt.fee_reserve) || 0;
          return { get: get, q: got.q, lock: got.lock, melt: melt, fw: won.w, amount: amt, fee: fee, total: amt + fee };
        });
      });
    },

    /* Quotes asked ahead of the person (`opts.paceMs` and `opts.perMin` on
     * `swapQuote` and `swapProbe`) keep their pairs at least `paceMs` apart,
     * second passes included, and wait while `perMin` pairs or more have gone
     * in the last minute. Every pair counts towards both, the ones a person
     * is waiting on too, though those are never held back themselves: a
     * Nutshell mint answers twenty quote requests a minute per address on
     * each quote route, and a pair is one on each, so a screen asking in the
     * background must leave most of that minute to the questions a person
     * is waiting on. `opts.hurry`, a promise, ends the wait early: the
     * person has come to need that very answer. Resolves when this pair may
     * go, and counts it as gone. */
    _swapPairs: /** @type {number[]} */ ([]),
    _swapPaceWait: function (ms, perMin) {
      var now = Date.now();
      var went = FoxyWallet._swapPairs = (FoxyWallet._swapPairs || []).filter(function (t) { return t > now - 60000; });
      var wait = 0;
      if (ms > 0 && went.length) wait = Math.max.apply(null, went) + ms - now;
      if (perMin > 0 && went.length >= perMin) {
        var sorted = went.slice().sort(function (a, b) { return a - b; });
        wait = Math.max(wait, sorted[went.length - perMin] + 60000 - now);
      }
      return Math.max(0, wait);
    },
    _swapPaced: function (opts) {
      var ms = Number(opts && opts.paceMs) || 0, perMin = Number(opts && opts.perMin) || 0;
      var wait = FoxyWallet._swapPaceWait(ms, perMin);
      var mark = { t: Date.now() + wait };
      // the slot is taken now, so a second question asked ahead queues behind this one
      FoxyWallet._swapPairs.push(mark.t);
      if (!(wait > 0)) return Promise.resolve();
      var timer = null;
      var slept = new Promise(function (r) { timer = setTimeout(r, wait); });
      var hurried = opts && opts.hurry && typeof opts.hurry.then === 'function' ? opts.hurry : null;
      return (hurried ? Promise.race([slept, hurried]) : slept).then(function () {
        clearTimeout(timer);
        // gone now, not when it was booked for
        var i = FoxyWallet._swapPairs.indexOf(mark.t);
        if (i >= 0) FoxyWallet._swapPairs[i] = Date.now();
      });
    },

    /* What a pair says, kept: its shape for sizing the next pass, and the
     * mint's rate (the person's rate before the fee: cents against sats as
     * the two quotes priced them) for the screens. Answers the rate, or 0. */
    _swapNote: function (at, f, t, got) {
      var m = canonicalMint(at);
      if (got && got.get > 0 && got.amount > 0 && got.total > 0) {
        var key = m + '|' + f + '|' + t;
        var was = (FoxyWallet._swapSeen[key] || []).filter(function (p) { return p.get !== got.get; });
        FoxyWallet._swapSeen[key] = [{ get: got.get, amount: got.amount, fee: got.fee, total: got.total, at: Date.now() }].concat(was).slice(0, 4);
      }
      var msat = 0;
      try { msat = Number(FoxyWallet.msatOf(String(got.q.request))) || 0; } catch (e) { msat = 0; }
      var usdPerBtc = f === 'usd' ? rateFrom(got.amount, got.get * 1000) : rateFrom(got.get, got.amount * 1000);
      if (!(usdPerBtc > 0) && msat) usdPerBtc = f === 'usd' ? rateFrom(got.amount, msat) : rateFrom(got.get, msat);
      if (usdPerBtc > 0 && m) mintRates[m] = { usdPerBtc: usdPerBtc, at: Date.now(), mint: m };
      return usdPerBtc > 0 ? usdPerBtc : 0;
    },

    /* The mint's rate, asked ahead: one quote pair for a nominal amount
     * (`amount` in the FROM unit, or a thousand sats' worth), so the amount
     * screen can show the mint's own rate before anything is typed and the
     * swap's first pass is sized from it. Needs no balance, since nothing is
     * paid: the two quotes are left to expire. Keeps the rate (`mintRate`)
     * and the pair's shape, and nothing else. `opts` paces it as
     * `swapQuote`'s. Resolves { usdPerBtc, at }. */
    swapProbe: function (from, to, amount, opts) {
      var f = unitOf(from), t = unitOf(to);
      var no = function (why) {
        var e = /** @type {any} */ (new Error(why));
        e.probe = true;
        return Promise.reject(e);
      };
      if (!f || !t || !HANDLED_UNITS[f] || !HANDLED_UNITS[t] || f === t) return no('Pick two different balances.');
      if (!wallet || !routeOpen()) return no('Swapping needs the mint.');
      var at = mintOf(wallet);
      if (!FoxyWallet.twoUnits(at)) return no('This mint issues only bitcoin.');
      var view;
      try { view = needNow(); } catch (e) { return no('Swapping needs the mint.'); }
      var known = FoxyWallet.mintRate(at);
      var rate = (known && known.usdPerBtc) || Number(FoxyWallet._rate) || 100000;
      var give = Math.round(Number(amount));
      if (!(give > 0)) give = f === 'sat' ? 1000 : Math.max(1, Math.round(1000 * rate / 1e6));
      var get = f === 'usd' ? Math.floor(give / 100 / rate * 1e8) : Math.floor(give * rate / 1e8 * 100);
      if (!(get > 0)) get = 1;
      return Promise.all([unitWalletOn(view, t), unitWalletOn(view, f), FoxyWallet._swapPaced(opts)]).then(function (ws) {
        return FoxyWallet._swapPass(ws[0], ws[1], get);
      }).then(function (got) {
        var r = FoxyWallet._swapNote(at, f, t, got);
        return { usdPerBtc: r, at: Date.now() };
      });
    },

    /* The rate for swapping `amount` of `from` into `to`, held by the mint.
     * `amount` is what leaves, the mint's fee included; `opts.all` is the
     * whole of the FROM balance. The first pass is sized from the last pair
     * this mint answered in this direction (the probe's, or an earlier
     * quote's), else from the rate last seen, a little under; it is taken
     * as it is when no larger figure in the TO unit would fit. Otherwise a
     * second pass sized from what the first said, and a third if the rate
     * moved between them (six requests at most). Resolves { id, mint, from,
     * to, total, amount, fee, get, rate, market, spread, spreadWarn,
     * expiresAt, state: 'quoted' }. */
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
      /* `opts.coming`: what will be in this phone of FROM before the swap is run, and is not yet (a card's SWAP: what comes off the card at
       * its first tap, 26f-flashcard.js `fcSwapGo`); it is counted in what this phone could swap, never in `opts.all`'s whole. */
      var coming = Math.max(0, Math.round(Number(opts && opts.coming) || 0));
      var have = sumProofs(proofs(at, f));
      var total = (opts && opts.all) ? have : Math.round(Number(amount));
      have += coming;
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
        return FoxyWallet._swapPaced(opts).then(function () {
          return FoxyWallet._swapPass(tw, fw, get);
        }).then(function (got) {
          FoxyWallet._swapNote(at, f, t, got);
          return got;
        });
      };
      /* The first pass's size, from the pairs this mint answered this way in
       * the last ten minutes (a rate older says little about now), aiming
       * just under the amount. Two pairs far enough apart in size
       * give the fee as a fixed part and a share; one pair is read both as
       * a share and as fixed, and the smaller taken, so the guess errs
       * under. The rate is taken from the largest pair, the one its rounding
       * blurs least. None: 0, and the rate last seen sizes it, a little under. */
      var fromSeen = function () {
        var pts = (FoxyWallet._swapSeen[canonicalMint(at) + '|' + f + '|' + t] || []).filter(function (p) {
          return p && Date.now() - p.at < 600000 && p.get > 0 && p.amount > 0 && p.total > 0;
        });
        if (!pts.length) return 0;
        // the melt rounds what it asks up by half a unit on average, so a unit under lands in the middle
        var aim = total - 1;
        var big = pts.reduce(function (a, p) { return p.amount > a.amount ? p : a; }, pts[0]);
        // a melt's amount is rounded up to the unit, so the middle of what it could have been
        var per = Math.max(0.5, big.amount - 0.5) / big.get;
        // the newest pair, and the one furthest from it in size
        var far = pts.slice(1).reduce(function (a, p) {
          return !a || Math.abs(p.amount - pts[0].amount) > Math.abs(a.amount - pts[0].amount) ? p : a;
        }, null);
        if (far && Math.abs(pts[0].amount - far.amount) >= Math.max(10, 0.1 * Math.max(pts[0].amount, far.amount))) {
          var share = (pts[0].fee - far.fee) / (pts[0].amount - far.amount);
          if (share >= 0 && share < 0.5) {
            var fixed = pts[0].fee - share * pts[0].amount;
            return Math.floor((aim - fixed) / (1 + share) / per);
          }
        }
        var p0 = pts[0];
        return Math.floor(Math.min(p0.get * aim / p0.total, p0.get * (aim - p0.fee) / p0.amount));
      };
      var refuseLow = function () { return new Error('That is too little to swap after the mint’s fee.'); };
      var mintRefusal = function (e) {
        if (e && (e.offline || neverSent(e))) throw offline();
        throw e;
      };
      return Promise.all([unitWalletOn(view, t), unitWalletOn(view, f)]).then(function (ws) {
        tw = ws[0]; fw = ws[1];
        var first = fromSeen() || Math.floor(convert(total, guess) * 0.97);
        return pass(Math.max(1, first));
      }).then(function (one) {
        if (one.fee >= total || !(one.amount > 0)) throw refuseLow();
        /* Close enough already: under the amount by less than one more unit
         * of what arrives would cost (a cent of bitcoin is a dozen sats or so;
         * a sat of dollars is under a cent, so one cent). No second pass could
         * give the person more, so none is asked. */
        var step = Math.max(1, Math.ceil(one.amount / one.get));
        if (one.total <= total && total - one.total <= step) return one;
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
        // the rate the person gets, before the fee, kept as the mint's latest
        var usdPerBtc = FoxyWallet._swapNote(at, f, t, got);
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
        /* `opts.card`: the card a swap from a card's screen is for (26f-flashcard.js `fcSwapGo`); kept on the quote, and from it
         * on the swap's record, its invoice's record and its melt. The swap's rows do not name it (`swapMarks`): to the card the
         * swap is its two taps, and those rows do. */
        if (opts && typeof opts.card === 'string' && opts.card) quote.card = opts.card;
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
      // the card a swap from a card's screen is for (`swapQuote`, `opts.card`), or none
      var swapCard = typeof q.card === 'string' && q.card ? q.card : undefined;
      var result = function (state, spent, fee) {
        return { id: q.id, state: state, from: { unit: q.from, amount: spent }, to: { unit: q.to, amount: q.get },
                 fee: fee, rate: q.rate };
      };
      try {
        putUnitSwap({ id: q.id, at: Date.now(), mint: q.mint, from: q.from, to: q.to, total: q.total, amount: q.amount,
                      fee: q.fee, get: q.get, rate: rate, mintQuote: mq.quote, meltQuote: melt.quote, state: 'paying', card: swapCard });
        keepQuote(mq, q._lock, q.get, 'swap', q.to, q.mint, { swap: q.id, mintRate: rate || undefined, swapCard: swapCard });
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
        unit: q.from, swap: q.id, mintRate: rate, swapCard: swapCard,
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
        /* The melt paid this mint's own invoice for the swap, so the mint has
         * marked it paid already: claimed at once, without asking first
         * (`swapClaim`). Only for that melt, answered PAID, at the mint the
         * invoice came from. */
        var paidHere = !!(paid && paid.hash === melt.quote)
          && canonicalMint(mintOf(q._w)) === canonicalMint(mintOf(q._tw));
        return swapClaim(q._tw, mq.quote, paidHere).then(function (ok) {
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
      load(K.melting, []).forEach(function (e) { if (e && e.quote) held[e.quote] = sumProofs(e.proofs || []) || true; });
      var all = unitSwaps();
      var live = all.filter(function (r) {
        if (swapsGone[r.id]) return true;
        if (r.meltQuote && held[r.meltQuote]) return true;
        return r.meltLeg === 'paid' && !!(r.mintQuote && quoteRecord(r.mintQuote));
      });
      all.forEach(function (r) { if (live.indexOf(r) < 0) dropUnitSwap(r.id); });
      return live.map(function (r) {
        /* What is out of the pile for it: its need, or everything its melt
         * was paid with while that is held, which is more when the melt was
         * paid over its need with the rest to come back as change. So the
         * pile and the pill always add up to what there was. */
        var out = Math.max(Number(r.total) || 0, (r.meltQuote && typeof held[r.meltQuote] === 'number') ? held[r.meltQuote] : 0);
        return { id: r.id, at: Number(r.at) || 0, from: { unit: recordUnit({ unit: r.from }), amount: out },
                 to: { unit: recordUnit({ unit: r.to }), amount: Number(r.get) || 0 } };
      });
    },

    /* A swap in one call, quoted and run at once: for the suites. The screens
     * show the quote first and run it on SWAP. */
    swapUnits: function (from, to, amount, opts, onStage) {
      return FoxyWallet.swapQuote(from, to, amount, opts).then(function (q) { return FoxyWallet.swapRun(q, onStage); });
    },

    /* ---- money paid in the other unit, swapped into the one held --------
     *
     * The records are in 08c-units.js (foxy.cashu.convert): sats paid to a
     * dollars wallet, swapped into dollars, and dollars paid to a bitcoin
     * wallet, swapped into sats. Each record says which (`convertUnits`), and
     * every figure below is in the record's FROM unit unless it says. This is
     * the one step that moves money for them: the oldest payment in the pile
     * and not yet swapped, swapped by the ordinary swap (`swapQuote`,
     * `swapRun`), with its two ordinary rows. The payment's own row is never
     * touched but for the words it shows (`convert`, `convertSwap`,
     * `convertUsd` or `convertSats`, `convertWhy`).
     *
     * Nobody is waiting on it, so it is careful rather than quick. It does
     * nothing (resolves null, writes nothing) without a route and the mint's
     * own keys, while a late claim walk is out or has the phone at another
     * mint, while a small-change top-up is under way, and while any other
     * swap between the units is still with the mint: two would not stack.
     *
     * At most the sats that arrived, less what the swap itself costs, and
     * never any of the share of the pile that was not this payment's when
     * its claim landed: a payment made since came out of the same pile, and
     * the person's other sats are not this payment's to swap. Nothing without
     * a current price to judge the rate by. A rate more than 2% from the
     * market is not run; a fee over a tenth leaves the sats as bitcoin.
     * Three tries in all, one each launch.
     *
     * `onStage('start', rec, quote)` as the swap starts. Resolves null when it
     * did nothing, else { id, state, outcome, why, from, to, rec }: `state` the
     * record's, and `outcome` what the person might be told: 'done', 'pending'
     * (with the mint; the sweeps finish it), 'failed' (not swapped this time;
     * the sats stay bitcoin), 'kept' (left as bitcoin on purpose) or
     * 'offline' (the route went before anything was asked). Never rejects. */
    convertOne: function (onStage) {
      var stage = typeof onStage === 'function' ? onStage : function () {};
      if (converting) return converting;
      if (!wallet || !routeOpen() || FoxyWallet.fromCache()) return Promise.resolve(null);
      if (claimingLate || claimAway || FoxyWallet._tidying) return Promise.resolve(null);
      var at = mintOf(wallet);
      var here = canonicalMint(at);
      try { convertSettle(); } catch (eSettle) {
        console.warn('[foxy] sats paid to a dollars wallet: could not put the records right, so none is swapped now:',
                     (eSettle && eSettle.message) || eSettle);
        return Promise.resolve(null);
      }
      if (FoxyWallet.unitSwapsPending().length) return Promise.resolve(null);
      if (!FoxyWallet.twoUnits(here)) return Promise.resolve(null);
      var rec = converts().filter(function (r) {
        return r.state === 'claimed' && canonicalMint(String(r.mint || '')) === here && !convertTried[r.id];
      }).sort(function (a, b) { return (Number(a.at) || 0) - (Number(b.at) || 0); })[0];
      if (!rec) return Promise.resolve(null);
      var u = convertUnits(rec);
      // the words of the log, by the record's units: "sats paid to a dollars wallet", or "dollars paid to a bitcoin wallet"
      var what = (u.from === 'sat' ? 'sats' : balanceWord(u.from)) + ' paid to a ' + balanceWord(u.to) + ' wallet';
      var amount = 0;
      var answer = function (outcome, q) {
        return { id: rec.id, state: rec.state, outcome: outcome, why: rec.why || '',
                 from: { unit: u.from, amount: q ? q.total : amount },
                 to: { unit: u.to, amount: q ? q.get : 0 }, rec: Object.assign({}, rec, { from: u.from, to: u.to }) };
      };
      // the end of a record's life, or of this try, written down and said on its row
      var mark = function (state, why, row) {
        rec.state = state;
        rec.why = why || '';
        try { putConvert(rec); } catch (e) {
          console.warn('[foxy] ' + what + ': the record could not be written:', (e && e.message) || e);
        }
        if (row) amendTx(rec.hash, row);
      };
      // not swapped this time: tried again next launch, or not at all after the third
      var notNow = function (why) {
        var last = (Number(rec.tries) || 0) >= CONVERT_TRIES;
        rec.swap = '';
        mark(last ? 'failed' : 'claimed', why, { convert: 'failed' });
        console.warn('[foxy] ' + what + ' were not swapped (' + why + ')'
          + (last ? '; that was the last try, they stay ' + balanceWord(u.from) : '; tried again next launch'));
        return answer('failed');
      };
      if (holdUnit(FoxyWallet.walletChoice().hold) !== u.to) {
        mark('kept', 'hold', { convert: 'kept', convertWhy: 'hold' });
        console.log('[foxy] ' + what + ' are kept as ' + balanceWord(u.from) + ': the wallet holds ' + (FoxyWallet.walletChoice().hold || 'nothing chosen') + ' now');
        return Promise.resolve(answer('kept'));
      }
      /* No yardstick, no swap. The mint's rate is judged against this
       * phone's own last price, and one more than an hour old is not the
       * market: judged by it, a fair rate could cost a try and a poor one
       * could pass. Nothing is tried or written; the app asks for a price
       * and comes back (`convertOnReturn`). */
      var market = FoxyWallet.lastPrice();
      if (!market.rate || FoxyWallet.priceTooOld(market.at) || market.ageMs > CONVERT_PRICE_MS) {
        console.log('[foxy] ' + what + ': waiting for a current bitcoin price before swapping');
        return Promise.resolve(null);
      }
      /* What may be swapped: this payment's sats and none of the person's
       * own. At most what landed (and never more than it was kept as), and
       * of the pile now only what is over the share that was not this
       * payment's when its claim landed (`pileAt` less `got`). A payment
       * made since came out of the same pile, and is taken to have come out
       * of this one first, so the person's own sats are never touched. A
       * record that does not say what the pile was is not swapped at all. */
      var pileNow = sumProofs(proofs(at, u.from));
      var got = Math.max(0, Math.round(Number(rec.got) || 0));
      if (Number(rec.sats) > 0) got = Math.min(got, Math.round(Number(rec.sats)));
      var known = typeof rec.pileAt === 'number' && isFinite(rec.pileAt) && rec.pileAt >= 0;
      var notThis = known ? Math.max(0, Math.round(rec.pileAt) - got) : pileNow;
      var cap = Math.min(got, pileNow - notThis);
      if (!(cap > 0)) {
        mark('kept', 'spent', { convert: 'kept', convertWhy: 'spent' });
        console.log('[foxy] ' + what + ' were spent before they could be swapped; nothing is swapped');
        return Promise.resolve(answer('kept'));
      }
      /* And the swap's own costs come out of that too, not out of the rest:
       * the mint's fee on the split that cuts the pieces and on the pieces
       * the melt spends (`meltNeed`, the very sum `pay` refuses on). The
       * quote is asked for less by that much, and what it comes back at is
       * checked against the same sum, once more a little lower if it is
       * over. */
      // the fees of the FROM unit's own keyset: the sat wallet's for sats, the dollar wallet's (or its stand-in) for dollars
      var feeW = u.from === 'sat' ? wallet : (unitWalletNow(u.from) || feeWalletFor(u.from, wallet));
      var costOf = function (owed) {
        try { return meltNeed(feeW, proofs(at, u.from), owed); } catch (e) { return null; }
      };
      var within = function (q) {
        var n = costOf(Number(q.total) || 0);
        return n && n.ok && n.need <= cap ? n : null;
      };
      var tooLittle = function () { return new Error('That is too little to swap after the mint’s fee.'); };
      var first = costOf(cap);
      amount = cap - Math.max(0, Math.round(Number(first && first.fee) || 0));
      if (!(amount > 0)) {
        mark('kept', 'small', { convert: 'kept', convertWhy: 'small' });
        return Promise.resolve(answer('kept'));
      }
      convertTried[rec.id] = true;
      rec.state = 'quoting';
      rec.tries = (Number(rec.tries) || 0) + 1;
      rec.triedAt = Date.now();
      try { putConvert(rec); } catch (eMark) {
        console.warn('[foxy] ' + what + ': the try could not be written down, so none is made:',
                     (eMark && eMark.message) || eMark);
        return Promise.resolve(null);
      }
      console.log('[foxy] ' + what + ': swapping ' + moneyWords(amount, u.from) + ' into ' + balanceWord(u.to) + ' (try '
        + rec.tries + ' of ' + CONVERT_TRIES + ')');
      var quoted = FoxyWallet.swapQuote(u.from, u.to, amount).then(function (q) {
        var n = within(q);
        if (n) return { q: q, need: n };
        var over = Math.max(1, Math.round(((costOf(Number(q.total) || 0) || {}).need || Number(q.total) || 0) - cap));
        var less = amount - over;
        if (!(less > 0)) throw tooLittle();
        return FoxyWallet.swapQuote(u.from, u.to, less).then(function (q2) {
          var n2 = within(q2);
          if (!n2) throw tooLittle();
          return { q: q2, need: n2 };
        });
      });
      var run = quoted.then(function (held) {
        var q = held.q;
        /* A fee over a tenth of what goes is a payment too small for this
         * mint's fees, and stays bitcoin: that does not change by asking
         * again. A rate more than 2% from the market is the mint's of the
         * moment, and is asked again next launch. A swap nobody is watching
         * is not run at a rate or a fee a person would turn down. */
        if (Number(held.need.need) - satsOf(q.amount) > 0.1 * Number(held.need.need)) {
          mark('kept', 'small', { convert: 'kept', convertWhy: 'small' });
          console.log('[foxy] ' + what + ': the mint’s fee is over a tenth of them; kept as ' + balanceWord(u.from));
          return answer('kept');
        }
        if (q.spreadWarn) return notNow('rate');
        rec.state = 'swapping';
        rec.swap = q.id;
        try { putConvert(rec); } catch (eRun) {
          // not run: with no record of it, a swap cut off here could not be told from one never made
          rec.state = 'claimed';
          rec.swap = '';
          console.warn('[foxy] ' + what + ': the swap could not be written down, so it is not run');
          return answer('failed');
        }
        amendTx(rec.hash, { convert: 'swapping', convertSwap: q.id });
        try { stage('start', Object.assign({}, rec, { from: u.from, to: u.to }), q); } catch (eStage) {}
        return FoxyWallet.swapRun(q).then(function (r) {
          if (r && r.state === 'done') {
            rec.gotTo = Math.round(Number(q.get) || 0);
            if (u.to === 'usd') rec.gotUsd = rec.gotTo;
            mark('done', '', u.to === 'usd' ? { convert: 'done', convertUsd: rec.gotTo } : { convert: 'done', convertSats: rec.gotTo });
            try { convertSpent(rec); } catch (eSpent) {}
            console.log('[foxy] ' + what + ' are swapped: ' + moneyWords(rec.gotTo, u.to));
            return answer('done', q);
          }
          if (r && r.state === 'pending') {
            console.log('[foxy] ' + what + ': the swap is with the mint; the sweeps finish it');
            return answer('pending', q);
          }
          return notNow('mint');
        }, function (e) {
          // swapRun throws only when nothing left the phone (16b, `swapRun`)
          console.warn('[foxy] ' + what + ': the swap did not start:', (e && e.message) || e);
          return notNow('mint');
        });
      }, function (e) {
        var msg = String((e && e.message) || '');
        if (e && e.offline) {
          // no route by the time it asked: not a try, and not this launch's one try either
          rec.tries = Math.max(0, (Number(rec.tries) || 1) - 1);
          delete convertTried[rec.id];
          mark('claimed', rec.why);
          return answer('offline');
        }
        if (/too little/i.test(msg)) {
          mark('kept', 'small', { convert: 'kept', convertWhy: 'small' });
          console.log('[foxy] ' + what + ' are too little to swap after the mint’s fee; kept as ' + balanceWord(u.from));
          return answer('kept');
        }
        return notNow('quote');
      }).then(null, function (e) {
        console.warn('[foxy] ' + what + ': the swap stopped:', (e && e.message) || e);
        return null;
      });
      var free = function (r) { converting = null; return r; };
      converting = run.then(free, free);
      return converting;
    },

    /* Whether a payment of `p` ({ unit, mint, purpose, terms }) would be swapped into the unit held (08c-units.js,
     * `convertDue`): for the suites, which hold it to the same answers for sats as it always gave. */
    _convertDue: function (p) { return convertDue(p); },

    /* Whether the swap into dollars waits on a bitcoin price: none, or one
     * older than `convertOne` judges a rate by. The app asks for one then. */
    convertWantsPrice: function () {
      var p = FoxyWallet.lastPrice();
      return !p.rate || FoxyWallet.priceTooOld(p.at) || p.ageMs > CONVERT_PRICE_MS;
    },

    /* The payments still to be swapped into dollars (owed, in the pile, or
     * being swapped), oldest first, as copies: each record (08c-units.js)
     * with `tried` true once this launch has had its one go at it. */
    convertsOwed: function () {
      return converts().filter(function (r) {
        return ['owed', 'claimed', 'quoting', 'swapping'].indexOf(r.state) >= 0;
      }).sort(function (a, b) { return (Number(a.at) || 0) - (Number(b.at) || 0); })
        // with its units said, an old record's too (sats into dollars)
        .map(function (r) { var u = convertUnits(r); return Object.assign({}, r, { tried: !!convertTried[r.id], from: u.from, to: u.to }); });
    },

