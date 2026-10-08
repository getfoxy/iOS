'use strict';
/* flashcard-kit.js — what the flashcard suites share: a page with a phone and
 * a mint behind it, and a card to tap on it. */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
const { makeCard } = require('./flashcard-card');

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
    bridge: (w, m) => {
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

/* A new card, as it comes out of its packet. */
const newCard = (ctx, key) => makeCard({ window: ctx.window, key });

/* Money onto a card cut the old way, in the powers of two the amount is made of and no more (a card is cut like a
 * cash drawer now, and has an exact set for any price): for a test that needs a card with no exact set, so that a
 * payment needs change. The card is told, for the cutting only, that it already holds every size three deep, so no
 * gap is filled and no rung deepened. Written at a tap with the owner's proof, or the PIN (`o.pin`). */
async function binaryLoad(ctx, card, sats, o) {
  const opts = o || {};
  card.tap();
  const seen = await ctx.W.cardLook(card);
  const sizes = [];
  for (let i = 0; i < 46; i++) for (let k = 0; k < 3; k++) sizes.push({ nonce: 'x'.repeat(i + 1) + k, amount: Math.pow(2, i) });
  await ctx.W.cardPrepare(Object.assign({}, seen, { pieces: seen.pieces.concat(sizes) }), sats);
  card.tap();
  return ctx.W.cardWrite(card, opts.pin ? { pin: opts.pin } : { owner: true });
}

const settle = async () => { for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0)); };
const history = (c) => JSON.parse(c.storage.getItem('foxy.cashu.log') || '[]');
/* What a call rejected with: its `card` kind, or its message. */
const why = (p) => p.then(() => 'went through', (e) => (e && e.card) || (e && e.message) || String(e));

module.exports = { page, funded, newCard, binaryLoad, settle, history, why, MINT, MINT2, OTHER_WORDS, PHONE_WORDS };
