'use strict';
/* card-loads-spent.js — a card load whose pieces the mint says are spent keeps only its showing copy.
 *
 *     node tests/card-loads-spent.js
 *
 * A card top-up's note keeps its token until every piece is in that card's file on this phone (`cardLoadOnFile`). On a
 * phone whose store sat at its cap, 84 of 90 such notes were for card keys with no row there at all, so that rule could
 * never be met, and 2 MB of their text was kept for ever: a card's tap was refused for room. The mints said nearly
 * every one of those pieces was long spent.
 *
 * After a connect settles, the loads kept at that mint are asked about (NUT-07), at most 400 Ys a request, on a
 * circuit of the sweep's own, at most once an hour a mint (`cardLoadsSpent`, build/wallet/08a-flashcard.js). Here,
 * against the harness's mint, with what it says about chosen pieces set by the test:
 *   1. a load spent in every piece keeps only `kept`; one with a piece unspent and one with a piece pending keep
 *      `token`; one whose change is still owed is not asked about; the sweep says what it did in one line;
 *   2. nothing is asked with no route, and the connect does not wait for the sweep;
 *   3. asked once a connect, not again within the hour, and again after it;
 *   4. an answer that is short, long, or names another Y lets nothing go;
 *   5. a load at another mint is not asked about at this one;
 *   6. the phone's own case: a store at the cap with spent card loads refuses a card's tap, and the sweep makes room;
 *   7. a load whose pieces are on file is still let go by the trim, without asking.
 */
const crypto = require('crypto');
const { funded, newCard, MINT, MINT2 } = require('./flashcard-kit');
const { noBooks } = require('./harness');

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};

const CAP = 5 * 1024 * 1024;
const RESERVE = 'foxy.store.reserve';
const HOUR = 60 * 60 * 1000;
const wk = (s) => s.length * (/[^\u0000-ÿ]/.test(s) ? 2 : 1);
const bytesOf = (st, noReserve) => {
  let n = 0;
  for (let i = 0; i < st.length; i++) { const k = st.key(i); if (noReserve && k === RESERVE) continue; n += wk(k) + wk(st.getItem(k) || ''); }
  return n;
};
const get = (c, k, d) => { try { const v = JSON.parse(c.storage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const key = () => { const e = crypto.createECDH('secp256k1'); e.generateKeys(); return e.getPublicKey('hex', 'compressed'); };
// the sweep's hour made to pass (no such note on a build without the sweep)
const age = (c, ms) => { if (c.W._cardLoadsAge) c.W._cardLoadsAge(ms); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isErr = (x) => !!(x && typeof x === 'object' && typeof x.message === 'string' && typeof x.stack === 'string');

/* A page with money and a card set up, one real load prepared for it (its pieces are in the card's file), and the mint's
 * checkstate answered through `c.said` (a state by Y, over what the mint says) and `c.answer` (the states, reshaped).
 * Every checkstate is in `c.asked` ({ ys, circuit }); the page's log lines in `c.logs`. */
async function world(o) {
  const c = await funded({}, 30000);
  c.card = newCard(c);
  await c.W.cardSetUp(c.card, { pin: '1234', recoverable: true });
  if (o && o.full) {
    c.full = newCard(c);
    await c.W.cardSetUp(c.full, { pin: '1234', recoverable: true });
    c.full.tap();
    await c.W.cardAdd(c.full, { sats: 5000, pin: '1234' });
  }
  c.card.tap();
  await c.W.cardPrepare(await c.W.cardLook(c.card), 3000);
  const meta = get(c, 'foxy.txmeta', {});
  c.realLoad = Object.keys(meta).filter((h) => meta[h].to === 'card' && meta[h].token)[0];
  c.sample = meta[c.realLoad].token;
  c.logs = [];
  for (const how of ['log', 'warn']) {
    const was = c.window.console[how].bind(c.window.console);
    c.window.console[how] = (...a) => { c.logs.push(a.map(String).join(' ')); if (process.env.FOXY_VERBOSE) was(...a); };
  }
  c.asked = [];
  c.said = {};
  c.answer = null;
  c.fate = (m) => {
    if (new URL(m.url).pathname !== '/v1/checkstate') return null;
    const ys = (JSON.parse(m.body || '{}').Ys) || [];
    c.asked.push({ ys, circuit: m.circuit || '' });
    const real = JSON.parse(String(c.mint.handle(m)).replace(/^\d+\n/, ''));
    let states = real.states.map((s) => (c.said[s.Y] ? Object.assign({}, s, { state: c.said[s.Y] }) : s));
    if (c.answer) states = c.answer(states);
    return '200\n' + JSON.stringify({ states });
  };
  noBooks(c, 'notes put in its store behind the wallet’s back');
  return c;
}

const yOf = (c, secret) => c.window.CashuTS.hashToCurve(new c.window.Uint8Array(Buffer.from(String(secret), 'utf8'))).toHex(true);

/* A load like the real one, of `n` pieces (its pieces again, each with a nonce of its own), for a card key this phone has
 * no row for, at `mint`. Its token and its Ys. */
function cloneLoad(c, mint, n) {
  const info = c.W.tokenInfo(c.sample);
  const cardKey = key();
  const proofs = [];
  for (let i = 0; i < (n || info.proofs.length); i++) {
    const p = info.proofs[i % info.proofs.length];
    const j = JSON.parse(p.secret);
    j[1].nonce = crypto.randomBytes(32).toString('hex');
    j[1].data = cardKey;
    proofs.push(Object.assign({}, p, { secret: JSON.stringify(j) }));
  }
  const token = c.window.CashuTS.getEncodedToken({ mint: mint || MINT, proofs, unit: 'sat' });
  return { token, ys: proofs.map((p) => yOf(c, p.secret)) };
}

function putLoads(c, loads) {
  const meta = get(c, 'foxy.txmeta', {});
  for (const [h, l, extra] of loads) meta[h] = Object.assign({ to: 'card', carded: Date.now(), token: l.token }, extra || {});
  c.storage.setItem('foxy.txmeta', JSON.stringify(meta));
}

// the checkstate requests that asked about any of `ys`
const askedFor = (c, ys) => { const s = new Set(ys); return c.asked.filter((a) => a.ys.some((y) => s.has(y))); };
const sweepLines = (c) => c.logs.filter((l) => /\[foxy\] card: \d+ loads whose pieces the mint says are spent let go/.test(l));

/* A connect, and then the sweep it starts, waited for: until a new sweep line, or `ms`. */
async function connectAndSettle(c, ms) {
  const lines = sweepLines(c).length;
  await c.W.connect(MINT, null, null, { remember: true });
  const until = Date.now() + (ms || 3000);
  while (Date.now() < until && sweepLines(c).length === lines) await wait(10);
  await wait(20);
}

(async () => {
  /* ---- 1. spent in every piece: only the showing copy kept; anything else keeps its token --------------------------- */
  {
    const c = await world();
    const spent = cloneLoad(c, MINT, 12), oneUnspent = cloneLoad(c, MINT, 12), onePending = cloneLoad(c, MINT, 12), owed = cloneLoad(c, MINT, 6);
    spent.ys.forEach((y) => { c.said[y] = 'SPENT'; });
    oneUnspent.ys.slice(1).forEach((y) => { c.said[y] = 'SPENT'; });
    onePending.ys.forEach((y, i) => { c.said[y] = i === 3 ? 'PENDING' : 'SPENT'; });
    owed.ys.forEach((y) => { c.said[y] = 'SPENT'; });
    putLoads(c, [['load-spent', spent], ['load-unspent', oneUnspent], ['load-pending', onePending], ['load-owed', owed, { owedChange: true }]]);
    const balance = await c.W.balanceSats();
    const pile = c.storage.getItem('foxy.cashu.proofs.' + MINT);
    await connectAndSettle(c);
    const m = get(c, 'foxy.txmeta', {});
    ok(!m['load-spent'].token && m['load-spent'].kept === spent.token && m['load-spent'].to === 'card',
       'a card load the mint says is spent in every piece keeps only its showing copy (`kept`)', JSON.stringify(Object.keys(m['load-spent'])));
    ok(m['load-unspent'].token === oneUnspent.token && !m['load-unspent'].kept, 'one with a piece unspent keeps its token');
    ok(m['load-pending'].token === onePending.token && !m['load-pending'].kept, 'one with a piece pending keeps its token');
    ok(m['load-owed'].token === owed.token && !askedFor(c, owed.ys).length, 'one whose change is still owed keeps its token, and is not asked about');
    const lines = sweepLines(c);
    const kb = Math.round(spent.token.length / 1024);
    ok(lines.length === 1 && lines[0].indexOf('[foxy] card: 1 loads whose pieces the mint says are spent let go, ' + kb + ' KB; 2 kept') === 0,
       'the sweep says so in one line', lines.join(' | ') || 'no line');
    const mine = askedFor(c, spent.ys.concat(oneUnspent.ys, onePending.ys));
    const others = c.circuits.filter((r) => r.path === '/v1/checkstate' && !mine.some((a) => a.circuit === r.circuit)).map((r) => r.circuit)
      .concat(c.circuits.filter((r) => r.path !== '/v1/checkstate').map((r) => r.circuit));
    ok(mine.length === 1 && !!mine[0].circuit && others.indexOf(mine[0].circuit) < 0,
       'asked in one request, on a circuit no other request rode', mine.length + ' request(s), circuit ' + (mine[0] && mine[0].circuit ? 'set' : 'none'));
    ok((await c.W.balanceSats()) === balance && c.storage.getItem('foxy.cashu.proofs.' + MINT) === pile, 'and the balance and the pile are as they were');
  }

  /* ---- 2. no route: nothing asked; and the connect does not wait for the sweep -------------------------------------- */
  {
    const c = await world();
    const spent = cloneLoad(c, MINT, 8);
    spent.ys.forEach((y) => { c.said[y] = 'SPENT'; });
    putLoads(c, [['load-spent', spent]]);
    const balance = await c.W.balanceSats();
    c.W._privacy({ tor: 'connecting', progress: 0, everUp: true, network: 'none' });
    await c.W.connect(MINT, null, null, { remember: true }).then(null, () => null);
    await wait(300);
    const direct = c.W._cardLoadsSpent ? await c.W._cardLoadsSpent(MINT) : 0;
    ok(!askedFor(c, spent.ys).length && direct === 0 && get(c, 'foxy.txmeta', {})['load-spent'].token === spent.token,
       'with no route nothing is asked, and the load keeps its token', askedFor(c, spent.ys).length + ' request(s)');
    c.W._privacy({ tor: 'up', progress: 100, everUp: true, network: 'satisfied' });
    // the connect resolves before the sweep has asked anything: it runs after the connect's own sweeps, waited for by nothing
    let atConnect = -1;
    await c.W.connect(MINT, null, null, { remember: true }).then(() => { atConnect = askedFor(c, spent.ys).length; });
    await connectAndSettle(c);
    ok(atConnect === 0, 'the connect is answered before the sweep asks anything', atConnect + ' request(s) as it answered');
    ok(askedFor(c, spent.ys).length === 1 && !get(c, 'foxy.txmeta', {})['load-spent'].token,
       'with the route back, the next connect asks (no route was no ask, and no hour’s wait)', askedFor(c, spent.ys).length + ' request(s)');
    ok((await c.W.balanceSats()) === balance, 'and the balance is what it was', balance + ' -> ' + (await c.W.balanceSats()));
  }

  /* ---- 3. once a connect, not again within the hour, again after it -------------------------------------------------- */
  {
    const c = await world();
    const unspent = cloneLoad(c, MINT, 8);
    unspent.ys.slice(1).forEach((y) => { c.said[y] = 'SPENT'; });
    putLoads(c, [['load-unspent', unspent]]);
    await connectAndSettle(c);
    const first = askedFor(c, unspent.ys).length;
    await connectAndSettle(c, 300);
    const second = askedFor(c, unspent.ys).length;
    age(c, 59 * 60 * 1000);
    await connectAndSettle(c, 300);
    const third = askedFor(c, unspent.ys).length;
    age(c, 2 * 60 * 1000);
    await connectAndSettle(c);
    const fourth = askedFor(c, unspent.ys).length;
    ok(first === 1, 'asked once on a connect', first + ' request(s)');
    ok(second === 1 && third === 1, 'not asked again by a connect within the hour', second + ', ' + third);
    ok(fourth === 2, 'asked again by a connect after the hour', fourth + ' request(s)');
    ok(get(c, 'foxy.txmeta', {})['load-unspent'].token === unspent.token, 'and, a piece still unspent, it keeps its token');
  }

  /* ---- 4. an answer that is not one state for each Y asked lets nothing go ------------------------------------------- */
  {
    const c = await world();
    const spent = cloneLoad(c, MINT, 10);
    spent.ys.forEach((y) => { c.said[y] = 'SPENT'; });
    putLoads(c, [['load-spent', spent]]);
    const shapes = {
      short: (s) => s.slice(0, -1),
      long: (s) => s.concat([{ Y: '02' + 'ab'.repeat(32), state: 'SPENT', witness: null }]),
      'another Y': (s) => s.map((x, i) => (i === 0 ? Object.assign({}, x, { Y: '03' + 'cd'.repeat(32) }) : x)),
    };
    for (const [name, shape] of Object.entries(shapes)) {
      c.answer = shape;
      const before = askedFor(c, spent.ys).length;
      await connectAndSettle(c);
      ok(askedFor(c, spent.ys).length === before + 1 && get(c, 'foxy.txmeta', {})['load-spent'].token === spent.token,
         'an answer ' + (name === 'another Y' ? 'naming another Y' : name) + ' is refused whole: the load keeps its token');
      age(c, 2 * HOUR);
    }
    c.answer = null;
    await connectAndSettle(c);
    ok(!get(c, 'foxy.txmeta', {})['load-spent'].token, 'and the same load is let go once the answer is whole');
  }

  /* ---- 5. a load at another mint is not asked about at this one ------------------------------------------------------ */
  {
    const c = await world();
    const away = cloneLoad(c, MINT2, 8), here = cloneLoad(c, MINT, 8);
    away.ys.concat(here.ys).forEach((y) => { c.said[y] = 'SPENT'; });
    putLoads(c, [['load-away', away], ['load-here', here]]);
    await connectAndSettle(c);
    const m = get(c, 'foxy.txmeta', {});
    ok(!askedFor(c, away.ys).length && m['load-away'].token === away.token, 'a load at another mint is not asked about here, and keeps its token');
    ok(askedFor(c, here.ys).length === 1 && !m['load-here'].token, 'while the one at this mint is asked about and let go');
  }

  /* ---- 6. the phone's case: a store at the cap with spent card loads refuses a card's tap; the sweep makes room ------- */
  {
    const c = await world({ full: true });
    const loads = [];
    let chars = 0;
    for (let i = 0; chars < 2.04 * 1024 * 1024; i++) {
      const l = cloneLoad(c, MINT, 40);
      l.ys.forEach((y) => { c.said[y] = 'SPENT'; });
      loads.push(['old-' + i, l]);
      chars += l.token.length;
    }
    // one load of them with a piece unspent, as one at the phone's mint was
    c.said[loads[3][1].ys[5]] = 'UNSPENT';
    putLoads(c, loads);
    // the rest of the store filled with what nothing can trim, to what the phone had in use (3,958,169 bytes)
    const room = 3958169 - bytesOf(c.storage, true) - wk('test.filler');
    c.storage.setItem('test.filler', 'z'.repeat(Math.max(0, room)));
    // and capped as WebKit caps it, from here on
    const proto = c.window.Storage.prototype, set = proto.setItem;
    proto.setItem = function (k, v) {
      const old = this.getItem(String(k));
      const next = bytesOf(this) - (old === null ? 0 : wk(String(k)) + wk(old)) + wk(String(k)) + wk(String(v));
      if (next > CAP) throw new c.window.DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return set.call(this, k, v);
    };
    const inUse = bytesOf(c.storage, true);
    const onCard = c.full.balance();
    c.full.tap();
    const before = await c.W.cardWithdraw(c.full, { pin: '1234' }).then(() => null, (e) => e);
    await wait(30);
    ok(!!before && before.card === 'storage-full' && c.full.balance() === onCard,
       'a store at the cap, ' + loads.length + ' card loads holding ' + Math.round(chars / 1024) + ' KB of it, refuses a card’s tap',
       (before ? before.card || before.message : 'went') + '; ' + inUse + ' bytes in use');
    age(c, 2 * HOUR);
    const askedBefore = c.asked.length;
    await connectAndSettle(c, 10000);
    const all = loads.reduce((n, l) => n + l[1].ys.length, 0);
    const mine = c.asked.slice(askedBefore).filter((a) => askedFor({ asked: [a] }, loads[0][1].ys.concat(...loads.slice(1).map((l) => l[1].ys))).length);
    const m = get(c, 'foxy.txmeta', {});
    const left = loads.filter(([h]) => m[h] && m[h].token).map(([h]) => h);
    ok(mine.length === Math.ceil(all / 400) && mine.every((a) => a.ys.length <= 400) && new Set(mine.map((a) => a.circuit)).size === 1,
       'the sweep asks at most 400 Ys a request, all on its one circuit', mine.length + ' request(s) for ' + all + ' Ys, the largest ' + Math.max(...mine.map((a) => a.ys.length)));
    ok(left.length === 1 && left[0] === loads[3][0], 'every load but the one with a piece unspent keeps only its showing copy', left.length + ' keep their token');
    ok(sweepLines(c).some((l) => new RegExp('card: ' + (loads.length - 1) + ' loads .* let go, \\d+ KB; 1 kept').test(l)), 'and the line says how many, how much, and how many kept', sweepLines(c).slice(-1)[0]);
    const after = bytesOf(c.storage, true);
    c.full.tap();
    const tap = await c.W.cardWithdraw(c.full, { pin: '1234' }).then((r) => r, (e) => e);
    ok(!isErr(tap) && c.full.balance() < onCard, 'and then the card’s tap goes', (isErr(tap) ? tap.card || tap.message : 'went') + '; ' + inUse + ' -> ' + after + ' bytes in use');
  }

  /* ---- 7. a load on file is still let go by the trim, without asking ------------------------------------------------- */
  {
    const c = await world();
    const ys = c.W.tokenInfo(c.sample).proofs.map((p) => yOf(c, p.secret));
    await connectAndSettle(c, 500);
    ok(!askedFor(c, ys).length && get(c, 'foxy.txmeta', {})[c.realLoad].token === c.sample, 'a load whose pieces are on file is not asked about by the sweep');
    c.W._trimStore(false);
    const m = get(c, 'foxy.txmeta', {})[c.realLoad];
    ok(!m.token && m.kept === c.sample && !askedFor(c, ys).length, 'and the trim lets it go as before (`cardLoadOnFile`), asking nothing');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
