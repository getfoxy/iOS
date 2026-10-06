'use strict';
/* flashcard-card.js — a model of the Foxy card, for tests.
 *
 * The card is a JavaCard applet (the card's own repository; its commands are
 * in docs/FOXY-CARD-SPEC.md there). A wallet cannot be tested against a card
 * in a test run, so this answers the same commands with the same bytes: APDUs
 * in, as hex, and the answer out with its status word. It is held to the
 * applet by tests/flashcard-model.js, which replays a conversation the applet
 * had under jCardSim and compares every answer.
 *
 *     const card = makeCard({ window, key });  // window: the page's (its CashuTS signs); key: 64 hex
 *     const answer = await card.send('b001000000');
 *     card.tap();                                // the card leaves and comes back
 *     card.leaveAfter(2);                        // it leaves the field two commands from now
 *
 * Not a card: no EEPROM, no torn writes inside a command, and it signs in
 * microseconds. What it has in common is every rule the applet enforces.
 */
const crypto = require('crypto');

const AID = 'f0464f58594341524401';
const SLOTS = 64;
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const u32 = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

function makeCard(opts) {
  const o = opts || {};
  const CT = o.window.CashuTS;
  // the library checks for its own realm's Uint8Array, which a Node Buffer is not
  const own = (buf) => o.window.Uint8Array.from(buf);
  const priv = String(o.key || crypto.randomBytes(32).toString('hex'));
  const pub = hex(CT.getPubKeyFromPrivKey(own(Buffer.from(priv, 'hex'))));
  const s = {
    pin: null, pinState: 0, tries: 3, locked: false,
    record: { set: false, unit: 0, limit: 0, refund: '00'.repeat(33), mint: '' },
    slots: Array.from({ length: SLOTS }, () => ({ status: 0, data: '' })),   // data: 81 bytes as hex
    // the tap's own
    verified: false, spentThisPin: 0, selected: false,
  };
  let leaveIn = -1, gone = false;
  let leaveAt = null;        // { ins, nth }: gone when the nth command of that instruction arrives
  const sent = [];

  const amountOf = (slot) => parseInt(slot.data.substr(16, 8), 16);
  const dateOf = (slot) => parseInt(slot.data.substr(154, 8), 16);
  const secretOf = (slot) => {
    let text = '["P2PK",{"nonce":"' + slot.data.substr(24, 64) + '","data":"' + pub + '","tags":[';
    if (dateOf(slot)) text += '["locktime","' + dateOf(slot) + '"],["refund","' + s.record.refund + '"]';
    return text + ']}]';
  };
  const sign = (digest) => {
    const sig = CT.schnorrSignDigest(own(digest), own(Buffer.from(priv, 'hex')));
    return typeof sig === 'string' ? sig : hex(sig);
  };
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
      // a SELECT is a new session: what the tap had verified is gone
      s.verified = false; s.spentThisPin = 0; s.selected = true;
      return '0100' + '9000';
    }
    if (!s.selected) return '6999';
    if (cla !== 0xb0) return '6e00';
    const gated = () => s.pinState !== 0 && !s.verified;            // requirePinIfSet
    const mayWrite = () => s.pinState === 1 && s.verified;           // requirePinSetAndVerified

    switch (ins) {
      case 0x01: {
        const n = (st) => s.slots.filter((x) => x.status === st).length;
        return [1, 0, SLOTS, n(1), n(2), n(0), 7, s.pinState, 2, s.tries, s.locked ? 1 : 0, s.record.set ? 1 : 0]
          .map((v) => ('0' + v.toString(16)).slice(-2)).join('') + u32(s.record.limit) + '9000';
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
        return '02' + (s.record.set ? '01' : '00') + ('0' + s.record.unit.toString(16)).slice(-2) + u32(s.record.limit)
          + s.record.refund + ('0' + mint.length.toString(16)).slice(-2) + hex(mint) + '9000';
      }
      case 0x20: {
        if (gated()) return '6982';
        if (p1 >= SLOTS) return '6a83';
        const slot = s.slots[p1];
        if (slot.status === 0) return '6a88';
        if (slot.status === 2) return '6985';
        const sum = s.spentThisPin + amountOf(slot);
        if (s.record.limit !== 0 && (sum > 4294967295 || sum > s.record.limit)) return '6a8f';
        const digest = sha256(Buffer.from(secretOf(slot), 'utf8'));
        slot.status = 2;
        s.spentThisPin = sum % 4294967296;
        return sign(digest) + '9000';
      }
      case 0x30: {
        if (s.locked) return '6986';
        if (!mayWrite()) return '6982';
        if (!s.record.set) return '6a8c';
        const at = s.slots.findIndex((x) => x.status === 0);
        if (at < 0) return '6a84';
        if (data.length !== 81) return '6700';
        if (data.readUInt32BE(77) !== 0 && s.record.refund.slice(0, 2) === '00') return '6a8e';
        if ((data[44] !== 2 && data[44] !== 3) || data.readUInt32BE(8) === 0) return '6a80';
        s.slots[at] = { status: 1, data: hex(data) };
        return ('0' + at.toString(16)).slice(-2) + '9000';
      }
      case 0x31: {
        if (s.locked) return '6986';
        if (gated()) return '6982';
        let freed = 0;
        s.slots.forEach((x) => { if (x.status === 2) { x.status = 0; x.data = ''; freed += 1; } });
        return ('0' + freed.toString(16)).slice(-2) + '9000';
      }
      case 0x32: {
        if (s.locked) return '6986';
        if (!mayWrite()) return '6982';
        if (s.slots.some((x) => x.status === 1)) return '6a8d';
        if (data.length < 35) return '6700';
        const mintLen = data[34];
        if (mintLen < 1 || mintLen > 96 || data.length !== 35 + mintLen) return '6700';
        const refund = data.subarray(1, 34);
        if (refund[0] === 0) { if (refund.some((v) => v !== 0)) return '6a80'; }
        else if (refund[0] !== 2 && refund[0] !== 3) return '6a80';
        s.record = { set: true, unit: data[0], limit: s.record.limit, refund: hex(refund), mint: data.subarray(35).toString('latin1') };
        return '9000';
      }
      case 0x33: {
        if (s.locked) return '6986';
        if (!mayWrite()) return '6982';
        if (data.length !== 4) return '6700';
        s.record.limit = data.readUInt32BE(0);
        return '9000';
      }
      case 0x40: {
        if (s.pinState === 0) return '6984';
        if (s.tries === 0) return '6983';
        if (data.length < 4 || data.length > 8) return '6700';
        if (hex(data) !== s.pin) return failPin();
        s.tries = 3; s.verified = true; s.spentThisPin = 0;
        return '9000';
      }
      case 0x41: {
        if (s.locked) return '6986';
        if (s.pinState !== 0) return '6985';
        if (data.length < 4 || data.length > 8) return '6700';
        s.pin = hex(data); s.pinState = 1;
        return '9000';
      }
      case 0x42: {
        if (s.locked) return '6986';
        if (!s.verified) return '6982';
        const oldLen = data[0];
        if (!(oldLen >= 4 && oldLen <= 8)) return '6700';
        const newLen = data.length - 1 - oldLen;
        if (newLen < 4 || newLen > 8) return '6700';
        if (hex(data.subarray(1, 1 + oldLen)) !== s.pin) return failPin();
        s.tries = 3;
        s.pin = hex(data.subarray(1 + oldLen));
        return '9000';
      }
      case 0x50: {
        if (gated()) return '6982';
        if (p2 !== 0xde) return '6b00';
        if (s.locked) return '6985';
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
      return Promise.resolve(answer(a));
    },
    /* The card is taken away and brought back: nothing of the last tap is left. */
    tap() { gone = false; leaveIn = -1; leaveAt = null; s.verified = false; s.spentThisPin = 0; s.selected = false; },
    /* It leaves just as the `nth` command of this instruction (two hex digits) is sent, which is not answered. */
    leaveBefore(ins, nth) { leaveAt = { ins: String(ins).toLowerCase(), nth: nth || 1 }; },
    /* Another card with this one's key and everything on it as it is now: what a copied card would be. */
    copy() {
      const twin = makeCard({ window: o.window, key: priv });
      Object.assign(twin.state, JSON.parse(JSON.stringify(s)), { verified: false, spentThisPin: 0, selected: false });
      return twin;
    },
    /* It leaves the field after `n` more commands have been answered. */
    leaveAfter(n) { leaveIn = n; },
    secretOf: (i) => secretOf(s.slots[i]),
    balance: () => s.slots.reduce((a, x) => (x.status === 1 ? a + amountOf(x) : a), 0),
  };
}

module.exports = { makeCard, AID };
