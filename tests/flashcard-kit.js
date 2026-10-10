'use strict';
/* flashcard-kit.js — what the flashcard suites share: a page with a phone and
 * a mint behind it, and a card to tap on it. */
const crypto = require('crypto');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
const { makeCard } = require('./flashcard-card');

/* The two block explorers a card's clock is fetched from, by their onion addresses (build/wallet/08b-block-headers.js). A page made
 * with `headers: true` fetches from them on its own (Tor up, a card tapped); one made without does not, and a test asks
 * (`W.headerRefresh`). What they answer is `ctx.explorer(host, path)`: the answer's text with its status before it ('200\n...'),
 * a promise of one, or nothing at all for a source that does not answer. They are not the mint: their requests are in
 * `ctx.explored` and in neither `ctx.trace` nor `ctx.circuits`. */
const EXPLORERS = { mempool: 'mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion', blockstream: 'explorerzydxu5ecjrkwceayqybizmpjjznk5izmitf2modhcusuqlid.onion',
  // the same two by their ordinary names, which the page asks through a Tor exit only when neither onion gave a header
  mempoolExit: 'mempool.space', blockstreamExit: 'blockstream.info' };

const MINT = 'https://m.test';
// a second mint, for a card that is moved from one to another (`page({ second: true })`)
const MINT2 = 'https://n.test';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

/* A page as it ships, its bridge answered by a phone that holds `words` and by
 * a mint (`sharedMint`, or one of its own). `feePpk` is the mint's input fee. */
function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  let mint = null;
  let mint2 = null;
  let ctx = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    storage: opts.storage,
    spare: !!opts.spare,
    headers: !!opts.headers,
    bridge: (w, m) => {
      if (m.action === 'mintRequest' && Object.values(EXPLORERS).indexOf(new URL(m.url).hostname) >= 0) {
        const at = new URL(m.url);
        ctx.explored.push({ host: at.hostname, path: at.pathname, circuit: m.circuit || '', method: m.method || 'GET', url: m.url });
        const got = ctx.explorer ? ctx.explorer(at.hostname, at.pathname) : null;
        return Promise.resolve(got).then((text) => (text === undefined || text === null)
          ? reply(w, m.id, null, 'The Internet connection appears to be offline') : reply(w, m.id, text));
      }
      if (m.action === 'mintRequest') {
        // every request the mint is sent, in order with the card's sheet (`ctx.trace`), and which circuit it left on
        ctx.trace.push('mint ' + new URL(m.url).pathname);
        ctx.circuits.push({ path: new URL(m.url).pathname, circuit: m.circuit || '' });
        if (ctx.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
        // by the address asked: the second mint's requests are the second mint's
        const at = (mint2 && new URL(m.url).origin === MINT2) ? mint2 : mint;
        return reply(w, m.id, (ctx.fate && ctx.fate(m)) || at.handle(m));
      }
      if (m.action === 'inboxAnswer') return reply(w, m.id, 'ok');
      /* The phone's NFC, as Foxy/Flashcard/CardLink.swift answers: `ctx.nfc`
       * is the card that will be tapped (or null for none, or 'off' for a
       * phone that cannot read one), `ctx.sheet` every line the sheet showed. */
      if (m.action === 'cardBegin') {
        ctx.sheet.push('begin: ' + m.text);
        ctx.trace.push('begin');
        ctx.ended = false;
        if (ctx.nfc === 'off') return reply(w, m.id, null, 'NFC is not available on this phone');
        if (!ctx.nfc) return reply(w, m.id, null, 'the session was cancelled');
        ctx.nfc.tap();
        return reply(w, m.id, 'ok');
      }
      if (m.action === 'cardSend') {
        // the sheet has ended: the phone has no session to carry a command (Foxy/Bridge/FoxyBridge+Flashcard.swift)
        if (ctx.ended) { ctx.refusedAfterEnd += 1; return reply(w, m.id, null, 'the tag was lost'); }
        if (!ctx.nfc || ctx.nfc === 'off') return reply(w, m.id, null, 'no card');
        return ctx.nfc.send(m.apdu).then((r) => reply(w, m.id, r), () => reply(w, m.id, null, 'the tag was lost'));
      }
      if (m.action === 'cardSay') { ctx.sheet.push('say: ' + m.text); return reply(w, m.id, 'ok'); }
      // the same sheet looks for the card again (FoxyBridge+Flashcard.swift, handleCardAgain): the card is tapped anew, or none is
      if (m.action === 'cardAgain') {
        ctx.sheet.push('again: ' + m.text);
        if (ctx.ended) return reply(w, m.id, null, 'the session was cancelled');
        if (!ctx.nfc || ctx.nfc === 'off') { ctx.ended = true; return reply(w, m.id, null, 'the session was cancelled'); }
        ctx.nfc.tap();
        return reply(w, m.id, 'ok');
      }
      if (m.action === 'cardEnd') {
        ctx.sheet.push(m.error ? 'error: ' + m.error : 'end: ' + m.text);
        ctx.trace.push(m.error ? 'error' : 'end');
        ctx.ended = true;
        return reply(w, m.id, 'ok');
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    // versionByte 1: a mint whose keysets have the long names (NUT-02's second kind)
    before: (w) => {
      phone.attach(w);
      mint = opts.sharedMint || fakeMint(w, { p2pk: true, feePpk: opts.feePpk, versionByte: opts.versionByte });
      // keys and quote numbers of its own, as two real mints have
      if (opts.second) mint2 = opts.sharedMint2 || fakeMint(w, { p2pk: true, fill: 9, quoteFrom: 5000, feePpk: opts.feePpk2, versionByte: opts.versionByte2 });
    },
  });
  ctx.deaf = !!opts.deaf;
  ctx.nfc = null;
  ctx.sheet = [];
  ctx.trace = [];
  ctx.circuits = [];
  ctx.explorer = null;
  ctx.explored = [];
  ctx.ended = false;
  ctx.refusedAfterEnd = 0;
  ctx.mint = mint;
  ctx.mint2 = mint2;
  ctx.phone = phone;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}

/* Connected at MINT, with `sats` claimed from an invoice (0 for none). */
async function funded(o, sats) {
  const c = page(o);
  await c.W.connect((o && o.mint) || MINT, null, null, { remember: true });
  if (sats) await c.W.claim((await c.W.invoice(sats, '')).hash);
  await c.W.primeLocks();
  return c;
}

/* A new card, as it comes out of its packet. `o` is the model's options (`software`, `floorBits`, ...). */
const newCard = (ctx, key, o) => makeCard(Object.assign({ window: ctx.window, key }, o || {}));

/* ---- block headers, for the suites that need a clock on a card ---------------------------------------------------------
 * A header as the network carries it (80 bytes: version, the previous hash, the merkle root, the time, `bits`, the nonce;
 * every number little-endian), mined here: its nonce found with node's hash, at a difficulty so low it takes two tries.
 * `CHEAP` is that difficulty (the target is about 2^255), and a card that takes such a header is made with it for its floor
 * (`newCard(ctx, key, { floorBits: CHEAP })`): the real floor is 2^184 and cannot be mined in a test. */
const CHEAP = 0x207fffff;
const targetOfBits = (bits) => {
  const exp = bits >>> 24, man = bits & 0xffffff;
  return exp >= 3 ? BigInt(man) << BigInt(8 * (exp - 3)) : BigInt(man >> (8 * (3 - exp)));
};
const sha256d = (buf) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest();
let headerSeq = 0;
function mineHeader(time, bits, o) {
  const opts = o || {};
  const b = Buffer.alloc(80);
  b.writeInt32LE(0x20000000, 0);
  // the previous block and the merkle root are made up, and different for every header (or what `opts.prev` names)
  headerSeq += 1;
  (opts.prev ? Buffer.from(opts.prev, 'hex').reverse() : crypto.createHash('sha256').update('previous ' + headerSeq).digest()).copy(b, 4);
  crypto.createHash('sha256').update('merkle ' + headerSeq).digest().copy(b, 36);
  b.writeUInt32LE(time >>> 0, 68);
  b.writeUInt32LE((bits === undefined ? CHEAP : bits) >>> 0, 72);
  const target = targetOfBits(b.readUInt32LE(72));
  for (let nonce = 0; ; nonce++) {
    b.writeUInt32LE(nonce, 76);
    if (opts.fail ? BigInt('0x' + Buffer.from(sha256d(b)).reverse().toString('hex')) > target
                  : BigInt('0x' + Buffer.from(sha256d(b)).reverse().toString('hex')) <= target) return b.toString('hex');
  }
}
/* A header's hash as Bitcoin shows it. */
const hashOfHeader = (hex) => Buffer.from(sha256d(Buffer.from(hex, 'hex'))).reverse().toString('hex');
/* The explorers of a page answering as the network's tip is this header: both of them, or `only` ('mempool' or 'blockstream': an operator,
 * whose onion and ordinary name answer alike). A source that is left out does not answer. `lie` is a header a source gives for the tip it
 * names instead of the real one. `onions: 'down'` is onions that do not answer, `onions: 'hang'` ones that never do; `exits: 'down'` is
 * ordinary names that do not answer. */
function tipIs(ctx, hex, o) {
  const opts = o || {};
  const tip = hashOfHeader(hex);
  ctx.explorer = (host, path) => {
    const exit = host === EXPLORERS.mempoolExit || host === EXPLORERS.blockstreamExit;
    const who = (host === EXPLORERS.mempool || host === EXPLORERS.mempoolExit) ? 'mempool' : 'blockstream';
    if (exit ? opts.exits === 'down' : opts.onions === 'down') return null;
    if (!exit && opts.onions === 'hang') return new Promise(() => {});
    if (opts.only && opts.only !== who) return null;
    const mine = opts.per && opts.per[who];
    if (/^\/api\/blocks\/tip\/hash$/.test(path)) return '200\n' + (mine ? hashOfHeader(mine) : tip);
    const m = /^\/api\/block\/([0-9a-f]{64})\/header$/.exec(path);
    if (m) return '200\n' + ((mine && hashOfHeader(mine) === m[1]) ? mine : (opts.lie && opts.lie[who]) || hex);
    return '404\nnot found';
  };
}

/* Money onto a card cut the old way, in the powers of two the amount is made of and no more (a card is cut like a
 * cash drawer now, and has an exact set for any price): for a test that needs a card with no exact set, so that a
 * payment needs change. The card is told, for the cutting only, that it already holds every size eight deep (as deep as any drawer is cut), so no
 * gap is filled and no rung deepened. Written at a tap with the owner's proof, or the PIN (`o.pin`). */
async function binaryLoad(ctx, card, sats, o) {
  const opts = o || {};
  card.tap();
  const seen = await ctx.W.cardLook(card);
  const sizes = [];
  for (let i = 0; i < 46; i++) for (let k = 0; k < 8; k++) sizes.push({ nonce: 'x'.repeat(i + 1) + k, amount: Math.pow(2, i) });
  await ctx.W.cardPrepare(Object.assign({}, seen, { pieces: seen.pieces.concat(sizes) }), sats);
  card.tap();
  return ctx.W.cardWrite(card, opts.pin ? { pin: opts.pin } : { owner: true });
}

const settle = async () => { for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0)); };
const history = (c) => JSON.parse(c.storage.getItem('foxy.cashu.log') || '[]');
/* What a call rejected with: its `card` kind, or its message. */
const why = (p) => p.then(() => 'went through', (e) => (e && e.card) || (e && e.message) || String(e));

module.exports = { page, funded, newCard, binaryLoad, settle, history, why, MINT, MINT2, OTHER_WORDS, PHONE_WORDS,
                    EXPLORERS, CHEAP, mineHeader, hashOfHeader, tipIs, sha256d, targetOfBits };
