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
 * Two parts:
 *   the screens   driven as a person drives them (flashcard-ui-kit.js) against the real wallet, a test mint and the model of
 *                 the card: the defaults and the three times rule, NO CONNECTION before the tap with no sheet opened, TRY AGAIN
 *                 and BACK with every entry kept, a route lost between NEXT and the tap, TAP TO FINISH, and the card set up
 *                 with what was chosen once the route is back;
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
