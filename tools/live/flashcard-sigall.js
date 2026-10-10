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

/* A real block header, as the network carries it (80 bytes), and the time in it. A card of software 1.15 takes its clock from the newest
 * it has been shown and believes a header for the work in it, so a header that is public and was made some time ago does as well as one
 * from this minute, and needs no network: the applet's day logic runs on it. Shown to the card before the first payment. */
const TIP = '00c02133b973a14eab498ae41fd2054685e7250b36c4bd758ca801000000000000000000ba4fd6d57bfebf73fcf0552a92d5430b78b735cf59c6c58243b2fc48d4669b5a75dcc96af01e021736a8ee8c';
const TIP_TIME = 1791614069;
const TIP_HASH = '00000000000000000001fa7ca83e1eb90d5a1865d8db9684f3f03ca64ccaec8a';
const u32 = (n) => ('00000000' + (n >>> 0).toString(16)).slice(-8);
const SELECT = '00a404000af0464f5859434152440100';

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

/* What the change a card made counts for against its wait, in SIGN commands, by the card's software: `made` pieces. From 1.14
 * (info.costed) two for every three, since a piece is about two thirds of a signature's work; in 1.13 one for each piece. */
const changeCredit = (made, info) => (info.costed ? Math.floor(2 * made / 3) : made);

/* The SIGN commands a payment waits before the signature under a limit on one payment, by the card's software: what leaves the card for
 * good (the pieces less the change it made for itself) and how many pieces of that change it made (`made`).
 *   1.13 and on (info.shaped): nothing within the limit, or a thirty-second over it, change or no change; otherwise seven for the first
 *        limit's worth over it and three for each after, a part counting as one (255 at most), less what the change made counts for
 *        (`changeCredit`: one for each piece in 1.13, two for every three from 1.14).
 *   1.12 (info.ownChange): four for every limit's worth over the limit, a part counting as one, and four for a payment within it that
 *        made change.
 *   before: by the pieces whole, the first limit's worth free. */
const waitsFor = (leaves, limit, made, info) => {
  if (info.shaped) {
    const units = leaves <= limit + Math.floor(limit / 32) ? 1 : Math.min(255, Math.ceil(leaves / limit));
    return units <= 1 ? 0 : Math.max(0, 7 + 3 * (units - 2) - changeCredit(made, info));
  }
  if (!info.ownChange) return leaves > limit ? 4 * (Math.ceil(leaves / limit) - 1) : 0;
  return leaves > limit ? 4 * Math.ceil(leaves / limit) : (made > 0 ? 4 : 0);
};

const held = (b, mint) => {
  try { return (JSON.parse(b.w.localStorage.getItem('foxy.cashu.proofs.' + mint.replace(/\/+$/, ''))) || []).reduce((n, p) => n + Number(p.amount || 0), 0); }
  catch (e) { return 0; }
};

async function at(mintKey, names, real) {
  const MINT = H.MINTS[mintKey].https;
  console.log('\n== ' + names[mintKey]);
  const holder = H.boot({ keychain: { words: '' } });
  // the till's next swap is answered by the mint and the answer is lost on the way back, when a test says so
  let loseNext = false;
  const till = H.boot({ keychain: { words: '' }, net: (m, p) => { if (loseNext && p === '/v1/swap') { loseNext = false; return 'after'; } return 'ok'; } });
  await holder.W.seedReady();
  await till.W.seedReady();

  // every command the card is sent, to count its signatures; and all of them, from the first, to look for a PIN among
  const sent = [];
  const ever = [];
  let card;
  const seeing = (a, answer) => answer.then((r) => { if (String(a).toLowerCase().slice(0, 4) === 'b022' && /9000$/.test(r)) lastSum = parseInt(String(r).slice(0, 8), 16); return r; });
  // a card made new again (a card with no PIN is set up on a new one): the simulator and the model can be, a chip cannot
  let renew = null;
  if (real && !process.env.FOXY_CARD_MODEL) {
    await real.fresh();
    if (!CHIP) renew = async () => { await real.fresh(); };
    card = { what: real.what, tap: real.tap, send: (a) => { sent.push(String(a).toLowerCase()); ever.push(String(a).toLowerCase()); return seeing(a, real.send(a)); } };
  } else {
    let m = makeCard({ window: holder.w, format: Number(process.env.FOXY_CARD_MODEL) === 3 ? 3 : 4 });
    if (Number(process.env.FOXY_CARD_MODEL) !== 3) renew = async () => { m = makeCard({ window: holder.w, format: 4 }); };
    card = { what: 'the JavaScript model of the card (no card server on ' + PORT + ')', tap: async () => m.tap(), send: (a) => { sent.push(String(a).toLowerCase()); ever.push(String(a).toLowerCase()); return seeing(a, m.send(a)); } };
  }
  const signatures = () => sent.filter((a) => a.slice(0, 4) === 'b024').length;
  // the card's own change in the payment just made: how many pieces it was asked to make, and what they come to
  const madePieces = () => sent.filter((a) => a.slice(0, 4) === 'b026').length;
  const madeSats = () => sent.filter((a) => a.slice(0, 4) === 'b026').reduce((n, a) => n + parseInt(a.substr(10, 8), 16), 0);
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

  /* The card's clock (software 1.15 and on), before the first payment: the time a terminal tells it, and the real block header above. A
   * daily limit set on a card that has been shown no block has a day with no start (the card spends its first day on trust); the first
   * block gives it one, and the day begins at the time written in the block. Then the limit is taken off again, so that what follows is
   * as it always was. */
  if (first.card.info.headers) {
    await card.tap();
    await holder.W.cardSetLimit(card, { sats: 1000000 });
    await card.tap();
    const before = (await holder.W.cardLook(card)).info;
    await card.tap();
    await card.send(SELECT);
    const told = await card.send('b0370000' + '04' + u32(Math.floor(Date.now() / 1000)));
    const took = await card.send('b0360000' + '50' + TIP + '04');
    await card.tap();
    const seen = await holder.W.cardLook(card);
    ok('a daily limit on a card that has seen no block has a day with no start; a real block header, shown before the first payment, gives it one',
       before.limit === 1000000 && before.now === 0 && before.windowStart === 0 && told === '9000' && took === u32(TIP_TIME) + '9000'
       && seen.info.now === TIP_TIME && seen.info.windowStart === TIP_TIME && seen.record.headerHash === TIP_HASH && seen.day.turns === TIP_TIME + 86400,
       'the clock was ' + before.now + ' and is ' + seen.info.now + ', the day begins at ' + seen.info.windowStart + ' and turns at ' + seen.day.turns
       + ' (TELL_TIME answered ' + told + ', SET_HEADER ' + took + ')');
    await card.tap();
    await holder.W.cardSetLimit(card, { sats: 0 });
  }

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

  /* The limit on one payment, which asks no clock and is waited for. From
   * software 1.12 the card counts what leaves it for good (the pieces less the
   * change it makes for itself, which is the price and the mint's fee on the
   * pieces). From 1.13 it signs at once within the limit, change or no change,
   * and over it does seven signatures of work for the first limit's worth over
   * and three for each after, less what the change it made counts for (one for
   * each piece in 1.13, two for every three from 1.14), a SIGN command each, and
   * only then signs; 1.12 did four for every limit's worth, and for a payment
   * within the limit that made change. The mint sees nothing of that: the one
   * signature it is sent is the same kind as any other. */
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
    // what left the card for good: the pieces less the change it made for itself (before 1.12, the pieces whole)
    const leaves = (onIt - left) - (first.card.info.ownChange ? madeSats() : 0);
    const made = madePieces();
    ok('a per tap limit of 100, and 250 asked: the card waits, then signs once, and the mint takes it',
       paid.sats === 250 && waits === waitsFor(leaves, 100, made, first.card.info) && waits >= 4 && counted.join(',') === Array.from({ length: waits }, (_, i) => i + 1).join(','),
       waits + ' waits for ' + leaves + ' sats that left the card (' + (onIt - left) + ' of pieces, ' + made + ' pieces of change made by the card), each answered "not yet" and no more; the till is up ' + (held(till, MINT) - tb));
    if (change) { await card.tap(); await till.W.cardWrite(card, { pin: PIN }); }
    sent.length = 0;
    await card.tap();
    const small = await till.W.cardPay(card, { sats: 100, pin: PIN });
    // 100 and the mint's fee on the pieces is 101 or more: from 1.13 still within the limit (a thirty-second over counts as within), and nothing; in 1.12 a limit's worth over, so two, or one for its change
    const smallLeaves = pieceSum() - (first.card.info.ownChange ? madeSats() : 0);
    ok('  and 100, at the limit (or a sat over it for the mint\u2019s fee), waits what it should: ' + (first.card.info.shaped ? 'nothing, change or no change' : 'nothing, one limit\u2019s worth for change within the limit, two for the fee'),
       small.sats === 100 && signatures() === 1 + waitsFor(smallLeaves, 100, madePieces(), first.card.info) && signatures() <= 9,
       signatures() + ' SIGN command(s) for ' + smallLeaves + ' sats that left the card');
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
  /* The card makes its own change (software 1.12): the till names an amount for each output of it, the card answers a blinded message
   * it made itself, and the mint signs for those outputs in the same swap as the till's own. The till keeps what the mint signed and finishes the
   * pieces at the next tap from the card's openings: the nonce makes the secret, the blinding factor takes the blinding off. Nothing a till
   * chooses can take the change, and the mint is the only judge of whether the pieces are good: here they are spent again. */
  if (first.card.info.ownChange) {
    await card.tap();
    const seen = await holder.W.cardLook(card);
    const sizes = [];
    for (let i = 0; i < 46; i++) for (let k = 0; k < 8; k++) sizes.push({ nonce: 'z'.repeat(i + 1) + k, amount: Math.pow(2, i) });
    await holder.W.cardPrepare(Object.assign({}, seen, { pieces: seen.pieces.concat(sizes) }), 2000);
    await card.tap();
    await holder.W.cardWrite(card, { owner: true });
    const tb = held(till, MINT);
    sent.length = 0;
    await card.tap();
    const paid = await till.W.cardPay(card, { sats: 1000, pin: PIN });
    const made = sent.filter((a) => a.slice(0, 4) === 'b026');
    const order = sent.map((a) => a.slice(2, 4)).filter((i) => /^(22|23|26|24)$/.test(i)).join(' ');
    const rows = JSON.parse(till.w.localStorage.getItem('foxy.flashcard.owed') || '[]');
    const change = (paid.change && paid.change.sats) || 0;
    ok('the card is asked for its own change, an amount to a command, between the till’s outputs and its one signature, and the mint takes the swap',
       paid.sats === 1000 && made.length >= 1 && made.length <= 8 && /^22( 23)+( 26)+ 24$/.test(order) && signatures() === 1 && held(till, MINT) - tb === 1000,
       made.length + ' commands for ' + change + ' sats; the till is up ' + (held(till, MINT) - tb));
    ok('  what it is owed is what the mint signed for those outputs, and no token',
       rows.length === 1 && rows[0].kind === 'change' && !rows[0].token && Array.isArray(rows[0].blind) && rows[0].blind.length === made.length && rows[0].sats === change
       && rows[0].blind.every((b) => /^0[23][0-9a-f]{64}$/.test(b.C_) && /^0[23][0-9a-f]{64}$/.test(b.K)),
       JSON.stringify(rows.map((r) => [r.sats, (r.blind || []).length])));
    sent.length = 0;
    await card.tap();
    const back = await till.W.cardWrite(card, { change: true });
    const reads = sent.filter((a) => a.slice(0, 4) === 'b019').length;
    // the card is chosen again, and asked what its change is made of: nothing is left
    await card.tap();
    await card.send('00a404000af0464f5859434152440100');
    const none = await card.send('b019000000');
    ok('  the next tap finishes its pieces from the card’s openings with no PIN, and the card lists none after', back.left === 0 && back.change === change && till.W.cardOwed().length === 0
       && reads >= 1 && /^009000$/i.test(none), back.card.balance + ' on the card, ' + reads + ' page(s) of openings read');
    sent.length = 0;
    await card.tap();
    const again = await till.W.cardPay(card, { sats: 700, pin: PIN });
    ok('  and those pieces are good at the mint: the card pays 700 more with them, in one signature', again.sats === 700 && signatures() === 1, 'the till is up ' + (held(till, MINT) - tb));
    if (again.change && again.change.sats) { await card.tap(); await till.W.cardWrite(card, { change: true }); }
    await card.tap();
    await holder.W.cardWithdraw(card, { pin: PIN });

    /* The swap's answer lost after the mint made it. The till finds its own outputs again by their counters; the card's are not made of
     * anything it holds, so it asks the mint for the signatures by the blinded messages it wrote down before the card signed
     * (NUT-09, the same question a restore of the card's openings by its owner's phone would put), and the change is had. */
    await card.tap();
    const seen2 = await holder.W.cardLook(card);
    const sizes2 = [];
    for (let i = 0; i < 46; i++) for (let k = 0; k < 8; k++) sizes2.push({ nonce: 'q'.repeat(i + 1) + k, amount: Math.pow(2, i) });
    await holder.W.cardPrepare(Object.assign({}, seen2, { pieces: seen2.pieces.concat(sizes2) }), 2000);
    await card.tap();
    await holder.W.cardWrite(card, { owner: true });
    const tb2 = held(till, MINT);
    loseNext = true;
    sent.length = 0;
    await card.tap();
    const lostPay = await till.W.cardPay(card, { sats: 1000, pin: PIN });
    await till.W.recoverSwaps();
    await till.W.cardSettle();
    const lostChange = (lostPay.change && lostPay.change.sats) || 0;
    const rows2 = JSON.parse(till.w.localStorage.getItem('foxy.flashcard.owed') || '[]');
    ok('a swap whose answer is lost after the mint made it: the payment is made, and the card\u2019s change is had from the mint by its blinded messages and owed',
       till.rec.lost.some((x) => x.path === '/v1/swap') && lostPay.sats === 1000 && held(till, MINT) - tb2 === 1000 && lostChange > 0 && rows2.length === 1 && !!rows2[0].blind && rows2[0].sats === lostChange
       && till.W.cardTaken().length === 0 && JSON.parse(till.w.localStorage.getItem('foxy.flashcard.swaps') || '[]').length === 0,
       'the till is up ' + (held(till, MINT) - tb2) + ', ' + lostChange + ' of change owed');
    await card.tap();
    const lostBack = await till.W.cardWrite(card, { change: true });
    const owedAfter = till.W.cardOwed().length;
    sent.length = 0;
    await card.tap();
    const lostAgain = await till.W.cardPay(card, { sats: 700, pin: PIN });
    ok('  and written at the next tap, and the pieces are good at the mint', lostBack.left === 0 && lostBack.change === lostChange && owedAfter === 0 && lostAgain.sats === 700 && signatures() === 1,
       lostBack.card.balance + ' on the card; ' + JSON.stringify({ left: lostBack.left, change: lostBack.change, lostChange, owedAfter, paid: lostAgain.sats, signatures: signatures() }));
    if (lostAgain.change && lostAgain.change.sats) { await card.tap(); await till.W.cardWrite(card, { change: true }); }
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

    /* A set chosen for its change, on a card that has a limit: before 1.12 the card waited by the pieces, so a larger set was given up
     * at the first "not yet" for the cheapest. From 1.12 it waits by what leaves it, which is the same for both sets, and both make change: a
     * payment within the limit that makes change waits one limit's worth, for the one set, and the till is told the card is making change.
     * From 1.13 it waits for nothing within the limit, change or no change: signed at the first asking, and nobody is told to hold. */
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
    if (first.card.info.shaped) {
      ok('a payment within the limit that makes change waits for nothing, with the one set: signed at the first asking, and nobody is told to hold',
         cheap.sats === 250 && signatures() === 1 && sent.filter((a) => a.slice(0, 4) === 'b022').length === 1 && told.length === 0,
         signatures() + ' SIGN, ' + pieceSum() + ' sats of pieces signed for, ' + told.length + ' told to hold');
    } else if (first.card.info.ownChange) {
      ok('a payment within the limit that makes change waits one limit\u2019s worth for it, with the one set: four "not yet", and the till is told the card is making change',
         cheap.sats === 250 && signatures() === 1 + 4 && sent.filter((a) => a.slice(0, 4) === 'b022').length === 1 && told.length === 4 && told.every((p) => p.making === true),
         signatures() + ' SIGN, ' + pieceSum() + ' sats of pieces signed for, ' + told.length + ' told to hold');
    } else {
      ok('a till that first asks for a set with change worth having is told "not yet" once, and pays with the cheapest set: nobody is told to hold',
         cheap.sats === 250 && signatures() === 2 && sent.filter((a) => a.slice(0, 4) === 'b022').length === 2 && pieceSum() <= 400 && told.length === 0,
         signatures() + ' SIGN, ' + pieceSum() + ' sats of pieces signed for');
    }
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
    /* One payment a tap at full speed (software 1.13): the card makes a second payment signed in the same time in the field wait as one
     * over the limit does, with a limit or none: seven signatures, less what the change it makes counts for (`changeCredit`: one for each
     * piece on a card of 1.13, two for every three from 1.14, so four pieces of change leave 3 on the one and 5 on the other). A sheet of
     * the phone remembers what it has had the card sign (`link.one.paid`; `card` here stands in for that link), and says so before the
     * PIN is sent. */
    if (first.card.info.shaped) {
      card.one = {};
      await card.tap();
      sent.length = 0;
      const p1 = await till.W.cardPay(card, { sats: 100, pin: PIN });
      const w1 = signatures() - 1;
      sent.length = 0;
      const ahead = [];
      const p2 = await till.W.cardPay(card, { sats: 100, pin: PIN, progress: (p) => { if (p.step === 'waiting' && p.ahead) ahead.push(p); } });
      const w2 = signatures() - 1, m2 = madePieces();
      delete card.one;
      // (the card of this software's rule for the change: 1.14 two waits off for every three pieces, 1.13 one for each)
      const want2 = Math.max(0, 7 - changeCredit(m2, first.card.info));
      ok('one payment a tap at full speed: the first of a time in the field goes at once, the second waits seven less what its change counts for (' + (first.card.info.costed ? 'two for every three pieces' : 'one for each piece') + '), and the wallet said so before the PIN',
         p1.sats === 100 && w1 === 0 && p2.sats === 100 && w2 === want2 && (w2 === 0 ? ahead.length === 0 : (ahead.length === 1 && ahead[0].left === w2 && ahead[0].second === true)),
         'first ' + w1 + ' waits, second ' + w2 + ' (7 less ' + changeCredit(m2, first.card.info) + ' for ' + m2 + ' pieces of change made by the card), said ' + JSON.stringify(ahead.map((p) => [p.left, p.second])));
      if (till.W.cardOwed().length) { await card.tap(); await till.W.cardWrite(card, { pin: PIN }); }
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
    /* The card not let into: before 1.16 a payment is refused at its beginning, 6982. From it the beginning is taken with no PIN shown (the
     * card looks at the PIN where it signs), and the signature is refused, 6A94, which signs nothing and gives the payment up. */
    let still, signed = '';
    if (first.card.info.noPinKnown) {
      // (a place that holds a piece is begun with, and the card is chosen again in a new tap: nothing is verified in it)
      await card.tap();
      const lk = await till.W.cardLook(card, { noAuth: true });
      await card.tap();
      await card.send(SELECT);
      still = await card.send('b0220000' + '01' + ('0' + lk.pieces[0].i.toString(16)).slice(-2));
      signed = await card.send('b024000040');
    } else {
      still = await card.send('b0220000' + '01' + '00');
    }
    ok('the envelope heard at one tap opens nothing at another: not tried at all with no fresh bytes, a wrong PIN under new ones, and the card not let into',
       good.sats === 100 && /6985$/.test(cold) && /63c2$/i.test(stale) && (first.card.info.noPinKnown ? (/9000$/.test(still) && /6a94$/i.test(signed)) : /6982$/.test(still)),
       cold + ', ' + stale + ', ' + still + (signed ? ', ' + signed : ''));
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

  /* The PIN is optional (software 1.16): a no-PIN allowance on a card with a PIN, and a card with none. The allowance is what a card signs for in
   * the day's window with no PIN shown; a payment within it signs with none, one over it is refused at the signature (6A94: the PIN is wanted
   * for the whole payment) and gives the payment up, and a payment made with the PIN counts nothing against it. A card with no PIN pays with
   * none, and ADD PIN gives it one: every payment asks for it until an allowance is set. The card that is on a chip cannot be made new again,
   * so a card with no PIN is made on the simulator and the model only. */
  if (first.card.info.noPinKnown) {
    await card.tap();
    await holder.W.cardAdd(card, { sats: 1000, pin: PIN });
    await card.tap();
    await holder.W.cardSetLimit(card, { noPin: 300 });
    await card.tap();
    const set = await holder.W.cardLook(card);
    ok('an allowance of 300 is set by the owner, in twelve bytes: the card says it to anybody, and nothing of it is spent',
       set.noPin.set && set.noPin.limit === 300 && set.noPin.spent === 0 && set.noPin.left === 300, JSON.stringify(set.noPin));
    sent.length = 0;
    await card.tap();
    const within = await till.W.cardPay(card, { sats: 200 });
    ok('a payment of 200 within it is signed with no PIN: one signature, no PIN shown to the card', within.sats === 200 && signatures() === 1 && sent.filter((a) => a.slice(0, 4) === 'b040').length === 0,
       'sent ' + sent.map((a) => a.slice(2, 4)).join(' '));
    if (till.W.cardOwed().length) { await card.tap(); await till.W.cardWrite(card, { change: true }); }
    await card.tap();
    const counted = await till.W.cardLook(card, { noAuth: true });
    // what left the card for good: the 200, and the sat or two a mint with a fee takes with it
    const spentOnce = counted.noPin.spent;
    ok('and the card counts it, for anybody who reads it: 200 of 300, and the mint\u2019s fee with it', spentOnce >= 200 && spentOnce <= 202 && counted.noPin.left === 300 - spentOnce, JSON.stringify(counted.noPin));
    // over what is left: the wallet knows from the read, and says so before the card is asked
    sent.length = 0;
    await card.tap();
    const early = await till.W.cardPay(card, { sats: 150 }).then(() => null, (e) => e);
    ok('150 is over the 100 that is left: the read says the PIN is wanted before the card is asked to begin', !!early && early.card === 'pin-needed' && early.early === true && signatures() === 0,
       early && (early.card + ' ' + early.left));
    // and the card's own word, asked all the same: begin one place and sign, which the card refuses, 6A94, and gives up
    await card.tap();
    const look = await till.W.cardLook(card, { noAuth: true });
    // places worth more than what is left of the allowance, largest first
    const places = [];
    let worth = 0;
    for (const x of look.pieces.slice().sort((a, b) => b.amount - a.amount)) { places.push(x.i); worth += x.amount; if (worth > look.noPin.left) break; }
    await card.send(SELECT);
    const begun = await card.send('b0220000' + ('0' + places.length.toString(16)).slice(-2) + places.map((i) => ('0' + i.toString(16)).slice(-2)).join(''));
    const refused = await card.send('b024000040');
    ok('asked all the same, the card begins and refuses to sign: 6A94, nothing signed, the payment given up', /9000$/.test(begun) && /6a94$/i.test(refused), begun.slice(-12) + ', ' + refused);
    await card.tap();
    const after = await till.W.cardLook(card, { noAuth: true });
    ok('and it is nothing: the pieces are all there, and the count is as it was', after.balance === look.balance && after.noPin.spent === spentOnce, after.balance + ' on it, ' + after.noPin.spent + ' counted');
    // with the PIN, the whole payment
    sent.length = 0;
    await card.tap();
    const withPin = await till.W.cardPay(card, { sats: 150, pin: PIN });
    ok('the second tap, with the PIN, pays the whole 150', withPin.sats === 150 && sent.filter((a) => a.slice(0, 4) === 'b040').length === 1);
    if (till.W.cardOwed().length) { await card.tap(); await till.W.cardWrite(card, { change: true }); }
    await card.tap();
    const kept = await till.W.cardLook(card, { noAuth: true });
    ok('which counts nothing against the allowance', kept.noPin.spent === spentOnce && kept.noPin.left === 300 - spentOnce, JSON.stringify(kept.noPin));
    await card.tap();
    const mine = await holder.W.cardLook(card, { mine: true });
    ok('the owner’s log marks the taps made with no PIN', mine.log && mine.log.last.length >= 2 && mine.log.last[0].noPin === false && mine.log.last.some((x) => x.noPin === true),
       JSON.stringify(mine.log && mine.log.last.slice(0, 3).map((x) => [x.sats, x.noPin])));
    await card.tap();
    await holder.W.cardSetLimit(card, { noPin: 0 });
    await card.tap();
    await holder.W.cardWithdraw(card, { pin: PIN });

    // a card with no PIN
    if (renew) {
      await renew();
      await card.tap();
      const bare = await holder.W.cardSetUp(card, { recoverable: true });
      ok('a card is set up with no PIN: its record and its owner, and no allowance to ask for', bare.info.pin === 'none' && bare.info.hasRecord && bare.info.owner && bare.noPin.set === false,
         JSON.stringify([bare.info.pin, bare.info.hasRecord, bare.info.owner]));
      await card.tap();
      const loaded = await holder.W.cardAdd(card, { sats: 1000, owner: true });
      ok('and loaded by its owner', loaded.card.balance >= 1000, String(loaded.card.balance));
      sent.length = 0;
      await card.tap();
      const bareDay = await till.W.cardPay(card, { sats: 300 });
      ok('it pays with no PIN', bareDay.sats === 300 && sent.filter((a) => /^b04[012]/.test(a)).length === 0, 'sent ' + sent.map((a) => a.slice(2, 4)).join(' '));
      if (till.W.cardOwed().length) { await card.tap(); await till.W.cardWrite(card, { change: true }); }
      await card.tap();
      await holder.W.cardSetLimit(card, { sats: 500 });
      await card.tap();
      const limit = await till.W.cardPay(card, { sats: 400 }).then(() => null, (e) => e);
      ok('and its limits hold: a daily limit of 500 refuses 400 more after 300', !!limit && limit.card === 'limit', limit && limit.card);
      await card.tap();
      await holder.W.cardSetLimit(card, { sats: 0 });
      await card.tap();
      const pinned = await holder.W.cardAddPin(card, { pin: PIN });
      ok('ADD PIN gives it one, with the owner’s grant, sealed; the money stays and the allowance is nothing', pinned.info.pin === 'set' && pinned.noPin.set === false && pinned.balance >= 600,
         pinned.info.pin + ', ' + pinned.balance + ' on it');
      await card.tap();
      const asks = await till.W.cardPay(card, { sats: 100 }).then(() => null, (e) => e);
      ok('and every payment asks for the PIN now', !!asks && asks.card === 'pin-needed', asks && asks.card);
      await card.tap();
      const typed = await till.W.cardPay(card, { sats: 100, pin: PIN });
      ok('which is typed, and pays', typed.sats === 100);
      if (till.W.cardOwed().length) { await card.tap(); await till.W.cardWrite(card, { pin: PIN }); }
      await card.tap();
      await holder.W.cardWithdraw(card, { pin: PIN });
    } else {
      console.log('    (a card with no PIN is not made on a chip that cannot be made new: the simulator and the model do that)');
    }
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
  // (FOXY_LIVE_ONLY=nutshell, say, runs one of the two)
  const only = process.env.FOXY_LIVE_ONLY ? String(process.env.FOXY_LIVE_ONLY).split(',') : null;
  for (const mint of (CHIP ? [process.env.FOXY_CARD_MINT || 'cdk'] : (only || ['cdk', 'nutshell']))) await at(mint, names, real);
  if (real) real.close();
  console.log('\n' + R.pass + ' passed, ' + R.fail + ' failed');
  process.exit(R.fail ? 1 : 0);
}
run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
