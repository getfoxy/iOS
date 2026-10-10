  /* ---- Bitcoin block headers: the clock of a Foxy card (software 1.15 and on) --------------
   *
   * A card has no clock of its own, and since software 1.15 nobody tells it the time under a
   * signature. Its time is the time written in the newest Bitcoin block header it has been shown
   * (SET_HEADER), and it believes a header for what the header would have cost to make, not for who
   * brings it: it hashes the 80 bytes twice and the hash, read as a number, must be at or under the
   * target the header's own `bits` name, which is the work of ten minutes of the whole network; the
   * target must be no easier than the floor built into the card, nor easier than four times the
   * target of the hardest header it has taken. Nobody can show it a block from tomorrow, because
   * nobody has tomorrow's work, so a phone, a till and a stranger's reader all carry its clock
   * forward the same way and none of them is trusted for it (docs/CARD.md, "The time").
   *
   * This phone's part is to bring the card the newest header it can get. It asks two block
   * explorers, mempool.space and Blockstream, each at its onion address (no exit can turn an onion
   * away, and neither learns where this phone is), each on a circuit of its own; when neither onion
   * gave a header it could use (a fresh Tor can take longer to reach an onion service than the ask
   * allows), it asks the same two by their ordinary names through a Tor exit, as the price falls
   * back from mempool's onion to the clearnet; and it keeps the newest header that passes what is
   * checked below. A tap uses what is kept and never waits for
   * the fetch (`cardClock`, 08a-flashcard.js): the fetch happens when Tor comes up, when the app
   * comes back to the front and when a card is tapped, if the one kept is older than ten minutes
   * and the phone is online, and never more than once a minute after a failure. There is no timer
   * here: nothing runs that has to be stopped.
   *
   * What is checked before a header is believed:
   *   - it is 80 bytes of hex, and it is the block the source named as its tip (the hash of the
   *     header is the hash it was asked for: a source cannot hand over another block);
   *   - its hash is at or under its own target: the work is real, whoever sent it;
   *   - its time is within three hours of this phone's clock, ahead or behind, so a source that is
   *     stale, or a phone whose clock is wrong, is not taken for the network's time;
   *   - the two sources name the same tip. With only one answering, or one of the two failing the
   *     checks, the other is taken if it passes them, and the log says so.
   * Whatever the card thinks of it is the card's to say (a header under its floor is refused 6A93):
   * the floor rises with the network, in the card's software, and is not copied here.
   *
   * The phone's clock is the middle of the three hours above, and it is the time the card is told
   * as a note (TELL_TIME), which the card writes into its receipts and its log and trusts for
   * nothing. Foxy's native side gives the page no view of the network's time to check that clock
   * against (Tor will not use a consensus that is not current by its own clock, so a clock hours out
   * tends not to get a route at all, and that is all it says), so the device clock stands alone. */
  var CARD_HEADER = 'foxy.flashcard.header';
  /* The two sources, by their onion addresses, which the explorers publish as their Onion-Location. Both speak the
   * explorer API of Esplora, the one that answers `/api/blocks/tip/hash` with the tip's hash and
   * `/api/block/<hash>/header` with the 80 bytes of its header as hex. */
  var HEADER_SOURCES = [
    { name: 'mempool.space', url: 'http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion' },
    { name: 'blockstream.info', url: 'http://explorerzydxu5ecjrkwceayqybizmpjjznk5izmitf2modhcusuqlid.onion' },
  ];
  /* The same two by their ordinary addresses, asked through a Tor exit only when neither onion answered: a fresh
   * Tor can take longer to reach an onion service than the ask allows, and the price feed's walk found the same
   * (its onion first, then the clearnet). The header is public and the card checks its work itself, so where it
   * came from changes nothing about trust; an exit learns that this phone asked for the newest block, as it does
   * for the price. */
  var HEADER_SOURCES_EXIT = [
    { name: 'mempool.space (exit)', url: 'https://mempool.space' },
    { name: 'blockstream.info (exit)', url: 'https://blockstream.info' },
  ];
  // a kept header is refreshed when it is older than this (when it was fetched, not when its block was made)
  var HEADER_FRESH_MS = 10 * 60 * 1000;
  // and not asked for again sooner than this after a try that kept nothing
  var HEADER_RETRY_MS = 60 * 1000;
  // how far a header's time may be from this phone's clock, in seconds
  var HEADER_SKEW = 3 * 3600;
  // one request to one source: it is an onion, so a cold circuit is seconds of work
  var HEADER_ASK_MS = 25000;

  /* The target a header's `bits` name (the card's `targetOf`), as 64 hex digits: the three-byte mantissa placed
   * `exponent` bytes up from the bottom of 32. `bits` is the header's four bytes read little-endian, so the exponent
   * is the top byte. null for a difficulty no header could carry: a size of 0 or past 32, or a mantissa with its top
   * bit set (a negative target). */
  function headerTarget(bits) {
    var b = Number(bits) >>> 0, exp = b >>> 24, man = b & 0xffffff;
    if (exp < 1 || exp > 32 || (man & 0x800000)) return null;
    var out = [];
    for (var i = 0; i < 32; i++) out.push(0);
    var parts = [(man >>> 16) & 255, (man >>> 8) & 255, man & 255];
    for (var k = 0; k < 3; k++) {
      var at = 32 - exp + k;
      if (at < 32) out[at] = parts[k];
    }
    return hexOf(out);
  }

  /* An 80-byte header, read. Throws when it is not one. `hash` is the block's hash as Bitcoin shows it (the double
   * SHA-256 of the 80 bytes, turned round); `worked`: that hash is at or under the target its own bits name, which is
   * all the work there is to see. `bitsHex` is the four bytes as the header carries them. */
  function headerParse(hex) {
    var h = String(hex === undefined || hex === null ? '' : hex).trim().toLowerCase();
    if (!/^[0-9a-f]{160}$/.test(h)) throw new Error('That is not a block header: it is not 80 bytes.');
    var bytes = Array.prototype.slice.call(bytesOfHex(h));
    var u32 = function (at) { return (bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536 + bytes[at + 3] * 16777216); };
    var shown = sha256(sha256(bytes)).reverse();
    var hash = hexOf(shown);
    var bits = u32(72);
    var target = headerTarget(bits);
    return { hex: h, version: u32(0), time: u32(68), bits: bits, bitsHex: h.substr(144, 8), nonce: u32(76), hash: hash,
             prev: hexOf(bytes.slice(4, 36).reverse()), target: target || '', worked: !!target && hash <= target };
  }

  /* A block hash for a line of text: as Bitcoin shows it, it begins with as many zeros as the network's work asks for
   * (eighteen or more of them, now) so the first eight digits of every hash are the same. The eight after the zeros are
   * what tells one block from another. '' where there is no hash. */
  function headerShort(hash) {
    var h = String(hash || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h) || /^0+$/.test(h)) return '';
    return h.replace(/^0+/, '').slice(0, 8);
  }

  /* What this phone has kept: { hex, time, hash, bits, at } (`at`: when it was fetched, in ms), or null. It is read again
   * from its 80 bytes, and what is stored beside them is not believed. */
  function headerKept() {
    var rec = load(CARD_HEADER, null);
    if (!rec || typeof rec !== 'object' || typeof rec.hex !== 'string') return null;
    var at = Number(rec.at) || 0;
    try {
      var h = headerParse(rec.hex);
      if (!h.worked) return null;
      return { hex: h.hex, time: h.time, hash: h.hash, bits: h.bits, at: at };
    } catch (e) { return null; }
  }

  /* Whether a header read off the wire is one to believe at `nowSec` (this phone's clock, in seconds): '' if so,
   * and otherwise what is wrong with it, in words for the log. */
  function headerProblem(h, nowSec) {
    if (!h.target) return 'its difficulty is one no block carries';
    if (!h.worked) return 'its hash is over the target its own difficulty names';
    if (Math.abs(h.time - nowSec) > HEADER_SKEW) {
      return 'its time is more than three hours ' + (h.time > nowSec ? 'ahead of' : 'behind') + ' this phone’s clock';
    }
    return '';
  }

  // a promise that gives up, and lets go of its timer whichever way it ends
  function headerWithin(promise, ms, label) {
    return new Promise(function (ok, no) {
      var timer = setTimeout(function () { no(new Error(label + ' did not answer within ' + Math.round(ms / 1000) + 's.')); }, ms);
      Promise.resolve(promise).then(function (v) { clearTimeout(timer); ok(v); }, function (e) { clearTimeout(timer); no(e); });
    });
  }

  // an answer's text as a bare string: trimmed, and out of the quotes a source that answers JSON puts round it
  function headerText(body) {
    return String(body === undefined || body === null ? '' : body).trim().replace(/^"([^"]*)"$/, '$1').trim();
  }

  /* One source's tip and its header, on the circuit `label` (both requests ride it). Rejects with why not. */
  function headerAsk(source, label) {
    var get = function (path) {
      return headerWithin(FoxyWallet.nativeRequest({ endpoint: source.url + path, method: 'GET', foxyText: true, foxyCircuit: label }),
                          Number(FoxyWallet._headerAskMs) || HEADER_ASK_MS, source.name);
    };
    return Promise.resolve().then(function () { return get('/api/blocks/tip/hash'); }).then(function (text) {
      var tip = headerText(text).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(tip)) throw new Error('what it called the tip is not a block hash');
      return get('/api/block/' + tip + '/header').then(function (body) {
        var header = headerParse(headerText(body));
        if (header.hash !== tip) throw new Error('the header it gave is not the block it named');
        return { source: source.name, tip: tip, header: header };
      });
    });
  }

  var headerFlight = null;    // the fetch in hand, shared by whoever asks while it runs
  var headerTried = 0;        // when the last one began

  /* Ask both sources and decide. Resolves { kept, fetched, why }: `kept` what this phone has now, `fetched` whether
   * it changed (a header newer than the one before, or the same one seen again), `why` in words. Never rejects. */
  function headerFetch() {
    var began = Date.now();
    var nowSec = function () { return Math.floor(Date.now() / 1000); };
    // one wave of sources, asked together, each on a circuit of its own: what each gave, or why not
    var wave = function (sources) {
      var labels = sources.map(function () { return newCircuitLabel(); });
      return Promise.all(sources.map(function (src, i) {
        return headerAsk(src, labels[i]).then(function (got) { return { name: src.name, got: got, why: '' }; },
                                              function (e) { return { name: src.name, got: null, why: String((e && e.message) || e) }; });
      }));
    };
    var notes = [];
    var sift = function (results) {
      var usable = [];
      var at = nowSec();
      results.forEach(function (r) {
        if (!r.got) { notes.push(r.name + ': ' + r.why); return; }
        var problem = headerProblem(r.got.header, at);
        if (problem) { notes.push(r.name + ': ' + problem); return; }
        usable.push(r.got);
      });
      return usable;
    };
    return wave(HEADER_SOURCES).then(function (results) {
      var usable = sift(results);
      if (usable.length) return usable;
      // neither onion answered with a header this phone could use: the same two by their ordinary addresses, through an exit
      return wave(HEADER_SOURCES_EXIT).then(sift);
    }).then(function (usable) {
      var before = headerKept();
      var say = function (words) { console.log('[foxy] card clock: ' + words + ' (' + (Date.now() - began) + ' ms)'); };
      if (!usable.length) {
        say('no block header could be used: ' + notes.join('; '));
        return { kept: before, fetched: false, why: 'none' };
      }
      var tips = usable.map(function (u) { return u.tip; }).filter(function (t, i, a) { return a.indexOf(t) === i; });
      if (tips.length > 1) {
        say('the sources name different tips (' + tips.map(headerShort).join(', ') + '); nothing is kept');
        return { kept: before, fetched: false, why: 'disagree' };
      }
      var chosen = usable[0].header;
      if (usable.length === 1) {
        say('only ' + usable[0].source + ' gave a header this phone could use (' + notes.join('; ') + '); block ' + headerShort(chosen.hash)
            + ' (time ' + chosen.time + ') taken on its word alone');
      }
      if (before && before.time > chosen.time) {
        say('the block ' + headerShort(chosen.hash) + ' is older than the one kept, ' + headerShort(before.hash) + '; the one kept stands');
        return { kept: before, fetched: false, why: 'older' };
      }
      var rec = { hex: chosen.hex, time: chosen.time, hash: chosen.hash, at: Date.now() };
      save(CARD_HEADER, rec);
      if (usable.length >= 2) say('block ' + headerShort(chosen.hash) + ' (time ' + chosen.time + ') is the tip of ' + usable.map(function (u) { return u.source; }).join(' and '));
      return { kept: headerKept(), fetched: true, why: usable.length >= 2 ? 'agree' : 'one' };
    });
  }

  /* The newest header, fetched when the one kept is older than ten minutes and the phone has a route; the one in
   * flight is shared. `opts.force` asks regardless of age and of the minute's rest. Resolves { kept, fetched, why }
   * and never rejects. */
  function headerRefresh(opts) {
    var o = opts || {};
    var kept = headerKept();
    var now = Date.now();
    var age = kept ? now - kept.at : Infinity;
    if (!o.force && kept && age >= 0 && age < HEADER_FRESH_MS) return Promise.resolve({ kept: kept, fetched: false, why: 'fresh' });
    if (headerFlight) return headerFlight;
    if (!o.force && now - headerTried >= 0 && now - headerTried < HEADER_RETRY_MS) return Promise.resolve({ kept: kept, fetched: false, why: 'tried lately' });
    if (!bridged() || !routeOpen()) return Promise.resolve({ kept: kept, fetched: false, why: 'offline' });
    headerTried = now;
    var run = headerFetch().then(null, function (e) {
      console.warn('[foxy] card clock: the fetch failed:', (e && e.message) || e);
      return { kept: headerKept(), fetched: false, why: 'failed' };
    });
    headerFlight = run;
    var free = function () { if (headerFlight === run) headerFlight = null; };
    run.then(free, free);
    return run;
  }

  /* Ask in the background, for a moment when a header is wanted soon (Tor has come up, the app is back, a card is
   * being tapped). Silent, and off where a test says so. */
  function headerSoon() {
    if (FoxyWallet._headersOff) return;
    headerRefresh().then(null, function () {});
  }

  /* The same a few seconds on, for Tor coming up and the app coming back, so that it does not ride on the heels of the
   * circuit being made ready (`warmSpareSoon`) or of the mint being reached: those come first. One timer that runs
   * once and is gone. */
  function headerLater() {
    if (FoxyWallet._headersOff) return;
    setTimeout(headerSoon, FoxyWallet._headerAfterMs === undefined ? 4000 : FoxyWallet._headerAfterMs);
  }
