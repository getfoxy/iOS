'use strict';
/* switch-guard.js — no mint switch while money is moving, and a restore that
 * waits for its own write.
 *
 *     node tests/switch-guard.js
 *
 * moneyBusy and every switch path a person can start, lifted out of
 * build/foxy-app.js and run against a stand-in app and wallet.
 *
 * The switch screen already refused while the proof lock was held, but a
 * payment request, a pasted or scanned token from another mint, a new-mint
 * claim, the change sweep and a restore all connected elsewhere without
 * asking, and stages outside the lock (a Lightning address lookup, a send
 * still running, an invoice being watched) were not counted at all. Found in
 * the review of af333d8, finding 17.
 *
 * adoptScan runs in the wallet's proof lock and answers with a promise. The
 * restore wrapped it in a try and connected at once, so a refusal never
 * reached rsPickErr; the new-mint check refreshed the balance before the
 * proofs were filed. */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function block(start) {
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function method(sig) {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  return block(at + 3);
}
const methods = new Function('return {' + [
  'moneyBusy() {', 'busyWhy() {', 'refuseSwitchWhileBusy() {', 'tokenSwitchRefused(text) {',
  'justSwitch(url, waited) {', 'sweepHoldsLock() {', 'switchAfterSweep(url, go) {', 'reqMints(req) {', 'reqCanon(u) {', 'reqPayMint(req) {', 'reqHeldAt(req, amount) {', 'makeTokenForRequest(go) {', 'sweepChange(from, left, already) {',
  'takeTokenFromPaste(text) {', 'takingToken(run) {', 'newMintKeep(passed) {', 'newMintRedeem() {',
  'rowUnits(row) {', 'adoptRestoreMint(passed) {', 'sweepNewMint(url, host) {', 'mintNameOf(url) {',
  'shortMintName(raw, url) {', 'mintKnownName(url) {',
  'back() {', 'goSwitchMint(extra) {', 'goTransfer() {', 'trPick(url) {',
  // the verifying-ecash screen a pasted token puts up (07-history-tokens-mints.js)
  'receivingUp(title) {', 'receivingDown() {',
  // what ends a receive (12-receive.js, 19-update-keypad-balance.js)
  'stopReceive() {', 'endReceiveAtHome() {',
  // a switch that lands at once, and its mint's answer (09-melt-paste-switch.js)
  'mintConnected(ev) {', 'onMint(url) {',
].map(method).join(',\n') + '}')();

// the real offer, for the tests that need it; the rest keep the stand-in's
const realOffer = new Function('return {' + method('offerNewMint(text) {') + '}')().offerNewMint;
const HERE = 'https://mint.here', THERE = 'https://mint.there';
const WAIT = 'Wait for the payment to finish before switching mints.';
const wait = ms => new Promise(r => setTimeout(r, ms));

function wallet(over) {
  return Object.assign({
    calls: [], depth: 0, mintUrl: HERE,
    proofLockDepth() { return this.depth; },
    mintHost() { return 'mint.here'; },
    mints() { return [THERE]; },
    connect(url) { this.calls.push('connect ' + url); return Promise.resolve({ name: url }); },
    tokenInfo(t) { return { mint: t === 'here-token' ? HERE : THERE, sats: 5, unit: 'sat', amount: 5 }; },
    receiveToken(t) { this.calls.push('receive ' + t); return Promise.resolve({ host: 'mint.there', switched: true }); },
    sendToken() { this.calls.push('sendToken'); return Promise.resolve({ token: 'cashuB', sats: 5, hash: 'h' }); },
    sweepQuote() { this.calls.push('sweepQuote'); return Promise.resolve({ from: THERE, to: HERE }); },
    moveRun() { this.calls.push('moveRun'); return Promise.resolve({ sats: 5, leftBehind: 0 }); },
    transactions() { return Promise.resolve([]); },
    adoptScan() { this.calls.push('adopt'); return Promise.resolve(); },
    scanSeed() { return Promise.resolve([]); },
    reason(e) { return (e && e.message) || String(e); },
  }, over || {});
}

function app(W) {
  global.window = { FoxyWallet: W };
  return Object.assign({
    state: { screen: 'home', stack: [] },
    toasts: [],
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    toast(m) { this.toasts.push(m); },
    showMelt() {}, hideMelt() {}, meltSays() {}, expectOwnSpend() {},
    walletReady() {}, refreshBalance() { W.calls.push('refresh'); }, loadHistory() {},
    announcePayment(ev) { this.announced = ev; }, hushSweepEntries() { return Promise.resolve(); },
    offerNewMint() { return false; }, balNow() { return 0; }, tookToken() {},
    settleAnimate() {}, noteReceived() {}, claimFailed(e) { this.claimErr = e; },
    watchToken() {}, mintPile() { return { sats: 0 }; }, mintHost() { return W.mintHost(); },
    group: n => String(n), unitMoney: (a, u) => a + ' ' + u, rowAmounts: () => '5 sats',
  }, methods);
}

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));
const said = a => a.toasts.indexOf(WAIT) >= 0;
const touched = (W, what) => W.calls.some(c => c.indexOf(what) === 0);

(async () => {
  // 0. a receive that has reached home is not a payment in progress
  /* Paid by tap, the receive screen goes confirm, paid, home and never passes
   * the close button — so its invoice watch ran on and the switch was refused
   * for a payment that had finished. */
  {
    const W = wallet(), a = app(W);
    let stopped = 0;
    a._watching = true; a._stopWatch = () => { stopped += 1; }; a._invoiceRun = 4;
    a.endReceiveAtHome();
    check('home stops the invoice watch', stopped === 1 && !a._watching && !a._stopWatch, stopped + ' stop(s)');
    check('and an invoice still on its way will not arm another', a._invoiceRun === 5, String(a._invoiceRun));
    check('so the switch is not refused for it', a.refuseSwitchWhileBusy() === false && !said(a), a.toasts.join('; '));
    /* Left within a second, before the mint had answered: nothing is being
     * watched yet, and the invoice that answers a moment later must not start
     * a watch on a screen that has gone. It did, and the switch was refused
     * for an invoice nobody had seen. */
    const b = app(wallet());
    b._watching = false; b._stopWatch = null; b._invoiceRun = 7;
    b.endReceiveAtHome();
    check('home with an invoice still being asked for: its answer will be an older request\u2019s, and arm nothing',
      b._invoiceRun === 8 && !b._watching, String(b._invoiceRun));
    check('and every arrival at home asks',
      /prevState\.screen !== this\.state\.screen\) \{[\s\S]{0,400}if \(this\.state\.screen === 'home'\) this\.endReceiveAtHome\(\);/.test(src),
      'componentDidUpdate');
  }

  // 1. every kind of money in motion blocks the switch screen
  const busy = [
    ['the proof lock is held', (a, W) => { W.depth = 1; }],
    ['a send is in flight', a => { a._sendRun = new Promise(() => {}); }],
    ['a token is being claimed and moved', a => { a.state.nmBusy = true; }],
    ['change is being collected', a => { a._chasingChange = true; }],
    ['a token is being made for a request', a => { a.state.reqBusy = true; }],
  ];
  for (const [label, set] of busy) {
    const W = wallet(), a = app(W);
    set(a, W);
    a.justSwitch(THERE);
    await wait(0);
    check('switch screen refuses when ' + label, !touched(W, 'connect') && said(a),
      JSON.stringify({ calls: W.calls, toasts: a.toasts }));
  }
  {
    /* An unpaid invoice is not a payment in progress: nothing has moved. It
     * used to hold the switch until the person went back and closed it. The
     * watch is let go, the invoice stays on file, and the switch goes on. */
    const W = wallet(), a = app(W);
    let stopped = 0;
    a._watching = true; a._stopWatch = () => { stopped += 1; }; a._invoiceRun = 2;
    a.justSwitch(THERE);
    await wait(0);
    check('an invoice being watched does not hold the switch: the watch is let go and the mint is changed',
      stopped === 1 && !a._watching && a._invoiceRun === 3 && touched(W, 'connect ' + THERE) && !said(a),
      JSON.stringify({ stopped, calls: W.calls, toasts: a.toasts }));
    // but with money really moving as well, it still waits, and the invoice is let go all the same
    const W2 = wallet(), b = app(W2);
    b._watching = true; b._stopWatch = () => {}; b._sendRun = new Promise(() => {});
    b.justSwitch(THERE);
    await wait(0);
    check('with a payment under way as well, the switch still waits', !touched(W2, 'connect') && said(b), JSON.stringify(W2.calls));
  }
  {
    const W = wallet(), a = app(W);
    check('nothing moving: not busy', a.moneyBusy() === false, 'busy');
    a.justSwitch(THERE);
    await wait(0);
    check('nothing moving: the switch screen connects', touched(W, 'connect ' + THERE) && !said(a), JSON.stringify(W.calls));
  }
  {
    /* MINT-PRIVACY.md C9: a restore scan hands a mint this seed's whole history
     * there, so switching back to a mint this device has used does not scan it. */
    const scans = [];
    const used = wallet({ mintUsedBefore: () => true, scanSeed: (w, m) => { scans.push(m); return Promise.resolve([]); } });
    const a = app(used);
    a.justSwitch(THERE);
    await wait(5);
    const fresh = wallet({ mintUsedBefore: () => false, scanSeed: (w, m) => { scans.push(m); return Promise.resolve([]); } });
    const b = app(fresh);
    b.justSwitch(THERE);
    await wait(5);
    check('switching back to a mint used before scans no seed there; a new mint is scanned',
      scans.length === 1 && touched(used, 'connect ' + THERE), JSON.stringify(scans));
  }

  // 2. every other switch path, with a Lightning address still being looked up
  const sending = () => { const W = wallet(), a = app(W); a._sendRun = new Promise(() => {}); return [W, a]; };
  {
    const [W, a] = sending();
    a.state.req = { mints: [THERE], sats: 5, unit: 'sat' };
    a.makeTokenForRequest();
    await wait(0);
    check('a request at another mint waits', !touched(W, 'connect') && !touched(W, 'sendToken') && said(a) && !a.state.reqBusy,
      JSON.stringify({ calls: W.calls, toasts: a.toasts }));
  }
  {
    const [W, a] = sending();
    a.state.req = { mints: [HERE], sats: 5, unit: 'sat' };
    a.makeTokenForRequest();
    await wait(0);
    check('a request at this mint switches nothing and goes ahead', touched(W, 'sendToken') && !touched(W, 'connect') && !said(a),
      JSON.stringify(W.calls));
  }
  {
    const [W, a] = sending();
    a.takeTokenFromPaste('there-token');
    await wait(0);
    check('a pasted token from another mint waits', !touched(W, 'receive') && said(a), JSON.stringify(W.calls));
  }
  {
    const [W, a] = sending();
    a.takeTokenFromPaste('here-token');
    await wait(0);
    check('a pasted token from this mint goes ahead', touched(W, 'receive') && !said(a), JSON.stringify(W.calls));
  }
  {
    const [W, a] = sending();
    a.state.nmInfo = { mint: THERE, sats: 5, unit: 'usd', amount: 5 };
    a.state.nmToken = 'there-token';
    a.newMintKeep();
    await wait(0);
    check('keeping a token at its new mint waits', !touched(W, 'receive') && said(a) && !a.state.nmBusy, JSON.stringify(W.calls));
  }
  {
    const [W, a] = sending();
    a.state.nmPlan = { from: THERE, to: HERE, net: 5 };
    a.state.nmToken = 'there-token';
    a.newMintRedeem();
    await wait(0);
    check('redeeming a token from a new mint waits', !touched(W, 'receive') && !touched(W, 'moveRun') && said(a) && !a.state.nmBusy,
      JSON.stringify(W.calls));
  }
  {
    const [W, a] = sending();
    a.sweepChange(THERE, 10, 50);
    await wait(0);
    check('the change sweep leaves the change where it is', !touched(W, 'sweepQuote') && !touched(W, 'connect')
      && !a._chasingChange && a.announced && a.announced.sats === 50, JSON.stringify({ calls: W.calls, announced: a.announced }));
  }
  {
    const W = wallet(), a = app(W);
    a.sweepChange(THERE, 10, 50);
    await wait(10);
    check('nothing moving: the change sweep runs', touched(W, 'sweepQuote') && touched(W, 'connect ' + THERE) && touched(W, 'moveRun'),
      JSON.stringify(W.calls));
  }
  const pick = { url: THERE, host: 'mint.there', state: 'done', sats: 5 };
  const restoring = a => Object.assign(a.state, { rsPick: pick, rsRows: [pick] });
  {
    const [W, a] = sending();
    restoring(a);
    a.adoptRestoreMint();
    await wait(0);
    check('a restore waits too', !touched(W, 'adopt') && !touched(W, 'connect') && said(a) && !a.state.rsBusy2, JSON.stringify(W.calls));
  }

  // 3. adoptScan answers with a promise: wait for it, show its refusal
  for (const [label, adoptScan] of [
    ['rejects', function () { this.calls.push('adopt'); return Promise.reject(new Error('the proofs are busy')); }],
    ['throws', function () { this.calls.push('adopt'); throw new Error('the proofs are busy'); }],
  ]) {
    const W = wallet({ adoptScan }), a = app(W);
    restoring(a);
    a.adoptRestoreMint();
    await wait(10);
    check('restore: adoptScan ' + label + ' — the error is shown', a.state.rsPickErr === 'the proofs are busy' && a.state.rsBusy2 === false,
      JSON.stringify({ err: a.state.rsPickErr, busy: a.state.rsBusy2 }));
    check('restore: adoptScan ' + label + ' — no connect', !touched(W, 'connect'), JSON.stringify(W.calls));
  }
  {
    const slow = function () { this.calls.push('adopt'); return wait(20).then(() => this.calls.push('adopted')); };
    const W = wallet({ adoptScan: slow }), a = app(W);
    restoring(a);
    a.adoptRestoreMint();
    await wait(5);
    check('restore: nothing connects while adoptScan is still writing', !touched(W, 'connect'), JSON.stringify(W.calls));
    await wait(40);
    check('restore: connects once adoptScan has finished', W.calls.indexOf('connect ' + THERE) > W.calls.indexOf('adopted')
      && W.calls.indexOf('adopted') >= 0 && a.state.rsAdopted === true && !a.state.rsPickErr, JSON.stringify(W.calls));
  }
  {
    const found = [{ state: 'done', sats: 5, url: HERE }];
    // adoptScan answers with what it filed and how much of that is new (audit W1)
    const slow = function () {
      this.calls.push('adopt');
      return wait(20).then(() => { this.calls.push('adopted'); return { kept: [{ host: 'mint.here', sats: 5, added: 5, partial: false }], units: [] }; });
    };
    const W = wallet({ adoptScan: slow, scanSeed: () => Promise.resolve(found) }), a = app(W);
    a.sweepNewMint(HERE, 'mint.here');
    await wait(5);
    check('new mint: the balance is not read before the proofs are filed', !touched(W, 'refresh') && !a.toasts.length, JSON.stringify(W.calls));
    await wait(40);
    check('new mint: read and announced once they are', W.calls.indexOf('refresh') > W.calls.indexOf('adopted')
      && a.toasts.some(t => /^Found /.test(t)), JSON.stringify({ calls: W.calls, toasts: a.toasts }));
  }
  {
    // the scan saw 5 sats, but a payment or a sent token holds them: nothing new was filed
    const found = [{ state: 'done', sats: 5, url: HERE }];
    const none = function () { this.calls.push('adopt'); return Promise.resolve({ kept: [{ host: 'mint.here', sats: 0, added: 0, partial: false }], units: [] }); };
    const W = wallet({ adoptScan: none, scanSeed: () => Promise.resolve(found) }), a = app(W);
    a.sweepNewMint(HERE, 'mint.here');
    await wait(10);
    check('new mint: nothing is announced when nothing new was filed', !touched(W, 'refresh') && !a.toasts.length,
      JSON.stringify({ calls: W.calls, toasts: a.toasts }));
  }
  {
    const found = [{ state: 'done', sats: 5, url: HERE }];
    const W = wallet({ adoptScan: () => Promise.reject(new Error('no')), scanSeed: () => Promise.resolve(found) }), a = app(W);
    const warn = console.warn; console.warn = () => {};
    a.sweepNewMint(HERE, 'mint.here');
    await wait(10);
    console.warn = warn;
    check('new mint: a refused write announces nothing', !touched(W, 'refresh') && !a.toasts.length && a._sweeping === null,
      JSON.stringify({ calls: W.calls, toasts: a.toasts }));
  }

  {
    /* Your mint is the one you are on: a token from another goes to MOVE TO YOUR
     * MINT even where something is held. */
    const W = wallet({ balanceAt: (m) => (m === THERE ? 12 : 0) }), a = app(W);
    a.MINT_NAMES = {};
    a.offerNewMint = realOffer;
    const nq = []; a.nmQuote = () => nq.push(1);
    check('a token from another mint where 12 sats are held still offers the move', a.offerNewMint('there-token') === true
      && a.state.screen === 'newMint' && a.state.nmInfo.mint === THERE && !touched(W, 'receive') && !touched(W, 'connect'),
      JSON.stringify({ screen: a.state.screen, calls: W.calls }));
    const b = app(wallet());
    b.MINT_NAMES = {};
    b.offerNewMint = realOffer;
    check('a token from your own mint goes straight in', b.offerNewMint('here-token') === false && b.state.screen === 'home', b.state.screen);
  }
  {
    // keeping it at its mint claims there and brings the wallet back to yours
    const W = wallet({ receiveToken(t) { this.calls.push('receive ' + t); return Promise.resolve({ sats: 5, unit: 'sat', host: 'mint.there', switched: true }); } });
    const a = app(W);
    a.MINT_NAMES = {};
    a.state.nmInfo = { mint: THERE, sats: 5, unit: 'sat', amount: 5 };
    a.state.nmToken = 'there-token';
    a.newMintKeep();
    await wait(5);
    check('keeping a token at its mint claims it there, then the wallet is back on yours',
      W.calls.indexOf('receive there-token') >= 0 && W.calls.indexOf('connect ' + HERE) > W.calls.indexOf('receive there-token')
        && a.state.screen === 'home' && a.toasts.some(t => /Kept 5 sats at There/.test(t)),
      JSON.stringify({ calls: W.calls, toasts: a.toasts }));
  }

  /* 5. the mint list is never opened in a mode nobody asked for -------------
   *
   * One screen, three jobs, and trStep is the whole of what says which.
   * back() pops a screen and clears nothing, so a transfer dropped at "FROM
   * WHICH MINT?" left trStep set and every later way into the list opened it
   * still asking which mint to move from — with no way back to switching. */
  {
    // goTransfer does nothing without a wallet that can quote a move
    const W = wallet({ transferQuote() { return Promise.resolve({ feeSats: 1 }); } });
    const a = app(W);
    a.refuseSwitchWhileBusy = () => false;
    a.goTransfer();
    check('TRANSFER opens the mint list asking which mint the money leaves',
      a.state.screen === 'switchMint' && a.state.trStep === 'from', JSON.stringify(a.state));
    a.back();
    check('back from that list comes home', a.state.screen === 'home', a.state.screen);
    a.goSwitchMint();
    check('SWITCH after a dropped transfer opens the list to switch, not to move',
      a.state.screen === 'switchMint' && !a.state.trStep, JSON.stringify(a.state));
    // the one that made it unrecoverable: a tap on the list began a transfer
    a.trPick(THERE);
    check('picking a mint with no transfer under way starts nothing',
      a.state.screen === 'switchMint' && a.state.flow !== 'transfer', JSON.stringify(a.state));
  }
  {
    // every other way in says the same, so none of them can inherit the mode
    const ways = ['goSwitchMint(extra) {'];
    const inherits = ways.filter(sig => {
      const body = method(sig);
      return body.indexOf('trStep') < 0;
    });
    check('the one way into the switch list names the mode it opens in',
      inherits.length === 0, inherits.join(', '));
    const strays = (src.match(/screen: 'switchMint'/g) || []).length;
    // goSwitchMint and goTransfer, and nothing else setting that screen by hand
    check('nothing opens the mint list around goSwitchMint', strays === 2, strays + ' places set screen switchMint');
  }

  // 9. a switch lands at once (`switchTo`), and "Now on" waits for the mint's answer (`mintConnected`)
  {
    let pending = null;
    const W = wallet({
      switchTo(url) {
        this.calls.push('switchTo ' + url);
        this.mintUrl = url; pending = { url, host: 'mint.there' };
        return Promise.resolve({ name: 'mint.there', pending: true, balanceSats: 300 });
      },
      connectPending() { return pending; },
      mintHost() { return String(this.mintUrl).replace(/^https?:\/\//, ''); },
      fromCache() { return !!pending; },
    });
    const a = app(W);
    const ready = [];
    a.walletReady = (w) => { ready.push(w); a.setState({ screen: 'home', stack: [] }); };
    a.offerQuarantine = () => {}; a.convertOnReturn = null;
    let againCalls = 0;
    a.connectForRealOnceOnline = () => { againCalls += 1; };
    a.state.screen = 'switchMint'; a.state.stack = ['home'];
    a.justSwitch(THERE);
    await wait(0);
    check('the switch asks the wallet to switch at once, not to connect and wait',
      touched(W, 'switchTo ' + THERE) && !touched(W, 'connect'), JSON.stringify(W.calls));
    check('home is drawn straight away, on the new mint, and the mint list has closed',
      ready.length === 1 && a.state.screen === 'home' && W.mintUrl === THERE && !a.state.switchBusy && !a.state.mintBusy,
      JSON.stringify({ ready, screen: a.state.screen, busy: a.state.switchBusy }));
    check('nothing is said at the tap: the shield says it is connecting',
      a.toasts.length === 0 && !!a._switchSay && a._switchSay.url === THERE, JSON.stringify(a.toasts));
    const refreshes = W.calls.filter(c => c === 'refresh').length;
    pending = null;
    a.mintConnected({ url: THERE, ok: true });
    check('when the mint answers: "Now on" it, and the balance is read again',
      a.toasts.indexOf('Now on mint.there') >= 0 && W.calls.filter(c => c === 'refresh').length === refreshes + 1 && !a._switchSay,
      JSON.stringify({ toasts: a.toasts, calls: W.calls }));
    a.mintConnected({ url: THERE, ok: true });
    check('and only once for the switch', a.toasts.filter(t => t === 'Now on mint.there').length === 1, JSON.stringify(a.toasts));

    // one that does not answer: the phone stays, says so, and is asked again behind the screen
    const b = app(W);
    b.walletReady = () => b.setState({ screen: 'home', stack: [] });
    b.offerQuarantine = () => {};
    let again = 0;
    b.connectForRealOnceOnline = () => { again += 1; };
    b._catchUpConnect = true;
    b.justSwitch(THERE);
    await wait(0);
    b.mintConnected({ url: THERE, ok: false, why: 'b timed out', back: false });
    check('a mint that does not answer: said, the phone stays, and the connect for real is armed again',
      b.toasts.some(t => /mint\.there is not answering yet/.test(t)) && W.mintUrl === THERE && again === 1 && b._catchUpConnect === false,
      JSON.stringify({ toasts: b.toasts, again }));
    // with no keys on file, it went back: home on the mint it was on
    const c = app(W);
    const cReady = [];
    let cAgain = 0;
    c.walletReady = (w) => cReady.push(w);
    c.connectForRealOnceOnline = () => { cAgain += 1; };
    W.mintUrl = HERE;
    c.mintConnected({ url: 'https://mint.new', ok: false, why: 'no answer', back: true });
    check('a switch with no keys on file that went back: home again on the old mint, and said',
      cReady.length === 1 && c.toasts.some(t => /Could not reach mint\.new .*Still on mint\.here/.test(t)), JSON.stringify(c.toasts));
    check('and the wallet put back, itself from the keys on file, is connected to for real behind it', cAgain === 1, String(cAgain));
    // "Now on" by the switch's number (`gen`): an earlier switch's answer is not this one's, and after NOT ANSWERING
    // the answer that does come is said once
    {
      let n = 0;
      const G = wallet({
        switchTo(url) { this.mintUrl = url; n += 1; return Promise.resolve({ name: 'mint.there', pending: true, gen: n }); },
        connectPending() { return null; }, fromCache() { return false; },
        mintHost() { return String(this.mintUrl).replace(/^https?:\/\//, ''); },
      });
      const g = app(G);
      g.walletReady = () => {}; g.offerQuarantine = () => {}; g.connectForRealOnceOnline = () => {};
      g.justSwitch(THERE); await wait(0);       // switch 1
      g.justSwitch(HERE); await wait(0);        // switch 2, before 1 answered
      g.justSwitch(THERE); await wait(0);       // switch 3, to the first mint again
      g.mintConnected({ url: THERE, ok: true, gen: 1 });
      check('an earlier switch to the same mint answering late does not say "Now on" for this one',
        !g.toasts.some(t => /^Now on/.test(t)) && !!g._switchSay && g._switchSay.gen === 3, JSON.stringify({ toasts: g.toasts, say: g._switchSay }));
      g.mintConnected({ url: THERE, ok: false, why: 'timed out', back: false, gen: 3 });
      g.mintConnected({ url: THERE, ok: false, why: 'timed out', back: false, gen: 3 });
      check('this switch not answering is said once, and its "Now on" is kept for when it does',
        g.toasts.filter(t => /is not answering yet/.test(t)).length === 1 && !!g._switchSay, JSON.stringify(g.toasts));
      g.mintConnected({ url: THERE, ok: true, gen: 3 });
      check('and when it answers after all, "Now on" is said once',
        g.toasts.filter(t => t === 'Now on mint.there').length === 1 && !g._switchSay, JSON.stringify(g.toasts));
      const before = g.toasts.length;
      g.justSwitch(HERE); await wait(0);
      check('every switch starts with no "Now on" of an earlier one waiting', g._switchSay && g._switchSay.gen === 4 && g.toasts.length === before,
        JSON.stringify(g._switchSay));
    }
    // a wallet with no switchTo still connects and waits, as before
    const old = wallet(), d = app(old);
    d.justSwitch(THERE);
    await wait(0);
    check('a wallet without switchTo still connects, and says "Now on" at once',
      touched(old, 'connect ' + THERE) && d.toasts.indexOf('Now on mint.there') >= 0, JSON.stringify(d.toasts));
    void againCalls;
  }
  // and the receive screen waits for a mint that has not answered, rather than spending a try
  {
    const at = src.indexOf('\n  openReceiveNow() {');
    const recv = block(at + 3);
    check('the receive screen waits for a mint switched to, by `routeSoon`, without spending a try',
      /e && e\.foxyConnecting && waits < WAITS && W\.routeSoon\)[\s\S]{0,260}W\.routeSoon\(this\.MINT_ANSWER_WAIT_MS\)[\s\S]{0,120}return attempt\(n, waits \+ 1\)/.test(recv),
      'openReceiveNow');
    check('and the boot listens for the mint\u2019s answer', /W\.onMintConnected\(\(ev\) => this\.mintConnected\(ev\)\)/.test(src), 'bootWallet');
  }

  // ---- 2026-11-03: the switch names its path, and a background sweep holding the proof lock is waited for ----------------
  {
    const said = [];
    const log0 = console.log;
    const caught = (fn) => { said.length = 0; console.log = (...a) => { said.push(a.join(' ')); }; try { return fn(); } finally { console.log = log0; } };
    // at once, from the keys on file
    const L = wallet({ switchTo(url) { this.calls.push('switchTo ' + url); return Promise.resolve({ name: 'mint.there', pending: true, gen: 1 }); },
                       switchWaits() { return ''; } });
    const l = app(L);
    l.walletReady = () => {};
    caught(() => l.justSwitch(THERE));
    check('a switch that lands at once says so: "switch: <host> \u2014 at once (switchTo)"',
      said.some(x => x === '[foxy] switch: mint.there \u2014 at once (switchTo)'), JSON.stringify(said));
    // waiting for the mint, with the wallet's reason
    const M = wallet({ switchTo() { return Promise.resolve({ name: 'mint.there', pending: true, gen: 1 }); },
                       switchWaits() { return 'its keysets could not be kept: the store is full'; } });
    const m = app(M);
    m.walletReady = () => {};
    caught(() => m.justSwitch(THERE));
    check('one that waits for the mint says why, in the wallet\u2019s words',
      said.some(x => x === '[foxy] switch: mint.there \u2014 waiting for the mint: its keysets could not be kept: the store is full'), JSON.stringify(said));
    // no switchTo in the wallet at all
    const N = wallet(), n = app(N);
    caught(() => n.justSwitch(THERE));
    check('and a wallet with no switchTo is named as the reason',
      said.some(x => x === '[foxy] switch: mint.there \u2014 waiting for the mint: no switchTo in the wallet'), JSON.stringify(said));
    await wait(0);

    // a sweep holding the lock, let go within the five seconds: the switch waits for it and goes on, with no refusal
    let holder = { what: '_onchainClaimAwayWith', ms: 3000 };
    const S = wallet({ proofLockHolder() { return holder; } });
    S.depth = 1;
    const sw = app(S);
    sw.walletReady = () => {};
    check('a sweep holding the proof lock is one to wait for', sw.sweepHoldsLock() === true, 'not a sweep');
    caught(() => sw.justSwitch(THERE));
    check('so the switch waits rather than refusing: the row shows it was tapped',
      sw.state.switchBusy === true && sw.state.mintBusy === THERE && !said.some(x => /refused/.test(x)) && !touched(S, 'connect')
      && said.some(x => /waiting up to 5s for _onchainClaimAwayWith \(a background sweep\)/.test(x)), JSON.stringify({ said, st: sw.state }));
    await wait(400);
    S.depth = 0; holder = null;
    await wait(400);
    check('and once the sweep lets go it switches, nothing said about a payment',
      touched(S, 'connect ' + THERE) && sw.toasts.indexOf(WAIT) < 0 && !sw._switchSweepT, JSON.stringify({ calls: S.calls, toasts: sw.toasts }));

    // a person's own payment holding the lock: refused at once, as before
    const P = wallet({ proofLockHolder() { return { what: 'pay', ms: 1000 }; } });
    P.depth = 1;
    const pp = app(P);
    check('a person\u2019s own payment in the lock is not a sweep', pp.sweepHoldsLock() === false, 'taken for a sweep');
    pp.justSwitch(THERE);
    await wait(0);
    check('and the switch is refused at once for it', pp.toasts.indexOf(WAIT) >= 0 && !touched(P, 'connect') && !pp.state.switchBusy,
      JSON.stringify(pp.toasts));
    // a sweep that does not let go in five seconds: refused then, as before
    const H = wallet({ proofLockHolder() { return { what: 'tidyChange', ms: 9000 }; } });
    H.depth = 1;
    const hh = app(H);
    const t0 = Date.now();
    hh.justSwitch(THERE);
    while (!hh.toasts.length && Date.now() - t0 < 7000) await wait(100);
    check('a sweep still holding it after five seconds: the switch is refused then, with the words it always had',
      hh.toasts.indexOf(WAIT) >= 0 && Date.now() - t0 >= 4900 && !touched(H, 'connect') && !hh.state.switchBusy,
      JSON.stringify({ ms: Date.now() - t0, toasts: hh.toasts }));
    // and something else moving money is never waited for, sweep or not
    const X = wallet({ proofLockHolder() { return { what: 'tidyChange', ms: 100 }; } });
    X.depth = 1;
    const xx = app(X);
    xx._sendRun = new Promise(() => {});
    check('a send running beside the sweep: not a sweep to wait for', xx.sweepHoldsLock() === false, 'waited');
  }

  results.forEach(r => console.log(r));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(failed ? failed + ' switch guard check(s) failed' : 'all switch guard checks pass');
  process.exit(failed ? 1 : 0);
})();
