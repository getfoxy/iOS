'use strict';
/* mint-remove.js — removing a mint from the list, its balance moved first.
 *
 *     node tests/mint-remove.js
 *
 * The keeper's words (2026-11-07): a pencil at the top right of SWITCH MINT turns on a bin by each mint; a bin on a mint with
 * money asks where it goes (TRANSFER's "to" step), then TRANSFER's confirmation with the fee, then the mint is removed. With
 * nothing there, one line (REMOVE <MINT>?). And: what cannot be moved (change the fee hands back, a balance under the fee)
 * does not hold the mint on the list; it stays in its pile at that mint, said with its figure, until the mint is added again.
 *
 *   1  edit mode: the pencil, the tick, a bin on each tile, a tile that switches nothing, the screen left leaves it
 *   2  a mint with nothing: REMOVE?, removed, hidden, and the shipped mint re-added only through the gate
 *   3  a mint with sats, the one the phone is on: TO WHICH MINT?, the quote for all of it, the confirmation, the move, the mint
 *      removed, the phone at the mint the money went to, the change left there named, the books adding up
 *   4  a move that fails removes nothing
 *   5  both balances: the sats and then the dollars, one confirmation each, then removed; not the mint the phone is on, which
 *      it goes back to
 *   6  a balance too small to move: no transfer, the one line naming what stays; removed with it kept
 *   7  the refusals, each: the only mint, an unpaid invoice, a token sent and not claimed, a card's load, a transfer in flight,
 *      a till open at it, a cashier code that names it, something else moving money; nothing removed
 *   8  HISTORY's mint list keeps a removed mint, greyed, REMOVED, with what is left there; a restore from words brings it back
 *
 * The real wallet (Web/foxy-wallet.js through tests/flashcard-kit.js) against two fake mints; the screens' methods lifted out
 * of build/foxy-app.js, as tests/transfer-dollars.js and tests/mint-gate.js lift them. Run `python3 tools/join-sources.py`
 * first. */
const fs = require('fs');
const path = require('path');
const { page, MINT, MINT2, MINT3 } = require('./flashcard-kit');

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 300; i++) await wait(0); await wait(40); };

const src = fs.readFileSync(process.env.FOXY_APP || path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function method(name) {
  const m = new RegExp('\\n  ' + name + '\\([^)]*\\) \\{').exec(src);
  if (!m) return '';
  let i = src.indexOf('{', m.index + 3), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
  return src.slice(m.index + 3, i + 1);
}
const NAMES = ['mrEditToggle', 'mrBack', 'mrHeld', 'mrName', 'mrSame', 'mrRefusal', 'mrRefuse', 'mrTrash', 'mrNextMint', 'mrOnIt',
  'mrAskEmpty', 'mrRemoveNow', 'mrDrop', 'mrMoveStart', 'mrPickTo', 'mrQuoteShort', 'mrDust', 'mrLeftText', 'mrRemoveLeaving',
  'mrMoved', 'mrFinish', 'mrRemovedMints', 'mrConfirmLine',
  'trHeldAt', 'trPick', 'trPickTo', 'quoteTransfer', 'trMoveLess', 'runTransfer', 'trCancel', 'transferSpec', 'transferSpecUsd',
  'trLook', 'mintOnPhone', 'mintGate', 'connectBack', 'homeAgain', 'moneyBusy', 'allMints', 'goSwitchMint', 'back', 'renderMints',
  'onMint', 'scanCandidate', 'mintTileTap', 'mrWhenFree', 'mrSentLine', 'mrAddTo', 'mrUndoAdd', 'mrQuoted', 'mrNextLeg', 'pfPiles', 'pfMint', 'otherUnitsLine',
  'shortMintName', 'mintKnownName'];
const missing = NAMES.filter((n) => !method(n));
const lifted = new Function('return {' + NAMES.map(method).filter(Boolean).join(',\n') + '}')();

const SHIPPED = MINT2;   // the second mint is one of the app's shipped mints here
const RATE = 76900;      // the fake mints' dollar price (usd per bitcoin)

function app(R, o) {
  const W = R.W;
  global.window = { FoxyWallet: W };
  const a = Object.assign({}, lifted, {
    state: { screen: 'switchMint', stack: ['home'] },
    toasts: [], cards: [], announced: [], pads: [],
    setState(u, cb) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); if (cb) cb(); },
    toast(m) { this.toasts.push(m); },
    blockedCard(kind, spec) { this.cards.push(Object.assign({ kind }, spec)); },
    lockAsk(go, why, gaveUp) { this.pads.push(why); if (this.padSays === false) { if (gaveUp) gaveUp(); return; } go(); },
    refuseSwitchWhileBusy() { const b = this.moneyBusy(); if (b) this.toast('busy'); return b; },
    DEFAULT_MINTS: [{ url: SHIPPED, name: 'Shipped', host: 'n.test', tint: '#000' }],
    MELT_PATIENCE_MS: 1000,
    mintPile(url) {
      const raw = R.storage.getItem('foxy.cashu.proofs.' + url);
      const sats = raw ? JSON.parse(raw).reduce((n, p) => n + Number(p.amount || 0), 0) : 0;
      const units = W.balances().filter((b) => b.unit !== 'sat' && String(b.mint).replace(/\/+$/, '') === String(url).replace(/\/+$/, ''));
      return { sats, units, text: sats + ' sats', ink: '' };
    },
    mintNameOf: (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\.test.*$/, ''),
    money: (n) => ({ main: '₿ ' + n, sub: '' }),
    unitFigure: (n, u) => (u === 'usd' ? '$' + (n / 100).toFixed(2) : '₿ ' + n),
    cfRow: (label, value) => ({ label, value }),
    group: (n) => String(n), usd: (v) => Number(v).toFixed(2), unitMoney: (n, u) => u + ' ' + n,
    px: () => RATE, satUsd: () => RATE / 1e8,
    mintHost() { return W.mintHost(); }, mintDownText: () => '', mintReachable: () => true, histShown: () => ({ mint: '' }),
    showMelt() {}, hideMelt() {}, refreshBalance() {}, loadHistory() {}, walletReady() {},
    announcePayment(ev) { this.announced.push(ev); this.state.screen = 'paid'; },
    justSwitch(u) { this.switched = u; W.connect(u).catch(() => {}); },
    forgetRestoreCandidates() {}, scanSeedRows() { this.scanned = this.allMints().map((m) => m.url); },
  }, o || {});
  return a;
}
const piles = (R, url) => ({
  sat: (JSON.parse(R.storage.getItem('foxy.cashu.proofs.' + url) || '[]') || []).reduce((n, p) => n + Number(p.amount || 0), 0),
  usd: R.W.balanceOf('usd', url),
});
const onList = (a, url) => a.allMints().some((m) => a.mrSame(m.url, url));
const lastCard = (a) => a.cards[a.cards.length - 1] || {};

async function funded(o) {
  const R = page(Object.assign({ second: true, units: ['sat', 'usd'] }, o || {}));
  const W = R.W;
  await W.connect(MINT2, null, null, { remember: true });
  await W.connect(MINT, null, null, { remember: true });
  return R;
}

async function run() {
  ok(!missing.length, 'the screens have every method this needs', 'missing: ' + missing.join(', '));
  if (missing.length) return finish();

  // ---- 1 --------------------------------------------------------------------------------------------------------------
  console.log('1. edit mode');
  {
    const R = await funded();
    const a = app(R);
    let v = a.renderMints({ s: a.state, sc: 'switchMint' });
    ok(v.mintEditShown && v.mintEditOff && !v.mintEditOn && v.mintRows.every((r) => !r.trash), 'SWITCH MINT: the pencil at the top right, no bins',
      JSON.stringify({ shown: v.mintEditShown, off: v.mintEditOff }));
    const title = v.mintTitle;
    a.mrEditToggle();
    v = a.renderMints({ s: a.state, sc: 'switchMint' });
    ok(v.mintEditOn && !v.mintEditOff && v.mintRows.length === 2 && v.mintRows.every((r) => r.trash), 'the pencil: a tick, and a bin on every tile');
    ok(v.mintTitle === title, 'the title is the list’s own in edit mode', v.mintTitle);
    const there = v.mintRows.find((r) => !r.here);
    there.tap();
    ok(!a.switched, 'a tile tapped in edit mode switches nothing');
    a.mrEditToggle();
    v = a.renderMints({ s: a.state, sc: 'switchMint' });
    ok(!v.mintEditOn && v.mintRows.every((r) => !r.trash), 'the tick leaves edit mode');
    v.mintRows.find((r) => !r.here).tap();
    await settle();
    ok(a.switched === SHIPPED, 'and a tile switches again', String(a.switched));
    a.switched = null;
    a.mrEditToggle();
    a.back();
    ok(!a.state.mrEdit, 'leaving the screen leaves edit mode');
    a.goSwitchMint();
    ok(!a.state.mrEdit, 'and the list opens out of it');
    // not offered on the list's other jobs
    a.state.trStep = 'from';
    v = a.renderMints({ s: a.state, sc: 'switchMint' });
    ok(!v.mintEditShown, 'no pencil on TRANSFER’s FROM WHICH MINT?');
    a.state.trStep = '';
    a.state.histPick = true;
    v = a.renderMints({ s: a.state, sc: 'switchMint' });
    ok(!v.mintEditShown, 'nor on HISTORY’s');
  }

  // ---- 2 --------------------------------------------------------------------------------------------------------------
  console.log('\n2. a mint with nothing, a shipped one');
  {
    const R = await funded();
    const W = R.W;
    const a = app(R);
    a.state.mrEdit = true;
    ok(onList(a, SHIPPED) && a.mintOnPhone(SHIPPED), 'set up: the shipped mint on the list, on the phone');
    a.mrTrash(SHIPPED);
    const c = lastCard(a);
    ok(c.kind === 'mintRemove' && /^REMOVE N\?$/.test(c.title) && c.retry === 'REMOVE' && c.shut && c.shut.label === 'CANCEL',
      'its bin asks one line: REMOVE <MINT>?', JSON.stringify({ t: c.title, r: c.retry }));
    c.go();
    await settle();
    ok(!onList(a, SHIPPED) && W.mintHidden(SHIPPED) && !W.mintChosen(SHIPPED), 'REMOVE: off the list, hidden, not chosen',
      JSON.stringify({ list: a.allMints().map((m) => m.url), hidden: W.mintsHidden() }));
    ok(!a.mintOnPhone(SHIPPED), 'a removed shipped mint is no longer the phone’s');
    ok(W.mintUrl === MINT && a.toasts.some((t) => /off your list/.test(t)), 'the phone stays where it was, and is told', JSON.stringify(a.toasts));
    // added again: the gate asks, as for any mint, and it is back
    W.pinIsSet = () => true; W.faceLock = () => false; W.screenLocked = () => true;
    a.padSays = false;
    a.mintTileTap(SHIPPED);
    ok(a.pads.length === 1 && !onList(a, SHIPPED), 'ADD A MINT with it: the lock asks, and given up nothing is added', JSON.stringify(a.pads));
    a.padSays = true;
    a.mintTileTap(SHIPPED);
    ok(a.pads.length === 2 && onList(a, SHIPPED) && !W.mintHidden(SHIPPED) && a.mintOnPhone(SHIPPED) && a.switched === SHIPPED,
      'passed: on the list again, chosen, and switched to', JSON.stringify({ pads: a.pads.length, hidden: W.mintsHidden() }));
  }

  // ---- 3 --------------------------------------------------------------------------------------------------------------
  console.log('\n3. a mint with sats, the one the phone is on');
  {
    const R = await funded();
    const W = R.W;
    await W.claim((await W.invoice(3000, '')).hash);
    const before = piles(R, MINT).sat + piles(R, MINT2).sat;
    ok(piles(R, MINT).sat === 3000 && W.mintUrl === MINT, 'set up: 3,000 sats at m, the phone on it');
    const a = app(R);
    a.state.mrEdit = true;
    a.mrTrash(MINT);
    let v = a.renderMints({ s: a.state, sc: 'switchMint' });
    ok(a.state.screen === 'switchMint' && a.state.trStep === 'to' && a.state.mrMint === MINT && v.mintTitle === 'TO WHICH MINT?',
      'its bin: TO WHICH MINT?', JSON.stringify({ sc: a.state.screen, t: v.mintTitle }));
    ok(v.mintRows.length === 1 && v.mintRows[0].name === 'Shipped' && v.mintPickers && !v.mintEditShown,
      'listing the other mints, with ADD A MINT, and no pencil', JSON.stringify(v.mintRows.map((r) => r.name)));
    ok(/Everything at m moves/.test(v.mintNowLine), 'saying all of it moves first', v.mintNowLine);
    // back from the question: edit mode again, nothing moved
    a.back();
    ok(a.state.screen === 'switchMint' && !a.state.mrMint && a.state.mrEdit && !a.state.trStep, 'back: the list in edit mode, nothing removed');
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    ok(a.state.screen === 'trConfirm' && !!a.state.trPlan && a.state.trSats > 0 && a.state.trSats < 3000,
      'a mint picked: TRANSFER’s confirmation, quoted for all that the fee leaves room for', JSON.stringify({ sc: a.state.screen, sats: a.state.trSats, err: a.state.trErr }));
    const spec = a.transferSpec();
    ok(/TRANSFER/.test(spec.cta) && !spec.ctaBusy && /leaves your list/.test(spec.subtitle) && /stays at m until you add it again/.test(spec.subtitle),
      'the confirmation: the fee, TRANSFER, and the words for the removal and the change', JSON.stringify({ cta: spec.cta, sub: spec.subtitle }));
    ok(onList(a, MINT), 'nothing removed before it is pressed');
    const quotedFee = Number(a.state.trFee);
    spec.go();
    await settle(); await settle();
    const left = piles(R, MINT).sat;
    // the change is quoted again, proved under the fee, and the one line asks (the review's M1)
    const ask = lastCard(a);
    ok(onList(a, MINT) && ask.kind === 'mintRemove' && ask.reason.indexOf('₿ ' + left + ' stays at M until you add it again. It is less than the fee to move it.') === 0,
      'landed: the change quoted again, too little to move, and the one line asks with its figure', JSON.stringify({ left, r: ask.reason }));
    ask.go();
    await settle();
    ok(!onList(a, MINT) && W.mintHidden(MINT), 'REMOVE: m is off the list', JSON.stringify(a.allMints().map((m) => m.url)));
    ok(W.mintUrl === MINT2 && (W.saved() || {}).url === MINT2, 'the phone is at the mint the money went to, saved there', W.mintUrl);
    const notice = a.cards.find((c) => c.kind === 'mintRemoved');
    ok(left > 0 && !!notice && notice.reason.indexOf('₿ ' + left + ' stays at M until you add it again') === 0,
      'the change the fee handed back stays at m, said with its figure', JSON.stringify({ left, notice: notice && notice.reason }));
    const after = piles(R, MINT).sat + piles(R, MINT2).sat;
    const fee = before - after;
    // (the fake mint's route costs 2 sats of the reserve; the rest of the reserve came back as the change left at m)
    ok(fee === 2 && fee <= quotedFee, 'the books add up: what is on the phone is what was, less the route’s fee',
      JSON.stringify({ before, after, fee, quoted: quotedFee }));
    const hist = await W.transactions(50);
    const out = hist.filter((t) => t.dir === 'out' && String(t.mint || '').replace(/\/+$/, '') === MINT);
    ok(out.length >= 1, 'and the move is in m’s history, which stays', JSON.stringify(hist.map((t) => [t.dir, t.mint, t.sats])));
    ok(piles(R, MINT).sat === left && W.balanceOf('sat', MINT) === left, 'and m’s pile is untouched, still counted at m', String(left));
    // added again: its pile on the list as it was
    a.mintTileTap(MINT);
    await settle();
    ok(onList(a, MINT) && a.mrHeld(MINT).sat === left, 'added again: on the list with what was left there', String(a.mrHeld(MINT).sat));
  }

  // ---- 4 --------------------------------------------------------------------------------------------------------------
  console.log('\n4. a move that fails');
  {
    const R = await funded();
    const W = R.W;
    await W.claim((await W.invoice(3000, '')).hash);
    const a = app(R);
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    R.fate = (m) => (/\/v1\/melt\/bolt11$/.test(new URL(m.url).pathname) && new URL(m.url).origin === MINT
      ? '400\n' + JSON.stringify({ detail: 'the payment could not be routed', code: 20000 }) : null);
    a.transferSpec().go();
    await settle(); await settle();
    ok(onList(a, MINT) && !W.mintHidden(MINT) && W.mintChosen(MINT), 'nothing is removed', JSON.stringify(a.allMints().map((m) => m.url)));
    ok(piles(R, MINT).sat === 3000 && !a.cards.some((c) => c.kind === 'mintRemoved'), 'the money is where it was, and no notice', String(piles(R, MINT).sat));
    ok(!!a.state.trErr, 'the confirmation says why', a.state.trErr);
    const sp = a.transferSpec();
    // the review's H1: a refused move offers no way to remove it; CANCEL, as TRANSFER has
    ok(sp.secondary && sp.secondary.label === 'CANCEL' && !/REMOVE/.test(JSON.stringify(sp)), 'and offers CANCEL only, nothing about removing', JSON.stringify(sp.secondary));
    ok(!a.cards.some((c) => c.kind === 'mintRemove'), 'and no question to remove it');
    R.fate = null;
    a.trCancel();
    ok(!a.state.mrMint && onList(a, MINT), 'CANCEL: the removal is dropped');
  }

  // ---- 5 --------------------------------------------------------------------------------------------------------------
  console.log('\n5. both balances, at a mint the phone is not on');
  {
    const R = await funded({ mintOpts: { satFeeReserve: 0, usdFeeReserve: 0 } });
    const W = R.W;
    await W.claim((await W.invoice(2000, '', { unit: 'usd' })).hash);
    await W.claim((await W.invoice(5000, '')).hash);
    await W.connect(MINT2, null, null, { remember: true });
    const a = app(R);
    ok(piles(R, MINT).sat === 5000 && piles(R, MINT).usd === 2000 && W.mintUrl === MINT2, 'set up: 5,000 sats and $20.00 at m, the phone on n');
    a.mrTrash(MINT);
    ok(a.state.trUnit === 'sat', 'the sats first');
    a.trPick(MINT2);
    await settle();
    let spec = a.transferSpec();
    ok(/Its dollars move next/.test(spec.subtitle), 'its confirmation says the dollars move next', spec.subtitle);
    spec.go();
    await settle(); await settle(); await wait(600); await settle();
    ok(onList(a, MINT) && a.state.screen === 'trConfirm' && a.state.trUnit === 'usd', 'the sats landed: the dollars’ confirmation, m still on the list',
      JSON.stringify({ sc: a.state.screen, u: a.state.trUnit, err: a.state.trErr }));
    await settle();
    spec = a.transferSpec();
    ok(/DOLLARS/.test(JSON.stringify(spec.rows)) && /TRANSFER \$/.test(spec.cta), 'in dollars, with its own fee', JSON.stringify({ cta: spec.cta, err: a.state.trErr }));
    spec.go();
    await settle(); await settle();
    const left = piles(R, MINT);
    ok(!onList(a, MINT) && W.mintHidden(MINT), 'both landed: m is off the list', JSON.stringify({ left, err: a.state.trErr }));
    ok(left.sat < 50 && left.usd < 50, 'next to nothing is left at m', JSON.stringify(left));
    ok(W.mintUrl === MINT2, 'the phone back on n, where it was', W.mintUrl);
    ok(a.announced.length === 2, 'two moves, two confirmations', String(a.announced.length));
  }

  // ---- 6 --------------------------------------------------------------------------------------------------------------
  console.log('\n6. too little to move');
  {
    const R = await funded();
    const W = R.W;
    await W.claim((await W.invoice(9, '')).hash);
    const a = app(R);
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    const c = lastCard(a);
    ok(c.kind === 'mintRemove' && /^REMOVE M\?$/.test(c.title) && /₿ 9 stays at M until you add it again/.test(c.reason),
      'the fee is more than it holds: no transfer, the one line names what stays', JSON.stringify({ t: c.title, r: c.reason }));
    ok(!a.announced.length && piles(R, MINT).sat === 9, 'nothing moved');
    c.go();
    await settle();
    ok(!onList(a, MINT) && piles(R, MINT).sat === 9 && W.mintUrl === MINT2, 'REMOVE: off the list, the 9 sats kept at m, the phone on n',
      JSON.stringify({ list: a.allMints().map((m) => m.url), at: W.mintUrl }));
  }

  // ---- 7 --------------------------------------------------------------------------------------------------------------
  console.log('\n7. the refusals');
  {
    const R = await funded();
    const W = R.W;
    await W.claim((await W.invoice(3000, '')).hash);
    const refused = (a, words, name) => {
      const n = a.cards.length;
      a.mrTrash(MINT);
      const c = a.cards[a.cards.length - 1] || {};
      ok(a.cards.length === n + 1 && c.title === 'NOT REMOVED' && words.test(c.reason) && onList(a, MINT) && !a.state.mrMint,
        name, JSON.stringify(c.reason));
    };
    const put = (k, v) => R.storage.setItem(k, JSON.stringify(v));
    const clear = (k) => R.storage.removeItem(k);
    {
      const a = app(R, { DEFAULT_MINTS: [] });
      W.forgetMintFromList(MINT2);
      refused(a, /only mint on your list/, 'the only mint on the list');
      W.chooseMint(MINT2);
      await W.connect(MINT2, null, null, { remember: true });
      await W.connect(MINT, null, null, { remember: true });
    }
    const a = app(R);
    ok(onList(a, MINT2), 'set up: two mints again');
    put('foxy.cashu.quotes', [{ quote: 'q1', amount: 10, mint: MINT, expiry: Math.floor(Date.now() / 1000) + 600 }]);
    refused(a, /invoice there is not paid or collected/, 'an invoice asked for and not paid');
    put('foxy.cashu.quotes', [{ quote: 'q1', amount: 10, mint: MINT, expiry: Math.floor(Date.now() / 1000) - 600 }]);
    a.mrTrash(MINT);
    ok(a.state.mrMint === MINT, 'an invoice that has expired unpaid holds nothing');
    a.trCancel(); clear('foxy.cashu.quotes');
    const sent = await W.sendToken(100, { unit: 'sat' });
    await settle();
    // a token sent and not claimed lets the removal through (the keeper's answer), and its confirmation names it
    a.mrTrash(MINT);
    ok(a.state.mrMint === MINT && a.state.trStep === 'to', 'a token sent from there and not claimed does not refuse it',
      JSON.stringify((a.cards[a.cards.length - 1] || {}).reason));
    ok(a.mrConfirmLine().indexOf('A token of ₿ 100 you sent is still unclaimed; it stays on its note.') >= 0,
      'the confirmation names it, with its figure', a.mrConfirmLine());
    a.trCancel();
    const meta = JSON.parse(R.storage.getItem('foxy.txmeta') || '{}');
    const h = Object.keys(meta).find((k) => meta[k] && meta[k].token);
    meta[h].to = 'card';
    put('foxy.txmeta', meta);
    clear('foxy.cashu.token.watch'); clear('foxy.cashu.outtoken');
    refused(a, /card holds money loaded from there/, 'a card’s load whose pieces are there');
    delete meta[h].token; put('foxy.txmeta', meta);
    put('foxy.cashu.move', [{ quote: 'mv1', from: MINT, to: MINT2, at: Date.now() }]);
    refused(a, /transfer from or to it is still in flight/, 'a transfer in flight');
    clear('foxy.cashu.move');
    put('foxy.till.keeper', { mints: [MINT], def: MINT });
    refused(a, /till is open at it/, 'a till open at it');
    clear('foxy.till.keeper');
    put('foxy.till.passes', [{ id: 'c1', mint: MINT, exp: Math.floor(Date.now() / 1000) + 3600 }]);
    refused(a, /cashier code names it/, 'a cashier code that names it, while the code lives');
    put('foxy.till.passes', [{ id: 'c1', mint: MINT, exp: Math.floor(Date.now() / 1000) - 60 }]);
    a.mrTrash(MINT);
    ok(a.state.mrMint === MINT, 'a code that has ended holds nothing');
    a.trCancel(); clear('foxy.till.passes');
    a._sendRun = true;
    refused(a, /moving money right now/, 'something else moving money');
    a._sendRun = false;
    ok(onList(a, MINT) && !W.mintHidden(MINT) && W.mintChosen(MINT) && piles(R, MINT).sat > 0, 'after every refusal, nothing removed and nothing moved');
    ok(!!sent, 'set up: the token was made');
  }

  // ---- 7b -------------------------------------------------------------------------------------------------------------
  console.log('\n7b. ADD A MINT on TO WHICH MINT? is the destination; a sent token goes with the removal');
  {
    const R = await funded();
    const W = R.W;
    await W.connect(MINT2, null, null, { remember: true });
    await W.claim((await W.invoice(3000, '')).hash);
    const sent = await W.sendToken(200, { unit: 'sat' });
    await settle();
    W.removeMint(MINT);
    const SPARE = 'https://spare.example';
    const a = app(R, { DEFAULT_MINTS: [{ url: MINT2, name: 'Shipped', host: 'n.test', tint: '#000' }, { url: SPARE, name: 'Spare', host: 'spare.example', tint: '#000' }] });
    ok(!onList(a, MINT) && onList(a, MINT2) && piles(R, MINT2).sat === 2800 && !!sent, 'set up: 2,800 sats at n, a 200-sat token sent from it, m not on the list');
    a.mrTrash(MINT2);
    ok(a.state.mrMint === MINT2 && a.state.trStep === 'to', 'its bin: TO WHICH MINT? (the unclaimed token holds nothing)');
    const v = a.renderMints({ s: a.state, sc: 'switchMint' });
    ok(v.mintPickers, 'with ADD A MINT');
    // the sheet's ADD (08-mint-entry-and-notes.js) calls justSwitch with the address typed
    const justSwitch = new Function('return {' + method('justSwitch') + '}')().justSwitch;
    justSwitch.call(a, MINT + '/');
    await settle();
    ok(a.state.screen === 'trConfirm' && a.state.trTo === MINT && !!a.state.trPlan && !a.switched,
      'ADD: no switch; the confirmation, the mint added the destination', JSON.stringify({ sc: a.state.screen, to: a.state.trTo, err: a.state.trErr }));
    ok(W.mintChosen(MINT) && !W.mintHidden(MINT), 'the mint added is chosen and on the list again');
    a.transferSpec().go();
    await settle(); await settle();
    ok(/A token of ₿ 200 you sent is still unclaimed/.test(lastCard(a).reason || ''), 'the one line names the token', lastCard(a).reason);
    lastCard(a).go();
    await settle();
    ok(!onList(a, MINT2) && onList(a, MINT) && piles(R, MINT).sat > 2700, 'the money landed at the mint added, and n is removed',
      JSON.stringify({ m: piles(R, MINT), n: piles(R, MINT2) }));
    const notice = a.cards.find((c) => c.kind === 'mintRemoved');
    ok(!!notice && /A token of ₿ 200 you sent is still unclaimed; it stays on its note\./.test(notice.reason), 'the notice names the token', notice && notice.reason);
    const meta = JSON.parse(R.storage.getItem('foxy.txmeta') || '{}');
    ok(Object.keys(meta).some((h) => meta[h] && meta[h].token === sent.token), 'and the token is still on its note');
  }

  // ---- 8 --------------------------------------------------------------------------------------------------------------
  console.log('\n8. HISTORY, and a restore from words');
  {
    const R = await funded();
    const W = R.W;
    await W.claim((await W.invoice(9, '')).hash);
    const a = app(R);
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    lastCard(a).go();
    await settle();
    ok(!onList(a, MINT), 'set up: m removed with 9 sats left there');
    a.goSwitchMint({ histPick: true });
    const v = a.renderMints({ s: a.state, sc: 'switchMint' });
    const row = v.mintRows.find((r) => /^REMOVED/.test(r.host));
    ok(!!row && row.dim === '0.55' && /9/.test(row.balMain), 'HISTORY’s mint list keeps it, greyed, REMOVED, with the 9 sats', JSON.stringify(row && { host: row.host, bal: row.balMain }));
    ok(v.mintRows.length === 2, 'after the mints on the list', String(v.mintRows.length));
    // the shipped one too, then words: both back
    a.state.mrEdit = true; a.state.histPick = false;
    a.mrTrash(SHIPPED);
    await settle();
    ok(W.mintsHidden().length === 1, 'the only other mint cannot go: refused', JSON.stringify(W.mintsHidden()));
    a.scanCandidate('candidate');
    ok(W.mintsHidden().length === 0 && onList(a, MINT) && a.scanned.indexOf(MINT) >= 0, 'a restore from words: every removed mint back on the list and scanned',
      JSON.stringify(a.scanned));
  }
  // ---- 9 --------------------------------------------------------------------------------------------------------------
  console.log('\n9. the review’s probes');
  // P1: a reserve of 1% of a large pile: the change is moved again while it fits; what stays is less than the fee
  {
    const R = await funded({ mintOpts: { satFeeReservePpk: 10 } });
    const W = R.W;
    await W.claim((await W.invoice(100000, '')).hash);
    const a = app(R);
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    let moves = 0;
    for (let i = 0; i < 4 && a.state.screen === 'trConfirm' && a.state.trPlan; i++) {
      if (i > 0) ok(/came back as change/.test(a.transferSpec().subtitle), 'move ' + (i + 1) + '’s confirmation says what came back as change', a.transferSpec().subtitle);
      a.transferSpec().go(); moves += 1;
      await settle(); await settle(); await wait(300); await settle();
    }
    const left = piles(R, MINT).sat;
    const c = lastCard(a);
    ok(moves >= 2 && moves <= 3, 'P1: the change was moved again, three moves at most', String(moves));
    ok(left < 20 && (left === 0 ? c.kind !== 'mintRemove' : (c.kind === 'mintRemove' && /less than the fee to move it/.test(c.reason))),
      'P1: what stays is dust (or nothing), and where something stays the one line says so',
      JSON.stringify({ left, moves, r: c.reason }));
    if (c.go) c.go();
    await settle();
    ok(!onList(a, MINT) && piles(R, MINT).sat === left, 'P1: then removed, the dust kept at m');
  }
  // P3: dollars, the phone's price off the mint's either way: sized at the mint's own rate, no more than dust stays
  for (const off of [1.03, 0.97]) {
    const R = await funded();
    const W = R.W;
    await W.claim((await W.invoice(10000, '', { unit: 'usd' })).hash);
    const a = app(R, { px: () => RATE * off });
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    for (let i = 0; i < 4 && a.state.screen === 'trConfirm' && a.state.trPlan; i++) {
      a.transferSpec().go();
      await settle(); await settle(); await wait(300); await settle();
    }
    const left = piles(R, MINT).usd;
    ok(left <= 5, 'P3: $100.00 at m, the phone’s price ' + (off > 1 ? '3% over' : '3% under') + ' the mint’s: no more than 5 cents stays', String(left));
    const c = lastCard(a);
    if (c.kind === 'mintRemove' && c.go) { c.go(); await settle(); }
    ok(!onList(a, MINT), 'P3: and m is removed', JSON.stringify({ left, card: c.title, err: a.state.trErr }));
  }
  // P2: a refusal written between the question and REMOVE stops it
  {
    const R = await funded();
    const W = R.W;
    await W.claim((await W.invoice(9, '')).hash);
    const a = app(R);
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    const c = lastCard(a);
    ok(c.kind === 'mintRemove' && c.go, 'P2: set up: the one line for 9 sats');
    R.storage.setItem('foxy.cashu.quotes', JSON.stringify([{ quote: 'late', amount: 5, mint: MINT, expiry: Math.floor(Date.now() / 1000) + 600 }]));
    c.go();
    await settle(); await wait(300); await settle();
    const r = lastCard(a);
    ok(onList(a, MINT) && !W.mintHidden(MINT) && r.title === 'NOT REMOVED' && /invoice there/.test(r.reason),
      'P2: an invoice made meanwhile: NOT REMOVED, still on the list', JSON.stringify({ t: r.title, r: r.reason }));
  }
  // P4 (L1): back from the removal's confirmation is TO WHICH MINT? again, whose tiles are destinations
  {
    const R = await funded();
    const W = R.W;
    await W.claim((await W.invoice(3000, '')).hash);
    const a = app(R);
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    a.back();
    await settle();
    const v = a.renderMints({ s: a.state, sc: 'switchMint' });
    ok(a.state.screen === 'switchMint' && a.state.trStep === 'to' && a.state.mrMint === MINT && v.mintTitle === 'TO WHICH MINT?',
      'P4: back from the confirmation: TO WHICH MINT? again', JSON.stringify({ sc: a.state.screen, st: a.state.trStep }));
    v.mintRows[0].tap();
    await settle();
    ok(!a.switched && a.state.screen === 'trConfirm' && a.state.trTo === MINT2, 'P4: a tile there is the destination, not a switch',
      JSON.stringify({ sw: a.switched, sc: a.state.screen }));
    a.trCancel();
    ok(!a.state.mrMint && onList(a, MINT), 'P4: CANCEL ends it, nothing removed');
  }
  // the leftover on answer 1: a mint added for a removal that is dropped is not left chosen
  {
    const R = await funded();
    const W = R.W;
    await W.connect(MINT2, null, null, { remember: true });
    await W.claim((await W.invoice(3000, '')).hash);
    W.removeMint(MINT);
    const a = app(R, { DEFAULT_MINTS: [{ url: MINT2, name: 'Shipped', host: 'n.test', tint: '#000' }, { url: 'https://spare.example', name: 'Spare', host: 'spare.example', tint: '#000' }] });
    const justSwitch = new Function('return {' + method('justSwitch') + '}')().justSwitch;
    for (const how of ['CANCEL', 'back']) {
      a.mrTrash(MINT2);
      justSwitch.call(a, MINT);
      await settle();
      ok(a.state.screen === 'trConfirm' && W.mintChosen(MINT), 'set up (' + how + '): m added as the destination, chosen');
      if (how === 'CANCEL') a.transferSpec().secondary.go(); else { a.back(); a.back(); }
      await settle(); await settle();
      ok(!W.mintChosen(MINT) && !onList(a, MINT) && W.mintHidden(MINT), how + ': m let go again, not chosen, hidden as before',
        JSON.stringify({ chosen: W.mintChosen(MINT), list: a.allMints().map((m) => m.url) }));
    }
  }
  // P5, P6, P8 (M3): a visit leaves a removed mint hidden; PAY FROM and the dollars line leave its pile out; a take-back
  // landing there shows it again, not the phone's own until chosen
  {
    const R = await funded({ units2: ['sat', 'usd'] });
    const W = R.W;
    await W.connect(MINT2, null, null, { remember: true });
    await W.claim((await W.invoice(3000, '')).hash);
    await W.claim((await W.invoice(500, '', { unit: 'usd' })).hash);
    const sent = await W.sendToken(200, { unit: 'sat' });
    await settle();
    await W.connect(MINT, null, null, { remember: true });
    W.removeMint(MINT2);
    const a = app(R, { DEFAULT_MINTS: [{ url: MINT2, name: 'Shipped', host: 'n.test', tint: '#000' }, { url: 'https://spare.example', name: 'Spare', host: 'spare.example', tint: '#000' }] });
    ok(W.mintHidden(MINT2) && !a.mintOnPhone(MINT2), 'set up: the shipped mint n removed with ₿ 2,800 and $5.00 on it');
    await W.connect(MINT2, null, null, { remember: false });
    await W.connect(MINT, null, null, { remember: true });
    ok(W.mintHidden(MINT2) && !onList(a, MINT2) && !a.mintOnPhone(MINT2), 'P5: a visit leaves it hidden, off the list, not the phone’s',
      JSON.stringify({ hidden: W.mintHidden(MINT2), list: a.allMints().map((m) => m.url) }));
    ok(!a.pfPiles().some((p) => a.mrSame(p.mint, MINT2)), 'P6: PAY FROM does not offer its pile', JSON.stringify(a.pfPiles()));
    a.unitLabel = (u) => String(u).toUpperCase();
    ok(!/n\.test/.test(a.otherUnitsLine()), 'P6: nor does the line of other balances name its dollars', a.otherUnitsLine());
    const before = piles(R, MINT2).sat;
    await W.reclaimToken(sent.token);
    await settle();
    ok(piles(R, MINT2).sat > before && !W.mintHidden(MINT2) && onList(a, MINT2), 'P8: a take-back landing at it: the money there, and it shows again',
      JSON.stringify({ before, now: piles(R, MINT2).sat, hidden: W.mintHidden(MINT2) }));
    ok(!a.mintOnPhone(MINT2) && W.mintReturned(MINT2), 'P8: and, shipped as it is, it is not the phone’s own until chosen through the gate');
    W.pinIsSet = () => true; W.faceLock = () => false; W.screenLocked = () => true;
    a.mintTileTap(MINT2);
    ok(a.pads.length === 1 && a.mintOnPhone(MINT2) && !W.mintReturned(MINT2), 'P8: its tile asks the lock, and passed it is the phone’s again', String(a.pads.length));
  }
  // ---- 10 -------------------------------------------------------------------------------------------------------------
  console.log('\n10. the review’s second round');
  // F1 (P16): a sats quote that fails for any reason but the fee proves nothing: TRANSFER's error, CANCEL, nothing removed
  for (const [label, hit] of [['the far mint’s invoice fails (500)', (u) => u.origin === MINT2 && /\/v1\/mint\/quote\/bolt11$/.test(u.pathname)],
    ['m’s melt quote fails (500)', (u) => u.origin === MINT && /\/v1\/melt\/quote\/bolt11$/.test(u.pathname)]]) {
    const R = await funded();
    const W = R.W;
    await W.claim((await W.invoice(30000, '')).hash);
    const a = app(R);
    R.fate = (m) => (hit(new URL(m.url)) ? '500\n' + JSON.stringify({ detail: 'lightning backend unavailable', code: 0 }) : null);
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    R.fate = null;
    const sp = a.state.screen === 'trConfirm' ? a.transferSpec() : {};
    ok(a.state.screen === 'trConfirm' && !!a.state.trErr && !a.cards.some((c) => c.kind === 'mintRemove')
      && sp.secondary && sp.secondary.label === 'CANCEL' && /TRY AGAIN/.test(sp.cta),
      'F1: ' + label + ': TRANSFER’s error with TRY AGAIN and CANCEL, no question to remove it', JSON.stringify({ err: a.state.trErr, cta: sp.cta, cards: a.cards.map((c) => c.title) }));
    ok(onList(a, MINT) && !W.mintHidden(MINT) && piles(R, MINT).sat === 30000, 'F1: ' + label + ': nothing removed, the 30,000 sats there');
    a.trCancel();
  }
  // F2 (P12): ADD A MINT with the address of a mint already listed and chosen, then CANCEL: it stays listed and chosen
  {
    const R = await funded();
    const W = R.W;
    await W.claim((await W.invoice(3000, '')).hash);
    const a = app(R);
    const justSwitch = new Function('return {' + method('justSwitch') + '}')().justSwitch;
    ok(onList(a, MINT2) && W.mintChosen(MINT2), 'F2: set up: n listed and chosen');
    a.mrTrash(MINT);
    justSwitch.call(a, MINT2);
    await settle();
    ok(a.state.screen === 'trConfirm' && a.state.trTo === MINT2, 'F2: its address typed at ADD A MINT: the destination');
    a.transferSpec().secondary.go();
    await settle(); await settle();
    ok(onList(a, MINT2) && W.mintChosen(MINT2) && !W.mintHidden(MINT2), 'F2: CANCEL: n still listed and chosen',
      JSON.stringify({ list: a.allMints().map((m) => m.url), chosen: W.mintChosen(MINT2) }));
  }
  // F3 (P10): REMOVE pressed while money is moving: nothing moves the phone, and after the wait NOT REMOVED
  {
    const R = await funded();
    const W = R.W;
    await W.claim((await W.invoice(9, '')).hash);
    const a = app(R);
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    const c = lastCard(a);
    ok(c.kind === 'mintRemove' && c.go, 'F3: set up: the one line for 9 sats, the phone on m');
    a._sendRun = true;
    c.go();
    await wait(1500);
    ok((W.saved() || {}).url === MINT, 'F3: while money moves, the phone stays saved on m', JSON.stringify(W.saved()));
    await wait(10000); await settle();
    const r = lastCard(a);
    ok(r.title === 'NOT REMOVED' && /moving money/.test(r.reason) && onList(a, MINT) && W.mintUrl === MINT && (W.saved() || {}).url === MINT,
      'F3: after the wait: NOT REMOVED, the phone still on m and saved there', JSON.stringify({ t: r.title, at: W.mintUrl }));
    a._sendRun = false;
  }
  // F4: a restore from words clears the record of removed mints money came back to
  {
    const R = await funded();
    const W = R.W;
    const a = app(R);
    W.removeMint(MINT2);
    R.storage.setItem('foxy.cashu.mints.hidden', JSON.stringify([]));
    R.storage.setItem('foxy.cashu.mints.returned', JSON.stringify([MINT2]));
    ok(W.mintReturned(MINT2) && !a.mintOnPhone(MINT2), 'F4: set up: n returned, not the phone’s own');
    a.scanCandidate('candidate');
    ok(!W.mintReturned(MINT2) && a.mintOnPhone(MINT2), 'F4: a restore from words: n the phone’s own again, as the rest of the list');
  }
  // ---- 11 -------------------------------------------------------------------------------------------------------------
  console.log('\n11. change under the far mint’s smallest invoice');
  // 30,000 sats, a reserve of 1% at m: ₿ 298 come back, the second move would land 295 at n, whose smallest invoice is 500
  {
    const R = await funded({ mintOpts: { satFeeReservePpk: 10 }, mintOpts2: { mintMin: 500 } });
    const W = R.W;
    await W.claim((await W.invoice(30000, '')).hash);
    const a = app(R);
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    ok(a.state.screen === 'trConfirm' && !!a.state.trPlan, 'set up: the first move quoted', a.state.trErr);
    a.transferSpec().go();
    await settle(); await settle(); await wait(300); await settle();
    const left = piles(R, MINT).sat;
    const c = lastCard(a);
    ok(left === 298 && c.kind === 'mintRemove' && /₿ 298 stays at M until you add it again\. It is less than the smallest amount n takes\./.test(c.reason),
      'the change under n’s smallest invoice is dust: the one line names it and the reason', JSON.stringify({ left, r: c.reason, err: a.state.trErr }));
    ok(!(a.state.trErr && a.state.screen === 'trConfirm' && !a.cards.some((x) => x.kind === 'mintRemove')), 'not TRANSFER’s error with TRY AGAIN');
    if (c.go) c.go();
    await settle();
    ok(!onList(a, MINT) && W.mintHidden(MINT) && piles(R, MINT).sat === 298, 'REMOVE: m hidden, the ₿ 298 kept there');
  }
  // the same with a third mint on the list whose smallest invoice is 200: the change goes there, a confirmation offered
  {
    const R = await funded({ third: true, mintOpts: { satFeeReservePpk: 10 }, mintOpts2: { mintMin: 500 }, mintOpts3: { mintMin: 200 } });
    const W = R.W;
    await W.connect(MINT3, null, null, { remember: true });
    await W.connect(MINT, null, null, { remember: true });
    await W.claim((await W.invoice(30000, '')).hash);
    const a = app(R);
    ok(onList(a, MINT3) && a.mintOnPhone(MINT3), 'set up: o on the list too');
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    a.transferSpec().go();
    await settle(); await settle(); await wait(300); await settle();
    ok(a.state.screen === 'trConfirm' && a.state.trTo === MINT3 && !!a.state.trPlan && !a.cards.some((x) => x.kind === 'mintRemove'),
      'the change n will not take is offered to o, whose smallest invoice it is over', JSON.stringify({ sc: a.state.screen, to: a.state.trTo, err: a.state.trErr }));
    ok(/came back as change/.test(a.transferSpec().subtitle), 'its confirmation says it came back as change', a.transferSpec().subtitle);
    a.transferSpec().go();
    await settle(); await settle(); await wait(300); await settle();
    const c = lastCard(a);
    if (c.kind === 'mintRemove' && c.go) c.go();
    await settle();
    ok(!onList(a, MINT) && piles(R, MINT).sat < 10 && piles(R, MINT3).sat > 280, 'then removed, next to nothing left at m',
      JSON.stringify({ m: piles(R, MINT).sat, o: piles(R, MINT3).sat }));
  }
  // ---- 12 -------------------------------------------------------------------------------------------------------------
  console.log('\n12. a refusal that is not a floor');
  const once = (R, hit) => { let n = 0; R.fate = (m) => (hit(new URL(m.url)) && n++ === 0 ? '400\n' + JSON.stringify({ detail: 'Lightning backend timed out', code: 0 }) : null); };
  const nInvoice = (u) => u.origin === MINT2 && /\/v1\/mint\/quote\/bolt11$/.test(u.pathname);
  // R4: n refuses the first invoice once: no floor, no dust; the second ask is the quote
  {
    const R = await funded();
    const W = R.W;
    await W.claim((await W.invoice(30000, '')).hash);
    const a = app(R);
    once(R, nInvoice);
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    R.fate = null;
    ok(!a.cards.some((c) => c.kind === 'mintRemove') && a.state.screen === 'trConfirm' && !!a.state.trPlan && a.state.trSats > 29000,
      'R4: a one-off refusal on the first move is no floor: no dust question, the whole pile quoted on asking again',
      JSON.stringify({ cards: a.cards.map((c) => c.title), err: a.state.trErr, sats: a.state.trSats }));
    a.trCancel();
    ok(onList(a, MINT) && piles(R, MINT).sat === 30000, 'R4: nothing removed');
    // and plain TRANSFER: the same refusal is not a floor either
    once(R, nInvoice);
    let err = null, plan = null;
    await W.connect(MINT2, null, null, { remember: false });
    try { plan = await W.transferQuote(MINT, 700); } catch (e) { err = e; }
    R.fate = null;
    ok(!!plan && !(err && err.foxyFloor), 'R4: TRANSFER of 700 sats, refused once: quoted on asking again, never marked a floor', String(err && err.message));
  }
  {
    const R = await funded({ mintOpts2: { mintMin: 800 } });
    const W = R.W;
    await W.claim((await W.invoice(700, '')).hash);
    const a = app(R);
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    const sp = a.state.screen === 'trConfirm' ? a.transferSpec() : {};
    ok(!a.cards.some((c) => c.kind === 'mintRemove') && !!a.state.trErr && sp.secondary && sp.secondary.label === 'CANCEL' && /TRY AGAIN/.test(sp.cta),
      'a true floor on the first move (690 under 800): TRANSFER’s error with TRY AGAIN and CANCEL, not dust', JSON.stringify({ err: a.state.trErr, cards: a.cards.map((c) => c.title) }));
    ok(onList(a, MINT) && piles(R, MINT).sat === 700, 'nothing removed');
    a.trCancel();
  }
  // a 1,500-sat change refused twice at a 2,000 minimum: above 1,000 no floor is assumed: TRANSFER's error, not dust
  {
    const R = await funded({ mintOpts: { satFeeReservePpk: 10 }, mintOpts2: { mintMin: 2000 } });
    const W = R.W;
    await W.claim((await W.invoice(150200, '')).hash);
    const a = app(R);
    a.mrTrash(MINT);
    a.trPick(MINT2);
    await settle();
    a.transferSpec().go();
    await settle(); await settle(); await wait(300); await settle();
    const left = piles(R, MINT).sat;
    const sp = a.state.screen === 'trConfirm' ? a.transferSpec() : {};
    ok(left >= 1400 && !a.cards.some((c) => c.kind === 'mintRemove') && !!a.state.trErr && sp.secondary && sp.secondary.label === 'CANCEL',
      'change of about 1,500 under a 2,000 minimum: TRANSFER’s error with CANCEL, no dust question', JSON.stringify({ left, err: a.state.trErr, cards: a.cards.map((c) => c.title) }));
    ok(onList(a, MINT) && !W.mintHidden(MINT), 'and m still on the list');
    a.trCancel();
  }
  finish();
}

function finish() {
  console.log('\n' + (failed ? failed + ' of ' + (passed + failed) + ' mint-remove checks FAILED' : 'all ' + passed + ' mint-remove checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
