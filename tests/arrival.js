'use strict';
/* arrival.js — a card that opened Foxy on its first run, kept until home.
 *
 *     node tests/arrival.js
 *
 * A person without Foxy taps a card, is sent to get it, installs it, and taps the
 * card again. That address opens a Foxy with no wallet: the phone keeps it as an
 * arrival (Foxy/Flashcard/CardTapDelivery.swift, `Arrival`; its rules are
 * FoxyTests') and asks the page about it, `FoxyWallet._arrived(kind, code)`, every
 * half second until the page answers shown or over. The first run goes on exactly
 * as it does without one (the launch, the notices, what to hold), and the moment
 * home is first reached the card is asked for, as CARD on home asks for it: the
 * phone's sheet, and a new card read is WELCOME TO YOUR CASHU CARD. Then it is
 * gone, and a card is a tap again.
 *
 * The page's side, 26f-flashcard.js (`arrived`, `arrivalHomeNow`, `arrivalWatch`),
 * run with the card's screens, the cards and the question of what to hold
 * (tests/flashcard-ui-kit.js) against the real wallet, a test mint and a new card.
 * The phone's asking is played here by `ask`: what the page answers to the call
 * the phone makes. */
const fs = require('fs');
const path = require('path');
const { funded, newCard } = require('./flashcard-kit');
const { appOn, settle, welcome, card } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (!good && detail !== undefined ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 60000).unref();

/* A first run on a phone with a new card in reach: the app's parts, the gate's screens up (`gate.up`), a mint with two
 * balances unless `one`, and every screen the app goes to written down (`screens`). The phone's call is `ask`: null until
 * the page has put `_arrived` on its wallet, as a page that has not booted answers nothing. */
async function firstRun(o) {
  const opts = o || {};
  const ctx = opts.ctx || await funded({}, 0);
  ctx.nfc = newCard(ctx);
  const gate = { up: true };
  ctx.window.FoxyGate = { visible: () => gate.up };
  const app = appOn(ctx);
  app.ARRIVAL_SETTLE_MS = 40;
  app.ARRIVAL_POLL_MS = 10;
  let held = '';
  app.twoUnitsOn = () => !opts.one;
  app.walletChoiceNow = () => ({ hold: held });
  ctx.W.setWalletChoice = (p) => { held = p.hold; };
  const screens = [];
  const set = app.setState;
  app.setState = (x) => {
    set(x);
    if (screens[screens.length - 1] !== app.state.screen) screens.push(app.state.screen);
  };
  const W = ctx.W;
  delete W._arrived;
  const ask = (kind, code) => (W._arrived ? W._arrived(kind === undefined ? 'card' : kind, code === undefined ? '' : code) : null);
  /* What bootWallet does once the lock is decided (06-wallet-boot-and-restore.js, checked below to say so). */
  const boot = () => { W._arrived = (kind, code) => app.arrived(kind, code); app.arrivalWatch(); };
  /* The gate down and the mint answered: walletReady's home (09-melt-paste-switch.js), its notice over home, and the
   * question of what to hold a moment later. */
  const ready = () => {
    gate.up = false;
    app._readyAt = Date.now();
    app.setState({ screen: 'home', stack: [] });
    app.blockedCard('custody', { tone: 'warn', title: 'THE MINT HOLDS YOUR BITCOIN', reason: 'Ecash in this wallet is issued by a mint.' });
  };
  const custodyRead = () => app.dismissCard('custody');
  const holdAsked = () => app.offerHoldChoice();
  const holdAnswered = (h) => { app.setState({ holdPick: h || 'usd' }); app.holdDone(); };
  return { ctx, app, gate, screens, ask, boot, ready, custodyRead, holdAsked, holdAnswered, held: () => held };
}

(async () => {
  /* ---- bootWallet puts the call on the wallet, beside the card's tap ---- */
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '06-wallet-boot-and-restore.js'), 'utf8');
    const tap = src.indexOf('W._cardTapped = () => this.cardTapped();');
    const arr = src.indexOf('W._arrived = (kind, code) => this.arrived(kind, code);');
    ok(tap > 0 && arr > tap && src.indexOf('this.arrivalWatch();', arr) > arr,
       'bootWallet puts _arrived on the wallet once the lock is decided, beside _cardTapped, and starts watching for home');
  }

  /* ---- the card's address before the set-up: kept through it, WELCOME TO YOUR CASHU CARD the first thing after home ---- */
  {
    const r = await firstRun();
    const { app, ctx, ask } = r;
    ok(ask() === null, 'before the page has booted it answers nothing, and the phone asks again');
    r.boot();
    ok(ask() === 'keep', 'booted, the launch’s screens up: kept');
    r.ready();
    ok(ask() === 'keep' && card(app) && card(app).title === 'THE MINT HOLDS YOUR BITCOIN', 'home, with the mint’s notice over it: kept');
    r.custodyRead();
    ok(ask() === 'keep', 'the notice read, the question of what to hold still to come: kept');
    r.holdAsked();
    ok(app.state.screen === 'holdChoice' && ask() === 'keep', 'CURRENCIES up: kept, and the question is asked exactly as without a card');
    ok(r.screens.indexOf('flashcard') < 0 && ctx.sheet.length === 0, 'nothing of the card yet: no screen, no sheet');
    const before = r.screens.length;
    r.holdAnswered('usd');
    ok(r.held() === 'usd' && app.state.screen === 'home', 'the answer kept, and home');
    await sleep(60);
    ok(ask() === 'shown', 'home reached: shown');
    ok(r.screens.slice(before).join(' > ') === 'home > flashcard', 'the card’s screen is the first thing after home', r.screens.slice(before).join(' > '));
    ok(/^begin: Tap behind the phone\.$/.test(ctx.sheet[0] || ''), 'asking for the card with the phone’s own sheet, as CARD on home does', ctx.sheet[0]);
    await settle();
    const w = welcome(app);
    ok(!!w && w.buttons === 'SET UP CARD,CANCEL', 'the new card read: WELCOME TO YOUR CASHU CARD, SET UP CARD and CANCEL', JSON.stringify(w));
    ok(ask() === 'over' && !app._arrival, 'cleared once shown: the phone is told the first run is over, and a card is a tap again');
    const sheets = ctx.sheet.length;
    await sleep(40);
    ok(ctx.sheet.length === sheets && app.state.screen === 'flashcard', 'and it is not opened a second time');
  }

  /* ---- the address during the set-up, with the question of what to hold up ---- */
  {
    const r = await firstRun();
    const { app, ask } = r;
    r.boot();
    r.ready();
    r.custodyRead();
    r.holdAsked();
    ok(ask() === 'keep', 'a card tapped while CURRENCIES is up: kept');
    ok(app.state.screen === 'holdChoice', 'and the question stays where it is');
    r.holdAnswered('both');
    await sleep(60);
    ok(ask() === 'shown' && app.state.screen === 'flashcard', 'answered: home, then the card');
    await settle();
    ok(!!welcome(app), 'WELCOME TO YOUR CASHU CARD');
  }

  /* ---- the page loaded again during the set-up: the phone asks the new page, which keeps it and shows it once ---- */
  {
    const r = await firstRun();
    r.boot();
    ok(r.ask() === 'keep', 'kept by the first page');
    const again = await firstRun({ ctx: r.ctx });
    again.boot();
    ok(again.ask() === 'keep' && again.app._arrival && again.app._arrival.kind === 'card', 'the page loaded again: the phone asks, and the new page keeps it');
    again.ready();
    again.custodyRead();
    again.holdAsked();
    again.holdAnswered('sat');
    await sleep(60);
    ok(again.ask() === 'shown' && again.app.state.screen === 'flashcard', 'and shows it when home is reached');
    ok(again.ask() === 'over', 'once');
  }

  /* ---- the lock: it waits for the unlock ---- */
  {
    const r = await firstRun({ one: true });
    const { app, ask } = r;
    r.boot();
    r.ready();
    r.custodyRead();
    app._pinLocked = true;
    await sleep(60);
    ok(ask() === 'keep' && app.state.screen === 'home', 'home, but the lock is up: kept');
    app._pinLocked = false;
    ok(ask() === 'shown' && app.state.screen === 'flashcard', 'unlocked: the card');
  }

  /* ---- a mint with one balance: no question of what to hold, home after the notice ---- */
  {
    const r = await firstRun({ one: true });
    r.boot();
    r.ready();
    ok(r.ask() === 'keep', 'the notice up: kept');
    r.custodyRead();
    r.holdAsked();
    ok(r.app.state.screen === 'home', 'one balance: nothing asked of what to hold');
    await sleep(60);
    ok(r.ask() === 'shown' && r.app.state.screen === 'flashcard', 'home: the card');
  }

  /* ---- a question of what to hold that was given up for this launch does not hold the card back ---- */
  {
    const r = await firstRun();
    r.boot();
    ok(r.ask() === 'keep', 'kept');
    r.ready();
    r.custodyRead();
    await sleep(60);
    ok(r.ask() === 'keep', 'the question of what to hold still due: kept');
    r.app._holdGaveUp = true;
    await sleep(60);
    ok(r.ask() === 'shown', 'the question left for the next launch: home is home');
  }

  /* ---- a wallet that reached home before the arrival came: over, and nothing opened here ---- */
  {
    const r = await firstRun();
    r.boot();
    r.ready();
    r.custodyRead();
    r.holdAsked();
    r.holdAnswered('usd');
    await sleep(80);
    ok(r.app._homeReached === true, 'home reached with nothing waiting: the page knows its first run is over');
    const sheets = r.ctx.sheet.length;
    r.app.setState({ screen: 'history', stack: ['home'] });
    ok(r.ask() === 'over' && r.app.state.screen === 'history' && r.ctx.sheet.length === sheets,
       'a card after that: over, nothing opened here; the phone makes it the tap it always was (cardTapRule decides)');
  }

  /* ---- what is not an arrival this page knows ---- */
  {
    const r = await firstRun();
    r.boot();
    r.ready();
    r.custodyRead();
    r.holdAsked();
    r.holdAnswered('usd');
    ok(r.ask('Card', '') === 'over' && r.ask('card', "1'); x('") === 'over', 'a kind or a code that is not one: over');
    await sleep(60);
    r.app._homeReached = false;
    ok(r.ask('elsewhere', '123456') === 'over' && r.app.state.screen === 'home', 'a kind this page does not open: over, and home stays');
  }

  console.log('\n' + (failed ? failed + ' arrival checks FAIL' : 'all arrival checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + (e && e.stack)); process.exit(1); });
