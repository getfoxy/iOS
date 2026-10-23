'use strict';
/* flashcard-holder.js — the card of a holder with no phone (software 1.22), its set-up's screens, and 1.21's held claim.
 *
 *     node tests/flashcard-holder.js
 *
 * Three parts, against the model of the card (tests/flashcard-card.js, `software: 21` and `software: 22`):
 *
 *   the card itself     what the model holds to of 1.21 and 1.22, command by command: SELECT's 01 15 and 01 16, 6A97 on a
 *                       card with no PIN, a load on a card with no owner (6A90 on 1.21, under the PIN on 1.22), the claim's
 *                       six askings, SET_LIMIT's PIN form, the history held for nine askings, refused in a tap that paid, and
 *                       no payment after it;
 *   the wallet          `cardSetUp` with the holder's two numbers, `cardSetUpFor` (the first paying phone, no owner, no key
 *                       of its own), `cardGuestLook` (VIEW AS GUEST, nothing kept) and `cardClaim` (TIE OWNERSHIP);
 *   the screens         driven as a person drives them (flashcard-ui-kit.js): the owner's set-up, its PIN pads, YES and NO
 *                       and SET AMOUNT for each; SEND > FLASHCARD to a new card, which this phone sets up for its holder and does not
 *                       own; VIEW AS GUEST and TIE OWNERSHIP TO THIS PHONE; RESTORE LOST CARD; the swipe between home and
 *                       the card; and no daily limit anywhere on the card's screen.
 *
 * And the set-up's two amounts in the card's own money, on SET AMOUNT: a dollar card's in dollars only, a bitcoin card's in dollars
 * first with the screen's swap to sats, the card sent cents or sats as before. No card of 1.21 or 1.22 in this suite makes change: every payment here is of
 * exact pieces (the change these cards make for themselves, mended or given up, is tests/flashcard-mend.js). */
const { funded, newCard, why, OTHER_WORDS } = require('./flashcard-kit');
const { appOn, until, pad, card, vals, settle, keyIn } = require('./flashcard-ui-kit');

let failed = 0;
// the card's MENU, at the top right: its rows, and what LIMITS says under it (what the card pays without its PIN)
const menuOf = (v) => (v.fcMenuItems || []).map((k) => k.label).join();
const limitsSub = (v) => ((v.fcMenuItems || []).find((k) => k.label === 'LIMITS') || {}).sub || '';
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

const SELECT = '00a404000af0464f5859434152440100';
const hexOf = (pin) => Buffer.from(pin, 'latin1').toString('hex');
const u32 = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
const ins = (c) => c.sent.filter((a) => a.slice(0, 2) === 'b0').map((a) => a.slice(2, 4));
const sw = (r) => String(r).slice(-4);
const card4 = (ctx, software) => newCard(ctx, undefined, { format: 4, software });
// whether a phone keeps any of a card's history: what it read of its log, or its receipts
// the last reads this phone keeps for the swipe (26f-flashcard.js, FC_READS)
const kept = (ctx) => { try { return JSON.parse(ctx.storage.getItem('foxy.flashcard.reads') || '{}') || {}; } catch (e) { return {}; } };
const keptFor = (ctx, key) => ['foxy.flashcard.receipts', 'foxy.flashcard.logseen'].some((k) => {
  try { return !!(JSON.parse(ctx.storage.getItem(k) || '{}') || {})[key]; } catch (e) { return true; }
});

/* SET AMOUNT, while the set-up asks one of its two amounts (26j-card-wheel.js, `fcSuAmount`): which, the unit on the screen, the unit
 * the card takes, what is typed, and the line under it; `type(figure, unit)` puts a figure on it as the keypad would ('USD' a dollar
 * string, 'SATS' whole sats; the swap is the screen's own, so the unit is said), `next()` is NEXT and `back()` the round back button. */
function amt(a) {
  const s = a.state;
  if (s.screen !== 'amount' || !/^cardSu(NoPin|Tap)$/.test(String(s.flow))) return null;
  return {
    flow: s.flow, unit: s.unit, cardUnit: a.fcTypedUnit(), amount: s.amount, line: a.fcSuAmountLine(),
    type(fig, unit) { a.setState({ amount: String(fig), unit: unit || s.unit }); return amt(a); },
    next() { a.fcAmountNext(); },
    back() { a.back(); },
  };
}

(async () => {
  const H = await funded({}, 20000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 20000);
  const G = await funded({ sharedMint: H.mint, words: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above' }, 0);

  /* ======== the card itself ======================================================================================= */
  {
    const c21 = card4(H, 21), c22 = card4(H, 22), c20 = card4(H);
    const sel = async (c) => { c.tap(); return c.send(SELECT); };
    ok((await sel(c21)) === '01159000' && (await sel(c22)) === '01169000' && (await sel(c20)) === '01149000',
       'SELECT answers 01 15 for 1.21 and 01 16 for 1.22 (and 01 14 for the card before them)');
    c21.tap();
    const l21 = await H.W.cardLook(c21);
    c22.tap();
    const l22 = await H.W.cardLook(c22);
    c20.tap();
    const l20 = await H.W.cardLook(c20);
    ok(l21.info.version === '1.21' && l21.info.pinFirst && !l21.info.guests && l22.info.version === '1.22' && l22.info.pinFirst && l22.info.guests
       && !l20.info.pinFirst && !l20.info.guests, 'and the phone reads both: 1.21 is a PIN first, 1.22 is that and a card a holder with no phone can have',
       JSON.stringify([l21.info.version, l22.info.version, l20.info.version]));

    // no PIN: 6A97 to a load, CLEAR_SPENT, a payment and a claim (a card is given its PIN before anything)
    for (const [c, name] of [[c21, '1.21'], [c22, '1.22']]) {
      await sel(c);
      const said = [await c.send('b0300000' + '51' + '00'.repeat(81)), await c.send('b031000001'), await c.send('b0220000' + '01' + '00'),
                    await c.send('b0430000' + '41' + '04' + '11'.repeat(64))].map(sw);
      ok(said.join() === '6a97,6a97,6a97,6a97', 'a ' + name + ' card with no PIN answers 6A97 to a load, CLEAR_SPENT, a payment’s first step and a claim', said.join());
    }
    // a PIN, and a record: on 1.21 a card with no owner takes no load (6A90); on 1.22 it takes one under the PIN
    const setUpBare = async (c) => {
      await sel(c);
      await c.send('b0410000' + '04' + hexOf('1234'));
      await c.send('b0400000' + '04' + hexOf('1234'));
      const rec = '00' + '00'.repeat(33) + '00'.repeat(65) + '0d' + Buffer.from('https://m.test').toString('hex').slice(0, 26);
      return c.send('b0320000' + (rec.length / 2).toString(16).padStart(2, '0') + rec);
    };
    ok(sw(await setUpBare(c21)) === '9000' && sw(await setUpBare(c22)) === '9000', 'both take a PIN and a record from whoever holds them, while they have no owner');
    await sel(c21);
    ok(sw(await c21.send('b0300000' + '51' + '00'.repeat(81))) === '6982', 'a load with no PIN in the tap: 6982');
    await c21.send('b0400000' + '04' + hexOf('1234'));
    ok(sw(await c21.send('b0300000' + '51' + '00'.repeat(81))) === '6a90', 'and on 1.21, with it: 6A90, a card with no owner takes no money');
    await sel(c22);
    await c22.send('b0400000' + '04' + hexOf('1234'));
    ok(sw(await c22.send('b0300000' + '51' + '00'.repeat(81))) === '6a80', 'on 1.22 the same load is let in under the PIN and judged as a piece (this one is not one: 6A80)');

    // SET_LIMIT's PIN form: the limit on one payment and, with eight bytes, the allowance; never once there is an owner
    await sel(c22);
    ok(sw(await c22.send('b0330000' + '08' + u32(300) + u32(50))) === '6982', 'SET_LIMIT’s PIN form with no PIN in the tap: 6982');
    await c22.send('b0400000' + '04' + hexOf('1234'));
    ok(sw(await c22.send('b0330000' + '08' + u32(300) + u32(50))) === '9000' && c22.state.tapLimit === 300 && c22.state.noPinLimit === 50 && c22.state.record.limit === 0,
       'with it: the limit on one payment and the no-PIN allowance, and no daily limit', JSON.stringify([c22.state.tapLimit, c22.state.noPinLimit]));

    // the claim: five askings answered keep holding, the sixth claims; another command between begins the count again
    await sel(c21);
    await c21.send('b0400000' + '04' + hexOf('1234'));
    const key = '04' + '22'.repeat(64);
    const claim = () => c21.send('b0430000' + '41' + key).then(sw);
    const firstFour = [await claim(), await claim(), await claim(), await claim()];
    await c21.send('b001010000');
    const again = [];
    for (let i = 0; i < 6; i++) again.push(await claim());
    ok(firstFour.every((x) => x === '6a98') && again.slice(0, 5).every((x) => x === '6a98') && again[5] === '9000' && c21.state.owner === key,
       'the claim: five askings answer 6A98, keep holding, and the sixth claims; a GET_INFO between begins the count again', again.join());
    await sel(c21);
    await c21.send('b0400000' + '04' + hexOf('1234'));
    ok(sw(await c21.send('b0330000' + '08' + u32(1) + u32(1))) === '6a91', 'once it has an owner the PIN form of the limit is 6A91');
    ok(sw(await c21.send('b0220000' + '01' + '00')) !== '6985', 'a new tap after a claim pays as ever (the claim’s tap is over)');
    {
      // a claim of a 1.22 card in a tap that paid: 6985; and a tap that claimed pays nothing after
      const t = card4(H, 21);
      await setUpBare(t);
      t.state.tapPaid = true;
      ok(sw(await t.send('b0430000' + '41' + key)) === '6985', 'a claim in a tap that paid is refused, 6985');
      t.tap();
      await t.send(SELECT);
      await t.send('b0400000' + '04' + hexOf('1234'));
      for (let i = 0; i < 6; i++) await t.send('b0430000' + '41' + key);
      ok(t.state.owner === key && sw(await t.send('b0220000' + '01' + '00')) === '6985', 'and no payment follows a claim in its own tap: 6985');
    }
  }

  /* ---- 1.22: the history, held for -------------------------------------------------------------------------------- */
  {
    const c = card4(H, 22);
    c.tap();
    await R.W.cardSetUpFor(c, { pin: '2468' });
    c.tap();
    await R.W.cardPrepare(await R.W.cardLook(c, { short: true }), 800);
    c.tap();
    await R.W.cardWrite(c, { pin: '2468' });
    c.tap();
    await c.send(SELECT);
    ok(sw(await c.send('b018000000')) === '6982', 'the history of a card with a PIN and no owner wants its PIN in the tap: 6982');
    await c.send('b0400000' + '04' + hexOf('2468'));
    const askings = [];
    for (let i = 0; i < 10; i++) askings.push(sw(await c.send('b018000000')));
    ok(askings.slice(0, 9).every((x) => x === '6a98') && askings[9] === '9000', 'with it, nine askings in a row are 6A98, keep holding, and the tenth answers', askings.join(' '));
    ok(sw(await c.send('b018010000')) === '9000' && sw(await c.send(SELECT)) === '9000' && sw(await c.send('b018000000')) === '6982'
       && sw(await c.send('b0400000' + '04' + hexOf('2468'))) === '9000' && sw(await c.send('b018000000')) === '9000',
       'once answered, the receipts are open in the same tap, and the log after a SELECT with the PIN given again, with no hold');
    ok(sw(await c.send('b0220000' + '01' + '00')) === '6985', 'and no payment follows a history read in its tap: 6985');
    // a GET_INFO between askings begins the count again
    c.tap();
    await c.send(SELECT);
    await c.send('b0400000' + '04' + hexOf('2468'));
    for (let i = 0; i < 5; i++) await c.send('b018000000');
    await c.send('b001010000');
    const after = [];
    for (let i = 0; i < 10; i++) after.push(sw(await c.send('b018000000')));
    ok(after.slice(0, 9).every((x) => x === '6a98') && after[9] === '9000', 'another command between askings begins the count again', after.join(' '));
    // a tap that paid shows no history
    c.tap();
    const paid = await G.W.cardPay(c, { sats: 800, pin: '2468' });
    ok(paid.sats === 800 && c.balance() === 0, 'the card pays a till 800 exactly (no change)', String(paid.sats));
    await c.send(SELECT);
    await c.send('b0400000' + '04' + hexOf('2468'));
    ok(sw(await c.send('b018000000')) === '6985', 'and in that tap its history is refused, 6985, before any asking is counted');
  }

  /* ======== the wallet ============================================================================================ */
  {
    // the owner's set-up with the holder's two numbers: under the PIN before the claim, on 1.21 and on
    const c = card4(H, 22);
    c.tap();
    const held = [];
    const made = await H.W.cardSetUp(c, { pin: '1234', tapLimit: 2000, noPin: 400, tapUsd: 1.2, noPinUsd: 0.25, onHold: (n) => held.push(n) });
    const order = ins(c);
    const from = order.lastIndexOf('41');
    const tail = order.slice(from).filter((x) => x !== '44');
    ok(made.info.owner && made.mine === true && c.state.tapLimit === 2000 && c.state.noPinLimit === 400 && c.state.record.limit === 0,
       'set up with its two numbers: its owner is this phone, its limit on one payment 2,000 and its no-PIN allowance 400, and no daily limit');
    ok(tail.slice(0, 5).join() === '41,40,32,33,43' && tail.filter((x) => x === '43').length === 6 && held.length === 6,
       'in the order PIN, PIN shown, record, SET_LIMIT’s PIN form, then six askings of the claim, each told to the screen', tail.join());
    ok(H.W.cardPaceUsd(c.key) === 1.2 && H.W.cardNoPinUsd(c.key) === 0.25, 'and the dollars they were chosen in are kept, so the sats follow the price');
    // a card before 1.21: the numbers with the owner's proof, once it has its owner
    const old = card4(H);
    old.tap();
    await H.W.cardSetUp(old, { pin: '1234', tapLimit: 700, noPin: 90 });
    const o2 = ins(old);
    ok(old.state.tapLimit === 700 && old.state.noPinLimit === 90 && o2.lastIndexOf('34') > o2.lastIndexOf('43') && o2.indexOf('33') < 0,
       'a card of 1.20 is given them with the owner’s form after its owner, never the PIN form', o2.slice(o2.lastIndexOf('41')).join());
    const none = card4(H, 22);
    none.tap();
    await H.W.cardSetUp(none, { pin: '1234' });
    ok(ins(none).indexOf('33') < 0 && none.state.tapLimit === 0 && none.state.noPinLimit === 0, 'and with no numbers chosen, no limit is sent at all');
    // cut off before its claim: a PIN, a record and no owner, which the same set-up tried again finishes under that PIN
    const cut = card4(H, 22);
    cut.tap();
    cut.leaveBefore('43', 1);
    ok((await why(H.W.cardSetUp(cut, { pin: '1234', tapLimit: 100 }))) === 'gone' && !cut.state.owner && cut.state.record.set && cut.state.pinState === 1,
       'a set-up cut off before its claim leaves a PIN and a record, and no owner');
    cut.tap();
    const again = await H.W.cardSetUp(cut, { pin: '1234', tapLimit: 100 });
    ok(again.mine === true && !!cut.state.owner && cut.state.tapLimit === 100, 'and the same set-up tried again finishes it, the PIN shown before it is set again');
  }
  {
    // the first paying phone: no owner, no key of its own, the money under the holder's PIN
    const c = card4(H, 22);
    c.tap();
    const set = await R.W.cardSetUpFor(c, { pin: '5555', tapLimit: 300, noPin: 40 });
    ok(!c.state.owner && c.state.pinState === 1 && c.state.record.set && c.state.record.refund === '00'.repeat(33) && c.state.tapLimit === 300 && c.state.noPinLimit === 40,
       'set up for its holder: a PIN, a record with no refund key (a cash card), the two numbers, and no owner', JSON.stringify([c.state.owner, c.state.record.refund.slice(0, 4)]));
    ok(set.info.setUp && !set.info.owner && !ins(c).includes('43') && !R.W.cardsKnown()[c.key], 'and no claim was asked for, and this phone keeps no row for it: it cannot take it back');
    c.tap();
    ok((await why(R.W.cardSetUpFor(c, { pin: '1111' }))) === 'has-pin', 'set up once, it is not set up again for anybody');
    const c21 = card4(H, 21);
    c21.tap();
    ok((await why(R.W.cardSetUpFor(c21, { pin: '1111' }))) === 'old-card', 'a card of 1.21 is not set up for somebody else: it takes no money with no owner');
    c.tap();
    await R.W.cardPrepare(await R.W.cardLook(c, { short: true }), 1200);
    c.tap();
    const w = await R.W.cardWrite(c, { pin: '5555' });
    ok(w.card.balance === 1200 && w.card.pieces.every((p) => p.date === 0), 'the money goes on under the holder’s PIN, in pieces with no date: nobody can take them back', String(w.card.balance));
    c.tap();
    const look = await R.W.cardLook(c, { mine: true });
    ok(look.mine !== true && !R.W.cardIsMine(look), 'and read by that phone afterwards, the card is not its own');

    // VIEW AS GUEST, on a third phone: the history, held for, and nothing of it kept
    c.tap();
    const asked = [];
    const g = await G.W.cardGuestLook(c, { pin: '5555', onHold: (n) => asked.push(n) });
    ok(g.guest && g.balance === 1200 && g.log && g.log.last.length >= 1 && g.receipts && g.receipts.guest && asked.length === 10 && g.tap.limit === 300,
       'VIEW AS GUEST: the PIN, ten askings told to the screen, the log, the receipts and the limit on one payment', JSON.stringify([asked.length, g.log.last.length, g.tap.limit]));
    ok(!keptFor(G, c.key), 'and the guest’s phone keeps none of it');
    c.tap();
    ok((await why(G.W.cardGuestLook(c, { pin: '0000' }))) === 'wrong-pin', 'a wrong PIN is the card’s own refusal, with its tries');
    c.tap();
    ok((await why(G.W.cardClaim(c, { pin: '5555' }))) === 'has-money' && !c.state.owner, 'TIE OWNERSHIP of a card with money on it is refused before anything is asked: spend or move it first');
    // the card emptied at a till, exactly; then claimed
    c.tap();
    await H.W.cardPay(c, { sats: 1200, pin: '5555' });
    c.tap();
    const held = [];
    const mineNow = await G.W.cardClaim(c, { pin: '5555', onHold: (n) => held.push(n) });
    ok(mineNow.mine === true && !!c.state.owner && held.length === 6 && /^0[23]/.test(c.state.record.refund) && G.W.cardsKnown()[c.key]
       && G.W.cardsKnown()[c.key].refundKey === c.state.record.refund,
       'emptied, it is tied to the phone in six askings, and given that phone’s refund key: its money can be taken back from now on', JSON.stringify([held.length, c.state.record.refund.slice(0, 6)]));
    c.tap();
    ok((await why(G.W.cardGuestLook(c, { pin: '5555' }))) === 'has-owner', 'a card with an owner has no guest view: its history is its owner’s');
  }

  /* ======== the screens =========================================================================================== */

  /* ---- B5: the owner's set-up, from the card's own screen -------------------------------------------------------- */
  {
    const holder = appOn(H);
    holder.price = 60000;
    await holder.refreshBalance();
    const c = card4(H, 22);
    H.nfc = c;
    holder.goFlashcard();
    await until('the new card to be read', () => !!holder.state.fc);
    let v = vals(holder);
    ok(v.fcNew && v.fcNewLine === 'Welcome to Foxy Card. Set it up to put money on it.' && typeof v.fcSetUp === 'function' && typeof v.fcRestore === 'function' && !v.fcGuest,
       'a new card is welcomed, with SET UP CARD and RESTORE LOST CARD', v.fcNewLine);
    holder.fcSetUp();
    ok(pad(holder) && pad(holder).title === 'CREATE A PIN' && pad(holder).sub === 'Four to eight digits. The card asks for it when it pays.' && !pad(holder).hasCancel,
       'SET UP CARD asks CREATE A PIN, on the card PIN pad, with the way out at the top', pad(holder) && pad(holder).title);
    pad(holder).type('2580');
    ok(pad(holder).title === 'RE-ENTER PIN', 'then RE-ENTER PIN');
    pad(holder).type('2581');
    ok(pad(holder).title === 'CREATE A PIN' && /did not match/.test(pad(holder).note), 'two that differ start it again', pad(holder).note);
    pad(holder).type('2580');
    pad(holder).type('2580');
    ok(card(holder) && card(holder).title === 'SMALL AMOUNTS' && card(holder).reason === 'Do you want to pay small amounts without entering your PIN?' && card(holder).has('YES') && card(holder).has('NO'),
       'at a mint with one balance, no currency is asked: next, "Do you want to pay small amounts without entering your PIN?" YES or NO', card(holder) && card(holder).all);
    card(holder).press('YES');
    let s = amt(holder);
    ok(s && s.flow === 'cardSuNoPin' && s.unit === 'USD' && s.amount === '' && s.cardUnit === 'sat' && holder.state.stack.slice(-1)[0] === 'flashcard' && s.line === '',
       'YES opens SET AMOUNT for the no-PIN amount, as LIMITS does: empty, in dollars first, for a card that holds sats, and no seconds line', JSON.stringify(s));
    s.back();
    ok(!amt(holder) && holder.state.screen === 'flashcard' && card(holder) && card(holder).title === 'SMALL AMOUNTS', 'its round back button is the question again, over the card’s screen as it was');
    card(holder).press('YES');
    amt(holder).next();
    ok(amt(holder) && holder.toasts.slice(-1)[0] === 'Type an amount first.', 'NEXT with nothing typed is refused, as on LIMITS', holder.toasts.slice(-1)[0]);
    amt(holder).type('5.00').next();
    ok(!amt(holder) && holder.state.screen === 'flashcard' && card(holder) && card(holder).title === 'MAX PER TAP' && card(holder).reason === 'Do you want to set a max per tap?',
       'NEXT carries it on: "Do you want to set a max per tap?", over the card’s screen', card(holder) && card(holder).all);
    card(holder).press('YES');
    s = amt(holder);
    ok(s && s.flow === 'cardSuTap' && s.unit === 'USD' && s.amount === '' && s.line === '', 'YES opens SET AMOUNT for the limit on one payment, empty, with no line before a figure', JSON.stringify(s));
    ok(amt(holder).type('10.00').line === 'It will take 13 seconds to pay $40.00.', 'typed, the line under it says the seconds a payment of four limits waits', amt(holder).line);
    ok(amt(holder).type('20.00').line === 'It will take 13 seconds to pay $80.00.', 'and follows the figure as it is typed', amt(holder).line);
    c.tap();
    H.sheet.length = 0;
    amt(holder).next();
    await until('the card to be set up', () => !!c.state.owner && holder.state.fc && holder.state.fc.ownedHere === true);
    ok(c.state.pin === hexOf('2580') && c.state.noPinLimit === Math.round(5 / 60000 * 1e8) && c.state.tapLimit === Math.round(20 / 60000 * 1e8) && c.state.record.limit === 0,
       'one tap wrote the PIN, the no-PIN amount and the limit on one payment in sats at the price, and no daily limit', JSON.stringify([c.state.noPinLimit, c.state.tapLimit]));
    ok(H.sheet.filter((x) => x === 'say: Keep holding.').length >= 6 && holder.toasts.indexOf('The card is set up.') >= 0,
       'the sheet said Keep holding at every asking of the claim, and the screen said it is set up', String(H.sheet.filter((x) => x === 'say: Keep holding.').length));
    v = vals(holder);
    ok(v.fcUsable && !v.fcGuest && /^PER TAP LIMIT \$20\.00/.test(v.fcLimitLine) && v.fcNoPinShown === undefined && /^No PIN up to \$5\.00 · \$[\d,.]+ left$/.test(limitsSub(v)) && v.fcDayShown === undefined,
       'its screen: the per tap limit on its face, the no PIN limit and what is left of it under LIMITS in its menu, and nothing of a day', [v.fcLimitLine, limitsSub(v)].join(' | '));
    ok(menuOf(v) === 'LIMITS,CHANGE PIN,RESTORE LOST CARD,RESET' && v.fcMenuShown === true && v.fcCloseShown === false,
       'the MENU at the top right, in place of the close button, holds LIMITS, CHANGE PIN, RESTORE LOST CARD and RESET, in that order', menuOf(v));
    ok(v.fcMenuItems.every((k) => typeof k.tap === 'function' && /^M/.test(k.path)) && v.fcMenuItems.slice(1).every((k) => k.sub === ''),
       'each row a tap with its own drawing, and only LIMITS has a line under it');
    // (MENU is home's own button, `toggleMenu`, which turns `open0`)
    ok(v.fcMenuOpen === false && (holder.setState({ open0: true }), vals(holder).fcMenuOpen === true) && (holder.setState({ open0: false }), vals(holder).fcMenuOpen === false),
       'MENU opens the drawer, as home’s does, and closes it');
    ok(v.fcRowShown === true && v.fcButtons.map((k) => k.label).join() === 'SCAN,PASTE,SWAP' && v.fcButtons.every((k) => typeof k.tap === 'function' && /^M/.test(k.path))
       && v.fcButtons[2].dim === '0.38',
       'the bottom row is home’s: SCAN, PASTE and SWAP, SWAP greyed on a card of one currency', v.fcButtons.map((k) => k.label + ' ' + k.dim).join(', '));
    ok(v.fcLinks === undefined && v.fcNoPinLine === undefined && v.fcBlockLine === undefined, 'and the old row, the no-PIN line and the block line are gone from the screen');

    // NO and NO: nothing set, no limit sent
    const n = card4(H, 21);
    H.nfc = n;
    n.tap();
    holder.fcRead();
    await until('the second card to be read', () => holder.state.fc && holder.state.fc.key === n.key);
    holder.fcSetUp();
    pad(holder).type('1357');
    pad(holder).type('1357');
    card(holder).press('NO');
    card(holder).press('NO');
    await until('the 1.21 card to be set up', () => !!n.state.owner && holder.state.fc && holder.state.fc.key === n.key && holder.state.fc.ownedHere === true);
    ok(n.state.tapLimit === 0 && n.state.noPinLimit === 0 && ins(n).indexOf('33') < 0 && vals(holder).fcLimitLine === 'NO LIMIT',
       'NO and NO: a card of 1.21 set up with no limits, and none sent', vals(holder).fcLimitLine);

    // the daily limit (C15): a card with one shows nothing of it, and LIMITS offers none
    n.tap();
    await H.W.cardSetLimit(n, { sats: 900 });
    n.tap();
    holder.fcRead();
    await until('the card with a daily limit', () => holder.state.fc && holder.state.fc.limit === 900);
    v = vals(holder);
    ok(v.fcLimitLine === '' && v.fcLimitShown === false && v.fcDayLeft === undefined, 'a card with a daily limit says nothing of it on its face', JSON.stringify(v.fcLimitLine));
    holder.fcSetLimit();
    ok(card(holder) && card(holder).all === ['CHANGE CARD LIMITS', 'Which limit would you like to add or change?', 'PER TAP LIMIT', 'NO PIN LIMIT', 'CLOSE'].join(' | '),
       'LIMITS: the per tap limit and the no PIN limit, and no daily limit, and CLOSE rather than CANCEL', card(holder) && card(holder).all);
    // the no-PIN keypad of a card of 1.21 and on asks of the PIN, not of a day
    holder._fcLimitNoPin = true;
    ok(holder.fcLimitQuestion() === 'What is the most this card should pay by tap alone before it asks for its PIN?',
       'the no-PIN keypad of a card of 1.21 and on asks nothing of a day', holder.fcLimitQuestion());
    holder._fcLimitNoPin = false;
    card(holder).press('CLOSE');

    // B9 from the card's row: a card this phone can take back says when; a cash card says it cannot be
    holder.fcRestoreThis();
    ok(card(holder) && /when this phone last saw it/.test(card(holder).reason) && card(holder).title === holder.fcName(n.key),
       'RESTORE on a card this phone set up: its row of CARDS YOU LOADED, saying what it held and when it can be taken back', card(holder) && card(holder).all);
    card(holder).press('CLOSE');
  }

  /* ---- the two amounts' unit, by what the card holds (the owner's rule of 2026-10-22) --------------------------------------------
   * A dollar card's amounts are typed in dollars and nothing else; a bitcoin card's in dollars first or in sats by SET AMOUNT's own swap;
   * what the card is sent is what it takes (cents, or sats) either way. */
  {
    const a = appOn(H, { screen: 'flashcard' });
    a.price = 60000;
    // a bitcoin card: dollars first; typed in sats, both amounts are sats, and no dollars are kept for them
    let chose = null;
    a.fcSetUpSteps({ unit: 'sat', run: (c) => { chose = c; } });
    pad(a).type('2580'); pad(a).type('2580');
    card(a).press('YES');
    ok(amt(a).unit === 'USD' && amt(a).cardUnit === 'sat', 'a bitcoin card’s SET AMOUNT opens in dollars, for sats', JSON.stringify(amt(a)));
    amt(a).type('2000', 'SATS').next();
    card(a).press('YES');
    ok(amt(a).flow === 'cardSuTap' && amt(a).type('10000', 'SATS').line === 'It will take 13 seconds to pay ₿ 40,000.', 'swapped to sats, the seconds line is in sats', amt(a).line);
    ok(amt(a).type('20000', 'SATS').line === 'It will take 13 seconds to pay ₿ 80,000.', 'and follows the figure in sats', amt(a).line);
    ok(amt(a).type('10.00', 'USD').line === 'It will take 13 seconds to pay $40.00.', 'swapped back, the line is in dollars', amt(a).line);
    amt(a).type('50000', 'SATS').next();
    ok(chose && chose.noPin === 2000 && chose.noPinUsd === 0 && chose.tapLimit === 50000 && chose.tapUsd === 0 && a.state.screen === 'flashcard',
       'what the card is sent is the sats typed, and no dollars are kept for figures typed in sats', JSON.stringify(chose));
    // typed in dollars, a bitcoin card is sent their sats, and the dollars are kept, as LIMITS keeps them
    chose = null;
    a.fcSetUpSteps({ unit: 'sat', run: (c) => { chose = c; } });
    pad(a).type('2580'); pad(a).type('2580');
    card(a).press('YES');
    amt(a).type('2.00').next();
    card(a).press('YES');
    amt(a).type('10.00').next();
    ok(chose && chose.noPin === Math.round(2 / 60000 * 1e8) && chose.noPinUsd === 2 && chose.tapLimit === Math.round(10 / 60000 * 1e8) && chose.tapUsd === 10,
       'typed in dollars: their sats at the price, and the dollars kept', JSON.stringify(chose));
    // a dollar card: dollars and nothing else, price or not
    chose = null;
    a.fcSetUpSteps({ unit: 'usd', run: (c) => { chose = c; } });
    pad(a).type('2580'); pad(a).type('2580');
    card(a).press('YES');
    ok(amt(a).unit === 'USD' && amt(a).cardUnit === 'usd', 'a dollar card’s SET AMOUNT is in dollars, for cents', JSON.stringify(amt(a)));
    amt(a).type('2.00').next();
    card(a).press('YES');
    ok(amt(a).type('10.00').line === 'It will take 13 seconds to pay $40.00.', 'its limit too, its seconds line in dollars', amt(a).line);
    amt(a).next();
    ok(chose && chose.noPin === 200 && chose.tapLimit === 1000 && chose.noPinUsd === 0 && chose.tapUsd === 0, 'and the card is sent cents', JSON.stringify(chose));
    a.price = 0;
    a.fcSetUpSteps({ unit: 'usd', run: () => {} });
    pad(a).type('2580'); pad(a).type('2580');
    card(a).press('YES');
    ok(amt(a).unit === 'USD' && amt(a).cardUnit === 'usd', 'with no Bitcoin price a dollar card is still in dollars, never sats', JSON.stringify(amt(a)));
    amt(a).back();
    card(a).press('NO');
    card(a).press('NO');
    // LIMITS takes its figure on the SET AMOUNT keypad: a dollar card's in dollars with no swap, a bitcoin card's in dollars with the swap to sats
    {
      const k = appOn(H, { screen: 'flashcard', fc: { unit: 'usd', key: 'x' } }, { send: true });
      k.price = 60000;
      k.fcAmount('cardLimit');
      const usdPad = k.state.unit === 'USD' && k.usdKeypad() === true;
      k.setState({ screen: 'flashcard', stack: [], fc: { unit: 'sat', key: 'y' } });
      k.fcAmount('cardLimit');
      const satPad = k.state.unit === 'USD' && k.usdKeypad() === false;
      k.price = 0;
      k.setState({ screen: 'flashcard', stack: [] });
      k.fcAmount('cardLimit');
      ok(usdPad && satPad && k.state.unit === 'SATS', 'LIMITS: a dollar card’s keypad is dollars with no swap; a bitcoin card’s is dollars with its swap to sats, and sats with no price',
         JSON.stringify([usdPad, satPad, k.state.unit]));
    }
    // a bitcoin card with no price: sats alone, as dollars cannot be turned into the sats it holds
    a.fcSetUpSteps({ unit: 'sat', run: () => {} });
    pad(a).type('2580'); pad(a).type('2580');
    card(a).press('YES');
    ok(amt(a).unit === 'SATS' && amt(a).cardUnit === 'sat', 'a bitcoin card with no price: SET AMOUNT in sats', JSON.stringify(amt(a)));
    amt(a).back();
    card(a).press('NO');
    card(a).press('NO');
  }

  /* ---- B6: SEND > FLASHCARD to a new card: this phone sets it up for its holder, and does not own it -------------------- */
  const cash = card4(H, 22);
  {
    const payer = appOn(R);
    payer.price = 60000;
    await payer.refreshBalance();
    R.nfc = cash;
    cash.tap();
    payer.fcSendCard();
    ok(payer.state.screen === 'amount' && payer.state.flow === 'cardSend', 'SEND > FLASHCARD asks for the amount first');
    keyIn(payer, 1500);
    await until('the set-up to begin', () => !!pad(payer));
    ok(pad(payer).title === 'CREATE A PIN' && /The person who holds it types the PIN they want/.test(pad(payer).sub) && /not this phone’s/.test(pad(payer).sub) && R.W.cardOwed().length === 0,
       'a new card held to the phone: nothing is made for it, and the set-up begins with CREATE A PIN, saying whose PIN it is', pad(payer).sub);
    ok(R.sheet.some((x) => x === 'end: Set up the card first'), 'the sheet ended calmly, saying the card is to be set up first', R.sheet.slice(-1)[0]);
    pad(payer).type('8642');
    ok(pad(payer).title === 'RE-ENTER PIN' && pad(payer).sub === 'The person who holds the card types the same PIN again.', 'RE-ENTER PIN, in the same words', pad(payer).sub);
    pad(payer).type('8642');
    ok(card(payer) && card(payer).title === 'SMALL AMOUNTS', 'then the same two questions');
    card(payer).press('YES');
    ok(amt(payer) && amt(payer).flow === 'cardSuNoPin' && payer.state.stack.indexOf('amount') < 0, 'YES opens SET AMOUNT in place of SEND’s keypad', JSON.stringify(payer.state.stack));
    amt(payer).type('2.00').next();
    ok(payer.state.screen === 'amount' && payer.state.flow === 'cardSend' && payer.state.amount === '1500' && payer.state.unit === 'SATS',
       'NEXT puts SEND’s keypad back as it was, under the next question', JSON.stringify([payer.state.flow, payer.state.amount]));
    card(payer).press('NO');
    cash.tap();
    await until('the money to be on the card', () => cash.balance() === 1500 && payer.state.screen === 'home');
    ok(!cash.state.owner && cash.state.record.refund === '00'.repeat(33) && cash.state.pin === hexOf('8642') && cash.state.noPinLimit === Math.round(2 / 60000 * 1e8) && cash.state.tapLimit === 0,
       'one tap: the holder’s PIN, no owner, no refund key, a no-PIN amount of $2.00, and the 1,500 under the PIN', JSON.stringify([cash.state.noPinLimit, cash.balance()]));
    ok(!ins(cash).includes('43') && !R.W.cardsKnown()[cash.key] && payer.toasts.indexOf('The card is set up for the person who holds it.') >= 0,
       'no claim was asked for, the phone keeps no row of it, and the screen says whose card it is', payer.toasts.slice(-2).join(' / '));
    ok(card(payer) && card(payer).reason === '\u20bf1,500 went onto the card.', 'and what went on, as any money put on a card is said', card(payer) && card(payer).reason);
    card(payer).press('DONE');
    // read on the same phone's FLASHCARD screen: somebody else's card
    cash.tap();
    payer.goFlashcard();
    await until('the cash card to be read', () => payer.state.fc && payer.state.fc.key === cash.key);
    const v = vals(payer);
    ok(payer.state.fc.ownedHere === false && payer.state.fc.mine === false && v.fcGuest && !v.fcUsable && v.fcBalance === '₿ 1,500'
       && v.fcGuestLine === 'This card belongs to whoever holds it. It is not tied to any phone.',
       'and read on that phone it is not its own: its balance, and VIEW AS GUEST and TIE OWNERSHIP TO THIS PHONE, and nothing to move its money', v.fcBalance);
    payer.fcRestoreThis();
    ok(card(payer) && card(payer).reason === 'This card is cash: it was set up with no key that can take its money back, so if it is lost its money cannot be restored.',
       'RESTORE on a cash card says, in one sentence, that it cannot be restored and why', card(payer) && card(payer).reason);
    card(payer).press('CLOSE');
    // a new card of 1.21 cannot be set up for somebody else: it takes no money with no owner
    const new21 = card4(H, 21);
    R.nfc = new21;
    payer.setState({ screen: 'home', stack: [], fc: null });
    payer.fcSendCard();
    keyIn(payer, 500);
    await until('the refusal', () => !!card(payer));
    ok(card(payer).title === 'NOT ON THIS CARD' && /its holder sets it up on their own Foxy first/i.test(card(payer).reason) && !pad(payer) && R.W.cardOwed().length === 0 && new21.state.pinState === 0,
       'SEND > FLASHCARD to a new card of 1.21 says plainly that its holder sets it up first, and nothing is made or written', card(payer).reason);
    card(payer).press('CLOSE');
  }

  /* ---- B7: VIEW AS GUEST and TIE OWNERSHIP TO THIS PHONE, on a friend's phone ------------------------------------------ */
  {
    const friend = appOn(G);
    friend.price = 60000;
    G.nfc = cash;
    cash.tap();
    friend.goFlashcard();
    await until('the card to be read', () => friend.state.fc && friend.state.fc.key === cash.key);
    let v = vals(friend);
    ok(v.fcGuest && v.fcBalance === '₿ 1,500' && !friend.state.fc.log, 'its balance at once, with no PIN and nothing held for, and no history yet');
    v.fcGuestView();
    ok(pad(friend) && pad(friend).title === 'CARD PIN' && pad(friend).cta === 'VIEW AS GUEST', 'VIEW AS GUEST asks for the card’s PIN', pad(friend) && pad(friend).cta);
    G.sheet.length = 0;
    cash.tap();
    pad(friend).type('8642');
    await until('the log to be shown', () => card(friend) && /OWN LOG/.test(card(friend).title));
    ok(G.sheet.filter((x) => x === 'say: Keep holding.').length >= 9 && cash.state.tapRead === true,
       'the sheet says Keep holding while the card is held for (ten askings), and the card has read its history out', String(G.sheet.filter((x) => x === 'say: Keep holding.').length));
    ok(/Shown as a guest: nothing of it is kept on this phone\./.test(card(friend).reason) && / put on/.test(card(friend).reason) && !card(friend).has('COPY RECEIPTS'),
       'the card’s own log, said to be shown as a guest, with the money put on and nothing to copy', card(friend).reason);
    card(friend).press('CLOSE');
    v = vals(friend);
    ok(friend.state.fc.guestRead && v.fcBalance === '₿ 1,500' && /^NO PIN UP TO/.test(v.fcLimitLine), 'and the screen shows the balance with it', v.fcLimitLine);
    ok(!keptFor(G, cash.key), 'nothing of the history is kept on the friend’s phone');
    ok(!kept(G)[cash.key] && !friend.fcKeptRead(), 'and no read of the card is kept for the swipe: a guest’s read is kept nowhere');
    // a tap that paid: the card's 6985, said in plain words
    cash.state.tapPaid = true;
    G.nfc = { send: (a) => cash.send(a), tap: () => {} };
    friend.fcGuestRun('8642');
    await until('the refusal', () => card(friend) && card(friend).title === 'THE CARD HAS JUST PAID');
    ok(/does not show its history in the same tap/.test(card(friend).reason), 'a tap that paid shows no history, and says why', card(friend).reason);
    card(friend).press('CLOSE');
    G.nfc = cash;
    // TIE OWNERSHIP with money on the card
    vals(friend).fcGuestTie();
    ok(card(friend) && card(friend).title === 'MONEY ON THE CARD' && card(friend).reason === 'Spend or move the money on this card first. Only an empty card can be tied to a phone.' && !pad(friend),
       'TIE OWNERSHIP of a card with money on it: spend or move the money first, before any PIN', card(friend) && card(friend).all);
    card(friend).press('CLOSE');
    // emptied at a till, and read again: TIE OWNERSHIP
    cash.tap();
    await H.W.cardPay(cash, { sats: 1500, pin: '8642' });
    cash.tap();
    friend.fcRead();
    await until('the empty card', () => friend.state.fc && friend.state.fc.key === cash.key && friend.state.fc.balance === 0);
    vals(friend).fcGuestTie();
    ok(card(friend) && card(friend).title === 'TIE OWNERSHIP TO THIS PHONE?' && /This makes this phone the card’s owner/.test(card(friend).reason) && card(friend).has('TIE OWNERSHIP'),
       'an empty card: a plain warning first, that this makes this phone its owner', card(friend) && card(friend).all);
    card(friend).press('TIE OWNERSHIP');
    ok(pad(friend) && pad(friend).cta === 'TIE OWNERSHIP' && /about four seconds/.test(pad(friend).sub), 'then its PIN', pad(friend) && pad(friend).sub);
    G.sheet.length = 0;
    cash.tap();
    pad(friend).type('8642');
    await until('the claim', () => friend.state.fc && friend.state.fc.ownedHere === true);
    v = vals(friend);
    ok(!!cash.state.owner && G.sheet.filter((x) => x === 'say: Keep holding.').length >= 6 && friend.toasts.indexOf('This phone is the card’s owner now.') >= 0
       && v.fcUsable && !v.fcGuest && friend.state.fc.recoverable,
       'the claim, Keep holding at every asking: this phone owns the card now, with its own key in it, and its screen is an owner’s', friend.toasts.slice(-1)[0]);
  }

  /* ---- B9: RESTORE LOST CARD from the welcome ------------------------------------------------------------------------ */
  {
    const fresh = await funded({ sharedMint: H.mint, words: 'army van defense carry jealous true garbage claim echo media make crunch' }, 0);
    const empty = appOn(fresh, { screen: 'flashcard' });
    empty.fcRestoreLost();
    ok(card(empty) && card(empty).title === 'RESTORE LOST CARD' && /set up no card whose money it can take back/.test(card(empty).reason),
       'RESTORE LOST CARD on a phone that loaded no card says so, and that a card set up for somebody else cannot be restored', card(empty) && card(empty).reason);
    const holderApp = appOn(H, { screen: 'flashcard', fc: { key: 'x', setUp: false } });
    holderApp.fcRestoreLost();
    const v = vals(holderApp);
    ok(!card(holderApp) && holderApp.state.screen === 'flashcard' && !holderApp.state.fc && v.fcHasRows && v.fcRows.length >= 2,
       'on the phone that loaded cards: the list of CARDS YOU LOADED, the take-back of each', String(v.fcRows.length));
  }

  /* ---- B10: a swipe between home and the card, the HOME | CARD pill, and the card as it was last read --------------- */
  {
    const fresh = await funded({ sharedMint: H.mint, words: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong' }, 0);
    const a = appOn(fresh);
    ok(a.fcSwipe('left') === false && a.state.screen === 'home', 'a phone with no card: a swipe on home does nothing');
    ok(!vals(a).pageTabsShown && vals(a).pageTabs.length === 0, 'and home shows no HOME | CARD pill');
    H.storage.removeItem('foxy.flashcard.reads');
    const b = appOn(H);
    ok(!!b.fcLastCard(), 'a phone that set a card up has a newest card');
    let v = vals(b);
    // the pill: HOME on the left and CARD on the right, the one on show raised in the pale frost pill, the other dimmed
    const FROST = 'linear-gradient(160deg,#D6EEF7,#B9DCEA)';
    const tabsAre = (w, onKey) => w.pageTabsShown && w.pageTabs.length === 2
      && w.pageTabs.map((t) => t.key + ':' + t.label).join(',') === 'home:HOME,card:CARD'
      && w.pageTabs.every((t) => (t.key === onKey)
        ? (t.bg === FROST && t.ink === '#10161B' && t.pressed === 'true')
        : (t.bg === 'transparent' && t.ink === 'rgba(var(--ink-rgb),.55)' && t.pressed === 'false'));
    ok(tabsAre(v, 'home') && !('swipeDots' in v) && !('swipeHintShown' in v),
       'home shows HOME | CARD with HOME raised, and no dots and no hint', JSON.stringify(v.pageTabs && v.pageTabs.map((t) => [t.key, t.pressed])));
    ok(JSON.stringify(v.pageTabs[0].bg) === JSON.stringify(b.segLook(true, 'frost').bg) && v.pageTabs[1].bg === b.segLook(false, 'frost').bg,
       'the halves are drawn by segLook, the same as history’s DOLLARS | BITCOIN');
    H.nfc = null;
    H.sheet.length = 0;
    b.fcWatchSwipe();
    const doc = H.window.document;
    const touch = (kind, x, y) => {
      const ev = new H.window.Event(kind, { bubbles: true });
      ev[kind === 'touchend' ? 'changedTouches' : 'touches'] = [{ clientX: x, clientY: y }];
      doc.body.dispatchEvent(ev);
    };
    touch('touchstart', 300, 400);
    touch('touchend', 150, 410);
    ok(b.state.screen === 'flashcard' && H.sheet.some((x) => /^begin: /.test(x)), 'a swipe to the left with no read of the card kept asks for the card, as MENU > FLASHCARD did', H.sheet.join(' / '));
    await settle();
    v = vals(b);
    ok(tabsAre(v, 'card'), 'the card’s screen shows the same pill with CARD raised');
    touch('touchstart', 100, 400);
    touch('touchend', 260, 395);
    ok(b.state.screen === 'home' && !b.state.fc, 'and a swipe to the right on the card’s screen is home again');
    ok(H.storage.getItem('foxy.flashcard.swipes') === null, 'the swipe counts nothing any more (the hint is gone)');
    touch('touchstart', 10, 400);
    touch('touchend', 200, 400);
    ok(b.state.screen === 'home', 'a swipe that starts at the left edge is the back gesture’s, not this one');
    touch('touchstart', 300, 400);
    touch('touchend', 260, 400);
    ok(b.state.screen === 'home', 'a short movement is not a swipe');
    b.state.open0 = true;
    ok(b.fcSwipe('left') === false && b.state.screen === 'home', 'with the menu open, nothing');
    b.state.open0 = false;

    // a card this phone owns, with money on it, read once
    const own = card4(H, 22);
    own.tap();
    await H.W.cardSetUp(own, { pin: '1357' });
    own.tap();
    await H.W.cardPrepare(await H.W.cardLook(own, { short: true }), 700);
    own.tap();
    await H.W.cardWrite(own, { pin: '1357' });
    await settle();
    H.nfc = own;
    own.tap();
    b.goFlashcard();
    await until('the owned card read', () => b.state.fc && b.state.fc.key === own.key && b.state.fc.balance === 700);
    const read = vals(b).fcBalance;
    const k = kept(H)[own.key];
    ok(!!k && k.fc.balance === 700 && b.fcLastCard().key === own.key, 'its read is kept for the swipe, by the card’s key', JSON.stringify(k && k.fc.balance));
    ok(!!k && !/"(secret|C|nonce|dleq|witness|proofs)"\s*:\s*[\[{"]/.test(JSON.stringify(k)) && !('pieces' in k.fc),
       'and what is kept is the screen’s figures, with no piece, secret or proof of the card’s money', JSON.stringify(k));
    b.setState({ screen: 'home', stack: [], fc: null });
    b._fcCard = null;
    H.nfc = null;
    H.sheet.length = 0;
    touch('touchstart', 300, 400);
    touch('touchend', 150, 410);
    v = vals(b);
    ok(b.state.screen === 'flashcard' && !H.sheet.some((x) => /^begin: /.test(x)) && b.state.fc && b.state.fc.memo && v.fcBalance === read,
       'a swipe to the card shows it at once as it was last read, with no tap', v.fcBalance + ' / ' + H.sheet.join(' / '));
    ok(v.fcMemoShown && v.fcMemoLine === 'As read a moment ago · tap the card to refresh' && v.fcPillRows.length === 1,
       'with its pill, and a line under it saying when it was read and that a tap of the card refreshes it', v.fcMemoLine);
    ok(tabsAre(v, 'card'), 'and CARD raised');
    touch('touchstart', 100, 400);
    touch('touchend', 260, 395);
    ok(b.state.screen === 'home', 'a swipe to the right is home again');
    // the pill's taps: CARD on home is the swipe to the card (from its last read), HOME on the card's screen the swipe home
    v = vals(b);
    v.pageTabs[0].tap();
    ok(b.state.screen === 'home', 'HOME on home, the half already raised, does nothing');
    H.sheet.length = 0;
    v.pageTabs[1].tap();
    v = vals(b);
    ok(b.state.screen === 'flashcard' && b.state.fc && b.state.fc.memo && v.fcBalance === read && !H.sheet.some((x) => /^begin: /.test(x)) && tabsAre(v, 'card'),
       'CARD on home opens the card’s screen at once as it was last read, CARD raised', v.fcBalance + ' / ' + H.sheet.join(' / '));
    v.pageTabs[1].tap();
    ok(b.state.screen === 'flashcard', 'CARD on the card’s screen does nothing');
    v.pageTabs[0].tap();
    ok(b.state.screen === 'home' && !b.state.fc && b.state.stack.length === 0 && tabsAre(vals(b), 'home'), 'HOME on the card’s screen is home again, HOME raised');
    b.state.open0 = true;
    vals(b).pageTabs[1].tap();
    ok(b.state.screen === 'home', 'with the menu open, CARD does nothing, as the swipe');
    b.state.open0 = false;
    b._fcSwipeOff();

    // Foxy started again: the stored read, with its age
    const all = kept(H);
    all[own.key].at = Date.now() - 3 * 60000;
    H.storage.setItem('foxy.flashcard.reads', JSON.stringify(all));
    const c = appOn(H);
    H.sheet.length = 0;
    c.goFlashcard({ kept: true });
    v = vals(c);
    ok(c.state.screen === 'flashcard' && !H.sheet.length && v.fcBalance === read && v.fcMemoLine === 'As read 3 minutes ago · tap the card to refresh',
       'after a relaunch MENU > FLASHCARD shows the stored read the same way, with its age', v.fcMemoLine);
    // ADD FUNDS on a kept read asks for the card first, then goes on
    H.nfc = own;
    own.tap();
    v.fcAdd();
    ok(H.sheet.some((x) => /^begin: /.test(x)), 'ADD FUNDS on a kept read asks for the tap of the card first', H.sheet.join(' / '));
    await until('the amount screen', () => c.state.screen === 'amount' && c.state.flow === 'cardAdd');
    ok(c.state.stack.indexOf('flashcard') >= 0 && !c.state.fc.memo, 'and once the card is read, ADD FUNDS goes on to SET AMOUNT');
    // a tap of the card's picture refreshes a kept read
    const d = appOn(H);
    d.goFlashcard({ kept: true });
    H.sheet.length = 0;
    own.tap();
    vals(d).fcCardTap();
    await until('the refreshed read', () => d.state.fc && !d.state.fc.memo && d.state.fc.key === own.key);
    ok(H.sheet.some((x) => /^begin: /.test(x)) && !vals(d).fcMemoShown, 'pressing the card’s picture reads it again, and the line goes');
    // a reset card is forgotten
    d.fcForgetRead(own.key);
    ok(!kept(H)[own.key], 'a card forgotten (as a reset does) keeps no read');
  }

  /* ======== a first payer's set-up cut short, and the model's order ================================================ */
  {
    // the model: SET_CARD on an empty card with no PIN is open on 1.22 as on 1.21 (rule 1); and a used, loaded card with no owner is
    // refused 6A8D before anything about a hold, by SET_CARD and SET_LIMIT's PIN form alike (requireNothingOwed comes first)
    const rec = '00' + '00'.repeat(33) + '00'.repeat(65) + '08' + Buffer.from('https://').toString('hex');
    const setCard = 'b0320000' + (rec.length / 2).toString(16).padStart(2, '0') + rec;
    const opened = [];
    for (const v of [21, 22]) { const c = card4(H, v); c.tap(); await c.send(SELECT); opened.push(sw(await c.send(setCard))); }
    ok(opened.join() === '9000,9000', 'SET_CARD on an empty card with no PIN is open on 1.22 as on 1.21', opened.join());
    const used = card4(H, 22);
    used.tap();
    await R.W.cardSetUpFor(used, { pin: '2468' });
    used.tap();
    await R.W.cardPrepare(await R.W.cardLook(used, { short: true }), 500);
    used.tap();
    await R.W.cardWrite(used, { pin: '2468' });
    used.tap();
    await used.send(SELECT);
    await used.send('b0400000' + '04' + hexOf('2468'));
    const lim = sw(await used.send('b0330000' + '08' + u32(1) + u32(1)));
    const rew = sw(await used.send(setCard));
    ok(lim === '6a8d' && rew === '6a8d', 'a used card with money and no owner, PIN given and no hold: 6A8D to the PIN form of the limit and to SET_CARD', lim + ' ' + rew);

    // the wallet: a first payer's set-up cut between the PIN and the record is taken up again, with no owner and no key of this phone's
    const w1 = card4(H, 22);
    w1.tap();
    w1.leaveBefore('32', 1);
    ok((await why(R.W.cardSetUpFor(w1, { pin: '5555', tapLimit: 300, noPin: 40 }))) === 'gone' && w1.state.pinState === 1 && !w1.state.record.set,
       'a first payer’s set-up cut before the record leaves a PIN and no record');
    w1.tap();
    ok((await R.W.cardLook(w1, { short: true })).forHolder === true, 'and this phone notes that it began it');
    w1.tap();
    await R.W.cardSetUpFor(w1, { pin: '5555', tapLimit: 300, noPin: 40 });
    ok(!w1.state.owner && w1.state.record.refund === '00'.repeat(33) && w1.state.tapLimit === 300 && w1.state.noPinLimit === 40 && !ins(w1).includes('43'),
       'the same set-up again finishes it: the record with no refund key, both numbers, and no claim', JSON.stringify([w1.state.tapLimit, w1.state.noPinLimit]));
    w1.tap();
    ok((await R.W.cardLook(w1, { short: true })).forHolder === false && !R.W.cardsKnown()[w1.key], 'and once finished the note is gone, and the phone keeps no row of the card');
    // cut between the record and the numbers: taken up again under the PIN the card has (shown, not set), the numbers written
    const w2 = card4(H, 22);
    w2.tap();
    w2.leaveBefore('33', 1);
    ok((await why(R.W.cardSetUpFor(w2, { pin: '5555', tapLimit: 300, noPin: 40 }))) === 'gone' && w2.state.record.set && w2.state.tapLimit === 0,
       'a first payer’s set-up cut before the holder’s numbers leaves a record and no numbers');
    w2.tap();
    ok((await why(R.W.cardSetUpFor(w2, { pin: '1111', tapLimit: 300, noPin: 40 }))) === 'wrong-pin' && w2.state.tapLimit === 0,
       'taken up again, the PIN the card has is shown first: another PIN is refused and writes nothing');
    w2.tap();
    const before = ins(w2).length;
    await R.W.cardSetUpFor(w2, { pin: '5555', tapLimit: 300, noPin: 40 });
    const tail = ins(w2).slice(before);
    ok(w2.state.tapLimit === 300 && w2.state.noPinLimit === 40 && !w2.state.owner && tail.indexOf('41') < 0 && tail.indexOf('40') >= 0 && tail.indexOf('33') > tail.indexOf('32'),
       'with the holder’s PIN it writes the record and the numbers again, never a new PIN, and no owner', tail.filter((x) => x !== '44').join());
    // a card set up for its holder elsewhere (no note here), or one with money on it, is not set up again
    const elsewhere = card4(H, 22);
    elsewhere.tap();
    await H.W.cardSetUpFor(elsewhere, { pin: '7777' });
    elsewhere.tap();
    ok((await why(R.W.cardSetUpFor(elsewhere, { pin: '7777', tapLimit: 999 }))) === 'has-pin' && elsewhere.state.tapLimit === 0,
       'a card another phone set up for its holder is not set up again here: money goes on it with its PIN');

    // the screens: SEND > FLASHCARD, cut before the holder's numbers, TRY AGAIN writes them and then the money
    // SET AMOUNT for each, at what the wheel stood at: $2.00 without the PIN, $10.00 on one payment
    const wheelSet = (a) => amt(a).type(amt(a).flow === 'cardSuTap' ? '10.00' : '2.00', 'USD').next();
    const payer = appOn(R);
    payer.price = 60000;
    await payer.refreshBalance();
    const u1 = card4(H, 22);
    R.nfc = u1;
    u1.tap();
    payer.fcSendCard();
    keyIn(payer, 1500);
    await until('the set-up pad', () => !!pad(payer));
    pad(payer).type('8642'); pad(payer).type('8642');
    card(payer).press('YES'); wheelSet(payer);
    card(payer).press('YES'); wheelSet(payer);
    u1.tap();
    u1.leaveBefore('33', 1);
    await until('the failure card', () => !!card(payer) && /AGAIN/.test(card(payer).all));
    ok(u1.state.tapLimit === 0 && u1.balance() === 0 && R.W.cardOwed().length === 0, 'cut before the holder’s numbers: nothing set, nothing made');
    u1.tap();
    card(payer).press('TRY AGAIN');
    await until('the money on the card', () => u1.balance() === 1500);
    await settle();
    ok(u1.state.tapLimit === Math.round(10 / 60000 * 1e8) && u1.state.noPinLimit === Math.round(2 / 60000 * 1e8) && !u1.state.owner && !ins(u1).includes('43'),
       'TRY AGAIN takes the set-up up again: the holder’s two numbers are on the card with the money, and still no owner', JSON.stringify([u1.state.tapLimit, u1.state.noPinLimit]));
    if (card(payer)) card(payer).press('DONE');

    // cut before the record and left: this phone's FLASHCARD screen does not offer to set it up as its own
    const u2 = card4(H, 22);
    R.nfc = u2;
    payer.setState({ screen: 'home', stack: [], fc: null });
    u2.tap();
    payer.fcSendCard();
    keyIn(payer, 1500);
    await until('the set-up pad', () => !!pad(payer));
    pad(payer).type('8642'); pad(payer).type('8642');
    card(payer).press('NO'); card(payer).press('NO');
    u2.tap();
    u2.leaveBefore('32', 1);
    await until('the failure card', () => !!card(payer) && /AGAIN/.test(card(payer).all));
    card(payer).press('CANCEL');
    payer.setState({ screen: 'home', stack: [], fc: null });
    u2.tap();
    payer.goFlashcard();
    await until('the cut card read', () => payer.state.fc && payer.state.fc.key === u2.key);
    let v = vals(payer);
    ok(v.fcNew && !v.fcNewSetUp && v.fcNewLine === 'Its set-up for the person who holds it was cut short. Send it money to finish it.',
       'its FLASHCARD screen on the phone that began it: no SET UP CARD, and a line saying to send it money to finish', v.fcNewLine);
    payer.fcSetUp();
    ok(!pad(payer) && card(payer) && /Send it money to finish/.test(card(payer).reason) && !u2.state.owner,
       'and the owner’s set-up is not run on it from there', card(payer) && card(payer).all);
    card(payer).press('CLOSE');
    // a fresh send to it: the set-up's steps again, which finish it for its holder and put the money on
    payer.setState({ screen: 'home', stack: [], fc: null });
    u2.tap();
    payer.fcSendCard();
    keyIn(payer, 1500);
    await until('the set-up pad again', () => !!pad(payer));
    ok(pad(payer).title === 'CREATE A PIN' && R.sheet.some((x) => x === 'end: Finish setting up the card'),
       'a later send to it takes its set-up up again, from CREATE A PIN (the card has no record, so it takes the PIN typed now)', pad(payer).title);
    pad(payer).type('8642'); pad(payer).type('8642');
    card(payer).press('NO'); card(payer).press('NO');
    u2.tap();
    await until('the money on the card', () => u2.balance() === 1500);
    await settle();
    ok(!u2.state.owner && u2.state.record.refund === '00'.repeat(33) && !R.W.cardsKnown()[u2.key], 'finished for its holder: no owner, no refund key, no row on this phone');
    if (card(payer)) card(payer).press('DONE');

    // cut before the numbers and left: a later send asks the holder's PIN once, and writes the numbers before the money
    const u3 = card4(H, 22);
    R.nfc = u3;
    payer.setState({ screen: 'home', stack: [], fc: null });
    u3.tap();
    payer.fcSendCard();
    keyIn(payer, 1500);
    await until('the set-up pad', () => !!pad(payer));
    pad(payer).type('8642'); pad(payer).type('8642');
    card(payer).press('NO');
    card(payer).press('YES'); wheelSet(payer);
    u3.tap();
    u3.leaveBefore('33', 1);
    await until('the failure card', () => !!card(payer) && /AGAIN/.test(card(payer).all));
    card(payer).press('CANCEL');
    payer.setState({ screen: 'home', stack: [], fc: null });
    u3.tap();
    payer.fcSendCard();
    keyIn(payer, 1500);
    await until('the PIN pad', () => !!pad(payer));
    ok(pad(payer).title === 'CARD PIN' && /set-up was cut short/.test(pad(payer).sub), 'a later send to a card cut before its numbers asks the holder’s PIN once', pad(payer).title + ' / ' + pad(payer).sub);
    pad(payer).type('8642');
    card(payer).press('NO');
    card(payer).press('YES'); wheelSet(payer);
    u3.tap();
    await until('the money on the card', () => u3.balance() === 1500);
    await settle();
    ok(u3.state.tapLimit === Math.round(10 / 60000 * 1e8) && !u3.state.owner, 'and the holder’s limit is written with the money', String(u3.state.tapLimit));
    if (card(payer)) card(payer).press('DONE');

    // the card's own log says nothing of a daily limit
    ok(!/daily limit/.test(require('fs').readFileSync(require('path').join(__dirname, '../build/app/26f-flashcard.js'), 'utf8').split('fcLogCard() {')[1].split('\n  }\n')[0]),
       'the card’s own log screen says nothing of a daily limit');
  }

  /* ---- B11: what the owner chose at set-up drives the card's screen (software 1.23) ---------------------------------------
   * BOTH: two pills from the moment set-up ends, each at nothing, ADD FUNDS asking which and SWAP greyed while a side is empty; the read
   * kept for the swipe keeps it so. DOLLARS: one pill, and ADD FUNDS asks nothing. */
  {
    const U = await funded({ units: ['sat', 'usd'] }, 0);
    const twoCard = card4(U, 23);
    twoCard.tap();
    await U.W.cardSetUp(twoCard, { pin: '2468', unit: 'usd', hold: 'both', price: 60000 });
    const oneCard = card4(U, 23);
    oneCard.tap();
    await U.W.cardSetUp(oneCard, { pin: '2468', unit: 'usd', hold: 'usd', price: 60000 });
    const a = appOn(U);
    a.price = 60000;
    a.twoUnitsOn = () => true;
    a.unitBalance = () => 1000;
    const readIt = async (c) => {
      U.nfc = c;
      c.tap();
      a.setState({ screen: 'home', stack: [], fc: null, curCard: null });
      a._fcCard = null;
      a.goFlashcard();
      await until('the card read', () => !!a.state.fc && a.state.fc.key === c.key && !(a._fcTaps > 0));
      await settle();
      return vals(a);
    };
    let v = await readIt(twoCard);
    ok(v.fcPillRows.length === 2 && v.fcPillRows[0].big === '0.00' && v.fcPillRows[1].big === '0',
       'a card set up for both shows two pills at nothing before anything is on it', JSON.stringify(v.fcPillRows.map((x) => x.big)));
    ok((v.fcButtons.find((x) => x.label === 'SWAP') || {}).dim === '0.38', 'and SWAP greyed while a side is empty');
    a.fcAdd();
    ok(a.state.screen === 'currency' && a.state.curCard && a.state.curCard.question === 'ADD WHICH TO THE CARD?', 'and ADD FUNDS asks which', a.state.screen);
    const k = kept(U)[twoCard.key];
    ok(!!k && Array.isArray(k.fc.units) && k.fc.units.length === 2 && k.fc.both === false && k.fc.only === '',
       'the read kept for the swipe keeps both pills and what SWAP needs', JSON.stringify(k && [k.fc.units, k.fc.both, k.fc.only]));
    v = await readIt(oneCard);
    ok(v.fcPillRows.length === 1 && v.fcPillRows[0].big === '0.00', 'a card set up for dollars shows one pill', JSON.stringify(v.fcPillRows.map((x) => x.big)));
    a.fcAdd();
    ok(a.state.screen === 'amount' && a.state.flow === 'cardAdd' && !a.state.curCard && a.fcUnit() === 'usd', 'and ADD FUNDS asks no currency', a.state.screen);
  }

  console.log('\n' + (failed || until.failed ? (failed + until.failed) + ' flashcard-holder check(s) failed' : 'all flashcard-holder checks pass'));
  process.exit(failed || until.failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
