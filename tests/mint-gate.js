'use strict';
/* mint-gate.js — adding a mint asks the lock this phone has.
 *
 *     node tests/mint-gate.js
 *
 * Every way a mint new to this phone gets added first passes the app's lock where one is set: Face ID where FACE ID LOCK is
 * on, else the PIN pad where SET PIN is on, as POINT OF SALE asks (26m-till.js `tillGate`, `lockAsk`). No lock, nothing is
 * asked. A mint already on the phone is never asked about. Given up, nothing is added. Asked once per add.
 *
 * "On the phone" is a shipped mint or one the person chose (the wallet's `mintChosen`: the phone's own mint, one it was
 * saved on, one passed through the gate). A mint only visited (a crossing, PAY FROM, MOVE TO YOUR MINT) shows as a tile and
 * is not chosen: its tile asks.
 *
 *   1  ADD A MINT's tile: the pad before the address sheet; the sheet's ADD asks nothing more
 *   2  ADD A MINT's scan button: a scanned mint new to this phone asks before the connect; a chosen one does not; a busy
 *      phone refuses before the pad; an address that is not secure is refused before the pad
 *   3  a token from a new mint, KEEP IT THERE: asked before the claim
 *   4  a request naming a new mint, USE: asked before the connect
 *   5  a restore that keeps a mint the phone only visited (the scan looks at every mint on the list): asked once
 *   6  a cashier code at a mint new to this phone: asked before the join
 *   7  the gate itself, and the wallet's real `canonicalMint` deciding which address is the same mint
 *   8  the till's own gate is unchanged
 *   9  a tile of a mint only visited asks; passed, it is chosen and free from then
 *  10  a Cashu ID payment at another mint, KEEP IT THERE: asked before the answer
 *  11  the real wallet: a visit does not choose a mint, a switch does, the record is seeded from an older phone's list, a
 *      mint dropped from the list is no longer chosen; MOVE TO YOUR MINT's claim is a visit; then a tile tap asks; TRANSFER
 *      TO that mint asks, and a quote dropped leaves it unchosen; a move that fails after the claim goes home
 *  12  TRANSFER TO a mint only visited: asked before the keypad, and passing it does not choose it
 *
 * The methods are lifted from build/foxy-app.js and run against a stand-in app and wallet, as tests/switch-guard.js does;
 * section 11 runs them against the real wallet (tests/harness.js). Run `python3 tools/join-sources.py && python3
 * tools/pack-index.py` first. FOXY_APP names another build to run against. */
const fs = require('fs');
const path = require('path');
const SRC = process.env.FOXY_APP || path.join(__dirname, '..', 'build', 'foxy-app.js');
const src = fs.readFileSync(SRC, 'utf8');
function block(start) {
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
// a method by its name, whatever its arguments; '' where this build has none
function method(name) {
  const m = new RegExp('\\n  ' + name + '\\([^)]*\\) \\{').exec(src);
  return m ? block(m.index + 3) : '';
}
const NAMES = ['mintOnPhone', 'mintGate', 'lockAsk', 'typeMintGated', 'scanOtherMint', 'newMintKeep', 'adoptRestoreMint',
  'tillJoinGo', 'makeTokenForRequest', 'reqMints', 'reqCanon', 'reqPayMint', 'onMint', 'mintTileTap', 'cidOfferCard', 'cidDecideGo',
  'connectBack', 'trPick', 'trPickTo', 'trHeldAt', 'quoteTransfer', 'trCancel', 'newMintRedeem', 'homeAgain', 'reclaimFromTx',
  'runTransfer', 'crossComeHome', 'back', 'offerNewMint'];
const lifted = NAMES.map(method).filter(Boolean);
// the busy questions as the app asks them, for the sections that want them (the stand-in's own answer stays for the rest)
const busyMethods = new Function('return {' + ['moneyBusy', 'refuseSwitchWhileBusy'].map(method).filter(Boolean).join(',\n') + '}')();
const methods = new Function('return {' + lifted.join(',\n') + '}')();

/* The wallet's own address rules, lifted from Web/foxy-wallet.js: `canonicalMint` (the host lowercased, the path's case
 * kept, :443 and a trailing dot dropped) and `mintUrlProblem` (https, or http to an .onion only). */
const WSRC = fs.readFileSync(process.env.FOXY_WALLET || path.join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8');
function wfn(name) {
  const m = new RegExp('\\n  function ' + name + '\\(').exec(WSRC);
  if (!m) throw new Error('no ' + name + ' in the wallet');
  let i = WSRC.indexOf('{', m.index), depth = 0;
  for (; i < WSRC.length; i++) {
    if (WSRC[i] === '{') depth++;
    else if (WSRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  return WSRC.slice(m.index + 3, i + 1);
}
const canonicalMint = new Function(wfn('canonicalMint') + '\nreturn canonicalMint;')();
const mintUrlProblem = new Function(wfn('mintUrlProblem') + '\nreturn mintUrlProblem;')();

const HERE = 'https://mint.here', KNOWN = 'https://mint.known', NEW = 'https://mint.new';
// on the list from a visit only (a crossing, PAY FROM, MOVE TO YOUR MINT), not chosen
const VISITED = 'https://mint.visited';
// chosen, with a path whose case is part of the address
const PATHED = 'https://mint.pathed/Bitcoin';
const PIN = '4321';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};

function wallet(lock, over) {
  const L = Object.assign({ pin: '', face: false, faceSays: 'yes' }, lock || {});
  return Object.assign({
    calls: [], faces: [], mintUrl: HERE, scanned: NEW,
    mintHost() { return 'mint.here'; },
    mints() { return [KNOWN, VISITED, PATHED]; },
    // every mint on the list was used before; only some were chosen
    mintUsedBefore(u) { return [HERE, KNOWN, VISITED, PATHED].some((x) => canonicalMint(x) === canonicalMint(u)); },
    chosen: [HERE, KNOWN, PATHED],
    mintChosen(u) { return this.chosen.some((x) => canonicalMint(x) === canonicalMint(u)); },
    chooseMint(u) { this.calls.push('choose ' + u); this.chosen.push(u); },
    canonicalMint,
    pinIsSet: () => !!L.pin,
    faceLock: () => !!L.face,
    screenLocked: () => !!L.pin || !!L.face,
    biometric(reason, passcode) { this.faces.push([reason, passcode]); return Promise.resolve(L.faceSays); },
    scan() { this.calls.push('scan'); return Promise.resolve(this.scanned); },
    mintProblem: (u) => mintUrlProblem(u),
    cashuIdDecide(key, choice, always) { this.calls.push('decide ' + choice + ' ' + key + (always ? ' always' : '')); return Promise.resolve({ state: 'there' }); },
    connect(url) { this.calls.push('connect ' + url); return Promise.resolve({ name: url }); },
    tokenInfo() { return { mint: NEW, sats: 5, unit: 'usd', amount: 5 }; },
    receiveToken(t) { this.calls.push('receive ' + t); return Promise.resolve({ host: 'mint.new', switched: true, unit: 'usd' }); },
    sendToken() { this.calls.push('sendToken'); return Promise.resolve({ token: 'cashuB', sats: 5, hash: 'h' }); },
    adoptScan() { this.calls.push('adopt'); return Promise.resolve(); },
    tillJoin(p) { this.calls.push('join ' + p.mint); return Promise.resolve({ pass: p, since: 1 }); },
    tillLeave() { this.calls.push('leave'); return Promise.resolve(); },
    reason(e) { return (e && e.message) || String(e); },
  }, over || {});
}

function app(W) {
  global.window = { FoxyWallet: W };
  const a = Object.assign({
    state: { screen: 'home', stack: [] },
    toasts: [], pads: [], cards: [], settled: 0, dismissed: 0,
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    toast(m) { this.toasts.push(m); },
    blockedCard(id, o) { this.cards.push([id, o]); },
    pinOverlay(o) { this.pads.push(o); },
    pinDismiss() { this.dismissed += 1; },
    pinTry(pin) { return pin === PIN ? { ok: true } : { ok: false, message: 'Wrong PIN.' }; },
    menuReturnSettle() { this.settled += 1; },
    DEFAULT_MINTS: [{ url: 'https://shipped.example', name: 'Shipped' }],
    knownMints() { return [HERE, 'https://shipped.example', KNOWN, VISITED, PATHED]; },
    cidMoney: (n) => String(n), busy: false,
    justSwitch(u) { W.calls.push('switch ' + u); },
    typeMint() { W.calls.push('sheet'); },
    refuseSwitchWhileBusy() { if (this.busy) this.toast('busy'); return !!this.busy; },
    holdSwapWatchStop() {},
    showMelt() {}, hideMelt() {}, walletReady() {}, refreshBalance() {}, loadHistory() {}, tookToken() {},
    mintNameOf: (u) => String(u).replace(/^https?:\/\//, ''), group: (n) => String(n), rowUnits: () => [], forgetRestoreCandidates() {},
    stageScreen() {}, hideStage() {}, forgetRequests() {}, homeState: () => ({ screen: 'amount' }),
    mintPile() { return { sats: 0 }; }, mintHost() { return W.mintHost(); },
  }, methods);
  return a;
}

const pad = (a) => a.pads[a.pads.length - 1];
// a tap on a mint's tile; a build with no gate there switches at once, as its tile did
const tile = (a, u) => (a.mintTileTap ? a.mintTileTap(u) : a.justSwitch(u));
const did = (W, what) => W.calls.some((c) => c.indexOf(what) === 0);
// no pad to type into (a build that did not ask): said, and the run goes on to the next check
const submit = (a, pin) => { let warned = ''; const p = pad(a); if (!p) return 'no pad'; p.onSubmit(pin, (m) => { warned = m; }); return warned; };
const cancel = (a) => { const p = pad(a); if (p && p.onCancel) p.onCancel(); };

/* One entry, run under each lock: `start(a)` begins the add; `done(W)` says whether it went ahead. */
async function entry(name, setup, start, doneWhat) {
  // no lock: nothing asked, as today
  {
    const W = wallet(), a = app(W);
    setup(a, W);
    await start(a);
    await wait(5);
    ok(!a.pads.length && !W.faces.length && did(W, doneWhat), name + ': no lock set, nothing asked and it goes ahead', JSON.stringify(W.calls));
  }
  // a PIN: the pad first, nothing done until it is passed
  {
    const W = wallet({ pin: PIN }), a = app(W);
    setup(a, W);
    await start(a);
    await wait(5);
    ok(a.pads.length === 1 && !did(W, doneWhat), name + ': with a PIN, the pad before anything is added', JSON.stringify({ pads: a.pads.length, calls: W.calls }));
    if (!a.pads.length) return;
    const warned = submit(a, '0000');
    await wait(5);
    ok(!!warned && !did(W, doneWhat), name + ': a wrong PIN adds nothing', JSON.stringify({ warned, calls: W.calls }));
    submit(a, PIN);
    await wait(5);
    ok(did(W, doneWhat) && a.pads.length === 1 && a.dismissed === 1, name + ': the right PIN goes ahead, and nothing is asked again',
      JSON.stringify({ pads: a.pads.length, calls: W.calls }));
  }
  // given up: nothing added, and the screen the person was on stays
  {
    const W = wallet({ pin: PIN }), a = app(W);
    // started from a screen that is not home, so a cancel that went home would show
    a.state.screen = 'mints';
    setup(a, W);
    const before = a.state.screen;
    await start(a);
    await wait(5);
    cancel(a);
    await wait(5);
    ok(a.pads.length === 1 && !did(W, doneWhat) && !did(W, 'choose') && before !== 'home' && a.state.screen === before && a.settled === 1,
      name + ': the pad given up adds nothing and leaves the person where they were', JSON.stringify({ calls: W.calls, screen: a.state.screen }));
  }
  // Face ID on: the face, then on; no pad
  {
    const W = wallet({ pin: PIN, face: true }), a = app(W);
    setup(a, W);
    await start(a);
    await wait(5);
    ok(W.faces.length === 1 && W.faces[0][1] === false && !a.pads.length && did(W, doneWhat),
      name + ': FACE ID LOCK on, a face that says yes goes ahead with no pad', JSON.stringify({ faces: W.faces, pads: a.pads.length, calls: W.calls }));
  }
  {
    const W = wallet({ pin: PIN, face: true, faceSays: 'no' }), a = app(W);
    setup(a, W);
    await start(a);
    await wait(5);
    ok(W.faces.length === 1 && a.pads.length === 1 && !did(W, doneWhat), name + ': a face that will not scan falls to the PIN',
      JSON.stringify({ faces: W.faces.length, pads: a.pads.length, calls: W.calls }));
  }
  {
    const W = wallet({ face: true }), a = app(W);
    setup(a, W);
    await start(a);
    await wait(5);
    ok(W.faces.length === 1 && W.faces[0][1] === true && did(W, doneWhat), name + ': Face ID with no PIN: the phone’s passcode may stand in',
      JSON.stringify({ faces: W.faces, calls: W.calls }));
  }
}

/* Section 11: the wallet itself (Web/foxy-wallet.js through tests/harness.js), with fake mints, and the lifted gate in front
 * of it. */
async function realWallet() {
  const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
  const HOME = 'https://home.test', THEIR = 'https://their.test', OTHER = 'https://other.test';
  const shared = {};
  const page = (storage) => {
    const ph = nativePhone({ words: PHONE_WORDS });
    const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
    const ctx = loadReal({
      storage,
      bridge: (w, m) => {
        if (m.action === 'mintRequest') {
          const u = new URL(m.url);
          const mint = shared[u.origin];
          if (!mint) return reply(w, m.id, null, 'no such mint in this test');
          // a melt refused at the token's mint: the move after a claim fails there
          if (shared.failMelt && u.origin === THEIR && /melt\/bolt11$/.test(u.pathname)) {
            return reply(w, m.id, '400\n' + JSON.stringify({ detail: 'melt refused in this test', code: 0 }));
          }
          return reply(w, m.id, mint.handle(m));
        }
        const got = ph.answer(w, m);
        if (!got) return reply(w, m.id, null, 'not in this test');
        return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
      },
      before: (w) => {
        ph.attach(w);
        if (!shared[HOME]) {
          shared[HOME] = fakeMint(w, { fill: 7 });
          shared[THEIR] = fakeMint(w, { fill: 9 });
          shared[OTHER] = fakeMint(w, { fill: 11 });
        }
      },
    });
    ctx.W._nodeProbeDelay = [86400000, 86400000];
    return ctx;
  };
  const settle = async () => { for (let i = 0; i < 200; i++) await wait(0); await wait(30); };
  const stored = (ctx, k, d) => { try { const v = JSON.parse(ctx.storage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };

  // an older phone: a list and a saved mint, and no record of chosen mints yet
  {
    const OLD_A = 'https://old-a.example', OLD_B = 'https://old-b.example/Path';
    const ctx = page({ 'foxy.cashu.mints': JSON.stringify([OLD_A, OLD_B]), 'foxy.cashu.mints.used': JSON.stringify([OLD_A, OLD_B]),
      'foxy.cashu.mint': JSON.stringify(OLD_A) });
    const W = ctx.W;
    await W.seedReady();
    ok(typeof W.mintChosen === 'function' && W.mintChosen(OLD_A) && W.mintChosen(OLD_B),
      'wallet: an older phone’s list is seeded as chosen, so no tile it had starts to ask');
    await W.connect(THEIR, null, null, { remember: false });
    ok(!W.mintChosen(THEIR) && W.mints().indexOf(THEIR) >= 0 && W.mintChosen(OLD_A) && W.mintChosen(OLD_B),
      'wallet: a visit after the upgrade shows on the list and is not chosen; the seeded ones stay',
      JSON.stringify({ chosen: stored(ctx, 'foxy.cashu.mints.chosen', null), list: W.mints() }));
    await W.connect(OTHER, null, null, { remember: true });
    ok(W.mintChosen(OTHER), 'wallet: a switch (a connect that saves the mint) chooses it');
    W.forgetMintFromList(OLD_B);
    ok(!W.mintChosen(OLD_B) && W.mintChosen(OLD_A), 'wallet: a mint dropped from the list is no longer chosen');
    W.chooseMint(THEIR);
    ok(W.mintChosen('HTTPS://THEIR.TEST/'), 'wallet: a mint passed through the gate is chosen, compared as the wallet writes a mint');

    // the gate with this wallet behind it: a PIN set (the pad is the stand-in's)
    W.pinIsSet = () => true; W.faceLock = () => false; W.screenLocked = () => true;
    W.calls = [];
    const a = app(W);
    a.scanOtherMint = methods.scanOtherMint;
    W.scan = () => Promise.resolve(OLD_B);
    a.scanOtherMint();
    await wait(5);
    ok(a.pads.length === 1 && !did(W, 'switch'), 'a dropped mint scanned again asks the lock', JSON.stringify({ pads: a.pads.length, calls: W.calls }));
  }

  // MOVE TO YOUR MINT, then a tap on the tile of the token's mint
  {
    const payer = page();
    await payer.W.seedReady();
    await payer.W.connect(THEIR, null, null, { remember: true });
    const inv = await payer.W.invoice(500, '');
    await payer.W.claim(inv.hash);
    const one = await payer.W.sendToken(100, { unit: 'sat' });
    const two = await payer.W.sendToken(100, { unit: 'sat' });
    // for the control below, made before any claim, so its outputs meet nobody else's
    const kept = await payer.W.sendToken(100, { unit: 'sat' });

    const ctx = page();
    const W = ctx.W;
    await W.seedReady();
    await W.connect(HOME, null, null, { remember: true });
    const plan = await W.sweepQuote(THEIR, 100);
    await W.receiveToken(one.token, { visit: true });
    await W.moveRun(plan, () => {});
    await settle();
    ok(stored(ctx, 'foxy.cashu.mint', '') === HOME && W.mints().indexOf(THEIR) >= 0 && !W.mintChosen(THEIR) && W.balanceAt(HOME) > 0,
      'wallet: MOVE TO YOUR MINT (a visit’s claim, then the move) lands at home, shows the token’s mint, and does not choose it',
      JSON.stringify({ mint: stored(ctx, 'foxy.cashu.mint', ''), list: W.mints(), chosen: W.mintChosen(THEIR), home: W.balanceAt(HOME) }));
    ok(/W\.receiveToken\(this\.state\.nmToken, \{ visit: true \}\)/.test(method('newMintRedeem')), 'MOVE TO YOUR MINT claims the token as a visit');
    // PAY FROM and a tap's crossing connect to the other mint as visits too
    ok(/W\.connect\(e\.mint, null, null, \{ remember: false \}\)/.test(src) && /W\.connect\(theirs, null, null, \{ remember: false \}\)/.test(src),
      'PAY FROM and a tap’s crossing visit the other mint');

    // TRANSFER TO that mint: the quote is a visit, so a transfer dropped after its quote leaves the mint unchosen
    {
      W.pinIsSet = () => true; W.faceLock = () => false; W.screenLocked = () => true;
      W.calls = [];
      const b = app(W);
      Object.assign(b, { moneyBusy: () => false, refreshBalance() {} });
      // TRANSFER › from home › to the token's mint: the pad first, and passing it chooses nothing
      Object.assign(b.state, { screen: 'switchMint', stack: [], trStep: 'to', trFrom: HOME, trUnit: 'sat' });
      b.trPick(THEIR);
      await wait(5);
      ok(b.pads.length === 1 && b.state.screen === 'switchMint', 'TRANSFER TO the token’s mint asks the lock before the keypad',
        JSON.stringify({ pads: b.pads.length, screen: b.state.screen }));
      submit(b, PIN);
      await wait(5);
      ok(b.state.trTo === THEIR && !W.mintChosen(THEIR), 'passed: the keypad for it, and the mint is not chosen yet',
        JSON.stringify({ to: b.state.trTo, chosen: W.mintChosen(THEIR) }));
      Object.assign(b.state, { screen: 'trConfirm', stack: [], trFrom: HOME, trTo: THEIR, trSats: 10, trUnit: 'sat' });
      b._trWas = HOME;
      b.quoteTransfer();
      await settle();
      ok(!!b.state.trPlan && !W.mintChosen(THEIR) && stored(ctx, 'foxy.cashu.mint', '') === HOME,
        'TRANSFER TO the token’s mint: the quote connects there as a visit, and chooses nothing',
        JSON.stringify({ plan: !!b.state.trPlan, err: b.state.trErr, chosen: W.mintChosen(THEIR), saved: stored(ctx, 'foxy.cashu.mint', '') }));
      b.trCancel();
      await settle();
      ok(W.mintUrl === HOME && !W.mintChosen(THEIR), 'dropped: back on home, and the mint is still not chosen', W.mintUrl);
      const c = app(W);
      W.calls = [];
      tile(c, THEIR);
      await wait(5);
      ok(c.pads.length === 1 && !did(W, 'switch'), 'after a TRANSFER dropped, the token’s mint’s tile still asks the lock');
      cancel(c);
    }

    W.pinIsSet = () => true; W.faceLock = () => false; W.screenLocked = () => true;
    W.calls = [];
    const a = app(W);
    tile(a, HOME);
    await wait(5);
    ok(!a.pads.length && did(W, 'switch ' + HOME), 'the home mint’s tile asks nothing', JSON.stringify(W.calls));
    tile(a, THEIR);
    await wait(5);
    ok(a.pads.length === 1 && !did(W, 'switch ' + THEIR), 'after MOVE TO YOUR MINT, the token’s mint’s tile asks the lock',
      JSON.stringify({ pads: a.pads.length, calls: W.calls }));
    submit(a, PIN);
    await wait(5);
    ok(did(W, 'switch ' + THEIR) && W.mintChosen(THEIR), 'passed, it switches and the mint is chosen');

    /* A plain claim at a mint the person did not choose (a take-back, change, a card's row at a mint only visited) is a
     * visit too: it used to save the phone there, which chose the mint with nothing asked. */
    const ctl = page();
    await ctl.W.seedReady();
    await ctl.W.connect(HOME, null, null, { remember: true });
    await ctl.W.receiveToken(two.token);
    await settle();
    ok(!ctl.W.mintChosen(THEIR) && stored(ctl, 'foxy.cashu.mint', '') === HOME && ctl.W.balanceAt(THEIR) === 100,
      'wallet: a plain claim at a mint not chosen takes the money there as a visit, and chooses nothing',
      JSON.stringify({ chosen: ctl.W.mintChosen(THEIR), saved: stored(ctl, 'foxy.cashu.mint', ''), there: ctl.W.balanceAt(THEIR) }));
    // MOVE TO YOUR MINT whose move fails after the claim: the sats stay at the token's mint, and the phone goes home
    const three = await payer.W.sendToken(100, { unit: 'sat' });
    const fx = page();
    await fx.W.seedReady();
    await fx.W.connect(HOME, null, null, { remember: true });
    const fplan = await fx.W.sweepQuote(THEIR, 100);
    const said = [];
    const f = app(fx.W);
    Object.assign(f, {
      movingUp: () => true, movingDown() {}, expectOwnSpend() {}, hushSweepEntries: () => Promise.resolve(),
      walletReady(w) { said.push('ready ' + ((w && w.name) || '')); }, sweepChange() {}, noteReceived() {}, announcePayment() {},
    });
    Object.assign(f.state, { nmPlan: fplan, nmToken: three.token, nmInfo: { mint: THEIR, sats: 100 } });
    shared.failMelt = true;
    f.newMintRedeem();
    for (let i = 0; i < 20; i++) await settle();
    shared.failMelt = false;
    ok(/safe at their\.test/.test(String(f.state.nmErr)) && fx.W.mintUrl === HOME && stored(fx, 'foxy.cashu.mint', '') === HOME
      && fx.W.balanceAt(THEIR) === 100 && !fx.W.mintChosen(THEIR),
      'a move that fails after the claim: the sats are safe at the token’s mint, and the session is back on home with nothing chosen',
      JSON.stringify({ err: f.state.nmErr, live: fx.W.mintUrl, saved: stored(fx, 'foxy.cashu.mint', ''), there: fx.W.balanceAt(THEIR),
        chosen: fx.W.mintChosen(THEIR), said }));
    // the control: a mint the gate passed (`chooseMint`) is where a claim saves the phone, as KEEP IT THERE does
    // the same phone as the plain claim above, home again, so its counters run on from there
    const ctl2 = ctl;
    await ctl2.W.connect(HOME, null, null, { remember: true });
    ctl2.W.chooseMint(THEIR);
    await ctl2.W.receiveToken(kept.token);
    await settle();
    ok(stored(ctl2, 'foxy.cashu.mint', '') === THEIR, 'wallet (control): a claim at a mint the gate passed saves the phone there',
      stored(ctl2, 'foxy.cashu.mint', ''));
    // RECLAIM of a token sent at a mint only visited: the same rule (18-seed-phrase.js `reclaimToken`)
    ok(/FoxyWallet\.connect\(from, null, null, FoxyWallet\.mintChosen\(from\) \? undefined : \{ remember: false \}\)/.test(
      WSRC), 'RECLAIM at a mint not chosen connects as a visit');
  }
}

/* Section 13: the live mint is the saved one when a flow ends. A visit leaves the phone's session on another mint until
 * something brings it home; left there, the next MOVE TO YOUR MINT moved the money to that mint and its landing chose it,
 * with nothing asked (a RECLAIM, or TRANSFER's back arrow, then a token moved home). Each flow that visits is run on the
 * real wallet with its own fake mints, and ends with the live mint equal to the saved one. */
async function liveHome() {
  const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
  const HOME = 'https://home13.test', V = 'https://visited13.test', THIRD = 'https://third13.test';
  const shared = {};
  const page = () => {
    const ph = nativePhone({ words: PHONE_WORDS });
    const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
    const ctx = loadReal({
      bridge: (w, m) => {
        if (m.action === 'mintRequest') {
          const u = new URL(m.url);
          const mint = shared[u.origin];
          if (!mint) return reply(w, m.id, null, 'no such mint in this test');
          return reply(w, m.id, mint.handle(m));
        }
        const got = ph.answer(w, m);
        if (!got) return reply(w, m.id, null, 'not in this test');
        return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
      },
      before: (w) => {
        ph.attach(w);
        if (!shared[HOME]) { shared[HOME] = fakeMint(w, { fill: 7 }); shared[V] = fakeMint(w, { fill: 9 }); shared[THIRD] = fakeMint(w, { fill: 11 }); }
      },
    });
    ctx.W._nodeProbeDelay = [86400000, 86400000];
    return ctx;
  };
  const settle = async () => { for (let i = 0; i < 200; i++) await wait(0); await wait(40); };
  const tokenAt = async (mint, n) => {
    const p = page(); await p.W.seedReady();
    await p.W.connect(mint, null, null, { remember: true });
    const inv = await p.W.invoice(n + 400, ''); await p.W.claim(inv.hash);
    return (await p.W.sendToken(n, { unit: 'sat' })).token;
  };
  const bare = (u) => String(u || '').replace(/\/+$/, '');
  const tokV = await tokenAt(V, 200), tokV2 = await tokenAt(V, 200);
  const tok3 = await tokenAt(THIRD, 300), tok3b = await tokenAt(THIRD, 300), tok3c = await tokenAt(THIRD, 300);
  const tokHome = await tokenAt(HOME, 300);

  // one phone: home is chosen and saved; money at V from a visit (a move that failed, a crossing's leftovers)
  const ctx = page(); const W = ctx.W; await W.seedReady();
  await W.connect(HOME, null, null, { remember: true });
  await W.receiveToken(tokHome);
  await W.receiveToken(tokV, { visit: true });
  await W.connect(HOME, null, null, { remember: true });
  const saved = () => bare(JSON.parse(ctx.storage.getItem('foxy.cashu.mint') || '""'));
  const atHome = (what) => ok(bare(W.mintUrl) === saved() && saved() === HOME && !W.mintChosen(V),
    what + ': the live mint is the saved one (home), and the visited mint is not chosen',
    JSON.stringify({ live: W.mintUrl, saved: saved(), chosenV: W.mintChosen(V) }));
  W.pinIsSet = () => true; W.faceLock = () => false; W.screenLocked = () => true;
  const mk = () => {
    const a = app(W);
    Object.assign(a, { refreshBalance() {}, walletReady() {}, loadHistory() {}, receivingDown() {}, movingUp: () => true, movingDown() {},
      expectOwnSpend() {}, hushSweepEntries: () => Promise.resolve(), sweepChange() {}, noteReceived() {}, announcePayment() {},
      moneyBusy: () => false, offlineNow: () => false });
    return a;
  };

  // the wallet's own rule: money moved home goes to the saved mint, whichever mint the session is on
  await W.connect(V, null, null, { remember: false });
  const p0 = await W.sweepQuote(THIRD, 300);
  ok(bare(p0.to) === HOME, 'wallet: with the session left on a visited mint, MOVE TO YOUR MINT is quoted to the saved mint', p0.to);
  await W.connect(HOME, null, null, { remember: true });

  // RECLAIM of a token made at V (PAY FROM V), through the history row's button
  {
    await W.connect(V, null, null, { remember: false });
    const out = await W.sendToken(50, { unit: 'sat' });
    await W.connect(HOME, null, null, { remember: true });
    const a = mk();
    a.reclaimFromTx(out.token);
    for (let i = 0; i < 6; i++) await settle();
    atHome('RECLAIM of a token sent at a visited mint');
    // then a token from a third mint, moved home: home it lands, and V stays unchosen
    const plan = await W.sweepQuote(THIRD, 300);
    await W.receiveToken(tok3, { visit: true });
    await W.moveRun(plan, () => {});
    await settle();
    ok(bare(plan.to) === HOME && saved() === HOME && !W.mintChosen(V) && W.balanceAt(V) >= 150,
      'after the RECLAIM, MOVE TO YOUR MINT moves the money home, not to the visited mint, and chooses nothing',
      JSON.stringify({ to: plan.to, saved: saved(), chosenV: W.mintChosen(V), atV: W.balanceAt(V) }));
    // a RECLAIM that fails (the token already taken) goes home too
    await W.connect(V, null, null, { remember: false });
    const a2 = mk();
    a2.reclaimFromTx(out.token);
    for (let i = 0; i < 6; i++) await settle();
    atHome('a RECLAIM refused at the visited mint');
  }

  // take-back: a plain claim at a mint not chosen (the wallet's take-back of a token locked to this phone takes this road)
  {
    await W.receiveToken(tokV2);
    await settle();
    ok(saved() === HOME && !W.mintChosen(V), 'wallet: a claim at a mint not chosen saves nothing there', JSON.stringify({ saved: saved(), live: W.mintUrl }));
    const a = mk();
    a.homeAgain();
    await settle();
    atHome('a take-back at a visited mint, then home again');
  }

  // TRANSFER from home to V: the quote visits V; the back arrow off the confirmation, and off the keypad, goes home
  for (const where of ['trConfirm', 'amount']) {
    const a = mk();
    Object.assign(a.state, { screen: 'trConfirm', stack: ['home', 'switchMint', 'amount'], flow: 'transfer', trFrom: HOME, trTo: V, trSats: 20, trUnit: 'sat' });
    a._trWas = HOME;
    a.quoteTransfer();
    await settle();
    ok(bare(W.mintUrl) === V && !!a.state.trPlan, 'TRANSFER TO the visited mint: the quote is made there (a visit)', W.mintUrl);
    a.state.screen = where;
    try { a.back(); } catch (e) { /* what back() does after the trip home is the shell's, not this test's */ }
    await settle();
    atHome('the back arrow off TRANSFER’s ' + (where === 'amount' ? 'keypad' : 'confirmation'));
  }
  {
    // and then a token from a third mint, moved home (the second probe's chain)
    const plan = await W.sweepQuote(THIRD, 300);
    await W.receiveToken(tok3b, { visit: true });
    await W.moveRun(plan, () => {});
    await settle();
    ok(bare(plan.to) === HOME && saved() === HOME && !W.mintChosen(V), 'after TRANSFER backed out, MOVE TO YOUR MINT lands home and chooses nothing',
      JSON.stringify({ to: plan.to, saved: saved(), chosenV: W.mintChosen(V) }));
  }

  // the wallet's landing: a move to a mint not chosen lands there as a visit
  {
    await W.connect(V, null, null, { remember: false });
    const plan = await W.transferQuote(HOME, 20);
    await W.connect(HOME, null, null, { remember: false });
    await W.moveRun(plan, () => {});
    await settle();
    ok(bare(W.mintUrl) === V && saved() === HOME && !W.mintChosen(V), 'wallet: a move landing at a mint not chosen is a visit: nothing saved, nothing chosen',
      JSON.stringify({ live: W.mintUrl, saved: saved(), chosenV: W.mintChosen(V) }));
    const a = mk();
    a.homeAgain();
    await settle();
    atHome('home again after that landing');
  }

  // MOVE TO YOUR MINT through its screen: home after
  {
    const a = mk();
    const plan = await W.sweepQuote(THIRD, 300);
    Object.assign(a.state, { nmPlan: plan, nmToken: tok3c, nmInfo: { mint: THIRD, sats: 300 } });
    a.newMintRedeem();
    for (let i = 0; i < 10; i++) await settle();
    ok(!a.state.nmErr, 'MOVE TO YOUR MINT went through', a.state.nmErr);
    atHome('MOVE TO YOUR MINT');
  }

  // PAY FROM (and a tap's crossing, and a payout on chain): a visit, and the crossing's way home (`crossComeHome`)
  {
    const a = mk();
    a._crossCameFrom = HOME;
    await W.connect(V, null, null, { remember: false });
    a.crossComeHome();
    await settle();
    atHome('a visit for PAY FROM, home by `crossComeHome`');
  }

  // TRANSFER pressed: its mint is chosen, the landing saves the phone there, and the live mint is the saved one
  {
    const a = mk();
    Object.assign(a.state, { screen: 'trConfirm', stack: [], flow: 'transfer', trFrom: HOME, trTo: V, trSats: 20, trUnit: 'sat' });
    a._trWas = HOME;
    a.quoteTransfer();
    await settle();
    a.runTransfer();
    for (let i = 0; i < 6; i++) await settle();
    ok(W.mintChosen(V) && saved() === V && bare(W.mintUrl) === V, 'TRANSFER pressed: the mint it lands at is chosen, saved and live',
      JSON.stringify({ chosen: W.mintChosen(V), saved: saved(), live: W.mintUrl, err: a.state.trErr }));
  }
  ok(/homeAgain/.test(method('back')) && /trConfirm/.test(method('back')), 'the back arrow goes home off TRANSFER’s screens');
}

/* Section 14: the trip home is counted while it is out. A trip home (`homeAgain`) still connecting when a token from
 * another mint was claimed and moved: the connect landed between the claim and the move, and the move paid from home,
 * the token's money left where it was and the move written down as made. Home's answers are held back 400 ms here. */
async function homeRace() {
  const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
  const HOME = 'https://home14.test', V = 'https://visited14.test', X = 'https://third14.test';
  const shared = { delay: {} };
  const page = () => {
    const ph = nativePhone({ words: PHONE_WORDS });
    const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
    const ctx = loadReal({
      bridge: (w, m) => {
        if (m.action === 'mintRequest') {
          const u = new URL(m.url);
          const mint = shared[u.origin];
          if (!mint) return reply(w, m.id, null, 'no such mint in this test');
          const ans = mint.handle(m);
          const ms = shared.delay[u.origin] || 0;
          return ms ? setTimeout(() => reply(w, m.id, ans), ms) : reply(w, m.id, ans);
        }
        const got = ph.answer(w, m);
        if (!got) return reply(w, m.id, null, 'not in this test');
        return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
      },
      before: (w) => {
        ph.attach(w);
        if (!shared[HOME]) { shared[HOME] = fakeMint(w, { fill: 7 }); shared[V] = fakeMint(w, { fill: 9 }); shared[X] = fakeMint(w, { fill: 11 }); }
      },
    });
    ctx.W._nodeProbeDelay = [86400000, 86400000];
    return ctx;
  };
  const settle = async () => { for (let i = 0; i < 200; i++) await wait(0); await wait(40); };
  const bare = (u) => String(u || '').replace(/\/+$/, '');
  const tokenAt = async (mint, n) => {
    const p = page(); await p.W.seedReady();
    await p.W.connect(mint, null, null, { remember: true });
    const inv = await p.W.invoice(n + 400, ''); await p.W.claim(inv.hash);
    return (await p.W.sendToken(n, { unit: 'sat' })).token;
  };
  const tokX = await tokenAt(X, 300), tokX2 = await tokenAt(X, 300);
  const ctx = page(); const W = ctx.W; await W.seedReady();
  await W.connect(HOME, null, null, { remember: true });
  const inv = await W.invoice(1000, ''); await W.claim(inv.hash);
  const saved = () => bare(JSON.parse(ctx.storage.getItem('foxy.cashu.mint') || '""'));

  // the wallet: a connect home landing between the claim at X and the move is refused by the move, before anything is paid
  {
    await W.connect(V, null, null, { remember: false });
    const plan = await W.sweepQuote(X, 300);
    shared.delay[HOME] = 400;
    const homeGoing = W.connect(HOME, null, null, { remember: false });
    await W.receiveToken(tokX, { visit: true });
    await homeGoing.catch(() => {});
    shared.delay[HOME] = 0;
    let err = null;
    try { await W.moveRun(plan, () => {}); } catch (e) { err = e; }
    await settle();
    ok(!!err && err.unsent === true && W.balanceAt(HOME) === 1000 && W.balanceAt(X) === 300 && !W.pendingMoves().length,
      'wallet: a move asked with the live mint not the one it pays from is refused, nothing sent; home 1000 and X 300, the books add up',
      JSON.stringify({ err: err && err.message, home: W.balanceAt(HOME), x: W.balanceAt(X), notes: W.pendingMoves().length }));
  }

  // the app: RECLAIM's trip home still out, MOVE TO YOUR MINT waits for it
  {
    await W.connect(V, null, null, { remember: false });
    const a = app(W);
    Object.assign(a, { refreshBalance() {}, walletReady() {}, loadHistory() {}, movingUp: () => true, movingDown() {}, stopReceive() {},
      expectOwnSpend() {}, hushSweepEntries: () => Promise.resolve(), sweepChange() {}, noteReceived() {}, announcePayment() {},
      busyWhy: () => 'test', state: Object.assign(a.state, {}) });
    a.refuseSwitchWhileBusy = busyMethods.refuseSwitchWhileBusy;
    a.moneyBusy = busyMethods.moneyBusy;
    const plan = await W.sweepQuote(X, 300);
    shared.delay[HOME] = 400;
    const trip = a.homeAgain();
    ok(!!trip && !!a._homeGoing && a.moneyBusy(), 'the trip home is counted as busy while its connect is out');
    Object.assign(a.state, { nmPlan: plan, nmToken: tokX2, nmInfo: { mint: X, sats: 300 } });
    const homeBefore = W.balanceAt(HOME), xBefore = W.balanceAt(X);
    a.newMintRedeem();
    await trip;
    shared.delay[HOME] = 0;
    await settle();
    ok(a.toasts.some((t) => /Wait for the payment/.test(t)) && W.balanceAt(HOME) === homeBefore && W.balanceAt(X) === xBefore,
      'MOVE TO YOUR MINT asked meanwhile waits for it: refused, nothing claimed or moved',
      JSON.stringify({ toasts: a.toasts, home: W.balanceAt(HOME), x: W.balanceAt(X) }));
    ok(!a._homeGoing && bare(W.mintUrl) === HOME && saved() === HOME, 'the trip lands: home, live and saved', W.mintUrl);
    // asked again once home: the move goes through, from X, and the books add up
    a.toasts = [];
    a.newMintRedeem();
    for (let i = 0; i < 10; i++) await settle();
    ok(!a.state.nmErr && W.balanceAt(HOME) > homeBefore && W.balanceAt(HOME) - homeBefore <= 300 && bare(W.mintUrl) === HOME && saved() === HOME,
      'asked again, the money really moves from X to home, and the phone is home',
      JSON.stringify({ err: a.state.nmErr, toasts: a.toasts, home: W.balanceAt(HOME) - homeBefore, x: W.balanceAt(X), live: W.mintUrl }));
  }

  // TRANSFER: the back arrow while the quote's connect to V is still out ends home, live and saved
  {
    const a = app(W);
    Object.assign(a, { refreshBalance() {}, loadHistory() {} });
    a.moneyBusy = busyMethods.moneyBusy;
    Object.assign(a.state, { screen: 'trConfirm', stack: ['home', 'switchMint', 'amount'], flow: 'transfer', trFrom: HOME, trTo: V, trSats: 20, trUnit: 'sat' });
    a._trWas = HOME;
    shared.delay[V] = 400;
    a.quoteTransfer();
    ok(!!a._trQuoteGoing && a.moneyBusy(), 'the quote’s connect is counted while it is out');
    try { a.back(); } catch (e) { /* the shell's part of back() */ }
    a.state.screen = 'amount';
    for (let i = 0; i < 8; i++) await settle();
    await wait(500);
    await settle();
    shared.delay[V] = 0;
    ok(bare(W.mintUrl) === HOME && saved() === HOME && !a.state.trPlan && !W.mintChosen(V),
      'the back arrow during the quote’s connect: the late connect does not take the phone back; live and saved are home, no quote',
      JSON.stringify({ live: W.mintUrl, saved: saved(), plan: !!a.state.trPlan }));
  }

  // CANCEL on the confirmation: while the quote's connect to V is held back, and after the quote has landed
  {
    const a = app(W);
    Object.assign(a, { refreshBalance() {}, loadHistory() {} });
    a.moneyBusy = busyMethods.moneyBusy;
    Object.assign(a.state, { screen: 'trConfirm', stack: ['home', 'switchMint', 'amount'], flow: 'transfer', trFrom: HOME, trTo: V, trSats: 20, trUnit: 'sat' });
    a._trWas = HOME;
    shared.delay[V] = 400;
    a.quoteTransfer();
    a.trCancel();
    await wait(500);
    for (let i = 0; i < 6; i++) await settle();
    shared.delay[V] = 0;
    ok(bare(W.mintUrl) === HOME && saved() === HOME && !W.mintChosen(V) && !a.state.trPlan && !a._homeGoing,
      'CANCEL while the quote\u2019s connect to V is out: live and saved are home, V not chosen, no quote',
      JSON.stringify({ live: W.mintUrl, saved: saved(), chosenV: W.mintChosen(V), plan: !!a.state.trPlan }));
  }
  {
    const a = app(W);
    Object.assign(a, { refreshBalance() {}, loadHistory() {} });
    a.moneyBusy = busyMethods.moneyBusy;
    Object.assign(a.state, { screen: 'trConfirm', stack: ['home', 'switchMint', 'amount'], flow: 'transfer', trFrom: HOME, trTo: V, trSats: 20, trUnit: 'sat' });
    a._trWas = HOME;
    a.quoteTransfer();
    for (let i = 0; i < 4; i++) await settle();
    ok(!!a.state.trPlan && bare(W.mintUrl) === V, 'the quote landed at V (a visit)', W.mintUrl);
    shared.delay[HOME] = 400;
    a.trCancel();
    ok(!!a._homeGoing && a.moneyBusy(), 'CANCEL after the quote: the trip home is counted busy until it lands');
    await a._homeGoing;
    shared.delay[HOME] = 0;
    await settle();
    ok(!a._homeGoing && !a.moneyBusy() && bare(W.mintUrl) === HOME && saved() === HOME && !W.mintChosen(V),
      'and it lands: live and saved are home, V not chosen', JSON.stringify({ live: W.mintUrl, saved: saved() }));
  }
}

(async () => {
  ok(['mintGate', 'mintOnPhone', 'lockAsk', 'typeMintGated'].every((n) => !!method(n)), 'the gate is in this build', SRC);

  console.log('1. ADD A MINT’s tile');
  await entry('the tile', () => {}, (a) => (a.typeMintGated ? a.typeMintGated() : a.typeMint()), 'sheet');
  {
    // the sheet's ADD connects with no second ask: it calls justSwitch itself, not the gate
    const sheet = /\n {2}typeMint\(\) \{[\s\S]*?\n {2}\}\n/.exec(src);
    ok(!!sheet && /this\.justSwitch\(clean\)/.test(sheet[0]) && !/mintGate/.test(sheet[0]), 'the sheet’s ADD connects with nothing more asked');
    ok(/typeOtherMint: \(\) => this\.typeMintGated\(\)/.test(src), 'ADD A MINT’s tile opens the sheet through the gate');
  }

  console.log('\n2. ADD A MINT’s scan button');
  await entry('a scanned new mint', () => {}, (a) => a.scanOtherMint(), 'switch ' + NEW);
  {
    const W = wallet({ pin: PIN }), a = app(W);
    W.scanned = KNOWN + '/';
    a.scanOtherMint();
    await wait(5);
    ok(!a.pads.length && did(W, 'switch ' + KNOWN), 'a scanned mint already on this phone is a switch, and nothing is asked', JSON.stringify(W.calls));
    const W2 = wallet({ pin: PIN }), b = app(W2);
    W2.scanned = 'https://shipped.example';
    b.scanOtherMint();
    await wait(5);
    ok(!b.pads.length && did(W2, 'switch https://shipped.example'), 'nor one of the shipped list', JSON.stringify(W2.calls));
    // a mint on the list from a visit only is not chosen: scanned, it asks
    const W3 = wallet({ pin: PIN }), c = app(W3);
    W3.scanned = VISITED;
    c.scanOtherMint();
    await wait(5);
    ok(c.pads.length === 1 && !did(W3, 'switch'), 'a scanned mint the phone only visited asks', JSON.stringify({ pads: c.pads.length, calls: W3.calls }));
    // a busy phone says so before the pad, not after it is passed
    const W4 = wallet({ pin: PIN }), d = app(W4);
    d.busy = true;
    d.scanOtherMint();
    await wait(5);
    ok(!d.pads.length && !did(W4, 'switch') && d.toasts.indexOf('busy') >= 0, 'a busy phone refuses the scanned mint before the PIN is asked',
      JSON.stringify({ pads: d.pads.length, toasts: d.toasts, calls: W4.calls }));
    // an address that is not secure is refused before the pad (the wallet's `mintUrlProblem`)
    const W5 = wallet({ pin: PIN }), e = app(W5);
    W5.scanned = 'http://mint.new';
    e.scanOtherMint();
    await wait(5);
    ok(!e.pads.length && !did(W5, 'switch') && /not secure/.test(e.toasts.join(' ')), 'an http address that is not an .onion is refused before the gate',
      JSON.stringify({ pads: e.pads.length, toasts: e.toasts }));
  }

  console.log('\n3. a token from a new mint, KEEP IT THERE');
  const keeping = (a) => { a.state.nmInfo = { mint: NEW, sats: 5, unit: 'usd', amount: 5 }; a.state.nmToken = 'new-token'; };
  await entry('keeping a token at a new mint', keeping, (a) => a.newMintKeep(), 'receive new-token');
  {
    const W = wallet({ pin: PIN }), a = app(W);
    a.state.nmInfo = { mint: KNOWN, sats: 5, unit: 'usd', amount: 5 }; a.state.nmToken = 'known-token';
    a.newMintKeep();
    await wait(5);
    ok(!a.pads.length && did(W, 'receive known-token'), 'keeping one at a mint this phone uses asks nothing', JSON.stringify(W.calls));
  }

  console.log('\n4. a request naming a new mint, USE');
  const useCardAt = (mint) => (a) => {
    a.state.req = { mints: [mint], sats: 5, unit: 'sat' };
    a.makeTokenForRequest();
    const card = a.cards.find((c) => c[0] === 'reqMint');
    if (!card) return Promise.resolve();
    // what USE starts again, counted rather than run
    a.makeTokenForRequest = (go) => { window.FoxyWallet.calls.push('pay at ' + a._reqMintOk); return go; };
    return Promise.resolve(card[1].go());
  };
  await entry('USE on a request at a new mint', () => {}, useCardAt(NEW), 'pay at ' + NEW);
  // a mint on the list from a visit only: the card and its gate too, or a request with no delivery saves the phone there
  await entry('USE on a request at a mint only visited', () => {}, useCardAt(VISITED), 'pay at ' + VISITED);

  /* The scan looks at every mint on the list (`scanSeedRows` reads `knownMints`), and a mint the phone only visited is on
   * it: a row the app makes, at a mint the person never chose. */
  console.log('\n5. a restore that finds money at a mint the phone only visited');
  const restoring = (a) => {
    const row = { url: VISITED, host: 'mint.visited', state: 'done', sats: 5 };
    Object.assign(a.state, { rsPick: row, rsRows: [row, { url: KNOWN, host: 'mint.known', state: 'done', sats: 7 }] });
  };
  ok(app(wallet()).knownMints().indexOf(VISITED) >= 0 && /: this\.knownMints\(\);/.test(method('scanSeedRows') || src),
    'the restore scans every mint on the list, a visited one with them');
  await entry('a restore keeping a visited mint', restoring, (a) => a.adoptRestoreMint(), 'adopt');
  {
    const W = wallet({ pin: PIN }), a = app(W);
    restoring(a);
    a.adoptRestoreMint();
    await wait(5);
    submit(a, PIN);
    await wait(5);
    ok(did(W, 'choose ' + VISITED) && did(W, 'adopt'), 'passed, the mints it keeps are chosen', JSON.stringify(W.calls));
  }
  {
    const W = wallet({ pin: PIN }), a = app(W);
    const row = { url: KNOWN, host: 'mint.known', state: 'done', sats: 7 };
    Object.assign(a.state, { rsPick: row, rsRows: [row] });
    a.adoptRestoreMint();
    await wait(5);
    ok(!a.pads.length && did(W, 'adopt'), 'a restore at mints this phone already has asks nothing', JSON.stringify(W.calls));
  }

  console.log('\n6. a cashier code at a new mint');
  await entry('working a till at a new mint', () => {}, (a) => a.tillJoinGo({ mint: NEW, id: 'x', exp: 0 }), 'join ' + NEW);
  {
    const W = wallet({ pin: PIN }), a = app(W);
    a.tillJoinGo({ mint: KNOWN, id: 'x', exp: 0 });
    await wait(5);
    ok(!a.pads.length && did(W, 'join ' + KNOWN), 'a till at a mint this phone uses asks nothing', JSON.stringify(W.calls));
  }

  console.log('\n7. the gate itself');
  {
    const W = wallet({ pin: PIN }), a = app(W);
    ok(!!a.mintOnPhone && a.mintOnPhone(HERE) && a.mintOnPhone('HTTPS://MINT.KNOWN/') && a.mintOnPhone('https://shipped.example')
      && !a.mintOnPhone(NEW) && !a.mintOnPhone(VISITED) && !a.mintOnPhone(''),
      'on this phone: its own mint, the chosen ones, the shipped ones; not a stranger, nor a mint only visited');
    // the wallet's real comparison decides which address is the same mint
    const cases = [
      ['https://MINT.PATHED/Bitcoin', true, 'the host in capitals'],
      ['https://mint.pathed/Bitcoin/', true, 'a trailing slash'],
      ['https://mint.pathed:443/Bitcoin', true, 'the default port'],
      ['https://mint.pathed./Bitcoin', true, 'a dot after the name'],
      ['https://mint.pathed/bitcoin', false, 'the path in another case'],
      ['https://mint.pathed:8443/Bitcoin', false, 'another port'],
      ['https://someone@mint.pathed/Bitcoin', false, 'a user before the host'],
      ['https://mint.pathed/Bitcoin?x=1', false, 'a query'],
      ['https://mint.pathed.evil/Bitcoin', false, 'a longer host'],
    ];
    for (const [u, same, why] of cases) {
      ok(a.mintOnPhone(u) === same, 'the same mint or not (' + why + '): ' + u + (same ? ' is free' : ' asks'));
    }
    let ran = 0;
    if (a.mintGate) a.mintGate(KNOWN, () => { ran += 1; });
    ok(ran === 1 && !a.pads.length, 'a mint on this phone: on at once, nothing asked');
    if (a.mintGate) a.mintGate(NEW, () => { ran += 1; }, 'To add this mint.');
    ok(ran === 1 && a.pads.length === 1 && pad(a).title === 'ENTER YOUR PIN' && pad(a).subtitle === 'To add this mint.',
      'a new one: the same pad the till asks, saying why', JSON.stringify(a.pads.map((p) => [p.title, p.subtitle])));
  }

  console.log('\n8. the till’s own gate is unchanged');
  {
    const tillGate = method('tillGate');
    ok(!!tillGate && /SET A LOCK FIRST/.test(tillGate) && /this\.lockAsk\(go, why/.test(tillGate), 'POINT OF SALE still says SET A LOCK FIRST with no lock, and asks through the same lock');
  }

  console.log('\n9. a tile of a mint the phone only visited');
  {
    ok(/: \(\(\) => this\.mintTileTap\(m\.url\)\)/.test(src), 'the mint list’s tile switches through the gate');
    await entry('a visited mint’s tile', () => {}, (a) => tile(a, VISITED), 'switch ' + VISITED);
    const W = wallet({ pin: PIN }), a = app(W);
    tile(a, KNOWN);
    tile(a, 'https://shipped.example');
    await wait(5);
    ok(!a.pads.length && did(W, 'switch ' + KNOWN) && did(W, 'switch https://shipped.example'), 'a chosen mint’s tile, and a shipped one’s, ask nothing',
      JSON.stringify(W.calls));
    tile(a, VISITED);
    await wait(5);
    submit(a, PIN);
    await wait(5);
    ok(did(W, 'choose ' + VISITED) && did(W, 'switch ' + VISITED), 'passed, the visited mint is chosen and switched to', JSON.stringify(W.calls));
    const pads = a.pads.length;
    tile(a, VISITED);
    await wait(5);
    ok(a.pads.length === pads, 'chosen, its tile asks nothing again');
  }

  console.log('\n10. a Cashu ID payment at another mint, KEEP IT THERE');
  {
    const offer = { key: 'k1', mint: NEW, host: 'mint.new', amount: 21, unit: 'sat', lands: 20, fee: 1, name: 'Ana' };
    const keepIt = (always) => (a) => {
      a.cidOfferCard(offer);
      const card = a.cards.find((c) => c[0] === 'cidOffer-k1');
      return card ? card[1].shut.tap(always) : undefined;
    };
    await entry('KEEP IT THERE for a Cashu ID payment', () => {}, keepIt(false), 'decide keep k1');
    const W = wallet({ pin: PIN }), a = app(W);
    keepIt(true)(a);
    await wait(5);
    submit(a, PIN);
    await wait(5);
    ok(did(W, 'decide keep k1 always') && did(W, 'choose ' + NEW), 'passed, the tick is carried and the mint is chosen', JSON.stringify(W.calls));
    const W2 = wallet({ pin: PIN }), b = app(W2);
    b.cidOfferCard(Object.assign({}, offer, { mint: KNOWN }));
    b.cards.find((c) => c[0] === 'cidOffer-k1')[1].shut.tap(false);
    await wait(5);
    ok(!b.pads.length && did(W2, 'decide keep k1'), 'kept at a mint the person chose: nothing asked', JSON.stringify(W2.calls));
    // the other answers add no mint, and ask nothing
    const W3 = wallet({ pin: PIN }), c = app(W3);
    c.cidOfferCard(Object.assign({}, offer, { back: true }));
    const card = c.cards.find((x) => x[0] === 'cidOffer-k1')[1];
    card.go('', false);
    card.pills[0].tap(false);
    await wait(5);
    ok(!c.pads.length && did(W3, 'decide home k1') && did(W3, 'decide back k1'), 'BRING IT HOME and SEND IT BACK ask nothing', JSON.stringify(W3.calls));
  }

  console.log('\n11. the real wallet');
  await realWallet();

  console.log('\n12. TRANSFER TO a mint only visited');
  {
    const at = (a) => {
      Object.assign(a.state, { screen: 'switchMint', trStep: 'to', trFrom: HERE, trUnit: 'sat' });
      a.mintPile = () => ({ sats: 50, units: [] });
      // the keypad opening, counted
      const keypad = a.trPickTo;
      a.trPickTo = function (m) { window.FoxyWallet.calls.push('keypad ' + m); return keypad.call(this, m); };
    };
    await entry('TRANSFER TO a visited mint', at, (a) => a.trPick(VISITED), 'keypad ' + VISITED);
    const W = wallet({ pin: PIN }), a = app(W);
    at(a);
    a.trPick(VISITED);
    submit(a, PIN);
    await wait(5);
    ok(a.state.screen === 'amount' && a.state.trTo === VISITED && !did(W, 'choose'), 'passed, the keypad, and the mint is not chosen until the transfer lands',
      JSON.stringify({ screen: a.state.screen, calls: W.calls }));
    const W2 = wallet({ pin: PIN }), b = app(W2);
    at(b);
    b.trPick(KNOWN);
    ok(!b.pads.length && b.state.screen === 'amount', 'TRANSFER TO a chosen mint asks nothing');
    ok(/W\.connect\(trTo, null, null, \{ remember: false \}\)/.test(method('quoteTransfer'))
      && /W\.connect\(this\.state\.trFrom, null, null, \{ remember: false \}\)/.test(method('runTransfer')),
      'the quote and the run connect as visits; the landing (`moveRun`) saves the phone where it lands');
  }

  console.log('\n13. the live mint is the saved one when a flow ends');
  await liveHome();

  console.log('\n14. the trip home is counted while it is out');
  await homeRace();

  console.log('');
  console.log(failed ? failed + ' of ' + (passed + failed) + ' mint gate checks FAILED' : passed + ' passed, 0 failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e && e.stack || e)); process.exit(1); });
