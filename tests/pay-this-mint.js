'use strict';
/* pay-this-mint.js — paying someone at the same mint with a token.
 *
 *     node tests/pay-this-mint.js
 *
 * The invoice card (PAYING ANOTHER … USER), USE CASHU and CONTINUE OVER
 * LIGHTNING, the watch that says when the token is redeemed and how long it
 * waits before each question, and SCAN on the receive screen. The methods are
 * lifted out of build/foxy-app.js and run against a stand-in app and wallet,
 * as switch-guard.js does. MINT-PRIVACY.md C6. */
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
  'acceptTarget(text) {', 'payThisMintWithToken(sats, go) {', 'claimWait(kind) {',
  'claimWatchResume() {', 'claimWatchTick() {', 'claimWatchDue() {', 'scanTokenToReceive() {', 'syncPreview() {',
  'claimWaitFor(age, onScreen) {', 'tokenOnScreen(hash) {', 'watchToken(sats, hash, quick) {', 'tidyChangeLater(more) {', 'hushSweepEntries() {',
  'spScanToken(idx) {',
].map(method).join(',\n') + '}')();
// the real announcement, for the test that needs it; the others count calls
// announcePayment reads the app's list of confirmation screens, which lives
// beside it in the class file rather than in the method
const confirmScreens = /CONFIRM_SCREENS = (\[[^\]]*\])/.exec(src);
if (!confirmScreens) throw new Error('missing CONFIRM_SCREENS');
const announce = new Function('CONFIRM_SCREENS',
  'return {' + method('announcePayment(ev) {') + '}')(JSON.parse(confirmScreens[1].replace(/'/g, '"'))).announcePayment;
const waits = /CLAIM_WAITS = (\{[^;]*\});/.exec(src);
if (!waits) throw new Error('missing CLAIM_WAITS');

const INVOICE = 'lnbc21u1pthismint';
const wait = ms => new Promise(r => setTimeout(r, ms));

function wallet(over) {
  const watches = [];
  return Object.assign({
    calls: [], watches, claimAnswers: [],
    classify: (t) => (/^cashu/.test(t) ? 'token' : 'invoice'),
    amountOf: () => 2100,
    msatOf: () => 2100000,
    invoiceFromThisMint: () => true,
    mintNodeKnown: () => true,
    learnThisMintNode() { this.calls.push('learn'); return Promise.resolve('node'); },
    remember() {}, book: () => [],
    sendToken(sats) { this.calls.push('sendToken ' + sats); return Promise.resolve({ token: 'cashuBtok', sats, hash: 'token-1', swapped: true }); },
    watchTokenClaim(hash, opts) { watches.push({ hash, sats: 2100, persist: !!(opts && opts.persist), quick: !!(opts && opts.quick), since: Date.now() - 3600000 }); return true; },
    tidyChange() { this.calls.push('tidy'); return Promise.resolve({ skipped: 'enough small change' }); },
    watchedTokens() { return watches.slice(); },
    dropTokenWatch(hash) { const i = watches.findIndex(w => w.hash === hash); if (i >= 0) watches.splice(i, 1); },
    tokenClaimState(hash) { this.calls.push('ask ' + hash + ' ' + Date.now()); return Promise.resolve(this.claimAnswers.shift() || 'waiting'); },
    settleTx(h) { this.calls.push('settle ' + h); },
    forgetClaimedToken(h) { this.calls.push('forget ' + h); return true; },
    lastTokenHash: () => 'token-1',
    clearLastToken() { this.calls.push('clearLast'); },
    scan: () => Promise.resolve('cashuBincoming'),
    receiveToken(t) { this.calls.push('receive ' + t); return Promise.resolve({ sats: 2100, unit: 'sat', host: 'mint.here', switched: false }); },
    reason: (e) => String((e && e.message) || e),
  }, over || {});
}

function app(W, state) {
  global.window = { FoxyWallet: W };
  const a = Object.assign({
    state: Object.assign({ screen: 'sendScan', stack: ['home'] }, state || {}),
    cards: [], toasts: [], announced: [], calls: W.calls,
    CLAIM_WAITS: { first: [30, 30], quick: [5, 5], soon: [20, 20], later: [40, 40], rarely: [40, 40], offline: [8, 8] },
    TIDY_WAIT: [60000, 60000], moneyBusy: () => false, group: n => String(n),
    setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
    blockedCard(kind, spec) { this.cards.push({ kind, spec }); },
    toast(m) { this.toasts.push(m); },
    mintName: () => 'Minibits',
    showMelt() {}, hideMelt() {}, meltSays() {}, balNow: () => 0, refreshBalance() {},
    loadHistory() { W.calls.push('loadHistory'); }, noteReceived() {}, tookToken() {}, announceTaken() {},
    isBadSignatures: () => false, badSignatureCard() {}, walletReady() {},
    offerNewMint: () => false, tokenSwitchRefused: () => false, claimFailed(e) { this.claimErr = e; },
    closeReceive() { W.calls.push('closeReceive'); this.setState({ screen: 'home', stack: [] }); },
    announcePayment(ev) { this.announced.push(ev); },
  }, methods);
  return a;
}

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));

(async () => {
  // the shipped waits: after a swap 15-45 s; with no swap, or on a return, a few seconds
  const shipped = new Function('return ' + waits[1].replace(/\s+/g, ' '))();
  check('the shipped waits keep the first question after a swap clear of it, and the rest within seconds',
    shipped.first[0] >= 15000 && shipped.first[1] <= 45000 && shipped.quick[1] <= 4000 && shipped.soon[1] <= 5000,
    JSON.stringify(shipped));

  {
    const W = wallet(), a = app(W);
    a.acceptTarget(INVOICE);
    const card = a.cards[0];
    check('an invoice from this mint shows the card, not the confirmation',
      card && card.kind === 'sameMintInvoice' && a.state.screen === 'sendScan', JSON.stringify(a.cards) + ' ' + a.state.screen);
    check('the card says what was asked for',
      card && card.spec.title === 'PAYING ANOTHER MINIBITS USER'
        && card.spec.reason === 'This payment could have the ultimate privacy. But it requires you to make it over Cashu instead of Lightning.'
        && card.spec.retry === 'USE CASHU' && card.spec.shut.label === 'CONTINUE OVER LIGHTNING',
      JSON.stringify(card && card.spec));
    card.spec.shut.tap();
    check('CONTINUE OVER LIGHTNING goes to the confirmation for the invoice',
      a.state.screen === 'sendConfirm' && a.state.recipient === INVOICE && a.state.amount === '2100', JSON.stringify(a.state));
  }
  {
    const W = wallet(), a = app(W);
    a.acceptTarget(INVOICE);
    a.cards[0].spec.go();
    await wait(5);
    check('USE CASHU makes a token for the invoice amount and opens it with its subtitle',
      W.calls.indexOf('sendToken 2100') >= 0 && a.state.screen === 'tokenOut' && a.state.tokenForPayee === true
        && a.state.tokenOutHash === 'token-1' && a.state.tokenOut === 'cashuBtok',
      JSON.stringify({ calls: W.calls, state: a.state }));
    check('the token is watched, and kept watching after its screen closes',
      W.watches.length === 1 && W.watches[0].persist === true, JSON.stringify(W.watches));
    check('a token made with a swap waits before its first question', W.watches[0].quick === false, JSON.stringify(W.watches));
    clearTimeout(a._claimT);
  }
  {
    const W = wallet({ invoiceFromThisMint: () => false }), a = app(W);
    a.acceptTarget(INVOICE);
    check('an invoice from elsewhere goes straight to the confirmation', !a.cards.length && a.state.screen === 'sendConfirm', JSON.stringify(a.cards));
  }
  {
    // the mint's node not known when the invoice is scanned: asked, then the card
    let known = false;
    const W = wallet({ mintNodeKnown: () => known, invoiceFromThisMint: () => known,
      learnThisMintNode() { this.calls.push('learn'); known = true; return Promise.resolve('node'); } });
    const a = app(W);
    a.acceptTarget(INVOICE);
    check('an invoice scanned before the mint\'s node is known waits for it, with the camera held back',
      W.calls.indexOf('learn') >= 0 && a._checkingInvoice === true && !a.cards.length && a.state.screen === 'sendScan',
      JSON.stringify({ calls: W.calls, cards: a.cards }));
    await wait(5);
    check('then shows the card for it', a.cards.length === 1 && a._checkingInvoice === false, JSON.stringify(a.cards));
  }
  {
    // asked, and it is not the mint's: straight to the confirmation
    const W = wallet({ mintNodeKnown: () => false, invoiceFromThisMint: () => false });
    const a = app(W);
    a.acceptTarget(INVOICE);
    await wait(5);
    check('an invoice from elsewhere, asked about, goes to the confirmation', !a.cards.length && a.state.screen === 'sendConfirm', JSON.stringify(a.cards));
  }
  {
    // the scan screen's camera is a native view over the page: it must not sit over a card
    const W = wallet({ startPreview() { W.calls.push('startPreview'); return true; }, stopPreview() { W.calls.push('stopPreview'); }, stopPasteButton() {} });
    const a = app(W, { screen: 'sendScan' });
    a._previewOn = true;
    a._blockedEl = {};
    a.syncPreview();
    check('a card on the scan screen puts the camera away', W.calls.indexOf('stopPreview') >= 0 && a._previewOn === false, JSON.stringify(W.calls));
    W.calls.length = 0;
    a._blockedEl = null;
    a._checkingInvoice = true;
    a._previewOn = true;
    a.syncPreview();
    check('and so does checking an invoice', W.calls.indexOf('stopPreview') >= 0, JSON.stringify(W.calls));
  }
  {
    /* nor over the connection screen: back from the background on a scan
     * screen, the camera sat live across SECURING YOUR CONNECTION. The gate is drawn on the page; the pane is above it. */
    const W = wallet({ startPreview() { W.calls.push('startPreview'); return true; }, stopPreview() { W.calls.push('stopPreview'); }, stopPasteButton() {} });
    const a = app(W, { screen: 'sendScan' });
    let up = true;
    global.window.FoxyGate = { visible: () => up };
    a._previewOn = true;
    a.syncPreview();
    check('the connection screen over a scan screen puts the camera away',
      W.calls.indexOf('stopPreview') >= 0 && a._previewOn === false, JSON.stringify(W.calls));
    check('and no camera is started under it', W.calls.indexOf('startPreview') < 0, JSON.stringify(W.calls));
    const gate = fs.readFileSync(require('path').join(__dirname, '..', 'Web', 'foxy-tor-gate.js'), 'utf8');
    check('the gate says when it goes up, as it does when it goes down',
      /dispatchEvent\(new Event\('foxy-gate-up'\)\)/.test(gate) && /dispatchEvent\(new Event\('foxy-gate-down'\)\)/.test(gate));
    check('and the app asks about the camera again on both',
      /addEventListener\('foxy-gate-up',[^\n]*syncPreview/.test(src)
      && /addEventListener\('foxy-gate-down',[\s\S]{0,200}?syncPreview/.test(src));
  }
  {
    /* one token redeemed while another token's screen is open: DONE on the
     * confirmation goes back to that screen, not home */
    const W = wallet({ notify() {} });
    const a = app(W, { screen: 'tokenOut', stack: [], tokenOutHash: 'token-25' });
    global.document = { visibilityState: 'visible' };
    a.announcePayment = announce;
    a.announcePayment({ dir: 'out', sats: 10, hash: 'tokenclaim-token-10', to: 'ecash', tokenHash: 'token-10' });
    check('another token\'s confirmation keeps the open token screen to come back to',
      a.state.screen === 'paid' && a._returnTo && a._returnTo.screen === 'tokenOut', JSON.stringify({ screen: a.state.screen, back: a._returnTo }));
    const b = app(W, { screen: 'tokenOut', stack: [], tokenOutHash: 'token-10' });
    b.announcePayment = announce;
    b.announcePayment({ dir: 'out', sats: 10, hash: 'tokenclaim-token-10', to: 'ecash', tokenHash: 'token-10' });
    check('the token on screen being redeemed still ends there', b._returnTo === null, JSON.stringify(b._returnTo));
  }
  {
    // a move's own entries, already queued for a confirmation by a history pass, are taken out
    const W = wallet({ transactions: () => Promise.resolve([{ hash: 'old' }, { hash: 'claim-home' }, { hash: 'token-from' }]) });
    const a = app(W, { screen: 'home', stack: [] });
    a._sweepBefore = new Set(['old']);
    a._paidQueue = [{ hash: 'claim-home', sats: 21 }, { hash: 'someone-else', sats: 5 }];
    await a.hushSweepEntries();
    check('a move\'s entries queued for a confirmation are dropped, others kept',
      a._paidQueue.length === 1 && a._paidQueue[0].hash === 'someone-else' && a._seenTx['claim-home'] && !a._seenTx.old,
      JSON.stringify({ queue: a._paidQueue, seen: a._seenTx }));
  }
  {
    // split: a payer's token for exactly their share, from this mint, marks them paid
    const rows = [{ hash: 'q-2', sats: 2100, paid: false }, { hash: 'q-3', sats: 900, paid: false }];
    const mk = (over) => wallet(Object.assign({
      mintUrl: 'https://mint.here', splitPending: () => ({ rows }),
      tokenInfo: () => ({ mint: 'https://mint.here', sats: 2100, unit: 'sat' }),
    }, over));
    const W = mk(), a = app(W, { screen: 'spPayer', spFromWaiting: true });
    a.mintNameOf = (u) => String(u || '').replace(/^https?:\/\/(mint\.)?/, '');
    a.mintName = () => 'here';
    a.spMarkPaid = (i, h) => W.calls.push('paid ' + i + ' ' + h);
    a.spScanToken(0);
    await wait(10);
    check('split: a token for exactly the share is taken and the payer marked paid, back on COLLECTING',
      W.calls.indexOf('receive cashuBincoming') >= 0 && W.calls.indexOf('paid 0 q-2') >= 0 && a.state.screen === 'spWaiting',
      JSON.stringify({ calls: W.calls, screen: a.state.screen }));
    const W2 = mk(), b = app(W2, { screen: 'spPayer' });
    b.mintNameOf = a.mintNameOf; b.mintName = a.mintName; b.spMarkPaid = () => W2.calls.push('paid');
    b.spScanToken(1);
    await wait(10);
    check('split: a token for another amount is refused, and stays the payer\'s',
      !W2.calls.some(c => /^receive|^paid/.test(c)) && /is for 2100 sats; this share is 900 sats/.test(b.toasts.join('|')),
      JSON.stringify({ calls: W2.calls, toasts: b.toasts }));
    const W3 = mk({ tokenInfo: () => ({ mint: 'https://mint.there', sats: 2100, unit: 'sat' }) }), c = app(W3, { screen: 'spPayer' });
    c.mintNameOf = a.mintNameOf; c.mintName = a.mintName; c.spMarkPaid = () => W3.calls.push('paid');
    c.spScanToken(0);
    await wait(10);
    check('split: a token from another mint is refused, with what to ask for',
      !W3.calls.some(x => /^receive|^paid/.test(x)) && /from there\. Ask for one from here/.test(c.toasts.join('|')),
      JSON.stringify({ calls: W3.calls, toasts: c.toasts }));
  }
  {
    const W = wallet({ msatOf: () => 2100500 }), a = app(W);
    a.acceptTarget(INVOICE);
    check('an invoice with a fraction of a sat is paid by Lightning, which can carry it', !a.cards.length && a.state.screen === 'sendConfirm', JSON.stringify(a.cards));
  }
  {
    // the watch, away from the token's screen: nothing asked before the first wait; once claimed, a note
    const W = wallet(), a = app(W, { screen: 'home', stack: [] });
    W.claimAnswers.push('waiting', 'claimed');
    const t0 = Date.now();
    a.watchToken(2100, 'token-1', false);
    await wait(15);
    const early = W.calls.filter(c => c.startsWith('ask')).length;
    await wait(140);
    const asks = W.calls.filter(c => c.startsWith('ask')).map(c => Number(c.split(' ')[2]) - t0);
    check('no question before the first wait', early === 0, 'asked ' + early + ' time(s) in 15 ms');
    check('asked again after the wait for its age, then claimed',
      asks.length === 2 && asks[0] >= 28 && asks[1] - asks[0] >= 38, JSON.stringify(asks));
    check('redeemed while elsewhere: a note, no confirmation, settled, forgotten and no longer watched',
      a.announced.length === 0 && /token for 2100 sats was redeemed/.test(a.toasts.join('|'))
        && W.calls.indexOf('settle token-1') >= 0 && W.calls.indexOf('forget token-1') >= 0 && !W.watches.length,
      JSON.stringify({ announced: a.announced, toasts: a.toasts, calls: W.calls, watches: W.watches }));
    clearTimeout(a._claimT);
  }
  {
    // the watch ended while its question was out (the token taken back in): nothing said
    const W = wallet({ tokenClaimState(h) {
      this.calls.push('ask ' + h + ' ' + Date.now());
      W.watches.length = 0;                 // received back into this wallet meanwhile
      return Promise.resolve('claimed');
    } });
    const a = app(W, { screen: 'home', stack: [] });
    a.watchToken(2100, 'token-1', true);
    await wait(40);
    check('a watch that ended while its question was out says nothing', !a.announced.length && !a.toasts.length
      && W.calls.indexOf('settle token-1') < 0, JSON.stringify({ announced: a.announced, toasts: a.toasts, calls: W.calls }));
    clearTimeout(a._claimT);
  }
  {
    // on its own ECASH TOKEN screen: the confirmation
    const W = wallet(), a = app(W, { screen: 'tokenOut', stack: [], tokenOutHash: 'token-1' });
    W.claimAnswers.push('claimed');
    a.watchToken(2100, 'token-1', true);
    await wait(40);
    check('redeemed with its screen open: the payment confirmation', a.announced.length === 1 && !a.toasts.length,
      JSON.stringify({ announced: a.announced, toasts: a.toasts }));
    clearTimeout(a._claimT);
  }
  {
    // no swap: asked within the quick wait
    const W = wallet(), a = app(W, { screen: 'home', stack: [] });
    const t0 = Date.now();
    a.watchToken(2100, 'token-1', true);
    await wait(20);
    const first = W.calls.filter(c => c.startsWith('ask')).map(c => Number(c.split(' ')[2]) - t0)[0];
    check('a token made with no swap is asked about within the quick wait', first != null && first < 20, 'first question at ' + first);
    clearTimeout(a._claimT);
  }
  {
    // Tor not up: asked again soon, not after a long wait
    const W = wallet({ tokenClaimState(h) { this.calls.push('ask ' + h + ' ' + Date.now()); return Promise.resolve(this.calls.filter(c => c.startsWith('ask')).length === 1 ? 'offline' : 'waiting'); } });
    const a = app(W, { screen: 'home', stack: [] });
    a.watchToken(2100, 'token-1', true);
    await wait(30);
    check('a question that could not go out is tried again within seconds', W.calls.filter(c => c.startsWith('ask')).length >= 2, JSON.stringify(W.calls));
    clearTimeout(a._claimT);
  }
  {
    // a watch kept by an older build that was only for its screen
    const W = wallet(), a = app(W, { screen: 'home', stack: [] });
    W.watches.push({ hash: 'token-old', sats: 5, persist: false });
    a.claimWatchTick();
    check('an older screen-only watch is dropped', !W.watches.length, JSON.stringify(W.watches));
    clearTimeout(a._claimT);
  }
  {
    // after a return, the first question waits again
    const W = wallet(), a = app(W, { screen: 'home', stack: [] });
    W.watches.push({ hash: 'token-9', sats: 5, persist: true });
    a._claimNext = { 'token-9': 0 };
    a.claimWatchResume();
    check('a return asks within the quick wait, not at the instant of return', !W.calls.some(c => c.startsWith('ask')), JSON.stringify(W.calls));
    await wait(30);
    check('and does ask within seconds', W.calls.some(c => c.startsWith('ask')), JSON.stringify(W.calls));
    clearTimeout(a._claimT);
  }
  /* The loop must outlive a pass that goes wrong.
   *
   * The token has already left this wallet: this watch is the only thing that
   * turns its history entry green, settles it and clears the text out of the
   * notes. It used to end for the rest of the session if the tick ran before
   * the wallet script was on the page, or if the mint call failed where it
   * stood rather than in a promise — the same shape as the on-chain watcher
   * that stopped asking on a phone (onchain-watch.js). */
  {
    const W = wallet(), a = app(W, { screen: 'home', stack: [] });
    W.watches.push({ hash: 'token-9', sats: 5, persist: true });
    global.window = {};                   // the wallet script has not loaded yet
    a.claimWatchTick();
    check('a tick before the wallet is on the page asks again rather than giving up', !!a._claimT,
      'no timer was left behind');
    clearTimeout(a._claimT);
    global.window = { FoxyWallet: W };
  }
  {
    const W = wallet({ tokenClaimState(h) {
      this.calls.push('ask ' + h);
      throw new Error('no circuit');      // not a rejected promise: thrown where it stands
    } });
    const a = app(W, { screen: 'home', stack: [] });
    a.watchToken(2100, 'token-1', true);
    await wait(120);
    check('a question that fails where it stands does not end the watching',
      W.calls.filter(c => c.startsWith('ask')).length >= 2, JSON.stringify(W.calls));
    clearTimeout(a._claimT);
  }
  {
    const W = wallet(), a = app(W, { screen: 'confirm', stack: ['home'] });
    a.scanTokenToReceive();
    await wait(10);
    check('SCAN on the receive screen takes the token, closes the invoice and lets history say it arrived',
      W.calls.indexOf('closeReceive') >= 0 && W.calls.indexOf('receive cashuBincoming') > W.calls.indexOf('closeReceive')
        && W.calls.indexOf('loadHistory') > W.calls.indexOf('receive cashuBincoming') && a.state.screen === 'home',
      JSON.stringify({ calls: W.calls, screen: a.state.screen }));
  }
  {
    const W = wallet({ scan: () => Promise.resolve('lnbc1notatoken') }), a = app(W, { screen: 'confirm', stack: ['home'] });
    a.scanTokenToReceive();
    await wait(10);
    check('SCAN refuses what is not a token and leaves the invoice open',
      a.toasts[0] === 'That QR is not a Cashu token.' && W.calls.indexOf('closeReceive') < 0, JSON.stringify({ toasts: a.toasts, calls: W.calls }));
  }

  results.forEach(r => console.log(r));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(failed ? failed + ' pay-this-mint check(s) failed' : 'all pay-this-mint checks pass');
  process.exit(failed ? 1 : 0);
})();
