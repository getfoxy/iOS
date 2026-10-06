'use strict';
/* flashcard-applet.js — the wallet against the applet itself.
 *
 *     sh <card repository>/tools/cardsim/run.sh 47435      (in another terminal)
 *     node tests/flashcard-applet.js [port]
 *
 * The other flashcard suites tap a model of the card written in JavaScript
 * (flashcard-card.js), which flashcard-model.js holds to a recording of the
 * applet. This one has no model in it: every command the wallet builds goes
 * over a socket to the applet's own class, running in the JavaCard simulator
 * (the card repository's CardServer), and every answer is the applet's. The
 * mint is the test mint, in this process.
 *
 * It is the same road the iOS Simulator takes (Foxy/Flashcard/CardLink.swift),
 * with Node where the phone would be. Not in check-all.sh: it needs a JDK and
 * the card repository, and says so and passes over when no card is listening.
 */
const net = require('net');
const { funded, history, OTHER_WORDS } = require('./flashcard-kit');

const PORT = Number(process.argv[2]) || 47435;
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const why = (p) => p.then(() => 'went through', (e) => (e && e.card) || (e && e.message) || String(e));

/* One line out, one line back. */
function wire(port) {
  return new Promise((resolve, reject) => {
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
    sock.on('error', reject);
    sock.on('connect', () => resolve({
      ask: (line) => new Promise((res) => { waiting.push(res); sock.write(line + '\n'); }),
      close: () => sock.destroy(),
    }));
  });
}

(async () => {
  let w;
  try { w = await wire(PORT); } catch (e) {
    console.log('no card is listening on 127.0.0.1:' + PORT + ' (run the card repository’s tools/cardsim/run.sh ' + PORT + '); nothing checked');
    process.exit(0);
  }
  await w.ask('ctl new');
  /* The link the wallet talks through, and a tap: the card powered up again. */
  const link = {
    send: async (apdu) => {
      const said = await w.ask('apdu ' + apdu);
      if (said === 'gone') throw new Error('the tag was lost');
      return said;
    },
  };
  const tap = async () => { const said = await w.ask('tap'); if (said !== 'ok') throw new Error('no card: ' + said); };
  const show = () => w.ask('ctl show');

  const H = await funded({}, 6000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const bal = (c) => c.W.balanceSats();

  /* ---- a new card, read and set up ------------------------------------------ */
  await tap();
  const fresh = await H.W.cardLook(link);
  ok(fresh.info.pin === 'none' && !fresh.info.hasRecord && fresh.info.empty === 64 && /^0[23][0-9a-f]{64}$/.test(fresh.key),
     'the applet is chosen by its whole name, proves it holds its key, and reads as new', fresh.info.version);
  await tap();
  const made = await H.W.cardSetUp(link, { pin: '1234', recoverable: true });
  ok(made.info.pin === 'set' && made.info.hasRecord && made.record.mint === 'https://m.test' && H.W.cardIsMine(made),
     'set up: a PIN, this phone’s mint, and this phone’s refund key', made.record.mint);
  await tap();
  ok((await why(H.W.cardSetUp(link, { pin: '1234', recoverable: true }))) === 'set-up', 'and it will not be set up twice');

  /* ---- money on ------------------------------------------------------------- */
  await tap();
  ok((await why(H.W.cardAdd(link, { sats: 500, pin: '9999' }))) === 'wrong-pin', 'a wrong PIN is refused by the applet, with the tries left');
  ok(H.W.cardOwed().length === 1, 'and the pieces made for it wait');
  await tap();
  const wrote = await H.W.cardWrite(link, { pin: '1234' });
  ok(wrote.sats === 500 && wrote.left === 0 && wrote.card.balance === 500, 'the right PIN writes them: 500 on the card', await show());
  await tap();
  const added = await H.W.cardAdd(link, { sats: 2000, pin: '1234' });
  ok(added.card.balance === 2500 && (await bal(H)) === 3500, 'and 2,000 more: the applet holds 2,500, the phone 3,500', await show());
  await tap();
  const checked = await H.W.cardCheck(await H.W.cardLook(link));
  ok(checked.sats === 2500 && checked.spent === 0, 'the mint agrees every piece the applet lists is unspent');

  /* ---- paying another phone -------------------------------------------------- */
  await tap();
  const steps = [];
  const paid = await R.W.cardPay(link, { sats: 1000, pin: '1234', on: (s) => steps.push(s) });
  ok(paid.sats === 1000 && (await bal(R)) === 1000 && paid.change && paid.change.written,
     'the applet signs, the mint takes its signatures, and 1,000 sats are paid with the change written back', steps.join(' > ') + ' | ' + (await show()));
  ok(history(R).some((e) => e.hash === paid.hash && e.sats === 1000 && e.memo === 'card'), 'with its entry');
  await tap();
  ok((await why(R.W.cardPay(link, { sats: 100, pin: '0000' }))) === 'wrong-pin' && (await bal(R)) === 1000, 'a wrong PIN at the till: refused, nothing signed');
  await tap();
  ok((await why(R.W.cardPay(link, { sats: 99999, pin: '1234' }))) === 'not-enough', 'more than it holds: refused before the PIN is sent');

  // pulled away before the change is written
  await tap();
  const look = await R.W.cardLook(link);
  const before = look.balance;
  await tap();
  await H.W.cardSetLimit(link, { pin: '1234', sats: 0 });
  await tap();
  // the commands of a payment up to the first write: counted by letting them through one more each time
  let pulledAt = -1;
  for (let n = 8; n < 60 && pulledAt < 0; n++) {
    await w.ask('ctl on');
    await tap();
    const snap = await R.W.cardLook(link);
    if (snap.pieces.length < 2) break;
    await tap();
    await w.ask('ctl pull ' + n);
    const r = await R.W.cardPay(link, { sats: 3, pin: '1234' }).then((x) => x, (e) => e);
    if (r && r.change && !r.change.written && !r.change.unmade) pulledAt = n;
    else if (r && r.card === 'interrupted') { pulledAt = -2; break; }
    else if (r && r.sats === 3 && (!r.change || r.change.written)) break;      // it got all the way through
    await w.ask('ctl on');
    // whatever is owed after a pull goes back before the next try
    if (R.W.cardOwed().length) { await tap(); await R.W.cardWrite(link, { pin: '1234' }); }
  }
  await w.ask('ctl on');
  if (R.W.cardOwed().length) { await tap(); await R.W.cardWrite(link, { pin: '1234' }); }
  await tap();
  const after = await R.W.cardLook(link);
  ok(R.W.cardOwed().length === 0 && R.W.cardTaken().length === 0 && after.balance <= before && after.balance > 0,
     'pulled away at every point of a payment in turn: nothing is left owed or unanswered, and the card still holds its money', before + ' > ' + after.balance + ', pulled ' + pulledAt);

  /* ---- its limit, its PIN, and money off ------------------------------------- */
  await tap();
  const limited = await H.W.cardSetLimit(link, { pin: '1234', sats: 50 });
  ok(limited.record.limit === 50, 'a limit of 50 is set');
  await tap();
  ok((await why(R.W.cardPay(link, { sats: 400, pin: '1234' }))) === 'over-limit', 'and a till asking for 400 is refused');
  await tap();
  await H.W.cardSetLimit(link, { pin: '1234', sats: 0 });
  await tap();
  await H.W.cardChangePin(link, { pin: '1234', newPin: '87654321' });
  await tap();
  ok((await why(H.W.cardWithdraw(link, { pin: '1234' }))) === 'wrong-pin', 'the PIN is changed: the old one is wrong now');
  await tap();
  const hBefore = await bal(H);
  const out = await H.W.cardWithdraw(link, { pin: '87654321' });
  await tap();
  const empty = await H.W.cardLook(link);
  ok(out.sats > 0 && (await bal(H)) === hBefore + out.sats && empty.balance === 0, 'and the new one empties the card into its own phone', out.sats + ' | ' + (await show()));

  /* ---- three wrong PINs ------------------------------------------------------- */
  await tap();
  await H.W.cardAdd(link, { sats: 256, pin: '87654321' });
  const tries = [];
  for (let i = 0; i < 3; i++) { await tap(); tries.push(await why(R.W.cardPay(link, { sats: 100, pin: '0000' }))); }
  await tap();
  ok(tries.join() === 'wrong-pin,wrong-pin,blocked' && (await why(R.W.cardPay(link, { sats: 100, pin: '87654321' }))) === 'blocked',
     'three wrong PINs block the applet, and the right one no longer opens it', tries.join());
  // a year on, the phone that loaded it takes the 256 back with no card
  const real = H.window.Date.now.bind(H.window.Date);
  H.window.Date.now = () => real() + 366 * 86400000;
  const back = await H.W.cardTakeBack(empty.key);
  H.window.Date.now = real;
  ok(back.sats === 256, 'and its money comes back to the phone that loaded it, a year on, with no card', String(back.sats));

  w.close();
  console.log('\n' + (failed ? failed + ' flashcard-applet check(s) failed' : 'all flashcard-applet checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
