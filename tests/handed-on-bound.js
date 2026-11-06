'use strict';
/* handed-on-bound.js — the list of pieces handed on lets go only of what holds no money.
 *
 *     node tests/handed-on-bound.js
 *
 * Signing a locked piece and handing it on makes it the next person's money,
 * and this phone keeps the secret on a list so the same piece never goes out
 * twice. The list was cut to its last 200 on every write, oldest first. A piece
 * whose row could not be rewritten when it went is still named by that row,
 * and once its secret fell off the end the phone would offer it again and hand
 * it to a second person, who would lose. Now the list is bounded the way the
 * in-flight lists are: entries whose pieces are on no waiting row are let go,
 * oldest first; one still named by a row is never dropped; and a new hand-on
 * that would need more room than that is refused before anything is signed. */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  let mint = opts.mint || null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
      if (m.action === 'inboxAnswer') return reply(w, m.id, 'ok');
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); if (!mint) mint = fakeMint(w, { p2pk: true }); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.mint = mint;
  return ctx;
}

const settle = async () => { for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0)); };
const offline = (W) => W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
const get = (c, k, d) => { try { const v = JSON.parse(c.window.localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const HANDED = 'foxy.req.handedon';
const UNCLAIMED = 'foxy.req.unclaimed';
const fake = (n) => Array.from({ length: n }, (_, i) => 'settled-' + String(i).padStart(4, '0') + '-' + 'a'.repeat(40));

async function run() {
  const rx = page();
  const W = rx.W;
  await W.connect(MINT, { remember: true });
  await W.primeLocks();
  const payer = page({ mint: rx.mint, words: OTHER_WORDS });
  await payer.W.connect(MINT, { remember: true });
  await payer.W.claim((await payer.W.invoice(2000, '')).hash);

  // three locked payments kept with no route
  offline(W);
  const kept = [];
  for (const n of [40, 50, 60]) {
    const ask = W.decodeRequest(W.paymentRequest(n, { purpose: 'receive' })) || {};
    const pay = await payer.W.sendToken(n, { unit: 'sat', lockTo: ask.lockTo });
    W._requestPaid(JSON.stringify({ id: ask.id, mint: MINT, unit: 'sat', proofs: W.tokenInfo(pay.token).proofs }), 'inbox-' + n);
    await settle();
    kept.push({ id: ask.id, token: get(rx, UNCLAIMED, {})[ask.id].token });
  }
  ok(kept.every((k) => !!k.token), 'three locked payments wait on the unclaimed list');

  /* The first was handed on with its row's rewrite refused: its secrets are on the handed-on list, oldest of all, and
   * its row still names them. Behind them, 199 entries whose pieces are on no row (settled). */
  const first = W.tokenInfo(kept[0].token).proofs.map((p) => p.secret);
  rx.window.localStorage.setItem(HANDED, JSON.stringify(first.concat(fake(199))));
  const r2 = await W.forwardLocked(kept[1].token);
  ok(!!(r2 && r2.token), 'a second payment is handed on');
  const after = get(rx, HANDED, []);
  ok(first.every((s) => after.indexOf(s) >= 0), 'the pieces a waiting row still names stay on the list, however old',
     first.filter((s) => after.indexOf(s) < 0).length + ' of ' + first.length + ' dropped');
  ok(after.length <= 200, 'and the list is held to 200, settled entries let go first', after.length + ' entries');
  const second = W.tokenInfo(kept[1].token).proofs.map((p) => p.secret);
  ok(second.every((s) => after.indexOf(s) >= 0), 'the pieces just handed on are on it');
  const again = await W.forwardLocked(kept[0].token).then(() => 'handed on', (e) => String(e && e.message));
  ok(/already been handed on/.test(again), 'and the first payment is not handed on a second time', again);

  /* Every entry names a piece a waiting row holds: nothing can be let go, and a new hand-on is refused before it
   * is signed, with the list and the waiting rows as they were. */
  {
    const rows = get(rx, UNCLAIMED, {});
    const blockers = [];
    const tok = W.tokenInfo(kept[0].token);
    const proto = tok.proofs[0];
    const pieces = Array.from({ length: 200 }, (_, i) => Object.assign({}, proto, { secret: proto.secret.replace(/"nonce","[0-9a-f]+"/, '"nonce","' + (i.toString(16).padStart(64, '0')) + '"') }));
    pieces.forEach((p) => blockers.push(p.secret));
    rows.held = { token: W._encodeTokenForTest ? W._encodeTokenForTest(tok.mint, pieces, 'sat') : null, at: Date.now(), amount: 1, unit: 'sat', sats: 1, stranded: true };
    if (!rows.held.token) {
      const C = rx.window.CashuTS;
      rows.held.token = C.getEncodedTokenV4 ? C.getEncodedTokenV4({ mint: tok.mint, proofs: pieces, unit: 'sat' })
                                           : C.getEncodedToken({ mint: tok.mint, proofs: pieces, unit: 'sat' });
    }
    rx.window.localStorage.setItem(UNCLAIMED, JSON.stringify(rows));
    rx.window.localStorage.setItem(HANDED, JSON.stringify(blockers));
    const third = await W.forwardLocked(kept[2].token).then(() => null, (e) => e);
    ok(!!third && third.inFlightFull === true, 'a hand-on with no room left among settled entries is refused',
       String(third && third.message));
    ok(JSON.stringify(get(rx, HANDED, [])) === JSON.stringify(blockers) && !!get(rx, UNCLAIMED, {})[kept[2].id],
       'and nothing is written: the list as it was, the payment still waiting');
  }

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
