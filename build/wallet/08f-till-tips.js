  /* ---- tips at the till, and the keeper's list of cashier codes ---------------
   *
   * The keeper says, as its till opens, whether it takes tips and who they go to
   * (26m-till.js, 26p-till-tips.js): itself, one Foxy ID, or a group of up to
   * eight, each with a whole percentage, the percentages adding up to 100. The
   * answer is `tips`:
   *
   *     { on, to: 'self' | 'one' | 'group', ids: [{ id, nostr, name, pct }] }
   *
   * `id` the Foxy ID's key (33 bytes, hex), `nostr` its delivery key (32), as a
   * contact keeps them (08e-cashu-id.js `cidKeep`), so a contact removed later is
   * still paid. Each CASHIER CODE has its own answer, the till's by default, kept
   * on this phone's row of the code; the code itself says only whether its till
   * offers tips (`tips: true`), so nobody's Foxy ID is printed at a counter.
   *
   * A payment with a tip is ONE payment for the total. Once it is in, the tip
   * part is passed on (`tipForward`): to the keeper, nothing more than a word on
   * the sale's row; to one person, a Foxy ID payment of the whole tip; to a
   * group, one payment per share. Each share is the tip times its percentage,
   * rounded down to a whole sat or cent, and what rounding leaves goes to the
   * first share, so the shares add up to the tip exactly. A share smaller than
   * `TIP_MIN` waits, kept for that ID (`K.tillTipCarry`), and goes with the next
   * tip to the same ID at the same mint in the same unit.
   *
   * Each payment to a Foxy ID is a job (`K.tillTipJobs`), made from the
   * keeper's balance at the mint the sale landed at, one at a time, tried again
   * a minute later while it fails, ten failures at most, and at once when the
   * route comes back. With no route, or the phone at another mint than the
   * sale's, it waits and counts no try. A job that gives up, or is still
   * waiting a week on, leaves the
   * money where it is, in the keeper's balance, and its sale's row says so.
   *
   * `tillTips` is the whole of it as one object, for anything else that takes
   * payments and passes tips on: `check`, `split`, `forward`,
   * `jobs`, `run`, `carry`, and the limits. Nothing in it knows which screen
   * asked. */

  var TIP_IDS_MAX = 8;
  // the smallest share sent on its own: a sat or a cent less than this rides with the next tip to that ID
  var TIP_MIN = { sat: 10, usd: 1 };
  var TIP_TRIES_MAX = 10;
  var TIP_RETRY_MS = 60000;
  var TIP_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;
  var TIP_JOBS_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
  var TIP_SALES_MAX = 500;
  /* The history row of a sale this phone took in, by its hash, or null: a row in, of this phone's own money (not
   * a cashier's row, which is the keeper's). A tip is passed on only from a sale that landed here. */
  /* `tillOnly`: a cashier's sale alone (a till row the keeper took from a cashier, `till` and `who: 'cashier'`),
   * for any caller but the keeper's own till (`from: 'till'`), which is held to its till being open. */
  function tipSaleRow(hash, tillOnly) {
    if (!hash) return null;
    var rows = load(K.log, []);
    if (!Array.isArray(rows)) return null;
    for (var i = 0; i < rows.length; i++) {
      var e = rows[i];
      if (e && e.hash === hash && e.dir === 'in' && !e.forKeeper && e.state !== 'failed') {
        /* A cashier's sale, for anybody but the keeper's own till. For that, a row of this phone's own, and only while
         * its till is open (`tillKeeperNow`): its PAID names the sale it has just landed. */
        if (tillOnly ? !(e.till === true && e.who === 'cashier') : !tillKeeperNow()) return null;
        return e;
      }
    }
    return null;
  }

  // whether a code (a pass, or this phone's row of one) offers tips
  function tillTipsOn(p) {
    if (!p) return false;
    if (p.tips === true) return true;
    return !!(p.tips && typeof p.tips === 'object' && p.tips.on);
  }

  function tillLabelClean(label) {
    return String(label || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TILL_LABEL_MAX);
  }

  /* An answer to ACCEPT TIPS? made whole, or a throw that says what is wrong with it in words a
   * screen can show. Off is { on: false, to: 'self', ids: [] }. */
  function tipsCheck(t) {
    var off = { on: false, to: 'self', ids: [] };
    if (!t || typeof t !== 'object' || !t.on) return off;
    var to = t.to === 'self' || t.to === 'one' || t.to === 'group' ? t.to : '';
    if (!to) throw new Error('Tips go to you, to one person, or to a group.');
    if (to === 'self') return { on: true, to: 'self', ids: [] };
    var raw = Array.isArray(t.ids) ? t.ids : [];
    if (!raw.length) throw new Error(to === 'one' ? 'Pick who the tips go to.' : 'Add someone to the group first.');
    if (to === 'one' && raw.length !== 1) throw new Error('One person takes the tips.');
    if (raw.length > TIP_IDS_MAX) throw new Error('A group is ' + TIP_IDS_MAX + ' Foxy IDs at most.');
    var seen = Object.create(null);
    var ids = raw.map(function (r) {
      var id = String((r && r.id) || '').toLowerCase();
      if (!CID_HEX33.test(id)) throw new Error('That is not a Foxy ID.');
      var nostr = String((r && r.nostr) || '').toLowerCase();
      if (!CID_HEX32.test(nostr)) {
        var c = cidContactOf(id);
        nostr = c ? String(c.cid.nostr || '').toLowerCase() : '';
      }
      if (!CID_HEX32.test(nostr)) throw new Error('That Foxy ID is not one of your contacts. Add it first.');
      var name = cidCleanName(r && r.name);
      if (!name) throw new Error('Name every Foxy ID that takes tips.');
      if (seen[id]) throw new Error((to === 'group' ? 'The same Foxy ID is in the group twice' : 'That Foxy ID is there twice') + ' (' + name + ').');
      seen[id] = true;
      var pct = to === 'one' ? 100 : Number(r && r.pct);
      if (!(Math.floor(pct) === pct && pct >= 1 && pct <= 100)) throw new Error('Each share is a whole percentage from 1 to 100 (' + name + ').');
      return { id: id, nostr: nostr, name: name, pct: pct };
    });
    var sum = ids.reduce(function (n, r) { return n + r.pct; }, 0);
    if (sum !== 100) throw new Error('The shares have to add up to 100%. They add up to ' + sum + '%.');
    return { on: true, to: to, ids: ids };
  }

  /* The shares of a tip of `amount` (whole sats or cents): each the tip times its percentage,
   * rounded down, and what rounding leaves to the first, so they add up to `amount` exactly.
   * [{ id, nostr, name, pct, amount }], in the group's order. [] for no tip or tips to the keeper. */
  function tipSplit(tips, amount) {
    var t;
    try { t = tipsCheck(tips); } catch (e) { return []; }
    var n = Math.floor(Number(amount) || 0);
    if (!t.on || t.to === 'self' || !(n > 0)) return [];
    var shares = t.ids.map(function (r) { return { id: r.id, nostr: r.nostr, name: r.name, pct: r.pct, amount: Math.floor(n * r.pct / 100) }; });
    var left = n - shares.reduce(function (s, r) { return s + r.amount; }, 0);
    shares[0].amount += left;
    return shares;
  }

  /* ---- the keeper's own answer, for the till while it is open ---- */

  function tillTipsNow() {
    var t = load(K.tillTips, null);
    try { return tipsCheck(t); } catch (e) { return tipsCheck(null); }
  }

  function tillTipsSet(t) {
    var clean = tipsCheck(t);
    mustSave(K.tillTips, clean);
    console.log('[foxy] till: tips ' + (!clean.on ? 'off' : clean.to === 'self' ? 'on, kept by this phone'
      : clean.to === 'one' ? 'on, to one Foxy ID' : 'on, split among ' + clean.ids.length + ' Foxy IDs'));
    return clean;
  }

  /* ---- the jobs ---- */

  function tipJobRows() {
    var l = load(K.tillTipJobs, []);
    return Array.isArray(l) ? l.filter(function (r) { return r && typeof r === 'object' && typeof r.id === 'string' && CID_HEX33.test(String(r.cid || '')); }) : [];
  }

  function tipJobAmend(id, fields) {
    var rows = tipJobRows();
    var hit = null;
    rows.forEach(function (r) { if (r.id === id) { Object.assign(r, fields); hit = r; } });
    if (hit) save(K.tillTipJobs, rows);
    return hit;
  }

  // done rows (sent or given up) go a week after, so the list does not grow with every tip
  function tipJobsTidy(rows) {
    var now = Date.now();
    return rows.filter(function (r) { return r.state === 'due' || !(Number(r.doneAt) > 0) || Number(r.doneAt) + TIP_JOBS_KEEP_MS > now; });
  }

  function tipCarryKey(id, unit, mint) { return id + '|' + unit + '|' + canonicalMint(String(mint || '')); }

  function tipCarryRows() {
    var c = load(K.tillTipCarry, {});
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  }

  function tipChanged() {
    if (typeof FoxyWallet._onHistoryChanged === 'function') {
      try { FoxyWallet._onHistoryChanged(); } catch (x) {}
    }
  }

  function tipSaid(n, unit) { return unit === 'usd' ? '$' + (n / 100).toFixed(2) : n + (n === 1 ? ' sat' : ' sats'); }

  /* A sale's tip, passed on. `o`: { tips, amount, unit, mint, hash, from }: `amount` the tip in whole
   * sats or cents of `unit`, landed at `mint`, its sale's history row `hash` where there is one. The
   * row is marked (`tillTip`); tips to the keeper end there. Otherwise one job per share big enough to
   * send, the rest kept for the next tip. A sale already passed on (by its `hash`) is not passed on
   * twice. Answers { kept, jobs, waiting, seen }. */
  function tipForward(o) {
    var unit = unitOf(o && o.unit) || 'sat';
    var amount = Math.floor(Number(o && o.amount) || 0);
    var hash = String((o && o.hash) || '');
    var mint = canonicalMint(String((o && o.mint) || mintUrl || ''));
    var out = { kept: 0, jobs: 0, waiting: 0, seen: false };
    if (!(amount > 0) || !mint) return out;
    /* Only for a sale this phone took in: its row is in the history, in, and its own. A tip named for a sale
     * nothing received would be paid out of the keeper's balance for nothing. Never more than the sale. */
    var saleRow = tipSaleRow(hash, !(o && o.from === 'till'));
    if (!saleRow) {
      console.warn('[foxy] till: a tip for a sale this phone has no record of taking in; nothing passed on');
      out.refused = true;
      return out;
    }
    var landed = unitOf(saleRow.unit) && unitOf(saleRow.unit) !== 'sat' ? satsOf(saleRow.amount) : satsOf(saleRow.sats != null ? saleRow.sats : saleRow.amount);
    if ((unitOf(saleRow.unit) || 'sat') !== unit) {
      console.warn('[foxy] till: a tip in another unit than its sale; nothing passed on');
      out.refused = true;
      return out;
    }
    if (landed >= 0 && amount > landed) amount = Math.floor(landed);
    if (!(amount > 0)) return out;
    if (hash) {
      var sales = load(K.tillTipSales, []);
      if (!Array.isArray(sales)) sales = [];
      if (sales.indexOf(hash) >= 0) { out.seen = true; return out; }
      save(K.tillTipSales, sales.concat([hash]).slice(-TIP_SALES_MAX));
      try { amendTx(hash, { tillTip: amount, tillTipUnit: unit }); } catch (x) {}
    }
    var tips;
    try { tips = tipsCheck(o && o.tips); } catch (e) { tips = tipsCheck(null); console.warn('[foxy] till: a tip’s answer could not be read; the tip stays here:', e.message); }
    if (!tips.on || tips.to === 'self') {
      out.kept = amount;
      console.log('[foxy] till: a tip of ' + tipSaid(amount, unit) + ', kept by this phone');
      tipChanged();
      return out;
    }
    var shares = tipSplit(tips, amount);
    var carry = tipCarryRows();
    var rows = tipJobsTidy(tipJobRows());
    var now = Date.now();
    shares.forEach(function (sh, i) {
      var key = tipCarryKey(sh.id, unit, mint);
      var total = sh.amount + (Math.floor(Number(carry[key]) || 0));
      if (!(total > 0)) return;
      if (total < TIP_MIN[unit]) {
        carry[key] = total;
        out.waiting += total;
        return;
      }
      delete carry[key];
      var rnd = hexOf(window.CashuTS.createRandomSecretKey()).slice(0, 8);
      rows.push({ id: 'tip' + now.toString(36) + i + rnd, cid: sh.id, nostr: sh.nostr, name: sh.name, unit: unit, mint: mint,
                  amount: total, sale: hash, from: String((o && o.from) || 'till'), at: now, tries: 0, state: 'due' });
      out.jobs += 1;
    });
    mustSave(K.tillTipJobs, rows);
    save(K.tillTipCarry, carry);
    console.log('[foxy] till: a tip of ' + tipSaid(amount, unit) + ' to pass on: ' + out.jobs + ' payment(s)'
      + (out.waiting ? ', ' + tipSaid(out.waiting, unit) + ' too small to send yet' : ''));
    tipChanged();
    if (out.jobs) tipRunSoon();
    return out;
  }

  /* A cashier's word of how much of a payment was its tip (`tip` on the delivery, 08d-till.js
   * `tillDeliverAll`), and of the sale itself (`base`): passed on as it says, since the keeper's row
   * shows the sale and the tip as two figures (26p-till-tips.js `tillTipRowText`). The word is held to
   * the pieces that came (their sum, before this phone's own swap fee, which the cashier could not know):
   * a tip over them, or a sale and tip that add up to more, passes on no tip at all (the payment is still
   * taken), and so does a sale of nothing. What is passed on is the tip, less any part of it the swap fee
   * took (never more than landed less the sale). A whole number; 0 otherwise. */
  function tillTipOfBody(j, r, unit) {
    var tip = Number(j && j.tip);
    if (!(Math.floor(tip) === tip && tip > 0)) return 0;
    var came = 0;
    if (r && typeof r === 'object') came = unit === 'sat' ? satsOf(r.sats != null ? r.sats : r.amount) : satsOf(r.amount != null ? r.amount : r.sats);
    var sum = Math.floor(Array.isArray(j.proofs) ? sumProofs(j.proofs) : 0) || 0;
    var said = Number(j && j.base);
    var base = (Math.floor(said) === said && said >= 0) ? said : sum - tip;
    if (tip > sum || base > sum - tip) {
      console.warn('[foxy] till: a cashier’s delivery says a tip and sale beyond what arrived; no tip passed on');
      return 0;
    }
    if (!(base > 0)) {
      console.warn('[foxy] till: a cashier’s delivery says the whole of it was a tip; no tip passed on');
      return 0;
    }
    var landed = came > 0 ? Math.floor(came) : sum;
    return Math.max(0, Math.min(tip, landed - base));
  }

  var tipRunning = null;
  var tipTimer = null;

  function tipRetryMs() { return CID_TESTS && Number(FoxyWallet._tillTipRetryMs) > 0 ? Number(FoxyWallet._tillTipRetryMs) : TIP_RETRY_MS; }

  function tipRunSoon() { setTimeout(function () { tipRun().then(null, function () {}); }, 0); }

  // a job given up: the money stays in this phone's balance, and the sale's row says so
  function tipFail(r, why) {
    tipJobAmend(r.id, { state: 'failed', doneAt: Date.now(), why: String(why || '').slice(0, 160) });
    if (r.sale) {
      var sale = (load(K.log, []) || []).filter(function (e) { return e && e.hash === r.sale; })[0] || {};
      var names = Array.isArray(sale.tillTipFailed) ? sale.tillTipFailed.slice() : [];
      if (names.indexOf(r.name) < 0) names.push(r.name);
      try { amendTx(r.sale, { tillTipFailed: names, tillTipLeft: (Math.floor(Number(sale.tillTipLeft) || 0)) + r.amount }); } catch (x) {}
    }
    console.warn('[foxy] till: a tip of ' + tipSaid(r.amount, r.unit) + ' for ' + r.name + ' was not sent and stays here: ' + why);
    tipChanged();
    return null;
  }

  function tipOne(r) {
    if (Date.now() - Number(r.at) > TIP_GIVE_UP_MS) return tipFail(r, 'not sent within a week');
    // waits, counting nothing: no route, or the phone at another mint than the one the sale landed at
    if (!wallet || !routeOpen()) return null;
    if (canonicalMint(mintUrl || '') !== r.mint) return null;
    var pay;
    try {
      pay = FoxyWallet.cashuIdPay(r.cid, r.amount, { unit: r.unit, read: { id: r.cid, nostr: r.nostr }, name: r.name, memo: 'Tip to ' + r.name });
    } catch (e) { pay = Promise.reject(e); }
    return Promise.resolve(pay).then(function (res) {
      tipJobAmend(r.id, { state: 'sent', doneAt: Date.now(), payHash: String((res && res.hash) || ''), relayed: !!(res && res.sent) });
      if (res && res.hash) { try { amendTx(res.hash, { tillTipTo: r.name, tillTipSale: r.sale || '' }); } catch (x) {} }
      console.log('[foxy] till: a tip of ' + tipSaid(r.amount, r.unit) + ' went to ' + r.name);
      tipChanged();
    }, function (e) {
      var why = String((e && e.message) || e);
      // another payment to a contact is being made this moment: the next try, with none counted
      if (/being made/i.test(why)) return null;
      var tries = (Number(r.tries) || 0) + 1;
      // what no number of tries changes: their ID is this phone's own, or not an ID
      if (tries >= TIP_TRIES_MAX || /your own Foxy ID|not a Foxy ID/i.test(why)) return tipFail(r, why);
      tipJobAmend(r.id, { tries: tries, why: why.slice(0, 160) });
      console.warn('[foxy] till: a tip for ' + r.name + ' was not sent yet (' + tries + ' of ' + TIP_TRIES_MAX + '):', why);
      return null;
    });
  }

  /* Every job due, one at a time; shared while it runs. While any is left, again a minute later
   * (one timer, gone with the last job), and at once when the route comes back (`tipOnRoute`). */
  function tipRun() {
    if (tipRunning) return tipRunning;
    var run = Promise.resolve().then(function () {
      var due = tipJobRows().filter(function (r) { return r.state === 'due'; });
      return due.reduce(function (chain, r) { return chain.then(function () { return tipOne(r); }); }, Promise.resolve());
    }).then(function () {
      save(K.tillTipJobs, tipJobsTidy(tipJobRows()));
      tipArm();
      return tipJobRows().filter(function (r) { return r.state === 'sent'; }).length;
    }, function (e) {
      console.warn('[foxy] till: passing tips on failed:', (e && e.message) || e);
      tipArm();
      return 0;
    });
    tipRunning = run;
    var done = function () { if (tipRunning === run) tipRunning = null; };
    run.then(done, done);
    return run;
  }

  function tipArm() {
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    if (!tipJobRows().some(function (r) { return r.state === 'due'; })) return;
    tipTimer = setTimeout(function () { tipTimer = null; tipRun().then(null, function () {}); }, tipRetryMs());
  }

  // after a connect, on the way back from the background, and when the route comes back: what is due goes
  function tipOnRoute() {
    try { if (tipJobRows().some(function (r) { return r.state === 'due'; })) tipRunSoon(); }
    catch (e) { console.warn('[foxy] till: tips on the route’s return:', (e && e.message) || e); }
  }

  /* ---- the keeper's cashier codes, as a list ---- */

  function tillLogRows() {
    var l = load(K.tillPassLog, []);
    return Array.isArray(l) ? l.filter(function (r) { return r && typeof r === 'object' && TILL_ID.test(String(r.id)); }) : [];
  }

  // what a code's tips say on its row: off, to the keeper, or the names
  function tillTipsBrief(t) {
    var c;
    try { c = tipsCheck(t); } catch (e) { c = tipsCheck(null); }
    return { on: c.on, to: c.to, names: c.ids.map(function (r) { return r.name; }), pcts: c.ids.map(function (r) { return r.pct; }) };
  }

  function tillLogAdd(row) {
    var list = tillLogRows().filter(function (r) { return r.id !== row.id; });
    list.push({ id: row.id, label: String(row.label || ''), unit: row.unit, main: tillMainOf(row), mints: tillMintsOf(row),
                tips: tillTipsBrief(row.tips), made: Number(row.made) || Date.now(), exp: Number(row.exp) || 0 });
    save(K.tillPassLog, list.slice(-TILL_LOG_MAX));
  }

  /* END: the code is off the live list for good, and its row says when. Its cashier is not told
   * (nothing reaches a cashier but its code), and may go on taking payments by it until the code
   * runs out; what it sends is this phone's money, locked to it, and is still taken, as for a code
   * that ran out (the week after). So its key and its listening stay. */
  function tillPassEnd(id) {
    var rows = tillPassRows();
    var now = Date.now();
    var hit = null;
    rows.forEach(function (r) { if (r.id === id && !r.endedAt) { r.endedAt = now; hit = r; } });
    var logged = tillLogRows();
    var inLog = logged.filter(function (r) { return r.id === id; })[0];
    if (!hit && !(inLog && !inLog.endedAt && Number(inLog.exp) * 1000 > now)) return false;
    if (hit) mustSave(K.tillPasses, rows);
    if (!inLog && hit) { tillLogAdd(hit); logged = tillLogRows(); }
    logged.forEach(function (r) { if (r.id === id && !r.endedAt) r.endedAt = now; });
    save(K.tillPassLog, logged);
    console.log('[foxy] till: a cashier code was ended');
    return true;
  }

  /* The codes for the list: { live, past }. Live, newest last: those not run out and not ended,
   * each with its text for the QR. Past, newest first: ended or run out, with when it ran and how it
   * ended ('ended' by END, 'expired' by its own time). No figures of what any took: the till keeps
   * no totals. A code from before the list was kept is read from its row. */
  function tillPassList() {
    var now = Date.now();
    var rows = tillPrune();
    var log = tillLogRows();
    rows.forEach(function (r) { if (!log.some(function (l) { return l.id === r.id; })) { tillLogAdd(r); } });
    log = tillLogRows();
    var byId = {};
    rows.forEach(function (r) { byId[r.id] = r; });
    var view = function (l) {
      var r = byId[l.id];
      var ended = Number(l.endedAt) || (r && Number(r.endedAt)) || 0;
      return { id: l.id, label: l.label || '', unit: l.unit, main: l.main, mints: (l.mints || []).slice(), tips: l.tips || tillTipsBrief(null),
               made: Number(l.made) || 0, exp: Number(l.exp) || 0, endedAt: ended,
               how: ended ? 'ended' : 'expired', until: ended || (Number(l.exp) || 0) * 1000,
               text: r && !ended && Number(r.exp) * 1000 > now ? tillPassText(r) : '' };
    };
    var all = log.map(view);
    var live = all.filter(function (v) { return !!v.text; }).sort(function (a, b) { return a.made - b.made; });
    var past = all.filter(function (v) { return !v.text; }).sort(function (a, b) { return b.until - a.until; });
    return { live: live, past: past };
  }

  var tillTips = {
    MAX_IDS: TIP_IDS_MAX,
    MIN: TIP_MIN,
    check: function (t) { return tipsCheck(t); },
    split: function (t, amount) { return tipSplit(t, amount); },
    forward: function (o) { return tipForward(o); },
    jobs: function () {
      return tipJobRows().map(function (r) {
        return { id: r.id, cid: r.cid, name: r.name, unit: r.unit, mint: r.mint, amount: r.amount, sale: r.sale || '', from: r.from || '',
                 at: r.at, tries: Number(r.tries) || 0, state: r.state, why: r.why || '', payHash: r.payHash || '' };
      });
    },
    carry: function () { return Object.assign({}, tipCarryRows()); },
    run: function () { return tipRun(); },
  };
