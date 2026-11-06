'use strict';
/* flashcard-tap-time.js — five seconds a tap (decided 2026-11-06), and the phone's own part of a load made short.
 *
 *     node tests/flashcard-tap-time.js
 *
 * "For a good user experience the first load should not spend more than 5 seconds signing/loading"; "one binary set on first
 * load, refill at first online tap"; and a refill per tap keeps the five seconds. This pins:
 *
 *   the budget: 110 ms a piece (89 measured on a phone held well, with headroom), the tap's own commands besides, and so how many
 *     pieces one load and one payment's change write (08a-flashcard.js, "five seconds a tap");
 *   the first load: one binary set of the amount, its piece count and its time by that budget ($25.00 is sixteen pieces);
 *   the first load's rest cut so that every price up to the whole is exact (12,345 and 100,000), as far as thirty pieces allow;
 *   the drawer deepening at later taps a whole set at a time, the smallest size short first, never past the tap's pieces, and the
 *     drawer after the first, second and fourth such taps;
 *   at the defaults, through real taps: a second offline payment from a first load refused for want of exact pieces, a payment's
 *     change cut and written inside its pieces, and a top-up through the card deepening it;
 *   the load sent to the phone as lists of commands, each command the size it always was, stopping at the first the card refuses,
 *     and sent one at a time by a phone that cannot; a card that leaves part way;
 *   no read of the card after a write that went whole, and one where it did not;
 *   the page's background work waiting while a card's sheet is up.
 */
const { funded, newCard, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
// how many whole sets of 1, 2, 4 … 1,024 a drawer holds: the exact payments of any price up to 2,047 it makes offline, one after another
const sets = (amounts) => {
  const c = {};
  amounts.forEach((a) => { c[a] = (c[a] || 0) + 1; });
  let n = 0;
  for (;;) {
    for (let d = 1; d <= 1024; d *= 2) if ((c[d] || 0) < n + 1) return n;
    n += 1;
  }
};
const loads = (card) => card.sent.filter((a) => /^b030/.test(a));

(async () => {
  /* ---- 1: the budget ---------------------------------------------------------------------------------------------------- */
  const H = await funded({}, 200000);
  const W = H.W;
  const B = W.cardTapBudget();
  ok(B.tapMs === 5000 && B.pieceMs === 110 && B.firstDepth === 1, 'five seconds a tap, budgeted at 110 ms a piece; a first load one set deep', JSON.stringify(B));
  ok(B.load === Math.floor((5000 - B.loadOwnMs) / 110) && B.load >= 25 && B.load <= 32 && B.change === Math.floor((5000 - B.payOwnMs) / 110) && B.change >= 12,
     'a load writes at most what fits after its own read and PIN, change what fits after the signing', B.load + ' and ' + B.change);
  ok(W.cardTapEstimate('load', B.load) <= 5000 && W.cardTapEstimate('load', B.load + 1) > 5000 && W.cardTapEstimate('change', B.change) <= 5000,
     'and those are the most that fit five seconds', String(W.cardTapEstimate('load', B.load)));

  /* ---- 2: the first load is one binary set -------------------------------------------------------------------------------- */
  const first = W.cardDeepLadder(2500, B.load, 0, [], B.firstDepth, true).denominations;
  ok(first.length === 16 && first.reduce((a, b) => a + b, 0) === 2500 && sets(first) === 1 && W.cardReach(first) === 2500,
     '$25.00 (2,500 cents): one of each size 1 to 1,024 and the rest in powers of two, sixteen pieces; every price up to the whole is exact', first.join(' '));
  ok(W.cardTapEstimate('load', first.length) === 1600 + 16 * 110 && W.cardTapEstimate('load', first.length) < 5000,
     'and its tap, by the budget: ' + W.cardTapEstimate('load', first.length) + ' ms');

  // a real card, loaded for the first time by its owner, through the phone's sheet
  const card = newCard(H, undefined, { format: 4 });
  await W.cardSetUp(card, { pin: '1234', recoverable: true });
  card.tap();
  let seen = await W.cardLook(card, { mine: true, short: true });
  ok(seen.info.wide && seen.info.many, 'a card of 128 places, cut deep');
  let made = await W.cardPrepare(seen, 2500);
  ok(made.pieces === 16, 'the first load onto it is the binary set: sixteen pieces, not the deep drawer', String(made.pieces));
  H.nfc = card;
  H.batches.length = 0;
  card.sent.length = 0;
  // (under the PIN, as every load of a card of 1.21 and on is: the owner's own grant reads the card again, for what only its owner is told)
  let r = await W.cardSession('Hold the card.', (link) => W.cardWrite(link, { pin: '1234' }));
  ok(r.amount === 2500 && card.balance() === 2500 && loads(card).length === 16 && H.batches.join() === '8,8',
     'written in two lists of eight to the phone, a command a piece as ever', JSON.stringify({ lists: H.batches, loads: loads(card).length }));
  ok(loads(card).every((a) => a.length === loads(card)[0].length), 'every load command the same size', String(loads(card)[0].length / 2));
  const after = card.sent.slice(card.sent.indexOf(loads(card).slice(-1)[0]) + 1);
  ok(after.length === 0 && r.card.balance === 2500 && r.card.info.unspent === 16,
     'nothing asked of the card after the last piece: what it holds is known from what went on', JSON.stringify({ after: after.map((a) => a.slice(0, 4)), bal: r.card.balance }));

  /* ---- 3: later taps deepen it, five seconds at a time ----------------------------------------------------------------------- */
  let have = first.slice();
  const table = [{ tap: 'first load', wrote: first.length, onCard: have.length, sets: sets(have), ms: W.cardTapEstimate('load', first.length) }];
  for (let t = 1; t <= 4; t++) {
    const add = W.cardDeepLadder(2500, B.load, 0, have, 8, true).denominations;
    have = have.concat(add);
    table.push({ tap: 'top-up ' + t, wrote: add.length, onCard: have.length, sets: sets(have), ms: W.cardTapEstimate('load', add.length) });
  }
  ok(table.every((x) => x.wrote <= B.load && x.ms <= 5000), 'every tap writes no more than five seconds of pieces', JSON.stringify(table.map((x) => x.wrote)));
  ok(table[1].sets === 2 && table[2].sets >= 3 && table[4].sets > table[3].sets && table[3].sets > table[2].sets,
     'a whole set more at the first top-up (a second exact payment), more after the second, more after the fourth', JSON.stringify(table.map((x) => x.sets)));
  ok(JSON.stringify(table.map((x) => [x.wrote, x.onCard, x.sets])) === JSON.stringify([[16, 16, 1], [20, 36, 2], [10, 46, 3], [13, 59, 4], [19, 78, 6]]),
     'the drawer after the first load and four top-ups of $25.00', JSON.stringify(table.map((x) => [x.wrote, x.onCard, x.sets])));
  // the change of a payment, cut into the drawer's gaps, a whole set at a time and the smallest first, within the change's pieces
  const short = [1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1];
  const back = W.cardDeepLadder(1500, B.change, 0, short, 8, true).denominations;
  ok(back.length <= B.change && [1, 2, 4, 8, 16, 32, 64, 128, 256, 512].every((d) => back.indexOf(d) >= 0) && back.indexOf(1024) < 0
     && back.reduce((a, b) => a + b, 0) === 1500,
     'change of 1,500 onto a drawer one set deep: one more of each size from the smallest up as far as the money goes, the rest in powers of two', back.join(' '));
  const capped = W.cardDeepLadder(16000, B.change, 0, [], 8, true).denominations;
  ok(capped.length <= B.change && sets(capped) === 1,
     'more money than a tap can cut: as many whole sets as its pieces allow, never more pieces than fit', capped.length + ' pieces');
  const full = W.cardDeepLadder(16376 + 3000, 200, 0, [], 8, true).denominations;
  ok(sets(full) === 8 && full.length === 88 + 7, 'with the room, the plan itself: eight of every size, and 3,000 more in seven powers of two', String(full.length));

  // a top-up of the real card: the pieces it writes, and its tap
  card.tap();
  seen = await W.cardLook(card, { mine: true, short: true });
  made = await W.cardPrepare(seen, 2500);
  ok(made.pieces === 20 && W.cardTapEstimate('load', made.pieces) <= 5000, 'the card’s first top-up: twenty pieces, inside five seconds', String(made.pieces));

  /* ---- 4: a phone that cannot send a list, a refusal, a card that leaves -------------------------------------------------------- */
  H.noMany = true;
  H.batches.length = 0;
  card.sent.length = 0;
  r = await W.cardSession('Hold the card.', (link) => W.cardWrite(link, { owner: true }));
  ok(r.amount === 2500 && card.balance() === 5000 && H.batches.length === 0 && loads(card).length === 20,
     'a phone with no list: the same pieces, one command at a time', JSON.stringify({ bal: card.balance(), lists: H.batches }));
  H.noMany = false;
  // a card that leaves in the middle of a list: what went on stays on, the rest at the next tap, nothing twice
  card.tap();
  seen = await W.cardLook(card, { mine: true, short: true });
  await W.cardPrepare(seen, 1000);
  const owedBefore = W.cardOwed().length;
  card.sent.length = 0;
  let gone = null;
  await W.cardSession('Hold the card.', (link) => {
    // the card leaves three commands into the first list
    const many = link.sendMany;
    link.sendMany = (apdus) => { card.leaveAfter(3); link.sendMany = many; return many(apdus); };
    return W.cardWrite(link, { owner: true });
  }).catch((e) => { gone = e; });
  const part = card.balance();
  ok(!!gone && gone.card === 'gone' && part > 5000 && part < 6000 && W.cardOwed().length === owedBefore,
     'taken away part way through a list: what went on is on, the rest still owed', JSON.stringify({ e: gone && gone.card, bal: part }));
  r = await W.cardSession('Hold the card.', (link) => W.cardWrite(link, { owner: true }));
  ok(card.balance() === 6000 && W.cardOwed().length === 0, 'and the next tap finishes it, nothing written twice', String(card.balance()));

  /* ---- 5: the read after a write that did not go whole is made ------------------------------------------------------------------ */
  card.tap();
  seen = await W.cardLook(card, { mine: true, short: true });
  await W.cardPrepare(seen, 300);
  // a row filed for another unit is left owed, and the card is read again after the write
  const rows = JSON.parse(H.storage.getItem('foxy.flashcard.owed'));
  rows.push(Object.assign({}, rows[0], { id: 'not-this-one', unit: 'usd', amount: 5, sats: 0, token: rows[0].token }));
  H.storage.setItem('foxy.flashcard.owed', JSON.stringify(rows));
  card.sent.length = 0;
  r = await W.cardSession('Hold the card.', (link) => W.cardWrite(link, { owner: true }));
  const tail = card.sent.slice(card.sent.indexOf(loads(card).slice(-1)[0]) + 1);
  ok(r.left === 1 && tail.some((a) => /^00a4/.test(a) || /^b001/.test(a)), 'a write that left a row owed reads the card again after it', JSON.stringify(tail.map((a) => a.slice(0, 4))));
  H.storage.setItem('foxy.flashcard.owed', JSON.stringify(W.cardOwed().filter((x) => x.id !== 'not-this-one')));

  /* ---- 6: the page's background work waits while a sheet is up ------------------------------------------------------------------ */
  const ran = [];
  ok(!W.cardSheetUp(), 'no sheet up');
  W.cardAfter(() => ran.push('now'));
  ok(ran.join() === 'now', 'with no sheet up, work runs at once');
  let during = null;
  await W.cardSession('Hold the card.', (link) => {
    during = W.cardSheetUp();
    W.cardAfter(() => ran.push('after'));
    ok(ran.join() === 'now', 'while the sheet is up, it waits');
    return W.cardLook(link, { short: true });
  });
  await new Promise((go) => setTimeout(go, 10));
  ok(during === true && !W.cardSheetUp() && ran.join() === 'now,after', 'and runs once the sheet is down', ran.join());

  /* ---- 7: a phone test of the first load's depth: `-FoxyFirstDepth N` on a debug build, and the line the test is read from ---------- */
  {
    const D = await funded({}, 20000);
    // as Foxy/FoxyWebView.swift hands it to a debug build's page launched with `-FoxyFirstDepth 4`
    D.window.FOXY_DEBUG = true;
    D.window.__foxyFirstDepth = 4;
    const lines = [];
    const log0 = D.window.console.log;
    D.window.console.log = (...a) => { lines.push(a.join(' ')); return log0.apply(D.window.console, a); };
    const c4 = newCard(D, undefined, { format: 4 });
    await D.W.cardSetUp(c4, { pin: '1234', recoverable: true });
    c4.tap();
    const s4 = await D.W.cardLook(c4, { mine: true, short: true });
    const m4 = await D.W.cardPrepare(s4, 2500);
    const want4 = D.W.cardDeepLadder(2500, B.load, 0, [], 4, true).denominations;
    ok(m4.pieces === want4.length && m4.pieces > 16 && sets(want4) >= 1 && lines.some((l) => /a first load is cut 4 deep for this run/.test(l)),
       '-FoxyFirstDepth 4: a first load is cut four deep for that run, and the log says so once', m4.pieces + ' pieces');
    D.nfc = c4;
    lines.length = 0;
    const w4 = await D.W.cardSession('Hold the card.', (link) => D.W.cardWrite(link, { pin: '1234' }));
    const line = lines.filter((l) => /card: wrote \d+ piece\(s\) in \d+ ms, contact \d+ ms from read to done/.test(l))[0] || '';
    const m = /wrote (\d+) piece\(s\) in (\d+) ms, contact (\d+) ms/.exec(line) || [];
    ok(w4.amount === 2500 && Number(m[1]) === m4.pieces && Number(m[3]) >= Number(m[2]),
       'every write ends with "card: wrote N piece(s) in M ms, contact T ms from read to done", the contact from the card\u2019s first answer in the sheet', line);
    D.window.console.log = log0;
    // not a debug build's page: the argument is not read
    const E = await funded({}, 20000);
    E.window.__foxyFirstDepth = 4;
    const c1 = newCard(E, undefined, { format: 4 });
    await E.W.cardSetUp(c1, { pin: '1234', recoverable: true });
    c1.tap();
    const m1 = await E.W.cardPrepare(await E.W.cardLook(c1, { mine: true, short: true }), 2500);
    ok(m1.pieces === 16, 'a page that is not a debug build\u2019s cuts the first load as decided, one binary set', String(m1.pieces));
  }

  /* ---- 8: every price exact on a first load, and the defaults through real payments and writes --------------------------------- */
  {
    for (const [amt, top] of [[12345, 0], [100000, 0], [32973, 0], [2500, 0]]) {
      const cut = W.cardDeepLadder(amt, B.load, top, [], 1, true, true).denominations;
      ok(cut.length <= B.load && cut.reduce((a, b) => a + b, 0) === amt && W.cardReach(cut) === amt,
         'a first load of ' + amt + ': every price up to the whole is exact, in ' + cut.length + ' pieces', String(W.cardReach(cut)));
    }
    const big = W.cardDeepLadder(1310000, B.load, 0, [], 1, true, true).denominations;
    ok(big.length <= B.load && big.reduce((a, b) => a + b, 0) === 1310000 && W.cardReach(big) >= 200000 && W.cardReach(big) < 1310000,
       'a first load of 1,310,000: thirty pieces cannot make every price exact; every price up to ' + W.cardReach(big) + ' is', big.length + ' pieces');

    // a card loaded once, by its owner, at the defaults; a till at the same mint
    const O = await funded({}, 9000);
    const T = await funded({ sharedMint: O.mint, words: OTHER_WORDS }, 0);
    const k = newCard(O, undefined, { format: 4 });
    await O.W.cardSetUp(k, { pin: '1234', recoverable: true });
    k.tap();
    await O.W.cardAdd(k, { sats: 2000, owner: true });
    const offline = (c) => c.W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
    const online = (c) => c.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
    const pay = (sats, o) => { k.tap(); return T.W.cardPay(k, Object.assign({ sats, pin: '1234' }, o || {})).then((r) => r, (e) => ({ refused: (e && e.card) || (e && e.message) })); };
    offline(T);
    const one = await pay(700, { offline: true });
    const two = await pay(700, { offline: true });
    ok(one.sats === 700 && !one.refused && two.refused === 'inexact' && k.balance() === 1300,
       'offline, a first load pays one price exactly, and the same price again is refused for want of exact pieces (NO CHANGE WHILE OFFLINE)',
       JSON.stringify({ one: one.refused || one.sats, two: two.refused, card: k.balance() }));
    online(T);
    await T.W.claimUnclaimed().catch(() => {});
    // online, the same price is paid with change, and the change is cut and written inside its tap's pieces
    const three = await pay(700);
    const owedChange = T.W.cardOwed().filter((r) => r.card === k.key);
    const changePieces = owedChange.reduce((n, r) => n + (T.W.tokenInfo(r.token) || { proofs: [] }).proofs.length, 0);
    k.tap();
    await T.W.cardWrite(k, { change: true }).catch(() => T.W.cardWrite(k, { pin: '1234' }));
    ok(three.sats === 700 && !three.refused && changePieces <= B.change && k.balance() === 600,
       'online, the price is paid with change, cut inside a payment\u2019s pieces and written at the change tap', JSON.stringify({ card: k.balance(), change: three.change, changePieces }));
    // a top-up through the card deepens it
    k.tap();
    const before = sets((await O.W.cardLook(k, { mine: true })).pieces.map((x) => x.amount));
    k.tap();
    const seenK = await O.W.cardLook(k, { mine: true, short: true });
    const top = await O.W.cardPrepare(seenK, 2500);
    k.tap();
    await O.W.cardWrite(k, { pin: '1234' });
    k.tap();
    const afterK = await O.W.cardLook(k, { mine: true });
    ok(top.pieces <= B.load && k.balance() === 3100 && sets(afterK.pieces.map((x) => x.amount)) > before,
       'a top-up through the card: inside the tap\u2019s pieces, and a whole set deeper', JSON.stringify({ pieces: top.pieces, before, sets: sets(afterK.pieces.map((x) => x.amount)) }));
  }

  console.log('\n| tap | pieces written | estimated contact (110 ms a piece) | pieces on the card | whole sets (exact offline payments) |');
  table.forEach((x) => console.log('| ' + x.tap + ' | ' + x.wrote + ' | ' + (x.ms / 1000).toFixed(2) + ' s | ' + x.onCard + ' | ' + x.sets + ' |'));
  console.log('\n' + (failed ? failed + ' flashcard-tap-time check(s) failed' : 'all flashcard-tap-time checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
