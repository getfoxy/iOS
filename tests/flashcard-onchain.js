'use strict';
/* flashcard-onchain.js — SEND on a card's own screen, to a bitcoin address: a payment on chain made from the card.
 *
 *     node tests/flashcard-onchain.js
 *
 * In card mode (tests/flashcard-send.js) a bitcoin address goes to the phone's own on-chain confirmation (26b-onchain.js),
 * with FROM / FLASHCARD and NEXT for SEND. NEXT reads the amount and the reserve of the fee option chosen off the card as
 * a till reads a card; the card's pieces are held for the payment and handed to the mint by the phone's own on-chain melt
 * (16a-onchain.js `onchainPay`, with them), and the payment is then the phone's to follow, PENDING until the transaction
 * confirms. What comes back after the card has gone, the reserve the transaction did not use or all of it where the mint
 * does not take it, is the card's: owed to it, said at launch (YOUR CARD HAS MONEY WAITING), and put on at its next tap.
 *
 * The screens are build/app/26f-flashcard.js and 26b-onchain.js with the send flow's own parts (flashcard-ui-kit.js,
 * `send: true`, `money: true`), over the real wallet, the test mint with its NUT-30 (tests/harness.js, `onchain`) and the
 * model of the card of software 1.20. What is checked is what a person sees, that the card and the mint say the money is
 * where the screen says it is, and that this phone's books add up at every step (tests/harness.js, the books).
 */
const fs = require('fs');
const path = require('path');
const { funded, newCard, history, MINT } = require('./flashcard-kit');
const { appOn, until, card, pad, vals, settle } = require('./flashcard-ui-kit');
const { booksWrong } = require('./harness');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

/* The app's own timers, followed from here: which are still to fire at the end, and whether any repeats. The app's methods
 * run in this node, made from their files by the kit (`appOn`, the frames "eval at appOn"); the page's own timers (the
 * wallet's, in its window) and the kit's are their own business. Each is named by the app's method that set it. */
const live = new Map();
const repeating = new Map();
const realSet = global.setTimeout, realClear = global.clearTimeout, realEvery = global.setInterval, realStop = global.clearInterval;
const appFrame = () => {
  // the frame that asked for the timer itself, and not one further down (the page's own timers are asked by its window)
  const frames = String(new Error().stack).split('\n').slice(3);
  if (!/eval at appOn/.test(frames[0] || '')) return '';
  // named by the first of the app's methods on the way down (an arrow inside one is "eval")
  for (const l of frames) {
    const m = /at (?:\w+\.)?(\w+) \(eval at appOn/.exec(l);
    if (m && m[1] !== 'eval') return m[1];
  }
  return '?';
};
global.setTimeout = function (fn, ms) {
  const where = appFrame();
  const id = realSet(function () { live.delete(id); return fn.apply(this, arguments); }, ms);
  if (where && Number(ms) > 0) live.set(id, { where, ms: Number(ms) });
  return id;
};
global.clearTimeout = function (id) { live.delete(id); return realClear(id); };
global.setInterval = function (fn, ms) {
  const where = appFrame();
  const id = realEvery.apply(this, arguments);
  if (where) repeating.set(id, { where, ms: Number(ms) });
  return id;
};
global.clearInterval = function (id) { repeating.delete(id); return realStop(id); };

const ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
// an address with its amount (BIP-21), in sats
const uri = (sats) => 'bitcoin:' + ADDRESS + '?amount=' + (sats / 1e8).toFixed(8).replace(/0+$/, '');

(async () => {
  const H = await funded({ mintOpts: { onchain: true } }, 120000);
  const holder = appOn(H, {}, { send: true, money: true });
  holder.price = 100000;
  await holder.refreshBalance();

  // a card of software 1.20, set up by this phone with no PIN, and 30,000 on it
  const c = newCard(H, undefined, { format: 4 });
  await H.W.cardSetUp(c, {});
  c.tap();
  await H.W.cardAdd(c, { sats: 30000, owner: true });

  const books = () => booksWrong(H);
  const held = () => JSON.parse(H.storage.getItem('foxy.cashu.held') || '{}');
  const outsHeld = () => Object.keys(held()).filter((k) => /^cardout-/.test(k));
  const sending = () => JSON.parse(H.storage.getItem('foxy.cashu.onchain.out') || '[]');
  const update = () => { holder.syncCardOut(); holder.syncSend(); };
  const tapsDone = async (who) => { const a = who || holder; await until('the tap to be over', () => !(a._fcTaps > 0)); await settle(); };
  const closeCards = (a) => { for (let i = 0; i < 6 && a._blockedEl && a._blockedEl.parentNode; i++) a.dismissCard(a._blockedKind); };
  const toCard = async (which) => {
    const k = which || c;
    closeCards(holder);
    holder.setState({ screen: 'home', stack: [], sendFrom: '', ocPlan: null, ocTo: '', ocSats: 0, ocErr: '', ocBusy: false });
    holder.syncCardOut();
    H.nfc = k;
    holder.goFlashcard();
    await until('the card to be read', () => !!holder.state.fc && holder.state.fc.key === k.key && holder.state.fc.check !== 'asking');
    await settle();
  };
  // SEND on the card's screen, an address read (pasted or scanned), and its confirmation with the mint's fee
  const toConfirm = async (text) => {
    vals(holder).fcSend();
    update();
    holder.acceptTarget(text);
    await until('the on-chain confirmation and its fee', () => holder.state.screen === 'ocConfirm' && !!holder.state.ocPlan && !holder.state.ocQuoting);
    update();
  };
  // what the wallet is asked to pay with, as the payment starts: the card's pieces, still held
  let asked = null;
  // set to an error, the next payment refuses by throwing as it is asked, as a wallet with no route to the mint may
  let throwNext = null;
  const pay0 = H.W.onchainPay;
  H.W.onchainPay = function (plan, fee, stage, opts) {
    const h = opts && opts.held ? held()[opts.held] : null;
    asked = { plan, fee, opts, hold: h ? { kind: h.kind, card: h.card, sats: h.proofs.reduce((n, p) => n + Number(p.amount), 0) } : null, books: books().length };
    if (throwNext) { const e = throwNext; throwNext = null; throw e; }
    return pay0.apply(this, arguments);
  };
  const CARD_OWED = 'foxy.flashcard.owed', CARD_DUE = 'foxy.flashcard.due';
  const owedRows = () => JSON.parse(H.storage.getItem(CARD_OWED) || '[]');
  // the clock moved on, for the wallet's page and this node both; the answer puts it back
  const later = (ms) => {
    const realW = H.window.Date.now.bind(H.window.Date), realN = Date.now;
    H.window.Date.now = () => realW() + ms;
    Date.now = () => realN() + ms;
    return () => { H.window.Date.now = realW; Date.now = realN; };
  };

  /* ---- 1: an address in card mode reaches the on-chain confirmation, the card's ---------------------------------- */
  let spec;
  {
    await toCard();
    await toConfirm(uri(10000));
    spec = holder.confirmSpec();
    const labels = spec.rows.map((r) => r.label);
    const row = (l) => spec.rows.find((r) => r.label === l) || {};
    ok(holder.state.screen === 'ocConfirm' && holder.state.sendFrom === 'card' && holder.fcOutMode(),
       'a bitcoin address read in card mode reaches the on-chain confirmation, still in card mode', holder.state.screen);
    ok(labels.join() === 'DELIVERED TO,NETWORK,FROM,ARRIVES,FEE' && row('NETWORK').value === 'ON-CHAIN'
       && row('FROM').value === 'FLASHCARD' && row('FROM').sub === 'm.test',
       'its rows: NETWORK ON-CHAIN, then FROM / FLASHCARD / the card’s mint, and no PAYING FROM', labels.join());
    ok(spec.amount === '$ 10.00' && spec.amountSub === '₿ 10,000', 'the amount, dollars first and the sats under', spec.amount + ' | ' + spec.amountSub);
    ok(row('FEE').value === 'UP TO $ 0.06' && row('FEE').sub === '₿ 64', 'the mint’s fee reserve as FEE, dollars first and the sats under', row('FEE').value + ' | ' + row('FEE').sub);
    const phoneSays = /chip: 'A payment on chain is not instant\. It is done when it confirms\.'/.test(fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '26b-onchain.js'), 'utf8'));
    ok(spec.chip === 'A payment on chain is not instant. It is done when it confirms.' && phoneSays,
       'the line the phone’s own on-chain confirmation has about settling', spec.chip);
    ok(spec.cta === 'NEXT' && !spec.ctaBusy && spec.secondary && spec.secondary.label === 'CHANGE THE SPEED', 'NEXT for SEND, with the speeds the mint offers', spec.cta);
    // from this phone the same address is SEND, with PAYING FROM and no FROM row
    holder.state.sendFrom = '';
    const plain = holder.confirmSpec();
    holder.state.sendFrom = 'card';
    ok(/^SEND /.test(plain.cta) && plain.rows.some((r) => r.label === 'PAYING FROM') && !plain.rows.some((r) => r.label === 'FROM'),
       'out of card mode it is the phone’s own: SEND, and PAYING FROM', plain.cta);
    ok(books().length === 0, 'the books add up', books().join(' / '));
  }

  /* ---- 2: NEXT reads amount and reserve off the card; the held pieces are melted on chain; PENDING ---------------- */
  let quote = '';
  let paidFrom = 0;
  {
    const before = c.balance();
    const total = H.W.cardOutTotal(10000, 64);
    const meltsBefore = H.mint.posted.filter((p) => p.path === '/v1/melt/onchain').length;
    H.sheet.length = 0;
    spec.go();
    await until('the payment to be handed to the mint', () => holder.announced.length > 0);
    await tapsDone();
    await until('the change to be owed to the card', () => H.W.cardOwed().some((r) => r.out));
    await settle();
    paidFrom = before;
    quote = holder.announced[0].hash.replace(/^onchain-/, '');
    ok(before - c.balance() === total && total === 10064, 'NEXT reads the amount and the fee’s reserve off the card, as a till reads it: 10,064', (before - c.balance()) + ' sats');
    ok(H.sheet.some((x) => /^begin: /.test(x)), 'in one sheet, as a till reads a card with no PIN');
    ok(!!asked && !!asked.opts && /^cardout-/.test(asked.opts.held) && asked.opts.card === c.key && asked.hold && asked.hold.kind === 'card out'
       && asked.hold.sats === total && asked.books === 0,
       'the card’s swap lands in pieces held for the payment, 10,064 of them, and the books add up while they are held', JSON.stringify(asked && asked.hold));
    ok(H.mint.posted.filter((p) => p.path === '/v1/melt/onchain').length === meltsBefore + 1 && asked.plan.id === quote,
       'the wallet’s own on-chain melt is asked, once, of the quote the confirmation showed');
    const rec = sending().find((r) => r.quote === quote) || {};
    ok(rec.state === 'PENDING' && rec.cardOut === asked.opts.held && rec.card === c.key && (H.W.onchainSending() || []).some((r) => r.quote === quote),
       'PENDING is the phone’s: the payment is on the list the on-chain watch follows, naming the card', JSON.stringify({ state: rec.state }));
    const ev = holder.announced[0];
    const own = /this\.announcePayment\(\{ dir: 'out', sats: done\.sats, hash: 'onchain-' \+ done\.quote,\s*to: 'a bitcoin address', force: true \}\)/
      .test(fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '26b-onchain.js'), 'utf8'));
    ok(ev.dir === 'out' && ev.sats === 10000 && ev.to === 'a bitcoin address' && ev.force === true && own,
       'and the screen says it is on its way as the phone’s own on-chain send says it: the same announcement', JSON.stringify(ev));
    const out = history(H).find((e) => e.hash === 'onchain-' + quote) || {};
    ok(out.dir === 'out' && out.sats === 10000 && out.state === 'pending' && out.memo === 'paid from card' && out.fromCard === c.key && out.network === 'ON-CHAIN',
       'its history entry is the on-chain payment, pending, paid from the card', JSON.stringify({ sats: out.sats, state: out.state, memo: out.memo }));
    ok(outsHeld().length === 0, 'nothing of the card’s is left held');
    ok(books().length === 0, 'the books add up', books().join(' / '));
  }

  /* ---- 3: the reserve the transaction did not use is owed to the card, and said ----------------------------------- */
  let change = 0;
  {
    const owed = H.W.cardOwed().filter((r) => r.out);
    change = owed.reduce((n, r) => n + r.sats, 0);
    const pileBefore = await H.W.balanceSats();
    ok(owed.length === 1 && owed[0].kind === 'change' && owed[0].card === c.key && owed[0].payment === 'onchain-' + quote && change === 32,
       'the mint gave back 32 of the 64 reserved, and they are owed to the card, as change of that payment', JSON.stringify(owed));
    ok((await H.W.balanceSats()) === pileBefore && H.W.cardOutHeld().length === 0, 'and are not this phone’s: nothing of them is in its pile or held');
    ok(card(holder) && card(holder).title === 'YOUR CARD HAS MONEY WAITING' && card(holder).reason === 'Tap your card to put ₿32 back on it.' && card(holder).has('TAP CARD'),
       'the screen says so at once: YOUR CARD HAS MONEY WAITING, with TAP CARD', card(holder) && card(holder).all);
    const out = history(H).find((e) => e.hash === 'onchain-' + quote) || {};
    ok(out.changeSats === 32 && out.changeState === 'not handed' && out.feeSats === 32 && out.grossSats === 10064,
       'the payment’s entry says what it cost and the 32 going back to the card', JSON.stringify({ fee: out.feeSats, change: out.changeSats, state: out.changeState }));
    ok(books().length === 0, 'the books add up', books().join(' / '));
    closeCards(holder);
  }

  /* ---- 3b: owed once, however often it is asked again ----------------------------------------------------------------- */
  {
    const tap = H.W.cardOwed().filter((r) => r.out)[0].forHash;
    const tokens = owedRows().length;
    // the connect's retry of what could not be made, its sweep for holds left behind (past ten minutes), and the change's own hold
    await H.W.cardDueRetry();
    const back = later(11 * 60000);
    await H.W.cardOutsLeft();
    back();
    await H.W.cardOutBack(asked.opts.held + '-change');
    const out = H.W.cardOwed().filter((r) => r.out);
    ok(out.length === 1 && out[0].sats === 32 && owedRows().length === tokens,
       'asked again by the retry, the sweep and the change’s own hold, the 32 are owed to the card once', JSON.stringify(H.W.cardOwed().map((r) => [r.kind, r.sats])));
    /* A note that the change is still to be made, for a payment whose change is owed already (made on a later try that
     * did not drop the note): the retry drops it, and makes nothing a second time for the card. */
    const swaps = H.mint.posted.filter((x) => x.path === '/v1/swap').length;
    H.storage.setItem(CARD_DUE, JSON.stringify([{ forHash: tap, card: c.key, token: '', sats: 0, worth: 32, owed: 32, refund: false,
                                                  outChange: true, payment: 'onchain-' + quote, blind: false, cardChange: 0, at: Date.now() }]));
    await H.W.cardDueRetry();
    ok(H.W.cardDue().length === 0 && owedRows().length === tokens && H.W.cardOwed().filter((r) => r.out).length === 1
       && H.mint.posted.filter((x) => x.path === '/v1/swap').length === swaps,
       'a note that the change is still to be made, for change owed already, is dropped with nothing made', JSON.stringify(H.W.cardDue()));
    ok(books().length === 0, 'the books add up', books().join(' / '));
  }

  /* ---- 4: Foxy closed and opened again: the card says so at launch, until it is put back ------------------------- */
  {
    const again = appOn(H, {}, { send: true, money: true });
    ok(again.fcMoneyWaiting() === true && card(again) && card(again).title === 'YOUR CARD HAS MONEY WAITING'
       && /₿32 back on it/.test(card(again).reason) && card(again).has('TAP CARD'),
       'the next launch says YOUR CARD HAS MONEY WAITING, with one button, TAP CARD', card(again) && card(again).all);
    const boot = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '09-melt-paste-switch.js'), 'utf8');
    ok(/setTimeout\(\(\) => \{ if \(this\.fcMoneyWaiting\) this\.fcMoneyWaiting\(\); \}, 1500\)/.test(boot), 'which the launch asks for, once the wallet is ready');
    // and the card's own screen has it, in the line for money waiting for a card
    H.nfc = c;
    again.goFlashcard();
    await until('the card to be read', () => !!again.state.fc && again.state.fc.key === c.key && again.state.fc.check !== 'asking');
    await settle();
    const said = JSON.stringify(vals(again)).indexOf('₿32 is waiting to go onto this card') >= 0;
    ok(said, 'the Flashcard screen says it too: ₿32 is waiting to go onto this card');
    // confirmed on chain meanwhile: the payment is done, and the 32 still the card's
    H.mint.onchainConfirm(quote);
    await H.W.onchainFollow(quote);
    const out = history(H).find((e) => e.hash === 'onchain-' + quote) || {};
    ok(out.state === 'success' && out.settled === true && H.W.cardOwed().some((r) => r.out), 'the transaction confirms: the entry is paid, and the change is still waiting for the card', out.state);
    // the tap: the card's balance rises by the change
    closeCards(again);
    again.setState({ screen: 'home', stack: [], fc: null });
    again.fcMoneyWaiting();
    const was = c.balance();
    H.nfc = c;
    card(again).press('TAP CARD');
    await until('the change to be on the card', () => c.balance() === was + 32 && !H.W.cardOwed().length);
    await tapsDone(again);
    ok(c.balance() === was + 32 && c.balance() === paidFrom - 10064 + 32 && H.W.cardOwed().length === 0,
       'the tap puts it on: the card’s balance rises by the 32, and it has paid 10,032 in all', String(c.balance()));
    ok(again.fcMoneyWaiting() === false && !(card(again) && card(again).title === 'YOUR CARD HAS MONEY WAITING'),
       'and the launch says nothing more of it');
    const done = history(H).find((e) => e.hash === 'onchain-' + quote) || {};
    ok(done.changeState === 'given back', 'the payment’s entry says the change is back on the card', done.changeState);
    c.tap();
    const seen = await H.W.cardLook(c, { mine: true });
    const checked = await H.W.cardCheck(seen);
    ok(checked.spent === 0 && seen.balance === c.balance(), 'the mint says every piece on the card is good', JSON.stringify({ spent: checked.spent }));
    ok(books().length === 0, 'the books add up', books().join(' / '));
    closeCards(again);
  }

  /* ---- 5: the mint does not take the payment: all of it goes back to the card ------------------------------------- */
  {
    await toCard();
    const before = c.balance();
    await toConfirm(uri(12000));
    const q = holder.state.ocPlan.quote;
    // the mint answers the melt UNPAID (its payment failed, and it kept none of the ecash): its own quote, as it answers it, so
    const asItIs = JSON.parse(H.mint.handle({ url: 'https://m.test/v1/melt/quote/onchain/' + q.quote, method: 'GET' }).split('\n').slice(1).join('\n'));
    H.fate = (m) => (/\/v1\/melt\/onchain$/.test(String(m.url))
      ? '200\n' + JSON.stringify(Object.assign({}, asItIs, { state: 'UNPAID', selected_fee_index: 0, change: [] })) : null);
    holder.confirmSpec().go();
    await until('the payment to be refused', () => !!card(holder) && card(holder).title === 'NOT PAID');
    H.fate = null;
    await tapsDone();
    const owed = H.W.cardOwed().filter((r) => r.out);
    ok(before - c.balance() === 12064 && owed.length === 1 && owed[0].sats === 12064 && owed[0].kind === 'refund',
       'the card paid 12,064, the mint took none of it, and all of it is owed back to the card', JSON.stringify(owed.map((r) => [r.kind, r.sats])));
    ok(/12,064 goes back on the card/.test(card(holder).reason) && card(holder).has('TAP CARD'), 'NOT PAID, saying so, with TAP CARD', card(holder).reason);
    const out = history(H).find((e) => e.hash === 'onchain-' + q.quote) || {};
    ok(out.state === 'failed' && outsHeld().length === 0 && !sending().some((r) => r.quote === q.quote), 'its entry is failed, and nothing is left held or followed', out.state);
    ok(books().length === 0, 'the books add up', books().join(' / '));
    // a launch now says so too
    const later = appOn(H, {}, { send: true });
    ok(later.fcMoneyWaiting() === true && /₿12,064 back on it/.test(card(later).reason), 'and a launch would say YOUR CARD HAS MONEY WAITING', card(later) && card(later).reason);
    closeCards(later);
    H.nfc = c;
    card(holder).press('TAP CARD');
    await until('the money to be back on the card', () => c.balance() === before && H.W.cardOwed().length === 0);
    await tapsDone();
    ok(c.balance() === before && books().length === 0, 'its next tap puts it all back, and the books add up', c.balance() + ' | ' + books().join(' / '));
  }

  /* ---- 6: the melt's answer never came (Foxy closed as it went), and the mint never had it: back to the card later ---- */
  {
    await toCard();
    const before = c.balance();
    await toConfirm(uri(11000));
    const q = holder.state.ocPlan.quote;
    H.fate = (m) => (/\/v1\/melt\/onchain$/.test(String(m.url)) ? '504\n' + JSON.stringify({ detail: 'gateway timeout' }) : null);
    holder.confirmSpec().go();
    await until('the payment to be pending', () => !!card(holder) && card(holder).title === 'PAYMENT PENDING');
    H.fate = null;
    await tapsDone();
    const rec = sending().find((r) => r.quote === q.quote) || {};
    ok(before - c.balance() === 11064 && rec.state === 'UNKNOWN' && (rec.proofs || []).length > 0 && outsHeld().length === 0 && H.W.cardOwed().length === 0,
       'no answer: PAYMENT PENDING, and the card’s pieces wait in the payment’s record for the mint’s word', JSON.stringify({ state: rec.state }));
    ok(books().length === 0, 'the books add up while the mint is silent: the record’s pieces beyond the amount are counted as still here', books().join(' / '));
    const pile = await H.W.balanceSats();
    closeCards(holder);
    // Foxy opened again, past the two minutes in which UNPAID is no verdict: the on-chain watch asks, and the mint never had it
    const back = appOn(H, {}, { send: true });
    const realW = H.window.Date.now.bind(H.window.Date);
    const realN = Date.now;
    H.window.Date.now = () => realW() + 3 * 60000;
    Date.now = () => realN() + 3 * 60000;
    back.onchainWatch();
    await until('the pieces to be owed back to the card', () => H.W.cardOwed().some((r) => r.out && r.sats === 11064));
    await until('the screen to say so', () => !!card(back) && card(back).title === 'YOUR CARD HAS MONEY WAITING');
    H.window.Date.now = realW;
    Date.now = realN;
    realClear(back._ocWatchT);
    live.delete(back._ocWatchT);
    const out = history(H).find((e) => e.hash === 'onchain-' + q.quote) || {};
    ok(!sending().some((r) => r.quote === q.quote) && out.state === 'failed' && outsHeld().length === 0 && (await H.W.balanceSats()) === pile,
       'the mint says it never had it: the record goes, the entry is failed, and the pieces are the card’s again, owed to it, not this phone’s', out.state);
    ok(/₿11,064 back on it/.test(card(back).reason) && back.toasts.some((t) => /did not go\. Nothing was paid from the card/.test(t)),
       'said: that on-chain payment did not go, and YOUR CARD HAS MONEY WAITING', back.toasts.join(' / '));
    ok(books().length === 0, 'the books add up', books().join(' / '));
    H.nfc = c;
    card(back).press('TAP CARD');
    await until('the money to be back on the card', () => c.balance() === before && H.W.cardOwed().length === 0);
    await tapsDone(back);
    ok(c.balance() === before && books().length === 0, 'TAP CARD puts it all back on, and the books add up', c.balance() + ' | ' + books().join(' / '));
    closeCards(back);
  }

  /* ---- 7: Foxy closed between the card paying and the melt: the hold is found at the next connect and owed back ----- */
  {
    c.tap();
    const before = c.balance();
    const r = await H.W.cardPay(c, { sats: 10064, holdFor: true, only: c.key });
    ok(r.held && outsHeld().length === 1 && c.balance() === before - 10064, 'the card pays 10,064 for a payment on chain, held to one side, and then Foxy is gone');
    ok(books().length === 0, 'the books add up while it is held', books().join(' / '));
    const realW = H.window.Date.now.bind(H.window.Date);
    const realN = Date.now;
    H.window.Date.now = () => realW() + 11 * 60000;
    Date.now = () => realN() + 11 * 60000;
    // the connect's sweep (11-routing.js), as on the next launch
    const swept = await H.W.cardOutsLeft();
    H.window.Date.now = realW;
    Date.now = realN;
    ok(swept.length === 1 && swept[0].made && outsHeld().length === 0 && H.W.cardOwed().length === 1 && H.W.cardOwed()[0].sats === 10064 && H.W.cardOwed()[0].out,
       'the next connect finds the hold and owes it back to the card, as for a Lightning payment', JSON.stringify(swept));
    const launch = appOn(H, {}, { send: true });
    ok(launch.fcMoneyWaiting() === true && /₿10,064 back on it/.test(card(launch).reason), 'and the launch says YOUR CARD HAS MONEY WAITING', card(launch) && card(launch).reason);
    H.nfc = c;
    card(launch).press('TAP CARD');
    await until('the money to be back on the card', () => c.balance() === before && H.W.cardOwed().length === 0);
    await tapsDone(launch);
    ok(c.balance() === before && books().length === 0, 'TAP CARD puts it back, and the books add up', c.balance() + ' | ' + books().join(' / '));
    closeCards(launch);
  }

  /* ---- 7b: the wallet refuses by throwing, after the card has paid: all of it owed back at once, NOT PAID ----------- */
  {
    await toCard();
    const before = c.balance();
    await toConfirm(uri(10000));
    // the route gone between the tap and the melt: the wallet's refusal, thrown as it is asked
    throwNext = new Error('Tor is reconnecting. Try again in a moment.');
    holder.confirmSpec().go();
    await until('the payment to be refused', () => !!card(holder) && card(holder).title === 'NOT PAID');
    await tapsDone();
    const owed = H.W.cardOwed().filter((r) => r.out);
    ok(before - c.balance() === 10064 && owed.length === 1 && owed[0].sats === 10064 && owed[0].kind === 'refund' && outsHeld().length === 0,
       'refused by a throw once the card has paid 10,064: all of it is owed back to the card at once, and nothing is left held',
       JSON.stringify({ owed: owed.map((r) => [r.kind, r.sats]), held: outsHeld() }));
    ok(holder.state.ocBusy === false && holder.melting === false && /10,064 goes back on the card/.test(card(holder).reason) && card(holder).has('TAP CARD'),
       'NOT PAID says so, with TAP CARD; the overlay is down and the confirmation is not left sending', card(holder).reason);
    ok(!sending().some((r) => r.quote === holder.state.ocPlan.id), 'and nothing is followed as if it had been sent');
    ok(books().length === 0, 'the books add up', books().join(' / '));
    H.nfc = c;
    card(holder).press('TAP CARD');
    await until('the money to be back on the card', () => c.balance() === before && H.W.cardOwed().length === 0);
    await tapsDone();
    ok(c.balance() === before && books().length === 0, 'TAP CARD puts it all back, and the books add up', c.balance() + ' | ' + books().join(' / '));
    closeCards(holder);
  }

  /* ---- 7c: Foxy closed as the melt answered, before the change was the card's: the connect's sweep says so ---------- */
  {
    // more on the card, for the payments that follow
    c.tap();
    await H.W.cardAdd(c, { sats: 30200, owner: true });
    await toCard();
    const before = c.balance();
    await toConfirm(uri(10000));
    const q = holder.state.ocPlan.id;
    const outBack0 = H.W.cardOutBack;
    // what makes the change the card's never runs: Foxy is gone
    H.W.cardOutBack = () => Promise.resolve({ sats: 0, made: false });
    holder.confirmSpec().go();
    await until('the change to be held for the card', () => outsHeld().some((k) => /-change$/.test(k)));
    await tapsDone();
    H.W.cardOutBack = outBack0;
    const changeId = asked.opts.held + '-change';
    ok(outsHeld().join() === changeId && H.W.cardOwed().length === 0 && before - c.balance() === 10064,
       'the change is held for the card, and not yet owed to it', JSON.stringify(outsHeld()));
    ok(books().length === 0, 'the books add up, the change counted where it is held', books().join(' / '));
    closeCards(holder);
    const relaunch = appOn(H, {}, { send: true });
    ok(relaunch.fcMoneyWaiting() === false && !card(relaunch), 'the next launch has nothing to say yet: a hold is not money owed');
    relaunch.fcCaughtUp({ cardOwed: 0 });
    ok(!card(relaunch), 'and a connect that made nothing owed says nothing');
    // the connect's sweep, past the two minutes a hold is left to the screen that made it
    H.W.onCaughtUp((info) => relaunch.fcCaughtUp(info));
    const back = later(3 * 60000);
    await H.W.connect(MINT, null, null, { remember: true });
    await until('the sweep to end saying so', () => !!card(relaunch) && card(relaunch).title === 'YOUR CARD HAS MONEY WAITING');
    back();
    H.W.onCaughtUp(() => {});
    const owed = H.W.cardOwed().filter((r) => r.out);
    ok(owed.length === 1 && owed[0].sats === 32 && owed[0].kind === 'change' && owed[0].payment === 'onchain-' + q && outsHeld().length === 0
       && /₿32 back on it/.test(card(relaunch).reason) && card(relaunch).has('TAP CARD'),
       'the sweep makes the change the card’s, and says so as it ends: YOUR CARD HAS MONEY WAITING, with TAP CARD', JSON.stringify(owed));
    const boot = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '06-wallet-boot-and-restore.js'), 'utf8');
    ok(/W\.onCaughtUp\(\(info\) => \{[\s\S]*?if \(this\.fcCaughtUp\) this\.fcCaughtUp\(info\);/.test(boot),
       'which the app asks for when the connect has caught up');
    ok(books().length === 0, 'the books add up', books().join(' / '));
    H.nfc = c;
    card(relaunch).press('TAP CARD');
    await until('the change to be on the card', () => c.balance() === before - 10032 && H.W.cardOwed().length === 0);
    await tapsDone(relaunch);
    ok(c.balance() === before - 10032 && books().length === 0, 'TAP CARD puts the 32 on: the card paid 10,032 in all', c.balance() + ' | ' + books().join(' / '));
    closeCards(relaunch);
    // confirmed: the change came with the answer, so there is nothing more to restore, and nothing comes twice
    const pile = await H.W.balanceSats();
    H.mint.onchainConfirm(q);
    const done = await H.W.onchainFollow(q);
    ok(done.state === 'PAID' && !done.cardChange && (await H.W.balanceSats()) === pile && H.W.cardOwed().length === 0 && outsHeld().length === 0,
       'it confirms, and the change that came with the answer is not restored again', JSON.stringify(done));
    ok(books().length === 0, 'the books add up', books().join(' / '));
  }

  /* ---- 7d: a mint that signs the change only once the transaction confirms ----------------------------------------------- */
  {
    H.mint.changeLater(true);
    await toCard();
    const before = c.balance();
    await toConfirm(uri(10000));
    const q = holder.state.ocPlan.id;
    const n0 = holder.announced.length;
    holder.confirmSpec().go();
    await until('the payment to be handed to the mint', () => holder.announced.length > n0);
    await tapsDone();
    const rec = sending().find((r) => r.quote === q) || {};
    ok(before - c.balance() === 10064 && rec.state === 'PENDING' && (rec.outputs || []).length > 0 && H.W.cardOwed().length === 0 && outsHeld().length === 0,
       'PENDING with no change in the answer: the counters of the change’s outputs are on the payment’s record, and nothing is owed yet',
       JSON.stringify({ state: rec.state, outputs: rec.outputs }));
    let entry = history(H).find((e) => e.hash === 'onchain-' + q) || {};
    ok(entry.feeSats === 64 && entry.state === 'pending', 'until it confirms, the entry counts the whole reserve as its fee', String(entry.feeSats));
    ok(books().length === 0, 'the books add up', books().join(' / '));
    closeCards(holder);
    const pile = await H.W.balanceSats();
    H.mint.onchainConfirm(q);
    holder.onchainWatch();
    await until('the change to be owed to the card', () => H.W.cardOwed().some((r) => r.out && r.payment === 'onchain-' + q));
    await until('the screen to say so', () => !!card(holder) && card(holder).title === 'YOUR CARD HAS MONEY WAITING');
    realClear(holder._ocWatchT);
    live.delete(holder._ocWatchT);
    const owed = H.W.cardOwed().filter((r) => r.out);
    entry = history(H).find((e) => e.hash === 'onchain-' + q) || {};
    const after = sending().find((r) => r.quote === q) || {};
    ok(owed.length === 1 && owed[0].sats === 32 && owed[0].kind === 'change' && (await H.W.balanceSats()) === pile && outsHeld().length === 0,
       'it confirms: the watch restores the change from those counters, and it is the card’s, owed to it, not this phone’s', JSON.stringify(owed.map((r) => [r.kind, r.sats])));
    ok(entry.state === 'success' && entry.feeSats === 32 && entry.changeSats === 32 && entry.changeState === 'not handed'
       && after.state === 'PAID' && !(after.outputs || []).length,
       'its entry: paid, a fee of 32, and 32 going back to the card; the record keeps no counters', JSON.stringify({ fee: entry.feeSats, change: entry.changeSats, state: entry.changeState }));
    ok(/₿32 back on it/.test(card(holder).reason), 'YOUR CARD HAS MONEY WAITING says the 32', card(holder).reason);
    ok(books().length === 0, 'the books add up', books().join(' / '));
    const again = await H.W.onchainFollow(q);
    ok(!again.cardChange && H.W.cardOwed().filter((r) => r.out).length === 1, 'asked again, nothing more is restored');
    H.nfc = c;
    card(holder).press('TAP CARD');
    await until('the change to be on the card', () => c.balance() === before - 10032 && H.W.cardOwed().length === 0);
    await tapsDone();
    ok(c.balance() === before - 10032 && (history(H).find((e) => e.hash === 'onchain-' + q) || {}).changeState === 'given back' && books().length === 0,
       'TAP CARD puts it on, and the entry says given back', c.balance() + ' | ' + books().join(' / '));
    closeCards(holder);

    // and this phone's own payment at such a mint: the change comes back to its pile when it confirms
    const pile0 = await H.W.balanceSats();
    const plan = await H.W.onchainQuote(ADDRESS, 10000);
    const pick = plan.options.filter((o) => o.fee === 64)[0] || plan.options[0];
    const sent = await H.W.onchainPay(plan, pick.index);
    const pile1 = await H.W.balanceSats();
    const own = () => history(H).find((e) => e.hash === 'onchain-' + plan.id) || {};
    ok(sent.state === 'PENDING' && pile0 - pile1 === 10000 + pick.fee && own().feeSats === pick.fee,
       'from this phone: PENDING, the whole reserve gone from the pile and counted as fee for now', JSON.stringify({ paid: pile0 - pile1, fee: own().feeSats }));
    ok(books().length === 0, 'the books add up', books().join(' / '));
    H.mint.onchainConfirm(plan.id);
    const paid = await H.W.onchainFollow(plan.id);
    const backSats = pick.fee - Math.ceil(pick.fee / 2);
    ok(paid.state === 'PAID' && paid.changeBack === backSats && (await H.W.balanceSats()) === pile1 + backSats && own().feeSats === pick.fee - backSats && own().state === 'success',
       'it confirms: the change is restored into the pile, and the fee comes down by it', JSON.stringify({ back: paid.changeBack, fee: own().feeSats }));
    ok(books().length === 0, 'the books add up', books().join(' / '));
    H.mint.changeLater(false);
  }

  /* ---- 7e: the mint took it and its answer was lost; it confirms later, and the change is the card's ------------------- */
  {
    await toCard();
    const before = c.balance();
    await toConfirm(uri(10000));
    const q = holder.state.ocPlan.id;
    // the mint acts on the melt, and its answer never arrives
    H.fate = (m) => (/\/v1\/melt\/onchain$/.test(String(m.url)) ? (H.mint.handle(m), '504\n' + JSON.stringify({ detail: 'gateway timeout' })) : null);
    const timers = new Set(live.keys());
    holder.confirmSpec().go();
    await until('the payment to be pending', () => !!card(holder) && card(holder).title === 'PAYMENT PENDING');
    H.fate = null;
    await tapsDone();
    const rec = sending().find((r) => r.quote === q) || {};
    ok(before - c.balance() === 10064 && rec.state === 'UNKNOWN' && (rec.outputs || []).length > 0 && H.W.cardOwed().length === 0,
       'no answer: PAYMENT PENDING, with the card’s pieces and the change’s counters on the record', JSON.stringify({ state: rec.state, outputs: rec.outputs }));
    ok(books().length === 0, 'the books add up while the mint is silent', books().join(' / '));
    closeCards(holder);
    H.mint.onchainConfirm(q);
    holder.onchainWatch();
    await until('the change to be owed to the card', () => H.W.cardOwed().some((r) => r.out && r.payment === 'onchain-' + q));
    await until('the screen to say so', () => !!card(holder) && card(holder).title === 'YOUR CARD HAS MONEY WAITING');
    realClear(holder._ocWatchT);
    live.delete(holder._ocWatchT);
    const owed = H.W.cardOwed().filter((r) => r.out);
    const entry = history(H).find((e) => e.hash === 'onchain-' + q) || {};
    ok(owed.length === 1 && owed[0].sats === 32 && entry.state === 'success' && entry.feeSats === 32 && entry.changeSats === 32,
       'it confirms: the change is restored and owed to the card, and the entry’s fee is what it cost, 32', JSON.stringify({ owed: owed.map((r) => r.sats), fee: entry.feeSats }));
    ok(books().length === 0, 'the books add up', books().join(' / '));
    H.nfc = c;
    card(holder).press('TAP CARD');
    await until('the change to be on the card', () => c.balance() === before - 10032 && H.W.cardOwed().length === 0);
    await tapsDone();
    ok(c.balance() === before - 10032 && books().length === 0, 'TAP CARD puts it on', c.balance() + ' | ' + books().join(' / '));
    closeCards(holder);
    // PAYMENT PENDING's two sweeps, from this payment, which end by themselves: stopped here, so the count at the end is the first's
    const pend = Array.from(live.entries()).filter(([id, t]) => !timers.has(id) && t.where === 'showPayPending');
    ok(pend.length === 2, 'PAYMENT PENDING set its two sweeps, once each', JSON.stringify(pend.map(([, t]) => t.ms)));
    pend.forEach(([id]) => { realClear(id); live.delete(id); });
  }

  /* ---- 7f: a card with a PIN: the launch's TAP CARD, then its PIN, puts the change on ---------------------------------- */
  {
    const cp = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(cp, { pin: '1234' });
    cp.tap();
    await H.W.cardAdd(cp, { sats: 11000, owner: true });
    await toCard(cp);
    const before = cp.balance();
    await toConfirm(uri(10000));
    const q = holder.state.ocPlan.id;
    holder.confirmSpec().go();
    await until('the PIN pad', () => !!pad(holder));
    pad(holder).type('1234');
    await until('the change to be owed to the card', () => H.W.cardOwed().some((r) => r.out && r.card === cp.key));
    await tapsDone();
    closeCards(holder);
    ok(before - cp.balance() === 10064, 'the PIN card pays 10,064 for the payment on chain, its PIN asked', String(before - cp.balance()));
    /* The tap after a payment loads with no PIN (the card's note that it has paid). A launch long after finds it used by
     * some other tap, as here, and the next write is the PIN's. */
    cp.state.changeDue = false;
    const launch = appOn(H, {}, { send: true, money: true });
    ok(launch.fcMoneyWaiting() === true && /₿32 back on it/.test(card(launch).reason), 'the launch says YOUR CARD HAS MONEY WAITING', card(launch) && card(launch).reason);
    H.nfc = cp;
    card(launch).press('TAP CARD');
    await until('the PIN pad', () => !!pad(launch));
    ok(pad(launch).title === 'CARD PIN', 'TAP CARD, tried with no PIN, asks for the card’s PIN', pad(launch).title);
    pad(launch).type('1234');
    await until('the change to be on the card', () => cp.balance() === before - 10032 && !H.W.cardOwed().some((r) => r.card === cp.key));
    await tapsDone(launch);
    const entry = history(H).find((e) => e.hash === 'onchain-' + q) || {};
    ok(cp.balance() === before - 10032 && H.W.cardOwed().length === 0 && entry.changeState === 'given back',
       'the PIN puts the 32 on: nothing is owed, and the entry says given back', cp.balance() + ' | ' + entry.changeState);
    ok(books().length === 0, 'the books add up', books().join(' / '));
    closeCards(launch);
  }

  /* ---- 8: below the mint's floor, refused in the words the phone uses, before the card is touched --------------------- */
  {
    await toCard();
    const before = c.balance();
    vals(holder).fcSend();
    update();
    holder.toasts.length = 0;
    holder.acceptTarget(uri(5000));
    await until('the mint’s limits to be asked', () => holder.toasts.length > 0);
    ok(holder.toasts[0] === 'This mint sends at least 10,000 sats on chain.' && holder.state.screen === 'sendHow' && !card(holder),
       'an address for 5,000: refused in the words the phone’s keypad uses, and nothing moves', holder.toasts.join(' / '));
    // and typed on the keypad, the same words, and the card's own ceiling
    holder.toasts.length = 0;
    holder.acceptTarget(ADDRESS);
    await until('the keypad', () => holder.state.screen === 'amount');
    update();
    ok(holder.state.screen === 'amount' && holder.state.flow === 'onchain' && holder.fcOutMode(), 'an address with no amount: the keypad, still in card mode');
    holder.setState({ unit: 'SATS', amount: String(before + 100) });
    const ctx = holder.renderContext();
    ok(ctx.sendOver === true && Math.abs(ctx.sendCapUsd - before * 100000 / 1e8) < 1e-9, 'the keypad is held to what the card holds', JSON.stringify({ cap: ctx.sendCapUsd }));
    holder.ocNext();
    ok(holder.toasts.pop() === 'That is more than the card holds.' && holder.state.screen === 'amount', 'and NEXT says so');
    holder.setState({ amount: '5000' });
    holder.ocNext();
    ok(holder.toasts.pop() === 'This mint sends at least 10,000 sats on chain.' && holder.state.screen === 'amount', 'under the floor: the same words as from the phone', holder.state.screen);
    ok(c.balance() === before && H.W.cardOwed().length === 0 && books().length === 0, 'nothing came off the card, and the books add up');
    holder.back();
    update();
  }

  /* ---- 9: the per tap limit applies to amount and reserve, as at a till ------------------------------------------------ */
  {
    // 700 a tap against 10,064: fifteen limits' worth, as $300 against a $20 limit; ten askings and four for each after the first: 62, too long to hold
    c.tap();
    await H.W.cardSetLimit(c, { sats: 700, tap: true });
    await toCard();
    const before = c.balance();
    await toConfirm(uri(10000));
    holder.confirmSpec().go();
    await until('the card to refuse', () => !!card(holder));
    ok(/PER TAP LIMIT/.test(card(holder).title) && c.balance() === before && outsHeld().length === 0 && !H.W.cardOwed().length,
       'a payment of fifteen limits’ worth: OVER THE CARD’S PER TAP LIMIT, and nothing taken', card(holder).title);
    closeCards(holder);
    await tapsDone();
    c.tap();
    await H.W.cardSetLimit(c, { sats: 0, tap: true });
    ok(books().length === 0, 'the books add up', books().join(' / '));
  }

  /* ---- every timer of the app's stops: none repeats, and none is left but the on-chain watch and the pending sweeps ---- */
  {
    for (const a of [holder]) { realClear(a._ocWatchT); live.delete(a._ocWatchT); }
    const left = Array.from(live.values());
    ok(repeating.size === 0, 'every timer that repeats has been stopped (the card sheet’s seconds, the screens behind it)', JSON.stringify(Array.from(repeating.values())));
    ok(left.length === 2 && left.every((t) => t.where === 'showPayPending') && left.map((t) => t.ms).sort((a, b) => a - b).join() === '30000,150000',
       'what is still to fire is PAYMENT PENDING’s two sweeps, each once, which end by themselves; the on-chain watch’s next pass was stopped', JSON.stringify(left));
    for (const id of Array.from(live.keys())) realClear(id);
    live.clear();
    ok(live.size === 0, 'and once those are stopped, none is left');
  }

  console.log(failed || until.failed ? '\n' + (failed + until.failed) + ' FAILED' : '\nall flashcard-onchain checks pass');
  process.exit(failed || until.failed ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
