'use strict';
/* card-notice.js — what the card's screen does not say, and its HISTORY does.
 *
 *     node tests/card-notice.js
 *
 * The card's screen said, under its title, how fresh the mint's word was ("Verified At 8:06 AM", "Not Verified", "Verifying…"); on
 * the card, in red, what the mint says is already spent; under the card its limit ("PER SECOND LIMIT $30.00"); an amber box for
 * money waiting to go onto a card; and a SWAP button for a card of two currencies. The keeper asked for the screen to be the card's
 * name, its picture, its balance and DEPOSIT and WITHDRAW. What is checked here:
 *
 *   1  none of those is among the card screen's values any more;
 *   2  they are rows at the top of the card's HISTORY (`fcHistNotes`): the mint's word in red with what clears it, money waiting in
 *      amber which a press puts on (`fcWriteAsk`), the verified words and the limits in grey;
 *   3  the card's menu button turns (`foxyRing`) and HISTORY in its menu glows: red for the mint's word, amber for money waiting, red
 *      over amber, and nothing once both have cleared;
 *   4  SWAP is a row of the card's menu, after TRANSFER and before RESET, for a card of two currencies only;
 *   2b-2d  the amber row's press is the box's (the real `fcWriteAsk`, from the card's screen); a card with no record keeps the
 *      amber line on its screen; pieces above the limit and change owed are grey rows;
 *   6  the ring by the real WITHDRAW: a typed one leaves it red, WITHDRAW ALL stops it;
 *   5  the history screen draws the rows above the payments, for the card's own list only, with no NOTHING TO SEE YET! under them,
 *      and the markup binds all of it.
 *
 * The card is the model (tests/flashcard-card.js); the mint is the test mint.
 */
const fs = require('fs');
const path = require('path');
const { funded, newCard, settle, OTHER_WORDS } = require('./flashcard-kit');
const { appOn, until, vals } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const RED = '#FF5C5C';
const AMBER = '#F7931A';
const RING = 'foxyRing 1.15s linear infinite';
const ROOT = path.join(__dirname, '..');
const markup = fs.readFileSync(path.join(ROOT, 'build', 'markup.html'), 'utf8');
const appText = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');

/* The words the card's screen draws: every string among its values, and those of its rows. */
const said = (v) => JSON.stringify(v, (k, x) => (typeof x === 'function' ? undefined : x));
const hist = (v) => v.fcMenuItems.filter((m) => m.label === 'HISTORY')[0] || {};

(async () => {
  /* ---- 1 to 3: a card a copy of which spent some of it, and money waiting for a card ------------------------------------------ */
  const H = await funded({}, 9000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const card = newCard(H, undefined, { format: 4 });
  await H.W.cardSetUp(card, { pin: '1234', recoverable: true });
  card.tap();
  await H.W.cardAdd(card, { sats: 2000, pin: '1234' });
  card.tap();
  const holder = appOn(H);
  await holder.refreshBalance();
  const twin = card.copy();
  twin.tap();
  await R.W.cardPay(twin, { sats: 300, pin: '1234' });
  await settle();
  const gone = 2000 - twin.balance();
  H.nfc = card;
  holder.goFlashcard();
  await until('the card to be read and the mint to answer', () => !!holder.state.fc && holder.state.fc.key === card.key && holder.state.fc.check && holder.state.fc.check.spent > 0);
  await settle();
  const spentWords = 'The mint says ' + holder.fcSats(gone, 'sat') + ' is already spent';

  let v = vals(holder);
  const words = said(v);
  ok(v.fcCheck === '' && !/already spent/i.test(words), '1  the mint’s word is not on the card’s screen', v.fcCheck);
  ok(v.fcVerified === undefined && v.fcVerifiedShown === undefined && !/Verified|Verifying/.test(words), '1  nor how fresh it is, under the title: the title is the card’s name alone', v.fcTitle);
  ok(v.fcLimitLine === undefined && v.fcLimitShown === undefined && !/LIMIT/.test(words.replace(/"LIMITS"/g, '')), '1  nor its limit under the card');
  ok(v.fcFaceLines === false && v.fcCardCap === '0px', '1  and the card has no line under it, so its picture has the room');
  ok(v.fcBalance === '₿ ' + holder.group(2000 - gone), '1  the balance is still what the card can spend, as the mint has answered', v.fcBalance);

  let rows = holder.fcHistNotes(holder.state.fc);
  ok(rows[0] && rows[0].kind === 'spent' && rows[0].name === spentWords && rows[0].line2 === 'WITHDRAW ALL or RESET clears it off the card'
     && rows[0].tileBg === 'var(--bad)' && rows[0].line2Color === 'var(--bad)', '2  the card’s HISTORY opens with the mint’s word, in red, and what clears it', rows[0] && rows[0].name);
  const ver = rows.filter((r) => r.kind === 'verified')[0];
  ok(!!ver && ver.name === 'Not Verified' && /ink-rgb/.test(ver.tileBg), '2  then how fresh the mint’s word is, in grey: Not Verified', ver && ver.name);
  const lim = rows.filter((r) => r.kind === 'limit')[0];
  ok(!!lim && lim.name === 'No limit' && /ink-rgb/.test(lim.tileBg), '2  and the card’s limit, in grey', lim && lim.name);
  ok(rows.every((r) => typeof r.open === 'function' && 'line2' in r && 'amtText' in r && 'stroke' in r), '2  each a row of the history’s own kind');

  ok(v.fcMenuRing === RING && v.fcMenuRingInk === RED, '3  the menu button turns, red, while the mint’s word stands', v.fcMenuRing + ' ' + v.fcMenuRingInk);
  ok(hist(v).ring === RING && hist(v).ringInk === RED && hist(v).labelInk === RED && /^alertGlow /.test(hist(v).glow), '3  and HISTORY in the menu glows red', JSON.stringify([hist(v).labelInk, hist(v).glow]));
  ok(v.fcMenuItems.filter((m) => m.label !== 'HISTORY').every((m) => m.ring === 'none' && m.glow === 'none' && m.labelInk === 'var(--ink)'), '3  and no other row');

  // money waiting to go onto another card as well: red wins, and the amber row is there
  const realOwed = H.W.cardOwed;
  const other = '02' + 'b7'.repeat(32);
  H.W.cardOwed = () => [{ card: other, sats: 255, out: true }];
  v = vals(holder);
  ok(v.fcMenuRingInk === RED && hist(v).labelInk === RED, '3  with money waiting as well, red wins', v.fcMenuRingInk);
  ok(!/waiting to go onto/.test(said(v)) && (v.fcNotes || []).length === 0, '1  and the money waiting is not on the card’s screen', said(v.fcNotes));
  rows = holder.fcHistNotes(holder.state.fc);
  const owedRow = rows.filter((r) => r.kind === 'owed')[0];
  ok(rows[0].kind === 'spent' && !!owedRow && owedRow.name === holder.fcSats(255, 'sat') + ' is waiting to go onto ' + holder.fcName(other)
     && owedRow.line2 === 'Press here, then tap that card.' && owedRow.tileBg === 'var(--btc-ink)', '2  it is the next row, in amber, naming the card', owedRow && owedRow.name);
  const asked = [];
  const writeAsk = holder.fcWriteAsk;
  holder.fcWriteAsk = (o) => asked.push(o);
  owedRow.open();
  holder.fcWriteAsk = writeAsk;
  ok(asked.length === 1 && JSON.stringify(asked[0]) === '{}', '2  and a press on it is the tap that puts it on, as the amber box’s was', JSON.stringify(asked));

  // the mint's word cleared (WITHDRAW ALL or RESET): amber alone
  const spentFc = holder.state.fc;
  holder.state.fc = Object.assign({}, spentFc, { check: 'ok', checkedAt: Date.now(), spentOn: false });
  v = vals(holder);
  ok(v.fcMenuRing === RING && v.fcMenuRingInk === AMBER && hist(v).ringInk === AMBER && hist(v).labelInk === AMBER && /^warnGlow /.test(hist(v).glow),
     '3  money waiting alone: the button turns amber, and HISTORY glows amber', JSON.stringify([v.fcMenuRingInk, hist(v).glow]));
  rows = holder.fcHistNotes(holder.state.fc);
  ok(rows[0].kind === 'owed' && rows.every((r) => r.kind !== 'spent') && /^Verified At /.test(rows.filter((r) => r.kind === 'verified')[0].name),
     '2  no red row, and the verified row says when', rows.map((r) => r.kind + ':' + r.name).join(' | '));
  // the same card owed: "this card"
  H.W.cardOwed = () => [{ card: card.key, sats: 255, out: true }];
  rows = holder.fcHistNotes(holder.state.fc);
  ok(rows[0].name === holder.fcSats(255, 'sat') + ' is waiting to go onto this card' && rows[0].line2 === 'Press here, then tap it.', '2  money owed to the card on show is for “this card”', rows[0].name);

  // both cleared: nothing turns, nothing glows
  H.W.cardOwed = () => [];
  v = vals(holder);
  ok(v.fcMenuRing === 'none' && v.fcMenuRingInk === 'transparent' && hist(v).ring === 'none' && hist(v).glow === 'none' && hist(v).labelInk === 'var(--ink)',
     '3  with neither, the button is still and HISTORY plain', JSON.stringify([v.fcMenuRing, hist(v).glow]));
  ok(holder.fcAlert(holder.state.fc) === '' && holder.fcAlert(spentFc) === 'red', '3  fcAlert: nothing, or red for the mint’s word');
  H.W.cardOwed = realOwed;

  // a card that waits for its limit: the limit row says it as its rate
  holder.state.fc = Object.assign({}, holder.state.fc, { tap: { limited: true, paced: true, limit: 3000 } });
  rows = holder.fcHistNotes(holder.state.fc);
  const rate = rows.filter((r) => r.kind === 'limit')[0];
  ok(!!rate && rate.name === 'Per second limit' && rate.amtText === holder.fcSpeedText(3000, 'sat', holder.fcKeptUsd(holder.state.fc)), '2  “Per second limit” with its rate', rate && rate.name + ' ' + rate.amtText);
  ok(!/PER SECOND/.test(said(vals(holder))), '1  and it is not on the card’s screen');
  holder.state.fc = Object.assign({}, holder.state.fc, { tap: { limited: true, paced: false, limit: 3000 }, pinSet: false });
  const tapRow = holder.fcHistNotes(holder.state.fc).filter((r) => r.kind === 'limit')[0];
  ok(tapRow.name === 'Per tap limit' && tapRow.amtText === holder.fcPrice(3000, 'sat') && tapRow.line2 === 'No PIN', '2  a per tap limit, and No PIN under it for a card with none', tapRow.name + ' / ' + tapRow.line2);
  ok(holder.fcLimitWords(holder.state.fc) === 'PER TAP LIMIT ' + holder.fcPrice(3000, 'sat') + ' | NO PIN', '2  its words as the card’s face had them', holder.fcLimitWords(holder.state.fc));
  holder.state.fc = Object.assign({}, holder.state.fc, { pin: 'blocked' });
  ok(holder.fcHistNotes(holder.state.fc).every((r) => r.kind !== 'limit' && r.kind !== 'verified'), '2  a blocked card has no limit or verified row');
  holder.state.fc = spentFc;

  /* ---- 2b: the amber row does what the box did, by the real write-ask: back to the card's screen, then the owner's own proof with
   * no PIN; and money for this card at another mint is a visit there for the tap, not A DIFFERENT MINT ---------------------------- */
  {
    const log = [];
    const keep = { run: holder.fcWriteRun, pin: holder.fcAskPin, move: holder.fcMoveWrite, card: holder.blockedCard };
    holder.fcWriteRun = (pin, o) => log.push('run ' + JSON.stringify(o));
    holder.fcAskPin = (o) => log.push('pin ' + o.title);
    holder.fcMoveWrite = () => log.push('visit');
    holder.blockedCard = (k) => log.push('card ' + k);
    const fromRow = async () => {
      holder.setState({ screen: 'flashcard', stack: ['home'] });
      holder.fcHistory();
      ok(holder.state.screen === 'history' && holder.state.histCard === card.key, '2b  HISTORY opened from the card');
      holder.fcHistNotes(holder.state.fc).filter((r) => r.kind === 'owed')[0].open();
      await settle();
      return log.splice(0).join(' ; ');
    };
    holder.state.fc = Object.assign({}, spentFc, { check: 'ok', checkedAt: Date.now() });
    const ownedAt = holder.state.fc.ownedHere;
    H.W.cardOwed = () => [{ card: card.key, sats: 255, out: true, mint: H.W.mintUrl }];
    holder.setState({ screen: 'flashcard', stack: ['home'] });
    holder.fcWriteAsk({});
    const fromBox = log.splice(0).join(' ; ');
    const said = await fromRow();
    ok(ownedAt === true && said === fromBox && said === 'run {"owner":true}' && holder.state.screen === 'flashcard',
       '2b  the owner’s card: the row goes back to the card’s screen and writes with the owner’s proof and no PIN, as the box did', said + ' / ' + fromBox);
    H.W.cardOwed = () => [{ card: card.key, sats: 255, out: true, mint: 'https://other.example' }];
    const away = await fromRow();
    ok(away === 'visit' && holder.state.screen === 'flashcard', '2b  money for the card at another mint: the row visits that mint for the tap, as the box did', away);
    H.W.cardOwed = realOwed;
    Object.assign(holder, { fcWriteRun: keep.run, fcAskPin: keep.pin, fcMoveWrite: keep.move, blockedCard: keep.card });
    holder.state.fc = spentFc;
    holder.setState({ screen: 'flashcard', stack: ['home'] });
  }

  /* ---- 2c: a card with no record has no menu and no HISTORY: the money waiting for a card is said on its screen, as before -------- */
  {
    H.W.cardOwed = () => [{ card: '02' + 'c4'.repeat(32), sats: 255, out: true }];
    holder.state.fc = Object.assign({}, spentFc, { hasRecord: false, setUp: false, pin: 'set' });
    v = vals(holder);
    ok(v.fcMenuShown === false && v.fcNotes.length === 1 && /is waiting to go onto CARD ··C4C4\. Press here, then tap that card\.$/.test(v.fcNotes[0].text),
       '2c  a card with no record: no menu, so the amber line stays on its screen', v.fcNotes.map((n) => n.text).join(' | '));
    H.W.cardOwed = realOwed;
    holder.state.fc = spentFc;
  }

  /* ---- 2d: pieces above the limit and change owed to the card are grey rows in its HISTORY, not lines on its screen -------------- */
  {
    holder.state.fc = Object.assign({}, spentFc, { above: 400, owes: { parts: [{ state: 'fetched', amount: 24 }] } });
    v = vals(holder);
    const kinds = holder.fcHistNotes(holder.state.fc);
    const ab = kinds.filter((r) => r.kind === 'above')[0];
    const ow = kinds.filter((r) => r.kind === 'owes')[0];
    ok(v.fcAboveShown === undefined && v.fcAboveLine === undefined && v.fcOwesShown === undefined && v.fcOwesLines === undefined && !/ABOVE THE LIMIT|CHANGE OWED/i.test(said(v)),
       '2d  the card’s screen says nothing of pieces above the limit or change owed');
    ok(!!ab && ab.name === 'In pieces above the limit' && ab.amtText === holder.fcPrice(400, 'sat') && ab.line2 === 'A till holds longer for those'
       && !!ow && ow.name === 'Change owed to this card' && ow.amtText === holder.fcBoth(24, 'sat') && ow.line2 === (holder.FC_OWES.fetched || ''),
       '2d  its HISTORY has them, grey', kinds.map((r) => r.kind + ':' + r.name + ' ' + r.amtText + ' / ' + r.line2).join(' | '));
    holder.state.fc = spentFc;
  }

  /* ---- 4: SWAP in the menu ----------------------------------------------------------------------------------------------- */
  {
    v = vals(holder);
    ok(v.fcButtons === undefined && v.fcRowShown === undefined && !v.fcMenuItems.some((m) => m.label === 'SWAP'), '4  a card of one currency: no SWAP anywhere, and no row under DEPOSIT and WITHDRAW');
    holder.state.fc = Object.assign({}, spentFc, { units: ['sat', 'usd'], bal: { sat: 500, usd: 120 }, ownedHere: true, owner: true, resetKnown: true, locked: false });
    v = vals(holder);
    const labels = v.fcMenuItems.map((m) => m.label);
    ok(labels.indexOf('SWAP') > labels.indexOf('TRANSFER') && labels.indexOf('SWAP') === labels.indexOf('RESET') - 1 && v.fcButtons === undefined,
       '4  a card of two currencies: SWAP in its menu, after TRANSFER and before RESET, and not on the screen', labels.join());
    const swaps = [];
    const fcSwap = holder.fcSwap;
    holder.fcSwap = () => swaps.push(1);
    holder.state.open0 = true;
    v.fcMenuItems.filter((m) => m.label === 'SWAP')[0].tap();
    ok(swaps.length === 1 && holder.state.open0 === false, '4  pressed, the menu shuts and the card’s swap opens');
    holder.state.fc = Object.assign({}, holder.state.fc, { bal: { sat: 0, usd: 0 } });
    vals(holder).fcMenuItems.filter((m) => m.label === 'SWAP')[0].tap();
    ok(swaps.length === 1 && holder.toasts.slice(-1)[0] === 'Put money on the card to swap.', '4  on a card that holds nothing it says why', holder.toasts.slice(-1)[0]);
    holder.fcSwap = fcSwap;
    holder.state.fc = spentFc;
  }

  /* ---- 6: the ring by the real paths: a typed withdrawal leaves the spent pieces on the card (still red); WITHDRAW ALL lets them go
   * (the ring stops, no red row) ------------------------------------------------------------------------------------------------ */
  {
    holder.setState({ screen: 'home', stack: [], fc: null });
    card.tap();
    H.nfc = card;
    holder.goFlashcard();
    await until('the card read again, the mint’s word on it', () => !!holder.state.fc && holder.state.fc.key === card.key && holder.state.fc.check && holder.state.fc.check.spent > 0);
    await settle();
    ok(vals(holder).fcMenuRingInk === RED, '6  red before', vals(holder).fcMenuRingInk);
    card.tap();
    holder.fcWithdrawRun(500, '1234', 0, undefined, 'sat');
    await until('the 500 to come off', () => !(holder._fcTaps > 0) && card.balance() <= 2000 - 500 && !!holder.state.fc && holder.state.fc.check && holder.state.fc.check !== 'asking', 20000);
    await settle();
    ok(vals(holder).fcMenuRingInk === RED && holder.fcHistNotes(holder.state.fc)[0].kind === 'spent', '6  a typed withdrawal leaves the spent pieces on the card: still red, the red row first',
       JSON.stringify(holder.state.fc && holder.state.fc.check));
    card.tap();
    holder.fcWithdrawRun(0, '1234', 0, undefined, 'sat');
    await until('everything to come off', () => !(holder._fcTaps > 0) && card.balance() === 0 && !!holder.state.fc && holder.state.fc.balance === 0, 20000);
    await settle(); await settle();
    v = vals(holder);
    ok(v.fcMenuRing === 'none' && v.fcMenuRingInk === 'transparent' && !holder.fcHistNotes(holder.state.fc).some((r) => r.kind === 'spent') && hist(v).glow === 'none',
       '6  WITHDRAW ALL lets the spent pieces go: the ring stops, HISTORY is plain, and there is no red row', JSON.stringify([v.fcMenuRingInk, holder.state.fc.check]));
  }

  /* ---- 5: the history screen and the markup ------------------------------------------------------------------------------ */
  {
    const method = (sig) => {
      const at = appText.indexOf('\n  ' + sig);
      if (at < 0) throw new Error('missing ' + sig);
      let i = appText.indexOf('{', at), depth = 0;
      for (; i < appText.length; i++) { if (appText[i] === '{') depth++; else if (appText[i] === '}') { depth--; if (depth === 0) break; } }
      return appText.slice(at + 3, i + 1);
    };
    const a = new Function('return {' + method('renderHistory(c) {') + '}')();
    const saved = { CTA_INK: global.CTA_INK, window: global.window };
    global.CTA_INK = () => '#fff';
    global.window = { FoxyWallet: {} };
    Object.assign(a, {
      histAudit: () => ({ balOf: new Map(), balNow: 0, run: 0, dueChange: 0, dueCount: 0, off: 0, flagged: new Map(), toShowCount: 0, toShowSats: 0 }),
      stageMoney: (n) => '₿ ' + n, money: (n) => ({ main: '₿ ' + n, sub: '' }), txFiat: () => 0, px: () => 0, group: (n) => String(n),
      topUpFeeSats: () => 0, recoveringSats: () => 0, unitMoney: (n) => String(n), unitLabel: (u) => u, txTotalOut: () => 0, txTotalUnit: () => 0,
      openTx: () => {}, openPendingSplit: () => {}, goSwitchMint: () => {}, go: () => {}, setState: () => {}, histRef: () => {},
      fcHistNotes: (fc) => [{ kind: 'spent', name: 'of ' + fc.key }],
    });
    const at = (stack, key) => a.renderHistory({ s: { screen: 'history', stack, histCard: 'K1', fc: { key }, histFilter: 'all', history: [], historyComplete: true }, sc: 'history' });
    ok(at(['home', 'flashcard'], 'K1').histNotes.length === 1 && at(['home', 'flashcard'], 'K1').histNotes[0].name === 'of K1', '5  the card’s own list carries its rows');
    ok(at(['home'], 'K1').histNotes.length === 0 && at(['home', 'flashcard'], 'K2').histNotes.length === 0, '5  home’s list, or another card’s, carries none');
    ok(at(['home', 'flashcard'], 'K1').historyEmpty === false && at(['home'], 'K1').historyEmpty === true,
       '5  a card’s list with rows of its own and no payments does not say NOTHING TO SEE YET! under them; an empty list still does');
    global.CTA_INK = saved.CTA_INK; global.window = saved.window;

    const fcT = markup.slice(markup.indexOf('<sc-if value="{{ isFlashcard }}">'), markup.indexOf('<sc-if value="{{ isFieldLog }}">'));
    ok(fcT.length > 1000 && !/fcVerified|fcLimitLine|fcLimitShown|fcRowShown|fcButtons/.test(fcT), '5  the card screen’s markup draws none of the lines, and no row of buttons');
    ok(/<div data-card-menu-ring style="[^"]*border-top-color:\{\{ fcMenuRingInk \}\};border-right-color:\{\{ fcMenuRingInk2 \}\};animation:\{\{ fcMenuRing \}\};pointer-events:none"><\/div><div sc-camel-on-click="\{\{ toggleMenu \}\}" role="button" aria-label="Menu"/.test(fcT),
       '5  the card’s menu button has the ring, as home’s has');
    const menuT = fcT.slice(fcT.indexOf('{{ fcMenuItems }}'));
    ok(/color:\{\{ m\.labelInk \}\}[^>]*>\{\{ m\.label \}\}/.test(menuT) && /animation:\{\{ m\.glow \}\}/.test(menuT) && /animation:\{\{ m\.ring \}\}/.test(menuT), '5  and its menu rows their colour, glow and ring');
    ok(/@keyframes warnGlow\{/.test(markup), '5  the amber glow is defined');
    const hT = markup.slice(markup.indexOf('<sc-if value="{{ isHistory }}">'));
    const notesAt = hT.indexOf('<sc-for list="{{ histNotes }}"');
    ok(notesAt > 0 && notesAt < hT.indexOf('<sc-for list="{{ historyGroups }}"') && /data-hist-note="\{\{ n\.kind \}\}" sc-camel-on-click="\{\{ n\.open \}\}"/.test(hT)
       && /\{\{ n\.line2 \}\}/.test(hT) && /\{\{ n\.amtText \}\}/.test(hT), '5  the history draws the rows above the payments, in the payments’ own style');
  }

  await settle();
  console.log(failed ? failed + ' failed' : 'all card-notice checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
