'use strict';
/* card-setup.js — a card's set-up that survives a missing connection, its defaults, and the keypad in dollars offline.
 *
 *     node tests/card-setup.js
 *
 * The keeper's words (2026-11-08): the set-up's tap with no connection said so and went back to the start, every entry lost;
 * it should look at the connection before asking for the tap, say to connect, and let a failed tap be tried again without
 * starting over; the limits' keypad showed sats offline where dollars are the default; the second amount is NO PIN MAXIMUM,
 * three times the no-PIN amount by default, the no-PIN amount $10 and the rate $10 a second; and the tap says TAP TO FINISH.
 *
 * Three parts:
 *   the screens   driven as a person drives them (flashcard-ui-kit.js) against the real wallet, a test mint and the model of
 *                 the card: the defaults and the three times rule, NO CONNECTION before the tap with no sheet opened, TRY AGAIN
 *                 and BACK with every entry kept, a route lost between NEXT and the tap, TAP TO FINISH, and the card set up
 *                 with what was chosen once the route is back;
 *   the price     figures typed in dollars offline are written at the tap's price, under a day old, or refused (NO BITCOIN
 *                 PRICE): the set-up, CARD LIMITS and SEND > FLASHCARD; TRY AGAIN with another card is THAT IS ANOTHER CARD;
 *                 the kept entries are forgotten as Foxy locks or is put away;
 *   the keypad    `syncUnit` (09-melt-paste-switch.js) lifted out of the app: a limit's keypad stays in dollars offline at the
 *                 last price seen, a dollar card's never goes to sats, sats only where no price was ever seen, and a send
 *                 offline is still in sats. */
const fs = require('fs');
const path = require('path');
const { funded, newCard } = require('./flashcard-kit');
const { appOn, until, pad, card, settle, speed, named, welcome, watchBehind } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const hexOf = (pin) => Buffer.from(pin, 'latin1').toString('hex');

// SET AMOUNT while the set-up asks one of its amounts: which, the unit, what is typed, whether it is the default
function amt(a) {
  const s = a.state;
  if (s.screen !== 'amount' || !/^cardSu(NoPinTx|NoPin|Tap)$/.test(String(s.flow))) return null;
  return {
    flow: s.flow, unit: s.unit, amount: s.amount, dflt: !!s.amountDefault,
    // a figure typed by hand (the first key clears the default, 19-update-keypad-balance.js `press`)
    type(fig) { a.setState({ amount: String(fig), amountDefault: false }); return amt(a); },
    next() { a.fcAmountNext(); },
    back() { a.back(); },
  };
}

const down = (c) => c.W._privacy({ tor: 'stopped', network: 'none', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
const up = (c) => c.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });

(async () => {
  /* ======== the screens =========================================================================================== */
  {
    const H = await funded({}, 20000);
    H.W._routeWaitMs = 0;
    up(H);
    const a = appOn(H);
    a.price = 60000;
    await a.refreshBalance();
    const c = newCard(H, undefined, { format: 4, software: 22 });
    H.nfc = c;
    a.goFlashcard();
    await until('the new card to be read', () => !!a.state.fc);
    welcome(a).press('SET UP CARD');
    named(a).type('Lunch card').next();
    pad(a).type('2580');
    pad(a).type('2580');

    let s = amt(a);
    ok(s && s.flow === 'cardSuNoPinTx' && s.unit === 'USD' && s.amount === '10.00' && s.dflt,
       'NO PIN AMOUNT comes up at $10.00, in dollars, as the default', JSON.stringify(s));
    s.next();
    s = amt(a);
    ok(s && s.flow === 'cardSuNoPin' && s.unit === 'USD' && s.amount === '30.00' && s.dflt,
       'the second amount comes up at three times it, $30.00', JSON.stringify(s));
    ok(a.fcSuDayWords().title === 'NO PIN MAXIMUM' && a.fcSuDayWords().question === 'What’s the most this card should pay in total before asking for a PIN?',
       'titled NO PIN MAXIMUM, with the keeper’s question', JSON.stringify(a.fcSuDayWords()));
    s.back();
    amt(a).type('4.00').next();
    s = amt(a);
    ok(s && s.flow === 'cardSuNoPin' && s.amount === '12.00' && s.dflt,
       'NO PIN AMOUNT changed to $4.00: NO PIN MAXIMUM follows it, $12.00, while it is not typed by hand', JSON.stringify(s));
    s.type('50.00').next();
    let sp = speed(a);
    ok(sp && sp.mode === 'su' && sp.chosen === '$10' && sp.figure === '10',
       'MAX PER SECOND comes up at $10 a second', JSON.stringify(sp));
    sp.back();
    s = amt(a);
    ok(s && s.flow === 'cardSuNoPin' && s.amount === '50.00', 'back on NO PIN MAXIMUM: the $50.00 typed by hand', JSON.stringify(s));
    s.back();
    amt(a).type('6.00').next();
    s = amt(a);
    ok(s && s.amount === '50.00', 'and once typed by hand it no longer follows NO PIN AMOUNT ($6.00 does not make it $18.00)', JSON.stringify(s));
    s.next();
    ok(a._fcSu && a._fcSu.noPin === Math.round(50 / 60000 * 1e8) && a._fcSu.noPinUsd === 50 && a._fcSu.noPinTxUsd === 6,
       'NEXT on the figure as it came back keeps it, in dollars for a bitcoin card', JSON.stringify(a._fcSu && [a._fcSu.noPin, a._fcSu.noPinUsd]));
    speed(a).pick(25);

    // no route: NO CONNECTION, no sheet, every entry kept
    down(H);
    H.sheet.length = 0;
    speed(a).next();
    await settle();
    let k = card(a);
    ok(k && k.title === 'NO CONNECTION' && k.has('TRY AGAIN') && k.has('BACK') && !k.has('CANCEL') && H.sheet.length === 0 && !c.state.owner,
       'with no route, NEXT on MAX PER SECOND says NO CONNECTION before any tap is asked for: TRY AGAIN and BACK, no sheet opened', k && k.all);
    ok(k && k.reason === H.W.routeWords() && k.reason.length > 0, 'in the wallet’s own words for the missing route', k && k.reason);
    k.press('TRY AGAIN');
    await settle();
    k = card(a);
    ok(k && k.title === 'NO CONNECTION' && H.sheet.length === 0, 'TRY AGAIN with the route still down: NO CONNECTION again, still no sheet', k && k.all);
    k.press('BACK');
    sp = speed(a);
    ok(sp && sp.mode === 'su' && sp.chosen === '$25' && a._fcSu && a._fcSu.pin === '2580' && a._fcSu.noPinUsd === 50 && a._fcSu.noPinTxUsd === 6,
       'BACK is MAX PER SECOND again, at the $25 chosen, with the PIN and both amounts kept', JSON.stringify(sp));
    sp.back();
    ok(amt(a) && amt(a).amount === '50.00', 'and a step further back, NO PIN MAXIMUM as it was typed');
    amt(a).next();
    speed(a).next();
    await settle();
    k = card(a);
    ok(k && k.title === 'NO CONNECTION', 'NO CONNECTION again');
    // the card tapped beside: the same as BACK, nothing lost
    a._blockedEl.dispatchEvent(new (H.window.Event)('click', { bubbles: false }));
    await settle();
    ok(!card(a) && speed(a) && speed(a).chosen === '$25' && a._fcSu && a._fcSu.noPinUsd === 50, 'the card tapped beside goes back to MAX PER SECOND too, nothing lost',
       JSON.stringify(speed(a)));

    // the route back, and lost again between NEXT and the tap: the tap fails in the wallet's words, and comes back with TRY AGAIN
    up(H);
    const tap = a.fcTap.bind(a);
    let once = true;
    a.fcTap = (o, fn) => { if (once) { once = false; down(H); } return tap(o, fn); };
    const seen = watchBehind(a, H);
    speed(a).next();
    await until('the failed tap’s card', () => !!card(a));
    seen.stop();
    k = card(a);
    ok(k && k.title === 'NO CONNECTION' && k.has('TRY AGAIN') && k.has('BACK') && !c.state.owner && c.state.pin !== hexOf('2580'),
       'a route lost between NEXT and the tap: NO CONNECTION, TRY AGAIN and BACK, nothing written to the card', k && k.all);
    ok(seen.titles().split(' > ')[0] === 'TAP TO FINISH', 'the screen behind the sheet asked TAP TO FINISH', seen.titles());
    a.fcTap = tap;
    up(H);
    H.sheet.length = 0;
    k.press('TRY AGAIN');
    await until('the card to be set up', () => !!c.state.owner && a.state.fc && a.state.fc.ownedHere === true);
    ok(c.state.pin === hexOf('2580') && c.state.noPinLimit === Math.round(50 / 60000 * 1e8) && c.state.tapLimit === Math.round(25 / 60000 * 1e8),
       'TRY AGAIN with the route back sets the card up with every entry as chosen: the PIN, $50.00 without it and $25 a second',
       JSON.stringify([c.state.noPinLimit, c.state.tapLimit]));
    ok(JSON.stringify(H.W.cardNoPinTx(c.key)) === JSON.stringify({ n: Math.round(6 / 60000 * 1e8), unit: 'sat', usd: 6 }) && H.W.cardName(c.key) === 'LUNCH CARD',
       'and NO PIN AMOUNT ($6.00) and the name are kept on this phone', JSON.stringify([H.W.cardNoPinTx(c.key), H.W.cardName(c.key)]));
    ok(!a._fcSuLast && !a._fcSu, 'written: nothing of the set-up is left to come back to');
  }

  /* ---- a sheet cancelled at the tap comes back to the last step ---------------------------------------------------- */
  {
    const H = await funded({}, 20000);
    H.W._routeWaitMs = 0;
    up(H);
    const a = appOn(H);
    a.price = 60000;
    await a.refreshBalance();
    const c = newCard(H, undefined, { format: 4, software: 25 });
    H.nfc = c;
    a.goFlashcard();
    await until('the new card to be read', () => !!a.state.fc);
    welcome(a).press('SET UP CARD');
    named(a).skip();
    pad(a).type('1357');
    pad(a).type('1357');
    amt(a).next();
    ok(a.fcSuDayWords().title === 'NO PIN MAXIMUM' && a.fcSuDayWords().question === 'What’s the most this card should pay in 24 hours before asking for a PIN?',
       'a card of 1.25, whose allowance fills again every 24 hours: NO PIN MAXIMUM, in 24 hours', JSON.stringify(a.fcSuDayWords()));
    amt(a).next();
    H.nfc = null;
    speed(a).next();
    await settle();
    ok(!card(a) && speed(a) && speed(a).chosen === '$10' && a._fcSu && a._fcSu.pin === '1357' && a._fcSu.noPinTxUsd === 10 && a._fcSu.noPinUsd === 30,
       'the sheet ended with no card: back on MAX PER SECOND, every entry kept ($10.00, $30.00, $10 a second)', JSON.stringify(speed(a)));
  }

  /* ---- figures typed offline at an old price are written at the price of the tap ------------------------------------- */
  /* Offline the keypads stay in dollars at the last price seen, of any age. The sats those dollars made at NEXT were written as
   * they were once the route came back: typed at 30,000 and tapped at 60,000, the card took $60 where $30 was meant. Now the
   * dollars are worked out again at the tap, at a price under a day old, and with none the set-up is refused. */
  const offlineSetUp = async (o) => {
    const H = await funded({}, 20000);
    H.W._routeWaitMs = 0;
    up(H);
    const a = appOn(H);
    a.price = 60000;
    await a.refreshBalance();
    const c = newCard(H, undefined, { format: 4, software: 22 });
    H.nfc = c;
    a.goFlashcard();
    await until('the new card to be read', () => !!a.state.fc);
    welcome(a).press('SET UP CARD');
    if (o && o.name) named(a).type(o.name).next(); else named(a).skip();
    pad(a).type('2580');
    pad(a).type('2580');
    down(H);
    a.price = 30000;
    amt(a).next();
    amt(a).next();
    speed(a).next();
    await settle();
    return { H, a, c };
  };
  {
    const { H, a, c } = await offlineSetUp();
    ok(a._fcSuLast && a._fcSuLast.noPin === Math.round(30 / 30000 * 1e8) && card(a) && card(a).title === 'NO CONNECTION',
       'typed offline at the last price seen (30,000): NO CONNECTION, the sats of $30.00 at that price kept', JSON.stringify(a._fcSuLast && a._fcSuLast.noPin));
    up(H);
    a.price = 60000;
    H.sheet.length = 0;
    card(a).press('TRY AGAIN');
    await until('the card to be set up', () => !!c.state.owner && a.state.fc && a.state.fc.ownedHere === true, 8000).catch(() => {});
    const at = (d) => Math.round(d / 60000 * 1e8);
    ok(c.state.noPinLimit === at(30) && c.state.tapLimit === at(10),
       'TRY AGAIN at 60,000: the card holds $30.00 without its PIN and $10 a second at today’s price, not twice that',
       JSON.stringify([c.state.noPinLimit, c.state.tapLimit]));
    ok(JSON.stringify(H.W.cardNoPinTx(c.key)) === JSON.stringify({ n: at(10), unit: 'sat', usd: 10 }),
       'and NO PIN AMOUNT, $10.00, is kept on this phone at today’s price too', JSON.stringify(H.W.cardNoPinTx(c.key)));

    // CARD LIMITS, typed in dollars at an old price: written at today's
    await settle();
    a.state.fc = a.state.fc || {};
    a.fcLimitRun(Math.round(40 / 30000 * 1e8), 'nopin', 40);
    await until('the no PIN maximum to be written', () => c.state.noPinLimit !== at(30), 8000).catch(() => {});
    ok(c.state.noPinLimit === at(40), 'CARD LIMITS: a no PIN maximum of $40.00 typed at 30,000 is written at 60,000, $40.00 worth',
       JSON.stringify([c.state.noPinLimit, at(40), card(a) && card(a).all]));
    // and at a price more than a day old: refused, nothing written
    const was = c.state.noPinLimit;
    H.W._rate = 60000;
    H.W._rateAt = Date.now() - 25 * 3600 * 1000;
    a.fcLimitRun(Math.round(50 / 30000 * 1e8), 'nopin', 50);
    await settle();
    ok(card(a) && card(a).title === 'NO BITCOIN PRICE' && c.state.noPinLimit === was,
       'CARD LIMITS with only a price more than a day old: NO BITCOIN PRICE, the card as it was', card(a) && card(a).all);
  }
  {
    // a price more than a day old at the set-up's tap: NO BITCOIN PRICE, nothing written, the entries kept; a fresh price, written
    const { H, a, c } = await offlineSetUp();
    up(H);
    a.price = 60000;
    H.W._rate = 60000;
    H.W._rateAt = Date.now() - 25 * 3600 * 1000;
    H.sheet.length = 0;
    card(a).press('TRY AGAIN');
    await settle();
    let k = card(a);
    ok(k && k.title === 'NO BITCOIN PRICE' && k.has('TRY AGAIN') && k.has('BACK') && !c.state.owner && H.sheet.length === 0,
       'TRY AGAIN with only a price more than a day old: NO BITCOIN PRICE with TRY AGAIN and BACK, no tap asked for, nothing written', k && k.all);
    H.W._rateAt = Date.now();
    k.press('TRY AGAIN');
    await until('the card to be set up', () => !!c.state.owner && a.state.fc && a.state.fc.ownedHere === true, 8000).catch(() => {});
    ok(c.state.noPinLimit === Math.round(30 / 60000 * 1e8), 'and with a fresh price, set up at it', String(c.state.noPinLimit));
  }
  {
    // TRY AGAIN with another blank card held up: refused, nothing written to it; the first card then takes its own entries
    const { H, a, c } = await offlineSetUp({ name: 'Card A' });
    const c2 = newCard(H, undefined, { format: 4, software: 22 });
    H.nfc = c2;
    up(H);
    a.price = 60000;
    H.sheet.length = 0;
    card(a).press('TRY AGAIN');
    await until('the second card to be refused', () => !!(card(a) && card(a).title !== 'NO CONNECTION'), 8000).catch(() => {});
    let k = card(a);
    ok(k && k.title === 'THAT IS ANOTHER CARD' && k.has('TRY AGAIN') && k.has('BACK') && !c2.state.owner && c2.state.pin !== hexOf('2580'),
       'TRY AGAIN with another card held up: THAT IS ANOTHER CARD, nothing written to it', k && k.all);
    H.nfc = c;
    k.press('TRY AGAIN');
    await until('the first card to be set up', () => !!c.state.owner && a.state.fc && a.state.fc.ownedHere === true, 8000).catch(() => {});
    ok(!!c.state.owner && c.state.pin === hexOf('2580') && H.W.cardName(c.key) === 'CARD A' && !c2.state.owner,
       'TRY AGAIN with the first card: set up, with its name', JSON.stringify([!!c.state.owner, H.W.cardName(c.key)]));
  }
  {
    // the kept entries, its PIN among them, are forgotten as Foxy locks: TRY AGAIN then writes nothing
    const { H, a, c } = await offlineSetUp();
    const kept = a._fcSuLast;
    a.fcSuForget();
    ok(!a._fcSuLast && kept && kept.pin === '', 'forgotten: no entries kept, and the PIN blanked in the record that was');
    up(H);
    a.price = 60000;
    H.sheet.length = 0;
    card(a).press('TRY AGAIN');
    await settle();
    ok(!c.state.owner && H.sheet.length === 0 && a.toasts.indexOf('The set-up was closed. Start it again.') >= 0,
       'TRY AGAIN after: nothing asked of the card, and the person told to start again', a.toasts.join('|'));
  }
  {
    // a set-up still being typed, its PIN in it: the lock drops it and leaves its steps
    const H = await funded({}, 20000);
    H.W._routeWaitMs = 0;
    up(H);
    const a = appOn(H);
    a.price = 60000;
    await a.refreshBalance();
    const c = newCard(H, undefined, { format: 4, software: 22 });
    H.nfc = c;
    a.goFlashcard();
    await until('the new card to be read', () => !!a.state.fc);
    welcome(a).press('SET UP CARD');
    named(a).skip();
    pad(a).type('2580');
    pad(a).type('2580');
    amt(a).next();
    amt(a).next();
    const typing = a._fcSu;
    ok(typing && typing.pin === '2580' && speed(a), 'on MAX PER SECOND, the set-up holds the PIN typed');
    H.W.pinSet('1111');
    a.pinLock();
    await settle();
    ok(!a._fcSu && !a._fcSuLast && typing.pin === '' && a.state.screen === 'flashcard',
       'the lock comes up: the set-up being typed is dropped, its PIN blanked, back on the card’s screen', JSON.stringify([!!a._fcSu, a.state.screen]));
    if (a._pinEl) a.pinDismiss();
  }
  {
    // the lock itself forgets them (10-pin.js `pinLock`)
    const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '10-pin.js'), 'utf8');
    const away = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '07-history-tokens-mints.js'), 'utf8');
    const lock = src.slice(src.indexOf('\n  pinLock() {'), src.indexOf('this._pinLocked = true;', src.indexOf('\n  pinLock() {')));
    const put = away.slice(away.indexOf('\n  putAway(on) {'), away.indexOf('\n  }', away.indexOf('\n  putAway(on) {')));
    ok(/this\.fcSuForget\(\)/.test(lock) && /this\.fcSuForget\(\)/.test(put), 'the lock and a put-away both forget a set-up’s kept entries');
  }
  {
    // SEND > FLASHCARD in dollars to a bitcoin card: its sats worked out again at the tap's price, not at NEXT's
    const H = await funded({}, 20000);
    const a = appOn(H);
    a.price = 60000;
    let asked = null;
    a.fcSendGuard = () => {};
    H.W.cardUnits = () => null;
    H.W.cardPrepare = (cd, n) => { asked = n; return Promise.resolve({}); };
    const alt = { sats: Math.round(10 / 30000 * 1e8), have: 1e9 };
    a.fcSendPrepare({ record: { unit: 'sat' } }, 1000, 'usd', alt);
    ok(asked === Math.round(10 / 60000 * 1e8), '$10.00 sent to a bitcoin card, typed at 30,000: loaded with $10.00 of sats at 60,000', String(asked));
    asked = null;
    H.W._rate = 60000;
    H.W._rateAt = Date.now() - 25 * 3600 * 1000;
    let threw = null;
    try { a.fcSendPrepare({ record: { unit: 'sat' } }, 1000, 'usd', { sats: 33333, have: 1e9 }); } catch (e) { threw = e; }
    ok(asked === null && threw && threw.card === 'wrong-unit', 'with only a price more than a day old: refused, nothing loaded', threw && threw.message);
  }

  /* ======== the keypad ============================================================================================ */
  {
    const app = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
    const body = (sig) => {
      const at = app.indexOf('\n  ' + sig);
      if (at < 0) throw new Error('missing ' + sig);
      let i = app.indexOf('{', at), depth = 0;
      for (; i < app.length; i++) { if (app[i] === '{') depth++; else if (app[i] === '}') { depth--; if (depth === 0) break; } }
      return app.slice(at + 3, i + 1);
    };
    const K = new Function('return class {\n' + body('syncUnit() {') + '\n};')();
    const put = (o) => {
      const k = new K();
      k.state = Object.assign({ screen: 'amount', unit: 'USD', amount: '' }, o.state);
      k.offlineNow = () => o.offline !== false;
      k.satUsd = () => (o.price === undefined ? 84000 / 1e8 : o.price);
      k.px = () => (k.satUsd() || 0) * 1e8;
      k.unitPx = k.px;
      k.keypadLocked = () => !!o.locked;
      k.walletNow = () => 'sat';
      k.setState = (u) => Object.assign(k.state, typeof u === 'function' ? u(k.state) : u);
      k.syncUnit();
      return k.state.unit;
    };
    ['cardSuNoPinTx', 'cardSuNoPin', 'cardSuTap', 'cardLimit', 'cardLimitTx', 'tillCap', 'tillTip'].forEach((flow) => {
      ok(put({ state: { flow } }) === 'USD', 'offline, ' + flow + '’s keypad stays in dollars at the last price seen');
    });
    ok(put({ state: { flow: 'cardSuNoPin' }, price: null }) === 'SATS', 'and goes to sats only where this phone never saw a price');
    ok(put({ state: { flow: 'cardSuNoPinTx' }, price: null, locked: true }) === 'USD' && put({ state: { flow: 'cardAdd' }, price: null, locked: true }) === 'USD',
       'a dollar card’s own amounts stay in dollars with no price at all: they need none');
    ok(put({ state: { flow: 'send' } }) === 'SATS' && put({ state: { flow: 'cardAdd' } }) === 'SATS' && put({ state: { flow: 'transfer' } }) === 'SATS',
       'a payment offline is still in sats: a send, money onto a bitcoin card, a transfer');
    ok(put({ state: { flow: 'cardLimit' }, offline: false }) === 'USD', 'and online nothing changes');
  }

  if (until.failed) failed += until.failed;
  console.log(failed ? failed + ' card-setup checks failed' : 'all card-setup checks pass');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
