'use strict';
/* flashcard-card.js — a model of the Foxy card, for tests.
 *
 * The card is a JavaCard applet (the card's own repository, https://github.com/getfoxy/card;
 * its commands are in docs/FOXY-CARD-SPEC.md there). A wallet cannot be tested against a card
 * in a test run, so this answers the same commands with the same bytes: APDUs
 * in, as hex, and the answer out with its status word. It is held to the
 * applet by tests/flashcard-model.js, which replays a conversation the applet
 * had under jCardSim and compares every answer.
 *
 *     const card = makeCard({ window, key });  // window: the page's (its CashuTS signs); key: 64 hex
 *     const answer = await card.send('b001000000');
 *     card.tap();                                // the card leaves and comes back
 *     card.leaveAfter(2);                        // it leaves the field two commands from now
 *     card.setNonce(hex)                         // the nonce it last gave is this one (replaying a recording of the applet)
 *
 * Not a card: no EEPROM, no torn writes inside a command, and it signs in
 * microseconds. What it has in common is every rule the applet enforces.
 */
const crypto = require('crypto');
const { p256Verify } = require('./harness');

const AID = 'f0464f58594341524401';
const SLOTS = 64;
const PAGE_MAX = 255;
const DAY = 86400;
// how long a tap is, to the card, for the limit on one tap (the applet's TAP_SECONDS)
const TAP = 10;
const MINT_MAX = 80;
const ascii = (t) => Buffer.from(t, 'ascii');
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const u32 = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

function makeCard(opts) {
  const o = opts || {};
  const CT = o.window.CashuTS;
  // the library checks for its own realm's Uint8Array, which a Node Buffer is not
  const own = (buf) => o.window.Uint8Array.from(buf);
  /* Which card this is. Format 3 signs for one piece at a time (SPEND_PROOF, a signature over that piece's secret).
   * Format 4 signs once for a whole payment (NUT-11 SIG_ALL): every piece's secret carries the flag, SPEND_PROOF is
   * gone, and a payment is SPEND_ALL_BEGIN, its outputs, and SPEND_ALL_SIGN. Three unless asked for four. */
  const FORMAT = o.format === 4 ? 4 : 3;
  /* The card of format 4 is also the one whose second limit is not a ten-second window that refuses (the card of format
   * 3 keeps that, as the applet it models did) but the limit on ONE PAYMENT, with no clock: a payment over it is not
   * refused, it waits. Every limit's worth past the first costs WAIT_SIGNS signatures of the card's work, each asked for
   * by a SPEND_ALL_SIGN that answers two bytes (how many are still to come) in place of the signature. Nothing is
   * counted or remembered from one payment to the next. */
  const VERSION = FORMAT === 4 ? 5 : 3;
  const PACED = FORMAT === 4;
  const WAIT_SIGNS = 4;
  const priv = String(o.key || crypto.randomBytes(32).toString('hex'));
  const pub = hex(CT.getPubKeyFromPrivKey(own(Buffer.from(priv, 'hex'))));
  const s = {
    pin: null, pinState: 0, tries: 3, locked: false,
    // limit: the most the card signs for in a day, sats; 0 is none. timeKey: who may tell it the time (hex, 04 || X || Y)
    record: { set: false, unit: 0, limit: 0, refund: '00'.repeat(33), timeKey: '00'.repeat(65), mint: '' },
    // the card's own clock and its day: the latest signed time it has taken, when this day began, what it has signed for since
    now: 0, windowStart: 0, spent: 0,
    // the limit on one tap, which to the card is TAP seconds of that clock: the limit, when this tap began, what it has signed for in it
    tapLimit: 0, tapStart: 0, tapSpent: 0,
    /* The card's own log (the applet's cardLog): counts that only go up, the run of over-limit refusals in hand, and a
     * ring of the last eight taps. A tap, here, is one time in the field: `tapOpen` is gone with the power (`tap()`). */
    log: { taps: 0, sats: 0, refused: 0, tampers: 0, runAt: 0, run: 0,
           ring: Array.from({ length: 8 }, () => ({ time: 0, sats: 0, pieces: 0, refused: 0, flags: 0 })) },
    tapOpen: false,
    slots: Array.from({ length: SLOTS }, () => ({ status: 0, data: '' })),   // data: 81 bytes as hex
    // the owner's public key (hex, 04 || X || Y), given to a card with none or by the owner's proof, and never read out
    owner: null,
    // that the card has paid since it was last tapped (permanent): the next tap may put pieces on with no PIN, for the change
    changeDue: false,
    // the tap's own: what was verified, the nonce the card last gave (hex, good for one try), whether the owner has allowed
    // loading, and whether this is the tap after a payment (the note above, taken at SELECT)
    verified: false, nonce: null, grant: false, changeGrant: false, selected: false,
  };
  let leaveIn = -1, gone = false;
  let leaveAt = null;        // { ins, nth }: gone when the nth command of that instruction arrives
  let loseAt = null;         // { ins, nth }: the nth command of that instruction is carried out, and its answer is lost
  const sent = [];

  const amountOf = (slot) => parseInt(slot.data.substr(16, 8), 16);
  const dateOf = (slot) => parseInt(slot.data.substr(154, 8), 16);
  const secretOf = (slot) => {
    let text = '["P2PK",{"nonce":"' + slot.data.substr(24, 64) + '","data":"' + pub + '","tags":[';
    if (dateOf(slot)) text += '["locktime","' + dateOf(slot) + '"],["refund","' + s.record.refund + '"]' + (FORMAT === 4 ? ',' : '');
    // format 4: the flag is every piece's last tag, as the wallet's library writes it
    return text + (FORMAT === 4 ? '["sigflag","SIG_ALL"]' : '') + ']}]';
  };
  const sign = (digest) => {
    const sig = CT.schnorrSignDigest(own(digest), own(Buffer.from(priv, 'hex')));
    return typeof sig === 'string' ? sig : hex(sig);
  };
  const none = (n) => Buffer.alloc(n);
  /* The owner's proof at the front of an owner's command's data: its length (1), an ECDSA signature (P-256, SHA-256,
   * DER) by the owner key over label || nonce || everything after it. Answers { sw } when it is refused, and
   * { at, value } (where the value begins, and what it is) when it is the owner's. The nonce is spent by being tried. */
  const ownerProof = (label, data) => {
    if (!s.owner) return { sw: '6a90' };
    const nonce = s.nonce;
    s.nonce = null;
    if (!nonce || data.length < 1) return { sw: '6a91' };
    const len = data[0];
    if (len < 1 || len > 72 || data.length < 1 + len) return { sw: '6a91' };
    const value = data.subarray(1 + len);
    const message = Buffer.concat([ascii(label), Buffer.from(nonce, 'hex'), value]);
    return p256Verify(s.owner, message, hex(data.subarray(1, 1 + len))) ? { at: 1 + len, value } : { sw: '6a91' };
  };
  const unspent = () => s.slots.some((x) => x.status === 1);
  /* The log's entry for this time in the field, begun (the count of taps up by one, its place in the ring cleared and
   * given the clock) if nothing in it has been written down yet. */
  const stop = (n) => Math.min(4294967295, n);
  const logEntry = () => {
    if (!s.tapOpen) s.log.taps = stop(s.log.taps + 1);
    const at = (((s.log.taps & 0xff) - 1) & 7);
    if (!s.tapOpen) { s.log.ring[at] = { time: s.now, sats: 0, pieces: 0, refused: 0, flags: 0 }; s.tapOpen = true; }
    return s.log.ring[at];
  };
  /* A spend over a limit, written down and then refused: the third in a run inside one tap's ten seconds of the clock
   * marks the tap and counts the run. A clock that is behind the run's start (a new time key) begins a new run. */
  const refuse = (sw) => {
    const e = logEntry();
    s.log.refused = stop(s.log.refused + 1);
    if (e.refused < 255) e.refused += 1;
    if (s.log.run === 0 || s.now < s.log.runAt || s.now >= s.log.runAt + TAP) { s.log.runAt = s.now; s.log.run = 1; }
    else if (s.log.run < 255) s.log.run += 1;
    if (s.log.run === 3) s.log.tampers = stop(s.log.tampers + 1);
    if (s.log.run >= 3) e.flags |= 1;
    return sw;
  };
  /* The limits, held to what a payment's pieces are worth together (format 4): '' when it is within them; '6a92' with a
   * limit and no time; over the day or the tap, written down and refused. */
  const overLimits = (total, carry) => {
    if (s.record.limit !== 0 && s.now === 0) return '6a92';
    if (s.record.limit !== 0) {
      const t = (s.now >= s.windowStart + DAY ? 0 : s.spent) + total;
      if (carry || t > s.record.limit || t > 4294967295) return refuse('6a8f');
    }
    return '';
  };
  /* What a payment of `total` costs in time: the signatures of work before it is signed. */
  const waitsFor = (total, carry) => {
    if (s.tapLimit === 0) return 0;
    if (carry) return 255 * WAIT_SIGNS;
    return Math.min(255, Math.max(0, Math.ceil(total / s.tapLimit) - 1)) * WAIT_SIGNS;
  };
  /* SET_LIMIT's value, by either form: four bytes are the day's limit and leave the tap's; eight are both, the day's then
   * the tap's, and there a limit whose number does not change keeps its window and its count. A limit needs a time. */
  const writeLimit = (value) => {
    const both = value.length === 8;
    const day = value.readUInt32BE(0);
    const tap = both ? value.readUInt32BE(4) : 0;
    // the limit on one payment asks no clock, and so needs no time; the day's does
    if ((day !== 0 || (!PACED && both && tap !== 0)) && s.now === 0) return '6a92';
    if (!both || day !== s.record.limit) { s.record.limit = day; s.windowStart = s.now; s.spent = 0; }
    if (both && tap !== s.tapLimit) { s.tapLimit = tap; if (!PACED) { s.tapStart = s.now; s.tapSpent = 0; } }
    return '9000';
  };
  const u32of = (n) => u32(Number(n));
  const failPin = () => {
    s.verified = false;
    s.tries -= 1;
    if (s.tries <= 0) { s.tries = 0; s.pinState = 2; return '6983'; }
    return '63c' + s.tries;
  };

  function answer(apdu) {
    const b = Buffer.from(apdu, 'hex');
    if (b.length < 4) return '6700';
    const cla = b[0], ins = b[1], p1 = b[2], p2 = b[3];
    // the data field, where there is one: Lc, then that many bytes, then perhaps Le
    const data = b.length > 5 ? b.subarray(5, 5 + b[4]) : Buffer.alloc(0);

    if (cla === 0x00 && ins === 0xa4) {
      if (!data.length || AID.indexOf(hex(data)) !== 0) return '6a82';
      // a SELECT is a new session: what the tap had verified, the nonce and the owner's grant are gone. The note that the
      // card has paid grants this tap a load with no PIN (changeGrant), but is NOT cleared here: only a load that uses it
      // clears it (0x30), so a glance or a cut-short tap leaves it standing for the tap that writes the change
      s.verified = false; s.nonce = null; s.grant = false; s.selected = true;
      s.changeGrant = s.changeDue;
      // and a payment begun and not signed for is given up
      s.all = null;
      return '010' + VERSION + '9000';
    }
    if (!s.selected) return '6999';
    if (cla !== 0xb0) return '6e00';
    // a payment begun (SPEND_ALL_BEGIN) is given up by anything that is not its next step
    if (ins !== 0x23 && ins !== 0x24) s.all = null;
    const gated = () => s.pinState !== 0 && !s.verified;            // requirePinIfSet
    const mayWrite = () => s.pinState === 1 && s.verified;           // requirePinSetAndVerified
    const mayLoad = () => s.pinState === 1 && (s.verified || s.grant || s.changeGrant);   // requireLoadAuthority

    switch (ins) {
      case 0x01: {
        const n = (st) => s.slots.filter((x) => x.status === st).length;
        return [1, VERSION, SLOTS, n(1), n(2), n(0), PACED ? 15 : 7, s.pinState, FORMAT, s.tries, s.locked ? 1 : 0, s.record.set ? 1 : 0]
          .map((v) => ('0' + v.toString(16)).slice(-2)).join('') + u32(s.record.limit) + (s.owner ? '01' : '00')
          + u32(s.now) + u32(s.windowStart) + u32(s.spent) + (s.changeGrant ? '01' : '00')
          // P1 = 1 asks for the tap as well: twelve bytes more, and the thirty before them as they are without it
          + (p1 === 1 ? u32(s.tapLimit) + (PACED ? '0000000000000000' : u32(s.tapStart) + u32(s.tapSpent)) : '') + '9000';
      }
      case 0x10: return pub + '9000';
      case 0x11: return u32(s.slots.reduce((a, x) => (x.status === 1 ? (a + amountOf(x)) % 4294967296 : a), 0)) + '9000';
      case 0x12: return ('0' + s.slots.filter((x) => x.status !== 0).length.toString(16)).slice(-2) + '9000';
      case 0x13: {
        if (p1 >= SLOTS) return '6a83';
        const slot = s.slots[p1];
        if (slot.status === 0) return '6a88';
        return '0' + slot.status + slot.data + '9000';
      }
      case 0x14: return s.slots.map((x) => '0' + x.status).join('') + '9000';
      case 0x15: {
        if (data.length !== 16) return '6700';
        const mine = crypto.randomBytes(16);
        const tag = sha256(Buffer.from('FoxyCard/auth'));
        const digest = sha256(Buffer.concat([tag, tag, data, mine, Buffer.from(pub, 'hex')]));
        return hex(mine) + sign(digest) + '9000';
      }
      case 0x16: {
        const mint = Buffer.from(s.record.mint, 'latin1');
        return '0' + FORMAT + (s.record.set ? '01' : '00') + ('0' + s.record.unit.toString(16)).slice(-2) + u32(s.record.limit)
          + s.record.refund + s.record.timeKey + ('0' + mint.length.toString(16)).slice(-2) + hex(mint) + '9000';
      }
      case 0x18: {
        // GET_LOG: for the PIN verified in this tap or the owner's grant; the four counts, then the taps the ring holds, newest first
        if (s.pinState !== 0 && !s.verified && !s.grant) return '6982';
        const byte = (v) => ('0' + (v & 0xff).toString(16)).slice(-2);
        const held = s.log.taps < 8 ? s.log.taps : 8;
        const newest = (((s.log.taps & 0xff) - 1) & 7);
        let out = u32(s.log.taps) + u32(s.log.sats) + u32(s.log.refused) + u32(s.log.tampers);
        for (let k = 0; k < held; k++) {
          const e = s.log.ring[(newest - k) & 7];
          out += u32(e.time) + u32(e.sats) + byte(e.pieces) + byte(e.refused) + byte(e.flags) + '00';
        }
        return out + '9000';
      }
      case 0x17: {
        // every unspent piece and every place's state, a page at a time (the applet's GET_PIECES): the first place to
        // report is P1; the answer opens with the first place it does not cover, then an entry for each place that is
        // not empty: a tag of (state << 6 | place), and the piece (81 bytes) only for an unspent place. A page is at
        // most 255 bytes.
        if (p1 >= SLOTS) return '6a83';
        let next = p1, len = 1, body = '';
        for (; next < SLOTS; next += 1) {
          const x = s.slots[next];
          const cost = x.status === 1 ? 82 : x.status === 2 ? 1 : 0;
          if (len + cost > PAGE_MAX) break;
          len += cost;
          if (x.status !== 0) body += ('0' + ((x.status << 6) | next).toString(16)).slice(-2) + (x.status === 1 ? x.data : '');
        }
        return ('0' + next.toString(16)).slice(-2) + body + '9000';
      }
      case 0x22: {
        // SPEND_ALL_BEGIN: the places a payment is made of, in order. Each once, unspent, all of one date; the limits
        // are held to what they are worth together. Answers that worth.
        if (FORMAT !== 4) return '6d00';
        if (gated()) return '6982';
        if (data.length < 1) return '6700';
        if (data.length > 32) return '6a96';
        const list = Array.from(data);
        let sum = 0;
        for (let i = 0; i < list.length; i++) {
          if (list[i] >= SLOTS) return '6a83';
          const slot = s.slots[list[i]];
          if (slot.status === 0) return '6a88';
          if (slot.status === 2) return '6985';
          for (let j = 0; j < i; j++) if (list[j] === list[i]) return '6a80';
          if (dateOf(slot) !== dateOf(s.slots[list[0]])) return '6a80';
          sum += amountOf(slot);
        }
        const carry = sum > 4294967295;
        const total = carry ? 4294967295 : sum;
        const no = overLimits(total, carry);
        if (no) return no;
        // the pieces' half of the message is the card's own to build: each one's secret, and its C in hex
        const waits = waitsFor(total, carry);
        s.all = { list, total, waits, waited: waits > 0, text: list.map((i) => secretOf(s.slots[i]) + s.slots[i].data.substr(88, 66)).join('') };
        return u32(total) + '9000';
      }
      case 0x23: {
        // SPEND_ALL_OUTPUTS: the swap's outputs, 37 bytes each (amount 4, blinded message 33), hashed as the mint reads them
        if (FORMAT !== 4) return '6d00';
        if (!s.all) return '6985';
        if (data.length < 37 || data.length % 37 !== 0) { s.all = null; return '6700'; }
        for (let at = 0; at < data.length; at += 37) s.all.text += String(data.readUInt32BE(at)) + hex(data.subarray(at + 4, at + 37));
        return '9000';
      }
      case 0x24: {
        // SPEND_ALL_SIGN: one signature over the whole message; every piece named is burned as it is given
        if (FORMAT !== 4) return '6d00';
        if (!s.all) return '6985';
        if (gated()) return '6982';
        // the wait: one signature of work to a command, and how many are still to come in place of the signature
        if (s.all.waits > 0) {
          s.all.waits -= 1;
          s.waited = (s.waited || 0) + 1;
          return ('000' + s.all.waits.toString(16)).slice(-4) + '9000';
        }
        const pay = s.all;
        s.all = null;
        const no = overLimits(pay.total, false);
        if (no) return no;
        const dayBegins = s.record.limit !== 0 && s.now >= s.windowStart + DAY;
        const sig = sign(sha256(Buffer.from(pay.text, 'utf8')));
        if (s.record.limit !== 0) { s.spent = (dayBegins ? 0 : s.spent) + pay.total; if (dayBegins) s.windowStart = s.now; }
        pay.list.forEach((i) => { s.slots[i].status = 2; });
        s.changeDue = true;
        { const e = logEntry(); e.sats = stop(e.sats + pay.total); e.pieces = Math.min(255, e.pieces + pay.list.length); s.log.sats = stop(s.log.sats + pay.total);
          if (pay.waited) e.flags |= 2; }
        // kept, for a terminal whose answer is lost on the air (SPEND_ALL_AGAIN); and what it was over, for a test to read
        s.lastSig = sig;
        s.lastText = pay.text;
        return sig + '9000';
      }
      case 0x25: {
        // SPEND_ALL_AGAIN: the last signature given, again
        if (FORMAT !== 4) return '6d00';
        if (gated()) return '6982';
        if (!s.lastSig) return '6a88';
        return s.lastSig + '9000';
      }
      case 0x20: {
        // SPEND_PROOF: format 3's, one piece and a signature over its secret alone. Gone in format 4.
        if (FORMAT === 4) return '6d00';
        if (gated()) return '6982';
        if (p1 >= SLOTS) return '6a83';
        const slot = s.slots[p1];
        if (slot.status === 0) return '6a88';
        if (slot.status === 2) return '6985';
        // the day's limit, before anything is signed or burned; charged the whole piece. The owner's grant opens nothing here.
        let begins = false, total = 0;
        if (s.record.limit !== 0) {
          if (s.now === 0) return '6a92';
          begins = s.now >= s.windowStart + DAY;
          total = (begins ? 0 : s.spent) + amountOf(slot);
          if (total > s.record.limit || total > 4294967295) return refuse('6a8f');
        }
        // and the limit on one tap, the same way, against a window of TAP seconds that only the clock ends
        let tapBegins = false, tapTotal = 0;
        if (s.tapLimit !== 0) {
          if (s.now === 0) return '6a92';
          tapBegins = s.now >= s.tapStart + TAP;
          tapTotal = (tapBegins ? 0 : s.tapSpent) + amountOf(slot);
          if (tapTotal > s.tapLimit || tapTotal > 4294967295) return refuse('6a95');
        }
        const digest = sha256(Buffer.from(secretOf(slot), 'utf8'));
        slot.status = 2;
        if (s.record.limit !== 0) { if (begins) s.windowStart = s.now; s.spent = total; }
        if (s.tapLimit !== 0) { if (tapBegins) s.tapStart = s.now; s.tapSpent = tapTotal; }
        // the card's own account of it, with the burn
        { const e = logEntry(); e.sats = stop(e.sats + amountOf(slot)); if (e.pieces < 255) e.pieces += 1; s.log.sats = stop(s.log.sats + amountOf(slot)); }
        // and the next tap may put the change on with no PIN
        s.changeDue = true;
        return sign(digest) + '9000';
      }
      case 0x30: {
        if (s.locked) return '6986';
        if (!mayLoad()) return '6982';
        if (!s.owner) return '6a90';
        if (!s.record.set) return '6a8c';
        if (s.now === 0) return '6a92';
        const at = s.slots.findIndex((x) => x.status === 0);
        if (at < 0) return '6a84';
        if (data.length !== 81) return '6700';
        if (data.readUInt32BE(77) !== 0 && s.record.refund.slice(0, 2) === '00') return '6a8e';
        if ((data[44] !== 2 && data[44] !== 3) || data.readUInt32BE(8) === 0) return '6a80';
        // a piece is on the card once: the card signs a piece's secret, which its nonce makes, and takes its amount on the
        // terminal's word, so a nonce that is in any slot, spent or not, is refused (a freed slot holds nothing)
        const nonce = hex(data.subarray(12, 44));
        if (s.slots.some((x) => x.status !== 0 && x.data.substr(24, 64) === nonce)) return '6a94';
        s.slots[at] = { status: 1, data: hex(data) };
        // a load the change grant alone allowed spends the note now, not at SELECT: the change is going on
        if (!s.verified && !s.grant) s.changeDue = false;
        return ('0' + at.toString(16)).slice(-2) + '9000';
      }
      case 0x31: {
        if (s.locked) return '6986';
        if (s.pinState !== 0 && !s.verified && !s.grant && !s.changeGrant) return '6982';
        let freed = 0;
        s.slots.forEach((x) => { if (x.status === 2) { x.status = 0; x.data = ''; freed += 1; } });
        return ('0' + freed.toString(16)).slice(-2) + '9000';
      }
      case 0x32: {
        if (s.locked) return '6986';
        const owned = !!s.owner;
        if (!owned && !mayWrite()) return '6982';
        let rec = data;
        if (owned) {
          const got = ownerProof('FoxyCard/set-card', data);
          if (got.sw) return got.sw;
          rec = got.value;
        }
        if (unspent()) return '6a8d';
        if (rec.length < 101) return '6700';
        const mintLen = rec[99];
        if (mintLen < 1 || mintLen > MINT_MAX || rec.length !== 100 + mintLen) return '6700';
        const refund = rec.subarray(1, 34);
        if (refund[0] === 0) { if (refund.some((v) => v !== 0)) return '6a80'; }
        else if (refund[0] !== 2 && refund[0] !== 3) return '6a80';
        const timeKey = rec.subarray(34, 99);
        if (timeKey[0] !== 4) return '6a80';
        const newKey = hex(timeKey) !== s.record.timeKey;
        s.record = { set: true, unit: rec[0], limit: s.record.limit, refund: hex(refund), timeKey: hex(timeKey), mint: rec.subarray(100).toString('latin1') };
        // a different time key is the one thing that sends the card's clock, and the day it was counting, back to nothing
        if (newKey) { s.now = 0; s.windowStart = 0; s.spent = 0; s.tapStart = 0; s.tapSpent = 0; }
        return '9000';
      }
      case 0x33: {
        if (s.locked) return '6986';
        if (!mayWrite()) return '6982';
        if (s.owner) return '6a91';
        if (unspent()) return '6a8d';
        if (data.length !== 4 && data.length !== 8) return '6700';
        return writeLimit(data);
      }
      case 0x34: {
        if (s.locked) return '6986';
        if (!s.owner) return '6a90';
        const got = ownerProof('FoxyCard/set-limit', data);
        if (got.sw) return got.sw;
        if (got.value.length !== 4 && got.value.length !== 8) return '6700';
        return writeLimit(got.value);
      }
      case 0x35: {
        if (data.length < 6) return '6700';
        const len = data[4];
        if (len < 1 || len > 72 || data.length !== 5 + len) return '6700';
        if (!s.record.set) return '6a8c';
        const message = Buffer.concat([ascii('FoxyCard/time'), data.subarray(0, 4)]);
        if (!p256Verify(s.record.timeKey, message, hex(data.subarray(5)))) return '6a93';
        if (data.readUInt32BE(0) > s.now) s.now = data.readUInt32BE(0);
        return u32(s.now) + '9000';
      }
      case 0x40: {
        if (s.pinState === 0) return '6984';
        if (s.tries === 0) return '6983';
        if (data.length < 4 || data.length > 8) return '6700';
        if (hex(data) !== s.pin) return failPin();
        s.tries = 3; s.verified = true;
        return '9000';
      }
      case 0x41: {
        if (s.locked) return '6986';
        if (s.owner) return '6a91';
        if (unspent()) return '6a8d';
        if (data.length < 4 || data.length > 8) return '6700';
        s.pin = hex(data); s.pinState = 1; s.tries = 3; s.verified = false;
        return '9000';
      }
      case 0x42: {
        if (s.locked) return '6986';
        if (!s.owner) return '6a90';
        const got = ownerProof('FoxyCard/change-pin', data);
        if (got.sw) return got.sw;
        if (got.value.length < 4 || got.value.length > 8) return '6700';
        s.pin = hex(got.value); s.pinState = 1; s.tries = 3; s.verified = false;
        return '9000';
      }
      case 0x43: {
        if (s.locked) return '6986';
        let key = data;
        if (s.owner) {
          const got = ownerProof('FoxyCard/set-owner', data);
          if (got.sw) return got.sw;
          key = got.value;
        }
        if (unspent()) return '6a8d';
        if (key.length !== 65) return '6700';
        if (key[0] !== 4) return '6a80';
        s.owner = hex(key);
        return '9000';
      }
      case 0x44: {
        if (!s.owner) return '6a90';
        s.nonce = crypto.randomBytes(16).toString('hex');
        return s.nonce + '9000';
      }
      case 0x45: {
        if (s.locked) return '6986';
        if (!s.owner) return '6a90';
        const got = ownerProof('FoxyCard/load', data);
        if (got.sw) return got.sw;
        if (got.value.length !== 0) return '6700';
        s.grant = true;
        return '9000';
      }
      case 0x50: {
        if (!mayWrite()) return '6982';
        if (p2 !== 0xde) return '6b00';
        if (s.locked) return '6985';
        const got = ownerProof('FoxyCard/lock', data);
        if (got.sw) return got.sw;
        if (got.value.length !== 0) return '6700';
        s.locked = true;
        return '9000';
      }
      default: return '6d00';
    }
  }

  return {
    key: pub,
    state: s,
    sent,
    /* An APDU in, the answer out, both hex. Rejects once the card has left. */
    send(apdu) {
      if (gone) return Promise.reject(new Error('the card is not there'));
      if (leaveIn === 0) { gone = true; return Promise.reject(new Error('the card is not there')); }
      if (leaveIn > 0) leaveIn -= 1;
      const a = String(apdu).toLowerCase();
      if (leaveAt && a.slice(0, 2) === 'b0' && a.slice(2, 4) === leaveAt.ins) {
        leaveAt.nth -= 1;
        if (leaveAt.nth <= 0) { gone = true; leaveAt = null; return Promise.reject(new Error('the card is not there')); }
      }
      sent.push(a);
      if (loseAt && a.slice(0, 2) === 'b0' && a.slice(2, 4) === loseAt.ins) {
        loseAt.nth -= 1;
        if (loseAt.nth <= 0) { answer(a); gone = true; loseAt = null; return Promise.reject(new Error('the card is not there')); }
      }
      return Promise.resolve(answer(a));
    },
    /* The card is taken away and brought back: nothing of the last tap is left (but the note that it paid, which is permanent). */
    tap() { gone = false; leaveIn = -1; leaveAt = null; loseAt = null; s.verified = false; s.nonce = null; s.grant = false; s.changeGrant = false; s.selected = false; s.tapOpen = false; s.all = null; },
    /* It leaves just as the `nth` command of this instruction (two hex digits) is sent, which is not answered. */
    leaveBefore(ins, nth) { leaveAt = { ins: String(ins).toLowerCase(), nth: nth || 1 }; },
    /* It leaves as it answers the `nth` command of this instruction: the card has done what was asked, and nobody hears. */
    loseAnswerOf(ins, nth) { loseAt = { ins: String(ins).toLowerCase(), nth: nth || 1 }; },
    /* Another card with this one's key and everything on it as it is now: what a copied card would be. */
    copy() {
      const twin = makeCard({ window: o.window, key: priv, format: FORMAT });
      Object.assign(twin.state, JSON.parse(JSON.stringify(s)), { verified: false, nonce: null, grant: false, changeGrant: false, selected: false, tapOpen: false });
      return twin;
    },
    /* It leaves the field after `n` more commands have been answered. */
    leaveAfter(n) { leaveIn = n; },
    setNonce(nonceHex) { s.nonce = String(nonceHex).toLowerCase(); },
    secretOf: (i) => secretOf(s.slots[i]),
    format: FORMAT,
    balance: () => s.slots.reduce((a, x) => (x.status === 1 ? a + amountOf(x) : a), 0),
  };
}

module.exports = { makeCard, AID };
