'use strict';
/* flashcard-offline-ui.js — a card pays a phone that has no route, as the person at the till sees it.
 *
 *     node tests/flashcard-offline-ui.js
 *
 * The wallet's side is tests/flashcard-offline.js: a card that proves its money signs the swap over to this phone, which
 * keeps it, counts it, and settles it with the mint when it is online. This is the screens over that: the receive
 * screen's CARD with no route (no HIGH RISK card, the PIN, the tap, the receive closed and PAYMENT RECEIVED), the amber
 * ring while it waits, its row and its detail in HISTORY, the three ways a kept payment can fail and the late warning,
 * the owner's renewal offered at a read, set-up with nothing asked, and the dollar receive with no route.
 *
 * The screens are the card's parts (tests/flashcard-ui-kit.js) with HISTORY's own pass, books and screens lifted out of
 * their files (16-history-lists.js, 26-render-history-and-contacts.js), the queue of confirmations (12-receive.js,
 * 15-paid-wake-keyboard.js) and the ring's own lines (21-render-values.js). The books are the app's (histAudit,
 * histAuditUsd) while a payment waits, and the harness's (booksWrong) once nothing does.
 */
const fs = require('fs');
const path = require('path');
const { funded, newCard, settle, history, OTHER_WORDS } = require('./flashcard-kit');
const { booksWrong } = require('./harness');
const { appOn, until, pad, card } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const appFile = (f) => fs.readFileSync(path.join(__dirname, '..', 'build', 'app', f), 'utf8');
/* One of the app's methods, out of the text of its file, by its first line (or by its name and the bracket, `name(`, for one
 * whose parameters other work adds to): from there to the brace that closes it. */
const lift = (src, sig) => {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('flashcard-offline-ui: no method ' + sig);
  let i = /\{$/.test(sig) ? src.indexOf('{', at + 3 + sig.length - 1) : src.indexOf(') {', at) + 2, depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at + 3, i + 1);
};
const HISTORY_SIGS = ['loadHistory() {', 'histAudit() {', 'histAuditUsd() {', 'histAuditIn(unit) {', 'arrivingNow() {', 'arrivingBucket(unit) {',
                      'topUpFeeSats() {', 'recoveringSats() {', 'txTotalOut(t) {', 'txWhen(t) {', 'txLabel(d, now) {', 'txStamp(d, now) {',
                      'txDay(d, now) {', 'txClock(d) {', 'txWho(t) {'];
const RENDER_SIGS = ['renderHistory(c) {', 'renderTxDetail(c) {', 'histRowTwo('];
const QUEUE = [[appFile('12-receive.js'), 'announcePayment(ev) {'], [appFile('15-paid-wake-keyboard.js'), 'nextPaidScreen() {'],
               [appFile('15-paid-wake-keyboard.js'), 'queueLater() {'], [appFile('15-paid-wake-keyboard.js'), 'paidDismissed() {']];
/* The amber and red of the HISTORY ring, out of renderVals (21-render-values.js): from the wallet it reads to the colours it
 * picks between, run as written against a page's wallet. */
const RING = (() => {
  const src = appFile('21-render-values.js');
  const from = src.indexOf('const W21 = window.FoxyWallet;');
  const to = src.indexOf("const AMBER = '#F7931A';");
  if (from < 0 || to < from) throw new Error('flashcard-offline-ui: the ring’s lines moved');
  return new Function('window', src.slice(from, to) + '\nreturn { waiting, atRisk };');
})();

/* The till: the card's parts with HISTORY and the confirmations. `state.balSats` is the balance as home has it, which the
 * books walk back from. */
function till(ctx, start) {
  const a = appOn(ctx, Object.assign({ screen: 'confirm' }, start || {}), { split: true });
  const hist = new Function('window', 'document', 'return {' + HISTORY_SIGS.map((s) => lift(appFile('16-history-lists.js'), s)).join(',\n') + '}')(
    ctx.window, ctx.window.document);
  const view = new Function('window', 'document', 'CTA_INK', 'return {' + RENDER_SIGS.map((s) => lift(appFile('26-render-history-and-contacts.js'), s)).join(',\n') + '}')(
    ctx.window, ctx.window.document, () => '#fff');
  const queue = new Function('window', 'document', 'CONFIRM_SCREENS', 'return {' + QUEUE.map(([src, s]) => lift(src, s)).join(',\n') + '}')(
    { FoxyWallet: { notify: () => {} } }, { visibilityState: 'visible' }, []);
  Object.assign(a, hist, view, queue);
  // the wallet's words for money that moved by a card, as the history names them (a field of the class, 16-history-lists.js)
  a.CARD_MEMOS = new Function('return ' + /\n  CARD_MEMOS = (\{[\s\S]*?\});/.exec(appFile('16-history-lists.js'))[1])();
  a.SPLIT_SCREENS = [];
  a.QUEUE_RETRY_MS = 40;
  a.PASTE_SETTLE_MS = 0;
  a.FC_END_SETTLE_MS = 20;
  a.offerSecureFoxy = () => {};
  a.dismissPaid = () => { a.state.screen = 'home'; a.paidDismissed(); };
  a.refreshBalance = () => ctx.W.balanceSats().then((n) => { a.have = n; a.state.balSats = n; });
  a.twoUnitsOn = () => false;
  a.homePills = () => ['sat'];
  a.txFiat = () => 0;
  a.unitMoney = (n, u) => n + ' ' + u;
  a.unitFigure = (n, u) => n + ' ' + u;
  a.unitLabel = (u) => String(u).toUpperCase();
  a.histRef = null;
  a.moneyIn = (n, unit) => (unit === 'usd' ? '$ ' + (Math.round(Number(n) || 0) / 100).toFixed(2) : a.group(n) + ' sats');
  return a;
}
// the till's books, after a history pass: the bitcoin's and the dollars', each its `off`
async function auditOf(a) {
  await a.refreshBalance();
  a.loadHistory();
  await settle();
  const sat = a.histAudit(), usd = a.histAuditUsd();
  return { whole: sat.whole, off: sat.off, usdOff: usd.off, bal: sat.balNow };
}
/* What HISTORY draws for the entry `hash`: its row on the list (drawn in the order of the entries, every one of them with
 * no filter on), and its detail screen. */
function rowOf(a, hash) {
  const g = a.renderHistory({ s: a.state, sc: 'history' });
  const rows = [].concat(...(g.historyGroups || []).map((x) => x.items || []));
  const entries = [].concat(...(a.state.history || []).map((x) => x.items || []));
  const at = entries.findIndex((t) => t.hash === hash);
  return (at >= 0 && rows.length === entries.length) ? rows[at] : null;
}
function detailOf(a, hash) {
  const tx = [].concat(...(a.state.history || []).map((x) => x.items)).filter((t) => t.hash === hash)[0];
  return tx ? a.renderTxDetail({ s: a.state, sc: 'txDetail', tx }) : null;
}

const offline = (c) => c.W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
const online = (c) => c.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
// pages' clocks and this one's (the screens' parts read the time here), moved by `ms`, and put back by the function it answers
function later(pages, ms) {
  const reals = pages.map((c) => c.window.Date.now.bind(c.window.Date));
  const here = Date.now;
  pages.forEach((c, i) => { c.window.Date.now = () => reals[i]() + ms; });
  Date.now = () => here() + ms;
  return () => { pages.forEach((c, i) => { c.window.Date.now = reals[i]; }); Date.now = here; };
}
const slotDates = (k) => Array.from(new Set(k.state.slots.filter((x) => x.status === 1).map((x) => parseInt(x.data.substr(154, 8), 16))));
const booksGood = (name, ...pages) => {
  const wrong = [];
  pages.forEach((c) => booksWrong(c).forEach((l) => wrong.push(l)));
  ok(wrong.length === 0, name, wrong.join(' | '));
};

/* H, the card's owner, with the card set up (recoverable, as every card is) and 2,000 on it; R, a stranger at the same
 * mint with nothing, whose till is `t`, with the wallet's word of a kept payment lost given to its card (06b). */
async function world(o) {
  const opts = o || {};
  const H = await funded({}, 9000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const k = newCard(H, undefined, { format: 4 });
  await H.W.cardSetUp(k, { pin: '1234' });
  k.tap();
  await H.W.cardAdd(k, { sats: opts.sats || 2000, pin: '1234' });
  const t = till(R);
  R.W.onCardKeptLost((info) => t.cardKeptLostCard(info));
  return { H, R, k, t };
}
// the card pays R's wallet with no route, as the till's CARD would (the screens of it are case 1's)
async function keptPay(R, k, sats) {
  offline(R);
  k.tap();
  return R.W.cardPay(k, { sats, pin: '1234', offline: true });
}

(async () => {
  /* ---- 1: the receive screen's CARD with no route --------------------------------------------------------------- */
  const A = await world();
  {
    const { R, k, t } = A;
    const asked = [];
    R.W.onOfflineOffer((info) => { asked.push(info); return t.offlineRiskCard(info); });
    offline(R);
    R.nfc = k;
    t.asking = 592;
    k.sent.length = 0;
    t.payByCard();
    ok(!card(t) && asked.length === 0, 'with no route, CARD asks the person nothing: no HIGH RISK card', card(t) && card(t).title);
    await until('the PIN pad', () => !!pad(t));
    ok(pad(t).title === 'CARD PIN' && /^To pay ₿592\. /.test(pad(t).sub), 'the card wants its PIN, and the pad asks for it for the second tap', pad(t).sub);
    pad(t).type('1234');
    await until('the payment to be kept', () => R.W.cardKeptWaiting().length === 1 && t.state.screen !== 'confirm');
    await settle();
    // (the receive closed, and the history pass it asked for has come and gone: what it raised is on screen)
    ok(t.state.screen === 'paid' && t.state.stack.indexOf('confirm') < 0 && !card(t) && asked.length === 0 && k.sent.some((x) => /^b01a/.test(x)),
       'the card proved its money (its proofs were read) and signed: the receive closes, with no card raised over it', t.state.screen);
    ok(t.toasts.indexOf('Paid by card while this phone is offline. Foxy settles it with the mint when it is online.') >= 0, 'and a line says how it settles', t.toasts.slice(-1)[0]);
    const id = R.W.cardKeptWaiting()[0].id;
    A.hash = 'req-' + id;
    A.date = R.W.cardKeptWaiting()[0].date;
    ok(t.state.screen === 'paid' && t.state.amount === '592' && !t.state.payOut && !t.state.paidSays,
       'the history pass says PAYMENT RECEIVED for ₿592, as for any payment', JSON.stringify({ screen: t.state.screen, amount: t.state.amount, says: t.state.paidSays }));
    t.dismissPaid();
    const au = await auditOf(t);
    ok(t.state.screen === 'home' && !(t._paidQueue || []).length, 'once, however many history passes follow', t.state.screen);
    ok(au.whole && au.off === 0 && au.usdOff === 0 && au.bal === 592, 'the balance counts it, and the books add up while it waits', JSON.stringify(au));
    const ring = RING(R.window);
    ok(ring.waiting === true && !ring.atRisk, 'the HISTORY ring is amber while it waits, not red: nobody else can take it', JSON.stringify(ring));
    const row = rowOf(t, A.hash);
    ok(row && row.metaRail === 'Paid by card · settles online' && row.metaColor === 'var(--btc-ink)' && row.tileBg === 'var(--btc-ink)' && row.stroke === 'var(--btc-ink)' && !row.atRisk,
       'its row says it was paid by card and settles online, in amber', row && row.metaRail);
    const d = detailOf(t, A.hash);
    const day = t.fcDay(A.date);
    ok(d && d.txStatus === 'SETTLES ONLINE' && d.txCardShow === true && d.txAtRisk === false && d.txCardInk === 'var(--btc-ink)'
       && d.txCardLine === 'A card paid this while this phone was offline. The card signed it over to this phone, and Foxy settles it with the mint the next time this phone is online. Be online before '
         + day + ': after that the card’s owner can take it back.',
       'its detail says SETTLES ONLINE, what that means, and the day to be online by, with no CLAIM NOW', d && d.txCardLine);
  }

  /* ---- 2: settled at the first connection: an ordinary receive, announced once ------------------------------------ */
  {
    const { H, R, t } = A;
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    const au = await auditOf(t);
    ok(R.W.cardKeptWaiting().length === 0 && t.state.screen !== 'paid' && t._paidQueue.length === 0, 'online, it settles, and nothing is announced again', t.state.screen);
    const row = rowOf(t, A.hash), d = detailOf(t, A.hash);
    ok(row && row.metaRail === '' && row.tileBg === 'var(--ok)' && d.txStatus === 'COMPLETE' && d.txCardShow === false,
       'its row is an ordinary completed receive now', JSON.stringify({ rail: row && row.metaRail, status: d && d.txStatus }));
    ok(RING(R.window).waiting === false, 'and the ring stops');
    ok(au.whole && au.off === 0 && au.usdOff === 0 && au.bal === 592, 'the books add up', JSON.stringify(au));
    booksGood('and the harness’s books of both pages', R, H);
  }

  /* ---- 2b: the switch off, and a card too old to pay offline ------------------------------------------------------ */
  {
    const { H, R, t } = A;
    offline(R);
    R.W.cardOffline(false);
    const k1 = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(k1, { pin: '1234' });
    k1.tap();
    await H.W.cardAdd(k1, { sats: 500, pin: '1234' });
    R.nfc = k1;
    k1.sent.length = 0;
    t.toasts.length = 0;
    t.state.screen = 'confirm';
    t.asking = 64;
    t.payByCard();
    await settle();
    ok(t.toasts.indexOf('A card payment needs a connection.') >= 0 && !card(t) && !pad(t) && k1.sent.length === 0,
       'the switch off: with no route a card payment needs a connection, and the card is not touched', t.toasts.join(' | '));
    R.W.cardOffline(true);
    // a one-signature card of software 1.19, which keeps no proofs of the mint's to show
    const old = newCard(H, undefined, { format: 4, software: 19 });
    await H.W.cardSetUp(old, { pin: '1234' });
    old.tap();
    await H.W.cardAdd(old, { sats: 500, pin: '1234' });
    R.nfc = old;
    old.sent.length = 0;
    t.payByCard();
    await until('the old card to be refused', () => !!card(t));
    ok(card(t).title === 'TOO OLD TO PAY OFFLINE'
       && card(t).reason === 'This card is too old to pay a phone that is offline. Take this payment when this phone is online. Nothing was taken.'
       && !pad(t) && !old.sent.some((x) => /^b0(40|22)/.test(x)) && old.balance() === 500,
       'a card too old to prove its money is refused before its PIN and before it is asked to sign, in plain words', card(t).reason);
    card(t).press('CLOSE');
    t.state.screen = 'home';
    online(R);
    booksGood('the books add up', R, H);
  }

  /* ---- 3: the three ways a kept payment fails, said ----------------------------------------------------------------- */
  // retired: the mint's keyset is gone between the tap and the connection
  {
    const { H, R, k, t } = await world();
    const got = await keptPay(R, k, 592);
    const date = got.date;
    R.fate = (m) => (/\/v1\/swap$/.test(new URL(m.url).pathname) ? '400\n{"code":12002,"detail":"keyset inactive"}' : null);
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    R.fate = null;
    const c = card(t);
    ok(c && c.title === 'CARD PAYMENT NOT SETTLED' && c.reason === 'The mint changed its keys or its fee after a card paid you 592 sats while you were offline, and it will not take the card’s signature now. It is not in your balance. The money goes back to the card’s owner after ' + t.fcDay(date) + '.',
       'a keyset retired: CARD PAYMENT NOT SETTLED, in the words for it', c && c.reason);
    if (c) c.press(c.has('CLOSE') ? 'CLOSE' : c.has('OK') ? 'OK' : 'DONE');
    const au = await auditOf(t);
    const row = rowOf(t, got.hash), d = detailOf(t, got.hash);
    ok(row && row.metaRail === 'Failed' && d.txStatus === 'FAILED' && d.txCardShow && d.txCardInk === 'var(--bad)'
       && d.txCardLine === 'The mint changed its keys or its fee after the card paid, and would not take the card’s signature, so it is not in your balance.',
       'its row is Failed, and its detail says why in one sentence', d && d.txCardLine);
    ok(au.off === 0 && au.usdOff === 0 && au.bal === 0 && !RING(R.window).waiting, 'the balance is back to nothing, the ring is still, and the books add up', JSON.stringify(au));
    booksGood('the harness’s books too', R, H);
  }
  // spent: the mint says the pieces were spent, and they were not this phone's swap
  {
    const { H, R, k, t } = await world();
    const got = await keptPay(R, k, 592);
    R.fate = (m) => (/\/v1\/swap$/.test(new URL(m.url).pathname) ? '400\n{"code":11001,"detail":"Token already spent"}' : null);
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    R.fate = null;
    const c = card(t);
    ok(c && c.title === 'CARD PAYMENT NOT SETTLED' && c.reason === 'The mint says the 592 sats this card paid while you were offline was already spent before this phone could settle it. That card, or a copy of it, spent the same money twice. It is not in your balance, and the payment is marked failed in your history.',
       'spent by a copy of the card: CARD PAYMENT NOT SETTLED, and that the card spent it twice', c && c.reason);
    if (c) c.press(c.has('CLOSE') ? 'CLOSE' : c.has('OK') ? 'OK' : 'DONE');
    const au = await auditOf(t);
    const d = detailOf(t, got.hash);
    ok(d && d.txStatus === 'FAILED' && d.txCardLine === 'The mint said this card’s money had already been spent before this phone could settle it, so it is not in your balance.',
       'its detail says so', d && d.txCardLine);
    ok(au.off === 0 && au.usdOff === 0 && au.bal === 0, 'and the books add up', JSON.stringify(au));
    booksGood('the harness’s books too', R, H);
  }
  // unwound: past its date, the card's owner took it back first
  {
    const { H, R, k, t } = await world();
    const got = await keptPay(R, k, 592);
    const date = got.date;
    const undo = later([H, R], date * 1000 + HOUR - Date.now());
    const back = await H.W.cardTakeBack(k.key);
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    const c = card(t);
    ok(back && back.sats > 0 && c && c.title === 'CARD PAYMENT WENT BACK'
       && c.reason === 'This phone could not settle the 592 sats a card paid while you were offline before its date, ' + t.fcDay(date) + '. After that date the money goes back to the card’s owner, and it has. It is not in your balance, and the payment is marked failed in your history.',
       'taken back by its owner after its date: CARD PAYMENT WENT BACK, with the date', c && c.reason);
    if (c) c.press(c.has('CLOSE') ? 'CLOSE' : c.has('OK') ? 'OK' : 'DONE');
    const au = await auditOf(t);
    const d = detailOf(t, got.hash);
    ok(d && d.txStatus === 'FAILED' && d.txCardLine === 'This phone could not settle it before its date, and the money went back to the card’s owner.', 'its detail says so', d && d.txCardLine);
    ok(au.off === 0 && au.usdOff === 0 && au.bal === 0, 'and the books add up', JSON.stringify(au));
    undo();
    booksGood('the harness’s books of both pages', R, H);
  }

  // the card's signature refused by the mint: said as that, and not as its keys, its fee or its owner
  {
    const { H, R, k, t } = await world();
    const got = await keptPay(R, k, 592);
    R.fate = (m) => (/\/v1\/swap$/.test(new URL(m.url).pathname) ? '400\n{"code":11010,"detail":"Witness signature is not valid: locktime has passed"}' : null);
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    R.fate = null;
    const c = card(t);
    ok(c && c.title === 'CARD PAYMENT NOT SETTLED'
       && c.reason === 'The mint would not take the card’s signature for the 592 sats it paid you while you were offline, so this phone cannot settle it. It is not in your balance. The money goes back to the card’s owner after ' + t.fcDay(got.date) + '.',
       'the mint refused the card’s signature: CARD PAYMENT NOT SETTLED, in the words for that', c && c.reason);
    if (c) c.press(c.has('CLOSE') ? 'CLOSE' : c.has('OK') ? 'OK' : 'DONE');
    const au = await auditOf(t);
    const d = detailOf(t, got.hash);
    ok(d && d.txStatus === 'FAILED' && d.txCardLine === 'The mint would not take the card’s signature, so it is not in your balance, and the money goes back to the card’s owner.',
       'its detail says so in one sentence', d && d.txCardLine);
    ok(au.off === 0 && au.usdOff === 0 && au.bal === 0, 'and the books add up', JSON.stringify(au));
    booksGood('the harness’s books too', R, H);
  }
  // a share of the bill it paid, open again: said, and the collecting screen unticks it and watches its invoice again
  {
    const { t } = await world();
    let watched = 0;
    t.resumeSplitNow = () => { watched += 1; };
    t.state.spPaid = [true, true];
    t.state.screen = 'spAllPaid';
    t.cardKeptLostCard({ id: 'card-x', sats: 592, cause: 'retired', date: 0, shares: [0] });
    await settle();
    const c = card(t);
    ok(c && /It is not in your balance\. The share of the bill it paid is open again\.$/.test(c.reason)
       && JSON.stringify(t.state.spPaid) === '[false,true]' && t.state.screen === 'spWaiting' && watched === 1,
       'a share it paid is open again: said, unticked on the bill’s screen (only that one), and its invoice watched again', JSON.stringify({ paid: t.state.spPaid, screen: t.state.screen }));
  }

  /* ---- 4: the mint not answering near its date: said once, in passing ---------------------------------------------- */
  {
    const { H, R, k, t } = await world();
    const got = await keptPay(R, k, 592);
    online(R);
    R.deaf = true;
    await R.W.claimUnclaimed();
    await settle();
    const lateSaid = () => t.toasts.filter((x) => /^A card payment of /.test(x));
    ok(lateSaid().length === 0 && R.W.cardKeptWaiting().length === 1 && RING(R.window).waiting, 'not answering with its date far off: nothing said, still waiting, the ring amber');
    const undo = later([R], got.date * 1000 - DAY - Date.now());
    await R.W.claimUnclaimed();
    await settle();
    await R.W.claimUnclaimed();
    await settle();
    ok(lateSaid().length === 1 && lateSaid()[0] === 'A card payment of 592 sats is not settled yet: the mint is not answering. It has to settle before ' + t.fcDay(got.date) + '.' && !card(t),
       'a day before its date, the line says it is late and by when, once, with no card raised', lateSaid().join(' | '));
    const au = await auditOf(t);
    ok(au.off === 0 && au.usdOff === 0, 'the books add up while it waits', JSON.stringify(au));
    R.deaf = false;
    for (let i = 0; i < 4 && R.W.cardKeptWaiting().length; i++) { await R.W.claimUnclaimed(); await settle(); }
    undo();
    ok(R.W.cardKeptWaiting().length === 0 && (await R.W.balanceSats()) === 592, 'and once it answers, settled');
    booksGood('the books add up', R, H);
  }

  /* ---- 5: the owner's renewal, offered at a read --------------------------------------------------------------------- */
  {
    const H = await funded({}, 9000);
    const k = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(k, { pin: '1234' });
    k.tap();
    await H.W.cardAdd(k, { sats: 2000, pin: '1234' });
    const date = slotDates(k)[0];
    const owner = appOn(H);
    await owner.refreshBalance();
    H.nfc = k;
    const readCard = async () => {
      owner.state.screen = 'home'; owner.state.stack = []; owner.state.fc = null;
      owner.goFlashcard();
      await until('the card to be read', () => !!owner.state.fc && owner.state.fc.key === k.key);
      await settle();
    };
    // twenty-one days left: nothing asked
    let undo = later([H], date * 1000 - 21 * DAY - Date.now());
    await readCard();
    ok(!card(owner) && !pad(owner), 'with twenty-one days left, its owner’s read asks nothing', card(owner) && card(owner).title);
    undo();
    // nineteen days left, and offline: nothing asked
    undo = later([H], date * 1000 - 19 * DAY - Date.now());
    owner.offline = true;
    await readCard();
    ok(!card(owner) && !pad(owner), 'with nineteen days left and no connection, nothing is asked');
    owner.offline = false;
    owner._fcRefreshAsked = {};
    // nineteen days left, online: RENEW THIS CARD, then its PIN pad
    await readCard();
    const day = owner.fcDay(date);
    ok(card(owner) && card(owner).title === 'RENEW THIS CARD' && card(owner).reason === 'Its money is good until ' + day + '. Renew it for 30 days.'
       && card(owner).has('RENEW') && card(owner).has('LATER') && !pad(owner),
       'with nineteen days left, online, its owner is offered the renewal: RENEW or LATER, and no pad until asked', card(owner) && card(owner).all);
    card(owner).press('LATER');
    ok(!card(owner) && !pad(owner) && owner.state.screen === 'flashcard' && owner.FC_RENEW_DAYS === 20
       && owner.renderFlashcard({ s: owner.state, sc: owner.state.screen }).fcNotes.some((n) => /must be renewed by/.test(n.text)),
       'LATER: nothing is done, and the line on the card’s screen still offers it');
    await readCard();
    ok(!card(owner), 'asked once for a card in a session: read again, it is not asked again');
    /* Each thing that holds the offer back, alone (read here as the read would, with the rest as they are): the wallet
     * with no route, money owed to the card still to be written, its own read finding money coming to it, and a card
     * that is locked. And all of them away: offered. */
    const ask = (c) => { owner._fcRefreshAsked = {}; owner.fcRefreshMaybe(c || { key: k.key }); const got = card(owner); if (got) got.press('LATER'); return got ? got.title : ''; };
    offline(H);
    ok(ask() === '' && !owner.offlineNow(), 'with the wallet’s route gone and the screen not yet saying so, nothing is offered');
    online(H);
    const owed0 = H.storage.getItem('foxy.flashcard.owed');
    H.storage.setItem('foxy.flashcard.owed', JSON.stringify([{ id: 'owed-x', card: k.key, token: 'cashuB', sats: 64, kind: 'load', at: Date.now() }]));
    ok(ask() === '', 'with money owed to it still to be written, nothing is offered: its next tap puts that on first');
    if (owed0 === null) H.storage.removeItem('foxy.flashcard.owed'); else H.storage.setItem('foxy.flashcard.owed', owed0);
    ok(ask({ key: k.key, owes: { parts: [{ state: 'fetched' }] } }) === '', 'nor with money coming to it found at this read');
    owner.state.fc.locked = true;
    ok(ask() === '', 'nor for a locked card, which cannot give its money up to be renewed until it is opened');
    owner.state.fc.locked = false;
    ok(ask() === 'RENEW THIS CARD', 'with none of those, it is offered');

    owner._fcRefreshAsked = {};
    await readCard();
    card(owner).press('RENEW');
    await until('the renewal’s PIN pad', () => !!pad(owner));
    ok(pad(owner).title === 'CARD PIN' && pad(owner).sub === 'Its money is good until ' + day + '. Renew it for 30 days: ₿2,000.' && pad(owner).cta === 'RENEW',
       'RENEW asks for the card’s PIN, and says what it is good until and what is renewed', pad(owner).sub);
    const hb = await H.W.balanceSats();
    k.tap();
    pad(owner).type('1234');
    await until('the card to be renewed', () => owner.state.screen === 'paid' && owner.state.paidSays === 'ON THE CARD');
    const nowS = Math.floor(H.window.Date.now() / 1000);
    ok(k.balance() === 2000 && slotDates(k).length === 1 && Math.abs(slotDates(k)[0] - (nowS + 30 * 86400)) < 600 && (await H.W.balanceSats()) === hb,
       'renewed: the same 2,000, every piece of one date thirty days on', JSON.stringify({ days: ((slotDates(k)[0] - nowS) / 86400).toFixed(2) }));
    owner.setState({ screen: 'home', stack: [] }); if (owner.paidDismissed) owner.paidDismissed(); await new Promise((ok2) => setTimeout(ok2, 100));
    undo();
    booksGood('the books add up', H);
  }

  /* ---- 6: set-up asks nothing, and the card is recoverable --------------------------------------------------------------- */
  {
    const H = await funded({}, 3000);
    const owner = appOn(H);
    const k = newCard(H);
    H.nfc = k;
    owner.goFlashcard();
    await until('the new card to be read', () => !!owner.state.fc);
    owner.fcSetUp();
    pad(owner).type('1234');
    pad(owner).type('1234');
    ok(!pad(owner) && !(card(owner) && card(owner).title === 'IF THE CARD IS LOST'), 'set-up goes from the PIN to the tap: no IF THE CARD IS LOST', card(owner) && card(owner).title);
    await until('the card to be set up', () => !!k.state.owner && owner.state.fc && owner.state.fc.owner);
    k.tap();
    await H.W.cardAdd(k, { sats: 500, pin: '1234' });
    ok(/^0[23]/.test(k.state.record.refund) && owner.state.fc.recoverable && H.W.cardsList().some((r) => r.key === k.key)
       && Math.abs(slotDates(k)[0] - (Date.now() / 1000 + 30 * 86400)) < 600,
       'the card names this phone’s key, is on the list of cards this phone loaded, and what goes on it is good for thirty days', k.state.record.refund.slice(0, 6));
    booksGood('the books add up', H);
  }

  /* ---- 6b: under a week left, with no route: refused before the PIN, in the offline words -------------------------------- */
  {
    const { H, R, k, t } = await world();
    const date = slotDates(k)[0];
    const undo = later([R], date * 1000 - (6 * DAY + 23 * HOUR) - Date.now());
    offline(R);
    R.nfc = k;
    t.state.screen = 'confirm';
    t.asking = 592;
    k.sent.length = 0;
    t.payByCard();
    await until('the card to be refused', () => !!card(t));
    ok(card(t).title === 'CARD NEEDS RENEWING'
       && card(t).reason === 'This card’s money runs out in less than 7 days, so this phone cannot take it while offline. Its owner renews it by tapping it on their phone. Nothing was taken.'
       && !pad(t) && !k.sent.some((x) => /^b0(40|22)/.test(x)) && k.balance() === 2000,
       'six days and twenty-three hours left, no route: CARD NEEDS RENEWING in the offline words, before the PIN and before it signs', card(t).reason);
    card(t).press(card(t).has('CLOSE') ? 'CLOSE' : 'OK');
    undo();
    online(R);
    booksGood('the books add up', R, H);
  }

  /* ---- 7: a dollar receive with no route --------------------------------------------------------------------------------- */
  {
    const { H, R, k, t } = await world();
    offline(R);
    R.nfc = k;
    t.state.recvAmount = 100;                 // one dollar asked
    /* A dollar card pays a dollar receive in cents with no price and needs no build that converts, so CARD taps the card for
     * dollars whatever this phone's price is; a bitcoin card is asked for sats only where its sats can be worked out and turned
     * into dollars later. This card holds bitcoin: it is read, and refused before its PIN and before it signs, with why
     * (a dollar card's side is tests/flashcard-usd-ui.js). */
    const signed = () => k.sent.some((x) => /^b0(40|22)/.test(x));
    // a build that cannot turn sats into dollars later: a bitcoin card is told a phone that is offline takes dollars only from a dollar card
    const realConvert = R.W.convertOne;
    delete R.W.convertOne;
    t.toasts.length = 0;
    k.sent.length = 0;
    t.payUsdByCard();
    await until('the bitcoin card to be refused', () => !!card(t));
    ok(card(t).title === 'THIS CARD HOLDS BITCOIN'
       && card(t).reason === 'This card holds bitcoin here, not dollars. A phone that is offline takes dollars only from a dollar card. Take this payment in bitcoin, or when this phone is online.'
       && /Nothing was taken/.test(card(t).all) && !pad(t) && !signed() && k.balance() === 2000,
       'without the dollars build, a bitcoin card at a dollar receive with no route is read and refused, before its PIN and before it signs', card(t) && card(t).all);
    card(t).press(card(t).has('CLOSE') ? 'CLOSE' : 'OK');
    // with it: the wallet's own rule for a price too old to use, and `convertOne` stood in for (nothing is swapped here)
    R.W.convertOne = () => Promise.resolve(null);
    R.W._rate = 64000; R.W._rateAt = Date.now() - 2 * DAY;
    k.sent.length = 0;
    t.payUsdByCard();
    await until('the price to be refused', () => !!card(t));
    ok(card(t) && card(t).title === 'BITCOIN PRICE TOO OLD' && card(t).reason === 'This phone last saw the Bitcoin price 2 days ago. That is too old to work out what to take from the card.'
       && /Nothing was taken/.test(card(t).all) && !pad(t) && !signed() && k.balance() === 2000,
       'a price two days old: a bitcoin card is refused before its PIN and before it signs', card(t) && card(t).all);
    card(t).press(card(t).has('CLOSE') ? 'CLOSE' : 'OK');
    R.W._rate = 0; R.W._rateAt = 0;
    k.sent.length = 0;
    t.payUsdByCard();
    await until('no price to be said', () => !!card(t));
    ok(card(t) && card(t).title === 'BITCOIN PRICE TOO OLD' && /has not seen the Bitcoin price/.test(card(t).reason) && !signed(), 'and no price at all is said so', card(t) && card(t).reason);
    card(t).press(card(t).has('CLOSE') ? 'CLOSE' : 'OK');
    R.W._rate = 64000; R.W._rateAt = Date.now() - 60 * 1000;
    t.payUsdByCard();
    await until('the PIN pad', () => !!pad(t));
    ok(pad(t).sub === 'To pay $1.00 (₿1,563). The card’s owner types its PIN here.', 'a fresh price: the dollars asked, and the sats they come to at it', pad(t).sub);
    pad(t).type('1234');
    await until('the payment to be kept', () => R.W.cardKeptWaiting().length === 1);
    await settle();
    const rec = R.W.cardKept(R.W.cardKeptWaiting()[0].id);
    ok(rec && rec.sats === 1563 && rec.terms && rec.terms.convert === true && rec.terms.usd === 100 && rec.terms.rate === 64000,
       'it takes the sats, and keeps the price with the payment to be turned into dollars once it settles', JSON.stringify(rec && rec.terms));
    if (realConvert) R.W.convertOne = realConvert; else delete R.W.convertOne;
    const au = await auditOf(t);
    ok(au.off === 0 && au.usdOff === 0, 'the books add up in both units', JSON.stringify(au));
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    booksGood('and once it settles', R, H);
  }

  failed += until.failed;
  console.log(failed ? '\n' + failed + ' flashcard-offline-ui check(s) failed' : '\nall flashcard-offline-ui checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
