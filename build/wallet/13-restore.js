    /* ---- looking for balances under a seed ----------------------------- */

    /* Ask a list of mints what they have signed for this seed.
     *
     * Reads only. Nothing is written to storage and no connection changes, so
     * this is safe to run on a device that already holds money. Use adoptScan
     * to keep what it finds.
     *
     * Two things it cannot do. It only looks where it is told — there is no
     * discovery, so a mint you used that is not on the list stays invisible.
     * And it only finds proofs whose secrets came from this seed; anything
     * received as a token and never swapped is not derivable from the words.
     */
    scanSeed: function (phrase, urls, onEach) {
      assertRoute();
      /* No words reach the page and none are turned into a seed here. A scan is
       * of this wallet's own seed (no words given) or of words typed on the
       * phone ({ candidate }), and the phone sends the secrets for each batch
       * (restoreFrom). Words passed in are refused. */
      var target;
      try { target = nativeScanTarget(phrase); } catch (e) { return Promise.reject(e); }
      if (!bridged()) {
        return Promise.reject(new Error('Foxy keeps this wallet’s seed on the phone, and this page is not running in the app, so it cannot look for balances.'));
      }
      if (!window.CashuTS) {
        return Promise.reject(new Error('cashu-ts.js did not load.'));
      }
      var list = (urls && urls.length) ? urls.slice() : [FoxyWallet.defaultMint];
      var seed = placeholderSeed();
      var out = [];
      /* The phone's refusals that asking again never changes: a range outside
       * its window, a candidate it no longer holds (restoreFrom has already
       * tried this wallet's own seed where the words are it), a keyset id it
       * does not derive for, and a request it calls malformed. */
      var NO_RETRY = /outside the restore window|unknown candidate|derives secrets only for 00 and 01 keysets|bad request/;
      /* A candidate is kept on the phone for as long as a scan asks with it:
       * forgetSeedCandidate waits for this scan to end (review M6). */
      var release = target.candidate ? holdCandidate(target.candidate) : function () {};

      function say(r) { if (typeof onEach === 'function') { try { onEach(r); } catch (e) {} } }

      function step(i) {
        if (i >= list.length) return out;
        var url = String(list[i]).trim().replace(/\/+$/, '');
        var host = hostOf(url);
        say({ url: url, host: host, state: 'looking' });

        var scanOpts = {
          bip39seed: seed,
          secretsPolicy: 'deterministic',
          counterInit: {},
          counterSource: undefined,
        };
        if (target.candidate) scanOpts.foxyCandidate = target.candidate;
        var w = newWallet(url, scanOpts);

        /* This wallet's own seed on the phone is restored only up to 1000
         * counters past the phone's next one. The walk stops there (walkKeyset),
         * so the phone's counters are read first, per mint, as they are now. */
        var limits = null;
        var ready = target.own
          ? nativeSnapshot().then(function (c) { limits = c; return withTimeout(w.loadMint(), 25000, host); })
          : withTimeout(w.loadMint(), 25000, host);

        return ready
          .then(function () {
            // EVERY keyset, not just the active one. restore takes a keysetId
            // and defaults to the current one,
            // so a mint that has rotated its keys hides everything minted
            // under the old ones — which is most of a wallet's history.
            var ids = [];
            try {
              ids = w._keyChain.getKeysets().map(function (k) { return k.id; });
            } catch (e) {}
            if (!ids.length && w.keysetId) ids = [w.keysetId];
            console.log('[foxy]', host, 'has', ids.length, 'keysets:', ids.join(' '));

            /* And every other unit the mint offers, from its keyset list
             * (/v1/keysets, already loaded). The wallet above sees only sat
             * keysets; a usd balance another wallet made with the same words
             * sits under the usd ones. Blind-auth keysets are not money and
             * are not walked. */
            var unitIds = {};
            try {
              var listed = w.keyChain && w.keyChain.keysets;
              (Array.isArray(listed) ? listed : Object.values(listed || {})).forEach(function (k) {
                var u = k && unitOf(k.unit);
                if (!u || u === 'sat' || u === 'auth' || !k.id) return;
                (unitIds[u] = unitIds[u] || []).push(k.id);
              });
            } catch (e) {}
            Object.keys(unitIds).forEach(function (u) {
              console.log('[foxy]', host, 'also has', unitIds[u].length, u, 'keysets:', unitIds[u].join(' '));
            });

            var all = [], marks = {}, seen = {}, failures = 0, failedIds = [];

            function take(found, label) {
              var got = (found && found.proofs) || [];
              var added = 0;
              got.forEach(function (p) {
                var key = String(p.secret || '') + '|' + String(p.C || '');
                if (seen[key]) return;
                seen[key] = 1; all.push(p); added++;
              });
              if (added) console.log('[foxy]', host, label, '->', added, 'proofs');
              return found;
            }

            /* One walk per keyset. The active keyset used to be walked twice —
             * once with no keyset named, then again in this loop — which
             * doubled a restore's time over Tor for nothing. A keyset that
             * does not answer now marks the whole row partial instead of
             * vanishing from it. */
            /* One keyset, walked in batches of 100.
             *
             * Each batch has its own deadline and three tries. Over Tor one
             * slow answer used to cost the whole keyset, which got a single
             * limit for everything. Three empty batches in a row end the walk,
             * as NUT-13 says. A batch that fails all three tries ends it too
             * and marks the keyset failed, but what was found before it stays.
             */
            function walkKeyset(id, by) {
              var ww = by || w;
              /* A keyset id from before NUT-02's versioned ids (base64). cashu-ts
               * could derive its secrets; the phone derives only 00 and 01
               * keysets, so since the seed moved to the phone nothing restores
               * it. Marked partial at once, and named, rather than asked three
               * times over Tor for a refusal that never changes (review L11). */
              if (!NATIVE_KEYSET.test(String(id).toLowerCase())) {
                return Promise.resolve({ proofs: [], last: null, failed: true,
                  why: 'keyset ' + id + ' is a legacy (base64) keyset, and the phone derives secrets only for 00 and 01 keysets, so it cannot be restored' });
              }
              /* Never more than the mint will take in one array. 100 is the
               * batch NUT-13 suggests and what Foxy has always walked; a mint
               * advertising a smaller max_array_length (NUT-06) would refuse
               * the batch, and a refused batch ends the walk — which for a
               * restore means ecash that is there and not found. */
              var size = Math.min(FoxyWallet.RESTORE_BATCH || 100, mintArrayCap(ww));
              var start = 0, empty = 0, last = null, found = [];
              /* The phone's window for this wallet's own seed; none otherwise.
               * A batch that would reach past it is cut to end there. */
              var limit = limits ? (Number(limits[String(id).toLowerCase()]) || 0) + NATIVE_RESTORE_WINDOW : Infinity;
              var step = size;
              function wait(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
              function batch(tries) {
                return withTimeout(restoreFrom(ww, start, step, id),
                                   FoxyWallet.RESTORE_BATCH_MS || 45000,
                                   host + ' restore ' + id + ' from ' + start)
                  .catch(function (e) {
                    // the phone's refusals of a range are its answer, and asking again changes nothing
                    if (tries >= 2 || NO_RETRY.test(String(e && e.message))) throw e;
                    console.warn('[foxy]', host, 'restore batch from', start, 'failed, trying again:',
                                 (e && e.message) || e);
                    return wait((tries + 1) * (FoxyWallet.RESTORE_RETRY_MS || 2000))
                      .then(function () { return batch(tries + 1); });
                  });
              }
              function more() {
                step = Math.min(size, limit - start);
                return batch(0).then(function (r) {
                  var got = (r && r.proofs) || [];
                  if (got.length) { found = found.concat(got); empty = 0; } else { empty++; }
                  if (r && r.lastCounterWithSignature != null) last = r.lastCounterWithSignature;
                  start += step;
                  // the gap NUT-13 scans across: ten empty batches of 100, the phone's window (RESTORE_GAP)
                  if (empty * size >= RESTORE_GAP) return { proofs: found, last: last, failed: false };
                  /* At the end of the phone's window without ten empty
                   * batches: the mint signed on counters the phone's next one
                   * is behind, and there may be more past it. Kept, and marked
                   * partial; adopting this moves the counter, and a scan after
                   * that looks further. */
                  if (start >= limit) {
                    return { proofs: found, last: last, failed: true,
                             why: 'the phone restores this seed only to ' + NATIVE_RESTORE_WINDOW
                               + ' counters past its next one, ' + (limit - NATIVE_RESTORE_WINDOW) };
                  }
                  return more();
                }, function (e) {
                  return { proofs: found, last: last, failed: true, why: (e && e.message) || String(e) };
                });
              }
              return more();
            }

            function nextKeyset(k) {
              if (k >= ids.length) {
                console.log('[foxy]', host, 'walked', ids.length, 'keysets,',
                            failures, 'did not finish,', all.length, 'proofs total');
                return { proofs: all, counters: marks, failed: failedIds };
              }
              var id = ids[k];
              return walkKeyset(id).then(function (res) {
                take({ proofs: res.proofs }, 'keyset ' + id);
                if (res.last != null) marks[id] = res.last + 1;
                if (res.failed) {
                  failures++;
                  failedIds.push(id);
                  console.warn('[foxy]', host, 'keyset', id, 'restore did not finish:', res.why);
                }
                return nextKeyset(k + 1);
              });
            }

            /* Then each other unit, with a wallet of that unit: cashu-ts will
             * only restore a keyset in its wallet's unit. Counters go into the
             * same record, keyed by keyset id, which is unique across units.
             * A unit whose keysets do not answer marks the row partial, as a
             * sat keyset does. Nothing here touches the sat proofs. */
            function walkUnits(found) {
              found.units = {};
              return Object.keys(unitIds).sort().reduce(function (chain, u) {
                return chain.then(function () {
                  var got = [], failedU = [];
                  found.units[u] = { proofs: got, failed: failedU };
                  return unitWallet(w, u, scanOpts).then(function (uw) {
                    return unitIds[u].reduce(function (c2, id) {
                      return c2.then(function () {
                        return walkKeyset(id, uw).then(function (res) {
                          (res.proofs || []).forEach(function (p) {
                            var key = String(p.secret || '') + '|' + String(p.C || '');
                            if (seen[key]) return;
                            seen[key] = 1; got.push(p);
                          });
                          if (res.last != null) marks[id] = res.last + 1;
                          if (res.failed) {
                            failures++;
                            failedU.push(id);
                            failedIds.push(id);
                            console.warn('[foxy]', host, u, 'keyset', id, 'restore did not finish:', res.why);
                          }
                        });
                      });
                    }, Promise.resolve());
                  }, function (e) {
                    unitIds[u].forEach(function (id) { failedU.push(id); failedIds.push(id); });
                    console.warn('[foxy]', host, 'could not walk', u, 'keysets:', (e && e.message) || e);
                  }).then(function () {
                    if (got.length) console.log('[foxy]', host, u, '->', got.length, 'proofs');
                  });
                });
              }, Promise.resolve()).then(function () { return found; });
            }
            return Promise.resolve(nextKeyset(0)).then(walkUnits);
          })
          .then(function (found) {
            var got = found.proofs || [];
            var names = Object.keys(found.units || {});
            // one state check for every unit: a state is asked by secret, whatever the unit
            var asked = got.slice(), spans = {};
            names.forEach(function (u) {
              spans[u] = asked.length;
              asked = asked.concat(found.units[u].proofs);
            });
            function units(states) {
              var out = {};
              names.forEach(function (u) {
                var list = found.units[u].proofs;
                out[u] = { proofs: states ? list.filter(function (p, k) {
                  var s = states[spans[u] + k];
                  return (s && (s.state || s.State)) === 'UNSPENT';
                }) : [], failed: found.units[u].failed };
              });
              return out;
            }
            // no proofs left is not no counters: spent proofs used them too
            if (!asked.length) return { proofs: [], counters: found.counters, failed: found.failed, units: units(null) };
            return withTimeout(w.checkProofsStates(asked), 45000, host + ' state check')
              .then(function (states) {
                /* UNSPENT only. A PENDING proof is held by a payment still
                 * routing: it was kept here, and a scan filed it as balance. */
                var live = got.filter(function (p, k) {
                  var st = states[k] && (states[k].state || states[k].State);
                  return st === 'UNSPENT';
                });
                return { proofs: live, counters: found.counters, failed: found.failed, units: units(states) };
              });
          })
          .then(function (r) {
            var row = {
              url: url, host: host, state: 'done',
              sats: sumProofs(r.proofs), count: r.proofs.length,
              proofs: r.proofs, counters: r.counters,
              // a keyset that did not answer: what is here may not be all there is
              partial: !!(r.failed && r.failed.length), missing: r.failed || [],
              /* Other units, each in its own: { usd: { amount, count, proofs,
               * partial, missing } }. `sats` above never includes them. */
              units: {},
              /* Secrets of the proofs here whose DLEQ does not verify against
               * the keys this mint published (NUT-12), for adoptScan to report
               * as it stores them. A keyset without loaded keys is not named. */
              dleqInvalid: [],
            };
            dleqAudit(w, r.proofs, row.dleqInvalid);
            Object.keys(r.units || {}).forEach(function (u) {
              var ur = r.units[u];
              dleqAudit(w, ur.proofs, row.dleqInvalid);
              row.units[u] = { amount: sumProofs(ur.proofs), count: ur.proofs.length, proofs: ur.proofs,
                               partial: !!ur.failed.length, missing: ur.failed.slice() };
              if (ur.proofs.length) {
                console.log('[foxy] scan', host, '->', formatAmount(row.units[u].amount, u), 'in', ur.proofs.length, u, 'proofs');
              }
            });
            console.log('[foxy] scan', host, '->', row.sats, 'sats in', row.count, 'proofs');
            out.push(row); say(row);
            return step(i + 1);
          })
          .catch(function (e) {
            var row = { url: url, host: host, state: 'failed',
                        sats: 0, count: 0, why: (e && e.message) || String(e) };
            console.warn('[foxy] scan', host, 'failed:', row.why);
            out.push(row); say(row);
            return step(i + 1);
          });
      }

      return Promise.resolve().then(function () { return step(0); }).then(function (r) { release(); return r; }, function (e) { release(); throw e; });
    },

    /* Keep what a scan found.
     *
     * Writes each mint's proofs under that mint's own key and sets only the
     * counters for the keysets it actually rebuilt — a blanket counter reset
     * would leave every OTHER mint free to re-derive secrets it has already
     * used. Refuses to overwrite a pile that already has something in it
     * unless told to.
     */
    adoptScan: function (rows, opts) {
      var o = opts || {};
      var kept = [], skipped = [];
      /* There are no words here. Words typed on the phone come as their
       * candidate, which goes to the phone first (seedAdopt): it asks for the
       * replace and sets the old seed's counters aside — as cashu.me does,
       * rather than carrying them into the new seed, where a counter of 900 put
       * the new seed's first proofs past the gap any restore looks across — and
       * only then does anything here change. A No on the phone's Replace alert
       * rejects with nothing changed (audit W3). A candidate the
       * phone calls "same" is this wallet's own seed, adopted as a scan with no
       * words is. Every write after that is the phone's counters, then the
       * piles, in a promise. */
      var newSeed = false;
      if (o.words) return Promise.reject(new Error(WORDS_STAY + ' Enter the words on the phone to restore them.'));
      if (o.candidate) {
        return adoptCandidate(String(o.candidate)).then(function (replaced) {
          newSeed = replaced;
          return adopt();
        });
      }
      return Promise.resolve().then(adopt);

      function adopt() {
        // the phone set the old counters aside; what is remembered is which seed this is
        if (newSeed) seedReplaced = 'phone:' + secretEpoch;
        /* The seed this restore put in place, still the seed: every later
         * adoption keeps everything already in a pile, as the one that replaced
         * it did. A mint that answered after the words were adopted was adopted
         * with overwrite and no words — the words were no longer different, so
         * its pile's proofs from the replaced seed read as rebuildable and were
         * dropped, recoverable only with the old words (MONEY.md §6, now fixed).
         * Kept in memory for the session, which is as long as a
         * scan can still be answering, and a rescan of failed mints is covered
         * too. What it may keep by mistake is a spent proof, which the next
         * reconcile removes. */
        /* The seed is named by secretEpoch, which moves whenever the seed
         * changes (an adopt, a wipe). The phone's counters are not read: it
         * keeps the higher of its own and what is sent. */
        var replacedHere = !!seedReplaced && seedReplaced === 'phone:' + secretEpoch;
        var c = {};
        var imported = importedSet();
        var spoken = spokenForSecrets();
        var keptUnits = [], skippedUnits = [];
        function sig(p) { return String(p.secret || '') + '|' + String(p.C || ''); }

        /* The stored-proof DLEQ check, which every other write of a pile runs
         * (checkIssued) and this one skipped (audit W7). scanSeed
         * checks what it found against the keys of the mint that restored it and
         * names the proofs that fail (dleqInvalid); those are reported, as a
         * stored proof's are, and kept. A row with no such list, not made by
         * scanSeed, is checked against the connected wallet when it is that
         * mint's; otherwise, as for any keyset not loaded, it is skipped. */
        function auditRestored(r, list) {
          if (!list.length) return;
          if (Array.isArray(r.dleqInvalid)) {
            var bad = {};
            r.dleqInvalid.forEach(function (s) { bad[s] = 1; });
            var failing = list.filter(function (p) { return bad[p.secret] && !dleqSeen[p.secret]; });
            failing.forEach(function (p) { dleqSeen[p.secret] = 1; });
            if (failing.length) reportInvalidDleq(r.host || hostOf(r.url), failing.length, 'restore');
            return;
          }
          if (wallet && canonicalMint(r.url) === mintOf(wallet)) checkIssued(list, 'restore', wallet);
        }

        /* One pile: the sat pile, or one unit's. The same rules for each.
         * Returns what was written and the part of it that is new, or null when
         * the pile was left alone. */
        function adoptPile(key, found, partial, r) {
          var existing = load(key, []);
          if (existing.length && !o.overwrite && !o.merge) return null;
          /* What an overwrite may drop: only proofs these words can rebuild.
           * A partial scan may be missing some of those, and none of a replaced
           * seed's proofs can come back from new words — so in both cases
           * everything already here stays. Proofs are bearer money; a spent one
           * kept by mistake is removed by the next reconcile. */
          var keepAll = o.merge || newSeed || replacedHere || partial;
          var seen = {}, had = {};
          existing.forEach(function (p) { had[sig(p)] = 1; });
          // never what a payment, the quarantine or a sent token already holds
          var keep = found.filter(function (p) { return p && !spoken[p.secret]; });
          var fresh = keep.filter(function (p) { return !had[sig(p)]; });
          var added = sumProofs(fresh);
          keep.forEach(function (p) { seen[sig(p)] = 1; });
          existing.forEach(function (p) {
            if (seen[sig(p)]) return;
            if (keepAll || !seedDerived(p, imported)) { keep.push(p); seen[sig(p)] = 1; }
          });
          // a pile that does not land throws (W6); the scan can be adopted again
          mustSave(key, keep);
          auditRestored(r, fresh);
          return { list: keep, added: added };
        }

        /* Counters only move forward, and move for every keyset the scan saw
         * signed — even where each of those proofs has since been spent. They
         * were used; setting one lower (it used to be a plain assignment) made
         * the mint refuse the next swap, "outputs have already been signed".
         *
         * Written before any pile, and a write that fails throws with no pile
         * changed. They were written last, with the failure ignored: a pile
         * adopted over counters that never moved handed the next swap outputs
         * the mint had already signed (W6). */
        (rows || []).forEach(function (r) {
          if (r.state !== 'done') return;
          Object.keys(r.counters || {}).forEach(function (id) {
            c[id] = Math.max(Number(c[id]) || 0, Number(r.counters[id]) || 0);
          });
        });
        // the phone's counters move before any pile is written
        return nativeAdvanceAll(c).then(writePiles);

        function writePiles() {
          (rows || []).forEach(function (r) {
            if (r.state !== 'done') return;
            if (r.proofs && r.proofs.length) {
              var keep = adoptPile(K.proofs + '.' + r.url, r.proofs, r.partial, r);
              if (keep) kept.push({ host: r.host, sats: sumProofs(keep.list), added: keep.added, partial: !!r.partial });
              else skipped.push(r.host);
            }
            // each other unit into its own pile, never the sat pile
            Object.keys(r.units || {}).sort().forEach(function (name) {
              var u = unitOf(name);
              var ur = r.units[name];
              if (!u || u === 'sat' || !r.url || !ur || !ur.proofs || !ur.proofs.length) return;
              var part = !!(r.partial || ur.partial);
              var keepU = adoptPile(proofKey(r.url, u), ur.proofs, part, r);
              if (keepU) keptUnits.push({ host: r.host, unit: u, amount: sumProofs(keepU.list), added: keepU.added, partial: part });
              else skippedUnits.push({ host: r.host, unit: u });
            });
          });
          return { kept: kept, skipped: skipped, units: keptUnits, skippedUnits: skippedUnits };
        }
      }
    },

