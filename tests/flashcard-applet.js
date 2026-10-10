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
const SELECT = '00a404000af0464f5859434152440100';

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

  /* ---- the PIN is optional (software 1.16): a card with none, ADD PIN, and the no-PIN allowance ----------------- */
  if (made.info.noPinKnown) {
    await w.ask('ctl new');
    await tap();
    const bare = await H.W.cardSetUp(link, { recoverable: true });
    ok(bare.info.pin === 'none' && bare.info.hasRecord && bare.info.owner === true && bare.info.setUp === true && bare.noPin.set === false && bare.noPin.known === true,
       'a card is set up with no PIN, by the applet: its record and its owner, and no allowance', JSON.stringify([bare.info.pin, bare.info.hasRecord, bare.info.owner]));
    await tap();
    const filled = await H.W.cardAdd(link, { sats: 1000, owner: true });
    ok(filled.card.balance >= 1000, 'loaded by its owner with the grant, with no PIN on it', String(filled.card.balance));
    await tap();
    const rBefore = await bal(R);
    await tap();
    const free = await R.W.cardPay(link, { sats: 100 });
    ok(free.sats === 100 && (await bal(R)) === rBefore + 100, 'it pays 100 with no PIN typed', String(free.sats));
    await tap();
    const bareLog = await H.W.cardLook(link, { mine: true });
    ok(bareLog.log && bareLog.log.last.length > 0 && bareLog.log.last[0].noPin === false && bareLog.log.last[0].sats >= 100,
       'and its log marks nothing for it: a card with no PIN has no PIN to be without (the mark is for the allowance)', JSON.stringify(bareLog.log && bareLog.log.last[0]));
    await tap();
    ok((await why(H.W.cardSetLimit(link, { noPin: 100 }))) === 'no-pin', 'no allowance can be set on a card with no PIN (the wallet says so before the applet is asked)');
    // the applet itself, asked for twelve bytes with no PIN: 6985. The wallet is made to believe a PIN is set, so that it asks.
    await tap();
    const asked = { send: async (a) => { const r = await link.send(a); return (a.slice(0, 6) === 'b00101' && r.length === 88) ? r.slice(0, 14) + '01' + r.slice(16) : r; } };
    const six = await H.W.cardSetLimit(asked, { noPin: 100 }).then(() => null, (e) => e);
    ok(!!six && six.sw === '6985', 'asked for twelve bytes with an allowance on a card with no PIN, the applet answers 6985', six && six.sw);
    await tap();
    await H.W.cardSetLimit(link, { sats: 150 });
    await tap();
    await R.W.cardPay(link, { sats: 100 });
    await tap();
    ok((await why(R.W.cardPay(link, { sats: 100 }))) === 'limit', 'a daily limit set on it holds with no PIN: 100 more after 100 is over 150');
    await tap();
    await H.W.cardSetLimit(link, { sats: 0 });

    // ADD PIN
    await tap();
    await link.send(SELECT);
    const noGrant = await link.send('b0410000' + '04' + '31323334');
    ok(/^6[0-9a-f]{3}$/i.test(noGrant), 'ADD PIN with no grant in the tap is refused by the applet', noGrant);
    await tap();
    const added = await H.W.cardAddPin(link, { pin: '2468' });
    ok(added.info.pin === 'set' && added.info.noPin.limit === 0 && added.noPin.set === false && added.balance >= 800, 'ADD PIN: the owner’s grant and a PIN sealed; the money stays, the allowance is nothing', added.info.pin + ', ' + added.balance);
    await tap();
    ok((await why(H.W.cardAddPin(link, { pin: '1357' }))) === 'has-pin', 'and not again');
    await tap();
    ok((await why(R.W.cardPay(link, { sats: 50 }))) === 'pin-needed', 'every payment asks for the PIN now: the read says so before the applet is asked');
    // the applet's own word: begin a payment with no PIN, and ask for the signature
    await tap();
    const seen = await R.W.cardLook(link);
    await link.send(SELECT);
    const place = ('0' + seen.pieces[0].i.toString(16)).slice(-2);
    const begun = await link.send('b0220000' + '01' + place);
    const refused = await link.send('b024000040');
    ok(/9000$/.test(begun) && /6a94$/i.test(refused), 'the applet takes the beginning with no PIN and refuses the signature, 6A94', begun.slice(-12) + ', ' + refused);
    await tap();
    const kept = await R.W.cardLook(link);
    ok(kept.balance === seen.balance && kept.info.spent === seen.info.spent, 'which signed nothing and burned nothing');
    await tap();
    const mid = await R.W.cardPay(link, { sats: 50, pin: '2468' });
    ok(mid.sats === 50, 'with the PIN it pays');

    // the allowance
    await tap();
    await H.W.cardSetLimit(link, { noPin: 200 });
    await tap();
    const set = await R.W.cardLook(link);
    ok(set.noPin.set && set.noPin.limit === 200 && set.noPin.spent === 0, 'an allowance of 200 is set by the owner in twelve bytes, and said to anybody', JSON.stringify(set.noPin));
    await tap();
    const within = await R.W.cardPay(link, { sats: 120 });
    await tap();
    const counted = await R.W.cardLook(link);
    ok(within.sats === 120 && counted.noPin.spent === 120 && counted.noPin.left === 80, 'a payment of 120 within it is signed with no PIN, and counted: 120 of 200', JSON.stringify(counted.noPin));
    await tap();
    const over = await R.W.cardPay(link, { sats: 100 }).then(() => null, (e) => e);
    ok(!!over && over.card === 'pin-needed' && over.left === 80, '100 is over the 80 left: pin-needed, and the whole payment (never a part)', over && over.card);
    await tap();
    const pinned = await R.W.cardPay(link, { sats: 100, pin: '2468' });
    await tap();
    const same = await R.W.cardLook(link);
    ok(pinned.sats === 100 && same.noPin.spent === 120, 'with the PIN it pays, and counts nothing against the allowance', JSON.stringify(same.noPin));
    // the day: a header begins the window if none had (the allowance was set before one), and keeps the count
    await tap();
    await link.send(SELECT);
    if (made.info.headers) {
      const took = await link.send('b0360000' + '50' + TIP + '04');
      await tap();
      const anchored = await R.W.cardLook(link);
      ok(took === u32(TIP_TIME) + '9000' && anchored.info.now === TIP_TIME && anchored.noPin.spent === 120,
         'a block header shown to it gives the window a start (the allowance alone had set none) and keeps the count', JSON.stringify([anchored.info.now, anchored.info.windowStart, anchored.noPin.spent]));
    }
    // ADD PIN, then change the PIN (unblocking is the old flow): nothing else about the PIN changed
    await tap();
    ok((await H.W.cardChangePin(link, { newPin: '8642' })) === true, 'and CHANGE PIN is as it was');
    await tap();
    const hb = await bal(H);
    const off = await H.W.cardWithdraw(link, { pin: '8642' });
    ok(off.sats > 0 && (await bal(H)) === hb + off.sats, 'the card is emptied into its owner’s phone with the new PIN', String(off.sats));
  }

  w.close();
  console.log('\n' + (failed ? failed + ' flashcard-applet check(s) failed' : 'all flashcard-applet checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
