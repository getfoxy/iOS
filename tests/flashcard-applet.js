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
 * mint is the test mint, in this process. The card repository is
 * https://github.com/getfoxy/card.
 *
 * It is the same road the iOS Simulator takes (Foxy/Flashcard/CardLink.swift),
 * with Node where the phone would be. Not in check-all.sh: it needs a JDK and
 * the card repository, and says so and passes over when no card is listening.
 */
const net = require('net');
const { funded, history, OTHER_WORDS } = require('./flashcard-kit');

/* A real block header, as the network carries it (80 bytes), and the time in it. A card of software 1.15 takes its clock from the
 * newest it has been shown, and believes a header for the work in it, so one that was made years ago and is public does as well as
 * one from this minute: it needs no network, and the applet's day logic runs on it. */
const TIP = '00c02133b973a14eab498ae41fd2054685e7250b36c4bd758ca801000000000000000000ba4fd6d57bfebf73fcf0552a92d5430b78b735cf59c6c58243b2fc48d4669b5a75dcc96af01e021736a8ee8c';
const TIP_TIME = 1791614069;
const TIP_HASH = '00000000000000000001fa7ca83e1eb90d5a1865d8db9684f3f03ca64ccaec8a';
const OLD = '00e0ff3f5c9163e913a6431d7ef2fce013c71bc6a96a9fdaad1a020000000000000000000db1148f11b5c527caef5a8f54ed8bab7a2096b40d2a204b5c8e7f38d3501c5f7273c86af01e02177f6bf671';
const u32 = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
const SELECT = '00a4040009f0464f58594341524400';

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
  ok(fresh.info.pin === 'none' && !fresh.info.hasRecord && fresh.info.empty === fresh.info.slots && /^0[23][0-9a-f]{64}$/.test(fresh.key),
     'the applet is chosen by its whole name, proves it holds its key, and reads as new', fresh.info.version);
  await tap();
  const made = await H.W.cardSetUp(link, { pin: '1234', recoverable: true });
  ok(made.info.pin === 'set' && made.info.hasRecord && made.record.mint === 'https://m.test' && H.W.cardIsMine(made),
     'set up: a PIN, this phone’s mint, and this phone’s refund key', made.record.mint);
  // a card of 1.15 has no time key: its record has zeros where one was, and its clock is Bitcoin block headers; one before it was given the interim key
  ok(made.info.owner === true && made.info.limit === 0 && fresh.info.owner === false && fresh.info.limit === 0
     && (made.info.headers ? made.record.timeKey === '' && made.record.headerBits === '' && made.record.headerHash === '' : made.record.timeKey === H.W.cardTimeKey),
     made.info.headers ? 'and an owner and no limit, and no time key (the applet reads none): its clock is block headers, and it has been shown none' : 'and an owner, no limit, and the time key, which the applet kept: the new card had none of them');
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
  const added = await H.W.cardAdd(link, { sats: 2000, owner: true });
  ok(added.card.balance === 2500 && (await bal(H)) === 3500, 'and 2,000 more with this phone’s proof and no PIN: the applet holds 2,500, the phone 3,500', await show());
  await tap();
  ok((await R.W.cardLook(link, { mine: true })).mine === false && (await H.W.cardLook(link, { mine: true })).mine === true,
     'a phone with other words is refused by the applet as the owner, and the owner’s is not');
  await tap();
  const checked = await H.W.cardCheck(await H.W.cardLook(link));
  ok(checked.sats === 2500 && checked.spent === 0, 'the mint agrees every piece the applet lists is unspent');

  /* ---- a terminal that has the PIN ----------------------------------------------- */
  // It reads a piece and writes it back stating an amount of 1. The card signs a piece's secret and not its amount, so
  // that copy would be spent for 1 and signed for the real piece. The applet refuses a nonce that is on the card already.
  await tap();
  await link.send('00a4040009f0464f58594341524400');
  ok((await link.send('b0400000' + '04' + '31323334')) === '9000', 'a terminal with the PIN is let in');
  const slotsBefore = await link.send('b014000000');
  const realPiece = (await link.send('b013000000')).slice(2, -4);
  const copy = realPiece.slice(0, 16) + '00000001' + realPiece.slice(24);
  ok(realPiece.length === 162 && (await link.send('b0300000' + '51' + copy + '01')) === '6a94', 'its copy of a piece on the card, with an amount of 1, is refused by the applet');
  ok((await link.send('b0300000' + '51' + realPiece + '01')) === '6a94' && (await link.send('b014000000')) === slotsBefore,
     'and so is the piece itself, again, and nothing on the card has changed');

  /* ---- its clock (software 1.15 and on): a real block header, and the time a terminal tells it --------------------- */
  if (made.info.headers) {
    await tap();
    await link.send(SELECT);
    ok((await link.send('b0370000' + '04' + u32(1790000000))) === '9000', 'a terminal tells it its own time: a note, nothing back');
    ok((await link.send('b0350000' + '00')) === '6d00', 'and SET_TIME, a time under a signature, is gone');
    const took = await link.send('b0360000' + '50' + TIP + '04');
    ok(took === u32(TIP_TIME) + '9000', 'a block header is taken and the applet says its clock: the time in it', took);
    const info = H.W.cardParse.info((await link.send('b001010000')).slice(0, -4));
    const rec = H.W.cardParse.record((await link.send('b016000000')).slice(0, -4), info);
    ok(info.now === TIP_TIME && info.headerTime === TIP_TIME && rec.headerHash === TIP_HASH && rec.headerBits === TIP.substr(144, 8),
       'its clock is the block’s, and its record says the block: the hash, and the difficulty it was made at', rec.headerHash.slice(0, 24) + ' ' + rec.headerBits);
    ok((await link.send('b0360000' + '50' + OLD + '04')) === u32(TIP_TIME) + '9000' && H.W.cardParse.info((await link.send('b001010000')).slice(0, -4)).now === TIP_TIME,
       'an older block changes nothing');
    // the same block with its nonce changed: no work in it
    ok((await link.send('b0360000' + '50' + TIP.slice(0, 152) + '00000000' + '04')) === '6a93', 'a block without the work in it is refused');
    await tap();
    const seen = await H.W.cardLook(link);
    ok(seen.info.now === TIP_TIME && seen.clock && seen.clock.told === true && seen.clock.sent === false,
       'a phone that taps it is current: it tells the time, and sends no header (it has none newer)', JSON.stringify(seen.clock));
  }

  /* ---- paying another phone -------------------------------------------------- */
  await tap();
  const steps = [];
  const paid = await R.W.cardPay(link, { sats: 1000, pin: '1234', on: (s) => steps.push(s) });
  ok(paid.sats === 1000 && (await bal(R)) === 1000 && paid.change === null && steps.join(' ') === 'reading signing checking done',
     'the applet signs, the card is let go, the mint takes its signatures, and 1,000 sats are paid: the pieces were cut like a cash drawer, so there is no change', steps.join(' > ') + ' | ' + (await show()));
  ok(history(R).some((e) => e.hash === paid.hash && e.sats === 1000 && e.memo === 'card'), 'with its entry');
  await tap();
  ok((await why(R.W.cardPay(link, { sats: 100, pin: '0000' }))) === 'wrong-pin' && (await bal(R)) === 1000, 'a wrong PIN at the till: refused, nothing signed');
  await tap();
  ok((await why(R.W.cardPay(link, { sats: 99999, pin: '1234' }))) === 'not-enough', 'more than it holds: refused before the PIN is sent');

  // a payment the mint refuses: the applet's own CLEAR_SPENT frees the places the signing burned, and the same pieces load again
  await tap();
  const holds = (await R.W.cardLook(link)).balance;
  R.fate = (m) => (/\/v1\/swap$/.test(String(m.url || '')) ? '400\n' + JSON.stringify({ code: 11000, detail: 'signature for P2PK does not verify' }) : null);
  await tap();
  const refused = await R.W.cardPay(link, { sats: 300, pin: '1234' }).then(() => null, (e) => e);
  R.fate = null;
  await tap();
  const burned = await R.W.cardLook(link);
  await tap();
  const putBack = await R.W.cardWrite(link, { pin: '1234' });
  ok(refused && refused.card === 'putback' && refused.owed === 300 && burned.balance === holds - 300 && burned.info.spent > 0
     && putBack.back === 300 && putBack.card.balance === holds && putBack.card.info.spent === 0 && R.W.cardOwed().length === 0 && (await bal(R)) === 1000,
     'a payment the mint refuses is put back by the next tap: the applet frees the burned places and takes the same pieces again; nothing was paid', holds + ' > ' + burned.balance + ' > ' + putBack.card.balance + ' | ' + (await show()));

  // pulled away at every point of a payment in turn: the card does its part in the first dozen commands, and is let go
  await tap();
  const look = await R.W.cardLook(link);
  const before = look.balance;
  const outcomes = [];
  for (let n = 4; n < 60; n++) {
    await w.ask('ctl on');
    await tap();
    const snap = await R.W.cardLook(link);
    if (snap.pieces.length < 2) break;
    await tap();
    await w.ask('ctl pull ' + n);
    const r = await R.W.cardPay(link, { sats: 3, pin: '1234' }).then((x) => x, (e) => e);
    outcomes.push(r && r.sats === 3 ? 'paid' : (r && r.card) || 'error');
    await w.ask('ctl on');
    // whatever is owed after a pull goes back before the next try
    if (R.W.cardOwed().length) { await tap(); await R.W.cardWrite(link, { pin: '1234' }); }
    if (r && r.sats === 3) break;      // it got all the way through
  }
  await w.ask('ctl on');
  if (R.W.cardOwed().length) { await tap(); await R.W.cardWrite(link, { pin: '1234' }); }
  await tap();
  const after = await R.W.cardLook(link);
  ok(R.W.cardOwed().length === 0 && R.W.cardTaken().length === 0 && after.balance <= before && after.balance > 0 && outcomes[outcomes.length - 1] === 'paid',
     'pulled away at every point of a payment in turn: nothing is left owed or unanswered, and the card still holds its money', before + ' > ' + after.balance + ', ' + outcomes.join(' '));

  /* ---- its limit, its PIN, and money off ------------------------------------- */
  await tap();
  const limited = await H.W.cardSetLimit(link, { sats: 50 });
  ok(limited.record.limit === 50 && limited.info.limit === 50 && limited.info.windowStart === limited.info.now && (!limited.info.headers || limited.info.windowStart === TIP_TIME),
     'a daily limit of 50 is set, with the owner’s proof and no PIN, by the applet' + (limited.info.headers ? ', and its day begins at the block’s time' : ''));
  await tap();
  ok((await why(R.W.cardPay(link, { sats: 400, pin: '1234' }))) === 'limit', 'and a till asking for 400 is refused');
  await tap();
  ok((await why(R.W.cardSetLimit(link, { sats: 0 }))) === 'not-owner', 'and a phone with other words cannot remove it: the applet refuses the proof');
  await tap();
  ok((await H.W.cardLook(link)).info.tries === 3, 'at no cost in tries');
  await tap();
  await H.W.cardChangePin(link, { newPin: '87654321' });
  await tap();
  ok((await why(H.W.cardWithdraw(link, { pin: '1234' }))) === 'wrong-pin', 'the PIN is changed: the old one is wrong now');
  await tap();
  ok((await why(R.W.cardChangePin(link, { newPin: '1357' }))) === 'not-owner', 'and a phone with other words cannot change it again');
  await tap();
  const hBefore = await bal(H);
  const out = await H.W.cardWithdraw(link, { pin: '87654321' });
  await tap();
  const empty = await H.W.cardLook(link);
  ok(out.sats > 0 && (await bal(H)) === hBefore + out.sats && empty.balance === 0, 'and the new one empties the card into its own phone, whatever the limit', out.sats + ' | ' + (await show()));
  ok(empty.record.limit === 50, 'the limit having been lifted for that, with the owner’s proof, and put back, in the same tap');

  /* ---- three wrong PINs ------------------------------------------------------- */
  await tap();
  await tap();
  await H.W.cardSetLimit(link, { sats: 0 });
  await tap();
  await H.W.cardAdd(link, { sats: 256, owner: true });
  const tries = [];
  for (let i = 0; i < 3; i++) { await tap(); tries.push(await why(R.W.cardPay(link, { sats: 100, pin: '0000' }))); }
  await tap();
  ok(tries.join() === 'wrong-pin,wrong-pin,blocked' && (await why(R.W.cardPay(link, { sats: 100, pin: '87654321' }))) === 'blocked',
     'three wrong PINs block the applet, and the right one no longer opens it', tries.join());
  await tap();
  ok((await H.W.cardChangePin(link, { newPin: '1111' })) === true, 'the owner’s phone unblocks it with a new PIN, and never needed the old one');
  await tap();
  ok((await R.W.cardWrite(link, { pin: '1111' })).card.info.pin === 'set', 'which is the PIN now');
  // blocked again for what follows: the money is taken back with no card
  for (let i = 0; i < 3; i++) { await tap(); await why(R.W.cardPay(link, { sats: 100, pin: '0000' })); }
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
