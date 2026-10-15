'use strict';
/* long-exact-set.js — a send the confirmation offers is a send that is made.
 *
 *     node tests/long-exact-set.js
 *
 * Pieces on hand that add up to the amount go into the token as they are, with
 * no swap and no fee, and `sendShortfall` said yes to any amount such a set
 * makes. But `sendToken` swaps a set of more than 24 pieces for a handful when
 * there is a route, and a swap costs the mint's fee on every input and the
 * receiver's fee on what comes out (includeFees). A set that covers only the
 * amount cannot pay that, so cashu-ts refused the send the confirmation had
 * just offered: "Not enough funds available to send", twelve times in one
 * crowd run at a mint that charges 100 ppk. Both now ask one rule
 * (`exactGoesAsIs`), and this checks they give the same answer: refused
 * together when the long set would be swapped and its fees do not fit (30
 * pieces, and 25, the first that is long), and both yes when the swap can
 * still make it, with 24 pieces or fewer, past the mint's cap, with no route,
 * and at a mint that charges nothing.
 *
 * The pile is written straight into storage: one-sat pieces signed with the
 * fake mint's key. Where the set goes as it is the mint is never asked; where
 * it is swapped at a mint with no fee, the fake mint makes the swap.
 */
const crypto = require('crypto');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS, noBooks } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

function page(feePpk, more) {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w, Object.assign({ feePpk: feePpk }, more || {})); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  // its pile is written in by hand, pieces no entry ever brought in, so the books have nothing to say
  noBooks(ctx, 'a pile written straight into storage');
  ctx.mint = () => mint;
  return ctx;
}

const routeUp = (W) => W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
const routeDown = (W) => W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false, transport: 'direct', network: 'none' });

/* `count` one-sat pieces, and the pieces of `more` beside them, in the pile.
 * Signed with the fake mint's own key (its key seed is the byte 7,
 * `fakeMint`), because it checks every input of a swap: C is the secret's
 * point times that key. */
function pileOf(ctx, count, more) {
  const w = ctx.window, C = w.CashuTS, m = ctx.mint();
  const pair = C.createNewMintKeys(16, new w.Uint8Array(64).fill(7), { versionByte: 0 });
  const pile = [];
  for (const amount of Array(count).fill(1).concat(more || [])) {
    const key = BigInt('0x' + Buffer.from(Array.from(pair.privKeys[String(amount)])).toString('hex'));
    const secret = crypto.randomBytes(32).toString('hex');
    const point = C.hashToCurve(new w.Uint8Array(Buffer.from(secret, 'utf8'))).multiply(key);
    pile.push({ id: m.id, amount, secret, C: point.toHex(true) });
  }
  ctx.storage.setItem('foxy.cashu.proofs.' + MINT, JSON.stringify(pile));
}

/* What the check says and what the send does, for one amount. */
async function both(W, sats) {
  const check = W.sendShortfall(sats);
  let sent = null, refused = null;
  try { sent = await W.sendToken(sats, { unit: 'sat' }); } catch (e) { refused = String(e && e.message); }
  const pieces = sent ? W.tokenInfo(sent.token).proofs.length : 0;
  return { check, sent, refused, pieces };
}

(async () => {
  /* 100 ppk: thirty one-sat pieces make 27 and the receiver's 3 exactly, so
   * the exact set is all thirty. Swapped, the 27 and the receiver's 1 on four
   * outputs need 28 after the swap's own 3: thirty is 27 after it. */
  {
    const ctx = page(100);
    routeUp(ctx.W);
    await ctx.W.connect(MINT, { remember: true });
    pileOf(ctx, 30);
    const r = await both(ctx.W, 27);
    ok(r.check && r.check.short === true && r.check.need === 31,
      'at a fee mint with a route, a set of 30 is not offered: the check says short, need 31',
      JSON.stringify(r.check));
    ok(!r.sent && !!r.refused, 'and the send refuses it too, so the two agree', r.refused || 'sent ' + r.pieces + ' pieces');
    ok(/needs 31 sats/.test(r.check.why || ''), 'the check says why in the wallet\'s words', r.check.why);
    const left = JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.' + MINT) || '[]');
    ok(left.length === 30, 'and nothing left the pile', left.length + ' pieces in it');
  }

  /* 25 pieces, the first long set: 22 and the receiver's 3. Swapped, 22 is
   * three outputs and the receiver's 1, so 23 after the swap's own fee, and
   * twenty-five ones are 22 after it. Twenty-six would do: 26 less 3 is 23. */
  {
    const ctx = page(100);
    routeUp(ctx.W);
    await ctx.W.connect(MINT, { remember: true });
    pileOf(ctx, 25);
    const r = await both(ctx.W, 22);
    ok(r.check && r.check.short === true && r.check.need === 26,
      'at a fee mint with a route, a set of 25 is not offered: need 26', JSON.stringify(r.check));
    ok(!r.sent && !!r.refused, 'and the send refuses it too', r.refused || 'sent ' + r.pieces + ' pieces');
  }

  /* A long set that the swap can still make, because something larger is
   * held as well: both yes, and the swap is what happens. */
  {
    const ctx = page(100);
    routeUp(ctx.W);
    await ctx.W.connect(MINT, { remember: true });
    pileOf(ctx, 30, [64]);
    const r = await both(ctx.W, 27);
    ok(r.check && r.check.short === false, 'a long set beside a piece of 64 is offered', JSON.stringify(r.check));
    ok(!!r.sent && r.pieces > 0 && r.pieces < 30, 'and swapped for a handful', r.refused || r.pieces + ' pieces');
  }

  /* Past what the mint takes in one request there is no swap of them, so the
   * long set goes as it is, fee mint or not. */
  {
    const ctx = page(100, { maxArray: 25 });
    routeUp(ctx.W);
    await ctx.W.connect(MINT, { remember: true });
    pileOf(ctx, 30);
    const r = await both(ctx.W, 27);
    ok(r.check && r.check.short === false, 'above the mint\'s cap of 25, the set of 30 is offered', JSON.stringify(r.check));
    ok(!!r.sent && r.pieces === 30, 'and sent as it is, all 30 pieces', r.refused || r.pieces + ' pieces');
  }

  /* 24 pieces: 21 and the receiver's 3. Not over 24, so it goes as it is. */
  {
    const ctx = page(100);
    routeUp(ctx.W);
    await ctx.W.connect(MINT, { remember: true });
    pileOf(ctx, 24);
    const r = await both(ctx.W, 21);
    ok(r.check && r.check.short === false, 'at a fee mint with a route, a set of 24 is offered', JSON.stringify(r.check));
    ok(!!r.sent && r.pieces === 24, 'and sent as it is, all 24 pieces', r.refused || r.pieces + ' pieces');
  }

  /* No route: no swap to make, so the long set goes as it is. */
  {
    const ctx = page(100);
    routeUp(ctx.W);
    await ctx.W.connect(MINT, { remember: true });
    pileOf(ctx, 30);
    routeDown(ctx.W);
    const r = await both(ctx.W, 27);
    ok(r.check && r.check.short === false, 'with no route, the set of 30 is offered', JSON.stringify(r.check));
    ok(!!r.sent && r.pieces === 30, 'and sent as it is, all 30 pieces', r.refused || r.pieces + ' pieces');
  }

  /* A mint that charges nothing: the swap needs no more than the amount, so
   * the long set is offered and the swap makes it into a handful. */
  {
    const ctx = page(0);
    routeUp(ctx.W);
    await ctx.W.connect(MINT, { remember: true });
    pileOf(ctx, 30);
    const r = await both(ctx.W, 30);
    ok(r.check && r.check.short === false, 'at a mint with no fee, a set of 30 is offered', JSON.stringify(r.check));
    ok(!!r.sent && r.pieces > 0 && r.pieces < 30, 'and swapped for a handful', r.refused || r.pieces + ' pieces');
  }

  console.log('\n' + (failed ? failed + ' failed' : 'all long exact set checks pass'));
  process.exit(failed ? 1 : 0);
})();
