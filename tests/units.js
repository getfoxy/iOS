/* units.js — ecash in units other than sats.
 *
 *     node tests/units.js
 *
 * Requires jsdom: npm install --no-save jsdom
 *
 * A mint can issue usd or eur ecash beside sats. Foxy used to see only sats:
 * a restore walked only sat keysets, and a usd token's cents were counted as
 * sats. These check the unit piles (foxy.cashu.proofs.<mint>@<unit>), restore
 * of other units, tokenInfo and receiveToken for a usd token, balances(), and
 * that everything about sats is as it was.
 *
 * The mint is a stub, in the style of harness.js, that knows about units the
 * way cashu-ts 4.10.1 does: a wallet has one unit, its keyset list is that
 * unit's, and its receive and restore refuse any other. */
'use strict';
const { load, proof, PHONE_WORDS } = require('./harness');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    const problem = await fn();
    if (problem) {
      failures.push(name + ': ' + problem);
      console.log('FAIL  ' + name);
      console.log('      ' + problem);
    } else {
      passed += 1;
      console.log('ok    ' + name);
    }
  } catch (e) {
    failures.push(name + ': threw ' + (e && e.message));
    console.log('THREW ' + name);
    console.log('      ' + (e && e.stack || e));
  }
}

const sumOf = (ps) => (ps || []).reduce((a, p) => a + Number(p.amount || 0), 0);
const eq = (got, want, what) =>
  got === want ? null : (what + ': got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));

const MINT = 'https://m.test';
const SAT_PILE = 'foxy.cashu.proofs.' + MINT;
const USD_PILE = SAT_PILE + '@usd';
const SAT_ID = '00b4cd27d8861a44';
const USD_ID = '00c0ffee00000001';
const USD_OLD = '00c0ffee00000002';
const AUTH_ID = '00a0a0a0a0a0a0a0';
/* A restore scan as RESTORE runs it: the words typed on the phone (here the
 * phone's own seed again), scanned by their candidate. A candidate is walked
 * until three batches come back empty; this wallet's own seed only to 300 past
 * the phone's next counter. */
async function scan(ctx, urls) {
  ctx.phone.hooks.enter = () => PHONE_WORDS;
  const candidate = await ctx.W.enterSeedNative();
  return ctx.W.scanSeed({ candidate }, urls || [MINT]);
}

// A token here is base64url JSON, so it passes unwrap() and the stub decodes it.
const tok = (proofs, unit, mint) =>
  'cashuB' + Buffer.from(JSON.stringify({ mint: mint || MINT, unit: unit || 'sat', proofs })).toString('base64url');
const decode = (t) => JSON.parse(Buffer.from(String(t).slice(6), 'base64url').toString());
const pile = (storage, key) => JSON.parse(storage.getItem(key) || '[]');

let serial = 0;
function minted(amount, id) {
  serial += 1;
  const tag = String(serial).padStart(8, '0');
  return { amount, id, secret: 'ab'.repeat(28) + tag, C: '02' + '0'.repeat(56) + tag };
}

/* A cashu-ts stand-in with units.
 *
 *   keysets   the mint's /v1/keysets: [{ id, unit, active }]
 *   restore   { keysetId: { batchStart: [amounts] | 'fail' } }
 *   spent     a Set of secrets the mint calls SPENT (mutable)
 *   fee       what a swap keeps back
 *   noReceive a wallet without receive(), so an import files unchecked
 */
function unitCashu(opts) {
  const o = opts || {};
  const keysets = o.keysets || [
    { id: SAT_ID, unit: 'sat', active: true },
    { id: USD_ID, unit: 'usd', active: true },
    { id: USD_OLD, unit: 'usd', active: false },
    { id: AUTH_ID, unit: 'auth', active: true },
  ];
  const spent = o.spent || new Set();
  const log = { built: [], restored: [], loads: 0, cacheLoads: 0, received: [] };
  class Wallet {
    constructor(url, wopts) {
      this.mintUrl = typeof url === 'string' ? url : (url && url.mintUrl);
      this.opts = wopts || {};
      this.unit = this.opts.unit || 'sat';
      log.built.push({ unit: this.unit, opts: this.opts });
      const self = this;
      const map = {};
      keysets.forEach((k) => { map[k.id] = Object.assign({ hasKeys: false }, k); });
      this.keyChain = {
        keysets: map,
        cache: { keysets },
        getKeysets: () => {
          const list = keysets.filter((k) => k.unit === self.unit);
          if (!list.length) throw new Error('No keysets found for unit: ' + self.unit);
          return list;
        },
        getKeyset: (id) => map[id],
      };
      this._keyChain = this.keyChain;
      this.on = { countersReserved: () => {} };
      if (o.noReceive) this.receive = undefined;
    }
    get keysetId() {
      const k = keysets.find((x) => x.unit === this.unit && x.active);
      return k && k.id;
    }
    loadMint() { log.loads += 1; return Promise.resolve(); }
    loadMintFromCache() { log.cacheLoads += 1; }
    getMintInfo() { return { cache: { name: 'stub mint' } }; }
    restore(start, count, cfg) {
      const id = cfg && cfg.keysetId;
      const ks = keysets.find((k) => k.id === id);
      if (!ks || ks.unit !== this.unit) {
        return Promise.reject(new Error('Keyset unit does not match wallet unit'));
      }
      log.restored.push({ unit: this.unit, id, start });
      const want = (o.restore && o.restore[id] || {})[start];
      if (want === 'fail') return Promise.reject(new Error('mint did not answer'));
      const proofs = (want || []).map((a) => minted(a, id));
      return Promise.resolve(proofs.length
        ? { proofs, lastCounterWithSignature: start + proofs.length - 1 }
        : { proofs: [] });
    }
    checkProofsStates(ps) {
      return Promise.resolve((ps || []).map((p) => ({ state: spent.has(p.secret) ? 'SPENT' : 'UNSPENT' })));
    }
    decodeToken(t) { return decode(t); }
    receive(t) {
      const d = typeof t === 'string' ? decode(t) : t;
      if ((d.unit || 'sat') !== this.unit) return Promise.reject(new Error('Token is not in wallet unit'));
      log.received.push({ unit: this.unit, opts: this.opts });
      return Promise.resolve([minted(sumOf(d.proofs) - (o.fee || 0), this.keysetId)]);
    }
    checkMintQuoteBolt11() { return Promise.resolve({ state: 'UNPAID' }); }
  }
  const cashu = {
    Wallet,
    // the bridge's Mint (customRequest); not a wallet, so not counted as one
    Mint: class { constructor(url) { this.mintUrl = url; } },
    getDecodedToken: (t) => {
      if (o.fullDecodeThrows) throw new Error('keyset ids not loaded');
      return decode(t);
    },
    getTokenMetadata: (t) => {
      const d = decode(t);
      return {
        unit: d.unit || 'sat', mint: d.mint, amount: sumOf(d.proofs),
        incompleteProofs: d.proofs.map(({ id, ...rest }) => rest),
        proofAmounts: d.proofs.map((p) => p.amount),
      };
    },
    getEncodedToken: (x) => tok(x.proofs, x.unit, x.mint),
  };
  return { cashu, log, spent };
}

async function wallet(opts) {
  const o = opts || {};
  const stub = unitCashu(o);
  const ctx = load({ cashu: stub.cashu, storage: o.storage });
  ctx.W.RESTORE_RETRY_MS = 1;
  ctx.log = stub.log;
  ctx.spent = stub.spent;
  if (o.connect !== false) await ctx.W.connect(MINT, { remember: true });
  return ctx;
}

const usdProof = (amount) => ({ ...proof(amount), id: USD_ID });

(async () => {
  console.log('foxy other-unit tests\n');

  // ---- restore --------------------------------------------------------------

  await test('restore walks every usd keyset with a usd wallet and adopts them into the usd pile', async () => {
    const ctx = await wallet({
      connect: false,
      restore: { [SAT_ID]: { 0: [8, 16] }, [USD_ID]: { 0: [100, 23] }, [USD_OLD]: { 0: [5] } },
    });
    const rows = await scan(ctx);
    const row = rows.find((r) => r.state === 'done');
    if (!row) return 'no finished row: ' + JSON.stringify(rows);
    if (row.sats !== 24) return 'sat total changed: ' + row.sats;
    if (!row.units || !row.units.usd) return 'no usd in the row: ' + JSON.stringify(Object.keys(row.units || {}));
    if (row.units.usd.amount !== 128) return 'usd amount ' + row.units.usd.amount + ', wanted 128';
    if (row.units.usd.count !== 3) return 'usd count ' + row.units.usd.count;
    if (row.units.auth) return 'walked the blind-auth keyset';
    if (row.partial || row.units.usd.partial) return 'marked partial with nothing failing';
    if (row.counters[USD_ID] !== 2 || row.counters[USD_OLD] !== 1 || row.counters[SAT_ID] !== 2) {
      return 'counters: ' + JSON.stringify(row.counters);
    }
    const wrong = ctx.log.restored.filter((c) => (c.id === SAT_ID) !== (c.unit === 'sat'));
    if (wrong.length) return 'a keyset was restored by a wallet of another unit: ' + JSON.stringify(wrong[0]);
    if (ctx.log.restored.some((c) => c.id === AUTH_ID)) return 'restored the auth keyset';
    if (!ctx.log.restored.some((c) => c.id === USD_OLD)) return 'the inactive usd keyset was not walked';
    if (ctx.log.cacheLoads < 1 || ctx.log.loads !== 1) return 'the usd wallet fetched the mint again (loads ' + ctx.log.loads + ')';
    const usdBuilt = ctx.log.built.find((b) => b.unit === 'usd');
    if (!usdBuilt || usdBuilt.opts.secretsPolicy !== 'deterministic' || !usdBuilt.opts.bip39seed) {
      return 'the usd wallet was not built on the seed';
    }

    const out = await ctx.W.adoptScan(rows, { overwrite: true });
    if (sumOf(pile(ctx.storage, SAT_PILE)) !== 24) return 'sat pile: ' + sumOf(pile(ctx.storage, SAT_PILE));
    if (sumOf(pile(ctx.storage, USD_PILE)) !== 128) return 'usd pile: ' + sumOf(pile(ctx.storage, USD_PILE));
    if (!out.units || out.units.length !== 1 || out.units[0].amount !== 128) return 'adopt result: ' + JSON.stringify(out.units);
    const c = ctx.phone.countersNow();
    return eq(c[USD_ID], 2, 'usd counter on the phone');
  });

  await test('a usd proof the mint calls spent is left out of the scan', async () => {
    const ctx = await wallet({ connect: false, restore: { [USD_ID]: { 0: [100, 23] } } });
    // the stub numbers secrets in order: the second usd proof is 23
    const origRestore = ctx.window.CashuTS.Wallet.prototype.restore;
    ctx.window.CashuTS.Wallet.prototype.restore = function (...a) {
      return origRestore.apply(this, a).then((r) => {
        (r.proofs || []).filter((p) => p.amount === 23).forEach((p) => ctx.spent.add(p.secret));
        return r;
      });
    };
    const rows = await scan(ctx);
    const row = rows[0];
    return eq(row.units.usd && row.units.usd.amount, 100, 'usd found and unspent');
  });

  await test('a usd keyset that does not answer marks the row partial and keeps the sats', async () => {
    const ctx = await wallet({ connect: false, restore: { [SAT_ID]: { 0: [8] }, [USD_ID]: { 0: [50], 100: 'fail' } } });
    const rows = await scan(ctx);
    const row = rows[0];
    if (row.state !== 'done') return 'row ' + row.state;
    if (!row.partial || !row.units.usd.partial) return 'not marked partial';
    if (!row.missing.includes(USD_ID)) return 'failed keyset not named';
    if (row.sats !== 8) return 'sats ' + row.sats;
    return eq(row.units.usd.amount, 50, 'usd found before the failure');
  });

  await test('a mint with only sat keysets scans and adopts exactly as before', async () => {
    const ctx = await wallet({ connect: false, keysets: [{ id: SAT_ID, unit: 'sat', active: true }],
                               restore: { [SAT_ID]: { 0: [8, 16] } } });
    const rows = await scan(ctx);
    const row = rows[0];
    if (JSON.stringify(row.units) !== '{}') return 'units: ' + JSON.stringify(row.units);
    if (ctx.log.built.length !== 1) return 'built ' + ctx.log.built.length + ' wallets, wanted 1';
    if (row.sats !== 24 || row.count !== 2 || row.partial) return 'row: ' + JSON.stringify({ sats: row.sats, count: row.count, partial: row.partial });
    const out = await ctx.W.adoptScan(rows, { overwrite: true });
    if (JSON.stringify(out.kept) !== JSON.stringify([{ host: 'm.test', sats: 24, added: 24, partial: false }])) return 'kept: ' + JSON.stringify(out.kept);
    const unitKeys = Object.keys(ctx.storage).filter((k) => k.indexOf('@') >= 0);
    return unitKeys.length ? 'wrote ' + unitKeys.join(', ') : null;
  });

  await test('adopting without overwrite leaves a usd pile that already holds proofs', async () => {
    const held = [usdProof(7)];
    const ctx = await wallet({ connect: false, storage: { [USD_PILE]: JSON.stringify(held) } });
    const out = await ctx.W.adoptScan([{ state: 'done', url: MINT, host: 'm.test', proofs: [], counters: {},
      units: { usd: { amount: 100, count: 1, proofs: [usdProof(100)], partial: false } } }], {});
    if (!out.skippedUnits.length) return 'not reported as skipped';
    return eq(sumOf(pile(ctx.storage, USD_PILE)), 7, 'usd pile untouched');
  });

  // ---- tokens -----------------------------------------------------------------

  await test('tokenInfo reads a usd token in its own unit and does not call it sats', async () => {
    const ctx = await wallet({});
    const info = ctx.W.tokenInfo(tok([usdProof(100), usdProof(23)], 'usd'));
    if (!info) return 'did not decode';
    if (info.unit !== 'usd') return 'unit ' + info.unit;
    if (info.amount !== 123) return 'amount ' + info.amount;
    if (info.sats !== null) return 'sats ' + info.sats + ' for a usd token';
    const sat = ctx.W.tokenInfo(tok([proof(64), proof(8)]));
    if (sat.unit !== 'sat' || sat.amount !== 72) return 'sat token: ' + JSON.stringify({ unit: sat.unit, amount: sat.amount });
    return eq(sat.sats, 72, 'sats of a sat token');
  });

  await test('tokenInfo keeps the unit when only the metadata decoder can read the token', async () => {
    const ctx = await wallet({ fullDecodeThrows: true });
    const info = ctx.W.tokenInfo(tok([usdProof(250)], 'usd', 'https://other.test'));
    if (!info) return 'did not decode';
    if (info.unit !== 'usd' || info.sats !== null) return JSON.stringify({ unit: info.unit, sats: info.sats });
    return eq(info.amount, 250, 'amount');
  });

  await test('receiving a usd token swaps it with a usd wallet into the usd pile', async () => {
    const ctx = await wallet({ fee: 2, storage: { [SAT_PILE]: JSON.stringify([proof(64)]) } });
    const loadsBefore = ctx.log.loads;
    const r = await ctx.W.receiveToken(tok([usdProof(100), usdProof(23)], 'usd'));
    if (r.unit !== 'usd' || r.amount !== 121 || r.sats !== null) return 'result: ' + JSON.stringify(r);
    const swap = ctx.log.received[0];
    if (!swap || swap.unit !== 'usd') return 'swapped by a ' + (swap && swap.unit) + ' wallet';
    if (swap.opts.secretsPolicy !== 'deterministic' || !swap.opts.bip39seed || !swap.opts.counterSource) {
      return 'the usd wallet was not on the seed and the shared counters';
    }
    if (ctx.log.loads !== loadsBefore) return 'the usd wallet fetched the mint again';
    if (sumOf(pile(ctx.storage, USD_PILE)) !== 121) return 'usd pile ' + sumOf(pile(ctx.storage, USD_PILE));
    if (sumOf(pile(ctx.storage, SAT_PILE)) !== 64) return 'sat pile changed';
    if (await ctx.W.balanceSats() !== 64) return 'balanceSats counted usd';
    const entry = (await ctx.W.transactions(1))[0];
    if (!entry || entry.unit !== 'usd' || entry.amount !== 121 || entry.feeAmount !== 2) return 'history: ' + JSON.stringify(entry);
    return eq(entry.sats, 0, 'sats in the usd history entry');
  });

  await test('a usd token at a mint with no usd keysets is refused and nothing is filed', async () => {
    const ctx = await wallet({ keysets: [{ id: SAT_ID, unit: 'sat', active: true }] });
    try {
      await ctx.W.receiveToken(tok([usdProof(100)], 'usd'));
    } catch (e) {
      if (!/does not issue USD ecash/.test(e.message)) return 'message: ' + e.message;
      if (ctx.log.received.length) return 'the mint was asked to swap';
      return ctx.storage.getItem(USD_PILE) ? 'a usd pile was written' : null;
    }
    return 'the token was received';
  });

  await test('a sat token is received exactly as before', async () => {
    const ctx = await wallet({});
    const r = await ctx.W.receiveToken(tok([proof(64), proof(8)]));
    if (r.sats !== 72 || r.mint !== MINT || r.switched) return 'result: ' + JSON.stringify(r);
    if (ctx.log.received[0].unit !== 'sat') return 'swapped by a ' + ctx.log.received[0].unit + ' wallet';
    if (sumOf(pile(ctx.storage, SAT_PILE)) !== 72) return 'sat pile ' + sumOf(pile(ctx.storage, SAT_PILE));
    const entry = (await ctx.W.transactions(1))[0];
    if ('unit' in entry || 'amount' in entry) return 'the sat history entry gained unit fields: ' + JSON.stringify(entry);
    if (Object.keys(ctx.storage).some((k) => k.indexOf('@') >= 0)) return 'a unit pile was written';
    return eq(entry.sats, 72, 'history sats');
  });

  await test('sending another unit is refused before anything is touched', async () => {
    const ctx = await wallet({ storage: { [USD_PILE]: JSON.stringify([usdProof(500)]) } });
    let msg = '';
    try { await ctx.W.sendToken(100, { unit: 'usd' }); } catch (e) { msg = e.message; }
    if (!/only send sats/.test(msg)) return 'usd send: ' + (msg || 'not refused');
    let satMsg = '';
    try { await ctx.W.sendToken(100, { unit: 'sat' }); } catch (e) { satMsg = e.message; }
    if (/only send sats/.test(satMsg)) return 'a sat send was refused as another unit';
    return eq(sumOf(pile(ctx.storage, USD_PILE)), 500, 'usd pile after the refusal');
  });

  await test('reclaiming or importing a usd token is refused', async () => {
    const ctx = await wallet({});
    const t = tok([usdProof(100)], 'usd');
    let reclaim = '';
    try { await ctx.W.reclaimToken(t); } catch (e) { reclaim = e.message; }
    if (!/USD ecash/.test(reclaim)) return 'reclaim: ' + (reclaim || 'not refused');
    let imp = '';
    try { await ctx.W.importProofs(t); } catch (e) { imp = e.message; }
    if (!/USD ecash/.test(imp)) return 'import: ' + (imp || 'not refused');
    return ctx.log.received.length ? 'the mint was asked to swap' : null;
  });

  // ---- balances ---------------------------------------------------------------

  await test('balances() lists each non-empty pile in its own unit; balanceIn reads one', async () => {
    const ctx = await wallet({ storage: {
      [SAT_PILE]: JSON.stringify([proof(64)]),
      [USD_PILE]: JSON.stringify([usdProof(100), usdProof(23)]),
      'foxy.cashu.proofs.https://b.test@eur': JSON.stringify([proof(50)]),
      'foxy.cashu.proofs.https://b.test': '[]',
      'foxy.cashu.proofs.https://c.test@usd': '[]',
    } });
    const got = JSON.stringify(ctx.W.balances());
    const want = JSON.stringify([
      { mint: 'https://b.test', unit: 'eur', amount: 50 },
      { mint: MINT, unit: 'sat', amount: 64 },
      { mint: MINT, unit: 'usd', amount: 123 },
    ]);
    if (got !== want) return 'balances: ' + got;
    if (ctx.W.balanceIn(MINT, 'usd') !== 123) return 'balanceIn usd ' + ctx.W.balanceIn(MINT, 'usd');
    if (ctx.W.balanceIn(MINT) !== 64) return 'balanceIn with no unit ' + ctx.W.balanceIn(MINT);
    if (ctx.W.balanceIn('https://B.test/', 'eur') !== 50) return 'balanceIn does not canonicalise the mint';
    if (ctx.W.balanceIn(MINT, 'not a unit!') !== 0) return 'a bad unit read something';
    if (ctx.W.balanceAt(MINT) !== 64) return 'balanceAt counted usd';
    return eq(await ctx.W.balanceSats(), 64, 'balanceSats');
  });

  await test('amounts are shown in their unit: cents with a symbol, or the unit code', async () => {
    const { W } = await wallet({ connect: false });
    const cases = [
      [123, 'usd', '$1.23'], [123456, 'usd', '$1,234.56'], [50, 'eur', '€0.50'],
      [1234, 'sat', '1,234 sats'], [5, 'msat', '5 msat'], [7, 'USD', '$0.07'],
    ];
    for (const [n, u, want] of cases) {
      if (W.formatAmount(n, u) !== want) return u + ' ' + n + ': ' + W.formatAmount(n, u) + ', wanted ' + want;
    }
    return eq(W.unitName('usd') + W.unitName('eur') + W.unitName('msat'), 'USDEURMSAT', 'unit names');
  });

  // ---- reconcile, quarantine, imports ------------------------------------

  await test('reconcile checks the usd pile too, and reports it apart from sats', async () => {
    const derived = usdProof(40);
    const foreign = usdProof(9);
    const live = usdProof(100);
    const sat = proof(64);
    const ctx = await wallet({
      spent: new Set([derived.secret, foreign.secret]),
      storage: {
        [SAT_PILE]: JSON.stringify([sat]),
        [USD_PILE]: JSON.stringify([derived, foreign, live]),
        'foxy.cashu.imported': JSON.stringify([foreign.secret]),
      },
    });
    const r = await ctx.W.reconcile();
    if (r.before !== 64 || r.after !== 64 || r.spent !== 0 || r.removed !== 0) return 'sat figures: ' + JSON.stringify(r);
    if (!r.units || !r.units.usd || r.units.usd.spent !== 49 || r.units.usd.after !== 100) return 'usd figures: ' + JSON.stringify(r.units);
    if (JSON.stringify(pile(ctx.storage, USD_PILE).map((p) => p.secret)) !== JSON.stringify([live.secret])) return 'usd pile not reconciled';
    const q = JSON.parse(ctx.storage.getItem('foxy.cashu.quarantine') || '[]');
    if (q.length !== 1 || q[0].unit !== 'usd' || q[0].proof.secret !== foreign.secret) return 'quarantine: ' + JSON.stringify(q);
    if (ctx.W.quarantinedSats() !== 0) return 'quarantinedSats counted usd: ' + ctx.W.quarantinedSats();

    // the mint changes its mind: it goes back to the usd pile, not the sat pile
    ctx.spent.delete(foreign.secret);
    const back = await ctx.W.unquarantine();
    if (back.back !== 0) return 'put back as sats: ' + JSON.stringify(back);
    if (!back.backUnits || back.backUnits.usd !== 9) return 'backUnits: ' + JSON.stringify(back.backUnits);
    if (sumOf(pile(ctx.storage, SAT_PILE)) !== 64) return 'sat pile changed on putting back';
    return eq(sumOf(pile(ctx.storage, USD_PILE)), 109, 'usd pile after putting back');
  });

  await test('putting back sets-aside ecash sends sats to the sat pile and each other unit to its own', async () => {
    const satForeign = proof(32);
    const usdForeign = usdProof(9);
    const sat = proof(64);
    const ctx = await wallet({
      spent: new Set([satForeign.secret, usdForeign.secret]),
      storage: {
        [SAT_PILE]: JSON.stringify([sat, satForeign]),
        [USD_PILE]: JSON.stringify([usdForeign]),
        'foxy.cashu.imported': JSON.stringify([satForeign.secret, usdForeign.secret]),
      },
    });
    await ctx.W.reconcile();
    const q = JSON.parse(ctx.storage.getItem('foxy.cashu.quarantine') || '[]');
    if (q.length !== 2) return 'both were set aside: ' + JSON.stringify(q.map((r) => r.unit));
    if (ctx.W.quarantinedSats() !== 32) return 'quarantinedSats ' + ctx.W.quarantinedSats();

    ctx.spent.delete(satForeign.secret);
    ctx.spent.delete(usdForeign.secret);
    const back = await ctx.W.unquarantine();
    if (back.back !== 32) return 'sats put back: ' + JSON.stringify(back);
    // only units other than sats are reported apart: sats are `back`
    if (!back.backUnits || Object.keys(back.backUnits).join() !== 'usd' || back.backUnits.usd !== 9) {
      return 'backUnits: ' + JSON.stringify(back.backUnits);
    }
    const bad = eq(sumOf(pile(ctx.storage, SAT_PILE)), 96, 'sat pile after putting back');
    if (bad) return bad;
    const bad2 = eq(sumOf(pile(ctx.storage, USD_PILE)), 9, 'usd pile after putting back');
    if (bad2) return bad2;
    return eq(JSON.parse(ctx.storage.getItem('foxy.cashu.quarantine') || '[]').length, 0, 'what is still set aside');
  });

  await test('putting back sats alone reports no other unit', async () => {
    const satForeign = proof(32);
    const ctx = await wallet({
      spent: new Set([satForeign.secret]),
      storage: {
        [SAT_PILE]: JSON.stringify([proof(64), satForeign]),
        'foxy.cashu.imported': JSON.stringify([satForeign.secret]),
      },
    });
    await ctx.W.reconcile();
    ctx.spent.delete(satForeign.secret);
    const back = await ctx.W.unquarantine();
    if (back.back !== 32) return 'sats put back: ' + JSON.stringify(back);
    if (back.backUnits) return 'a sats-only return named units: ' + JSON.stringify(back.backUnits);
    return eq(sumOf(pile(ctx.storage, SAT_PILE)), 96, 'sat pile after putting back');
  });

  await test('a sat-only reconcile returns what it always did', async () => {
    const a = proof(64), b = proof(8);
    const ctx = await wallet({ spent: new Set([b.secret]), storage: { [SAT_PILE]: JSON.stringify([a, b]) } });
    const r = await ctx.W.reconcile();
    return eq(JSON.stringify(r), JSON.stringify({ before: 72, after: 64, removed: 1, spent: 8 }), 'result');
  });

  await test('pruning the imported list keeps imports held in a usd pile', async () => {
    const held = usdProof(30);
    const ctx = await wallet({ noReceive: true, storage: {
      [USD_PILE]: JSON.stringify([held]),
      'foxy.cashu.imported': JSON.stringify([held.secret]),
    } });
    await ctx.W.importProofs(JSON.stringify({ proofs: [proof(8)] }));
    const list = JSON.parse(ctx.storage.getItem('foxy.cashu.imported') || '[]');
    if (!list.includes(held.secret)) return 'the usd import was pruned from the list';
    return eq(list.length, 2, 'imported secrets');
  });

  await test('a restore overwrite keeps an imported usd proof the words cannot rebuild', async () => {
    const foreign = usdProof(30);
    const ctx = await wallet({ connect: false, storage: {
      [USD_PILE]: JSON.stringify([foreign]),
      'foxy.cashu.imported': JSON.stringify([foreign.secret]),
    } });
    await ctx.W.adoptScan([{ state: 'done', url: MINT, host: 'm.test', proofs: [], counters: {},
      units: { usd: { amount: 100, count: 1, proofs: [usdProof(100)], partial: false } } }], { overwrite: true });
    return eq(sumOf(pile(ctx.storage, USD_PILE)), 130, 'usd pile after the overwrite');
  });

  await test('the sat ledger still balances across a usd receive', async () => {
    const ctx = await wallet({ storage: { [SAT_PILE]: JSON.stringify([proof(64)]) } });
    const before = await ctx.W.balanceSats();
    await ctx.W.receiveToken(tok([proof(8)]));
    await ctx.W.receiveToken(tok([usdProof(100)], 'usd'));
    const moved = (await ctx.W.balanceSats()) - before;
    const history = (await ctx.W.transactions(50)).reduce((a, t) => a + (t.dir === 'in' ? Number(t.sats) || 0 : 0), 0);
    return eq(history, moved, 'history sats against the sat balance');
  });

  console.log('');
  console.log(passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
})();
