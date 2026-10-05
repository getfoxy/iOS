/* run.js — the test suite.
 *
 *     node tests/run.js
 *
 * Requires jsdom: npm install --no-save jsdom
 *
 * These test Web/foxy-wallet.js as it stands — no restructuring, no framework.
 * They came from throwaway scripts written while chasing bugs;
 * keeping them means those bugs cannot come back quietly.
 */
'use strict';
/* Every test runs against the phone (harness.js's nativePhone), which keeps
 * the seed, its words and the counters, as the app does: the wallet has no
 * other seed path. */
const { load, proof, connected, PHONE_WORDS } = require('./harness');
const { ledgerBalances, makeProofBox, snapshot } = require('./invariants');

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
    console.log('      ' + (e && e.message));
  }
}

const sumOf = (ps) => (ps || []).reduce((a, p) => a + Number(p.amount || 0), 0);
const eq = (got, want, what) =>
  got === want ? null : (what + ': got ' + got + ', wanted ' + want);

(async () => {
  console.log('foxy wallet tests\n');

  /* A missing function is a broken file, not a failing test.
   *
   * An edit once removed 43KB from foxy-wallet.js — nine functions — and the
   * smoke test passed, because it checks that the markup's bindings resolve
   * rather than that the wallet still has its methods. Everything below would
   * have reported as a failure, which would have sent someone looking in the
   * wrong place. */
  {
    const { W } = load({});
    const need = ['importProofs', 'exportProofs', 'pinSet',
                  'looksLikeReinstall', 'balanceSats', 'transactions',
                  'pendingMelts', 'connect', 'pay', 'sendToken', 'receiveToken'];
    const missing = need.filter(n => typeof W[n] !== 'function');
    if (missing.length) {
      console.log('Web/foxy-wallet.js is missing: ' + missing.join(', '));
      console.log('That is a damaged file, not a failing test. Restore it:');
      console.log('    git checkout Web/foxy-wallet.js');
      process.exit(1);
    }
  }

  // ---- provenance ------------------------------------------------------

  await test('imported proofs are recorded as foreign', async () => {
    const { W, storage } = await connected();
    await W.importProofs(JSON.stringify({ proofs: [proof(64), proof(32)] }));
    const list = JSON.parse(storage.getItem('foxy.cashu.imported') || '[]');
    return eq(list.length, 2, 'imported secrets recorded');
  });

  await test('a 64-hex secret from elsewhere is still foreign', async () => {
    // the shape test this replaced called these seed-derived and deleted them
    const { W, storage } = await connected();
    const hex = (n) => n.toString(16).padStart(64, '0');
    await W.importProofs(JSON.stringify({
      proofs: [proof(64, hex(1)), proof(32, hex(2))],
    }));
    const list = JSON.parse(storage.getItem('foxy.cashu.imported') || '[]');
    if (list.length !== 2) return 'expected 2 recorded, got ' + list.length;
    return list.every(s => /^[0-9a-f]{64}$/.test(s))
      ? null : 'the secrets were not 64-hex, so this does not test the case';
  });

  // ---- dedup -----------------------------------------------------------

  await test('importing the same proofs twice adds nothing', async () => {
    const { W } = await connected();
    const token = JSON.stringify({ proofs: [proof(64), proof(32)] });
    const first = await W.importProofs(token);
    const second = await W.importProofs(token);
    if (first !== 96) return 'first import added ' + first + ', wanted 96';
    return eq(second, 0, 'second import');
  });

  // ---- the reinstall check ---------------------------------------------

  await test('a seed with nothing else is a reinstall', async () => {
    const { W } = load({});
    await W.seedReady();                     // the phone says a seed exists
    return W.looksLikeReinstall() ? null : 'should have been recognised';
  });

  await test('a seed with a mint is an update, not a reinstall', async () => {
    const { W } = load({ storage: {
      'foxy.cashu.mint': JSON.stringify('https://m.test'),
    } });
    await W.seedReady();
    return W.looksLikeReinstall() ? 'an update must never look like a reinstall' : null;
  });

  await test('a seed with only a PIN is an update', async () => {
    const { W } = load({ storage: {
      'foxy.pin.v1': JSON.stringify({ salt: 'x', hash: 'y' }),
    } });
    await W.seedReady();
    return W.looksLikeReinstall() ? 'a PIN means the app has run before' : null;
  });

  // ---- the PIN ---------------------------------------------------------

  await test('the PIN is never stored', async () => {
    const { W, storage } = load({});
    W.pinSet('482913');
    const rec = storage.getItem('foxy.pin.v1') || '';
    if (rec.includes('482913')) return 'the digits are in storage';
    if (!W.pinCheck('482913')) return 'the correct PIN does not verify';
    return W.pinCheck('482914') ? 'a wrong PIN verified' : null;
  });

  // ---- the invariants --------------------------------------------------

  await test('INVARIANT the ledger balances across an import', async () => {
    const { W } = await connected();
    const before = await snapshot(W);
    await W.importProofs(JSON.stringify({ proofs: [proof(64), proof(32)] }));
    const after = await snapshot(W);
    // an import is not a payment: it moves the balance with no history entry,
    // which is the one legitimate exception and worth asserting explicitly
    if (after.log.length !== before.log.length) {
      return 'an import wrote a history entry, which it should not';
    }
    return eq(after.balance - before.balance, 96, 'balance after import');
  });

  await test('INVARIANT a secret never carries two signatures', async () => {
    const box = makeProofBox();
    const good = proof(64);
    let problem = box.add([good, proof(32)]);
    if (problem) return 'a clean set was rejected: ' + problem;
    // the same secret, a different signature — proof corruption
    problem = box.add([{ ...good, C: '03' + '0'.repeat(64) }]);
    return problem ? null : 'a rebuilt proof was not detected';
  });

  // ---- DLEQ (NUT-12) -----------------------------------------------------

  // The cryptography is cashu-ts's and was checked against a live mint; these
  // check that Foxy asks, and what it does with the answer.
  const dleqStub = (verdict) => {
    const { stubCashu } = require('./harness');
    const c = stubCashu({});
    const Base = c.Wallet;
    c.Wallet = class extends Base {
      constructor(u, o) { super(u, o); this.keyChain = { getKeyset: () => ({ hasKeys: true }) }; }
    };
    c.Mint = c.Wallet;
    c.hasValidDleq = (p) => verdict(p);
    return c;
  };

  await test('a proof whose DLEQ fails is kept, and the mint is reported', async () => {
    const { load } = require('./harness');
    const ctx = load({ cashu: dleqStub(p => p.dleq.ok) });
    await ctx.W.connect('https://m.test', { remember: true });
    let told = null;
    ctx.W.onMintTrouble(t => { told = t; });
    const good = { ...proof(8), dleq: { ok: true } };
    const bad = { ...proof(16), dleq: { ok: false } };
    await ctx.W.importProofs(JSON.stringify({ proofs: [good, bad] }));
    if (!told) return 'no report for a proof whose DLEQ failed';
    if (told.invalid !== 1) return 'reported ' + told.invalid + ' invalid, wanted 1';
    return eq(await ctx.W.balanceSats(), 24, 'balance kept both proofs');
  });

  await test('proofs with valid or absent DLEQ raise nothing', async () => {
    const { load } = require('./harness');
    const ctx = load({ cashu: dleqStub(p => p.dleq.ok) });
    await ctx.W.connect('https://m.test', { remember: true });
    let told = null;
    ctx.W.onMintTrouble(t => { told = t; });
    await ctx.W.importProofs(JSON.stringify({ proofs: [{ ...proof(8), dleq: { ok: true } }, proof(4)] }));
    return told ? 'reported trouble for proofs that were fine' : null;
  });

  // ---- the seed on the phone: boot and connect -----------------------------
  //
  // A keychain read that failed was answered as "no seed"; the next thing to
  // want a seed made one, and its write replaced the real seed. And a fresh
  // install built its wallet with random secrets until a seed screen was opened.
  // The seed is the phone's now, and the same must hold of its answers.

  const WORDS = PHONE_WORDS;
  const NEW_WORDS = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

  /* A page on a phone holding `words` ('' is none), a Tor that is up, and a
   * cashu-ts that records how each wallet was built. `o` goes to load: another
   * phone (o.phone, for a relaunch) or storage. */
  function phone(words, o) {
    const { stubCashu } = require('./harness');
    const built = [];
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    cashu.Wallet = class extends Base {
      constructor(url, opts) { super(url, opts); built.push(opts || {}); }
    };
    cashu.Mint = class { constructor(url) { this.mintUrl = url; } };
    const ctx = load(Object.assign({ cashu, words }, o || {}));
    const asked = (action) => ctx.phone.asks.filter(m => m.action === action).length;
    return Object.assign(ctx, { built, asked });
  }
  // everything a page has in storage, for the next launch
  const storageOf = (ctx) => {
    const out = {};
    for (let i = 0; i < ctx.storage.length; i++) out[ctx.storage.key(i)] = ctx.storage.getItem(ctx.storage.key(i));
    return out;
  };

  await test('a new seed the phone could not make is never used to connect, and is made on a later try', async () => {
    const ctx = phone('');
    let refuse = 'Face ID or the passcode was cancelled';
    ctx.phone.hooks.refuse = m => (m.action === 'seedCreate' ? refuse : null);
    await ctx.W.seedReady();
    let refused = null;
    try { await ctx.W.connect('https://m.test', { remember: true }); } catch (e) { refused = e.message; }
    if (!refused || !/cancelled/.test(refused)) return 'connected with no seed on the phone: ' + refused;
    if (ctx.built.length) return 'a cashu-ts wallet was built with no seed on the phone';
    refuse = null;
    await ctx.W.connect('https://m.test', { remember: true });
    if (ctx.built.length !== 1) return 'the seed made on a later try did not connect';
    if (!ctx.phone.keychain.words) return 'the phone has no seed';
    return eq(ctx.asked('seedCreate'), 3, 'seedCreate asks (at boot, the refused connect, the later one)');
  });

  await test('a phone that cannot say whether it has a seed is not a wallet without one', async () => {
    const ctx = phone(WORDS);
    ctx.phone.hooks.refuse = m => (m.action === 'seedStatus' ? 'The keychain did not answer (-25308).' : null);
    await ctx.W.seedReady();
    if (ctx.W.hasSeed()) return 'hasSeed with no answer from the phone';
    let refused = null;
    try { await ctx.W.connect('https://m.test', { remember: true }); } catch (e) { refused = e.message; }
    if (!refused || !/-25308/.test(refused)) return 'connect: ' + refused;
    if (ctx.asked('seedCreate')) return 'a seed was made';
    if (ctx.built.length) return 'a cashu-ts wallet was built';
    return eq(ctx.phone.keychain.words, WORDS, 'the seed on the phone');
  });

  await test('a phone that fails once is asked again, and its seed is used', async () => {
    const ctx = phone(WORDS);
    let fails = 1;
    ctx.phone.hooks.refuse = m => (m.action === 'seedStatus' && fails-- > 0 ? 'timed out' : null);
    await ctx.W.seedReady();
    await ctx.W.connect('https://m.test', { remember: true });
    if (ctx.asked('seedStatus') !== 2) return 'asked the phone ' + ctx.asked('seedStatus') + ' times, wanted 2';
    if (ctx.asked('seedCreate')) return 'made a seed over the phone\'s';
    return ctx.built.length === 1 ? null : 'did not connect';
  });

  await test('a fresh install gets its seed before its first wallet, never random secrets', async () => {
    const ctx = phone('');
    await ctx.W.seedReady();
    await ctx.W.connect('https://m.test', { remember: true });
    if (ctx.asked('seedCreate') !== 1) return 'seedCreate asks: ' + ctx.asked('seedCreate') + ', wanted 1';
    if (!ctx.phone.keychain.words) return 'the phone has no seed';
    const opts = ctx.built[ctx.built.length - 1];
    if (!opts.bip39seed || !opts.outputDataCreator) return 'the wallet was built without the placeholder and the phone\'s creator';
    return eq(opts.secretsPolicy, 'deterministic', 'secrets policy');
  });

  await test('a seed already on the phone is used and never replaced', async () => {
    const ctx = phone(WORDS);
    await ctx.W.connect('https://m.test', { remember: true });
    if (ctx.asked('seedCreate') || ctx.asked('seedMigrate') || ctx.asked('seedAdopt')) return 'asked: ' + ctx.phone.asks.map(a => a.action).join();
    const opts = ctx.built[ctx.built.length - 1];
    return opts.bip39seed && opts.outputDataCreator ? null : 'the wallet was built without the seed';
  });

  await test('restoring typed words asks the phone to replace the seed', async () => {
    const ctx = phone(WORDS);
    await ctx.W.seedReady();
    ctx.phone.hooks.enter = () => NEW_WORDS;
    const candidate = await ctx.W.enterSeedNative();
    await ctx.W.adoptScan([], { candidate });
    if (ctx.asked('seedAdopt') !== 1) return 'seedAdopt asks: ' + ctx.asked('seedAdopt');
    return eq(ctx.phone.keychain.words, NEW_WORDS, 'the seed on the phone');
  });

  await test('a page with no bridge refuses to connect or scan, and builds no wallet on random secrets', async () => {
    const ctx = phone(WORDS, { phone: false });
    let refused = null;
    try { await ctx.W.connect('https://m.test', { remember: true }); } catch (e) { refused = e.message; }
    if (!refused || !/not running in the app/.test(refused)) return 'connect: ' + refused;
    let scan = null;
    try { await ctx.W.scanSeed(null, ['https://m.test']); } catch (e) { scan = e.message; }
    if (!scan || !/not running in the app/.test(scan)) return 'scan: ' + scan;
    if (typeof ctx.W.seedWords !== 'undefined') return 'the page still has seedWords';
    return ctx.built.length ? 'a cashu-ts wallet was built' : null;
  });

  // ---- an older install moved onto the phone, once ---------------------------

  const LEGACY = 'foxy.seed.v1';
  const OLD_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const KS = '00b4cd27d8861a44';
  const COUNTERS = 'foxy.counter.v1';
  const stamp = (ctx, key) => ctx.storage.getItem(key) || '';

  await test('migrate: words this page held go to a phone with no seed, the copy here goes, and nothing is made', async () => {
    const ctx = phone('', { storage: { [LEGACY]: OLD_WORDS, 'foxy.cashu.mint': JSON.stringify('https://m.test') } });
    await ctx.W.seedReady();
    const asks = ctx.phone.asks.map(a => a.action).join();
    if (asks !== 'seedMigrate,seedStatus') return 'boot asked: ' + asks;
    if (ctx.phone.asks[0].words !== OLD_WORDS) return 'sent: ' + ctx.phone.asks[0].words;
    if (ctx.phone.keychain.words !== OLD_WORDS) return 'the phone holds ' + ctx.phone.keychain.words;
    if (ctx.storage.getItem(LEGACY) !== null) return 'the copy here was kept';
    if (!/"migrated"/.test(stamp(ctx, LEGACY + '.toPhone'))) return 'stamp: ' + stamp(ctx, LEGACY + '.toPhone');
    await ctx.W.connect('https://m.test', { remember: true });
    if (ctx.built.length !== 1) return 'did not connect';
    const had = ctx.phone.asks.length;
    const next = phone(null, { phone: ctx.phone, storage: storageOf(ctx) });
    await next.W.seedReady();
    return eq(ctx.phone.asks.slice(had).map(a => a.action).join(), 'seedStatus', 'the next launch asked');
  });

  await test('migrate: words the phone already holds: the copy here goes, and nothing is replaced', async () => {
    const ctx = phone(OLD_WORDS, { storage: { [LEGACY]: OLD_WORDS } });
    await ctx.W.seedReady();
    if (ctx.storage.getItem(LEGACY) !== null) return 'the copy here was kept';
    if (ctx.phone.keychain.words !== OLD_WORDS || ctx.asked('seedCreate') || ctx.asked('seedAdopt')) return 'the phone\'s seed changed';
    return /"same"/.test(stamp(ctx, LEGACY + '.toPhone')) ? null : 'stamp: ' + stamp(ctx, LEGACY + '.toPhone');
  });

  await test('migrate: words that are not the phone\'s seed stay untouched, are said, and are not sent again; the phone\'s seed is the wallet\'s', async () => {
    const ctx = phone(WORDS, { storage: { [LEGACY]: OLD_WORDS } });
    const warned = [];
    const warn = ctx.window.console.warn;
    ctx.window.console.warn = (...a) => { warned.push(a.join(' ')); };
    await ctx.W.seedReady();
    ctx.window.console.warn = warn;
    if (ctx.storage.getItem(LEGACY) !== OLD_WORDS) return 'the copy here changed: ' + ctx.storage.getItem(LEGACY);
    if (ctx.phone.keychain.words !== WORDS) return 'the phone\'s seed was replaced';
    if (!warned.some(l => /not the seed on the phone/.test(l))) return 'not said: ' + JSON.stringify(warned);
    if (!/"different"/.test(stamp(ctx, LEGACY + '.toPhone'))) return 'stamp: ' + stamp(ctx, LEGACY + '.toPhone');
    await ctx.W.connect('https://m.test', { remember: true });
    if (ctx.built.length !== 1) return 'did not connect on the phone\'s seed';
    const had = ctx.phone.asks.length;
    const next = phone(null, { phone: ctx.phone, storage: storageOf(ctx) });
    await next.W.seedReady();
    if (ctx.phone.asks.slice(had).some(a => a.action === 'seedMigrate')) return 'sent again on the next launch';
    return next.storage.getItem(LEGACY) === OLD_WORDS ? null : 'the copy went on the next launch';
  });

  await test('migrate: words the phone could not take stay, and go at the next launch; with no seed there nothing is made and connect refuses', async () => {
    const ctx = phone('', { storage: { [LEGACY]: OLD_WORDS } });
    let refuse = 'Face ID or the passcode was cancelled';
    ctx.phone.hooks.refuse = m => (m.action === 'seedMigrate' ? refuse : null);
    await ctx.W.seedReady();
    let refused = null;
    try { await ctx.W.connect('https://m.test', { remember: true }); } catch (e) { refused = e.message; }
    if (!refused || !/has not taken it yet/.test(refused)) return 'connect: ' + refused;
    if (ctx.asked('seedCreate') || ctx.phone.keychain.words) return 'a seed was made while this page still held the wallet\'s words';
    if (ctx.built.length) return 'a wallet was built';
    if (ctx.storage.getItem(LEGACY) !== OLD_WORDS || ctx.storage.getItem(LEGACY + '.toPhone') !== null) return 'the copy changed, or a stamp was written';
    refuse = null;
    const next = phone(null, { phone: ctx.phone, storage: storageOf(ctx) });
    await next.W.connect('https://m.test', { remember: true });
    if (ctx.phone.keychain.words !== OLD_WORDS) return 'not sent at the next launch';
    if (next.built.length !== 1) return 'the next launch did not connect';
    return next.storage.getItem(LEGACY) === null ? null : 'the copy stayed after the phone took the words';
  });

  await test('migrate: an error with a seed already on the phone lets the wallet connect, and the words go at the next launch', async () => {
    const ctx = phone(WORDS, { storage: { [LEGACY]: WORDS } });
    let refuse = 'timed out';
    ctx.phone.hooks.refuse = m => (m.action === 'seedMigrate' ? refuse : null);
    await ctx.W.connect('https://m.test', { remember: true });
    if (ctx.built.length !== 1) return 'did not connect';
    if (ctx.storage.getItem(LEGACY) !== WORDS) return 'the copy went although the phone did not answer';
    refuse = null;
    const next = phone(null, { phone: ctx.phone, storage: storageOf(ctx) });
    await next.W.seedReady();
    return next.storage.getItem(LEGACY) === null ? null : 'the copy stayed after the phone said it has them';
  });

  await test('migrate: words that are not a seed stay, are not sent again, and do not stop the wallet', async () => {
    const ctx = phone(WORDS, { storage: { [LEGACY]: 'not a seed at all' } });
    await ctx.W.connect('https://m.test', { remember: true });
    if (ctx.built.length !== 1) return 'did not connect';
    if (ctx.storage.getItem(LEGACY) !== 'not a seed at all') return 'the copy changed';
    if (!/"invalid"/.test(stamp(ctx, LEGACY + '.toPhone'))) return 'stamp: ' + stamp(ctx, LEGACY + '.toPhone');
    const had = ctx.phone.asks.length;
    const next = phone(null, { phone: ctx.phone, storage: storageOf(ctx) });
    await next.W.seedReady();
    return ctx.phone.asks.slice(had).some(a => a.action === 'seedMigrate') ? 'sent again' : null;
  });

  await test('migrate: the page\'s counters go to the phone once, the higher per keyset, and are never written again', async () => {
    const KS1 = '01' + 'cd'.repeat(32);
    const before = JSON.stringify({ [KS]: 40, [KS1]: 7, 'I2yN+iRYfkzT': 9 });
    const ctx = phone(WORDS, { storage: { [COUNTERS]: before } });
    ctx.phone.counters.set(WORDS, new Map([[KS, 100]]));        // the phone already ahead on one keyset
    await ctx.W.seedReady();
    const sent = ctx.phone.asks.filter(a => a.action === 'countersImport');
    if (sent.length !== 1 || JSON.stringify(sent[0].counters) !== JSON.stringify({ [KS]: 40, [KS1]: 7 })) return 'sent: ' + JSON.stringify(sent.map(a => a.counters));
    const c = ctx.phone.countersNow();
    if (c[KS] !== 100 || c[KS1] !== 7) return 'the phone\'s counters: ' + JSON.stringify(c);
    await ctx.W.connect('https://m.test', { remember: true });
    const src = ctx.built[0].counterSource;
    await src.reserve(KS, 5);
    await src.advanceToAtLeast(KS1, 50);
    if (ctx.storage.getItem(COUNTERS) !== before) return 'the page wrote its counters: ' + ctx.storage.getItem(COUNTERS);
    const had = ctx.phone.asks.length;
    const next = phone(null, { phone: ctx.phone, storage: storageOf(ctx) });
    await next.W.connect('https://m.test', { remember: true });
    if (ctx.phone.asks.slice(had).some(a => a.action === 'countersImport')) return 'sent again on the next launch';
    /* A copy that changed since, as an older build installed in between writes
     * it, is offered once more; the phone takes an import once per install, and
     * its "counters were already imported" is stamped as done. */
    const older = storageOf(next);
    older[COUNTERS] = JSON.stringify({ [KS]: 400 });
    const third = phone(null, { phone: ctx.phone, storage: older });
    await third.W.seedReady();
    if (ctx.phone.countersNow()[KS] !== 105) return 'a second import was taken: ' + JSON.stringify(ctx.phone.countersNow());
    if (!/"already":true/.test(stamp(third, COUNTERS + '.sentToPhone')) || !third.W.hasSeed()) return 'stamp: ' + stamp(third, COUNTERS + '.sentToPhone');
    const had3 = ctx.phone.asks.length;
    const fourth = phone(null, { phone: ctx.phone, storage: storageOf(third) });
    await fourth.W.seedReady();
    if (ctx.phone.asks.slice(had3).some(a => a.action === 'countersImport')) return 'offered again after the phone said it had them';
    return eq(third.storage.getItem(COUNTERS), older[COUNTERS], 'the page\'s copy after offering it');
  });

  await test('migrate: counters found where the phone had no seed are not put on the new seed', async () => {
    const ctx = phone('', { storage: { [COUNTERS]: JSON.stringify({ [KS]: 900 }) } });
    await ctx.W.seedReady();
    if (ctx.asked('countersImport')) return 'sent to the new seed';
    if (ctx.phone.countersNow()[KS]) return 'the new seed\'s counter is ' + ctx.phone.countersNow()[KS];
    return /new seed/.test(stamp(ctx, COUNTERS + '.sentToPhone')) ? null : 'stamp: ' + stamp(ctx, COUNTERS + '.sentToPhone');
  });

  await test('migrate: a phone with no seed past its one-time move ("no migration here"): the copy stays, is said, boot makes a seed, and the next launch compares the words with it', async () => {
    const ctx = phone('', { storage: { [LEGACY]: OLD_WORDS }, phone: undefined });
    ctx.phone.migrationOpen = false;
    const warned = [];
    const warn = ctx.window.console.warn;
    ctx.window.console.warn = (...a) => { warned.push(a.join(' ')); };
    await ctx.W.seedReady();
    ctx.window.console.warn = warn;
    const asks = ctx.phone.asks.map(a => a.action).join();
    if (asks !== 'seedMigrate,seedStatus,seedCreate') return 'boot asked: ' + asks;
    if (ctx.storage.getItem(LEGACY) !== OLD_WORDS) return 'the copy here changed';
    if (ctx.phone.keychain.words === OLD_WORDS) return 'the phone took the words after its window closed';
    if (!warned.some(l => /no longer takes words/.test(l))) return 'not said: ' + JSON.stringify(warned);
    if (!/"closed"/.test(stamp(ctx, LEGACY + '.toPhone'))) return 'stamp: ' + stamp(ctx, LEGACY + '.toPhone');
    await ctx.W.connect('https://m.test', { remember: true });
    if (ctx.built.length !== 1) return 'did not connect on the phone\'s own seed';
    // "closed" is not final: the next launch sends the words, and the phone, which has a seed now, compares
    const had = ctx.phone.asks.length;
    const next = phone(null, { phone: ctx.phone, storage: storageOf(ctx) });
    await next.W.seedReady();
    if (next.phone.asks.slice(had).map(a => a.action).join() !== 'seedMigrate,seedStatus') return 'the next launch asked: ' + next.phone.asks.slice(had).map(a => a.action).join();
    if (!/"different"/.test(stamp(next, LEGACY + '.toPhone')) || next.storage.getItem(LEGACY) !== OLD_WORDS) return 'next launch: ' + stamp(next, LEGACY + '.toPhone');
    const had2 = ctx.phone.asks.length;
    const third = phone(null, { phone: ctx.phone, storage: storageOf(next) });
    await third.W.seedReady();
    return ctx.phone.asks.slice(had2).some(a => a.action === 'seedMigrate') ? 'sent again after the phone said different' : null;
  });

  await test('migrate: a fresh install boots with nothing to move: no words, no counters, no stamps', async () => {
    const ctx = phone('');
    await ctx.W.seedReady();
    await ctx.W.connect('https://m.test', { remember: true });
    const asks = ctx.phone.asks.map(a => a.action).join();
    if (asks !== 'seedStatus,seedCreate') return 'asked: ' + asks;
    const keys = Object.keys(storageOf(ctx)).filter(k => /seed|counter/.test(k));
    return keys.length ? 'wrote ' + keys.join(', ') : null;
  });

  /* Native seed review, M4: an old install with the seed saved and a copy in
   * the page. A cancelled Face ID fails seedMigrate and leaves its window open;
   * seedStatus finds the seed and closes it. The phone still compares at the
   * next launch, so the copy goes then. Before, that launch heard "no migration
   * here", stamped it as final, and the words stayed in the page for good. */
  await test('M4 migrate: a cancelled Face ID, then seedStatus closing the window, and the next launch still compares: the same seed\'s copy is removed', async () => {
    const ctx = phone(WORDS, { storage: { [LEGACY]: WORDS, [COUNTERS]: JSON.stringify({ [KS]: 40 }) } });
    let cancel = true;
    ctx.phone.hooks.unlock = (action) => !(cancel && action === 'seedMigrate');
    await ctx.W.connect('https://m.test', { remember: true });
    if (ctx.built.length !== 1) return 'did not connect on the phone\'s seed';
    if (ctx.phone.refusals.map(r => r.action).join() !== 'seedMigrate') return 'refusals: ' + JSON.stringify(ctx.phone.refusals);
    if (ctx.phone.migrationOpen) return 'seedStatus finding the seed left the window open';
    if (ctx.storage.getItem(LEGACY) !== WORDS || ctx.storage.getItem(LEGACY + '.toPhone') !== null) return 'the copy changed, or a stamp was written, after an error';
    // M5: the counters are the words', which were not compared yet
    if (ctx.asked('countersImport') || ctx.storage.getItem(COUNTERS + '.sentToPhone') !== null) return 'the counters were sent, or stamped, before the words were compared';
    cancel = false;
    const next = phone(null, { phone: ctx.phone, storage: storageOf(ctx) });
    await next.W.seedReady();
    if (next.storage.getItem(LEGACY) !== null) return 'the copy stayed although the phone holds the same seed: ' + stamp(next, LEGACY + '.toPhone');
    if (!/"same"/.test(stamp(next, LEGACY + '.toPhone'))) return 'stamp: ' + stamp(next, LEGACY + '.toPhone');
    return eq(ctx.phone.countersNow()[KS], 40, 'the same seed\'s counters, sent once it was compared');
  });

  await test('M4 migrate: a "closed" stamp an earlier build left while a seed is saved is not final: the phone compares, and the same seed\'s copy goes', async () => {
    const ctx = phone(WORDS, { storage: { [LEGACY]: WORDS, [LEGACY + '.toPhone']: JSON.stringify({ at: 1, answer: 'closed' }) } });
    ctx.phone.migrationOpen = false;
    await ctx.W.seedReady();
    if (ctx.asked('seedMigrate') !== 1) return 'seedMigrate asks: ' + ctx.asked('seedMigrate');
    if (ctx.storage.getItem(LEGACY) !== null) return 'the copy stayed';
    return /"same"/.test(stamp(ctx, LEGACY + '.toPhone')) ? null : 'stamp: ' + stamp(ctx, LEGACY + '.toPhone');
  });

  /* M5: words in the page that are not the phone's seed. The page's counters
   * (2,400) were theirs; put on the phone's seed (which had used 30) they would
   * make new ecash from 2,400, past where a restore of the phone's words looks. */
  await test('M5 migrate: words of a different seed leave the page\'s counters unimported, stamped as skipped with why, and new ecash starts at the phone\'s counter', async () => {
    const ctx = phone(WORDS, { storage: { [LEGACY]: OLD_WORDS, [COUNTERS]: JSON.stringify({ [KS]: 2400 }) } });
    ctx.phone.counters.set(WORDS, new Map([[KS, 30]]));
    await ctx.W.connect('https://m.test', { remember: true });
    if (ctx.asked('countersImport')) return 'another seed\'s counters were sent: ' + JSON.stringify(ctx.phone.asks.filter(a => a.action === 'countersImport'));
    if (ctx.phone.countersNow()[KS] !== 30) return 'the phone\'s counter: ' + ctx.phone.countersNow()[KS];
    const s = JSON.parse(stamp(ctx, COUNTERS + '.sentToPhone') || 'null');
    if (!s || s.sent !== JSON.stringify({ [KS]: 2400 }) || !/not the phone/.test(s.skipped || '')) return 'stamp: ' + stamp(ctx, COUNTERS + '.sentToPhone');
    const r = await ctx.built[0].counterSource.reserve(KS, 1);
    if (r.start !== 30) return 'new ecash made from counter ' + r.start + ', not the phone\'s 30';
    const had = ctx.phone.asks.length;
    const next = phone(null, { phone: ctx.phone, storage: storageOf(ctx) });
    await next.W.seedReady();
    const again = ctx.phone.asks.slice(had).map(a => a.action).join();
    return again === 'seedStatus' ? null : 'the next launch asked: ' + again;
  });

  // ---- wrong PINs -------------------------------------------------------
  //
  // The count lived in the app's memory: closing Foxy gave five fresh tries,
  // and a burst of guesses was each checked after its own delay.

  function pinPage(storage) {
    const ctx = load({ storage: storage || {} });
    const w = ctx.window;
    if (!w.TextEncoder) w.TextEncoder = require('util').TextEncoder;
    if (!w.crypto || !w.crypto.getRandomValues) {
      Object.defineProperty(w, 'crypto', { value: require('crypto').webcrypto, configurable: true });
    }
    ctx.W.PIN_ROUNDS = 5;                      // the count is under test, not the hash cost
    let now = 1000000;
    w.Date.now = () => now;
    ctx.clock = { get: () => now, set: t => { now = t; } };
    ctx.saved = () => {
      const out = {};
      for (let i = 0; i < ctx.storage.length; i++) {
        const k = ctx.storage.key(i); out[k] = ctx.storage.getItem(k);
      }
      return out;
    };
    return ctx;
  }

  await test('wrong PINs are still counted after Foxy is closed and opened', async () => {
    const first = pinPage();
    first.W.pinSet('4321');
    for (let i = 0; i < 5; i++) first.W.pinAttempt('0000');
    const second = pinPage(first.saved());          // a relaunch: same storage, new page
    second.clock.set(first.clock.get());
    const r = second.W.pinAttempt('4321');
    if (r.ok) return 'the right PIN was accepted during the wait';
    return r.locked ? null : 'expected the wait to hold after a relaunch: ' + JSON.stringify(r);
  });

  await test('during the wait a PIN is not checked, and after it the right one works', async () => {
    const ctx = pinPage();
    ctx.W.pinSet('4321');
    for (let i = 0; i < 6; i++) ctx.W.pinAttempt('0000');   // six misses: a 2s wait
    const burst = [1, 2, 3].map(() => ctx.W.pinAttempt('4321'));
    if (burst.some(r => r.ok || !r.locked)) return 'a PIN was checked during the wait: ' + JSON.stringify(burst);
    ctx.clock.set(ctx.clock.get() + 2001);
    const r = ctx.W.pinAttempt('4321');
    if (!r.ok) return 'right PIN refused after the wait: ' + JSON.stringify(r);
    const after = ctx.W.pinAttempt('0000');
    return eq(after.tries, 1, 'count after a success');
  });

  await test('a clock moved backwards does not skip the wait', async () => {
    const ctx = pinPage();
    ctx.W.pinSet('4321');
    for (let i = 0; i < 8; i++) ctx.W.pinAttempt('0000');
    ctx.clock.set(ctx.clock.get() - 3600000);
    const r = ctx.W.pinAttempt('4321');
    return r.locked ? null : 'the wait was skipped: ' + JSON.stringify(r);
  });

  await test('a clock moved forwards does not skip the wait, while the phone has not restarted', async () => {
    const ctx = pinPage();
    const perf = ctx.window.performance;
    ctx.window.__foxyUptime = { s: 5000, p: perf.now() };
    ctx.W.pinSet('4321');
    for (let i = 0; i < 8; i++) ctx.W.pinAttempt('0000');          // an 8-second wait
    ctx.clock.set(ctx.clock.get() + 24 * 3600000);                  // Settings: a day later
    const early = ctx.W.pinAttempt('4321');
    if (!early.locked) return 'the wait was skipped by moving the clock: ' + JSON.stringify(early);
    ctx.window.__foxyUptime = { s: 5009, p: perf.now() };            // nine seconds really pass
    const later = ctx.W.pinAttempt('4321');
    return later.ok ? null : 'the right PIN was refused after the wait really passed: ' + JSON.stringify(later);
  });

  await test('setting a PIN clears the count', async () => {
    const ctx = pinPage();
    ctx.W.pinSet('4321');
    for (let i = 0; i < 7; i++) ctx.W.pinAttempt('0000');
    ctx.W.pinSet('1111');
    const r = ctx.W.pinAttempt('1111');
    return r.ok ? null : 'new PIN refused: ' + JSON.stringify(r);
  });

  // ---- restore and counters, as cashu.me handles them ----------------------

  // the phone's counters for the seed it holds
  const readCounters = ctx => ctx.phone.countersNow();
  const hex = n => n.toString(16).padStart(64, '0');
  // two keysets the phone derives for (00 ids)
  const K1 = '00a1a1a1a1a1a1a1', K2 = '00b2b2b2b2b2b2b2';
  /* Words typed on the phone for RESTORE, as their candidate. A candidate is
   * walked until three batches come back empty; this wallet's own seed only to
   * 1000 past the phone's next counter. */
  const typedOnPhone = async (ctx, words) => {
    ctx.phone.hooks.enter = () => words;
    return ctx.W.enterSeedNative();
  };

  await test('adopting a scan never lowers a counter', async () => {
    const ctx = load({ storage: { [COUNTERS]: JSON.stringify({ [K1]: 500 }) } });
    await ctx.W.adoptScan([{ state: 'done', url: 'https://m.test', host: 'm.test',
                   proofs: [proof(8)], counters: { [K1]: 201, [K2]: 7 } }], { overwrite: true });
    const c = readCounters(ctx);
    if (c[K1] !== 500) return 'K1 lowered to ' + c[K1];
    return eq(c[K2], 7, 'K2 raised');
  });

  await test('counters move on even when every proof from a keyset was spent', async () => {
    const ctx = load({});
    await ctx.W.adoptScan([{ state: 'done', url: 'https://m.test', host: 'm.test', proofs: [], counters: { [K1]: 40 } }], {});
    return eq(readCounters(ctx)[K1], 40, 'counter from a fully spent keyset');
  });

  await test('restoring different words sets the old counters aside', async () => {
    const ctx = load({ storage: { [COUNTERS]: JSON.stringify({ [K1]: 900 }) } });
    const candidate = await typedOnPhone(ctx, NEW_WORDS);
    await ctx.W.adoptScan([{ state: 'done', url: 'https://m.test', host: 'm.test',
                   proofs: [proof(8)], counters: { [K2]: 5 } }], { overwrite: true, candidate });
    const c = readCounters(ctx);
    if (ctx.phone.keychain.words !== NEW_WORDS) return 'the words were not adopted';
    if (c[K1] !== undefined) return 'the old seed counter came along: ' + JSON.stringify(c);
    if (c[K2] !== 5) return 'new counters not set: ' + JSON.stringify(c);
    const aside = ctx.phone.aside.find(x => x.words === WORDS);
    if (!aside) return 'old counters not kept aside';
    return eq(aside.counters[K1], 900, 'set-aside counter');
  });

  await test('a partial scan adds to a pile instead of replacing it', async () => {
    const mine = proof(16, hex(101));
    const { W, storage } = load({ storage: { 'foxy.cashu.proofs.https://m.test': JSON.stringify([mine]) } });
    await W.adoptScan([{ state: 'done', partial: true, url: 'https://m.test', host: 'm.test',
                   proofs: [proof(8, hex(102))], counters: {} }], { overwrite: true });
    const pile = JSON.parse(storage.getItem('foxy.cashu.proofs.https://m.test'));
    return eq(pile.length, 2, 'proofs after a partial adopt');
  });

  await test('an overwrite keeps proofs the seed cannot rebuild', async () => {
    const derived = proof(16, hex(201));
    const foreign = proof(32, hex(202));
    const { W, storage } = load({ storage: {
      'foxy.cashu.proofs.https://m.test': JSON.stringify([derived, foreign]),
      'foxy.cashu.imported': JSON.stringify([foreign.secret]),
    } });
    await W.adoptScan([{ state: 'done', url: 'https://m.test', host: 'm.test',
                   proofs: [proof(8, hex(203))], counters: {} }], { overwrite: true });
    const pile = JSON.parse(storage.getItem('foxy.cashu.proofs.https://m.test')).map(p => p.secret);
    if (!pile.includes(foreign.secret)) return 'the imported proof was dropped';
    if (pile.includes(derived.secret)) return 'the rebuildable proof was not replaced';
    return eq(pile.length, 2, 'proofs after overwrite');
  });

  await test('outputs already signed: counters move on and the claim is tried once more', async () => {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    let calls = 0;
    cashu.Wallet = class extends Base {
      constructor(u, o) {
        super(u, o);
        this.keyChain = { getKeysets: () => [{ id: '00b4cd27d8861a44' }] };
      }
      mintProofsBolt11() {
        calls += 1;
        if (calls === 1) {
          const e = new Error('outputs have already been signed before'); e.code = 10002;
          return Promise.reject(e);
        }
        return Promise.resolve([proof(8)]);
      }
    };
    const ctx = load({ cashu, storage: { 'foxy.cashu.quotes': JSON.stringify([{ quote: 'q1', amount: 8 }]) } });
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.claim('q1');
    if (calls !== 2) return 'mint asked ' + calls + ' times, wanted 2';
    if (ctx.phone.lowered.length) return 'the phone was asked to move a counter down: ' + JSON.stringify(ctx.phone.lowered);
    return eq(readCounters(ctx)['00b4cd27d8861a44'] >= 10, true, 'the phone\'s counter moved on');
  });

  // ---- restore in batches, and one counter store ---------------------------

  /* A mint whose restore answers per batch start: rows[start] is what that
   * batch returns — a number of proofs, 'fail', or 'failOnce'. */
  function restoreMint(rows) {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    const calls = [];
    const failedOnce = new Set();
    cashu.Wallet = class extends Base {
      constructor(u, o) { super(u, o); this._keyChain = { getKeysets: () => [{ id: '00b4cd27d8861a44' }] }; }
      restore(start, count, cfg) {
        calls.push(start);
        const want = rows[start];
        if (want === 'fail') return Promise.reject(new Error('mint did not answer'));
        if (want === 'failOnce' && !failedOnce.has(start)) {
          failedOnce.add(start);
          return Promise.reject(new Error('mint did not answer'));
        }
        const n = typeof want === 'number' ? want : (want === 'failOnce' ? 1 : 0);
        const proofs = Array.from({ length: n }, () => proof(8));
        return Promise.resolve(n ? { proofs, lastCounterWithSignature: start + n - 1 } : { proofs: [] });
      }
    };
    const ctx = load({ cashu });
    ctx.W.RESTORE_RETRY_MS = 1;
    ctx.calls = calls;
    return ctx;
  }

  await test('restore walks batches of 100 until ten come back empty', async () => {
    const ctx = restoreMint({ 0: 2, 100: 1 });
    const rows = await ctx.W.scanSeed({ candidate: await typedOnPhone(ctx, WORDS) }, ['https://m.test']);
    const row = rows.find(r => r.state === 'done');
    if (!row) return 'no finished row: ' + JSON.stringify(rows);
    if (JSON.stringify(ctx.calls) !== '[0,100,200,300,400,500,600,700,800,900,1000,1100]') return 'batches asked: ' + JSON.stringify(ctx.calls);
    if (row.partial) return 'marked partial with nothing failing';
    if (row.counters['00b4cd27d8861a44'] !== 101) return 'counter: ' + JSON.stringify(row.counters);
    return eq(row.count, 3, 'proofs found');
  });

  await test('a restore batch that fails once is tried again and the walk finishes', async () => {
    const ctx = restoreMint({ 0: 1, 100: 'failOnce' });
    const rows = await ctx.W.scanSeed({ candidate: await typedOnPhone(ctx, WORDS) }, ['https://m.test']);
    const row = rows.find(r => r.state === 'done');
    if (!row) return 'no finished row';
    if (ctx.calls.filter(c => c === 100).length !== 2) return 'batch 100 asked ' + ctx.calls.filter(c => c === 100).length + ' times';
    if (row.partial) return 'marked partial although the retry worked';
    return eq(row.count, 2, 'proofs found');
  });

  await test('a restore batch that keeps failing marks the scan partial and keeps what it found', async () => {
    const ctx = restoreMint({ 0: 2, 100: 'fail' });
    const rows = await ctx.W.scanSeed({ candidate: await typedOnPhone(ctx, WORDS) }, ['https://m.test']);
    const row = rows.find(r => r.state === 'done');
    if (!row) return 'no finished row: ' + JSON.stringify(rows.map(r => r.state));
    if (ctx.calls.filter(c => c === 100).length !== 3) return 'batch 100 asked ' + ctx.calls.filter(c => c === 100).length + ' times, wanted 3';
    if (!row.partial) return 'not marked partial';
    if (!row.missing.includes('00b4cd27d8861a44')) return 'failed keyset not named';
    return eq(row.count, 2, 'proofs kept from before the failure');
  });

  /* Native seed review, L11: the phone derives only 00 and 01 keysets. A legacy
   * base64 keyset was asked three times, with waits, before the row was marked
   * partial with a refusal that never changes. */
  await test('L11 a legacy base64 keyset is marked partial at once, named, and never asked for', async () => {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    const calls = [];
    const OLD_ID = 'I2yN+iRYfkzT';
    cashu.Wallet = class extends Base {
      constructor(u, o) { super(u, o); this._keyChain = { getKeysets: () => [{ id: OLD_ID }, { id: '00b4cd27d8861a44' }] }; }
      restore(start, count, cfg) {
        calls.push(cfg.keysetId + '@' + start);
        const n = start === 0 ? 1 : 0;
        return Promise.resolve(n ? { proofs: [proof(8)], lastCounterWithSignature: 0 } : { proofs: [] });
      }
    };
    const ctx = load({ cashu });
    ctx.W.RESTORE_RETRY_MS = 4000;          // a retry would wait longer than this test takes
    const warned = [];
    const warn = ctx.window.console.warn;
    ctx.window.console.warn = (...a) => { warned.push(a.join(' ')); };
    const t0 = Date.now();
    const rows = await ctx.W.scanSeed({ candidate: await typedOnPhone(ctx, WORDS) }, ['https://m.test']);
    ctx.window.console.warn = warn;
    const row = rows.find(r => r.state === 'done');
    if (!row) return 'no finished row: ' + JSON.stringify(rows);
    if (Date.now() - t0 > 3000) return 'the legacy keyset was tried again';
    if (calls.some(c => c.startsWith(OLD_ID))) return 'restored: ' + calls.join();
    if (ctx.phone.asks.some(a => a.action === 'restoreSecrets' && !/^00b4/.test(a.keysetId))) return 'the phone was asked for the legacy keyset';
    if (!row.partial || JSON.stringify(row.missing) !== JSON.stringify([OLD_ID])) return 'row: ' + JSON.stringify({ partial: row.partial, missing: row.missing });
    if (!warned.some(l => /legacy \(base64\) keyset/.test(l))) return 'not said: ' + JSON.stringify(warned);
    return eq(row.count, 1, 'proofs from the 00 keyset');
  });

  await test('every wallet shares one stored counter source, with no write-back', async () => {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    const sources = [];
    let listeners = 0;
    cashu.Wallet = class extends Base {
      constructor(u, o) {
        super(u, o);
        if (o && o.counterSource) sources.push(o.counterSource);
        this.on = { countersReserved: () => { listeners++; } };
      }
    };
    const ctx = load({ cashu });
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.connect('https://m.test', { remember: true });
    if (sources.length !== 2 || sources[0] !== sources[1]) return 'wallet objects did not share a source (' + sources.length + ')';
    if (listeners) return 'a countersReserved write-back is still registered';
    const src = sources[0];
    const a = await src.reserve(K1, 5);
    const b = await src.reserve(K1, 3);
    if (a.start !== 0 || b.start !== 5) return 'reservations overlap: ' + JSON.stringify([a, b]);
    if (readCounters(ctx)[K1] !== 8) return 'not on the phone: ' + JSON.stringify(readCounters(ctx));
    await ctx.W.adoptScan([{ state: 'done', url: 'https://m.test', host: 'm.test', proofs: [], counters: { [K1]: 50 } }], {});
    const c = await src.reserve(K1, 1);
    return eq(c.start, 50, 'a counter raised by a restore, seen by an existing wallet');
  });

  await test('the shared counter source refuses to hand out a used range', async () => {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    let src = null;
    cashu.Wallet = class extends Base { constructor(u, o) { super(u, o); if (o && o.counterSource) src = o.counterSource; } };
    const ctx = load({ cashu, storage: { [COUNTERS]: JSON.stringify({ [K1]: 20 }) } });
    await ctx.W.connect('https://m.test', { remember: true });
    let refused = false;
    try { await src.reserveAt(K1, 10, 5); } catch (e) { refused = /already issued/.test(e.message); }
    if (!refused) return 'reserveAt below the next counter was allowed';
    await src.advanceToAtLeast(K1, 5);
    if (readCounters(ctx)[K1] !== 20) return 'advanceToAtLeast moved a counter down';
    const snap = await src.snapshot();
    return eq(snap[K1], 20, 'snapshot');
  });

  // ---- a report's findings: imports, piles per mint, the lock, invoices ----

  // A stand-in mint that swaps: what comes back is one fresh proof of the sum.
  const swapStub = (o = {}) => {
    const { stubCashu } = require('./harness');
    const c = stubCashu({ spent: o.spent });
    const Base = c.Wallet;
    c.Wallet = class extends Base {
      constructor(u, w) {
        super(u, w);
        if (o.dleq) this.keyChain = { getKeyset: () => ({ hasKeys: true }) };
      }
      receive(token) {
        if (o.onSwap) o.onSwap(token);
        if (o.refuse) return Promise.reject(new Error('Token already spent'));
        return Promise.resolve([proof(token.proofs.reduce((a, p) => a + p.amount, 0))]);
      }
    };
    c.Mint = c.Wallet;
    if (o.dleq) c.hasValidDleq = o.dleq;
    return c;
  };

  await test('an import is swapped at the mint, and what comes back is the seed\'s own', async () => {
    let swaps = 0;
    const ctx = load({ cashu: swapStub({ onSwap: () => { swaps += 1; } }) });
    await ctx.W.connect('https://m.test', { remember: true });
    const got = await ctx.W.importProofs(JSON.stringify({ proofs: [proof(64), proof(32)] }));
    if (swaps !== 1) return 'swapped ' + swaps + ' times, wanted 1';
    if (got !== 96) return 'import returned ' + got + ', wanted 96';
    const held = JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://m.test') || '[]');
    if (held.length !== 1 || held[0].amount !== 96) return 'held ' + JSON.stringify(held.map(p => p.amount));
    const imported = JSON.parse(ctx.storage.getItem('foxy.cashu.imported') || '[]');
    return imported.length ? 'the swapped proofs were marked imported' : null;
  });

  await test('an import the mint refuses adds nothing', async () => {
    const ctx = load({ cashu: swapStub({ refuse: true }) });
    await ctx.W.connect('https://m.test', { remember: true });
    let threw = false;
    try { await ctx.W.importProofs(JSON.stringify({ proofs: [proof(64)] })); } catch (e) { threw = true; }
    if (!threw) return 'a refused import did not fail';
    return eq(await ctx.W.balanceSats(), 0, 'balance after a refused import');
  });

  await test('an import whose DLEQ fails is refused before the mint is asked', async () => {
    let swaps = 0;
    const ctx = load({ cashu: swapStub({ dleq: p => p.dleq.ok, onSwap: () => { swaps += 1; } }) });
    await ctx.W.connect('https://m.test', { remember: true });
    let threw = false;
    try {
      await ctx.W.importProofs(JSON.stringify({ proofs: [{ ...proof(8), dleq: { ok: false } }] }));
    } catch (e) { threw = true; }
    if (!threw) return 'a forged signature was imported';
    if (swaps) return 'the mint was asked to swap a forged proof';
    return eq(await ctx.W.balanceSats(), 0, 'balance');
  });

  await test('an import with no mint connected is refused', async () => {
    const { W } = load({});
    try { await W.importProofs(JSON.stringify({ proofs: [proof(8)] })); } catch (e) { return null; }
    return 'filed proofs nothing had checked';
  });

  await test('the imported list keeps imports held at another mint', async () => {
    // pruned against the connected mint alone, it forgot these, and a later
    // reconcile there would have deleted them as rebuildable
    const other = proof(40);
    const { W, storage } = await connected({ storage: {
      'foxy.cashu.proofs.https://other.test': JSON.stringify([other]),
      'foxy.cashu.imported': JSON.stringify([other.secret]),
    } });
    await W.importProofs(JSON.stringify({ proofs: [proof(8)] }));
    const list = JSON.parse(storage.getItem('foxy.cashu.imported') || '[]');
    return list.includes(other.secret) ? null : 'the import held at another mint was forgotten';
  });

  await test('putting quarantined ecash back asks the mint first, and leaves other mints\' entries', async () => {
    const fromA = proof(16), legacy = proof(8), here = proof(4), spent = proof(2);
    const { W, storage } = await connected({ behaviour: { spent: [spent.secret] }, storage: {
      'foxy.cashu.quarantine': JSON.stringify([{ mint: 'https://a.test', proof: fromA }, legacy,
        { mint: 'https://m.test', proof: here }, { mint: 'https://m.test', proof: spent }]),
    } });
    if (W.quarantinedSats() !== 30) return 'quarantine shows ' + W.quarantinedSats() + ' sats, wanted 30';
    const r = await W.unquarantine();
    if (r.back !== 12) return 'put back ' + r.back + ', wanted 12 (the unspent entries at this mint)';
    if (r.stillSpent !== 2) return 'still spent ' + r.stillSpent + ', wanted 2';
    if (r.elsewhere !== 16) return 'elsewhere ' + r.elsewhere + ', wanted 16';
    const pile = JSON.parse(storage.getItem('foxy.cashu.proofs.https://m.test') || '[]');
    if (pile.length !== 2) return 'this mint\'s pile has ' + pile.length + ' proofs, wanted 2';
    if (storage.getItem('foxy.cashu.proofs.https://a.test')) return 'another mint\'s entry was moved without asking that mint';
    const left = W.quarantined().map(e => e.proof.secret).sort().join();
    if (left !== [fromA.secret, spent.secret].sort().join()) return 'left in quarantine: ' + left;
    return eq(W.quarantinedSats(), 16, 'still offered (the confirmed-spent entry is not)');
  });

  await test('putting ecash back waits for a payment holding the proof lock', async () => {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    let release;
    cashu.Wallet = class extends Base {
      mintProofsBolt11() { return new Promise(r => { release = () => r([proof(8)]); }); }
    };
    const back = proof(4);
    const ctx = load({ cashu, storage: {
      'foxy.cashu.quotes': JSON.stringify([{ quote: 'q1', amount: 8, mint: 'https://m.test' }]),
      'foxy.cashu.quarantine': JSON.stringify([{ mint: 'https://m.test', proof: back }]),
    } });
    await ctx.W.connect('https://m.test', { remember: true });
    const claiming = ctx.W.claim('q1');
    await new Promise(r => setTimeout(r, 20));
    let done = false;
    const putting = ctx.W.unquarantine().then(r => { done = true; return r; });
    await new Promise(r => setTimeout(r, 20));
    if (done) return 'put back while a claim held the proofs';
    release();
    await claiming;
    await putting;
    return eq(await ctx.W.balanceSats(), 12, 'balance with the claim and the put-back both kept');
  });

  await test('an import skips proofs the mint calls spent and brings in the rest', async () => {
    const live = proof(64), gone = proof(32);
    const ctx = load({ cashu: swapStub({ spent: [gone.secret] }) });
    await ctx.W.connect('https://m.test', { remember: true });
    const got = await ctx.W.importProofs(JSON.stringify({ proofs: [live, gone] }));
    return eq(got, 64, 'imported');
  });

  await test('an import where everything is spent says so', async () => {
    const gone = proof(32);
    const ctx = load({ cashu: swapStub({ spent: [gone.secret] }) });
    await ctx.W.connect('https://m.test', { remember: true });
    try { await ctx.W.importProofs(JSON.stringify({ proofs: [gone] })); } catch (e) {
      return /spent/.test(e.message) ? null : 'wrong message: ' + e.message;
    }
    return 'a fully spent backup imported';
  });

  await test('a claim switching mints mid-wait files its proofs under its own mint', async () => {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    let release;
    cashu.Wallet = class extends Base {
      mintProofsBolt11() { return new Promise(r => { release = () => r([proof(8)]); }); }
    };
    const ctx = load({ cashu, storage: {
      'foxy.cashu.quotes': JSON.stringify([{ quote: 'q1', amount: 8, mint: 'https://m.test' }]),
    } });
    await ctx.W.connect('https://m.test', { remember: true });
    const claiming = ctx.W.claim('q1');
    await new Promise(r => setTimeout(r, 20));
    await ctx.W.connect('https://b.test', { remember: true });
    release();
    await claiming;
    const atM = JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://m.test') || '[]');
    const atB = JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://b.test') || '[]');
    if (atB.length) return 'the claim filed its proofs under the mint connected afterwards';
    return eq(atM.length, 1, 'proofs under the mint that issued them');
  });

  await test('settling held payments waits for the proof lock', async () => {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    let release, checks = 0;
    cashu.Wallet = class extends Base {
      mintProofsBolt11() { return new Promise(r => { release = () => r([proof(8)]); }); }
      checkMeltQuoteBolt11() { checks += 1; return Promise.resolve({ state: 'PENDING' }); }
    };
    const ctx = load({ cashu, storage: {
      'foxy.cashu.quotes': JSON.stringify([{ quote: 'q1', amount: 8, mint: 'https://m.test' }]),
      // a fresh hold: an old PENDING one with unspent inputs is given back on connect
      'foxy.cashu.melting': JSON.stringify([{ quote: 'm1', mint: 'https://m.test', proofs: [proof(4)],
        at: Math.floor(Date.now() / 1000) }]),
    } });
    await ctx.W.connect('https://m.test', { remember: true });
    await new Promise(r => setTimeout(r, 20));
    const claiming = ctx.W.claim('q1');
    await new Promise(r => setTimeout(r, 20));
    const before = checks;
    const sweeping = ctx.W.sweepMelts();
    await new Promise(r => setTimeout(r, 20));
    if (checks !== before) return 'the sweep asked the mint while a claim held the proofs';
    release();
    await claiming;
    await sweeping;
    return checks > before ? null : 'the sweep never ran';
  });

  await test('an invoice pushed past the list\'s cap can still be claimed', async () => {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    cashu.Wallet = class extends Base { mintProofsBolt11() { return Promise.resolve([proof(8)]); } };
    const ctx = load({ cashu, storage: {
      'foxy.cashu.quotes.old': JSON.stringify([{ quote: 'q9', amount: 8, mint: 'https://m.test' }]),
    } });
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.claim('q9');
    const old = JSON.parse(ctx.storage.getItem('foxy.cashu.quotes.old') || '[]');
    if (old.length) return 'the claimed invoice is still archived';
    return eq(await ctx.W.balanceSats(), 8, 'balance after claiming an archived invoice');
  });

  // A payment whose melt errors: the quote's state decides, not the wording.
  // how the mint refuses outright: a 400 with a NUT error code, as the bridge shapes it
  const mintSaidNo = () => Object.assign(new Error('quote is already being paid'), { status: 400, code: 11006 });
  const payStub = (state, proofState, meltError) => {
    const { stubCashu } = require('./harness');
    const c = stubCashu();
    const Base = c.Wallet;
    c.Wallet = class extends Base {
      createMeltQuoteBolt11() { return Promise.resolve({ quote: 'm1', amount: 8, fee_reserve: 0 }); }
      getFeesForProofs() { return 0; }
      send(amount, have) { return Promise.resolve({ keep: [], send: have }); }
      // worded like the refusals the old text match gave the proofs back for
      meltProofsBolt11() { return Promise.reject(meltError ? meltError() : new Error('quote is already being paid')); }
      checkMeltQuoteBolt11() { return Promise.resolve({ state }); }
      // a payment really routing has its inputs PENDING at the mint
      checkProofsStates(ps) { return Promise.resolve(ps.map(() => ({ state: proofState || 'PENDING' }))); }
    };
    c.Mint = c.Wallet;
    return c;
  };
  const payWith = async (state, proofState, meltError) => {
    const ctx = load({ cashu: payStub(state, proofState, meltError), storage: {
      'foxy.cashu.proofs.https://m.test': JSON.stringify([proof(8)]),
    } });
    await ctx.W.connect('https://m.test', { remember: true });
    await new Promise(r => setTimeout(r, 20));
    let result = null, error = null;
    try { result = await ctx.W.pay('lnbc80n1test'); } catch (e) { error = e; }
    const held = JSON.parse(ctx.storage.getItem('foxy.cashu.melting') || '[]');
    const pile = JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://m.test') || '[]');
    return { result, error, held, pile };
  };

  await test('a melt error on a payment still routing keeps the ecash held', async () => {
    const r = await payWith('PENDING');
    if (!r.error || !r.error.pending) return 'not reported as pending: ' + (r.error ? r.error.message : 'it succeeded');
    if (r.pile.length) return 'proofs went back to the pile while the payment was routing';
    return eq(r.held.length, 1, 'held melts');
  });

  await test('a refused melt left PENDING by the mint, with its ecash untouched, gives the ecash back', async () => {
    // seen on testnut: quote PENDING hours after the refusal, inputs UNSPENT
    const r = await payWith('PENDING', 'UNSPENT', mintSaidNo);
    if (!r.error || r.error.pending) return 'wanted a definite failure, got ' + (r.error ? 'pending' : 'success');
    if (r.held.length) return 'the hold was not dropped';
    return eq(r.pile.length, 1, 'proofs back in the pile');
  });

  await test('a melt that never answered, left PENDING with its ecash untouched, stays held', async () => {
    const r = await payWith('PENDING', 'UNSPENT');
    if (!r.error || !r.error.pending) return 'not reported as pending: ' + (r.error ? r.error.message : 'it succeeded');
    if (r.pile.length) return 'proofs went back while the melt could still be on its way';
    return eq(r.held.length, 1, 'held melts');
  });

  const sweepWith = async (age, state = 'PENDING') => {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    cashu.Wallet = class extends Base { checkMeltQuoteBolt11() { return Promise.resolve({ state }); } };
    const held = proof(10);
    const ctx = load({ cashu, storage: {
      'foxy.cashu.melting': JSON.stringify([{ quote: 'm9', mint: 'https://m.test', proofs: [held],
        at: Math.floor(Date.now() / 1000) - age }]),
    } });
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.sweepMelts();
    return { held: JSON.parse(ctx.storage.getItem('foxy.cashu.melting') || '[]'), balance: await ctx.W.balanceSats() };
  };

  await test('the sweep gives back a hold the mint left PENDING but never spent, once it is old enough', async () => {
    const young = await sweepWith(10);
    if (!young.held.length) return 'a ten-second-old hold was given back';
    const old = await sweepWith(600);
    if (old.held.length) return 'a ten-minute-old PENDING hold with unspent inputs is still held';
    return eq(old.balance, 10, 'balance after the sweep');
  });

  await test('W4 a melt that never answered, then read UNPAID, stays held until the sweep', async () => {
    // the request may still be on its way: a retry must not be able to pay twice
    const r = await payWith('UNPAID');
    if (!r.error || !r.error.pending) return 'not reported as pending: ' + (r.error ? r.error.message : 'it succeeded');
    if (r.pile.length) return 'proofs went back while the melt could still be on its way';
    return eq(r.held.length, 1, 'held melts');
  });

  await test('W4 the sweep gives back an UNPAID hold only once it is two minutes old; FAILED at once', async () => {
    const young = await sweepWith(10, 'UNPAID');
    if (!young.held.length) return 'a ten-second-old UNPAID hold was given back';
    const old = await sweepWith(600, 'UNPAID');
    if (old.held.length) return 'a ten-minute-old UNPAID hold is still held';
    if (old.balance !== 10) return 'balance after the sweep ' + old.balance;
    const failed = await sweepWith(10, 'FAILED');
    if (failed.held.length) return 'a FAILED hold was kept';
    return eq(failed.balance, 10, 'balance after a FAILED sweep');
  });

  await test('a melt the mint refused, whose quote reads unpaid, gives the ecash back', async () => {
    const r = await payWith('UNPAID', undefined, mintSaidNo);
    if (!r.error || r.error.pending) return 'wanted a definite failure, got ' + (r.error ? 'pending' : 'success');
    if (r.held.length) return 'the hold was not dropped';
    return eq(r.pile.length, 1, 'proofs back in the pile');
  });

  await test('a melt error on a payment the mint says is paid is a payment', async () => {
    const r = await payWith('PAID');
    if (r.error) return 'threw: ' + r.error.message;
    if (r.held.length) return 'the hold was not dropped';
    return eq(r.pile.length, 0, 'proofs in the pile');
  });

  // ---- locked tokens: Foxy has no P2PK keys -------------------------------------

  // A token is base64url JSON here, so it passes unwrap() and the stub decodes it.
  const tok = (proofs, mint = 'https://m.test') =>
    'cashuB' + Buffer.from(JSON.stringify({ mint, proofs, unit: 'sat' })).toString('base64url');
  const lockedProof = (amount) => ({ ...proof(amount), secret: JSON.stringify(['P2PK', { nonce: 'ab', data: '02' + 'a'.repeat(64), tags: [] }]) });
  const receiveStub = (calls) => {
    const { stubCashu } = require('./harness');
    const c = stubCashu({});
    const Base = c.Wallet;
    c.Wallet = class extends Base {
      receive(...args) { calls.push(args); return Promise.resolve([proof(8)]); }
    };
    c.Mint = c.Wallet;
    c.getDecodedToken = (t) => JSON.parse(Buffer.from(String(t).slice(6), 'base64url').toString());
    c.getEncodedToken = (t) => t;
    return c;
  };

  await test('a token locked to a key is refused before the mint is asked', async () => {
    const calls = [];
    const ctx = load({ cashu: receiveStub(calls) });
    await ctx.W.connect('https://m.test', { remember: true });
    try { await ctx.W.receiveToken(tok([lockedProof(8)])); } catch (e) {
      if (!/locked to/.test(e.message)) return 'wrong message: ' + e.message;
      return calls.length ? 'the mint was asked to swap a locked token' : null;
    }
    return 'a locked token was received';
  });

  /* ---- P2PK: a lock this phone asked for, and one it did not -------------
   *
   * A token locked to somebody else stays refused, exactly as it always was.
   * The only thing that changed is that a lock THIS phone put in its own
   * payment request can now be opened, with the key it kept for that request.
   */
  const keyPair = () => {
    const { stubCashu } = require('./harness');
    const c = stubCashu({});
    void c;
    const priv = 'ab'.repeat(32);
    return { priv, pub: '02' + 'b'.repeat(64) };
  };

  await test('a locked token is still refused when no key was kept for it', async () => {
    const calls = [];
    const ctx = load({ cashu: receiveStub(calls) });
    await ctx.W.connect('https://m.test', { remember: true });
    let err = null;
    try { await ctx.W.receiveToken(tok([lockedProof(8)])); } catch (e) { err = e; }
    if (!err || !/locked to/.test(err.message)) return 'a locked token with no key was taken';
    return calls.length ? 'the mint was asked to swap it' : null;
  });

  await test('a locked token is refused when the key kept is for another lock', async () => {
    const calls = [];
    const ctx = load({ cashu: receiveStub(calls) });
    await ctx.W.connect('https://m.test', { remember: true });
    // the proof is locked to 02aaa…; this key is not that one
    let err = null;
    try {
      await ctx.W.receiveToken(tok([lockedProof(8)]), { unlockWith: 'cd'.repeat(32) });
    } catch (e) { err = e; }
    if (!err || !/locked to/.test(err.message)) return 'a lock belonging to somebody else was opened';
    return calls.length ? 'the mint was asked to swap it' : null;
  });

  await test('a token half locked to us is refused whole, not half claimed', async () => {
    const ctx = load({ cashu: receiveStub([]) });
    await ctx.W.connect('https://m.test', { remember: true });
    /* Two different locks in one token. Whatever key is offered, at most one of
     * them can name it, so this must be refused rather than half-claimed —
     * the guard asks that EVERY proof is locked to the key we hold. */
    const other = { ...proof(8), secret: JSON.stringify(['P2PK', { nonce: 'cd', data: '03' + 'c'.repeat(64), tags: [] }]) };
    let err = null;
    try { await ctx.W.receiveToken(tok([lockedProof(8), other]), { unlockWith: 'ab'.repeat(32) }); } catch (e) { err = e; }
    return err && /locked to/.test(err.message) ? null : 'a token with two different locks was claimed';
  });

  await test('reclaiming a locked token is refused; a plain one is a plain receive', async () => {
    const calls = [];
    const ctx = load({ cashu: receiveStub(calls) });
    await ctx.W.connect('https://m.test', { remember: true });
    let refused = false;
    try { await ctx.W.reclaimToken(tok([lockedProof(8)])); } catch (e) { refused = /locked to/.test(e.message); }
    if (!refused) return 'a locked token was not refused';
    if (calls.length) return 'the mint was asked about a locked token';
    const r = await ctx.W.reclaimToken(tok([proof(8)]));
    if (calls.length !== 1) return 'receive called ' + calls.length + ' times';
    if (calls[0].length !== 1) return 'receive was given ' + calls[0].length + ' arguments (a key?), wanted 1';
    return eq(r.sats, 8, 'reclaimed');
  });

  await test('a token Foxy sends carries no lock', async () => {
    const { stubCashu } = require('./harness');
    const c = stubCashu({});
    const Base = c.Wallet;
    let args = null;
    c.Wallet = class extends Base {
      getFeesForProofs() { return 0; }
      send(...a) { args = a; return Promise.resolve({ keep: [], send: a[1] }); }
    };
    c.Mint = c.Wallet;
    c.getEncodedToken = () => 'cashuBsent';
    // a 16 for 8 sats: a swap (an exact 8 would go as it is, with no swap to lock)
    const ctx = load({ cashu: c, storage: {
      'foxy.cashu.proofs.https://m.test': JSON.stringify([proof(16)]),
    } });
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.sendToken(8);
    if (!args) return 'send was never called';
    return args.length === 3 ? null : 'send was given ' + args.length + ' arguments (an output shape?), wanted 3';
  });

  await test('an import leaves out locked proofs and brings in the plain ones', async () => {
    const ctx = load({ cashu: swapStub({}) });
    await ctx.W.connect('https://m.test', { remember: true });
    const got = await ctx.W.importProofs(JSON.stringify({ proofs: [proof(64), lockedProof(32)] }));
    return eq(got, 64, 'imported');
  });

  await test('the custom P2PK scheme is gone', async () => {
    const { W } = load({});
    const left = ['p2pkKey', 'p2pkPub', 'p2pkPriv', 'p2pkLegacy', 'nextRefundKey', 'refundKeyFor', 'tokenLock', 'paymentCode']
      .filter(n => typeof W[n] !== 'undefined');
    return left.length ? 'still there: ' + left.join(', ') : null;
  });

  // ---- notifications ---------------------------------------------------------

  await test('a notification names a kind, and nothing else is sent', async () => {
    const sent = [];
    const { W } = load({ bridge: (w, m) => { if (m.action === 'notify') sent.push(m); } });
    const results = [W.notify('sent'), W.notify('received'), W.notify('you received 0.05 BTC'), W.notify()];
    if (results.join() !== 'true,true,false,false') return 'notify returned ' + results.join();
    if (sent.length !== 2) return 'posted ' + sent.length + ' notifications, wanted 2';
    if (sent.some(m => 'text' in m || 'title' in m)) return 'a notification carried page text';
    return eq(sent.map(m => m.kind).join(), 'sent,received', 'kinds');
  });

  // ---- signed mint quotes (NUT-20) ---------------------------------------------

  const nut20Stub = (supports, log) => {
    const { stubCashu } = require('./harness');
    const c = stubCashu({});
    const Base = c.Wallet;
    c.Wallet = class extends Base {
      getMintInfo() { return { isSupported: (n) => ({ supported: supports && n === 20 }) }; }
      createLockedMintQuote(amount, pubkey) { log.push(['locked', amount, pubkey]); return Promise.resolve({ quote: 'q20', request: 'lnbc80n1locked', pubkey, expiry: 9999999999 }); }
      createMintQuoteBolt11(amount) { log.push(['plain', amount]); return Promise.resolve({ quote: 'q0', request: 'lnbc80n1plain', expiry: 9999999999 }); }
      mintProofsBolt11(amount, quote, config) { log.push(['mint', amount, quote, config]); return Promise.resolve([proof(amount)]); }
    };
    c.Mint = c.Wallet;
    c.createRandomSecretKey = () => new Uint8Array(32).fill(1);
    c.getPubKeyFromPrivKey = () => Uint8Array.from([2].concat(new Array(32).fill(0xab)));
    return c;
  };

  await test('an invoice at a mint with NUT-20 is locked, its key stored with it, and the claim signs', async () => {
    const log = [];
    const ctx = load({ cashu: nut20Stub(true, log) });
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.invoice(8);
    const created = log.find(l => l[0] === 'locked' || l[0] === 'plain');
    if (!created || created[0] !== 'locked') return 'the quote was not locked: ' + JSON.stringify(created);
    const q = JSON.parse(ctx.storage.getItem('foxy.cashu.quotes') || '[]')[0] || {};
    if (q.pubkey !== '02' + 'ab'.repeat(32)) return 'pubkey not stored with the quote: ' + q.pubkey;
    if (q.privkey !== '01'.repeat(32)) return 'private key not stored with the quote';
    await ctx.W.claim('q20');
    const minted = log.find(l => l[0] === 'mint');
    if (!minted) return 'never claimed';
    if (typeof minted[2] !== 'object' || minted[2].pubkey !== q.pubkey) return 'claimed without the quote\'s pubkey';
    return minted[3] && minted[3].privkey === q.privkey ? null : 'claimed without signing';
  });

  await test('an invoice at a mint without NUT-20 is unlocked, as before', async () => {
    const log = [];
    const ctx = load({ cashu: nut20Stub(false, log) });
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.invoice(8);
    if (!log.some(l => l[0] === 'plain') || log.some(l => l[0] === 'locked')) return 'wrong quote kind: ' + JSON.stringify(log);
    const q = JSON.parse(ctx.storage.getItem('foxy.cashu.quotes') || '[]')[0] || {};
    if (q.privkey) return 'a key was stored for an unlocked quote';
    await ctx.W.claim('q0');
    const minted = log.find(l => l[0] === 'mint');
    return minted && minted[2] === 'q0' && !minted[3] ? null : 'the claim was not a plain one: ' + JSON.stringify(minted);
  });

  await test('an interrupted mint switch finishes with its quote\'s key', async () => {
    const log = [];
    const lock = { pubkey: '02' + 'cd'.repeat(32), privkey: '07'.repeat(32) };
    const ctx = load({ cashu: nut20Stub(true, log), storage: {
      'foxy.cashu.move': JSON.stringify({ to: 'https://m.test', from: 'https://a.test', quote: 'q7', amount: 8, lock }),
    } });
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.finishMove();
    const minted = log.find(l => l[0] === 'mint' && (l[2] === 'q7' || (l[2] && l[2].quote === 'q7')));
    if (!minted) return 'the move was not claimed';
    return minted[3] && minted[3].privkey === lock.privkey ? null : 'claimed without the move note\'s key';
  });

  // ---- used counters, as each mint says it -------------------------------------

  const usedStub = (fails, extra = {}) => {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    const seen = { calls: 0, checks: 0 };
    cashu.Wallet = class extends Base {
      constructor(u, o) {
        super(u, o);
        this.keyChain = { getKeysets: () => [{ id: '00b4cd27d8861a44' }] };
        this.counters = { peekNext: async () => 3, advanceToAtLeast: async () => {} };
      }
      mintProofsBolt11() {
        seen.calls += 1;
        if (seen.calls <= fails.length) return Promise.reject(fails[seen.calls - 1]);
        return Promise.resolve([proof(8)]);
      }
      checkMintQuoteBolt11() { seen.checks += 1; return Promise.resolve({ state: extra.quoteState || 'PAID' }); }
    };
    cashu.Mint = cashu.Wallet;
    return { cashu, seen };
  };
  const mintErr = (code, message) => { const e = new Error(message); e.code = code; return e; };
  const claimWith = async (fails, extra) => {
    const { cashu, seen } = usedStub(fails, extra);
    const ctx = load({ cashu, storage: { 'foxy.cashu.quotes': JSON.stringify([{ quote: 'q1', amount: 8 }]) } });
    await ctx.W.connect('https://m.test', { remember: true });
    let error = null;
    try { await ctx.W.claim('q1'); } catch (e) { error = e; }
    return { seen, error, counter: readCounters(ctx)['00b4cd27d8861a44'] || 0 };
  };

  await test('CDK\'s "Duplicate outputs" moves the counters on and tries again', async () => {
    const r = await claimWith([mintErr(11008, 'Duplicate outputs')]);
    if (r.error) return 'failed: ' + r.error.message;
    return eq(r.seen.calls, 2, 'mint asked');
  });

  await test('Nutshell\'s 11003 and 11004 are used counters too', async () => {
    const r = await claimWith([mintErr(11003, 'outputs already signed'), mintErr(11004, 'outputs are pending')]);
    if (r.error) return 'failed: ' + r.error.message;
    return eq(r.seen.calls, 3, 'mint asked');
  });

  await test('a longer run of used counters: 10, then 50, then 100, then it gives up', async () => {
    const used = () => mintErr(11008, 'Duplicate outputs');
    const ok = await claimWith([used(), used(), used()]);
    if (ok.error) return 'three used ranges should still claim: ' + ok.error.message;
    if (ok.counter < 160) return 'counter moved to ' + ok.counter + ', wanted at least 160';
    const gaveUp = await claimWith([used(), used(), used(), used()]);
    if (!gaveUp.error) return 'kept retrying past three skips';
    return eq(gaveUp.seen.calls, 4, 'mint asked before giving up');
  });

  await test('counters move on at most 160 per keyset in a session, so a restore still reaches what follows', async () => {
    const used = () => mintErr(11008, 'Duplicate outputs');
    const { cashu, seen } = usedStub([used(), used(), used(), used(), used()]);
    const ctx = load({ cashu, storage: { 'foxy.cashu.quotes': JSON.stringify([{ quote: 'q1', amount: 8 }, { quote: 'q2', amount: 8 }]) } });
    await ctx.W.connect('https://m.test', { remember: true });
    try { await ctx.W.claim('q1'); } catch (e) {}          // 10, 50, 100, then the fourth refusal stands
    const first = readCounters(ctx)['00b4cd27d8861a44'] || 0;
    let error = null;
    try { await ctx.W.claim('q2'); } catch (e) { error = e; }
    const second = readCounters(ctx)['00b4cd27d8861a44'] || 0;
    if (!error) return 'the second claim should have failed on used counters';
    if (second !== first) return 'counters moved again past the budget: ' + first + ' -> ' + second;
    return eq(seen.calls, 5, 'mint asked');
  });

  await test('CDK\'s 20006 on a claim is used counters while the quote is PAID, and final once it is ISSUED', async () => {
    const paid = await claimWith([mintErr(20006, 'Invoice already paid or pending')], { quoteState: 'PAID' });
    if (paid.error) return 'a PAID quote was not retried: ' + paid.error.message;
    if (!paid.seen.checks) return 'the quote state was not asked';
    const issued = await claimWith([mintErr(20006, 'Invoice already paid or pending')], { quoteState: 'ISSUED' });
    if (!issued.error) return 'an ISSUED quote was claimed again';
    return eq(issued.seen.calls, 1, 'mint asked for an ISSUED quote');
  });

  // ---- mint errors over the bridge -------------------------------------------

  await test('a mint refusal over the bridge is the error cashu-ts throws, with its code', async () => {
    class HttpResponseError extends Error { constructor(m, status) { super(m); this.status = status; this.name = 'HttpResponseError'; } }
    class MintOperationError extends HttpResponseError { constructor(code, detail) { super(detail, 400); this.code = code; this.name = 'MintOperationError'; } }
    let answer = '';
    const { W } = load({
      cashu: { MintOperationError, HttpResponseError },
      bridge: (win, m) => { if (m.action === 'mintRequest') setTimeout(() => win.FoxyWallet._scanResult(m.id, answer, null), 0); },
    });
    const ask = async (text) => {
      answer = text;
      try { await W.nativeRequest({ endpoint: 'https://m.test/v1/mint/bolt11', method: 'POST', requestBody: { a: 1 } }); } catch (e) { return e; }
      return null;
    };
    const sig = await ask('400\n{"code":20008,"detail":"Signature for mint request invalid"}');
    if (!(sig instanceof MintOperationError)) return 'a coded refusal was not a MintOperationError: ' + (sig && sig.name);
    if (sig.code !== 20008 || sig.status !== 400) return 'code ' + sig.code + ' status ' + sig.status;
    if (!sig.body || sig.body.code !== 20008) return 'the body did not ride along';
    const down = await ask('502\n{"error":"bad gateway"}');
    if (!(down instanceof HttpResponseError) || down instanceof MintOperationError) return 'a 502 was ' + (down && down.name);
    return eq(down.status, 502, 'status');
  });

  // ---- a paid invoice that will not claim, and a mint's invalid signatures ------

  const claimStub = (o) => {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    const seen = { mints: 0, checks: 0, sends: 0 };
    cashu.Wallet = class extends Base {
      checkMintQuoteBolt11() {
        seen.checks += 1;
        return o.checkFails ? Promise.reject(new Error('Load failed')) : Promise.resolve({ state: 'PAID' });
      }
      mintProofsBolt11() { seen.mints += 1; return Promise.reject(new Error(o.mintError)); }
      getFeesForProofs() { return 0; }
      send() { seen.sends += 1; return Promise.reject(new Error(o.sendError || 'no')); }
    };
    cashu.Mint = cashu.Wallet;
    return { cashu, seen };
  };
  const stuckCtx = async (o) => {
    const { cashu, seen } = claimStub(o);
    const ctx = load({ cashu, storage: Object.assign({
      'foxy.cashu.quotes': JSON.stringify([{ quote: 'q5', amount: 21, mint: 'https://m.test' }]),
    }, o.storage || {}) });
    const told = { claim: [], mint: [] };
    ctx.W.onClaimTrouble(h => told.claim.push(h));
    ctx.W.onMintTrouble(t => told.mint.push(t));
    await ctx.W.connect('https://m.test', { remember: true });
    await new Promise(r => setTimeout(r, 30));
    return { ctx, seen, told };
  };

  await test('a paid invoice whose claim fails is recorded and announced, with why', async () => {
    const { ctx, told } = await stuckCtx({ mintError: 'The mint answered 500.' });
    await ctx.W.sweepQuotes();
    const stuck = ctx.W.stuckInvoices();
    if (stuck.length !== 1) return 'stuck invoices: ' + stuck.length;
    const u = stuck[0].unclaimed;
    if (!u.reason || !u.tries || !u.since) return 'not recorded fully: ' + JSON.stringify(u);
    if (u.badSignatures) return 'a 500 was taken for invalid signatures';
    return told.claim.length ? null : 'the app was not told';
  });

  /* CLAIM_TRIES_MAX bounds the counter ranges a mint is asked to sign and
   * never does. A claim that was never sent asked for none, and ten of those
   * across badly-timed wakes used to file a PAID invoice as given up — money
   * left sitting at the mint with Foxy no longer asking for it. Both directions are pinned: the refusals that mean
   * nothing was sent are free, and everything else still costs. */
  await test('a claim that was never sent does not spend one of the ten tries', async () => {
    const { ctx } = await stuckCtx({ mintError: 'Foxy is not connected to Tor.' });
    for (let i = 0; i < 12; i++) await ctx.W.sweepQuotes();
    const stuck = ctx.W.stuckInvoices();
    if (stuck.length !== 1) return 'stuck invoices: ' + stuck.length;
    const u = stuck[0].unclaimed;
    if (u.tries) return 'a claim that never left the phone cost ' + u.tries + ' tries';
    if (u.gaveUp) return 'Foxy stopped asking after failures that asked nothing: ' + u.gaveUp;
    return u.reason ? null : 'the reason was not recorded';
  });

  await test('a claim the mint never answered still spends one, and stops at ten', async () => {
    const { ctx } = await stuckCtx({ mintError: 'mintRequest did not answer.' });
    for (let i = 0; i < 12; i++) await ctx.W.sweepQuotes();
    const u = (ctx.W.stuckInvoices()[0] || {}).unclaimed || {};
    if (!u.tries) return 'silence cost nothing';
    return u.gaveUp === 'silence' ? null : 'gaveUp was ' + JSON.stringify(u.gaveUp)
      + ' after ' + u.tries + ' tries';
  });

  await test('an unpaid invoice checked while offline is not "paid, not collected"', async () => {
    const { ctx } = await stuckCtx({ checkFails: true, mintError: 'unused' });
    await ctx.W.sweepQuotes();
    return eq(ctx.W.stuckInvoices().length, 0, 'stuck invoices');
  });

  await test('a mint\'s invalid signatures on a claim are said once and never asked again', async () => {
    const { ctx, seen, told } = await stuckCtx({ mintError: 'DLEQ verification failed on mint response' });
    await ctx.W.sweepQuotes();
    const stuck = ctx.W.stuckInvoices();
    if (!stuck.length || !stuck[0].unclaimed.badSignatures) return 'not marked: ' + JSON.stringify(stuck);
    if (!told.mint.some(t => t.badSignatures && t.where === 'claim')) return 'the app was not told: ' + JSON.stringify(told.mint);
    const asked = seen.mints;
    let refused = false;
    try { await ctx.W.claim('q5'); } catch (e) { refused = /invalid signatures/.test(e.message); }
    if (!refused) return 'a second claim was not refused';
    await ctx.W.sweepQuotes();
    if (seen.mints !== asked) return 'the mint was asked again (' + seen.mints + ' times)';
    return eq(told.mint.filter(t => t.badSignatures).length, 1, 'times told');
  });

  await test('invalid signatures on a swap are reported, not retried', async () => {
    const { ctx, seen, told } = await stuckCtx({
      mintError: 'unused', sendError: 'DLEQ verification failed on mint response',
      storage: { 'foxy.cashu.quotes': '[]', 'foxy.cashu.proofs.https://m.test': JSON.stringify([proof(8)]) },
    });
    try { await ctx.W.sendToken(4); } catch (e) { /* expected */ }
    if (seen.sends !== 1) return 'send was tried ' + seen.sends + ' times';
    return told.mint.some(t => t.badSignatures && t.where === 'swap') ? null : 'not reported: ' + JSON.stringify(told.mint);
  });

  // ---- the price: one request at a time ---------------------------------------

  await test('callers asking for the price at once share one request', async () => {
    let asked = 0;
    const { W } = load({ bridge: (win, m) => {
      if (m.action !== 'price') return;
      asked += 1;
      setTimeout(() => win.FoxyWallet._scanResult(m.id, '77000', null), 30);
    } });
    W._privacy({ tor: 'up', progress: 100, everUp: true });
    const got = await Promise.all([W.rate(), W.rate({ fresh: true }), W.rate(), W.rate({ fresh: true }), W.rate(), W.rate()]);
    if (got.some(n => n !== 77000)) return 'answers: ' + got.join(',');
    if (asked !== 1) return 'the native side was asked ' + asked + ' times, wanted 1';
    await W.rate();                          // cached for a minute: no new request
    if (asked !== 1) return 'a cached price was fetched again';
    await W.rate({ fresh: true });           // a fresh one after the first settled: a new request
    return eq(asked, 2, 'requests after a later fresh ask');
  });

  await test('no price is asked for while the app is in the background', async () => {
    let asked = 0;
    const { W, window: win } = load({ bridge: (w, m) => {
      if (m.action !== 'price') return;
      asked += 1;
      setTimeout(() => w.FoxyWallet._scanResult(m.id, '77000', null), 10);
    } });
    W._privacy({ tor: 'up', progress: 100, everUp: true });
    let hidden = true;
    Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    let refused = false;
    try { await W.rate(); } catch (e) { refused = /background/.test(e.message); }
    if (!refused || asked) return 'asked while hidden with no price yet (asked ' + asked + ')';
    hidden = false;
    await W.rate({ fresh: true });
    hidden = true;
    const kept = await W.rate({ fresh: true });
    if (asked !== 1) return 'asked ' + asked + ' times, wanted 1 (none while hidden)';
    return eq(kept, 77000, 'the last price while hidden');
  });

  // ---- a melt's change when its answer was lost ----------------------------------

  const changeStub = (log) => {
    const { stubCashu } = require('./harness');
    const c = stubCashu();
    const Base = c.Wallet;
    const ref = { storage: null };
    c.Wallet = class extends Base {
      constructor(u, o) {
        super(u, o);
        this.keyChain = { getKeysets: () => [{ id: '00b4cd27d8861a44' }] };
        // cashu-ts's event: every counter reservation, as { keysetId, start, count, next }
        this.reserved = new Set();
        this.on = { countersReserved: (fn) => { this.reserved.add(fn); return () => this.reserved.delete(fn); } };
      }
      createMeltQuoteBolt11() { return Promise.resolve({ quote: 'm1', amount: 8, fee_reserve: 4 }); }
      getFeesForProofs() { return 0; }
      send(amount, have) { return Promise.resolve({ keep: [], send: have }); }
      meltProofsBolt11() {
        // the melt reserves its change outputs on the phone and says so, then the answer is lost
        return this.opts.counterSource.reserve('00b4cd27d8861a44', 3).then(({ start }) => {
          this.reserved.forEach(fn => fn({ keysetId: '00b4cd27d8861a44', start, count: 3, next: start + 3 }));
          throw new Error('Load failed');
        });
      }
      checkMeltQuoteBolt11() {
        return Promise.resolve({ state: 'PAID', change: [{ id: '00b4cd27d8861a44', amount: 2, C_: '02' + 'ab'.repeat(32) }] });
      }
      restore(start, count, cfg) {
        log.push([start, count, cfg && cfg.keysetId]);
        return Promise.resolve({ proofs: [proof(2)] });
      }
    };
    c.Mint = c.Wallet;
    return { cashu: c, ref };
  };

  await test('a melt found PAID later gets its change back from the counters it reserved', async () => {
    const log = [];
    const { cashu, ref } = changeStub(log);
    // 12 in: amount 8 and a reserve of 4, with no split fee, so the fee is 12 - 8 - change
    const ctx = load({ cashu, storage: {
      'foxy.cashu.proofs.https://m.test': JSON.stringify([proof(12)]),
      'foxy.counter.v1': JSON.stringify({ '00b4cd27d8861a44': 10 }),
    } });
    ref.storage = ctx.storage;
    await ctx.W.connect('https://m.test', { remember: true });
    await new Promise(r => setTimeout(r, 20));
    const res = await ctx.W.pay('lnbc80n1test');
    if (!log.length) return 'no restore of the change counters';
    if (log[0][0] !== 10 || log[0][1] !== 3) return 'restored ' + JSON.stringify(log[0]) + ', wanted from 10, 3 counters';
    const pile = JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://m.test') || '[]');
    if (sumOf(pile) !== 2) return 'pile holds ' + sumOf(pile) + ' sats, wanted the 2 sats of change';
    return eq(res.feeSats, 2, 'fee after the change came back');
  });

  await test('the sweep settles a PAID held melt with its change restored', async () => {
    const log = [];
    const { cashu, ref } = changeStub(log);
    const held = proof(12);
    const ctx = load({ cashu, storage: {
      'foxy.counter.v1': JSON.stringify({ '00b4cd27d8861a44': 7 }),
      'foxy.cashu.melting': JSON.stringify([{ quote: 'm1', mint: 'https://m.test', proofs: [held], amount: 8,
        feeReserve: 4, at: Math.floor(Date.now() / 1000) - 5, outputs: [{ keysetId: '00b4cd27d8861a44', start: 5, count: 2 }] }]),
    } });
    ref.storage = ctx.storage;
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.sweepMelts();
    if (!log.some(l => l[0] === 5 && l[1] === 2)) return 'restore calls: ' + JSON.stringify(log);
    const pile = JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://m.test') || '[]');
    if (!pile.length) return 'the change was not kept';
    return eq(JSON.parse(ctx.storage.getItem('foxy.cashu.melting') || '[]').length, 0, 'holds left');
  });

  await test('a held melt at another mint is settled from wherever the phone is, with its change', async () => {
    /* A payment carried home is melted at the payer's mint and the phone goes
     * back to its own. A melt cut short there used to be "left alone" until
     * the phone was next connected to that mint (tools/live/tap-scenarios.js
     * F17): its entry unwritten and the unused reserve uncollected. */
    const log = [];
    const { cashu, ref } = changeStub(log);
    const ctx = load({ cashu, storage: {
      'foxy.counter.v1': JSON.stringify({ '00b4cd27d8861a44': 7 }),
      'foxy.cashu.melting': JSON.stringify([{ quote: 'm1', mint: 'https://away.test', proofs: [proof(12)], amount: 8,
        feeReserve: 4, at: Math.floor(Date.now() / 1000) - 5, outputs: [{ keysetId: '00b4cd27d8861a44', start: 5, count: 2 }] }]),
    } });
    ref.storage = ctx.storage;
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.sweepMelts();
    if (ctx.W.mintUrl.replace(/\/+$/, '') !== 'https://m.test') return 'the phone was moved to ' + ctx.W.mintUrl;
    if (JSON.parse(ctx.storage.getItem('foxy.cashu.melting') || '[]').length) return 'the hold at the other mint was left alone';
    if (!log.some(l => l[0] === 5 && l[1] === 2)) return 'its change was not restored: ' + JSON.stringify(log);
    const there = JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://away.test') || '[]');
    if (!there.length) return 'the change was not kept at the mint it belongs to';
    if (JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://m.test') || '[]').length) return 'the change was put in the wrong mint\'s pile';
    const row = JSON.parse(ctx.storage.getItem('foxy.cashu.log') || '[]').find(e => e.hash === 'm1');
    if (!row || row.dir !== 'out') return 'no entry for the payment';
    return eq(String(row.mint).replace(/\/+$/, ''), 'https://away.test', 'the mint on its entry');
  });

  await test('a paid held melt whose change cannot be restored yet stays held', async () => {
    const log = [];
    const { cashu, ref } = changeStub(log);
    const Base = cashu.Wallet;
    cashu.Wallet = class extends Base { restore() { return Promise.reject(new Error('Load failed')); } };
    const ctx = load({ cashu, storage: {
      'foxy.counter.v1': JSON.stringify({ '00b4cd27d8861a44': 7 }),
      'foxy.cashu.melting': JSON.stringify([{ quote: 'm1', mint: 'https://m.test', proofs: [proof(12)], amount: 8,
        feeReserve: 4, at: Math.floor(Date.now() / 1000) - 5, outputs: [{ keysetId: '00b4cd27d8861a44', start: 5, count: 2 }] }]),
    } });
    ref.storage = ctx.storage;
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.sweepMelts();
    if (JSON.parse(ctx.storage.getItem('foxy.cashu.log') || '[]').some(e => e.hash === 'm1')) return 'the payment was written with its change lost';
    return eq(JSON.parse(ctx.storage.getItem('foxy.cashu.melting') || '[]').length, 1, 'holds left');
  });

  await test('a melt that did not go still cost its split, and that is counted once', async () => {
    /* The pile is split for the melt before the melt is asked for, and that
     * swap is paid for whatever happens next (tap-scenarios.js F11: 2 sats
     * gone on no entry). With no payment to carry it, it goes to the tally
     * the audit card counts. */
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    cashu.Wallet = class extends Base { checkMeltQuoteBolt11() { return Promise.resolve({ state: 'FAILED' }); } };
    const ctx = load({ cashu, storage: {
      'foxy.cashu.melting': JSON.stringify([{ quote: 'm9', mint: 'https://m.test', proofs: [proof(10)], splitFee: 2,
        at: Math.floor(Date.now() / 1000) - 10 }]),
    } });
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.sweepMelts();
    if (JSON.parse(ctx.storage.getItem('foxy.cashu.melting') || '[]').length) return 'the FAILED hold was kept';
    if ((await ctx.W.balanceSats()) !== 10) return 'the pieces did not come back';
    if (ctx.W.topUpFeeSats() !== 2) return 'the split\'s fee is on no entry and in no tally: ' + ctx.W.topUpFeeSats();
    await ctx.W.sweepMelts();
    return eq(ctx.W.topUpFeeSats(), 2, 'the fee after a second sweep');
  });

  await test('a late change restore asks only for the melt\'s own outputs, never a token sent after it', async () => {
    const log = [];
    const { cashu, ref } = changeStub(log);
    const ctx = load({ cashu, storage: {
      // counters 7 to 18 went to a token sent after the payment was held
      'foxy.counter.v1': JSON.stringify({ '00b4cd27d8861a44': 19 }),
      'foxy.cashu.melting': JSON.stringify([{ quote: 'm1', mint: 'https://m.test', proofs: [proof(12)], amount: 8,
        feeReserve: 4, at: Math.floor(Date.now() / 1000) - 5, outputs: [{ keysetId: '00b4cd27d8861a44', start: 5, count: 2 }] }]),
    } });
    ref.storage = ctx.storage;
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.sweepMelts();
    const asked = JSON.stringify(log.map(l => [l[0], l[1]]));
    return asked === '[[5,2]]' ? null : 'restore calls: ' + asked + ', wanted only [[5,2]]';
  });

  /* Holds written before `outputs` was recorded carry `counters`, the snapshot
   * taken just before meltProofsBolt11. cashu-ts 4.10.1's prepareMelt makes
   * max(bitlength(inputs - amount - 1), 1) NUT-08 blanks on the bound keyset,
   * reserved right after that snapshot: 12 in for 8 is 4 over, so 2 blanks. */
  const legacyStub = (signed, log) => {
    const { cashu, ref } = changeStub(log);
    const Base = cashu.Wallet;
    cashu.Wallet = class extends Base {
      restore(start, count, cfg) {
        log.push([start, count, cfg && cfg.keysetId]);
        const proofs = [];
        for (let k = start; k < start + count; k++) if (signed[k]) proofs.push(signed[k]);
        return Promise.resolve({ proofs });
      }
    };
    cashu.Mint = cashu.Wallet;
    return { cashu, ref };
  };
  const legacyHold = (over) => JSON.stringify([Object.assign({ quote: 'm1', mint: 'https://m.test', proofs: [proof(12)], amount: 8,
    feeReserve: 4, at: Math.floor(Date.now() / 1000) - 5, counters: { '00b4cd27d8861a44': 5 } }, over || {})]);

  await test('an older hold restores exactly the melt\'s blank outputs from its snapshot, and settles', async () => {
    const log = [];
    const change = proof(2);
    const { cashu, ref } = legacyStub({ 5: change }, log);
    const ctx = load({ cashu, storage: {
      'foxy.counter.v1': JSON.stringify({ '00b4cd27d8861a44': 19 }),
      'foxy.cashu.melting': legacyHold(),
    } });
    ref.storage = ctx.storage;
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.sweepMelts();
    const asked = JSON.stringify(log.map(l => [l[0], l[1], l[2]]));
    if (asked !== '[[5,2,"00b4cd27d8861a44"]]') return 'restore calls: ' + asked + ', wanted only [[5,2,keyset]]';
    const pile = JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://m.test') || '[]');
    if (pile.length !== 1 || pile[0].secret !== change.secret) return 'pile: ' + JSON.stringify(pile.map(p => p.amount));
    return eq(JSON.parse(ctx.storage.getItem('foxy.cashu.melting') || '[]').length, 0, 'holds left');
  });

  await test('an older hold\'s change restore never takes a token sent right after the melt\'s range', async () => {
    const log = [];
    // the melt's blanks at 5 and 6 (one signed as change); a token sent after the hold at 7 and 8, unclaimed
    const change = proof(1), t1 = proof(4), t2 = proof(4);
    const { cashu, ref } = legacyStub({ 5: change, 7: t1, 8: t2 }, log);
    const ctx = load({ cashu, storage: {
      'foxy.counter.v1': JSON.stringify({ '00b4cd27d8861a44': 9 }),
      'foxy.cashu.melting': legacyHold(),
    } });
    ref.storage = ctx.storage;
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.sweepMelts();
    const pile = JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://m.test') || '[]').map(p => p.secret);
    if (pile.includes(t1.secret) || pile.includes(t2.secret)) return 'the token sent after the hold was restored as change';
    if (log.some(l => l[0] + l[1] > 7)) return 'asked for counters past the melt\'s range: ' + JSON.stringify(log);
    return pile.length === 1 && pile[0] === change.secret ? null : 'pile: ' + JSON.stringify(pile);
  });

  await test('an older hold whose range holds more than the fee reserve adds nothing, and still settles', async () => {
    const log = [];
    // counters 5 and 6 hold 8 sats: not change from a 4 sat reserve, so some other operation's
    const { cashu, ref } = legacyStub({ 5: proof(4), 6: proof(4) }, log);
    const ctx = load({ cashu, storage: {
      'foxy.counter.v1': JSON.stringify({ '00b4cd27d8861a44': 19 }),
      'foxy.cashu.melting': legacyHold(),
    } });
    ref.storage = ctx.storage;
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.sweepMelts();
    const pile = JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://m.test') || '[]');
    if (pile.length) return 'added ' + sumOf(pile) + ' sats that are more than the fee reserve';
    return eq(JSON.parse(ctx.storage.getItem('foxy.cashu.melting') || '[]').length, 0, 'holds left');
  });

  await test('an older hold whose inputs are on another keyset, or whose snapshot lacks the keyset, restores nothing', async () => {
    for (const over of [{ proofs: [{ ...proof(12), id: '00ffffffffffffff' }] }, { counters: { '00ffffffffffffff': 5 } }]) {
      const log = [];
      const { cashu, ref } = legacyStub({ 5: proof(2) }, log);
      const ctx = load({ cashu, storage: {
        'foxy.counter.v1': JSON.stringify({ '00b4cd27d8861a44': 19 }),
        'foxy.cashu.melting': legacyHold(over),
      } });
      ref.storage = ctx.storage;
      await ctx.W.connect('https://m.test', { remember: true });
      await ctx.W.sweepMelts();
      if (log.length) return 'restored for ' + JSON.stringify(Object.keys(over)) + ': ' + JSON.stringify(log);
      if (JSON.parse(ctx.storage.getItem('foxy.cashu.melting') || '[]').length) return 'the hold did not settle';
    }
    return null;
  });

  await test('a payment the melt holds records its change outputs and the lightning address, lowercased', async () => {
    const log = [];
    const { cashu, ref } = changeStub(log);
    const Base = cashu.Wallet;
    cashu.Wallet = class extends Base {
      meltProofsBolt11() {
        this.reserved.forEach(fn => fn({ keysetId: '00b4cd27d8861a44', start: 40, count: 3, next: 43 }));
        return Promise.resolve({ quote: { state: 'PENDING' } });
      }
      checkProofsStates(ps) { return Promise.resolve((ps || []).map(() => ({ state: 'PENDING' }))); }
      checkMeltQuoteBolt11() { return Promise.resolve({ state: 'PENDING' }); }
    };
    cashu.Mint = cashu.Wallet;
    const ctx = load({ cashu, storage: { 'foxy.cashu.proofs.https://m.test': JSON.stringify([proof(16)]) } });
    ref.storage = ctx.storage;
    await ctx.W.connect('https://m.test', { remember: true });
    await new Promise(r => setTimeout(r, 20));
    const res = await ctx.W.pay('lnbc80n1test', null, { payee: 'Alice@Example.com' });
    const held = ctx.W.pendingMelts();
    if (!res || !res.pending || held.length !== 1) return 'not held: ' + JSON.stringify(res) + ', holds ' + held.length;
    if (held[0].payee !== 'alice@example.com') return 'payee on the hold: ' + held[0].payee;
    return JSON.stringify(held[0].outputs) === JSON.stringify([{ keysetId: '00b4cd27d8861a44', start: 40, count: 3 }])
      ? null : 'outputs on the hold: ' + JSON.stringify(held[0].outputs);
  });

  await test('a claim does not erase an invoice made while it waited on the mint', async () => {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    let release;
    cashu.Wallet = class extends Base {
      mintProofsBolt11() { return new Promise(r => { release = () => r([proof(8)]); }); }
    };
    const ctx = load({ cashu, storage: {
      'foxy.cashu.quotes': JSON.stringify([{ quote: 'q1', amount: 8, mint: 'https://m.test' }]),
    } });
    await ctx.W.connect('https://m.test', { remember: true });
    const claiming = ctx.W.claim('q1');
    await new Promise(r => setTimeout(r, 20));
    // what invoice() writes while the claim waits: a new invoice, with its key
    const list = JSON.parse(ctx.storage.getItem('foxy.cashu.quotes'));
    list.unshift({ quote: 'q2', amount: 21, mint: 'https://m.test', privkey: 'k' });
    ctx.storage.setItem('foxy.cashu.quotes', JSON.stringify(list));
    release();
    await claiming;
    const after = JSON.parse(ctx.storage.getItem('foxy.cashu.quotes') || '[]').map(q => q.quote);
    if (after.includes('q1')) return 'the claimed invoice is still listed';
    return after.includes('q2') ? null : 'the invoice made during the claim was erased: ' + JSON.stringify(after);
  });

  // ---- answers the wallet never heard: a claim, a swap -----------------------------

  /* A mint whose claim and swap answers can be lost (KS, the stub's keyset, is above). Each operation reserves
   * counters from mint.next and says so, as cashu-ts does. mint.lose says what
   * each request does next: 'drop' (the mint does it, the answer is lost),
   * 'refuse' (a coded 400), 'used' (outputs already signed), or nothing (it
   * answers). restore gives back what the mint signed at those counters. */
  const lostStub = (o = {}) => {
    const { stubCashu } = require('./harness');
    const c = stubCashu();
    const Base = c.Wallet;
    const mint = { next: o.next || 10, signed: {}, restores: [], quoteState: o.quoteState || 'UNPAID',
                   spent: new Set(), lose: (o.lose || []).slice(), restoreFails: 0 };
    const decode = (t) => (typeof t === 'string' ? JSON.parse(Buffer.from(t.slice(6), 'base64url').toString()) : t);
    const reserve = (self, amounts) => {
      const start = mint.next;
      mint.next += amounts.length;
      self.reserved.forEach(fn => fn({ keysetId: KS, start, count: amounts.length, next: mint.next }));
      return amounts.map((a, i) => ({ counter: start + i, proof: proof(a) }));
    };
    const answer = (outs, onSigned) => {
      const how = mint.lose.shift();
      const refusal = (code, m) => { const e = new Error(m); e.code = code; e.status = 400; return Promise.reject(e); };
      if (how === 'refuse') return refusal(11001, 'Token already spent');
      if (how === 'used') return refusal(11008, 'Duplicate outputs');
      outs.forEach(x => { mint.signed[x.counter] = x.proof; });
      if (onSigned) onSigned();
      if (how === 'drop') return Promise.reject(new Error('Load failed'));
      return Promise.resolve(outs.map(x => x.proof));
    };
    c.Wallet = class extends Base {
      constructor(u, w) {
        super(u, w);
        this.keyChain = { getKeysets: () => [{ id: KS }] };
        this.reserved = new Set();
        this.on = { countersReserved: (fn) => { this.reserved.add(fn); return () => this.reserved.delete(fn); } };
      }
      // o.fee(proofs): the mint's input fee on them (NUT-02); none by default
      getFeesForProofs(ps) { return o.fee ? o.fee(ps) : 0; }
      decodeToken(t) { return decode(t); }
      checkMintQuoteBolt11() { return Promise.resolve({ state: mint.quoteState }); }
      mintProofsBolt11() {
        return answer(reserve(this, o.claimAmounts || [4, 4]), () => { mint.quoteState = 'ISSUED'; });
      }
      receive(token) {
        const d = decode(token);
        return answer(reserve(this, o.receiveAmounts || [8]), () => d.proofs.forEach(p => mint.spent.add(p.secret)));
      }
      send(amount, have) {
        return answer(reserve(this, o.sendAmounts || [8, 8]), () => have.forEach(p => mint.spent.add(p.secret)))
          .then(ps => ({ send: [ps[0]], keep: ps.slice(1) }));
      }
      checkProofsStates(ps) { return Promise.resolve(ps.map(p => ({ state: mint.spent.has(p.secret) ? 'SPENT' : 'UNSPENT' }))); }
      restore(start, count, cfg) {
        mint.restores.push([start, count, cfg && cfg.keysetId]);
        if (mint.restoreFails > 0) { mint.restoreFails -= 1; return Promise.reject(new Error('Load failed')); }
        const proofs = [];
        for (let k = start; k < start + count; k++) if (mint.signed[k]) proofs.push(mint.signed[k]);
        return Promise.resolve({ proofs });
      }
    };
    c.Mint = c.Wallet;
    c.getDecodedToken = decode;
    c.getEncodedToken = (t) => 'cashuB' + Buffer.from(JSON.stringify(t)).toString('base64url');
    return { cashu: c, mint };
  };
  const lostCtx = async (o, storage) => {
    const { cashu, mint } = lostStub(o);
    const ctx = load({ cashu, storage: storage || {} });
    await ctx.W.connect('https://m.test', { remember: true });
    await new Promise(r => setTimeout(r, 20));     // connect's own sweeps
    const read = (k, d) => JSON.parse(ctx.storage.getItem(k) || d);
    return { ctx, mint, read };
  };

  await test('a claim whose answer was lost is restored from the counters it recorded, once', async () => {
    const { ctx, mint, read } = await lostCtx({ lose: ['drop'] }, {
      'foxy.cashu.quotes': JSON.stringify([{ quote: 'q1', amount: 8, mint: 'https://m.test', memo: 'lunch' }]),
    });
    mint.quoteState = 'PAID';
    let err = null;
    try { await ctx.W.claim('q1'); } catch (e) { err = e; }
    if (!err) return 'the claim did not fail';
    const rec = read('foxy.cashu.quotes', '[]')[0];
    if (!rec || JSON.stringify(rec.outputs) !== JSON.stringify([{ keysetId: KS, start: 10, count: 2 }])) {
      return 'outputs on the invoice: ' + JSON.stringify(rec && rec.outputs);
    }
    if (await ctx.W.balanceSats() !== 0) return 'balance before any recovery';
    const swept = await ctx.W.sweepQuotes();
    if (!swept.length || swept[0].sats !== 8) return 'the sweep reported ' + JSON.stringify(swept);
    if (await ctx.W.balanceSats() !== 8) return 'balance after the sweep: ' + await ctx.W.balanceSats();
    if (read('foxy.cashu.quotes', '[]').length) return 'the invoice is still on file';
    await ctx.W.sweepQuotes();
    if (await ctx.W.recoverIssued('q1') !== 0) return 'a second recovery added something';
    const log = read('foxy.cashu.log', '[]').filter(e => e.hash === 'q1');
    if (log.length !== 1 || log[0].sats !== 8 || log[0].memo !== 'lunch') return 'history: ' + JSON.stringify(log);
    const asked = JSON.stringify(mint.restores.map(r => [r[0], r[1]]));
    if (asked !== '[[10,2]]') return 'restores: ' + asked;
    return eq(await ctx.W.balanceSats(), 8, 'balance after running the recovery again');
  });

  await test('a claim refused for used counters records only the attempt the mint may have signed', async () => {
    // the refused range holds an earlier operation's outputs: restoring it would count them again
    const { ctx, mint, read } = await lostCtx({ lose: ['used', 'drop'] }, {
      'foxy.cashu.quotes': JSON.stringify([{ quote: 'q1', amount: 8, mint: 'https://m.test' }]),
    });
    mint.signed[10] = proof(4); mint.signed[11] = proof(4);    // a token sent earlier, not yet claimed
    mint.quoteState = 'PAID';
    try { await ctx.W.claim('q1'); } catch (e) { /* the second answer is lost */ }
    const rec = read('foxy.cashu.quotes', '[]')[0];
    if (!rec || JSON.stringify(rec.outputs) !== JSON.stringify([{ keysetId: KS, start: 12, count: 2 }])) {
      return 'outputs on the invoice: ' + JSON.stringify(rec && rec.outputs);
    }
    await ctx.W.sweepQuotes();
    const asked = JSON.stringify(mint.restores.map(r => [r[0], r[1]]));
    if (asked !== '[[12,2]]') return 'restores: ' + asked + ', wanted only [[12,2]]';
    return eq(await ctx.W.balanceSats(), 8, 'balance');
  });

  await test('an ISSUED invoice with no recorded outputs is dropped as before, and nothing is restored', async () => {
    const { ctx, mint, read } = await lostCtx({ quoteState: 'ISSUED' }, {
      'foxy.cashu.quotes': JSON.stringify([{ quote: 'q1', amount: 8, mint: 'https://m.test' }]),
    });
    await ctx.W.sweepQuotes();
    if (read('foxy.cashu.quotes', '[]').length) return 'the invoice is still on file';
    if (mint.restores.length) return 'restored ' + JSON.stringify(mint.restores);
    return eq(await ctx.W.balanceSats(), 0, 'balance');
  });

  await test('a received token whose swap answer was lost is taken from the counters it reserved', async () => {
    const { ctx, mint, read } = await lostCtx({ lose: ['drop'], next: 20 });
    mint.signed[15] = proof(4);          // an earlier send's token at a lower counter: never restored here
    const r = await ctx.W.receiveToken(tok([proof(8)]));
    if (!r || r.sats !== 8) return 'receive returned ' + JSON.stringify(r);
    if (read('foxy.cashu.swaps', '[]').length) return 'the swap record was not cleared';
    await ctx.W.recoverSwaps();
    const asked = JSON.stringify(mint.restores.map(x => [x[0], x[1]]));
    if (asked !== '[[20,1]]') return 'restores: ' + asked;
    if (read('foxy.cashu.log', '[]').filter(e => e.dir === 'in').length !== 1) return 'history entries: ' + ctx.storage.getItem('foxy.cashu.log');
    return eq(await ctx.W.balanceSats(), 8, 'balance');
  });

  await test('a lost swap the mint cannot be asked about yet is settled by the next sweep, once', async () => {
    const { ctx, mint, read } = await lostCtx({ lose: ['drop'], next: 20 });
    mint.restoreFails = 1;
    let err = null;
    try { await ctx.W.receiveToken(tok([proof(8)])); } catch (e) { err = e; }
    if (!err) return 'the receive did not fail';
    const kept = read('foxy.cashu.swaps', '[]');
    if (kept.length !== 1 || kept[0].kind !== 'receive' || JSON.stringify(kept[0].outputs) !== JSON.stringify([{ keysetId: KS, start: 20, count: 1 }])) {
      return 'swap record: ' + JSON.stringify(kept);
    }
    const got = await ctx.W.recoverSwaps();
    if (got.length !== 1 || got[0].amount !== 8) return 'recoverSwaps: ' + JSON.stringify(got);
    if (read('foxy.cashu.swaps', '[]').length) return 'the record was not cleared';
    const again = await ctx.W.recoverSwaps();
    if (again.length) return 'a second sweep recovered ' + JSON.stringify(again);
    if (read('foxy.cashu.log', '[]').filter(e => e.dir === 'in').length !== 1) return 'history entries: ' + ctx.storage.getItem('foxy.cashu.log');
    return eq(await ctx.W.balanceSats(), 8, 'balance');
  });

  await test('a swap the mint refuses leaves no record and restores nothing', async () => {
    const { ctx, mint, read } = await lostCtx({ lose: ['refuse'], next: 20 });
    try { await ctx.W.receiveToken(tok([proof(8)])); } catch (e) { /* expected */ }
    if (read('foxy.cashu.swaps', '[]').length) return 'a record was kept: ' + ctx.storage.getItem('foxy.cashu.swaps');
    await ctx.W.recoverSwaps();
    if (mint.restores.length) return 'restored ' + JSON.stringify(mint.restores);
    return eq(await ctx.W.balanceSats(), 0, 'balance');
  });

  await test('a token send whose swap answer was lost puts the outputs back and the spent inputs out', async () => {
    const held = proof(16);
    const { ctx, mint, read } = await lostCtx({ lose: ['drop'], next: 30 }, {
      'foxy.cashu.proofs.https://m.test': JSON.stringify([held]),
    });
    let err = null;
    try { await ctx.W.sendToken(8); } catch (e) { err = e; }
    if (!err || !/restored/.test(err.message)) return 'wanted a failure saying it was restored, got ' + (err ? err.message : 'a token');
    const pile = read('foxy.cashu.proofs.https://m.test', '[]');
    if (pile.some(p => p.secret === held.secret)) return 'the spent input is still in the pile';
    if (pile.length !== 2 || sumOf(pile) !== 16) return 'pile: ' + JSON.stringify(pile.map(p => p.amount));
    if (ctx.storage.getItem('foxy.cashu.outtoken')) return 'a token was recorded';
    if (read('foxy.cashu.swaps', '[]').length) return 'the swap record was not cleared';
    const asked = JSON.stringify(mint.restores.map(x => [x[0], x[1]]));
    return asked === '[[30,2]]' ? null : 'restores: ' + asked;
  });

  // ---- a lost swap's restore must add up to what the swap made ------------------------

  /* A record written before the request, as swapGuard writes it, whose ranges
   * the tests fill with whatever the mint signed there. */
  const swapRecord = (over) => JSON.stringify([Object.assign({
    id: 'receive-1', kind: 'receive', mint: 'https://m.test', unit: 'sat',
    at: Math.floor(Date.now() / 1000) - 5, amount: 8, expect: 8,
  }, over)]);

  await test('a lost receive whose counters hold a different amount from the token less its fee adds nothing, and keeps the record', async () => {
    const { ctx, read } = await lostCtx({ lose: ['drop'], next: 20, receiveAmounts: [4] });
    let err = null;
    try { await ctx.W.receiveToken(tok([proof(8)])); } catch (e) { err = e; }
    if (!err) return 'the receive did not fail';
    const kept = read('foxy.cashu.swaps', '[]');
    if (kept.length !== 1 || kept[0].expect !== 8) return 'swap record: ' + JSON.stringify(kept);
    const got = await ctx.W.recoverSwaps();
    if (got.length) return 'recoverSwaps added ' + JSON.stringify(got);
    if (read('foxy.cashu.swaps', '[]').length !== 1) return 'the record was dropped';
    return eq(await ctx.W.balanceSats(), 0, 'balance');
  });

  await test('a lost receive with an input fee takes outputs that add up to the token less the fee', async () => {
    const { ctx, read } = await lostCtx({ lose: ['drop'], next: 20, receiveAmounts: [7], fee: () => 1 });
    const r = await ctx.W.receiveToken(tok([proof(8)]));
    if (!r || r.sats !== 7) return 'receive returned ' + JSON.stringify(r);
    if (read('foxy.cashu.swaps', '[]').length) return 'the swap record was not cleared';
    return eq(await ctx.W.balanceSats(), 7, 'balance');
  });

  await test('a swap record that also points at another operation\'s range adds only the range that matches', async () => {
    const { ctx, mint, read } = await lostCtx({}, {
      'foxy.cashu.swaps': swapRecord({ outputs: [{ keysetId: KS, start: 10, count: 2 }, { keysetId: KS, start: 20, count: 1 }] }),
    });
    const stray = proof(2), mine = proof(8);
    mint.signed[10] = stray;            // a token sent earlier, not yet claimed
    mint.signed[20] = mine;
    const got = await ctx.W.recoverSwaps();
    if (got.length !== 1 || got[0].amount !== 8) return 'recoverSwaps: ' + JSON.stringify(got);
    const pile = read('foxy.cashu.proofs.https://m.test', '[]').map(p => p.secret);
    if (pile.includes(stray.secret)) return 'the other operation\'s token was added as balance';
    if (read('foxy.cashu.swaps', '[]').length) return 'the record was not cleared';
    return pile.length === 1 && pile[0] === mine.secret ? null : 'pile: ' + JSON.stringify(pile);
  });

  await test('when a stray range and the swap\'s own both add up to the amount, nothing is added', async () => {
    const { ctx, mint, read } = await lostCtx({}, {
      'foxy.cashu.swaps': swapRecord({ outputs: [{ keysetId: KS, start: 10, count: 2 }, { keysetId: KS, start: 20, count: 1 }] }),
    });
    mint.signed[10] = proof(4); mint.signed[11] = proof(4); mint.signed[20] = proof(8);
    const got = await ctx.W.recoverSwaps();
    if (got.length) return 'recoverSwaps added ' + JSON.stringify(got);
    if (read('foxy.cashu.swaps', '[]').length !== 1) return 'the record was dropped';
    return eq(await ctx.W.balanceSats(), 0, 'balance');
  });

  await test('a swap record with no amount to check (written before amounts were kept) adds nothing', async () => {
    const { ctx, mint, read } = await lostCtx({}, {
      'foxy.cashu.swaps': swapRecord({ expect: undefined, outputs: [{ keysetId: KS, start: 20, count: 1 }] }),
    });
    mint.signed[20] = proof(8);
    await ctx.W.recoverSwaps();
    if (read('foxy.cashu.swaps', '[]').length !== 1) return 'the record was dropped';
    return eq(await ctx.W.balanceSats(), 0, 'balance');
  });

  await test('a lost send whose inputs the mint never took adds nothing from its counters', async () => {
    const held = proof(16);
    const { ctx, mint, read } = await lostCtx({}, {
      'foxy.cashu.proofs.https://m.test': JSON.stringify([held]),
      'foxy.cashu.swaps': swapRecord({ id: 'send-1', kind: 'send', amount: 0, expect: undefined,
        inputs: [{ id: KS, amount: 16, secret: held.secret }], outputs: [{ keysetId: KS, start: 30, count: 2 }] }),
    });
    mint.signed[30] = proof(8); mint.signed[31] = proof(8);    // someone else's, from these counters
    const got = await ctx.W.recoverSwaps();
    if (got.length) return 'recoverSwaps added ' + JSON.stringify(got);
    const pile = read('foxy.cashu.proofs.https://m.test', '[]');
    if (pile.length !== 1 || pile[0].secret !== held.secret) return 'pile: ' + JSON.stringify(pile.map(p => p.amount));
    return eq(read('foxy.cashu.swaps', '[]').length, 1, 'records kept');
  });

  await test('a lost send is settled once its inputs read SPENT and the outputs add up to them less the fee', async () => {
    const held = proof(16);
    const { ctx, mint, read } = await lostCtx({ fee: (ps) => ps.length }, {
      'foxy.cashu.proofs.https://m.test': JSON.stringify([held]),
      'foxy.cashu.swaps': swapRecord({ id: 'send-1', kind: 'send', amount: 0, expect: undefined,
        inputs: [{ id: KS, amount: 16, secret: held.secret }], outputs: [{ keysetId: KS, start: 30, count: 2 }] }),
    });
    mint.spent.add(held.secret);
    mint.signed[30] = proof(8); mint.signed[31] = proof(7);    // 16 in, 1 sat of fee
    const got = await ctx.W.recoverSwaps();
    if (got.length !== 1 || got[0].amount !== 15) return 'recoverSwaps: ' + JSON.stringify(got);
    const pile = read('foxy.cashu.proofs.https://m.test', '[]');
    if (pile.some(p => p.secret === held.secret)) return 'the spent input is still in the pile';
    return eq(sumOf(pile), 15, 'pile');
  });

  // ---- recovered proofs are this wallet's own, not imports --------------------------

  await test('change restored for a payment that settles later is not imported, and is removed (not set aside) once spent', async () => {
    const log = [];
    const { cashu, ref } = changeStub(log);
    const Base = cashu.Wallet;
    const spent = new Set();
    cashu.Wallet = class extends Base {
      checkProofsStates(ps) { return Promise.resolve(ps.map(p => ({ state: spent.has(p.secret) ? 'SPENT' : 'UNSPENT' }))); }
    };
    cashu.Mint = cashu.Wallet;
    const ctx = load({ cashu, storage: {
      'foxy.counter.v1': JSON.stringify({ '00b4cd27d8861a44': 7 }),
      'foxy.cashu.melting': JSON.stringify([{ quote: 'm1', mint: 'https://m.test', proofs: [proof(12)], amount: 8,
        feeReserve: 4, at: Math.floor(Date.now() / 1000) - 5, outputs: [{ keysetId: '00b4cd27d8861a44', start: 5, count: 2 }] }]),
    } });
    ref.storage = ctx.storage;
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.sweepMelts();
    const pile = JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://m.test') || '[]');
    if (pile.length !== 1) return 'pile after the sweep: ' + JSON.stringify(pile.map(p => p.amount));
    const imported = JSON.parse(ctx.storage.getItem('foxy.cashu.imported') || '[]');
    if (imported.includes(pile[0].secret)) return 'the restored change was marked imported';
    spent.add(pile[0].secret);
    await ctx.W.reconcile();
    const pen = JSON.parse(ctx.storage.getItem('foxy.cashu.quarantine') || '[]');
    if (pen.length) return 'spent change was set aside as if nothing could rebuild it';
    return eq(JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://m.test') || '[]').length, 0, 'proofs after reconcile');
  });

  await test('change a payment restores after its answer was lost is not marked imported', async () => {
    const log = [];
    const { cashu, ref } = changeStub(log);
    const ctx = load({ cashu, storage: {
      'foxy.cashu.proofs.https://m.test': JSON.stringify([proof(12)]),
      'foxy.counter.v1': JSON.stringify({ '00b4cd27d8861a44': 10 }),
    } });
    ref.storage = ctx.storage;
    await ctx.W.connect('https://m.test', { remember: true });
    await new Promise(r => setTimeout(r, 20));
    await ctx.W.pay('lnbc80n1test');
    const pile = JSON.parse(ctx.storage.getItem('foxy.cashu.proofs.https://m.test') || '[]');
    if (sumOf(pile) !== 2) return 'pile holds ' + sumOf(pile);
    const imported = JSON.parse(ctx.storage.getItem('foxy.cashu.imported') || '[]');
    return pile.some(p => imported.includes(p.secret)) ? 'the restored change was marked imported' : null;
  });

  await test('a lost claim and a lost receive, recovered, are not marked imported', async () => {
    const { ctx, mint, read } = await lostCtx({ lose: ['drop', 'drop'], next: 20 }, {
      'foxy.cashu.quotes': JSON.stringify([{ quote: 'q1', amount: 8, mint: 'https://m.test' }]),
    });
    mint.quoteState = 'PAID';
    try { await ctx.W.claim('q1'); } catch (e) { /* the answer is lost */ }
    await ctx.W.sweepQuotes();
    await ctx.W.receiveToken(tok([proof(8)]));
    const pile = read('foxy.cashu.proofs.https://m.test', '[]');
    if (sumOf(pile) !== 16) return 'pile holds ' + sumOf(pile) + ', wanted 16';
    const imported = read('foxy.cashu.imported', '[]');
    return pile.some(p => imported.includes(p.secret)) ? 'recovered proofs were marked imported' : null;
  });

  await test('set-aside ecash with no record of its mint is counted apart, for the app to say so', async () => {
    const foreign = { ...proof(8), id: '00ffffffffffffff' };
    const { W } = await connected({ storage: { 'foxy.cashu.quarantine': JSON.stringify([
      foreign,                                                       // no mint, a keyset this mint does not issue
      proof(4),                                                      // no mint, this mint's keyset: it can go back
      { mint: 'https://other.test', proof: proof(16) },              // another mint's, on record
      { mint: '', proof: { ...proof(2), id: '00eeeeeeeeeeeeee' }, confirmedSpent: 1 },
    ]) } });
    if (W.quarantinedSats() !== 28) return 'quarantinedSats ' + W.quarantinedSats() + ', wanted 28';
    return eq(W.quarantinedUnknown(), 8, 'quarantinedUnknown');
  });

  // ---- a melt's fee: everything it cost beyond the amount --------------------------

  const feeStub = () => {
    const { stubCashu } = require('./harness');
    const c = stubCashu();
    const Base = c.Wallet;
    c.Wallet = class extends Base {
      createMeltQuoteBolt11() { return Promise.resolve({ quote: 'm1', amount: 8, fee_reserve: 4 }); }
      getFeesForProofs() { return 0; }
      // the split swaps 16 into 12 for the melt and 3 kept: 1 sat of input fee
      send() { return Promise.resolve({ keep: [proof(3)], send: [proof(8), proof(4)] }); }
      meltProofsBolt11() { return Promise.resolve({ state: 'PAID', change: [proof(2)] }); }
      checkMeltQuoteBolt11() { return Promise.resolve({ state: 'PAID', change: [proof(2)] }); }
    };
    c.Mint = c.Wallet;
    return c;
  };

  await test('a melt logs as its fee the inputs and the split fee, less the amount and change', async () => {
    const ctx = load({ cashu: feeStub(), storage: { 'foxy.cashu.proofs.https://m.test': JSON.stringify([proof(16)]) } });
    await ctx.W.connect('https://m.test', { remember: true });
    await new Promise(r => setTimeout(r, 20));
    const res = await ctx.W.pay('lnbc80n1test');
    // 16 held, 5 left (3 kept, 2 change), 8 paid: 3 of fee, where reserve less change said 2
    if (res.feeSats !== 3) return 'pay returned fee ' + res.feeSats + ', wanted 3';
    const log = JSON.parse(ctx.storage.getItem('foxy.cashu.log') || '[]').filter(e => e.hash === 'm1');
    if (log.length !== 1 || log[0].feeSats !== 3) return 'history: ' + JSON.stringify(log);
    const audit = JSON.parse(ctx.storage.getItem('foxy.cashu.audit') || '[]');
    if (!audit.length || audit[0].feeSats !== 3) return 'audit fee: ' + (audit[0] && audit[0].feeSats);
    return eq(await ctx.W.balanceSats(), 16 - 8 - 3, 'balance');
  });

  await test('the sweep logs a PAID held melt\'s fee the same way, split fee included', async () => {
    const ctx = load({ cashu: feeStub(), storage: {
      'foxy.cashu.melting': JSON.stringify([{ quote: 'm1', mint: 'https://m.test', proofs: [proof(12)], amount: 8,
        feeReserve: 4, splitFee: 1, at: Math.floor(Date.now() / 1000) - 5, outputs: [] }]),
    } });
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.sweepMelts();
    const log = JSON.parse(ctx.storage.getItem('foxy.cashu.log') || '[]').filter(e => e.hash === 'm1');
    if (log.length !== 1) return 'history entries for the melt: ' + log.length;
    return eq(log[0].feeSats, 3, 'fee');
  });

  // ---- quarantine, counters, invoice amounts ----------------------------------------

  await test('quarantined ecash with no mint recorded goes back only when its keyset is this mint\'s', async () => {
    const foreign = { ...proof(8), id: '00ffffffffffffff' };
    const ours = proof(4);
    const usdSpent = proof(100);
    const { W, storage } = await connected({ behaviour: { spent: [usdSpent.secret] }, storage: {
      'foxy.cashu.quarantine': JSON.stringify([foreign, ours, { mint: 'https://m.test', unit: 'usd', proof: usdSpent }]),
    } });
    const r = await W.unquarantine();
    if (r.back !== 4) return 'put back ' + r.back + ', wanted 4 (only the proof on this mint\'s keyset)';
    if (r.unknown !== 8) return 'unknown ' + r.unknown + ', wanted 8';
    const pile = JSON.parse(storage.getItem('foxy.cashu.proofs.https://m.test') || '[]');
    if (pile.some(p => p.secret === foreign.secret)) return 'a proof from an unrecorded mint was filed here';
    const left = JSON.parse(storage.getItem('foxy.cashu.quarantine'));
    if (!left.some(e => (e.proof || e).secret === foreign.secret)) return 'the foreign proof left the quarantine';
    const usd = left.find(e => e.proof && e.proof.secret === usdSpent.secret);
    if (!usd || !usd.confirmedSpent) return 'the usd entry was not marked confirmed spent';
    return eq(usd.unit, 'usd', 'unit kept on the confirmed-spent entry');
  });

  await test('the shared counter source never sets a counter lower', async () => {
    const { stubCashu } = require('./harness');
    const cashu = stubCashu();
    const Base = cashu.Wallet;
    let src = null;
    cashu.Wallet = class extends Base { constructor(u, o) { super(u, o); if (o && o.counterSource) src = o.counterSource; } };
    const ctx = load({ cashu, storage: { [COUNTERS]: JSON.stringify({ [K1]: 20 }) } });
    await ctx.W.connect('https://m.test', { remember: true });
    let refused = false;
    try { await src.setNext(K1, 5); } catch (e) { refused = /only move forward/.test(e.message); }
    if (!refused) return 'setNext below the phone\'s counter was not refused';
    if (readCounters(ctx)[K1] !== 20) return 'the counter moved to ' + readCounters(ctx)[K1];
    await src.setNext(K1, 30);
    return eq(readCounters(ctx)[K1], 30, 'counter after setNext upwards');
  });

  // an invoice-shaped string with an h field, for the description hash: timestamp,
  // then h (type 23, 52 words), then a blank 520-bit signature and a blank checksum
  const invoiceFor = (prefix, text) => {
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const hash = require('crypto').createHash('sha256').update(text, 'utf8').digest();
    const words = [];
    let acc = 0, bits = 0;
    for (const b of hash) {
      acc = (acc << 8) | b; bits += 8;
      while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); }
      acc &= (1 << bits) - 1;
    }
    if (bits) words.push((acc << (5 - bits)) & 31);
    const data = [0, 0, 0, 0, 0, 0, 0, 23, 1, 20].concat(words, new Array(104).fill(0));
    return { pr: prefix + data.map(v => CHARSET[v]).join('') + 'qqqqqq', hex: hash.toString('hex') };
  };
  const META = '[["text/plain","Pay alice"]]';

  await test('an invoice\'s description hash is read from its h field', async () => {
    const { W } = load({});
    const inv = invoiceFor('lnbc100n1', META);
    if (W.descriptionHashOf(inv.pr) !== inv.hex) return 'read ' + W.descriptionHashOf(inv.pr) + ', wanted ' + inv.hex;
    return eq(W.descriptionHashOf('lnbc100n1xyzqqqqqq'), null, 'an invoice with no h field');
  });

  await test('a lightning address invoice must match the amount asked for to the millisat', async () => {
    // a page with no bridge fetches the address itself, with the fetch below
    const { W, window: win } = load({ phone: false });
    let pr = '';
    win.fetch = async (u) => ({ ok: true, status: 200, json: async () => (/\/cb/.test(u)
      ? { pr } : { tag: 'payRequest', callback: 'https://addr.test/cb', minSendable: 1000, maxSendable: 100000000, metadata: META }) });
    if (W.msatOf('lnbc104000p1x') !== 10400) return 'msatOf 104000p: ' + W.msatOf('lnbc104000p1x');
    if (W.msatOf('lnbc105001p1x') !== null) return 'a pico amount that is not a multiple of 10 read as ' + W.msatOf('lnbc105001p1x');
    if (W.msatOf('lnbc2500u1x') !== 250000000) return 'msatOf 2500u: ' + W.msatOf('lnbc2500u1x');
    if (W.amountOf('lnbc104000p1x') !== 10) return 'this test assumes amountOf rounds 10.4 sats to 10';
    pr = 'lnbc104000p1xyz';
    let msg = '';
    try { await W.payLnurl('alice@addr.test', 10); } catch (e) { msg = e.message; }
    if (!/Not paying it/.test(msg)) return 'an invoice for 10.4 sats against 10 asked was not refused: ' + msg;
    pr = invoiceFor('lnbc100n1', META).pr;
    msg = '';
    try { await W.payLnurl('alice@addr.test', 10); } catch (e) { msg = e.message; }
    if (/Not paying it/.test(msg)) return 'an exact invoice for what the address described was refused: ' + msg;
    pr = invoiceFor('lnbc100n1', '[["text/plain","Pay mallory"]]').pr;
    msg = '';
    try { await W.payLnurl('alice@addr.test', 10); } catch (e) { msg = e.message; }
    if (!/something other than what it described/.test(msg)) return 'an invoice for other metadata was not refused: ' + msg;
    pr = 'lnbc100n1xyz';
    msg = '';
    try { await W.payLnurl('alice@addr.test', 10); } catch (e) { msg = e.message; }
    return /Not paying it/.test(msg) ? null : 'an invoice with no description hash was not refused: ' + msg;
  });

  // ---- sent tokens: forgotten once claimed, and with the history ------------------

  const sentStub = (spentSecrets) => {
    const { stubCashu } = require('./harness');
    const c = stubCashu({ spent: spentSecrets });
    c.getDecodedToken = (t) => JSON.parse(Buffer.from(String(t).slice(6), 'base64url').toString());
    return c;
  };
  const sentCtx = async (spent, extra = {}) => {
    const a = proof(8), b = proof(4), other = proof(2);
    const tokA = tok([a]), tokB = tok([b]), tokOther = tok([other], 'https://other.test');
    const ctx = load({ cashu: sentStub(spent(a, b)), storage: Object.assign({
      'foxy.txmeta': JSON.stringify({ 'token-1': { to: 'ecash', token: tokA }, 'token-2': { to: 'ecash', token: tokB, note: 'lunch' }, 'token-3': { to: 'ecash', token: tokOther } }),
      'foxy.cashu.audit': JSON.stringify([{ hash: 'token-1', kind: 'token', sats: 8, inputs: [a], outputs: [] }, { hash: 'token-2', kind: 'token', sats: 4, inputs: [b], outputs: [] }]),
      'foxy.cashu.outtoken': JSON.stringify({ token: tokA, sats: 8, mint: 'https://m.test', hash: 'token-1' }),
      'foxy.cashu.log': JSON.stringify([{ hash: 'token-1', dir: 'out', sats: 8 }]),
    }, extra) });
    await ctx.W.connect('https://m.test', { remember: true });
    await new Promise(r => setTimeout(r, 30));
    return { ctx, a, b, tokA, tokB, tokOther };
  };

  await test('a claimed token\'s text is forgotten; the other tokens stay', async () => {
    const { ctx, tokA, tokB, tokOther } = await sentCtx(() => []);
    if (!ctx.W.forgetClaimedToken(tokA)) return 'nothing was forgotten';
    const meta = JSON.parse(ctx.storage.getItem('foxy.txmeta'));
    if (meta['token-1'].token) return 'the claimed token is still in its note';
    if (meta['token-1'].to !== 'ecash') return 'the rest of the note went too';
    if (meta['token-2'].token !== tokB || meta['token-2'].note !== 'lunch') return 'the unclaimed token\'s note changed';
    if (meta['token-3'].token !== tokOther) return 'another mint\'s token was touched';
    const audit = JSON.parse(ctx.storage.getItem('foxy.cashu.audit'));
    if (audit[0].inputs.length) return 'the claimed token\'s proofs are still in the audit trail';
    if (!audit[1].inputs.length) return 'the unclaimed token\'s audit record lost its proofs';
    if (ctx.storage.getItem('foxy.cashu.outtoken')) return 'the last-token record of a claimed token stayed';
    return eq(JSON.parse(ctx.storage.getItem('foxy.cashu.log')).length, 1, 'history entries kept');
  });

  await test('clearing history clears the notes too, and keeps an unclaimed last token unless told', async () => {
    const { ctx } = await sentCtx(() => []);
    const unclaimed = await ctx.W.tokensNotClaimed();
    if (unclaimed.length !== 3) return 'tokens not claimed: ' + unclaimed.length + ', wanted 3 (two here unspent, one elsewhere)';
    ctx.W.clearHistory();
    if (Object.keys(JSON.parse(ctx.storage.getItem('foxy.txmeta'))).length) return 'the notes survived clearing history';
    if (JSON.parse(ctx.storage.getItem('foxy.cashu.audit')).length) return 'the audit trail survived';
    if (!ctx.storage.getItem('foxy.cashu.outtoken')) return 'an unclaimed last token was forgotten without asking';
    ctx.W.clearHistory({ forgetToken: true });
    return ctx.storage.getItem('foxy.cashu.outtoken') ? 'forgetToken did not forget it' : null;
  });

  await test('clearing history leaves the balance carried forward as one settled row per mint', async () => {
    const { load } = require('./harness');
    const ctx = load({ cashu: dleqStub(() => true) });
    await ctx.W.connect('https://m.test', { remember: true });
    await ctx.W.importProofs(JSON.stringify({ proofs: [{ ...proof(8), dleq: { ok: true } }, { ...proof(16), dleq: { ok: true } }] }));
    const before = await ctx.W.balanceSats();
    if (before !== 24) return 'balance before: ' + before;
    ctx.W.clearHistory();
    const log = JSON.parse(ctx.storage.getItem('foxy.cashu.log'));
    if (log.length !== 1) return 'rows left: ' + log.length + ', wanted 1';
    const row = log[0];
    if (row.memo !== 'opening' || row.dir !== 'in' || !row.settled) return 'not an opening row: ' + JSON.stringify(row);
    if (row.sats !== 24) return 'carried ' + row.sats + ', the balance was 24';
    if (row.mint !== 'https://m.test') return 'mint ' + row.mint;
    return /^opening-/.test(row.hash) ? null : 'hash ' + row.hash;
  });

  await test('change that came back and was then scanned as well is counted once, and only a scan of exactly that change', async () => {
    const { load } = require('./harness');
    const now = Math.floor(Date.now() / 1000);
    const ctx = load({ storage: { 'foxy.cashu.log': JSON.stringify([
      { hash: 'req-scan-bbb', dir: 'in', sats: 1183, at: now - 100, settled: true },   // a real, separate receive of another amount
      { hash: 'req-scan-aaa', dir: 'in', sats: 15315, at: now - 280, settled: true },  // the same change, scanned
      { hash: 'p1', dir: 'out', sats: 14138, grossSats: 29453, changeSats: 15315, changeState: 'came back', at: now - 300, settled: true },
      { hash: 'req-scan-old', dir: 'in', sats: 15315, at: now - 5000, settled: true }, // before the payment: not its change
    ]) } });
    ctx.W.repairOwedChange();
    const by = {};
    JSON.parse(ctx.storage.getItem('foxy.cashu.log')).forEach(e => { by[e.hash] = e; });
    if (by['req-scan-aaa'].state !== 'failed') return 'the scanned twin is still counted: ' + JSON.stringify(by['req-scan-aaa']);
    if (by['req-scan-bbb'].state === 'failed') return 'a different receive was dropped';
    if (by['req-scan-old'].state === 'failed') return 'an earlier receive was dropped';
    return by.p1.sats === 14138 ? null : 'the payment was touched: ' + by.p1.sats;
  });

  await test('change collected later by scanning: the payment becomes its gross and says so, once, and only for a matching receive', async () => {
    const { load } = require('./harness');
    const now = Math.floor(Date.now() / 1000);
    const ctx = load({ storage: { 'foxy.cashu.log': JSON.stringify([
      // newest first, as the log is kept
      { hash: 'r2', dir: 'in', sats: 500, at: now - 50, settled: true },
      { hash: 'r1', dir: 'in', sats: 22426, at: now - 100, settled: true },
      { hash: 'p1', dir: 'out', sats: 1180, grossSats: 23606, changeSats: 22426, changeState: 'owed', at: now - 300, settled: true },
      { hash: 'p0', dir: 'out', sats: 10, grossSats: 30, changeSats: 20, changeState: 'owed', at: now - 400, settled: true },
    ]) } });
    ctx.W.repairOwedChange();
    const by = {};
    JSON.parse(ctx.storage.getItem('foxy.cashu.log')).forEach(e => { by[e.hash] = e; });
    if (by.p1.changeState !== 'collected') return 'p1 is ' + by.p1.changeState;
    if (by.p1.sats !== 23606) return 'p1 counts ' + by.p1.sats + ', wanted its gross 23606';
    if (by.p1.changeFrom !== 'r1') return 'p1 matched ' + by.p1.changeFrom;
    if (by.p0.changeState !== 'owed' || by.p0.sats !== 10) return 'p0, with no matching receive, was touched: ' + JSON.stringify(by.p0);
    // and a second pass does not take the same receive for anything else
    ctx.W.repairOwedChange();
    const again = JSON.parse(ctx.storage.getItem('foxy.cashu.log')).filter(e => e.changeFrom === 'r1').length;
    return again === 1 ? null : 'r1 was used ' + again + ' times';
  });

  // ----------------------------------------------------------------------

  // ---- storage versions (foxy.schema) ---------------------------------

  await test('fresh storage is stamped with the current version, and a second launch leaves it', async () => {
    const first = load({});
    const v = first.storage.getItem('foxy.schema');
    if (!/^\d+$/.test(v || '') || Number(v) < 2) return 'foxy.schema is ' + v;
    const again = load({ storage: { 'foxy.schema': v } });
    return eq(again.storage.getItem('foxy.schema'), v, 'version after a second launch');
  });

  await test('an old install: flash.* keys move, a value under the new name is kept, the P2PK counter goes', async () => {
    const { storage } = load({ storage: {
      'flash.cashu.log': '[1]', 'flash.cashu.mint': '"https://old.test"', 'foxy.cashu.mint': '"https://new.test"',
      'foxy.p2pk.refundn': '3',
    } });
    if (storage.getItem('flash.cashu.log') !== null || storage.getItem('flash.cashu.mint') !== null) return 'a flash.* key is still there';
    if (storage.getItem('foxy.cashu.log') !== '[1]') return 'the log did not move';
    if (storage.getItem('foxy.cashu.mint') !== '"https://new.test"') return 'a value already under foxy.* was overwritten';
    if (storage.getItem('foxy.p2pk.refundn') !== null) return 'the P2PK refund counter is still there';
    return /^\d+$/.test(storage.getItem('foxy.schema') || '') ? null : 'no version stamped';
  });

  await test('a partly migrated install runs only the steps it has not been through', async () => {
    const { storage } = load({ storage: { 'foxy.schema': '1', 'flash.leftover': 'x', 'foxy.p2pk.refundn': '3' } });
    if (storage.getItem('foxy.p2pk.refundn') !== null) return 'step 2 did not run';
    return storage.getItem('flash.leftover') === 'x' ? null : 'step 1 ran again on an install already past it';
  });

  await test('storage from a newer Foxy is left untouched: no migration, no writes, no mint contacted', async () => {
    const { W, storage } = load({ storage: { 'foxy.schema': '999', 'flash.cashu.log': '[1]', 'foxy.p2pk.refundn': '3' } });
    if (storage.getItem('foxy.schema') !== '999') return 'the newer version number was changed';
    if (storage.getItem('flash.cashu.log') !== '[1]' || storage.getItem('foxy.p2pk.refundn') !== '3') return 'a step ran on newer storage';
    const before = JSON.stringify(Object.keys(storage).sort().map(k => [k, storage.getItem(k)]));
    let msg = '';
    try { await W.connect('https://m.test', null, null, { remember: true }); } catch (e) { msg = e && e.message; }
    if (!/newer version of Foxy/.test(msg)) return 'connect did not refuse: ' + (msg || 'it resolved');
    const after = JSON.stringify(Object.keys(storage).sort().map(k => [k, storage.getItem(k)]));
    return after === before ? null : 'storage changed after the refusal';
  });


  /* Audit: W1, W2, W3 */
  {
    const MINT = 'https://m.test';
    const OLD = WORDS;
    const NEW = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

    await test('a seed scan does not adopt proofs held by a payment or inside a sent token', async () => {
      const { stubCashu } = require('./harness');
      const held = proof(64), sent = proof(32), fresh = proof(8);
      const cashu = stubCashu();
      cashu.Wallet.prototype.checkMeltQuoteBolt11 = () => Promise.resolve({ state: 'PENDING' });
      cashu.getDecodedToken = (t) => {
        if (t === 'cashuAsent') return { mint: MINT, unit: 'sat', proofs: [sent] };
        throw new Error('not a token');
      };
      const storage = {
        'foxy.cashu.melting': JSON.stringify([{ quote: 'q1', amount: 60, proofs: [held], mint: MINT,
          at: Math.floor(Date.now() / 1000), outputs: [] }]),
        'foxy.cashu.outtoken': JSON.stringify({ token: 'cashuAsent', sats: 32, mint: MINT, hash: 'token-1' }),
      };
      const { W, storage: ls } = load({ storage, cashu });
      await W.connect(MINT);
      const row = { url: MINT, host: 'm.test', state: 'done', proofs: [held, sent, fresh], counters: {}, partial: false, units: {} };
      const res = await W.adoptScan([row], { merge: true });
      const pile = JSON.parse(ls.getItem('foxy.cashu.proofs.' + MINT) || '[]');
      if (sumOf(pile) !== 8) return 'the pile holds ' + pile.map(p => p.amount).join('+') + ' sats';
      return eq(res && res.kept && res.kept[0] && res.kept[0].added, 8, 'sats reported as added');
    });

    await test('a paid invoice the mint keeps refusing is claimed automatically three times at most, then once more by hand', async () => {
      const { stubCashu } = require('./harness');
      let asked = 0;
      const cashu = stubCashu();
      class Refusing extends cashu.Wallet {
        checkMintQuoteBolt11() { return Promise.resolve({ state: 'PAID' }); }
        mintProofsBolt11() {
          asked += 1;
          const cs = this.opts.counterSource;
          return (cs ? cs.reserve(this.keysetId, 6) : Promise.resolve()).then(() => {
            const e = new Error('quote signature invalid'); e.status = 400; e.code = 20008; throw e;
          });
        }
      }
      cashu.Wallet = Refusing; cashu.Mint = Refusing;
      const { W, storage } = load({ storage: { 'foxy.cashu.quotes': JSON.stringify([{ quote: 'qq', amount: 1000, mint: MINT, at: 1 }]) }, cashu });
      await W.connect(MINT);
      await new Promise(r => setTimeout(r, 50));
      for (let i = 0; i < 10; i++) await W.sweepQuotes();
      const q = JSON.parse(storage.getItem('foxy.cashu.quotes'))[0];
      if (asked !== 3) return 'the mint was asked ' + asked + ' times by the sweep';
      if (!(q.unclaimed && q.unclaimed.refused === 3)) return 'refusals recorded: ' + JSON.stringify(q.unclaimed);
      let again = null;
      try { await W.retryRefusedClaim('qq'); } catch (e) { again = e; }
      if (!again || asked !== 4) return 'the try by hand did not ask the mint once more (asked ' + asked + ')';
      const q2 = JSON.parse(storage.getItem('foxy.cashu.quotes'))[0];
      return eq(q2.unclaimed.refused, 1, 'refusals after the try by hand');
    });

    await test("declining the phone's Replace alert on a restore changes no counters, piles or seed", async () => {
      const { stubCashu } = require('./harness');
      const ctx = load({ storage: { 'foxy.counter.v1': JSON.stringify({ '00b4cd27d8861a44': 500 }) }, cashu: stubCashu() });
      await ctx.W.seedReady();
      const counted = JSON.stringify(ctx.phone.countersNow());
      ctx.phone.hooks.adopt = () => false;
      const candidate = await typedOnPhone(ctx, NEW);
      const row = { url: MINT, host: 'm.test', state: 'done', proofs: [proof(16)], counters: { '00b4cd27d8861a44': 3 }, partial: false, units: {} };
      let refused = null;
      try { await ctx.W.adoptScan([row], { overwrite: true, candidate }); } catch (e) { refused = e; }
      if (!refused) return 'the restore went ahead after the phone refused';
      if (JSON.stringify(ctx.phone.countersNow()) !== counted) return 'counters changed: ' + JSON.stringify(ctx.phone.countersNow());
      if (ctx.phone.asks.some(a => a.action === 'counterAdvance')) return 'counters were moved';
      if (ctx.storage.getItem('foxy.cashu.proofs.' + MINT) !== null) return 'a pile was written';
      if (ctx.phone.aside.length) return 'the old counters were set aside';
      return eq(ctx.phone.keychain.words, OLD, 'the seed on the phone');
    });
  }

  /* Audit: W5, W6, W7, and MONEY.md §6's late overwrite */
  {
    const MINT = 'https://m.test';
    const PILE = 'foxy.cashu.proofs.' + MINT;
    const { stubCashu } = require('./harness');

    /* A mint that answers a proof's state from o.states (secret -> state), or
     * not at all with o.checkFails, and swaps as cashu-ts does: counters
     * reserved from the shared source first, and only then the request. */
    const stateStub = (o = {}) => {
      const c = stubCashu();
      const seen = { sent: 0 };
      c.Wallet = class extends c.Wallet {
        checkProofsStates(ps) {
          if (o.checkFails) return Promise.reject(new Error('Load failed'));
          return Promise.resolve(ps.map(p => ({ state: (o.states || {})[p.secret] || 'UNSPENT' })));
        }
        receive() {
          const cs = this.opts.counterSource;
          return (cs ? cs.reserve(this.keysetId, 3) : Promise.resolve()).then(() => {
            seen.sent += 1;
            return [proof(8)];
          });
        }
      };
      c.Mint = c.Wallet;
      c.getDecodedToken = (t) => JSON.parse(Buffer.from(String(t).slice(6), 'base64url').toString());
      c.getEncodedToken = (t) => t;
      return { cashu: c, seen };
    };

    /* WebKit with its store full, for the keys blocked(key) names: setItem
     * throws QuotaExceededError. Returns the function that lifts it. */
    const refuseWrites = (ctx, blocked) => {
      const proto = ctx.window.Storage.prototype;
      const real = proto.setItem;
      proto.setItem = function (k, v) {
        if (blocked(String(k))) throw new ctx.window.DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return real.call(this, k, v);
      };
      return () => { proto.setItem = real; };
    };

    await test('W5 a token the mint calls spent is refused before the swap, and no counter moves', async () => {
      const spent = proof(8);
      const { cashu, seen } = stateStub({ states: { [spent.secret]: 'SPENT' } });
      const ctx = load({ cashu });
      await ctx.W.connect(MINT, { remember: true });
      const before = JSON.stringify(readCounters(ctx));
      let err = null;
      try { await ctx.W.receiveToken(tok([spent, proof(4)])); } catch (e) { err = e; }
      if (!err || !/already spent/.test(err.message)) return 'wanted "already spent", got ' + (err ? err.message : 'a receive');
      if (seen.sent) return 'the mint was asked to swap a spent token';
      if (JSON.stringify(readCounters(ctx)) !== before) return 'counters moved: ' + JSON.stringify(readCounters(ctx));
      let again = null;
      try { await ctx.W.reclaimToken(tok([spent])); } catch (e) { again = e; }
      if (!again || !/already spent/.test(again.message)) return 'reclaim: ' + (again ? again.message : 'it went ahead');
      if (seen.sent) return 'the mint was asked to swap a spent token on reclaim';
      return eq(JSON.stringify(readCounters(ctx)), before, 'counters after the reclaim');
    });

    await test('W5 a token the mint calls pending is refused, and no counter moves', async () => {
      const pending = proof(8);
      const { cashu, seen } = stateStub({ states: { [pending.secret]: 'PENDING' } });
      const ctx = load({ cashu });
      await ctx.W.connect(MINT, { remember: true });
      const before = JSON.stringify(readCounters(ctx));
      let err = null;
      try { await ctx.W.receiveToken(tok([pending])); } catch (e) { err = e; }
      if (!err || !/pending/.test(err.message)) return 'wanted a pending refusal, got ' + (err ? err.message : 'a receive');
      if (seen.sent) return 'the mint was asked to swap a pending token';
      return eq(JSON.stringify(readCounters(ctx)), before, 'counters');
    });

    await test('W5 a state check that fails still receives the token', async () => {
      const { cashu, seen } = stateStub({ checkFails: true });
      const ctx = load({ cashu });
      await ctx.W.connect(MINT, { remember: true });
      const r = await ctx.W.receiveToken(tok([proof(8)]));
      if (seen.sent !== 1) return 'swapped ' + seen.sent + ' times';
      // the counters did move for a swap that was made: this stub does reserve
      if (readCounters(ctx)[KS] !== 3) return 'counters: ' + JSON.stringify(readCounters(ctx));
      return eq(r.sats, 8, 'received');
    });

    await test('W6 a counter the phone cannot store stops the swap before it is sent', async () => {
      const { cashu, seen } = stateStub({});
      const ctx = load({ cashu });
      await ctx.W.connect(MINT, { remember: true });
      ctx.phone.hooks.refuse = m => (m.action === 'counterReserve' ? 'the counters could not be written' : null);
      let err = null;
      try { await ctx.W.receiveToken(tok([proof(8)])); } catch (e) { err = e; }
      ctx.phone.hooks.refuse = null;
      if (!err || !err.unsent || !/could not be written/.test(err.message)) return 'wanted a refusal before sending, got ' + (err ? err.message : 'a receive');
      if (seen.sent) return 'the request went out on counters that were never stored';
      if (JSON.parse(ctx.storage.getItem('foxy.cashu.swaps') || '[]').length) return 'a swap record was kept for a request never sent';
      return eq(await ctx.W.balanceSats(), 0, 'balance');
    });

    await test('W6 a received token whose proofs cannot be stored keeps its swap record, and recoverSwaps files them', async () => {
      const { ctx, read } = await lostCtx({ next: 20 });
      const release = refuseWrites(ctx, k => k === PILE);
      let err = null;
      try { await ctx.W.receiveToken(tok([proof(8)])); } catch (e) { err = e; }
      if (!err || !err.storageFull) return 'wanted a storage failure, got ' + (err ? err.message : 'a receive');
      const kept = read('foxy.cashu.swaps', '[]');
      if (kept.length !== 1 || kept[0].kind !== 'receive') return 'swap record: ' + JSON.stringify(kept);
      const early = await ctx.W.recoverSwaps();
      if (early.length || read('foxy.cashu.swaps', '[]').length !== 1) return 'settled while storage still refused: ' + JSON.stringify(early);
      release();
      const got = await ctx.W.recoverSwaps();
      if (got.length !== 1 || got[0].amount !== 8) return 'recoverSwaps: ' + JSON.stringify(got);
      if (read('foxy.cashu.swaps', '[]').length) return 'the record was not cleared';
      return eq(await ctx.W.balanceSats(), 8, 'balance');
    });

    await test('W6 a token send whose change cannot be stored makes no token, and the whole pile comes back', async () => {
      const held = proof(16);
      const { ctx, read } = await lostCtx({ next: 30 }, { [PILE]: JSON.stringify([held]) });
      const release = refuseWrites(ctx, k => k === PILE);
      let err = null;
      try { await ctx.W.sendToken(8); } catch (e) { err = e; }
      if (!err || !err.storageFull) return 'wanted a storage failure, got ' + (err ? err.message : 'a token');
      if (ctx.storage.getItem('foxy.cashu.outtoken')) return 'a token was made';
      if (read('foxy.cashu.swaps', '[]').length !== 1) return 'the swap record was not kept';
      release();
      await ctx.W.recoverSwaps();
      const pile = read(PILE, '[]');
      if (pile.some(p => p.secret === held.secret)) return 'the spent input is still in the pile';
      return eq(sumOf(pile), 16, 'pile after recovery');
    });

    await test('W6 an issued claim whose restored proofs cannot be stored keeps its record for the next sweep', async () => {
      const { ctx, mint, read } = await lostCtx({ lose: ['drop'] }, {
        'foxy.cashu.quotes': JSON.stringify([{ quote: 'q1', amount: 8, mint: MINT }]),
      });
      mint.quoteState = 'PAID';
      try { await ctx.W.claim('q1'); } catch (e) { /* the answer is lost */ }
      const release = refuseWrites(ctx, k => k === PILE);
      await ctx.W.sweepQuotes();
      const rec = read('foxy.cashu.quotes', '[]')[0];
      if (!rec || !rec.outputs || !rec.outputs.length) return 'the invoice record went while its proofs were not stored';
      release();
      await ctx.W.sweepQuotes();
      if (read('foxy.cashu.quotes', '[]').length) return 'the invoice is still on file';
      return eq(await ctx.W.balanceSats(), 8, 'balance');
    });

    await test('W6 a payment whose hold cannot be written is never sent, and the ecash stays', async () => {
      let melts = 0;
      const c = payStub('UNPAID');
      c.Wallet = class extends c.Wallet { meltProofsBolt11() { melts += 1; return super.meltProofsBolt11(); } };
      c.Mint = c.Wallet;
      const ctx = load({ cashu: c, storage: { [PILE]: JSON.stringify([proof(8)]) } });
      await ctx.W.connect(MINT, { remember: true });
      const release = refuseWrites(ctx, k => k === 'foxy.cashu.melting');
      let err = null;
      try { await ctx.W.pay('lnbc80n1test'); } catch (e) { err = e; }
      release();
      if (!err || !err.storageFull) return 'wanted a storage failure, got ' + (err ? err.message : 'a payment');
      if (melts) return 'the melt was sent with no hold on disk';
      return eq(await ctx.W.balanceSats(), 8, 'balance');
    });

    await test('W6 a paid melt whose change cannot be stored keeps its hold, and the sweep settles it', async () => {
      const c = payStub('PAID');
      c.Wallet = class extends c.Wallet { meltProofsBolt11() { return Promise.resolve({ state: 'PAID', change: [proof(2)] }); } };
      c.Mint = c.Wallet;
      const ctx = load({ cashu: c, storage: { [PILE]: JSON.stringify([proof(10)]) } });
      await ctx.W.connect(MINT, { remember: true });
      let holding = false;
      const release = refuseWrites(ctx, k => {
        if (k === 'foxy.cashu.melting') holding = true;
        return holding && k === PILE;
      });
      let err = null;
      try { await ctx.W.pay('lnbc80n1test'); } catch (e) { err = e; }
      release();
      if (!err || !err.storageFull) return 'wanted a storage failure, got ' + (err ? err.message : 'a payment');
      if (JSON.parse(ctx.storage.getItem('foxy.cashu.melting') || '[]').length !== 1) return 'the hold went although the change was not stored';
      await ctx.W.sweepMelts();
      if (JSON.parse(ctx.storage.getItem('foxy.cashu.melting') || '[]').length) return 'the sweep did not settle the hold';
      return eq(JSON.parse(ctx.storage.getItem('foxy.cashu.log') || '[]').filter(e => e.hash === 'm1').length, 1, 'payments logged');
    });

    await test('W6 adopting a scan whose counters the phone cannot store writes no pile', async () => {
      const ctx = load({});
      ctx.phone.hooks.refuse = m => (m.action === 'counterAdvance' ? 'the counters could not be written' : null);
      let err = null;
      try {
        await ctx.W.adoptScan([{ state: 'done', url: MINT, host: 'm.test', proofs: [proof(8)], counters: { [K1]: 5 } }], {});
      } catch (e) { err = e; }
      if (!err || !/could not be written/.test(err.message)) return 'wanted the phone\'s refusal, got ' + (err ? err.message : 'an adoption');
      return ctx.storage.getItem(PILE) === null ? null : 'a pile was written over counters that never moved';
    });

    await test('W7 forgetting the seed rejects when the phone keeps it, and forgets nothing', async () => {
      const ctx = load({ cashu: stubCashu() });
      await ctx.W.seedReady();
      ctx.phone.hooks.wipe = () => false;
      let refused = null;
      try { await ctx.W.seedForget(); } catch (e) { refused = e; }
      if (!refused) return 'a declined wipe resolved';
      if (!ctx.W.hasSeed() || ctx.phone.keychain.words !== WORDS) return 'the seed was forgotten while the phone kept it';
      ctx.phone.hooks.wipe = () => true;
      const r = await ctx.W.seedForget();
      if (r !== 'replaced') return 'a wipe resolved ' + r;
      return ctx.phone.keychain.words !== WORDS ? null : 'the phone still has the old seed';
    });

    await test('W7 restored proofs whose DLEQ fails are reported as they are adopted, and kept', async () => {
      const c = stubCashu();
      const good = { ...proof(8), dleq: { ok: true } };
      const bad = { ...proof(16), dleq: { ok: false } };
      c.Wallet = class extends c.Wallet {
        constructor(u, o) {
          super(u, o);
          this._keyChain = { getKeysets: () => [{ id: KS }] };
          this.keyChain = { getKeyset: () => ({ hasKeys: true }), keysets: [] };
        }
        restore(start) {
          return Promise.resolve(start === 0 ? { proofs: [good, bad], lastCounterWithSignature: 1 } : { proofs: [] });
        }
      };
      c.Mint = c.Wallet;
      c.hasValidDleq = (p) => p.dleq.ok;
      const ctx = load({ cashu: c });
      const told = [];
      ctx.W.onMintTrouble(t => told.push(t));
      const rows = await ctx.W.scanSeed({ candidate: await typedOnPhone(ctx, WORDS) }, [MINT]);
      if (told.length) return 'reported before anything was adopted';
      await ctx.W.adoptScan(rows, { overwrite: true });
      if (told.length !== 1 || told[0].invalid !== 1 || told[0].where !== 'restore' || told[0].mint !== 'm.test') {
        return 'reports: ' + JSON.stringify(told);
      }
      await ctx.W.adoptScan(rows, { merge: true });
      if (told.length !== 1) return 'reported again on a second adoption';
      return eq(sumOf(JSON.parse(ctx.storage.getItem(PILE) || '[]')), 24, 'both proofs kept');
    });

    await test('MONEY §6 a mint adopted after new words keeps the replaced seed\'s proofs', async () => {
      const oldAtA = proof(8, hex(601)), oldAtB = proof(16, hex(602));
      const ctx = load({ storage: {
        'foxy.cashu.proofs.https://a.test': JSON.stringify([oldAtA]),
        'foxy.cashu.proofs.https://b.test': JSON.stringify([oldAtB]),
      } });
      const { W, storage } = ctx;
      const candidate = await typedOnPhone(ctx, NEW_WORDS);
      await W.adoptScan([{ state: 'done', url: 'https://a.test', host: 'a.test', proofs: [proof(4, hex(603))], counters: {} }],
                        { overwrite: true, candidate });
      // b answers late, and is adopted with overwrite and no words, as the restore screen once did
      await W.adoptScan([{ state: 'done', url: 'https://b.test', host: 'b.test', proofs: [proof(2, hex(604))], counters: {} }],
                        { overwrite: true });
      const a = JSON.parse(storage.getItem('foxy.cashu.proofs.https://a.test') || '[]').map(p => p.secret);
      if (!a.includes(oldAtA.secret)) return 'the replaced seed\'s proof at the first mint was dropped';
      const b = JSON.parse(storage.getItem('foxy.cashu.proofs.https://b.test') || '[]').map(p => p.secret);
      if (!b.includes(oldAtB.secret)) return 'the replaced seed\'s proof at the late mint was dropped';
      return eq(b.length, 2, 'proofs at the late mint');
    });
  }

  // ---- the seed on the phone, with the real cashu-ts ----------------------

  /* The phone keeps the seed, the words and the counters, and hands the page
   * only secrets ("the seed on the phone" in build/wallet/03-seed-counters-logs.js).
   * These run the page as it ships — cashu-ts and the wallet — against fakeMint,
   * with the native side mocked by harness.js's nativePhone, which derives from
   * the mocked keychain's words with the bundled bip39 and cashu-ts's NUT-13
   * derivation. What reaches the mint must be NUT-13's outputs for the words. */
  {
    const { loadReal, fakeMint, nativePhone } = require('./harness');
    const NS_WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const NS_OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const NS_MINT = 'https://m.test';
    const NS_PILE = 'foxy.cashu.proofs.' + NS_MINT;
    // BOLT 11's example invoice with its amount made 2500n, 250 sat; nothing here checks its signature
    const NS_INVOICE = 'lnbc2500n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
    const PLACEHOLDER = Array.from(Buffer.from('FOXY PLACEHOLDER, NOT A SEED. Every secret comes from the phone.', 'latin1'));
    const WORD_ACTION = /^seed(Read|Write|Delete|Secrets)$/;
    const sameBytes = (a, b) => !!a && a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
    const threw = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

    /* A page, a fake mint (o.mint to share one), and the phone: o.phone or one
     * holding o.words. rec.bridge is every bridge action but mint requests,
     * rec.toSeed how often the page turned words into a seed (bip39.js is
     * loaded for the phone's use, and the page must never call it), rec.wallets
     * the options of every cashu-ts Wallet the page built. o.loseSwap()
     * returning true loses the answer to a swap the mint made. */
    const nsPhones = [];   // every phone a page below ran on: no normal flow may meet the cap on counter moves
    function nsPage(opts) {
      const o = opts || {};
      const phone = o.phone || nativePhone({ words: o.words === undefined ? NS_WORDS : o.words, window: o.window });
      if (nsPhones.indexOf(phone) < 0) nsPhones.push(phone);
      const keychain = phone.keychain;
      const rec = { bridge: [], toSeed: 0, wallets: [] };
      let mint = null, realToSeed = null;
      const answer = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
      const ctx = loadReal({
        storage: o.storage,
        bridge: (w, m) => {
          if (m.action === 'mintRequest') {
            if (o.onMint) o.onMint(m);
            const out = o.rewrite ? o.rewrite(m, mint.handle(m)) : mint.handle(m);
            if (o.loseSwap && new URL(m.url).pathname === '/v1/swap' && o.loseSwap()) {
              return answer(w, m.id, null, 'The network connection was lost.');
            }
            return answer(w, m.id, out);
          }
          rec.bridge.push(m.action);
          const got = phone.answer(w, m);
          if (!got) return answer(w, m.id, null, 'not in this test');
          return Promise.resolve(got).then((r) => answer(w, m.id, r[0], r[1]));
        },
        before: (w) => {
          if (!phone.toSeed) phone.attach(w);
          mint = o.mint || fakeMint(w, { versionByte: o.versionByte || 0, p2pk: !!o.p2pk, feePpk: o.feePpk, maxArray: o.maxArray });
          // the bundle's exports are getters, so the page gets a copy with one counted
          const B = w.FoxyBip39;
          realToSeed = B.mnemonicToSeedSync;
          w.FoxyBip39 = { generateMnemonic: B.generateMnemonic, mnemonicToSeed: B.mnemonicToSeed,
            validateMnemonic: B.validateMnemonic, wordlist: B.wordlist,
            mnemonicToSeedSync: function () { rec.toSeed++; return realToSeed.apply(null, arguments); } };
          const CT = w.CashuTS, copy = {};
          for (const k of Object.keys(CT)) copy[k] = CT[k];
          copy.Wallet = class extends CT.Wallet {
            constructor(u, op) { super(u, op); rec.wallets.push(op || {}); }
          };
          w.CashuTS = copy;
        },
      });
      return Object.assign(ctx, { keychain, phone, rec, mint });
    }

    const nsPile = (s) => {
      let all = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (/^foxy\.cashu\.proofs\./.test(k)) all = all.concat(JSON.parse(s.getItem(k) || '[]'));
      }
      return all;
    };
    const secretsOf = (ps) => (ps || []).map(p => p.secret).sort().join(',');
    const postedTo = (posted, path) => posted.filter(x => x.path === path).map(x => x.B_.join(',')).join('|');
    /* The same requests with the same outputs. A scan of this wallet's own seed
     * on the phone stops at the phone's window (1000 past its next counter), so
     * its last batch of a keyset may be cut short: that request's outputs are the
     * first ones of the request a scan of the same words by candidate sent. */
    const samePosts = (fullPosts, cutPosts, path) => {
      const a = fullPosts.filter(x => x.path === path), b = cutPosts.filter(x => x.path === path);
      return a.length === b.length && a.every((x, i) => {
        const cut = path === '/v1/restore' && b[i].B_.length < x.B_.length;
        return (cut ? x.B_.slice(0, b[i].B_.length) : x.B_).join(',') === b[i].B_.join(',');
      });
    };
    const phoneCounters = (phone) => JSON.stringify(Object.fromEntries([...(phone.counters.get(phone.keychain.words) || new Map())].sort()));

    /* Mint 300, send a 100 token and take it back with the swap's answer lost
     * (its recorded ranges are restored), pay 250 (change), then rescan the seed
     * as the app does: with no words. */
    async function nsFlow(versionByte) {
      let lose = false;
      const P = nsPage({ versionByte, loseSwap: () => { const l = lose; lose = false; return l; } });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const inv = await W.invoice(300, '');
      const claimed = await W.claim(inv.hash);
      const t = await W.sendToken(100);
      // the swap's answer is lost after the mint made it: its recorded ranges are restored
      const asksBeforeLoss = P.phone.asks.length;
      lose = true;
      const back = await W.receiveToken(t.token);
      const lostWas = !lose;
      const recovered = back;
      const paid = await W.pay(NS_INVOICE);
      const mark = P.mint.posted.length;
      const rows = await W.scanSeed(null, [NS_MINT]);
      return { P, W, claimed, t, back, paid, recovered, lostWas, asksBeforeLoss, rows,
               scanPosts: P.mint.posted.slice(mark), pile: nsPile(P.storage), balance: await W.balanceSats() };
    }

    /* What the mint is told, and from which circuit. */
    const onMintLog = () => {
      const seen = [];
      return { seen, onMint: (m) => seen.push({ path: new URL(m.url).pathname, circuit: m.circuit, at: Date.now(), body: m.body ? JSON.parse(m.body) : null }) };
    };

    await test('each job at a mint leaves on its own circuit, and connecting asks the mint about no proof and no sent token', async () => {
      const log = onMintLog();
      const P = nsPage({ onMint: log.onMint });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const inv = await W.invoice(300, '');
      // watched, as the receive screen does: polled, then claimed
      await new Promise((res) => W.watch(inv.hash, res, { pollMs: 10 }));
      await W.sendToken(100);
      const mark = log.seen.length;
      await W.connect(NS_MINT);
      await new Promise(r => setTimeout(r, 50));
      const asked = log.seen.slice(mark).filter(x => x.path === '/v1/checkstate');
      if (asked.length) return 'a connect asked the mint about ' + asked.map(x => x.body.Ys.length).join('+') + ' proof(s)';
      // the keychain's own fetches of the mint's public keys go unlabelled: the phone gives each its own circuit
      const unlabelled = log.seen.filter(x => !/^[0-9a-f]{32}$/.test(String(x.circuit || '')) && !/^\/v1\/(keys|keysets)(\/|$)/.test(x.path));
      if (unlabelled.length) return 'requests with no circuit label: ' + unlabelled.map(x => x.path).join(', ');
      const one = (path) => log.seen.find(x => x.path === path);
      const claim = one('/v1/mint/bolt11'), swap = one('/v1/swap'), made = one('/v1/mint/quote/bolt11');
      if (!claim || !swap || !made) return 'the flow did not reach the mint';
      if (swap.circuit === claim.circuit || swap.circuit === made.circuit) return 'the token\'s swap shared a circuit with the receive';
      const polls = log.seen.filter(x => x.path === '/v1/mint/quote/bolt11/' + inv.hash);
      if (!polls.length) return 'the invoice was never polled';
      if (polls.some(x => x.circuit !== claim.circuit)) return 'the invoice\'s checks and its claim left on different circuits';
    });

    await test('a sent token is asked about on a circuit of its own, the same one each time', async () => {
      const log = onMintLog();
      const P = nsPage({ onMint: log.onMint });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const inv = await W.invoice(300, '');
      await W.claim(inv.hash);
      await W.sendToken(100);
      const mark = log.seen.length;
      if (await W.tokenState() !== 'waiting') return 'an unclaimed token read as claimed';
      await W.tokenState();
      const checks = log.seen.slice(mark).filter(x => x.path === '/v1/checkstate');
      if (checks.length !== 2) return checks.length + ' checks, wanted 2';
      if (checks[0].circuit !== checks[1].circuit) return 'the token\'s checks left on different circuits';
      const others = log.seen.slice(0, mark).map(x => x.circuit);
      if (others.indexOf(checks[0].circuit) >= 0) return 'the token\'s checks shared a circuit with another job';
    });

    await test('a payment that picks ecash spent elsewhere asks about only what it sent, and takes that out of the balance', async () => {
      const log = onMintLog();
      const P = nsPage({ onMint: log.onMint });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const inv = await W.invoice(300, '');
      await W.claim(inv.hash);
      const pile = nsPile(P.storage);
      const big = pile.find(p => Number(p.amount) === 256);
      if (!big) return 'no 256 proof in ' + pile.map(p => p.amount).join('+');
      // spent behind the wallet's back, as a restore of the seed elsewhere would
      const CT = P.window.CashuTS;
      const out = CT.OutputData.createSingleDeterministicData(256, new P.window.Uint8Array(64).fill(3), 0, big.id).blindedMessage;
      const spentThere = P.mint.handle({ url: NS_MINT + '/v1/swap', body: JSON.stringify({ inputs: [big], outputs: [{ amount: 256, id: big.id, B_: out.B_ }] }) });
      if (!/^200/.test(spentThere)) return 'the spend elsewhere: ' + spentThere.slice(0, 80);
      let told = null;
      W.onSpentElsewhere((r) => { told = r; });
      const mark = log.seen.length;
      const failed = await W.sendToken(250).then(() => null, (e) => e);
      if (!failed || !/not enough/i.test(failed.message)) return 'the send: ' + (failed ? failed.message : 'went through');
      const checks = log.seen.slice(mark).filter(x => x.path === '/v1/checkstate');
      if (checks.length !== 1) return checks.length + ' checks, wanted 1';
      const refused = log.seen.slice(mark).find(x => x.path === '/v1/swap');
      if (checks[0].body.Ys.length !== refused.body.inputs.length) return 'asked about ' + checks[0].body.Ys.length + ' proofs, the swap sent ' + refused.body.inputs.length;
      if (checks[0].circuit !== refused.circuit) return 'the question left on another circuit than the refused swap';
      if (!told || told.sats !== 256) return 'said: ' + JSON.stringify(told);
      if (nsPile(P.storage).some(p => p.secret === big.secret)) return 'the spent proof is still in the pile';
      return eq(await W.balanceSats(), 44, 'balance');
    });

    await test('a sweep checks each outstanding invoice after a pause, each on its own circuit', async () => {
      const log = onMintLog();
      const P = nsPage({ onMint: log.onMint });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const a = await W.invoice(21, ''), b = await W.invoice(34, '');
      W._sweepPause = [60, 60];
      const mark = log.seen.length;
      const started = Date.now();
      const got = await W.sweepQuotes();
      if (got.length !== 2) return 'claimed ' + got.length + ' of 2';
      const checks = log.seen.slice(mark).filter(x => /^\/v1\/mint\/quote\/bolt11\//.test(x.path));
      if (checks.length !== 2) return checks.length + ' invoice checks, wanted 2';
      if (checks[0].at - started < 50) return 'the first check went out ' + (checks[0].at - started) + ' ms after the sweep began';
      if (checks[1].at - checks[0].at < 50) return 'the checks went out ' + (checks[1].at - checks[0].at) + ' ms apart';
      if (checks[0].circuit === checks[1].circuit) return 'two invoices were checked on one circuit';
      if (!a.hash || !b.hash) return 'no invoices';
    });

    await test('an invoice names the node that signed it: BOLT11\'s example, and a Nutshell mint\'s', async () => {
      const P = nsPage({});
      const W = P.W;
      // BOLT11: "the payee's public key" of its examples
      const bolt11 = 'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
      if (W.invoiceSigner(bolt11) !== '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad') return 'BOLT11 example: ' + W.invoiceSigner(bolt11);
      // nofee.testnut.cashu.space (Nutshell 0.18.2): two invoices, one node
      const nofee = 'lnbc210n1p42kszv9qypqqqdqqxqrrsssp5l7wur9f67wxjveqqkcpah3l3cy07atk8w24yrs443dvy6ryxp28qpp5wgy26tn926ygjz0knadns8lm75xp8kavnr7rxdmma2c9v44auzmq4d4j9n0a8xh9fv3849lvaqns8wasddm5uyc6neraks3xl4dma4mqw0t26kzzwt30yszgf0any8qv0rygacadpjs53p9xezcecr47t7cp3zq32p';
      if (W.invoiceSigner(nofee) !== '02aae401c1c1665b563bab29c1bc1cc7088fd4968fc5ee90d29a32ffe57e236c43') return 'nofee: ' + W.invoiceSigner(nofee);
      // one character changed: another signer or none, never the mint's
      const bent = bolt11.slice(0, 40) + (bolt11[40] === 'q' ? 'p' : 'q') + bolt11.slice(41);
      if (W.invoiceSigner(bent) === '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad') return 'a changed invoice kept its signer';
      // an invoice from this wallet's mint, and not from another after a switch
      await W.seedReady();
      await W.connect(NS_MINT);
      P.storage.setItem('foxy.cashu.mint.nodes', JSON.stringify({ [NS_MINT]: '03e7156ae33b0a208d0744199163177e909e80176e55d97a2f221ede0f934dd9ad' }));
      if (!W.invoiceFromThisMint(bolt11)) return 'the mint\'s own invoice was not recognised';
      if (W.invoiceFromThisMint(nofee)) return 'another node\'s invoice read as this mint\'s';
    });

    await test('a mint whose node is not known is asked for it when an invoice is scanned, on a circuit of its own', async () => {
      const log = onMintLog();
      // a real 21-sat invoice from nofee.testnut.cashu.space; the fake mint says 21 sats is its least
      const bolt11 = 'lnbc210n1p42kszv9qypqqqdqqxqrrsssp5l7wur9f67wxjveqqkcpah3l3cy07atk8w24yrs443dvy6ryxp28qpp5wgy26tn926ygjz0knadns8lm75xp8kavnr7rxdmma2c9v44auzmq4d4j9n0a8xh9fv3849lvaqns8wasddm5uyc6neraks3xl4dma4mqw0t26kzzwt30yszgf0any8qv0rygacadpjs53p9xezcecr47t7cp3zq32p';
      const P = nsPage({ onMint: log.onMint, rewrite: (m, out) => {
        const path = new URL(m.url).pathname;
        if (!/^200/.test(out)) return out;
        const j = JSON.parse(out.slice(4));
        if (path === '/v1/info') j.nuts[4].methods[0].min_amount = 21;
        else if (path === '/v1/mint/quote/bolt11') j.request = bolt11;
        else return out;
        return '200\n' + JSON.stringify(j);
      } });
      const W = P.W;
      W._nodeProbeDelay = [60000, 60000];   // the connect's own check stays out of the way
      await W.seedReady();
      await W.connect(NS_MINT);
      if (W.mintNodeKnown()) return 'the node was known before anything asked';
      if (W.invoiceFromThisMint(bolt11)) return 'recognised with no node known';
      const mark = log.seen.length;
      const node = await W.learnThisMintNode();
      if (node !== '02aae401c1c1665b563bab29c1bc1cc7088fd4968fc5ee90d29a32ffe57e236c43') return 'learned ' + node;
      if (!W.invoiceFromThisMint(bolt11)) return 'the mint\'s invoice was not recognised once its node was learned';
      // the connect's keyset check may land in the same moment; anything else may not
      const asked = log.seen.slice(mark).filter(x => x.path !== '/v1/keysets');
      if (asked.length !== 1 || asked[0].path !== '/v1/mint/quote/bolt11') return 'asked: ' + asked.map(x => x.path).join(', ');
      if (log.seen.slice(0, mark).some(x => x.circuit === asked[0].circuit)) return 'the question shared a circuit';
      const again = log.seen.length;
      await W.learnThisMintNode();
      if (log.seen.length !== again) return 'a known node was asked for again';
    });

    await test('a token made to pay someone is watched by its fingerprints alone, on its own circuit, until it is redeemed', async () => {
      const log = onMintLog();
      const P = nsPage({ onMint: log.onMint });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const inv = await W.invoice(300, '');
      await W.claim(inv.hash);
      const t = await W.sendToken(100);
      if (!W.watchTokenClaim(t.hash, { persist: true })) return 'no watch';
      const stored = P.storage.getItem('foxy.cashu.token.watch');
      if (/cashu[AB]/.test(stored)) return 'the watch stored the token itself';
      const mark = log.seen.length;
      if (await W.tokenClaimState(t.hash) !== 'waiting') return 'an unredeemed token read as claimed';
      // redeemed by someone else: a second wallet
      const Q = nsPage({ mint: P.mint });
      await Q.W.seedReady();
      await Q.W.connect(NS_MINT);
      await Q.W.receiveToken(t.token);
      if (await W.tokenClaimState(t.hash) !== 'claimed') return 'a redeemed token still read as waiting';
      const checks = log.seen.slice(mark).filter(x => x.path === '/v1/checkstate');
      if (checks.length !== 2) return checks.length + ' checks, wanted 2';
      const inToken = W.tokenInfo(t.token).proofs.length;
      if (checks.some(x => x.body.Ys.length !== inToken)) return 'a check asked about more than the token';
      if (checks[0].circuit !== checks[1].circuit) return 'the checks left on different circuits';
      if (log.seen.slice(0, mark).some(x => x.circuit === checks[0].circuit)) return 'the watch shared a circuit with another job';
      if (!W.forgetClaimedToken(t.hash)) return 'the claimed token\'s text was not forgotten by its hash';
      W.dropTokenWatch(t.hash);
      return W.watchedTokens().length ? 'the watch stayed' : null;
    });

    await test('a Cashu payment request names the amount and this mint, and nothing else', async () => {
      const P = nsPage({});
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const creq = W.paymentRequest(2100);
      if (!/^creqA/.test(creq)) return 'made: ' + creq.slice(0, 20);
      const d = P.window.CashuTS.decodePaymentRequest(creq);
      /* `.toString()`, not `Number(...)`: cashu-ts 4.11.0 backs an amount with
       * `Amount`, and coercing one numerically is deprecated and throws in v5.
       * The wallet routes every one of these through `satsOf`; a test that
       * still coerced would be the thing that breaks on the next bump. */
      if (Number(String(d.amount)) !== 2100 || d.unit !== 'sat' || d.mints.length !== 1 || d.mints[0] !== NS_MINT) return 'decoded: ' + JSON.stringify(d);
      if (d.description || (d.transport || []).length || d.singleUse !== true) return 'more than it should say: ' + JSON.stringify(d);
      const any = P.window.CashuTS.decodePaymentRequest(W.paymentRequest(0));
      if (any.amount != null) return 'an any-amount request carried ' + any.amount;
      // what Foxy reads when a payer scans it
      const read = W.decodeRequest(creq);
      return read && Number(read.amount || read.sats) === 2100 ? null : 'Foxy read it as ' + JSON.stringify(read);
    });

    /* A request that names somewhere to be paid — which, until this was added,
     * nothing here ever built. Every suite runs without Tor, so openInbox
     * always failed and every request under test carried `transport: []`. The
     * one thing the transport list decides was therefore never checked, and
     * what it decides is whether a payer loses their money: cashu.me takes the
     * FIRST transport it recognises, so an onion in front of a Nostr key sends
     * a browser wallet to an address it cannot resolve — after it has already
     * swapped the ecash at the mint (tools/live/production.md). */
    await test('a request offers Nostr before the onion, so a browser wallet takes the one it can reach', async () => {
      const P = nsPage({});
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const onion = 'http://' + 'a'.repeat(55) + 'd.onion/' + 'b'.repeat(32);
      const nostr = 'nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhhy'
        + 'tnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34kytnrdaksjlyr9p';
      const both = P.window.CashuTS.decodePaymentRequest(
        W.paymentRequest(100, { deliverTo: { onion: onion, nostr: nostr }, purpose: 'receive' }));
      const kinds = (both.transport || []).map(t => t.type);
      if (kinds.join(',') !== 'nostr,post') return 'transports were ' + JSON.stringify(kinds);
      const n = both.transport[0];
      if (n.target !== nostr) return 'the nostr target was ' + n.target;
      if (!(n.tags || []).some(g => g[0] === 'n' && g.indexOf('17') > 0)) {
        return 'the nostr transport does not say NIP-17: ' + JSON.stringify(n.tags);
      }
      if (both.transport[1].target !== onion) return 'the onion target was ' + both.transport[1].target;

      // and Foxy itself still prefers the onion, wherever it sits in the list
      const mine = W.decodeRequest(W.paymentRequest(100, { deliverTo: { onion: onion, nostr: nostr } }));
      if (!mine || !mine.delivery || mine.delivery.kind !== 'onion') {
        return 'Foxy would have paid over ' + JSON.stringify(mine && mine.delivery);
      }

      // one alone is carried alone, and neither is carried when there is neither
      const only = P.window.CashuTS.decodePaymentRequest(W.paymentRequest(100, { deliverTo: { nostr: nostr } }));
      if ((only.transport || []).map(t => t.type).join(',') !== 'nostr') {
        return 'a nostr-only request carried ' + JSON.stringify((only.transport || []).map(t => t.type));
      }
      const none = P.window.CashuTS.decodePaymentRequest(W.paymentRequest(100, { deliverTo: {} }));
      if ((none.transport || []).length) return 'a request with nowhere to be paid carried a transport';

      // and rubbish in the answer is not put in front of a payer
      const junk = P.window.CashuTS.decodePaymentRequest(
        W.paymentRequest(100, { deliverTo: { onion: 'http://evil.example/x', nostr: 'npub1nope' } }));
      return (junk.transport || []).length ? 'a bad address was carried: '
        + JSON.stringify(junk.transport) : null;
    });

    await test('a sent token taken back into the wallet no longer waits in history', async () => {
      const P = nsPage({});
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const inv = await W.invoice(300, '');
      await W.claim(inv.hash);
      const t = await W.sendToken(21);
      if (!(W.tagsFor(t.hash) || {}).token) return 'the sent token\'s text was not kept';
      await W.reclaimToken(t.token);
      return (W.tagsFor(t.hash) || {}).token ? 'its text is still kept, so history shows it waiting' : null;
    });

    await test('back in the foreground with money, the seed is read once', async () => {
      const P = nsPage({});
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const inv = await W.invoice(300, '');
      await W.claim(inv.hash);
      const mark = P.phone.asks.length;
      if (await W.openSeedForVisit() !== true) return 'the seed was not there';
      const asked = P.phone.asks.slice(mark).map(x => (x && x.action) || x);
      return asked.indexOf('seedStatus') >= 0 ? null : 'asked: ' + JSON.stringify(asked);
    });

    /* An empty wallet has nothing to unlock. Face ID once per visit is the
     * rule, but a fresh install was made to face the prompt before
     * it had anything to protect, which is friction in front of somebody who
     * has not started. */
    await test('with nothing in the wallet, coming back asks for nothing', async () => {
      const P = nsPage({});
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const mark = P.phone.asks.length;
      if (await W.openSeedForVisit() !== false) return 'it read the seed anyway';
      const asked = P.phone.asks.slice(mark).map(x => (x && x.action) || x);
      return asked.length ? 'it asked the phone: ' + JSON.stringify(asked) : null;
    });

    // and the launch itself never reads it: it asks only whether one is there
    /* A fresh install asks the phone two things and neither needs the person:
     * whether a seed is there (quietly), and — finding none — to make one.
     * Reading is what Face ID is for, and there is nothing to read yet. */
    await test('a fresh install never asks the phone to read the seed', async () => {
      const P = nsPage({ words: '' });          // a phone with no seed yet
      const W = P.W;
      const mark = P.phone.asks.length;
      await W.seedReady();
      await W.connect(NS_MINT);
      const asks = P.phone.asks.slice(mark);
      const reading = asks.filter(x => x && x.action === 'seedStatus' && x.quiet !== true);
      if (reading.length) return 'it read the seed ' + reading.length + ' time(s)';
      const kinds = asks.map(x => x && x.action);
      return kinds.every(k => k === 'seedStatus' || k === 'seedCreate' || k === 'countersImport')
        ? null : 'it asked for more than that: ' + JSON.stringify(kinds);
    });

    await test('the launch asks whether a seed exists without reading it', async () => {
      const P = nsPage({});
      const W = P.W;
      const mark = P.phone.asks.length;
      await W.seedReady();
      const status = P.phone.asks.slice(mark).filter(x => x && x.action === 'seedStatus');
      if (!status.length) return 'the launch did not ask about the seed at all';
      return status.every(x => x.quiet === true) ? null
        : 'it read the seed at launch: ' + JSON.stringify(status.map(x => x.quiet));
    });

    await test('a token the pile can make exactly needs no swap; one it cannot still swaps', async () => {
      const log = onMintLog();
      const P = nsPage({ onMint: log.onMint });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const inv = await W.invoice(300, '');
      await W.claim(inv.hash);          // 256 + 32 + 8 + 4
      let mark = log.seen.length;
      const exact = await W.sendToken(40);
      if (exact.swapped !== false || exact.sats !== 40) return 'the 40-sat token: ' + JSON.stringify({ swapped: exact.swapped, sats: exact.sats });
      if (log.seen.slice(mark).length) return 'a token from pieces held asked the mint: ' + log.seen.slice(mark).map(x => x.path).join(', ');
      if (await W.balanceSats() !== 260) return 'balance after it: ' + await W.balanceSats();
      mark = log.seen.length;
      const swapped = await W.sendToken(21);
      if (swapped.swapped !== true) return 'the 21-sat token did not swap';
      if (!log.seen.slice(mark).some(x => x.path === '/v1/swap')) return 'no swap for 21';
      const back = await W.receiveToken(exact.token);
      return back.sats === 40 ? null : 'the no-swap token did not redeem: ' + JSON.stringify(back);
    });

    /* The pool as shipped, not a number written down twice.
     *
     * This test asserted "two of each" against a PIECES_EACH of 2, so raising
     * the pool to 3 broke it — which is the test doing its job, but it should
     * not have to be edited to say the same thing again. It reads
     * the constant now and funds itself for whatever it finds. */
    const SMALL = [1, 2, 4, 8, 16, 32, 64, 128];
    const EACH = (() => {
      const m = require('fs').readFileSync(require('path').join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8')
        .match(/PIECES_EACH\s*=\s*(\d+)/);
      if (!m) throw new Error('PIECES_EACH not found in the shipped wallet');
      return Number(m[1]);
    })();

    await test('small change: the small tier is filled to ' + EACH + ' of each, and then small amounts need no swap', async () => {
      const log = onMintLog();
      const P = nsPage({ onMint: log.onMint });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      /* The whole small tier plus large pieces to break it out of. */
      const funds = 255 * EACH + 8192;
      const inv = await W.invoice(funds, '');
      await W.claim(inv.hash);

      /* One piece per run, on purpose: tidyChange breaks the smallest piece
       * bigger than what it is filling and no more, so a pool this deep takes
       * many quiet moments. Looping here is what the app does over time
       * (tidyChangeLater). It stops when there is nothing left worth breaking,
       * which with a deep tier above the small one is "no larger piece to break"
       * rather than "enough small change" — either is a settled pool. */
      let runs = 0, last = null;
      for (; runs < 60; runs++) {
        last = await W.tidyChange();
        if (last.skipped) break;
      }
      if (!last || !last.skipped) return 'never settled after ' + runs + ' runs: ' + JSON.stringify(last);

      const pile = nsPile(P.storage);
      const count = (d) => pile.filter(p => Number(p.amount) === d).length;
      const short = SMALL.filter(d => count(d) < EACH);
      if (short.length) return 'short of ' + EACH + ' at ' + short.join(',')
        + ' after ' + runs + ' runs (' + last.skipped + ') — pile: '
        + pile.map(p => p.amount).sort((x, y) => x - y).join(',');
      if (await W.balanceSats() !== funds) return 'balance changed: ' + await W.balanceSats();

      const mark = log.seen.length;
      for (const n of [21, 7, 100, 999]) {
        const t = await W.sendToken(n);
        if (t.swapped !== false) return n + ' sats needed a swap after tidying';
      }
      return log.seen.slice(mark).some(x => x.path === '/v1/swap') ? 'a swap went out' : null;
    });

    /* And the target itself, pinned by what a swap chooses to make.
     *
     * Asking "does it still want to run" cannot see the line: a pile one short of
     * the small target and a pile that has finished it both want to run — the
     * second one is filling 256s. And asserting "at least EACH of each" passes on
     * a wrong target anyway, because every swap hands its remainder back as
     * powers of two and counts drift upward by accident. That is how a changePlan
     * ignoring PIECES_EACH and filling two went unnoticed.
     *
     * What does see it is which denominations come out. One short of the small
     * target, a swap makes small pieces. With the small tier finished, it makes
     * 256s — the next tier, one denomination at a time. */
    await test('the pool fills the small tier to ' + EACH + ' first, and only then starts on 256', async () => {
      const P = nsPage({});
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const inv = await W.invoice(255 * EACH + 8192, '');
      await W.claim(inv.hash);
      for (let i = 0; i < 60; i++) { if ((await W.tidyChange()).skipped) break; }

      const key = (() => {
        for (let i = 0; i < P.storage.length; i++) {
          const k = P.storage.key(i);
          if (/^foxy\.cashu\.proofs\./.test(k)) return k;
        }
        return null;
      })();
      if (!key) return 'no pile on disk';
      const all = nsPile(P.storage);
      const count = (list, d) => list.filter(p => Number(p.amount) === d).length;
      /* Built from proofs the mint really signed, so the swap that follows is a
       * real one. Two different large pieces, because the first swap spends the
       * one it breaks and the second pile cannot be handed the same proof — it
       * came back "that piece was spent elsewhere", which is `retryWithoutSpent`
       * correctly noticing. Over 256 so that either tier can break it. */
      const bigs = all.filter(p => Number(p.amount) > 256)
        .sort((a, b) => Number(a.amount) - Number(b.amount));
      if (bigs.length < 2) return 'need two pieces over 256 to break, have '
        + bigs.map(p => p.amount).join(',');
      /* Two 256s go in as well, and they are what makes the break rule visible.
       *
       * Without them the pile has nothing between 128 and 256, so a rule looking
       * for "bigger than 128" and the right one looking for "bigger than what is
       * being filled" pick the same input and behave identically. With them, the
       * wrong rule picks a 256 to make 256s out of — which cannot work — and
       * stops with "the piece is too small". */
      const twoFiftySix = all.filter(p => Number(p.amount) === 256).slice(0, 2);
      if (twoFiftySix.length < 2) return 'need two 256s to make the break rule visible';
      const setOf = (want, breaker) => {
        const out = [breaker].concat(twoFiftySix);
        for (const d of SMALL) {
          const got = all.filter(p => Number(p.amount) === d).slice(0, want);
          if (got.length < want) return null;
          out.push(...got);
        }
        return out;
      };

      /* Half gone: the swap must make small pieces. A tier is refilled once
       * it is down to six of its twelve, not at the first piece spent, which
       * meant a swap after nearly every payment. */
      const nearly = setOf(6, bigs[0]);
      if (!nearly) return 'could not build a pile at six of each';
      P.storage.setItem(key, JSON.stringify(nearly));
      const r1 = await W.tidyChange();
      if (r1.skipped) return 'six of ' + EACH + ' was called full: ' + r1.skipped;
      const after1 = nsPile(P.storage);
      const gainedSmall = SMALL.some(d => count(after1, d) > count(nearly, d));
      if (!gainedSmall) return 'one short, and the swap made no small pieces: '
        + after1.map(p => p.amount).sort((x, y) => x - y).join(',');

      // at the target: the small tier is done, so 256 is next
      const full = setOf(EACH, bigs[1]);
      if (!full) return 'could not build a pile at ' + EACH;
      P.storage.setItem(key, JSON.stringify(full));
      const r2 = await W.tidyChange();
      if (r2.skipped) return 'at ' + EACH + ' it stopped instead of starting the next tier: ' + r2.skipped;
      const after2 = nsPile(P.storage);
      if (count(after2, 256) <= count(full, 256)) {
        return 'at ' + EACH + ' the swap did not start on 256s: '
          + after2.map(p => p.amount).sort((x, y) => x - y).join(',');
      }
      /* And it did not quietly go past the target on the small pieces while it
       * was there — 256s are what it was asked for. */
      const wentPast = SMALL.filter(d => count(after2, d) > EACH + 1);
      if (wentPast.length) return 'it overfilled ' + wentPast.join(',') + ' past the target';
    });

    /* The swap a payment or a receipt makes anyway fills the pool itself.
     *
     * A receive used to put the money in as a few large pieces and a top-up
     * then broke them down, swap after swap, while the person waited; a
     * locked payment picked its own inputs and spent the small pieces exact
     * change needs. Now the receive's outputs are the pool's missing pieces,
     * and a locked payment takes one large piece in and hands the pool's
     * pieces back. */
    await test('a receive into an empty pile fills the small tiers in that one swap', async () => {
      const log = onMintLog();
      const P = nsPage({ onMint: log.onMint });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const inv = await W.invoice(255 * EACH + 4096, '');
      await W.claim(inv.hash);
      const made = await W.sendToken(255 * EACH + 2048);
      // the claim's pieces go out with the token: what is left is small
      const before = nsPile(P.storage);
      const key = (() => {
        for (let i = 0; i < P.storage.length; i++) {
          const k = P.storage.key(i);
          if (/^foxy\.cashu\.proofs\./.test(k)) return k;
        }
        return null;
      })();
      if (!key) return 'no pile on disk';
      // an empty pile, then the token comes back in
      P.storage.setItem(key, JSON.stringify([]));
      const mark = log.seen.length;
      await W.receiveToken(made.token);
      const swaps = log.seen.slice(mark).filter(x => x.path === '/v1/swap').length;
      if (swaps !== 1) return swaps + ' swaps for one receive';
      const pile = nsPile(P.storage);
      const count = (d) => pile.filter(p => Number(p.amount) === d).length;
      // sixty shaped pieces at most in one swap, and no more than six of any one size
      const small = pile.filter(p => Number(p.amount) <= 128).length;
      if (small < 48) return 'only ' + small + ' small pieces came back: ' + pile.map(p => p.amount).sort((x, y) => x - y).join(',');
      const over = SMALL.filter(d => count(d) > 6 + 1);
      if (over.length) return 'more than six of one size in one swap: ' + over.map(d => d + 'x' + count(d)).join(',');
      if (pile.length > 60 + 16) return pile.length + ' pieces for one receive';
      return before.length >= 0 ? null : 'unreachable';
    });

    await test('a top-up swap asks a small-cap mint for no more outputs than it takes', async () => {
      const log = onMintLog();
      const P = nsPage({ maxArray: 25, onMint: log.onMint });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      await W.claim((await W.invoice(4096, '')).hash);
      const r = await W.tidyChange();
      if (!r.split) return 'the top-up did not run: ' + JSON.stringify(r);
      const swapsSeen = log.seen.filter(x => x.path === '/v1/swap');
      const outs = swapsSeen.length ? ((swapsSeen[swapsSeen.length - 1].body || {}).outputs || []).length : -1;
      if (!(outs > 0 && outs <= 25)) return outs + ' outputs asked of a mint that takes 25';
    });

    await test('a top-up\'s fee goes on the payment before it, and the audit still adds up', async () => {
      const P = nsPage({ feePpk: 1000 });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      await W.claim((await W.invoice(4096, '')).hash);
      const before = JSON.parse(P.storage.getItem('foxy.cashu.log') || '[]')[0];
      const r = await W.tidyChange();
      if (!r.split) return 'the top-up did not run: ' + JSON.stringify(r);
      const after = JSON.parse(P.storage.getItem('foxy.cashu.log') || '[]');
      const row = after.find(e => e.hash === before.hash);
      if (!row) return 'the claim\'s row went missing';
      const fee = (Number(row.feeSats) || 0) - (Number(before.feeSats) || 0);
      if (!(fee > 0)) return 'no fee was charged to the row: ' + JSON.stringify(row);
      if (Number(row.sats) !== Number(before.sats) - fee) return 'the received amount did not drop by the fee';
      if (after.length !== JSON.parse(P.storage.getItem('foxy.cashu.log') || '[]').length) return 'rows changed';
      const bal = await W.balanceSats();
      const sum = after.reduce((a, e) => a + (e.dir === 'in' ? Number(e.sats) : -(Number(e.sats) + (Number(e.feeSats) || 0))), 0);
      if (bal !== sum) return 'balance ' + bal + ' vs rows ' + sum;
      if (W.topUpFeeSats() !== 0) return 'the tally was used although a row could carry the fee';
    });

    await test('a token\'s row carries the swap fee, the shortfall check agrees, and the audit adds up', async () => {
      const P = nsPage({ feePpk: 1000 });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      await W.claim((await W.invoice(1024, '')).hash);
      const pileBefore = nsPile(P.storage).reduce((a, p) => a + Number(p.amount), 0);
      const lack = W.sendShortfall(500);
      if (!lack || lack.short || !(lack.fee > 0) || lack.need !== 500 + lack.fee) return 'shortfall for 500: ' + JSON.stringify(lack);
      const over = W.sendShortfall(1024);
      if (!over || !over.short || over.have !== 1024) return 'shortfall for the whole pile: ' + JSON.stringify(over);
      const made = await W.sendToken(500, { unit: 'sat' });
      if (!made || !made.token) return 'no token';
      const pileAfter = nsPile(P.storage).reduce((a, p) => a + Number(p.amount), 0);
      const row = JSON.parse(P.storage.getItem('foxy.cashu.log') || '[]').find(e => e.dir === 'out');
      if (!row) return 'no out row';
      const fee = pileBefore - pileAfter - Number(row.sats);
      if (!(fee > 0)) return 'the swap cost nothing: ' + fee;
      if (Number(row.feeSats) !== fee) return 'the row says fee ' + row.feeSats + ', the pile says ' + fee;
      const rows = JSON.parse(P.storage.getItem('foxy.cashu.log') || '[]');
      const sum = rows.reduce((a, e) => a + (e.dir === 'in' ? Number(e.sats) : -(Number(e.sats) + (Number(e.feeSats) || 0))), 0);
      const bal = await W.balanceSats();
      if (bal !== sum) return 'balance ' + bal + ' vs rows ' + sum;
    });

    await test('the shortfall check agrees with the swap about the receiver\'s fee near the whole balance', async () => {
      const P = nsPage({ p2pk: true, feePpk: 1000 });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      await W.claim((await W.invoice(64, '')).hash);
      const held = await W.balanceSats();
      const key = '02' + 'ab'.repeat(32);
      // walk down from the whole balance: whatever the check allows, the locked send must make
      let allowed = 0, refusedAbove = 0;
      for (let want = held; want > held - 40 && want > 0; want--) {
        const lack = W.sendShortfall(want, { locked: true });
        if (!lack) return 'no answer for ' + want;
        if (lack.short) { refusedAbove += 1; if (!(lack.need > lack.have)) return 'short without a shortfall at ' + want + ': ' + JSON.stringify(lack); continue; }
        allowed = want;
        break;
      }
      if (!allowed) return 'nothing within 40 sats of the balance was allowed';
      if (!refusedAbove) return 'the whole balance was allowed although a swap has fees to pay';
      const made = await W.sendToken(allowed, { unit: 'sat', lockTo: key }).catch(e => ({ why: e.message }));
      if (!made || !made.token) return 'the check allowed ' + allowed + ' of ' + held + ' and the send refused: ' + (made && made.why)
        + ' | ' + JSON.stringify(W.sendShortfall(allowed, { locked: true })) + ' pile ' + nsPile(P.storage).map(p => p.amount).join(',');
    });

    await test('a payment only passing through a mint is received as the fewest pieces', async () => {
      /* Taken at the payer's mint to be melted home a second later. Shaped
       * into small change it arrived as 46 pieces, 7 sats to spend where the
       * quote allowed 6, and the way home was refused (tools/live/tap-scenarios.js 6). */
      const A = nsPage({ feePpk: 150 });
      await A.W.seedReady(); await A.W.connect(NS_MINT);
      await A.W.claim((await A.W.invoice(4096, '')).hash);
      const one = await A.W.sendToken(1026, { unit: 'sat' });
      const two = await A.W.sendToken(1026, { unit: 'sat' });
      const B = nsPage({ feePpk: 150 });
      await B.W.seedReady(); await B.W.connect(NS_MINT);
      await B.W.receiveToken(one.token, { plain: true });
      const plain = nsPile(B.storage).length;
      const C = nsPage({ feePpk: 150 });
      await C.W.seedReady(); await C.W.connect(NS_MINT);
      await C.W.receiveToken(two.token);
      const shaped = nsPile(C.storage).length;
      if (!(plain <= 12)) return plain + ' pieces from a plain receive of 1026';
      if (Math.ceil(plain * 150 / 1000) > 2) return 'a plain receive costs ' + Math.ceil(plain * 150 / 1000) + ' to spend';
      if (!(shaped > plain)) return 'the ordinary receive made ' + shaped + ' pieces, the plain one ' + plain;
      if ((await B.W.balanceSats()) !== (await C.W.balanceSats())) return 'the two receives kept different amounts';
    });

    await test('change made at a fee mint puts its fee on the payment, which records what really stayed', async () => {
      const A = nsPage({ p2pk: true, feePpk: 1000 });
      const B = nsPage({ p2pk: true, feePpk: 1000 });
      await A.W.seedReady(); await A.W.connect(NS_MINT);
      await B.W.seedReady(); await B.W.connect(NS_MINT);
      await A.W.claim((await A.W.invoice(2048, '')).hash);
      const paid = await A.W.sendToken(1024, { unit: 'sat' });
      const before = await B.W.balanceSats();
      // B asked for 600 and was handed 1024: 424 less the fee on what came goes back
      const got = await B.W.receiveToken(paid.token, { hash: 'req-t1', keptSats: 600, grossSats: 1024, changeSats: 1024 - 600 });
      void got;
      const afterIn = await B.W.balanceSats();
      const inFee = 1024 - (afterIn - before);
      const row0 = JSON.parse(B.storage.getItem('foxy.cashu.log') || '[]').find(e => e.hash === 'req-t1');
      if (!row0) return 'no row for the payment';
      if (Number(row0.sats) > afterIn - before - 424 + 0) return 'the row keeps ' + row0.sats + ' of ' + (afterIn - before) + ' that arrived with 424 going back';
      const change = await B.W.sendToken(424 - inFee, { unit: 'sat', lockTo: '02' + 'ab'.repeat(32), purpose: 'change' });
      if (!(change.fee > 0)) return 'making change cost nothing at a fee mint: ' + change.fee;
      const afterOut = await B.W.balanceSats();
      if (afterIn - afterOut !== change.sats + change.fee) return 'the pile fell by ' + (afterIn - afterOut) + ', the token and fee say ' + (change.sats + change.fee);
      if (JSON.parse(B.storage.getItem('foxy.cashu.log') || '[]').some(e => e.dir === 'out')) return 'change wrote a row of its own';
    });

    await test('a locked payment at a fee mint takes one piece in when the pile only just covers it', async () => {
      const P = nsPage({ p2pk: true, feePpk: 1000 });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      await W.claim((await W.invoice(400, '')).hash);
      const key = (() => { for (let i = 0; i < P.storage.length; i++) { const k = P.storage.key(i); if (/^foxy\.cashu\.proofs\./.test(k)) return k; } return null; })();
      const all = nsPile(P.storage);
      // a pile of 256 + 128 + 16: no single piece covers 255 plus both fees, two together do
      const pick = (d) => all.find(p => Number(p.amount) === d);
      if (!pick(256) || !pick(128) || !pick(16)) return 'the claim did not make 256/128/16: ' + all.map(p => p.amount).join(',');
      P.storage.setItem(key, JSON.stringify([pick(256), pick(128), pick(16)]));
      const made = await W.sendToken(255, { unit: 'sat', lockTo: '02' + 'ab'.repeat(32) }).catch(e => ({ why: e.message }));
      if (!made || !made.token) return 'refused: ' + (made && made.why);
      const left = nsPile(P.storage);
      if (left.map(p => p.secret).length !== new Set(left.map(p => p.secret)).size) return 'a secret twice in the pile';
    });

    await test('a locked payment takes one large piece in and leaves the small pieces alone', async () => {
      const P = nsPage({ p2pk: true });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const inv = await W.invoice(255 * EACH + 8192, '');
      await W.claim(inv.hash);
      for (let i = 0; i < 60; i++) { if ((await W.tidyChange()).skipped) break; }
      const pileBefore = nsPile(P.storage);
      const smallBefore = pileBefore.filter(p => Number(p.amount) <= 128).map(p => p.secret).sort();
      const made = await W.sendToken(1000, { unit: 'sat', lockTo: '02' + 'ab'.repeat(32) });
      if (!made || !made.token) return 'no token';
      const pileAfter = nsPile(P.storage);
      const smallAfter = pileAfter.filter(p => Number(p.amount) <= 128).map(p => p.secret).sort();
      const gone = smallBefore.filter(s => smallAfter.indexOf(s) < 0);
      if (gone.length) return gone.length + ' small piece(s) were spent as inputs';
      const count = (d) => pileAfter.filter(p => Number(p.amount) === d).length;
      const short = SMALL.filter(d => count(d) < EACH);
      if (short.length) return 'short at ' + short.join(',') + ' after the payment';
      if (pileAfter.length - pileBefore.length > 60) return (pileAfter.length - pileBefore.length) + ' new pieces from one payment';
    });

    await test('and the same at a mint that charges an input fee', async () => {
      const P = nsPage({ p2pk: true, feePpk: 100 });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const inv = await W.invoice(255 * EACH + 8192, '');
      await W.claim(inv.hash);
      for (let i = 0; i < 60; i++) { if ((await W.tidyChange()).skipped) break; }
      const pileBefore = nsPile(P.storage);
      const smallBefore = pileBefore.filter(p => Number(p.amount) <= 128).map(p => p.secret).sort();
      const made = await W.sendToken(1000, { unit: 'sat', lockTo: '02' + 'ab'.repeat(32) });
      if (!made || !made.token) return 'no token';
      const pileAfter = nsPile(P.storage);
      const smallAfter = pileAfter.filter(p => Number(p.amount) <= 128).map(p => p.secret).sort();
      const gone = smallBefore.filter(s => smallAfter.indexOf(s) < 0);
      if (gone.length) return gone.length + ' small piece(s) were spent as inputs';
      const count = (d) => pileAfter.filter(p => Number(p.amount) === d).length;
      const short = SMALL.filter(d => count(d) < EACH);
      if (short.length) return 'short at ' + short.join(',') + ' after the payment';
      if (pileAfter.length - pileBefore.length > 60) return (pileAfter.length - pileBefore.length) + ' new pieces from one payment';
    });

    /* Change for a token shown as a code.
     *
     * A payer with no route and no exact pieces pays over, and names in the
     * token's note a key for the difference to be locked to. The receiver
     * keeps what was asked, makes the rest locked to that key, and is told to
     * show it. A note that is not one is a token like any other. */
    await test('a token that paid over and named a key is read, and a mint that cannot lock leaves the receiver the lot', async () => {
      const A = nsPage({});
      await A.W.seedReady();
      await A.W.connect(NS_MINT);
      const inv = await A.W.invoice(2048, '');
      await A.W.claim(inv.hash);
      const plain = await A.W.sendToken(256);
      const CT = (A.window || A.w || {}).CashuTS || global.CashuTS;
      if (!CT) return 'no CashuTS on the page object';
      const info = A.W.tokenInfo(plain.token);
      const key = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
      const noted = CT.getEncodedToken({ mint: info.mint, unit: 'sat', proofs: info.proofs,
                                         memo: 'foxy:change:' + key + ':239' });
      const read = A.W.changeNoteOf(noted);
      if (!read || read.changeTo !== key || read.asked !== 239) return 'the note did not read back: ' + JSON.stringify(read);
      if (A.W.changeNoteOf(plain.token)) return 'a token with no note read as one';
      const odd = CT.getEncodedToken({ mint: info.mint, unit: 'sat', proofs: info.proofs,
                                       memo: 'foxy:change:' + key + ':0' });
      if (A.W.changeNoteOf(odd)) return 'a note asking for nothing read as one';

      const B = nsPage({ mint: A.mint, words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' });
      await B.W.seedReady();
      await B.W.connect(NS_MINT);
      let shown = null;
      B.W.onChangeStuck((x) => { shown = x; });
      const got = await B.W.receiveToken(noted);
      if (got.changeDue !== 17) return 'it did not find 17 sats of change due: ' + JSON.stringify(got);
      /* This mint cannot lock (no NUT-11), which is the failure worth pinning:
       * the change cannot be made, so the receiver keeps the lot, its entry
       * says so, and nothing is shown as owed that does not exist. The locked
       * path itself is the one `sendToken` already has (tests/p2pk-round-trip.js). */
      for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 20));
      if (shown) return 'change was shown that this mint could not have made';
      if (await B.W.balanceSats() !== 256) return 'the receiver holds ' + await B.W.balanceSats() + ', not the 256 it kept';
    });

    await test('a watched token taken back by this wallet stops being watched, and is never announced as sent', async () => {
      const P = nsPage({});
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      const inv = await W.invoice(300, '');
      await W.claim(inv.hash);
      const t = await W.sendToken(25);
      if (!W.watchTokenClaim(t.hash, { persist: true })) return 'no watch';
      await W.reclaimToken(t.token);
      if (W.watchedTokens().length) return 'the reclaimed token is still watched';
      if (await W.tokenClaimState(t.hash) !== null) return 'the watch still answers';
    });

    await test('an invoice sweep that waited through a trip to the background asks nothing until Tor is back', async () => {
      const log = onMintLog();
      const P = nsPage({ onMint: log.onMint });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      await W.invoice(21, '');
      W._sweepPause = [40, 40];
      const mark = log.seen.length;
      const sweep = W.sweepQuotes();
      W._privacy({ tor: 'connecting', progress: 50, everUp: true });   // back from the background, Tor not up yet
      await sweep;
      const asked = log.seen.slice(mark).filter(x => /^\/v1\/mint\/quote\/bolt11\//.test(x.path));
      W._privacy({ tor: 'up', progress: 100, everUp: true });
      return asked.length ? 'asked the mint ' + asked.length + ' time(s) with Tor down' : null;
    });

    /* The keyset cache remembers what a mint said about itself for five
     * minutes, so a wallet does not ask three times a minute. It nearly took
     * the marking check above with it: keyed by url alone, the second look —
     * whose entire purpose is an INDEPENDENT answer on a fresh circuit — was
     * handed the first circuit's answer out of memory and compared it with
     * itself. These pin the rule that makes that impossible, rather than the
     * one caller that remembered to opt out. */
    await test('a cached mint answer is never handed to a question asked on another circuit', async () => {
      const log = onMintLog();
      const W = nsPage({ onMint: log.onMint }).W;
      await W.seedReady();
      await W.connect(NS_MINT);
      // connecting starts a second look of its own; let it land before counting
      await new Promise(r => setTimeout(r, 80));
      const ask = (circuit, extra) => W.nativeRequest(Object.assign(
        { method: 'GET', endpoint: NS_MINT + '/v1/keysets', foxyCircuit: circuit }, extra || {}));
      // only this test's own circuits, so nothing else at the mint is counted
      const on = (c) => log.seen.filter(x => x.path === '/v1/keysets' && x.circuit === c).length;

      await ask('job-a');
      if (on('job-a') !== 1) return 'the first ask on a circuit did not reach the mint';

      await ask('job-a');
      if (on('job-a') !== 1) return 'the same question on the same circuit was asked twice — the cache is not working';

      await ask('job-b');
      if (on('job-b') !== 1) return 'another circuit was answered from the cache — a second opinion cannot be independent';

      await ask('job-a', { foxyFresh: true });
      if (on('job-a') !== 2) return 'foxyFresh did not go past the cache';
      return null;
    });

    /* A mint that takes the request and never answers used to be asked again
     * on every connect and every return, for ever. Each ask reserves a counter
     * range the mint never signs, and a long enough run of them hides later
     * ecash from a restore — the harm the three-refusal cap exists to prevent,
     * reached by a path nothing was counting. */
    await test('a mint that never answers a claim stops being asked, and says why', async () => {
      const log = onMintLog();
      const W = nsPage({
        onMint: log.onMint,
        // the quote is paid; handing the ecash over fails with no verdict in it
        rewrite: (m, out) => {
          const path = new URL(m.url).pathname;
          if (/^\/v1\/mint\/quote\/bolt11\//.test(path)) {
            const q = JSON.parse(out.slice(out.indexOf('\n') + 1));
            return '200\n' + JSON.stringify(Object.assign(q, { state: 'PAID', paid: true }));
          }
          if (path === '/v1/mint/bolt11') return '502\n{"detail":"the mint said nothing"}';
          return out;
        },
      }).W;
      await W.seedReady();
      await W.connect(NS_MINT);
      await W.invoice(21, '');
      const claims = () => log.seen.filter(x => x.path === '/v1/mint/bolt11').length;

      for (let i = 0; i < 25; i++) await W.sweepQuotes().catch(() => {});
      const asked = claims();
      if (asked === 0) return 'the claim was never attempted, so this test proves nothing';
      if (asked > 12) return 'asked the mint ' + asked + ' times: nothing is counting the silence';

      const rec = (W.pendingQuotes() || [])[0];
      if (!rec || !rec.unclaimed) return 'no record of the trouble was kept';
      if (rec.unclaimed.gaveUp !== 'silence') {
        return 'stopped for the wrong reason: ' + JSON.stringify(rec.unclaimed);
      }
      if (rec.unclaimed.refused !== 0) {
        return 'a 502 was counted as the mint refusing: ' + rec.unclaimed.refused;
      }

      // and the money is not abandoned: one more try by hand goes out
      const before = claims();
      await W.retryRefusedClaim(rec.quote).catch(() => {});
      if (claims() <= before) return 'TRY AGAIN asked the mint nothing';
      return null;
    });

    await test('nothing that moves money is ever answered from the cache', async () => {
      const log = onMintLog();
      const W = nsPage({ onMint: log.onMint }).W;
      await W.seedReady();
      await W.connect(NS_MINT);
      await new Promise(r => setTimeout(r, 80));
      // a POST to a path that IS cacheable as a GET: it is the method that decides
      const post = () => W.nativeRequest({ method: 'POST', endpoint: NS_MINT + '/v1/keysets',
        requestBody: {}, foxyCircuit: 'post-job' }).catch(() => {});
      await post();
      await post();
      const posts = log.seen.filter(x => x.path === '/v1/keysets' && x.circuit === 'post-job').length;
      if (posts !== 2) return 'a POST was answered from the cache (' + posts + ' of 2 reached the mint)';
      return null;
    });

    await test('a keyset shown to this wallet alone is reported, after a second look on another circuit', async () => {
      const log = onMintLog();
      // the mint's listing, asked on a labelled circuit, leaves out the keyset the connect was given
      const P = nsPage({ onMint: log.onMint, rewrite: (m, out) => {
        if (!m.circuit || new URL(m.url).pathname !== '/v1/keysets') return out;
        return '200\n' + JSON.stringify({ keysets: [{ id: '00ffffffffffffff', unit: 'sat', active: true, input_fee_ppk: 0 }] });
      } });
      const W = P.W;
      const told = [];
      W.onMintTrouble((t) => told.push(t));
      await W.seedReady();
      await W.connect(NS_MINT);
      await new Promise(r => setTimeout(r, 60));
      const asked = log.seen.filter(x => x.path === '/v1/keysets' && x.circuit);
      if (asked.length !== 2) return asked.length + ' independent keyset lists asked for, wanted 2';
      if (asked[0].circuit === asked[1].circuit) return 'the second look used the same circuit';
      if (told.length !== 1 || told[0].keysetsUnseen !== 1) return 'reported: ' + JSON.stringify(told);
      // an honest mint: one look, nothing said
      const log2 = onMintLog();
      const Q = nsPage({ onMint: log2.onMint });
      const told2 = [];
      Q.W.onMintTrouble((t) => told2.push(t));
      await Q.W.seedReady();
      await Q.W.connect(NS_MINT);
      await new Promise(r => setTimeout(r, 60));
      if (log2.seen.filter(x => x.path === '/v1/keysets' && x.circuit).length !== 1) return 'an honest mint was asked more than once';
      if (told2.length) return 'an honest mint was reported: ' + JSON.stringify(told2);
    });

    await test('a lost send swap records the proofs it sent, and its recovery asks the mint about those alone', async () => {
      const log = onMintLog();
      let lose = false;
      const P = nsPage({ onMint: log.onMint, loseSwap: () => { const l = lose; lose = false; return l; } });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      for (const n of [64, 64, 64, 64]) { const inv = await W.invoice(n, ''); await W.claim(inv.hash); }
      const held = nsPile(P.storage).length;
      const mark = log.seen.length;
      lose = true;
      const e = await W.sendToken(10).then(() => null, (x) => x);
      if (!e) return 'the send went through';
      const swap = log.seen.slice(mark).find(x => x.path === '/v1/swap');
      if (!swap) return 'no swap was sent';
      const sent = swap.body.inputs.length;
      if (sent >= held) return 'the swap took the whole pile (' + sent + ' of ' + held + '), so this test shows nothing';
      const checks = log.seen.slice(mark).filter(x => x.path === '/v1/checkstate');
      const biggest = Math.max(0, ...checks.map(x => x.body.Ys.length));
      if (biggest > sent + (swap.body.outputs || []).length) return 'a check asked about ' + biggest + ' proofs; the swap sent ' + sent;
      const pileYs = checks.filter(x => x.body.Ys.length === held);
      if (pileYs.length) return 'the whole pile was asked about';
    });

    for (const vb of [0, 1]) {
      await test('seed on the phone: mint, send, receive, melt change, a lost answer and restore make NUT-13\'s outputs for the words (' + (vb ? '01' : '00') + ' keyset)', async () => {
        const on = await nsFlow(vb);
        const id = on.P.mint.id;
        if (id.slice(0, 2) !== (vb ? '01' : '00')) return 'the mint\'s keyset is ' + id;
        if (!on.lostWas) return 'no swap answer was lost';
        /* NUT-13's outputs for the words, counter by counter, made here by the
         * bundled cashu-ts from the words' seed, as the words' own wallet makes
         * them: every output that reached the mint must be one, at a counter the
         * phone handed out. The blinded message does not depend on the amount. */
        const w = on.P.window;
        const realSeed = on.P.phone.toSeed(NS_WORDS);
        const next = on.P.phone.counters.get(NS_WORDS).get(id);
        const counterOf = new Map();
        for (let k = 0; k < next + 1000; k++) {
          counterOf.set(w.CashuTS.OutputData.createSingleDeterministicData(1, realSeed, k, id).blindedMessage.B_, k);
        }
        const made = new Set();
        for (const path of ['/v1/mint/bolt11', '/v1/swap', '/v1/melt/bolt11']) {
          const outs = on.P.mint.posted.filter(x => x.path === path).flatMap(x => x.B_);
          if (!outs.length) return 'the flow sent nothing to ' + path;
          const stray = outs.filter(b => !counterOf.has(b) || counterOf.get(b) >= next);
          if (stray.length) return stray.length + ' output(s) sent to ' + path + ' are not NUT-13\'s for the words below the phone\'s next counter';
          outs.forEach(b => made.add(counterOf.get(b)));
        }
        // every counter the phone handed out made one output, once
        if (made.size !== next) return 'the phone handed out ' + next + ' counters, and ' + made.size + ' outputs were made from them';
        const restored = on.P.mint.posted.filter(x => x.path === '/v1/restore').flatMap(x => x.B_);
        if (!restored.length || restored.some(b => !counterOf.has(b))) return 'a restore asked for outputs that are not the words\'';
        if (!on.P.mint.change.length) return 'the melt returned no change, so change was not made';
        if (on.recovered.sats !== 100) return 'the receive whose answer was lost: ' + on.recovered.sats;
        const onRow = on.rows[0];
        if (!onRow || onRow.state !== 'done' || !onRow.count || onRow.partial) return 'the rescan: ' + JSON.stringify(onRow && (onRow.why || onRow.missing || onRow.state));
        if (secretsOf(onRow.proofs) !== secretsOf(on.pile)) return 'the rescan did not find the pile';
        if (!(on.balance > 0) || on.claimed !== 300 || onRow.sats !== on.balance) {
          return 'amounts: ' + JSON.stringify([on.balance, on.claimed, on.paid.feeSats, onRow.sats]);
        }
        // the page wrote no counters of its own
        if (on.P.storage.getItem('foxy.counter.v1') !== null) return 'the page wrote counters to storage';
        // one round trip a reservation: no restore secrets asked before the first restore
        if (on.P.phone.asks.slice(0, on.asksBeforeLoss).some(a => a.action === 'restoreSecrets')) return 'secrets for new outputs were fetched apart from their reservation';
        if (!on.P.phone.asks.some(a => a.action === 'counterReserve' && a.count > 0)) return 'nothing was reserved on the phone';
        // no words asked for or turned into a seed, and every seeded wallet on the placeholder with the creator
        if (on.P.rec.bridge.some(a => WORD_ACTION.test(a))) return 'the page asked for the words: ' + on.P.rec.bridge.filter(a => WORD_ACTION.test(a));
        if (on.P.rec.toSeed !== 0) return 'the page turned words into a seed ' + on.P.rec.toSeed + ' times';
        const seeded = on.P.rec.wallets.filter(o => o.bip39seed);
        if (!seeded.length || !seeded.every(o => sameBytes(o.bip39seed, PLACEHOLDER) && o.outputDataCreator)) {
          return 'a wallet was built with a real seed, or without the creator';
        }
        if (on.W._secretsHeld() !== 0) return on.W._secretsHeld() + ' secrets still held after every operation used its own';
        // nothing that reached the mint was made from the placeholder
        const fromPlaceholder = new Set(w.CashuTS.OutputData.createDeterministicData(0, new w.Uint8Array(PLACEHOLDER), 0,
          { id, keys: on.P.mint.pubs }, Array(400).fill(0)).map(d => d.blindedMessage.B_));
        if (on.P.mint.posted.some(x => x.B_.some(b => fromPlaceholder.has(b)))) return 'an output made from the placeholder reached the mint';
        // the same words typed on another phone, scanned by candidate, ask the mint for the same outputs
        const other = nsPage({ words: NS_OTHER, mint: on.P.mint });
        await other.W.seedReady();
        other.phone.hooks.enter = () => NS_WORDS;
        const candidate = await other.W.enterSeedNative();
        const mark = on.P.mint.posted.length;
        const byCandidate = await other.W.scanSeed({ candidate }, [NS_MINT]);
        // a candidate is walked to three empty batches; this wallet's own scan stops at the phone's window
        if (!samePosts(on.P.mint.posted.slice(mark), on.scanPosts, '/v1/restore')) return 'a candidate\'s scan asked for different outputs';
        if (secretsOf(byCandidate[0].proofs) !== secretsOf(onRow.proofs)) return 'a candidate\'s scan found different proofs';
        return other.rec.toSeed ? 'the other page turned words into a seed' : null;
      });
    }

    await test('seed on the phone: boot never asks for the words, and sends the counters once', async () => {
      const KS0 = '00' + 'ab'.repeat(7), KS1 = '01' + 'cd'.repeat(32);
      const before = JSON.stringify({ [KS0]: 5, [KS1]: 7, 'I2yN+iRYfkzT': 9 });
      const phone = nativePhone({ words: NS_WORDS });
      const P = nsPage({ phone, storage: { 'foxy.counter.v1': before } });
      await P.W.seedReady();
      const asked = phone.asks.map(a => a.action).join();
      if (asked !== 'seedStatus,countersImport') return 'boot asked: ' + asked;
      if (JSON.stringify(phone.asks[1].counters) !== JSON.stringify({ [KS0]: 5, [KS1]: 7 })) return 'sent: ' + JSON.stringify(phone.asks[1].counters);
      if (!P.W.hasSeed()) return 'hasSeed is false';
      if (P.W.looksLikeReinstall()) return 'a wallet with counters looks like a reinstall';
      await P.W.connect(NS_MINT);
      if (phone.asks.map(a => a.action).join() !== asked) return 'connect asked again: ' + phone.asks.map(a => a.action).join();
      const inv = await P.W.invoice(64, '');
      await P.W.claim(inv.hash);
      if (P.storage.getItem('foxy.counter.v1') !== before) return 'the page\'s copy of its counters changed';
      if (!(phone.counters.get(phone.keychain.words).get(P.mint.id) > 0)) return 'the claim reserved nothing on the phone';
      // the next launch, from the same storage: asked whether a seed exists, and nothing sent again
      const kept = {};
      for (let i = 0; i < P.storage.length; i++) kept[P.storage.key(i)] = P.storage.getItem(P.storage.key(i));
      const had = phone.asks.length;
      const Q = nsPage({ phone, storage: kept });
      await Q.W.seedReady();
      await Q.W.connect(NS_MINT);
      const again = phone.asks.slice(had).map(a => a.action).join();
      if (again !== 'seedStatus') return 'the next launch asked: ' + again;
      if (P.rec.toSeed || Q.rec.toSeed) return 'words were turned into a seed in the page';
      if (P.rec.bridge.concat(Q.rec.bridge).some(a => WORD_ACTION.test(a))) return 'the words were asked for';
      // a reinstall: the phone's seed, and nothing this app wrote but the stamps
      const R = nsPage({ phone });
      await R.W.seedReady();
      if (!R.W.looksLikeReinstall()) return 'a reinstall does not look like one';
      // a phone that cannot say: connect refuses, nothing is made, and the next connect asks again
      const S = nsPage({ words: NS_WORDS });
      S.phone.hooks.refuse = m => (m.action === 'seedStatus' ? 'the seed could not be read' : null);
      await S.W.seedReady();
      const refused = await threw(() => S.W.connect(NS_MINT));
      if (!refused || !/the seed could not be read/.test(refused.message)) return 'connect with no answer: ' + (refused && refused.message);
      if (S.phone.asks.some(a => a.action === 'seedCreate') || S.keychain.words !== NS_WORDS) return 'a seed was made while the phone could not read its own';
      S.phone.hooks.refuse = null;
      await S.W.connect(NS_MINT);
      return null;
    });

    await test('seed on the phone: outputs a mint signed before move the phone\'s counters on with counterAdvance, never down', async () => {
      const A = nsPage({ words: NS_WORDS });
      await A.W.seedReady();
      await A.W.connect(NS_MINT);
      await A.W.claim((await A.W.invoice(300, '')).hash);
      await A.W.sendToken(100);
      // the same seed on a phone whose counters start from nothing, at the same mint
      const B = nsPage({ words: NS_WORDS, mint: A.mint });
      await B.W.seedReady();
      await B.W.connect(NS_MINT);
      await B.W.claim((await B.W.invoice(64, '')).hash);
      if (await B.W.balanceSats() !== 64) return 'balance ' + await B.W.balanceSats();
      const moves = B.phone.asks.filter(a => a.action === 'counterAdvance');
      if (!moves.length) return 'the counters were not moved on the phone';
      if (moves.some((a, i) => i && a.next <= moves[i - 1].next)) return 'moves: ' + moves.map(a => a.next).join();
      if (B.phone.lowered.length) return 'asked to move a counter down: ' + JSON.stringify(B.phone.lowered);
      if (!(B.phone.counters.get(NS_WORDS).get(A.mint.id) >= moves[moves.length - 1].next)) return 'the counter is behind its last move';
      return B.storage.getItem('foxy.counter.v1') === null ? null : 'counters were written to storage';
    });

    await test('seed on the phone: a restore past the phone\'s window is refused, and the row is partial, not a crash', async () => {
      const P = nsPage({ words: NS_WORDS, window: 50 });
      P.W.RESTORE_RETRY_MS = 1;
      await P.W.seedReady();
      await P.W.connect(NS_MINT);
      await P.W.claim((await P.W.invoice(300, '')).hash);
      const rows = await P.W.scanSeed(null, [NS_MINT]);
      const row = rows[0];
      if (!row || row.state !== 'done') return 'row: ' + JSON.stringify(row && (row.why || row.state));
      if (!row.partial || !row.missing.includes(P.mint.id)) return 'not partial: ' + JSON.stringify({ partial: row.partial, missing: row.missing });
      const asks = P.phone.asks.filter(a => a.action === 'restoreSecrets');
      if (asks.length !== 1) return 'asked ' + asks.length + ' times for a range the phone refuses';
      // the usual window: the same scan finishes and finds the claim
      P.phone.window = 1000;
      const again = (await P.W.scanSeed(null, [NS_MINT]))[0];
      if (again.partial || again.sats !== 300) return 'with the window: ' + JSON.stringify({ partial: again.partial, sats: again.sats });
      // the page stops at the window itself: batches of 150 reach it before ten empty batches, partial, and never refused
      const Q = nsPage({ words: NS_WORDS, mint: P.mint });
      Q.W.RESTORE_BATCH = 150;
      await Q.W.seedReady();
      const clipped = (await Q.W.scanSeed(null, [NS_MINT]))[0];
      const qAsks = Q.phone.asks.filter(a => a.action === 'restoreSecrets');
      if (!clipped.partial || clipped.sats !== 300) return 'at the window: ' + JSON.stringify({ partial: clipped.partial, sats: clipped.sats, why: clipped.why });
      if (qAsks.map(a => a.start + '+' + a.count).join() !== '0+150,150+150,300+150,450+150,600+150,750+150,900+100') return 'asks: ' + qAsks.map(a => a.start + '+' + a.count).join();
      // adopting it moves the phone's counter to past what the mint signed
      await Q.W.adoptScan([clipped], { merge: true });
      return Q.phone.counters.get(NS_WORDS).get(P.mint.id) === clipped.counters[P.mint.id] ? null
        : 'counter after adopting: ' + Q.phone.counters.get(NS_WORDS).get(P.mint.id);
    });

    await test('seed on the phone: words typed on the phone are scanned, adopted (no, yes, same), set the counters, and keep late arrivals', async () => {
      // wallet X: NS_OTHER's 300 at the mint, made on its own phone
      const X = nsPage({ words: NS_OTHER });
      await X.W.seedReady();
      await X.W.connect(NS_MINT);
      await X.W.claim((await X.W.invoice(300, '')).hash);
      // wallet B: its own seed, with 64 of its own at the same mint
      const B = nsPage({ words: NS_WORDS, mint: X.mint });
      const W = B.W, pb = B.phone;
      W.RESTORE_RETRY_MS = 1;
      await W.seedReady();
      await W.connect(NS_MINT);
      await W.claim((await W.invoice(64, '')).hash);
      const mine = JSON.parse(B.storage.getItem(NS_PILE)).map(p => p.secret);
      pb.hooks.enter = () => null;
      if (await W.enterSeedNative() !== null) return 'a cancel on the phone gave a candidate';
      pb.hooks.enter = () => NS_OTHER;
      const candidate = await W.enterSeedNative();
      if (typeof candidate !== 'string' || !candidate) return 'candidate: ' + candidate;
      const rows = await W.scanSeed({ candidate }, [NS_MINT]);
      if (rows[0].state !== 'done' || rows[0].sats !== 300 || rows[0].partial) return 'scan: ' + JSON.stringify({ state: rows[0].state, sats: rows[0].sats, why: rows[0].why });
      if (pb.asks.some(a => a.action === 'restoreSecrets' && a.candidate !== candidate)) return 'the candidate\'s scan asked for this wallet\'s own secrets';
      // No, in the phone's Replace alert
      pb.hooks.adopt = () => false;
      const counted = phoneCounters(pb);
      const no = await threw(() => W.adoptScan(rows, { candidate, overwrite: true }));
      if (!no || !/Nothing was changed/.test(no.message)) return 'a No: ' + (no && no.message);
      if (pb.keychain.words !== NS_WORDS || phoneCounters(pb) !== counted) return 'the seed or its counters changed after a No';
      if (JSON.parse(B.storage.getItem(NS_PILE)).length !== mine.length) return 'the pile changed after a No';
      if (pb.asks.some(a => a.action === 'counterAdvance')) return 'counters moved after a No';
      const unknown = await threw(() => W.adoptScan(rows, { candidate: 'nope', overwrite: true }));
      if (!unknown || !/unknown candidate/.test(unknown.message)) return 'an unknown candidate: ' + (unknown && unknown.message);
      // Yes
      pb.hooks.adopt = () => true;
      await W.adoptScan(rows, { candidate, overwrite: true });
      if (pb.keychain.words !== NS_OTHER) return 'the phone did not adopt the words';
      if (!pb.aside.some(x => x.words === NS_WORDS)) return 'the old seed\'s counters were not set aside';
      const next = pb.counters.get(NS_OTHER).get(X.mint.id);
      if (!(next >= rows[0].counters[X.mint.id])) return 'counter ' + next + ', the scan saw ' + rows[0].counters[X.mint.id];
      const pile = JSON.parse(B.storage.getItem(NS_PILE));
      if (sumOf(pile) !== 364 || !mine.every(s => pile.some(p => p.secret === s))) return 'pile after adopting: ' + sumOf(pile);
      // a mint answering late, adopted with overwrite and no candidate, keeps the replaced seed's proofs
      const late = await W.scanSeed(null, [NS_MINT]);
      await W.adoptScan(late, { overwrite: true });
      const pile2 = JSON.parse(B.storage.getItem(NS_PILE));
      if (!mine.every(s => pile2.some(p => p.secret === s)) || sumOf(pile2) !== 364) return 'a late adoption dropped the replaced seed\'s proofs: ' + sumOf(pile2);
      // the restored seed spends with no used-output skips
      const moved = pb.asks.filter(a => a.action === 'counterAdvance').length;
      const t = await W.sendToken(10);
      if (t.sats !== 10 || pb.asks.filter(a => a.action === 'counterAdvance').length !== moved) return 'spending after the restore moved counters on';
      // X's own words, typed on X's phone: "same", no Replace alert, and nothing replaced
      X.phone.hooks.enter = () => NS_OTHER;
      let alerted = false;
      X.phone.hooks.adopt = () => { alerted = true; return true; };
      const same = await X.W.enterSeedNative();
      const xrows = await X.W.scanSeed({ candidate: same }, [NS_MINT]);
      await X.W.adoptScan(xrows, { candidate: same, merge: true });
      if (alerted || X.keychain.words !== NS_OTHER || X.phone.aside.length) return 'the same words replaced the seed';
      if (!(await W.forgetSeedCandidate(candidate)) || pb.candidates.has(candidate)) return 'the candidate was not forgotten';
      if (B.rec.toSeed || B.rec.bridge.some(a => WORD_ACTION.test(a))) return 'the page used the words';
      return null;
    });

    await test('seed on the phone: a wipe is the phone\'s, and a No there erases nothing', async () => {
      const P = nsPage({ words: NS_WORDS });
      await P.W.seedReady();
      await P.W.connect(NS_MINT);
      await P.W.claim((await P.W.invoice(100, '')).hash);
      P.phone.hooks.wipe = () => false;
      const no = await threw(() => P.W.wipeDevice());
      if (!no || !/Nothing was erased/.test(no.message)) return 'a No: ' + (no && no.message);
      if (await P.W.balanceSats() !== 100 || P.keychain.words !== NS_WORDS) return 'something was erased after a No';
      P.phone.hooks.wipe = () => true;
      const res = await P.W.wipeDevice();
      if (!res.created || !(res.removed > 0) || res.words) return 'wipe: ' + JSON.stringify(res);
      if (!P.keychain.words || P.keychain.words === NS_WORDS) return 'the phone has no new seed';
      for (let i = 0; i < P.storage.length; i++) if (/^foxy\./.test(P.storage.key(i))) return 'storage kept ' + P.storage.key(i);
      if (!P.W.hasSeed()) return 'no seed after the wipe';
      await P.W.connect(NS_MINT);
      await P.W.claim((await P.W.invoice(50, '')).hash);
      if (await P.W.balanceSats() !== 50) return 'balance on the new seed: ' + await P.W.balanceSats();
      // forgetting under the switch is the phone's wipe as well, and leaves storage as forgetting always did
      if (await P.W.seedForget() !== 'replaced' || await P.W.balanceSats() !== 50) return 'seedForget';
      if (P.rec.bridge.some(a => WORD_ACTION.test(a)) || P.rec.toSeed) return 'the words were used';
      return null;
    });

    await test('seed on the phone: BACKUP and its quiz are the phone\'s, and words given to the page are refused', async () => {
      const P = nsPage({ words: NS_WORDS });
      await P.W.seedReady();
      if (typeof P.W.seedWords !== 'undefined' || typeof P.W.seedOnPhone !== 'undefined') return 'the page still has a way to ask for the words';
      P.phone.hooks.show = () => false;
      let r = await P.W.showSeedNative({ verify: false });
      if (r.verified || P.W.backedUp()) return 'marked backed up without a quiz';
      P.phone.hooks.show = ({ verify }) => verify;
      r = await P.W.showSeedNative({ verify: true });
      if (!r.verified || !P.W.backedUp()) return 'a quiz passed on the phone did not mark the backup';
      if (JSON.stringify(P.phone.asks.filter(a => a.action === 'seedShow').map(a => a.verify)) !== '[false,true]') return 'seedShow asks';
      const scan = await threw(() => P.W.scanSeed(NS_WORDS, [NS_MINT]));
      if (!scan || !/on the phone/.test(scan.message)) return 'a scan of words: ' + (scan && scan.message);
      const adopt = await threw(() => P.W.adoptScan([], { words: NS_WORDS }));
      if (!adopt || !/on the phone/.test(adopt.message)) return 'an adoption of words: ' + (adopt && adopt.message);
      return P.rec.toSeed ? 'the page turned words into a seed' : null;
    });

    await test('seed on the phone: a missing secret throws, a used one is gone, and a real seed is refused', async () => {
      const P = nsPage({ window: Number.MAX_SAFE_INTEGER });
      await P.W.seedReady();
      await P.W.connect(NS_MINT);
      const made = P.rec.wallets.find(o => o.outputDataCreator);
      if (!made) return 'connect built no wallet with the creator';
      const cr = made.outputDataCreator, w = P.window, id = P.mint.id;
      const place = new w.Uint8Array(PLACEHOLDER);
      const keyset = { id, keys: P.mint.pubs };
      const threwSync = (fn, re) => { try { fn(); return 'did not throw'; } catch (e) { return re.test(e.message) ? null : e.message; } };
      let why = threwSync(() => cr.createDeterministicData(13, place, 5000, keyset), /no secret from the phone for counter 5000 /);
      if (why) return 'a batch with no secrets: ' + why;
      why = threwSync(() => cr.createSingleDeterministicData(1, place, 5000, id), /will not make one from the placeholder seed/);
      if (why) return 'a single output with no secret: ' + why;
      await P.W._fetchSecrets(id, 5000, 3);
      const real = w.FoxyBip39.mnemonicToSeedSync(NS_WORDS);
      why = threwSync(() => cr.createSingleDeterministicData(1, real, 5000, id), /only for wallets built on the placeholder seed/);
      if (why) return 'a real seed: ' + why;
      const mine = cr.createDeterministicData(3, place, 5000, keyset, [1, 1, 1]);
      const want = w.CashuTS.OutputData.createDeterministicData(3, real, 5000, keyset, [1, 1, 1]);
      if (mine.map(d => d.blindedMessage.B_).join() !== want.map(d => d.blindedMessage.B_).join()) return 'outputs from the phone\'s secrets are not NUT-13\'s';
      if (mine.map(d => Array.from(d.secret).join('.')).join() !== want.map(d => Array.from(d.secret).join('.')).join()) return 'secrets differ';
      if (mine.map(d => String(d.blindingFactor)).join() !== want.map(d => String(d.blindingFactor)).join()) return 'blinding factors differ';
      why = threwSync(() => cr.createSingleDeterministicData(1, place, 5001, id), /counter 5001 /);
      if (why) return 'a secret used twice: ' + why;
      // a candidate's secrets are its own: this wallet's creator does not take them
      P.phone.hooks.enter = () => NS_OTHER;
      const candidate = await P.W.enterSeedNative();
      await P.W._fetchSecrets(id, 0, 2, candidate);
      why = threwSync(() => cr.createSingleDeterministicData(1, place, 0, id), /no secret from the phone for counter 0 /);
      if (why) return 'this wallet\'s creator took a candidate\'s secret: ' + why;
      P.W._resumed(0);
      if (P.W._secretsHeld() !== 0) return 'still held after coming back: ' + P.W._secretsHeld();
      return eq(cr.createRandomData(3, keyset, [1, 2]).length, 2, 'random outputs, which are cashu-ts\'s own');
    });

    await test('seed on the phone: a refused reservation fails a swap before it is sent, and keeps its counters', async () => {
      let refuse = false;
      const P = nsPage({});
      P.phone.hooks.refuse = m => (refuse && m.action === 'counterReserve' ? 'the seed could not be read' : null);
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      await W.claim((await W.invoice(300, '')).hash);
      const swaps = () => P.mint.posted.filter(x => x.path === '/v1/swap').length;
      const counter = () => P.phone.counters.get(NS_WORDS).get(P.mint.id) || 0;
      const sent = swaps(), before = counter();
      refuse = true;
      const err = await threw(() => W.sendToken(100));
      if (!err) return 'the send went through with the phone refusing';
      if (!/the seed could not be read/.test(err.message)) return 'it said: ' + err.message;
      if (swaps() !== sent) return 'a swap reached the mint';
      if (counter() < before) return 'the counter moved down, from ' + before + ' to ' + counter();
      if (await W.balanceSats() !== 300) return 'balance ' + await W.balanceSats() + ' after the refused send';
      refuse = false;
      const t = await W.sendToken(100);
      if (swaps() !== sent + 1) return 'the send once the phone answers did not swap once';
      return eq(t.sats, 100, 'the send once the phone answers');
    });

    await test('seed on the phone: restore secrets go 1000 at a time, a range past 2^31 is never asked, and the keyset id\'s case does not matter', async () => {
      const P = nsPage({ words: '', window: Number.MAX_SAFE_INTEGER });
      const W = P.W;
      await W.seedReady();
      await W.connect(NS_MINT);
      if (!P.keychain.words) return 'no seed was made';
      if (P.phone.asks.map(a => a.action).join() !== 'seedStatus,seedCreate') return 'asks while connecting: ' + P.phone.asks.map(a => a.action).join();
      if (P.rec.toSeed) return 'the new words were turned into a seed in the page';
      const restores = () => P.phone.asks.filter(a => a.action === 'restoreSecrets');
      await W._fetchSecrets(P.mint.id, 7, 2500);
      if (restores().map(a => a.start + '+' + a.count).join() !== '7+1000,1007+1000,2007+500') return 'asks: ' + JSON.stringify(restores());
      if (W._secretsHeld() !== 2500) return 'held ' + W._secretsHeld();
      await W._fetchSecrets(P.mint.id, 100, 50);
      if (restores().length !== 3) return 'asked again for secrets already held';
      W._resumed(0);
      if (W._secretsHeld() !== 0) return 'coming back from the background left ' + W._secretsHeld() + ' held';
      if (await threw(() => W._fetchSecrets('9f2c', 0, 1)) === null || restores().length !== 3) return 'a keyset id that is not 00 or 01 was asked for';
      // native's last counter on a 00 keyset is 2^31 - 1: a range past it is refused whole, never asked in part
      if (await threw(() => W._fetchSecrets(P.mint.id, 2 ** 31 - 1000, 1500)) === null || restores().length !== 3) return 'a range past counter 2^31 - 1 was asked for';
      await W._fetchSecrets(P.mint.id, 2 ** 31 - 2, 2);
      if (restores().length !== 4 || W._secretsHeld() !== 2) return 'the range ending at 2^31 - 1 was not fetched';
      // an uppercase keyset id is asked in lowercase, and an answer echoing uppercase is still taken
      W._resumed(0);
      P.phone.shout = true;
      await W._fetchSecrets(P.mint.id.toUpperCase(), 0, 2);
      if (restores()[4].keysetId !== P.mint.id || W._secretsHeld() !== 2) return 'asked ' + JSON.stringify(restores()[4]) + ', held ' + W._secretsHeld();
      return null;
    });

    /* The used-output skip moves a keyset on 10, then 50, then 100, each from
     * the phone's next counter: inside native's cap of 100 past next. */
    await test('seed on the phone: the used-output skip moves 10, 50 and 100 past the phone\'s next counter, and the phone never refuses a move', async () => {
      const A = nsPage({ words: NS_WORDS });
      await A.W.seedReady();
      await A.W.connect(NS_MINT);
      const id = A.mint.id;
      // A's outputs at counters 0, 11 and 62: where B's claim lands at first and after each skip
      for (const at of [0, 11, 62]) {
        A.phone.counters.set(NS_WORDS, new Map([[id, at]]));
        await A.W.claim((await A.W.invoice(64, '')).hash);
      }
      const B = nsPage({ words: NS_WORDS, mint: A.mint });
      await B.W.seedReady();
      await B.W.connect(NS_MINT);
      const warned = [];
      const warn = B.window.console.warn;
      B.window.console.warn = (...a) => { warned.push(a.join(' ')); };
      await B.W.claim((await B.W.invoice(64, '')).hash);
      B.window.console.warn = warn;
      const skips = warned.map(l => (/moving the counters on by (\d+)/.exec(l) || [])[1]).filter(Boolean).join();
      if (skips !== '10,50,100') return 'skips: ' + skips;
      if (await B.W.balanceSats() !== 64) return 'balance ' + await B.W.balanceSats();
      const moves = B.phone.asks.filter(a => a.action === 'counterAdvance').map(a => a.next).join();
      if (moves !== '11,62,163') return 'moves: ' + moves;
      return B.phone.refusals.length ? 'the phone refused: ' + JSON.stringify(B.phone.refusals) : null;
    });

    /* Three mints, each with a keyset of its own, and X's ecash at each. */
    async function threeMints(o) {
      const base = nsPage({});
      const mints = { 'a.test': fakeMint(base.window, { fill: 7 }), 'b.test': fakeMint(base.window, { fill: 8 }), 'c.test': fakeMint(base.window, { fill: 9 }) };
      const router = { mints, handle: (m) => mints[new URL(m.url).host].handle(m) };
      const X = nsPage({ words: NS_OTHER, mint: router });
      await X.W.seedReady();
      const want = { 'https://a.test': 100, 'https://b.test': 200, 'https://c.test': 300 };
      // c's ecash past counter 150: further on than a counter move of 100 without a served restore range
      if (o && o.farAtC) X.phone.counters.set(NS_OTHER, new Map([[mints['c.test'].id, 150]]));
      for (const url of Object.keys(want)) {
        await X.W.connect(url);
        await X.W.claim((await X.W.invoice(want[url], '')).hash);
      }
      return { router, mints, want };
    }

    /* Native seed review, M6. The words are adopted when the first mint answers,
     * while the scan is still walking the others with their candidate. Native
     * now keeps the adopted candidate until the page forgets it; the page forgets
     * it only once the scan has ended. */
    await test('M6 a scan of three mints with the words adopted after the first: the others finish on the words, late mints are kept, and the candidate is forgotten only after the scan', async () => {
      const { router, mints, want } = await threeMints({ farAtC: true });
      const B = nsPage({ words: NS_WORDS, mint: router });
      B.W.RESTORE_RETRY_MS = 1;
      await B.W.seedReady();
      B.phone.hooks.enter = () => NS_OTHER;
      const candidate = await B.W.enterSeedNative();
      let adopting = null, forgetting = null;
      const rows = await B.W.scanSeed({ candidate }, Object.keys(want), (row) => {
        if (row.url === 'https://a.test' && row.state === 'done' && !adopting) {
          // as the restore screen does: adopt, then forget the candidate straight away
          adopting = B.W.adoptScan([row], { candidate, overwrite: true }).then(() => { forgetting = B.W.forgetSeedCandidate(candidate); });
        }
      });
      await adopting;
      await forgetting;
      const asks = B.phone.asks;
      const adoptAt = asks.findIndex(a => a.action === 'seedAdopt');
      const lastByWords = asks.map((a, i) => (a.action === 'restoreSecrets' && a.candidate === candidate ? i : -1)).reduce((x, y) => Math.max(x, y), -1);
      const forgotAt = asks.findIndex(a => a.action === 'seedCandidateForget');
      if (!(adoptAt >= 0 && adoptAt < lastByWords)) return 'the words were not adopted mid-scan (adopt ' + adoptAt + ', last batch ' + lastByWords + ')';
      if (!(forgotAt > lastByWords)) return 'the candidate was forgotten while the scan still asked with it';
      if (B.keychain.words !== NS_OTHER) return 'not adopted';
      const byUrl = Object.fromEntries(rows.map(r => [r.url, r]));
      for (const url of Object.keys(want)) {
        const r = byUrl[url];
        if (!r || r.state !== 'done' || r.partial || r.sats !== want[url]) return url + ': ' + JSON.stringify(r && { state: r.state, partial: r.partial, sats: r.sats, why: r.why, missing: r.missing });
      }
      if (B.phone.refusals.length) return 'the phone refused: ' + JSON.stringify(B.phone.refusals);
      // the mints that answered after the adopt, kept as they arrived (merge); c's counter moves past 150 in served steps
      await B.W.adoptScan([byUrl['https://b.test'], byUrl['https://c.test']], { merge: true });
      for (const url of Object.keys(want)) {
        const pile = JSON.parse(B.storage.getItem('foxy.cashu.proofs.' + url) || '[]');
        if (sumOf(pile) !== want[url]) return 'pile at ' + url + ': ' + sumOf(pile);
      }
      const cId = mints['c.test'].id, cMark = byUrl['https://c.test'].counters[cId];
      if (!(cMark > 150) || B.phone.nextOf(cId) !== cMark) return 'c\'s counter ' + B.phone.nextOf(cId) + ', the scan saw ' + cMark;
      if (B.phone.refusals.length) return 'the phone refused a late adoption: ' + JSON.stringify(B.phone.refusals);
      return B.phone.candidates.has(candidate) ? 'the candidate was never forgotten' : null;
    });

    await test('M6 the phone dropping the adopted words mid-scan (Foxy in the background): later batches restore with the wallet\'s own seed, and a rescan of any row left partial finishes', async () => {
      const { router, want } = await threeMints();
      const B = nsPage({ words: NS_WORDS, mint: router });
      B.W.RESTORE_RETRY_MS = 1;
      await B.W.seedReady();
      B.phone.hooks.enter = () => NS_OTHER;
      const candidate = await B.W.enterSeedNative();
      let adopting = null;
      const rows = await B.W.scanSeed({ candidate }, Object.keys(want), (row) => {
        if (row.url === 'https://a.test' && row.state === 'done' && !adopting) {
          adopting = B.W.adoptScan([row], { candidate, overwrite: true }).then(() => B.phone.background());
        }
      });
      await adopting;
      if (!B.phone.refusals.some(r => r.error === 'unknown candidate')) return 'the phone never dropped the words mid-scan';
      const byUrl = Object.fromEntries(rows.map(r => [r.url, r]));
      for (const url of Object.keys(want)) {
        const r = byUrl[url];
        if (!r || r.state !== 'done' || r.sats !== want[url]) return url + ': ' + JSON.stringify(r && { state: r.state, partial: r.partial, sats: r.sats, missing: r.missing });
      }
      const other = B.phone.refusals.filter(r => r.error !== 'unknown candidate' && r.error !== 'outside the restore window');
      if (other.length) return 'the phone refused: ' + JSON.stringify(other);
      // the late mints kept as they arrived, then what is left partial (the window of the wallet's own seed) scanned again
      await B.W.adoptScan([byUrl['https://b.test'], byUrl['https://c.test']], { merge: true });
      const left = rows.filter(r => r.partial).map(r => r.url);
      if (left.length) {
        const again = await B.W.scanSeed(null, left);
        const bad = again.filter(r => r.state !== 'done' || r.partial || r.sats !== want[r.url]);
        if (bad.length) return 'the rescan: ' + JSON.stringify(bad.map(r => ({ url: r.url, partial: r.partial, sats: r.sats })));
      }
      for (const url of Object.keys(want)) {
        const pile = JSON.parse(B.storage.getItem('foxy.cashu.proofs.' + url) || '[]');
        if (sumOf(pile) !== want[url]) return 'pile at ' + url + ': ' + sumOf(pile);
      }
      return null;
    });

    /* Native seed review, L10: a held melt's change and a lost swap's ranges do
     * not name their seed, so new words wait until they settle. */
    await test('L10 new words are not adopted while a payment or swap is still settling; the wallet\'s own words are, and a candidate never scanned waits', async () => {
      const X = nsPage({ words: NS_OTHER });
      await X.W.seedReady();
      await X.W.connect(NS_MINT);
      await X.W.claim((await X.W.invoice(100, '')).hash);
      const B = nsPage({ words: NS_WORDS, mint: X.mint });
      await B.W.seedReady();
      await B.W.connect(NS_MINT);
      await B.W.claim((await B.W.invoice(64, '')).hash);
      B.phone.hooks.enter = () => NS_OTHER;
      const other = await B.W.enterSeedNative();
      const rows = await B.W.scanSeed({ candidate: other }, [NS_MINT]);
      B.phone.hooks.enter = () => NS_WORDS;
      let own = await B.W.enterSeedNative();
      const ownRows = await B.W.scanSeed({ candidate: own }, [NS_MINT]);
      const SETTLING = 'A payment or swap is still settling. Wait for it to finish before replacing the seed.';
      const holds = [
        ['foxy.cashu.melting', [{ quote: 'm1', mint: NS_MINT, proofs: [], amount: 1, at: 1 }]],
        ['foxy.cashu.swaps', [{ id: 'send-1', kind: 'send', mint: NS_MINT, unit: 'sat', at: 1, amount: 1, outputs: [{ keysetId: X.mint.id, start: 0, count: 1 }] }]],
        /* Ecash paid to a payment request, arrived and not swapped in yet. It
         * is locked to a key this seed derives at NUT-13's P2PK path, and a
         * Replace sets the lock index aside with the counters — so the new seed
         * derives a different key at every index and the only thing that opens
         * those proofs is gone. Missed when the delayed claim was built: the
         * money had left the payer, was counted in the balance, and nothing
         * stood between it and a restore of other words. */
        ['foxy.req.unclaimed', { 'req-1': { token: 'cashuBwaiting', at: 1, sats: 9 } }],
      ];
      const adopts = () => B.phone.asks.filter(a => a.action === 'seedAdopt').length;
      for (const [key, value] of holds) {
        B.storage.setItem(key, JSON.stringify(value));
        const before = adopts();
        const refused = await threw(() => B.W.adoptScan(rows, { candidate: other, overwrite: true }));
        if (!refused || refused.message !== SETTLING) return key + ': ' + (refused && refused.message);
        if (adopts() !== before || B.keychain.words !== NS_WORDS) return key + ': the phone was asked to replace the seed';
        await B.W.adoptScan(ownRows, { candidate: own, merge: true });
        if (adopts() !== before + 1 || B.keychain.words !== NS_WORDS) return key + ': the wallet\'s own words were not let through';
        B.storage.removeItem(key);
      }
      await B.W.forgetSeedCandidate(own);
      own = await B.W.enterSeedNative();
      B.storage.setItem(holds[0][0], JSON.stringify(holds[0][1]));
      const unscanned = await threw(() => B.W.adoptScan([], { candidate: own }));
      if (!unscanned || unscanned.message !== SETTLING) return 'a candidate never scanned: ' + (unscanned && unscanned.message);
      B.storage.removeItem(holds[0][0]);
      /* A payment nothing here can open does not hold the wallet.
       *
       * `claimUnclaimed` marks an entry stranded when the claim comes back
       * "locked to someone else's key": this seed cannot open it, so it is not
       * waiting for anything and never will be. Counted, it would refuse every
       * restore of other words until the app was reinstalled — the trap the
       * locked-send carve-out above was written for, reached by another road.
       * Left here across the adopt below, which must go through. */
      B.storage.setItem('foxy.req.unclaimed',
        JSON.stringify({ 'req-2': { token: 'cashuBstranded', at: 1, sats: 9, stranded: true } }));
      const held = await threw(() => B.W.adoptScan(rows, { candidate: other, overwrite: true }));
      if (held) return 'a stranded payment held the seed: ' + held.message;
      B.storage.removeItem('foxy.req.unclaimed');
      return eq(B.keychain.words, NS_OTHER, 'the seed once nothing was settling');
    });

    await test('seed on the phone: no flow above met the phone\'s cap on counter moves ("too far ahead"): skips, lost answers, scans and their adoption', async () => {
      const hit = nsPhones.filter(p => p.refusals.some(r => r.error === 'too far ahead'));
      if (nsPhones.length < 20) return 'only ' + nsPhones.length + ' phones ran';
      return hit.length ? hit.length + ' phone(s) refused a counter move: ' + JSON.stringify(hit.map(p => p.refusals.filter(r => r.error === 'too far ahead'))) : null;
    });

    /* ---- the phone mock is native's rules (harness.js NATIVE_RULES) ----
     * Every test above runs on it, so what it lets through is what the page is
     * tested against. These hold it to the contract native keeps after the
     * review's fixes. */
    {
      const { NATIVE_SAYS: SAYS } = require('./harness');
      const page = {};
      const ask = async (ph, action, extra, w) => {
        const r = await ph.answer(w || page, Object.assign({ action, id: 'x' }, extra || {}));
        return r[1] ? { error: r[1] } : JSON.parse(r[0]);
      };
      // four 00 ids with one derivation index, 864559728 (review H1)
      const ALIASES = ['009a1f293253e41e', '0000000033882270', '009a1f29b253e41d', '009a1f28b253e41f'];

      await test('phone mock: 00 keyset ids with one derivation index share one counter, keyed by the first id stored', async () => {
        const ph = nativePhone({ words: NS_WORDS });
        const [a, b, c, d] = ALIASES;
        if ((await ask(ph, 'counterReserve', { keysetId: a, count: 5 })).start !== 0) return 'the first reservation';
        const r2 = await ask(ph, 'counterReserve', { keysetId: b, count: 3 });
        if (r2.start !== 5) return 'an alias reached a counter of its own: ' + JSON.stringify(r2);
        if ((await ask(ph, 'counterAdvance', { keysetId: c, next: 20 })).next !== 20) return 'an advance by an alias';
        if ((await ask(ph, 'counterReserveAt', { keysetId: d, start: 10, count: 1 })).error !== SAYS.issued) return 'an alias reserved an issued range';
        if ((await ask(ph, 'restoreSecrets', { keysetId: b, start: 21, count: 1000 })).error !== SAYS.window) return 'an alias was restored past the index\'s window';
        const snap = await ask(ph, 'counterSnapshot');
        return JSON.stringify(snap.counters) === JSON.stringify({ [a]: 20 }) ? null : 'snapshot: ' + JSON.stringify(snap);
      });

      await test('phone mock: counter moves stop at 100 past next or a served restore range, at the version\'s last counter, and at 256 keysets', async () => {
        const ph = nativePhone({ words: NS_WORDS });
        const K00 = '00' + 'ab'.repeat(7);
        if ((await ask(ph, 'counterAdvance', { keysetId: K00, next: 101 })).error !== SAYS.ahead) return 'an advance to 101 from 0';
        if ((await ask(ph, 'counterAdvance', { keysetId: K00, next: 100 })).next !== 100) return 'an advance to 100';
        if ((await ask(ph, 'counterReserveAt', { keysetId: K00, start: 201, count: 1 })).error !== SAYS.ahead) return 'reserveAt 101 past next';
        if ((await ask(ph, 'counterReserveAt', { keysetId: K00, start: 200, count: 1 })).start !== 200) return 'reserveAt 100 past next';
        // next is 201: a restore served to 450 lets the counter follow it there, and no further
        if ((await ask(ph, 'restoreSecrets', { keysetId: K00, start: 400, count: 50 })).error) return 'a restore inside the window';
        if ((await ask(ph, 'counterAdvance', { keysetId: K00, next: 451 })).error !== SAYS.ahead) return 'an advance past the served range';
        if ((await ask(ph, 'counterAdvance', { keysetId: K00, next: 450 })).next !== 450) return 'an advance to the served range';
        if ((await ask(ph, 'counterAdvance', { keysetId: K00, next: 3 })).next !== 450) return 'a lower next moved the counter';
        // a new app session forgets what was served
        await ask(ph, 'restoreSecrets', { keysetId: K00, start: 700, count: 50 });
        ph.relaunch();
        if ((await ask(ph, 'counterAdvance', { keysetId: K00, next: 700 })).error !== SAYS.ahead) return 'a range served before a relaunch still counted';
        // the last counter of a 00 keyset: next at most 2^31
        ph.counters.get(NS_WORDS).set(K00, 2 ** 31 - 50);
        if ((await ask(ph, 'counterAdvance', { keysetId: K00, next: 2 ** 31 })).next !== 2 ** 31) return 'an advance to 2^31';
        if ((await ask(ph, 'counterAdvance', { keysetId: K00, next: 2 ** 31 + 1 })).error !== SAYS.outOfRange) return 'an advance past 2^31';
        if ((await ask(ph, 'counterReserve', { keysetId: K00, count: 1 })).error !== SAYS.outOfRange) return 'a reservation past 2^31';
        const many = {};
        for (let i = 0; i < 255; i++) many['01' + i.toString(16).padStart(64, '0')] = 1;
        if ((await ask(ph, 'countersImport', { counters: many })).error) return 'an import to 256 keysets';
        if ((await ask(ph, 'counterReserve', { keysetId: '01' + 'ff'.repeat(32), count: 1 })).error !== SAYS.keysets) return 'a 257th keyset';
        return null;
      });

      await test('phone mock: countersImport runs once per install and needs no seed, nor does a peek', async () => {
        const ph = nativePhone({ words: '' });
        const K00 = '00' + 'cd'.repeat(7);
        const peek = await ask(ph, 'counterReserve', { keysetId: K00, count: 0 });
        if (peek.error || peek.start !== 0) return 'a peek with no seed: ' + JSON.stringify(peek);
        if ((await ask(ph, 'counterReserve', { keysetId: K00, count: 1 })).error !== SAYS.noSeed) return 'a reservation with no seed';
        const first = await ask(ph, 'countersImport', { counters: { [K00]: 40 } });
        if (first.error || first.counters[K00] !== 40) return 'an import with no seed: ' + JSON.stringify(first);
        if ((await ask(ph, 'countersImport', { counters: { [K00]: 90 } })).error !== SAYS.imported) return 'a second import';
        if ((await ask(ph, 'countersImport', { counters: { nope: 1 } })).error !== SAYS.bad) return 'a malformed import';
        return eq((await ask(ph, 'counterSnapshot')).counters[K00], 40, 'the counter after a refused second import');
      });

      await test('phone mock: two candidates at most; adopted or same, counters rise to 1000 short of what was served; the adopted one is kept, and every one goes on background or reload', async () => {
        const ph = nativePhone({ words: NS_WORDS });
        const K00 = '00' + 'ef'.repeat(7);
        ph.hooks.enter = () => NS_OTHER;
        const c1 = (await ask(ph, 'seedEnter')).candidate;
        ph.hooks.enter = () => NS_WORDS;
        const c2 = (await ask(ph, 'seedEnter')).candidate;
        if ((await ask(ph, 'seedEnter')).error !== SAYS.full) return 'a third candidate';
        for (let at = 0; at < 1100; at += 100) {
          if ((await ask(ph, 'restoreSecrets', { keysetId: K00, start: at, count: 100, candidate: c2 })).error) return 'serving the same words';
        }
        const same = await ask(ph, 'seedAdopt', { candidate: c2 });
        // ten empty batches past the last signature: the counter stops at the end of its batch, where every restore still looks
        if (!same.same || ph.nextOf(K00) !== 100) return 'same: ' + JSON.stringify(same) + ', counter ' + ph.nextOf(K00);
        if ((await ask(ph, 'restoreSecrets', { keysetId: K00, start: 0, count: 250, candidate: c1 })).error) return 'serving new words';
        const adopted = await ask(ph, 'seedAdopt', { candidate: c1 });
        if (!adopted.adopted || ph.keychain.words !== NS_OTHER) return 'adopt: ' + JSON.stringify(adopted);
        if (ph.nextOf(K00) !== 0) return 'the adopted seed\'s counter: ' + ph.nextOf(K00);
        if (!ph.candidates.has(c1) || ph.candidates.has(c2)) return 'candidates after the adopt: ' + [...ph.candidates.keys()];
        if ((await ask(ph, 'restoreSecrets', { keysetId: K00, start: 250, count: 100, candidate: c1 })).error) return 'the adopted candidate refused after the adopt';
        ph.background();
        if ((await ask(ph, 'restoreSecrets', { keysetId: K00, start: 350, count: 100, candidate: c1 })).error !== SAYS.unknown) return 'kept through the background';
        const c3 = (await ask(ph, 'seedEnter')).candidate;
        if (!c3) return 'no candidate after the background';
        return (await ask(ph, 'seedAdopt', { candidate: c3 }, {})).error === SAYS.unknown ? null : 'kept through a reload';
      });

      await test('phone mock: seedMigrate compares with a saved seed with its window closed, writes only while it is open, and only answers close it', async () => {
        const closed = nativePhone({ words: '' });
        closed.migrationOpen = false;
        if ((await ask(closed, 'seedMigrate', { words: NS_WORDS })).error !== SAYS.noMigration) return 'closed, with no seed';
        const open = nativePhone({ words: '' });
        if ((await ask(open, 'seedMigrate', { words: 'not a seed' })).error !== SAYS.bad || !open.migrationOpen) return 'bad words closed the window';
        if (!(await ask(open, 'seedMigrate', { words: NS_WORDS.toUpperCase() })).migrated || open.keychain.words !== NS_WORDS || open.migrationOpen) return 'open, with no seed';
        const saved = nativePhone({ words: NS_WORDS });
        saved.hooks.unlock = () => false;
        if ((await ask(saved, 'seedMigrate', { words: NS_WORDS })).error !== SAYS.unreadable || !saved.migrationOpen) return 'an error closed the window';
        saved.hooks.unlock = null;
        if (!(await ask(saved, 'seedStatus')).exists || saved.migrationOpen) return 'seedStatus finding the seed left the window open';
        if (!(await ask(saved, 'seedMigrate', { words: NS_WORDS })).same) return 'closed, the same seed';
        const diff = await ask(saved, 'seedMigrate', { words: NS_OTHER });
        if (!diff.different || saved.keychain.words !== NS_WORDS) return 'closed, a different seed: ' + JSON.stringify(diff);
        const made = nativePhone({ words: '' });
        await ask(made, 'seedCreate');
        return made.migrationOpen ? 'seedCreate left the window open' : null;
      });

      await test('phone mock: one seed screen at a time, none just after a cancelled Face ID, and an open one closes when the seed changes', async () => {
        const ph = nativePhone({ words: NS_WORDS });
        let now = 1000000;
        ph.now = () => now;
        let close = null;
        ph.hooks.show = () => new Promise((ok) => { close = ok; });
        const shown = ask(ph, 'seedShow', { verify: true });
        if ((await ask(ph, 'seedShow', {})).error !== SAYS.screenOpen) return 'a second words screen';
        if ((await ask(ph, 'seedEnter')).error !== SAYS.screenOpen) return 'a restore screen over the words screen';
        close(true);
        if (!(await shown).verified) return 'the quiz passed there';
        ph.hooks.unlock = () => false;
        if ((await ask(ph, 'seedShow', {})).error !== SAYS.unreadable) return 'a cancelled Face ID';
        ph.hooks.unlock = null;
        if ((await ask(ph, 'seedShow', {})).error !== SAYS.again) return 'the words screen straight after a cancelled Face ID';
        now += 10001;
        ph.hooks.show = () => new Promise(() => {});
        const open = ask(ph, 'seedShow', { verify: true });
        await ask(ph, 'seedWipe');
        const after = await open;
        return after.verified === false ? null : 'the words screen stayed open over a new seed: ' + JSON.stringify(after);
      });
    }
  }

  console.log('');
  console.log(passed + ' passed, ' + failures.length + ' failed');
  // an invoice's watcher keeps a timer alive; the verdict is in, so exit
  process.exit(failures.length ? 1 : 0);
})();
