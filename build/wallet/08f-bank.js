  /* ---- BANK ACCOUNT: dollars in the person's own account at an exchange, paid by Lightning -------------------------
   *
   * SEND > BANK ACCOUNT (build/app/26q-bank.js). No exchange is asked for anything but what any payer may ask: no
   * account of Foxy's, no key, no business programme. The person already has an account; Foxy pays it by Lightning, and
   * the exchange turns the bitcoin into dollars by the person's own setting there.
   *
   *   Strike ..... a Lightning address, <username>@strike.me. Looked up at
   *                https://strike.me/.well-known/lnurlp/<username> before it is kept: a payment record is the account
   *                found; an answer of 400-499, or an answer that is not a payment record, is no account by that name.
   *   River,
   *   Cash App ... no Lightning address: the person makes an invoice in the app and pastes it. Nothing is looked up.
   *
   * The lookup is the well-known request of LUD-16 alone, over the wallet's Tor road and on the same terms as a
   * Lightning address's lookup when it is paid (`lookupLnurl`, 16-sending.js): asked again on a fresh circuit while it
   * goes unanswered (`askedAgain`), inside one deadline. Paying goes through `lookupLnurl` and `payLnurl` as any
   * address does, with their checks (min and max, the invoice's amount to the millisat, what it describes).
   *
   * What is kept (`foxy.bank`): the exchange chosen and, for an address, the username; never an invoice. */

  var BANK = {
    strike: { name: 'Strike', domain: 'strike.me', site: 'strike', by: 'address' },
    cashapp: { name: 'Cash App', domain: 'cash.app', site: 'cashapp', by: 'invoice' },
    river: { name: 'River', domain: 'river.com', site: 'river', by: 'invoice' },
  };
  var BANK_KEY = 'foxy.bank';

  /* A username as the person typed or pasted it, made into the one this exchange knows: the address's own domain and a
   * leading @ come off; a name at another domain is not one. '' for one that is not. */
  function bankUser(ex, raw) {
    var b = BANK[ex];
    if (!b || b.by !== 'address') return '';
    var t = String(raw || '').trim().replace(/^lightning:/i, '').replace(/^@+/, '');
    var at = t.lastIndexOf('@');
    if (at >= 0) {
      if (t.slice(at + 1).toLowerCase() !== b.domain) return '';
      t = t.slice(0, at);
    }
    t = t.toLowerCase();
    return /^[a-z0-9._-]{1,64}$/.test(t) && !/^[.]|[.]$/.test(t) ? t : '';
  }

  /* One GET to an exchange's address server, as `lookupLnurl` asks one: through the phone's Tor road, asked again on a
   * fresh circuit while it goes unanswered, the first answer the answer, inside one deadline. */
  function bankGet(url) {
    var REACH_MS = Number(FoxyWallet._reachMs) > 0 ? Number(FoxyWallet._reachMs) : 45000;
    if (bridged()) {
      // `foxyNoPace`: an address's server is no mint, and its answer times pace none (`askAgainWait`)
      var asked = askedAgain('', 'that address', function (circuit) {
        return FoxyWallet.nativeRequest({ endpoint: url, method: 'GET', foxyCircuit: circuit, foxyNoPace: true });
      }, newCircuitLabel, REACH_MS).then(function (won) { return won.got; });
      return withTimeout(asked, REACH_MS, 'that address');
    }
    return withTimeout(fetch(url), REACH_MS, 'that address').then(function (r) {
      if (!r.ok) {
        var e = new Error('That address did not answer (' + r.status + ').');
        /** @type {any} */ (e).status = r.status;
        throw e;
      }
      return r.json();
    });
  }

  /* The lookup: { state, ex, user, addr, min, max, why }, `state` one of
   *   found ...... the exchange answered with a payment record for this name (min and max in sats, 0 where it said none);
   *   missing .... it answered, and not with one: no account by that name.
   * Rejects for a name that is not one, with no route, when the person said no to contacting the address, and when no
   * answer came at all: that is a lookup to try again, not an answer. */
  function bankLookup(ex, raw) {
    var b = BANK[ex];
    if (!b || b.by !== 'address') return Promise.reject(new Error('That exchange is not paid to a username.'));
    var user = bankUser(ex, raw);
    if (!user) return Promise.reject(new Error('That is not a ' + b.name + ' username.'));
    try { assertRoute(); } catch (e) { return Promise.reject(e); }
    var addr = user + '@' + b.domain;
    var said = function (state, extra) { return Object.assign({ state: state, ex: ex, user: user, addr: addr, min: 0, max: 0, why: '' }, extra || {}); };
    console.log('[foxy] bank: looking up a ' + b.name + ' username');
    return bankGet('https://' + b.domain + '/.well-known/lnurlp/' + encodeURIComponent(user)).then(function (meta) {
      if (meta && meta.tag === 'payRequest' && meta.callback) {
        return said('found', {
          min: Number(meta.minSendable) > 0 ? Math.ceil(Number(meta.minSendable) / 1000) : 0,
          max: Number(meta.maxSendable) > 0 ? Math.floor(Number(meta.maxSendable) / 1000) : 0,
        });
      }
      return said('missing');
    }, function (e) {
      var msg = String((e && e.message) || e || '');
      // the person's own no to contacting the address is theirs, not the exchange's answer
      if (/did not allow Foxy/i.test(msg)) throw e;
      var status = Number(e && e.status) || 0;
      if (status >= 400 && status < 500) return said('missing');
      throw e;
    });
  }

  /* What BANK ACCOUNT remembers: { ex, user, addr } for an address, { ex } for River; null for nothing, or for what no
   * longer reads as one. */
  function bankSaved() {
    var v = load(BANK_KEY, null);
    if (!v || typeof v !== 'object' || !BANK[v.ex]) return null;
    var b = BANK[v.ex];
    if (b.by !== 'address') return { ex: v.ex, user: '', addr: '' };
    var user = bankUser(v.ex, v.user);
    return user ? { ex: v.ex, user: user, addr: user + '@' + b.domain } : null;
  }

  function bankSave(ex, raw) {
    var b = BANK[ex];
    if (!b) return false;
    if (b.by !== 'address') return save(BANK_KEY, { ex: ex, at: Date.now() });
    var user = bankUser(ex, raw);
    return user ? save(BANK_KEY, { ex: ex, user: user, at: Date.now() }) : false;
  }
