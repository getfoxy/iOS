'use strict';
/* flashcard-cross-mint-load.js — money from this phone onto a card at another mint.
 *
 *     node tests/flashcard-cross-mint-load.js
 *
 * A card's money is at the mint its record names. A phone at another mint, online, puts money on it there: SEND > FLASHCARD from
 * home, or ADD FUNDS on the card's own screen. The card is read once; the card's mint makes an invoice for the amount in the card's
 * unit, and this phone's mint quotes paying it from this phone's balance. What goes on the card, the most that leaves this phone and
 * the fee are shown on a confirmation before anything moves. PUT ... ON CARD pays the invoice from here, claims it at the card's mint
 * on a visit there, makes the pieces for the card there, and writes them in one more tap under the card's PIN. The phone is home
 * after. Offline it is refused in one sentence, with nothing asked of anybody.
 *
 *   1  the owner's own bitcoin card of 1.21 at mint A, the phone at mint B: SEND > FLASHCARD asks the PIN before the card, the one
 *      tap that reads it brings the confirmation (nothing signed, nothing moved, the phone still at B), and PUT ... ON CARD asks no
 *      PIN again and writes the card in one more tap: the card up by the amount, B down by the amount and the fee the mint kept,
 *      nothing left at A, the phone home at B, and the load's row the card's (left out of home's list)
 *   2  somebody else's card, on a phone that knows no card: the confirmation first, then the PIN, then one tap
 *   3  ADD FUNDS on the card's screen: the amount, the confirmation, the PIN (a card of 1.21 wants it from its owner too), one tap,
 *      and the card's screen after
 *   4  a dollar card at A, this phone's bitcoin at B: the dollars typed go on the card, and B pays the invoice in sats; typed in
 *      sats, the card is refused in plain words, with nothing asked of any mint
 *   5  offline: "Putting money on a card at another mint needs the connection.", nothing taken, nothing asked
 *   6  B refuses the melt: NOT ON THE CARD, nothing taken, nothing on the card, nothing left waiting
 *   7  this phone cannot cover the amount and the fee: said, the button greyed, and it does nothing
 *   8  B does not answer the melt: held as any melt is, nothing on the card, and once settled the money is this phone's at A
 *   9  a dollar card at A, this phone at B with $1.00 and bitcoin: the bitcoin pays, with nothing asked and no greyed button (the
 *      dollars cannot); a bitcoin card with this phone holding only dollars is paid from the dollars
 *  10  both of this phone's balances cover it: PAY FROM WHICH? is asked, and dollars chosen pay it in dollars
 *  11  a card of 1.23 that holds both, at A: SEND not started in a currency asks SEND WHICH TO THE CARD? with nothing greyed, and
 *      ADD FUNDS asks ADD WHICH TO THE CARD?; what is chosen goes on the card in that currency
 *  12  the claim at A refused: NOT ON THE CARD, the money this phone's at A, the crossing kept and finished later (and a dollar
 *      crossing's log line says dollars)
 *  13  the visit to A cannot connect: the same, the phone home at B
 *  14  the pieces cannot be made at A after the claim: the money this phone's at A, nothing crossing
 *  15  the tap that should write the pieces reads no card: they are owed to the card, and written at its next tap, from B
 *  16  the confirmation says what the card will get: the pieces as cut at its mint, not the amount typed, and the fee over that
 *
 * The screens are the card's parts with the send parts (tests/flashcard-ui-kit.js), over the real wallet, two test mints
 * (tests/flashcard-kit.js `second`) and the model of the card (tests/flashcard-card.js). The two test mints do not know each other's
 * invoices, so the world here does what Lightning does: a melt at B that the mint says PAID, of an invoice A made, pays A's quote
 * (`linked`). Every case ends with the books added up.
 */
const { page, newCard, settle, MINT, MINT2, OTHER_WORDS } = require('./flashcard-kit');
const { booksWrong } = require('./harness');
const { appOn, until, pad, card, keyIn } = require('./flashcard-ui-kit');
const fs = require('fs');
const path = require('path');
/* One of the app's methods, out of the text of its file, by its first line (as flashcard-ui-kit.js lifts them): the CURRENCY screen's
 * pick, which the questions below are answered with. */
const liftFrom = (file, sig) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', file), 'utf8');
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('no method ' + sig);
  let i = src.indexOf('{', at + 3 + sig.length - 1), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) break; } }
  return src.slice(at + 3, i + 1);
};
const withPick = (a) => Object.assign(a, new Function('return {' + liftFrom('01-ui-basics.js', 'currencyPick(unit) {') + '}')());
// a dollar balance at B for this phone: an invoice there in dollars, claimed (B pays its own quotes)
const usdAtB = async (R, a, cents) => {
  await R.W.claim((await R.W.invoice(cents, '', { unit: 'usd' })).hash);
  await a.refreshBalance();
  a.state.balUsdCents = R.W.balanceOf('usd', MINT2);
};
// a dollar card's first dollars, from this phone's own at A (bought there), and home to B
const usdCardAtA = async (R, a, k, cents) => {
  await R.W.connect(MINT, null, null, { remember: true });
  const uq = await R.W.invoice(cents + 1000, '', { unit: 'usd' });
  R.mint.payQuote(uq.hash);
  await R.W.claim(uq.hash);
  k.tap();
  await R.W.cardAdd(k, { amount: cents, unit: 'usd', pin: '2468' });
  await R.W.connect(MINT2, null, null, { remember: true });
  await a.refreshBalance();
};
const readCard = async (a, k) => {
  k.tap();
  a.setState({ screen: 'home', stack: [], fcXl: null });
  a.goFlashcard();
  await until('the card read on its screen', () => a.state.fc && a.state.fc.key === k.key && a.state.screen === 'flashcard' && !(a._fcTaps > 0));
};

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
async function waitFor(cond, ms) {
  const end = Date.now() + (ms || 10000);
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return !!cond();
}
const bare = (u) => String(u || '').replace(/\/+$/, '');
const signed = (k) => k.sent.some((x) => /^b0(40|22)/.test(x));
const offline = (c) => c.W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
const online = (c) => c.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
const saved = (c) => bare(JSON.parse(c.storage.getItem('foxy.cashu.mint') || '""'));
const begins = (c) => c.sheet.filter((x) => /^begin: /.test(x)).length;
const spec = (a) => a.fcXlSpec();
const rowOf = (a, label) => (spec(a).rows || []).filter((r) => r.label === label)[0] || {};
const home = (R) => waitFor(() => bare(R.W.mintUrl) === MINT2 && !R.W.cardAwayNow(), 30000);
const confirmed = (a) => until('the confirmation with both mints’ figures', () => a.state.screen === 'fcXlConfirm' && !!(a.state.fcXl && (a.state.fcXl.plan || a.state.fcXl.err)));
function booksGood(name, ...pages) {
  const wrong = [];
  pages.forEach((c) => booksWrong(c).forEach((l) => wrong.push(l)));
  ok(wrong.length === 0, name + ': the books add up', wrong.join(' | '));
}

/* What Lightning does between the two test mints: a melt at B that the mint says PAID, of an invoice that A made, pays A's quote.
 * `R.melts`: every melt B answered, by its state. */
function linked(R) {
  R.melted = [];
  R.fate = (m) => {
    const url = new URL(m.url);
    if (url.origin !== MINT2 || url.pathname !== '/v1/melt/bolt11' || m.method !== 'POST') return null;
    const said = R.mint2.handle(m);
    try {
      const body = JSON.parse(String(said).slice(String(said).indexOf('\n') + 1));
      R.melted.push(body && body.state);
      if (body && body.state === 'PAID') {
        const id = Object.keys(R.mint.quotes).filter((k) => R.mint.quotes[k].request === body.request && R.mint.quotes[k].state === 'UNPAID').pop();
        if (id) R.mint.payQuote(id);
      }
    } catch (e) { /* a refusal: nothing paid */ }
    return said;
  };
}

/* R: a phone whose own mint is B, with `atB` sats there. Its card (`own`: set up by R at A with PIN 2468 and `onCard` on it, of
 * software 21) or none; `units`/`units2` what each mint issues. A's invoices wait to be paid (by B's melts, `linked`). */
async function world(o) {
  const opts = o || {};
  const R = page({ second: true, units: opts.units, units2: opts.units2, words: OTHER_WORDS,
                   mintOpts: { quotesUnpaid: true }, mintOpts2: opts.mintOpts2 || {} });
  let k = null;
  if (opts.own) {
    await R.W.connect(MINT, null, null, { remember: true });
    const q = await R.W.invoice(opts.fundA || 5000, '');
    R.mint.payQuote(q.hash);
    await R.W.claim(q.hash);
    await R.W.primeLocks();
    // (`software` 23 and `hold`: a card of 1.23, set up to hold both or one, at the page's price)
    k = newCard(R, undefined, { format: 4, software: opts.software || 21, unit: opts.cardUnit });
    await R.W.cardSetUp(k, Object.assign({ pin: '2468' }, opts.cardUnit === 'usd' ? { unit: 'usd' } : {},
                                         opts.hold ? { hold: opts.hold, price: 60000 } : {}));
    if (opts.onCard) { k.tap(); await R.W.cardAdd(k, { sats: opts.onCard, pin: '2468' }); }
  }
  await R.W.connect(MINT2, null, null, { remember: true });
  if (opts.atB) await R.W.claim((await R.W.invoice(opts.atB, '')).hash);
  await R.W.primeLocks();
  linked(R);
  const a = appOn(R, { screen: 'home', stack: [] }, { send: true, receive: true });
  a.price = 60000;
  a.mintNameOf = (u) => bare(u).replace(/^https?:\/\//, '');
  a.mintName = () => a.mintNameOf(R.W.mintUrl);
  await a.refreshBalance();
  R.nfc = k;
  return { R, a, k };
}

(async () => {
  /* ---- 1: the owner's own bitcoin card at A, SEND > FLASHCARD from B ------------------------------------------------ */
  {
    const { R, a, k } = await world({ own: true, onCard: 2000, atB: 4000 });
    const atA = R.W.balanceAt(MINT), atB = R.W.balanceAt(MINT2), cardBefore = k.balance();
    R.sheet.length = 0;
    k.sent.length = 0;
    a.fcSendCard();
    ok(a.state.screen === 'amount' && a.state.flow === 'cardSend', 'SEND > FLASHCARD asks for the amount first');
    keyIn(a, 1000);
    ok(!!pad(a) && pad(a).title === 'CARD PIN' && pad(a).cta === 'TAP CARD' && begins(R) === 0,
       'a phone that knows a card asks the PIN before the card is asked for', pad(a) && pad(a).cta);
    pad(a).type('2468');
    await confirmed(a);
    const x = a.state.fcXl;
    ok(begins(R) === 1 && !signed(k) && k.balance() === cardBefore && R.W.balanceAt(MINT2) === atB && !pad(a),
       'the one tap reads the card and nothing more: the confirmation comes up, nothing signed, nothing moved', JSON.stringify({ begins: begins(R), b: R.W.balanceAt(MINT2) - atB }));
    ok(bare(R.W.mintUrl) === MINT2 && !R.W.cardAwayNow(), 'both mints are asked with this phone still at its own');
    ok(!!x.plan && x.plan.amount === 1000 && x.plan.total === 1010 && x.plan.fee === 10 && x.cardUnit === 'sat' && x.payUnit === 'sat',
       'the figures: 1,000 to go on, at most 1,010 from this phone, a fee of up to 10', JSON.stringify(x.plan && { amount: x.plan.amount, total: x.plan.total, fee: x.plan.fee }));
    // (the owner's design: CARD AT DIFFERENT MINT; with no price here, the sats are the main figures)
    ok(spec(a).title === 'CARD AT DIFFERENT MINT' && spec(a).subtitle === 'This card is at another mint. Your money goes there by Lightning, and you pay the fee.'
       && spec(a).amountLabel === 'YOU PAY' && spec(a).amount === 'UP TO ₿ 1,010'
       && (spec(a).rows || []).map((r) => r.label).join() === 'ON THE CARD,FEE, PAID BY YOU,CARD’S MINT,YOUR MINT'
       && rowOf(a, 'ON THE CARD').value === '₿ 1,000' && rowOf(a, 'FEE, PAID BY YOU').value === 'UP TO ₿ 10'
       && rowOf(a, 'CARD’S MINT').value === 'M.TEST' && rowOf(a, 'YOUR MINT').value === 'N.TEST' && rowOf(a, 'CARD’S MINT').basis === '50%' && rowOf(a, 'YOUR MINT').basis === '50%',
       'it says what goes on the card, what leaves this phone, the fee and the two mints side by side', JSON.stringify((spec(a).rows || []).map((r) => r.label + '=' + r.value)));
    ok(spec(a).cta === 'PUT ₿ 1,000 ON CARD' && !spec(a).ctaBusy, 'the button says what it does, with the amount', spec(a).cta);
    spec(a).go();
    await waitFor(() => k.balance() === cardBefore + 1000, 40000);
    await waitFor(() => a.state.screen === 'paid' && a.state.paidSays === 'ON THE CARD', 20000);
    await home(R);
    await settle();
    ok(!pad(a) && begins(R) === 2, 'no PIN asked again, and one more tap wrote it: two taps in all', String(begins(R)));
    ok(a.state.paidAmount === 1000 && a.state.stack.slice(-1)[0] === 'home', 'said as any load from SEND is: ON THE CARD on the success screen, over Home', JSON.stringify([a.state.paidAmount, a.state.stack]));
    a.setState({ screen: 'home', stack: [] }); if (a.paidDismissed) a.paidDismissed(); await new Promise((ok2) => setTimeout(ok2, 100));
    const spent = atB - R.W.balanceAt(MINT2);
    const meltRow = (await R.W.transactions(50)).filter((t) => t.dir === 'out' && bare(t.mint) === MINT2)[0] || {};
    ok(spent === 1002 && spent <= x.plan.total && Number(meltRow.feeSats) === 2,
       'B is down by the amount and the 2 sats the mint kept of its reserve, and no more than shown', JSON.stringify({ spent, fee: meltRow.feeSats }));
    ok(R.W.balanceAt(MINT) === atA && saved(R) === MINT2 && bare(R.W.mintUrl) === MINT2,
       'nothing of it is left at A, and the phone is home at B, still its own mint', JSON.stringify({ a: R.W.balanceAt(MINT) - atA, at: R.W.mintUrl }));
    ok(!R.W.cardOwed().length && !R.W.pendingMelts().length && !R.W.pendingMoves().length, 'nothing is left owed, held or crossing');
    const rows = await R.W.transactions(50);
    const load = rows.filter((t) => t.card === k.key && t.memo === 'to card')[0];
    const melt = rows.filter((t) => t.dir === 'out' && bare(t.mint) === MINT2)[0], claim = rows.filter((t) => t.dir === 'in' && t.memo === 'mint switch')[0];
    ok(!!load && bare(load.mint) === MINT && load.sats === 1000 && R.W.cardKnownHere(k.key) && !!melt && !melt.card && !melt.fromCard && !!claim && !claim.card && bare(claim.mint) === MINT,
       'the load’s row names the card (its own list has it, home’s leaves it out), and the crossing’s rows are this phone’s',
       JSON.stringify(rows.slice(0, 4).map((t) => [t.dir, t.memo, t.card ? 'card' : '', bare(t.mint)])));
    booksGood('the owner’s card at another mint', R);
  }

  /* ---- 2: somebody else's card, on a phone that knows no card ----------------------------------------------------- */
  {
    const H = page({ second: true, mintOpts: { quotesUnpaid: true } });
    await H.W.connect(MINT, null, null, { remember: true });
    const hq = await H.W.invoice(5000, '');
    H.mint.payQuote(hq.hash);
    await H.W.claim(hq.hash);
    await H.W.primeLocks();
    const k = newCard(H, undefined, { format: 4, software: 21 });
    await H.W.cardSetUp(k, { pin: '1357' });
    k.tap();
    await H.W.cardAdd(k, { sats: 1500, pin: '1357' });
    const R = page({ second: true, sharedMint: H.mint, sharedMint2: H.mint2, words: OTHER_WORDS });
    await R.W.connect(MINT2, null, null, { remember: true });
    await R.W.claim((await R.W.invoice(3000, '')).hash);
    await R.W.primeLocks();
    linked(R);
    const a = appOn(R, { screen: 'home', stack: [] }, { send: true, receive: true });
    a.price = 60000;
    a.mintNameOf = (u) => bare(u).replace(/^https?:\/\//, '');
    await a.refreshBalance();
    R.nfc = k;
    const cardBefore = k.balance(), atB = R.W.balanceAt(MINT2);
    k.sent.length = 0;
    a.fcSendCard();
    keyIn(a, 700);
    await confirmed(a);
    ok(!pad(a) && begins(R) === 1 && !signed(k), 'a phone that knows no card reads it first, and the confirmation comes before any PIN',
       JSON.stringify({ pad: !!pad(a), begins: begins(R), signed: signed(k) }));
    spec(a).go();
    await until('the PIN pad', () => !!pad(a));
    ok(pad(a).title === 'CARD PIN' && /^To put \$0\.42 \(₿700\) on the card\.$/.test(pad(a).sub) && pad(a).cta === 'PUT $0.42 ON CARD' && R.W.balanceAt(MINT2) === atB,
       'then the PIN, saying what goes on, with nothing moved yet', pad(a).sub + ' / ' + pad(a).cta);
    pad(a).type('1357');
    await waitFor(() => k.balance() === cardBefore + 700, 40000);
    await home(R);
    await settle();
    ok(begins(R) === 2 && atB - R.W.balanceAt(MINT2) === 702 && R.W.balanceAt(MINT) === 0,
       'one more tap, under the PIN: on the card, B down by the amount and its fee, nothing kept at A', JSON.stringify({ begins: begins(R), spent: atB - R.W.balanceAt(MINT2) }));
    const load = (await R.W.transactions(50)).filter((t) => t.card === k.key && t.memo === 'to card')[0];
    ok(!!load && !R.W.cardKnownHere(k.key), 'the load’s row names the card, which is not this phone’s: home’s list keeps it');
    booksGood('somebody else’s card at another mint', H, R);
  }

  /* ---- 3: ADD FUNDS on the card's screen ---------------------------------------------------------------------------- */
  {
    const { R, a, k } = await world({ own: true, onCard: 2000, atB: 4000 });
    const atB = R.W.balanceAt(MINT2), cardBefore = k.balance();
    k.tap();
    a.goFlashcard();
    await until('the card read on its screen', () => a.state.fc && a.state.fc.key === k.key && a.state.screen === 'flashcard');
    R.sheet.length = 0;
    a.fcAdd();
    ok(a.state.screen === 'amount' && a.state.flow === 'cardAdd' && !card(a), 'ADD FUNDS goes to SET AMOUNT, and is not refused as A DIFFERENT MINT', card(a) && card(a).all);
    keyIn(a, 600);
    await confirmed(a);
    ok(!!a.state.fcXl.plan && a.state.fcXl.plan.total === 610 && spec(a).cta === 'PUT ₿ 600 ON CARD' && !pad(a) && begins(R) === 0,
       'the confirmation, with nothing tapped and no PIN asked yet', JSON.stringify({ total: a.state.fcXl.plan && a.state.fcXl.plan.total, cta: spec(a).cta }));
    spec(a).go();
    await until('the PIN pad', () => !!pad(a));
    ok(pad(a).title === 'CARD PIN', 'a card of 1.21 wants its PIN from its owner too');
    pad(a).type('2468');
    await waitFor(() => k.balance() === cardBefore + 600, 40000);
    await home(R);
    await settle();
    ok(begins(R) === 1 && a.state.screen === 'flashcard' && a.state.fc && a.state.fc.balance === cardBefore + 600,
       'one tap, and the card’s screen after, showing what it holds', JSON.stringify({ begins: begins(R), screen: a.state.screen, bal: a.state.fc && a.state.fc.balance }));
    ok(atB - R.W.balanceAt(MINT2) === 602 && saved(R) === MINT2, 'B down by the amount and its fee, and home', String(atB - R.W.balanceAt(MINT2)));
    booksGood('ADD FUNDS at another mint', R);
  }

  /* ---- 4: a dollar card at A, this phone's bitcoin at B ------------------------------------------------------------------ */
  {
    const { R, a, k } = await world({ own: true, units: ['sat', 'usd'], cardUnit: 'usd', atB: 20000 });
    // the dollar card's first dollars, from this phone's own at A (bought there, as it would)
    await R.W.connect(MINT, null, null, { remember: true });
    const uq = await R.W.invoice(3000, '', { unit: 'usd' });
    R.mint.payQuote(uq.hash);
    await R.W.claim(uq.hash);
    k.tap();
    await R.W.cardAdd(k, { amount: 1000, unit: 'usd', pin: '2468' });
    await R.W.connect(MINT2, null, null, { remember: true });
    await a.refreshBalance();
    const cardBefore = k.balance(), atB = R.W.balanceAt(MINT2), usdA = R.W.balanceOf('usd', MINT);
    // typed in sats: not a dollar amount
    R.sheet.length = 0;
    a.fcSendCard();
    keyIn(a, 5000);
    pad(a).type('2468');
    await until('the refusal', () => !!card(a));
    ok(card(a).title === 'A DOLLAR CARD' && card(a).reason === 'This card holds dollars. Type the amount in dollars.' && !a.state.fcXl && k.balance() === cardBefore,
       'typed in sats, a dollar card is refused in plain words, and nothing is asked of any mint', card(a).all);
    card(a).press('CLOSE');
    a.setState({ screen: 'home', stack: [] });
    a.fcSendCard();
    a.state.amount = '5.00';
    a.state.unit = 'USD';
    a.fcAmountNext();
    await until('the PIN pad', () => !!pad(a));
    pad(a).type('2468');
    await confirmed(a);
    const x = a.state.fcXl;
    const sats = Math.round(Number(x.plan && x.plan.melt && x.plan.melt.amount) || 0);
    ok(x.cardUnit === 'usd' && x.payUnit === 'sat' && x.plan.amount === 500 && rowOf(a, 'ON THE CARD').value === '$ 5.00' && sats > 0
       && x.plan.total === sats + 10 && /^UP TO ₿ /.test(spec(a).amount),
       'the dollars typed go on the card, and this phone’s bitcoin pays the invoice A made for them', JSON.stringify({ cu: x.cardUnit, pu: x.payUnit, total: x.plan.total, sats }));
    spec(a).go();
    await waitFor(() => k.balance() === cardBefore + 500, 40000);
    await home(R);
    await settle();
    ok(atB - R.W.balanceAt(MINT2) === sats + 2 && R.W.balanceOf('usd', MINT) === usdA,
       'B down by the invoice’s sats and the fee kept, and no dollars left over at A', JSON.stringify({ spent: atB - R.W.balanceAt(MINT2), usd: R.W.balanceOf('usd', MINT) - usdA }));
    booksGood('a dollar card at another mint, from bitcoin', R);
  }

  /* ---- 5: offline ---------------------------------------------------------------------------------------------------- */
  {
    const { R, a, k } = await world({ own: true, onCard: 2000, atB: 4000 });
    const atB = R.W.balanceAt(MINT2), cardBefore = k.balance();
    a.fcSendCard();
    keyIn(a, 500);
    pad(a).type('2468');
    await confirmed(a);
    offline(R);
    const asked = R.trace.length;
    spec(a).go();
    await settle();
    ok(!!card(a) && card(a).reason === 'Putting money on a card at another mint needs the connection.' && k.balance() === cardBefore && R.W.balanceAt(MINT2) === atB
       && R.trace.length === asked, 'no route at PUT ... ON CARD: refused in one sentence, nothing taken and nothing asked', card(a) && card(a).all);
    card(a).press('CLOSE');
    // ADD FUNDS on the card's screen with no route: the same, before the amount
    online(R);
    k.tap();
    a.setState({ screen: 'home', stack: [], fcXl: null });
    a.goFlashcard();
    await until('the card read', () => a.state.fc && a.state.fc.key === k.key && a.state.screen === 'flashcard');
    a.offline = true;
    a.fcAdd();
    ok(!!card(a) && card(a).reason === 'Putting money on a card at another mint needs the connection.' && a.state.screen === 'flashcard',
       'and ADD FUNDS offline says the same, on the card’s screen', card(a) && card(a).all);
    a.offline = false;
    booksGood('offline, a card at another mint', R);
  }

  /* ---- 6: B refuses the melt ----------------------------------------------------------------------------------------- */
  {
    const { R, a, k } = await world({ own: true, onCard: 2000, atB: 4000, mintOpts2: { meltRefuse: true } });
    const atA = R.W.balanceAt(MINT), atB = R.W.balanceAt(MINT2), cardBefore = k.balance();
    R.sheet.length = 0;
    a.fcSendCard();
    keyIn(a, 800);
    pad(a).type('2468');
    await confirmed(a);
    spec(a).go();
    await waitFor(() => !!card(a) && card(a).title === 'NOT ON THE CARD', 40000);
    await home(R);
    await settle();
    ok(/Nothing was taken\.$/.test(card(a).reason) && begins(R) === 1 && k.balance() === cardBefore,
       'NOT ON THE CARD, nothing taken, and the card not asked for again', card(a).all);
    ok(R.W.balanceAt(MINT2) === atB && R.W.balanceAt(MINT) === atA && !R.W.pendingMoves().length && !R.W.pendingMelts().length && !R.W.cardOwed().length,
       'nothing lost, nothing held, crossing or owed', JSON.stringify({ b: R.W.balanceAt(MINT2) - atB, moves: R.W.pendingMoves().length }));
    booksGood('B refuses the melt', R);
  }

  /* ---- 7: this phone cannot cover the amount and the fee --------------------------------------------------------------- */
  {
    const { R, a, k } = await world({ own: true, onCard: 2000, atB: 1005 });
    const cardBefore = k.balance();
    a.fcSendCard();
    keyIn(a, 1000);
    pad(a).type('2468');
    await confirmed(a);
    const sp = spec(a);
    ok(a.state.fcXl.short && /isn.t enough to cover/.test(sp.warn || '') && sp.ctaBusy === true && sp.cta === 'PUT ₿ 1,000 ON CARD' && sp.amount === 'UP TO ₿ 1,010',
       'short of the amount and its fee: said, with the button greyed', JSON.stringify({ warn: sp.warn, cta: sp.cta, busy: sp.ctaBusy }));
    sp.go();
    await settle();
    ok(a.state.screen === 'fcXlConfirm' && !pad(a) && k.balance() === cardBefore && R.W.balanceAt(MINT2) === 1005, 'the button does nothing, and nothing moves');
    booksGood('this phone short of the fee', R);
  }

  /* ---- 8: B does not answer the melt --------------------------------------------------------------------------------- */
  {
    const { R, a, k } = await world({ own: true, onCard: 2000, atB: 4000, mintOpts2: { meltPending: true } });
    const atA = R.W.balanceAt(MINT), atB = R.W.balanceAt(MINT2), cardBefore = k.balance();
    a.fcSendCard();
    keyIn(a, 900);
    pad(a).type('2468');
    await confirmed(a);
    const plan = a.state.fcXl.plan;
    spec(a).go();
    await waitFor(() => !!card(a) && card(a).title === 'NOT ON THE CARD', 40000);
    await settle();
    ok(/has not finished/.test(card(a).reason) && k.balance() === cardBefore && R.W.pendingMelts().length === 1 && R.W.pendingMoves().length === 1
       && bare(R.W.mintUrl) === MINT2, 'held as any melt is, the crossing written down, nothing on the card, and the phone at B', card(a).all);
    const held = R.W.pendingMelts()[0];
    R.mint2.settleMelt(held.quote, 'paid');
    R.mint.payQuote(plan.mintQuote.quote);
    await R.W.sweepMelts();
    await R.W.finishMove();
    await settle();
    ok(!R.W.pendingMelts().length && !R.W.pendingMoves().length && R.W.balanceAt(MINT) - atA === 900 && atB - R.W.balanceAt(MINT2) >= 900
       && k.balance() === cardBefore, 'settled, the money is this phone’s at A, claimed from B, and the card is as it was',
       JSON.stringify({ a: R.W.balanceAt(MINT) - atA, b: atB - R.W.balanceAt(MINT2) }));
    booksGood('B slow to answer the melt', R);
  }

  /* ---- 9: one of this phone's balances cannot pay and the other can: the other pays, with nothing greyed ---------------------- */
  {
    const { R, a, k } = await world({ own: true, units: ['sat', 'usd'], units2: ['sat', 'usd'], cardUnit: 'usd', atB: 20000 });
    a.twoUnitsOn = () => true;
    await usdCardAtA(R, a, k, 1000);
    await usdAtB(R, a, 100);
    const cardBefore = k.balance(), atB = R.W.balanceAt(MINT2), usdB = R.W.balanceOf('usd', MINT2);
    await readCard(a, k);
    a.fcAdd();
    a.state.amount = '5.00'; a.state.unit = 'USD';
    a.fcAmountNext();
    await confirmed(a);
    const x = a.state.fcXl, sp = spec(a);
    ok(x.cardUnit === 'usd' && x.payUnit === 'sat' && !x.short && !x.err && !sp.ctaBusy && /^UP TO ₿ /.test(sp.amount) && a.state.screen === 'fcXlConfirm',
       'a dollar card, this phone with $1.00 and bitcoin: the bitcoin pays $5.00, asked nothing, and the button is live',
       JSON.stringify({ pu: x.payUnit, short: x.short, err: x.err, cta: sp.cta, busy: sp.ctaBusy }));
    sp.go();
    await until('the PIN pad', () => !!pad(a));
    pad(a).type('2468');
    await waitFor(() => k.balance() === cardBefore + 500, 40000);
    await home(R);
    await settle();
    ok(k.balance() === cardBefore + 500 && R.W.balanceAt(MINT2) < atB && R.W.balanceOf('usd', MINT2) === usdB,
       'on the card, paid from B’s bitcoin, its dollars left alone', JSON.stringify({ card: k.balance() - cardBefore, usd: R.W.balanceOf('usd', MINT2) - usdB }));
    booksGood('a dollar card at another mint, paid from the balance that can', R);
  }
  {
    // a bitcoin card, and this phone at B holding only dollars: the dollars pay
    const { R, a, k } = await world({ own: true, units: ['sat', 'usd'], units2: ['sat', 'usd'], onCard: 1000 });
    a.twoUnitsOn = () => true;
    await usdAtB(R, a, 2000);
    const cardBefore = k.balance(), usdB = R.W.balanceOf('usd', MINT2);
    ok(R.W.balanceAt(MINT2) === 0 && usdB === 2000, 'this phone holds dollars only at B', JSON.stringify([R.W.balanceAt(MINT2), usdB]));
    await readCard(a, k);
    a.fcAdd();
    keyIn(a, 600);
    await confirmed(a);
    const x = a.state.fcXl, sp = spec(a);
    ok(x.cardUnit === 'sat' && x.payUnit === 'usd' && !x.short && !sp.ctaBusy && /^UP TO \$/.test(sp.amount),
       'a bitcoin card, this phone with dollars only: the dollars pay (payUnit usd), nothing greyed', JSON.stringify({ pu: x.payUnit, short: x.short, amount: sp.amount }));
    sp.go();
    await until('the PIN pad', () => !!pad(a));
    pad(a).type('2468');
    await waitFor(() => k.balance() === cardBefore + 600, 40000);
    await home(R);
    await settle();
    ok(k.balance() === cardBefore + 600 && R.W.balanceOf('usd', MINT2) < usdB && R.W.balanceOf('usd', MINT2) >= usdB - x.plan.total && !R.W.pendingMoves().length,
       'the sats on the card, B’s dollars down by no more than shown', JSON.stringify({ spent: usdB - R.W.balanceOf('usd', MINT2), total: x.plan.total }));
    booksGood('a bitcoin card at another mint, paid in dollars', R);
  }

  /* ---- 10: both balances cover it: PAY FROM WHICH? ------------------------------------------------------------------------ */
  {
    const { R, a, k } = await world({ own: true, units: ['sat', 'usd'], units2: ['sat', 'usd'], cardUnit: 'usd', atB: 20000 });
    a.twoUnitsOn = () => true;
    withPick(a);
    await usdCardAtA(R, a, k, 1000);
    await usdAtB(R, a, 3000);
    const cardBefore = k.balance(), atB = R.W.balanceAt(MINT2), usdB = R.W.balanceOf('usd', MINT2);
    await readCard(a, k);
    a.fcAdd();
    a.state.amount = '2.00'; a.state.unit = 'USD';
    a.fcAmountNext();
    await until('the question', () => a.state.screen === 'currency');
    ok(a.state.curCard && a.state.curCard.question === 'PAY FROM WHICH?' && a.state.curCard.bal && a.state.curCard.bal.usd === usdB
       && a.state.curCard.bal.sat === atB && !a.state.curCard.short.usd && !a.state.curCard.short.sat && a.state.currencyNext === 'fcXlConfirm',
       'both of this phone’s balances can pay: PAY FROM WHICH? is asked, with both offered', JSON.stringify(a.state.curCard));
    a.currencyPick('usd');
    await until('back on the confirmation', () => a.state.screen === 'fcXlConfirm');
    const x = a.state.fcXl, sp = spec(a);
    ok(x.payUnit === 'usd' && x.plan.payUnit === 'usd' && x.payFixed && /^UP TO \$/.test(sp.amount) && rowOf(a, 'ON THE CARD').value === '$ 2.00' && !sp.ctaBusy,
       'dollars chosen: the confirmation pays from the dollars', JSON.stringify({ pu: x.payUnit, amount: sp.amount }));
    sp.go();
    await until('the PIN pad', () => !!pad(a));
    pad(a).type('2468');
    await waitFor(() => k.balance() === cardBefore + 200, 40000);
    await home(R);
    await settle();
    ok(k.balance() === cardBefore + 200 && R.W.balanceAt(MINT2) === atB && usdB - R.W.balanceOf('usd', MINT2) >= 200 && usdB - R.W.balanceOf('usd', MINT2) <= x.plan.total,
       'on the card, paid in dollars at B (payUnit usd), the bitcoin left alone', JSON.stringify({ spent: usdB - R.W.balanceOf('usd', MINT2), sat: R.W.balanceAt(MINT2) - atB }));
    booksGood('a dollar card at another mint, paid in dollars', R);
  }

  /* ---- 11: a card of 1.23 that holds both, at A ---------------------------------------------------------------------------- */
  {
    const { R, a, k } = await world({ own: true, units: ['sat', 'usd'], units2: ['sat', 'usd'], software: 23, hold: 'both', cardUnit: 'usd', atB: 20000 });
    a.twoUnitsOn = () => true;
    withPick(a);
    await usdAtB(R, a, 3000);
    const satB = R.W.balanceAt(MINT2);
    // SEND > FLASHCARD from home, not started in either balance
    R.sheet.length = 0;
    a.fcSendCard();
    a.state.amount = '1.00'; a.state.unit = 'USD';
    a.fcAmountNext();
    /* The owner's rule (2026-10-23): both of this phone's balances could pay $1.00, so which pays is asked right after the amount,
     * before any card is read; then the PIN where the card is known to want it, one read, and, the card holding both, which goes on it. */
    await until('the question', () => a.state.screen === 'currency');
    ok(a.state.curCard && a.state.curCard.question === 'SEND WHICH TO THE CARD?' && /Either balance could pay/.test(a.state.curCard.foot || '') && begins(R) === 0,
       'SEND from a phone whose two balances both cover it: which pays, asked after the amount and before any card is read', JSON.stringify(a.state.curCard));
    a.currencyPick('sat');
    await until('the PIN pad, or the card’s question', () => !!pad(a) || a.state.screen === 'currency' || a.state.screen === 'fcXlConfirm');
    if (pad(a)) pad(a).type('2468');
    await until('the card’s question', () => (a.state.screen === 'currency' && a.state.curCard && !/Either balance/.test(a.state.curCard.foot || '')) || a.state.screen === 'fcXlConfirm');
    if (a.state.screen === 'currency' && a.state.curCard.question === 'SEND WHICH TO THE CARD?') {
      ok(!a.state.curCard.short.usd && !a.state.curCard.short.sat && begins(R) === 1, 'read once: a card of both asks which goes on it, with nothing greyed', JSON.stringify(a.state.curCard));
      a.currencyPick('sat');
    }
    // (the paying balance was chosen already: PAY FROM WHICH? only where the flow still asks it)
    await until('the confirmation, or the question which pays', () => a.state.screen === 'currency' || (a.state.screen === 'fcXlConfirm' && !!(a.state.fcXl && a.state.fcXl.plan)));
    if (a.state.screen === 'currency') {
      ok(a.state.curCard.question === 'PAY FROM WHICH?', 'then which of this phone’s balances pays, both able to', a.state.curCard.question);
      a.currencyPick('sat');
    }
    await confirmed(a);
    let x = a.state.fcXl;
    ok(x.cardUnit === 'sat' && x.amount === Math.round(1e8 / 60000) && x.plan && x.plan.cardUnit === 'sat',
       'bitcoin chosen: the sats the dollars typed are at this phone’s price go on the card', JSON.stringify({ cu: x.cardUnit, amount: x.amount }));
    const satsOn = x.plan.land;
    spec(a).go();
    // (the PIN was typed before the read where the card was known to want it: then no pad here, the write goes on the PIN it has)
    await until('the PIN pad, or the write', () => !!pad(a) || (a.state.screen === 'paid' && a.state.paidSays === 'ON THE CARD'));
    if (pad(a)) pad(a).type('2468');
    await waitFor(() => a.state.screen === 'paid' && a.state.paidSays === 'ON THE CARD', 40000);
    await home(R);
    await settle();
    k.tap();
    let seen = await R.W.cardLook(k, { mine: true, price: 60000 });
    ok(seen.units && seen.units.sat && seen.units.sat.balance === satsOn, 'the sats are on the card, in bitcoin', JSON.stringify(seen.units && { sat: seen.units.sat && seen.units.sat.balance }));
    a.setState({ screen: 'home', stack: [] }); if (a.paidDismissed) a.paidDismissed(); await new Promise((ok2) => setTimeout(ok2, 100));
    // ADD FUNDS on its screen: which goes on it, asked first, with nothing greyed
    await readCard(a, k);
    a.fcAdd();
    ok(a.state.screen === 'currency' && a.state.curCard && a.state.curCard.question === 'ADD WHICH TO THE CARD?' && !a.state.curCard.short.usd && !a.state.curCard.short.sat,
       'ADD FUNDS on a card of both at another mint asks which, with nothing greyed', JSON.stringify(a.state.curCard));
    a.currencyPick('usd');
    ok(a.state.screen === 'amount' && a.state.flow === 'cardAdd' && a.fcUnit() === 'usd', 'dollars chosen: SET AMOUNT in dollars');
    a.state.amount = '1.50'; a.state.unit = 'USD';
    a.fcAmountNext();
    await until('the confirmation, or the question which pays', () => a.state.screen === 'currency' || (a.state.screen === 'fcXlConfirm' && !!(a.state.fcXl && a.state.fcXl.plan)));
    if (a.state.screen === 'currency') a.currencyPick('sat');
    await confirmed(a);
    x = a.state.fcXl;
    ok(x.cardUnit === 'usd' && x.amount === 150 && x.plan && x.plan.cardUnit === 'usd', 'the dollars to go on the card at its mint', JSON.stringify({ cu: x.cardUnit, amount: x.amount }));
    spec(a).go();
    await until('the PIN pad', () => !!pad(a));
    pad(a).type('2468');
    await waitFor(() => a.state.screen === 'flashcard' && !(a._fcTaps > 0) && !!a.state.fc && !!a.state.fc.bal && a.state.fc.bal.usd === 150, 40000);
    await home(R);
    await settle();
    k.tap();
    seen = await R.W.cardLook(k, { mine: true, price: 60000 });
    ok(seen.units.usd.balance === 150 && seen.units.sat.balance === satsOn && R.W.balanceAt(MINT2) < satB,
       'and the card holds both now: the dollars beside the sats', JSON.stringify({ usd: seen.units.usd.balance, sat: seen.units.sat.balance }));
    booksGood('a card of both at another mint', R);
  }

  /* ---- 12: the claim at A refused -------------------------------------------------------------------------------------- */
  {
    const { R, a, k } = await world({ own: true, units: ['sat', 'usd'], units2: ['sat', 'usd'], cardUnit: 'usd', atB: 20000 });
    await usdCardAtA(R, a, k, 500);
    const cardBefore = k.balance(), usdA = R.W.balanceOf('usd', MINT);
    const prev = R.fate;
    let refuse = 1;
    R.fate = (m) => {
      const u = new URL(m.url);
      if (refuse > 0 && u.origin === MINT && u.pathname === '/v1/mint/bolt11' && m.method === 'POST') { refuse -= 1; return '400\n{"detail":"the mint is not issuing now","code":11000}'; }
      return prev(m);
    };
    a.fcSendCard();
    a.state.amount = '3.00'; a.state.unit = 'USD';
    a.fcAmountNext();
    await until('the PIN pad, or the confirmation', () => !!pad(a) || a.state.screen === 'fcXlConfirm');
    if (pad(a)) pad(a).type('2468');
    await confirmed(a);
    const plan = a.state.fcXl.plan;
    spec(a).go();
    await waitFor(() => !!pad(a) || (!!card(a) && card(a).title === 'NOT ON THE CARD'), 20000);
    if (pad(a)) pad(a).type('2468');
    await waitFor(() => !!card(a) && card(a).title === 'NOT ON THE CARD', 40000);
    await home(R);
    await settle();
    ok(/The money is in this phone, at m\.test\. The card is as it was\./.test(card(a).all) && k.balance() === cardBefore && R.W.pendingMoves().length === 1
       && bare(R.W.mintUrl) === MINT2 && refuse === 0,
       'the claim at A refused: NOT ON THE CARD, the money this phone’s at A, the crossing kept, the phone home', card(a).all);
    const said = [];
    const con = R.window.console, log = con.log;
    con.log = (...xs) => { said.push(xs.join(' ')); log.apply(con, xs); };
    await R.W.finishMove();
    con.log = log;
    ok(!R.W.pendingMoves().length && R.W.balanceOf('usd', MINT) - usdA === plan.issue && k.balance() === cardBefore,
       'finished later from B: the dollars are this phone’s at A, and the card is as it was', JSON.stringify({ usd: R.W.balanceOf('usd', MINT) - usdA, issue: plan.issue }));
    ok(said.some((l) => /finished an interrupted crossing: \$ \d+\.\d\d at /.test(l)) && !said.some((l) => /finished an interrupted crossing: \d+ sats/.test(l)),
       'and its log line says the dollars as dollars, not as sats', said.filter((l) => /interrupted crossing/.test(l)).join(' | '));
    booksGood('the claim at the card’s mint refused', R);
  }

  /* ---- 13: the visit to A cannot connect --------------------------------------------------------------------------------- */
  {
    const { R, a, k } = await world({ own: true, onCard: 1000, atB: 4000 });
    const cardBefore = k.balance(), atA = R.W.balanceAt(MINT);
    const connect = R.W.connect;
    let failedOnce = false;
    R.W.connect = function (u) {
      if (!failedOnce && bare(u) === MINT && R.W.pendingMoves().length) { failedOnce = true; return Promise.reject(new Error('m.test did not answer.')); }
      return connect.apply(this, arguments);
    };
    a.fcSendCard();
    keyIn(a, 700);
    pad(a).type('2468');
    await confirmed(a);
    const plan = a.state.fcXl.plan;
    spec(a).go();
    await waitFor(() => !!card(a) && card(a).title === 'NOT ON THE CARD', 40000);
    await settle();
    R.W.connect = connect;
    ok(failedOnce && /The money is in this phone, at m\.test\./.test(card(a).all) && k.balance() === cardBefore && R.W.pendingMoves().length === 1
       && bare(R.W.mintUrl) === MINT2 && saved(R) === MINT2,
       'the visit cannot connect: NOT ON THE CARD, the money this phone’s at A, the phone home at B', card(a).all);
    await R.W.finishMove();
    ok(!R.W.pendingMoves().length && R.W.balanceAt(MINT) - atA === plan.issue, 'and the crossing is finished later', String(R.W.balanceAt(MINT) - atA));
    booksGood('the visit to the card’s mint not made', R);
  }

  /* ---- 14: the pieces cannot be made at A after the claim (`movePaid`) --------------------------------------------------- */
  {
    const { R, a, k } = await world({ own: true, onCard: 1000, atB: 4000 });
    const cardBefore = k.balance(), atA = R.W.balanceAt(MINT);
    const prepare = R.W.cardPrepare;
    let refused = 0;
    R.W.cardPrepare = function (c, n, o) {
      if (o && o.visit && !refused) { refused += 1; const e = new Error('The card’s mint would not make its pieces.'); return Promise.reject(e); }
      return prepare.apply(this, arguments);
    };
    a.fcSendCard();
    keyIn(a, 650);
    pad(a).type('2468');
    await confirmed(a);
    const plan = a.state.fcXl.plan;
    spec(a).go();
    await waitFor(() => !!card(a) && card(a).title === 'NOT ON THE CARD', 40000);
    await home(R);
    await settle();
    R.W.cardPrepare = prepare;
    ok(refused === 1 && /The card’s mint would not make its pieces\./.test(card(a).reason) && /The money is in this phone, at m\.test\./.test(card(a).all)
       && k.balance() === cardBefore && !R.W.pendingMoves().length && !R.W.cardOwed().length && R.W.balanceAt(MINT) - atA === plan.issue,
       'claimed at A and not made into pieces: NOT ON THE CARD, the money this phone’s at A, nothing crossing or owed', card(a).all);
    booksGood('the pieces not made at the card’s mint', R);
  }

  /* ---- 15: the tap that should write the pieces reads no card ------------------------------------------------------------- */
  {
    const { R, a, k } = await world({ own: true, onCard: 1000, atB: 4000 });
    const cardBefore = k.balance();
    a.fcSendCard();
    keyIn(a, 550);
    pad(a).type('2468');
    await confirmed(a);
    // the card taken away before the tap that writes
    R.nfc = null;
    spec(a).go();
    await waitFor(() => !!card(a) && card(a).title === 'TAP THE CARD AGAIN', 40000);
    await home(R);
    await settle();
    const owed = R.W.cardOwed().filter((r) => r.card === k.key);
    ok(owed.length > 0 && owed.reduce((n, r) => n + (Number(r.amount) || Number(r.sats) || 0), 0) === 550 && k.balance() === cardBefore && bare(R.W.mintUrl) === MINT2,
       'no card at the tap: the pieces are owed to that card, and the phone is home at B', JSON.stringify({ owed: owed.map((r) => r.amount || r.sats), card: card(a).all }));
    R.nfc = k;
    card(a).press('TAP CARD');
    await until('the PIN pad, or the write', () => !!pad(a) || k.balance() === cardBefore + 550);
    if (pad(a)) pad(a).type('2468');
    await waitFor(() => k.balance() === cardBefore + 550, 40000);
    await settle();
    ok(k.balance() === cardBefore + 550 && !R.W.cardOwed().filter((r) => r.card === k.key).length && bare(R.W.mintUrl) === MINT2,
       'and written at its next tap, from B', JSON.stringify({ card: k.balance() - cardBefore }));
    booksGood('the pieces owed and written later', R);
  }

  /* ---- 16: what the card will get is what the confirmation says ------------------------------------------------------------ */
  {
    const { R, a, k } = await world({ own: true, onCard: 1000, atB: 4000 });
    a.fcSendCard();
    keyIn(a, 800);
    pad(a).type('2468');
    await confirmed(a);
    const plan = a.state.fcXl.plan;
    ok(plan.worth === Math.round(plan.melt.amount * plan.land / plan.issue) && plan.fee === Math.max(0, plan.total - plan.worth),
       'the fee is worked out over what lands on the card', JSON.stringify({ worth: plan.worth, land: plan.land, issue: plan.issue }));
    // the pieces as cut can come to less than the amount typed: the row and the button say what lands
    a.setState({ fcXl: Object.assign({}, a.state.fcXl, { plan: Object.assign({}, plan, { land: 797 }) }) });
    ok(rowOf(a, 'ON THE CARD').value === '₿ 797' && spec(a).cta === 'PUT ₿ 797 ON CARD',
       'what the card will get, on the row and the button', JSON.stringify([rowOf(a, 'ON THE CARD').value, spec(a).cta]));
    /* A payment that failed with its melt still held (`cardLoadAcross` passes the error on, the wallet keeps the melt): said as on
     * its way, never "Nothing was taken." */
    const pm = R.W.pendingMelts;
    R.W.pendingMelts = () => [{ bolt11: String(plan.invoice).toUpperCase(), quote: 'q-held' }];
    a.fcXlFailed(a.state.fcXl, new Error('B said something went wrong.'));
    ok(!!card(a) && card(a).title === 'NOT ON THE CARD' && /has not finished/.test(card(a).reason) && !/Nothing was taken/.test(card(a).all),
       'a failure with the melt still held says the payment has not finished', card(a) && card(a).all);
    card(a).press('CLOSE');
    R.W.pendingMelts = () => [];
    a.fcXlFailed(a.state.fcXl, new Error('B said no.'));
    ok(!!card(a) && /Nothing was taken\.$/.test(card(a).reason), 'with nothing held: nothing was taken', card(a) && card(a).all);
    card(a).press('CLOSE');
    R.W.pendingMelts = pm;
    a.setState({ fcXl: null, screen: 'home', stack: [] });
    booksGood('what the card will get', R);
    void k;
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed' + (until.failed ? ', ' + until.failed + ' waits timed out' : ''));
  process.exit(failed || until.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
