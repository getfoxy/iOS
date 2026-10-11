'use strict';
/* flashcard-release.js — a card is let go when it has signed, and the mint is
 * asked after.
 *
 *     node tests/flashcard-release.js
 *
 * A card does its part in seconds: it is read, it is given its PIN, it signs. The
 * mint's part takes as long as Tor does, and used to be done with the card held
 * to the phone and its sheet open. Now the sheet ends the moment the signatures
 * are in, and the swap is asked with the card gone. This pins:
 *
 *   the order: the sheet ends, then the swap; nothing is sent to the card after;
 *   a payment makes one swap request and asks the mint nothing first;
 *   the signed pieces are written down before the card is let go;
 *   a mint that refuses: the screen's error, what is owed back, and the next tap
 *     that clears the places the signing burned and loads the same pieces;
 *   an answer that is lost is not a refusal: the row and the swap record wait for
 *     the wallet's own recovery, and the payment is made when it comes;
 *   a till with no route is as it was (nothing to wait for, one sheet end);
 *   a card held on purpose (a renewal, a move) is held;
 *   the road to the mint opened as the sheet opens.
 *
 * The phone's NFC is the kit's: `ctx.nfc` is the card tapped, `ctx.trace` every
 * line of the sheet and every request to the mint in the order they happened.
 */
const { makeCard } = require('./flashcard-card');
const { page, funded, newCard, binaryLoad, why, history, settle, MINT, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();
const amounts = (card) => card.state.slots.filter((x) => x.status === 1).map((x) => parseInt(x.data.substr(16, 8), 16)).sort((a, b) => b - a);
const offline = (W) => W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
const online = (W) => W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
const row = (c, hash) => history(c).filter((e) => e.hash === hash)[0] || {};
const asked = (c, path) => c.circuits.filter((x) => x.path === path).length;
const THIRD = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/* One tap of `card` on `ctx`, as the app makes it: a session on the phone's
 * sheet, the card paid from inside it. `how` is what to do with the link. */
function tap(ctx, card, how, opts) {
  ctx.nfc = card;
  card.tap();
  return ctx.W.cardSession('Hold the card to the top of the phone', how, opts);
}
const JSONERR = (code, detail) => '400\n' + JSON.stringify({ code, detail });

(async () => {
  const H = await funded({}, 12000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const card = newCard(H);
  await H.W.cardSetUp(card, { pin: '1234' });
  card.tap();
  await H.W.cardAdd(card, { sats: 2000, pin: '1234' });

  /* ---- 1: a normal payment: SEND, the card gone before the mint answers, then RECEIVE ---- */
  {
    const steps = [];
    let atSwap = null;
    // the first swap is the payment's; the second, after it, makes the change
    R.fate = (m) => {
      if (!atSwap && /\/v1\/swap$/.test(String(m.url || ''))) atSwap = { ended: R.ended, taken: R.W.cardTaken().length, sheet: R.sheet.slice() };
      return null;
    };
    R.trace.length = 0;
    R.sheet.length = 0;
    R.circuits.length = 0;
    card.sent.length = 0;
    const held = card.balance();
    const paid = await tap(R, card, (link) => R.W.cardPay(link, { sats: 600, pin: '1234', on: (s) => steps.push(s) }));
    R.fate = null;
    const signed = card.sent.filter((a) => /^b020/.test(a)).length;
    const gave = held - card.balance();
    ok(paid.sats === 600 && (await bal(R)) === 600 && R.W.cardTaken().length === 0 && signed >= 1 && signed <= 2 && gave > 600,
       'SEND: a card pays 600 in no more than two pieces, over-paying, and the receiver keeps 600', JSON.stringify({ sats: paid.sats, bal: await bal(R), signed, gave }));
    ok(paid.change && paid.change.sats > 0 && paid.change.written === false && R.W.cardOwed().length === 1 && R.W.cardOwed()[0].kind === 'change'
       && R.W.cardOwed()[0].sats === paid.change.sats,
       'the difference is made into change for the card, and waits for its next tap', JSON.stringify({ change: paid.change, owed: R.W.cardOwed().map((r) => [r.kind, r.sats]) }));
    const order = R.trace.filter((x) => x === 'begin' || x === 'end' || x === 'error' || x === 'mint /v1/swap');
    ok(order.join(' ') === 'begin end mint /v1/swap mint /v1/swap', 'the sheet ends, then the swap is asked, then the change is made: all with the card gone', R.trace.join(', '));
    ok(!!atSwap && atSwap.ended === true && atSwap.sheet.filter((x) => /^end:/.test(x)).length === 1, 'at the moment the mint is asked the sheet has ended', JSON.stringify(atSwap && atSwap.sheet));
    ok(R.sheet.filter((x) => /^end:/.test(x)).length === 1 && R.sheet.filter((x) => /^error:/.test(x)).length === 0 && R.sheet[R.sheet.length - 1] === 'end: Done.',
       'it ends once, as "Done.", and never again after the mint', R.sheet.join(' | '));
    ok(R.refusedAfterEnd === 0, 'nothing is sent to the card after the sheet has ended', String(R.refusedAfterEnd));
    ok(atSwap && atSwap.taken === 1, 'the signed pieces were written down (in the card store) before the card was let go', JSON.stringify(atSwap && atSwap.taken));
    ok(steps.join(' ') === 'reading signing checking making done', 'the screen is told: the card is let go (checking), the change is made, and then it is done', steps.join(' '));
    ok(asked(R, '/v1/swap') === 2 && asked(R, '/v1/checkstate') === 0,
       'one swap for the payment and one for its change, and the mint is asked nothing about the pieces first', R.circuits.map((x) => x.path.replace('/v1/', '')).join(', '));
    const entry = row(R, paid.hash);
    ok(entry.memo === 'card' && entry.card === card.key && entry.sats === 600 && entry.grossSats === gave && entry.changeSats === gave - 600 && entry.changeState === 'not handed',
       'its entry is a card’s: 600 kept, what the card gave, and the change not yet handed over', JSON.stringify(entry));
    // what the card was asked: read, a PIN, its signatures, and nothing after the last
    const ins = card.sent.map((a) => a.slice(0, 6));
    ok(/^b020/.test(ins[ins.length - 1]), 'the last thing the card was asked is the last signature', ins.join(' '));

    // RECEIVE: the next tap writes the change, with no PIN
    card.tap();
    card.sent.length = 0;
    const back = await tap(R, card, (link) => R.W.cardWrite(link, { change: true }));
    ok(back.sats === paid.change.sats && back.left === 0 && R.W.cardOwed().length === 0 && card.balance() === held - gave + paid.change.sats,
       'RECEIVE: the next tap puts the change on the card', JSON.stringify({ sats: back.sats, card: card.balance() }));
    ok(!card.sent.some((a) => /^b040/.test(a)), 'with no PIN sent');
    ok(row(R, paid.hash).changeState === 'given back' && (await bal(R)) === 600, 'and the entry says given back; the receiver still holds 600');
  }

  /* ---- 1b: how long the card is held for a one-piece payment ------------------------- */
  {
    const one = newCard(H);
    await H.W.cardSetUp(one, { pin: '1234' });
    await binaryLoad(H, one, 1024);
    R.trace.length = 0;
    one.sent.length = 0;
    const got = await tap(R, one, (link) => R.W.cardPay(link, { sats: 1024, pin: '1234' }));
    const names = { '00a404': 'select', b03500: 'time', b00100: 'info', b01000: 'key', b01600: 'record', b01700: 'pieces', b04000: 'pin', b02000: 'sign' };
    const cmds = one.sent.map((a) => names[a.slice(0, 6)] || a.slice(0, 6));
    const signs = cmds.filter((x) => x === 'sign').length;
    const secs = (cmds.length - signs) * 0.06 + signs * 0.74;
    ok(got.sats === 1024 && cmds.length === 8 && signs === 1 && !cmds.includes('auth'),
       'a payment of one piece holds the card for ' + cmds.length + ' commands and one signature', cmds.join(' '));
    console.log('      held: ' + cmds.length + ' commands, one signature: about ' + secs.toFixed(1) + ' s of the card’s work (0.06 s a command, 0.74 s a signature), and then the sheet ends');
  }

  /* ---- 2: the mint refuses, and the next tap puts the money back --------------------- */
  {
    // a limit, to see that the day stays charged
    card.tap();
    await H.W.cardSetLimit(card, { sats: 1200 });
    const before = amounts(card);
    const spentBefore = card.state.spent;
    const sheetLen = R.sheet.length;

    // a copy of the card pays 512 first, behind the till's back: the mint will call that piece spent
    const twin = card.copy();
    const R2 = await funded({ sharedMint: H.mint, words: THIRD }, 0);
    const twinPaid = await tap(R2, twin, (link) => R2.W.cardPay(link, { sats: 512, pin: '1234' }));
    ok(twinPaid.sats === 512, 'a copy of the card has paid 512 elsewhere (the mint has seen that piece spent)');

    const rb = await bal(R);
    R.trace.length = 0;
    R.circuits.length = 0;
    const steps = [];
    const refused = await tap(R, card, (link) => R.W.cardPay(link, { sats: 600, pin: '1234', on: (s) => steps.push(s) })).then(() => null, (e) => e);
    // the fewest pieces that cover 600 are three: the two 256s the copy spent, and a 128
    const signedFor = card.state.spent - spentBefore;
    ok(refused && refused.card === 'putback' && signedFor === 640 && refused.owed === 128 && refused.lost === 512 && refused.limited === true,
       'the card pays 600 with the same pieces, and the mint refuses it: 512 of the 640 it signed is spent, 128 is still good, and the error says so', refused && refused.message);
    ok(R.trace.filter((x) => x === 'end' || x === 'error' || x === 'mint /v1/swap').join(' ') === 'end mint /v1/swap' && R.sheet[R.sheet.length - 1] === 'end: Done.',
       'the sheet had ended before the swap, and says nothing more now', R.trace.join(', '));
    ok(steps.join(' ') === 'reading signing checking', 'the screen was on checking with the mint', steps.join(' '));
    ok(asked(R, '/v1/swap') === 1 && asked(R, '/v1/checkstate') === 1, 'one swap, and then, with the card gone, the mint is asked which pieces are still good', R.circuits.map((x) => x.path.replace('/v1/', '')).join(', '));
    ok((await bal(R)) === rb && R.W.cardTaken().length === 0, 'nothing was paid, and nothing is left in the card store');
    const owed = R.W.cardOwed();
    ok(owed.length === 1 && owed[0].kind === 'putback' && owed[0].sats === 128 && owed[0].card === card.key, 'the 128 sats that are still good are owed back to the card', JSON.stringify(owed.map((r) => [r.kind, r.sats])));
    ok(card.state.spent === spentBefore + 640, 'the card’s day stays charged for all it signed', String(card.state.spent - spentBefore));
    ok(card.state.slots.filter((x) => x.status === 2).length >= 3, 'and its places stay burned until it is tapped again');

    // the tap that puts it back: the places are cleared and the same pieces loaded
    const tapAgain = await tap(R, card, (link) => R.W.cardWrite(link, { pin: '1234' }));
    ok(tapAgain.back === 128 && tapAgain.sats === 128 && tapAgain.left === 0 && R.W.cardOwed().length === 0,
       'the next tap says 128 was put back', JSON.stringify({ back: tapAgain.back, sats: tapAgain.sats }));
    const after = amounts(card);
    const lostSum = before.reduce((a, b) => a + b, 0) - after.reduce((a, b) => a + b, 0);
    ok(lostSum === 512 && card.state.slots.filter((x) => x.status === 2).length === 0, 'the card holds what it did less the 512 the mint had seen spent, and no burned place', amounts(card).join('+'));
    ok(card.state.spent === spentBefore + 640, 'the day is as charged: loading gives it nothing back', String(card.state.spent));
    ok((await bal(R)) === rb, 'and the receiver was paid nothing');
    ok(R.sheet.filter((x) => /^error:/.test(x)).length === 0, 'no sheet of this ended in an error');
  }

  /* ---- 2b: a refusal that is not a spent piece: all of it goes back ------------------- */
  {
    card.tap();
    await H.W.cardSetLimit(card, { sats: 0 });
    const holds = card.balance();
    const rb = await bal(R);
    let swaps = 0;
    // the mint says no to the signature (the pieces are untouched at the mint)
    R.fate = (m) => { if (/\/v1\/swap$/.test(String(m.url || ''))) { swaps += 1; return JSONERR(11000, 'signature for P2PK does not verify'); } return null; };
    R.circuits.length = 0;
    const refused = await tap(R, card, (link) => R.W.cardPay(link, { sats: 600, pin: '1234' })).then(() => null, (e) => e);
    R.fate = null;
    const gone = holds - card.balance();
    ok(refused && refused.card === 'putback' && gone >= 600 && refused.owed === gone && refused.lost === 0 && refused.limited === false && swaps === 1,
       'a mint that refuses the signatures leaves all it signed good: all of it is owed back, and the screen is told the card has no limit to stay charged', refused && refused.message);
    ok(R.W.cardOwed().length === 1 && R.W.cardTaken().length === 0 && (await bal(R)) === rb, 'the card holds the rest, and nothing was paid');
    const put = await tap(R, card, (link) => R.W.cardWrite(link, { pin: '1234' }));
    ok(put.back === gone && card.balance() === holds && R.W.cardOwed().length === 0, 'the next tap puts it all back: the card holds what it did', String(card.balance()));
    // and it pays as it did, with the pieces put back, and its change goes back at the tap after (RECEIVE)
    const again = await tap(R, card, (link) => R.W.cardPay(link, { sats: 600, pin: '1234' }));
    if (again.change && again.change.sats > 0 && !again.change.written) await tap(R, card, (link) => R.W.cardWrite(link, { change: true }));
    ok(again.sats === 600 && (await bal(R)) === rb + 600 && card.balance() === holds - 600 && R.W.cardOwed().length === 0, 'and then pays the 600, with the same pieces', String(await bal(R)));

    // pieces the mint never signed are not put back: nothing to put
    const rb2 = await bal(R);
    R.fate = (m) => (/\/v1\/swap$/.test(String(m.url || '')) ? JSONERR(10003, 'Proof could not be verified.') : null);
    const bad = await tap(R, card, (link) => R.W.cardPay(link, { sats: 100, pin: '1234' })).then(() => null, (e) => e);
    R.fate = null;
    ok(bad && bad.card === 'bad-pieces' && R.W.cardOwed().length === 0 && R.W.cardTaken().length === 0 && (await bal(R)) === rb2,
       'pieces the mint says it never signed are not put back on a card', bad && bad.card);
    // a mint too busy to answer is not a refusal of the pieces: the row waits
    R.fate = (m) => (/\/v1\/swap$/.test(String(m.url || '')) ? '429\n' + JSON.stringify({ detail: 'slow down' }) : null);
    // a price one piece of the card makes exactly
    const small = amounts(card).pop();
    const busy = await tap(R, card, (link) => R.W.cardPay(link, { sats: small, pin: '1234' })).then(() => null, (e) => e);
    R.fate = null;
    ok(busy && busy.card === 'waiting' && R.W.cardTaken().length === 1 && R.W.cardOwed().length === 0, 'a mint that says it is too busy has not refused: the row waits, and nothing is owed back', busy && busy.card);
    await R.W.cardSettle();
    ok(R.W.cardTaken().length === 0 && (await bal(R)) === rb2 + small, 'and the next asking pays it', String((await bal(R)) - rb2));
  }

  /* ---- 2c: all of it spent: nothing to put back ------------------------------------------ */
  {
    card.tap();
    await H.W.cardAdd(card, { sats: 900, owner: true });
    card.tap();
    const twin = card.copy();
    const first = await tap(R, twin, (link) => R.W.cardPay(link, { sats: 40, pin: '1234' }));
    const rb = await bal(R);
    const second = await tap(R, card, (link) => R.W.cardPay(link, { sats: 40, pin: '1234' })).then(() => null, (e) => e);
    ok(first.sats === 40 && second && second.card === 'spent' && R.W.cardOwed().length === 0 && R.W.cardTaken().length === 0 && (await bal(R)) === rb,
       'a copy that pays after the card is told the mint has the pieces spent: there is nothing to put back', second && second.card);
  }

  /* ---- 3: the answer is lost ------------------------------------------------------------ */
  {
    const Hh = await funded({}, 4000);
    const Rl = await funded({ sharedMint: Hh.mint, words: OTHER_WORDS }, 0);
    const c = newCard(Hh);
    await Hh.W.cardSetUp(c, { pin: '1234' });
    c.tap();
    await Hh.W.cardAdd(c, { sats: 1000, pin: '1234' });
    const real = Rl.mint.handle.bind(Rl.mint);
    // the mint makes the swap and the answer never arrives, and the mint is out of reach after it
    Rl.fate = (m) => {
      if (!/\/v1\/swap$/.test(String(m.url || ''))) return null;
      real(m);
      Rl.deaf = true;
      return '0\n';
    };
    Rl.circuits.length = 0;
    Rl.sheet.length = 0;
    const lost = await tap(Rl, c, (link) => Rl.W.cardPay(link, { sats: 100, pin: '1234' })).then(() => null, (e) => e);
    Rl.fate = null;
    ok(lost && lost.card === 'waiting' && lost.id, 'the answer is lost: that is not a refusal, it is waiting', lost && lost.message);
    ok(Rl.sheet.filter((x) => /^end:/.test(x)).length === 1 && Rl.sheet.filter((x) => /^error:/.test(x)).length === 0, 'the sheet had ended before it, and says nothing now');
    ok(Rl.W.cardTaken().length === 1 && Rl.W.cardOwed().length === 0, 'the signed pieces stay in the card store, and nothing is owed back');
    ok(JSON.parse(Rl.storage.getItem('foxy.cashu.swaps') || '[]').length === 1, 'and the swap record is kept for the wallet’s own recovery');
    ok((await bal(Rl)) === 0, 'nothing is counted yet');
    // the connection comes back: the wallet’s own recovery finds the swap, and the card’s row is closed
    Rl.deaf = false;
    const signedWorth = 1000 - c.balance();
    await Rl.W.recoverSwaps();
    await settle();
    ok(signedWorth > 100 && (await bal(Rl)) === signedWorth && Rl.W.cardTaken().length === 1,
       'the wallet’s own recovery finds the swap first: what the card signed is in the pile, and the card’s row is still there to be closed', String(await bal(Rl)));
    const rows = await Rl.W.cardSettle();
    await settle();
    const owedNow = Rl.W.cardOwed();
    ok((await bal(Rl)) === 100 && Rl.W.cardTaken().length === 0 && JSON.parse(Rl.storage.getItem('foxy.cashu.swaps') || '[]').length === 0
       && rows.length === 1 && rows[0].state === 'paid' && rows[0].change > 0
       && owedNow.length === 1 && owedNow[0].kind === 'change' && owedNow[0].card === c.key && owedNow[0].sats === rows[0].change,
       'on the next connection it is found: the receiver keeps 100, the over-payment is made into change for the card, and the row and the record are gone',
       JSON.stringify({ bal: await bal(Rl), rows, owed: owedNow.map((r) => [r.kind, r.sats]) }));
    const entries = history(Rl).filter((e) => e.hash === lost.id);
    ok(entries.length === 1 && entries[0].memo === 'card' && entries[0].card === c.key && entries[0].state === 'success' && entries[0].sats === 100
       && entries[0].grossSats === signedWorth && entries[0].changeState === 'not handed',
       'with one entry, a card’s: 100 kept, the change owed to the card', JSON.stringify(entries.map((e) => [e.memo, e.state, e.sats, e.grossSats, e.changeState])));
    ok(asked(Rl, '/v1/swap') >= 1 && c.balance() === 1000 - signedWorth, 'and the card was not asked for anything again', String(c.balance()));
    // its next tap takes the change, with no PIN
    c.tap();
    const back = await Rl.W.cardWrite(c, { change: true });
    ok(back.sats === rows[0].change && c.balance() === 1000 - signedWorth + rows[0].change && Rl.W.cardOwed().length === 0,
       'and the card’s next tap receives it', String(c.balance()));

    // an answer that never came because the request never got there: the next asking makes the swap
    const Rm = await funded({ sharedMint: Hh.mint, words: THIRD }, 0);
    Rm.fate = (m) => (/\/v1\/swap$/.test(String(m.url || '')) ? (Rm.deaf = true, '0\n') : null);
    const never = await tap(Rm, c, (link) => Rm.W.cardPay(link, { sats: 50, pin: '1234' })).then(() => null, (e) => e);
    Rm.fate = null;
    Rm.deaf = false;
    ok(never && never.card === 'waiting' && Rm.W.cardTaken().length === 1, 'a request that never got there is waiting too');
    const settled = await Rm.W.cardSettle();
    await settle();
    ok(settled.length === 1 && settled[0].state === 'paid' && (await bal(Rm)) === 50 && Rm.W.cardTaken().length === 0, 'and is made when the wallet asks again', JSON.stringify(settled));
  }

  /* ---- 4: a till with no route is as it was ----------------------------------------------- */
  {
    const Hh = await funded({}, 3000);
    const Ro = await funded({ sharedMint: Hh.mint, words: OTHER_WORDS }, 0);
    const c = newCard(Hh);
    await Hh.W.cardSetUp(c, { pin: '1234' });
    c.tap();
    await Hh.W.cardAdd(c, { sats: 2000, pin: '1234' });
    offline(Ro.W);
    Ro.trace.length = 0;
    Ro.sheet.length = 0;
    Ro.circuits.length = 0;
    const steps = [];
    const got = await tap(Ro, c, (link) => Ro.W.cardPay(link, { sats: 592, pin: '1234', trusted: true, on: (s) => steps.push(s) }));
    ok(got.trusted === true && got.sats === 592 && Ro.W.trustedWaiting().length === 1 && Ro.W.cardTaken().length === 0,
       'with no route a card is taken on trust, kept as a pending row, as it was');
    ok(Ro.trace.join(' ') === 'begin end' && Ro.sheet[Ro.sheet.length - 1] === 'end: Done.', 'the mint is never asked, and the sheet ends once, at the end', Ro.trace.join(', '));
    ok(steps.join(' ') === 'reading signing done', 'the screen is told reading, signing, done: there is no mint to wait for', steps.join(' '));
    ok(Ro.circuits.length === 0 && Ro.refusedAfterEnd === 0, 'no request of any kind went out');
    online(Ro.W);
  }

  /* ---- 5: a card held on purpose is held ----------------------------------------------------- */
  {
    const Hh = await funded({}, 3000);
    const c = newCard(Hh);
    await Hh.W.cardSetUp(c, { pin: '1234' });
    c.tap();
    await Hh.W.cardAdd(c, { sats: 1000, pin: '1234' });
    Hh.trace.length = 0;
    Hh.sheet.length = 0;
    const steps = [];
    const took = await tap(Hh, c, (link) => Hh.W.cardWithdraw(link, { pin: '1234', hold: true, on: (s) => steps.push(s) }));
    ok(took.sats === 1000 && took.card && took.card.balance === 0, 'a withdrawal that holds the card reads it again at the end', JSON.stringify({ sats: took.sats }));
    const at = Hh.trace.indexOf('mint /v1/swap'), end = Hh.trace.indexOf('end');
    ok(at > 0 && end > at && steps.join(' ') === 'reading signing mint done', 'and the sheet stays until after the swap', Hh.trace.join(', ') + ' / ' + steps.join(' '));

    // not held: the owner’s withdrawal lets the card go, and does not read it again
    c.tap();
    await Hh.W.cardAdd(c, { sats: 500, owner: true });
    Hh.trace.length = 0;
    Hh.sheet.length = 0;
    Hh.circuits.length = 0;
    const out = await tap(Hh, c, (link) => Hh.W.cardWithdraw(link, { pin: '1234' }));
    ok(out.sats === 500 && Hh.trace.filter((x) => x === 'end' || x === 'mint /v1/swap').join(' ') === 'end mint /v1/swap' && asked(Hh, '/v1/checkstate') === 0 && asked(Hh, '/v1/swap') === 1,
       'a withdrawal that does not hold lets the card go once it has signed, asks the mint nothing first, and does not read the card again', Hh.trace.join(', '));
    /* What its result carries for the holder's screen is the card as the tap knew it, worked out from the read at its start and not read again: no
     * pieces left, and the balance the card has. */
    ok(out.card && out.card.balance === 0 && out.card.pieces.length === 0 && out.card.key === c.key && c.balance() === 0 && out.card.info.unspent === 0,
       'its result carries the card as the tap knew it: worked out from the read at the start, and with nothing left on it', JSON.stringify(out.card && { balance: out.card.balance, pieces: out.card.pieces.length }));

    // the card leaves part-way through signing: the sheet ends in an error, and what it signed is held for its next tap
    c.tap();
    await binaryLoad(Hh, c, 1536);
    Hh.sheet.length = 0;
    const half = await tap(Hh, c, (link) => { c.leaveBefore('20', 2); return Hh.W.cardPay(link, { sats: 1535, pin: '1234' }); }).then(() => null, (e) => e);
    ok(half && half.card === 'interrupted' && half.resumable === true && Hh.W.cardOwed().length === 0 && !!Hh.W.cardHeldPayment(c.key) && Hh.sheet.some((x) => /^error:/.test(x)),
       'a card that leaves while it is signing: nothing paid yet, what it signed held for its next tap and nothing owed back, and the sheet says it left too soon', JSON.stringify({ card: half && half.card, held: Hh.W.cardHeldPayment(c.key), sheet: Hh.sheet }));
    await Hh.W.cardHeldLetGo(c.key);
    ok(!Hh.W.cardHeldPayment(c.key) && Hh.W.cardOwed().length === 1 && Hh.W.cardOwed()[0].kind === 'refund',
       'and let go, it goes back by the road it always did: made into pieces for the card, owed to it', JSON.stringify(Hh.W.cardOwed().map((r) => [r.kind, r.sats])));
  }

  /* ---- 6: the road to the mint is opened as the sheet opens ----------------------------------- */
  {
    const Hh = await funded({}, 3000);
    const c = newCard(Hh);
    await Hh.W.cardSetUp(c, { pin: '1234' });
    c.tap();
    await Hh.W.cardAdd(c, { sats: 1000, pin: '1234' });
    // a page that opens a circuit ahead of time, and has not opened one yet
    const Rw = page({ sharedMint: Hh.mint, words: OTHER_WORDS, spare: true });
    Rw.W._spareAfterMs = 86400000;
    await Rw.W.connect(MINT, null, null, { remember: true });
    await Rw.W.primeLocks();
    ok(!Rw.W._spare(), 'a phone with no circuit made ready');
    Rw.circuits.length = 0;
    Rw.trace.length = 0;
    const paid = await tap(Rw, c, (link) => Rw.W.cardPay(link, { sats: 100, pin: '1234' }), { warm: true });
    const keysets = Rw.circuits.filter((x) => x.path === '/v1/keysets');
    const swap = Rw.circuits.filter((x) => x.path === '/v1/swap')[0];
    ok(paid.sats === 100 && keysets.length >= 1 && Rw.trace.indexOf('mint /v1/keysets') < Rw.trace.indexOf('begin'),
       'the mint is asked for its keysets on a new circuit before the sheet opens, not after the card has signed', Rw.trace.slice(0, 4).join(', '));
    ok(!!swap && !!keysets[0] && swap.circuit === keysets[0].circuit && swap.circuit.length > 0,
       'and the swap leaves on that circuit', JSON.stringify({ swap: swap && swap.circuit.slice(0, 8), warm: keysets[0] && keysets[0].circuit.slice(0, 8) }));

    // a tap that only reads does not open one
    const Rr = page({ sharedMint: Hh.mint, words: OTHER_WORDS, spare: true });
    Rr.W._spareAfterMs = 86400000;
    await Rr.W.connect(MINT, null, null, { remember: true });
    Rr.circuits.length = 0;
    Rr.nfc = c;
    c.tap();
    await Rr.W.cardSession('Hold the card to the top of the phone', (link) => Rr.W.cardLook(link));
    await settle();
    ok(!Rr.W._spare(), 'a tap that only reads a card opens no circuit ahead of time', Rr.circuits.map((x) => x.path).join(', '));
  }

  /* ---- 7: change the mint did not make is made at the next connection --------------------- */
  {
    const Hd = await funded({}, 3000);
    const Rd = await funded({ sharedMint: Hd.mint, words: OTHER_WORDS }, 0);
    const c = newCard(Hd);
    await Hd.W.cardSetUp(c, { pin: '1234' });
    await binaryLoad(Hd, c, 1024);
    // the payment's swap goes through; the one that makes its change is refused
    let swaps = 0;
    Rd.fate = (m) => { if (/\/v1\/swap$/.test(String(m.url || ''))) { swaps += 1; if (swaps === 2) return JSONERR(11000, 'not now'); } return null; };
    const paid = await tap(Rd, c, (link) => Rd.W.cardPay(link, { sats: 200, pin: '1234' }));
    Rd.fate = null;
    await settle();
    const due = Rd.W.cardDue();
    ok(paid.sats === 200 && paid.change && paid.change.unmade === true && paid.change.sats === 824 && Rd.W.cardOwed().length === 0
       && due.length === 1 && due[0].sats === 824 && due[0].card === c.key,
       'a payment whose change the mint did not make stands, and the change is written down as due to the card', JSON.stringify({ change: paid.change, due }));
    const e0 = row(Rd, paid.hash);
    ok((await bal(Rd)) === 1024 && e0.sats === 1024 && e0.changeState === 'never sent',
       'until it is made the receiver holds it, and its entry says the whole', JSON.stringify({ bal: await bal(Rd), sats: e0.sats, state: e0.changeState }));
    // the next connection
    const tried = await Rd.W.cardDueRetry();
    await settle();
    const e1 = row(Rd, paid.hash);
    const owed = Rd.W.cardOwed();
    ok(tried.length === 1 && tried[0].state === 'made' && Rd.W.cardDue().length === 0 && owed.length === 1 && owed[0].kind === 'change' && owed[0].card === c.key,
       'the next connection makes it, owed to the card like any change', JSON.stringify({ tried, owed: owed.map((r) => [r.kind, r.sats]) }));
    ok((await bal(Rd)) === 200 && e1.sats === 200 && e1.changeState === 'not handed',
       'and the receiver is back to the 200 it was paid, its entry the same', JSON.stringify({ bal: await bal(Rd), sats: e1.sats, state: e1.changeState }));
    const back = await tap(Rd, c, (link) => Rd.W.cardWrite(link, { change: true }));
    ok(back.change === owed[0].sats && c.balance() === owed[0].sats && Rd.W.cardOwed().length === 0 && row(Rd, paid.hash).changeState === 'given back',
       'and the card’s next tap receives it, with no PIN', JSON.stringify({ back: back.change, card: c.balance() }));
    ok((await Rd.W.cardDueRetry()).length === 0, 'with nothing left to try');
  }

  /* ---- 7b: the change's answer is lost: the recovery finds it, and it goes to the card ------- */
  {
    const Hd = await funded({}, 3000);
    const Rd = await funded({ sharedMint: Hd.mint, words: OTHER_WORDS }, 0);
    const c = newCard(Hd);
    await Hd.W.cardSetUp(c, { pin: '1234' });
    await binaryLoad(Hd, c, 1024);
    const real = Rd.mint.handle.bind(Rd.mint);
    let swaps = 0;
    // the mint makes the change, its answer never comes, and the mint is out of reach after it
    // (with the mint still in reach, the wallet's own swap finds the answer at once, and the change is owed as usual)
    Rd.fate = (m) => {
      if (!/\/v1\/swap$/.test(String(m.url || ''))) return null;
      swaps += 1;
      if (swaps !== 2) return null;
      real(m);
      Rd.deaf = true;
      return '0\n';
    };
    const paid = await tap(Rd, c, (link) => Rd.W.cardPay(link, { sats: 200, pin: '1234' }));
    Rd.fate = null;
    await settle();
    ok(paid.sats === 200 && paid.change && paid.change.unmade === true && Rd.W.cardDue().length === 1 && Rd.W.cardOwed().length === 0,
       'a payment whose change answer was lost stands, and the change is due', JSON.stringify(paid.change));
    ok(row(Rd, paid.hash).changeState === 'making', 'and its entry is left for the recovery to finish', row(Rd, paid.hash).changeState);
    const early = await Rd.W.cardDueRetry();
    ok(early.length === 1 && early[0].state === 'waiting' && Rd.W.cardOwed().length === 0, 'while the swap is still being asked about, nothing is made twice', JSON.stringify(early));
    Rd.deaf = false;
    await Rd.W.recoverSwaps();
    await settle();
    const tried = await Rd.W.cardDueRetry();
    await settle();
    const owed = Rd.W.cardOwed();
    const tags = Rd.W.tagsFor(paid.hash) || {};
    ok(tried.length === 1 && tried[0].state === 'made' && owed.length === 1 && owed[0].card === c.key && owed[0].sats > 0 && !tags.changeToken && !tags.owedChange,
       'the recovery finds the change, and it is owed to the card, not left as a code on the payment', JSON.stringify({ tried, owed: owed.map((r) => [r.kind, r.sats]), tags }));
    ok((await bal(Rd)) === 200 && row(Rd, paid.hash).sats === 200, 'the receiver holds the 200 it was paid', String(await bal(Rd)));
    const back = await tap(Rd, c, (link) => Rd.W.cardWrite(link, { change: true }));
    ok(c.balance() === owed[0].sats && Rd.W.cardOwed().length === 0, 'and the card’s next tap receives it', String(c.balance()));
  }

  console.log('\n' + (failed ? failed + ' flashcard-release check(s) failed' : 'all flashcard-release checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
