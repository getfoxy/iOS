'use strict';
/* flashcard-sigall.js — a card that signs once for a payment, at real mints.
 *
 *   sh tools/live/local-mint.sh up
 *   sh <card repository>/tools/cardsim/run.sh 47436      (optional: the applet itself)
 *   (the card repository is https://github.com/getfoxy/card)
 *   NODE_EXTRA_CA_CERTS=build/live-tls/cert.pem FOXY_LIVE_LOCAL=1 \
 *     node tools/live/flashcard-sigall.js [card port]
 *
 * tests/flashcard-sigall.js pays with such a card at a stub mint that holds
 * NUT-11's SIG_ALL the way this repository reads it. These are CDK's and
 * Nutshell's own readings: one signature, on the first piece, over every
 * piece and every output, taken or refused by the mint itself.
 *
 * The card is the applet's own class in the JavaCard simulator when a card
 * server is listening on the port given (or 47436), and the JavaScript model
 * of it when none is. The wallet is the real one, twice: a holder's phone and
 * a receiver's, each on the mocked phone every live suite uses.
 *
 * What is held to, at each mint: a payment is one signature whatever its
 * pieces; the receiver has exactly what it asked for; change written back is
 * money the card can sign for again; and every sat is somewhere it can be
 * named.
 *
 * Fake money only — the local Docker mints. */
const net = require('net');
const H = require('./harness');
const { makeCard } = require('../../tests/flashcard-card');

/* FOXY_CARD_CHIP=1: the card on the port is a real one, in a reader on this
 * Mac (the card repository's tools/chip). One card, which nothing here can
 * make new again, so one mint (FOXY_CARD_MINT, or CDK); and a chip is slower
 * than a simulator, so it is given longer. */
const CHIP = !!process.env.FOXY_CARD_CHIP;
setTimeout(() => { console.log('WATCHDOG ' + (CHIP ? 3600 : 900) + 's'); process.exit(2); }, CHIP ? 3600000 : 900000).unref();

const R = { pass: 0, fail: 0 };
const ok = (name, good, detail) => {
  console.log((good ? '  OK    ' : '  FAIL  ') + name + (detail ? ' — ' + detail : ''));
  good ? R.pass++ : R.fail++;
};
const PORT = Number(process.argv[2]) || 47436;
const PIN = '1234';

/* The applet over a socket, as the iOS Simulator reaches it; null when no card server is listening. */
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
        what: CHIP ? 'the applet, on the chip in the reader' : 'the applet, in the JavaCard simulator',
        fresh: () => ask('ctl new'),
        tap: async () => { if ((await ask('tap')) !== 'ok') throw new Error('no card on the reader'); },
        send: async (apdu) => { const said = await ask('apdu ' + apdu); if (said === 'gone') throw new Error('the tag was lost'); return said; },
        close: () => sock.destroy(),
      });
    });
  });
}

const held = (b, mint) => {
  try { return (JSON.parse(b.w.localStorage.getItem('foxy.cashu.proofs.' + mint.replace(/\/+$/, ''))) || []).reduce((n, p) => n + Number(p.amount || 0), 0); }
  catch (e) { return 0; }
};

async function at(mintKey, names, real) {
  const MINT = H.MINTS[mintKey].https;
  console.log('\n== ' + names[mintKey]);
  const holder = H.boot({ keychain: { words: '' } });
  const till = H.boot({ keychain: { words: '' } });
  await holder.W.seedReady();
  await till.W.seedReady();

  // every command the card is sent, to count its signatures; and all of them, from the first, to look for a PIN among
  const sent = [];
  const ever = [];
  let card;
  const seeing = (a, answer) => answer.then((r) => { if (String(a).toLowerCase().slice(0, 4) === 'b022' && /9000$/.test(r)) lastSum = parseInt(String(r).slice(0, 8), 16); return r; });
  if (real && !process.env.FOXY_CARD_MODEL) { await real.fresh(); card = { what: real.what, tap: real.tap, send: (a) => { sent.push(String(a).toLowerCase()); ever.push(String(a).toLowerCase()); return seeing(a, real.send(a)); } }; }
  else {
    const m = makeCard({ window: holder.w, format: Number(process.env.FOXY_CARD_MODEL) === 3 ? 3 : 4 });
    card = { what: 'the JavaScript model of the card (no card server on ' + PORT + ')', tap: async () => m.tap(), send: (a) => { sent.push(String(a).toLowerCase()); ever.push(String(a).toLowerCase()); return seeing(a, m.send(a)); } };
  }
  const signatures = () => sent.filter((a) => a.slice(0, 4) === 'b024').length;
  const pieces = () => sent.filter((a) => a.slice(0, 4) === 'b022').reduce((n, a) => n + parseInt(a.substr(8, 2), 16), 0);
  // what the pieces of the last payment came to, as the card answered SPEND_ALL_BEGIN
  let lastSum = 0;
  const pieceSum = () => lastSum;
  console.log('the card: ' + card.what);

  await holder.W.connect(MINT);
  await H.mintAndClaim(holder.W, 40000);
  await holder.W.primeLocks();
  await till.W.connect(MINT);
  await till.W.primeLocks();
  const start = held(holder, MINT);

  await card.tap();
  await holder.W.cardSetUp(card, { pin: PIN, recoverable: true });
  await card.tap();
  const first = await holder.W.cardAdd(card, { sats: 2000, pin: PIN });
  // a mint with a fee: the load is rounded up by the sat or two the card's own pieces will cost to spend
  ok('a card that signs once for a payment, set up and loaded', first.card.info.format === 4 && first.card.balance >= 2000 && first.card.balance < 2040,
     'software ' + first.card.info.version + ', format ' + first.card.info.format + ', ' + first.card.balance + ' on it in ' + first.card.pieces.length + ' pieces');
  const loadCost = start - held(holder, MINT) - 2000;

  // payments: each one signature, the till with exactly what it asked
  let asked = 0, changeBack = 0, exact = 0;
  for (const sats of [1000, 137, 311]) {
    sent.length = 0;
    await card.tap();
    const before = held(till, MINT);
    const seen = await till.W.cardLook(card, { noAuth: true });
    const onCard = seen.balance;
    sent.length = 0;
    await card.tap();
    const paid = await till.W.cardPay(card, { sats, pin: PIN });
    asked += sats;
    const change = (paid.change && paid.change.sats) || 0;
    ok(sats + ' sats: ONE signature, for ' + pieces() + ' piece(s), and the mint takes it', paid.sats === sats && signatures() === 1,
       signatures() + ' signature(s); the till is up ' + (held(till, MINT) - before) + (change ? ', ' + change + ' of change owed to the card' : ', exactly: no change'));
    if (!change) exact += 1;
    if (change) {
      await card.tap();
      const back = await till.W.cardWrite(card, { pin: PIN });
      changeBack += change;
      ok('  its change goes back on at the next tap', back.left === 0 && till.W.cardOwed().length === 0, change + ' sats');
    }
    await card.tap();
    const after = await till.W.cardLook(card, { noAuth: true });
    ok('  the till has what it asked for, and the card is out that and the mint’s fees', held(till, MINT) - before >= sats && onCard - after.balance >= sats && onCard - after.balance - sats < 40,
       'till +' + (held(till, MINT) - before) + ', card -' + (onCard - after.balance));
  }
  ok('with the pieces it had, at least one payment was made exactly, with no change', exact >= 1, exact + ' of 3');

  /* The limit on one payment, which asks no clock and is waited for: over it
   * the card does four signatures of work for every limit's worth past the
   * first, a SIGN command each, and only then signs. The mint sees nothing of
   * that: the one signature it is sent is the same kind as any other. */
  {
    await card.tap();
    await holder.W.cardSetLimit(card, { sats: 100, tap: true });
    await card.tap();
    const asTill = await till.W.cardLook(card, { noAuth: true });
    ok('  the limit is its owner\u2019s to read: the till is told none', asTill.info.tapLimit === 0 && asTill.info.paced === true, 'the till reads ' + asTill.info.tapLimit);
    const onIt = asTill.balance;
    const tb = held(till, MINT);
    sent.length = 0;
    const counted = [];
    await card.tap();
    const paid = await till.W.cardPay(card, { sats: 250, pin: PIN, progress: (p) => { if (p.step === 'waiting') counted.push(p.polls); } });
    await card.tap();
    const left = (await till.W.cardLook(card, { noAuth: true })).balance;
    const change = (paid.change && paid.change.sats) || 0;
    const waits = signatures() - 1;
    ok('a per tap limit of 100, and 250 asked: the card waits, then signs once, and the mint takes it',
       paid.sats === 250 && waits === 4 * (Math.ceil((onIt - left) / 100) - 1) && waits >= 4 && counted.join(',') === Array.from({ length: waits }, (_, i) => i + 1).join(','),
       waits + ' waits for ' + (onIt - left) + ' sats of pieces, each answered "not yet" and no more; the till is up ' + (held(till, MINT) - tb));
    if (change) { await card.tap(); await till.W.cardWrite(card, { pin: PIN }); }
    sent.length = 0;
    await card.tap();
    const small = await till.W.cardPay(card, { sats: 100, pin: PIN });
    ok('  and 100, at the limit (or a sat over it for the mint\u2019s fee), waits nothing or once', small.sats === 100 && signatures() === 1 + 4 * (Math.ceil(pieceSum() / 100) - 1) && signatures() <= 5, signatures() + ' SIGN command(s)');
    if (small.change && small.change.sats) { await card.tap(); await till.W.cardWrite(card, { pin: PIN }); }
    await card.tap();
    await holder.W.cardSetLimit(card, { sats: 0, tap: true });
  }

  /* Its receipts, read by its holder's phone: one for each payment the card has signed, each with the first output of
   * the swap the mint took, and the hash of what was signed. */
  {
    await card.tap();
    const own = await holder.W.cardLook(card, { mine: true });
    const list = holder.W.cardReceipts(own.key);
    ok('the holder\u2019s phone reads a receipt for every payment the card has signed, and its log says what was put on',
       !!own.receipts && own.receipts.count === list.length && list.length >= 5 && list.every((r) => /^0[23][0-9a-f]{64}$/.test(r.out) && /^[0-9a-f]{64}$/.test(r.hash) && r.sats > 0)
       && own.log.last.some((x) => x.loaded > 0),
       list.length + ' receipts, the last for ' + list[list.length - 1].sats + ' sats');
    await card.tap();
    const other = await till.W.cardLook(card, { mine: true });
    ok('  and the till is given none', !other.receipts && !other.log);
  }

  // what change put on the card is money it can sign for: the holder takes all of it off, in one tap
  await card.tap();
  const left = (await holder.W.cardLook(card)).balance;
  const hb = held(holder, MINT);
  sent.length = 0;
  await card.tap();
  const off = await holder.W.cardWithdraw(card, { pin: PIN });
  await card.tap();
  const empty = await holder.W.cardLook(card);
  ok('the holder takes the rest off, change and all, in one tap', empty.balance === 0 && held(holder, MINT) - hb === off.sats && off.sats > 0 && left - off.sats < 40,
     off.sats + ' of ' + left + ' (' + signatures() + ' signature(s) for ' + pieces() + ' pieces; the mint took ' + (left - off.sats) + ')');

  /* A price the card cannot make exactly: loaded in the powers of two of the
   * amount and no more (the card is told, for the cutting only, that it holds
   * every size eight deep already), so 1,000 needs change. One signature
   * still; the change is locked to the card with its flag, written back, and
   * spent again. */
  {
    await card.tap();
    const seen = await holder.W.cardLook(card);
    const sizes = [];
    for (let i = 0; i < 46; i++) for (let k = 0; k < 8; k++) sizes.push({ nonce: 'x'.repeat(i + 1) + k, amount: Math.pow(2, i) });
    await holder.W.cardPrepare(Object.assign({}, seen, { pieces: seen.pieces.concat(sizes) }), 2000);
    await card.tap();
    const on = await holder.W.cardWrite(card, { owner: true });
    const tb = held(till, MINT);
    sent.length = 0;
    await card.tap();
    const paid = await till.W.cardPay(card, { sats: 1000, pin: PIN });
    const change = (paid.change && paid.change.sats) || 0;
    ok('a price it cannot make exactly (' + on.card.pieces.map((x) => x.amount).sort((a, b) => b - a).join('+') + '): one signature, and change', paid.sats === 1000 && signatures() === 1 && change > 0,
       'for ' + pieces() + ' pieces; the till is up ' + (held(till, MINT) - tb) + ' and has made ' + change + ' of change for the card');
    await card.tap();
    const back = await till.W.cardWrite(card, { pin: PIN });
    ok('  the change is written back onto the card', back.left === 0 && till.W.cardOwed().length === 0, change + ' sats, ' + back.card.balance + ' on the card now');
    sent.length = 0;
    await card.tap();
    const again = await till.W.cardPay(card, { sats: 700, pin: PIN });
    ok('  and is money the card signs for again: 700 more, which only the change can make up', again.sats === 700 && signatures() === 1,
       'one signature for ' + pieces() + ' pieces' + ((again.change && again.change.sats) ? ', ' + again.change.sats + ' of change' : ', exactly'));
    if (again.change && again.change.sats) { await card.tap(); await till.W.cardWrite(card, { pin: PIN }); }
    await card.tap();
    await holder.W.cardWithdraw(card, { pin: PIN });
  }
  /* A card of 128 places and its deep drawer (software 1.8): eight of each
   * small size, so prices in a row are each made exactly; a payment of most
   * of a small card, which is more than thirty-two pieces, in one signature;
   * and a till that asks for a set with change worth having, is told "not
   * yet" by a card with a limit it was not told, and pays with the cheapest
   * set instead. */
  if (first.card.info.wide && first.card.info.many) {
    const tally = (list) => list.reduce((o, x) => { o[x.amount] = (o[x.amount] || 0) + 1; return o; }, {});
    await card.tap();
    const deep = await holder.W.cardAdd(card, { sats: 20000, pin: PIN });
    const d = tally(deep.card.pieces);
    ok('20,000 sats go on as a deep drawer: eight or more of every size from 1 to 1,024', [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024].every((a) => d[a] >= 8),
       deep.card.pieces.length + ' pieces: ' + JSON.stringify(d));
    let made = 0;
    const tb = held(till, MINT);
    const prices = [613, 1777, 613, 430, 615, 2047, 1023, 999];
    for (const sats of prices) {
      sent.length = 0;
      await card.tap();
      const paid = await till.W.cardPay(card, { sats, pin: PIN });
      const listed = sent.filter((a) => a.slice(0, 4) === 'b017' && a.substr(6, 2) === '03').length;
      if (paid.sats === sats && !(paid.change && paid.change.sats) && signatures() === 1 && listed === 1) made += 1;
      else if (paid.change && paid.change.sats) { await card.tap(); await till.W.cardWrite(card, { change: true }); }
    }
    ok('eight prices in a row are each paid exactly, with one signature, the card read in one command, and no change',
       made === 8 && held(till, MINT) - tb === prices.reduce((a, b) => a + b, 0), made + ' of 8; the till is up ' + (held(till, MINT) - tb));
    // its drawer filled again, and the whole card taken off: more pieces than an older card had places, in one signature
    await card.tap();
    const refilled = await holder.W.cardAdd(card, { sats: 6000, pin: PIN });
    const hb3 = held(holder, MINT);
    sent.length = 0;
    await card.tap();
    const whole = await holder.W.cardWithdraw(card, { pin: PIN });
    await card.tap();
    const none = await holder.W.cardLook(card);
    ok('a card with its drawer filled again comes off whole in ONE signature for more than sixty-four pieces',
       none.balance === 0 && signatures() === 1 && pieces() === refilled.card.pieces.length && pieces() > 64 && held(holder, MINT) - hb3 === whole.sats,
       signatures() + ' signature(s) for ' + pieces() + ' of its ' + refilled.card.pieces.length + ' pieces, ' + whole.sats + ' sats');

    // most of a small card: more than thirty-two pieces, one signature
    await card.tap();
    const five = await holder.W.cardAdd(card, { sats: 6070, pin: PIN });
    const tb2 = held(till, MINT);
    sent.length = 0;
    await card.tap();
    const most = await till.W.cardPay(card, { sats: 5900, pin: PIN });
    ok('a payment of most of a small card is ONE signature for more than thirty-two pieces, and the mint takes it',
       most.sats === 5900 && signatures() === 1 && pieces() > 32 && held(till, MINT) - tb2 >= 5900,
       pieces() + ' of its ' + five.card.pieces.length + ' pieces; the till is up ' + (held(till, MINT) - tb2));
    if (most.change && most.change.sats) { await card.tap(); await till.W.cardWrite(card, { change: true }); }
    await card.tap();
    await holder.W.cardWithdraw(card, { pin: PIN });

    // a set chosen for its change, on a card that would wait for it: given up at the first "not yet"
    await card.tap();
    const seen = await holder.W.cardLook(card);
    const sizes = [];
    for (let i = 0; i < 46; i++) for (let k = 0; k < 8; k++) sizes.push({ nonce: 'y'.repeat(i + 1) + k, amount: Math.pow(2, i) });
    await holder.W.cardPrepare(Object.assign({}, seen, { pieces: seen.pieces.concat(sizes) }), 4000);
    await card.tap();
    await holder.W.cardWrite(card, { owner: true });
    await card.tap();
    await holder.W.cardSetLimit(card, { sats: 400, tap: true });
    const told = [];
    sent.length = 0;
    await card.tap();
    const cheap = await till.W.cardPay(card, { sats: 250, pin: PIN, progress: (p) => { if (p.step === 'waiting') told.push(p); } });
    ok('a till that first asks for a set with change worth having is told "not yet" once, and pays with the cheapest set: nobody is told to hold',
       cheap.sats === 250 && signatures() === 2 && sent.filter((a) => a.slice(0, 4) === 'b022').length === 2 && pieceSum() <= 400 && told.length === 0,
       signatures() + ' SIGN, ' + pieceSum() + ' sats of pieces signed for');
    if (cheap.change && cheap.change.sats) { await card.tap(); await till.W.cardWrite(card, { change: true }); }
    // and with no limit in the way, the larger set is what pays, and its change fills the drawer
    await card.tap();
    await holder.W.cardSetLimit(card, { sats: 0, tap: true });
    sent.length = 0;
    await card.tap();
    const full = await till.W.cardPay(card, { sats: 250, pin: PIN });
    const back = (full.change && full.change.sats) || 0;
    ok('with no limit, that set pays at once and brings back change worth going back for', full.sats === 250 && signatures() === 1 && back >= 200, back + ' sats of change');
    if (back) {
      sent.length = 0;
      await card.tap();
      const wrote = await till.W.cardWrite(card, { change: true });
      ok('  which goes back on with no PIN, the card read the short way before and after', wrote.left === 0 && till.W.cardOwed().length === 0
         && sent.filter((a) => a.slice(0, 4) === 'b017' && a.substr(6, 2) === '00').length === 0, wrote.card.balance + ' on the card');
    }
    await card.tap();
    await holder.W.cardWithdraw(card, { pin: PIN });
  }

  /* The PIN, sealed (software 1.9): enciphered to a key of the card's own under
   * sixteen bytes of the card's that are good once. Here it is the applet's
   * own key agreement that opens what the wallet sealed. */
  if (first.card.info.sealed) {
    const pins = ever.filter((a) => /^b04[012]/.test(a));
    ok('every PIN so far went to the card sealed: none of the ' + pins.length + ' commands that carry one has it in the clear',
       pins.length >= 8 && pins.every((a) => a.substr(4, 2) === '01' && a.indexOf('31323334') < 0));
    await card.tap();
    await holder.W.cardAdd(card, { sats: 500, pin: PIN });
    await card.tap();
    const wrong = await till.W.cardPay(card, { sats: 100, pin: '9999' }).then(() => null, (e) => e);
    ok('a wrong PIN, sealed, is refused as a wrong PIN, with the tries left', !!wrong && wrong.card === 'wrong-pin' && wrong.tries === 2, wrong && wrong.message);
    // what a listener heard of a good payment, played to the card at another tap
    sent.length = 0;
    await card.tap();
    const good = await till.W.cardPay(card, { sats: 100, pin: PIN });
    const heard = sent.filter((a) => /^b04001/.test(a))[0];
    await card.tap();
    await card.send('00a404000af0464f5859434152440100');
    const cold = await card.send(heard);
    await card.send('b044010071');
    const stale = await card.send(heard);
    const still = await card.send('b0220000' + '01' + '00');
    ok('the envelope heard at one tap opens nothing at another: not tried at all with no fresh bytes, a wrong PIN under new ones, and the card not let into',
       good.sats === 100 && /6985$/.test(cold) && /63c2$/i.test(stale) && /6982$/.test(still), cold + ', ' + stale + ', ' + still);
    // its owner changes the PIN: the new one sealed under the same sixteen bytes the proof is over
    await card.tap();
    await holder.W.cardChangePin(card, { newPin: '24680' });
    await card.tap();
    const old = await till.W.cardPay(card, { sats: 50, pin: PIN }).then(() => null, (e) => e);
    await card.tap();
    const fresh = await till.W.cardPay(card, { sats: 50, pin: '24680' });
    ok('its owner changes the PIN with the new one sealed, and the card takes the new and not the old', !!old && old.card === 'wrong-pin' && fresh.sats === 50);
    await card.tap();
    await holder.W.cardChangePin(card, { newPin: PIN });
    if (till.W.cardOwed().length) { await card.tap(); await till.W.cardWrite(card, { pin: PIN }); }
    await card.tap();
    await holder.W.cardWithdraw(card, { pin: PIN });
  }

  await card.tap();
  const emptied = await holder.W.cardLook(card);
  empty.balance = emptied.balance;

  const now = held(holder, MINT) + held(till, MINT) + empty.balance;
  console.log('    where every sat is: ' + start + ' at the start; now ' + held(holder, MINT) + ' in the holder’s phone, ' + held(till, MINT) + ' in the till, ' + empty.balance + ' on the card; '
    + (start - now) + ' in mint fees (loading cost ' + loadCost + ')');
  ok('nothing is unaccounted for: what is not held was a fee, and it is small', start - now >= 0 && start - now < 400, String(start - now));
  ok('nothing is left owed, unanswered or on file', till.W.cardOwed().length === 0 && till.W.cardTaken().length === 0 && holder.W.cardTaken().length === 0
     && JSON.parse(till.w.localStorage.getItem('foxy.flashcard.swaps') || '[]').length === 0 && JSON.parse(holder.w.localStorage.getItem('foxy.flashcard.swaps') || '[]').length === 0);
  const trouble = till.rec.error.concat(holder.rec.error).filter((l) => !/card:/.test(l));
  ok('and neither wallet logged an error', trouble.length === 0, trouble.slice(0, 2).join(' | '));
}

async function run() {
  const names = await H.mintNames(['cdk', 'nutshell']);
  const real = await applet(PORT);
  if (CHIP && !real) { console.log('no card is listening on ' + PORT); process.exit(1); }
  for (const mint of (CHIP ? [process.env.FOXY_CARD_MINT || 'cdk'] : ['cdk', 'nutshell'])) await at(mint, names, real);
  if (real) real.close();
  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
