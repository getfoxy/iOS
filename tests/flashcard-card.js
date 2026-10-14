'use strict';
/* flashcard-card.js — a model of the card, for tests: the Cashu card protocol 2.0.
 *
 * The card is a JavaCard applet: https://github.com/lnflash/cashu-javacard, whose wire is
 * spec/APDU.md there (protocol 2.0: Foxy's card software 1.20 with a neutral identity and the
 * fixes of docs/DECISIONS.md D18 to D25). Flash's wallets and this one speak it to the same
 * card. A wallet cannot be tested against a card in a test run, so this answers the same
 * commands with the same bytes: APDUs in, as hex, and the answer out with its status word.
 * It is held to the applet by tests/flashcard-model.js, which replays a conversation the
 * applet had under jCardSim (that repository's spec/vectors/transcript.json) and compares
 * every answer.
 *
 *     const card = makeCard({ window, key });  // window: the page's (its CashuTS signs); key: 64 hex
 *     makeCard({ window, proofRoom: false })     // the card that was refused the room for the mint's proofs: it stores a piece and keeps no proof
 *     makeCard({ window, floorBits: 0x207fffff })   // the least work a block header must show: the real floor unless a test mines its own headers
 *     makeCard({ window, chip: true })           // a SELECT of the package's ten bytes reaches the opener, as on a chip (D25), and not the applet
 *     const answer = await card.send('b001000000');
 *     card.tap();                                // the card leaves and comes back
 *     card.leaveAfter(2);                        // it leaves the field two commands from now
 *     card.setNonce(hex)                         // the nonce it last gave is this one (replaying a recording of the applet)
 *     card.setChange(nonceHex, rHex)             // the next change it makes for itself has this nonce and this blinding factor (same)
     card.setNewKey(privHex)                    // the key the next RESET gives it (replaying a recording of the applet); also `card.key`, which is whatever it has now
 *
 * Not a card: no EEPROM, no torn writes inside a command, and it signs in
 * microseconds. What it has in common is every rule the applet enforces.
 */
const crypto = require('crypto');
const { p256Verify } = require('./harness');

// the card's applet: the package AID (F0, "CASHUCARD") and 01. The package AID alone is a partial name (D25).
const AID = 'f043415348554341524401';
const PACKAGE = AID.slice(0, 20);
const VERSION = '0200';
const PAGE_MAX = 255;
const DAY = 86400;
// how long a tap is, to the card, for the limit on one tap (the applet's TAP_SECONDS)
const TAP = 10;
const MINT_MAX = 77;
// the rollover budget (D20): the default where the owner set none, and the most an owner may set
const ROLL_BUDGET = 7, ROLL_BUDGET_MOST = 30;
// the order of secp256k1: a blinding factor is under it and not zero
const CURVE_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const ascii = (t) => Buffer.from(t, 'ascii');
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const u32 = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
// the confirming byte of RESET (the applet's RESET_CONFIRM_BYTE), as LOCK_CARD has 0xDE
const RESET_CONFIRM = 0xad;

function makeCard(opts) {
  const o = opts || {};
  const CT = o.window.CashuTS;
  // the library checks for its own realm's Uint8Array, which a Node Buffer is not
  const own = (buf) => o.window.Uint8Array.from(buf);
  /* Every piece is format 4: its secret carries the SIG_ALL flag, and a payment is SPEND_ALL_BEGIN, its outputs, the card's own
   * change (SPEND_ALL_CHANGE) and SPEND_ALL_SIGN, which signs once for all of it. A payment over the LIMIT ON ONE PAYMENT is not
   * refused, it waits: each wait a signature of the card's work asked for by a SPEND_ALL_SIGN that answers "not yet" (00 01) in
   * place of the signature (`waitsFor`). 128 places; GET_PIECES has its short listing (P2 = 3) and named places (P2 = 2); the PIN
   * may be sealed; the PIN is optional and a card with one may carry a NO-PIN ALLOWANCE; the owner can RESET the card and switch
   * its NFC tag; and the card keeps the mint's NUT-12 proof with each piece (LOAD_PROOF P1 = 1, GET_DLEQ). The store is reserved by
   * the first SET_CARD that goes through (`s.dleq` is null until then, and for good on a card made with `proofRoom: false`, which
   * the chip may refuse). 1.x's commands are gone: SPEND_PROOF (20) and SET_TIME (35) are 6D00. */
  const FORMAT = 4;
  const SLOTS = 128;
  if (o.software !== undefined || (o.format !== undefined && o.format !== 4) || (o.places !== undefined && o.places !== 128)) {
    throw new Error('the model is the Cashu card protocol 2.0 and nothing older: no `software`, `format` 3 or `places` 64');
  }
  /* The least work a block header must show (the applet's FLOOR_BITS, 0x17087BC0: four times the target of the newest header in the spec's vectors,
   * a quarter of its work: D24), as `bits`. A test that
   * has to make headers of its own takes a cheap one (`floorBits`: 0x207fffff, whose target is about 2^255, takes two tries
   * of a hash); the card of the tests is the real one unless it is asked. */
  const FLOOR_BITS = o.floorBits === undefined ? 0x17087BC0 : (Number(o.floorBits) >>> 0);
  const TOP = (1n << 256n) - 1n;
  /* The target a header's `bits` name (the applet's `targetOf`): the three-byte mantissa placed `exponent` bytes up from the
   * bottom. `bits` is the header's four bytes read as a little-endian number, so the exponent is the top byte. null for a
   * difficulty no header could carry: a size of 0 or past 32, or a mantissa with its top bit set (the applet answers 6a80). */
  const targetOf = (bits) => {
    const exp = bits >>> 24, man = bits & 0xffffff;
    if (exp < 1 || exp > 32 || (man & 0x800000)) return null;
    return exp >= 3 ? BigInt(man) << BigInt(8 * (exp - 3)) : BigInt(man >> (8 * (3 - exp)));
  };
  const sha256x2 = (buf) => sha256(sha256(buf));
  // the signatures for the first limit's worth over the limit, and for each further one, and the most limits' worth that count
  const WAIT_OVER = 10, WAIT_MORE = 4, UNITS_MOST = 255;
  // the change a payment makes for itself: eight openings are kept, and GET_CHANGE says three to a page
  const CHANGE_MOST = 8;
  const CHANGE_PAGE = 3;
  // the card's key: made again by a RESET, which is another keypair
  let priv = String(o.key || crypto.randomBytes(32).toString('hex'));
  let pub = hex(CT.getPubKeyFromPrivKey(own(Buffer.from(priv, 'hex'))));
  let nextKey = null;        // the private key (hex) the next RESET gives the card, where a test says (`setNewKey`)
  // the key a PIN is sealed to: the card's own, for that and nothing else
  const pinPriv = String(o.pinKey || crypto.randomBytes(32).toString('hex'));
  const pinPub = hex(CT.getPubKeyFromPrivKey(own(Buffer.from(pinPriv, 'hex'))));
  const s = {
    pin: null, pinState: 0, tries: 3, locked: false,
    // limit: the most the card signs for in a day, sats; 0 is none
    record: { set: false, unit: 0, limit: 0, refund: '00'.repeat(33), mint: '', design: '' },
    // the card's own clock and its day: the time in the newest block header it has taken, when this day began, what it has signed for since
    now: 0, windowStart: 0, spent: 0,
    /* The no-PIN allowance (sats a day signed for without the PIN; 0 is none) and what has been signed for without it in the current
     * day window, which is the one the daily limit's counts in (`windowStart`, `now`). */
    noPinLimit: 0, noPinSpent: 0,
    // the limit on one payment (0 is none)
    tapLimit: 0,
    /* The rollover (D20, GET_CARD bytes 76 to 78): how often the day's window has rolled since the owner's last REFRESH (or anchored
     * SET_OWNER), the budget of rolls (0 is the default, 7; 1 to 30), and whether the no-PIN allowance is armed to begin again at the
     * next roll (a VERIFY_PIN or a good owner's proof arms it; a roll that renews it spends the arming). */
    rolls: 0, budget: 0, armed: false,
    /* The card's own log (the applet's cardLog): counts that only go up, the run of over-limit refusals in hand, and a
     * ring of the last eight taps. A tap, here, is one time in the field: `tapOpen` is gone with the power (`tap()`). */
    log: { taps: 0, sats: 0, refused: 0, tampers: 0, runAt: 0, run: 0,
           ring: Array.from({ length: 8 }, () => ({ time: 0, sats: 0, pieces: 0, refused: 0, flags: 0, told: 0 })) },
    // the quicker card's receipts: a count of every payment it has signed, and the last sixteen (when, how much, the
    // hash of what was signed, the first output it went to)
    receipts: { count: 0, ring: Array.from({ length: 16 }, () => ({ time: 0, told: 0, sats: 0, hash: '00'.repeat(32), out: '00'.repeat(33) })) },
    /* The clock: the `bits` of the hardest header it has taken (a number, as the header's four
     * bytes read little-endian; 0 for none), the hash of the last header taken (64 hex, as Bitcoin shows a block hash), and
     * the time the terminal last told it (the applet's tapTime: RAM, gone with the power, not with a SELECT; 0 until told). */
    hardest: 0, headerHash: '00'.repeat(32), told: 0,
    tapOpen: false,
    /* That a payment has been signed in this time in the field (the applet's tapOpen[1]): gone with the power (`tap()`), and
     * not with a SELECT. The next payment signed in it waits as one over the limit does, unless the owner's grant
     * (`grant`, which a SELECT takes away) is in the tap. */
    tapPaid: false,
    slots: Array.from({ length: SLOTS }, () => ({ status: 0, data: '' })),   // data: 81 bytes as hex
    /* The openings of the change the card has made for itself, kept from the moment it is made until the piece is
     * written back: { state, amount, keyset (16 hex), date, nonce (64 hex), r (64 hex) }. A state is 'empty', 'draft' (made
     * for a payment not yet signed for: let go at the next SPEND_ALL_BEGIN) or 'pending' (signed for; the piece is to come
     * back). They last as long as the card does, and a tap or a SELECT leaves them. */
    openings: Array.from({ length: CHANGE_MOST }, () => ({ state: 'empty' })),
    // the owner's public key (hex, 04 || X || Y), given to a card with none or by the owner's proof, and never read out
    owner: null,
    /* Whether the owner has switched the NFC tag off (a new card, a card with no owner and a card just reset have it on). The mint's
     * proof for each place, 96 bytes as hex (e || s || r) or '' for none: null until the first SET_CARD reserves the room, and for good on a card
     * that is refused it. A place that is freed keeps the record it had until the next piece comes; only an unspent place is ever served. */
    tagOff: false, dleq: null,
    // that the card has paid since it was last tapped (permanent): the next tap may put pieces on with no PIN, for the change
    changeDue: false,
    // the tap's own: what was verified, the nonce the card last gave (hex, good for one try), whether the owner has allowed
    // loading, and whether this is the tap after a payment (the note above, taken at SELECT); `opener`: a chip's opener was chosen (D25)
    verified: false, nonce: null, grant: false, changeGrant: false, selected: false, opener: false,
  };
  let leaveIn = -1, gone = false;
  let leaveAt = null;        // { ins, nth }: gone when the nth command of that instruction arrives
  let loseAt = null;         // { ins, nth }: the nth command of that instruction is carried out, and its answer is lost
  let nextChange = null;     // { nonce, r } (hex): what the next change the card makes is made of, where a test says (`setChange`)
  const sent = [];

  const amountOf = (slot) => parseInt(slot.data.substr(16, 8), 16);
  const dateOf = (slot) => parseInt(slot.data.substr(154, 8), 16);
  // the NUT-10 secret of a piece with this nonce (hex) and this date, as the card writes every piece's (the applet's `secretTail`)
  const secretFor = (nonce, date) => {
    let text = '["P2PK",{"nonce":"' + nonce + '","data":"' + pub + '","tags":[';
    if (date) text += '["locktime","' + date + '"],["refund","' + s.record.refund + '"],';
    // the flag is every piece's last tag, as the wallet's library writes it
    return text + '["sigflag","SIG_ALL"]' + ']}]';
  };
  const secretOf = (slot) => secretFor(slot.data.substr(24, 64), dateOf(slot));
  /* The blinded message of a change output, as the mint will read it (NUT-00): the secret hashed to the curve, and r times
   * the generator added to that point. Compressed, as hex. */
  const blinded = (secret, rHex) => CT.blindMessage(own(Buffer.from(secret, 'utf8')), BigInt('0x' + rHex)).B_.toHex(true);
  // a blinding factor: 32 bytes, under the curve's order and not zero
  const freshR = () => {
    for (;;) {
      const r = BigInt('0x' + crypto.randomBytes(32).toString('hex')) % CURVE_N;
      if (r !== 0n) return r.toString(16).padStart(64, '0');
    }
  };
  // an opening whose nonce is this one is let go: its piece is on the card
  const letGo = (nonce) => s.openings.forEach((x, k) => { if (x.state !== 'empty' && x.nonce === nonce) s.openings[k] = { state: 'empty' }; });
  const sign = (digest) => {
    const sig = CT.schnorrSignDigest(own(digest), own(Buffer.from(priv, 'hex')));
    return typeof sig === 'string' ? sig : hex(sig);
  };
  const none = (n) => Buffer.alloc(n);
  /* A sealed command opened (the applet's `unseal`): the sender's public key for this message (65, uncompressed), the
   * bytes under a keystream, a tag (16). The secret is the x of the point the card's PIN key and that key share; a block
   * is SHA-256 of the label, a counter, the secret, the sender's key, the card's sixteen bytes and the instruction; block
   * 0, with the sealed bytes after it, is the tag, and blocks 1 on are the keystream. Answers { sw } where it is not to
   * be tried at all, { bad } where it does not open, and { clear } where it does. `spend`: the sixteen bytes are used
   * up by this (an owner's command leaves them for its proof to use). */
  const SEAL = ascii('CashuCard/seal');
  const unseal = (insByte, data, spend) => {
    if (data.length < 65 + 1 + 16) return { sw: '6700' };
    const nonce = s.nonce;
    if (spend) s.nonce = null;
    if (!nonce) return { sw: '6985' };
    const E = data.subarray(0, 65), ct = data.subarray(65, data.length - 16), tag = data.subarray(data.length - 16);
    let shared;
    try {
      if (E[0] !== 4) throw new Error('not a point');
      const dh = crypto.createECDH('secp256k1');
      dh.setPrivateKey(Buffer.from(pinPriv, 'hex'));
      shared = dh.computeSecret(E);
    } catch (e) { s.nonce = null; return { bad: true }; }
    const block = (i, more) => sha256(Buffer.concat([SEAL, Buffer.from([i]), shared, E, Buffer.from(nonce, 'hex'), Buffer.from([insByte]), more || none(0)]));
    if (!block(0, ct).subarray(0, 16).equals(tag)) { s.nonce = null; return { bad: true }; }
    const clear = Buffer.alloc(ct.length);
    for (let at = 0; at < ct.length; at += 32) {
      const ks = block(1 + at / 32);
      for (let k = 0; k < 32 && at + k < ct.length; k++) clear[at + k] = ct[at + k] ^ ks[k];
    }
    return { clear };
  };
  /* The PIN block that ends a sealed command's data: its length, the PIN, zeros to eight. Answers the data with the PIN
   * itself in the block's place, or null where the block is not one. */
  const unblock = (clear) => {
    if (clear.length < 9) return null;
    const b = clear.subarray(clear.length - 9);
    if (b[0] < 4 || b[0] > 8) return null;
    return Buffer.concat([clear.subarray(0, clear.length - 9), b.subarray(1, 1 + b[0])]);
  };
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
    if (!p256Verify(s.owner, message, hex(data.subarray(1, 1 + len)))) return { sw: '6a91' };
    // the owner has seen the card: the no-PIN allowance may begin again at the next roll (D20)
    s.armed = true;
    return { at: 1 + len, value };
  };
  const unspent = () => s.slots.some((x) => x.status === 1);
  /* The log's entry for this time in the field, begun (the count of taps up by one, its place in the ring cleared and
   * given the clock) if nothing in it has been written down yet. */
  const stop = (n) => Math.min(4294967295, n);
  const logEntry = () => {
    if (!s.tapOpen) s.log.taps = stop(s.log.taps + 1);
    const at = (((s.log.taps & 0xff) - 1) & 7);
    if (!s.tapOpen) { s.log.ring[at] = { time: s.now, sats: 0, pieces: 0, refused: 0, flags: 0, loads: 0, loaded: 0, told: s.told }; s.tapOpen = true; }
    return s.log.ring[at];
  };
  /* A spend over a limit, written down and then refused: the third in a run inside one tap's ten seconds of the clock
   * marks the tap and counts the run. A clock that is behind the run's start (a new time key) begins a new run. */
  const refuse = (sw) => {
    const e = logEntry();
    s.log.refused = stop(s.log.refused + 1);
    if (e.refused < 255) e.refused += 1;
    /* A new run: the first there has been, a clock behind the run's start, ten seconds on from it, and every refusal on a card that has
     * seen no block header yet (now = 0): with no clock, three visits a week apart would read as one run of three, and a false mark is worse than none. */
    if (s.log.run === 0 || s.now === 0 || s.now < s.log.runAt || s.now >= s.log.runAt + TAP) { s.log.runAt = s.now; s.log.run = 1; }
    else if (s.log.run < 255) s.log.run += 1;
    if (s.log.run === 3) s.log.tampers = stop(s.log.tampers + 1);
    if (s.log.run >= 3) e.flags |= 1;
    return sw;
  };
  /* The day (D20): whether it is over by the card's clock, whether the window has never begun (its start is 0: its first beginning
   * is no roll), and whether a payment now begins a new one: the day is over, and the window has rolled fewer times since the
   * owner's last REFRESH than its budget (the applet's `windowRolls`). Past the budget the window stays where it is, and what was
   * signed for in it still counts. */
  const dayOver = () => s.now >= s.windowStart + DAY;
  const notBegun = () => s.windowStart === 0;
  const windowRolls = () => dayOver() && (notBegun() || s.rolls < (s.budget || ROLL_BUDGET));
  /* The limits, held to what a payment takes off the card: '' when it is within them; over the day, written down and refused. */
  const overLimits = (total, carry) => {
    if (s.record.limit !== 0) {
      const t = (windowRolls() ? 0 : s.spent) + total;
      if (carry || t > s.record.limit || t > 4294967295) return refuse('6a8f');
    }
    return '';
  };
  /* What a payment costs in time: the signatures of work before it is signed. `sum` is what leaves the card (the pieces less the
   * change it made for itself), `carry` that the pieces' sum wrapped, `made` how many pieces of change it made, and `second` that a
   * payment was signed in this time in the field already and the owner's grant is not in the tap. A payment within the limit (or a
   * thirty-second over it: a limit set in dollars at one moment and a price in dollars at another lands a few sats over) goes at
   * once, change or no change; over it waits WAIT_OVER for the first limit's worth over and WAIT_MORE for each after it,
   * ceil(sum / limit) limits' worth of them at most 255, less two for every three pieces of change made (an output is about two
   * thirds of a signature's work), never below 0; a `second` payment is at least one limit's worth over, WAIT_OVER, with a limit or
   * none; and a sum that wrapped waits the most there is, with no change taken off it. */
  const waitsFor = (sum, carry, made, second) => {
    let waits;
    if (s.tapLimit === 0) {
      if (!second) return 0;
      waits = WAIT_OVER;
    } else {
      if (carry) return WAIT_OVER + WAIT_MORE * (UNITS_MOST - 2);
      let units = sum <= s.tapLimit + Math.floor(s.tapLimit / 32) ? 1 : Math.min(UNITS_MOST, Math.ceil(sum / s.tapLimit));
      if (second && units <= 1) units = 2;
      if (units <= 1) return 0;
      waits = WAIT_OVER + WAIT_MORE * (units - 2);
    }
    return Math.max(0, waits - Math.floor(2 * made / 3));
  };
  /* SET_LIMIT's value (the applet's `writeLimit`): four bytes are the day's limit and leave the others; eight are the day's
   * then the one payment's; twelve add the no-PIN allowance; thirteen (the owner's form only) add the rollover budget. A day's
   * number that changes begins its window at `now` with nothing spent (the allowance's count too); in the longer forms a number
   * that does not change keeps its window and count. An allowance whose number changes counts from nothing in the window as it
   * stands. Every form without the thirteenth byte sets the budget back to its default (0, read as 7). */
  const writeLimit = (value) => {
    const both = value.length >= 8;
    const day = value.readUInt32BE(0);
    const tap = both ? value.readUInt32BE(4) : 0;
    // the twelve bytes carry the no-PIN allowance after them; a card with no PIN has none to set (there is no PIN for it to be an allowance against)
    const allowed = value.length >= 12 ? value.readUInt32BE(8) : null;
    if (allowed !== null && allowed !== 0 && s.pinState === 0) return '6985';
    if (value.length === 13 && (value[12] < 1 || value[12] > ROLL_BUDGET_MOST)) return '6a80';
    // the window is the day's and the allowance's together: a day's limit that changes begins it again, and the allowance counts from nothing in it
    if (!both || day !== s.record.limit) { s.record.limit = day; s.windowStart = s.now; s.spent = 0; s.noPinSpent = 0; }
    if (both && tap !== s.tapLimit) s.tapLimit = tap;
    // an allowance that changes counts from nothing, in the window as it stands (the window is the day's, and stays)
    if (allowed !== null && allowed !== s.noPinLimit) { s.noPinLimit = allowed; s.noPinSpent = 0; }
    s.budget = value.length === 13 ? value[12] : 0;
    return '9000';
  };
  /* A block header checked as SET_HEADER checks it (the applet's `checkHeader`): '' when it may be taken, else the status word. */
  const headerProblem = (data) => {
    if (data.length !== 80) return '6700';
    const shown = Buffer.from(sha256x2(data)).reverse();            // as Bitcoin shows a block hash
    const own = targetOf(data.readUInt32LE(72));
    if (own === null) return '6a80';
    if (BigInt('0x' + hex(shown)) > own) return '6a93';
    if (own > targetOf(FLOOR_BITS)) return '6a93';
    if (s.hardest !== 0) {
      const quarter = targetOf(s.hardest) * 4n;
      if (own > (quarter > TOP ? TOP : quarter)) return '6a93';
    }
    return '';
  };
  /* A header that has been checked, taken (the applet's `writeHeader`): a later time moves the clock, anchors the window of a day's
   * limit or an allowance set before any header, and is remembered (the hardest's bits where it is the hardest yet, and its hash);
   * an older one changes nothing. */
  const takeHeader = (data) => {
    const time = data.readUInt32LE(68), bits = data.readUInt32LE(72);
    if (time <= s.now) return;
    const own = targetOf(bits);
    const harder = s.hardest === 0 || own < targetOf(s.hardest);
    s.now = time;
    if ((s.record.limit !== 0 || s.noPinLimit !== 0) && s.windowStart === 0) s.windowStart = time;
    if (harder) s.hardest = bits;
    s.headerHash = hex(Buffer.from(sha256x2(data)).reverse());
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
      /* The package's ten bytes are a partial name (D25). On a chip they reach the instance made first whose name begins with
       * them, which is the opener (…4D): it answers 9000 with no version, and 6D00 to every command after. jCardSim gives a
       * partial name to the lowest such name, the applet (…01), which is what the recordings had; the model does that unless
       * it is asked to be a chip (`chip`). */
      if (o.chip && hex(data) === PACKAGE) { s.selected = false; s.opener = true; s.verified = false; s.nonce = null; s.grant = false; s.all = null; return '9000'; }
      s.opener = false;
      // a SELECT is a new session: what the tap had verified, the nonce and the owner's grant are gone. The note that the
      // card has paid grants this tap a load with no PIN (changeGrant), but is NOT cleared here: only a load that uses it
      // clears it (0x30), so a glance or a cut-short tap leaves it standing for the tap that writes the change
      s.verified = false; s.nonce = null; s.grant = false; s.selected = true;
      s.changeGrant = s.changeDue;
      // and a payment begun and not signed for is given up
      s.all = null;
      return VERSION + '9000';
    }
    if (s.opener) return '6d00';
    if (!s.selected) return '6999';
    if (cla !== 0xb0) return '6e00';
    // a payment begun (SPEND_ALL_BEGIN) is given up by anything that is not its next step: the outputs, the card's own change, the signature
    if (ins !== 0x23 && ins !== 0x24 && ins !== 0x26) s.all = null;
    // requirePinIfSet: a blocked state refuses even a session that says verified (D22)
    const gated = () => s.pinState === 2 || (s.pinState !== 0 && !s.verified);
    // a card with no PIN is written (its record) by whoever holds it until it has an owner; and it is loaded by its owner's grant, or the tap after a payment
    const strictWrite = () => s.pinState === 1 && s.verified;      // requirePinSetAndVerified (the pre-owner limit, the lock)
    const mayWrite = () => strictWrite() || (s.pinState === 0 && !s.owner);   // the record of a card with no owner: requirePinIfSet
    const mayLoad = () => (s.pinState === 1 && (s.verified || s.grant || s.changeGrant)) || s.pinState === 0;   // requireLoadAuthority: a card with no PIN is loaded by whoever holds it

    switch (ins) {
      case 0x01: {
        const n = (st) => s.slots.filter((x) => x.status === st).length;
        return [2, 0, SLOTS, n(1), n(2), n(0), 255, s.pinState, FORMAT, s.tries, s.locked ? 1 : 0, s.record.set ? 1 : 0]
          .map((v) => ('0' + v.toString(16)).slice(-2)).join('') + u32(s.record.limit) + (s.owner ? '01' : '00')
          + u32(s.now) + u32(s.windowStart) + u32(s.spent) + (s.changeGrant ? '01' : '00')
          // P1 = 1 asks for twelve bytes more, and the thirty before them as they are without it: the limit on one payment, to its
          // owner only (the grant, in this tap; zeros to anyone else), then the allowance and what is spent of it, to anybody (a till
          // needs them to know whether to ask for the PIN). P1 = 2 is those forty-two bytes and then the NFC tag's state; any other P1
          // is the thirty bytes.
          + ((p1 === 1 || p1 === 2) ? u32(!s.grant ? 0 : s.tapLimit) + u32(s.noPinLimit) + u32(s.noPinSpent) : '')
          + (p1 === 2 ? (s.tagOff ? '01' : '00') : '') + '9000';
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
        const tag = sha256(Buffer.from('CashuCard/auth'));
        const digest = sha256(Buffer.concat([tag, tag, data, mine, Buffer.from(pub, 'hex')]));
        return hex(mine) + sign(digest) + '9000';
      }
      case 0x16: {
        const mint = Buffer.from(s.record.mint, 'latin1');
        const byte = (v) => ('0' + (v & 0xff).toString(16)).slice(-2);
        /* 65 bytes after the refund key: the hardest header's bits (4, as a header carries them: little-endian), the last header's
         * hash (32), the rollover's three bytes (bytes 76 to 78 of the answer: rolls, budget, armed; D20) and zeros (26) */
        const clockBytes = hex(Buffer.from(u32(s.hardest), 'hex').reverse()) + s.headerHash + byte(s.rolls) + byte(s.budget) + (s.armed ? '01' : '00') + '00'.repeat(26);
        return '0' + FORMAT + (s.record.set ? '01' : '00') + ('0' + s.record.unit.toString(16)).slice(-2) + u32(s.record.limit)
          + s.record.refund + clockBytes + ('0' + mint.length.toString(16)).slice(-2) + hex(mint)
          + (s.record.design ? hex(Buffer.from(s.record.design, 'latin1')) : '000000') + '9000';
      }
      case 0x18: {
        // GET_LOG: for the PIN verified in this tap or the owner's grant; the four counts, then the taps the ring holds, newest first
        const byte = (v) => ('0' + (v & 0xff).toString(16)).slice(-2);
        if (p1 === 1) {
          // the receipts: the count of every payment signed, then up to three, newest first, from P2 back. The owner's grant and nothing less
          if (s.pinState !== 0 && !s.grant) return '6982';
          const n = s.receipts.count, kept = n < 16 ? n : 16, last = (((n & 0xff) - 1) & 15);
          let said = u32(n);
          for (let k = p2; k < kept && k < p2 + 3; k++) {
            const r = s.receipts.ring[(last - k) & 15];
            said += u32(r.time) + u32(r.told || 0) + u32(r.sats) + r.hash + r.out;
          }
          return said + '9000';
        }
        if (p1 !== 0) return '6a86';
        if (s.pinState !== 0 && !s.verified && !s.grant) return '6982';
        const held = s.log.taps < 8 ? s.log.taps : 8;
        const newest = (((s.log.taps & 0xff) - 1) & 7);
        let out = u32(s.log.taps) + u32(s.log.sats) + u32(s.log.refused) + u32(s.log.tampers);
        for (let k = 0; k < held; k++) {
          const e = s.log.ring[(newest - k) & 7];
          // twenty bytes: what was put on in the tap after what was signed for, then the time the terminal told
          out += u32(e.time) + u32(e.sats) + byte(e.pieces) + byte(e.refused) + byte(e.flags)
            + byte(Math.min(255, e.loads || 0)) + u32(e.loaded || 0) + u32(e.told || 0);
        }
        return out + '9000';
      }
      case 0x17: {
        // every unspent piece and every place's state, a page at a time (the applet's GET_PIECES): the first place to
        // report is P1; the answer opens with the first place it does not cover, then an entry for each place that is
        // not empty: a tag of (state << 6 | place), and the piece (81 bytes) only for an unspent place. A page is at
        // most 255 bytes.
        const how = p2;
        // the card of 128 places has no brief listing (its tags could not name the places) and has the short one instead
        if (how === 1 || how > 3) return '6a86';
        // P2 = 2: the places named, whole (status and the 81 bytes), in the order asked
        if (how === 2) {
          if (data.length < 1 || data.length > 3) return '6700';
          if (Array.from(data).some((i) => i >= SLOTS)) return '6a83';
          return Array.from(data).map((i) => '0' + s.slots[i].status + (s.slots[i].data || '00'.repeat(81))).join('') + '9000';
        }
        if (p1 >= SLOTS) return '6a83';
        const two = (v) => ('0' + (v & 0xff).toString(16)).slice(-2);
        /* P2 = 3: the short listing. An entry for each UNSPENT place: the place, with 0x80 where its keyset and date
         * follow (the first entry of an answer, and wherever they are not the entry before's); then the power of two it is
         * worth, or ff and the amount. Spent places are not in it. */
        if (how === 3) {
          let at = p1, size = 1, said = '', prev = null;
          for (; at < SLOTS; at += 1) {
            const x = s.slots[at];
            if (x.status !== 1) continue;
            const named = !prev || prev.data.substr(0, 16) !== x.data.substr(0, 16) || prev.data.substr(154, 8) !== x.data.substr(154, 8);
            const amount = amountOf(x);
            const power = (amount > 0 && Number.isInteger(Math.log2(amount))) ? Math.log2(amount) : -1;
            const cost = 2 + (named ? 12 : 0) + (power < 0 ? 4 : 0);
            if (size + cost > PAGE_MAX) break;
            size += cost;
            said += two(at | (named ? 0x80 : 0)) + (named ? x.data.substr(0, 16) + x.data.substr(154, 8) : '')
              + (power < 0 ? 'ff' + x.data.substr(16, 8) : two(power));
            prev = x;
          }
          return two(at) + said + '9000';
        }
        // P2 = 0: pages of the places, each piece whole
        let next = p1, len = 1, body = '';
        for (; next < SLOTS; next += 1) {
          const x = s.slots[next];
          const cost = x.status === 1 ? 82 : x.status === 2 ? 1 : 0;
          if (len + cost > PAGE_MAX) break;
          len += cost;
          if (x.status !== 0) {
            // the tag: the place, and 0x80 where it is spent
            body += two(next | (x.status === 2 ? 0x80 : 0)) + (x.status !== 1 ? '' : x.data);
          }
        }
        return two(next) + body + '9000';
      }
      case 0x19: {
        /* GET_CHANGE: the change the card has made for itself and not yet been handed, three openings to a page (P1 =
         * the page, from 0): a count, then for each the amount (4), the keyset (8), the date (4), the nonce (32) and the
         * blinding factor (32). Only pending openings are listed, never drafts. An opening whose piece is on the card by
         * now, in any place and spent or not, is let go as it is come to and is not listed; it comes to no more of them
         * than the page it fills. No PIN, and like any command but the payment's own steps, it gives a payment up. */
        const held = (nonce) => s.slots.some((x) => x.status !== 0 && x.data.substr(24, 64) === nonce);
        let skip = p1 * CHANGE_PAGE, n = 0, said = '';
        for (let k = 0; k < CHANGE_MOST && n < CHANGE_PAGE; k++) {
          const x = s.openings[k];
          if (x.state !== 'pending') continue;
          if (held(x.nonce)) { s.openings[k] = { state: 'empty' }; continue; }
          if (skip > 0) { skip -= 1; continue; }
          said += u32(x.amount) + x.keyset + u32(x.date) + x.nonce + x.r;
          n += 1;
        }
        return ('0' + n.toString(16)).slice(-2) + said + '9000';
      }
      case 0x1a: {
        /* GET_DLEQ: the mint's proof kept with an unspent place, for one place (P2 = FF) or two. No data, no PIN, any state of the card. For each
         * place asked, in the order asked: 01 and the 96 bytes (e, s, r) where the place is unspent and its record is not zero, and otherwise the single
         * byte 00 (empty or spent, a piece that came with no proof, or a card with no room for proofs). The same place twice is answered twice. 6A83 for a
         * P1 over 127, or a P2 over 127 and not FF, before anything is answered. It never gives the proof of a spent piece, and the card checks nothing. */
        if (p1 >= SLOTS || (p2 !== 0xff && p2 >= SLOTS)) return '6a83';
        let said = '';
        for (const place of (p2 === 0xff ? [p1] : [p1, p2])) {
          const rec = (s.dleq && s.slots[place].status === 1) ? s.dleq[place] : '';
          said += rec ? '01' + rec : '00';
        }
        return said + '9000';
      }
      case 0x22: {
        // SPEND_ALL_BEGIN: the places a payment is made of, in order. Each once, unspent, all of one date. Answers what
        // they are worth together. The limits are held to what leaves the card, at the signing. No PIN is asked here: the
        // signature is where the PIN or the allowance is looked at.
        if (data.length < 1) return '6700';
        // the card signs for as many places as it has
        if (data.length > SLOTS) return '6a96';
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
        // a sum that wraps is past any allowance: with a PIN set and not shown it is the PIN's to ask for, and the log writes no refusal for a reader without it
        if (carry && gated()) return '6a94';
        /* The day's limit and the wait are held to what leaves the card for good, the pieces less the change it makes for
         * itself, which is not known until the signing, where both are worked out (`waits` null until then). A sum that wraps
         * is past any day there is, whatever its change, and is refused here if a day's limit is set. */
        const no = carry ? overLimits(total, carry) : '';
        if (no) return no;
        // change made for a payment that was never signed for is let go
        s.openings.forEach((x, k) => { if (x.state === 'draft') s.openings[k] = { state: 'empty' }; });
        // the pieces' half of the message is the card's own to build: each one's secret, and its C in hex
        s.all = { list, total, carry, waits: null, waited: false, change: 0, changes: 0, text: list.map((i) => secretOf(s.slots[i]) + s.slots[i].data.substr(88, 66)).join('') };
        return u32(total) + '9000';
      }
      case 0x23: {
        // SPEND_ALL_OUTPUTS: the swap's outputs, 37 bytes each (amount 4, blinded message 33), hashed as the mint reads them
        if (!s.all) return '6985';
        // the terminal's outputs come before the card's own change, as the swap will name them: none after it
        if (s.all.changes > 0) { s.all = null; return '6985'; }
        if (data.length < 37 || data.length % 37 !== 0) { s.all = null; return '6700'; }
        if (!s.all.out) s.all.out = hex(data.subarray(4, 37));
        for (let at = 0; at < data.length; at += 37) s.all.text += String(data.readUInt32BE(at)) + hex(data.subarray(at + 4, at + 37));
        return '9000';
      }
      case 0x26: {
        /* SPEND_ALL_CHANGE: one change output the card makes for itself, after the terminal's outputs and before the
         * signature. The amount (4) is all a terminal names: the card draws the nonce and the blinding factor, writes the
         * secret as it writes its pieces' (its key, the payment's date and refund key, SIG_ALL), hashes it to the curve and
         * blinds it, so that nothing a terminal chooses can take the change. The amount and the blinded message go into the
         * message as an output of the terminal's would, and the opening is kept until the piece is written back. Answers the
         * blinded message. Every refusal after a payment is begun gives the payment up. */
        if (!s.all) return '6985';
        if (data.length !== 4) { s.all = null; return '6700'; }
        const amount = data.readUInt32BE(0);
        // the change, with this, may not come to more than the pieces: what leaves the card cannot be less than nothing
        const made = s.all.change + amount;
        if (amount === 0 || made > 4294967295 || made > s.all.total) { s.all = null; return '6a80'; }
        const which = s.openings.findIndex((x) => x.state === 'empty');
        if (which < 0) { s.all = null; return '6a84'; }
        // the opening's keyset and date are the payment's, as every piece of it has them
        const first = s.slots[s.all.list[0]];
        const own = nextChange || { nonce: crypto.randomBytes(32).toString('hex'), r: freshR() };
        nextChange = null;
        const point = blinded(secretFor(own.nonce, dateOf(first)), own.r);
        s.openings[which] = { state: 'draft', amount, keyset: first.data.substr(0, 16), date: dateOf(first), nonce: own.nonce, r: own.r };
        s.all.change = made;
        s.all.changes += 1;
        s.all.text += String(amount) + point;
        return point + '9000';
      }
      case 0x24: {
        // SPEND_ALL_SIGN: one signature over the whole message; every piece named is burned as it is given
        if (!s.all) return '6985';
        const pay = s.all;
        // what leaves the card for good: the pieces less the change it made for itself
        const net = pay.total - pay.change;
        /* What the allowance would have counted in the day if this payment is signed with no PIN (the applet's `requireAllowanceOrPin`):
         * it begins again with the day only where the day rolls and the allowance is armed, or the window has never begun (D20). */
        const noPinBefore = () => (windowRolls() && (s.armed || notBegun())) ? 0 : s.noPinSpent;
        /* Signed with no PIN where the card has none, or the PIN was shown (and is not blocked), or what leaves the card is within the
         * no-PIN allowance for the day's window as it stands. The allowance is for the whole payment, never a part of it. A blocked
         * PIN has no allowance. Otherwise 6a94, which signs nothing, gives the payment up as a limit does, and is nothing in the log
         * (not a refusal over a limit, not a tamper). Asked before the limits, so that a reader with no PIN writes nothing in the log. */
        const allowance = () => {
          if (!gated()) return false;
          if (s.pinState !== 1 || s.tries === 0 || s.noPinLimit === 0 || noPinBefore() + net > s.noPinLimit) { s.all = null; return '6a94'; }
          return true;
        };
        if (pay.waits === null) {
          // the day's limit and the wait are held to what leaves the card, and worked out at the first command, when the change is known
          const pinned = allowance();
          if (pinned === '6a94') return '6a94';
          const refused = overLimits(net, false);
          if (refused) { s.all = null; return refused; }
          pay.waits = waitsFor(net, pay.carry, pay.changes, s.tapPaid && !s.grant);
          pay.waited = pay.waits > 0;
        }
        // the wait: one signature of work to a command, and how many are still to come in place of the signature
        if (pay.waits > 0) {
          pay.waits -= 1;
          s.waited = (s.waited || 0) + 1;
          // "not yet", and not how many are to come: the count would say what the limit is
          return '0001' + '9000';
        }
        s.all = null;
        const noPin = allowance();
        if (noPin === '6a94') return '6a94';
        const no = overLimits(net, false);
        if (no) return no;
        /* The day's window serves the daily limit and the allowance, and begins at the first payment when either is set. A day that
         * is over begins again only while the budget lasts (`windowRolls`); the first window a card begins is no roll; a roll spends
         * one of the budget, and the arming with it where the allowance began again (D20). */
        const windowed = s.record.limit !== 0 || s.noPinLimit !== 0;
        const newDay = windowed && windowRolls();
        const first = notBegun();
        const renew = newDay && (first || s.armed);
        const daySpent = (windowRolls() ? 0 : s.spent) + net;
        const noPinSpent = noPin ? noPinBefore() + net : (renew ? 0 : s.noPinSpent);
        const sig = sign(sha256(Buffer.from(pay.text, 'utf8')));
        if (windowed) {
          if (newDay) {
            s.windowStart = s.now;
            if (!first) { s.rolls += 1; if (renew) s.armed = false; }
          }
          if (s.record.limit !== 0) s.spent = daySpent;
          s.noPinSpent = stop(noPinSpent);
        }
        pay.list.forEach((i) => { s.slots[i].status = 2; });
        // a payment in this time in the field: the next one in it is slowed, unless the owner's grant is in its tap
        s.tapPaid = true;
        // the change the card made for itself is signed for now: its openings stay until the pieces are back
        s.openings.forEach((x) => { if (x.state === 'draft') x.state = 'pending'; });
        s.changeDue = true;
        { const e = logEntry(); e.sats = stop(e.sats + net); e.pieces = Math.min(255, e.pieces + pay.list.length); s.log.sats = stop(s.log.sats + net);
          if (pay.waited) e.flags |= 2;
          // a payment signed for under the allowance (a PIN set and not shown) is marked; one made on a card with no PIN has no PIN to be without
          if (noPin) e.flags |= 8; }
        // its receipt: when, how much leaves the card, the hash of what was signed, and where the first of it went
        s.receipts.ring[s.receipts.count & 15] = { time: s.now, told: s.told, sats: net, hash: hex(sha256(Buffer.from(pay.text, 'utf8'))), out: pay.out || '00'.repeat(33) };
        s.receipts.count = stop(s.receipts.count + 1);
        // kept, for a terminal whose answer is lost on the air (SPEND_ALL_AGAIN); and what it was over, for a test to read
        s.lastSig = sig;
        s.lastNoPin = !!noPin;
        s.lastText = pay.text;
        return sig + '9000';
      }
      case 0x25: {
        // SPEND_ALL_AGAIN: the last signature given, again; one given under the allowance, with no PIN, is given again with none
        if (gated() && !s.lastNoPin) return '6982';
        if (!s.lastSig) return '6a88';
        return s.lastSig + '9000';
      }
      case 0x30: {
        if (s.locked) return '6986';
        if (!mayLoad()) return '6982';
        if (!s.owner) return '6a90';
        if (!s.record.set) return '6a8c';
        if (s.slots.findIndex((x) => x.status === 0) < 0) return '6a84';
        /* One piece, or up to three end to end: each as one alone would be, in order. With P1 = 1, one piece and the mint's proof
         * for it, 177 bytes exactly and nothing else different; any other P1 is the plain load, and leaves its pieces with no proof. */
        const withProof = p1 === 1;
        if (withProof ? data.length !== 177 : (data.length < 81 || data.length % 81 !== 0 || data.length > 243)) return '6700';
        const one = (piece, proof) => {
          const at = s.slots.findIndex((x) => x.status === 0);
          if (at < 0) return '6a84';
          if (piece.readUInt32BE(77) !== 0 && s.record.refund.slice(0, 2) === '00') return '6a8e';
          // not a point, or worth nothing, or a proof of nothing (96 zeros are what "no proof" is kept as): not a piece
          if ((piece[44] !== 2 && piece[44] !== 3) || piece.readUInt32BE(8) === 0 || (proof && proof.every((v) => v === 0))) return '6a80';
          // a piece is on the card once: the card signs a piece's secret, which its nonce makes, and takes its amount on the
          // terminal's word, so a nonce that is in any slot, spent or not, is refused (a freed slot holds nothing)
          const nonce = hex(piece.subarray(12, 44));
          if (s.slots.some((x) => x.status !== 0 && x.data.substr(24, 64) === nonce)) return '6a94';
          // the place's record is its piece's proof or zeros, and is written before the place's data (a card with no room for proofs writes nothing)
          if (s.dleq) s.dleq[at] = proof ? hex(proof) : '';
          s.slots[at] = { status: 1, data: hex(piece) };
          // change the card made for itself, back on the card: its opening is let go
          letGo(nonce);
          // a load the change grant alone allowed spends the note now, not at SELECT: the change is going on
          if (!s.verified && !s.grant) s.changeDue = false;
          return at;
        };
        // the first that cannot be stored stops it: first, with its own word; after others, they stand and are the answer
        let stored = '', put = 0, n = 0;
        for (let k = 0; k * 81 < data.length && !(withProof && k > 0); k++) {
          const got = one(data.subarray(k * 81, k * 81 + 81), withProof ? data.subarray(81) : null);
          if (typeof got === 'string') { if (k === 0) return got; break; }
          stored += ('0' + got.toString(16)).slice(-2);
          put += data.readUInt32BE(k * 81 + 8);
          n += 1;
        }
        // the card's own account of it: what was put on in this tap
        if (n > 0) { const e = logEntry(); e.loaded = stop((e.loaded || 0) + put); e.loads = Math.min(255, (e.loads || 0) + n); }
        // with a proof: the place, and whether the proof was kept
        return stored + (withProof ? (s.dleq ? '01' : '00') : '') + '9000';
      }
      case 0x31: {
        if (s.locked) return '6986';
        if (s.pinState !== 0 && !s.verified && !s.grant && !s.changeGrant) return '6982';
        // a card with no PIN is freed by whoever holds it, as it is loaded
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
          const got = ownerProof('CashuCard/set-card', data);
          if (got.sw) return got.sw;
          rec = got.value;
        }
        if (unspent()) return '6a8d';
        if (rec.length < 101) return '6700';
        const mintLen = rec[99];
        const withDesign = rec.length === 103 + mintLen;
        if (mintLen < 1 || mintLen > MINT_MAX || (rec.length !== 100 + mintLen && !withDesign)) return '6700';
        let design = '';
        if (withDesign) {
          const d = rec.subarray(100 + mintLen, 103 + mintLen);
          if (d.some((v) => v !== 0)) {
            if (!d.every((v) => (v >= 0x41 && v <= 0x5a) || (v >= 0x30 && v <= 0x39))) return '6a80';
            design = Buffer.from(d).toString('latin1');
          }
        }
        const refund = rec.subarray(1, 34);
        if (refund[0] === 0) { if (refund.some((v) => v !== 0)) return '6a80'; }
        else if (refund[0] !== 2 && refund[0] !== 3) return '6a80';
        // bytes 34 to 98 are not read (1.x cards kept a time signer's key there; the page writes zeros)
        // the room for the mint's proofs is reserved here, by the first SET_CARD that gets this far, once (a card that is refused it works as a card with none)
        if (s.dleq === null && o.proofRoom !== false) s.dleq = Array.from({ length: SLOTS }, () => '');
        s.record = { set: true, unit: rec[0], limit: s.record.limit, refund: hex(refund), mint: rec.subarray(100, 100 + mintLen).toString('latin1'), design: design };
        /* A new record lets the ratchet go: the hardest difficulty the card has taken is set to nothing and the next header sets it afresh, the one
         * way out for a card whose network has fallen under a quarter of its best. The clock itself, its window and the last header's hash stay. */
        s.hardest = 0;
        return '9000';
      }
      case 0x33: {
        if (s.locked) return '6986';
        if (!strictWrite()) return '6982';
        if (s.owner) return '6a91';
        if (unspent()) return '6a8d';
        if (data.length !== 4 && data.length !== 8) return '6700';
        return writeLimit(data);
      }
      case 0x34: {
        if (s.locked) return '6986';
        if (!s.owner) return '6a90';
        const got = ownerProof('CashuCard/set-limit', data);
        if (got.sw) return got.sw;
        if (got.value.length !== 4 && got.value.length !== 8 && got.value.length !== 12 && got.value.length !== 13) return '6700';
        return writeLimit(got.value);
      }
      case 0x36: {
        /* SET_HEADER: a Bitcoin block header, the 80 bytes as the network carries them. The card's clock is the time in the
         * newest one it has taken. It hashes the 80 bytes twice and the hash, read as a number, must be at or under the target the
         * header's own `bits` name (6a93); the target must be at or under the floor (6a93) and at or under four times the target of
         * the hardest header taken, a quarter of its work (6a93); bits no header could carry are 6a80, any other length 6700. No PIN,
         * no owner, no record, whatever state the card is in. A header later than the clock moves it, anchors the window of a day's
         * limit set before any header, and is remembered (the hardest's bits where it is the hardest yet, and its hash); an older one
         * changes nothing and is 9000. Answers the clock. */
        const bad = headerProblem(data);
        if (bad) return bad;
        takeHeader(data);
        return u32(s.now) + '9000';
      }
      case 0x37: {
        /* TELL_TIME: the terminal's own clock, four bytes big-endian, a note for this time in the field that is written into
         * the receipts and the log entries made in it. Trusted for nothing: no PIN, no key, no state refuses it. Answers nothing. */
        if (data.length !== 4) return '6700';
        s.told = data.readUInt32BE(0);
        return '9000';
      }
      case 0x40: {
        if (p1 > 1) return '6a86';
        if (s.pinState === 0) return '6984';
        // blocked by its state byte or by its counter, before anything is checked (D22)
        if (s.pinState === 2 || s.tries === 0) return '6983';
        if (p1 === 1) {
          // sealed: an envelope that does not open costs a try, as a wrong PIN does
          const got = unseal(0x40, data, true);
          if (got.sw) return got.sw;
          if (got.bad) return failPin();
          const pinOnly = got.clear.length === 9 ? unblock(got.clear) : null;
          if (!pinOnly) return '6700';
          if (hex(pinOnly) !== s.pin) return failPin();
          // a good PIN arms the no-PIN allowance to begin again at the next roll (D20)
          s.tries = 3; s.verified = true; s.armed = true;
          return '9000';
        }
        if (data.length < 4 || data.length > 8) return '6700';
        if (hex(data) !== s.pin) return failPin();
        s.tries = 3; s.verified = true; s.armed = true;
        return '9000';
      }
      case 0x41: {
        if (p1 > 1) return '6a86';
        if (s.locked) return '6986';
        /* ADD PIN. A card with an owner takes a PIN only when it has none and the owner's grant (ALLOW_LOAD) is in this tap, and
         * then holding money is no bar: the PIN is the point of it. A card with no owner is as it always was (set-up). */
        const adding = s.owner && s.pinState === 0 && s.grant;
        if (s.owner && !adding) return '6a91';
        if (!adding && unspent()) return '6a8d';
        let first = data;
        if (p1 === 1) {
          const got = unseal(0x41, data, true);
          if (got.sw) return got.sw;
          if (got.bad) return '6a80';
          first = got.clear.length === 9 ? unblock(got.clear) : null;
          if (!first) return '6700';
        }
        if (first.length < 4 || first.length > 8) return '6700';
        s.pin = hex(first); s.pinState = 1; s.tries = 3; s.verified = false;
        return '9000';
      }
      case 0x42: {
        if (p1 > 1) return '6a86';
        if (s.locked) return '6986';
        if (!s.owner) return '6a90';
        let proved = data;
        if (p1 === 1) {
          // sealed under the same sixteen bytes the proof is over: opening it leaves them for the proof to use up
          const open = unseal(0x42, data, false);
          if (open.sw) return open.sw;
          if (open.bad) return '6a80';
          proved = unblock(open.clear);
          if (!proved) return '6700';
        }
        const got = ownerProof('CashuCard/change-pin', proved);
        if (got.sw) return got.sw;
        if (got.value.length < 4 || got.value.length > 8) return '6700';
        s.pin = hex(got.value); s.pinState = 1; s.tries = 3; s.verified = false;
        return '9000';
      }
      case 0x43: {
        if (s.locked) return '6986';
        let key = data;
        if (s.owner) {
          const got = ownerProof('CashuCard/set-owner', data);
          if (got.sw) return got.sw;
          key = got.value;
        }
        if (unspent()) return '6a8d';
        /* The key, and after it, where the phone has one, a block header that anchors the card's clock (D20): 65 or 145 bytes. The
         * header is held to SET_HEADER's checks before anything is written (6A93 refuses the owner too) and taken with the key, with
         * the rollover count at 0: a card set up so never runs at now = 0. */
        if (key.length !== 65 && key.length !== 145) return '6700';
        if (key[0] !== 4) return '6a80';
        const anchor = key.length === 145 ? key.subarray(65) : null;
        if (anchor) { const bad = headerProblem(anchor); if (bad) return bad; }
        s.owner = hex(key.subarray(0, 65));
        if (anchor) { takeHeader(anchor); s.rolls = 0; }
        return '9000';
      }
      case 0x44: {
        /* P1 = 1, on a card that takes its PIN sealed: the sixteen bytes, the key a PIN is sealed to (33), and the
         * card's own key's signature over that key (64). Asked by anybody: a card with no owner has a PIN to be set. */
        if (p1 === 1) {
          s.nonce = crypto.randomBytes(16).toString('hex');
          return s.nonce + pinPub + sign(sha256(Buffer.concat([ascii('CashuCard/pinkey'), Buffer.from(pinPub, 'hex')]))) + '9000';
        }
        if (p1 !== 0) return '6a86';
        if (!s.owner) return '6a90';
        s.nonce = crypto.randomBytes(16).toString('hex');
        return s.nonce + '9000';
      }
      case 0x45: {
        if (s.locked) return '6986';
        if (!s.owner) return '6a90';
        const got = ownerProof('CashuCard/load', data);
        if (got.sw) return got.sw;
        if (got.value.length !== 0) return '6700';
        s.grant = true;
        return '9000';
      }
      case 0x50: {
        if (!strictWrite()) return '6982';
        if (p2 !== 0xde) return '6b00';
        if (s.locked) return '6985';
        const got = ownerProof('CashuCard/lock', data);
        if (got.sw) return got.sw;
        if (got.value.length !== 0) return '6700';
        s.locked = true;
        return '9000';
      }
      case 0x51: {
        /* RESET: the owner gives the card back to what it was in its packet. Checked in this order: the confirming bytes (P1 = 0, P2 = 0xAD,
         * else 6B00); an owner (6A90); the owner's proof over "CashuCard/reset" and an empty value (6A91; anything after the proof is 6700); a
         * LOCKED card also needs the PIN verified in this tap (6982; a blocked PIN is no bar to a card that is not locked, and the PIN is
         * not asked of one that is not); and nothing unspent (6A8D). Then, whole: every place empty; no PIN (three tries) and no owner; no record, no
         * limit, no allowance, no window, no count, no rollover; no log and no receipts; no change in hand, no signature to give again; no lock; and a NEW KEY. What it keeps is
         * its clock (`now`, and the last header's hash; the ratchet, the hardest difficulty taken, goes to nothing, as a new record
         * does it) and its software. */
        if (p1 !== 0 || p2 !== RESET_CONFIRM) return '6b00';
        if (!s.owner) return '6a90';
        const got = ownerProof('CashuCard/reset', data);
        if (got.sw) return got.sw;
        if (got.value.length !== 0) return '6700';
        if (s.locked && !s.verified) return '6982';
        if (unspent()) return '6a8d';
        s.slots.forEach((x) => { x.status = 0; x.data = ''; });
        s.pin = null; s.pinState = 0; s.tries = 3; s.verified = false; s.locked = false;
        s.owner = null; s.nonce = null; s.grant = false; s.changeGrant = false; s.changeDue = false;
        // the NFC tag is on again and the mint's proofs are zeros: none is a place's now, and none is for the next owner to read
        s.tagOff = false;
        if (s.dleq) s.dleq = s.dleq.map(() => '');
        s.record = { set: false, unit: 0, limit: 0, refund: '00'.repeat(33), mint: '', design: '' };
        s.windowStart = 0; s.spent = 0; s.noPinLimit = 0; s.noPinSpent = 0; s.tapLimit = 0;
        // the wipe takes the rollover bytes with it (D20)
        s.rolls = 0; s.budget = 0; s.armed = false;
        s.log = { taps: 0, sats: 0, refused: 0, tampers: 0, runAt: 0, run: 0,
                  ring: Array.from({ length: 8 }, () => ({ time: 0, sats: 0, pieces: 0, refused: 0, flags: 0, told: 0 })) };
        s.receipts = { count: 0, ring: Array.from({ length: 16 }, () => ({ time: 0, told: 0, sats: 0, hash: '00'.repeat(32), out: '00'.repeat(33) })) };
        s.tapOpen = false; s.tapPaid = false;
        s.openings = Array.from({ length: CHANGE_MOST }, () => ({ state: 'empty' }));
        s.all = null; s.lastSig = null; s.lastNoPin = false; delete s.lastText; s.waited = 0;
        s.hardest = 0;
        nextChange = null;
        priv = nextKey || crypto.randomBytes(32).toString('hex');
        nextKey = null;
        pub = hex(CT.getPubKeyFromPrivKey(own(Buffer.from(priv, 'hex'))));
        return '9000';
      }
      case 0x52: {
        /* SET_TAG: the owner switches the card's NFC tag off (P1 = 1) or on (P1 = 0). The owner's proof over "CashuCard/tag", the nonce just
         * given and the one byte after the proof, which is P1 again; no PIN, any funds. Refused in this order: 6B00 for a P1 over 1 or a P2 over 0, before
         * anything else (the nonce is left unspent); 6986 on a locked card; 6A90 with no owner; 6A91 with no nonce asked for in this tap, or a proof that
         * is not the owner's for this label, this nonce and these bytes (no PIN try is spent, and the nonce is); 6700 for anything but one byte after the
         * proof; 6B00 for a byte that is not P1. The state it already has is 9000 and writes nothing. */
        if (p1 > 1 || p2 !== 0) return '6b00';
        if (s.locked) return '6986';
        const got = ownerProof('CashuCard/tag', data);
        if (got.sw) return got.sw;
        if (got.value.length !== 1) return '6700';
        if (got.value[0] !== p1) return '6b00';
        s.tagOff = p1 === 1;
        return '9000';
      }
      case 0x53: {
        /* REFRESH (D20): the owner's proof over "CashuCard/refresh", the nonce just given and a block header (80 bytes). The header is
         * held to everything SET_HEADER holds one to and taken as it takes one (an older one moves nothing); then the rollover count goes
         * to 0, so the window may roll its budget's days again. No PIN; any funds; a locked card too. Answers the card's clock. */
        const got = ownerProof('CashuCard/refresh', data);
        if (got.sw) return got.sw;
        if (got.value.length !== 80) return '6700';
        const bad = headerProblem(got.value);
        if (bad) return bad;
        takeHeader(got.value);
        s.rolls = 0;
        return u32(s.now) + '9000';
      }
      default: return '6d00';
    }
  }

  return {
    // whatever key it has now (a RESET gives it another)
    get key() { return pub; },
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
    tap() { gone = false; leaveIn = -1; leaveAt = null; loseAt = null; s.verified = false; s.nonce = null; s.grant = false; s.changeGrant = false; s.selected = false; s.opener = false; s.tapOpen = false; s.tapPaid = false; s.all = null; s.told = 0; },
    /* It leaves just as the `nth` command of this instruction (two hex digits) is sent, which is not answered. */
    leaveBefore(ins, nth) { leaveAt = { ins: String(ins).toLowerCase(), nth: nth || 1 }; },
    /* It leaves as it answers the `nth` command of this instruction: the card has done what was asked, and nobody hears. */
    loseAnswerOf(ins, nth) { loseAt = { ins: String(ins).toLowerCase(), nth: nth || 1 }; },
    /* Another card with this one's key and everything on it as it is now: what a copied card would be. */
    copy() {
      const twin = makeCard({ window: o.window, key: priv, pinKey: pinPriv, floorBits: FLOOR_BITS, proofRoom: o.proofRoom, chip: o.chip });
      Object.assign(twin.state, JSON.parse(JSON.stringify(s)), { verified: false, nonce: null, grant: false, changeGrant: false, selected: false, tapOpen: false, tapPaid: false, told: 0 });
      return twin;
    },
    /* It leaves the field after `n` more commands have been answered. */
    leaveAfter(n) { leaveIn = n; },
    setNonce(nonceHex) { s.nonce = String(nonceHex).toLowerCase(); },
    // the private key (32 bytes, hex) the next RESET gives it, in place of a random one: what a recording of the applet needs
    setNewKey(privHex) {
      const k = String(privHex).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(k)) throw new Error('a key is 32 bytes');
      nextKey = k;
    },
    /* The next change the card makes for itself has this nonce and this blinding factor (32 bytes each, as hex; r under the
     * curve's order and not zero) in place of random ones: what a recording of the applet needs, which draws them itself. */
    setChange(nonceHex, rHex) {
      const nonce = String(nonceHex).toLowerCase(), r = String(rHex).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(r)) throw new Error('a change is made of a nonce and a blinding factor of 32 bytes each');
      if (BigInt('0x' + r) === 0n || BigInt('0x' + r) >= CURVE_N) throw new Error('a blinding factor is under the curve’s order and not zero');
      nextChange = { nonce, r };
    },
    secretOf: (i) => secretOf(s.slots[i]),
    format: FORMAT,
    // the protocol it speaks, as SELECT answers it
    version: VERSION,
    balance: () => s.slots.reduce((a, x) => (x.status === 1 ? a + amountOf(x) : a), 0),
  };
}

module.exports = { makeCard, AID, PACKAGE };
