'use strict';
/* shop-collect.js — SHOPS: the keeper's Foxy collects a shop's sales and pays its collaborators
 * (build/wallet/08g-shop-collect.js, docs/CASHU-ID.md "Shops").
 *
 *     node tests/shop-collect.js                      # cases 1 to 9 (about seven minutes: 2,000 sales at 50 ms a mint call)
 *     FOXY_SHOP_10K=1 node tests/shop-collect.js      # and the 10,000 (about half an hour of this machine's curve
 *                                                     # arithmetic: the fake mint signs and the page checks every piece)
 *     FOXY_SHOP_ONLY=3,8  FOXY_SHOP_N=200  FOXY_SHOP_MS=0   # some cases, fewer sales, no latency
 *
 * A fake shop engine answers the three calls (challenge, collect in pages of 200, collected) and checks the keeper's
 * signature as the engine does: BIP-340 by the shop's Cashu ID over SHA-256("foxy-shop-collect-v1" ‖ nonce ‖ host). Its
 * orders are invoices at harness.js's fake mint locked (NUT-20) to P′ = ID + r·G, or ecash locked (NUT-11) to P′. The
 * phone's seed side is harness.js's model of CashuID.swift (`cashuIdShop`), held here to the fixture FoxyTests holds
 * libsecp256k1 to (tests/fixtures/shop-collect-vectors.json).
 *
 *   1  the shop link: its forms and its refusals
 *   2  the arithmetic: P′, NUT-20's two messages, the collect digest, against the fixture and cashu-ts
 *   3  a collection: quotes and ecash, one RECEIVED row whose detail lists every order and sums to its total, one SENT
 *      row and one payment per collaborator, the collected call carrying every order once with its fields
 *   4  refusals: a lie about PAID, an invoice locked to another key, splits over the amount, a split that is not a Foxy
 *      ID, a mint this phone has not chosen; a host taken off SHOPS is not asked
 *   5  a repeat collection mints nothing twice; an order whose collected call failed is only said again
 *   6  an answer lost on the way back is restored from the outputs reserved; an order another phone minted is said
 *      collected earlier and never minted
 *   7  two shops
 *   8  1,000 sales at a mint answering in 50 ms: mint calls, one payout per collaborator, the books, the store's growth
 *   9  a cut at page 3 and a resume: nothing minted twice, every order confirmed once
 *  11  on chain: an order paid to a NUT-04 onchain quote, locked to P′ and not, collected as an invoice is; one the mint has
 *      issued before is said collected earlier; one not yet confirmed waits
 *  12–20  fix round 1, the review's attacks: H1 a share paid twice (12); H2 one invoice named by two orders (13), an order
 *      another phone minted after this one's call was lost (14); M2 one ecash in two orders, a piece listed twice (15), an
 *      ecash order refused at the receive stalling nothing (16); M1 someone else's issued invoice (17); L1 put away stops it
 *      (18); L2 a payout not made twice after a kill (19); L3 the signature binds the path (20)
 *  10  10,000 sales: a pile of under 40 pieces, the store under 300 KB more, every order confirmed once */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS, cashuIdKeys, shopCollectDigest, shopQuoteDigests, shopMovedKey, shopMovedPub, schnorrSign } = H;

const MINT = 'https://m.test';
const OTHER = 'https://other.test';
const ANA_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const BEN_WORDS = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const PAYER_WORDS = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const BIG = process.env.FOXY_SHOP_10K === '1';
// FOXY_SHOP_ONLY=3,8: only those cases
const want = (n) => !process.env.FOXY_SHOP_ONLY || process.env.FOXY_SHOP_ONLY.split(',').indexOf(String(n)) >= 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};

/* ---- the fake shop engine ---- */
function fakeShop(host, opts) {
  const o = opts || {};
  const shop = { host, path: o.path || '', url: 'https://' + host + (o.path || ''), orders: [], byOrder: new Map(), nonces: new Set(), confirmed: [], calls: { challenge: 0, collect: 0, collected: 0 },
                 collectFails: 0, collectedFails: 0, refusedSig: 0, CT: null, id: '' };
  shop.handle = (m) => {
    const u = new URL(m.url);
    const p = u.pathname.slice(shop.path.length);
    const body = m.body ? JSON.parse(m.body) : {};
    if (p === '/api/shop/collect/challenge') {
      shop.calls.challenge += 1;
      const n = crypto.randomBytes(32).toString('hex');
      shop.nonces.add(n);
      return '200\n' + JSON.stringify({ nonce: n, at: Date.now() });
    }
    const fresh = shop.nonces.has(body.nonce);
    shop.nonces.delete(body.nonce);
    const good = fresh && body.pub === shop.id
      && shop.CT.schnorrVerifyDigest(String(body.sig), shopCollectDigest(body.nonce, host, shop.path + p).toString('hex'), body.pub) === true;
    if (!good) { shop.refusedSig += 1; return '401\n{"error":"not the keeper"}'; }
    if (p === '/api/shop/collect') {
      shop.calls.collect += 1;
      if (shop.collectFails > 0) { shop.collectFails -= 1; return '503\n{"error":"busy"}'; }
      const left = shop.orders.filter((x) => !x.collected && (!body.after || x.order > body.after)).slice(0, 200);
      return '200\n' + JSON.stringify({ items: left.map((x) => x.item), total: shop.orders.filter((x) => !x.collected).length });
    }
    if (p === '/api/shop/collected') {
      shop.calls.collected += 1;
      if (shop.collectedFails > 0) { shop.collectedFails -= 1; return '500\n{"error":"down"}'; }
      for (const r of body.orders || []) {
        shop.confirmed.push(r);
        const x = shop.byOrder.get(r.order);
        if (x) x.collected = r;
      }
      return '200\n{"ok":true}';
    }
    return '404\n{}';
  };
  return shop;
}

function idString(W, k) { return W._cashuIdEncode(k.id, k.nostr, k.sig); }

/* A keeper's page, its mint and the shops, with the mint's calls counted and slowed as asked. */
function page(words, world) {
  const phone = nativePhone({ words });
  const reply = (w, id, t, e, ms) => setTimeout(() => w.FoxyWallet._scanResult(id, t, e), ms || 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const url = String(m.url || '');
        const shop = world.shops.find((s) => url.indexOf(s.url + '/') === 0);
        if (shop) return reply(w, m.id, shop.handle(m));
        const p = new URL(url).pathname;
        if (p === '/v1/mint/bolt11' || p === '/v1/mint/onchain') {
          world.mintCalls += 1;
          if (world.bodies.length < 5) world.bodies.push(JSON.parse(m.body || '{}'));
          if (world.mintDown || world.mintPostDown) return reply(w, m.id, null, 'did not answer', 5);
        }
        if (world.mintDown && /\/v1\/(mint\/quote|checkstate|swap)/.test(p)) return reply(w, m.id, null, 'did not answer', 5);
        if (p === '/v1/swap') world.swaps += 1;
        // the mint refuses a swap that takes ecash locked to a key in, when a case asks
        if (p === '/v1/swap' && world.swapRefuseLocked && /P2PK/.test(String(m.body || ''))) return reply(w, m.id, '400\n{"detail":"the mint will not take that","code":11000}');
        const at = url.indexOf('other.test') >= 0 ? world.other : world.mint;
        const out = at.handle(m);
        if ((p === '/v1/mint/bolt11' || p === '/v1/mint/onchain') && /^200/.test(out)) world.minted += 1;
        return reply(w, m.id, out, null, world.mintMs);
      }
      if (m.action === 'nostrSend') { world.relay.push({ target: m.target, body: m.body }); return reply(w, m.id, '3'); }
      if (m.action === 'cashuIdInboxOpen' || m.action === 'cashuIdCopiesOpen') return reply(w, m.id, '1');
      if (m.action === 'cashuIdInboxClose') return reply(w, m.id, 'ok');
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!world.mint) world.mint = fakeMint(w, { p2pk: true, nut20: true, quotesUnpaid: true, amendedNut20: true, order: 40, onchain: true, onchainNut20: true });
      if (!world.other) world.other = fakeMint(w, { p2pk: true, nut20: true, fill: 9, quoteFrom: 900000 });
    },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._cashuIdRetryMs = 40;
  ctx.W._cashuIdAheadMs = 3600000;
  ctx.W._shopEveryMs = 3600000;
  ctx.phone = phone;
  // what the page logged about shops, for the cases that look for a refusal's line
  ctx.logs = [];
  const log0 = ctx.window.console.log.bind(ctx.window.console);
  ctx.window.console.log = (...a) => { const t = a.map(String).join(' '); if (/shops:/.test(t)) ctx.logs.push(t); return log0(...a); };
  ctx.store = (k, d) => { try { const v = JSON.parse(ctx.storage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  return ctx;
}

function world() { return { shops: [], mint: null, other: null, mintCalls: 0, minted: 0, swaps: 0, mintMs: 0, mintDown: false, relay: [], bodies: [] }; }

/* An order: an invoice at the fake mint locked to P′ (paid unless `unpaid`), or ecash locked to P′ from `payer`. */
let orderN = 0;
function addQuote(W, shop, mint, o) {
  const CT = shop.CT;
  const r = crypto.randomBytes(32).toString('hex');
  const P = CT.pointFromHex(shop.id);
  const pub = o.pub || P.add(P.constructor.BASE.multiply(BigInt('0x' + r))).toHex(true);
  const ans = mint.handle({ url: (o.mintUrl || MINT) + '/v1/mint/quote/bolt11', method: 'POST', body: JSON.stringify({ amount: o.amount, unit: 'sat', pubkey: pub }) });
  const q = JSON.parse(ans.slice(ans.indexOf('\n') + 1));
  if (!o.unpaid) mint.payQuote(q.quote);
  const order = o.order || ('o' + String(++orderN).padStart(6, '0'));
  const item = { order, kind: 'quote', quote: q.quote, r, amount: o.amount, unit: 'sat', mint: o.mintUrl || MINT,
                 splits: o.splits || [], memo: o.memo || ('Order ' + order), paidAt: Date.now() };
  const x = { order, item, collected: null };
  shop.orders.push(x);
  shop.byOrder.set(order, x);
  return x;
}

const logRows = (ctx) => ctx.store('foxy.cashu.log', []) || [];
const balance = async (ctx) => Number(await ctx.W.balanceSats()) || 0;
const pileCount = (ctx) => { let n = 0; for (let i = 0; i < ctx.storage.length; i++) { const k = ctx.storage.key(i); if (k.indexOf('foxy.cashu.proofs') === 0) n += (ctx.store(k, []) || []).length; } return n; };
const storeBytes = (ctx) => { let n = 0; for (let i = 0; i < ctx.storage.length; i++) { const k = ctx.storage.key(i); n += k.length + String(ctx.storage.getItem(k)).length; } return n; };
const ordersOf = (d) => String((d && d.list) || '').split(';').filter(Boolean).map((x) => { const f = x.split(','); return [f[0], Number(f[1]), f[2] ? f[2].split('.').map(Number) : []]; });
const pileBytes = (ctx) => { let n = 0; for (let i = 0; i < ctx.storage.length; i++) { const k = ctx.storage.key(i); if (k.indexOf('foxy.cashu.proofs') === 0) n += String(ctx.storage.getItem(k)).length; } return n; };

const outboxPaid = (A) => (A.store('foxy.cid.outbox', []) || []).reduce((n, x) => n + x.amount, 0);
const pushItem = (shop, item) => { const x = { order: item.order, item, collected: null }; shop.orders.push(x); shop.byOrder.set(item.order, x); return x; };
async function payerPage(w) {
  const B = page(PAYER_WORDS, w);
  await B.W.connect(MINT, { remember: true });
  const inv = await B.W.invoice(20000, '');
  w.mint.payQuote(inv.quote || inv.hash);
  await B.W.claim(inv.hash);
  return B;
}
const lockedTo = (B, pub, amount) => B.W.sendToken(amount, { lockTo: pub }).then((made) => JSON.parse(JSON.stringify(B.W.tokenInfo(made.token).proofs,
  (k2, v) => (typeof v === 'bigint' ? Number(v) : v && typeof v.toNumber === 'function' ? v.toNumber() : v))));

async function setUp(w, shops) {
  const A = page(PHONE_WORDS, w);
  await A.W.connect(MINT, { remember: true });
  const mine = await A.W.cashuIdMine();
  const seedOf = (words) => Buffer.from(A.window.FoxyBip39.mnemonicToSeedSync(words));
  const ana = cashuIdKeys(seedOf(ANA_WORDS)), ben = cashuIdKeys(seedOf(BEN_WORDS));
  const anaText = idString(A.W, ana), benText = idString(A.W, ben);
  await A.W.cashuIdAdd(anaText, 'Ana');
  for (const s of shops) { s.id = mine.id; s.CT = A.window.CashuTS; w.shops.push(s); }
  return { A, mine, ana, ben, anaText, benText };
}

async function run() {
  /* ---- 1 the shop link ---- */
  if (want(1)) {
    const w = world();
    const A = page(PHONE_WORDS, w);
    const W = A.W;
    const r = W.shopRead('foxyshop:https://Shop.Example.com/store?name=Fox%20Prints');
    ok(r.url === 'https://shop.example.com/store' && r.host === 'shop.example.com' && r.name === 'Fox Prints' && !r.onion,
      '1 a link: foxyshop: and the https address, its path kept, its name from `name`', JSON.stringify(r));
    const on = W.shopRead('http://' + 'a'.repeat(56) + '.onion?name=Dark');
    ok(on.onion && on.url === 'http://' + 'a'.repeat(56) + '.onion' && on.name === 'Dark', '1 an .onion over http, the prefix left off', JSON.stringify(on));
    ok(W.shopRead('https://shop.example.com').name === 'shop.example.com', '1 no name: the host');
    ok(!!W.shopRead('http://shop.example.com').why && !!W.shopRead('https://127.0.0.1').why && !!W.shopRead('https://u:p@x.example.com').why
      && !!W.shopRead('https://x.example.com/#a').why && !!W.shopRead('ftp://x.example.com').why && !!W.shopRead('nonsense').why,
      '1 refused: plain http to a name, an IP, a login, a fragment, another scheme, words');
    W.shopAdd('foxyshop:https://shop.test?name=Fox%20Prints');
    W.shopAdd('https://shop.test?name=Renamed');
    ok(W.shops().length === 1 && W.shops()[0].name === 'Renamed', '1 a shop added twice is one shop, its name the newer');
    ok(W.shopRemove('shop.test') === true && W.shops().length === 0 && W.shopRemove('shop.test') === false, '1 REMOVE');
  }

  /* ---- 2 the arithmetic, held to the fixture ---- */
  if (want(2)) {
    const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'shop-collect-vectors.json'), 'utf8'));
    const w = world();
    const A = page(PHONE_WORDS, w);
    const CT = A.window.CashuTS;
    const k = cashuIdKeys(Buffer.from(A.window.FoxyBip39.mnemonicToSeedSync(V.words)));
    ok(k.id === V.id, '2 the fixture’s ID is the phone words’');
    ok(shopMovedPub(V.id, V.r) === V.moved && shopMovedKey(k.d, V.r).toString(16).padStart(64, '0') === V.movedKey, '2 P′ = ID + r·G and its key d + r');
    const P = CT.pointFromHex(V.id);
    ok(P.add(P.constructor.BASE.multiply(BigInt('0x' + V.r))).toHex(true) === V.moved, '2 and cashu-ts’s curve agrees on P′');
    ok(V.paths.length === 4 && V.paths.every((x) => shopCollectDigest(V.nonce, V.host, x.path).toString('hex') === x.digest) && shopCollectDigest(V.nonce, V.host, '/api/shop/collect').toString('hex') === V.collectDigest,
      '2 the collect digest, over the request\'s full path: both calls, a link with a path and one without');
    const dg = shopQuoteDigests(V.quote, V.outputs);
    ok(dg.amended.toString('hex') === V.amendedDigest && dg.legacy.toString('hex') === V.legacyDigest, '2 NUT-20’s amended and legacy messages');
    const key = shopMovedKey(k.d, V.r);
    const sig = schnorrSign(key, dg.amended), leg = schnorrSign(key, dg.legacy);
    ok(CT.verifyMintQuoteSignature(V.moved, V.quote, V.outputs, leg) === true, '2 cashu-ts verifies the legacy signature by d + r over the quote');
    ok(CT.schnorrVerifyDigest(sig, V.amendedDigest, V.moved) === true, '2 and the amended one');
    // the model's own answers: the right key signs, a quote locked elsewhere is refused, r = 0 is refused
    const ask = (m) => A.phone.answer(A.window, Object.assign({ action: 'cashuIdShop' }, m));
    const q = ask({ kind: 'quote', r: V.r, quote: V.quote, pubkey: V.moved, outputs: V.outputs });
    ok(!q[1] && CT.verifyMintQuoteSignature(V.moved, V.quote, V.outputs, JSON.parse(q[0]).legacy) === true, '2 cashuIdShop quote: signed by d + r');
    ok(ask({ kind: 'quote', r: V.r, quote: V.quote, pubkey: V.id, outputs: V.outputs })[1] === 'That ecash is not locked to this Cashu ID.', '2 a quote locked to the ID itself: refused');
    ok(!!ask({ kind: 'quote', r: '00'.repeat(32), quote: V.quote, pubkey: V.moved, outputs: V.outputs })[1], '2 r = 0: refused');
    const c = ask({ kind: 'collect', nonce: V.nonce, host: V.host, path: '/api/shop/collect' });
    ok(!c[1] && JSON.parse(c[0]).pub === V.id && CT.schnorrVerifyDigest(JSON.parse(c[0]).sig, V.collectDigest, V.id) === true, '2 cashuIdShop collect: the ID key over the digest');
    ok(ask({ kind: 'collect', nonce: V.nonce, host: 'Bad Host' })[1] === 'bad request' && ask({ kind: 'sign' })[1] === 'bad request', '2 a host that is not one, an unknown kind: bad request');
    const secret = JSON.stringify(['P2PK', { nonce: '11'.repeat(16), data: V.moved, tags: [] }]);
    const sp = ask({ kind: 'proofs', r: V.r, secrets: [secret] });
    ok(!sp[1] && CT.schnorrVerifyDigest(JSON.parse(sp[0]).sigs[0], crypto.createHash('sha256').update(secret).digest('hex'), V.moved) === true, '2 cashuIdShop proofs: NUT-11 by d + r');
    const all = JSON.stringify(['P2PK', { nonce: '11'.repeat(16), data: V.moved, tags: [['sigflag', 'SIG_ALL']] }]);
    ok(ask({ kind: 'proofs', r: V.r, secrets: [all] })[1] === 'bad request', '2 never SIG_ALL');
    const reply = String(q[0]) + String(c[0]) + String(sp[0]);
    ok(reply.indexOf(V.movedKey) < 0 && reply.indexOf(k.d.toString(16).padStart(64, '0')) < 0, '2 no key in any answer');
  }

  /* ---- 3 a collection ---- */
  if (want(3)) {
    const w = world();
    const shop = fakeShop('shop.test');
    const { A, mine, anaText, benText, ana, ben } = await setUp(w, [shop]);
    const B = page(PAYER_WORDS, w);
    await B.W.connect(MINT, { remember: true });
    const inv = await B.W.invoice(5000, '');
    w.mint.payQuote(inv.quote || inv.hash);
    await B.W.claim(inv.hash);
    // cashu-ts's own amended NUT-20 signature over a claim checks out against the phone's message (CashuID.quoteDigests)
    const b0 = w.bodies.find((b) => typeof b.signature === 'string');
    const qa = b0 && JSON.parse(w.mint.handle({ url: MINT + '/v1/mint/quote/bolt11/' + b0.quote, method: 'GET' }).split('\n').slice(1).join('\n'));
    ok(!!b0 && !!qa.pubkey && B.window.CashuTS.schnorrVerifyDigest(b0.signature, shopQuoteDigests(b0.quote, b0.outputs).amended.toString('hex'), qa.pubkey) === true,
      '2 cashu-ts’s amended NUT-20 message is the one the phone signs', b0 && b0.signature);
    const splits = [{ id: anaText, amount: 300, memo: 'your share' }, { id: benText, amount: 200, memo: '' }];
    for (let i = 0; i < 5; i++) addQuote(A.W, shop, w.mint, { amount: 1000 + i, splits });
    // ecash locked to P′ for one order, as Pay with Cashu posts it
    const CT = A.window.CashuTS;
    const r = crypto.randomBytes(32).toString('hex');
    const Pp = CT.pointFromHex(mine.id);
    const pub = Pp.add(Pp.constructor.BASE.multiply(BigInt('0x' + r))).toHex(true);
    const made = await B.W.sendToken(800, { lockTo: pub });
    const pr = JSON.parse(JSON.stringify(B.W.tokenInfo(made.token).proofs, (k2, v) => (typeof v === 'bigint' ? Number(v) : v && typeof v.toNumber === 'function' ? v.toNumber() : v)));
    const order = 'o' + String(++orderN).padStart(6, '0');
    const px = { order, item: { order, kind: 'proofs', proofs: pr, r, amount: 800, unit: 'sat', mint: MINT, splits: [{ id: anaText, amount: 100 }], memo: 'Order ' + order }, collected: null };
    shop.orders.push(px); shop.byOrder.set(order, px);
    const said = [];
    A.W._onShopCollect = (ev) => said.push(ev);
    const before = await balance(A);
    A.W.shopAdd('foxyshop:https://shop.test?name=Fox%20Prints');
    const n = await A.W.shopCollectNow();
    ok(n === 6, '3 six sales collected', String(n));
    ok(shop.refusedSig === 0 && shop.calls.collect >= 1, '3 the shop took the keeper’s signature over its nonce and host');
    const total = 1000 + 1001 + 1002 + 1003 + 1004 + 800;
    const owedAna = 5 * 300 + 100, owedBen = 5 * 200;
    const after = await balance(A);
    ok(after === before + total - owedAna - owedBen, '3 the keeper keeps the sales less the two shares', before + ' → ' + after);
    const rows = logRows(A);
    const recv = rows.filter((e) => e.dir === 'in' && e.shop);
    ok(recv.length === 1 && recv[0].memo === '6 sales from Fox Prints' && recv[0].sats === total, '3 ONE received row: "6 sales from Fox Prints", the whole amount', JSON.stringify(recv.map((e) => [e.memo, e.sats])));
    const d = recv[0] && recv[0].shop;
    const dOrders = ordersOf(d);
    ok(!!d && d.n === 6 && d.total === total && dOrders.length === 6 && dOrders.reduce((s, x) => s + x[1], 0) === d.total
      && d.name === 'Fox Prints' && d.host === 'shop.test' && d.at > 0, '3 its detail: the shop, the time, the count, the total, every order with its amount', d && d.list.slice(0, 60));
    ok(!!d && d.ids.length === 2 && d.ids[0][1] === 'Ana' && /^Cashu ID /.test(d.ids[1][1]) && dOrders.every((x) => x[2].indexOf(0) >= 0),
      '3 and which collaborators each order paid, by name where they are a contact', JSON.stringify(d && d.ids));
    ok(rows.filter((e) => e.dir === 'in').length === 1, '3 no other received row (the swap that took the ecash in is folded into it)');
    const sent = rows.filter((e) => e.dir === 'out');
    ok(sent.length === 2 && sent.some((e) => /^To Ana · Fox Prints$/.test(e.memo) && e.sats === owedAna) && sent.some((e) => /^To Cashu ID .* · Fox Prints$/.test(e.memo) && e.sats === owedBen),
      '3 one sent row a collaborator, their whole share', JSON.stringify(sent.map((e) => [e.memo, e.sats])));
    const outbox = A.store('foxy.cid.outbox', []);
    ok(outbox.length === 2 && outbox.some((x) => x.contact === ana.id && x.amount === owedAna && /Fox Prints · your share of 6 sales/.test(x.note))
      && outbox.some((x) => x.contact === ben.id && x.amount === owedBen && /your share of 5 sales/.test(x.note)),
      '3 one locked payment a collaborator, its note naming the shop and the count, no order', JSON.stringify(outbox.map((x) => [x.amount, x.note])));
    ok(outbox.every((x) => !/o0000/.test(String(x.note))), '3 no order number in a collaborator’s note');
    const conf = shop.confirmed;
    ok(conf.length === 6 && new Set(conf.map((c) => c.order)).size === 6 && conf.every((c) => c.amount > 0 && c.unit === 'sat' && c.mintedAt > 0
      && (c.quoteOrProofs === 'quote' || c.quoteOrProofs === 'proofs') && !c.earlier), '3 the collected call: every order once, with amount, unit, mintedAt, quoteOrProofs', JSON.stringify(conf[0]));
    ok(conf.filter((c) => c.quoteOrProofs === 'proofs').length === 1, '3 the ecash order said as proofs');
    const s0 = A.W.shops()[0];
    ok(s0.lastAt > 0 && s0.lastN === 6 && s0.paid.length === 2 && s0.paid.some((p) => p.name === 'Ana'), '3 the shop’s last collection and the collaborators it paid', JSON.stringify(s0.paid));
    ok(said.some((e) => e.state === 'collecting') && said.some((e) => e.state === 'collected' && e.n === 6 && e.shop === 'Fox Prints'), '3 COLLECTING, then "6 sales collected"', JSON.stringify(said.slice(-2)));
    ok(!A.store('foxy.shop.runs', {})['shop.test'], '3 nothing of the collection left in flight');

    /* ---- 5 again: nothing twice ---- */
    const calls = w.mintCalls;
    const said2 = [];
    A.W._onShopCollect = (ev) => said2.push(ev);
    const n2 = await A.W.shopCollectNow();
    ok(n2 === 0 && w.mintCalls === calls && logRows(A).length === rows.length, '5 a second collection: nothing waited, nothing minted, no row');
    ok(said2.every((e) => e.state !== 'collected'), '5 and nothing said but idle');

    // an order whose collected call failed: collected once, only said again
    addQuote(A.W, shop, w.mint, { amount: 700, splits: [{ id: anaText, amount: 70 }] });
    shop.collectedFails = 1;
    const n3 = await A.W.shopCollectNow();
    const minted3 = w.minted;
    ok(n3 === 1 && shop.confirmed.length === 6, '5 a sale collected whose collected call failed', String(n3));
    const runs = A.store('foxy.shop.runs', {});
    ok(!!runs['shop.test'] && Object.keys(runs['shop.test'].pend).length === 1, '5 its order is kept as taken, to be said again');
    const n4 = await A.W.shopCollectNow();
    ok(w.minted === minted3 && shop.confirmed.length === 7 && n4 === 0, '5 the next collection mints nothing and says it collected', String(w.minted - minted3));
    ok(!A.store('foxy.shop.runs', {})['shop.test'], '5 then nothing is left in flight');

    /* ---- 4 refusals ---- */
    const liar = addQuote(A.W, shop, w.mint, { amount: 999, unpaid: true });
    const stale = addQuote(A.W, shop, w.mint, { amount: 500, pub: mine.id });
    const greedy = addQuote(A.W, shop, w.mint, { amount: 400, splits: [{ id: anaText, amount: 300 }, { id: benText, amount: 200 }] });
    const badId = addQuote(A.W, shop, w.mint, { amount: 400, splits: [{ id: 'foxyid1nonsense', amount: 10 }] });
    const away = addQuote(A.W, shop, w.other, { amount: 400, mintUrl: OTHER });
    const good = addQuote(A.W, shop, w.mint, { amount: 600 });
    const bal5 = await balance(A);
    const out5 = A.store('foxy.cid.outbox', []).length;
    const n5 = await A.W.shopCollectNow();
    ok(n5 === 1 && !!good.collected && (await balance(A)) === bal5 + 600, '4 among five that are refused, the good one is collected', String(n5));
    ok(!liar.collected && !stale.collected && !greedy.collected && !badId.collected && !away.collected, '4 a lie about PAID, an invoice locked elsewhere, splits over the amount, a bad Cashu ID, a mint not chosen: none collected');
    ok(A.store('foxy.cid.outbox', []).length === out5, '4 and no collaborator paid for any of them');

    /* the host taken off SHOPS is never asked again */
    A.W.shopRemove('shop.test');
    const asked = shop.calls.challenge;
    await A.W.shopCollectNow();
    ok(shop.calls.challenge === asked, '4 a shop taken off SHOPS is not asked');
  }

  /* ---- 6 a lost answer, and an order minted by another phone ---- */
  if (want(6)) {
    const w = world();
    const shop = fakeShop('shop.test');
    const { A, anaText } = await setUp(w, [shop]);
    A.W.shopAdd('https://shop.test?name=Lost');
    addQuote(A.W, shop, w.mint, { amount: 1500, splits: [{ id: anaText, amount: 150 }] });
    w.mint.dropAnswerOf('mint');
    await A.W.shopCollectNow();
    // the lane gave up on the lost answer; its order waits as minting with its outputs on record
    const runs = A.store('foxy.shop.runs', {})['shop.test'];
    const p0 = runs && Object.values(runs.pend)[0];
    ok(!!p0 && (p0.s === 'm' && p0.o.length > 0 || p0.s === 't'), '6 an answer lost on the way back: the order kept with the outputs it reserved', JSON.stringify(p0));
    const before = await balance(A);
    const mintedBefore = w.minted;
    await A.W.shopCollectNow();
    ok(w.minted === mintedBefore && shop.confirmed.length === 1 && !shop.confirmed[0].earlier, '6 the next collection restores it, mints nothing more, and says it collected');
    ok((await balance(A)) - before === (p0 && p0.s === 't' ? 0 : 1500 - 150), '6 the keeper holds it, less the share', String((await balance(A)) - before));
    // another phone with the same words minted an order and its collected call was lost: this one says it was collected earlier
    const A2 = page(PHONE_WORDS, w);
    await A2.W.connect(MINT, { remember: true });
    const x = addQuote(A.W, shop, w.mint, { amount: 900 });
    A2.W.shopAdd('https://shop.test?name=Lost');
    shop.collectedFails = 1;
    await A2.W.shopCollectNow();
    const m1 = w.minted;
    await A.W.shopCollectNow();
    ok(w.minted === m1 && !!x.collected && x.collected.earlier === true, '6 an invoice the mint calls ISSUED and this phone never minted: said collected earlier, never minted', JSON.stringify(x.collected));
  }

  /* ---- 7 two shops ---- */
  if (want(7)) {
    const w = world();
    const s1 = fakeShop('one.test'), s2 = fakeShop('two.test');
    const { A, anaText } = await setUp(w, [s1, s2]);
    A.W.shopAdd('https://one.test?name=One');
    A.W.shopAdd('https://two.test?name=Two');
    addQuote(A.W, s1, w.mint, { amount: 1000, splits: [{ id: anaText, amount: 100 }] });
    addQuote(A.W, s2, w.mint, { amount: 2000, splits: [{ id: anaText, amount: 200 }] });
    const n = await A.W.shopCollectNow();
    const recv = logRows(A).filter((e) => e.shop);
    ok(n === 2 && recv.length === 2 && recv.some((e) => e.memo === '1 sale from One') && recv.some((e) => e.memo === '1 sale from Two'), '7 two shops: a row each', JSON.stringify(recv.map((e) => e.memo)));
    ok(A.store('foxy.cid.outbox', []).length === 2, '7 and a payment to the collaborator for each shop’s collection');
  }

  /* ---- 8 1,000 sales at 50 ms a call; 9 a cut at page 3 ---- */
  for (const cut of [false, true].filter((c) => want(c ? 9 : 8))) {
    const w = world();
    w.mintMs = Number(process.env.FOXY_SHOP_MS || 50);
    const shop = fakeShop('shop.test');
    const { A, anaText, benText } = await setUp(w, [shop]);
    const N = Number(process.env.FOXY_SHOP_N || 1000);
    for (let i = 0; i < N; i++) addQuote(A.W, shop, w.mint, { amount: 2100, splits: [{ id: anaText, amount: 200 }, { id: benText, amount: 100 }] });
    A.W.shopAdd('https://shop.test?name=Big');
    let atPaying = -1;
    A.W._onShopCollect = (ev) => { if (ev.state === 'paying' && atPaying < 0) atPaying = pileCount(A); };
    const bytes0 = storeBytes(A) - pileBytes(A);
    const began = Date.now();
    if (cut) {
      // the mint stops answering partway through page 3, and is back for the next collection
      const watch = setInterval(() => { if (w.minted >= Math.floor(N * 0.45) && !w.mintDown) w.mintDown = true; }, 5);
      await A.W.shopCollectNow();
      clearInterval(watch);
      const first = w.minted;
      ok(first >= Math.floor(N * 0.4) && first < N, '9 the first collection stopped partway, in its third page', String(first));
      const dbg = (at) => { if (process.env.FOXY_SHOP_DEBUG) console.log('      ' + at + ': held ' + Object.keys(A.store('foxy.cashu.held', {})).join(' ') + '; swaps ' + (A.store('foxy.cashu.swaps', []) || []).map((x) => x.id).join(' ') + '; run ' + JSON.stringify(Object.values(A.store('foxy.shop.runs', {})).map((r) => Object.values(r.gs).map((g) => (g.keep || []).length)))); };
      dbg('after the cut');
      w.mintDown = false;
      await A.W.shopCollectNow();
      dbg('after the second');
      await A.W.shopCollectNow();
      dbg('after the third');
    } else {
      await A.W.shopCollectNow();
    }
    const ms = Date.now() - began;
    const tag = cut ? '9' : '8';
    ok(w.minted === N, tag + ' every invoice minted exactly once', String(w.minted));
    const once = new Map();
    shop.confirmed.forEach((c) => once.set(c.order, (once.get(c.order) || 0) + 1));
    ok(once.size === N && [...once.values()].every((v) => v === 1), tag + ' every order said collected once', once.size + ' orders, ' + shop.confirmed.length + ' said');
    const sent = logRows(A).filter((e) => e.dir === 'out');
    if (!cut) {
      ok(w.mintCalls === N, '8 one mint call a sale', String(w.mintCalls));
      ok(sent.length === 2 && sent.some((e) => e.sats === N * 200) && sent.some((e) => e.sats === N * 100), '8 exactly one payout a collaborator, their whole share', JSON.stringify(sent.map((e) => e.sats)));
    } else {
      const toAna = sent.filter((e) => /Ana/.test(e.memo)).reduce((s, e) => s + e.sats, 0);
      ok(toAna === N * 200 && sent.length <= 4, '9 the collaborator paid their whole share across the two collections', toAna + ' in ' + sent.length);
    }
    const recv = logRows(A).filter((e) => e.shop);
    const all = recv.reduce((s, e) => s + ordersOf(e.shop).length, 0);
    const sum = recv.reduce((s, e) => s + ordersOf(e.shop).reduce((t, x) => t + x[1], 0), 0);
    ok(all === N && sum === N * 2100 && recv.every((e) => e.shop.total === ordersOf(e.shop).reduce((t, x) => t + x[1], 0) && e.sats === e.shop.total),
      tag + ' the rows’ detail lists every order and sums to the total', all + ' orders, ' + sum);
    ok((await balance(A)) === N * (2100 - 300), tag + ' the keeper holds the sales less the shares');
    const grown = storeBytes(A) - pileBytes(A) - bytes0;
    if (process.env.FOXY_SHOP_DEBUG) {
      const sizes = [];
      for (let i = 0; i < A.storage.length; i++) { const k = A.storage.key(i); sizes.push([k, String(A.storage.getItem(k)).length]); }
      console.log('      keys: ' + sizes.sort((a, b) => b[1] - a[1]).slice(0, 10).map((x) => x[0] + ' ' + x[1]).join(', '));
      const am = {}; for (let i = 0; i < A.storage.length; i++) { const k = A.storage.key(i); if (k.indexOf('foxy.cashu.proofs') === 0) (A.store(k, []) || []).forEach((pr) => { am[pr.amount] = (am[pr.amount] || 0) + 1; }); }
      console.log('      pile: ' + JSON.stringify(am));
    }
    console.log('      ' + tag + ': ' + N + ' sales in ' + ms + ' ms; ' + w.mintCalls + ' mint calls; ' + w.swaps + ' swaps; the store grew ' + grown + ' bytes beside the pile; ' + atPaying + ' pieces before the payouts, ' + pileCount(A) + ' after (' + pileBytes(A) + ' bytes)');
    ok(grown < 100 * 1024, tag + ' the store grew under 100 KB beside the pile (the order list about 15 bytes a sale)', String(grown));
    ok(atPaying >= 0 && atPaying < 40, tag + ' what the collection minted is under 40 pieces once each page is swapped', String(atPaying));
    // the payouts' change is shaped into the wallet's change pool (12 of each piece to 128, 8 of each to 65,536): bounded, whatever the count
    ok(pileCount(A) <= 168 + 40, tag + ' and the pile after the payouts is the change pool’s and that, whatever the count', String(pileCount(A)));
    ok(!A.store('foxy.shop.runs', {})['shop.test'], tag + ' nothing left in flight');
  }


  /* ---- 11 on chain ---- */
  if (want(11)) {
    const w = world();
    const shop = fakeShop('shop.test');
    const { A, mine, anaText } = await setUp(w, [shop]);
    const CT = A.window.CashuTS;
    const chainOrder = (amount, locked, confirm) => {
      const r = crypto.randomBytes(32).toString('hex');
      const P = CT.pointFromHex(mine.id);
      const pub = P.add(P.constructor.BASE.multiply(BigInt('0x' + r))).toHex(true);
      const ans = w.mint.handle({ url: MINT + '/v1/mint/quote/onchain', method: 'POST', body: JSON.stringify(locked ? { unit: 'sat', pubkey: pub } : { unit: 'sat' }) });
      const q = JSON.parse(ans.slice(ans.indexOf('\n') + 1));
      if (confirm) w.mint.onchainCredit(q.quote, amount);
      const order = 'o' + String(++orderN).padStart(6, '0');
      const x = { order, item: { order, kind: 'onchain', quote: q.quote, r, amount, unit: 'sat', mint: MINT, splits: [{ id: anaText, amount: 1000 }], memo: 'Order ' + order }, collected: null };
      shop.orders.push(x); shop.byOrder.set(order, x);
      return x;
    };
    const locked = chainOrder(30000, true, true);
    const open = chainOrder(25000, false, true);
    const waiting = chainOrder(40000, true, false);
    A.W.shopAdd('https://shop.test?name=Chain');
    const before = await balance(A);
    const n = await A.W.shopCollectNow();
    ok(n === 1 && !!locked.collected && !open.collected && !waiting.collected, '11 on chain: the locked address collected, the unconfirmed one waits', String(n));
    ok(!open.collected && A.logs.some((l) => /order .* was not collected: .*no lock/.test(l)), '11 an address with no lock is refused, with a log line (the keeper’s rule: D1)', A.logs.filter((l) => /shops/.test(l)).slice(-3).join(' | '));
    ok(locked.collected && locked.collected.quoteOrProofs === 'onchain', '11 said collected as onchain', JSON.stringify(locked.collected));
    ok((await balance(A)) - before === 30000 - 1000, '11 the keeper holds it, less the share', String((await balance(A)) - before));
    const row = logRows(A).filter((e) => e.shop)[0];
    ok(!!row && row.sats === 30000 && ordersOf(row.shop).length === 1, '11 one received row with its order', row && row.memo);
    // the third confirms; another phone with the same words takes it first and its collected call is lost: said earlier here
    w.mint.onchainCredit(waiting.item.quote, 40000);
    const A2 = page(PHONE_WORDS, w);
    await A2.W.connect(MINT, { remember: true });
    A2.W.shopAdd('https://shop.test?name=Chain');
    shop.collectedFails = 1;
    await A2.W.shopCollectNow();
    const m = w.minted;
    await A.W.shopCollectNow();
    ok(!!waiting.collected && waiting.collected.earlier === true && w.minted === m, '11 an address the mint has issued already: said collected earlier, never minted again', JSON.stringify(waiting.collected));
  }


  /* ---- 12 the review's attacks (fix round 1) ---- */
  // H1, A6: honest; the collected call fails once, then a new sale for the same collaborator: paid each share once
  if (want(12)) {
    const w = world(); const shop = fakeShop('shop.test');
    const { A, anaText } = await setUp(w, [shop]);
    addQuote(A.W, shop, w.mint, { amount: 5000, splits: [{ id: anaText, amount: 1000 }] });
    A.W.shopAdd('https://shop.test?name=Honest');
    shop.collectedFails = 1;
    await A.W.shopCollectNow();
    addQuote(A.W, shop, w.mint, { amount: 5000, splits: [{ id: anaText, amount: 1000 }] });
    await A.W.shopCollectNow();
    ok(outboxPaid(A) === 2000 && (await balance(A)) === 8000, '12 H1: two sales, a 1,000 share each, the first collected call lost: Ana is paid 2,000 in all, not 3,000',
      outboxPaid(A) + ' paid, ' + (await balance(A)) + ' kept');
  }
  // H2, A1: two orders name one paid invoice: one order counted, one share paid, the second never said collected
  if (want(13)) {
    const w = world(); const shop = fakeShop('shop.test');
    const { A, anaText } = await setUp(w, [shop]);
    const a = addQuote(A.W, shop, w.mint, { amount: 5000, splits: [{ id: anaText, amount: 1000 }] });
    const b = pushItem(shop, Object.assign({}, a.item, { order: 'zz-dup', splits: [{ id: anaText, amount: 4000 }] }));
    A.W.shopAdd('https://shop.test?name=Dup');
    await A.W.shopCollectNow();
    await A.W.shopCollectNow();
    addQuote(A.W, shop, w.mint, { amount: 9000 });
    await A.W.shopCollectNow();
    const recv = logRows(A).filter((e) => e.shop);
    const det = recv.reduce((n, e) => n + ordersOf(e.shop).reduce((t, x) => t + x[1], 0), 0);
    ok(outboxPaid(A) === 1000 && !(b.collected && !b.collected.earlier) && det === recv.reduce((n, e) => n + e.sats, 0),
      '13 H2: one paid invoice named by two orders: one order counted, one share paid, the rows’ detail the money', outboxPaid(A) + ' paid; ' + JSON.stringify(b.collected) + '; detail ' + det);
    ok(A.logs.some((l) => /zz-dup was not collected: it names an invoice or ecash another order names/.test(l)) || !b.collected, '13 the second order is refused with a log line');
  }
  // H2, A3: honest, two phones with the same words: this one's mint call never reached the mint, the other minted and paid
  if (want(14)) {
    const w = world(); const shop = fakeShop('shop.test');
    const { A, anaText } = await setUp(w, [shop]);
    const x = addQuote(A.W, shop, w.mint, { amount: 4000, splits: [{ id: anaText, amount: 1000 }] });
    A.W.shopAdd('https://shop.test?name=Two');
    w.mintPostDown = true;
    await A.W.shopCollectNow();
    w.mintPostDown = false;
    const A2 = page(PHONE_WORDS, w);
    await A2.W.connect(MINT, { remember: true });
    A2.W.shopAdd('https://shop.test?name=Two');
    shop.collectedFails = 1;
    await A2.W.shopCollectNow();
    await A.W.shopCollectNow();
    const recv = logRows(A).filter((e) => e.shop);
    ok(outboxPaid(A) === 0 && !!x.collected && x.collected.earlier === true && recv.every((e) => ordersOf(e.shop).length === 0 || e.sats > 0),
      '14 H2: an order the other phone minted after this one’s call was lost: said earlier, no share paid again, nothing counted', outboxPaid(A) + ' ' + JSON.stringify(x.collected));
  }
  // M2 and the page's own names, A2: one ecash in two orders, a piece listed twice; the good invoice of the page still comes in
  if (want(15)) {
    const w = world(); const shop = fakeShop('shop.test');
    const { A, mine, anaText } = await setUp(w, [shop]);
    const B = await payerPage(w);
    const r = crypto.randomBytes(32).toString('hex');
    const pr = await lockedTo(B, shopMovedPub(mine.id, r), 1000);
    pushItem(shop, { order: 'p1', kind: 'proofs', proofs: pr, r, amount: 1000, unit: 'sat', mint: MINT, splits: [{ id: anaText, amount: 100 }], memo: 'x' });
    pushItem(shop, { order: 'p2', kind: 'proofs', proofs: pr, r, amount: 1000, unit: 'sat', mint: MINT, splits: [{ id: anaText, amount: 900 }], memo: 'x' });
    const q = addQuote(A.W, shop, w.mint, { amount: 3000, splits: [{ id: anaText, amount: 300 }] });
    const r2 = crypto.randomBytes(32).toString('hex');
    const pr2 = await lockedTo(B, shopMovedPub(mine.id, r2), 1024);
    const one = pr2.filter((p) => p.amount === 1024).slice(0, 1);
    const rep = pushItem(shop, { order: 'p3', kind: 'proofs', proofs: one.concat(one), r: r2, amount: 2048, unit: 'sat', mint: MINT, splits: [{ id: anaText, amount: 2000 }], memo: 'x' });
    A.W.shopAdd('https://shop.test?name=DupP');
    await A.W.shopCollectNow();
    await A.W.shopCollectNow();
    const recv = logRows(A).filter((e) => e.shop);
    const det = recv.reduce((n, e) => n + ordersOf(e.shop).reduce((t, x) => t + x[1], 0), 0);
    ok(!!q.collected && !q.collected.earlier, '15 M2: the good invoice of the page is collected whatever the ecash orders do');
    ok(outboxPaid(A) <= 400 && !rep.collected, '15 the same ecash in two orders and a piece listed twice: neither paid twice nor counted', outboxPaid(A) + ' paid');
    ok(det <= 4000 && (await balance(A)) >= 3000 - 300, '15 the keeper holds what came, the detail no more than it', det + ' / ' + (await balance(A)));
  }
  // M2: one ecash order the mint refuses at the receive: the page's minted money is in the pile and said collected
  if (want(16)) {
    const w = world(); const shop = fakeShop('shop.test');
    const { A, mine, anaText } = await setUp(w, [shop]);
    const B = await payerPage(w);
    const r = crypto.randomBytes(32).toString('hex');
    const pr = await lockedTo(B, shopMovedPub(mine.id, r), 1000);
    const bad = pushItem(shop, { order: 'p9', kind: 'proofs', proofs: pr, r, amount: 1000, unit: 'sat', mint: MINT, splits: [], memo: 'x' });
    const q = addQuote(A.W, shop, w.mint, { amount: 3000 });
    w.swapRefuseLocked = true;   // the mint refuses the swap that takes the locked ecash in, and only that one
    A.W.shopAdd('https://shop.test?name=Stall');
    await A.W.shopCollectNow();
    w.swapRefuseLocked = false;
    ok(!!q.collected && !bad.collected && (await balance(A)) === 3000, '16 M2: an ecash order refused at the receive stalls nothing: the invoice is in the pile and said collected',
      JSON.stringify([!!q.collected, !!bad.collected, await balance(A)]));
  }
  // M1, A5: someone else's locked issued invoice is refused, not said earlier
  if (want(17)) {
    const w = world(); const shop = fakeShop('shop.test');
    const { A, anaText } = await setUp(w, [shop]);
    await payerPage(w);
    const bq = w.bodies.find((b) => b.quote);
    const r = crypto.randomBytes(32).toString('hex');
    pushItem(shop, { order: 'e1', kind: 'quote', quote: bq.quote, r, amount: 20000, unit: 'sat', mint: MINT, splits: [{ id: anaText, amount: 100 }], memo: 'x' });
    A.W.shopAdd('https://shop.test?name=Earlier');
    await A.W.shopCollectNow();
    ok(!shop.confirmed.some((c) => c.order === 'e1') && outboxPaid(A) === 0, '17 M1: someone else’s locked, issued invoice: not said earlier, nothing paid');
  }
  // L1: put away stops the timer and the collection in flight; the return takes it up again
  if (want(18)) {
    const w = world(); w.mintMs = 40;
    const shop = fakeShop('shop.test');
    const { A } = await setUp(w, [shop]);
    for (let i = 0; i < 60; i++) addQuote(A.W, shop, w.mint, { amount: 1000 });
    A.W.shopAdd('https://shop.test?name=Away');
    const going = A.W.shopCollectNow();
    while (w.minted < 8) await wait(10);
    A.W._stopAskingAgain();
    const at = w.minted;
    await going;
    await wait(300);
    ok(w.minted <= at + 4 && w.minted < 60, '18 L1: put away, no new invoice is minted (the four out at most finish)', at + ' then ' + w.minted);
    ok(!A.W.shopCollecting(), '18 and the collection stops');
    await A.W.shopCollectNow();
    ok(w.minted === at || w.minted <= at + 4, '18 nor does one start while away', String(w.minted));
    A.W.resumeSweeps();
    for (let i = 0; i < 400 && shop.confirmed.length < 60; i++) await wait(50);
    ok(w.minted === 60 && shop.confirmed.length === 60, '18 back: it takes up where it stopped, each minted once', w.minted + ' minted, ' + shop.confirmed.length + ' said');
  }
  // L2: killed after a collaborator's payment went out and before it was written paid: not paid again
  if (want(19)) {
    const w = world(); const shop = fakeShop('shop.test');
    const { A, anaText } = await setUp(w, [shop]);
    addQuote(A.W, shop, w.mint, { amount: 5000, splits: [{ id: anaText, amount: 1000 }] });
    A.W.shopAdd('https://shop.test?name=Kill');
    let before = null;
    A.W._onShopCollect = (ev) => { if (ev.state === 'paying') before = A.storage.getItem('foxy.shop.runs'); };
    shop.collectedFails = 1;   // the run is kept, as a run waiting for its ack is
    await A.W.shopCollectNow();
    // as if killed between the outbox's write and `paid`: the run as it stood before the payout
    A.storage.setItem('foxy.shop.runs', before);
    await A.W.shopCollectNow();
    ok(outboxPaid(A) === 1000, '19 L2: the payout is found in the outbox by its own id and not made again', String(outboxPaid(A)));
  }
  // L3: two shops on one host, at two paths: a signature for one is not good at the other
  if (want(20)) {
    const w = world();
    const one = fakeShop('shared.test', { path: '/one' }), two = fakeShop('shared.test', { path: '/two' });
    const { A } = await setUp(w, [one, two]);
    addQuote(A.W, one, w.mint, { amount: 1000 });
    addQuote(A.W, two, w.mint, { amount: 2000 });
    A.W.shopAdd('https://shared.test/one?name=One');
    A.W.shopAdd('https://shared.test/two?name=Two');
    await A.W.shopCollectNow();
    ok(one.confirmed.length === 1 && two.confirmed.length === 1 && one.refusedSig === 0 && two.refusedSig === 0, '20 L3: each shop at its own path takes the signature over host and the request\'s full path');
    const sig = A.phone.answer(A.window, { action: 'cashuIdShop', kind: 'collect', nonce: '11'.repeat(32), host: 'shared.test', path: '/one/api/shop/collect' });
    const v = (path) => A.window.CashuTS.schnorrVerifyDigest(JSON.parse(sig[0]).sig, shopCollectDigest('11'.repeat(32), 'shared.test', path).toString('hex'), JSON.parse(sig[0]).pub);
    ok(v('/one/api/shop/collect') === true && v('/two/api/shop/collect') === false && v('/one/api/shop/collected') === false,
      '20 the signature binds the request\'s full path: not good at /two, nor for the other call');
  }

  /* ---- 10 10,000 sales ---- */
  if (BIG && want(10)) {
    const w = world();
    w.mintMs = 0;
    const shop = fakeShop('shop.test');
    const { A, anaText } = await setUp(w, [shop]);
    const N = Number(process.env.FOXY_SHOP_BIG || 10000);
    for (let i = 0; i < N; i++) addQuote(A.W, shop, w.mint, { amount: 1234, splits: [{ id: anaText, amount: 34 }] });
    A.W.shopAdd('https://shop.test?name=Huge');
    let atPaying = -1;
    A.W._onShopCollect = (ev) => { if (ev.state === 'paying' && atPaying < 0) atPaying = pileCount(A); };
    const bytes0 = storeBytes(A);
    const began = Date.now();
    await A.W.shopCollectNow();
    const ms = Date.now() - began;
    const grown = storeBytes(A) - bytes0;
    console.log('      10: ' + N + ' sales in ' + ms + ' ms; ' + w.swaps + ' swaps; the store grew ' + grown + ' bytes; ' + atPaying + ' pieces before the payout, ' + pileCount(A) + ' after');
    ok(w.minted === N, '10 every invoice minted once', String(w.minted));
    const once = new Map();
    shop.confirmed.forEach((c) => once.set(c.order, (once.get(c.order) || 0) + 1));
    ok(once.size === N && [...once.values()].every((v) => v === 1), '10 every order confirmed once');
    ok(atPaying >= 0 && atPaying < 40, '10 the 10,000 sales are under 40 pieces once swapped', String(atPaying));
    ok(pileCount(A) <= 168 + 40, '10 and the pile after the payout is the change pool’s and that', String(pileCount(A)));
    ok(grown < 300 * 1024, '10 the store grew under 300 KB', String(grown));
    ok((await balance(A)) === N * 1200, '10 the keeper holds the sales less the share');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
