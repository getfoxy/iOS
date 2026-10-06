'use strict';
/* flashcard-screens.js — the FLASHCARD screens, driven as a person drives them.
 *
 *     node tests/flashcard-screens.js
 *
 * The screens are build/app/26f-flashcard.js over the PIN pad, the cards and
 * the stage screens (10-pin.js, 11-cards.js, 26e-loaders.js). Those four parts
 * are made into a class here and run against the real wallet, a test mint and
 * the model of the card (flashcard-kit.js): keys are pressed on the pad,
 * buttons on the cards, and a card is "tapped" by putting it where the phone's
 * NFC stand-in finds it. What is checked is what a person would see, and that
 * the money is where the screen says it is.
 *
 * The render snapshots pin how these look. This pins what they do. */
const fs = require('fs');
const path = require('path');
const { funded, newCard, history, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

const PARTS = ['10-pin.js', '11-cards.js', '26e-loaders.js', '26f-flashcard.js']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'build', 'app', f), 'utf8')).join('\n');

/* The four parts as a class over this page's window, and an app of it with
 * the rest of the app class stood in for: state, navigation, and the few
 * helpers the parts call. */
function appOn(ctx, start) {
  const Parts = new Function('window', 'document', 'localStorage', 'return class {\n' + PARTS + '\n};')(
    ctx.window, ctx.window.document, ctx.window.localStorage);
  const a = new Parts();
  a.state = Object.assign({ screen: 'home', stack: [], fc: null, invoice: '', invoiceIsAddress: false }, start || {});
  a.setState = (x) => { Object.assign(a.state, typeof x === 'function' ? x(a.state) : x); };
  a.forceUpdate = () => {};
  a.toasts = [];
  a.seen = {};
  a.toast = (m) => a.toasts.push(m);
  a.group = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  a.haptic = () => {};
  a.px = () => 0;
  a.usd = (v) => v.toFixed(2);
  a.BLOCKED_INFO = () => null;
  a.offlineNow = () => !!a.offline;
  a.offlineNo = (what) => a.toasts.push(what + ' needs a connection.');
  a.mintName = () => 'Test';
  a.mintNameOf = () => 'Test';
  a.goSwitchMint = () => { a.state.screen = 'switchMint'; };
  a.balNow = () => ({ sats: a.have || 0 });
  a.refreshBalance = () => ctx.W.balanceSats().then((n) => { a.have = n; });
  a.loadHistory = () => {};
  a.closeReceive = () => { a.state.screen = 'home'; };
  a.noteReceived = () => {};
  a.txIsNew = (h) => { const fresh = !a.seen[h]; a.seen[h] = true; return fresh; };
  a.wantedSats = () => a.asking || 0;
  return a;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/* Wait for something to be true of the screen, a few thousand turns at most. */
async function until(what, cond) {
  for (let i = 0; i < 6000; i++) { if (cond()) return true; await tick(); }
  ok(false, 'waited for: ' + what);
  return false;
}
const leaves = (root) => Array.from(root.querySelectorAll('div')).filter((d) => d.childElementCount === 0);
const click = (el) => el.dispatchEvent(new (el.ownerDocument.defaultView.Event)('click', { bubbles: true }));

/* The pad that is up: its title, its subtitle, its red line, and its keys. */
function pad(a) {
  const root = a._pinEl;
  if (!root || !root.parentNode) return null;
  const kids = Array.from(root.children);
  const find = (text) => leaves(root).filter((d) => d.textContent === text)[0];
  return {
    title: kids[0].textContent, sub: kids[1].textContent, note: kids[3].textContent, figure: kids[2].textContent,
    type(digits, cta) {
      String(digits).split('').forEach((d) => click(find(d).parentNode));
      click(find(cta || 'NEXT'));
    },
    press(label) { click(find(label)); },
    has(label) { return !!find(label); },
  };
}
/* The card that is up: its title, its words, and its buttons by their label. */
function card(a) {
  const root = a._blockedEl;
  if (!root || !root.parentNode) return null;
  // past the glow and the mark in the circle (! or \u00d7; the asking card's is a drawing)
  const texts = leaves(root).map((d) => d.textContent).filter((t) => t && t !== '!' && t !== '\u00d7');
  return {
    title: texts[0], reason: texts[1], all: texts.join(' | '),
    press(label) { click(leaves(root).filter((d) => d.textContent === label)[0]); },
    has(label) { return texts.indexOf(label) >= 0; },
  };
}
const stage = (ctx) => { const el = ctx.window.document.getElementById('foxy-stage'); return el ? el.getAttribute('data-stage') : ''; };
const vals = (a) => a.renderFlashcard({ s: a.state, sc: a.state.screen });
const settle = async () => { for (let i = 0; i < 300; i++) await tick(); };

(async () => {
  const H = await funded({}, 6000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const holder = appOn(H);
  const till = appOn(R, { screen: 'confirm' });
  await holder.refreshBalance();
  const c = newCard(H);

  /* ---- MENU > FLASHCARD, and a new card ------------------------------------ */
  holder.goFlashcard();
  let v = vals(holder);
  ok(holder.state.screen === 'flashcard' && v.isFlashcard && v.fcNone && !v.fcHas && v.fcRows.length === 0 && v.fcNotes.length === 0,
     'the screen opens asking for a card, with nothing else on it');
  H.nfc = null;
  holder.fcRead();
  await settle();
  ok(!stage(H) && !card(holder) && !holder.state.fc, 'the sheet dismissed with no card: back on the screen, and no card over it');
  H.nfc = c;
  holder.fcRead();
  await until('the new card to be read', () => !!holder.state.fc);
  v = vals(holder);
  ok(v.fcHas && v.fcNew && !v.fcUsable && v.fcChip === 'NO PIN YET' && v.fcBalance === '₿ 0' && !stage(H),
     'a card out of its packet reads as new, with one thing to do', v.fcChip);
  ok(H.sheet.join(' / ').indexOf('begin: Hold the card to the top of the phone') >= 0 && H.sheet.indexOf('say: Reading the card') >= 0 && H.sheet.indexOf('end: Done') >= 0,
     'and the phone’s own sheet was told what was happening', H.sheet.slice(-3).join(' / '));

  holder.fcSetUp();
  ok(pad(holder).title === 'CHOOSE A PIN', 'setting it up starts with a PIN');
  pad(holder).type('123');
  ok(pad(holder).note === 'At least four digits.' && pad(holder).title === 'CHOOSE A PIN', 'of four digits or more');
  pad(holder).type('4');
  ok(pad(holder).title === 'TYPE IT AGAIN', 'typed twice');
  pad(holder).type('1235');
  ok(pad(holder).title === 'CHOOSE A PIN' && /did not match/.test(pad(holder).note), 'and two that differ start it again', pad(holder).note);
  pad(holder).type('1234');
  pad(holder).type('1234');
  ok(!pad(holder) && card(holder) && card(holder).title === 'IF THE CARD IS LOST' && card(holder).has('RECOVERABLE') && card(holder).has('LIKE CASH'),
     'then the one choice: recoverable, or like cash', card(holder) && card(holder).title);
  c.tap();
  card(holder).press('RECOVERABLE');
  await until('the card to be set up', () => card(holder) && card(holder).title === 'THE CARD IS READY');
  v = vals(holder);
  ok(v.fcUsable && !v.fcNew && v.fcChip === 'PIN SET' && holder.state.fc.mine && holder.state.fc.recoverable,
     'one tap later it is this phone’s card, with a PIN, and recoverable');
  ok(v.fcFacts.map((f) => f.label).join() === 'MINT,HOLDS,IF LOST,LIMIT' && /This phone can take it back/.test(v.fcFacts[2].value) && v.fcFacts[3].value === 'No limit',
     'and the screen says where its money is, what it holds, what happens if it is lost, and its limit', v.fcFacts.map((f) => f.value).join(' / '));

  /* ---- add funds -------------------------------------------------------------- */
  c.tap();
  card(holder).press('ADD FUNDS');
  ok(pad(holder) && pad(holder).title === 'ADD FUNDS' && /You have ₿6,000/.test(pad(holder).sub), 'ADD FUNDS asks how much, and says what there is', pad(holder) && pad(holder).sub);
  pad(holder).type('99999');
  ok(pad(holder).title === 'ADD FUNDS' && pad(holder).note === 'You have ₿6,000.', 'more than the phone holds is refused on the pad');
  pad(holder).type('2000');
  ok(pad(holder).title === 'CARD PIN' && /add ₿2,000/.test(pad(holder).sub), 'then the card’s PIN', pad(holder).sub);
  pad(holder).type('1234');
  await until('the money to be on the card', () => card(holder) && card(holder).title === 'ON THE CARD');
  ok(c.balance() === 2000 && /₿2,000 went onto the card. It now holds ₿2,000\./.test(card(holder).reason) && holder.state.fc.balance === 2000,
     'and 2,000 sats are on it, and the screen says so', card(holder).reason);
  const added = history(H).filter((e) => e.memo === 'to card')[0];
  ok(added && holder.seen[added.hash] === true && H.W.cardOwed().length === 0, 'its entry is one the app will not announce a second time, and nothing is left owed');
  card(holder).press('DONE');
  await until('the mint’s word on the card', () => holder.state.fc.check === 'ok');
  ok(vals(holder).fcCheck === 'Checked with the mint', 'the mint is asked about what the card says it holds');

  // a wrong PIN: the pieces are made and wait, and the screen says so wherever it is opened
  c.tap();
  holder.fcAdd();
  pad(holder).type('500');
  pad(holder).type('9999');
  await until('the wrong PIN to be said', () => card(holder) && card(holder).title === 'WRONG PIN');
  ok(card(holder).reason === '2 tries left.' && card(holder).has('TRY AGAIN') && c.balance() === 2000 && H.W.cardOwed().length === 1,
     'a wrong PIN at the tap: said with the tries left, and the 500 is kept for the card', card(holder).reason);
  v = vals(holder);
  ok(v.fcNotes.length === 1 && /₿500 is waiting to go onto CARD/.test(v.fcNotes[0].text), 'the screen carries a line for it', v.fcNotes[0] && v.fcNotes[0].text);
  c.tap();
  card(holder).press('TRY AGAIN');
  ok(pad(holder).title === 'CARD PIN' && /put ₿500 on the card/.test(pad(holder).sub), 'TRY AGAIN asks for the PIN, not for the amount again', pad(holder).sub);
  pad(holder).type('1234');
  await until('the 500 to be on the card', () => card(holder) && card(holder).title === 'ON THE CARD');
  ok(c.balance() === 2500 && H.W.cardOwed().length === 0 && vals(holder).fcNotes.length === 0, 'and the right PIN finishes it: 2,500 on the card, nothing waiting');
  card(holder).press('DONE');

  /* ---- being paid by the card, at somebody else's phone ----------------------- */
  till.asking = 1000;
  R.nfc = c;
  c.tap();
  till.payByCard();
  ok(pad(till).title === 'CARD PIN' && /To pay ₿1,000/.test(pad(till).sub), 'CARD on the receive screen asks for the card’s PIN, with the amount', pad(till).sub);
  pad(till).type('0000');
  await until('the till to say the PIN was wrong', () => card(till) && card(till).title === 'WRONG PIN');
  ok(card(till).reason === '2 tries left. Nothing was taken.' && (await R.W.balanceSats()) === 0 && c.balance() === 2500 && till.state.screen === 'confirm',
     'a wrong PIN: said, nothing taken, and the invoice is still up', card(till).reason);
  c.tap();
  card(till).press('TRY AGAIN');
  pad(till).type('1234');
  await until('the payment to be made', () => till.state.screen === 'home');
  await settle();
  ok((await R.W.balanceSats()) === 1000 && !card(till) && !stage(R), 'the right PIN: 1,000 sats paid, the receive screen closed, and no card left over it');
  ok(R.sheet.indexOf('say: Keep the card there: asking the mint') >= 0 && R.sheet.indexOf('say: Putting change back on the card') >= 0,
     'and the sheet said to keep the card there while the mint was asked and the change went back');
  const paid = history(R).filter((e) => e.memo === 'card')[0];
  ok(paid && !till.seen[paid.hash] && R.W.tagsFor(paid.hash).to === 'card payment', 'its entry is left for the history pass to announce, as a payment');
  ok(c.balance() === 1500 && R.W.cardOwed().length === 0, 'the card holds its change: 1,500', String(c.balance()));

  till.state.screen = 'confirm';
  till.asking = 99999;
  c.tap();
  till.payByCard();
  pad(till).type('1234');
  await until('too little to be said', () => card(till) && card(till).title === 'NOT ENOUGH ON THE CARD');
  ok(card(till).reason === 'It holds ₿1,500. Nothing was taken.' && c.balance() === 1500, 'more than the card holds: refused before it signs anything', card(till).reason);
  card(till).press('CLOSE');

  // the card leaves before its change is written: paid, and the change waits for it.
  // A card of one piece, so there is change to give: set up as cash, with the wallet itself
  const c2 = newCard(H);
  await H.W.cardSetUp(c2, { pin: '1234' });
  c2.tap();
  await H.W.cardAdd(c2, { sats: 1024, pin: '1234' });
  till.state.screen = 'confirm';
  till.asking = 200;
  R.nfc = c2;
  // armed at the tap itself: the phone's session begins by finding the card afresh
  const tap0 = c2.tap;
  c2.tap = () => { tap0(); c2.leaveBefore('30', 1); c2.tap = tap0; };
  till.payByCard();
  pad(till).type('1234');
  await until('the change to be left waiting', () => card(till) && card(till).title === 'TAP THE CARD AGAIN');
  const owed = R.W.cardOwed().reduce((n, r) => n + r.sats, 0);
  ok((await R.W.balanceSats()) === 1200 && owed === 824 && c2.balance() === 0 && /\u20bf824 of change is waiting to go back on the card/.test(card(till).reason),
     'pulled away before its change was written: the payment stands and the change waits', card(till).reason);
  R.nfc = c;
  c.tap();
  card(till).press('TAP CARD');
  ok(/put \u20bf824 on the card/.test(pad(till).sub), 'TAP CARD asks its PIN again', pad(till).sub);
  pad(till).type('1234');
  await until('the wrong card to be noticed', () => card(till) && card(till).title === 'A DIFFERENT CARD');
  ok(R.W.cardOwed().length === 1 && /\u20bf824 is waiting for CARD/.test(card(till).reason), 'another card tapped instead gets none of it, and the till says which card it is for', card(till).reason);
  card(till).press('CLOSE');
  R.nfc = c2;
  c2.tap();
  till.fcWriteAsk({});
  pad(till).type('1234');
  await until('the change to be back on the card', () => card(till) && card(till).title === 'ON THE CARD');
  ok(c2.balance() === 824 && R.W.cardOwed().length === 0 && card(till).reason === '\u20bf824 went onto the card.',
     'and the right card\u2019s second tap puts it back, without the till being shown what the card holds', card(till).reason);
  card(till).press('DONE');
  ok(till.state.fc === null, 'nor is a payer\u2019s card left on show under the till\u2019s menu');

  /* ---- its limit, its PIN ---------------------------------------------------- */
  H.nfc = c;
  c.tap();
  holder.fcRead();
  await until('the card to be read again', () => holder.state.fc && holder.state.fc.balance === c.balance());
  holder.fcSetLimit();
  ok(pad(holder).title === 'SET LIMIT' && pad(holder).has('NO LIMIT'), 'SET LIMIT asks for an amount, or none');
  pad(holder).type('700');
  c.tap();
  pad(holder).type('1234');
  await until('the limit to be set', () => holder.state.fc.limit === 700);
  ok(vals(holder).fcFacts[3].value === 'One PIN entry can spend ₿700', 'and the card says its limit', vals(holder).fcFacts[3].value);
  till.state.screen = 'confirm';
  till.asking = 900;
  R.nfc = c;
  c.tap();
  till.payByCard();
  pad(till).type('1234');
  await until('the limit to refuse', () => card(till) && card(till).title === 'OVER THE CARD’S LIMIT');
  ok(/Nothing was taken/.test(card(till).reason) && (await R.W.balanceSats()) === 1200, 'a till asking for more than the limit is refused, with nothing signed', card(till).reason);
  card(till).press('CLOSE');

  holder.fcChangePin();
  pad(holder).type('1234');
  pad(holder).type('4321');
  c.tap();
  pad(holder).type('4321');
  await until('the PIN to be changed', () => card(holder) && card(holder).title === 'PIN CHANGED');
  card(holder).press('DONE');

  /* ---- withdraw ------------------------------------------------------------ */
  c.tap();
  holder.fcRead();
  await until('the card to be read', () => holder.state.fc && holder._fcCard && holder.state.fc.check !== 'asking');
  await holder.refreshBalance();
  const hadBefore = holder.have;
  const onCard = c.balance();
  holder.fcWithdraw();
  ok(pad(holder).title === 'WITHDRAW' && pad(holder).has('ALL OF IT (₿' + holder.group(onCard) + ')'), 'WITHDRAW offers an amount, or all of it');
  pad(holder).press('ALL OF IT (₿' + holder.group(onCard) + ')');
  ok(!pad(holder) && card(holder) && card(holder).title === 'OVER THE CARD’S LIMIT' && card(holder).has('SET LIMIT'),
     'a card holding more than its limit will not be emptied in one go, and the screen says so before the PIN', card(holder) && card(holder).reason);
  card(holder).press('SET LIMIT');
  pad(holder).press('NO LIMIT');
  c.tap();
  pad(holder).type('4321');
  await until('the limit to be off', () => holder.state.fc.limit === 0);
  ok(holder.toasts.indexOf('No limit.') >= 0, 'SET LIMIT from there takes the limit off');
  holder.fcWithdraw();
  c.tap();
  pad(holder).press('ALL OF IT (₿' + holder.group(onCard) + ')');
  ok(pad(holder).title === 'ENTER PIN TO WITHDRAW', 'then: ENTER PIN TO WITHDRAW');
  pad(holder).type('4321');
  await until('the money to be in the wallet', () => card(holder) && card(holder).title === 'IN YOUR WALLET');
  await settle();
  ok(c.balance() === 0 && (await H.W.balanceSats()) === hadBefore + onCard && holder.state.fc === null,
     'all of it is in the phone, the card is empty, and the screen asks for a tap again', card(holder).reason);
  const out = history(H).filter((e) => e.memo === 'from card')[0];
  ok(out && holder.seen[out.hash] === true, 'and its entry is not announced a second time');
  card(holder).press('DONE');

  /* ---- the cards this phone loaded, and its last month ------------------------ */
  v = vals(holder);
  ok(v.fcHasRows && v.fcRows.length === 1 && v.fcRows[0].sub === 'Empty when last seen', 'the card is listed, as empty when last seen', v.fcRows[0] && v.fcRows[0].sub);
  c.tap();
  holder.fcRead();
  await until('the card to be read', () => !!holder.state.fc);
  holder.fcAdd();
  pad(holder).type('1024');
  c.tap();
  pad(holder).type('4321');
  await until('1,024 to be on the card', () => card(holder) && card(holder).title === 'ON THE CARD');
  card(holder).press('DONE');
  ok(vals(holder).fcLinks.map((k) => k.label).join() === 'CHANGE PIN,SET LIMIT', 'with a year to run there is nothing to renew');
  const real = H.window.Date.now.bind(H.window.Date);
  const realHere = Date.now;
  const move = (ms) => { H.window.Date.now = () => real() + ms; Date.now = () => realHere() + ms; };
  move(350 * 86400000);
  v = vals(holder);
  ok(v.fcLinks.map((k) => k.label).join() === 'CHANGE PIN,SET LIMIT,RENEW' && /^Renew by /.test(v.fcFacts[2].value),
     'in its last month the screen says RENEW, and by when', v.fcFacts[2].value);
  c.tap();
  const entriesBefore = history(H).map((e) => e.hash);
  holder.fcRenew();
  pad(holder).type('4321');
  await until('the card to be renewed', () => card(holder) && card(holder).title === 'ON THE CARD');
  ok(c.balance() === 1024 && vals(holder).fcLinks.length === 2 && history(H).filter((e) => entriesBefore.indexOf(e.hash) < 0).length === 2
     && history(H).filter((e) => entriesBefore.indexOf(e.hash) < 0).every((e) => holder.seen[e.hash]),
     'renewed in one tap: the same 1,024, a year on, its two entries not announced', card(holder).reason);
  card(holder).press('DONE');

  // a year later the card is lost
  move(800 * 86400000);
  holder.goFlashcard();
  v = vals(holder);
  ok(v.fcRows[0].text === 'TAKE BACK' && v.fcRows[0].sub === '₿1,024 when last seen', 'past its date the list offers to take it back', v.fcRows[0].text);
  v.fcRows[0].tap();
  ok(card(holder).title === 'TAKE IT BACK?' && /lost or blocked/.test(card(holder).reason), 'asked first, and told what it is for', card(holder).reason);
  await holder.refreshBalance();
  const beforeBack = holder.have;
  card(holder).press('TAKE IT BACK');
  await until('the money to be back', () => card(holder) && card(holder).title === 'BACK IN YOUR WALLET');
  ok((await H.W.balanceSats()) === beforeBack + 1024 && /₿1,024 from the card/.test(card(holder).reason) && !stage(H), 'and 1,024 sats are back with no card', card(holder).reason);
  card(holder).press('DONE');
  ok(vals(holder).fcRows[0].sub === 'Taken back', 'the list says so');
  H.window.Date.now = real;
  Date.now = realHere;

  /* ---- what cannot be done, said before a pad is raised ----------------------- */
  holder.offline = true;
  till.offline = true;
  till.state.screen = 'confirm';
  till.asking = 100;
  till.payByCard();
  ok(!pad(till) && /A card payment needs a connection/.test(till.toasts.join('|')), 'offline, CARD says it needs a connection and asks for nothing');
  holder.offline = false;
  till.offline = false;
  till.asking = 0;
  till.payByCard();
  ok(!pad(till) && /Enter an amount first/.test(till.toasts.join('|')), 'with no amount asked for, it says so');
  R.nfc = 'off';
  till.asking = 100;
  till.payByCard();
  pad(till).type('1234');
  await until('a phone with no reader to say so', () => card(till) && card(till).title === 'NO CARD READER');
  card(till).press('CLOSE');
  ok(!stage(R), 'and a phone that cannot read a card says that, with nothing left on screen');

  console.log('\n' + (failed ? failed + ' flashcard-screens check(s) failed' : 'all flashcard-screens checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
