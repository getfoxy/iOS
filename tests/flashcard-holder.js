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
 *                       own; VIEW AS GUEST and TIE OWNERSHIP TO THIS PHONE; RESTORE LOST CARD; CARD at the top left of home
 *                       and HOME at the top left of the card's screen, and a swipe that does the same with nothing drawn for it,
 *                       HISTORY first in each MENU, a tap asked for every time;
 *                       and no daily limit anywhere on the card's screen.
 *
 * And the set-up's two amounts in the card's own money, on SET AMOUNT: a dollar card's in dollars only, a bitcoin card's in dollars
 * first with the screen's swap to sats, the card sent cents or sats as before. No card of 1.21 or 1.22 in this suite makes change: every payment here is of
 * exact pieces (the change these cards make for themselves, mended or given up, is tests/flashcard-mend.js). */
const { funded, newCard, why, OTHER_WORDS } = require('./flashcard-kit');
const { appOn, until, pad, card, vals, settle, keyIn, welcome, limits, speed, named } = require('./flashcard-ui-kit');

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
const keptFor = (ctx, key) => ['foxy.flashcard.receipts', 'foxy.flashcard.logseen'].some((k) => {
  try { return !!(JSON.parse(ctx.storage.getItem(k) || '{}') || {})[key]; } catch (e) { return true; }
});

/* SET AMOUNT, while the set-up asks one of its two amounts (26j-card-wheel.js, `fcSuAmount`): which, the unit on the screen, the unit
 * the card takes, what is typed, and the line under it; `type(figure, unit)` puts a figure on it as the keypad would ('USD' a dollar
 * string, 'SATS' whole sats; the swap is the screen's own, so the unit is said), `next()` is NEXT, `skip()` SKIP under it (23-render-home-and-amount.js,
 * `amtAltTap`: `fcSuSkip`) and `back()` the round back button. */
function amt(a) {
  const s = a.state;
  if (s.screen !== 'amount' || !/^cardSu(NoPin|Tap)$/.test(String(s.flow))) return null;
  return {
    flow: s.flow, unit: s.unit, cardUnit: a.fcTypedUnit(), amount: s.amount, line: a.fcSuAmountLine(),
    type(fig, unit) { a.setState({ amount: String(fig), unit: unit || s.unit }); return amt(a); },
    next() { a.fcAmountNext(); },
    skip() { a.fcSuSkip(); },
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
    ok(v.fcNew && v.fcNewLine === 'Welcome to Foxy Card. Set it up to put money on it.' && typeof v.fcSetUp === 'function' && !('fcRestore' in v) && !v.fcGuest,
       'a new card is welcomed, with SET UP CARD and no RESTORE LOST CARD (that is home’s MENU’s)', v.fcNewLine);
    ok(welcome(holder) && welcome(holder).buttons === 'SET UP CARD,CANCEL' && welcome(holder).line === '' && welcome(holder).design === 'FL1',
       'it lands on WELCOME TO YOUR CASHU CARD, over the card’s screen: the card’s picture, SET UP CARD and CANCEL', JSON.stringify(welcome(holder)));
    welcome(holder).press('SET UP CARD');
    let nm = named(holder);
    ok(nm && !pad(holder) && holder.state.screen === 'fcName' && nm.title === 'NAME CARD' && nm.draft === '' && nm.grey && nm.skipShown && nm.mode === 'su'
       && holder.state.stack.slice(-1)[0] === 'flashcard',
       'SET UP CARD asks NAME CARD first, over the card’s screen: the field empty, NEXT grey, SKIP under it', JSON.stringify(nm));
    nm.next();
    ok(named(holder) && holder.toasts.slice(-1)[0] === 'Type a name first.' && !pad(holder), 'NEXT with nothing typed is refused', holder.toasts.slice(-1)[0]);
    nm = named(holder).type('   ');
    ok(nm.grey, 'and spaces alone are no name: NEXT stays grey');
    nm = named(holder).type('Lunch card');
    ok(nm.draft === 'Lunch card' && !nm.grey, 'a name typed lights NEXT', JSON.stringify(nm));
    nm.back();
    ok(!named(holder) && !pad(holder) && holder.state.screen === 'flashcard' && welcome(holder) && !holder._fcSu, 'its round back button is the welcome again, nothing asked', holder.state.screen);
    welcome(holder).press('SET UP CARD');
    ok(named(holder) && named(holder).draft === '', 'SET UP CARD again: NAME CARD empty');
    named(holder).type('Lunch card').next();
    ok(pad(holder) && pad(holder).title === 'CREATE A PIN' && pad(holder).sub === 'Four to eight digits. The card asks for it when it pays.' && !pad(holder).hasCancel && !named(holder),
       'NEXT with a name asks CREATE A PIN, on the card PIN pad, with the way out at the top', pad(holder) && pad(holder).title);
    pad(holder).back();
    ok(!pad(holder) && named(holder) && named(holder).draft === 'Lunch card' && holder.state.stack.slice(-1)[0] === 'flashcard',
       'the PIN pad’s round back button is NAME CARD again, with the name as it was typed', JSON.stringify(named(holder)));
    named(holder).next();
    pad(holder).type('2580');
    ok(pad(holder).title === 'RE-ENTER PIN', 'then RE-ENTER PIN');
    pad(holder).type('2581');
    ok(pad(holder).title === 'CREATE A PIN' && /did not match/.test(pad(holder).note), 'two that differ start it again', pad(holder).note);
    pad(holder).type('2580');
    pad(holder).type('2580');
    let s = amt(holder);
    ok(s && !card(holder) && s.flow === 'cardSuNoPin' && s.unit === 'USD' && s.amount === '' && s.cardUnit === 'sat' && holder.state.stack.slice(-1)[0] === 'flashcard' && s.line === '',
       'at a mint with one balance, no currency is asked, and no question either: SET AMOUNT for the no-PIN amount straight away, as LIMITS opens it: empty, in dollars first, for a card that holds sats, and no seconds line', JSON.stringify(s));
    s.back();
    ok(!amt(holder) && !card(holder) && !holder._fcSu && holder.state.screen === 'flashcard' && welcome(holder) && c.state.pin !== hexOf('2580') && !c.state.owner,
       'its round back button leaves the set-up, to the card’s screen and its welcome as they were, nothing written', JSON.stringify([holder.state.screen, holder.state.stack]));
    welcome(holder).press('SET UP CARD');
    // (a name longer than the cap is cut as it is typed, and kept trimmed)
    nm = named(holder).type('  The card in the blue wallet, upstairs');
    ok(Array.from(nm.draft).length === 24 && nm.draft === '  The card in the blue w', 'a name is cut at 24 characters as it is typed', JSON.stringify(nm.draft));
    named(holder).type('  Lunch card ').next();
    pad(holder).type('2580');
    pad(holder).type('2580');
    amt(holder).next();
    ok(amt(holder) && holder.toasts.slice(-1)[0] === 'Type an amount first.', 'NEXT with nothing typed is refused, as on LIMITS', holder.toasts.slice(-1)[0]);
    amt(holder).type('5.00').next();
    let sp = speed(holder);
    ok(!amt(holder) && !card(holder) && sp && sp.mode === 'su' && sp.figure === '5' && sp.chosen === '$5' && sp.chips === '$1,$2,$5,$10,$25,$50' && sp.alt === 'SKIP' && holder.state.stack.slice(-1)[0] === 'flashcard',
       'NEXT carries it on to MAX SPEND PER SECOND, no question first: $5 a second chosen, of $1 $2 $5 $10 $25 $50, SKIP under NEXT', JSON.stringify(sp));
    sp.back();
    s = amt(holder);
    ok(!speed(holder) && s && s.flow === 'cardSuNoPin' && s.amount === '' && holder.state.stack.slice(-1)[0] === 'flashcard' && holder._fcSu,
       'its round back button is NO PIN AMOUNT? again, over the card’s screen', JSON.stringify(s));
    amt(holder).type('5.00').next();
    sp = speed(holder);
    ok(sp.pick(25).figure === '25' && speed(holder).chosen === '$25' && sp.pick(5).chosen === '$5', 'a chip pressed is the figure, and the chip that is orange');
    speed(holder).other();
    s = amt(holder);
    ok(s && s.flow === 'cardSuTap' && s.unit === 'USD' && s.amount === '' && s.line === '' && holder.state.stack.slice(-1)[0] === 'fcSpeed',
       'the figure opens SET AMOUNT for another rate, empty, with no line before a figure', JSON.stringify(s));
    ok(amt(holder).type('10.00').line === 'It will take 13 seconds to pay $120.00.', 'typed, the line under it says the seconds a payment of four limits waits, a limit being three seconds of the rate', amt(holder).line);
    ok(amt(holder).type('20.00').line === 'It will take 13 seconds to pay $240.00.', 'and follows the figure as it is typed', amt(holder).line);
    amt(holder).back();
    sp = speed(holder);
    ok(!amt(holder) && sp && sp.mode === 'su' && sp.chosen === '$5' && holder.state.stack.slice(-1)[0] === 'flashcard' && holder.state.flow !== 'cardSuTap',
       'its round back button is MAX SPEND PER SECOND again, where it came from, at the rate it showed', JSON.stringify([sp, holder.state.stack]));
    speed(holder).back();
    ok(amt(holder) && amt(holder).flow === 'cardSuNoPin', 'and MAX SPEND PER SECOND’s is NO PIN AMOUNT? again');
    amt(holder).type('5.00').next();
    c.tap();
    H.sheet.length = 0;
    speed(holder).next();
    await until('the card to be set up', () => !!c.state.owner && holder.state.fc && holder.state.fc.ownedHere === true);
    ok(c.state.pin === hexOf('2580') && c.state.noPinLimit === Math.round(5 / 60000 * 1e8) && c.state.tapLimit === Math.round(15 / 60000 * 1e8) && c.state.record.limit === 0,
       'one tap wrote the PIN, the no-PIN amount and the limit on one payment in sats at the price ($5 a second: $15), and no daily limit', JSON.stringify([c.state.noPinLimit, c.state.tapLimit]));
    ok(H.sheet.filter((x) => x === 'say: Keep holding.').length >= 6 && holder.toasts.indexOf('The card is set up.') >= 0,
       'the sheet said Keep holding at every asking of the claim, and the screen said it is set up', String(H.sheet.filter((x) => x === 'say: Keep holding.').length));
    v = vals(holder);
    ok(v.fcUsable && !v.fcGuest && v.fcLimitLine === 'PER SECOND LIMIT $5' && !welcome(holder) && v.fcNoPinShown === undefined && /^No PIN up to \$5\.00 · \$[\d,.]+ left$/.test(limitsSub(v)) && v.fcDayShown === undefined,
       'its screen: the limit as a rate on its face, the no PIN limit and what is left of it under LIMITS in its menu, nothing of a day, and no welcome', [v.fcLimitLine, limitsSub(v)].join(' | '));
    ok(menuOf(v) === 'HISTORY,RENAME CARD,LIMITS,CHANGE PIN,RESET' && v.fcMenuShown === true && v.fcCloseShown === false,
       'the MENU at the top right, in place of the close button, holds HISTORY, RENAME CARD, LIMITS, CHANGE PIN and RESET, in that order: no RESTORE, a card being read is not lost', menuOf(v));
    ok(H.W.cardName(c.key) === 'Lunch card' && H.W.cardsKnown()[c.key].name === 'Lunch card' && v.fcTitle === 'Lunch card' && v.fcVerifiedShown === true,
       'the name typed on NAME CARD is kept on the card’s row on this phone, trimmed, once the card is set up, and is the card screen’s title, with the Verified line under it', JSON.stringify([H.W.cardName(c.key), v.fcTitle, v.fcVerified]));
    ok(c.state.record && !JSON.stringify(c.state).includes('Lunch'), 'the card itself is told nothing of it');
    // RENAME CARD: the same screen, the name filled in; NEXT keeps the new one, back leaves it as it was
    holder.setState({ open0: true });
    vals(holder).fcMenuItems.filter((k) => k.label === 'RENAME CARD')[0].tap();
    let rn = named(holder);
    ok(rn && rn.title === 'RENAME CARD' && rn.draft === 'Lunch card' && !rn.grey && !rn.skipShown && rn.mode === 'rename' && !holder.state.open0 && holder.state.stack.slice(-1)[0] === 'flashcard',
       'RENAME CARD in the menu opens the same screen, titled RENAME CARD, with the name filled in and no SKIP', JSON.stringify(rn));
    rn.type('Coffee').back();
    ok(!named(holder) && holder.state.screen === 'flashcard' && H.W.cardName(c.key) === 'Lunch card', 'back leaves it as it was', H.W.cardName(c.key));
    holder.fcRename();
    named(holder).type('Coffee card').next();
    ok(!named(holder) && holder.state.screen === 'flashcard' && H.W.cardName(c.key) === 'Coffee card' && vals(holder).fcTitle === 'Coffee card',
       'NEXT keeps the new name, and the card’s screen is titled with it', vals(holder).fcTitle);
    v = vals(holder);
    ok(v.fcMenuItems.every((k) => typeof k.tap === 'function' && /^M/.test(k.path)) && v.fcMenuItems.filter((k) => k.label !== 'LIMITS').every((k) => k.sub === ''),
       'each row a tap with its own drawing, and only LIMITS has a line under it');
    // (MENU is home's own button, `toggleMenu`, which turns `open0`)
    ok(v.fcMenuOpen === false && (holder.setState({ open0: true }), vals(holder).fcMenuOpen === true) && (holder.setState({ open0: false }), vals(holder).fcMenuOpen === false),
       'MENU opens the drawer, as home’s does, and closes it');
    ok(v.fcRowShown === true && v.fcButtons.map((k) => k.label).join() === 'SCAN,PASTE' && v.fcButtons.every((k) => typeof k.tap === 'function' && /^M/.test(k.path)),
       'the bottom row is home’s with one pill: SCAN and PASTE, no SWAP on a card of one currency', v.fcButtons.map((k) => k.label + ' ' + k.dim).join(', '));
    ok(v.fcLinks === undefined && v.fcNoPinLine === undefined && v.fcBlockLine === undefined, 'and the old row, the no-PIN line and the block line are gone from the screen');

    // SKIP and SKIP: nothing set, no limit sent
    const n = card4(H, 21);
    H.nfc = n;
    n.tap();
    holder.fcRead();
    await until('the second card to be read', () => holder.state.fc && holder.state.fc.key === n.key);
    holder.fcSetUp();
    pad(holder).type('1357');
    pad(holder).type('1357');
    amt(holder).skip();
    ok(!amt(holder) && speed(holder) && speed(holder).mode === 'su' && holder._fcSu && holder._fcSu.noPin === 0 && holder._fcSu.noPinUsd === 0,
       'SKIP on NO PIN AMOUNT?: no allowance, and on to MAX SPEND PER SECOND', JSON.stringify(holder._fcSu && [holder._fcSu.noPin, holder._fcSu.noPinUsd]));
    speed(holder).skip();
    await until('the 1.21 card to be set up', () => !!n.state.owner && holder.state.fc && holder.state.fc.key === n.key && holder.state.fc.ownedHere === true);
    ok(n.state.tapLimit === 0 && n.state.noPinLimit === 0 && ins(n).indexOf('33') < 0 && vals(holder).fcLimitLine === 'NO LIMIT',
       'SKIP and SKIP: a card of 1.21 set up in one tap with no limits, and none sent', vals(holder).fcLimitLine);

    // the daily limit (C15): a card with one shows nothing of it, and LIMITS offers none
    n.tap();
    await H.W.cardSetLimit(n, { sats: 900 });
    n.tap();
    holder.fcRead();
    await until('the card with a daily limit', () => holder.state.fc && holder.state.fc.limit === 900);
    v = vals(holder);
    ok(v.fcLimitLine === '' && v.fcLimitShown === false && v.fcDayLeft === undefined, 'a card with a daily limit says nothing of it on its face', JSON.stringify(v.fcLimitLine));
    holder.fcSetLimit();
    ok(limits(holder) && !card(holder) && holder.state.screen === 'fcLimits' && limits(holder).rows.join(' / ') === ['PER SECOND LIMIT | How fast the card can pay | NO LIMIT | ', 'NO PIN LIMIT | Most it pays without a PIN | NONE | '].join(' / '),
       'LIMITS opens CARD LIMITS: the per second limit and the no PIN limit, each with what it is now, and no daily limit', limits(holder) && limits(holder).rows.join(' / '));
    // the no-PIN keypad of a card of 1.21 and on asks of the PIN, not of a day
    holder._fcLimitNoPin = true;
    ok(holder.fcLimitQuestion() === 'What is the most this card should pay by tap alone before it asks for its PIN?',
       'the no-PIN keypad of a card of 1.21 and on asks nothing of a day', holder.fcLimitQuestion());
    holder._fcLimitNoPin = false;
    limits(holder).press('NO PIN LIMIT');
    ok(!limits(holder) && holder.state.screen === 'flashcard' && card(holder) && card(holder).title === 'SET NO PIN LIMIT', 'NO PIN LIMIT opens its own steps from the card’s screen', card(holder) && card(holder).title);
    card(holder).press('CANCEL');
    holder.fcSetLimit();
    limits(holder).press('CLOSE');
    ok(!limits(holder) && holder.state.screen === 'flashcard' && !card(holder), 'CLOSE is the card’s screen again');

    // B9 from home's MENU (RESTORE LOST CARD, `fcRestoreLost`): the list of CARDS YOU LOADED, and this card's row says when it can be taken back
    ok(typeof holder.fcRestoreThis === 'undefined', 'the card’s screen has no restore of its own');
    holder.fcRestoreLost();
    const lostRow = (vals(holder).fcRows || []).length ? H.W.cardsList().filter((r) => r.key === n.key)[0] : null;
    ok(!holder.state.fc && holder.state.screen === 'flashcard' && !!lostRow, 'RESTORE LOST CARD opens CARDS YOU LOADED, with this card in it', String((vals(holder).fcRows || []).length));
    holder.fcRowCard(lostRow);
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
    ok(amt(a).unit === 'USD' && amt(a).cardUnit === 'sat', 'a bitcoin card’s SET AMOUNT opens in dollars, for sats', JSON.stringify(amt(a)));
    amt(a).type('2000', 'SATS').next();
    speed(a).other();
    ok(amt(a).flow === 'cardSuTap' && amt(a).type('10000', 'SATS').line === 'It will take 13 seconds to pay ₿ 120,000.', 'another rate, swapped to sats: the seconds line is in sats', amt(a).line);
    ok(amt(a).type('20000', 'SATS').line === 'It will take 13 seconds to pay ₿ 240,000.', 'and follows the figure in sats', amt(a).line);
    ok(amt(a).type('10.00', 'USD').line === 'It will take 13 seconds to pay $120.00.', 'swapped back, the line is in dollars', amt(a).line);
    amt(a).type('50000', 'SATS').next();
    ok(chose && chose.noPin === 2000 && chose.noPinUsd === 0 && chose.tapLimit === 150000 && chose.tapUsd === 0 && a.state.screen === 'flashcard',
       'what the card is sent is three seconds of the sats typed a second, and no dollars are kept for figures typed in sats', JSON.stringify(chose));
    // typed in dollars, a bitcoin card is sent their sats, and the dollars are kept, as LIMITS keeps them
    chose = null;
    a.fcSetUpSteps({ unit: 'sat', run: (c) => { chose = c; } });
    pad(a).type('2580'); pad(a).type('2580');
    amt(a).type('2.00').next();
    speed(a).pick(10).next();
    ok(chose && chose.noPin === Math.round(2 / 60000 * 1e8) && chose.noPinUsd === 2 && chose.tapLimit === Math.round(30 / 60000 * 1e8) && chose.tapUsd === 30 && a.state.screen === 'flashcard',
       'in dollars: their sats at the price, and the dollars kept; $10 a second is a limit of $30', JSON.stringify(chose));
    // a dollar card: dollars and nothing else, price or not
    chose = null;
    a.fcSetUpSteps({ unit: 'usd', run: (c) => { chose = c; } });
    pad(a).type('2580'); pad(a).type('2580');
    ok(amt(a).unit === 'USD' && amt(a).cardUnit === 'usd', 'a dollar card’s SET AMOUNT is in dollars, for cents', JSON.stringify(amt(a)));
    amt(a).type('2.00').next();
    ok(speed(a) && speed(a).chosen === '$5', 'its rate on MAX SPEND PER SECOND, in dollars');
    speed(a).other();
    ok(amt(a).type('10.00').line === 'It will take 13 seconds to pay $120.00.', 'another rate too, its seconds line in dollars', amt(a).line);
    amt(a).next();
    ok(chose && chose.noPin === 200 && chose.tapLimit === 3000 && chose.noPinUsd === 0 && chose.tapUsd === 0, 'and the card is sent cents, three seconds of the rate', JSON.stringify(chose));
    chose = null;
    a.fcSetUpSteps({ unit: 'usd', run: (c) => { chose = c; } });
    pad(a).type('2580'); pad(a).type('2580');
    amt(a).skip();
    speed(a).next();
    ok(chose && chose.noPin === 0 && chose.tapLimit === 1500 && chose.tapUsd === 0, 'NEXT on $5 a second: a limit of $15.00, in cents', JSON.stringify(chose));
    a.price = 0;
    a.fcSetUpSteps({ unit: 'usd', run: () => {} });
    pad(a).type('2580'); pad(a).type('2580');
    ok(amt(a).unit === 'USD' && amt(a).cardUnit === 'usd', 'with no Bitcoin price a dollar card is still in dollars, never sats', JSON.stringify(amt(a)));
    amt(a).back();
    ok(!amt(a) && !a._fcSu && a.state.screen === 'flashcard', 'its round back button leaves the set-up');
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
    chose = null;
    a.fcSetUpSteps({ unit: 'sat', run: (c) => { chose = c; } });
    pad(a).type('2580'); pad(a).type('2580');
    ok(amt(a).unit === 'SATS' && amt(a).cardUnit === 'sat', 'a bitcoin card with no price: SET AMOUNT in sats', JSON.stringify(amt(a)));
    amt(a).type('500', 'SATS').next();
    ok(!speed(a) && amt(a) && amt(a).flow === 'cardSuTap' && amt(a).amount === '' && a.state.stack.slice(-1)[0] === 'flashcard',
       'its rate cannot be said in dollars: typed on SET AMOUNT, over the card’s screen, with no MAX SPEND PER SECOND', JSON.stringify([a.state.screen, a.state.stack]));
    amt(a).back();
    ok(amt(a) && amt(a).flow === 'cardSuNoPin' && amt(a).amount === '' && a.state.stack.slice(-1)[0] === 'flashcard' && a._fcSu,
       'the rate typed with no MAX SPEND PER SECOND behind it: its round back button is NO PIN AMOUNT? again', JSON.stringify([a.state.screen, a.state.flow]));
    amt(a).type('500', 'SATS').next();
    amt(a).type('900', 'SATS').skip();
    ok(chose && chose.noPin === 500 && chose.tapLimit === 0 && chose.tapUsd === 0 && !a._fcSu && a.state.screen === 'flashcard' && !amt(a),
       'SKIP on the rate typed: no limit on a payment, the figure typed and not taken, and on to the tap; the no-PIN amount kept', JSON.stringify(chose));
    // and SKIP on the rate typed from MAX SPEND PER SECOND, at a price
    a.price = 60000;
    chose = null;
    a.fcSetUpSteps({ unit: 'sat', run: (c) => { chose = c; } });
    pad(a).type('2580'); pad(a).type('2580');
    amt(a).type('3.00').next();
    speed(a).other();
    amt(a).type('7.00').skip();
    ok(chose && chose.noPin === Math.round(3 / 60000 * 1e8) && chose.noPinUsd === 3 && chose.tapLimit === 0 && chose.tapUsd === 0 && a.state.screen === 'flashcard' && !speed(a) && !amt(a),
       'SKIP on the rate typed from MAX SPEND PER SECOND: no limit either, and the card’s screen as it was', JSON.stringify([chose, a.state.screen]));
    // SKIP on MAX SPEND PER SECOND itself, with an allowance typed: the allowance, and no limit
    chose = null;
    a.fcSetUpSteps({ unit: 'usd', run: (c) => { chose = c; } });
    pad(a).type('2580'); pad(a).type('2580');
    amt(a).type('4.00').next();
    speed(a).pick(25).skip();
    ok(chose && chose.noPin === 400 && chose.tapLimit === 0 && chose.tapUsd === 0 && a.state.screen === 'flashcard' && !speed(a),
       'SKIP on MAX SPEND PER SECOND: no limit, the chip chosen not taken, and the no-PIN amount kept', JSON.stringify(chose));
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
    await until('the welcome', () => !!welcome(payer));
    ok(payer.state.screen === 'fcWelcome' && welcome(payer).buttons === 'SET UP CARD,CANCEL' && !pad(payer)
       && welcome(payer).line === 'Set it up for the person who holds it. The money goes on in the same tap.',
       'a new card held to the phone lands on WELCOME TO YOUR CASHU CARD, a screen of its own over SEND’s keypad, saying whose it will be', JSON.stringify(welcome(payer)));
    welcome(payer).press('CANCEL');
    ok(!welcome(payer) && payer.state.screen === 'amount' && payer.state.flow === 'cardSend' && payer.state.amount === '1500', 'CANCEL is SEND’s keypad again, as it was');
    cash.tap();
    keyIn(payer, 1500);
    await until('the welcome again', () => !!welcome(payer));
    welcome(payer).press('SET UP CARD');
    ok(named(payer) && named(payer).title === 'NAME CARD' && named(payer).skipShown && payer.state.stack.slice(-1)[0] === 'fcWelcome' && !pad(payer),
       'a card set up for its holder from SEND > FLASHCARD is asked NAME CARD first too, over the welcome', JSON.stringify(payer.state.stack));
    named(payer).back();
    ok(!named(payer) && payer.state.screen === 'fcWelcome' && welcome(payer), 'whose back button is the welcome again');
    welcome(payer).press('SET UP CARD');
    named(payer).type('Mum').next();
    ok(pad(payer) && pad(payer).title === 'CREATE A PIN' && /The person who holds it types the PIN they want/.test(pad(payer).sub) && /not this phone’s/.test(pad(payer).sub) && R.W.cardOwed().length === 0,
       'a new card held to the phone: nothing is made for it, and the set-up begins with CREATE A PIN, saying whose PIN it is', pad(payer).sub);
    ok(R.sheet.some((x) => x === 'end: Set up the card first'), 'the sheet ended calmly, saying the card is to be set up first', R.sheet.slice(-1)[0]);
    pad(payer).type('8642');
    ok(pad(payer).title === 'RE-ENTER PIN' && pad(payer).sub === 'The person who holds the card types the same PIN again.', 'RE-ENTER PIN, in the same words', pad(payer).sub);
    pad(payer).type('8642');
    ok(!card(payer) && amt(payer) && amt(payer).flow === 'cardSuNoPin' && payer.state.stack.slice(-1)[0] === 'fcWelcome', 'then the same two amounts: NO PIN AMOUNT? on SET AMOUNT, over the welcome', JSON.stringify(payer.state.stack));
    amt(payer).back();
    ok(!amt(payer) && !payer._fcSu && payer.state.screen === 'fcWelcome' && welcome(payer) && payer.state.flow === 'cardSend' && payer.state.amount === '1500' && payer.state.unit === 'SATS' && cash.state.pinState === 0,
       'its round back button leaves the set-up for the welcome, SEND’s figure kept as it was, nothing written', JSON.stringify([payer.state.screen, payer.state.flow, payer.state.amount]));
    welcome(payer).press('SET UP CARD');
    named(payer).type('Mum').next();
    pad(payer).type('8642'); pad(payer).type('8642');
    amt(payer).type('2.00').next();
    ok(speed(payer) && speed(payer).mode === 'su' && payer.state.stack.slice(-1)[0] === 'fcWelcome', 'NEXT is MAX SPEND PER SECOND, over the welcome', JSON.stringify(payer.state.stack));
    cash.tap();
    speed(payer).skip();
    ok(payer.state.flow === 'cardSend' && payer.state.amount === '1500' && payer.state.unit === 'SATS',
       'SKIP puts SEND’s figure back as it was, and goes on to the tap', JSON.stringify([payer.state.screen, payer.state.flow, payer.state.amount]));
    await until('the money to be on the card', () => cash.balance() === 1500 && payer.state.screen === 'paid');
    ok(!cash.state.owner && cash.state.record.refund === '00'.repeat(33) && cash.state.pin === hexOf('8642') && cash.state.noPinLimit === Math.round(2 / 60000 * 1e8) && cash.state.tapLimit === 0,
       'one tap: the holder’s PIN, no owner, no refund key, a no-PIN amount of $2.00, and the 1,500 under the PIN', JSON.stringify([cash.state.noPinLimit, cash.balance()]));
    ok(!ins(cash).includes('43') && !R.W.cardsKnown()[cash.key] && payer.toasts.indexOf('The card is set up for the person who holds it.') >= 0,
       'no claim was asked for, the phone keeps no row of it, and the screen says whose card it is', payer.toasts.slice(-2).join(' / '));
    // (the app's success screen, ON THE CARD, as every load that ends at Home: the owner's rule)
    ok(payer.state.screen === 'paid' && payer.state.paidSays === 'ON THE CARD' && payer.state.paidAmount === 1500, 'and what went on, on the success screen as any money put on a card is said', JSON.stringify([payer.state.screen, payer.state.paidSays, payer.state.paidAmount]));
    payer.setState({ screen: 'home', stack: [] }); if (payer.paidDismissed) payer.paidDismissed(); await new Promise((ok2) => setTimeout(ok2, 100));
    // read on the same phone's FLASHCARD screen: somebody else's card
    cash.tap();
    payer.goFlashcard();
    await until('the cash card to be read', () => payer.state.fc && payer.state.fc.key === cash.key);
    const v = vals(payer);
    ok(payer.state.fc.ownedHere === false && payer.state.fc.mine === false && v.fcGuest && !v.fcUsable && v.fcBalance === '₿ 1,500'
       && v.fcGuestLine === 'This card belongs to whoever holds it. It is not tied to any phone.',
       'and read on that phone it is not its own: its balance, and VIEW AS GUEST and TIE OWNERSHIP TO THIS PHONE, and nothing to move its money', v.fcBalance);
    ok(R.W.cardName(cash.key) === 'Mum' && !R.W.cardsKnown()[cash.key] && v.fcTitle === 'Mum' && !(v.fcMenuItems || []).some((k) => k.label === 'RENAME CARD'),
       'the name typed for the holder’s card is kept on this phone with no row of the card made for it, and titles its screen; it has no RENAME CARD, not being this phone’s', JSON.stringify([R.W.cardName(cash.key), v.fcTitle, menuOf(v)]));
    ok(!(v.fcMenuItems || []).some((k) => /RESTORE/.test(k.label)), 'and no RESTORE in its menu: a card being read is not lost', menuOf(v));
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
    ok(friend.state.fc.guestRead && v.fcBalance === '₿ 1,500' && !/NO PIN UP TO/.test(v.fcLimitLine || '') && !v.fcLimitShown, 'and the screen shows the balance with it, and nothing of the no-PIN limit on the card’s face', v.fcLimitLine);
    ok(!keptFor(G, cash.key), 'nothing of the history is kept on the friend’s phone');
    ok(G.storage.getItem('foxy.flashcard.reads') === null, 'and no read of the card is kept anywhere: a guest’s read is kept nowhere');
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

  /* ---- B9: RESTORE LOST CARD from home's MENU -------------------------------------------------------------------------- */
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

    /* RESTORE before the card's date (the owner's word): its row offers RESTORE, which is written down and nothing else; the row
     * then says when it unlocks, and opens CANCEL RESTORE, which forgets it. The pending row in home's history is history-notes §7;
     * the take-back on the date, tests/flashcard-takeback.js. */
    const lc = newCard(H);
    await H.W.cardSetUp(lc, { pin: '1234', recoverable: true });
    lc.tap();
    await H.W.cardAdd(lc, { sats: 1024, pin: '1234' });
    const held = H.W.cardsList().filter((r) => r.key === lc.key)[0];
    const b0 = await H.W.balanceSats();
    holderApp.fcRowCard(held);
    ok(card(holderApp) && card(holderApp).has('RESTORE') && /RESTORE brings it back to this phone then, by itself\./.test(card(holderApp).reason),
       'a card’s row before its date offers RESTORE', card(holderApp) && card(holderApp).all);
    card(holderApp).press('RESTORE');
    await settle();
    const asked = H.W.cardRestores().filter((r) => r.key === held.key)[0];
    ok(!!asked && card(holderApp) && card(holderApp).title === 'RESTORING'
       && card(holderApp).reason === holderApp.fcPrice(held.amount, held.unit) + ' from ' + holderApp.fcName(held.key) + ' comes back to this phone on '
         + holderApp.fcDay(held.date) + '. Until then it is in your history as pending, and not in your balance.',
       'RESTORE writes the restore down and says when the money comes back, and that it is in no balance till then', card(holderApp) && card(holderApp).all);
    ok((await H.W.balanceSats()) === b0, 'and the balance is as it was', String((await H.W.balanceSats()) - b0));
    card(holderApp).press('DONE');
    const listed = (vals(holderApp).fcRows || []).filter((r) => r.name === holderApp.fcName(held.key))[0] || {};
    ok(/^UNLOCKS IN \d+D$/.test(listed.text || ''), 'its row in CARDS YOU LOADED says when it unlocks', listed.text);
    holderApp.fcRowCard(H.W.cardsList().filter((r) => r.key === held.key)[0]);
    ok(card(holderApp) && card(holderApp).title === 'RESTORING' && card(holderApp).has('CANCEL RESTORE') && /It is not in your balance until then\./.test(card(holderApp).reason),
       'opened again, the row is the restore waiting, with CANCEL RESTORE', card(holderApp) && card(holderApp).all);
    card(holderApp).press('CANCEL RESTORE');
    const after = H.W.cardsList().filter((r) => r.key === held.key)[0];
    ok(!H.W.cardRestores().some((r) => r.key === held.key) && after.amount === held.amount && after.date === held.date && !after.takenBack
       && holderApp.toasts.slice(-1)[0] === 'The restore is cancelled.' && !card(holderApp),
       'CANCEL RESTORE forgets the restore, and nothing else changes', JSON.stringify(after));
  }

  /* ---- B10: CARD at the top left of home, HOME at the top left of the card's screen, the swipe for each, HISTORY in each MENU, a tap asked for -- */
  {
    const CLOCK = 'M12 7v5l3.5 2M12 3.5a8.5 8.5 0 1 0 8.5 8.5A8.5 8.5 0 0 0 12 3.5Z';
    // a phone with no card: CARD is there all the same, and opens the card's screen asking for a card, as MENU > FLASHCARD did
    const fresh = await funded({ sharedMint: H.mint, words: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong' }, 0);
    const a = appOn(fresh);
    // (home's CARD button and its MENU's HISTORY are pinned on the mounted app: tests/home-shield.js; CARD is `goFlashcard`)
    let v = vals(a);
    ok(!('pageTabs' in v) && !('pageTabsShown' in v), 'home has no HOME | CARD pill');
    const blank = card4(fresh, 22);
    fresh.nfc = blank;
    fresh.sheet.length = 0;
    blank.tap();
    a.goFlashcard();
    ok(a.state.screen === 'flashcard' && fresh.sheet.some((x) => /^begin: /.test(x)), 'CARD asks for a card to be tapped, on the card’s screen', fresh.sheet.join(' / '));
    await until('the new card to be read', () => a.state.fc && a.state.fc.key === blank.key && !(a._fcTaps > 0));
    ok(vals(a).fcNew && vals(a).fcNewSetUp, 'and a new card tapped shows its set-up, as MENU > FLASHCARD did');
    ok(typeof vals(a).fcHome === 'function' && vals(a).fcMenuItems.length === 0, 'the card’s screen has HOME at the top left; a new card has no menu');
    vals(a).fcHome();
    ok(a.state.screen === 'home' && !a.state.fc && a.state.stack.length === 0, 'HOME is home again');

    // a card this phone owns, with money on it
    const b = appOn(H);
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
    H.sheet.length = 0;
    b.goFlashcard();
    ok(b.state.screen === 'flashcard' && !b.state.fc && H.sheet.some((x) => /^begin: /.test(x)), 'CARD asks for the tap: nothing of the card is shown before it is read');
    await until('the owned card read', () => b.state.fc && b.state.fc.key === own.key && b.state.fc.balance === 700);
    v = vals(b);
    ok(v.fcBalance === '₿ 700' && !('fcMemoShown' in v) && !('fcMemoLine' in v) && !('fcCardTap' in v), 'the card as read, with no “As read” line and no picture to press', v.fcBalance);
    ok(H.storage.getItem('foxy.flashcard.reads') === null, 'and no read of the card is kept on the phone');
    ok(/^HISTORY,(RENAME CARD,)?LIMITS,CHANGE PIN/.test(menuOf(v)) && v.fcMenuItems[0].path === CLOCK, 'the card’s MENU starts with HISTORY, the clock', menuOf(v));
    b.setState({ open0: true });
    vals(b).fcMenuItems[0].tap();
    ok(b.state.screen === 'history' && b.state.histCard === own.key && !b.state.open0, 'HISTORY in the card’s menu is the card’s own history');
    b.back();
    ok(b.state.screen === 'flashcard' && b.state.fc && b.state.fc.key === own.key, 'and back is the card’s screen');
    vals(b).fcHome();
    ok(b.state.screen === 'home' && !b.state.fc && b.state.stack.length === 0, 'HOME on the card’s screen is home');
    // CARD again: the same card is asked for again, not shown from before
    H.sheet.length = 0;
    own.tap();
    b.goFlashcard();
    ok(b.state.screen === 'flashcard' && !b.state.fc && H.sheet.some((x) => /^begin: /.test(x)), 'CARD again asks for the tap again');
    await until('the card read again', () => b.state.fc && b.state.fc.key === own.key && !(b._fcTaps > 0));
    vals(b).fcHome();
    /* The swipe, back as it was before CARD and HOME, and doing what they do: to the left on home is CARD (the tap asked for, nothing
     * of the card shown from before), to the right on the card's screen is HOME. No dots, no hint, no kept read. */
    ok(typeof b.fcKeptRead !== 'function' && typeof b.fcLastCard !== 'function', 'no kept read for the swipe');
    b.fcWatchSwipe();
    const doc = H.window.document;
    const touch = (kind, x, y) => {
      const ev = new H.window.Event(kind, { bubbles: true });
      ev[kind === 'touchend' ? 'changedTouches' : 'touches'] = [{ clientX: x, clientY: y }];
      doc.body.dispatchEvent(ev);
    };
    v = vals(b);
    ok(!('swipeDots' in v) && !('swipeHintShown' in v) && !('pageTabs' in v) && !('pageTabsShown' in v), 'home draws nothing for the swipe: no dots, no hint, no pill');
    H.sheet.length = 0;
    own.tap();
    touch('touchstart', 300, 400);
    touch('touchend', 150, 410);
    ok(b.state.screen === 'flashcard' && !b.state.fc && H.sheet.some((x) => /^begin: /.test(x)), 'a swipe to the left on home is CARD: the card’s screen, asking for the tap', H.sheet.join(' / '));
    await until('the card read by the swipe', () => b.state.fc && b.state.fc.key === own.key && !(b._fcTaps > 0));
    v = vals(b);
    ok(!('swipeDots' in v) && !('swipeHintShown' in v) && !('pageTabs' in v) && !('fcMemoLine' in v), 'and the card’s screen draws nothing for it either');
    touch('touchstart', 100, 400);
    touch('touchend', 260, 395);
    ok(b.state.screen === 'home' && !b.state.fc && b.state.stack.length === 0, 'a swipe to the right on the card’s screen is HOME');
    ok(H.storage.getItem('foxy.flashcard.reads') === null && H.storage.getItem('foxy.flashcard.last') === null, 'and nothing of the card is kept for it');
    H.sheet.length = 0;
    touch('touchstart', 10, 400);
    touch('touchend', 200, 400);
    touch('touchstart', 300, 400);
    touch('touchend', 150, 400);
    ok(b.state.screen === 'flashcard' && H.sheet.filter((x) => /^begin: /.test(x)).length === 1, 'a swipe from the left edge is the back gesture’s, not this one');
    await until('the card read again by the swipe', () => b.state.fc && b.state.fc.key === own.key && !(b._fcTaps > 0));
    touch('touchstart', 10, 400);
    touch('touchend', 200, 400);
    ok(b.state.screen === 'flashcard', 'and on the card’s screen too');
    touch('touchstart', 300, 400);
    touch('touchend', 150, 400);
    ok(b.state.screen === 'flashcard', 'a swipe to the left on the card’s screen does nothing');
    touch('touchstart', 100, 400);
    touch('touchend', 140, 400);
    ok(b.state.screen === 'flashcard', 'a short movement is not a swipe');
    // nothing over the screen, and no card flow under way
    b.fcAskPin({ title: 'CARD PIN', subtitle: '' }, () => {});
    ok(b.fcSwipe('right') === false && b.state.screen === 'flashcard', 'with a PIN pad up, nothing');
    pad(b).back();
    b.setState({ open0: true });
    ok(b.fcSwipe('right') === false && b.state.screen === 'flashcard', 'with the menu open, nothing');
    b.setState({ open0: false });
    b._fcTaps = 1;
    ok(b.fcSwipe('right') === false && b.state.screen === 'flashcard', 'while a card is being tapped, nothing');
    b._fcTaps = 0;
    ok(b.fcSwipe('right') === true && b.state.screen === 'home', 'and once nothing is up, the swipe is HOME');
    b.setState({ open0: true });
    ok(b.fcSwipe('left') === false && b.state.screen === 'home', 'on home with the menu open, nothing');
    b.setState({ open0: false });
    b._fcSwipeOff();
    H.storage.setItem('foxy.flashcard.reads', '{"x":{}}');
    H.storage.setItem('foxy.flashcard.last', '{"key":"x"}');
    b.fcDropOldStores();
    ok(H.storage.getItem('foxy.flashcard.reads') === null && H.storage.getItem('foxy.flashcard.last') === null, 'an earlier build’s kept reads are cleared');
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
    // SET AMOUNT for the first, $2.00 without the PIN, and $10 a second on MAX SPEND PER SECOND for the second ($30.00 on one payment)
    const wheelSet = (a) => (speed(a) ? speed(a).pick(10).next() : amt(a).type('2.00', 'USD').next());
    // SKIP on both: no allowance, no limit
    const skipBoth = (a) => { amt(a).skip(); (speed(a) || amt(a)).skip(); };
    // every new card is met by WELCOME TO YOUR CASHU CARD, whose SET UP CARD is the set-up's first pad
    const throughWelcome = async (a, what) => {
      await until(what + ', after the welcome', () => !!welcome(a));
      welcome(a).press('SET UP CARD');
      // (NAME CARD first: SKIP, no name)
      if (named(a)) named(a).skip();
      return until(what, () => !!pad(a));
    };
    const payer = appOn(R);
    payer.price = 60000;
    await payer.refreshBalance();
    const u1 = card4(H, 22);
    R.nfc = u1;
    u1.tap();
    payer.fcSendCard();
    keyIn(payer, 1500);
    await throughWelcome(payer, 'the set-up pad');
    pad(payer).type('8642'); pad(payer).type('8642');
    wheelSet(payer); wheelSet(payer);
    u1.tap();
    u1.leaveBefore('33', 1);
    await until('the failure card', () => !!card(payer) && /AGAIN/.test(card(payer).all));
    ok(u1.state.tapLimit === 0 && u1.balance() === 0 && R.W.cardOwed().length === 0, 'cut before the holder’s numbers: nothing set, nothing made');
    u1.tap();
    card(payer).press('TRY AGAIN');
    await until('the money on the card', () => u1.balance() === 1500);
    await settle();
    ok(u1.state.tapLimit === Math.round(30 / 60000 * 1e8) && u1.state.noPinLimit === Math.round(2 / 60000 * 1e8) && !u1.state.owner && !ins(u1).includes('43'),
       'TRY AGAIN takes the set-up up again: the holder’s two numbers are on the card with the money, and still no owner', JSON.stringify([u1.state.tapLimit, u1.state.noPinLimit]));
    if (card(payer)) card(payer).press('DONE');

    // cut before the record and left: this phone's FLASHCARD screen does not offer to set it up as its own
    const u2 = card4(H, 22);
    R.nfc = u2;
    payer.setState({ screen: 'home', stack: [], fc: null });
    u2.tap();
    payer.fcSendCard();
    keyIn(payer, 1500);
    await throughWelcome(payer, 'the set-up pad');
    pad(payer).type('8642'); pad(payer).type('8642');
    skipBoth(payer);
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
    await throughWelcome(payer, 'the set-up pad again');
    ok(pad(payer).title === 'CREATE A PIN' && R.sheet.some((x) => x === 'end: Finish setting up the card'),
       'a later send to it takes its set-up up again, from CREATE A PIN (the card has no record, so it takes the PIN typed now)', pad(payer).title);
    pad(payer).type('8642'); pad(payer).type('8642');
    skipBoth(payer);
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
    await throughWelcome(payer, 'the set-up pad');
    pad(payer).type('8642'); pad(payer).type('8642');
    amt(payer).skip(); wheelSet(payer);
    u3.tap();
    u3.leaveBefore('33', 1);
    await until('the failure card', () => !!card(payer) && /AGAIN/.test(card(payer).all));
    card(payer).press('CANCEL');
    payer.setState({ screen: 'home', stack: [], fc: null });
    u3.tap();
    payer.fcSendCard();
    keyIn(payer, 1500);
    await until('the welcome of a card cut short', () => !!welcome(payer) && welcome(payer).line === 'Its set-up was cut short. The person who holds it finishes it here.');
    await throughWelcome(payer, 'the PIN pad');
    ok(pad(payer).title === 'CARD PIN' && /set-up was cut short/.test(pad(payer).sub), 'a later send to a card cut before its numbers asks the holder’s PIN once', pad(payer).title + ' / ' + pad(payer).sub);
    pad(payer).type('8642');
    amt(payer).skip(); wheelSet(payer);
    u3.tap();
    await until('the money on the card', () => u3.balance() === 1500);
    await settle();
    ok(u3.state.tapLimit === Math.round(30 / 60000 * 1e8) && !u3.state.owner, 'and the holder’s limit is written with the money', String(u3.state.tapLimit));
    if (card(payer)) card(payer).press('DONE');

    // the card's own log says nothing of a daily limit
    ok(!/daily limit/.test(require('fs').readFileSync(require('path').join(__dirname, '../build/app/26f-flashcard.js'), 'utf8').split('fcLogCard() {')[1].split('\n  }\n')[0]),
       'the card’s own log screen says nothing of a daily limit');
  }

  /* ---- B11: what the owner chose at set-up drives the card's screen (software 1.23) ---------------------------------------
   * BOTH: two pills from the moment set-up ends, each at nothing, ADD FUNDS asking which and SWAP greyed while it holds nothing; each read
   * of it shows it so. DOLLARS: one pill, and ADD FUNDS asks nothing. */
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
    ok((v.fcButtons.find((x) => x.label === 'SWAP') || {}).dim === '0.38', 'and SWAP greyed while the card holds nothing');
    a.fcAdd();
    ok(a.state.screen === 'currency' && a.state.curCard && a.state.curCard.question === 'ADD WHICH TO THE CARD?', 'and ADD FUNDS asks which', a.state.screen);
    a.back();
    // read again from home's CARD, as every time: the two pills again, from the card and this phone's note of what it was set up to hold
    v = await readIt(twoCard);
    ok(v.fcPillRows.length === 2 && U.storage.getItem('foxy.flashcard.reads') === null, 'read again, both pills again, and nothing of it kept on the phone');
    v = await readIt(oneCard);
    ok(v.fcPillRows.length === 1 && v.fcPillRows[0].big === '0.00', 'a card set up for dollars shows one pill', JSON.stringify(v.fcPillRows.map((x) => x.big)));
    a.fcAdd();
    ok(a.state.screen === 'amount' && a.state.flow === 'cardAdd' && !a.state.curCard && a.fcUnit() === 'usd', 'and ADD FUNDS asks no currency', a.state.screen);
  }

  console.log('\n' + (failed || until.failed ? (failed + until.failed) + ' flashcard-holder check(s) failed' : 'all flashcard-holder checks pass'));
  process.exit(failed || until.failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
