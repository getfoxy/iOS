'use strict';
/* flashcard-switch.js — a card moved between two real mints, and back.
 *
 *   sh tools/live/local-mint.sh up
 *   sh <card repository>/tools/cardsim/run.sh 47436      (optional: the applet itself)
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/flashcard-switch.js [card port]
 *
 * tests/flashcard-switch.js moves a card between two stub mints, whose fees
 * and Lightning are whatever the test says they are. These are CDK's and
 * Nutshell's own: their keyset names (one long, one short), their input fees,
 * their fee reserves, and a Lightning payment each believes it made.
 *
 * The card is the applet's own class in the JavaCard simulator when a card
 * server is listening on the port given (or 47436), and the JavaScript model
 * of it when none is. Either way the wallet is the real one, on the mocked
 * phone every live suite uses.
 *
 * Twice over: first the wallet's own steps, called one by one (A, B), then the
 * screens (build/app/26f-flashcard.js, as tests/flashcard-ui-kit.js makes them
 * drivable) with SWITCH MINT pressed, a PIN typed and the card tapped (C), the
 * card put away before its second tap and the money put on later (D), and a
 * card with nothing on it (E).
 *
 * What is held to: every sat is somewhere it can be named (the card, the
 * phone at one mint, the phone at the other, or a fee), the phone's own
 * balance is not dipped into to pay for the card's crossing, and the card
 * pays at the mint it was moved to.
 *
 * Fake money only — the local Docker mints. */
const net = require('net');
const H = require('./harness');
const { makeCard } = require('../../tests/flashcard-card');
const { appOn, pad, card: face, vals } = require('../../tests/flashcard-ui-kit');

setTimeout(() => { console.log('WATCHDOG 900s'); process.exit(2); }, 900000).unref();

const R = { pass: 0, fail: 0 };
const ok = (name, good, detail) => {
  console.log((good ? '  OK    ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
  good ? R.pass++ : R.fail++;
};
const PORT = Number(process.argv[2]) || 47436;
const PIN = '1234';

/* The applet over a socket, as the iOS Simulator reaches it; null when no
 * card server is listening. */
function applet(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    const waiting = [];
    sock.on('data', (d) => {
      buf += d.toString('ascii');
      let at;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at).trim();
        buf = buf.slice(at + 1);
        const next = waiting.shift();
        if (next) next(line);
      }
    });
    sock.on('error', () => resolve(null));
    sock.on('connect', () => {
      const ask = (line) => new Promise((res) => { waiting.push(res); sock.write(line + '\n'); });
      resolve({
        what: 'the applet, in the JavaCard simulator',
        fresh: () => ask('ctl new'),
        tap: async () => { if ((await ask('tap')) !== 'ok') throw new Error('no card on the reader'); },
        send: async (apdu) => { const said = await ask('apdu ' + apdu); if (said === 'gone') throw new Error('the tag was lost'); return said; },
        close: () => sock.destroy(),
      });
    });
  });
}

/* The phone's NFC for the screens, as Foxy/Flashcard/CardLink.swift answers
 * it: `card` is the card that will be tapped, `away` a card nobody presents. */
const reader = { card: null, away: false, begun: 0 };
const nfc = (m, reply) => {
  if (m.action === 'cardBegin') {
    reader.begun++;
    if (!reader.card || reader.away) reply(m.id, null, 'the session was cancelled');
    else reader.card.tap().then(() => reply(m.id, 'ok'), (e) => reply(m.id, null, e.message));
    return true;
  }
  if (m.action === 'cardSend') { reader.card.send(m.apdu).then((r) => reply(m.id, r), () => reply(m.id, null, 'the tag was lost')); return true; }
  if (m.action === 'cardSay' || m.action === 'cardEnd') { reply(m.id, 'ok'); return true; }
  return false;
};
const bare = (u) => String(u || '').replace(/\/+$/, '');
/* Wait for something to be true of the screen, against mints that take the
 * time they take. Says what was up instead when it never is. */
async function wait(app, what, cond, ms) {
  const end = Date.now() + (ms || 120000);
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 40)); }
  ok('waited for ' + what, false, 'up instead: ' + ((face(app) && face(app).all) || (pad(app) && pad(app).title) || app.state.screen));
  return false;
}

/* What this phone holds at a mint, whichever it is connected to. */
const at = (b, mint) => {
  try { return (JSON.parse(b.w.localStorage.getItem('foxy.cashu.proofs.' + mint)) || []).reduce((n, p) => n + Number(p.amount || 0), 0); }
  catch (e) { return 0; }
};

/* One move of everything on the card from `from` to `to`, as the screens do
 * it: asked, off the card, across, made ready, and written on. Resolves the
 * figures. */
async function move(b, card, from, to, label) {
  const W = b.W;
  await card.tap();
  const before = await W.cardLook(card);
  const phone0 = { from: at(b, from), to: at(b, to) };
  // as the screen asks it: the card's balance, and how many pieces that is
  const guess = await W.cardMoveQuote(from, to, before.balance, { quoteOnly: true, pieces: before.pieces.length });
  const shown = before.balance - guess.net;
  console.log('    asked first: ' + before.balance + ' on the card in ' + before.pieces.length + ' pieces, about ' + guess.net + ' would land, fee up to ' + shown);

  await card.tap();
  const off = await W.cardWithdraw(card, { pin: PIN });
  ok(label + ': the first tap takes the money off the card', off.sats > 0 && off.card && off.card.balance === 0, off.sats + ' of ' + before.balance + ' (the mint took ' + (before.balance - off.sats) + ' to swap it)');

  const plan = await W.cardMoveQuote(from, to, off.sats);
  ok(label + ': the plan is paid for by the card’s own money', plan.gross <= off.sats && plan.net > 0, plan.net + ' to land, up to ' + plan.gross + ' to leave, of ' + off.sats);
  ok(label + ': and costs no more than the figure asked for first', before.balance - plan.net <= shown, 'up to ' + (before.balance - plan.net) + ', shown up to ' + shown);
  const done = await W.moveRun(plan, () => {}, { visit: true });
  ok(label + ': the Lightning payment is made and claimed at the other mint', done.sats === plan.net && at(b, to) === phone0.to + done.sats, done.sats + ' landed');
  const stayed = at(b, from) - phone0.from;
  ok(label + ': the phone’s own balance at the first mint was not dipped into', stayed >= 0, 'it is ' + stayed + ' sats up: the part of the reserve the route did not use');

  const made = await W.cardMoveLoad(off.card, done.sats);
  const owed = W.cardOwed();
  ok(label + ': what landed is made into pieces for the card, at that mint', made.sats > 0 && owed.length === 1 && owed[0].mint === to.replace(/\/+$/, ''), made.sats + ' for the card (' + (done.sats - made.sats) + ' it costs to make and spend them there)');

  await card.tap();
  const on = await W.cardWrite(card, { pin: PIN });
  ok(label + ': the second tap tells the card its new mint and writes the money on', on.left === 0 && on.sats === made.sats && on.card.record.mint === to.replace(/\/+$/, '') && on.card.balance === made.sats && W.cardOwed().length === 0,
     on.card.record.mint + ', holding ' + on.card.balance);
  const check = await W.cardCheck(on.card);
  ok(label + ': and that mint says every piece on it is good', check.spent === 0 && check.sats === made.sats);
  console.log('    keyset on the card: ' + on.card.pieces.map((x) => x.keyset)[0] + ' (eight bytes, whatever length the mint\u2019s own name for it is)');
  return { had: before.balance, off: off.sats, landed: done.sats, on: made.sats, stayed: stayed, leftAtTo: at(b, to) - phone0.to };
}

async function run() {
  const CDK = H.MINTS.cdk.https;
  const NUT = H.MINTS.nutshell.https;
  const names = await H.mintNames(['cdk', 'nutshell']);
  const b = H.boot({ keychain: { words: '' }, bridge: nfc });
  const W = b.W;
  await W.seedReady();

  let card = await applet(PORT);
  if (card) await card.fresh();
  else { const m = makeCard({ window: b.w }); card = { what: 'the JavaScript model of the card (no card server on ' + PORT + ')', tap: async () => m.tap(), send: (a) => m.send(a), close: () => {} }; }
  console.log('\n' + names.cdk + '  <->  ' + names.nutshell + '\nthe card: ' + card.what + '\n');

  await W.connect(CDK);
  await H.mintAndClaim(W, 6000);
  await W.primeLocks();
  await card.tap();
  await W.cardSetUp(card, { pin: PIN });
  await card.tap();
  const first = await W.cardAdd(card, { sats: 2000, pin: PIN });
  ok('a card set up at the first mint with money on it', first.card.balance > 0 && first.card.record.mint === CDK.replace(/\/+$/, ''), first.card.balance + ' on the card, ' + at(b, CDK) + ' in the phone');
  const total = first.card.balance + at(b, CDK) + at(b, NUT);

  console.log('\nA. ' + names.cdk + ' to ' + names.nutshell);
  const a = await move(b, card, CDK, NUT, 'A');

  console.log('\nthe card at its new mint');
  await card.tap();
  const paid = await W.cardPay(card, { sats: 300, pin: PIN });
  ok('it pays there, and its change is written back', paid.sats === 300 && (!paid.change || paid.change.written), JSON.stringify(paid.change));
  await W.connect(CDK);
  await card.tap();
  const wrong = await W.cardPay(card, { sats: 100, pin: PIN }).then(() => 'went through', (e) => e.card);
  ok('and at its old mint it signs nothing', wrong === 'other-mint', wrong);
  await W.connect(NUT);

  console.log('\nB. back again, ' + names.nutshell + ' to ' + names.cdk);
  const back = await move(b, card, NUT, CDK, 'B');

  /* ---- the screens ---------------------------------------------------------- */
  console.log('\nC. the screens: SWITCH MINT pressed, ' + names.cdk + ' to ' + names.nutshell);
  const app = appOn({ window: b.w, W: W });
  app.mintNameOf = (url) => (bare(url) === bare(CDK) ? names.cdk : bare(url) === bare(NUT) ? names.nutshell : bare(url));
  await app.refreshBalance();
  reader.card = card;
  const own = { cdk: at(b, CDK), nut: at(b, NUT) };
  app.goFlashcard();
  await wait(app, 'the card to be read', () => !!app.state.fc && app.state.fc.check === 'ok');
  const held = app.state.fc.balance;
  app.fcSwitchMint();
  ok('C: SWITCH MINT opens the list of mints', app.state.screen === 'switchMint' && app.state.fcPick === true);
  app.fcSwitchPick(NUT);
  await wait(app, 'the cost to be known', () => app.state.fcMove && (app.state.fcMove.fee != null || !!app.state.fcMove.err));
  let spec = app.fcMoveSpec();
  spec.rows.forEach((r) => console.log('    ' + r.label + ': ' + r.value));
  console.log('    [' + spec.cta + ']');
  ok('C: the confirmation has both mints’ own figures and a button that can be pressed', /^MOVE /.test(spec.cta) && typeof spec.go === 'function' && !app.state.fcMove.err, app.state.fcMove.err);
  const before = new Set((await W.transactions(50)).map((e) => e.hash));
  const begun = reader.begun;
  const agreed = app.state.fcMove.fee;
  spec.go();
  ok('C: it asks the card’s PIN once', !!pad(app) && pad(app).title === 'CARD PIN', pad(app) && pad(app).cta);
  pad(app).type(PIN);
  await wait(app, 'the card to be moved', () => face(app) && face(app).title === 'MOVED', 240000);
  await wait(app, 'the phone to be back at its mint', () => bare(W.mintUrl) === bare(CDK) && !app.state.fcMove);
  console.log('    ' + face(app).reason);
  ok('C: for no more than the fee the confirmation showed', held - app.state.fc.balance <= agreed + 3, (held - app.state.fc.balance) + ' gone from the card, shown up to ' + agreed + ' and the cost of making the pieces');
  ok('C: two taps later the card is at the other mint with its money', reader.begun === begun + 2 && app.state.screen === 'flashcard' && bare(app.state.fc.mint) === bare(NUT) && app.state.fc.balance > 0 && app.state.fc.balance < held,
     held + ' became ' + app.state.fc.balance + ', ' + (reader.begun - begun) + ' taps');
  ok('C: the phone’s own money was not used, and it is back at the mint it was at', at(b, CDK) >= own.cdk && at(b, NUT) >= own.nut && bare(W.mintUrl) === bare(CDK) && W.cardOwed().length === 0,
     (at(b, CDK) - own.cdk) + ' and ' + (at(b, NUT) - own.nut) + ' sats up');
  const fresh = (await W.transactions(50)).filter((e) => !before.has(e.hash));
  ok('C: none of its entries is announced as a payment', fresh.length >= 3 && fresh.every((e) => app.seen[e.hash] || W.tagsFor(e.hash).to === 'card') && app._quiet === false,
     fresh.length + ' entries; loud: ' + fresh.filter((e) => !app.seen[e.hash] && W.tagsFor(e.hash).to !== 'card').map((e) => (e.memo || e.dir) + ':' + e.sats).join(' '));
  face(app).press('DONE');

  console.log('\nD. the card put away before its second tap, ' + names.nutshell + ' to ' + names.cdk);
  await W.connect(NUT);
  await app.refreshBalance();
  app.setState({ fc: null });
  app.fcRead();
  await wait(app, 'the card to be read at its new mint', () => !!app.state.fc && app.state.fc.check === 'ok');
  const heldD = app.state.fc.balance;
  app.fcSwitchMint();
  app.fcSwitchPick(CDK);
  await wait(app, 'the cost back to be known', () => app.state.fcMove && (app.state.fcMove.fee != null || !!app.state.fcMove.err));
  const melt0 = app.showMelt;
  app.showMelt = (label) => { melt0(label); reader.away = true; };      // put away during the crossing
  app.fcMoveSpec().go();
  pad(app).type(PIN);
  await wait(app, 'the second tap to be asked for again', () => face(app) && face(app).title === 'TAP THE CARD AGAIN', 240000);
  ok('D: the money has crossed and waits for the card', W.cardOwed().length === 1 && W.cardOwed()[0].mint === bare(CDK) && W.cardOwed()[0].sats > 0 && W.cardOwed()[0].sats < heldD, W.cardOwed().map((r) => r.sats + ' at ' + r.mint).join());
  const waiting = W.cardOwed()[0].sats;
  face(app).press('LATER');
  await wait(app, 'the phone to be back where it was', () => app.state.screen === 'flashcard' && bare(W.mintUrl) === bare(NUT) && !app.state.fcMove);
  ok('D: LATER leaves the card’s screen with the line that says so', vals(app).fcNotes.length === 1 && /waiting to go onto this card/.test(vals(app).fcNotes[0].text), vals(app).fcNotes.map((n) => n.text).join());
  app.fcSwitchMint();
  ok('D: and the card is not moved again while that money waits', !!face(app) && face(app).title === 'PUT IT ON FIRST');
  face(app).press('CANCEL');
  vals(app).fcNotes[0].tap();
  ok('D: pressed from the wrong mint, it says which mint the money is at', !!face(app) && face(app).title === 'A DIFFERENT MINT' && !pad(app), face(app) && face(app).reason);
  face(app).press('CANCEL');
  await W.connect(CDK);
  reader.away = false;
  vals(app).fcNotes[0].tap();
  pad(app).type(PIN);
  await wait(app, 'the money to be on the card', () => face(app) && face(app).title === 'ON THE CARD');
  ok('D: from the right one, a tap finishes the move', bare(app.state.fc.mint) === bare(CDK) && app.state.fc.balance === waiting && W.cardOwed().length === 0, app.state.fc.balance + ' on the card at ' + app.state.fc.mint);
  face(app).press('DONE');
  app.showMelt = melt0;

  console.log('\nE. a card with nothing on it');
  await card.tap();
  await W.cardWithdraw(card, { pin: PIN });
  app.setState({ fc: null });
  app.fcRead();
  await wait(app, 'the empty card to be read', () => !!app.state.fc && app.state.fc.balance === 0);
  const begunE = reader.begun;
  app.fcSwitchMint();
  app.fcSwitchPick(NUT);
  ok('E: no confirmation and no Lightning: its PIN', app.state.screen === 'flashcard' && !!pad(app) && pad(app).cta === 'MOVE CARD' && !app.state.fcMove, pad(app) && pad(app).sub);
  pad(app).type(PIN);
  await wait(app, 'the empty card to be moved', () => face(app) && face(app).title === 'MOVED');
  await wait(app, 'the phone to be back at its mint', () => bare(W.mintUrl) === bare(CDK));
  ok('E: and one tap: the card is at the other mint, the phone where it was', reader.begun === begunE + 1 && bare(app.state.fc.mint) === bare(NUT), (reader.begun - begunE) + ' tap');
  face(app).press('DONE');

  await card.tap();
  const end = await W.cardLook(card);
  const now = end.balance + at(b, CDK) + at(b, NUT);
  console.log('\nwhere every sat is');
  console.log('    at the start: ' + total + ' (the card and the phone together)');
  console.log('    now:          ' + now + ' = the card ' + end.balance + ', the phone ' + at(b, CDK) + ' at ' + names.cdk + ' and ' + at(b, NUT) + ' at ' + names.nutshell);
  console.log('    gone in fees: ' + (total - now) + ' over four crossings, a payment and two withdrawals (the mints’ input fees and the Lightning fees)');
  ok('nothing is unaccounted for: what is not held was a fee, and it is small', total - now >= 0 && total - now < 300, String(total - now));
  ok('nothing is left owed or unanswered', W.cardOwed().length === 0 && W.cardTaken().length === 0);
  const trouble = b.rec.error.filter((l) => !/card:/.test(l));
  ok('and the wallet logged no errors', trouble.length === 0, trouble.slice(0, 2).join(' | '));

  card.close();
  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
