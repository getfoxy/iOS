'use strict';
/* flashcard-kit.js — what the flashcard suites share: a page with a phone and
 * a mint behind it, and a card to tap on it. */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
const { makeCard } = require('./flashcard-card');

const MINT = 'https://m.test';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

/* A page as it ships, its bridge answered by a phone that holds `words` and by
 * a mint (`sharedMint`, or one of its own). `feePpk` is the mint's input fee. */
function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  let mint = null;
  let ctx = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        if (ctx.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
        return reply(w, m.id, (ctx.fate && ctx.fate(m)) || mint.handle(m));
      }
      if (m.action === 'inboxAnswer') return reply(w, m.id, 'ok');
      /* The phone's NFC, as Foxy/Flashcard/CardLink.swift answers: `ctx.nfc`
       * is the card that will be tapped (or null for none, or 'off' for a
       * phone that cannot read one), `ctx.sheet` every line the sheet showed. */
      if (m.action === 'cardBegin') {
        ctx.sheet.push('begin: ' + m.text);
        if (ctx.nfc === 'off') return reply(w, m.id, null, 'NFC is not available on this phone');
        if (!ctx.nfc) return reply(w, m.id, null, 'the session was cancelled');
        ctx.nfc.tap();
        return reply(w, m.id, 'ok');
      }
      if (m.action === 'cardSend') {
        if (!ctx.nfc || ctx.nfc === 'off') return reply(w, m.id, null, 'no card');
        return ctx.nfc.send(m.apdu).then((r) => reply(w, m.id, r), () => reply(w, m.id, null, 'the tag was lost'));
      }
      if (m.action === 'cardSay') { ctx.sheet.push('say: ' + m.text); return reply(w, m.id, 'ok'); }
      if (m.action === 'cardEnd') { ctx.sheet.push(m.error ? 'error: ' + m.error : 'end: ' + m.text); return reply(w, m.id, 'ok'); }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    // versionByte 1: a mint whose keysets have the long names (NUT-02's second kind)
    before: (w) => { phone.attach(w); mint = opts.sharedMint || fakeMint(w, { p2pk: true, feePpk: opts.feePpk, versionByte: opts.versionByte }); },
  });
  ctx.deaf = !!opts.deaf;
  ctx.nfc = null;
  ctx.sheet = [];
  ctx.mint = mint;
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

const settle = async () => { for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0)); };
const history = (c) => JSON.parse(c.storage.getItem('foxy.cashu.log') || '[]');
/* What a call rejected with: its `card` kind, or its message. */
const why = (p) => p.then(() => 'went through', (e) => (e && e.card) || (e && e.message) || String(e));

module.exports = { page, funded, newCard, settle, history, why, MINT, OTHER_WORDS, PHONE_WORDS };
