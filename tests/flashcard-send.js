'use strict';
/* flashcard-send.js — SEND on a card's own screen: a payment made from the card.
 *
 *     node tests/flashcard-send.js
 *
 * The card's screen has RECEIVE (what ADD FUNDS was) and SEND (where WITHDRAW was). SEND opens the app's own SEND
 * MONEY screen in card mode: the camera as ever, the card's WITHDRAW at the top of the rows, PASTE, CONTACTS and TYPE,
 * and no SEND ECASH or FLASHCARD. What is read goes to the app's own confirmation, with a FROM / FLASHCARD row and NEXT
 * for PAY; NEXT reads the payment's total (its amount and the fee the confirmation showed) off the card exactly as a
 * till reads a card that pays it, and the pieces the card pays are held for that payment and melted, those and no others.
 * A payment that is not made puts them back on the card at its next tap, as a till's refusal does.
 *
 * The screens are build/app/26f-flashcard.js and the send flow's own parts, lifted out of their files
 * (flashcard-ui-kit.js, `send: true`), over the real wallet, the test mint (tests/harness.js) and the model of the card
 * of software 1.20 (tests/flashcard-card.js). What is checked is what a person sees, that the card and the mint say the
 * money is where the screen says it is, and that this phone's books add up (tests/harness.js, the books).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { funded, newCard, history } = require('./flashcard-kit');
const { appOn, until, pad, card, stage, vals, settle } = require('./flashcard-ui-kit');
const { booksWrong } = require('./harness');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

const MARKUP = fs.readFileSync(path.join(__dirname, '..', 'build', 'markup.html'), 'utf8');
// a block of the page's markup: from its sc-if to the next screen's
const block = (start, end) => MARKUP.slice(MARKUP.indexOf(start), MARKUP.indexOf(end, MARKUP.indexOf(start)));
const SEND_HOW = block('<sc-if value="{{ isSendHow }}">', '<sc-if value="{{ isChange }}">');
const CARD_SCREEN = block('<sc-if value="{{ isFlashcard }}">', '<sc-if value="{{ isFieldLog }}">');
/* The rows of SEND MONEY a person sees, top to bottom, for the screen's values: each row's label, where its sc-if is on. */
const rowsShown = (v) => {
  const col = SEND_HOW.slice(SEND_HOW.indexOf('<!-- The column of buttons'));
  const out = [];
  const re = /<sc-if value="\{\{ (\w+) \}\}"[^>]*>([\s\S]*?)<\/sc-if>/g;
  let m;
  while ((m = re.exec(col))) {
    const label = (/>([A-Z ]{4,})<\/div>\s*<\/div>\s*$/.exec(m[2].trim()) || /font-size:22px[^>]*>([A-Z ]+)<\/div>/.exec(m[2]) || [])[1];
    if (v[m[1]]) out.push(label);
  }
  return out;
};

// an invoice the test mint pays, for `sats` (its amount is in nano-bitcoin, ten to a sat)
const invoice = (sats) => 'lnbc' + (sats * 10) + 'n1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq';
// a Lightning address's server: asked for an amount, an invoice for it with the description hash of what it described (tests/home-first.js)
const META = '[["text/plain","Pay alice"]]';
const invoiceFor = (prefix, text) => {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const hash = crypto.createHash('sha256').update(text, 'utf8').digest();
  const words = [];
  let acc = 0, bits = 0;
  for (const b of hash) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; words.push((acc >> bits) & 31); }
    acc &= (1 << bits) - 1;
  }
  if (bits) words.push((acc << (5 - bits)) & 31);
  return prefix + [0, 0, 0, 0, 0, 0, 0, 23, 1, 20].concat(words, new Array(104).fill(0)).map((v) => CHARSET[v]).join('') + 'qqqqqq';
};
const addressServer = (m) => (/^https:\/\/addr\.test\//.test(String(m.url)) ? '200\n' + JSON.stringify(/\/\.well-known\//.test(m.url)
  ? { tag: 'payRequest', callback: 'https://addr.test/cb', minSendable: 1000, maxSendable: 100000000, metadata: META }
  : { pr: invoiceFor('lnbc' + Math.round(Number(/amount=(\d+)/.exec(m.url)[1]) / 100) + 'n1', META) }) : null);

(async () => {
  const H = await funded({}, 6000);
  H.fate = addressServer;
  const holder = appOn(H, {}, { send: true });
  await holder.refreshBalance();
  // the camera, as the phone's bridge has it: started over the pane the template lays out (`syncPreview`)
  const camera = [];
  H.W.startPreview = (el) => { camera.push(el); return true; };
  H.W.stopPreview = () => {};
  H.W.startPasteButton = () => false;
  H.W.stopPasteButton = () => {};
  const pane = H.window.document.createElement('div');
  pane.setAttribute('data-qr-vignette', '1');
  H.window.document.body.appendChild(pane);

  // a card of software 1.20 (the one that signs once for a payment), set up by this phone with no PIN, and 2,000 on it
  const c = newCard(H, undefined, { format: 4 });
  await H.W.cardSetUp(c, {});
  c.tap();
  await H.W.cardAdd(c, { sats: 2000, owner: true });
  await holder.refreshBalance();

  /* The card's screen, with this card read on it, from home. */
  const toCard = async (which) => {
    const k = which || c;
    // whatever the last part left up is closed, as a person closes it
    for (let i = 0; i < 5 && holder._blockedEl && holder._blockedEl.parentNode; i++) holder.dismissCard(holder._blockedKind);
    holder.setState({ screen: 'home', stack: [], sendFrom: '' });
    holder.syncCardOut();
    H.nfc = k;
    holder.goFlashcard();
    await until('the card to be read', () => !!holder.state.fc && holder.state.fc.key === k.key && holder.state.fc.check !== 'asking');
    await settle();
  };
  const sendVals = () => holder.renderSend({ s: holder.state, sc: holder.state.screen, emailOk: false });
  // the app's componentDidUpdate, as far as these screens are concerned
  const update = () => { holder.syncCardOut(); holder.syncSend(); };
  /* An invoice pasted on SEND MONEY, and its fee asked of the mint, as the confirmation does by itself. */
  const pasted = async (inv) => {
    holder._quotedFor = null;
    holder.acceptTarget(inv);
    update();
    await until('the fee to be quoted', () => holder.state.quotedFee != null || !holder.state.quotingFee && holder.state.screen !== 'sendConfirm');
    update();
  };
  const sentDone = () => until('the payment to be made', () => holder.state.screen === 'sendDone' && holder.state.sendPhase === 'settled');
  const held = () => JSON.parse(H.storage.getItem('foxy.cashu.held') || '{}');
  const outsHeld = () => Object.keys(held()).filter((k) => /^cardout-/.test(k));
  const melting = () => JSON.parse(H.storage.getItem('foxy.cashu.melting') || '[]');
  const books = () => booksWrong(H);
  // the tap that is going on is over (its sheet, and what it reads after), so the card can be spoken to by itself again
  const tapsDone = async () => { await until('the tap to be over', () => !(holder._fcTaps > 0)); await settle(); };

  await toCard();
  ok(holder.state.screen === 'flashcard' && holder.state.fc.balance === 2000, 'the card is read on its own screen, with 2,000 on it', String(holder.state.fc.balance));

  /* ---- 1: the card's screen: RECEIVE and SEND ------------------------------------------------------------------- */
  {
    const tile = (handler) => {
      const i = CARD_SCREEN.indexOf('sc-camel-on-click="{{ ' + handler + ' }}"');
      return i < 0 ? '' : (/white-space:nowrap">([A-Z ]+)<\/div><\/div>/.exec(CARD_SCREEN.slice(i, i + 3000)) || [])[1];
    };
    ok(tile('fcAdd') === 'RECEIVE' && tile('fcSend') === 'SEND' && !tile('fcWithdraw'),
       'the card’s two tiles read RECEIVE (what ADD FUNDS did) and SEND, which takes WITHDRAW’s place', tile('fcAdd') + ' | ' + tile('fcSend'));
    ok(!/>ADD FUNDS</.test(CARD_SCREEN) && !/nowrap">WITHDRAW</.test(CARD_SCREEN), 'and nothing on the card’s screen says ADD FUNDS or WITHDRAW any more');
    const v = vals(holder);
    ok(typeof v.fcSend === 'function' && typeof v.fcAdd === 'function', 'SEND has its handler, and RECEIVE keeps ADD FUNDS’s');
  }

  /* ---- 2: SEND opens SEND MONEY in card mode --------------------------------------------------------------------- */
  {
    camera.length = 0;
    vals(holder).fcSend();
    update();
    const s = holder.state;
    ok(s.screen === 'sendHow' && s.sendFrom === 'card' && s.flow === 'send' && s.stack[s.stack.length - 1] === 'flashcard' && holder.fcOutMode(),
       'SEND opens the send screen, in card mode, over the card’s screen', JSON.stringify({ screen: s.screen, from: s.sendFrom, stack: s.stack }));
    const v = sendVals();
    ok(v.clWdOn === true && v.clEcashOn === false && v.clCardOn === false && v.clPasteOn && v.clContactsOn && v.clTypeOn && typeof v.goWithdraw === 'function',
       'its values: WITHDRAW on, SEND ECASH and FLASHCARD off, PASTE, CONTACTS and TYPE as ever');
    ok(rowsShown(v).join() === 'WITHDRAW,PASTE,CONTACTS,TYPE', 'the rows a person sees are WITHDRAW, PASTE, CONTACTS and TYPE, in that order', rowsShown(v).join());
    holder.syncPreview();
    ok(camera.length === 1 && camera[0] === pane, 'and the camera is asked for over the screen’s pane, as on any SEND MONEY');
    ok(/data-rail-disc="withdraw"[\s\S]*?M12 19V5m0 0-6 6m6-6 6 6/.test(SEND_HOW) && /data-foxy-cardwd="1"[\s\S]*?M4\.6 5\.5h14\.8/.test(SEND_HOW),
       'WITHDRAW is drawn as the other rows are: a disc with an arrow up, and the card’s outline faint behind it');
  }

  /* ---- 3: back leaves card mode -------------------------------------------------------------------------------- */
  {
    holder.back();
    update();
    ok(holder.state.screen === 'flashcard' && holder.state.sendFrom === '' && !holder.fcOutMode(), 'back is the card’s screen, and card mode is over', holder.state.sendFrom);
    // an empty card has nothing to send
    const real = holder.state.fc;
    holder.state.fc = Object.assign({}, real, { balance: 0 });
    holder.toasts.length = 0;
    vals(holder).fcSend();
    ok(holder.state.screen === 'flashcard' && holder.toasts.indexOf('There is nothing on this card.') >= 0, 'SEND on a card with nothing on it says so, and goes nowhere');
    holder.state.fc = real;
    // home's own SEND is this phone's, with SEND ECASH and FLASHCARD and no WITHDRAW
    holder.setState({ screen: 'home', stack: [] });
    update();
    holder.setState((p) => ({ screen: 'sendHow', stack: p.stack.concat([p.screen]), flow: 'send', sendFrom: '' }));
    update();
    const v = sendVals();
    ok(!holder.fcOutMode() && rowsShown(v).join() === 'PASTE,SEND ECASH,CONTACTS,TYPE,FLASHCARD', 'home’s SEND is as it was: PASTE, SEND ECASH, CONTACTS, TYPE and FLASHCARD', rowsShown(v).join());
  }

  /* ---- 4: an invoice pasted in card mode, to the confirmation ------------------------------------------------- */
  let spec;
  {
    await toCard();
    vals(holder).fcSend();
    update();
    await pasted(invoice(500));
    spec = holder.confirmSpec();
    const labels = spec.rows.map((r) => r.label);
    const from = spec.rows.find((r) => r.label === 'FROM') || {};
    ok(holder.state.screen === 'sendConfirm' && holder.state.sendFrom === 'card' && holder.fcOutMode(), 'a pasted invoice reaches its confirmation, still in card mode');
    ok(labels.indexOf('FROM') === labels.indexOf('NETWORK') + 1 && from.value === 'FLASHCARD' && from.sub === 'm.test',
       'with FROM / FLASHCARD / the card’s mint in a row after NETWORK', labels.join() + ' | ' + from.value + ' ' + from.sub);
    ok(spec.cta === 'NEXT' && !spec.ctaBusy && labels.indexOf('FEE') >= 0 && (spec.rows.find((r) => r.label === 'FEE') || {}).value === 'UP TO ₿ 10',
       'and the button reads NEXT, with the fee the mint quoted', spec.cta + ' | ' + (spec.rows.find((r) => r.label === 'FEE') || {}).value);
    // the same invoice from home: SEND, and no FROM row
    const was = Object.assign({}, holder.state);
    holder.state.sendFrom = '';
    holder.state.balSats = 6000;
    const plain = holder.confirmSpec();
    ok(/^SEND /.test(plain.cta) && !plain.rows.some((r) => r.label === 'FROM'), 'out of card mode the same invoice says SEND and has no FROM row', plain.cta);
    // PAYING FROM BITCOIN said the opposite of FROM FLASHCARD: in card mode it is gone, and a payment from this phone keeps it where it was
    ok(labels.indexOf('PAYING FROM') < 0 && labels.join() === 'DELIVERED TO,NETWORK,FROM,ARRIVES,FEE',
       'in card mode the confirmation has FROM / FLASHCARD and no PAYING FROM', labels.join());
    const plainLabels = plain.rows.map((r) => r.label);
    ok(plainLabels.join() === 'DELIVERED TO,PAYING FROM,NETWORK,ARRIVES,FEE' && plain.rows[1].value === 'BITCOIN',
       'and a payment from this phone has its rows as before, PAYING FROM BITCOIN second', plainLabels.join());
    holder.state.sendFrom = was.sendFrom;
  }

  /* ---- 5: NEXT reads the total off the card and pays it ------------------------------------------------------- */
  {
    const before = c.balance();
    const pileBefore = await H.W.balanceSats();
    const meltsBefore = H.mint.change.length;
    H.sheet.length = 0;
    holder.toasts.length = 0;
    spec.go();
    await sentDone();
    await tapsDone();
    ok(before - c.balance() === 510, 'NEXT reads the payment’s total off the card: its 500 and the 10 of fee the confirmation showed, and no more', (before - c.balance()) + ' sats');
    ok(H.sheet.some((x) => /^begin: /.test(x)) && !pad(holder), 'in one sheet, as a till reads a card with no PIN');
    const log = history(H);
    const out = log.find((e) => e.dir === 'out' && e.memo === 'paid from card');
    const inn = log.find((e) => e.dir === 'in' && e.memo === 'card' && e.card === c.key && e.sats === 510);
    ok(!!out && out.sats === 500 && out.feeSats === 2 && out.fromCard === c.key && out.state === 'success',
       'the melt is paid at the mint, and its entry says it was paid from the card: 500, and 2 of fee', JSON.stringify(out && { sats: out.sats, fee: out.feeSats, from: out.fromCard }));
    ok(!!inn && (H.W.tagsFor(inn.hash) || {}).to === 'card' && holder.seen[inn.hash] === true,
       'what came off the card is the holder’s own move, tagged as one and never announced', JSON.stringify(inn && { sats: inn.sats, memo: inn.memo }));
    ok((await H.W.balanceSats()) - pileBefore === 8 && H.mint.change.length > meltsBefore,
       'this phone keeps only the fee reserve the payment did not use, which came back as the melt’s change', String((await H.W.balanceSats()) - pileBefore));
    ok(outsHeld().length === 0 && melting().length === 0 && H.W.cardTaken().length === 0 && H.W.cardOwed().length === 0,
       'nothing is left held, melting, taken or owed');
    ok(books().length === 0, 'and the books add up', books().join(' / '));
    ok(holder.state.sendPhase === 'settled' && !card(holder), 'the person sees PAYMENT SENT, with nothing over it');
    // what HISTORY says of it: the app's own words for the entry (16-history-lists.js, 26-render-history-and-contacts.js)
    const appText = ['16-history-lists.js', '26-render-history-and-contacts.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'build', 'app', f), 'utf8')).join('\n');
    ok(/'paid from card': 'Paid from card'/.test(appText) && /fromCard: t\.fromCard \|\| ''/.test(appText) && /t\.fromCard && t\.dir === 'out'[^\n]*'Paid from the Flashcard'/.test(appText),
       'and HISTORY says it was paid from the Flashcard, under the payee’s name as every payment has');
  }

  /* ---- 6: the mint refuses the melt: every piece goes back on the card ---------------------------------------- */
  {
    await toCard();
    const before = c.balance();
    vals(holder).fcSend();
    update();
    await pasted(invoice(300));
    H.fate = (m) => (/\/v1\/melt\/bolt11$/.test(String(m.url)) ? '400\n' + JSON.stringify({ code: 20000, detail: 'no route to that node' }) : addressServer(m));
    holder.confirmSpec().go();
    await until('the payment to be refused', () => !!card(holder) && card(holder).title === 'NOT PAID');
    H.fate = addressServer;
    ok(/310 goes back on the card/.test(card(holder).reason) && card(holder).has('TAP CARD') && holder.state.screen === 'sendConfirm',
       'NOT PAID, and the 310 the card paid goes back on it at a tap; the person is on the confirmation', card(holder).reason);
    ok(c.balance() === before - 310 && outsHeld().length === 0 && melting().length === 0 && H.W.cardOwed().length === 1 && H.W.cardOwed()[0].kind === 'refund',
       'what the card paid is made into pieces for it and owed to it, and nothing is held or melting', JSON.stringify(H.W.cardOwed().map((r) => [r.kind, r.sats])));
    H.nfc = c;
    card(holder).press('TAP CARD');
    await until('the money to be back on the card', () => c.balance() === before && H.W.cardOwed().length === 0);
    await tapsDone();
    await settle();
    ok(c.balance() === before && !history(H).some((e) => e.dir === 'out' && e.sats === 300 && e.state === 'success'),
       'the next tap puts it back: the card holds what it held before, and nothing was paid', String(c.balance()));
    c.tap();
    const seen = await H.W.cardLook(c, { mine: true });
    const checked = await H.W.cardCheck(seen);
    ok(checked.spent === 0 && seen.balance === before, 'and the mint says every piece on it is good', JSON.stringify({ spent: checked.spent, balance: seen.balance }));
    ok(books().length === 0, 'the books add up', books().join(' / '));
  }

  /* ---- 7: a payment that cannot even be tried: the quote ran out, and the mint will not quote again ----------- */
  {
    await toCard();
    const before = c.balance();
    vals(holder).fcSend();
    update();
    await pasted(invoice(250));
    // the confirmation's quote is a few seconds from its end, and the mint now refuses the invoice
    holder._feeQuote.quote.expiry = Math.floor(Date.now() / 1000) + 5;
    H.fate = (m) => (/\/v1\/melt\/quote\/bolt11$/.test(String(m.url)) ? '400\n' + JSON.stringify({ code: 20000, detail: 'invoice expired' }) : addressServer(m));
    holder.confirmSpec().go();
    await until('the payment to be given up', () => !!card(holder) && card(holder).title === 'NOT PAID');
    H.fate = addressServer;
    ok(c.balance() === before - 260 && H.W.cardOwed().length === 1 && outsHeld().length === 0, 'the card paid 260, and all of it is owed back to it', card(holder).reason);
    H.nfc = c;
    card(holder).press('TAP CARD');
    await until('the money to be back on the card', () => c.balance() === before && H.W.cardOwed().length === 0);
    await tapsDone();
    ok(c.balance() === before && books().length === 0, 'and its next tap puts it back', books().join(' / '));
  }

  /* ---- 8: the per tap limit, as at a till ---------------------------------------------------------------------- */
  {
    c.tap();
    await H.W.cardSetLimit(c, { sats: 200, tap: true });
    await toCard();
    const before = c.balance();
    vals(holder).fcSend();
    update();
    await pasted(invoice(400));
    H.sheet.length = 0;
    holder.confirmSpec().go();
    await sentDone();
    await tapsDone();
    ok(before - c.balance() === 410 && H.sheet.some((x) => /^say: Over per tap limit/.test(x)),
       'a total over the card’s per tap limit is waited for, as at a till, and paid', H.sheet.filter((x) => /Over per tap/.test(x)).slice(0, 2).join(' / '));
    // and one too long to hold is refused before anything is signed
    c.tap();
    await H.W.cardSetLimit(c, { sats: 10, tap: true });
    await toCard();
    const now = c.balance();
    vals(holder).fcSend();
    update();
    await pasted(invoice(600));
    holder.confirmSpec().go();
    await until('the card to refuse', () => !!card(holder));
    ok(/PER TAP LIMIT/.test(card(holder).title) && c.balance() === now && outsHeld().length === 0, 'a total too long to hold the card for: OVER THE CARD’S PER TAP LIMIT, and nothing taken', card(holder).title);
    holder.dismissCard(holder._blockedKind);
    c.tap();
    await H.W.cardSetLimit(c, { sats: 0, tap: true });
    ok(books().length === 0, 'the books add up', books().join(' / '));
  }

  /* ---- 9: a card with a PIN, as at a till --------------------------------------------------------------------- */
  {
    const cp = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(cp, { pin: '1234' });
    cp.tap();
    await H.W.cardAdd(cp, { sats: 1000, owner: true });
    await toCard(cp);
    vals(holder).fcSend();
    update();
    await pasted(invoice(200));
    holder.confirmSpec().go();
    await until('the PIN pad', () => !!pad(holder));
    ok(pad(holder).title === 'CARD PIN' && pad(holder).cta === 'TAP AGAIN' && cp.balance() === 1000,
       'a card with a PIN ends the first tap asking for it, with nothing taken: CARD PIN, TAP AGAIN', pad(holder).title + ' | ' + pad(holder).cta);
    pad(holder).type('0000');
    await until('the wrong PIN', () => !!card(holder));
    ok(card(holder).title === 'WRONG PIN' && cp.balance() === 1000 && outsHeld().length === 0, 'a wrong PIN: said, and nothing taken', card(holder).reason);
    card(holder).press('TRY AGAIN');
    await until('the PIN pad again', () => !!pad(holder));
    pad(holder).type('1234');
    await sentDone();
    await tapsDone();
    ok(cp.balance() === 1000 - 210 && history(H).some((e) => e.memo === 'paid from card' && e.sats === 200 && e.fromCard === cp.key),
       'the right PIN pays it: 210 off the card, and the payment made', String(cp.balance()));
    ok(books().length === 0, 'the books add up', books().join(' / '));
  }

  /* ---- 10: the wrong card held to the phone ------------------------------------------------------------------- */
  {
    const other = newCard(H, undefined, { format: 4 });
    await H.W.cardSetUp(other, {});
    other.tap();
    await H.W.cardAdd(other, { sats: 600, owner: true });
    await toCard();
    vals(holder).fcSend();
    update();
    await pasted(invoice(100));
    H.nfc = other;
    other.sent.length = 0;
    holder.confirmSpec().go();
    await until('the other card to be refused', () => !!card(holder));
    ok(card(holder).title === 'A DIFFERENT CARD' && other.balance() === 600 && !other.sent.some((a) => /^b02[24]/.test(a)),
       'another card held to the phone is said to be another card, and nothing is asked of it', card(holder).reason);
    holder.dismissCard(holder._blockedKind);
    H.nfc = c;
  }

  /* ---- 11: a Lightning address typed in card mode -------------------------------------------------------------- */
  {
    await toCard();
    const before = c.balance();
    holder.price = 100000;
    vals(holder).fcSend();
    update();
    sendVals().pickType();
    update();
    ok(holder.state.screen === 'sendType' && holder.fcOutMode(), 'TYPE in card mode, and still in it');
    holder.setState((p) => ({ screen: 'amount', stack: p.stack.concat([p.screen]), recipient: 'alice@addr.test', recipientKind: 'email', unit: 'SATS', amount: String(before + 100) }));
    update();
    let ctx = holder.renderContext();
    ok(ctx.sendOver === true && Math.abs(ctx.sendCapUsd - before * 100000 / 1e8) < 1e-9 && ctx.sendHeld === '',
       'the keypad is held to what the card holds, not this phone’s balance', JSON.stringify({ cap: ctx.sendCapUsd, over: ctx.sendOver }));
    holder.setState({ amount: '300' });
    ctx = holder.renderContext();
    ok(ctx.sendOver === false, 'and an amount the card holds is fine');
    holder.setState((p) => ({ payFrom: 'BITCOIN', screen: 'sendConfirm', stack: p.stack.concat([p.screen]) }));
    update();
    await until('the address to be looked up and its fee quoted', () => holder.state.quotedFee != null);
    update();
    const s2 = holder.confirmSpec();
    ok(s2.cta === 'NEXT' && s2.rows.some((r) => r.label === 'FROM' && r.value === 'FLASHCARD'), 'its confirmation has the FROM row and NEXT', s2.cta);
    s2.go();
    await sentDone();
    await tapsDone();
    ok(before - c.balance() === 310 && history(H).some((e) => e.memo === 'paid from card' && e.sats === 300 && e.fromCard === c.key),
       'NEXT pays the address’s invoice from the card: 310 off it, and the payment made', String(before - c.balance()));
    holder.price = 0;
    ok(books().length === 0, 'the books add up', books().join(' / '));
  }

  /* ---- 12: on chain at a mint that pays no address, a Cashu request and an invoice with no amount are said no to ----------------------
   * (A mint that pays on chain is paid from the card there: tests/flashcard-onchain.js.) */
  {
    await toCard();
    vals(holder).fcSend();
    update();
    holder.acceptTarget('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
    await until('the mint to be asked whether it pays on chain', () => !!card(holder));
    ok(card(holder) && /WON.T WORK/.test(card(holder).title) && /does not pay bitcoin addresses/.test(card(holder).reason) && holder.state.screen === 'sendHow',
       'a bitcoin address read in card mode, at a mint with no on-chain payments: THAT WON’T WORK, saying so, and nothing moves', card(holder) && card(holder).reason);
    holder.dismissCard(holder._blockedKind);
    holder.acceptTarget('creqA' + 'b'.repeat(40));
    ok(card(holder) && /WON.T WORK/.test(card(holder).title) && /Cashu payment request/.test(card(holder).reason) && holder.state.screen === 'sendHow',
       'a Cashu payment request is said no to the same way', card(holder) && card(holder).reason);
    holder.dismissCard(holder._blockedKind);
    const amountless = 'lnbc1p4ttszqpp5c6utwdk6cmla7kmz4nf89avnlyrzqrkhz0jx06hsltwmw9afwheqdqqcqzzsxqrrs0fppq9eka5xeg7p7sezkmmkc02cpffc2ekcdssp5hcpux550uxjsc3nj3qhvqa7rmz7hsp7yel3eveh3vg8awmve4fds9qxpqysgqtsd5g8er8mhnst3eres2455nxxm4kd44c4uwa3fvu8ueqsgf4vd5ft94jk8u54ahhvx9nmlz4r4z2w7yvcpd7nrk7d8yy489lfg5djspkrewuj';
    holder.acceptTarget(amountless);
    ok(card(holder) && /names no amount/.test(card(holder).reason) && holder.state.screen === 'sendHow', 'an invoice that names no amount, too', card(holder) && card(holder).reason);
    holder.dismissCard(holder._blockedKind);
  }

  /* ---- 13: leaving the flow leaves nothing behind ------------------------------------------------------------- */
  {
    await toCard();
    const before = c.balance();
    vals(holder).fcSend();
    update();
    await pasted(invoice(150));
    holder.back();
    update();
    holder.back();
    update();
    ok(holder.state.screen === 'flashcard' && holder.state.sendFrom === '', 'back twice from the confirmation is the card’s screen, out of card mode');
    vals(holder).fcSend();
    update();
    holder.setState({ screen: 'home', stack: [] });
    update();
    ok(holder.state.sendFrom === '' && !holder.fcOutMode(), 'home from SEND MONEY ends card mode');
    holder.setState((p) => ({ screen: 'sendHow', stack: p.stack.concat([p.screen]), flow: 'send', sendFrom: '' }));
    update();
    ok(rowsShown(sendVals()).join() === 'PASTE,SEND ECASH,CONTACTS,TYPE,FLASHCARD', 'and home’s SEND afterwards is this phone’s, with no WITHDRAW', rowsShown(sendVals()).join());
    ok(c.balance() === before && H.W.cardOwed().length === 0 && H.W.cardTaken().length === 0 && outsHeld().length === 0, 'nothing came off the card');
  }

  /* ---- 14: Foxy closed between the card paying and the melt: the hold goes back to the card -------------------- */
  {
    c.tap();
    const before = c.balance();
    const r = await H.W.cardPay(c, { sats: 120, holdFor: true, only: c.key });
    ok(r.held && r.heldSats === 120 && outsHeld().length === 1 && c.balance() === before - 120, 'the card pays 120 for a payment, held to one side', JSON.stringify({ held: r.held, sats: r.heldSats }));
    ok((await H.W.cardOutsLeft()).length === 0 && outsHeld().length === 1, 'a hold that is new and in a payment’s hands is left alone');
    const realW = H.window.Date.now.bind(H.window.Date);
    const realN = Date.now;
    H.window.Date.now = () => realW() + 11 * 60000;
    Date.now = () => realN() + 11 * 60000;
    const back = await H.W.cardOutsLeft();
    H.window.Date.now = realW;
    Date.now = realN;
    ok(back.length === 1 && back[0].made && outsHeld().length === 0 && H.W.cardOwed().length === 1 && H.W.cardOwed()[0].sats === 120,
       'one left behind goes back to the card, owed to it', JSON.stringify(back));
    c.tap();
    await H.W.cardWrite(c, { owner: true });
    ok(c.balance() === before && H.W.cardOwed().length === 0, 'and the card’s next tap puts it back', String(c.balance()));
    ok(books().length === 0, 'the books add up', books().join(' / '));
  }

  /* ---- 14b: a melt whose answer never came, then UNPAID: its pieces go back to the card, not into this phone ------- */
  {
    c.tap();
    const before = c.balance();
    const r = await H.W.cardPay(c, { sats: 130, holdFor: true, only: c.key });
    const q = await H.W.quoteFee(invoice(120));
    H.fate = (m) => (/\/v1\/melt\/bolt11$/.test(String(m.url)) ? '504\n' + JSON.stringify({ detail: 'gateway timeout' }) : addressServer(m));
    const e = await H.W.pay(invoice(120), null, { quote: q, held: r.held, card: c.key }).then(() => null, (x) => x);
    H.fate = addressServer;
    ok(!!e && e.pending && melting().length === 1 && melting()[0].cardOut === r.held && outsHeld().length === 0,
       'a melt of the card’s pieces with no answer is held as any melt is, naming the card’s hold', e && e.message);
    const realW = H.window.Date.now.bind(H.window.Date);
    const realN = Date.now;
    H.window.Date.now = () => realW() + 3 * 60000;
    Date.now = () => realN() + 3 * 60000;
    const pile0 = await H.W.balanceSats();
    // (the sweep gives them back to the card's hold, and then, in the same sweep, to the card: `cardOutsLeft`)
    await H.W.sweepMelts();
    H.window.Date.now = realW;
    Date.now = realN;
    ok(melting().length === 0 && outsHeld().length === 0 && (await H.W.balanceSats()) === pile0 && H.W.cardOwed().length === 1 && H.W.cardOwed()[0].sats === 130,
       'the mint says UNPAID two minutes on: the pieces go back to the card (owed to it), not into this phone’s pile', JSON.stringify({ held: outsHeld(), owed: H.W.cardOwed().map((x) => x.sats) }));
    const back = await H.W.cardOutsLeft();
    ok(back.length === 0 && H.W.cardOwed().length === 1, 'and the connect’s sweep after it finds nothing more to give back: they are owed once', JSON.stringify(back));
    c.tap();
    await H.W.cardWrite(c, { owner: true });
    ok(c.balance() === before && books().length === 0, 'the card’s next tap puts them back, and the books add up', c.balance() + ' | ' + books().join(' / '));
  }

  /* ---- 14c: a hold that could not go back to the card with no route goes back at the next sweep, not ten minutes on ---- */
  {
    c.tap();
    const before = c.balance();
    const r = await H.W.cardPay(c, { sats: 120, holdFor: true, only: c.key });
    ok(r.held && outsHeld().length === 1 && c.balance() === before - 120, 'the card pays 120 for a payment, held to one side',
       JSON.stringify({ held: r.held, outs: outsHeld().length, paid: before - c.balance() }));
    // no route: the phone says there is no network at all
    H.W._privacy({ tor: 'connecting', network: 'none' });
    const off = await H.W.cardOutBack(r.held);
    ok(!off.made && off.sats === 120 && outsHeld().length === 1 && H.W.cardOwed().length === 0,
       'with no route the payment’s put-back is refused, and the hold stays', JSON.stringify({ off, outs: outsHeld().length, owed: H.W.cardOwed().map((x) => x.sats) }));
    // the route back
    H.W._privacy({ tor: 'up', progress: 100, everUp: true });
    const back = await H.W.cardOutsLeft();
    ok(back.length === 1 && back[0].made && outsHeld().length === 0 && H.W.cardOwed().length === 1 && H.W.cardOwed()[0].sats === 120,
       'online, the next sweep gives the hold back to the card at once', JSON.stringify({ back, outs: outsHeld().length, owed: H.W.cardOwed().map((x) => x.sats) }));
    c.tap();
    await H.W.cardWrite(c, { owner: true });
    ok(c.balance() === before && H.W.cardOwed().length === 0 && books().length === 0, 'and the card’s next tap puts it back, and the books add up', c.balance() + ' | ' + books().join(' / '));
  }

  /* ---- 16: the card taken away as it signs: the same sheet asks for it again, and it pays once -------------------- */
  {
    await toCard();
    const before = c.balance();
    vals(holder).fcSend();
    update();
    await pasted(invoice(220));
    H.sheet.length = 0;
    // the card's answer to its signature is lost at the first tap (it signed, and the phone did not hear it)
    const send0 = c.send.bind(c);
    let armed = false;
    c.send = (a) => { if (!armed) { armed = true; c.loseAnswerOf('24', 1); } return send0(a); };
    holder.confirmSpec().go();
    await sentDone();
    await tapsDone();
    c.send = send0;
    ok(before - c.balance() === 230 && H.sheet.indexOf('again: Hold to finish paying') >= 0,
       'taken away as it signs: the same sheet asks for the card again, and 230 comes off it once', (before - c.balance()) + ' | ' + H.sheet.filter((x) => /^(begin|again|end|error):/.test(x)).join(' / '));
    ok(history(H).filter((e) => e.memo === 'paid from card' && e.sats === 220 && e.state === 'success').length === 1
       && outsHeld().length === 0 && melting().length === 0 && H.W.cardTaken().length === 0 && H.W.cardOwed().length === 0,
       'and the payment is made once, with nothing left held, melting, taken or owed');
    ok(books().length === 0, 'the books add up', books().join(' / '));
  }

  /* ---- 17: the fee went up between the confirmation and the tap: nothing is paid, and all of it goes back ------------ */
  {
    await toCard();
    const before = c.balance();
    vals(holder).fcSend();
    update();
    await pasted(invoice(240));
    // the confirmation's quote is about to end, and the mint's new one wants more fee than the card was charged for
    holder._feeQuote.quote.expiry = Math.floor(Date.now() / 1000) + 5;
    H.fate = (m) => (/\/v1\/melt\/quote\/bolt11$/.test(String(m.url))
      ? '200\n' + JSON.stringify({ quote: 'risen-' + Date.now(), amount: 240, fee_reserve: 40, state: 'UNPAID', expiry: Math.floor(Date.now() / 1000) + 3600,
                                   request: invoice(240), unit: 'sat', payment_preimage: null })
      : addressServer(m));
    holder.confirmSpec().go();
    await until('the payment to be given up', () => !!card(holder) && card(holder).title === 'NOT PAID');
    H.fate = addressServer;
    ok(c.balance() === before - 250 && /fee went up/.test(card(holder).reason) && H.W.cardOwed().length === 1 && H.W.cardOwed()[0].sats === 250
       && outsHeld().length === 0 && melting().length === 0 && !history(H).some((e) => e.dir === 'out' && e.sats === 240),
       'the card was charged 250, the mint now wants more: nothing is paid, and all 250 is owed back to the card', card(holder).reason);
    H.nfc = c;
    card(holder).press('TAP CARD');
    await until('the money to be back on the card', () => c.balance() === before && H.W.cardOwed().length === 0);
    await tapsDone();
    ok(c.balance() === before && books().length === 0, 'and its next tap puts it back', books().join(' / '));
    // after that, the person is not left on a confirmation that would pay from this phone instead
    ok(holder.state.screen !== 'sendConfirm' || (holder.fcOutMode() && holder.confirmSpec().cta === 'NEXT'),
       'whatever screen is left, it is not a confirmation that pays from this phone', holder.state.screen + ' ' + holder.state.sendFrom);
  }

  /* ---- 18: pieces held for a payment are nobody else's: not a payment from this phone's balance, not a restore --------- */
  {
    c.tap();
    const before = c.balance();
    const r = await H.W.cardPay(c, { sats: 140, holdFor: true, only: c.key });
    const secrets = (held()[r.held].proofs || []).map((p) => p.secret).sort().join();
    await holder.refreshBalance();
    const pile = await H.W.balanceSats();
    await H.W.pay(invoice(50), null, {});
    ok((held()[r.held].proofs || []).map((p) => p.secret).sort().join() === secrets && (await H.W.balanceSats()) === pile - 52,
       'a payment from this phone’s own balance meanwhile is paid from its pile, and the card’s held pieces are not touched', String(pile - (await H.W.balanceSats())));
    // a restore from the seed finds the held pieces unspent at the mint: they are the card's, and are not filed in the pile as well
    const pileKey = Array.from({ length: H.storage.length }, (_, i) => H.storage.key(i)).find((k) => /^foxy\.cashu\.proofs\./.test(k) && k.indexOf('@') < 0);
    const url = pileKey.slice('foxy.cashu.proofs.'.length);
    const now = await H.W.balanceSats();
    const pileProofs = JSON.parse(H.storage.getItem(pileKey) || '[]');
    await H.W.adoptScan([{ state: 'done', url, host: 'm.test', proofs: pileProofs.concat(held()[r.held].proofs), counters: {} }], { merge: true });
    const after = JSON.parse(H.storage.getItem(pileKey) || '[]');
    const heldSet = new Set((held()[r.held].proofs || []).map((p) => p.secret));
    ok(!after.some((p) => heldSet.has(p.secret)) && (await H.W.balanceSats()) === now,
       'a restore that finds them leaves them where they are: none of them is in this phone’s balance too', String((await H.W.balanceSats()) - now));
    ok(books().length === 0, 'the books add up while they are held', books().join(' / '));
    const realW = H.window.Date.now.bind(H.window.Date);
    const realN = Date.now;
    H.window.Date.now = () => realW() + 11 * 60000;
    Date.now = () => realN() + 11 * 60000;
    await H.W.cardOutsLeft();
    H.window.Date.now = realW;
    Date.now = realN;
    c.tap();
    await H.W.cardWrite(c, { owner: true });
    ok(c.balance() === before && outsHeld().length === 0 && H.W.cardOwed().length === 0 && books().length === 0,
       'and they go back to the card once, with the books adding up', c.balance() + ' | ' + books().join(' / '));
  }

  /* ---- 19: a payment left pending that the mint then calls UNPAID: back to the card by the payment's own sweep -------- */
  {
    c.tap();
    const before = c.balance();
    const r = await H.W.cardPay(c, { sats: 130, holdFor: true, only: c.key });
    const q = await H.W.quoteFee(invoice(120));
    H.fate = (m) => (/\/v1\/melt\/bolt11$/.test(String(m.url)) ? '504\n' + JSON.stringify({ detail: 'gateway timeout' }) : addressServer(m));
    await H.W.pay(invoice(120), null, { quote: q, held: r.held, card: c.key }).then(() => null, (x) => x);
    H.fate = addressServer;
    H.W.cardOutDone(r.held);
    const realW = H.window.Date.now.bind(H.window.Date);
    const realN = Date.now;
    H.window.Date.now = () => realW() + 3 * 60000;
    Date.now = () => realN() + 3 * 60000;
    // the sweep the pending screen runs by itself (03-send.js, `showPayPending`), and no new connection after it
    await H.W.sweepMelts();
    await settle();
    H.window.Date.now = realW;
    Date.now = realN;
    const refunds = H.W.cardOwed().filter((x) => x.kind === 'refund');
    ok(melting().length === 0 && outsHeld().length === 0 && refunds.length === 1 && refunds[0].sats === 130,
       'the sweep that finds it UNPAID owes the card’s pieces back to it then, without waiting for the next connection', JSON.stringify({ held: outsHeld(), owed: H.W.cardOwed().map((x) => x.sats) }));
    c.tap();
    await H.W.cardWrite(c, { owner: true });
    ok(c.balance() === before && books().length === 0, 'and the card’s next tap puts them back', c.balance() + ' | ' + books().join(' / '));
  }

  /* ---- 20: a mint that takes only so many outputs in a request: the swap the card signs for keeps to it ---------------- */
  {
    const H2 = await funded({ maxArray: 16 }, 34000);
    const c2 = newCard(H2, undefined, { format: 4 });
    await H2.W.cardSetUp(c2, {});
    c2.tap();
    await H2.W.cardAdd(c2, { sats: 32000, owner: true });
    for (const want of [16383, 15359, 8191, 6143, 2047]) {
      c2.tap();
      const from = H2.mint.posted.length;
      const was = c2.balance();
      const r = await H2.W.cardPay(c2, { sats: want, holdFor: true, only: c2.key }).then((x) => x, (e) => ({ error: e }));
      const most = Math.max(0, ...H2.mint.posted.slice(from).filter((p) => p.path === '/v1/swap').map((p) => p.B_.length));
      ok(!r.error && r.held && most <= 16,
         'paying ' + want + ' out of this phone at a mint that takes 16 outputs: the card’s swap has ' + most + ' of them, and its pieces are held',
         r.error ? String(r.error.message) : String(r.heldSats));
      if (r.held) await H2.W.cardOutBack(r.held);
      if (r.change && r.change.sats && !r.change.written) { c2.tap(); await H2.W.cardWrite(c2, { change: true }).catch(() => {}); }
      c2.tap();
      await H2.W.cardWrite(c2, { owner: true }).catch(() => {});
      ok(c2.balance() === was && H2.W.cardOwed().length === 0, 'and all of it back on the card after', c2.balance() + ' of ' + was);
    }
    ok(booksWrong(H2).length === 0, 'the books add up', booksWrong(H2).join(' / '));
    // a mint that takes 13: 8,191 is thirteen pieces of powers of two, and what the card pays over it more, so the swap is cut as ever, and all of it held
    const H3 = await funded({ maxArray: 13 }, 12000);
    const c3 = newCard(H3, undefined, { format: 4 });
    await H3.W.cardSetUp(c3, {});
    c3.tap();
    await H3.W.cardAdd(c3, { sats: 10000, owner: true });
    c3.tap();
    const was3 = c3.balance();
    const from3 = H3.mint.posted.length;
    const r3 = await H3.W.cardPay(c3, { sats: 8191, holdFor: true, only: c3.key }).then((x) => x, (e) => ({ error: e }));
    const most3 = Math.max(0, ...H3.mint.posted.slice(from3).filter((p) => p.path === '/v1/swap').map((p) => p.B_.length));
    ok(!r3.error && r3.held && r3.heldSats >= 8191 && most3 <= 13,
       'at a mint that takes 13 outputs, 8,191 from the card: its swap has ' + most3 + ', and at least the price is held', r3.error ? String(r3.error.message) : String(r3.heldSats));
    if (r3.change && r3.change.sats && !r3.change.written) { c3.tap(); await H3.W.cardWrite(c3, { change: true }).catch(() => {}); }
    const q3 = await H3.W.quoteFee(invoice(8181));
    const paid3 = await H3.W.pay(invoice(8181), null, { quote: q3, held: r3.held, card: c3.key }).then((x) => x, (e) => ({ error: e }));
    ok(!paid3.error && c3.balance() === was3 - 8191 && !Object.keys(JSON.parse(H3.storage.getItem('foxy.cashu.held') || '{}')).length && booksWrong(H3).length === 0,
       'and the invoice is paid with what is held, nothing left held, and the books add up', paid3.error ? String(paid3.error.message) : booksWrong(H3).join(' / '));
  }

  /* ---- 21: a payment from the card that fails with nothing of the card's held: its TRY AGAIN is a new tap of the card,
   *           never a payment from this phone's balance under a confirmation that says FROM FLASHCARD --------------------- */
  {
    await toCard();
    vals(holder).fcSend();
    update();
    await pasted(invoice(90));
    const pile = await H.W.balanceSats();
    holder.setState((p) => ({ screen: 'sendDone', stack: p.stack.concat([p.screen]), sendPhase: 'in' }));
    // (the app's own check for a mint's bad signatures, 03-send.js: none here)
    if (!holder.isBadSignatures) holder.isBadSignatures = () => false;
    // and a title for whichever card the failure is said with (the kit has none of the app's own, BLOCKED in 11-cards.js)
    const bc0 = holder.blockedCard;
    holder.blockedCard = (k, o) => bc0.call(holder, k, Object.assign({}, o, (o && o.title) ? {} : { title: String(k).toUpperCase() }));
    // the card's pieces are not where the payment looks for them (gone back to the card by the sweep, say)
    holder.startSendNow(holder.state.recipient, { held: 'cardout-gone', card: c.key, quote: holder._feeQuote, sats: 100 });
    await until('the payment to fail', () => !!card(holder));
    const calls = [];
    const was = { startSend: holder.startSend, fcOutNext: holder.fcOutNext };
    holder.startSend = () => calls.push('startSend');
    holder.fcOutNext = () => calls.push('fcOutNext');
    const offered = card(holder);
    if (offered.has('TRY AGAIN')) offered.press('TRY AGAIN');
    await settle();
    holder.startSend = was.startSend;
    holder.fcOutNext = was.fcOutNext;
    ok(calls.indexOf('startSend') < 0 && (await H.W.balanceSats()) === pile && !history(H).some((e) => e.dir === 'out' && e.sats === 90),
       'its TRY AGAIN does not pay from this phone: it is NEXT again, a new tap of the card', offered.all + ' | ' + calls.join());
    if (card(holder)) holder.dismissCard(holder._blockedKind);
    holder.blockedCard = bc0;
    ok(books().length === 0, 'the books add up', books().join(' / '));
  }

  /* ---- 21b: a payment from this phone that fails says so under its own kind's title ---------------------------------- */
  {
    for (let i = 0; i < 5 && holder._blockedEl && holder._blockedEl.parentNode; i++) holder.dismissCard(holder._blockedKind);
    holder.setState({ screen: 'sendConfirm', stack: ['home'], sendFrom: '', sendPhase: 'in' });
    if (!holder.isBadSignatures) holder.isBadSignatures = () => false;
    // the app's own titles for these kinds (BLOCKED, 01-ui-basics.js); the kit has none
    const info0 = holder.BLOCKED_INFO;
    holder.BLOCKED_INFO = (k) => ({ netLost: { title: 'CONNECTION LOST' }, sendFail: { title: 'PAYMENT FAILED' } })[k] || null;
    const pay0 = H.W.pay;
    H.W.pay = () => Promise.reject(new Error('socket hang up'));
    holder.startSendNow(invoice(70), {});
    await until('the failure card', () => !!card(holder));
    ok(holder._blockedKind === 'netLost' && card(holder).title === 'CONNECTION LOST',
       'a failed payment from this phone shows its card with its kind’s own title', holder._blockedKind + ' | ' + (card(holder) && card(holder).title));
    holder.dismissCard(holder._blockedKind);
    H.W.pay = () => Promise.reject(new Error('insufficient balance'));
    holder.setState({ screen: 'sendConfirm', sendPhase: 'in' });
    holder.startSendNow(invoice(70), {});
    await until('the failure card', () => !!card(holder));
    ok(holder._blockedKind === 'sendFail' && card(holder).title === 'PAYMENT FAILED', 'and not enough money keeps PAYMENT FAILED', holder._blockedKind + ' | ' + (card(holder) && card(holder).title));
    holder.dismissCard(holder._blockedKind);
    H.W.pay = pay0;
    holder.BLOCKED_INFO = info0;
    await settle();
  }

  /* ---- 15: WITHDRAW from the card-mode screen is the old tile ---------------------------------------------------- */
  {
    await toCard();
    const onCard = c.balance();
    await holder.refreshBalance();
    const had = await H.W.balanceSats();
    vals(holder).fcSend();
    update();
    sendVals().goWithdraw();
    update();
    const s = holder.state;
    ok(s.screen === 'amount' && s.flow === 'cardWd' && s.stack[s.stack.length - 1] === 'flashcard' && s.sendFrom === '',
       'WITHDRAW asks how much on the keypad, over the card’s screen, out of card mode', JSON.stringify({ screen: s.screen, flow: s.flow, stack: s.stack }));
    holder.fcWithdrawPin(0);
    await until('the card to be emptied', () => c.balance() === 0 && !!holder.state.fc && holder.state.fc.balance === 0 && !holder.state.fcRoll);
    await settle();
    ok(holder.state.screen === 'flashcard' && !card(holder) && (await H.W.balanceSats()) === had + onCard,
       'ALL OF IT: the card’s money is in this phone and its screen counts down to nothing, with nothing raised over it, as the old tile did', String((await H.W.balanceSats()) - had));
    ok(books().length === 0, 'the books add up', books().join(' / '));
  }

  /* ---- 22: at a mint with two balances (dollars and bitcoin): a card pays in bitcoin, and card mode alone changes ----
   * The mint issues sat and usd (fakeMint `units`), this phone holds dollars as well as bitcoin, and its sends have no
   * balance remembered yet. In card mode the confirmation is the card's: FROM FLASHCARD and NEXT, with no CURRENCY question
   * first, no WALLET button and no RATE row, and the card's sats pay. The dollars are not touched. Out of card mode the same
   * invoice gets the two-balance CONFIRM PAYMENT again, with its WALLET button. */
  {
    const T = await funded({ units: ['sat', 'usd'] }, 6000);
    T.fate = addressServer;
    await T.W.claim((await T.W.invoice(500, '', { unit: 'usd' })).hash);
    const two = appOn(T, {}, { send: true });
    await two.refreshBalance();
    const k = newCard(T, undefined, { format: 4 });
    await T.W.cardSetUp(k, {});
    k.tap();
    await T.W.cardAdd(k, { sats: 1500, owner: true });
    await two.refreshBalance();
    const upd = () => { two.syncCardOut(); two.syncSend(); };
    const usdBefore = T.W.balanceOf('usd');
    ok(two.twoUnitsOn() && usdBefore === 500 && T.W.walletChoice().send === '',
       'a mint with two balances: this phone holds $5.00 beside its bitcoin, and no balance is remembered for sends', JSON.stringify({ usd: usdBefore, choice: T.W.walletChoice() }));
    // the card's screen, then SEND, then an invoice pasted
    two.setState({ screen: 'home', stack: [], sendFrom: '' });
    T.nfc = k;
    two.goFlashcard();
    await until('the card to be read', () => !!two.state.fc && two.state.fc.key === k.key && two.state.fc.check !== 'asking');
    await settle();
    const before = k.balance();
    vals(two).fcSend();
    upd();
    two._quotedFor = null;
    two.acceptTarget(invoice(400));
    upd();
    await until('the fee to be quoted', () => two.state.quotedFee != null || !two.state.quotingFee && two.state.screen !== 'sendConfirm');
    upd();
    ok(two.state.screen === 'sendConfirm' && two.state.sendFrom === 'card' && two.cardSendNow() && two.walletNow('send') === 'sat',
       'in card mode the invoice goes straight to its confirmation: no CURRENCY question, and the card pays in bitcoin', two.state.screen + ' | ' + two.walletNow('send'));
    const sp = two.confirmSpec();
    const labels = sp.rows.map((r) => r.label);
    ok(!sp.wallet && labels.indexOf('RATE') < 0 && labels.indexOf('PAYING FROM') < 0 && sp.cta === 'NEXT'
       && sp.rows.some((r) => r.label === 'FROM' && r.value === 'FLASHCARD'),
       'SEND from the card at a two-unit mint: FROM FLASHCARD and NEXT, with no WALLET button and no RATE row', labels.join() + ' | ' + sp.cta);
    ok(!two.state.feeQ && !!two._feeQuote && (two._feeQuote.unit === undefined || two._feeQuote.unit === 'sat'),
       'and its fee was asked once, in sats: no quote of both balances', JSON.stringify(two._feeQuote && { unit: two._feeQuote.unit, fee: two._feeQuote.feeReserve }));
    sp.go();
    await until('the payment to be made', () => two.state.screen === 'sendDone' && two.state.sendPhase === 'settled');
    await until('the tap to be over', () => !(two._fcTaps > 0));
    await settle();
    const out = history(T).find((e) => e.dir === 'out' && e.memo === 'paid from card');
    ok(before - k.balance() === 410 && !!out && out.sats === 400 && (out.unit === undefined || out.unit === 'sat') && out.fromCard === k.key,
       'NEXT pays in sats from the card: 410 off it, and the entry is a bitcoin one, paid from the card', JSON.stringify(out && { sats: out.sats, unit: out.unit }));
    ok(T.W.balanceOf('usd') === usdBefore && T.W.walletChoice().send === '',
       'the dollar pill is untouched by the card’s payment, and nothing is remembered from it for the next send', String(T.W.balanceOf('usd')));
    ok(booksWrong(T).length === 0, 'the books add up, per unit', booksWrong(T).join(' / '));
    // out of card mode: home's SEND, the same kind of invoice, from this phone; nothing is remembered, so with both balances able to pay the confirmation asks which pays
    two.setState({ screen: 'home', stack: [], sendPhase: null });
    upd();
    ok(T.W.walletChoice().send === '' && two.walletNow('send') === '', 'back on home nothing is remembered for sending: the card’s payment left no choice behind');
    two.setState((p) => ({ screen: 'sendHow', stack: p.stack.concat([p.screen]), flow: 'send', sendFrom: '',
      wallet: '', walletAuto: false, walletTapped: false, feeQ: null }));
    upd();
    two._quotedFor = null;
    two.acceptTarget(invoice(400));
    // (from this phone the invoice is first asked whether this mint made it, so the question comes a moment later)
    await until('the question', () => { upd(); return two.state.screen === 'currency'; });
    ok(two.state.screen === 'currency' && two.state.currencyFlow === 'send' && two.state.currencyNext === 'sendConfirm',
       'both balances can pay and none is remembered: CURRENCY asks which pays before the confirmation', two.state.screen);
    upd();
    // the Dollars card on CURRENCY (the app's `currencyPick('usd')`, whose patch this is)
    two.setState({ wallet: 'usd', walletAuto: false, walletTapped: false, screen: 'sendConfirm', unit: 'USD', amount: '' });
    await until('the confirmation', () => two.state.screen === 'sendConfirm');
    upd();
    await until('both balances to be quoted', () => !!two.state.feeQ && !!two.state.feeQ.usd);
    upd();
    const sp2 = two.confirmSpec();
    const labels2 = sp2.rows.map((r) => r.label);
    ok(!two.cardSendNow() && sp2.title === 'CONFIRM PAYMENT' && !!sp2.wallet && sp2.wallet.word === 'USD' && labels2.indexOf('RATE') >= 0
       && labels2.indexOf('FROM') < 0 && sp2.cta === 'PAY',
       'leaving card mode restores the two-unit confirmation: CONFIRM PAYMENT, the WALLET button on USD (the answer to CURRENCY), the RATE row, PAY', labels2.join() + ' | ' + sp2.cta);
    two.setState({ screen: 'home', stack: [] });
    upd();
  }

  ok(!stage(H), 'no card screen is left up');
  console.log(failed || until.failed ? '\n' + (failed + until.failed) + ' FAILED' : '\nall flashcard-send checks pass');
  process.exit(failed || until.failed ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
