  /* ---- SHOPS: this phone collects a shop's sales and pays its collaborators ------------------------------------------
   *
   * docs/CASHU-ID.md, "Shops", is the whole of it. A shop's engine holds no words and no money: it asks the mint for
   * each order's invoice (NUT-04, NUT-20) locked to P′ = ID + r·G, the shop's Cashu ID (this phone's) moved by a random
   * r of the order's own, or for ecash locked to the same P′ (NUT-11). This phone, the keeper's, collects:
   *
   *   GET  /api/shop/collect/challenge                           → { nonce, at }
   *   POST /api/shop/collect   { pub, nonce, sig, after }        → { items: [ { order, kind, quote | proofs, r, amount, unit,
   *                                                                  mint, splits: [ { id, amount, memo } ], memo, paidAt } ] }
   *                                                                 (kind "quote" a bolt11 invoice, "onchain" a NUT-04 onchain quote,
   *                                                                  "proofs" ecash)
   *                                                                 (200 a page at most; `after` the last order of the page before)
   *   POST /api/shop/collected { pub, nonce, sig, orders: [ { order, amount, unit, mintedAt, quoteOrProofs, earlier } ] } → ack
   *
   * `sig` is the ID key's BIP-340 signature over SHA-256("foxy-shop-collect-v1" ‖ nonce (32 bytes) ‖ host ‖ the request's full path), made on the
   * native side (CashuID.swift `collectSign`): the key never leaves it. For each item the mint is asked first (the
   * quote PAID and locked to P′, or the pieces unspent and locked to P′); then the phone mints with outputs of its own,
   * NUT-20's signature by d + r made natively from the quote and the outputs, or swaps the pieces in with NUT-11's by
   * d + r (`cashuIdShop`), four at a time. What is minted is put away a few dozen sales at a time in one swap into the
   * phone's own pieces (`shopFlush`), so a thousand sales are a few dozen pieces and not thousands. Each page's orders
   * are said collected as soon as that page is in (`collected`, with what was minted, and when). After the last page
   * the splits are paid: ONE payment per collaborator per collection, their sum, as any contact is paid (`cidPay`: the
   * drop boxes, a refund key, thirty days); the rest stays. A collection is ONE received row in HISTORY, "N sales from
   * <shop>", whose detail lists every order with its amount and the collaborators it paid (about 25 bytes an order),
   * and one sent row for each collaborator.
   *
   * What is in flight is written down before each step (`SHOP_RUNS`: the collection's sums, and the orders of the page
   * not yet said collected), so a close or a lost route resumes where it left off: an order whose invoice the mint
   * calls ISSUED is restored from the outputs this phone reserved for it, or, minted by nothing of this phone's, said
   * as collected earlier and never minted again.
   *
   * Refused, each with a log line and nothing done: a host not in SHOPS, splits over the amount, a split that is not a
   * Cashu ID, a mint this phone has not chosen or that does not honour a lock, a quote or pieces the mint does not say
   * are paid or unspent and locked to P′. */

  var SHOP_KEY = 'foxy.shops';
  var SHOP_RUNS = 'foxy.shop.runs';
  var SHOP_MOST = 20;
  var SHOP_PAID_MOST = 20;
  var SHOP_PAGE = 200;
  var SHOP_PAGES_MOST = 100;
  var SHOP_SPLITS_MOST = 20;
  var SHOP_LANES = 4;
  // the most pieces a collection keeps track of to swap together again: past a page's worth, the rest stay as they are
  var SHOP_KEEP_MOST = 2000;
    var SHOP_EVERY_MS = 10 * 60 * 1000;
  // a collection's order list in its row is kept this long; older, the row keeps its totals
  var SHOP_DETAIL_MS = 90 * 24 * 60 * 60 * 1000;
  var SHOP_PREFIX = 'foxyshop:';
  var SHOP_ORDER = /^[A-Za-z0-9_-]{1,64}$/;
  var SHOP_QUOTE = /^[A-Za-z0-9_-]{1,256}$/;

  function shopLog(text) { console.log('[foxy] shops: ' + text); }

  function shopClean(text, most) {
    return String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, most || 40);
  }

  /* A shop's link: `foxyshop:` and the shop's address, https or http to an .onion, with its name as `name`:
   *
   *     foxyshop:https://shop.example.com?name=Fox%20Prints
   *     foxyshop:http://<56 letters>.onion?name=Fox%20Prints
   *
   * The prefix may be left off. The address may carry a path, under which the shop's /api lives. { url, host, name,
   * onion, id }, or { why }. Never throws. */
  function shopRead(text) {
    var bad = { why: 'That is not a shop link.' };
    var t = String(text || '').trim();
    if (t.toLowerCase().indexOf(SHOP_PREFIX) === 0) t = t.slice(SHOP_PREFIX.length).trim();
    if (!t || t.length > 600) return bad;
    var u;
    try { u = new URL(t); } catch (e) { return bad; }
    var host = String(u.hostname || '').toLowerCase().replace(/\.$/, '');
    if (!host || !/^[a-z0-9.-]{1,253}$/.test(host) || u.username || u.password || u.hash) return bad;
    var onion = /^[a-z2-7]{56}\.onion$/.test(host);
    if (u.protocol === 'http:' && !onion) return { why: 'A shop link is https, or http to an .onion address.' };
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return bad;
    if (!onion && (/^[0-9.]+$/.test(host) || host === 'localhost' || host.indexOf('.') < 0)) return { why: 'That is not an address Foxy will ask.' };
    var path = String(u.pathname || '').replace(/\/+$/, '');
    if (!/^[A-Za-z0-9._~\/-]*$/.test(path)) return bad;
    var base = u.protocol + '//' + host + (u.port ? ':' + u.port : '') + path;
    var name = shopClean(u.searchParams.get('name') || '', 40) || host;
    return { url: base, host: host, name: name, onion: onion, id: (host + (u.port ? ':' + u.port : '') + path).toLowerCase() };
  }

  function shopList() {
    var l = load(SHOP_KEY, []);
    return Array.isArray(l) ? l.filter(function (s) { return s && typeof s.id === 'string' && typeof s.url === 'string'; }) : [];
  }

  function shopOf(id) { return shopList().filter(function (s) { return s.id === id; })[0] || null; }

  function shopPut(shop) {
    var l = shopList();
    var at = -1;
    l.forEach(function (s, i) { if (s.id === shop.id) at = i; });
    if (at >= 0) l[at] = shop; else l.push(shop);
    mustSave(SHOP_KEY, l);
  }

  /* A shop link added (SHOPS > ADD A SHOP): kept, and collected from at once where there is a route. */
  function shopAdd(text) {
    var r = /** @type {any} */ (shopRead(text));
    if (r.why) throw new Error(r.why);
    var had = shopOf(r.id);
    if (!had && shopList().length >= SHOP_MOST) throw new Error('Foxy collects for ' + SHOP_MOST + ' shops at most. Remove one first.');
    var shop = Object.assign({ paid: [], lastAt: 0, lastN: 0, lastWhy: '' }, had || {}, {
      id: r.id, url: r.url, host: r.host, name: r.name, onion: r.onion, at: had ? had.at : Date.now(),
    });
    shopPut(shop);
    shopLog('a shop was added (' + shop.host + ')');
    shopSoon(0);
    return shop;
  }

  /* Off the list. A collection of it that is half done keeps its record, so what it owes its collaborators is not
   * forgotten: it finishes the next time the shop is added. */
  function shopRemove(id) {
    var l = shopList();
    var left = l.filter(function (s) { return s.id !== id; });
    if (left.length === l.length) return false;
    mustSave(SHOP_KEY, left);
    shopLog('a shop was removed');
    return true;
  }

  /* ---- a collection in flight, written down before each step ----
   *
   * { id, at, n, earlier, gs: { 'mint|unit': { mint, unit, n, got, hash, owed: { idHex: { nostr, name, amount, n, paid } } } },
   *   pend: { order: { s, g, a, k, o, t } } }: `pend` is the orders not yet said collected, `s` 'm' (minting: its outputs
   * `o` reserved), 't' (taken, minted at `t`) or 'e' (the mint had it issued before). A few hundred bytes, and a page's
   * orders at most while that page is out. */

  function shopRuns() {
    var r = load(SHOP_RUNS, {});
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  }
  function shopRunOf(id) { var r = shopRuns()[id]; return r && typeof r === 'object' ? r : null; }
  function shopRunPut(id, run) {
    var all = shopRuns();
    if (run) all[id] = run; else delete all[id];
    mustSave(SHOP_RUNS, all);
  }

  /* ---- the arithmetic: P′ = ID + r·G ---- */

  function shopR(hex) {
    var t = String(hex || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(t)) return '';
    var n = BigInt('0x' + t);
    return n > BigInt(0) && n < cidOrder() ? t : '';
  }

  function shopMovedPub(idHex, rHex) {
    var P = window.CashuTS.pointFromHex(String(idHex));
    var G = /** @type {any} */ (P.constructor).BASE;
    return P.add(G.multiply(BigInt('0x' + rHex))).toHex(true).toLowerCase();
  }

  /* ---- talking to the shop ---- */

  function shopCall(shop, method, path, body) {
    var url = shop.url + path;
    var said = function (text) {
      try { return JSON.parse(String(text || '')); } catch (e) { throw new Error(shop.host + ' did not answer in JSON'); }
    };
    if (shop.onion && method === 'POST') {
      return bridgeAsk('onionPost', { url: url, body: JSON.stringify(body || {}), timeout: 60000 }, 70000).then(function (text) {
        var s = String(text || '');
        var nl = s.indexOf('\n');
        var code = Number(s.slice(0, nl)) || 0;
        if (code < 200 || code >= 300) throw new Error(shop.host + ' answered ' + code);
        return said(s.slice(nl + 1));
      });
    }
    return FoxyWallet.nativeRequest({ endpoint: url, method: method, requestBody: body || undefined,
                                      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                                      foxyText: true, foxyNoPace: true }).then(said);
  }

  /* A fresh nonce from the shop, signed by the ID key over it, the shop's host and the full path of the call it is for
   * (`endpoint`, under the link's path): { pub, nonce, sig }. A signature for one call is not good for the other, nor at
   * another shop on the same host. */
  function shopProve(shop, mine, endpoint) {
    return shopCall(shop, 'GET', '/api/shop/collect/challenge').then(function (c) {
      var nonce = String((c && c.nonce) || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error(shop.host + ' gave no nonce to sign');
      // ‖ host ‖ path: the request's whole path as it is sent, the link's path joined with the call's, no trailing slash, no query
      var path = '';
      try { path = (new URL(shop.url).pathname.replace(/\/+$/, '') + endpoint).replace(/\/+$/, ''); } catch (e) { path = endpoint; }
      return nativeJson('cashuIdShop', { kind: 'collect', nonce: nonce, host: shop.host, path: path }, 60000).then(function (s) {
        var pub = String((s && s.pub) || '').toLowerCase();
        var sig = String((s && s.sig) || '').toLowerCase();
        if (pub !== mine.id || !/^[0-9a-f]{128}$/.test(sig)) throw new Error('the phone did not sign for the shop');
        return { pub: pub, nonce: nonce, sig: sig };
      });
    });
  }

  /* ---- one item, read ---- */

  /* An item as the shop sent it: { order, kind, quote, proofs, r, amount, unit, mint, splits, memo }, or { why }. */
  function shopItemRead(it) {
    var x = /** @type {any} */ (it || {});
    var order = String(x.order || '');
    if (!SHOP_ORDER.test(order)) return { why: 'it has no order number Foxy can read' };
    var out = /** @type {any} */ ({ order: order });
    out.kind = x.kind === 'quote' || x.kind === 'proofs' || x.kind === 'onchain' ? x.kind : '';
    if (!out.kind) return { order: order, why: 'it is neither an invoice, an address nor ecash' };
    out.r = shopR(x.r);
    if (!out.r) return { order: order, why: 'its r is not a number Foxy can use' };
    out.amount = satsOf(x.amount);
    if (!Number.isSafeInteger(out.amount) || out.amount <= 0) return { order: order, why: 'it has no amount' };
    out.unit = unitOf(x.unit) === 'usd' ? 'usd' : unitOf(x.unit) === 'sat' ? 'sat' : '';
    if (!out.unit) return { order: order, why: 'its unit is not one Foxy holds' };
    out.mint = canonicalMint(String(x.mint || ''));
    if (!out.mint || (!/^https:\/\//.test(out.mint) && !/^http:\/\/[a-z2-7]{56}\.onion/.test(out.mint))) return { order: order, why: 'it names no mint' };
    if (out.kind === 'quote' || out.kind === 'onchain') {
      out.quote = String(x.quote || '');
      if (!SHOP_QUOTE.test(out.quote)) return { order: order, why: out.kind === 'onchain' ? 'it names no on-chain quote' : 'it names no invoice' };
    } else {
      out.proofs = Array.isArray(x.proofs) ? x.proofs : [];
      if (!out.proofs.length || out.proofs.length > CID_PROOFS_MAX || !out.proofs.every(function (pr) {
        return pr && typeof pr.secret === 'string' && typeof pr.C === 'string' && typeof pr.id === 'string' && satsOf(pr.amount) > 0;
      })) return { order: order, why: 'its ecash is not ecash Foxy can read' };
    }
    var splits = Array.isArray(x.splits) ? x.splits : [];
    if (splits.length > SHOP_SPLITS_MOST) return { order: order, why: 'it has more than ' + SHOP_SPLITS_MOST + ' splits' };
    out.splits = [];
    for (var i = 0; i < splits.length; i++) {
      var sp = splits[i] || {};
      var amount = satsOf(sp.amount);
      if (!Number.isSafeInteger(amount) || amount <= 0) return { order: order, why: 'a split has no amount' };
      var read = /** @type {any} */ (cidRead(String(sp.id || '')));
      if (!read.id) return { order: order, why: 'a split names something that is not a valid Cashu ID' };
      out.splits.push({ read: read, amount: amount });
    }
    var sum = out.splits.reduce(function (n, s) { return n + s.amount; }, 0);
    if (sum > out.amount) return { order: order, why: 'its splits add up to ' + sum + ', more than the sale’s ' + out.amount };
    out.memo = shopClean(x.memo, 80);
    return out;
  }

  /* ---- the history row ---- */

  function shopRowAdd(row, n) {
    if (row.unit && row.unit !== 'sat') row.amount = (satsOf(row.amount) || 0) + n;
    else row.sats = (Number(row.sats) || 0) + n;
  }

  function shopSales(n) { return n === 1 ? '1 sale' : n.toLocaleString('en-US') + ' sales'; }

  /* The batch `taken` (each { item, got }) written into the group's one row, in one write with the pile: the row made
   * made now or before; the row a receive of signed pieces wrote (`freshHash`) is folded into it and goes. The row's `shop` is its
   * detail: the shop, the time, the count, the total, the collaborators (`ids`: the ID's start and a name), and `list`, every
   * order as "order,amount,i.j;" with the places in `ids` of the collaborators it paid: about 20 bytes an order. */
  function shopRowFold(shop, run, g, taken, freshHash, got, mine, fee) {
    var list = load(K.log, []);
    var row = g.hash ? list.filter(function (e) { return e && e.hash === g.hash; })[0] : null;
    var fresh = freshHash ? list.filter(function (e) { return e && e.hash === freshHash; })[0] : null;
    if (!row) {
      g.hash = 'shop-' + run.id + '-' + Object.keys(run.gs).indexOf(g.key);
      row = unitRow(g.unit, { dir: 'in', sats: 0, feeSats: 0, settled: true, state: 'success', hash: g.hash, mint: g.mint });
      row.at = Math.floor(Date.now() / 1000);
      if (rateNow()) row.rate = rateNow();
      list.unshift(row);
    }
    if (fresh && fresh !== row) {
      list = list.filter(function (e) { return e !== fresh; });
      if (Number(fresh.feeSats) > 0) row.feeSats = (Number(row.feeSats) || 0) + Number(fresh.feeSats);
      if (Number(fresh.feeAmount) > 0) row.feeAmount = (Number(row.feeAmount) || 0) + Number(fresh.feeAmount);
    }
    shopRowAdd(row, got);
    if (fee > 0) {
      if (row.unit && row.unit !== 'sat') row.feeAmount = (Number(row.feeAmount) || 0) + fee;
      else row.feeSats = (Number(row.feeSats) || 0) + fee;
    }
    var d = row.shop && typeof row.shop === 'object' ? row.shop : { name: shop.name, host: shop.host, at: Date.now(), n: 0, total: 0, unit: g.unit, ids: [], list: '' };
    taken.forEach(function (t) {
      var paid = [];
      t.item.splits.forEach(function (sp) {
        if (sp.read.id === mine.id) return;
        var at = -1;
        d.ids.forEach(function (x, i) { if (x[0] === sp.read.id.slice(2, 18)) at = i; });
        if (at < 0) { d.ids.push([sp.read.id.slice(2, 18), shopNameOf(sp.read)]); at = d.ids.length - 1; }
        if (paid.indexOf(at) < 0) paid.push(at);
      });
      d.list = String(d.list || '') + t.item.order + ',' + t.item.amount + (paid.length ? ',' + paid.join('.') : '') + ';';
      d.n += 1;
      d.total += t.item.amount;
    });
    row.shop = d;
    row.memo = shopSales(d.n) + ' from ' + shop.name;
    row.cid = 'shop';
    // the order lists of collections more than ninety days old, trimmed to their totals
    var old = Date.now() - SHOP_DETAIL_MS;
    list.forEach(function (e) { if (e && e.shop && typeof e.shop.list === 'string' && Number(e.shop.at) < old) delete e.shop.list; });
    saveMoney(K.log, list.slice(0, 500));
  }

  function shopNameOf(read) {
    var contact = cidContactOf(read.id);
    return (contact && contact.name) || ('Cashu ID ' + read.id.slice(2, 10));
  }

  /* ---- taking the money in ---- */

  /* One invoice (NUT-04 bolt11), or one on-chain quote (NUT-04 onchain): the mint asked, then minted with outputs of this
   * phone's. An invoice must be locked to P′ (NUT-20), and is signed by d + r on the native side from the quote and those
   * outputs (both of NUT-20's messages); an on-chain quote is locked to P′ the same way where the mint took the lock, and
   * minted by its id with no signature where it did not (`r` still names the order). The outputs' counters are on the
   * order's row in `pend` before the mint is asked to sign, so an answer lost on the way back is restored from them.
   * Resolves { proofs } (minted now or restored), { earlier: true } (issued before, not by this phone), or rejects
   * (refused, or not now). */
  function shopMintOne(shop, run, item, pub, view, gkey) {
    var refuse = function (why) { var e = /** @type {any} */ (new Error(why)); e.refused = true; throw e; };
    var chain = item.kind === 'onchain';
    var method = chain ? 'onchain' : 'bolt11';
    var ask = function () {
      return withTimeout(chain ? view.checkMintQuoteOnchain(item.quote) : view.checkMintQuoteBolt11(item.quote), 20000, chain ? 'the address’s state' : 'the invoice’s state');
    };
    // PAID, ISSUED or UNPAID for this order's amount; an on-chain quote by what has confirmed and what was issued
    var stateOf = function (q) {
      if (!chain) return String((q && q.state) || '').toUpperCase();
      var paid = satsOf(q && q.amount_paid), issued = satsOf(q && q.amount_issued);
      if (paid - issued >= item.amount) return 'PAID';
      if (issued >= item.amount) return 'ISSUED';
      return 'UNPAID';
    };
    return ask().then(function (q) {
      if (!q || String(q.quote) !== item.quote) refuse('the mint answered about another ' + (chain ? 'address' : 'invoice'));
      var key = String(q.pubkey || '').toLowerCase();
      var locked = !!key;
      if (locked && key !== pub) refuse('the ' + (chain ? 'address' : 'invoice') + ' is not locked to this order’s key');
      if (!locked && !chain) refuse('the invoice is not locked to a key (NUT-20)');
      // the keeper's rule (D1): an address with no lock is anybody's who holds its id, the shop's engine too; not taken
      if (!locked) refuse('the on-chain address has no lock; anyone holding its id could take it');
      if (!chain && q.amount != null && satsOf(q.amount) !== item.amount) refuse('the mint says the invoice is for ' + satsOf(q.amount) + ', not ' + item.amount);
      if (q.unit && unitOf(q.unit) !== item.unit) refuse('the mint says it is in ' + q.unit);
      var state = stateOf(q);
      var p = run.pend[item.order];
      if (state === 'ISSUED') {
        // an address with no lock could have been minted by anyone with its id, the shop's engine too: not vouched for
        if (!locked) refuse('the mint has issued an address with no lock; anyone holding its id could have taken it');
        if (!p || p.s !== 'm' || !Array.isArray(p.o) || !p.o.length) return { earlier: true };
        // minted by this phone, its answer lost: the outputs it reserved, restored
        return restoreRanges(view, p.o, 'the shop’s quote').then(function (rows) {
          var found = [];
          rows.forEach(function (r) { found = found.concat(r.proofs || []); });
          return liveUnheld(view, found);
        }).then(function (fresh) {
          // what this phone's outputs got is the sale, or this phone did not mint it (another order's, or another phone's)
          if (sumProofs(fresh) !== item.amount) return { earlier: true };
          shopLog(shop.host + ' order ' + item.order + ': minted before, its answer lost; restored ' + fresh.length + ' piece(s)');
          return { proofs: fresh };
        });
      }
      if (state !== 'PAID') refuse('the mint does not say it is paid (' + (state || 'no state') + ')');
      run.pend[item.order] = { s: 'm', g: gkey, a: item.amount, k: chain ? 'o' : 'q', o: [] };
      shopRunPut(shop.id, run);
      // the quote as cashu-ts is to read it, without its key (the phone signs, not the library)
      var asked = chain ? { quote: item.quote, amount_paid: q.amount_paid, amount_issued: q.amount_issued, unit: q.unit || item.unit } : { quote: item.quote };
      var signed = function () {
        return Promise.resolve(view.prepareMint(method, item.amount, asked, {
          onCountersReserved: function (used) {
            var r = used && used.keysetId ? { keysetId: String(used.keysetId), start: Number(used.start) || 0, count: Number(used.count) || 0 } : null;
            if (!r || !(r.count > 0)) return;
            run.pend[item.order].o = (run.pend[item.order].o || []).concat([r]);
            try { shopRunPut(shop.id, run); } catch (e) { refuseOn(view, e); }
          },
        })).then(function (prep) {
          if (!locked) return view.completeMint(prep);
          var outs = (prep.payload.outputs || []).map(function (o) { return { amount: satsOf(o.amount), B_: String(o.B_) }; });
          return nativeJson('cashuIdShop', { kind: 'quote', r: item.r, quote: item.quote, pubkey: pub, outputs: outs }, 60000).then(function (s) {
            if (!s || !/^[0-9a-f]{128}$/.test(String(s.sig)) || !/^[0-9a-f]{128}$/.test(String(s.legacy))) throw new Error('the phone did not sign the quote');
            prep.payload.signature = String(s.sig);
            prep.legacySignature = String(s.legacy);
            return view.completeMint(prep);
          });
        });
      };
      var stillPaid = function () { return ask().then(function (q2) { return stateOf(q2) === 'PAID'; }); };
      return onceMoreIfSigned(view, 'shop claim', signed, stillPaid).then(function (proofs) {
        return { proofs: proofs };
      });
    });
  }

  /* Pieces locked to P′: every one to P′ alone, the sale's amount, unspent at the mint; signed by d + r on the native
   * side. Resolves { signed } (with their witnesses, to be swapped in), { earlier: true }, or rejects. */
  function shopSignOne(shop, run, item, pub, view) {
    var proofs = item.proofs.map(function (pr) { return { id: String(pr.id), amount: satsOf(pr.amount), secret: String(pr.secret), C: String(pr.C), dleq: pr.dleq }; });
    var refused = function (why) { return Promise.reject(Object.assign(new Error(why), { refused: true })); };
    if (proofs.reduce(function (n, pr) { return n + pr.amount; }, 0) !== item.amount) return refused('its ecash is not the sale’s amount');
    if (!proofs.every(function (pr) { return String(lockedTo(pr) || '').toLowerCase() === pub && onlyLockedTo(pr, pub, { swapNow: true }); })) {
      return refused('its ecash is not locked to this order’s key alone');
    }
    return statesOf(view, proofs).then(function (states) {
      if (states.every(function (s) { return s === 'SPENT'; })) return /** @type {any} */ ({ earlier: true });
      if (!states.every(function (s) { return s === 'UNSPENT'; })) return refused('the mint does not say its ecash is unspent');
      return nativeJson('cashuIdShop', { kind: 'proofs', r: item.r, secrets: proofs.map(function (pr) { return pr.secret; }) }, 60000).then(function (s) {
        var sigs = Array.isArray(s && s.sigs) ? s.sigs : [];
        if (sigs.length !== proofs.length) throw new Error('the phone did not sign for the ecash');
        return { signed: cidForMint(proofs, sigs) };
      });
    });
  }

  /* A page's sales at one mint, put away. First, in one tick: what was minted into the pile, the row, the sums owed to
   * each collaborator, and each of those orders marked taken. Then what was minted is swapped, with the pieces the
   * collection's earlier pages left (`g.keep`), into the fewest pieces their sum needs (`shopSwapKeep`). Only then is the
   * ecash that came as pieces locked to P′ taken in, each order by its own receive (`receiveToken`: signed already, it is
   * a receive), its row folded into the collection's and the order taken: one the mint refuses is that order's alone,
   * left for the next collection, and stalls nothing minted. */
  function shopFlush(shop, run, g, batch, w, mine) {
    if (!batch.length) return Promise.resolve();
    var mintedBatch = batch.filter(function (b) { return !b.signed; });
    var signedBatch = batch.filter(function (b) { return b.signed; });
    var minted = [];
    mintedBatch.forEach(function (b) { minted.push.apply(minted, b.proofs); });
    var unitArg = g.unit === 'sat' ? undefined : g.unit;
    var take = function (orders, freshHash, landed, fee) {
      shopRowFold(shop, run, g, orders, freshHash, landed, mine, fee);
      var now = Date.now();
      orders.forEach(function (b) {
        g.n += 1;
        g.got += b.item.amount;
        b.item.splits.forEach(function (sp) {
          if (sp.read.id === mine.id) return;
          var o = g.owed[sp.read.id] || { nostr: sp.read.nostr, name: shopNameOf(sp.read), amount: 0, n: 0, paid: false, round: 0 };
          // a share paid already in this run (the run kept for an order not yet said collected) is not paid again: a new round
          if (o.paid) { o.amount = 0; o.n = 0; o.round = (Number(o.round) || 0) + 1; }
          o.amount += sp.amount;
          o.n += 1;
          o.paid = false;
          g.owed[sp.read.id] = o;
        });
        run.pend[b.item.order] = { s: 't', g: g.key, a: b.item.amount, k: b.item.kind === 'onchain' ? 'o' : b.item.kind === 'quote' ? 'q' : 'p', t: now };
      });
      run.n += orders.length;
      shopRunPut(shop.id, run);
      cidHistoryChanged();
    };
    var first = Promise.resolve();
    if (mintedBatch.length) {
      // the minted pieces, the row and the record, in one tick
      addProofs(minted, g.mint, w, unitArg);
      take(mintedBatch, '', sumProofs(minted), 0);
      first = shopSwapKeep(shop, run, g, w, mine, minted.map(function (p) { return p.secret; }));
    }
    return first.then(function () {
      return signedBatch.reduce(function (chain, b) {
        return chain.then(function () {
          if (shopAway) return;
          return FoxyWallet.receiveToken(encodeToken(g.mint, b.proofs, g.unit), { memo: 'Sales from ' + shop.name }).then(function (r) {
            take([b], (r && r.hash) || '', Math.round(satsOf(r && (r.amount != null ? r.amount : r.sats))) || 0, 0);
          }, function (e) {
            shopLog(shop.host + ' order ' + b.item.order + ' was not collected: its ecash was not taken in (' + String((e && e.message) || e).slice(0, 80) + ')');
          });
        });
      }, Promise.resolve());
    });
  }

  /* The collection's pieces at one mint (`g.keep`, and `more` just minted) swapped into the fewest their sum needs, in as
   * few swaps as the mint's longest array allows. Its inputs stay in the pile until its answer is in, its outputs are on
   * disk until then (`swapGuard`), and an answer lost holds its inputs back until the mint says what became of it
   * (`holdInputs`, `recoverSwaps`, asked at the next collection's start). A swap that does not happen leaves the pieces as
   * they are, still the collection's, for the next. */
  function shopSwapKeep(shop, run, g, w, mine, more) {
    var unitArg = g.unit === 'sat' ? undefined : g.unit;
    var keepSet = {};
    (g.keep || []).concat(more || []).forEach(function (x) { keepSet[x] = true; });
    var inputs = proofs(g.mint, unitArg).filter(function (p) { return p && keepSet[p.secret]; });
    // (pieces held back for a swap the mint has not answered about stay on the list: they come back to the pile, or are spent)
    if (inputs.length < 2) {
      g.keep = Object.keys(keepSet).slice(0, SHOP_KEEP_MOST);
      shopRunPut(shop.id, run);
      return Promise.resolve();
    }
    var view = onCircuit(w, 'shop:' + shop.id + ':put');
    var cap = Math.max(16, mintArrayCap(w) - 16);
    var chunks = [];
    for (var i = 0; i < inputs.length; i += cap) chunks.push(inputs.slice(i, i + cap));
    var outs = [];
    return chunks.reduce(function (chain, chunk) {
      return chain.then(function () {
        var amount = sumProofs(chunk);
        var guard = swapGuard(view, 'shop', { amount: amount, unit: g.unit, expect: amount - swapFeeFor(view, chunk), inputs: chunk });
        return guard.run('shop', function () { return view.receive(encodeToken(g.mint, chunk, g.unit)); }).then(function (got) {
          // the inputs out of the pile and what came back in, in one tick
          var gone = {};
          chunk.forEach(function (p) { gone[p.secret] = true; });
          setProofs(proofs(g.mint, unitArg).filter(function (p) { return !(p && gone[p.secret]); }).concat(got), g.mint, w, unitArg);
          guard.done();
          var cost = amount - sumProofs(got);
          outs = outs.concat(got);
          if (cost > 0) shopRowFold(shop, run, g, [], '', -cost, mine, cost);
        }, function (e) {
          outs = outs.concat(chunk);
          shopLog(shop.host + ': ' + chunk.length + ' piece(s) not swapped together (' + String((e && e.message) || e).slice(0, 60) + '); kept for the next swap');
        });
      });
    }, Promise.resolve()).then(function () {
      // what came back, and what of the list was not in the pile this time (held back for a swap still to be settled)
      var inPile = {};
      inputs.forEach(function (p) { inPile[p.secret] = true; });
      g.keep = outs.map(function (p) { return p.secret; })
        .concat(Object.keys(keepSet).filter(function (x) { return !inPile[x]; })).slice(0, SHOP_KEEP_MOST);
      shopRunPut(shop.id, run);
    });
  }

  /* One page's items at one mint, four at a time, each lane on a circuit of its own; then put away together. */
  function shopTakeAt(shop, run, mint, items, mine, progress) {
    return carryVisit(mint).then(function () {
      if (!tillMintLocks(mint)) throw Object.assign(new Error(hostOf(mint) + ' does not say it honours a lock (NUT-11)'), { refused: true });
      var unit = items[0].unit;
      return unit === 'sat' ? wallet : unitWalletLocal(unit);
    }).then(function (w) {
      var n20 = false;
      try { n20 = !!w.getMintInfo().isSupported(20).supported; } catch (e) { n20 = false; }
      var unit = items[0].unit;
      var gkey = mint + '|' + unit;
      var g = run.gs[gkey] || { key: gkey, mint: mint, unit: unit, n: 0, got: 0, hash: '', owed: {} };
      run.gs[gkey] = g;
      var queue = items.slice();
      var batch = [];
      var lane = function (i) {
        var view = onCircuit(w, 'shop:' + shop.id + ':' + i);
        var next = function () {
          var item = queue.shift();
          if (!item) return Promise.resolve();
          if (!routeOpen() || shopAway) { queue.length = 0; return Promise.resolve(); }
          var pub = shopMovedPub(mine.id, item.r);
          var one = item.kind === 'proofs' ? shopSignOne(shop, run, item, pub, view)
            : (n20 || item.kind === 'onchain') ? shopMintOne(shop, run, item, pub, view, gkey)
            : Promise.reject(Object.assign(new Error(hostOf(mint) + ' does not lock invoices to a key (NUT-20)'), { refused: true }));
          return one.then(function (r) {
            if (r.earlier) {
              run.pend[item.order] = { s: 'e', g: gkey, a: item.amount, k: item.kind === 'onchain' ? 'o' : item.kind === 'quote' ? 'q' : 'p', t: Date.now() };
              shopRunPut(shop.id, run);
              run.earlier = (Number(run.earlier) || 0) + 1;
              shopLog(shop.host + ' order ' + item.order + ': the mint had it issued before, not by this phone; said so, not minted');
              return;
            }
            batch.push({ item: item, proofs: r.proofs || r.signed, signed: !!r.signed });
            progress();
          }, function (e) {
            shopLog(shop.host + ' order ' + item.order + ' was not collected: ' + String((e && e.message) || e).slice(0, 140));
          }).then(next);
        };
        return next();
      };
      var lanes = [];
      for (var i = 0; i < SHOP_LANES; i++) lanes.push(lane(i));
      return Promise.all(lanes).then(function () { return shopFlush(shop, run, g, batch, w, mine); });
    }).then(null, function (e) {
      shopLog(shop.host + ': ' + items.length + ' sale(s) at ' + hostOf(mint) + ' were not collected: ' + String((e && e.message) || e).slice(0, 120));
    });
  }

  /* The orders of `run.pend` taken or issued earlier, said collected; off the record once the shop has them. */
  function shopSayCollected(shop, run, mine) {
    var orders = Object.keys(run.pend).filter(function (o) { var p = run.pend[o]; return p && (p.s === 't' || p.s === 'e'); });
    if (!orders.length) return Promise.resolve(0);
    var unitOfG = function (gk) { return String(gk || '').split('|')[1] || 'sat'; };
    var said = orders.map(function (o) {
      var p = run.pend[o];
      var row = { order: o, amount: p.a, unit: unitOfG(p.g), mintedAt: p.t || 0, quoteOrProofs: p.k === 'p' ? 'proofs' : p.k === 'o' ? 'onchain' : 'quote' };
      if (p.s === 'e') row.earlier = true;
      return row;
    });
    return shopProve(shop, mine, '/api/shop/collected').then(function (proof) {
      return shopCall(shop, 'POST', '/api/shop/collected', Object.assign({}, proof, { orders: said }));
    }).then(function () {
      orders.forEach(function (o) { delete run.pend[o]; });
      shopRunPut(shop.id, run);
      return orders.length;
    }, function (e) {
      // said again with the next page, or the next collection
      shopLog(shop.host + ': ' + orders.length + ' collected order(s) could not be said (' + String((e && e.message) || e).slice(0, 80) + '); said next time');
      return 0;
    });
  }

  /* After the last page: each collaborator paid once, the sum of their splits in this collection. */
  function shopPayOut(shop, run, mine) {
    var home = load(K.mint, '') || mintUrl || '';
    var keys = Object.keys(run.gs);
    return keys.reduce(function (chain, gk) {
      return chain.then(function () {
        var g = run.gs[gk];
        var due = Object.keys(g.owed).filter(function (id) { return !g.owed[id].paid && g.owed[id].amount > 0; });
        if (!due.length && (g.keep || []).length <= 40) return;
        return carryVisit(g.mint).then(function () {
          // pieces a cut left unswapped, put together before anything is paid from them
          if ((g.keep || []).length <= 40) return;
          return (g.unit === 'sat' ? Promise.resolve(wallet) : unitWalletLocal(g.unit)).then(function (w) { return shopSwapKeep(shop, run, g, w, mine, []); });
        }).then(function () {
          return due.reduce(function (c2, id) {
            return c2.then(function () {
              if (shopAway) return;
              var o = g.owed[id];
              /* The payout's own name, kept on its outbox row (`cidPay` opts.shopPay): a phone killed after the payment
               * went and before `paid` was written finds it there, and does not pay it again. */
              var payKey = shop.id + '|' + run.id + '|' + gk + '|' + id + '|' + (Number(o.round) || 0);
              if (cidOutboxRows().some(function (r) { return r && r.shopPay === payKey; })) {
                o.paid = true;
                shopRunPut(shop.id, run);
                shopLog(shop.host + ': a collaborator’s share was paid already (its payment is in the outbox); not paid again');
                return;
              }
              return cidPay(id, o.amount, { unit: g.unit, name: o.name, read: { id: id, nostr: o.nostr }, shopPay: payKey,
                                            memo: 'To ' + o.name + ' · ' + shop.name,
                                            note: shopClean(shop.name, 60) + ' · your share of ' + shopSales(o.n) }).then(function () {
                o.paid = true;
                shopRunPut(shop.id, run);
                shopPaidNote(shop, id, o.name);
                shopLog(shop.host + ': a collaborator was paid their share of ' + shopSales(o.n));
              }, function (e) {
                shopLog(shop.host + ': a collaborator’s share could not be paid yet (' + String((e && e.message) || e).slice(0, 80) + '); paid next time');
              });
            });
          }, Promise.resolve());
        });
      });
    }, Promise.resolve()).then(function () { return carryGoHome(home); });
  }

  function shopPaidNote(shop, id, name) {
    var s = shopOf(shop.id);
    if (!s) return;
    var paid = Array.isArray(s.paid) ? s.paid.slice() : [];
    var at = -1;
    paid.forEach(function (p, i) { if (p && p.id === id) at = i; });
    var row = at >= 0 ? paid[at] : { id: id, n: 0 };
    row = Object.assign({}, row, { name: name, n: (Number(row.n) || 0) + 1, at: Date.now() });
    if (at >= 0) paid.splice(at, 1);
    paid.unshift(row);
    s.paid = paid.slice(0, SHOP_PAID_MOST);
    shopPut(s);
  }

  /* ---- a collection ---- */

  var shopRunning = /** @type {any} */ (null);
  var shopTimer = /** @type {any} */ (null);
  // Foxy has been put away (`shopStop`): nothing new is asked, minted or paid until it is back (`shopResume`)
  var shopAway = false;

  /* Put away (`_stopAskingAgain`, from the app's `putAway`): the timer stops, and a collection in flight stops at its next
   * step, every step written down as ever, so the return takes it up where it stopped. */
  function shopStop() {
    shopAway = true;
    if (shopTimer) clearTimeout(shopTimer);
    shopTimer = null;
  }
  // back (a connect's catch-up, a return, the route's return): a collection a moment later
  function shopResume() {
    shopAway = false;
    shopSoon(2000);
  }

  function shopEveryMs() {
    return CID_TESTS && Number(FoxyWallet._shopEveryMs) > 0 ? Number(FoxyWallet._shopEveryMs) : SHOP_EVERY_MS;
  }

  // the next collection, in `ms` (the ten minutes when not said); one timer, never two
  function shopSoon(ms) {
    if (shopTimer) clearTimeout(shopTimer);
    shopTimer = null;
    if (!shopList().length || shopAway) return;
    shopTimer = setTimeout(function () {
      shopTimer = null;
      shopCollect().then(null, function () {});
    }, ms == null ? shopEveryMs() : ms);
  }

  function shopSay(ev) {
    if (typeof FoxyWallet._onShopCollect === 'function') { try { FoxyWallet._onShopCollect(ev); } catch (x) {} }
  }

  function shopCollectOne(shop, mine) {
    var run = shopRunOf(shop.id) || { id: Date.now().toString(36), at: Date.now(), n: 0, earlier: 0, gs: {}, pend: {} };
    var resumed = run.n > 0 || Object.keys(run.pend).length > 0;
    var started = run.n;
    var seen = 0, total = 0, saidStart = false;
    var home = load(K.mint, '') || mintUrl || '';
    var progress = function () {
      shopSay({ state: 'collecting', shop: shop.name, id: shop.id, n: run.n - started + 1, of: total });
    };
    var page = function (after, k) {
      if (k >= SHOP_PAGES_MOST || !routeOpen() || shopAway) return Promise.resolve();
      return shopProve(shop, mine, '/api/shop/collect').then(function (proof) {
        return shopCall(shop, 'POST', '/api/shop/collect', Object.assign({}, proof, after ? { after: after } : {}));
      }).then(function (list) {
        var raw = Array.isArray(list && list.items) ? list.items.slice(0, SHOP_PAGE) : [];
        if (!raw.length) return shopSayCollected(shop, run, mine);
        seen += raw.length;
        total = Math.max(total, Number(list && list.total) || 0, seen);
        if (!saidStart) { saidStart = true; shopSay({ state: 'collecting', shop: shop.name, id: shop.id, n: 0, of: total }); }
        var items = [];
        var named = {};
        raw.forEach(function (it) {
          var x = /** @type {any} */ (shopItemRead(it));
          if (x.why) { shopLog(shop.host + ' order ' + (x.order || '?') + ' was not collected: ' + x.why); return; }
          var p = run.pend[x.order];
          if (p && (p.s === 't' || p.s === 'e')) return;
          var marks = x.quote ? ['q:' + x.mint + '|' + x.quote] : x.proofs.map(function (pr) { return 's:' + String(pr.secret); });
          if (marks.some(function (m2, i2) { return named[m2] || marks.indexOf(m2) !== i2; })) { shopLog(shop.host + ' order ' + x.order + ' was not collected: it names an invoice or ecash another order names'); return; }
          marks.forEach(function (m2) { named[m2] = true; });
          if (!FoxyWallet.mintChosen(x.mint)) { shopLog(shop.host + ' order ' + x.order + ' was not collected: it is at ' + hostOf(x.mint) + ', a mint this phone has not chosen'); return; }
          items.push(x);
        });
        // by mint and unit, one visit each
        var by = {};
        items.forEach(function (x) { var gk = x.mint + '|' + x.unit; (by[gk] = by[gk] || []).push(x); });
        return Object.keys(by).reduce(function (chain, gk) {
          return chain.then(function () { return shopTakeAt(shop, run, by[gk][0].mint, by[gk], mine, progress); });
        }, Promise.resolve()).then(function () {
          return shopSayCollected(shop, run, mine);
        }).then(function () {
          if (raw.length < SHOP_PAGE) return;
          return page(String(raw[raw.length - 1].order || ''), k + 1);
        });
      });
    };
    shopRunPut(shop.id, run);
    if (resumed) shopLog(shop.host + ': a collection left off is taken up again');
    // a swap of an earlier run whose answer was lost: what became of it asked first, so its pieces are back for the payouts
    var held = load(K.held, {}) || {};
    var asked = Object.keys(held).some(function (k) { return k.indexOf('shop-') === 0; })
      ? Promise.resolve().then(function () { return FoxyWallet.recoverSwaps(); }).then(null, function () {}) : Promise.resolve();
    return asked.then(function () { return page('', 0); }).then(function () { return carryGoHome(home); }).then(function () {
      shopSay({ state: 'paying', shop: shop.name, id: shop.id, n: run.n - started });
      return shopPayOut(shop, run, mine);
    }).then(function () {
      var owing = Object.keys(run.gs).some(function (gk) {
        var g = run.gs[gk];
        return Object.keys(g.owed).some(function (id) { return !g.owed[id].paid; });
      });
      var n = run.n;
      // kept while a swap of its pieces waits for the mint's word (`holdInputs`): the next collection puts them together
      var holding = Object.keys(load(K.held, {}) || {}).some(function (k) { return k.indexOf('shop-') === 0; });
      if (!owing && !Object.keys(run.pend).length && !holding) shopRunPut(shop.id, null);
      var s = shopOf(shop.id);
      if (s) {
        s.lastAt = Date.now();
        if (n - started > 0 || !owing) s.lastN = n;
        s.lastWhy = '';
        shopPut(s);
      }
      if (n - started > 0) {
        cidHistoryChanged();
        shopSay({ state: 'collected', shop: shop.name, id: shop.id, n: n - started });
      } else shopSay({ state: 'idle', shop: shop.name, id: shop.id, n: 0 });
      return n - started;
    }, function (e) {
      var why = String((e && e.message) || e).slice(0, 120);
      shopLog(shop.host + ' could not be collected from: ' + why);
      var s = shopOf(shop.id);
      if (s) { s.lastWhy = why; try { shopPut(s); } catch (x) {} }
      shopSay({ state: run.n - started > 0 ? 'collected' : 'failed', shop: shop.name, id: shop.id, n: run.n - started, why: why });
      return carryGoHome(home).then(function () { return run.n - started; });
    });
  }

  /* Every shop in SHOPS, one after another, with a route up and a connected wallet. Resolves the sales collected.
   * One at a time: a second call while one runs gets the first. The next one is in ten minutes. */
  function shopCollect() {
    if (shopRunning) return shopRunning;
    var shops = shopList();
    if (!shops.length) return Promise.resolve(0);
    if (shopAway) return Promise.resolve(0);
    if (!wallet || !routeOpen() || claimAway) { shopSoon(); return Promise.resolve(0); }
    var run = cidMine().then(function (mine) {
      return shops.reduce(function (chain, shop) {
        return chain.then(function (n) {
          // a shop removed while the one before it ran is not asked
          if (!shopOf(shop.id)) return n;
          return shopCollectOne(shop, mine).then(function (k) { return n + k; });
        });
      }, Promise.resolve(0));
    }).then(function (n) { shopRunning = null; shopSoon(); return n; }, function (e) {
      shopRunning = null;
      shopSoon();
      shopLog('no collection: ' + String((e && e.message) || e).slice(0, 80));
      return 0;
    });
    shopRunning = run;
    return run;
  }
