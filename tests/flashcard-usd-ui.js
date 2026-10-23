'use strict';
/* flashcard-usd-ui.js — a card that holds dollars, as a person sees it.
 *
 *     node tests/flashcard-usd-ui.js
 *
 * A card holds one kind of money, chosen when it is set up: bitcoin, or the mint's dollars. The wallet's side is
 * tests/flashcard-usd.js. This is the screens over it:
 *
 *   1  set-up at a mint with two balances asks WHAT WILL THIS CARD HOLD? on the CURRENCY screen (no balances on the tiles), writes nothing of the
 *      phone's own choice, and sets the card up in dollars; at a mint with one balance nothing is asked
 *   2  the card's screen: one dollar pill, no SWAP, its limits in dollars whatever the price
 *   3  ADD FUNDS: the dollar keypad, capped by this phone's dollars, the stage in dollars
 *   4  a dollar receive paid by a dollar card: CARD before the code exists, the PIN pad in dollars, the cents straight in,
 *      no melt, PAYMENT RECEIVED in dollars, the row in dollars; and with the code up, the code is let go
 *   5  a bitcoin card at a dollar receive before the code: told to tap again, before its PIN and before it signs
 *   6  a dollar card at a bitcoin receive online: the mint's figure, agreed by a second tap, its cents pay the invoice
 *   7  offline, a dollar card at a dollar receive: kept, settled once online, in dollars, with no conversion
 *   8  offline, a dollar card at a bitcoin receive: this phone's price and its age, the PIN pad or THIS CARD HOLDS DOLLARS,
 *      the dollars kept and announced with the sats asked, a price too old or none, keys not seen, a split share, a phone
 *      that holds both
 *   9  CHANGE LIMIT on a dollar card: dollars, no sub line, nothing kept at a price
 *   10 WITHDRAW: capped by the card's cents, into the dollar balance, not announced
 *   11 SWITCH MINT with money on a dollar card: refused before anything is asked
 *   12 SEND from a dollar card: card mode in dollars, the fee in dollars, the RATE row, a melt in dollars; a bitcoin address
 *      refused in the card's words
 *   13 the card's own history in dollars, and its books
 *   14 the error map: every new kind, with "Nothing was taken."
 *   15 convert-on-return's words, both ways, and CARDS YOU LOADED for a dollar card
 *   16 SEND from a dollar card whose change was not put back in the sheet: TAP TO RECEIVE and CHANGE NOT MADE YET, in dollars
 *   17 a dollar card at a bitcoin receive online, at a dollar fee mint, to a receiver with no dollars: the card pays the fee
 *      of the very pieces melted, and the receiver nothing; refused there, PAID IN DOLLARS with every cent the card paid;
 *      a quote about to run out asked again before the card is touched; the agreement felt as a step, not a refusal
 *   18 a wrong PIN, then TRY AGAIN: the pad still says the dollars a dollar card pays
 *   19 FLASHCARD on the send screen while this phone sends from dollars: a bitcoin card is loaded with sats, as ever
 *   20 what is owed to a bitcoin card and a dollar card at once is said in one unit, the card's on show
 *   21 the rest of a dollar card's screens, each in dollars: a payment held and let go (that card's alone), one cut short,
 *      the log and its receipts, TAKE BACK, a reset cut short, a withdrawal cut short
 *
 * The screens are the card's parts with the send, receive and split parts (tests/flashcard-ui-kit.js), and lifted out of
 * their files: the CURRENCY screen (25-render-confirm-and-blocked.js, 01-ui-basics.js), the paid screen
 * (24-render-receive-and-send.js), HISTORY's pass, books and screens (16-history-lists.js, 26-render-history-and-contacts.js),
 * the queue of confirmations (12-receive.js, 15-paid-wake-keyboard.js) and convert-on-return (26i-swap.js). Every case ends
 * with the books per unit off by 0. */
const fs = require('fs');
const path = require('path');
const { page, funded, newCard, settle, history, MINT, OTHER_WORDS } = require('./flashcard-kit');
const { booksWrong } = require('./harness');
const { appOn, until, pad, card, explainer, behind, vals } = require('./flashcard-ui-kit');

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
const HOUR = 3600 * 1000;
const appFile = (f) => fs.readFileSync(path.join(__dirname, '..', 'build', 'app', f), 'utf8');
/* One of the app's methods, out of the text of its file, by its first line (or by its name and the bracket, `name(`): from
 * there to the brace that closes it. */
const lift = (src, sig) => {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('flashcard-usd-ui: no method ' + sig);
  let i = /\{$/.test(sig) ? src.indexOf('{', at + 3 + sig.length - 1) : src.indexOf(') {', at) + 2, depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at + 3, i + 1);
};
const LIFTS = [
  ['01-ui-basics.js', ['currencyPick(unit) {']],
  ['25-render-confirm-and-blocked.js', ['renderCurrency(c) {']],
  ['23-render-home-and-amount.js', ['usdKeypad() {']],
  ['24-render-receive-and-send.js', ['renderPaid(c) {', 'renderPaidBase(c) {']],
  ['16-history-lists.js', ['loadHistory() {', 'histAudit() {', 'histAuditUsd() {', 'histAuditIn(unit) {', 'arrivingNow() {', 'arrivingBucket(unit) {',
                           'topUpFeeSats() {', 'recoveringSats() {', 'txTotalOut(t) {', 'txWhen(t) {', 'txLabel(d, now) {', 'txStamp(d, now) {',
                           'txDay(d, now) {', 'txClock(d) {', 'txWho(t) {']],
  ['26-render-history-and-contacts.js', ['renderHistory(c) {', 'renderTxDetail(c) {', 'histRowTwo(']],
  ['12-receive.js', ['announcePayment(ev) {']],
  ['15-paid-wake-keyboard.js', ['nextPaidScreen() {', 'queueLater() {', 'paidDismissed() {']],
  ['26i-swap.js', ['convertOnReturn(due) {']],
  ['11-cards.js', ['cardKeptLostCard(info) {', 'moneyIn(n, unit) {']],
];
// the dollar pill's look, as home has it (23-render-home-and-amount.js, a field of the class)
const USD_PILL = new Function('return ' + /\n  USD_PILL = (\{[\s\S]*?\n  \});/.exec(appFile('23-render-home-and-amount.js'))[1])();

/* A screen of this phone, at `ctx`: the card's parts with the send, receive and split parts, and the lifted ones above. */
function screenOn(ctx, start) {
  const a = appOn(ctx, Object.assign({ screen: 'home' }, start || {}), { send: true, receive: true, split: true });
  const body = LIFTS.map(([f, sigs]) => sigs.map((s) => lift(appFile(f), s)).join(',\n')).join(',\n');
  const lifted = new Function('window', 'document', 'CONFIRM_SCREENS', 'CTA_INK', 'return {' + body + '}')(
    ctx.window, ctx.window.document, [], () => '#fff');
  Object.assign(a, lifted);
  a.USD_PILL = USD_PILL;
  a.CARD_MEMOS = new Function('return ' + /\n  CARD_MEMOS = (\{[\s\S]*?\});/.exec(appFile('16-history-lists.js'))[1])();
  a.SPLIT_SCREENS = [];
  a.QUEUE_RETRY_MS = 40;
  a.PASTE_SETTLE_MS = 0;
  a.FC_END_SETTLE_MS = 20;
  a.offerSecureFoxy = () => {};
  a.dismissPaid = () => { a.state.screen = 'home'; a.paidDismissed(); };
  a.refreshBalance = () => Promise.all([ctx.W.balanceSats(), Promise.resolve(ctx.W.balanceOf('usd'))]).then(([n, c]) => {
    a.have = n; a.state.balSats = n; a.state.balUsdCents = c;
  });
  a.homePills = () => ['usd', 'sat'];
  a.txFiat = () => 0;
  a.unitMoney = (n, u) => a.unitFigure(n, u);
  a.unitLabel = (u) => String(u).toUpperCase();
  a.histRef = null;
  a.fitStack = () => '';
  a.satsStack = () => '';
  a.boltField = () => '';
  a.paidTargetLabel = () => '';
  a.settleAnimate = () => {};
  a.priceAgeWords = (ms) => String(a.agoWords(ms)).toUpperCase();
  a.mintName = () => 'm.test';
  a.convertLater = () => { a.convertLaters = (a.convertLaters || 0) + 1; };
  a.convertWaiting = () => false;
  a.moneyBusy = () => false;
  a.swapPendingCard = (r) => { a.pendingCards = (a.pendingCards || []).concat([r]); };
  return a;
}

const read = (c, key, dflt) => { try { const v = JSON.parse(c.storage.getItem(key)); return v == null ? dflt : v; } catch (e) { return dflt; } };
const usd = (c) => c.W.balanceOf('usd');
const sats = (c) => c.W.balanceOf('sat');
const converts = (c) => read(c, 'foxy.cashu.convert', []);
const signed = (k) => k.sent.some((x) => /^b0(40|22)/.test(x));
const melts = (c, from) => c.trace.slice(from || 0).filter((t) => /\/v1\/melt\//.test(t));
const offline = (c) => c.W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
const online = (c) => c.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
async function fundUsd(c, cents) {
  const q = await c.W.invoice(cents, '', { unit: 'usd' });
  if (c.mint.quotes[q.hash] && c.mint.quotes[q.hash].state === 'UNPAID') c.mint.payQuote(q.hash);
  return c.W.claim(q.hash);
}
async function fundSat(c, n) {
  const q = await c.W.invoice(n, '');
  if (c.mint.quotes[q.hash] && c.mint.quotes[q.hash].state === 'UNPAID') c.mint.payQuote(q.hash);
  return c.W.claim(q.hash);
}
/* The books, judged: the harness's per unit once nothing waits, and no dollar entry with a sats figure. */
function booksGood(name, ...pages) {
  const wrong = [];
  pages.forEach((c) => {
    booksWrong(c).forEach((l) => wrong.push(l));
    history(c).forEach((e) => {
      if (e && e.unit === 'usd' && (Number(e.sats) > 0 || Number(e.feeSats) > 0 || e.grossSats !== undefined || e.changeSats !== undefined)) {
        wrong.push('a dollar entry with a sats figure: ' + e.hash);
      }
    });
  });
  ok(wrong.length === 0, name + ': the books add up in each unit', wrong.join(' | '));
}
// the app's own books for the till, after a history pass
async function audits(a) {
  await a.refreshBalance();
  a.loadHistory();
  await settle();
  return { sat: a.histAudit().off, usd: a.histAuditUsd().off };
}
const screen = (a) => a.renderReceive({ s: a.state, sc: a.state.screen, val: 0, landed: 0, invSats: 0, sats: 0 });
const paidVals = (a) => a.renderPaid({ s: a.state, sc: 'paid', sats: Math.round(Number(a.state.amount) || 0) });

// every entry a page has now, marked as already announced on its screen
async function seen(a, c) { (await c.W.transactions(500)).forEach((t) => a.txIsNew(t.hash)); a._seenSeeded = true; }
/* H, an owner with dollars and sats at a mint with both; R, a till at the same mint. `o.mintOpts` for the mint. */
async function world(o) {
  const opts = o || {};
  const H = page({ units: ['sat', 'usd'], mintOpts: Object.assign({ quotesUnpaid: true }, opts.mintOpts || {}) });
  await H.W.connect(MINT, null, null, { remember: true });
  await fundSat(H, 5000);
  await fundUsd(H, 20000);
  await H.W.primeLocks();
  const R = page({ sharedMint: H.mint, words: OTHER_WORDS });
  await R.W.connect(MINT, null, null, { remember: true });
  await R.W.primeLocks();
  const holder = screenOn(H, { screen: 'home' });
  const till = screenOn(R, { screen: 'confirm', flow: 'receive', stack: ['home', 'amount'] });
  await holder.refreshBalance();
  await till.refreshBalance();
  // what each phone was funded with is not news to it: its history pass starts from here
  await seen(holder, H);
  await seen(till, R);
  return { H, R, holder, till };
}
// a dollar card set up and loaded at the wallet: `pin` '' for none
async function dollarCard(H, cents, pin) {
  const k = newCard(H, undefined, { format: 4 });
  await H.W.cardSetUp(k, Object.assign({ unit: 'usd' }, pin ? { pin } : {}));
  k.tap();
  if (cents) await H.W.cardAdd(k, { amount: cents, unit: 'usd', owner: true });
  return k;
}
async function satCard(H, n, pin) {
  const k = newCard(H, undefined, { format: 4 });
  await H.W.cardSetUp(k, pin ? { pin } : {});
  k.tap();
  if (n) await H.W.cardAdd(k, { sats: n, owner: true });
  return k;
}
// a dollar receive of `cents` on the till, its code asked of the mint where `code`
async function dollarReceive(till, cents, code) {
  till.setState({ screen: 'confirm', flow: 'receive', stack: ['home', 'amount'], wallet: 'usd', unit: 'USD', amount: (cents / 100).toFixed(2),
                  invoice: '', invoiceHash: '', recvAmount: null, recvUnit: '' });
  // the receive screen as it is the moment it opens, before the mint has made the code (nothing asked of the mint), or with it
  if (code) { till.openUsdReceive(cents); await until('the dollar code', () => !!till.state.invoice); }
  else till.setState({ recvRail: 'LIGHTNING', invoiceIsAddress: false, recvUnit: 'usd', recvAmount: cents, recvExpiresAt: null });
}
async function bitcoinReceive(till, R, n, o) {
  const opts = o || {};
  const q = opts.code === false ? null : await R.W.invoice(n, '');
  till.setState({ screen: 'confirm', flow: 'receive', stack: ['home', 'amount'], wallet: 'sat', unit: opts.unit || 'SATS', amount: opts.amount || String(n),
                  invoice: q ? q.bolt11 : '', invoiceHash: q ? q.hash : '', recvUnit: 'sat', recvAmount: null, recvExpiresAt: null });
  till.asking = n;
  return q;
}
// whatever card is up, put down by its way out
const shut = (a) => { const c = card(a); if (!c) return; const way = ['CLOSE', 'OK', 'DONE', 'CANCEL', 'LATER'].filter((l) => c.has(l))[0]; if (way) c.press(way); };
const tapDone = (a, ctx) => until('the tap to be over', () => !(a._fcTaps > 0) && !ctx.window.document.getElementById('foxy-stage'));

(async () => {
  /* ---- 1: set-up --------------------------------------------------------------------------------------------- */
  {
    const { H, holder } = await world();
    const k = newCard(H, undefined, { format: 4 });
    H.nfc = k;
    holder.goFlashcard();
    await until('the new card to be read', () => !!holder.state.fc);
    const choice = JSON.stringify(H.W.walletChoice());
    const sheets = H.sheet.length;
    holder.fcSetUp();
    ok(holder.state.screen === 'currency' && holder.state.currencyFlow === 'card' && holder.state.stack.slice(-1)[0] === 'flashcard' && H.sheet.length === sheets,
       'SET UP at a mint with two balances: the CURRENCY screen first, nothing tapped yet', holder.state.screen + ' ' + holder.state.currencyFlow);
    let cv = holder.renderCurrency({ s: holder.state, sc: 'currency' });
    ok(cv.curTitle === 'CURRENCY' && cv.curQuestion === 'WHAT WILL THIS CARD HOLD?' && cv.curCards.map((x) => x.name).join() === 'DOLLARS,BITCOIN'
       && cv.curCards[0].balance === '' && cv.curCards[1].balance === '',
       'it asks WHAT WILL THIS CARD HOLD?, with the two balances and no figure on either (the phone\'s would read as the card\'s)', JSON.stringify([cv.curQuestion, cv.curCards.map((x) => x.balance)]));
    ok(/RESET the card/.test(cv.curFoot), 'and says the card holds one, changed by RESET and setting it up again', cv.curFoot);
    // back is the card's screen, with nothing tapped
    cv.curBack();
    ok(holder.state.screen === 'flashcard' && H.sheet.length === sheets && !k.state.owner, 'back from it is the card’s screen, and nothing was tapped');
    holder.fcSetUp();
    cv = holder.renderCurrency({ s: holder.state, sc: 'currency' });
    cv.curCards[0].tap();
    ok(holder.state.screen === 'flashcard', 'DOLLARS: back on the card’s screen, and the tap begins');
    await until('the card to be set up', () => !!k.state.owner && holder.state.fc && holder.state.fc.owner);
    await settle();
    ok(k.state.record.unit === 1 && holder.state.fc.unit === 'usd' && holder.toasts.indexOf('The card is set up. It holds dollars.') >= 0,
       'the card is set up in dollars: its record says 01, and the screen says so', JSON.stringify({ unit: k.state.record.unit, fc: holder.state.fc.unit }));
    ok(JSON.stringify(H.W.walletChoice()) === choice && (H.W.cardsList()[0] || {}).unit === 'usd',
       'this phone’s own remembered balances are unchanged, and its list of cards says the card holds dollars', JSON.stringify(H.W.walletChoice()));
    // BITCOIN at the same question sets one up as every card was
    const k2 = newCard(H, undefined, { format: 4 });
    H.nfc = k2;
    holder.goFlashcard();
    await until('the second card to be read', () => !!holder.state.fc && holder.state.fc.key === k2.key);
    holder.fcSetUp();
    holder.renderCurrency({ s: holder.state, sc: 'currency' }).curCards[1].tap();
    await until('the second card to be set up', () => !!k2.state.owner && holder.state.fc && holder.state.fc.owner);
    ok(k2.state.record.unit === 0 && holder.state.fc.unit === 'sat', 'BITCOIN: the card is set up in bitcoin');
    // a mint with one balance asks nothing
    const S = await funded({}, 1000);
    const one = screenOn(S, { screen: 'home' });
    const k3 = newCard(S, undefined, { format: 4 });
    S.nfc = k3;
    one.goFlashcard();
    await until('the card at a one-unit mint to be read', () => !!one.state.fc);
    one.fcSetUp();
    ok(one.state.screen === 'flashcard' && one.state.currencyFlow !== 'card', 'at a mint with one balance SET UP asks nothing: the tap at once');
    await until('that card to be set up', () => !!k3.state.owner && one.state.fc && one.state.fc.owner);
    ok(k3.state.record.unit === 0 && one.state.fc.unit === 'sat' && one.toasts.indexOf('The card is set up.') >= 0, 'in bitcoin, as every card was');
    booksGood('set-up', H, S);
  }

  /* ---- 2: the card's screen ------------------------------------------------------------------------------------ */
  const W2 = await world();
  {
    const { H, holder } = W2;
    const k = await dollarCard(H, 2000, '');
    H.nfc = k;
    holder.price = 80000;
    holder.goFlashcard();
    await until('the dollar card to be read', () => !!holder.state.fc && holder.state.fc.check !== 'asking');
    await settle();
    let v = vals(holder);
    ok(v.fcPillRows.length === 1 && v.fcPillRows[0].sym === '$' && v.fcPillRows[0].big === '20.00' && v.fcPillRows[0].ink === '#10161B'
       && v.fcPillRows[0].small === '₿ 25,000' && v.fcBalance === '$ 20.00',
       'one dollar pill, frost and dark ink: its cents big, their worth in sats under them at the price', JSON.stringify(v.fcPillRows[0] && { big: v.fcPillRows[0].big, small: v.fcPillRows[0].small }));
    ok(!v.fcButtons.some((x) => x.label === 'SWAP') && v.fcButtons.map((x) => x.label).join() === 'SCAN,PASTE', 'no SWAP in the row: the card holds one currency', v.fcButtons.map((x) => x.label).join());
    holder.price = 0;
    v = vals(holder);
    ok(v.fcPillRows[0].small === '' && v.fcPillRows[0].big === '20.00', 'with no price, nothing under the dollars');
    k.tap();
    await H.W.cardSetLimit(k, { sats: 2000, tap: true });
    k.tap();
    await H.W.cardSetLimit(k, { sats: 5000 });
    H.nfc = k;
    holder.fcRead();
    await until('the card read again', () => !!holder.state.fc && holder.state.fc.tap && holder.state.fc.tap.limited && holder.state.fc.limit === 5000);
    const line = () => vals(holder).fcLimitLine;
    // (its daily limit is not said: the card screens have none)
    const want = 'PER TAP LIMIT $20.00 | NO PIN';
    ok(line() === want, 'its per tap limit in dollars: PER TAP LIMIT $20.00, and nothing of its daily limit', line());
    holder.price = 80000;
    const at80 = line();
    holder.price = 160000;
    ok(at80 === want && line() === want && vals(holder).fcDayLeft === undefined,
       'and the same at a price and at a doubled price: a dollar is a dollar', line());
    holder.price = 0;
    booksGood('the card’s screen', H);
  }

  /* ---- 3: ADD FUNDS ---------------------------------------------------------------------------------------------- */
  {
    const { H, holder } = W2;
    holder.price = 80000;
    const k = holder._fcCard && H.nfc;
    holder.fcAdd();
    ok(holder.state.screen === 'amount' && holder.state.flow === 'cardAdd' && holder.state.unit === 'USD' && holder.usdKeypad() === true,
       'ADD FUNDS: the dollar keypad, with no ₿ toggle (`usdKeypad`)', holder.state.unit);
    holder.state.amount = '300.00';
    const ctxV = holder.renderContext();
    ok(ctxV.sendOver === true && ctxV.sendCapUsd === 200, 'its cap is this phone’s dollars: $300 is over the $200 it holds', JSON.stringify({ over: ctxV.sendOver, cap: ctxV.sendCapUsd }));
    holder.toasts.length = 0;
    holder.fcAmountNext();
    ok(holder.toasts.indexOf('You have $200.00.') >= 0 && holder.state.screen === 'amount', 'NEXT says what this phone holds, in dollars', holder.toasts.join(' | '));
    const usdBefore = usd(H), satBefore = sats(H), cardBefore = k.balance();
    holder.state.amount = '5.00';
    k.tap();
    holder.fcAmountNext();
    const ready = H.window.document.getElementById('foxy-stage');
    ok(ready && /\$ 5\.00/.test(ready.textContent), 'the stage says $ 5.00 while the pieces are made', ready && ready.textContent.slice(0, 80));
    await until('the dollars to go on', () => !!holder.state.fc && holder.state.fc.balance >= 2500 && !holder.state.fcRoll && !(holder._fcTaps > 0));
    await settle();
    ok(k.balance() - cardBefore >= 500 && sats(H) === satBefore && usdBefore - usd(H) >= 500,
       'the card holds $5.00 more, from this phone’s dollars; its bitcoin is untouched', JSON.stringify({ card: k.balance() - cardBefore, usd: usdBefore - usd(H), sat: sats(H) - satBefore }));
    const load = history(H).filter((e) => e.unit === 'usd' && e.dir === 'out' && e.card === k.key)[0];
    ok(load && load.amount >= 500 && load.sats === 0 && (H.W.tagsFor(load.hash) || {}).to === 'card', 'one dollar entry out, tagged as the card’s', JSON.stringify(load && { amount: load.amount, sats: load.sats }));
    holder.price = 0;
    booksGood('ADD FUNDS', H);
  }

  /* ---- 4: a dollar receive paid by a dollar card ----------------------------------------------------------------- */
  {
    const { H, R, till } = await world();
    const k = await dollarCard(H, 2000, '1234');
    R.nfc = k;
    await dollarReceive(till, 475, false);
    let v = screen(till);
    ok(v.recvCardShown === true && !till.state.invoice, 'CARD is there before the mint has made the code: a dollar card needs none');
    const usdBefore = usd(R), satBefore = sats(R), at = R.trace.length;
    k.tap();
    k.sent.length = 0;
    till.payByCard();
    await until('the card to want its PIN', () => !!pad(till));
    ok(pad(till).sub === 'To pay $ 4.75. The card’s owner types its PIN here.' && pad(till).cta === 'TAP AGAIN', 'the PIN pad: To pay $ 4.75.', pad(till).sub);
    ok(behind(R) && behind(R).amount === '$4.75', 'and behind the sheet, $4.75 with nothing under it', behind(R) && behind(R).amount);
    pad(till).type('1234');
    await until('PAYMENT RECEIVED', () => till.state.screen === 'paid');
    await tapDone(till, R);
    await settle();
    ok(till.state.paidUnit === 'usd' && till.state.paidAmount === 475, 'PAYMENT RECEIVED in dollars: 475 cents', JSON.stringify({ unit: till.state.paidUnit, amount: till.state.paidAmount }));
    const pv = paidVals(till);
    ok(pv.paidAddedTo === 'DOLLARS' && pv.paidHeadline === '$ 4.75' && !/BITCOIN/.test(String(pv.paidTitle) + pv.paidAddedTo),
       'ADDED TO DOLLARS, and nothing paid in bitcoin', JSON.stringify({ to: pv.paidAddedTo, head: pv.paidHeadline }));
    ok(usd(R) - usdBefore === 475 && sats(R) === satBefore && melts(R, at).length === 0 && !R.trace.slice(at).some((t) => /\/v1\/mint\//.test(t)),
       'the dollar balance rose by 475 cents, the bitcoin did not move, and no melt and no mint were asked', JSON.stringify({ usd: usd(R) - usdBefore, melts: melts(R, at) }));
    const entry = history(R).filter((e) => e.unit === 'usd' && e.dir === 'in')[0];
    ok(entry && entry.amount === 475 && entry.sats === 0 && (R.W.tagsFor(entry.hash) || {}).to === 'card payment', 'one dollar entry in, a card payment', JSON.stringify(entry && { amount: entry.amount }));
    till.dismissPaid();
    till.setState({ screen: 'history', stack: ['home'], histUnit: 'usd' });
    till.loadHistory();
    await settle();
    const hv = till.renderHistory({ s: till.state, sc: 'history' });
    const row = [].concat(...hv.historyGroups.map((g) => g.items))[0];
    ok(row && row.amtText === '+ $ 4.75' && hv.histAuditTitle === 'ADDS UP', 'its row in DOLLARS, and the dollar books add up', row && row.amtText + ' | ' + hv.histAuditTitle);
    // with the code up: the card still pays the cents, and the code is let go (nobody pays it)
    await dollarReceive(till, 100, true);
    const inv = till.state.invoiceHash;
    v = screen(till);
    ok(v.recvCardShown === true, 'with the code up, CARD as ever');
    const at2 = R.trace.length;
    k.tap();
    till.payByCard();
    ok(!!till._fcUsd && till._fcUsd.hash === inv, 'the code is held while the card is read (a bitcoin card would pay it)');
    await until('the PIN pad', () => !!pad(till));
    ok(pad(till).sub === 'To pay $ 1.00. The card’s owner types its PIN here.', 'the dollar card is asked the cents, whatever else the till asked', pad(till).sub);
    pad(till).type('1234');
    await until('PAYMENT RECEIVED', () => till.state.screen === 'paid');
    await tapDone(till, R);
    await settle();
    ok(!till._fcUsd && melts(R, at2).length === 0 && R.mint.quotes[inv].state === 'UNPAID' && till.state.paidAmount === 100,
       'paid in cents: the code is let go, unpaid, and nothing was melted', JSON.stringify({ q: R.mint.quotes[inv].state, melts: melts(R, at2) }));
    till.dismissPaid();
    till.stopReceive();
    // a confirmation held back while a card is tapped keeps its unit and its cents, and is raised as dollars (`keepForCardFlow`)
    till._fcTaps = 1;
    till.keepForCardFlow({ dir: 'in', sats: 0, unit: 'usd', amount: 475, hash: 'held-usd-1' });
    till._fcTaps = 0;
    till.nextPaidScreen();
    await until('the held confirmation', () => till.state.screen === 'paid');
    ok(till.state.paidUnit === 'usd' && till.state.paidAmount === 475 && paidVals(till).paidHeadline === '$ 4.75',
       'a confirmation held for a card flow is raised in dollars, with its cents', JSON.stringify({ unit: till.state.paidUnit, amount: till.state.paidAmount }));
    till.dismissPaid();
    const au = await audits(till);
    ok(au.sat === 0 && au.usd === 0, 'the app’s books add up in both units', JSON.stringify(au));
    booksGood('a dollar card at a dollar receive', H, R);
  }

  /* ---- 5: a bitcoin card at a dollar receive before the code ----------------------------------------------------- */
  {
    const { H, R, till } = await world();
    const k = await satCard(H, 3000, '1234');
    R.nfc = k;
    await dollarReceive(till, 100, false);
    k.tap();
    k.sent.length = 0;
    till.payByCard();
    await until('the card to be refused', () => !!card(till));
    ok(card(till).title === 'THIS CARD HOLDS BITCOIN' && card(till).reason === 'This card holds bitcoin. Tap it again when the dollar code is on screen, and it pays that.'
       && card(till).has('Nothing was taken.') && !pad(till) && !signed(k) && k.balance() === 3000,
       'a bitcoin card before the code: tap again when it is up, said before its PIN and before it signs', card(till).all);
    card(till).press('CLOSE');
    till.stopReceive();
    booksGood('a bitcoin card before the dollar code', H, R);
  }

  /* ---- 6: a dollar card at a bitcoin receive, online --------------------------------------------------------------- */
  {
    const { H, R, till } = await world();
    const k = await dollarCard(H, 2000, '');
    R.nfc = k;
    const q = await bitcoinReceive(till, R, 7000);
    const usdBefore = usd(R), satBefore = sats(R), cardBefore = k.balance();
    k.tap();
    k.sent.length = 0;
    till.payByCard();
    await until('the figure to be asked of the mint and said', () => !!card(till));
    ok(card(till).title === 'THIS CARD HOLDS DOLLARS' && /^They asked for ₿ 7,000\. At m\.test’s rate, that is \$ \d+\.\d\d with its fee\. Tapping the card again pays \$ \d+\.\d\d\.$/.test(card(till).reason)
       && !signed(k) && k.balance() === cardBefore,
       'the first tap reads the card and nothing more: the mint’s figure for the sats asked, in dollars, to agree to', card(till).reason);
    const cents = Math.round(Number(/pays \$ (\d+\.\d\d)/.exec(card(till).reason)[1]) * 100);
    R.sheet.length = 0;
    k.tap();
    card(till).press('TAP CARD');
    await until('the card to pay and the invoice to be paid', () => R.mint.quotes[q.hash].state === 'PAID' || R.mint.quotes[q.hash].state === 'ISSUED');
    await tapDone(till, R);
    await settle();
    ok(/^begin: Hold to pay \$ /.test(R.sheet[0] || ''), 'the sheet says what the hold pays', R.sheet[0]);
    ok(cardBefore - k.balance() >= cents && R.mint.quotes[q.hash].state === 'PAID', 'the card paid the cents agreed, and they paid this phone’s own invoice', JSON.stringify({ card: cardBefore - k.balance(), cents }));
    await R.W.claim(q.hash);
    await settle();
    ok(sats(R) - satBefore === 7000 && converts(R).length === 0, 'the sats asked are what arrived, and nothing is left to convert', JSON.stringify({ sat: sats(R) - satBefore, usd: usd(R) - usdBefore }));
    const cardIn = history(R).filter((e) => e.unit === 'usd' && e.dir === 'in' && e.memo === 'card')[0];
    ok(!!cardIn && !!till.seen[cardIn.hash], 'the dollars’ own entry is not announced: the sats are');
    booksGood('a dollar card at a bitcoin receive, online', H, R);
  }

  /* ---- 6b: the same, and the mint will not pay the invoice: the cents stay dollars, and it is said ---------------------- */
  {
    const { H, R, till } = await world({ mintOpts: { meltRefuse: true } });
    const k = await dollarCard(H, 2000, '');
    R.nfc = k;
    const q = await bitcoinReceive(till, R, 7000);
    const usdBefore = usd(R), satBefore = sats(R);
    k.tap();
    till.payByCard();
    await until('the figure', () => !!card(till));
    const cents = Math.round(Number(/pays \$ (\d+\.\d\d)/.exec(card(till).reason)[1]) * 100);
    k.tap();
    card(till).press('TAP CARD');
    await until('PAID IN DOLLARS', () => card(till) && card(till).title === 'PAID IN DOLLARS');
    await tapDone(till, R);
    await settle();
    ok(new RegExp('^The card paid \\$ ' + (cents / 100).toFixed(2).replace('.', '\\.') + ', and the mint did not turn it into bitcoin\\. .* It is in your dollar balance\\.$').test(card(till).reason),
       'PAID IN DOLLARS: what the card paid, that no bitcoin was made, and where the money is', card(till).reason);
    ok(usd(R) - usdBefore === cents && sats(R) === satBefore && R.mint.quotes[q.hash].state === 'UNPAID' && converts(R).length === 0,
       'the cents are in the dollar balance, the invoice is unpaid, and nothing is queued to swap them (SWAP is the person’s)', JSON.stringify({ usd: usd(R) - usdBefore, cents }));
    shut(till);
    booksGood('a dollar card at a bitcoin receive, the melt refused', H, R);
  }

  /* ---- 7: offline, a dollar card at a dollar receive ----------------------------------------------------------------- */
  {
    const { H, R, till } = await world();
    const k = await dollarCard(H, 2000, '');
    R.nfc = k;
    offline(R);
    await dollarReceive(till, 100, false);
    ok(screen(till).recvCardShown === true, 'with no route, CARD is there for a dollar receive');
    let lastPrice = 0;
    const realPrice = R.W.lastPrice;
    R.W.lastPrice = () => { lastPrice += 1; return realPrice.call(R.W); };
    const choice = JSON.stringify(R.W.walletChoice());
    k.tap();
    till.payByCard();
    await until('the payment to be kept', () => R.W.cardKeptWaiting().length === 1);
    await tapDone(till, R);
    await settle();
    /* (the till reads its price once, to ask a bitcoin card for sats as well where it can: it cannot know before the tap which
     * kind of card is held up; the dollar card's payment uses none of it. And once more, for the till cap, which holds what is
     * unsettled in dollars and in sats against one figure (07-request-delivery.js, `tillRefusal`): never for the payment's own) */
    ok(till.toasts.indexOf('Paid by card while this phone is offline. Foxy settles it with the mint when it is online.') >= 0 && lastPrice <= 2,
       'the card signed its cents over: received, and said so', String(lastPrice));
    const kept = R.W.cardKeptWaiting()[0];
    const keptRec = R.W.cardKept ? R.W.cardKept(kept.id) : null;
    const keptEntry = history(R).filter((e) => e.unit === 'usd' && e.dir === 'in')[0];
    ok(kept.unit === 'usd' && kept.amount === 100 && kept.sats === 0 && !(keptRec && keptRec.terms) && keptEntry && !keptEntry.askRate && !keptEntry.usdAsked && !keptEntry.convert,
       'kept in dollars: 100 cents, with no price and nothing to convert in the record or the entry', JSON.stringify({ kept, terms: keptRec && keptRec.terms }));
    let au = await audits(till);
    ok(au.sat === 0 && au.usd === 0, 'the books add up while it waits', JSON.stringify(au));
    till.setState({ screen: 'history', stack: ['home'], histUnit: 'usd' });
    till.loadHistory();
    await settle();
    const row = [].concat(...till.renderHistory({ s: till.state, sc: 'history' }).historyGroups.map((g) => g.items)).filter((r) => /\$ 1\.00/.test(r.amtText))[0];
    ok(row && row.metaRail === 'Paid by card · settles online', 'its row in DOLLARS says it settles online', row && row.metaRail);
    const usdBefore = usd(R);
    online(R);
    await R.W.claimUnclaimed();
    await settle();
    ok(R.W.cardKeptWaiting().length === 0 && usd(R) === usdBefore && converts(R).length === 0 && JSON.stringify(R.W.walletChoice()) === choice,
       'online, it settles into the dollar pile, nothing is converted, and nothing is remembered from it', JSON.stringify({ usd: usd(R), converts: converts(R).length }));
    R.W.lastPrice = realPrice;
    au = await audits(till);
    ok(au.sat === 0 && au.usd === 0, 'and the books add up once it has', JSON.stringify(au));
    booksGood('offline, a dollar card at a dollar receive', H, R);
  }

  /* ---- 8: offline, a dollar card at a bitcoin receive ---------------------------------------------------------------- */
  {
    const { H, R, till } = await world();
    const k = await dollarCard(H, 3000, '1234');
    R.nfc = k;
    R.W.setWalletChoice({ hold: 'bitcoin' });
    const choice = JSON.stringify(R.W.walletChoice());
    offline(R);
    R.W._rate = 84571; R.W._rateAt = Date.now() - 2 * HOUR;
    await bitcoinReceive(till, R, 7000, { code: false });
    const cardBefore = k.balance();
    k.tap();
    k.sent.length = 0;
    till.payByCard();
    await until('the PIN pad', () => !!pad(till));
    ok(pad(till).sub === 'To pay ₿ 7,000 for $ 5.92 at this phone’s price, seen 2 hours ago. The card’s owner types its PIN here.' && !signed(k),
       'tap one reads the card: the PIN pad says both figures and how old this phone’s price is', pad(till).sub);
    pad(till).type('1234');
    await until('the payment to be kept', () => R.W.cardKeptWaiting().length === 1);
    await tapDone(till, R);
    await until('PAYMENT RECEIVED', () => till.state.screen === 'paid');
    await settle();
    const kept = R.W.cardKeptWaiting()[0];
    ok(kept.unit === 'usd' && kept.amount === 592 && cardBefore - k.balance() >= 592, 'tap two pays 592 cents, kept in dollars', JSON.stringify(kept));
    const pv = paidVals(till);
    ok(pv.paidHeadline === '₿ 7,000' && pv.paidHeadlineSub === '$ 5.92 · THIS PHONE’S PRICE 2 HOURS AGO' && pv.paidAddedTo === 'DOLLARS, THEN BITCOIN',
       'PAYMENT RECEIVED: the sats asked, the dollars that came at this phone’s price, and dollars then bitcoin', JSON.stringify([pv.paidHeadline, pv.paidHeadlineSub, pv.paidAddedTo]));
    const entry = history(R).filter((e) => e.unit === 'usd' && e.dir === 'in')[0];
    ok(entry && entry.satsAsked === 7000 && entry.askOwn === true && entry.convert === 'owed' && entry.askRate === 84571 && entry.amount === 592 && entry.sats === 0,
       'the entry is dollars, with the sats asked, this phone’s price, and owed a swap into bitcoin', JSON.stringify(entry && { satsAsked: entry.satsAsked, own: entry.askOwn, convert: entry.convert }));
    till.dismissPaid();
    till.loadHistory();
    await settle();
    const tx = [].concat(...till.state.history.map((g) => g.items)).filter((t) => t.hash === entry.hash)[0];
    const d = till.renderTxDetail({ s: till.state, sc: 'txDetail', tx });
    ok(d.txAskShown && d.txAsked === '₿ 7,000' && d.txAskPriceHead === 'THIS PHONE’S PRICE' && d.txConvertShown && d.txConverted === 'Once online',
       'its detail: ASKED ₿ 7,000, THIS PHONE’S PRICE, swapped into bitcoin once online', JSON.stringify([d.txAsked, d.txAskPriceHead, d.txConverted]));
    const two = till.histRowTwo(Object.assign({}, tx, { cardWaits: false }), 'usd', new Map(), () => '', new Map());
    ok(two.amtSub === 'Asked ₿ 7,000' && two.metaRail === 'To be swapped into bitcoin once online', 'its row: Asked ₿ 7,000, to be swapped once online', JSON.stringify(two));
    const done = till.histRowTwo(Object.assign({}, tx, { cardWaits: false, convert: 'done', convertSats: 6961 }), 'usd', new Map(), () => '', new Map());
    ok(done.amtSub === 'Asked ₿ 7,000' && done.metaRail === 'Swapped into ₿ 6,961', 'and once swapped: Asked ₿ 7,000 · Swapped into ₿ 6,961', done.metaRail);
    const waits = till.histRowTwo(Object.assign({}, tx, { cardWaits: true }), 'usd', new Map(), () => '', new Map());
    ok(waits.metaRail === undefined, 'while the card’s payment waits, its own words win (`cardWaits`)', String(waits.metaRail));
    ok(JSON.stringify(R.W.walletChoice()) === choice, 'nothing remembers dollars as the next receive', JSON.stringify(R.W.walletChoice()));
    let au = await audits(till);
    ok(au.sat === 0 && au.usd === 0, 'the books add up while it waits', JSON.stringify(au));

    // no PIN expected: the card that says the figure, and TAP CARD
    const k2 = await dollarCard(H, 3000, '');
    R.nfc = k2;
    await bitcoinReceive(till, R, 7000, { code: false });
    k2.tap();
    k2.sent.length = 0;
    till.payByCard();
    await until('THIS CARD HOLDS DOLLARS', () => !!card(till));
    ok(card(till).title === 'THIS CARD HOLDS DOLLARS'
       && card(till).reason === 'They asked for ₿ 7,000. At this phone’s Bitcoin price, ₿ 1 = $ 84,571, seen 2 hours ago, that is $ 5.92. Tapping the card again pays $ 5.92.'
       && card(till).has('TAP CARD') && !signed(k2),
       'a card with no PIN: the figure, the price and its age, and TAP CARD', card(till).reason);
    R.sheet.length = 0;
    k2.tap();
    card(till).press('TAP CARD');
    await until('the second tap’s screen', () => !!behind(R));
    ok(behind(R).amount === '$ 5.92' && /^begin: Hold to pay \$ 5\.92$/.test(R.sheet[0] || ''), 'the tap says $ 5.92, and the sheet Hold to pay $ 5.92', behind(R).amount + ' | ' + R.sheet[0]);
    await until('the second payment to be kept', () => R.W.cardKeptWaiting().length === 2);
    await tapDone(till, R);
    await settle();
    if (till.state.screen === 'paid') till.dismissPaid();

    // another card held up for the second tap, one that holds bitcoin: nothing taken, and said
    const kd = await dollarCard(H, 3000, '');
    const ks = await satCard(H, 3000, '');
    R.nfc = kd;
    await bitcoinReceive(till, R, 7000, { code: false });
    kd.tap();
    till.payByCard();
    await until('THIS CARD HOLDS DOLLARS', () => !!card(till));
    R.nfc = ks;
    ks.tap();
    ks.sent.length = 0;
    card(till).press('TAP CARD');
    await until('the other card to be refused', () => card(till) && card(till).title === 'THIS CARD HOLDS BITCOIN');
    ok(card(till).reason === 'This is not the dollar card that was tapped first. It holds bitcoin: press CARD again, and it pays the bitcoin asked.'
       && card(till).has('Nothing was taken.') && !signed(ks) && ks.balance() === 3000,
       'a bitcoin card held up for the dollar card’s second tap is refused, before it signs', card(till).all);
    shut(till);
    R.nfc = k2;

    // typed in dollars: the cents typed, exactly
    const k3 = await dollarCard(H, 3000, '');
    R.nfc = k3;
    await bitcoinReceive(till, R, 7001, { code: false, unit: 'USD', amount: '5.92' });
    k3.tap();
    till.payByCard();
    await until('THIS CARD HOLDS DOLLARS', () => !!card(till));
    ok(/that is \$ 5\.92\./.test(card(till).reason), 'typed in dollars, the card is asked the cents typed, not a figure turned round twice', card(till).reason);
    card(till).press('CANCEL');

    // a price over a day old, or none, or no dollar keys seen: refused at the first tap
    R.W._rateAt = Date.now() - 25 * HOUR;
    k3.tap(); k3.sent.length = 0;
    till.payByCard();
    await until('the old price', () => !!card(till));
    ok(card(till).title === 'BITCOIN PRICE TOO OLD' && card(till).reason === 'This phone last saw the Bitcoin price 1 day ago. That is too old to work out what to take from the card.' && !signed(k3),
       'a price 25 hours old: BITCOIN PRICE TOO OLD, nothing taken', card(till).reason);
    shut(till);
    R.W._rate = 0; R.W._rateAt = 0;
    k3.tap();
    till.payByCard();
    await until('no price', () => !!card(till));
    ok(card(till).title === 'NO BITCOIN PRICE' && /never seen the Bitcoin price/.test(card(till).reason), 'no price: NO BITCOIN PRICE', card(till).reason);
    shut(till);
    R.W._rate = 84571; R.W._rateAt = Date.now() - 2 * HOUR;
    const realKeys = R.W.unitKeysOffline;
    R.W.unitKeysOffline = () => false;
    k3.tap();
    till.payByCard();
    await until('no dollar keys', () => !!card(till));
    ok(card(till).title === 'CARD NOT TAKEN' && /not seen the mint’s dollar keys/.test(card(till).reason) && /Nothing was taken/.test(card(till).all),
       'dollar keys not seen: CARD NOT TAKEN, nothing taken', card(till).all);
    shut(till);
    R.W.unitKeysOffline = realKeys;
    // a share of a split bill: refused in the card's words
    till.fcOtherUnit({ card: 'other-unit', unit: 'usd', message: 'This card holds dollars here, not bitcoin.', mint: MINT }, 7000, true, { idx: 0, hash: 'x' });
    ok(card(till) && card(till).title === 'THIS CARD HOLDS DOLLARS' && card(till).reason === 'This card holds dollars here, not bitcoin.' && card(till).has('Nothing was taken.'),
       'a share of a split bill is refused: This card holds dollars here, not bitcoin.', card(till) && card(till).all);
    shut(till);

    // holding both: kept as dollars, and the screen says it was paid in dollars
    R.W.setWalletChoice({ hold: 'both' });
    const k4 = await dollarCard(H, 3000, '');
    R.nfc = k4;
    await bitcoinReceive(till, R, 7000, { code: false });
    k4.tap();
    till.payByCard();
    await until('THIS CARD HOLDS DOLLARS', () => !!card(till));
    k4.tap();
    card(till).press('TAP CARD');
    await until('PAYMENT RECEIVED', () => till.state.screen === 'paid');
    await tapDone(till, R);
    await settle();
    const pv2 = paidVals(till);
    ok(pv2.paidHeadline === '$ 5.92' && pv2.paidHeadlineSub === 'Paid in dollars: $ 5.92 for ₿ 7,000' && pv2.paidAddedTo === 'DOLLARS',
       'holding both: PAYMENT RECEIVED $ 5.92, "Paid in dollars: $ 5.92 for ₿ 7,000", into DOLLARS', JSON.stringify([pv2.paidHeadline, pv2.paidHeadlineSub, pv2.paidAddedTo]));
    const both = history(R).filter((e) => e.unit === 'usd' && e.dir === 'in')[0];
    ok(both && both.satsAsked === 7000 && !both.convert, 'its entry keeps the sats asked, and owes no swap', JSON.stringify(both && { convert: both.convert }));
    till.dismissPaid();
    au = await audits(till);
    ok(au.sat === 0 && au.usd === 0, 'the books add up', JSON.stringify(au));
    online(R);
    R.W.setWalletChoice({ hold: 'bitcoin' });
    // the swap into bitcoin is the wallet's (tests/convert-on-return.js): here the claims land, and the books are judged after
    R.W.convertOne = () => Promise.resolve(null);
    await R.W.claimUnclaimed();
    await settle();
    booksGood('offline, a dollar card at a bitcoin receive', H, R);
  }

  /* ---- 9: CHANGE LIMIT on a dollar card --------------------------------------------------------------------------- */
  {
    const { H, holder } = W2;
    const k = H.nfc;
    const asked = [];
    const real = H.W.cardSetLimit;
    H.W.cardSetLimit = (link, o) => { asked.push(Object.assign({}, o, { on: undefined, progress: undefined })); return real.call(H.W, link, o); };
    holder.price = 80000;
    holder.fcSetLimit();
    // (the per tap limit: the card screens set no daily limit)
    card(holder).press('PER TAP LIMIT');
    if (explainer(holder)) { explainer(holder).finish(); explainer(holder).press('CONTINUE'); } else card(holder).press('CONTINUE');
    ok(holder.state.screen === 'amount' && holder.state.flow === 'cardLimit' && holder.state.unit === 'USD' && holder.usdKeypad() === true, 'the dollar keypad');
    holder.state.amount = '20.00';
    holder.fcAmountNext();
    const sp = holder.fcLimitSpec();
    ok(holder.state.fcLimit.sats === 2000 && holder.state.fcLimit.usd === 0 && sp.amount === '$ 20.00' && sp.amountSub === '' && !/kept at/.test(sp.warn),
       'the confirmation: $ 20.00, nothing under it, and no "kept at this many dollars"', JSON.stringify([sp.amount, sp.amountSub, sp.warn]));
    k.tap();
    sp.go();
    await until('the limit to be set', () => asked.length === 1 && !(holder._fcTaps > 0));
    await settle();
    ok(asked[0].sats === 2000 && asked[0].usd === 0 && asked[0].tap === true && k.state.tapLimit === 2000, 'the card’s limit on one tap is set to 2,000 cents, and no dollars are sent to keep it at', JSON.stringify(asked[0]));
    H.W.cardSetLimit = real;
    k.tap();
    await H.W.cardSetLimit(k, { sats: 0, tap: true });
    holder.price = 0;
  }

  /* ---- 10: WITHDRAW ------------------------------------------------------------------------------------------------ */
  {
    const { H, holder } = W2;
    const k = H.nfc;
    holder.setState({ screen: 'flashcard', stack: ['home'] });
    holder.fcRead();
    await until('the card read', () => !!holder.state.fc && holder.state.fc.check !== 'asking' && !(holder._fcTaps > 0));
    await settle();
    const has = holder.state.fc.balance;
    holder.fcWithdraw();
    ok(holder.state.flow === 'cardWd' && holder.state.unit === 'USD' && holder.usdKeypad(), 'WITHDRAW: the dollar keypad');
    holder.state.amount = String(has / 100 + 1);
    ok(holder.renderContext().sendCapUsd === has / 100 && holder.renderContext().sendOver === true, 'capped by the card’s cents', String(holder.renderContext().sendCapUsd));
    holder.state.amount = '3.00';
    const usdBefore = usd(H);

    k.tap();
    holder.fcAmountNext();
    await until('the money to come off', () => !!holder.state.fc && holder.state.fc.balance === has - 300 && !holder.state.fcRoll && !(holder._fcTaps > 0));
    await settle();
    const wd = history(H).filter((e) => e.unit === 'usd' && e.dir === 'in' && e.memo === 'from card')[0];
    ok(usd(H) - usdBefore > 290 && usd(H) - usdBefore <= 300 && wd && (H.W.tagsFor(wd.hash) || {}).to === 'card' && holder.state.screen === 'flashcard',
       '$3.00 off the card into this phone’s dollars, less the mint’s fee, as the holder’s own move (not announced)', JSON.stringify({ usd: usd(H) - usdBefore }));
    ok(!card(holder), 'and nothing is raised over the card’s screen: its balance counts down', card(holder) && card(holder).all);
    shut(holder);
    booksGood('WITHDRAW', H);
  }

  /* ---- 11: SWITCH MINT with money on a dollar card ------------------------------------------------------------------ */
  {
    const { H, holder } = W2;
    const at = H.trace.length;
    holder.fcSwitchMint();
    ok(card(holder) && card(holder).title === 'A DOLLAR CARD'
       && card(holder).reason === 'This card holds dollars at m.test. Take them off with WITHDRAW, switch, and load it again at the new mint.'
       && H.trace.length === at && holder.state.screen === 'flashcard',
       'SWITCH MINT: A DOLLAR CARD, and nothing asked of any mint', card(holder) && card(holder).all);
    shut(holder);
  }

  /* ---- 12: SEND from a dollar card ---------------------------------------------------------------------------------- */
  {
    const { H, holder } = W2;
    const k = H.nfc;
    const upd = () => { holder.syncCardOut(); holder.syncSend(); };
    holder.setState({ screen: 'flashcard', stack: ['home'], sendFrom: '' });
    holder.fcRead();
    await until('the card read', () => !!holder.state.fc && holder.state.fc.check !== 'asking' && !(holder._fcTaps > 0));
    await settle();
    const before = k.balance(), satBefore = sats(H);
    vals(holder).fcSend();
    upd();
    ok(holder.cardSendNow() && holder.walletNow('send') === 'usd', 'in card mode a dollar card pays in dollars');
    const q = await H.mint.handle({ url: MINT + '/v1/mint/quote/bolt11', method: 'POST', body: JSON.stringify({ amount: 2000, unit: 'sat' }) });
    const bolt11 = JSON.parse(String(q).replace(/^\d+\n/, '')).request;
    holder._quotedFor = null;
    holder.acceptTarget(bolt11);
    upd();
    await until('the fee to be quoted', () => holder.state.quotedFee != null || (!holder.state.quotingFee && holder.state.screen !== 'sendConfirm'));
    upd();
    ok(holder.state.screen === 'sendConfirm' && !!holder._feeQuote && holder._feeQuote.unit === 'usd', 'straight to its confirmation, with the fee asked in dollars', JSON.stringify(holder._feeQuote && holder._feeQuote.unit));
    const sp = holder.confirmSpec();
    const rows = sp.rows.map((r) => r.label);
    const rate = sp.rows.filter((r) => r.label === 'RATE')[0];
    const fee = sp.rows.filter((r) => r.label === 'FEE')[0];
    ok(!sp.wallet && sp.cta === 'NEXT' && rows.indexOf('FROM') >= 0 && !!rate && /^₿ 1 = \$ [\d,]+ · m\.test’s rate$/.test(rate.value)
       && /^UP TO \$ \d+\.\d\d$/.test(fee.value) && /^\$ \d+\.\d\d$/.test(sp.amount) && sp.amountSub === '₿ 2,000',
       'FROM FLASHCARD, the fee in dollars, the mint’s RATE, the dollars it costs over the sats paid, and NEXT', JSON.stringify([sp.amount, sp.amountSub, fee.value, rate && rate.value]));
    const at = H.trace.length;
    k.tap();
    sp.go();
    // (made: the sending screen settles, and the history pass raises its confirmation over it)
    await until('the payment to be made', () => holder.state.screen === 'paid' || (holder.state.screen === 'sendDone' && holder.state.sendPhase === 'settled'));
    await until('the tap to be over', () => !(holder._fcTaps > 0));
    await settle();
    if (holder.state.screen === 'paid') {
      ok(holder.state.payOut && holder.state.paidUnit === 'usd', 'its confirmation is a payment out, in dollars', JSON.stringify({ out: holder.state.payOut, unit: holder.state.paidUnit }));
      holder.dismissPaid();
    }
    const out = history(H).filter((e) => e.dir === 'out' && e.fromCard === k.key)[0];
    ok(out && out.unit === 'usd' && out.sats === 0 && sats(H) === satBefore && before - k.balance() > 0,
       'NEXT pays by a melt of the card’s dollars: a dollar entry, paid from the card, and this phone’s bitcoin untouched', JSON.stringify(out && { unit: out.unit, amount: out.amount }));
    ok(H.trace.slice(at).some((t) => /\/v1\/melt\/bolt11/.test(t)), 'one melt');
    holder.setState({ screen: 'home', stack: [], sendPhase: null });
    upd();
    // a bitcoin address: the card's words, and nothing asked of the mint
    holder.setState({ screen: 'flashcard', stack: ['home'], sendFrom: '' });
    holder.fcRead();
    await until('the card read', () => !!holder.state.fc && !(holder._fcTaps > 0));
    vals(holder).fcSend();
    upd();
    const at2 = H.trace.length;
    holder.fcOutAddress('bc1qexampleaddress');
    ok(card(holder) && card(holder).title === 'THAT WON’T WORK'
       && card(holder).reason === 'A dollar card pays Lightning invoices. To pay a bitcoin address, WITHDRAW to this phone and pay it from your bitcoin.'
       && card(holder).has('Nothing was taken from the card.') && H.trace.length === at2,
       'a bitcoin address from a dollar card: THAT WON’T WORK, in the card’s words', card(holder) && card(holder).all);
    shut(holder);
    holder.setState({ screen: 'home', stack: [], sendFrom: '' });
    booksGood('SEND from a dollar card', H);
  }

  /* ---- 13: the card's own history -------------------------------------------------------------------------------------- */
  {
    const { H, holder } = W2;
    holder.setState({ screen: 'flashcard', stack: ['home'] });
    holder.fcRead();
    await until('the card read', () => !!holder.state.fc && !(holder._fcTaps > 0));
    await settle();
    holder.fcHistory();
    holder.loadHistory();
    await settle();
    const hv = holder.renderHistory({ s: holder.state, sc: 'history' });
    const items = [].concat(...hv.historyGroups.map((g) => g.items));
    ok(items.length >= 3 && items.every((r) => /^[+−]\$ \d+\.\d\d$/.test(r.amtText) && r.amtSub === '') && !hv.histTabsShown,
       'the card’s list is in dollars: every row its cents, nothing under them, no tabs', JSON.stringify(items.map((r) => r.amtText)));
    ok(holder.histAuditUsd().off === 0 && holder.histAudit().off === 0, 'and the books add up in both units');
  }

  /* ---- 14: the error map ----------------------------------------------------------------------------------------------- */
  {
    const { holder } = W2;
    const said = (e, o) => { holder.fcFailed(e, o); const c = card(holder); const all = c ? c.all : ''; const t = c ? c.title : ''; const r = c ? c.reason : '';
      shut(holder); return { t, r, all }; };
    let x = said({ card: 'wrong-unit', cardUnit: 'usd', message: 'This card holds dollars, so it is paid with the dollars wallet.' }, { paying: true, taken: true });
    ok(x.t === 'THIS CARD HOLDS DOLLARS' && x.r === 'This card holds dollars here, not bitcoin. Ask for dollars, and it pays.' && /Nothing was taken\./.test(x.all),
       'wrong-unit, a dollar card at a till taking bitcoin', x.all);
    x = said({ card: 'wrong-unit', cardUnit: 'sat', message: 'This card holds bitcoin here, not dollars.' }, { paying: true, taken: true, dollarAsk: true, offline: true, usd: { cents: 100, satsWhy: 'build' } });
    ok(x.t === 'THIS CARD HOLDS BITCOIN' && /A phone that is offline takes dollars only from a dollar card/.test(x.r) && /Nothing was taken\./.test(x.all), 'wrong-unit, a bitcoin card offline', x.all);
    x = said({ card: 'wrong-unit', cardUnit: 'sat', message: 'This card holds bitcoin here, not dollars.' }, { paying: true, taken: true, dollarAsk: true, codeUp: false, usd: { cents: 100 } });
    ok(x.t === 'THIS CARD HOLDS BITCOIN' && /Tap it again when the dollar code is on screen/.test(x.r), 'wrong-unit, a bitcoin card before the code', x.all);
    x = said({ card: 'wrong-unit', cardUnit: 'usd', askUnit: 'sat', message: 'This card holds dollars, so it is loaded from your dollars.' }, {});
    ok(x.t === 'THIS CARD HOLDS DOLLARS' && x.r === 'This card holds dollars, so it is loaded from your dollars.' && /Nothing was taken\./.test(x.all), 'wrong-unit, a load typed in the other unit: the wallet’s words', x.all);
    x = said({ card: 'no-dollars-here', cardUnit: 'usd', message: 'm.test does not issue dollars now, so this card cannot be used here.' }, { paying: true, taken: true });
    ok(x.t === 'NO DOLLARS AT THIS MINT' && /does not issue dollars/.test(x.r) && /Nothing was taken\./.test(x.all), 'no-dollars-here', x.all);
    x = said({ card: 'other-unit', unit: 'usd', message: 'This card holds dollars here, not bitcoin.' }, { paying: true, taken: true });
    ok(x.t === 'THIS CARD HOLDS DOLLARS' && x.r === 'This card holds dollars here, not bitcoin.' && /Nothing was taken\./.test(x.all), 'other-unit', x.all);
    x = said({ card: 'offline-no-keys', cardUnit: 'usd', message: 'This phone has not seen the mint’s dollar keys yet, so it cannot check a dollar card while offline.' }, { paying: true, taken: true });
    ok(x.t === 'CARD NOT TAKEN' && /Nothing was taken\./.test(x.all), 'offline-no-keys', x.all);
    x = said({ card: 'not-enough', cardUnit: 'usd', balance: 475 }, { taken: true });
    ok(x.r === 'It holds $ 4.75. Nothing was taken.', 'not-enough in dollars', x.r);
    x = said({ card: 'limit', cardUnit: 'usd', left: 300, limit: 2000, turns: 0 }, { taken: true });
    ok(/\$20\.00 in a day/.test(x.r), 'a daily limit in dollars', x.r);
  }

  /* ---- 15: convert-on-return's words, and CARDS YOU LOADED ----------------------------------------------------------- */
  {
    const { R, till } = W2.R ? W2 : await world();
    const runs = [];
    const real = { one: R.W.convertOne, owed: R.W.convertsOwed };
    const answer = (stageRec, out) => { R.W.convertOne = (onStage) => { onStage('start', stageRec, null); runs.push(stageRec); return Promise.resolve(out); }; };
    R.W.convertsOwed = () => [{}];
    online(R);
    till.setState({ screen: 'home', stack: [] });
    till.toasts.length = 0;
    answer({ from: 'usd', to: 'sat', got: 592 }, { outcome: 'failed', id: 'a', from: { unit: 'usd', amount: 592 }, to: { unit: 'sat', amount: 0 } });
    till.convertOnReturn(true);
    await settle();
    ok(till.toasts[0] === 'You chose bitcoin, so Foxy is swapping the $ 5.92 you were paid into bitcoin.'
       && till.toasts[1] === 'Foxy could not swap the $ 5.92 into bitcoin just now. It stays as dollars.',
       'dollars into bitcoin: the start and the failure, in dollars', JSON.stringify(till.toasts));
    till.toasts.length = 0;
    till.setState({ screen: 'history' });
    answer({ from: 'usd', to: 'sat', got: 592 }, { outcome: 'pending', id: 'b', from: { unit: 'usd', amount: 592 }, to: { unit: 'sat', amount: 0 } });
    till.convertOnReturn(true);
    await settle();
    ok(till.toasts[1] === 'The swap into bitcoin is still going through. Foxy finishes it by itself.', 'pending, away from home', JSON.stringify(till.toasts));
    till.toasts.length = 0;
    // sats into dollars, as it always was (and a record from before records said their units)
    answer({ got: 5950 }, { outcome: 'failed', id: 'c', from: { unit: 'sat', amount: 5950 }, to: { unit: 'usd', amount: 0 } });
    till.convertOnReturn(true);
    await settle();
    ok(till.toasts[0] === 'You chose dollars, so Foxy is swapping the ₿ 5,950 you were paid into dollars.'
       && till.toasts[1] === 'Foxy could not swap the ₿ 5,950 into dollars just now. It stays as bitcoin.',
       'sats into dollars: the words as they always were', JSON.stringify(till.toasts));
    R.W.convertOne = real.one;
    R.W.convertsOwed = real.owed;
    // a card payment that did not settle, in dollars
    till.cardKeptLostCard({ unit: 'usd', amount: 592, sats: 0, cause: 'spent', date: 0 });
    ok(card(till) && /the \$ 5\.92 this card paid/.test(card(till).reason), 'a dollar card’s payment that did not settle is said in dollars', card(till) && card(till).reason);
    shut(till);
    // CARDS YOU LOADED: a dollar card's row in dollars
    const { H, holder } = W2;
    holder.setState({ screen: 'flashcard', stack: ['home'], fc: null });
    holder._fcCard = null;
    const rows = vals(holder).fcRows;
    const mine = rows.filter((r) => r.name === holder.fcName(H.nfc.key))[0];
    ok(mine && /^\$ \d+\.\d\d when last seen$/.test(mine.sub), 'CARDS YOU LOADED: a dollar card’s row in dollars', mine && mine.sub);
    mine.tap();
    ok(card(holder) && /^\$ \d+\.\d\d when this phone last saw it\./.test(card(holder).reason), 'and opened, in dollars', card(holder) && card(holder).reason);
    shut(holder);
    booksGood('the last of it', W2.H);
  }

  /* ---- 16: SEND from a dollar card, its change not put back in the sheet ------------------------------------------- */
  {
    const { holder } = await world();
    const realOwed = holder.fcOwedAfterPaying;
    holder.fcOwedAfterPaying = () => true;
    for (const unit of ['usd', 'sat']) {
      let o = null;
      holder.startSendNow = (to, x) => { o = x; };
      const fig = (n) => (unit === 'usd' ? { unit, amount: n, sats: 0 } : { unit, amount: n, sats: n });
      const send = { to: 'lnbc1', key: '02ab', unit };
      holder.fcOutPay(Object.assign({ hash: 'card-a' + unit, held: 'cardout-a' + unit, change: Object.assign(fig(28), { written: false }) }, fig(500)), send, 500);
      holder.fcOutSettled(o, true);
      const said = unit === 'usd' ? '$ 0.28' : '₿28';
      ok(o && o.change === 28 && o.unit === unit && card(holder) && card(holder).title === 'TAP TO RECEIVE' && card(holder).reason.indexOf('its ' + said + ' of change') >= 0,
         'SEND from a ' + (unit === 'usd' ? 'dollar' : 'bitcoin') + ' card, change left for later: TAP TO RECEIVE, its ' + said + ' of change', JSON.stringify({ change: o && o.change, card: card(holder) && card(holder).reason }));
      shut(holder);
      o = null;
      holder.fcOutPay(Object.assign({ hash: 'card-b' + unit, held: 'cardout-b' + unit, change: Object.assign(fig(28), { written: false, unmade: true }) }, fig(500)), send, 500);
      holder.fcOutSettled(o, true);
      ok(o && o.changeLater === 28 && card(holder) && card(holder).title === 'CHANGE NOT MADE YET' && card(holder).reason.indexOf('its ' + said + ' of change') >= 0,
         'and the change the mint did not make: CHANGE NOT MADE YET, ' + said, JSON.stringify({ later: o && o.changeLater, card: card(holder) && card(holder).reason }));
      shut(holder);
    }
    holder.fcOwedAfterPaying = realOwed;
  }

  /* ---- 17: a dollar card at a bitcoin receive online, at a dollar fee mint ------------------------------------------ */
  for (const how of ['paid', 'refused', 'stale']) {
    const mintOpts = Object.assign({ usdFeePpk: 1000 }, how === 'refused' ? { meltRefuse: true } : {}, how === 'stale' ? { meltTtl: 60 } : {});
    const { H, R, till } = await world({ mintOpts });
    const k = await dollarCard(H, 2000, '');
    R.nfc = k;
    const felt = [];
    till.haptic = (kind) => felt.push(kind);
    const q = await bitcoinReceive(till, R, 7000);
    const usdBefore = usd(R), satBefore = sats(R), cardBefore = k.balance();
    k.tap();
    till.payByCard();
    await until('the figure', () => !!card(till));
    const cents = Math.round(Number(/pays \$ (\d+\.\d\d)/.exec(card(till).reason)[1]) * 100);
    if (how === 'paid') {
      ok(card(till).title === 'THIS CARD HOLDS DOLLARS' && felt.indexOf('warning') >= 0 && felt.indexOf('error') < 0,
         'the figure to agree to is a step of the payment: felt as one, not as a refusal', JSON.stringify(felt));
    }
    if (how === 'stale') {
      // a minute and more passes before the second tap: the quote the figure came from has under the time a payment takes left
      const quotes = () => R.trace.filter((t) => /\/v1\/melt\/quote\/bolt11/.test(t)).length;
      const asked = quotes();
      const realNow = Date.now;
      Date.now = () => realNow() + 30000;
      k.tap();
      k.sent.length = 0;
      card(till).press('TAP CARD');
      await until('the figure asked again', () => quotes() > asked && !!card(till) && card(till).title === 'THIS CARD HOLDS DOLLARS');
      Date.now = realNow;
      ok(!signed(k) && k.balance() === cardBefore, 'a quote about to run out is asked again, and the new figure agreed, before the card is touched', JSON.stringify({ quotes: quotes() - asked }));
      till.FC_QUOTE_LEFT_MS = 30000;
    }
    k.tap();
    card(till).press('TAP CARD');
    if (how === 'refused') {
      await until('PAID IN DOLLARS', () => card(till) && card(till).title === 'PAID IN DOLLARS');
      await tapDone(till, R);
      await settle();
      ok(usd(R) - usdBefore === cents && cardBefore - k.balance() >= cents && R.W.cardOutHeld().length === 0 && R.W.cardOwed().length === 0 && R.mint.quotes[q.hash].state === 'UNPAID',
         'refused at a fee mint: PAID IN DOLLARS, every cent the card paid in this phone’s dollars, nothing held and nothing owed', JSON.stringify({ usd: usd(R) - usdBefore, cents }));
      shut(till);
    } else {
      await until('the invoice to be paid', () => R.mint.quotes[q.hash].state === 'PAID' || R.mint.quotes[q.hash].state === 'ISSUED');
      await tapDone(till, R);
      await settle();
      await R.W.claim(q.hash);
      await settle();
      ok(sats(R) - satBefore === 7000 && usd(R) - usdBefore >= 0 && cardBefore - k.balance() >= cents && R.W.cardOutHeld().length === 0 && !(card(till) && card(till).title === 'PAID IN DOLLARS'),
         (how === 'stale' ? 'then paid with the new quote: ' : 'at a dollar fee mint, a receiver with no dollars: ') + 'the sats asked arrive, and the receiver pays no fee for being paid',
         JSON.stringify({ sat: sats(R) - satBefore, usd: usd(R) - usdBefore, card: cardBefore - k.balance(), cents }));
      const out = history(R).filter((e) => e.unit === 'usd' && e.dir === 'out')[0];
      ok(!!out && out.fromCard === k.key, 'the melt spent the card’s own pieces', JSON.stringify(out && { memo: out.memo, fromCard: out.fromCard }));
    }
    booksGood('a dollar card at a bitcoin receive online, at a fee mint, ' + how, H, R);
  }

  /* ---- 18: a wrong PIN, then TRY AGAIN ------------------------------------------------------------------------------ */
  for (const code of [false, true]) {
    const { H, R, till } = await world();
    const k = await dollarCard(H, 2000, '1234');
    R.nfc = k;
    await dollarReceive(till, 475, code);
    k.tap();
    till.payByCard();
    await until('the PIN pad', () => !!pad(till));
    k.tap();
    pad(till).type('9999');
    await until('WRONG PIN', () => card(till) && card(till).title === 'WRONG PIN');
    card(till).press('TRY AGAIN');
    await until('the PIN pad again', () => !!pad(till));
    ok(pad(till).sub === 'To pay $ 4.75. The card’s owner types its PIN here.', 'TRY AGAIN after a wrong PIN, ' + (code ? 'the code up' : 'before the code') + ': the pad still says $ 4.75', pad(till).sub);
    k.tap();
    pad(till).type('1234');
    await until('PAYMENT RECEIVED', () => till.state.screen === 'paid');
    await tapDone(till, R);
    await settle();
    till.dismissPaid();
    booksGood('TRY AGAIN in dollars', H, R);
  }

  /* ---- 19: FLASHCARD on the send screen while this phone sends from dollars ----------------------------------------- */
  {
    const { H, R, holder } = await world();
    const k = newCard(R, undefined, { format: 4 });
    await R.W.cardSetUp(k, {});
    H.nfc = k;
    holder.setState({ screen: 'send', stack: ['home'] });
    holder.twoUnitsOn = () => true;
    holder.walletNow = () => 'usd';
    holder.price = 80000;
    const satBefore = sats(H), usdBefore = usd(H);
    holder.fcSendCard();
    ok(holder.usdKeypad(), 'FLASHCARD from dollars: the dollar keypad');
    holder.state.amount = '1.00';
    k.tap();
    holder.fcAmountNext();
    await until('the money on the card', () => !(holder._fcTaps > 0) && (k.balance() > 0 || !!card(holder)));
    await settle();
    ok(k.balance() === 1250 && usd(H) === usdBefore && satBefore - sats(H) >= 1250 && !(card(holder) && /HOLDS/.test(card(holder).title)),
       'a bitcoin card held to it is loaded with the sats those dollars are, from this phone’s bitcoin, as it always was',
       JSON.stringify({ card: k.balance(), sat: satBefore - sats(H), usd: usd(H) - usdBefore, up: card(holder) && card(holder).all }));
    shut(holder);
    booksGood('FLASHCARD from dollars, a bitcoin card', H, R);
  }

  /* ---- 20: owed to a bitcoin card and a dollar card at once --------------------------------------------------------- */
  {
    const { H, holder } = await world();
    const real = H.W.cardOwed;
    H.W.cardOwed = () => [{ id: 'a', card: 'kSat', unit: 'sat', amount: 3000, sats: 3000, kind: 'change' }, { id: 'b', card: 'kUsd', unit: 'usd', amount: 475, sats: 0, kind: 'change' }];
    holder.setState({ fc: { key: 'kUsd', unit: 'usd', balance: 100 } });
    const shown = holder.fcOwedSum();
    holder.setState({ fc: { key: 'kSat', unit: 'sat', balance: 100 } });
    const other = holder.fcOwedSum();
    const asked = holder.fcOwedSum('usd');
    ok(shown.unit === 'usd' && shown.amount === 475 && other.unit === 'sat' && other.amount === 3000 && asked.unit === 'usd' && asked.amount === 475,
       'what is owed is said in the unit of the card on show, or the one asked: sats and cents never added', JSON.stringify({ shown, other, asked }));
    holder.setState({ fc: { key: 'kUsd', unit: 'usd', balance: 100 } });
    holder.fcStillWaiting({});
    ok(card(holder) && /\$ 4\.75 is still waiting/.test(card(holder).reason), 'and a tap that read no card says the dollar card’s $ 4.75', card(holder) && card(holder).reason);
    shut(holder);
    // a change tap for the dollar card, with a bitcoin card on show: the dollars it is for
    holder.setState({ fc: { key: 'kSat', unit: 'sat', balance: 100 } });
    holder.fcStillWaiting({ unit: 'usd' });
    ok(card(holder) && /\$ 4\.75 is still waiting/.test(card(holder).reason), 'and one for a dollar card’s change says its dollars, whatever card is on show', card(holder) && card(holder).reason);
    shut(holder);
    H.W.cardOwed = real;
    holder.setState({ fc: null });
  }

  /* ---- 21: the rest of a dollar card's screens, in dollars ----------------------------------------------------------- */
  {
    const { H, R, till, holder } = await world();
    // a payment held, the tap to finish read no card: NOT PAID YET in dollars, and CANCEL lets go of that card's alone
    let letGo = 'none';
    const realLet = R.W.cardHeldLetGo;
    R.W.cardHeldLetGo = (key) => { letGo = key; return Promise.resolve({ unit: 'usd', amount: 300, sats: 0, made: false }); };
    till.fcHeldCard(0, '', false, null, null, { cents: 475, bolt11: '' }, null, 'usd', 'kUsd');
    ok(card(till) && card(till).title === 'NOT PAID YET' && /all of \$ 4\.75\./.test(card(till).reason), 'NOT PAID YET: what is still to sign, in dollars', card(till) && card(till).reason);
    card(till).press('CANCEL');
    await settle();
    ok(letGo === 'kUsd' && card(till) && card(till).title === 'NOT PAID', 'CANCEL lets go of that card’s payment alone', String(letGo));
    shut(till);
    R.W.cardHeldLetGo = realLet;
    // taken up, and the card could not finish
    till.fcShortHeld({ cardUnit: 'usd', balance: 1, still: 5, torn: 4, letGo: { unit: 'usd', amount: 72, sats: 0, made: true } }, 77);
    ok(card(till) && card(till).reason.indexOf('The card holds $ 0.01, and $ 0.05 of $ 0.77 was still to pay. $ 0.04 it signed') === 0,
       'a payment the card could not finish, in dollars', card(till) && card(till).reason);
    shut(till);
    // the card's own screens: its log and receipts, read from the card
    const k = await dollarCard(H, 2000, '');
    H.nfc = k;
    holder.setState({ screen: 'flashcard', stack: ['home'] });
    k.tap();
    holder.fcRead();
    await until('the card read', () => !!holder.state.fc && holder.state.fc.check !== 'asking' && !(holder._fcTaps > 0));
    await settle();
    const fc = holder.state.fc;
    if (fc.log && fc.log.last) {
      holder.fcLogCard();
      ok(card(holder) && card(holder).title === 'THIS CARD’S OWN LOG' && /\$ ?[\d,]+\.\d\d signed for/.test(card(holder).reason) && !/₿/.test(card(holder).reason),
         'THIS CARD’S OWN LOG: its totals in dollars, no sats', card(holder) && card(holder).reason.split('\n').slice(-1)[0]);
      shut(holder);
    } else ok(false, 'the dollar card’s log was read', JSON.stringify(Object.keys(fc)));
    let copied = '';
    holder.copySecret = (t) => { copied = t; return true; };
    const realRc = H.W.cardReceipts;
    H.W.cardReceipts = () => [{ n: 1, time: 1700000000, sats: 475, hash: 'ab', out: 'cd' }];
    holder.fcCopyReceipts();
    ok(/, cents, sha256/.test(copied) && !/, sats, sha256/.test(copied), 'COPY RECEIPTS heads its column in cents', copied.split('\n')[2]);
    H.W.cardReceipts = realRc;
    // TAKE BACK, a reset cut short, and a withdrawal cut short: what came off, in dollars
    const realTb = H.W.cardTakeBack;
    H.W.cardTakeBack = () => Promise.resolve({ unit: 'usd', amount: 1500, sats: 0, hash: 'tb', later: 200 });
    holder.fcTakeBack(k.key);
    await until('TAKE BACK said', () => !!card(holder) && card(holder).title === 'BACK IN YOUR WALLET');
    ok(card(holder).reason === '$ 15.00 from the card is in this phone now. $ 2.00 more can be taken back later.', 'TAKE BACK, in dollars', card(holder).reason);
    shut(holder);
    H.W.cardTakeBack = realTb;
    const realRs = H.W.cardEmptyAndReset;
    H.W.cardEmptyAndReset = () => Promise.reject(Object.assign(new Error('gone'), { card: 'gone', withdrew: 1200, unit: 'usd', hash: 'rs' }));
    holder.state.fc = Object.assign({}, holder.state.fc, { balance: 2000, unit: 'usd' });
    k.tap();
    holder.fcResetRun('');
    await until('EMPTY, BUT NOT RESET', () => !!card(holder) && card(holder).title === 'EMPTY, BUT NOT RESET');
    ok(/^\$12\.00 came off the card/.test(card(holder).reason), 'a reset cut short: what came off, in dollars', card(holder).reason);
    shut(holder);
    H.W.cardEmptyAndReset = realRs;
    const realWd = H.W.cardWithdraw;
    // three dollars off and then the card away; the sheet that asks for the rest reads none
    let wdTries = 0;
    H.W.cardWithdraw = () => Promise.reject((wdTries += 1) === 1
      ? Object.assign(new Error('partial'), { card: 'partial', amount: 300, sats: 0, unit: 'usd', left: 200, hash: 'wd' })
      : Object.assign(new Error('cancelled'), { card: 'cancelled', sheetClosed: true }));
    holder.setState({ screen: 'flashcard', stack: ['home'], fc: Object.assign({}, fc, { unit: 'usd' }) });
    k.tap();
    holder.fcWithdrawRun(500, '', 0, undefined, 'usd');
    await until('TAP THE CARD AGAIN', () => !!card(holder) && card(holder).title === 'TAP THE CARD AGAIN');
    ok(/^\$ 3\.00 came off the card .* the rest, \$ 2\.00\.$/.test(card(holder).reason), 'a withdrawal cut short: what came off and what is left, in dollars', card(holder).reason);
    shut(holder);
    H.W.cardWithdraw = realWd;
  }

  failed += until.failed;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
