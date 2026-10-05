    /* ---- helpers, unchanged from the LNbits build ---------------------- */

    /* Tokens arrive wrapped in whatever the sending wallet uses: a cashu: URI,
     * the registered web+cashu:// scheme, or sitting in the query string of a
     * web wallet link. Unwrap first, then everything downstream sees a plain
     * token. */
    /* A name for a set of pieces, and whether history has seen that name.
     * Both for ecash taken with no route, where the mint cannot be asked
     * whether these proofs have been through here before (19-bill-split.js). */
    piecesFingerprint: function (list) { return piecesFingerprint(list); },
    txSeen: function (hash) { return txSeen(hash); },

    unwrap: function (text) {
      var t = String(text || '').trim();
      var m = /[?&]token=([A-Za-z0-9\-_=+/]+)/.exec(t);
      if (m) return decodeURIComponent(m[1]);
      t = t.replace(/^web\+cashu:\/\//i, '').replace(/^cashu:\/\//i, '').replace(/^cashu:/i, '');

      // Wallets share tokens inside a sentence, behind an emoji, or with a
      // line break after them. Anchoring on the start of the paste rejected
      // all of those, so take the token out of whatever it arrived in.
      var found = /cashu[AB][A-Za-z0-9\-_=+/]{20,}/.exec(t);
      if (found) return found[0];

      var req = /creq[AB][A-Za-z0-9\-_=+/]{20,}/.exec(t);
      if (req) return req[0];

      return t.trim();
    },

    classify: function (text) {
      var t = FoxyWallet.unwrap(text).replace(/^lightning:/i, '');
      if (/^ln(bc|tb|bcrt)\w{20,}$/i.test(t)) return 'invoice';
      if (/^lnurl1[02-9ac-hj-np-z]{10,}$/i.test(t)) return 'lnurl';
      if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(t)) return 'lnurl';
      if (/^https:\/\/\S+\/\.well-known\/lnurlp\/\S+$/i.test(t)) return 'lnurl';
      if (/^cashu[AB][A-Za-z0-9\-_=+/]{20,}$/.test(t)) return 'token';
      if (/^creq[A-Za-z0-9\-_=+/]{20,}$/.test(t)) return 'request';
      // not ours, but people paste them — naming them beats "not a token"
      if (/^fed1[a-z0-9]{20,}$/i.test(t)) return 'fedimint';
      if (/^lno1[a-z0-9]{20,}$/i.test(t)) return 'bolt12';
      // a Bitcoin address, by its own checksum (08-bitcoin-address.js)
      if (readBitcoinAddress(t)) return 'address';
      if (/^(npub|nprofile)1[a-z0-9]{20,}$/i.test(t)) return 'nostr';
      return null;
    },

    decodeLnurl: function (code) {
      var CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
      var t = String(code || '').trim().toLowerCase().replace(/^lightning:/i, '');
      var pos = t.lastIndexOf('1');
      if (pos < 1) throw new Error('That is not a valid LNURL.');
      var hrp = t.slice(0, pos);
      var data = t.slice(pos + 1);
      if (data.length < 6) throw new Error('That is not a valid LNURL.');

      var values = [];
      for (var i = 0; i < data.length; i++) {
        var d = CHARSET.indexOf(data.charAt(i));
        if (d === -1) throw new Error('That is not a valid LNURL.');
        values.push(d);
      }

      /* The last six characters are a checksum, and this used to skip them.
       *
       * bech32 exists to catch the transcription errors QR scans and retyping
       * produce. Without the check, a damaged LNURL decodes to whatever the
       * damaged bits say — a different host, silently — and the wallet asks
       * that host for an invoice. */
      function polymod(vals) {
        var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
        var chk = 1;
        for (var p = 0; p < vals.length; p++) {
          var top = chk >> 25;
          chk = ((chk & 0x1ffffff) << 5) ^ vals[p];
          for (var g = 0; g < 5; g++) if ((top >> g) & 1) chk ^= GEN[g];
        }
        return chk;
      }
      var expanded = [];
      for (var j = 0; j < hrp.length; j++) expanded.push(hrp.charCodeAt(j) >> 5);
      expanded.push(0);
      for (var j2 = 0; j2 < hrp.length; j2++) expanded.push(hrp.charCodeAt(j2) & 31);
      if (polymod(expanded.concat(values)) !== 1) {
        throw new Error('That LNURL is damaged \u2014 its checksum does not match. '
          + 'Scan or paste it again.');
      }

      var bits = 0, value = 0, out = [];
      for (var k = 0; k < values.length - 6; k++) {
        value = (value << 5) | values[k];
        bits += 5;
        while (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xff); }
      }
      var url = out.map(function (b) { return String.fromCharCode(b); }).join('');
      if (!/^https?:\/\//i.test(url)) throw new Error('That LNURL did not decode to an address.');
      // the same transport rule mint URLs follow, read by a URL parser as they
      // are: an .onion is fine over http, nothing else is, because the callback
      // is asked for an invoice to pay
      var parsed;
      try { parsed = new URL(url); } catch (e) { throw new Error('That LNURL did not decode to an address.'); }
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && /\.onion$/i.test(parsed.hostname))) {
        throw new Error('That LNURL points at an insecure address (' + parsed.hostname + ').');
      }
      return url;
    },

    /* What that mint holds on this device, for deciding where to pay from. */
    balanceAt: function (url) {
      return sumProofs(load(K.proofs + '.' + url, []));
    },

    /* Why this mint URL is unacceptable, or null if it is fine. */
    mintProblem: function (u) { return mintUrlProblem(u); },

    amountOf: function (bolt11) {
      var m = /^ln(?:bc|tb|bcrt)(\d+)([munp])1/i.exec(
        String(bolt11 || '').trim().replace(/^lightning:/i, ''));
      if (!m) return null;
      var n = Number(m[1]);
      var u = m[2].toLowerCase();
      var btc = u === 'm' ? n / 1e3 : u === 'u' ? n / 1e6 : u === 'n' ? n / 1e9 : n / 1e12;
      // an amount too large to count exactly is no amount: a crafted invoice with
      // a few hundred digits read as Infinity (tests/fuzz-parsers.js)
      var sats = Math.round(btc * 1e8);
      return Number.isSafeInteger(sats) ? sats : null;
    },

    /* An invoice's amount in millisats, exactly, or null.
     *
     * amountOf rounds to whole sats, which is right for showing an amount and
     * wrong for deciding whether to pay one: 10.4 sats reads as 10. Worked in
     * integers from the invoice's own digits. A pico amount must be a multiple
     * of 10 (BOLT11); one that is not, or one too large to count exactly, is
     * null. An invoice with no multiplier (whole bitcoin) is null too, as in
     * amountOf. */
    msatOf: function (bolt11) {
      var m = /^ln(?:bc|tb|bcrt)(\d+)([munp])1/i.exec(
        String(bolt11 || '').trim().replace(/^lightning:/i, ''));
      if (!m) return null;
      var n = Number(m[1]);
      if (!Number.isSafeInteger(n)) return null;
      var u = m[2].toLowerCase();
      if (u === 'p') return n % 10 === 0 ? n / 10 : null;
      var msat = n * (u === 'm' ? 1e8 : u === 'u' ? 1e5 : 100);
      return Number.isSafeInteger(msat) ? msat : null;
    },

    /* An invoice's description hash (its h field), as hex, or null when it has
     * none. Read from the bech32 data part: a 35-bit timestamp, then tagged
     * fields (a 5-bit type, a 10-bit length, the data) up to the 520-bit
     * signature. The checksum is the mint's to check; it refuses a damaged
     * invoice before paying anything. */
    descriptionHashOf: function (bolt11) {
      var CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
      var t = String(bolt11 || '').trim().toLowerCase().replace(/^lightning:/, '');
      var sep = t.lastIndexOf('1');
      if (sep < 1 || t.length - sep < 7) return null;
      var words = [];
      for (var i = sep + 1; i < t.length - 6; i++) {
        var v = CHARSET.indexOf(t.charAt(i));
        if (v < 0) return null;
        words.push(v);
      }
      var end = words.length - 104;
      var at = 7;
      while (at + 3 <= end) {
        var type = words[at], len = words[at + 1] * 32 + words[at + 2];
        var start = at + 3;
        if (start + len > end) return null;
        if (type === 23) {                         // h: 52 words, 256 bits and 4 of padding
          if (len !== 52) return null;
          var value = 0, bits = 0, out = [];
          for (var k = start; k < start + len; k++) {
            value = (value << 5) | words[k];
            bits += 5;
            while (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xff); }
            value &= (1 << bits) - 1;
          }
          return out.slice(0, 32).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        }
        at = start + len;
      }
      return null;
    },

    /* Returns '' when the text will not fit.
     *
     * A locked token carries a whole spend condition in every proof secret —
     * pubkey, refund key, locktime — so it can run past what the largest QR
     * version holds. Better to return nothing and let the screen offer copy
     * and share than to throw from a render. Dropping the correction level
     * buys roughly a third more room before giving up. */
    qr: function (text, opts) {
      var o = opts || {};
      var raw = String(text || '');
      if (!raw) return '';
      // upper case packs into QR's denser alphanumeric mode; readers lower-case these
      var bech32 = /^(ln(bc|tb|bcrt)|lnurl1|ur:)/i.test(raw);
      var payload = bech32 ? raw.toUpperCase() : raw;
      var q = null;
      var levels = o.ecc ? [o.ecc] : ['M', 'L'];
      for (var li = 0; li < levels.length; li++) {
        try {
          var t = window.qrcode(0, levels[li]);
          t.addData(payload);
          t.make();
          q = t;
          break;
        } catch (e) { q = null; }
      }
      if (!q) {
        console.warn('[foxy] too long for a QR:', raw.length, 'chars');
        return '';
      }
      var n = q.getModuleCount();
      /* Four modules, which is what the spec asks for.
       *
       * It was two. A quiet zone is how a reader finds the code's edge, and
       * half of one on a dark screen is a code some cameras will not lock on
       * to at all — a phone's camera would not read one that copy-and-paste took
       * fine. The four modules cost nothing on screen: the box
       * already has padding of its own, and that padding is reduced by the same
       * amount, so the code itself ends up larger rather than smaller. */
      var quiet = o.quiet == null ? 4 : o.quiet;
      var size = n + quiet * 2;
      var d = '';
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (q.isDark(r, c)) d += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
        }
      }
      var bg = o.bg === null ? '' :
        '<rect width="' + size + '" height="' + size + '" fill="' + (o.bg || '#fff') + '"/>';
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size +
        '" shape-rendering="crispEdges">' + bg +
        '<path d="' + d + '" fill="' + (o.fill || '#000') + '"/></svg>');
    },

    myAddress: function (set) {
      if (set !== undefined) {
        try { localStorage.setItem('foxy.myaddr', String(set || '')); } catch (e) {}
        return String(set || '');
      }
      try { return localStorage.getItem('foxy.myaddr') || ''; } catch (e) { return ''; }
    },

    tag: function (hash, meta) {
      if (!hash) return;
      var all = load('foxy.txmeta', {});
      all[hash] = Object.assign({}, all[hash] || {}, meta || {});
      trimKeptTokens(all);
      var keys = Object.keys(all);
      if (keys.length > 300) {
        /* The oldest note with no token in it. A sent token's text can be its
         * only copy until it is claimed (forgetClaimedToken clears it then);
         * the oldest note used to go, whatever it held. */
        /* And a note somebody wrote goes last of all: it is the card's
         * title now, and the oldest entry with neither goes before any
         * entry with one. */
        var spare = -1;
        for (var i = 0; i < keys.length; i++) {
          var m0 = all[keys[i]];
          if (m0 && m0.token) continue;
          if (spare < 0) spare = i;
          if (!(m0 && m0.note)) { spare = i; break; }
        }
        if (spare >= 0) delete all[keys[spare]];
      }
      save('foxy.txmeta', all);
    },

    tagsFor: function (hash) { return load('foxy.txmeta', {})[hash] || {}; },

    book: function () { return load('foxy.contacts', []); },

    /* What a payment consumed and produced, most recent first.
     *
     * For working out where money went when something looks wrong. The
     * outputs of a recent payment are live change and also in the proof list;
     * the inputs are spent. */
    auditTrail: function (hash) {
      var list = load(K.audit, []);
      if (!hash) return list;
      return list.filter(function (e) { return e && e.hash === hash; });
    },

    clearAudit: function () { save(K.audit, []); return true; },

    /* Clear the local history. The mint keeps none, so this only removes what
     * this phone recorded — it does not touch any money. */
    /* Clear the history, and everything that only existed to go with it.
     *
     * The notes went on living after the history did: each ecash send's note
     * holds the token itself, so "clear history" left sent tokens readable on
     * the phone with nothing showing they were there. The notes go too now.
     * The last token made (outtoken) stays unless forgetToken is set — the app
     * asks first when a sent token is still unclaimed (tokensNotClaimed). */
    clearHistory: function (opts) {
      /* What is left is one row per mint: the balance carried forward. The
       * history screen audits the balance back to nothing, and a list that
       * starts after the money arrived would say DOES NOT ADD UP for ever. Written as an ordinary settled receive with the
       * memo `opening`, which the screen names and never announces. */
      var at = Math.floor(Date.now() / 1000);
      var opening = [];
      piles().forEach(function (p) {
        if (p.unit !== 'sat') return;
        var sats = sumProofs(proofs(p.mint, 'sat'));
        if (!(sats > 0)) return;
        var row = { at: at, mint: String(p.mint || '').replace(/\/+$/, ''), dir: 'in', sats: sats, feeSats: 0,
                    settled: true, state: 'success', memo: 'opening', hash: 'opening-' + at + '-' + opening.length };
        if (rateNow()) row.rate = rateNow();
        opening.push(row);
      });
      save(K.log, opening);
      // the audit trail is the same record in more detail; it goes too
      save(K.audit, []);
      save('foxy.txmeta', {});
      if (opts && opts.forgetToken) {
        try { localStorage.removeItem(K.outtok); } catch (e) {}
      }
      return true;
    },

    /* Sent tokens whose text is still on this phone: the notes and the last token. */
    _sentTokens: function () {
      var seen = {};
      var out = [];
      var meta = load('foxy.txmeta', {});
      Object.keys(meta).forEach(function (hash) {
        var t = meta[hash] && meta[hash].token;
        if (typeof t === 'string' && t && !seen[t]) { seen[t] = true; out.push({ hash: hash, token: t }); }
      });
      var last = load(K.outtok, null);
      if (last && last.token && !seen[last.token]) out.push({ hash: last.hash || null, token: last.token });
      return out;
    },

    /* Sent tokens the mint does not report as claimed — or that cannot be asked
     * about from here (another mint, no connection). Resolves
     * [{ hash, sats, mint }]. Used to warn before forgetting them. */
    tokensNotClaimed: function () {
      var list = FoxyWallet._sentTokens();
      if (!list.length) return Promise.resolve([]);
      var here = String(mintUrl || '').replace(/\/+$/, '');
      var w = wallet;
      return list.reduce(function (chain, e) {
        return chain.then(function (acc) {
          var info = FoxyWallet.tokenInfo(e.token);
          if (!info || !info.proofs.length) return acc;
          var row = { hash: e.hash, sats: info.sats, mint: info.mint };
          if (!w || !routeOpen() || String(info.mint || '').replace(/\/+$/, '') !== here) return acc.concat([row]);
          // each token on its own circuit, as the token screen asks
          return statesOf(onCircuit(w, e.hash ? 'token:' + e.hash : null), info.proofs).then(function (states) {
            return states.every(function (st) { return st === 'SPENT'; }) ? acc : acc.concat([row]);
          }, function () { return acc.concat([row]); });
        });
      }, Promise.resolve(/** @type {Array<{hash: *, sats: ?number, mint: string}>} */ ([])));
    },

    /* A sent token the mint has reported claimed: its text goes.
     *
     * A token is bearer money until someone claims it, and a readable record of
     * what was sent afterwards. Once claimed, the token's text is dropped from
     * its note, its proofs from its audit record, and the last-token record if
     * it is that one. Amount, time and mint stay in the history.
     *
     * Asks the mint nothing: the token screen's watch has just heard it claimed.
     * Every connect used to ask about each sent token still on file, from the
     * sender's own exit, which told the mint who paid whom once the receiver
     * redeemed it. Resolves true when there was text to forget. */
    forgetClaimedToken: function (token) {
      var text = String(token || '');
      // a history entry's hash names its token
      if (text && !/^cashu/i.test(text)) text = tokenTextFor(text);
      if (!text) return false;
      var info = FoxyWallet.tokenInfo(text);
      var found = false;
      var meta = load('foxy.txmeta', {});
      /* The text is kept, under another name.
       *
       * `token` means "not claimed yet": it is what makes a payment read as
       * not yet taken and offers RECLAIM. That goes. But somebody who says
       * they never got their money can still be shown the very token: they
       * scan it with any Cashu wallet and are told it has already been
       * claimed. A claimed token is spent — nobody can do anything with it —
       * so keeping it costs nothing but room, and room is what
       * `trimKeptTokens` looks after. */
      Object.keys(meta).forEach(function (h) {
        if (meta[h] && meta[h].token === text) {
          meta[h].kept = text;
          delete meta[h].token;
          found = true;
        }
      });
      if (found) { trimKeptTokens(meta); save('foxy.txmeta', meta); }
      var secrets = {};
      ((info && info.proofs) || []).forEach(function (p) { if (p && p.secret) secrets[p.secret] = true; });
      if (Object.keys(secrets).length) {
        save(K.audit, load(K.audit, []).map(function (a) {
          if (!a || a.kind !== 'token') return a;
          var mine = (a.inputs || []).some(function (p) { return p && secrets[p.secret]; });
          if (mine) found = true;
          return mine ? Object.assign({}, a, { inputs: [] }) : a;
        }));
      }
      var last = load(K.outtok, null);
      if (last && last.token === text) {
        try { localStorage.removeItem(K.outtok); } catch (x) {}
        found = true;
      }
      if (found) console.log('[foxy] forgot the text of a claimed token');
      return found;
    },

    /* Does this token get an animated QR code? More than two proofs, as
     * cashu.me decides, or a string long enough to make a dense code. */
    /* Which tokens animate, as cashu.me decides: more than two proofs, or a
     * long one. A compatibility rule, and left alone — `qrTooDense` below asks
     * a different question, about what a camera can resolve, and the receive
     * screen is where that one is asked. */
    tokenQrAnimates: function (token) {
      var info = FoxyWallet.tokenInfo(token);
      return !!(info && ((info.proofs || []).length > 2 || String(token).length > 400));
    },

    /* Would one code be too fine to read on a small phone?
     *
     * Asked in modules, not characters, because modules are what a camera has
     * to resolve. A count is the QR's own answer to how much it was given, and
     * the box it goes in is a fixed size: the receive screen on an iPhone XS is
     * 240 points across, so 93 modules is 2.6 points each and 65 is 3.7. Most
     * phone cameras want about three, and more at an angle or in poor light.
     *
     * This is what made a request carrying both an onion address and a Nostr
     * profile unreadable while a token beside it scanned fine — 461 characters
     * against 209, and the difference lands entirely in the module count.
     *
     * 80 modules is the line: 3 points each in that box, with the smallest
     * phone Foxy supports taken as the case to satisfy. Above it the code is
     * animated instead, which is several sparse frames rather than one dense
     * one, and Foxy has had that for long tokens all along. */
    qrTooDense: function (text) {
      var src = FoxyWallet.qr(String(text || ''));
      if (!src) return true;               // it would not fit in one code at all
      /* The svg is a percent-encoded data url, so the viewBox is read back out
       * of it decoded rather than matched through the encoding. */
      var svg = '';
      try { svg = decodeURIComponent(String(src).replace(/^data:image\/svg\+xml;utf8,/, '')); }
      catch (e) { return true; }
      var m = /viewBox="0 0 (\d+)/.exec(svg);
      var modules = m ? Number(m[1]) : 0;
      return !(modules > 0) || modules > 80;
    },

    /* Frames of an animated QR code for `text` (06-animated-qr.js):
     * { count, next() }, each next() the following frame's text. */
    animatedQr: function (text, maxFragment) { return urEncoder(text, maxFragment); },

    /* The node that signed an invoice (invoicePayee), for the tests. */
    invoiceSigner: function (bolt11) { return invoicePayee(bolt11); },

    /* Was this invoice made by the mint this wallet pays from? True only when
     * its signing node is that mint's known node (05-paying-this-mint.js). */
    invoiceFromThisMint: function (bolt11) {
      var node = mintUrl ? mintNodeOf(mintUrl) : null;
      return !!(node && invoicePayee(bolt11) === node);
    },

    /* Back in the foreground: the seed read now, while the person is looking,
     * so nothing later in the visit asks for Face ID. The phone forgets the seed
     * as Foxy leaves (SeedVault.forgetNativeSeed); the next action that needed
     * it asked at that moment, and a REDEEM after pasting a token from another
     * app stopped for Face ID. seedStatus reads it
     * through SeedVault.seedForSecrets and keeps it until Foxy leaves again.
     * Resolves true when the seed is there. */
    openSeedForVisit: function (opts) {
      if (!bridged() || !nativeSeedKnown) return Promise.resolve(false);
      var arriving = !!(opts && opts.arriving);
      /* Not on an empty wallet. Face ID once per visit is what the design calls
       * for, but a wallet with nothing in it has nothing to unlock, and asking
       * anyway is friction in front of somebody who has not started yet. The first money arriving makes it worth asking. */
      /* Unless they have asked for it.
       *
       * The empty-wallet exemption is for somebody who has not chosen yet —
       * friction in front of a wallet with nothing in it. Once they pick Face
       * ID on the SECURE FOXY card that is no longer who they are: they asked
       * for Face ID on every return to the foreground, so they get it, with a
       * balance or without one. */
      var chose = FoxyWallet.secureChoice && FoxyWallet.secureChoice() === 'device';
      if (!arriving && !chose && !sumProofs(proofs())) return Promise.resolve(false);
      /* Money arriving is that moment, and it is the exception to the line
       * above: taking a token derives its secrets from the seed, so the seed
       * is read whatever this decides. On a wallet that was still empty the
       * test above had declined to open it on the way in, so the ask landed
       * in the middle of the claim instead — a first receive put
       * Face ID up four and a half seconds after the paste, over the
       * confirmation that was arriving behind it.
       * Asked here, it belongs to the tap that started the receive.
       *
       * Never while Foxy is hidden: iOS puts up no prompt then, and a claim a
       * watcher makes in the background has its own read on the way out. */
      if (arriving && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return Promise.resolve(false);
      }
      return nativeJson('seedStatus', {}, PERSON_MS).then(function (j) { return j.exists === true; },
        function () { return false; });
    },

    /* A Cashu payment request (NUT-18) for `sats` at the mint this wallet is
     * on, for a payer to answer with ecash instead of Lightning. No
     * description, and single use, so it says only the amount, the mint and,
     * given `deliverTo` (an onion address from openInbox), where the payer's
     * wallet posts the payment. Without one, the payer's wallet shows a token
     * and it is scanned here. With no amount the payer chooses it. `purpose`
     * is told back when it is paid ('receive', or a split's 'split:<n>').
     * '' when it cannot be made. */
    paymentRequest: function (sats, opts) {
      try {
        var CT = window.CashuTS;
        if (!CT || !CT.PaymentRequest || !mintUrl) return '';
        var o = opts || {};
        var id = new Uint8Array(4);
        (window.crypto || window.msCrypto).getRandomValues(id);
        var n = Math.round(Number(sats));
        var mint = String(mintUrl).replace(/\/+$/, '');
        /* Nostr FIRST, then the onion.
         *
         * Order is not decoration here: cashu.me pays the first transport in
         * the list it recognises, and it recognises both. Put the onion first
         * and a browser takes it, cannot resolve it, and — having already
         * swapped the ecash at the mint — loses the money
         * (tools/live/production.md). Put Nostr first and the same wallet takes
         * the one it can actually reach.
         *
         * Foxy is unaffected by the order: deliveryFor
         * (07-request-delivery.js) looks for an onion before it looks for a
         * Nostr target, whatever position they are in, so a payment between
         * two Foxys still goes phone to phone and leaves nothing on a relay. */
        var to = o.deliverTo && typeof o.deliverTo === 'object' ? o.deliverTo : {};
        var transport = [];
        if (/^nprofile1[02-9ac-hj-np-z]{20,}$/.test(to.nostr)) {
          transport.push({ type: CT.PaymentRequestTransportType.NOSTR, target: to.nostr,
                           tags: [['n', '17']] });
        }
        if (/^http:\/\/[a-z2-7]{55}d\.onion\/[0-9a-f]{16,64}$/.test(to.onion)) {
          transport.push({ type: CT.PaymentRequestTransportType.POST, target: to.onion, tags: [] });
        }
        /* A key to lock the ecash to (NUT-11 through NUT-18's nut10). The
         * payer's wallet then mints proofs only this phone can spend, so a
         * token taken off the air — or off a relay — is worthless to whoever
         * took it. `o.lock` false turns it off — for a payer with no network,
         * who cannot mint locked proofs at all. */
        /* Taken from the primed pool, never made here.
         *
         * It was a fresh random key, made in this function. That is a key the
         * twelve words cannot rebuild, so ecash locked to it on a phone that is
         * lost is money nobody can ever move. The keys are derived from the seed
         * now, at NUT-13's path, by the phone (Foxy/Keychain/P2PK.swift) — and
         * this function is synchronous, called in the middle of a render, so
         * what it can do is take one the phone derived earlier. `primeLocks`
         * fills the pool and `railRequest` waits on it.
         *
         * An empty pool sends the request UNLOCKED. Not a random key: a random
         * key is the whole bug, and falling back to one here would put it back
         * on the one path nobody would think to look at again. */
        /* Only where the mint will honour it (NUT-11).
         *
         * Decided here, before the request goes out, rather than by letting a
         * payer try and fail: a lock a mint does not understand would have the
         * payer's swap refused with the money half moved. A mint without it
         * gets an unlocked request, which is what every request was until now.
         */
        /* `needLocal()`, not `need()`: reading what the mint said sends nothing,
         * and `need()` asserts the route, so an offline phone got canLock
         * false and asked to be paid unlocked — which is the one payment an
         * offline phone then refuses to take. */
        var canLock = false;
        try {
          var nuts = (needLocal().getMintInfo() || {}).nuts || {};
          var n11 = nuts['11'] || nuts[11];
          canLock = !!n11 && (n11.supported === undefined || n11.supported === true);
        } catch (e) { canLock = false; }
        /* The index is taken and the row is filed before the lock goes into the
         * request.
         *
         * It was the other way round, and the write threw its refusal away, so
         * a full store sent out a request naming a key this phone could not
         * open — and the payer's money is destroyed by paying it, because their
         * wallet swaps into proofs locked to that key before it delivers
         * anything (keepLockKey). Written first, the request can
         * only ever carry a lock this phone kept.
         *
         * A refusal drops the lock, not the request. Unlocked is what every
         * request was before requests were locked: worth less — a token taken
         * off the air is worth something to whoever took it, and the swap can no
         * longer be held back from the mint — and worth everything beside a request
         * nobody can answer. Caught here rather than left to the catch below,
         * which returns '' — and '' is a receive screen whose QR never
         * appears. */
        var lock;
        if (o.lock !== false && canLock) {
          try {
            var pub = takeLockKey(hexOf(id));
            if (/^0[23][0-9a-f]{64}$/i.test(pub)) lock = { kind: 'P2PK', data: pub, tags: [] };
            else console.warn('[foxy] no lock key was primed for this request, so it goes out unlocked');
          } catch (e) {
            console.warn('[foxy] the key for this request could not be kept, so it goes out unlocked:',
                         (e && e.message) || e);
            lock = undefined;
          }
          // and fill the pool behind it, so the next request has one
          primeLockPool();
        }
        /* A request that names dollars and no sats, for a phone with no route.
         *
         * Its bitcoin price may be hours old, so it does not do the conversion:
         * it says what it wants in dollars and what its own price was, and the
         * phone that has a current one works out the sats and offers them back
         * (`tapQuote`). Nothing has left anybody at that point, which is why the
         * order is this way round.
         *
         * It rides in the description, which is where NUT-18 puts words for a
         * person, and it is written to be both: another wallet shows "$5.00" and
         * lets the payer choose an amount, which is honest, and Foxy reads the
         * rest. A request with a sat amount carries none of this. */
        var says = '';
        if (Number(o.usd) > 0 && !(n > 0)) {
          says = '$' + (Number(o.usd) / 100).toFixed(2)
            + ' \u00b7 foxy1 usd=' + Math.round(Number(o.usd));
          /* The asking phone's own price goes only if the caller offers it, and
           * the offline receive does not offer it. It is no use to the payer —
           * the comparison happens on this phone, against what this phone last
           * saw — and "I last saw $83,481, two hours ago" tells a stranger when
           * this phone was last online. The marker itself has to ride either
           * way, because it is what carries the dollar amount. */
          if (Number(o.rate) > 0 && Number(o.rateAt) > 0) {
            says += ' rate=' + Math.round(Number(o.rate)) + ' at=' + Math.round(Number(o.rateAt) / 1000);
          }
        }
        var text = new CT.PaymentRequest(transport, hexOf(id), n > 0 ? n : undefined, 'sat',
          [mint], says || undefined, true, lock).toEncodedRequest();
        noteOpenRequest(hexOf(id), n > 0 ? n : 0, mint, o.purpose);
        return text;
      } catch (e) {
        return '';
      }
    },

    /* ---- the price leg, before any money ---------------------------------
     *
     * A receiver with no route asks in dollars, because its own bitcoin price
     * may be hours old and a wrong conversion is a wrong amount of money. The
     * payer, who has a current one, says what its price is and what that makes
     * of the amount; the receiver compares it with what it last saw and agrees
     * or does not. Only then does a request with a sat amount go back, and only
     * then is anything paid — so the sats never leave the payer until the
     * receiver has agreed to the number.
     *
     * The receiver does not have to trust the payer's price. It is told the
     * difference and shown the sats, and it agrees to the sats. A payer who lies
     * about the price is lying about how many sats they are offering, which is
     * the number on the screen. */

    /* Is this a request that asks in dollars and leaves the conversion open? */
    asksInDollars: function (req) {
      return !!(req && Number(req.usd) > 0 && !(Number(req.sats) > 0));
    },

    /* The payer's answer to one: this phone's price, when it saw it, and the
     * sats that makes. Null when there is no price to answer with — a payer
     * without one has nothing to offer and should not pretend. */
    quoteFor: function (req) {
      if (!FoxyWallet.asksInDollars(req)) return null;
      var mine = FoxyWallet.lastPrice();
      if (!mine.rate) return null;
      var sats = Math.round((Number(req.usd) / 100) / mine.rate * 1e8);
      if (!(sats > 0)) return null;
      return { id: String(req.id || ''), usd: Number(req.usd), rate: mine.rate,
               at: mine.at, ageMs: mine.ageMs, sats: sats };
    },

    /* The payer's other answer: "I have no route, and my sats are at this mint."
     *
     * Ecash is only ever worth what its own mint will honour, so a phone with
     * no route and no balance at the mint a request names cannot answer it at
     * all: it cannot melt, it cannot move, it cannot even swap. What it can do
     * is say so — and the phone that *does* have a route can work out what it
     * costs to bring that money home and ask for it.
     *
     * Null when there is nothing to say: a route makes this the payer's own
     * problem to solve (`transferQuote`), the same mint makes it no problem,
     * and no balance there makes it unanswerable. */
    stuckAtMint: function (req) {
      if (!req || !FoxyWallet.privacy || !FoxyWallet.privacy().offline) return null;
      var theirs = String((req.mints || [])[0] || '').replace(/\/+$/, '');
      var mine = String(mintUrl || '').replace(/\/+$/, '');
      if (!theirs || !mine || theirs === mine) return null;
      var held = FoxyWallet.balanceAt(mine);
      if (!(held > 0)) return null;
      /* What it can hand over, which is less than what it holds at a mint
       * that charges: the receiver's fee for taking the pieces is the
       * payer's, and is added to whatever is asked. Saying the whole pile
       * had the receiver's check pass an amount this phone's own send then
       * refused — asked 516 of a payer holding 516, "that needs 517"
       * (tools/live/offline-cross-scenarios.js `edge-carry`). */
      var have = held;
      try { if (wallet) have = Math.max(0, held - swapFeeFor(wallet, proofs(mintOf(wallet)))); } catch (e) { have = held; }
      if (!(have > 0)) return null;
      return { id: String(req.id || ''), mint: mine, have: have,
               sats: Math.round(Number(req.sats) || 0) };
    },

    /* The receiver's answer to that: what the payer must send, at their mint,
     * for `sats` to end up here.
     *
     * Every cost is on the payer — the route home, and both mints' fees for
     * spending pieces neither has issued yet — because the receiver named an
     * amount and the amount is what they get. Nothing is promised until the
     * quote comes back from two real mints, and nothing has moved when it does.
     *
     * The plan comes back with it: the receiver runs it once the payer's ecash
     * is swapped in, which is the moment there is no longer any risk in this at
     * all. */
    crossTerms: function (stuck, sats) {
      var want = Math.round(Number(sats) || 0);
      var from = String((stuck && stuck.mint) || '').replace(/\/+$/, '');
      var to = String(mintUrl || '').replace(/\/+$/, '');
      if (!from) return Promise.reject(new Error('They did not say which mint they are at.'));
      if (!to) return Promise.reject(new Error('No mint is connected.'));
      if (from === to) return Promise.reject(new Error('That is the mint this phone is on.'));
      if (!(want > 0)) return Promise.reject(new Error('Ask for an amount above zero.'));
      return FoxyWallet.transferQuote(from, want, { to: to, quoteOnly: true }).then(function (plan) {
        var extra = Math.max(0, Number(plan.feeSats) || 0) + Math.max(0, Number(plan.inPadSats) || 0);
        var ask = want + extra;
        if (stuck && Number(stuck.have) > 0 && ask > Number(stuck.have)) {
          var short = /** @type {any} */ (new Error(
            'Bringing ' + want + ' sats here from ' + from.replace(/^https?:\/\//, '')
            + ' costs ' + extra + ' on top, and they hold ' + stuck.have + ' there.'));
          short.foxyAsk = ask;
          short.foxyHave = Number(stuck.have);
          throw short;
        }
        console.log('[foxy] cross-mint: asking ' + ask + ' at ' + from.replace(/^https?:\/\//, '')
                    + ' so ' + want + ' lands here (' + extra + ' of fees, all theirs)');
        return { from: from, to: to, net: want, ask: ask, feeSats: extra, plan: plan };
      });
    },

    /* What the receiver makes of that quote: the sats offered, and how the
     * payer's price compares with the last one this phone saw. `theirs` is the
     * quote as it arrived; everything else is worked out here, from what this
     * phone knows, so a payer cannot dress up the comparison.
     *
     * `differsPct` is signed: positive means their price is higher than the one
     * this phone last saw, which is the direction that makes the amount fewer
     * sats. Null when this phone has never seen a price, and the person is then
     * agreeing to a number with nothing to weigh it against — which the screen
     * has to say. */
    /* The payment reader, for the tests: what `_requestPaid` does first. */
    readPayment: function (body) { return readPayment(body, mintUrl); },

    readQuote: function (text) {
      var got = null;
      try { got = JSON.parse(String(text || '')); } catch (e) { return null; }
      if (!got || typeof got !== 'object') return null;
      var sats = Math.round(Number(got.sats));
      var rate = Number(got.rate);
      if (!(sats > 0) || !(rate > 0)) return null;
      var mine = FoxyWallet.lastPrice();
      var differsPct = mine.rate ? ((rate - mine.rate) / mine.rate) * 100 : null;
      return {
        id: String(got.id || ''), usd: Math.round(Number(got.usd)) || 0,
        sats: sats, theirRate: rate,
        myRate: mine.rate, myRateAgeMs: mine.rate ? mine.ageMs : 0,
        differsPct: differsPct,
      };
    },

    /* The ways this phone can be paid a request, open until closeInbox:
     * { onion: 'http://<56>.onion/<path>', nostr: 'nprofile1...' }. Either may
     * be missing. Rejects when neither could be made — without Tor (Orbot, or
     * not connected yet) — and the request then goes without any, which means
     * the payer shows a token and it is scanned back. */
    openInbox: function () {
      return bridgeAsk('inboxOpen', {}, 25000).then(function (text) {
        var got = null;
        try { got = JSON.parse(String(text)); } catch (e) {}
        if (!got || typeof got !== 'object') throw new Error('No address.');
        var out = {};
        if (/^http:\/\/[a-z2-7]{55}d\.onion\/[0-9a-f]{16,64}$/.test(got.onion)) out.onion = got.onion;
        if (/^nprofile1[02-9ac-hj-np-z]{20,}$/.test(got.nostr)) out.nostr = got.nostr;
        if (!out.onion && !out.nostr) throw new Error('No address.');
        return out;
      });
    },

    /* Done with the address. `holdSecs` keeps it answering after the screen
     * has gone, because a payment can be on the wire towards it — the tap that
     * falls back to the onion is exactly that case. The screen does not wait:
     * the phone hands out a fresh warm address at once. */
    closeInbox: function (holdSecs) {
      var hold = Math.min(Math.max(Number(holdSecs) || 0, 0), 180);
      return bridgeAsk('inboxClose', { hold: hold }, 5000).catch(function () {});
    },

    /* Keys for the next few payment requests, derived by the phone and kept
     * ready (07-request-delivery.js).
     *
     * `paymentRequest` is synchronous and cannot wait for the phone, so whoever
     * is about to show a request waits here first — `railRequest` does it
     * alongside `openInbox`. Resolves with how many are ready, and never
     * rejects: no keys means the request goes out unlocked, which is what every
     * request was before requests were locked and is money that still arrives.
     *
     * It reads the seed on the phone, which the first time may be Face ID. That
     * is the right place for it: the screen this is called from is a screen
     * money is about to arrive on, and taking that money reads the seed anyway.
     *
     * And it gives up waiting after LOCK_PRIME_WAIT. What is behind this call is
     * the QR code on the receive screen, which shows nothing until it resolves —
     * so a phone whose keychain is slow to answer would leave somebody looking
     * at an empty square for as long as the bridge's own timeout, which is
     * minutes. The refill carries on in the background and the next request
     * takes what it brought; this one goes out unlocked. A code somebody can
     * scan beats a lock they never see. */
    primeLocks: function () {
      var filling = primeLockPool();
      return new Promise(function (ok) {
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          console.warn('[foxy] the phone has not derived lock keys yet; this request goes out unlocked');
          ok(lockPool().length);
        }, LOCK_PRIME_WAIT);
        var end = function (n) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          ok(n);
        };
        filling.then(end, function () { end(lockPool().length); });
      });
    },

    /* Told { stage, sats, id, purpose } as a payment for a request this page
     * made arrives ('arrived'), is redeemed ('paid') or is not ('failed'). */
    onRequestPaid: function (fn) {
      if (typeof fn === 'function') FoxyWallet._requestPaidListeners.push(fn);
    },
    /** @type {Array<function(any): void>} */
    _requestPaidListeners: [],
    /** @type {Object<string, boolean>} */
    _requestsBeingPaid: {},

    /* A payment posted to this phone's onion address (FoxyBridge+Delivery.swift):
     * checked against the request, redeemed at the mint, and the payer told
     * how that went. The request is single use: once paid, it is closed. */
    /* Ecash that arrived and was never claimed, tried again.
     *
     * Run on every connect, after the other sweeps. A payment written down by
     * `_requestPaid` and not claimed — the app closed, the mint was not there,
     * anything — is still money, and this is what goes and gets it. The lock
     * key is found by the lock itself, so it does not matter that the request
     * it belonged to is long forgotten. */
    claimUnclaimed: function () {
      /* One walk at a time, shared. A connect starts one and so does every
       * screen money can leave from; the second, waiting its turn behind the
       * first, was then refused by the mint for ecash the first had just
       * taken. */
      if (claimingLate) return claimingLate;
      var all = unclaimed(), ids = Object.keys(all);
      if (!ids.length) return Promise.resolve(0);
      console.log('[foxy] a payment for a request was never claimed:', ids.length, 'waiting');
      var took = 0;
      /* Where the phone is, to come back to. Ecash from another mint is
       * claimed at that mint, and the claim used to leave the wallet there:
       * a receiver that took a payment to carry home, and claimed it late,
       * opened on the payer's mint from then on
       * (tools/live/offline-cross-scenarios.js `one-side-b`). A visit, now. */
      var startedAt = canonicalMint(mintUrl || '');
      var carried = false;
      /* The ones taken on trust go first. They are the only rows somebody
       * else can still spend, so they do not wait behind ecash that is locked
       * to this phone and safe where it is. */
      ids.sort(function (a, b) {
        return (all[b] && all[b].trusted ? 1 : 0) - (all[a] && all[a].trusted ? 1 : 0);
      });
      var walk = ids.reduce(function (chain, id) {
        return chain.then(function () {
          var one = all[id];
          if (!one || typeof one.token !== 'string') { dropUnclaimed(id); return null; }
          /* Less anything already signed away from it. A row that gave pieces
           * up offline holds only the rest; one that could not be rewritten
           * when they went is put right here, before the mint is asked. */
          var claimText = withoutHandedOn(one.token);
          if (!claimText) { dropUnclaimed(id); dropLockKey(id); return null; }
          /* What is left of it is worth no more than this mint charges to
           * swap it in. A payment paid out of piece by piece can leave a
           * single sat behind, and at a mint that charges a sat for a swap
           * the claim asks for nothing out of one in: the mint refuses, the
           * row stays, and the sat is counted in the balance and asked about
           * on every connection for ever (`soak-payer`). It
           * cannot be claimed by itself, now or later, so it is let go. No
           * entry changes for it: a payment waiting to be claimed is written
           * down net of the fee for claiming it, and this is that fee. */
          try {
            var rest = FoxyWallet.tokenInfo(claimText);
            if (rest && wallet && canonicalMint(String(rest.mint || '')) === mintOf(wallet)) {
              var worth = sumProofs(rest.proofs || []);
              var cost = swapFeeFor(wallet, rest.proofs || []);
              if (isFinite(cost) && cost > 0 && worth > 0 && worth - cost <= 0) {
                dropUnclaimed(id);
                dropLockKey(id);
                console.log('[foxy] ' + worth + ' sat(s) left of a payment are too little to claim at this mint (its fee is '
                  + cost + '); let go as that fee');
                return null;
              }
            }
          } catch (eDust) {}
          /* No key named: `receiveToken` finds it. It looks through the rows
           * this phone kept and, failing those, walks the seed for the lock the
           * token carries — which is how a payment that arrived on a phone that
           * is now gone is still claimable from the twelve words. */
          // the same entry the arrival wrote, finished rather than doubled
          return FoxyWallet.receiveToken(claimText, { hash: 'req-' + id, plain: !!one.plain, visit: true })
            .then(function (r) {
              took += (r && r.sats) || 0;
              // one taken to be carried home is this phone's now, at their mint: its job says so
              if (carryPaid(id, (r && r.sats) || 0)) carried = true;
              /* A payment that was spent from before it was claimed is still
               * the payment that arrived: its entry says what it was worth
               * whole, less only what the swap itself cost. The pieces that
               * went are payments of their own in the list. */
              if (one.whole > 0 && r && r.sats > 0) {
                var cost = Math.max(0, (Number(one.sats) || 0) - r.sats);
                try { amendTx('req-' + id, { sats: Math.max(r.sats, one.whole - cost) }); } catch (x) {}
              }
              dropUnclaimed(id);
              dropLockKey(id);
              console.log('[foxy] a payment for a request was claimed late:', (r && r.sats) || 0, 'sats');
              /* Every one of them is said, so the screen can add them up:
               * what was waiting is now this phone's and nobody else's. */
              if (typeof FoxyWallet._onLateClaim === 'function') {
                try { FoxyWallet._onLateClaim({ sats: (r && r.sats) || 0, trusted: !!one.trusted, id: id }); }
                catch (x) { console.warn('[foxy] late-claim watcher:', x && x.message); }
              }
              /* One taken on trust has stopped being at risk, and the person
               * who took that risk is told so: it was the one payment they
               * were left wondering about. */
              if (one.trusted) {
                console.log('[foxy] a payment taken on trust is settled:', (r && r.sats) || 0, 'sats');
                if (typeof FoxyWallet._onTrustSettled === 'function') {
                  try { FoxyWallet._onTrustSettled({ sats: (r && r.sats) || one.sats, id: id, hash: 'req-' + id }); }
                  catch (x) { console.warn('[foxy] trust-settled watcher:', x && x.message); }
                }
              }
            }, function (e) {
              var why = String((e && e.message) || '');
              // never issued by this mint is gone too: it was never there (notIssued)
              var gone = /already spent|nothing to take/i.test(why) || notIssued(e);
              /* A row taken on trust while both phones were offline, and the
               * mint says the proofs are gone: the payer spent their copy back.
               *
               * This is the one failure here that somebody has to be told about,
               * and it is the whole reason `trusted` is written down. Every other
               * row is either locked to this phone or already swapped, so a
               * "spent" answer means this phone's own earlier claim got there
               * first — bookkeeping. For a trusted row it means the money the
               * person was shown, and counted, was taken back.
               *
               * The history entry is turned from PENDING to failed rather than
               * disappearing: an entry that vanishes leaves somebody sure they
               * were paid and unable to find it. */
              if (gone && one.trusted) {
                console.warn('[foxy] a payment taken on trust while offline was spent by the payer:',
                             one.sats, 'sats');
                logTx({ dir: 'in', sats: one.sats, feeSats: 0, settled: false, state: 'failed',
                        memo: 'ecash, offline \u2014 taken back', hash: 'req-' + id }, 'req-' + id);
                if (typeof FoxyWallet._onTrustLost === 'function') {
                  try { FoxyWallet._onTrustLost({ sats: one.sats, id: id }); }
                  catch (x) { console.warn('[foxy] trust-lost watcher:', x && x.message); }
                }
              }
              if (gone) { dropUnclaimed(id); dropLockKey(id); carryGone(id, true); return null; }
              /* Locked to a key no seed on this phone derives: written down, and
               * no longer counted as money in flight.
               *
               * `settling()` refuses new words while anything here is waiting,
               * because the seed is what opens it. An entry that this seed
               * cannot open is not waiting for anything — it is stranded — and
               * left counted it would refuse every restore until the app was
               * reinstalled. That is the trap the locked-send carve-out was
               * written for, reached by another road.
               *
               * The entry itself stays. The token is still on disk, and if the
               * seed that opens it ever comes back this claim runs again and
               * takes it. What goes is only its hold on the wallet. Marked, not
               * dropped, and only for a hard "not ours": a phone that could not
               * answer rejects with its own words now, not with this one. */
              if (/locked to/i.test(why)) strandUnclaimed(id);
              console.warn('[foxy] a payment for a request is still unclaimed:', e && e.message);
              return null;
            });
        });
      }, Promise.resolve()).then(function () {
        // home again, if a claim took the wallet to another mint
        if (startedAt && canonicalMint(mintUrl || '') !== startedAt) {
          return FoxyWallet.connect(startedAt, null, null, { remember: false }).then(null, function (e) {
            console.warn('[foxy] could not get back to', hostOf(startedAt), 'after a late claim:', e && e.message);
          });
        }
        return null;
      }).then(function () {
        // and what was claimed to be carried home is carried, after this walk is over
        if (carried) setTimeout(function () { FoxyWallet.carryResume().catch(function () {}); }, 0);
        return took;
      });
      claimingLate = walk;
      var freeWalk = function () { claimingLate = null; };
      walk.then(freeWalk, freeWalk);
      return walk;
    },

    /* `over` says which wire this arrived on: 'tap' for Bluetooth, '' for an onion
     * or a relay. Both used to come through here indistinguishable, and change can
     * only go back over a link that is still open — so the one thing this function
     * has to know before it can hand any back is which it was. */
    _requestPaid: function (body, answerId, over) {
      var answer = function (status, text) {
        return bridgeAsk('inboxAnswer', { answer: String(answerId), status: status, text: text || '' }, 5000)
          .catch(function () {});
      };
      var p;
      try { p = readPayment(body, mintUrl); } catch (e) {
        console.warn('[foxy] a payment for a request was refused:', e.message);
        answer(e.foxyStatus || 422, e.message);
        /* And the screen is told, as it is for every other ending. This one
         * returned before there was anybody to tell, so the receive screen went
         * on believing a tap was under way: the hold on the link ran its full
         * ninety seconds, and the next three presses of TAP were read as
         * dismissing a card. */
        FoxyWallet._requestPaidListeners.forEach(function (fn) {
          try { fn({ stage: 'failed', sats: 0, id: '', purpose: '', refused: e.message }); }
          catch (x) { console.warn('[foxy] request paid listener:', x && x.message); }
        });
        // and where the ecash is good and there is a route, it goes back locked to the payer
        if (over === 'tap') refundRefused(body, e);
        return;
      }
      if (FoxyWallet._requestsBeingPaid[p.id]) { answer(409, 'That request is being paid already.'); return; }
      FoxyWallet._requestsBeingPaid[p.id] = true;
      var token;
      try {
        token = window.CashuTS.getEncodedToken({ mint: p.mint, unit: 'sat', proofs: p.proofs });
      } catch (e) {
        delete FoxyWallet._requestsBeingPaid[p.id];
        answer(422, 'That payment would not make a token.');
        return;
      }
      /* Which wire, because it said "over Tor" whatever the answer was — and a
       * payment that arrived over Bluetooth read in the diary as one that came
       * over an onion, which is the opposite of what the next decision turns
       * on. */
      console.log('[foxy] a request was paid over ' + (over === 'tap' ? 'bluetooth' : 'Tor')
        + ':', p.sats, 'sats; redeeming');
      /* What this phone is actually keeping. An over-payment whose change goes
       * straight back is not money kept, and showing the gross told the person
       * they had been paid 4 sats for a 3-sat sale — on both phones, and then a
       * second screen for the 1 sat going back. */
      var giveBack = changeOwed(p, over);
      /* Less the mint's fee on the pieces that came, when change goes back:
       * what stays is what arrived after the fee, less the change. Without it
       * a 2,048 sat piece with 851 of change and a 1 sat fee was written as
       * 1,197 kept when 1,196 stayed, and the audit was a sat out for every
       * such payment. */
      /* And with no change at all: a paying Foxy adds this fee on purpose,
       * so a request for 8 sats arrives as 9, and the confirmation said 9
       * under the dollars for the seconds before the swap wrote 8.
       * What stays is what is said, from the start. */
      var kept = Math.max(0, Number(p.sats) - giveBack - (Number(p.inFee) || 0));
      if (giveBack > 0) {
        console.log('[foxy] of ' + p.sats + ' sats, ' + kept + ' is the payment and '
          + giveBack + ' goes back as change');
      }
      var tell = function (stage, r) {
        FoxyWallet._requestPaidListeners.forEach(function (fn) {
          try { fn({ stage: stage, sats: (r && r.sats) || kept, id: p.id, purpose: p.purpose, asked: p.asked, result: r }); }
          catch (e) { console.warn('[foxy] request paid listener:', e && e.message); }
        });
      };
      tell('arrived');
      /* The key this phone put in the request, if it asked for a lock.
       *
       * Kept where it survives a force-quit, because the redeem below is the
       * step that can fail. What is left then is a token on the unclaimed list
       * and no way to open it: locked ecash is spendable only by the key it
       * names, so if that key dies with the page the money dies with it.
       *
       * Read out of the row without asking the phone for anything, because this
       * step needs no private key: what it decides is whether the ecash that
       * arrived really is locked to us, and a public key answers that. The
       * private half is asked for at the claim, where there is money in front
       * of it. */
      var lockPub = lockPubFor(p.id);
      /* It reads the proofs, not the request: `lockPub` only says what this
       * phone asked for. Hoisted above `keepUnclaimed` because the offline
       * refusal below has to happen before anything is written down. */
      var lockedToUs = !!lockPub && p.proofs.every(function (pr) { return onlyLockedTo(pr, lockPub); });
      /* And signed by the mint, or it is not money at all (mintSigned). The
       * lock alone used to decide this, and a payment nobody had signed was
       * answered 200 and shown as paid. */
      var forged = dleqAudit(wallet, p.proofs).invalid;
      if (forged) {
        console.error('[foxy] a payment for a request carries ' + forged
          + ' piece(s) this mint did not sign; refusing it');
        delete FoxyWallet._requestsBeingPaid[p.id];
        tell('failed');
        answer(422, 'That ecash\u2019s signatures do not match the keys this mint publishes, so it was not taken.');
        return;
      }
      var held = lockedToUs && mintSigned(wallet, p.proofs);
      if (lockedToUs && !held) {
        console.warn('[foxy] a payment is locked to this phone but its signatures cannot be checked here;'
          + ' it is announced only once the mint has taken it');
        if (!routeOpen()) {
          delete FoxyWallet._requestsBeingPaid[p.id];
          tell('failed');
          answer(422, 'This phone is offline and cannot check that ecash\u2019s signatures.'
            + ' Try again when either phone is online.');
          return;
        }
      }
      /* What was asked and what came, side by side. Two payments locked to
       * this phone's own key were treated as unlocked because the request had
       * no row, and the only trace was the claim saying so three minutes later. */
      try {
        var lockedN = p.proofs.filter(function (pr) {
          return /^\s*\[\s*"P2PK"/.test(String((pr && pr.secret) || ''));
        }).length;
        console.log('[foxy] pay steps: arrived ' + p.proofs.length + ' piece(s), ' + lockedN
          + ' locked; this request ' + (lockPub ? 'has' : 'has NO') + ' lock key on file; '
          + (held ? 'all locked to it' : lockedN ? 'not all locked to a key this request knows' : 'unlocked')
          + '; route ' + (routeOpen() ? 'open' : 'shut') + ', wallet ' + (wallet ? 'connected' : 'NOT connected'));
      } catch (e) {}

      /* With no route, ecash that is not locked to this phone is not settled.
       *
       * Unlocked ecash is a race: anyone holding a copy can spend it, and the
       * only thing that settles it is this phone's own swap. Offline there is no
       * swap, so taking it means showing somebody money that may already be
       * gone, with no way to find out for as long as the phone stays offline.
       *
       * Locked ecash is the opposite and is taken without asking anybody: only
       * this phone can ever spend it, the payer had to swap at the mint to make
       * it — so it was already final before it arrived — and its DLEQ verifies
       * against the cached keyset without asking anyone anything.
       *
       * Which is also how this phone knows the payer's state without being told
       * it. A lock cannot be made without a swap, so "locked" is proof the payer
       * had a route, and "unlocked" is proof they did not. There is no flag to
       * set and nothing to lie about.
       *
       * Unlocked-and-offline used to be simply refused, which made an
       * offline payment between two Foxys impossible. It is now offered to the
       * person instead, because the risk is real, bounded, and theirs to take:
       * the payer can spend their copy back until this phone gets online, and
       * whether that particular payer would is a question about the payer.
       */
      /* Unlocked and no route: both phones are offline, and only the person can
       * say whether they trust this payer (offlineOffer). Two refusals come
       * first, neither of them a judgement about anybody:
       *
       *   - not over Bluetooth. A payer with no route reaches no onion and no
       *     relay, so unlocked ecash arriving on one of those is not an offline
       *     payer, and there is no link to hold open while a person reads a card.
       *   - not exact. This phone cannot make change with no route, and change
       *     out of its own pile would cost it the payment AND the change if the
       *     payer spends theirs again.
       *
       * Nothing is written down on any of these paths, so the payer keeps their
       * ecash and can offer it again to either phone with a route. */
      var bothOffline = !held && !routeOpen();
      /* Not supported for now, so the payer is told plainly rather than being
       * asked a question whose answer cannot be acted on. */
      if (bothOffline && !offlineToOffline()) {
        console.warn('[foxy] a payment arrived unlocked and this phone has no route;'
          + ' refusing it \u2014 nothing here can settle it until one of us is online');
        delete FoxyWallet._requestsBeingPaid[p.id];
        tell('failed');
        answer(422, 'This phone is offline, so it can only take ecash locked to it.'
          + ' Try again when either phone is online.');
        return;
      }
      if (bothOffline && over !== 'tap') {
        console.warn('[foxy] a payment arrived unlocked over ' + (over || 'a relay or an onion')
          + ' and this phone has no route; refusing it');
        delete FoxyWallet._requestsBeingPaid[p.id];
        tell('failed');
        answer(422, 'This phone is offline, so it can only take ecash locked to it.'
          + ' Try again when either phone is online.');
        return;
      }
      /* An over-payment the payer meant.
       *
       * Refusing every over-payment while both are offline is right when the
       * payer is expecting change back, because this phone cannot make any. It
       * is wrong when the payer has been shown the figures and said send it
       * anyway: then the extra is a gift, there is no change to make, and
       * refusing only sends them away with a payment they had agreed to.
       *
       * `overpaid` is the payer's own word, and it is safe for it to be: the
       * worst a false one can do is make this phone keep money it was sent. The
       * card the payer answered is the protection, and it is on their side
       * because they are the one giving something up. */
      if (bothOffline && p.overpaid && Number(p.asked) > 0 && Number(p.sats) > Number(p.asked)) {
        console.log('[foxy] both phones are offline and they over-paid by '
          + (Number(p.sats) - Number(p.asked)) + ' sats on purpose; no change is owed');
      } else if (bothOffline && Number(p.asked) > 0 && Number(p.sats) > Number(p.asked)) {
        console.warn('[foxy] both phones are offline and they overpaid by '
          + (Number(p.sats) - Number(p.asked)) + ' sats; refusing it — no change can be made offline');
        delete FoxyWallet._requestsBeingPaid[p.id];
        tell('failed');
        answer(422, 'You are both offline, so this phone cannot give change. Send exactly '
          + Number(p.asked) + ' sats, or one of you get online.');
        return;
      }

      /* The tail, as a step, because one of the ways in is a person reading a
       * card. `trusted` is true only for the one arrival this phone has not
       * settled and cannot settle: unlocked ecash taken offline on somebody's
       * word. Everything else reaches it exactly as it always did. */
      var takeIt = function (trusted) {
        /* Written down before it is touched. Everything after this can fail and
         * the money is still findable; before it, nothing could.
         *
         * So a write that does not land ends the payment here. `keepUnclaimed`
         * used to swallow its refusal, and a full store then took the
         * same path as a successful one: the payer answered 200, a settled entry
         * in history, the sats in the balance, and the only copy of the token
         * handed to a setTimeout no relaunch could find.
         *
         * Refused here and not further down. Redeeming it anyway, without writing
         * it down, only moves the refusal to `setProofs` — which is `mustSave`
         * too — with the mint having already taken the proofs, and that is the
         * W6 bug exactly. Nothing has been written or announced yet: `logTx`,
         * `tell('paid')`, the 200 and `dropOpenRequest(p.id)` are all below,
         * and only `tell('arrived')` has fired, which is a spinner. The request
         * stays open and the in-flight flag comes off, so the payer's next
         * attempt is read as a payment rather than answered 409.
         *
         * 422 because the bridge allows nothing else — `handleInboxAnswer`
         * coerces everything but 200, 409 and 422 — and 409 means "already
         * spent", which would tell the payer to stop rather than try again. Its
         * own words, not `mustSave`'s: that message says nothing is lost and it
         * is on record, and the record is the thing that failed. */
        try {
          keepUnclaimed(p.id, token, p.sats, trusted, /^carry:/.test(String(p.purpose || '')));
        } catch (e) {
          console.error('[foxy] a payment arrived and could not be written down; refusing it:',
                        (e && e.message) || e);
          delete FoxyWallet._requestsBeingPaid[p.id];
          tell('failed');
          answer(422, 'This phone could not write the payment down, so it was not taken. Try again.');
          return;
        }
        // a payment to be brought home: its job learns which request it answered, and the payer's key
        carryArrived(p);

        /* Every payment is swapped in the moment it lands. Nothing waits.
         *
         * Locked ecash used to be held back between thirty seconds and three
         * minutes, so the mint would not see the payer's swap and this redeem
         * seconds apart for the same amount. It was paid for in ways that kept
         * turning up: the only copy of the token sat in a setTimeout, and a
         * timer is not a place to keep somebody's money — background the app and
         * it dies; the receiving screen went back to the
         * invoice with nothing on it while the payer's phone said done; and the
         * wait was a window in which the proofs had not been taken yet, so a
         * payer who sent unlocked ecash to a request that asked for a lock could
         * spend it back, face to face, while the goods changed hands.
         *
         * Each of those was fixed in turn — written down first, told on screen
         * first, and the branch chosen by what actually arrived rather than by
         * what was asked for. The delay was removed anyway: what it
         * bought was one correlation at the mint, against a path where the sats
         * are only as safe as the next thing that goes wrong on it.
         *
         * `held` stays, and now decides the order of the telling rather than the
         * timing of the swap. Ecash locked to this phone alone is already ours —
         * the payer cannot take it back and no one else can spend it — so the
         * payer is answered and the person is shown their money without waiting
         * on a round trip to the mint, and the swap follows. Unlocked ecash is a
         * race: anyone with a copy can spend it, so nothing is announced until
         * the mint has taken it.
         *
         * It reads the proofs, not the request. `lockPub` only says what this
         * phone asked for, and nothing else here looks at the secret — that is
         * how the spend-it-back window above got in. */
        // `held` is computed above, before the write, for the offline refusal
        if (lockPub && !held) {
          console.warn('[foxy] a request asked for a lock and the payment arrived without one;'
            + ' announcing it only once the mint has taken it');
        }
        console.log('[foxy] pay steps: a request was paid; redeeming now'
          + (held ? ' (locked to this phone, so it is told first)' : ''));

        /* One entry, written when the money lands and finished when it is
         * swapped in. Named after the request so both halves find it. */
        /* No key named: `receiveToken` looks it up by the lock itself. The row
         * for this request is right there, so it is one question to the phone;
         * and if the row has gone, the seed still knows the key. */
        var into = 'req-' + p.id;
        var claim = function () {
          // `keptSats`: an over-payment's change goes straight back, so the
          // entry records the payment, not the piece that carried it
          return FoxyWallet.receiveToken(token, { hash: into, keptSats: kept,
                                                  grossSats: p.sats, changeSats: giveBack,
                                                  // only passing through this mint: not cut into small change
                                                  plain: /^carry:/.test(String(p.purpose || '')) })
            .then(function (r) {
              delete FoxyWallet._requestsBeingPaid[p.id];
              dropOpenRequest(p.id);
              dropUnclaimed(p.id);
              dropLockKey(p.id);
              console.log('[foxy] pay steps: a request was paid and is now swapped in');
              // this phone's, at their mint: written on its job before anybody is told
              carryPaid(p.id, kept);
              return r;
            });
        };

        /* Taken on trust, with no route to settle it.
         *
         * There is no swap to do and nothing to wait for, so the payer is
         * answered and the person is shown what they were paid. The row stays on
         * the unclaimed list marked `trusted`, and the next connect claims it
         * (claimUnclaimed) — which is also where this phone finds out whether the
         * payer kept their word.
         *
         * History says PENDING, because that is true: this is money that has
         * arrived and has not settled. The claim finishes the same entry rather
         * than adding a second one, exactly as the locked path does.
         *
         * No `changeBack`: an over-payment was refused above, so there is none,
         * and making change offline is the thing that would double the loss. */
        if (trusted) {
          delete FoxyWallet._requestsBeingPaid[p.id];
          dropOpenRequest(p.id);
          answer(200, '');
          console.log('[foxy] both phones are offline and the person accepted the risk: '
            + p.sats + ' sats taken on trust, to be swapped when there is a route');
          logTx({
            dir: 'in', sats: kept, feeSats: 0, settled: false, state: 'pending',
            grossSats: p.sats, changeSats: giveBack,
            /* `trusted` is on the history entry as well as on the unclaimed row,
             * because the two answer different questions. The row is what the
             * claim reads; this is what the person reads. A pending row that is
             * merely slow and one that a stranger can still take back must not
             * look the same in a list. */
            trusted: true, memo: 'ecash, offline', hash: into,
          });
          tell('paid', { sats: kept, trusted: true });
          return;
        }

        if (held) {
          // ours already: told now, swapped in the same breath
          delete FoxyWallet._requestsBeingPaid[p.id];
          dropOpenRequest(p.id);
          answer(200, '');
          changeBack(p, over);
          /* In history at once, at the moment it arrived.
           *
           * Everything the receiving phone shows hangs off this entry: the
           * confirmation screen is raised by the history pass finding a new one
           * (16-history-lists.js), and the list is the log itself. Written only
           * by the swap, it appeared only once the mint answered — the payer's
           * phone said done and the receiver's went back to home with nothing on
           * it. The money is this phone's the
           * moment it lands: it is locked to a key only this phone holds, the
           * payer cannot take it back, and balanceSats already counts it. The
           * swap is bookkeeping and finishes this entry rather than adding
           * another. */
          logTx({
            dir: 'in', sats: kept, feeSats: 0, settled: true, state: 'success',
            /* One entry, with the breakdown inside it. An over-payment and the
             * change going back are two halves of one sale, and filing them as
             * two transactions showed a payment for 4 and then a
             * withdrawal of 2 for a 2-sat sale. The list shows the
             * net; the detail screen shows all three figures, and keeps them, so
             * a report about a payment has the numbers in it. */
            grossSats: p.sats, changeSats: giveBack,
            changeState: giveBack > 0 ? 'making' : '',
            memo: 'ecash', hash: into,
          });
          tell('paid', { sats: kept });
          claim().catch(function (e) {
            /* Beaten to it, which is not an error.
             *
             * Any screen the money could leave from claims what is waiting first
             * (syncClaim), because a balance that counts unswapped sats has to be
             * able to spend them. That claim can land before this one and leave
             * this one looking at a token the mint has already taken — which
             * used to be reported as money still unclaimed while it sat safely
             * in the wallet. Gone means
             * taken; the list is cleared in case the claim that took it could
             * not write. */
            var gone = /already spent|nothing to take/i.test(String((e && e.message) || '')) || notIssued(e);
            if (gone) { dropUnclaimed(p.id); dropLockKey(p.id); return; }
            console.warn('[foxy] a payment for a request is still unclaimed:', e && e.message);
          });
          return;
        }

        return claim().then(function (r) {
          answer(200, '');
          changeBack(p, over);
          /* `r.sats` is what the swap took in, which is the gross. What the
           * person was paid is what stays after the change goes back. */
          tell('paid', { sats: kept, result: r });
        }, function (e) {
          delete FoxyWallet._requestsBeingPaid[p.id];
          tell('failed');
          var spent = /spent|already|nothing to take/i.test(String((e && e.message) || ''));
          /* Proofs the mint has already taken are not money waiting to be
           * swapped, and leaving them on the unclaimed list counted them in the
           * balance — sats that were refused, shown as held. Gone
           * means gone; anything else is worth trying again on the next connect,
           * so it stays, and so does the key that opens it. */
          // and ecash the mint never issued is not waiting for anything either
          if (spent || notIssued(e)) { dropUnclaimed(p.id); dropLockKey(p.id); }
          /* What the payer is told has to be what this phone then does.
           *
           * Plain ecash that could not be swapped in was answered 422 — "they
           * did not take it, your sats are still yours" on the payer's screen
           * — and kept on the unclaimed list all the same, to be claimed on the
           * next connection. So the payer was told no and paid anyway, and its
           * RECLAIM was refused as already spent (tools/live/tap-scenarios.js
           * F10). Somebody told a payment failed pays again.
           *
           * Two different things were being called a refusal. If the swap may
           * have reached the mint — its record is still on file, to be asked
           * about — nobody knows yet whether it was taken: this phone keeps
           * what it wrote down and says 409, which the payer reads as
           * UNCONFIRMED (21-native-bridges.js `tapSend`): it keeps its token,
           * watches it, and is not told it is free to spend. If the swap never
           * left, or the mint refused it, nothing was taken and nothing will
           * be: the copy goes, so the 422 is true.
           *
           * 409 and not 504, which is what the payer's own word for "no
           * answer" is: the phone passes on only 200, 409 and 422 from the
           * page and turns anything else into 422
           * (FoxyBridge+Delivery.swift `handleInboxAnswer`), so a 504 said
           * here arrived as the very refusal this is meant to stop. */
          var unsure = !spent && !notIssued(e)
            && loadSwaps().some(function (r) { return r && r.into === into; });
          if (!spent && !notIssued(e) && !unsure) dropUnclaimed(p.id);
          // and the job it was for: open again when nothing was taken, gone when the ecash was
          if (!unsure) carryGone(p.id, spent || notIssued(e));
          /* Said here, not only sent. This is the one refusal that reached the
           * payer without a word in this phone's own diary — so a payment that
           * failed looked, from the log, exactly like one that worked, and the
           * only trace was the payer's screen. */
          var code = (spent || unsure) ? 409 : 422;
          console.warn('[foxy] the claim failed, so the payer is being told ' + code
            + (unsure ? ' (it may still go through: kept, and asked about on the next connection)'
               : code === 422 ? ' (nothing was taken, and nothing is kept)' : '') + ':', (e && e.message) || e);
          answer(code, FoxyWallet.reason ? FoxyWallet.reason(e) : String((e && e.message) || e));
        });
      };

      /* Both offline: ask, and let the answer decide. Nothing above this line
       * wrote anything down, so a refusal here leaves the payer holding their
       * own ecash, which is the whole point of asking before taking it. */
      if (bothOffline) {
        offlineOffer(p).then(function (yes) {
          if (yes) { takeIt(true); return; }
          console.log('[foxy] both phones are offline and this payment was rejected here');
          delete FoxyWallet._requestsBeingPaid[p.id];
          tell('rejected');
          answer(422, 'They did not accept this payment. You are both offline, so nothing here'
            + ' could settle it. Your ecash is still yours.');
        });
        return;
      }
      return takeIt(false);
    },

    /* Pay a request straight to whoever made it (req from decodeRequest, with
     * a delivery). The token is made first, as GENERATE ECASH TOKEN makes it,
     * so the money is in this wallet's history whatever happens next; then its
     * proofs are delivered. Resolves with sendToken's { token, sats, hash }
     * once the other side has them. A failed delivery rejects with that
     * result as e.foxyToken, for the token screen to show instead: the money
     * is never lost between the two. `onStep` hears 'making', 'delivering'. */
    /* `opts.overpayOk` is the person's answer to the over-pay card: without it a
     * payment that would have to over-pay is refused with the figures attached
     * (`foxyNeedsOverpay`) rather than made. */
    payRequest: function (req, onStep, opts) {
      var step = typeof onStep === 'function' ? onStep : function () {};
      /* An open Bluetooth link counts as a way to deliver.
       *
       * `delivery` is built from the transports a request names, and an offline
       * receiver names none: it cannot publish an onion or reach a relay. This
       * refused before anything, so two offline phones standing together — with
       * a link up and the four digits on both screens — could not pay each
       * other at all, and the payer was sent to the token screen to show a QR.
       *
       * `viaTap` is only ever set for a request that arrived over the link it
       * would be paid back over, so this cannot pay a scanned request to
       * whichever phone happens to be connected. */
      var d = req && req.delivery;
      if (!d && req && req.viaTap) d = { kind: 'tap', target: '' };
      if (!d) return Promise.reject(new Error('That request names no way Foxy can deliver to.'));
      if (!(req.sats > 0)) return Promise.reject(new Error('That request names no amount.'));
      if ((req.unit || 'sat') !== 'sat') return Promise.reject(new Error('That request is not for sats.'));
      /* Timed, in three parts, because "the ecash way feels slower than the
       * Lightning way" could be any of them and guessing which is how time
       * gets spent on the wrong one. Making is a swap at the mint over Tor;
       * delivering is a fresh onion rendezvous, or the Bluetooth link that is
       * already open when this was a tap. */
      var began = Date.now(), madeAt = 0;
      /* Lock it to the receiver where the request asks and this phone can.
       *
       * A lock means a swap at the mint — the proofs have to be made afresh —
       * so the fast path where exact change goes straight over is given up for
       * it, and it needs the network. Worth it: the ecash is then spendable
       * only by the phone that asked, so a token taken off the air or off a
       * relay is worthless. Without a lock it is what it always was. */
      var lockTo = typeof req.lockTo === 'string' ? req.lockTo : '';
      /* A lock this phone cannot make is dropped, not failed on.
       *
       * Locking means swapping at the mint, which needs a route. A request
       * almost always asks for one — the receiver asks whenever the mint
       * supports NUT-11, which says nothing about whether the receiver is
       * online — so an offline payer met a lock it could not make and the send
       * died on the spot, silently, with the two phones linked and the code on
       * both screens.
       *
       * Paying unlocked is the right answer and not a weakening, because the
       * receiver decides what happens to it and knows its own state, which this
       * phone does not. An online receiver swaps it in before it says a word, so
       * it is settled before anybody is shown anything. An offline receiver
       * cannot, and asks its owner (HIGH RISK) or refuses. Either way the rule
       * that one of the two must have a route is enforced where it can actually
       * be checked.
       *
       * The link itself is not the exposure a lock guards against: the tap is
       * sealed and the four digits are on both screens. */
      if (lockTo && !routeOpen()) {
        console.log('[foxy] this phone has no route, so the lock the request asked for'
          + ' is dropped and the exact amount is paid from pieces on hand');
        lockTo = '';
      }
      /* The two rules, checked once, before a proof is touched.
       *
       * Everything above has decided what this payment would actually be — the
       * mint it comes from, whether it can carry a lock, what the request says
       * about the receiver — so this is the first moment the question can be
       * asked honestly, and the last moment before the answer costs anything.
       * `handoverRefusal` is where the rules are written down and argued.
       *
       * It refused at the far end before this: the payer swapped, made a token,
       * handed it over and was told no. Nothing was lost, but counters were
       * spent, the pile was re-split, and the person was left holding ecash to
       * get rid of. */
      var refusal = handoverRefusal({
        payerHasRoute: routeOpen(),
        /* What they said about themselves (`req.theirRoute`, from the tap
         * offer), or what the request lets this phone infer, or nothing. A
         * request naming somewhere to be paid was made by a phone with a route;
         * a request naming nowhere proves nothing at all, because Tor takes
         * half a minute to publish an address and an online receiver on the
         * ecash rail may name none. */
        receiverHasRoute: typeof req.theirRoute === 'boolean' ? req.theirRoute
          : (req.transports && req.transports.length ? true : null),
        locked: !!lockTo,
        atTheirMint: !req.mints || !req.mints.length
          || req.mints.some(function (m) {
            return String(m).replace(/\/+$/, '') === String(mintUrl || '').replace(/\/+$/, '');
          }),
      });
      if (refusal) {
        console.warn('[foxy] the payment was not made:', refusal);
        return Promise.reject(new Error(refusal));
      }
      step('making');
      /* A key for the change, before anything is paid.
       *
       * Change comes back locked to a key only this phone holds, and that key
       * comes from the pool the phone derives from the seed. The pool is filled
       * by whoever is about to show a request — the receiver — and a payer never
       * shows one, so a payer's pool was always empty: every over-payment went
       * out with no key on it and the receiver, having nothing to lock change to,
       * kept it and recorded the payer as owed. In testing the change
       * never came back once, and the reason was never the link.
       *
       * Primed here, where there is time: `payRequest` is already asynchronous
       * and this is before a single proof has moved. It never rejects — no key
       * means the old behaviour, an over-payment that is owed rather than
       * returned — and `primeLocks` is cheap when the pool is already full. */
      /* The pool the change key comes from, filled before anything is paid.
       *
       * It is filled by whoever is about to SHOW a request, and a payer never
       * shows one — so a payer's pool was empty and every over-payment went out
       * with no key on it. Filled on every tap, not only offline: a payer with a
       * route can still be handed an over-payment's change. It never rejects,
       * and it is cheap when the pool is already full. */
      var primed = (req.viaTap && FoxyWallet.primeLocks)
        ? FoxyWallet.primeLocks().catch(function () { return 0; })
        : Promise.resolve(0);
      return primed.then(function () {
      /* `cover` only where the change can come back: a tap, which is a link that
       * is still open. Over an onion or a relay there is nothing to hand change
       * to, so an amount this phone cannot make exactly is refused rather than
       * over-paid into thin air. */
      // the key this payment's change is locked to, made before the token so the token can name it
      var changeKeyEarly = (req.viaTap && req.id) ? (changeKeyFor(req.id) || '') : '';
      /* Asked first, where the other phone says it can be (`req.asks`, from
       * its tap offer): what is about to be sent, before any of it is made.
       * A no costs nothing — no swap, no fee, no ecash another phone has
       * seen — and is the receiver's own reason, word for word. */
      var asked = (req.viaTap && req.asks === true)
        ? FoxyWallet.askFirst(req, { locked: !!lockTo }) : Promise.resolve({ go: true });
      return asked.then(function (a) {
        if (!a || a.go !== true) {
          var eNo = /** @type {any} */ (new Error((a && a.why) || 'They cannot take this payment. Nothing was sent.'));
          eNo.foxyAskedNo = true;
          eNo.foxySilent = !!(a && a.silent);
          console.warn('[foxy] pay steps: asked first, and ' + (eNo.foxySilent ? 'no answer came' : 'they said no') + ': ' + eNo.message);
          throw eNo;
        }
        return FoxyWallet.sendToken(req.sats, lockTo ? { unit: 'sat', lockTo: lockTo, inflight: true }
                                                     : { unit: 'sat', cover: !!req.viaTap,
                                                         inflight: true, changeKey: changeKeyEarly,
                                                         overpayOk: !!(opts && opts.overpayOk) });
      })
        .then(function (made) {
        madeAt = Date.now();
        var info = FoxyWallet.tokenInfo(made.token);
        if (!info || !info.proofs || !info.proofs.length) {
          throw carryToken(new Error('The payment could not be read back.'), made);
        }
        var payment = { mint: String(info.mint || '').replace(/\/+$/, ''), unit: 'sat',
          proofs: info.proofs.map(function (pr) {
            var out = { id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C };
            if (pr.dleq) out.dleq = pr.dleq;
            if (pr.witness) out.witness = pr.witness;
            return out;
          }) };
        if (req.id) payment.id = req.id;
        /* A key for change to be locked to, when this payment might overpay.
         *
         * A payer with no route cannot swap, so an amount its pieces cannot make
         * exactly is paid by handing over more — and the difference comes back.
         * Unlocked it would be a race the payer cannot watch, since they have no
         * mint to settle it at; locked to this key it is theirs alone, and can
         * wait in the unclaimed store until there is a route.
         *
         * Derived from the seed on the phone, so it costs no network and works
         * exactly when it is needed. Kept under the request's own id so the key
         * is found again by `lockKeyMatching` when the change arrives. */
        /* Asked for twice if the pool has run dry, because a take that finds it
         * empty simply returns nothing and there is no waiting at the delivery
         * step. A phone paid with `no key to lock change to` twenty
         * minutes after the same phone had taken change back fine, because by
         * then the pool had been used up. */
        var changeKey = req.id ? changeKeyFor(req.id) : '';
        if (changeKey) {
          payment.changeTo = changeKey;
        } else if (req.id) {
          console.warn('[foxy] no key to lock change to, so any over-payment is owed'
            + ' rather than handed back');
        }
        /* Said out loud when the person agreed to over-pay knowing no change can
         * come back. A receiver with no route refuses an over-payment otherwise,
         * because it would have to swap to give the difference back — and this
         * is what tells it the difference was meant. */
        if (Number(made.over) > 0 && opts && opts.overpayOk) payment.overpaid = true;
        var body = serialiseBody(payment);
        step('delivering');
        /* Over Bluetooth when this request came over Bluetooth.
         *
         * The two phones are still connected — the offer crossed that link a
         * moment ago — and a fresh onion rendezvous is seconds spent reaching
         * a phone already within arm's reach. Only for a request that came
         * over that very link (`viaTap`): paying a scanned request to whatever
         * happens to be connected would be handing money to a stranger.
         *
         * A link that has gone falls back to the request's own transport, so
         * the worst a failed hand-over costs is the time it took to try. */
        var over = d.kind;
        /* Did anybody say they had written it down?
         *
         * Not "which transport did the request name", which is what decided it
         * before and is why a tap payment whose receiver refused had its token
         * deleted: a Foxy request always names an onion, whichever wire the
         * money actually went over. An onion 200 and a tap 200 are
         * the same promise; a relay taking a Nostr message and a tap left
         * unconfirmed are the same non-promise. */
        var confirmed = false;
        var byOwnTransport = function () {
          /* Nothing to fall back to when the request named no transport: the
           * link was the whole delivery. Its own failure is the answer. */
          if (d.kind === 'tap') {
            return Promise.reject(new Error('That phone is no longer connected,'
              + ' and it gave no other way to reach it.'));
          }
          return d.kind === 'onion'
            ? deliverToOnion(d.target, body).then(function (r) { confirmed = true; return r; })
            : deliverOverNostr(d.target, body);
        };
        var sent;
        if (req.viaTap && FoxyWallet.tapSend) {
          over = 'bluetooth';
          sent = FoxyWallet.tapSend(body).then(function (how) {
            confirmed = how === 'settled';
            return true;
          }, function (e) {
            /* They heard it and said no. Every refusal the receiver can give is
             * the same refusal over their onion — the request is not open there
             * either, the mint is the same mint — so a fallback would cost
             * seconds and a second copy of the proofs on the wire for an answer
             * already known. The token goes to the token screen. */
            if (e && e.foxyRefused) throw e;
            console.log('[foxy] pay steps: bluetooth would not take it ('
              + (e && e.message) + '); falling back to ' + d.kind);
            over = d.kind;
            return byOwnTransport();
          });
        } else {
          sent = byOwnTransport();
        }
        return sent.then(function () {
          /* Whether the pile could make the amount exactly, because that is the
           * difference between asking the mint nothing and handing it a swap to
           * tie a later question to (05-paying-this-mint.js).
           *
           * It was locked/not-locked alone, and how often a payer had
           * exact change was a question two diaries full of payments could not
           * answer. `tidyChange` exists to make exact
           * change the common case and nothing reported whether it was working.
           *
           * A locked send says so plainly rather than "swapped": pieces already
           * held carry no lock, so a lock is always a swap and the small-change
           * pool can never serve one. Reading that as tidyChange failing would
           * be reading it backwards. */
          console.log('[foxy] pay steps: made in ' + (madeAt - began) + ' ms'
            + (lockTo ? ' (locked to them, so swapped: a lock cannot use pieces on hand)'
              : made.swapped ? ' (not locked, swapped for change)'
              : ' (not locked, exact change: the mint was not asked)') + ', delivered over '
            + over + (confirmed ? '' : ' (nobody has confirmed it)')
            + ' in ' + (Date.now() - madeAt) + ' ms, ' + (Date.now() - began) + ' ms in all');
          // a copy, so the type check is not asked about a field sendToken never had
          return /** @type {any} */ (Object.assign({}, made, { confirmed: confirmed }));
        }, function (e) {
          /* A refusal is not a delivery failure.
           *
           * The receiver's words came back over the link — "you are both offline,
           * so this phone cannot give change", "that payment answers no request
           * open here" — and this threw them away and put a QR on screen, which
           * says nothing about why and asks the person to solve it with a camera.
           * The token still goes with it, because the money was made and has to
           * be somewhere; what changes is that the reason travels too, and the
           * screen can say it. */
          if (e && e.foxyRefused) {
            console.warn('[foxy] pay steps: made in ' + (madeAt - began)
              + ' ms, and they refused it: ' + ((e && e.message) || ''));
            /* A no is only a word, and the pieces have been on their phone.
             * So this waits for them to come back locked to this phone, and
             * failing that puts them in the wallet again flagged as at risk
             * (`afterRefusal`). It always rejects. */
            return afterRefusal(req, made, e);
          } else {
            console.log('[foxy] pay steps: made in ' + (madeAt - began) + ' ms, then ' + over
              + ' delivery failed after ' + (Date.now() - madeAt) + ' ms');
          }
          throw carryToken(e, made);
        });
      });
      });
    },

    /* One of this phone's own tokens, taken back, whatever it is made of.
     *
     * `reclaimToken` takes plain ecash and refuses anything with a lock on
     * it, as "not one of ours". But a phone that has taken change while it
     * had no route holds ecash locked to itself, and pays out of it by
     * signing those pieces into the token. Refused, that token could not be
     * taken back by anything: the automatic take-back skipped it and RECLAIM
     * said it was locked to someone else's key — 590 sats off the balance,
     * not in the words either, with only the token on the entry to show for
     * them (`soak-payer`). Such a token is taken in the way any
     * ecash locked to this phone is, which finds the key by the lock. Not in
     * the proof lock itself: it calls one of the two that are. */
    takeBackToken: function (text) {
      var info = FoxyWallet.tokenInfo(text);
      if (!info) return Promise.reject(new Error('That is not a Cashu token.'));
      if (!lockedProofs(info.proofs || []).length) return FoxyWallet.reclaimToken(text);
      var at = hostOf(String(info.mint || ''));
      return FoxyWallet.receiveToken(text, { hash: 'reclaim-' + Date.now(), memo: 'reclaimed' }).then(function (r) {
        console.log('[foxy] took back', (r && r.sats) || 0, 'sats, some of it ecash locked to this phone');
        return { sats: (r && r.sats) || 0, host: (r && r.host) || at };
      });
    },

    /* Ecash a receiver heard and refused, taken back.
     *
     * The receiver said no in words, so the payment is this phone's again —
     * but its pieces have been on another phone, and an honest one forgetting
     * them is not something this one can check. They sat on the payment's
     * entry behind a RECLAIM button, out of the balance, for as long as
     * nobody pressed it. Swapped here for pieces nobody has seen, on the
     * first connection after the refusal, by itself.
     *
     * Only at the mint the phone is on, and only plain ecash: a token locked
     * to the receiver is theirs alone to spend. If the mint says the pieces
     * are spent, the receiver took them after all, and the entry says paid.
     * Resolves the sats taken back. */
    takeBackRefused: function () {
      if (FoxyWallet._takingBack) return FoxyWallet._takingBack;
      if (!wallet || !routeOpen()) return Promise.resolve(0);
      var meta = load('foxy.txmeta', {});
      var here = canonicalMint(mintUrl || '');
      var hashes = Object.keys(meta).filter(function (h) {
        return meta[h] && meta[h].refused === true && typeof meta[h].token === 'string' && meta[h].token;
      });
      if (!hashes.length) return Promise.resolve(0);
      var back = 0;
      var walk = hashes.reduce(function (chain, h) {
        return chain.then(function () {
          // looked at again: RECLAIM pressed meanwhile has already dealt with it
          var now = FoxyWallet.tagsFor(h);
          if (!now || now.refused !== true || !now.token) return null;
          var text = String(now.token);
          var info = FoxyWallet.tokenInfo(text);
          if (!info || canonicalMint(String(info.mint || '')) !== here) return null;
          return FoxyWallet.takeBackToken(text).then(function (r) {
            back += (r && r.sats) || 0;
            FoxyWallet.tag(h, { refused: false, takenBack: true });
            try { amendTx(h, { takenBack: true }); } catch (x) {}
            console.log('[foxy] a payment they did not take is back in the wallet:', (r && r.sats) || 0, 'sats');
            if (typeof FoxyWallet._onTakenBack === 'function') {
              try { FoxyWallet._onTakenBack({ sats: (r && r.sats) || 0, hash: h }); } catch (x) {}
            }
          }, function (e) {
            /* Locked to a key that is not this phone's: nothing here can take
             * it back, and asking again will not change that. */
            if (/locked to/i.test(String((e && e.message) || ''))) { FoxyWallet.tag(h, { refused: false }); return; }
            if (/already spent/i.test(String((e && e.message) || ''))) {
              // they took it after saying no: it is a payment, and it is made
              FoxyWallet.tag(h, { refused: false });
              try { FoxyWallet.settleTx(h); FoxyWallet.forgetClaimedToken(text); } catch (x) {}
              console.log('[foxy] a payment they said they had not taken was taken; its entry says paid');
              return;
            }
            console.warn('[foxy] a refused payment could not be taken back yet:', e && e.message);
          });
        });
      }, Promise.resolve()).then(function () { return back; });
      FoxyWallet._takingBack = walk;
      var freeBack = function () { FoxyWallet._takingBack = null; };
      walk.then(freeBack, freeBack);
      return walk;
    },
    /** @type {?Promise<number>} */
    _takingBack: null,

    /* Ecash at risk, settled: swapped for pieces nobody has seen, or found
     * spent.
     *
     * On the first connection after the refusal, and every one after while
     * any is left. The mint is asked about each refused payment's pieces. All
     * unspent, they are swapped and the flag goes. Spent, the phone that said
     * no redeemed them: they come out of the pile, the entry says paid, and
     * the person is told. Resolves [{ state, hash, sats }]. */
    settleAtRisk: function () {
      if (FoxyWallet._settlingAtRisk) return FoxyWallet._settlingAtRisk;
      if (!wallet || !routeOpen() || !Object.keys(atRiskAll()).length) return Promise.resolve([]);
      var walk = FoxyWallet._settleAtRiskOnce().then(function (out) {
        (out || []).forEach(function (r) {
          if (typeof FoxyWallet._onAtRisk === 'function') {
            try { FoxyWallet._onAtRisk(r); } catch (x) { console.warn('[foxy] at-risk watcher:', x && x.message); }
          }
        });
        return out || [];
      }, function (e) {
        console.warn('[foxy] ecash at risk could not be settled yet:', e && e.message);
        return [];
      });
      FoxyWallet._settlingAtRisk = walk;
      var freeIt = function () { FoxyWallet._settlingAtRisk = null; };
      walk.then(freeIt, freeIt);
      return walk;
    },
    /** @type {?Promise<any[]>} */
    _settlingAtRisk: null,

    _settleAtRiskOnce: function () {
      var w = wallet;
      if (!w || !routeOpen()) return Promise.resolve([]);
      var here = mintOf(w);
      /** @type {any[]} */
      var out = [];
      // a group none of whose pieces is left was spent by this phone since: nothing to settle
      var all0 = atRiskAll(), live0 = {};
      atRiskGroups().forEach(function (g) { live0[g.hash] = true; });
      /* Not the ones kept as a note of pieces that were redeemed (`taken`,
       * below): a refund for those can still arrive, for thirty days. */
      var kept = function (g) { return !!(g && g.taken === true && Date.now() - (Number(g.at) || 0) < 30 * 86400000); };
      var stale = Object.keys(all0).filter(function (h) {
        return !live0[h] && !kept(all0[h]) && canonicalMint((all0[h] || {}).mint || '') === here;
      });
      if (stale.length) {
        stale.forEach(function (h) { delete all0[h]; try { FoxyWallet.tag(h, { atRisk: false }); amendTx(h, { highRisk: false }); } catch (x) {} });
        save(K.atRisk, all0);
      }
      var groups = atRiskGroups().filter(function (g) { return canonicalMint(g.mint) === here; });
      return groups.reduce(function (chain, g) {
        return chain.then(function () {
          var cw = onCircuit(w, 'atrisk:' + g.hash);
          return statesOf(cw, g.pieces).then(function (states) {
            var spent = g.pieces.filter(function (pr, i) { return states[i] === 'SPENT'; });
            var live = g.pieces.filter(function (pr, i) { return states[i] === 'UNSPENT'; });
            if (spent.length + live.length !== g.pieces.length) return null;      // something pending: next time
            var forget = function () {
              var all = atRiskAll();
              delete all[g.hash];
              save(K.atRisk, all);
              try { FoxyWallet.tag(g.hash, { atRisk: false }); } catch (x) {}
            };
            /* Redeemed is not always stolen. A receiver that means to send
             * the payment back swaps these very pieces to make the refund,
             * and if the link went first that refund is a code on its
             * screen. So the record is kept, emptied, as a note of which
             * request it was: a refund locked to that request's key is still
             * known for what it is when it comes (`atRiskRefundOf`), and the
             * entry stops saying the payment was taken. */
            var entomb = function (took) {
              var all = atRiskAll();
              var was = all[g.hash] || {};
              all[g.hash] = { taken: true, req: was.req || g.req || '', mint: here, at: Date.now(), sats: took, secrets: [], why: was.why || '' };
              save(K.atRisk, all);
              try { FoxyWallet.tag(g.hash, { atRisk: false }); } catch (x) {}
            };
            if (spent.length) {
              /* Redeemed after the refusal. Out of the pile, and the entry is
               * the payment it turned out to be. */
              var gone = {};
              spent.forEach(function (pr) { gone[pr.secret] = true; });
              setProofs(proofs(here).filter(function (pr) { return !(pr && gone[pr.secret]); }), here, w);
              var took = sumProofs(spent);
              try {
                amendTx(g.hash, { state: 'success', settled: true, highRisk: false, taken: true, sats: took,
                                  memo: 'ecash, taken after a refusal' });
              } catch (x) {}
              console.warn('[foxy] ecash a phone refused has since been redeemed: ' + took + ' sats; its entry says paid');
              out.push({ state: 'taken', hash: g.hash, sats: took });
              if (!live.length) { entomb(took); return null; }
            }
            /* Unspent: swapped for fresh pieces, as a split of this phone's
             * own pile is, so a lost answer is restored by the same record
             * and no entry is written for money that never left. */
            var token = window.CashuTS.getEncodedToken({ mint: here, proofs: live, unit: 'sat' });
            var guard = swapGuard(cw, 'split', { inputs: live });
            return guard.run('receive', function () { return cw.receive(token); }).then(function (fresh) {
              var old = {};
              live.forEach(function (pr) { old[pr.secret] = true; });
              setProofs(proofs(here).filter(function (pr) { return !(pr && old[pr.secret]); }).concat(fresh || []), here, w);
              guard.done();
              var fee = Math.max(0, sumProofs(live) - sumProofs(fresh || []));
              if (fee > 0) chargeUnsentFee(here, fee);
              if (spent.length) entomb(sumProofs(spent)); else forget();
              try { amendTx(g.hash, { highRisk: false, takenBack: true }); } catch (x) {}
              console.log('[foxy] ecash at risk is safe again: ' + sumProofs(fresh || []) + ' sats swapped for pieces nobody has seen');
              if (!spent.length) out.push({ state: 'safe', hash: g.hash, sats: sumProofs(fresh || []) });
            });
          }).catch(function (e) {
            console.warn('[foxy] ecash at risk could not be settled yet:', FoxyWallet.reason ? FoxyWallet.reason(e) : (e && e.message));
          });
        });
      }, Promise.resolve()).then(function () { return out; });
    },

    /* Is the connected mint's Lightning node known yet? */
    mintNodeKnown: function () { return !!(mintUrl && mintNodeOf(mintUrl)); },

    /* The connected mint's node, asked for now when it is not known. Resolves
     * the node, or null when the mint cannot be asked. */
    learnThisMintNode: function () {
      var u = mintUrl, w = wallet;
      if (!u || !w) return Promise.resolve(null);
      var known = mintNodeOf(u);
      if (known) return Promise.resolve(known);
      if (!routeOpen()) return Promise.resolve(null);
      return askMintNode(u, w).then(null, function () { return null; });
    },

    /* Watch the token logged under `hash` until it is redeemed. opts.persist:
     * keep watching after its screen closes. Resolves nothing; false when there
     * is no token to watch. */
    watchTokenClaim: function (hash, opts) {
      var text = tokenTextFor(hash);
      var ys = text ? tokenYsOf(text) : null;
      var info = text ? FoxyWallet.tokenInfo(text) : null;
      if (!ys || !info || !info.mint) return false;
      var list = tokenWatches().filter(function (r) { return r.hash !== hash; });
      list.push({ hash: hash, mint: canonicalMint(info.mint), ys: ys, sats: Number(info.sats) || 0,
                  persist: !!(opts && opts.persist), quick: !!(opts && opts.quick),
                  since: Date.now(), until: Date.now() + TOKEN_WATCH_MS });
      save(K.tokenWatch, list.slice(-10));
      return true;
    },

    /* Payments taken on trust while both phones were offline and not yet swapped
     * in: [{ id, sats, at }], newest first.
     *
     * This is money that is counted in the balance and that the payer can still
     * take back. It is the only kind of pending money in Foxy that somebody else
     * can make disappear, so the home screen rings red for it and history says so
     * on the row. Empty is the normal state.
     *
     * Local and synchronous, like `watchedTokens`: a render reads it. */
    trustedWaiting: function () {
      var all = unclaimed();
      /** @type {Array<{ id: string, sats: number, at: number }>} */
      var out = [];
      Object.keys(all).forEach(function (id) {
        var one = all[id] || {};
        if (!one.trusted) return;
        out.push({ id: id, sats: Number(one.sats) || 0, at: Number(one.at) || 0 });
      });
      return out.sort(function (a, b) { return b.at - a.at; });
    },

    /* Everything arrived and not yet swapped in, in sats. Local and instant; the
     * balance already counts it. The app asks before running a claim on a route
     * coming back, so an empty list costs nothing. */
    unclaimedSats: function (at) {
      return unclaimedSats(at);
    },

    trustedWaitingSats: function () {
      return FoxyWallet.trustedWaiting().reduce(function (n, r) { return n + r.sats; }, 0);
    },

    watchedTokens: function () {
      return tokenWatches().map(function (r) {
        return { hash: r.hash, mint: r.mint, sats: r.sats, persist: !!r.persist, quick: !!r.quick, since: r.since || 0 };
      });
    },

    dropTokenWatch: function (hash) {
      var list = tokenWatches();
      var left = list.filter(function (r) { return r.hash !== hash; });
      if (left.length !== list.length) save(K.tokenWatch, left);
    },

    /* Has the watched token been redeemed? 'claimed', 'waiting', 'offline' when
     * it could not be asked because Tor is not up, or null when nothing watches
     * it. Its Ys only, on the token's own circuit, at whatever mint issued it;
     * no answer is 'waiting'. */
    tokenClaimState: function (hash) {
      var rec = tokenWatches().filter(function (r) { return r.hash === hash; })[0];
      if (!rec) return Promise.resolve(null);
      // 'offline': not asked, Tor is not up (just back from the background, say)
      if (!bridged() || !routeOpen()) return Promise.resolve('offline');
      /* In pieces the mint will take. This POSTs one Y per proof in the
       * token, and a big token has plenty — a mint advertising a small
       * max_array_length (NUT-06, which CDK 0.18 and Nutshell 0.21 began
       * sending) would refuse the whole request, and the watch would read
       * 'waiting' for ever on a token that had in fact been redeemed. Every
       * chunk rides the token's own circuit, as the single request did. */
      var cap = mintArrayCap(wallet);
      return inChunks(rec.ys, cap, function (part) {
        return FoxyWallet.nativeRequest({
          endpoint: rec.mint + '/v1/checkstate', method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          requestBody: { Ys: part }, foxyCircuit: circuitFor('token:' + hash),
        }).then(function (j) { return (j && j.states) || []; });
      }).then(function (states) {
        var spent = states.filter(function (st) { return st && String(st.state).toUpperCase() === 'SPENT'; }).length;
        return states.length === rec.ys.length && spent === rec.ys.length ? 'claimed' : 'waiting';
      }, function () { return 'waiting'; });
    },

    /* Clear the contact book. Contacts are just names this phone saved against
     * handles; nothing about the wallet changes. */
    clearContacts: function () {
      save('foxy.contacts', []);
      return true;
    },

    remember: function (handle, name) {
      var h = String(handle || '').trim().replace(/^lightning:/i, '');
      if (!h || FoxyWallet.classify(h) !== 'lnurl') return FoxyWallet.book();
      var list = FoxyWallet.book().filter(function (c) {
        return String(c.handle).toLowerCase() !== h.toLowerCase();
      });
      list.unshift({
        handle: h,
        name: name || (h.indexOf('@') > 0 ? h.split('@')[0] : 'LNURL'),
        at: Date.now(),
      });
      save('foxy.contacts', list.slice(0, 50));
      return list;
    },

    forgetContact: function (handle) {
      var h = String(handle || '').toLowerCase();
      var list = FoxyWallet.book().filter(function (c) {
        return String(c.handle).toLowerCase() !== h;
      });
      save('foxy.contacts', list);
      return list;
    },

    /* True only when a failure is known to have asked the mint nothing, so a
     * caller can tell "the mint said no" from "the request never left". The
     * counters have always needed this (00-header-and-mint-errors.js); the
     * receive screen needs it too, to stop spending its three tries on a
     * network that is still closed. */
    neverSent: function (err) {
      return neverSent(err);
    },

    reason: function (err) {
      var m = (err && (err.message || err.detail)) || 'Something went wrong.';
      if (/failed to fetch|networkerror|load failed/i.test(m)) {
        return 'Could not reach the mint. Check the address and your connection.';
      }
      if (/not enough ecash|insufficient|balance/i.test(m)) return m;
      if (/route|no path/i.test(m)) return "The mint couldn't find a path to that wallet.";
      if (/bolt ?11 from backend|could not fetch bolt/i.test(m)) {
        return 'That mint answers, but its lightning node will not issue an invoice ' +
               'right now, so there is nothing to pay. Nothing was spent. Try another ' +
               'mint, or switch without moving the balance.';
      }
      if (/dleq verification failed|dleq proof invalid/i.test(m)) {
        return 'The mint sent signatures that do not match the keys it publishes, so Foxy did not accept them.';
      }
      if (/p2pk|spend conditions/i.test(m)) {
        return 'That ecash is locked to somebody else\u2019s key, so this wallet cannot spend it.';
      }
      if (/already spent|token already/i.test(m)) {
        return 'Already claimed \u2014 somebody took this token.';
      }
      if (/expired/i.test(m)) return 'That quote expired. Create a new one.';
      if (/quote is not on this device/i.test(m)) {
        return 'This payment was requested on another device, so only that one can claim it.';
      }
      // A routing failure comes back as the node's whole attempt log — the same
      // channel error repeated once per try. It is worth keeping, in the
      // console; it is not worth pouring down the screen.
      if (/temporary_channel_failure|no route|route not found|timed out after \d+ attempt|payment failed/i.test(m)) {
        console.warn('[foxy] routing failure in full:', m);
        return 'The two nodes could not find a lightning route between them. ' +
               'Nothing was spent \u2014 your balance is still at this mint. Try another mint.';
      }
      if (m.length > 220) {
        console.warn('[foxy] full error:', m);
        return m.slice(0, 200).replace(/\s+\S*$/, '') + '\u2026';
      }
      return m;
    },

