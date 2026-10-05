  /* ---- animated QR codes, for tokens too dense for one ---------------------
   *
   * A token of several proofs makes a QR code too fine for some cameras.
   * cashu.me shows such a token as a loop of frames instead, Blockchain Commons'
   * Uniform Resources (UR): the token's bytes wrapped as CBOR, cut into
   * fragments, sent as a fountain code, `ur:bytes/<n>-<count>/<bytewords>`.
   * Frames 1…count carry the fragments; later frames XOR a random set of them,
   * so a missed frame is made up by later ones. Foxy's scanner reads the same
   * (Foxy/Scanner/AnimatedQR.swift).
   *
   * Written here from what cashu.me runs, @gandlaf21/bc-ur 1.1.12, rather than
   * bundled. tests/animated-qr.js checks that these frames are, character for
   * character, the frames that library makes for the same token
   * (tests/fixtures/animated-qr.json), down to how bignumber.js rounds the
   * division that picks which fragments a frame mixes. */

  var UR_BYTEWORDS = 'ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom';

  var CRC_TABLE = (function () {
    var t = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32Of(bytes) {
    var crc = -1;
    for (var i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ -1) >>> 0;
  }

  /* Bytewords, minimal style: first and last letter of each byte's word, with
   * a CRC-32 of the bytes appended. */
  function bytewordsMinimal(bytes) {
    var sum = crc32Of(bytes);
    var all = bytes.concat([(sum >>> 24) & 0xFF, (sum >>> 16) & 0xFF, (sum >>> 8) & 0xFF, sum & 0xFF]);
    var out = '';
    for (var i = 0; i < all.length; i++) out += UR_BYTEWORDS.charAt(all[i] * 4) + UR_BYTEWORDS.charAt(all[i] * 4 + 3);
    return out;
  }

  /* A CBOR head, in its shortest form, as cborg writes it. */
  function cborHead(major, n) {
    var m = major << 5;
    if (n < 24) return [m | n];
    if (n < 0x100) return [m | 24, n];
    if (n < 0x10000) return [m | 25, (n >>> 8) & 0xFF, n & 0xFF];
    return [m | 26, (n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
  }

  /* xoshiro256**, seeded from SHA-256 of the seed bytes. */
  var U64 = (BigInt(1) << BigInt(64)) - BigInt(1);

  function xoshiro(seedBytes) {
    var digest = sha256(seedBytes);
    var s = [];
    for (var i = 0; i < 4; i++) {
      var v = BigInt(0);
      for (var n = 0; n < 8; n++) v = (v << BigInt(8)) | BigInt(digest[i * 8 + n]);
      s.push(v);
    }
    var rotl = function (x, k) { return ((x << BigInt(k)) & U64) | (x >> BigInt(64 - k)); };
    var ten20 = BigInt('100000000000000000000');
    var half = BigInt(1) << BigInt(63);
    function next() {
      var result = (rotl((s[1] * BigInt(5)) & U64, 7) * BigInt(9)) & U64;
      var t = (s[1] << BigInt(17)) & U64;
      s[2] ^= s[0];
      s[3] ^= s[1];
      s[1] ^= s[2];
      s[0] ^= s[3];
      s[2] ^= t;
      s[3] = rotl(s[3], 45);
      return result;
    }
    /* next() / 2^64, rounded half up to 20 decimal places and read as a
     * number: bignumber.js's default division, which the encoder uses. */
    function nextDouble() {
      var d = (next() * ten20 + half) >> BigInt(64);
      if (d >= ten20) return 1;
      var digits = d.toString();
      while (digits.length < 20) digits = '0' + digits;
      return Number('0.' + digits);
    }
    return {
      nextDouble: nextDouble,
      nextInt: function (low, high) { return Math.floor(nextDouble() * (high - low + 1) + low); },
    };
  }

  /* @apocentre/alias-sampling 0.5.3's table for weights 1/1 … 1/n, in its order. */
  var aliasTables = {};

  function aliasTable(n) {
    if (aliasTables[n]) return aliasTables[n];
    var p = [], sum = 0, i;
    for (i = 0; i < n; i++) { p[i] = 1 / (i + 1); sum += p[i]; }
    var P = [], S = [], L = [], prob = [], alias = [];
    for (i = 0; i < n; i++) P[i] = p[i] * n / sum;
    for (i = n - 1; i >= 0; --i) { if (P[i] < 1) S.push(i); else L.push(i); }
    while (S.length && L.length) {
      var a = S.pop(), g = L.pop();
      prob[a] = P[a];
      alias[a] = g;
      P[g] = P[g] + P[a] - 1;
      if (P[g] < 1) S.push(g); else L.push(g);
    }
    while (L.length) prob[L.pop()] = 1;
    while (S.length) prob[S.pop()] = 1;
    if (Object.keys(aliasTables).length > 16) aliasTables = {};
    aliasTables[n] = { prob: prob, alias: alias };
    return aliasTables[n];
  }

  function urChooseFragments(seqNum, seqLength, checksum) {
    if (seqNum <= seqLength) return [seqNum - 1];
    var seed = [(seqNum >>> 24) & 0xFF, (seqNum >>> 16) & 0xFF, (seqNum >>> 8) & 0xFF, seqNum & 0xFF,
                (checksum >>> 24) & 0xFF, (checksum >>> 16) & 0xFF, (checksum >>> 8) & 0xFF, checksum & 0xFF];
    var rng = xoshiro(seed);
    var table = aliasTable(seqLength);
    var c = Math.floor(rng.nextDouble() * seqLength);
    var degree = (rng.nextDouble() < table.prob[c] ? c : table.alias[c]) + 1;
    if (!(degree >= 1)) degree = 1;
    // the encoder shuffles every index; only the first `degree` are used
    var remaining = [], picked = [];
    for (var i = 0; i < seqLength; i++) remaining.push(i);
    while (picked.length < degree && remaining.length) {
      picked.push(remaining.splice(rng.nextInt(0, remaining.length - 1), 1)[0]);
    }
    return picked;
  }

  /* An endless run of frames for `text`, fragments of at most `maxFragment`
   * bytes: { count, next() }. One fragment gives a single `ur:bytes/…` frame. */
  function urEncoder(text, maxFragment) {
    var body = Array.prototype.slice.call(new TextEncoder().encode(String(text)));
    var message = cborHead(2, body.length).concat(body);
    var max = Math.max(10, Number(maxFragment) || 100);
    var fragmentLength = 0;
    for (var count = 1; count <= Math.ceil(message.length / 10); count++) {
      fragmentLength = Math.ceil(message.length / count);
      if (fragmentLength <= max) break;
    }
    var fragments = [];
    for (var at = 0; at < message.length; at += fragmentLength) {
      var f = message.slice(at, at + fragmentLength);
      while (f.length < fragmentLength) f.push(0);
      fragments.push(f);
    }
    var checksum = crc32Of(message);
    var seq = 0;
    return {
      count: fragments.length,
      next: function () {
        seq = (seq + 1) >>> 0;
        if (fragments.length === 1) return 'ur:bytes/' + bytewordsMinimal(message);
        var mixed = [];
        for (var k = 0; k < fragmentLength; k++) mixed.push(0);
        urChooseFragments(seq, fragments.length, checksum).forEach(function (index) {
          for (var j = 0; j < fragmentLength; j++) mixed[j] ^= fragments[index][j];
        });
        var part = [0x85].concat(cborHead(0, seq), cborHead(0, fragments.length), cborHead(0, message.length),
          cborHead(0, checksum), cborHead(2, mixed.length), mixed);
        return 'ur:bytes/' + seq + '-' + fragments.length + '/' + bytewordsMinimal(part);
      },
    };
  }
