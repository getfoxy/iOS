'use strict';
/* flashcard-claim-money.js — a card with money on it connected to a phone (software 1.24), and its backup moved there.
 *
 *     node tests/flashcard-claim-money.js
 *
 * A card with a PIN and no owner is a holder's with no phone (1.22). Before 1.24 it could be tied to a phone only while empty;
 * a card of 1.24 is claimed with its money on it (the model of the card, tests/flashcard-card.js `software: 24`). Its pieces were
 * made by whoever loaded it, with that phone's refund key or none, and its record names that key, which a card holding pieces is
 * not given a new one of. So the claim files this phone's key as due, and the backup moves here when every piece has been remade
 * with it: all of them off the card, the same money made into pieces locked to the card with this phone's key and a fresh date,
 * the record given the key while the card is empty, and the pieces written.
 *
 * What is held to here:
 *   - a card of 1.23 with money on it is refused as before (`has-money`), and nothing is sent to it;
 *   - a card of 1.24 with change owed to it is refused (the card's own rule), with words that say how to put the change on;
 *   - claimed online: the same sheet asks for the card once more (the card signs nothing in the tap that claimed it), the money
 *     comes off and goes back on, and the card's record and every piece on it name this phone's refund key, dated the hold ahead;
 *   - claimed with no way to do that (no second asking, as with no route): the card is this phone's, its money untouched, and the
 *     backup is said to be due (`rekeyDue`) until a later tap moves it, which `cardRekeyRun` is;
 *   - a tap cut short after the money came off leaves the new pieces owed to the card, and its next tap writes them, the record
 *     first;
 *   - an empty card claimed with a key due is given that key by its first top-up, never the old one;
 *   - the books add up (the harness asks, as it asks every suite).
 */
const { funded, newCard, why, OTHER_WORDS } = require('./flashcard-kit');
const { appOn, until, pad, card: face, vals, settle } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const card4 = (ctx, software) => newCard(ctx, undefined, { format: 4, software });
const ins = (c) => c.sent.filter((a) => a.slice(0, 2) === 'b0').map((a) => a.slice(2, 4));
// a card in the field that can be asked for again in the same sheet, as the phone's own link can (`link.again`)
const asking = (c) => { c.again = () => { c.tap(); return Promise.resolve(); }; return c; };
const ZERO = '00'.repeat(33);
const datesOf = (c) => c.state.slots.filter((x) => x.status === 1).map((x) => c.secretOf(c.state.slots.indexOf(x)))
  .map((sec) => { try { const tags = JSON.parse(sec)[1].tags || []; const t = tags.find((g) => g[0] === 'locktime'); return t ? Number(t[1]) : 0; } catch (e) { return -1; } });
const refundsOf = (c) => c.state.slots.filter((x) => x.status === 1).map((x) => c.secretOf(c.state.slots.indexOf(x)))
  .map((sec) => { try { const tags = JSON.parse(sec)[1].tags || []; const t = tags.find((g) => g[0] === 'refund'); return t ? t[1] : ''; } catch (e) { return '?'; } });

(async () => {
  const H = await funded({}, 20000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 20000);
  const G = await funded({ sharedMint: H.mint, words: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above' }, 0);
  const HOLD = G.W.cardHoldSecs();

  /* A card set up for its holder by the first phone that paid it (R): no owner, no refund key, money on it under the PIN. */
  const holders = async (software, sats) => {
    const c = card4(H, software);
    c.tap();
    await R.W.cardSetUpFor(c, { pin: '5555' });
    c.tap();
    await R.W.cardPrepare(await R.W.cardLook(c, { short: true }), sats);
    c.tap();
    await R.W.cardWrite(c, { pin: '5555' });
    return c;
  };

  /* ---- 1.23: refused, as ever ------------------------------------------------------------------------------------- */
  {
    const c = await holders(23, 1200);
    c.tap();
    const before = ins(c).length;
    ok((await why(G.W.cardClaim(c, { pin: '5555' }))) === 'has-money' && !c.state.owner && !ins(c).slice(before).includes('43'),
       'a card of 1.23 with money on it is refused, and no claim is sent to it', ins(c).slice(before).join());
  }

  /* ---- 1.24, online: claimed and its backup moved in the same sheet ------------------------------------------------- */
  {
    const c = asking(await holders(24, 1200));
    ok(c.version === 24 && c.state.record.refund === ZERO && c.balance() === 1200, 'a card of 1.24 holding 1,200, loaded as cash (no refund key)', String(c.version));
    c.tap();
    const held = [];
    const now = Math.floor(Date.now() / 1000);
    const got = await G.W.cardClaim(c, { pin: '5555', refresh: true, onHold: (n) => held.push(n) });
    const key = (G.W.cardsKnown()[c.key] || {}).refundKey;
    ok(!!c.state.owner && held.length === 6 && got.rekeyed === true && !got.rekeyDue, 'claimed in six askings, and the backup moved in the same sheet', JSON.stringify([held.length, got.rekeyed, got.rekeyDue]));
    ok(/^0[23]/.test(c.state.record.refund) && c.state.record.refund === key, 'the card’s record names this phone’s refund key', c.state.record.refund.slice(0, 8));
    ok(c.balance() > 1150 && c.balance() <= 1200 && refundsOf(c).every((r) => r === key), 'every piece on it is locked with that key, the money all there but the mint’s fees', c.balance() + ' ' + JSON.stringify(refundsOf(c).slice(0, 2)));
    ok(datesOf(c).every((d) => d >= now + HOLD - 120 && d <= now + HOLD + 120) && HOLD === 14 * 86400, 'dated the hold ahead: fourteen days', JSON.stringify(datesOf(c).slice(0, 2)));
    ok(!G.W.cardOwed().length && !G.W.cardRekeyDue(got), 'nothing is left owed, and nothing is due');
    ok(!G.W.cardsKnown()[c.key].rekey, 'and the row on file no longer says the key is due');
  }

  /* ---- 1.24 with change owed to it: refused, and told how ------------------------------------------------------------ */
  {
    const c = await holders(24, 600);
    c.state.changeDue = true;
    c.state.openings[0] = { state: 'pending', amount: 1 };
    c.tap();
    const e = await G.W.cardClaim(c, { pin: '5555' }).then(() => null, (x) => x);
    ok(e && e.card === 'has-money' && /VIEW AS GUEST/.test(e.message) && !c.state.owner, 'a card of 1.24 owed change is refused, with VIEW AS GUEST named to put it on', e && e.message);
  }

  /* ---- 1.24, no second asking: claimed now, the backup later ----------------------------------------------------------- */
  {
    const c = await holders(24, 900);
    c.tap();
    const got = await G.W.cardClaim(c, { pin: '5555', refresh: true });
    ok(!!c.state.owner && got.rekeyDue === true && c.state.record.refund === ZERO && c.balance() === 900,
       'with no way to ask for the card again in the sheet, it is claimed and its money left as it was, the backup due', JSON.stringify([got.rekeyDue, c.balance()]));
    c.tap();
    ok(G.W.cardRekeyDue(await G.W.cardLook(c, { mine: true })) === true, 'read again, it is still due');
    // later, with a route: a tap moves it, cut short after the money came off
    c.tap();
    c.leaveBefore('32', 1);
    ok((await why(G.W.cardRekeyRun(c, { pin: '5555' }))) === 'gone' && c.balance() === 0 && G.W.cardOwed().length === 1,
       'a tap cut short after the money came off leaves the card empty and the pieces owed to it', JSON.stringify([c.balance(), G.W.cardOwed().length]));
    ok(G.W.cardOwed()[0].card === c.key && c.state.record.refund === ZERO, 'owed to this card, whose record is still the old one');
    c.tap();
    const w = await G.W.cardWrite(c, { pin: '5555' });
    const key = G.W.cardsKnown()[c.key].refundKey;
    ok(w.left === 0 && c.state.record.refund === key && c.balance() > 850 && refundsOf(c).every((r) => r === key) && !G.W.cardOwed().length,
       'its next tap gives the record this phone’s key first, then writes them', JSON.stringify([w.left, c.balance()]));
    c.tap();
    ok(!G.W.cardRekeyDue(await G.W.cardLook(c, { mine: true })), 'and nothing is due any more');
  }

  /* ---- 1.24, emptied after the claim: its first top-up is made with this phone's key ------------------------------------- */
  {
    const c = await holders(24, 300);
    c.tap();
    await G.W.cardClaim(c, { pin: '5555' });
    c.tap();
    await H.W.cardPay(c, { sats: 300, pin: '5555' });
    ok(c.balance() === 0 && c.state.record.refund === ZERO, 'claimed, then spent to nothing at a till', String(c.balance()));
    await G.W.claim((await G.W.invoice(2000, '')).hash);
    c.tap();
    await G.W.cardAdd(c, { sats: 500, pin: '5555' });
    const key = G.W.cardsKnown()[c.key].refundKey;
    ok(c.state.record.refund === key && refundsOf(c).every((r) => r === key) && c.balance() === 500,
       'its first top-up is made with this phone’s key, which the record is given first', JSON.stringify([c.state.record.refund.slice(0, 6), c.balance()]));
  }

  /* ======== the screens: CONNECT TO PHONE ======================================================================== */

  /* ---- online: connected, and its backup moved in the same sheet ------------------------------------------------- */
  {
    const c = await holders(24, 1500);
    const app = appOn(G);
    app.price = 60000;
    G.nfc = c;
    c.tap();
    app.goFlashcard();
    await until('the card to be read', () => app.state.fc && app.state.fc.key === c.key);
    let v = vals(app);
    ok(v.fcGuest && app.state.fc.claimFull === true && v.fcBalance === '₿ 1,500', 'a card of 1.24 with money on it, read as somebody else’s, says it can be connected with it', v.fcBalance);
    v.fcGuestTie();
    ok(!face(app) && pad(app) && pad(app).cta === 'CONNECT' && /To connect the card to this phone/.test(pad(app).sub), 'CONNECT TO PHONE: no refusal and no warning, straight to the PIN', pad(app) && pad(app).sub);
    G.sheet.length = 0;
    c.tap();
    pad(app).type('5555');
    await until('it to be connected', () => app.toasts.indexOf('Connected. Backup on this phone.') >= 0 || app.toasts.indexOf('Connected to this phone.') >= 0);
    await settle();
    const key = G.W.cardsKnown()[c.key].refundKey;
    ok(app.toasts.indexOf('Connected. Backup on this phone.') >= 0 && !!c.state.owner && c.state.record.refund === key && refundsOf(c).every((r) => r === key) && c.balance() > 1450,
       'online: connected, and in the same sheet every piece remade with this phone’s key: “Connected. Backup on this phone.”', app.toasts.slice(-2).join(' | '));
    ok(G.sheet.some((x) => /^again: /.test(x)) && G.sheet.filter((x) => /^begin/.test(x)).length === 1, 'one sheet: the card asked for once more in it, as it signs nothing in the tap that claimed it', G.sheet.filter((x) => /^(begin|again)/.test(x)).join(' / '));
    v = vals(app);
    ok(v.fcUsable && !v.fcGuest && !app.state.fc.rekeyDue && !v.fcNotes.some((n) => /Backup moves/.test(n.text)), 'and its screen is an owner’s, with nothing said to be due');
  }

  /* ---- offline: connected now, the backup said to move later, and moved when the phone has a route --------------- */
  {
    const c = await holders(24, 1100);
    const app = appOn(G);
    app.price = 60000;
    G.nfc = c;
    c.tap();
    app.goFlashcard();
    await until('the second card to be read', () => app.state.fc && app.state.fc.key === c.key);
    app.offline = true;
    vals(app).fcGuestTie();
    c.tap();
    pad(app).type('5555');
    await until('it to be connected offline', () => app.toasts.indexOf('Connected to this phone.') >= 0);
    await settle();
    let v = vals(app);
    ok(!!c.state.owner && c.state.record.refund === ZERO && c.balance() === 1100 && app.state.fc.rekeyDue === true,
       'offline: connected, its money left as it is, the backup due', JSON.stringify([c.balance(), app.state.fc.rekeyDue]));
    const line = v.fcNotes.filter((n) => n.text === 'Backup moves to this phone next time you’re online.')[0];
    ok(!!line, 'and the card’s screen says so in its note box: “Backup moves to this phone next time you’re online.”', v.fcNotes.map((n) => n.text).join(' | '));
    // a route again, and the card read: the move begins by itself, its PIN asked once and one tap
    app.offline = false;
    c.tap();
    app.fcRead();
    await until('the move to ask for the PIN', () => pad(app) && pad(app).cta === 'MOVE BACKUP');
    c.tap();
    pad(app).type('5555');
    await until('the backup to move', () => app.toasts.indexOf('Backup on this phone.') >= 0);
    await settle();
    const key = G.W.cardsKnown()[c.key].refundKey;
    ok(c.state.record.refund === key && refundsOf(c).every((r) => r === key) && c.balance() > 1050 && !G.W.cardOwed().length,
       'read with a route, the card’s backup moves to this phone: its record and every piece name this phone’s key', JSON.stringify([c.balance(), c.state.record.refund.slice(0, 6)]));
    v = vals(app);
    ok(!app.state.fc.rekeyDue && !v.fcNotes.some((n) => /Backup moves/.test(n.text)), 'and the line is gone');
  }

  /* ---- the money owed after a cut-short move goes on at the next tap, though a row for some other card waits at another
   * mint: the first row elsewhere does not send this phone to switch while this card's own money waits here ---- */
  {
    const c = await holders(24, 700);
    c.tap();
    await G.W.cardClaim(c, { pin: '5555', refresh: true });
    c.tap();
    c.leaveBefore('32', 1);
    await why(G.W.cardRekeyRun(c, { pin: '5555' }));
    const owedHere = G.W.cardOwed().filter((r) => r.card === c.key);
    ok(c.balance() === 0 && owedHere.length === 1, 'cut short after the money came off: the card empty, its pieces owed to it here', JSON.stringify([c.balance(), owedHere.length]));
    const rows0 = G.storage.getItem('foxy.flashcard.owed');
    const rows = JSON.parse(rows0 || '[]');
    rows.push({ id: 'owed-elsewhere', card: '02' + 'ab'.repeat(32), sats: 64, kind: 'load', mint: 'https://testnut.cashu.space', at: Date.now() });
    G.storage.setItem('foxy.flashcard.owed', JSON.stringify(rows));
    const app = appOn(G);
    app.price = 60000;
    G.nfc = c;
    c.tap();
    app.goFlashcard();
    await until('the card with money owed to be read', () => app.state.fc && app.state.fc.key === c.key);
    c.tap();
    app.fcWriteAsk({});
    await settle();
    if (pad(app)) { c.tap(); pad(app).type('5555'); }
    await until('the owed money to be on the card', () => !G.W.cardOwed().some((r) => r.card === c.key) || (face(app) && face(app).title === 'A DIFFERENT MINT'));
    await settle();
    ok(!(face(app) && face(app).title === 'A DIFFERENT MINT') && c.balance() > 650 && !G.W.cardOwed().some((r) => r.card === c.key),
       'TAP CARD writes it: a row at another mint for another card does not send this phone to switch', JSON.stringify([c.balance(), face(app) && face(app).title, G.W.cardOwed()]));
    ok(G.W.cardOwed().some((r) => r.id === 'owed-elsewhere'), 'and that other row is left as it was');
    G.storage.setItem('foxy.flashcard.owed', JSON.stringify(JSON.parse(G.storage.getItem('foxy.flashcard.owed') || '[]').filter((r) => r.id !== 'owed-elsewhere')));
  }

  failed += until.failed;
  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
