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
 *
 * The screens are the card's parts with the send parts (tests/flashcard-ui-kit.js), over the real wallet, two test mints
 * (tests/flashcard-kit.js `second`) and the model of the card (tests/flashcard-card.js). The two test mints do not know each other's
 * invoices, so the world here does what Lightning does: a melt at B that the mint says PAID, of an invoice A made, pays A's quote
 * (`linked`). Every case ends with the books added up.
 */
const { page, newCard, settle, MINT, MINT2, OTHER_WORDS } = require('./flashcard-kit');
const { booksWrong } = require('./harness');
const { appOn, until, pad, card, keyIn } = require('./flashcard-ui-kit');

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
    k = newCard(R, undefined, { format: 4, software: 21, unit: opts.cardUnit });
    await R.W.cardSetUp(k, Object.assign({ pin: '2468' }, opts.cardUnit === 'usd' ? { unit: 'usd' } : {}));
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
    ok(spec(a).title === 'A CARD AT ANOTHER MINT' && spec(a).amountLabel === 'YOU PAY' && spec(a).amount === 'UP TO ₿ 1,010'
       && rowOf(a, 'ON THE CARD').value === '₿ 1,000' && rowOf(a, 'FEE, PAID BY YOU').value === 'UP TO ₿ 10'
       && rowOf(a, 'THE CARD’S MINT').value === 'M.TEST' && rowOf(a, 'YOUR MINT').value === 'N.TEST',
       'it says what goes on the card, what leaves this phone, the fee and the two mints', JSON.stringify((spec(a).rows || []).map((r) => r.label + '=' + r.value)));
    ok(spec(a).cta === 'PUT ₿ 1,000 ON CARD' && !spec(a).ctaBusy, 'the button says what it does, with the amount', spec(a).cta);
    spec(a).go();
    await waitFor(() => k.balance() === cardBefore + 1000, 40000);
    await waitFor(() => !!card(a) && card(a).title === 'ON THE CARD', 20000);
    await home(R);
    await settle();
    ok(!pad(a) && begins(R) === 2, 'no PIN asked again, and one more tap wrote it: two taps in all', String(begins(R)));
    ok(card(a).reason === '₿1,000 went onto the card.' && a.state.screen === 'home', 'said as any load from SEND is, at Home', card(a).reason);
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
    card(a).press('DONE');
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

  console.log('\n' + passed + ' passed, ' + failed + ' failed' + (until.failed ? ', ' + until.failed + ' waits timed out' : ''));
  process.exit(failed || until.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
