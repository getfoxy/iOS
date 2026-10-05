  /* ---- reading a Bitcoin address -------------------------------------------
   *
   * For paying on chain (16a-onchain.js). A mistyped address is money sent
   * nowhere, so both kinds are checked properly rather than by shape:
   *
   *   - bech32 and bech32m (bc1…), by their own checksum, with the witness
   *     version and program length the rules allow;
   *   - base58 (1… and 3…), by the four-byte double-SHA-256 checksum.
   *
   * Mainnet only: this wallet's mints settle in mainnet bitcoin, and a testnet
   * address that looked fine here would be refused at the mint with the person
   * none the wiser. The mint checks the address again before anything is spent
   * (onchainQuote), so this is the first of two gates, not the only one.
   */

  var B32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var B58_CHARSET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  function b32Polymod(values) {
    var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    var chk = 1;
    for (var i = 0; i < values.length; i++) {
      var top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ values[i];
      for (var k = 0; k < 5; k++) if ((top >>> k) & 1) chk ^= GEN[k];
    }
    return chk >>> 0;
  }

  function b32Expand(prefix) {
    var out = [];
    for (var i = 0; i < prefix.length; i++) out.push(prefix.charCodeAt(i) >> 5);
    out.push(0);
    for (var k = 0; k < prefix.length; k++) out.push(prefix.charCodeAt(k) & 31);
    return out;
  }

  /* A segwit address, or null: the witness version and program, checked the way
   * BIP-173 and BIP-350 ask (version 0 takes bech32, later versions bech32m). */
  function segwitAddress(text) {
    var t = String(text || '');
    if (t !== t.toLowerCase() && t !== t.toUpperCase()) return null;   // never mixed case
    t = t.toLowerCase();
    if (t.length < 14 || t.length > 74) return null;
    if (t.slice(0, 3) !== 'bc1') return null;
    var data = t.slice(3);
    var values = [];
    for (var i = 0; i < data.length; i++) {
      var at = B32_CHARSET.indexOf(data.charAt(i));
      if (at < 0) return null;
      values.push(at);
    }
    if (values.length < 7) return null;
    var check = b32Polymod(b32Expand('bc').concat(values));
    var version = values[0];
    if (version > 16) return null;
    if (check !== (version === 0 ? 1 : 0x2bc830a3)) return null;
    // the program itself: five-bit groups back into bytes
    var acc = 0, bits = 0, program = [];
    for (var n = 1; n < values.length - 6; n++) {
      acc = (acc << 5) | values[n];
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        program.push((acc >> bits) & 0xFF);
      }
    }
    if (bits >= 5 || ((acc << (8 - bits)) & 0xFF)) return null;        // no loose padding
    if (program.length < 2 || program.length > 40) return null;
    if (version === 0 && program.length !== 20 && program.length !== 32) return null;
    return t;
  }

  /* The bytes behind a base58 string, big-endian, or null.
   *
   * Written out per digit: each new digit multiplies what is there by 58 and
   * carries. An earlier version summed every byte into one number instead,
   * which gave the right answer for nothing and passed no address at all. */
  function base58Decode(text) {
    var t = String(text || '');
    var bytes = [];
    for (var i = 0; i < t.length; i++) {
      var value = B58_CHARSET.indexOf(t.charAt(i));
      if (value < 0) return null;
      for (var k = bytes.length - 1; k >= 0; k--) {
        value += 58 * bytes[k];
        bytes[k] = value & 0xFF;
        value = Math.floor(value / 256);
      }
      while (value > 0) { bytes.unshift(value & 0xFF); value = Math.floor(value / 256); }
    }
    for (var z = 0; z < t.length && t.charAt(z) === '1'; z++) bytes.unshift(0);
    return bytes;
  }

  /* A base58 address (1… or 3…), by its checksum. */
  function base58Address(text) {
    var t = String(text || '');
    if (!/^[13][1-9A-HJ-NP-Za-km-z]{24,34}$/.test(t)) return null;
    var bytes = base58Decode(t);
    if (!bytes || bytes.length !== 25) return null;
    if (bytes[0] !== 0x00 && bytes[0] !== 0x05) return null;           // mainnet P2PKH and P2SH
    var body = bytes.slice(0, 21), tail = bytes.slice(21);
    var sum = sha256(sha256(body));
    for (var c = 0; c < 4; c++) if (sum[c] !== tail[c]) return null;
    return t;
  }

  function bitcoinAddress(text) {
    return segwitAddress(text) || base58Address(text);
  }

  /* A scanned or pasted address with the amount, when a bitcoin: URI carries
   * one (BIP-21). Null when it is not an address this wallet can pay. */
  /* An address as history shows it: enough of both ends to recognise. */
  function shortAddress(address) {
    var t = String(address || '');
    return t.length > 20 ? t.slice(0, 10) + '\u2026' + t.slice(-6) : t;
  }

  function readBitcoinAddress(text) {
    var t = String(text || '').trim();
    var sats = 0;
    var uri = /^bitcoin:([^?\s]+)(\?([^\s]*))?$/i.exec(t);
    if (uri) {
      t = uri[1].trim();
      var amount = /(^|&)amount=([0-9]*\.?[0-9]+)/i.exec(uri[3] || '');
      if (amount) {
        var btc = Number(amount[2]);
        // BIP-21 amounts are in BTC; anything absurd is not an amount
        if (isFinite(btc) && btc > 0 && btc < 21000000) sats = Math.round(btc * 1e8);
      }
    }
    var address = bitcoinAddress(t);
    if (!address) return null;
    return { address: address, sats: sats };
  }

