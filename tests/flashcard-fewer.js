'use strict';
/* flashcard-fewer.js — a card held to a phone for as little time as it can be.
 *
 *     node tests/flashcard-fewer.js
 *
 * A card answers each command in a tenth of a second or so and signs a piece in
 * most of a second, so the hold is made of the commands sent and the pieces
 * signed. This pins what shortens it:
 *
 *   one read of the places on a card (GET_PIECES) in a page for each three
 *   pieces, with the old reads kept for an older applet;
 *   no AUTH in a till's payment, and the payment still true only by the mint;
 *   online, two pieces or one that overpay least, so a tap signs at most two,
 *   with the change written back at the next tap; offline, the exact set of
 *   pieces whenever one exists, by search and not by greed;
 *   what goes onto a card cut like a cash drawer (every power of two from 1 up to
 *   the largest that fits, then the rest), to fill the gaps in what the card
 *   holds, and no more than thirty-two pieces of it (half the card, leaving
 *   room for change), so that any price up to the balance has an exact set
 *   whenever the drawer is complete;
 *   the screen told which piece is being signed or written;
 *   a withdrawal cut short, finished by the next tap;
 *   and a till with no route, taking a card on trust only when the person has
 *   said so, only an exact set, and settling it when it is online.
 */
const { makeCard } = require('./flashcard-card');
const { funded, newCard, binaryLoad, why, history, settle, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();
const amounts = (card) => card.state.slots.filter((x) => x.status === 1).map((x) => parseInt(x.data.substr(16, 8), 16)).sort((a, b) => b - a);
const count = (card, prefix) => card.sent.filter((a) => a.slice(0, prefix.length) === prefix).length;
const offline = (W) => W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
const online = (W) => W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
const CMD = { select: '00a4', time: 'b035', info: 'b001', key: 'b010', auth: 'b015', record: 'b016', pieces: 'b017', slots: 'b014', proof: 'b013', pin: 'b040', spend: 'b020', load: 'b030' };

/* A small deterministic generator, so a failure can be run again. */
function rng(seed) {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

/* Whether every whole price from 1 up to the total is made exactly by some set of these pieces. Worked out the long way,
 * by the sums a set can make, and not by the rule that lets it be known without (each piece no more than one above the
 * sum of those smaller than it, which the other half of the check holds it to). */
function sumsOf(list) {
  const total = list.reduce((a, b) => a + b, 0);
  const can = new Uint8Array(total + 1);
  can[0] = 1;
  list.forEach((p) => { for (let t = total; t >= p; t--) if (can[t - p]) can[t] = 1; });
  return can;
}
function complete(list) {
  const can = sumsOf(list);
  for (let t = 1; t < can.length; t++) if (!can[t]) return false;
  return true;
}
function chain(list) {
  const sorted = list.slice().sort((a, b) => a - b);
  let sum = 0;
  for (const p of sorted) { if (p > sum + 1) return false; sum += p; }
  return true;
}
const isPow2 = (n) => n >= 1 && (n & (n - 1)) === 0;
const total = (l) => l.reduce((a, b) => a + b, 0);

(async () => {
  const H = await funded({}, 40000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const card = newCard(H);
  await H.W.cardSetUp(card, { pin: '1234' });
  card.tap();
  await H.W.cardAdd(card, { sats: 2000, pin: '1234' });

  /* ---- 1: one read ---------------------------------------------------------- */
  {
    card.tap();
    card.sent.length = 0;
    const seen = await H.W.cardLook(card);
    const held = seen.pieces.length;
    const pagesFor = Math.ceil(held / 3);
    ok(held === 32 && seen.balance === 2000, 'a card holding thirty-two pieces (2,000 sats cut like a cash drawer) is read', JSON.stringify(seen.pieces.map((x) => x.amount)));
    ok(count(card, CMD.pieces) === pagesFor && count(card, CMD.slots) === 0 && count(card, CMD.proof) === 0,
       'in ' + pagesFor + ' pages, three pieces to a page, and no read of the states or of any piece by itself', card.sent.map((a) => a.slice(0, 6)).join(' '));
    ok(card.sent.length === 6 + pagesFor, 'a look at it is ' + (6 + pagesFor) + ' commands: select, time, info, key, proof of the key, record and the pages', String(card.sent.length));

    // an applet that does not know the command: the reads before it, and the same card
    card.tap();
    card.sent.length = 0;
    const old = { send: (a) => card.send(a).then((r) => (a.slice(0, 4) === CMD.pieces ? '6d00' : r)) };
    const read = await H.W.cardLook(old);
    ok(count(card, CMD.slots) === 1 && count(card, CMD.proof) === held && card.sent.length === 8 + held,
       'an older applet is read the old way: the command it does not know, and then ' + (1 + held) + ' for the same ' + held + ' pieces', String(card.sent.length));
    ok(JSON.stringify(read.pieces) === JSON.stringify(seen.pieces) && read.balance === seen.balance, 'and the card read is the same card');

    // a card of sixty-four pieces: twenty-two pages
    const full = newCard(H);
    for (let i = 0; i < 64; i++) {
      const n = ('0' + i.toString(16)).slice(-2);
      full.state.slots[i] = { status: i % 5 === 4 ? 2 : 1, data: '0059534ce0bfa19a' + ('00000000' + (1 + i).toString(16)).slice(-8) + n.repeat(32) + '02' + n.repeat(32) + '00000000' };
    }
    await full.send('00a4040009f0464f58594341524400');
    const pages = [];
    let from = 0;
    while (from < 64) {
      const r = await full.send('b017' + ('0' + from.toString(16)).slice(-2) + '0000');
      ok(r.slice(-4) === '9000' && r.length / 2 - 2 <= 255, 'a page from slot ' + from + ' is within a short APDU', String(r.length / 2 - 2));
      if (r.slice(-4) !== '9000') break;
      pages.push(r);
      const next = parseInt(r.slice(0, 2), 16);
      if (!(next > from)) { ok(false, 'every page moves on', r.slice(0, 2)); break; }
      from = next;
    }
    ok(pages.length > 15 && pages.length <= 64, 'sixty-four places take about twenty pages', String(pages.length));
    ok((await full.send('b017400000')) === '6a83', 'and a page from a slot there is not is refused');
    const bad = (hex) => { try { H.W.cardParse.page(hex, 0); return 'read'; } catch (e) { return 'refused'; } };
    ok(bad('40') === 'read' && bad('00') === 'refused' && bad('41') === 'refused' && bad('40c0') === 'refused'
       && bad('4040' + '00'.repeat(10)) === 'refused' && bad('') === 'refused' && bad('zz') === 'refused',
       'a page that does not move on, runs past the card, has a state that is not one or is cut short is not read');
  }

  /* ---- 2: no AUTH in a payment, and paid only by the mint ------------------------ */
  {
    card.tap();
    card.sent.length = 0;
    await H.W.cardLook(card);
    ok(count(card, CMD.auth) === 1, 'the holder’s phone, reading a card to show it, still has the card prove its key');
    card.tap();
    card.sent.length = 0;
    const paid = await R.W.cardPay(card, { sats: 592, pin: '1234' });
    ok(paid.sats === 592 && count(card, CMD.auth) === 0 && count(card, CMD.spend) >= 1 && count(card, CMD.spend) <= 2,
       'a till paid by a card does not ask it to prove its key, and the card signs no more than two pieces', card.sent.map((a) => a.slice(0, 6)).join(' '));
    ok((await bal(R)) === 592, 'and is paid, by the mint’s swap');
    // RECEIVE: the change goes back on at the next tap, with no PIN
    if (paid.change && paid.change.sats > 0 && !paid.change.written) {
      card.tap();
      await R.W.cardWrite(card, { change: true });
    }
    ok(card.balance() === 2000 - 592, 'and with its change written back the card is down by exactly the price', String(card.balance()));

    // a pretend card with a key of its own and the real card’s pieces: the mint refuses what it signs
    const rBefore = await bal(R);
    const fake = makeCard({ window: R.window });
    Object.assign(fake.state, JSON.parse(JSON.stringify(card.state)), { verified: false, nonce: null, grant: false, selected: false });
    const a = await why(R.W.cardPay(fake, { sats: 64, pin: '1234' }));
    await settle();
    ok(a !== 'went through' && (await bal(R)) === rBefore, 'a pretend card with a key of its own gets nothing paid: the mint does not know its pieces', a);

    // one that gives the real card’s key and cannot sign for it: refused before anything is kept
    card.tap();
    const lie = makeCard({ window: R.window });
    Object.assign(lie.state, JSON.parse(JSON.stringify(card.state)), { verified: false, nonce: null, grant: false, selected: false });
    const liar = { send: (x) => lie.send(x).then((r) => (x.slice(0, 4) === CMD.key ? card.key + '9000' : r)) };
    const takenBefore = R.W.cardTaken().length;
    const b = await why(R.W.cardPay(liar, { sats: 64, pin: '1234' }));
    ok(b === 'bad-signature' && (await bal(R)) === rBefore && R.W.cardTaken().length === takenBefore,
       'one that names the real card’s key and signs with another is refused at its first signature, and nothing is kept', b);
  }

  /* ---- 3: the exact set, found by search ---------------------------------------- */
  {
    const rand = rng(20261007);
    const feeOf = (ppk) => (l) => Math.ceil(l.length * ppk / 1000);
    let cases = 0, exactFound = 0, bad = 0, over = 0, fewHad = 0, fewBad = 0, moreHad = 0, moreBad = 0, keptWhole = 0, keptBigger = 0;
    /* What a card would hold after a set of its pieces paid: the rest, and `back` of change cut as a till cuts it (the
     * drawer's gaps first, in a load's worth of places; the plain powers of two where that would round it). Whole when
     * every amount up to all of it has an exact set (`chain`, held to the sums further down). */
    const wholeAfter = (pool, set, back) => {
      const rest = pool.filter((p) => set.indexOf(p) < 0).map((p) => p.amount);
      let cut = back > 0 ? H.W.cardLadder(back, 32, 0, rest) : { denominations: [], extra: 0 };
      if (cut.extra > 0) cut = H.W.cardLadder(back, 64, 0, null, true);
      const after = rest.concat(cut.denominations);
      return chain(after) && H.W.cardReach(after) === total(after);
    };
    for (let n = 0; n < 700; n++) {
      const ppk = [0, 0, 100, 250, 1000][Math.floor(rand() * 5)];
      const stub = { getFeesForProofs: feeOf(ppk) };
      const size = 3 + Math.floor(rand() * 9);
      const pool = [];
      for (let i = 0; i < size; i++) pool.push({ amount: 1 << Math.floor(rand() * 10), secret: 's' + i, id: 'k' });
      const total = pool.reduce((s, p) => s + p.amount, 0);
      const want = 1 + Math.floor(rand() * total);
      const cap = rand() < 0.3 ? 1 + Math.floor(rand() * total) : null;
      // every subset: the fewest pieces that come to exactly the price and the fee on it, and the least that two pieces or one cover it with
      let best = -1, fewLeast = -1, fewCount = 0, coverCount = -1, keepLeast = -1, keepCount = 0;
      for (let m = 1; m < (1 << size); m++) {
        const set = pool.filter((p, i) => m & (1 << i));
        const sum = set.reduce((s, p) => s + p.amount, 0);
        if (cap !== null && sum > cap) continue;
        const need = want + feeOf(ppk)(set);
        if (sum === need && (best < 0 || set.length < best)) best = set.length;
        if (set.length <= 2 && sum >= need && (fewLeast < 0 || sum < fewLeast || (sum === fewLeast && set.length < fewCount))) { fewLeast = sum; fewCount = set.length; }
        // and the least of those that leave the card with no gap, the change cut back onto it as a till cuts it
        if (set.length <= 2 && sum >= need && cap === null && wholeAfter(pool, set, sum - need)
            && (keepLeast < 0 || sum < keepLeast || (sum === keepLeast && set.length < keepCount))) { keepLeast = sum; keepCount = set.length; }
        if (sum >= need && (coverCount < 0 || set.length < coverCount)) coverCount = set.length;
      }
      // with no limit on the day, the set that keeps the drawer whole is the one taken, where there is one
      if (keepLeast > 0) { if (keepLeast > fewLeast) keptBigger += 1; fewLeast = keepLeast; fewCount = keepCount; keptWhole += 1; }
      cases += 1;
      // offline: the exact set, the fewest pieces of it, whenever there is one
      const exactGot = H.W.cardExactPick(stub, pool, want, cap);
      if (best > 0) {
        exactFound += 1;
        const sum = exactGot ? exactGot.reduce((s, p) => s + p.amount, 0) : -1;
        if (!exactGot || sum !== want + feeOf(ppk)(exactGot) || exactGot.length !== best) { bad += 1; if (bad < 4) console.log('  exact missed', JSON.stringify({ ppk, want, cap, pool: pool.map((p) => p.amount), best, got: exactGot && exactGot.map((p) => p.amount) })); }
      }
      // online: two pieces or one, the least over, whenever they cover it; otherwise whatever covers it within the limit
      const got = H.W.cardPick(stub, pool, want, cap);
      if (fewLeast > 0) {
        fewHad += 1;
        const sum = got ? got.reduce((s, p) => s + p.amount, 0) : -1;
        if (!got || got.length > 2 || sum !== fewLeast || got.length !== fewCount) { fewBad += 1; if (fewBad < 4) console.log('  few missed', JSON.stringify({ ppk, want, cap, pool: pool.map((p) => p.amount), fewLeast, got: got && got.map((p) => p.amount) })); }
      } else if (got) {
        const sum = got.reduce((s, p) => s + p.amount, 0);
        if (sum < want + feeOf(ppk)(got) || (cap !== null && sum > cap)) { over += 1; if (over < 4) console.log('  bad cover', JSON.stringify({ ppk, want, cap, pool: pool.map((p) => p.amount), got: got.map((p) => p.amount) })); }
        // more than two needed: still the fewest that cover it
        if (coverCount > 2) {
          moreHad += 1;
          if (got.length !== coverCount) { moreBad += 1; if (moreBad < 4) console.log('  not the fewest', JSON.stringify({ ppk, want, cap, pool: pool.map((p) => p.amount), coverCount, got: got.map((p) => p.amount) })); }
        }
      }
    }
    ok(bad === 0 && exactFound > 100, 'offline, whenever a set of pieces comes to exactly the price and the fee on it, the fewest such pieces are taken, over ' + cases + ' random cards at mints that charge nothing and up to a sat a piece', exactFound + ' of them had one, ' + bad + ' missed');
    ok(fewBad === 0 && fewHad > 100, 'online, whenever two pieces or one cover the price and the fee, the pair or piece taken is the least-overpaying that leaves the card’s drawer with no gap, and the least-overpaying of all where none does or the day has a limit', fewHad + ' of them had one, ' + fewBad + ' missed');
    ok(keptWhole > 30 && keptBigger > 5, 'and that is a larger piece than the least-overpaying one often enough to matter', keptWhole + ' kept the drawer whole, ' + keptBigger + ' of them by over-paying more');
    ok(over === 0, 'and where none does, what is taken covers the price and the fee, and keeps to the day’s limit');
    ok(moreBad === 0 && moreHad > 50, 'and is the fewest pieces that cover it, each being most of a second of holding the card', moreHad + ' needed more than two, ' + moreBad + ' were not the fewest');

    // one price both ways: online a tap signs two pieces and takes change; offline, with no change to be had, it pays exactly
    const stub = { getFeesForProofs: () => 0 };
    const asPool = (list) => list.map((n, i) => ({ amount: n, secret: 'p' + i + '-' + n, id: 'k' }));
    const says = (pick) => pick && pick.map((p) => p.amount).join('+');
    // a drawer with two of its middle rungs: taking one of each leaves no gap
    const pool = asPool([1024, 512, 512, 256, 128, 128, 64, 32, 16, 16, 8, 4, 2, 1]);
    const pick = H.W.cardPick(stub, pool, 592, null);
    ok(says(pick) === '512+128', 'online a price of 592 is paid with 512 and 128, signed largest first, and 48 of change', says(pick));
    const exactPick = H.W.cardExactPick(stub, pool, 592, null);
    ok(exactPick && exactPick.map((p) => p.amount).sort((x, y) => y - x).join('+') === '512+64+16', 'offline it is paid exactly, with 512, 64 and 16', says(exactPick));
    ok(says(H.W.cardPick(stub, pool, 1000, null)) === '1024', 'and 1000 is paid with the 1024');

    /* The drawer kept whole. A card that paid online with its last middle pieces was left with large pieces and small
     * change, and could pay nothing in between exactly: every price a till with no route was asked for was refused. */
    const thin = asPool([8192, 4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1]);
    ok(says(H.W.cardPick(stub, thin, 3000, null)) === '8192', 'a card with one of each size pays 3,000 with its largest piece, whose change fills the drawer again, and not with its 2048 and 1024', says(H.W.cardPick(stub, thin, 3000, null)));
    ok(says(H.W.cardPick(stub, thin, 3000, 5000)) === '2048+1024', 'but under a day’s limit, which is charged the whole of what is signed, it is the 2048 and 1024 that over-pay least', says(H.W.cardPick(stub, thin, 3000, 5000)));
    const spare = asPool([8192, 4096, 4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1]);
    ok(says(H.W.cardPick(stub, spare, 3000, null)) === '4096', 'and with a second 4096 it is that one: the least over-paid that leaves no gap', says(H.W.cardPick(stub, spare, 3000, null)));
    // a card that already has a gap is mended by the change of the piece it pays with
    const gapped = asPool([8192, 4096, 128, 64, 8]);
    const mend = H.W.cardPick(stub, gapped, 50, null);
    ok(says(mend) === '8192', 'a card of two large pieces and a little change pays 50 with the large one whose change fills the gap (the 4096’s would not reach the 8192)', says(mend));
    ok(H.W.cardReach([4096, 128, 64, 8].concat(H.W.cardLadder(8142, 32, 0, [4096, 128, 64, 8]).denominations)) === 4096 + 200 + 8142,
       'after which every amount up to all it holds has an exact set');
    ok(H.W.cardReach([1, 2, 4, 8]) === 15 && H.W.cardReach([1, 2, 8]) === 3 && H.W.cardReach([2, 4]) === 0 && H.W.cardReach([1, 1, 1, 4, 8]) === 15 && H.W.cardReach([]) === 0,
       'how far a card’s pieces reach is the sum of them up to the first that is more than one above those before it');

    // through a whole payment
    card.tap();
    const before = card.balance();
    const rb = await bal(R);
    const exact = await R.W.cardPay(card, { sats: 256 + 128, pin: '1234' });
    ok(exact.sats === 384 && exact.change === null && card.balance() === before - 384 && (await bal(R)) === rb + 384,
       'a payment the card’s pieces make exactly has no change, and the card is not written to', JSON.stringify(exact.change));
  }

  /* ---- 4: what goes onto a card is cut like a cash drawer ----------------------------- */
  {
    const L = (n, most, top, have) => H.W.cardLadder(n, most, top, have);
    const show = (l) => l.denominations.join('+');
    // the drawer, the rest, and then the smallest rungs deepened with the places left (the default cap is a load, 32: half the card)
    const two = L(2000);
    ok(two.denominations.length === 32 && total(two.denominations) === 2000 && two.extra === 0
       && show(two) === '512+256+256+128+128+128+128+64+64+64+64+32+32+32+16+16+16+16+8+8+8+4+4+4+2+2+2+2+1+1+1+1',
       '2,000 sats is thirty-two pieces: every power of two from 1 to 512 once, two more of each of 1 to 128, and then 256, 128, 64, 16, 2 and 1', show(two));
    const sixteen = L(2000, 16);
    ok(sixteen.denominations.length === 16 && total(sixteen.denominations) === 2000 && show(sixteen) === '512+512+256+256+128+128+64+64+32+16+16+8+4+2+1+1',
       'in sixteen pieces it is the drawer and the rest alone: 1 to 512 once, then 512, 256, 128, 64, 16 and 1', show(sixteen));
    const big = L(11000);
    ok(big.denominations.length === 31 && total(big.denominations) === 11000 && big.extra === 0 && complete(big.denominations),
       '11,000 sats is a whole drawer to 4096 in thirty-one pieces, its small rungs deepened', show(big));
    const bigSixteen = L(11000, 16);
    ok(bigSixteen.denominations.length === 15 && total(bigSixteen.denominations) === 11000 && bigSixteen.extra === 0 && !complete(bigSixteen.denominations),
       '11,000 sats is not a whole drawer in sixteen pieces: it has fewer rungs, the biggest taken off first (1 to 64), and the big pieces after them', show(bigSixteen));
    ok(L(1).denominations.join('+') === '1' && L(2).denominations.join('+') === '1+1' && L(3).denominations.join('+') === '2+1' && L(5).denominations.join('+') === '2+1+1+1',
       'a few sats are as small a drawer as they can be: 1 is 1, 2 is 1 and 1, 3 is 2 and 1, 5 is 2 and three 1s');
    ok(L(0).denominations.length === 0 && L(0).sats === 0, 'and nothing is no pieces');
    ok(L(131071, 16).denominations.length === 1 && L(131071, 16).sats === 131072 && L(131071, 16).extra === 1,
       'an amount that is more than the pieces allowed even with no drawer is rounded up, its smallest pieces first, until it is not: 131,071 in sixteen is one piece of 131,072, a sat more', JSON.stringify(L(131071, 16)));
    ok(L(131071).denominations.length === 17 && L(131071).extra === 0, 'and in thirty-two it is its seventeen rungs, nothing added');
    ok(L(0b1111111111111111, 16).denominations.length === 16 && L(0b1111111111111111, 16).extra === 0 && L(0b11111111111111111, 16).denominations.length <= 16,
       'sixteen pieces is allowed, seventeen is not: 65,535 is the sixteen rungs from 1 to 32,768, and nothing is added');
    ok(L(7, 2).sats === 8 && L(7, 2).extra === 1 && L(5, 2).extra === 0 && L(5, 2).denominations.join('+') === '4+1', 'and the limit can be asked for');
    // the mint's largest key is kept to: more of that one
    const small = L(100000, 16, 4096);
    ok(small.sats >= 100000 && small.denominations.every((d) => d <= 4096) && total(small.denominations) === small.sats,
       'a mint whose largest piece is small makes more of that piece, and the sum is right', small.denominations.length + ' pieces');
    const capped = L(1000, 16, 64);
    ok(capped.denominations.every((d) => d <= 64) && total(capped.denominations) === capped.sats && capped.denominations.length <= 16,
       'and a drawer stops at it: no rung above the mint’s largest key', show(capped));

    // the gaps in what a card holds are filled first, the smallest first, then the rest, then the smallest rungs deepened with the places left
    const gap = L(300, 16, 0, [512, 64]);
    ok(show(gap) === '128+64+32+32+16+8+4+4+2+2+2+2+1+1+1+1' && total(gap.denominations) === 300 && gap.denominations.length === 16,
       'a card that holds 512 and 64 is given 300 more as 1, 2, 4, 8, 16, 32 and 128, the sizes it lacked, the rest, and two more of 1, 2 and 4 in the places left', show(gap));
    ok(show(L(3, 16, 0, [512])) === '2+1', 'a gift too small to fill the gaps fills the smallest ones: 3 more is 1 and 2');
    ok(show(L(40, 16, 0, [1, 2, 4, 8, 16, 32])) === '8+8+8+4+4+2+2+2+1+1', 'a card that has the whole drawer is given more of its smallest rungs: 40 is two more each of 1, 2, 4 and 8, and 8 and 2', show(L(40, 16, 0, [1, 2, 4, 8, 16, 32])));
    ok(show(L(40, 2, 0, [1, 2, 4, 8, 16, 32])) === '32+8', 'and, with no places for that, the amount in binary and nothing it did not need', show(L(40, 2, 0, [1, 2, 4, 8, 16, 32])));

    // the property: random loads onto empty cards
    {
      const rand = rng(77);
      let n = 0, whole = 0, bad = 0, shortRungs = 0;
      const check = (amount, top) => {
        const l = L(amount, 16, top);
        const d = l.denominations;
        n += 1;
        const rungsOk = d.every((x) => isPow2(x) && (!top || x <= top));
        if (!rungsOk || total(d) !== l.sats || l.sats < amount || d.length > 16 && l.extra === 0) { bad += 1; console.log('  bad cut', amount, top, show(l)); return; }
        // the full drawer for this amount is the rungs up to the largest whose drawer fits, then the rest
        let r = 0;
        while (Math.pow(2, r + 1) - 1 <= l.sats && (!top || Math.pow(2, r) <= top)) r += 1;
        const rest = (() => { let out = 0, left = l.sats - (Math.pow(2, r) - 1); for (let q = top || Infinity; left > 0;) { let d2 = 1; while (d2 * 2 <= left && d2 * 2 <= q) d2 *= 2; left -= d2; out += 1; } return out; })();
        const fits = r + rest <= 16;
        if (fits && l.extra === 0) {
          whole += 1;
          if (!chain(d) || (l.sats <= 4000 && !complete(d))) { bad += 1; console.log('  a full drawer that is not complete', amount, show(l)); }
        } else if (l.extra === 0) {
          shortRungs += 1;
          // fewer rungs: the rungs there are are the smallest, and the biggest taken off first
          const have = {};
          d.forEach((x) => { have[x] = true; });
          let k = 0;
          while (have[Math.pow(2, k)]) k += 1;
          let tooMany = false;
          for (let q = k + 1; q <= r; q++) {
            // one more rung would have been a drawer too: it did not fit, or this is not the most
            const gaps = []; for (let j = 0; j < q; j++) gaps.push(Math.pow(2, j));
            let left = l.sats - total(gaps); let count = gaps.length;
            if (left >= 0) { for (let d2 = 1; left > 0;) { d2 = 1; while (d2 * 2 <= left && (!top || d2 * 2 <= top)) d2 *= 2; left -= d2; count += 1; } if (count <= 16) tooMany = true; }
          }
          if (tooMany) { bad += 1; console.log('  fewer rungs than it could have had', amount, show(l)); }
        }
      };
      for (let a = 1; a <= 3000; a++) check(a, 0);
      for (let i = 0; i < 400; i++) check(1 + Math.floor(rand() * 200000), rand() < 0.3 ? Math.pow(2, 4 + Math.floor(rand() * 10)) : 0);
      ok(bad === 0 && whole > 2000 && shortRungs > 100, 'over every amount to 3,000 and 400 more up to 200,000, a cut is powers of two that add up, in sixteen pieces, a whole drawer where one fits in them and the most rungs there are room for where not', n + ' cuts, ' + whole + ' whole drawers, ' + shortRungs + ' with fewer rungs, ' + bad + ' bad');
    }

    // the property the cutting is for: random cards and prices
    {
      const rand = rng(20261008);
      const stub = { getFeesForProofs: () => 0 };
      const dummy = (list) => list.map((a, i) => ({ amount: a, secret: 'p' + i + '-' + a, id: 'k' }));
      let cards = 0, completeCards = 0, prices = 0, missed = 0, spent = 0, filled = 0, wrong = 0;
      for (let t = 0; t < 60; t++) {
        // a card made as the wallet makes one: a load, then payments that take pieces off it, and change cut back on
        let held = [];
        const top = rand() < 0.25 ? 1024 : 0;
        const load = (n) => { const l = L(n, 16, top, held); wrong += (total(l.denominations) !== l.sats || l.denominations.length > 16 && l.extra === 0) ? 1 : 0; held = held.concat(l.denominations); };
        load(1 + Math.floor(rand() * 5000));
        for (let step = 0; step < 6; step++) {
          if (step > 0 && rand() < 0.5) load(1 + Math.floor(rand() * 1500));
          const have = total(held);
          if (have > 0 && rand() < 0.6) {
            const price = 1 + Math.floor(rand() * have);
            // a tap at a till offline pays exactly; online, two pieces or one and change cut back on
            const pick = H.W.cardExactPick(stub, dummy(held), price, null) || H.W.cardPick(stub, dummy(held), price, null);
            if (!pick) { missed += 1; continue; }
            const took = pick.map((p) => p.amount);
            const out = held.slice();
            took.forEach((a) => { out.splice(out.indexOf(a), 1); });
            const over = total(took) - price;
            spent += 1;
            held = out;
            if (over > 0) { const l = L(over, 16, top, held); wrong += total(l.denominations) !== over && l.extra === 0 ? 1 : 0; held = held.concat(l.denominations.slice(0, l.extra === 0 ? 99 : 0)); }
          }
          cards += 1;
          if (held.length && chain(held) !== complete(held)) { wrong += 1; console.log('  rule and sums disagree', held.join(',')); }
          if (held.length && chain(held)) {
            completeCards += 1;
            const sums = sumsOf(held);
            const every = total(held) <= 700;
            for (let price = 1; price <= total(held); price++) {
              if (!every && rand() > 0.02) continue;
              prices += 1;
              const pick = H.W.cardExactPick(stub, dummy(held), price, null);
              const sum = pick ? pick.reduce((a, p) => a + p.amount, 0) : -1;
              if (!sums[price] || sum !== price) { missed += 1; if (missed < 4) console.log('  no exact set for', price, 'on', held.join(',')); }
            }
          }
          filled += held.length;
        }
      }
      ok(wrong === 0 && missed === 0 && completeCards > 30 && prices > 3000,
         'over random cards and prices, whenever the drawer is complete an exact set exists for every price up to the balance, and the wallet finds it for an offline till', cards + ' cards, ' + completeCards + ' complete, ' + prices + ' prices, ' + spent + ' payments, ' + missed + ' missed, ' + wrong + ' wrong');
    }

    // the property the choosing is for: a card paid from online, time after time, can still pay any amount offline
    {
      const rand = rng(20261009);
      const stub = { getFeesForProofs: () => 0 };
      const dummy = (list) => list.map((a, i) => ({ amount: a, secret: 'p' + i + '-' + a, id: 'k' }));
      let paid = 0, broke = 0, mended = 0, none = 0, most = 0;
      for (let t = 0; t < 400; t++) {
        // a load of twenty pieces, as a card is given (thirty-two, less the places kept for change)
        let held = L(500 + Math.floor(rand() * 60000), 20, 0, []).denominations.slice();
        if (!chain(held)) continue;
        for (let step = 0; step < 14 && total(held) > 20; step++) {
          const price = 1 + Math.floor(rand() * Math.min(total(held), 6000));
          const pick = H.W.cardPick(stub, dummy(held), price, null);
          if (!pick) { none += 1; break; }
          const took = pick.map((p) => p.amount);
          took.forEach((a) => { held.splice(held.indexOf(a), 1); });
          const back = total(took) - price;
          if (back > 0) { let l = L(back, 32, 0, held); if (l.extra > 0) l = H.W.cardLadder(back, 64, 0, null, true); held = held.concat(l.denominations); most = Math.max(most, l.denominations.length); }
          paid += 1;
          if (!chain(held)) { broke += 1; if (broke < 4) console.log('  a payment of', price, 'with', took.join('+'), 'left a gap:', held.slice().sort((a, b) => b - a).join(',')); break; }
          if (took.length <= 2 && back > price) mended += 1;
        }
      }
      ok(broke === 0 && paid > 800 && none === 0, 'over random cards, each paid from online again and again, no payment leaves a gap: every amount up to what the card holds still has an exact set for a till with no route',
         paid + ' payments, ' + broke + ' left a gap, ' + mended + ' over-paid by more than the price to keep it, the most pieces of change ' + most);
    }

    // loads one after another onto a card keep a complete drawer complete
    {
      const rand = rng(31);
      let bad = 0, runs = 0;
      for (let t = 0; t < 200; t++) {
        let held = [];
        for (let k = 0; k < 4; k++) {
          const l = L(1 + Math.floor(rand() * 900), 16, 0, held);
          const before = held.length === 0 || chain(held);
          held = held.concat(l.denominations);
          runs += 1;
          if (before && l.extra === 0 && !chain(held)) { bad += 1; console.log('  a load broke a whole drawer', held.join(',')); }
        }
      }
      ok(bad === 0, 'and loads one after another onto a card, each cut to fill its gaps, keep a whole drawer whole', runs + ' loads, ' + bad + ' broke it');
    }

    // a pile of small change does not become a card’s pieces
    const P = await funded({}, 12000);
    await P.W.tidyChange().catch(() => {});
    const c = newCard(P);
    await P.W.cardSetUp(c, { pin: '1234' });
    c.tap();
    const added = await P.W.cardAdd(c, { sats: 1000, pin: '1234' });
    ok(amounts(c).join('+') === '256+128+128+64+64+64+64+32+32+32+32+16+16+16+8+8+8+8+4+4+4+2+2+2+2+1+1+1+1' && added.card.balance === 1000 && amounts(c).length === 29,
       'a card loaded from a wallet that has just cut its own small change holds the drawer of the amount, deepened, and none of that change', amounts(c).join('+'));

    // a card with pieces on it is given what it lacks
    c.tap();
    await P.W.cardPay(c, { sats: 3, pin: '1234' });      // 2 and 1 signed
    c.tap();
    const gone = c.balance();
    const more = await P.W.cardLook(c).then((seen) => P.W.cardPrepare(seen, 2));
    ok(more.sats === 2, 'a top-up of 2 sats is cut as the card needs it', JSON.stringify(more));
    c.tap();
    await P.W.cardWrite(c, { pin: '1234' });
    ok(c.balance() === gone + 2 && complete(amounts(c)), 'and the card’s drawer is whole again', amounts(c).join('+'));

    // an amount that needs rounding is rounded, and the screen is told by how much
    const Q = await funded({}, 140000);
    const c2 = newCard(Q);
    await Q.W.cardSetUp(c2, { pin: '1234' });
    c2.tap();
    // a card with places for sixteen pieces and no more (the rest taken, as the phone sees it, and a dozen kept for change)
    const wide = await Q.W.cardLook(c2).then((seen) => Q.W.cardPrepare(Object.assign({}, seen, { info: Object.assign({}, seen.info, { empty: 28 }) }), 131071));
    // the pieces are of the sizes this mint's keys can make: no bigger than its largest
    const most = Q.W.cardMaxPiece();
    const fit = Math.ceil(131072 / most);
    ok(most > 0 && wide.sats === 131072 && wide.rounded === 1 && wide.pieces === fit,
       'a load that needed eighteen pieces, onto a card with places for sixteen, is ' + fit + ' of the mint’s largest, and says it was a sat more', JSON.stringify(Object.assign({ most }, wide)));
    c2.tap();
    await Q.W.cardWrite(c2, { pin: '1234' });
    ok(amounts(c2).join('+') === new Array(fit).fill(most).join('+'), 'and that is what the card holds', amounts(c2).join('+'));
  }

  /* ---- 4b: what a payment signs, on a card cut that way ---------------------------------- */
  {
    for (const [load, pieces] of [[2000, 32], [11000, 31]]) {
      const P = await funded({ feePpk: 0 }, load + 200);
      const Rv = await funded({ sharedMint: P.mint, words: OTHER_WORDS }, 0);
      const c = newCard(P);
      await P.W.cardSetUp(c, { pin: '1234' });
      c.tap();
      await P.W.cardAdd(c, { sats: load, pin: '1234' });
      ok(amounts(c).length === pieces && c.balance() === load, load + ' sats on a card is ' + pieces + ' pieces', amounts(c).join('+'));
      c.tap();
      c.sent.length = 0;
      const before = amounts(c);
      const paid = await Rv.W.cardPay(c, { sats: 600, pin: '1234' });
      const signed = count(c, CMD.spend);
      const left = amounts(c);
      const took = before.slice();
      left.forEach((a) => { took.splice(took.indexOf(a), 1); });
      const over = total(took) - 600;
      ok(paid.sats === 600 && signed <= 2 && signed === took.length && (await bal(Rv)) === 600
         && (over === 0 ? paid.change === null : (paid.change && paid.change.sats === over && paid.change.written === false)),
         'a payment of 600 from it signs no more than two pieces (SEND), and what they come to over the price is change for the card', took.sort((a, b) => b - a).join('+') + ' signed, ' + over + ' over');
      if (over > 0) {
        c.tap();
        await Rv.W.cardWrite(c, { change: true });
      }
      ok(c.balance() === load - 600 && !Rv.W.cardOwed().length, 'and its change is written back at the next tap, with no PIN (RECEIVE): the card is down by exactly 600', String(c.balance()));
      console.log('      ' + load + ' sats: ' + pieces + ' pieces; a payment of 600 signs ' + signed + ' (' + took.join('+') + '), ' + (signed * 0.74).toFixed(1) + ' s of signing');
      await settle();
    }
  }

  /* ---- 5: the screen is told which piece ------------------------------------------ */
  {
    const P = await funded({}, 20000);
    const Rv = await funded({ sharedMint: P.mint, words: OTHER_WORDS }, 0);
    const c = newCard(P);
    await P.W.cardSetUp(c, { pin: '1234' });
    c.tap();
    const writes = [];
    await P.W.cardAdd(c, { sats: 11165, pin: '1234' });
    ok(amounts(c).length === 31 && c.balance() === 11165, '11,165 sats on a card is thirty-one pieces: a drawer to 4096, the rest, and the small rungs deepened', amounts(c).join('+'));
    // the same, with a screen listening
    const c3 = newCard(P);
    await P.W.cardSetUp(c3, { pin: '1234' });
    c3.tap();
    const seen = await P.W.cardLook(c3);
    await P.W.cardPrepare(seen, 1000);
    c3.tap();
    await P.W.cardWrite(c3, { pin: '1234', progress: (p) => writes.push(p.step + ' ' + p.i + '/' + p.n) });
    ok(writes.length === 29 && writes.every((x, i) => x === 'writing ' + (i + 1) + '/29'), 'a card being written to says which piece, of how many (1,000 is twenty-nine)', writes.join(', '));

    const signs = [];
    c.tap();
    const rb = await bal(Rv);
    await Rv.W.cardPay(c, { sats: 3000 + 8192 - 8192, pin: '1234', progress: (p) => signs.push(p.step + ' ' + p.i + '/' + p.n) });
    const signing = signs.filter((x) => /^signing/.test(x));
    ok(signing.length > 0 && signing.every((x, i) => x === 'signing ' + (i + 1) + '/' + signing.length),
       'a card being signed from says which piece, of how many', signs.join(', '));
    ok((await bal(Rv)) === rb + 3000, 'and the payment is made');

    /* ---- 6: a full withdrawal: the pieces, and the hold they make ------------------ */
    const left = c.balance();
    c.tap();
    c.sent.length = 0;
    const steps = [];
    const hb = await bal(P);
    const out = await P.W.cardWithdraw(c, { pin: '1234', progress: (p) => steps.push(p.i + '/' + p.n) });
    const spends = count(c, CMD.spend);
    ok(out.sats === left && (await bal(P)) === hb + left && spends === steps.length && steps[steps.length - 1] === spends + '/' + spends,
       'a full withdrawal signs each piece once and says which', spends + ' pieces, ' + left + ' sats');
    console.log('      withdrawing ' + left + ' sats: ' + spends + ' pieces, ' + (spends * 0.74).toFixed(1) + ' s of signing at 0.74 s a piece, '
      + (c.sent.length - spends) + ' other commands');

    /* ---- 7: a withdrawal cut short is finished by the next tap ----------------------- */
    const w = newCard(P);
    await P.W.cardSetUp(w, { pin: '1234' });
    w.tap();
    await P.W.cardAdd(w, { sats: 3000, pin: '1234' });      // 2048 + 512 + 256 + 128 + 32 + 16 + 8
    const n0 = amounts(w).length, total = w.balance();
    const mine0 = await bal(P);
    w.tap();
    w.leaveBefore('20', 4);          // the fourth piece is not answered
    const cut = await P.W.cardWithdraw(w, { pin: '1234' }).then(() => null, (e) => e);
    const owed = P.W.cardOwed().filter((r) => r.card === w.key);
    const kept = (await bal(P)) - mine0;
    ok(cut && cut.card === 'partial' && cut.sats > 0 && kept === cut.sats && owed.length === 0 && P.W.cardTaken().length === 0,
       'a withdrawal cut short keeps what the card signed: it is in this phone, and nothing waits to go back to the card', cut && cut.message);
    ok(w.balance() > 0 && w.balance() < total && cut.left === w.balance(), 'and the card holds the rest, which the screen is told', w.balance() + ' on the card, ' + (cut && cut.left) + ' said');
    const entry = history(P).filter((e) => e.hash === cut.hash)[0] || {};
    ok(entry.dir === 'in' && entry.sats === cut.sats && entry.memo === 'from card', 'with one entry for what came off', JSON.stringify([entry.dir, entry.sats, entry.memo]));
    w.tap();
    const done = await P.W.cardWithdraw(w, { pin: '1234' });
    ok(w.balance() === 0 && done.sats > 0 && (await bal(P)) === mine0 + cut.sats + done.sats && cut.sats + done.sats <= total,
       'and the next tap takes the rest', cut.sats + ' + ' + done.sats + ' of ' + total);
    ok(n0 >= 5, 'the card had several pieces to cut it in', String(n0));
    await settle();
  }

  /* ---- 8: a till with no route ----------------------------------------------------- */
  {
    // 11,000 sats cut the old way (8192, 2048, 512, 128, 64, 32, 16, 8): there are prices the card cannot make exactly (300, say)
    const P = await funded({ feePpk: 0 }, 14000);
    const Rv = await funded({ sharedMint: P.mint, words: OTHER_WORDS }, 0);
    const c = newCard(P);
    await P.W.cardSetUp(c, { pin: '1234' });
    await binaryLoad(P, c, 11000);
    const rb = await bal(Rv);
    offline(Rv.W);

    // no yes: the card is not touched
    c.tap();
    c.sent.length = 0;
    const refused = await why(Rv.W.cardPay(c, { sats: 592, pin: '1234' }));
    ok(refused !== 'went through' && c.sent.length === 0 && Rv.W.trustedWaiting().length === 0, 'with no route and no yes, a card is refused as it was, and not spoken to', refused);
    ok((await Rv.W.cardOfflineAsk(592)) === false, 'with nobody to ask, the answer is no');
    const asked = [];
    Rv.W.onOfflineOffer((info) => { asked.push(info); return Promise.resolve(false); });
    ok((await Rv.W.cardOfflineAsk(592)) === false && asked.length === 1 && asked[0].sats === 592 && asked[0].scanned === true,
       'the question is the HIGH RISK card’s, with the amount, and a no is a no');
    Rv.W.onOfflineOffer(() => Promise.resolve(true));
    ok((await Rv.W.cardOfflineAsk(592)) === true, 'and a yes is a yes');

    // a yes, and a price the card cannot make: refused before the PIN
    c.tap();
    c.sent.length = 0;
    const inexact = await Rv.W.cardPay(c, { sats: 300, pin: '1234', trusted: true }).then(() => null, (e) => e);
    ok(inexact && inexact.card === 'inexact' && count(c, CMD.pin) === 0 && count(c, CMD.spend) === 0 && Rv.W.trustedWaiting().length === 0,
       'a price the card does not make exactly is refused before the PIN is sent, and says why', inexact && inexact.message);
    ok(/offline/i.test(inexact.message) && /change/i.test(inexact.message), 'in plain words');

    // a yes, and a price it makes
    c.tap();
    c.sent.length = 0;
    const got = await Rv.W.cardPay(c, { sats: 592, pin: '1234', trusted: true });
    ok(got.trusted === true && got.sats === 592 && got.change === null && count(c, CMD.auth) === 0 && count(c, CMD.spend) === 3,
       'a price the card makes exactly is taken on a yes: three pieces signed, and no change', JSON.stringify(got));
    const wait = Rv.W.trustedWaiting();
    ok(wait.length === 1 && wait[0].sats === 592 && Rv.W.cardTaken().length === 0,
       'it waits on trust as a trusted row, not yet money, and nothing is left in the card store', JSON.stringify(wait.map((x) => x.sats)));
    const entry = history(Rv).filter((e) => e.hash === got.hash)[0] || {};
    ok(entry.trusted === true && entry.state === 'pending' && entry.settled === false && entry.dir === 'in' && entry.sats === 592 && entry.card === c.key,
       'with a PENDING entry that says it is on trust', JSON.stringify({ t: entry.trusted, s: entry.state, memo: entry.memo }));
    ok(c.balance() === 11000 - 592, 'and the card is down by exactly that');

    // the day’s limit is looked at before the PIN, as it is online
    c.tap();
    await P.W.cardSetLimit(c, { sats: 100 });
    c.tap();
    c.sent.length = 0;
    const dear = await Rv.W.cardPay(c, { sats: 128, pin: '1234', trusted: true }).then(() => null, (e) => e);
    ok(dear && dear.card === 'limit' && count(c, CMD.pin) === 0, 'a card’s daily limit is kept to offline too', dear && dear.message);
    c.tap();
    await P.W.cardSetLimit(c, { sats: 0 });

    // a card that cannot sign for its own key keeps nothing
    c.tap();
    const fakeCard = makeCard({ window: Rv.window });
    Object.assign(fakeCard.state, JSON.parse(JSON.stringify(c.state)), { verified: false, nonce: null, grant: false, selected: false });
    const liar = { send: (x) => fakeCard.send(x).then((r) => (x.slice(0, 4) === CMD.key ? c.key + '9000' : r)) };
    const noSig = await why(Rv.W.cardPay(liar, { sats: 40, pin: '1234', trusted: true }));
    ok(noSig === 'bad-signature' && Rv.W.trustedWaiting().length === 1, 'a signature that is not good is refused offline, and nothing more is kept', noSig);

    // a second payment, and then the payer gets there first
    c.tap();
    const second = await Rv.W.cardPay(c, { sats: 40, pin: '1234', trusted: true });   // 32 and 8: exact from what is left
    ok(second.trusted === true && Rv.W.trustedWaiting().length === 2, 'a second one is taken the same way');
    // the signed pieces of the second, swapped by somebody else before the till is online
    const rows = JSON.parse(Rv.storage.getItem('foxy.req.unclaimed') || '{}');
    const secondRow = rows[second.hash.replace(/^req-/, '')];
    let lost = null;
    Rv.W._onTrustLost = (x) => { lost = x; };
    let safe = null;
    Rv.W._onTrustSettled = (x) => { safe = x; };
    const thief = await funded({ sharedMint: P.mint, words: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above' }, 0).catch(() => null);
    if (thief && secondRow) {
      const took = await thief.W.receiveToken(secondRow.token).then((r) => r, (e) => ({ why: e && e.message }));
      ok(took && took.sats > 0, 'another phone, online, swaps the signed pieces first', JSON.stringify(took));
      await settle();
    }

    // online again: the first is swapped in and the second is found taken back
    online(Rv.W);
    await Rv.W.claimUnclaimed();
    await settle();
    ok((await bal(Rv)) === rb + 592, 'online again, the first is swapped in at the mint and is the till’s money', String((await bal(Rv)) - rb));
    const done1 = history(Rv).filter((e) => e.hash === got.hash)[0] || {};
    ok(done1.state !== 'pending' && done1.state !== 'failed' && done1.settled !== false && !!safe && safe.sats > 0, 'its entry is settled and the person is told it is safe', JSON.stringify({ s: done1.state, settled: done1.settled }));
    const done2 = history(Rv).filter((e) => e.hash === second.hash)[0] || {};
    ok(!!thief && done2.state === 'failed' && /taken back/.test(String(done2.memo)) && !!lost && Rv.W.trustedWaiting().length === 0 && (await bal(Rv)) === rb + 592,
       'the second, which the mint says was spent first, is marked taken back, and the person is told', JSON.stringify({ s: done2.state, memo: done2.memo }));
    ok(Rv.W.cardOffline() === true, 'the card’s switch is on, and is its own');
    Rv.W.cardOffline(false);
    offline(Rv.W);
    c.tap();
    ok((await why(Rv.W.cardPay(c, { sats: 50, pin: '1234', trusted: true }))) !== 'went through' && Rv.W.trustedWaiting().length === 0, 'with the switch off, a till with no route refuses a card again');
    Rv.W.cardOffline(true);
    await settle();
  }

  console.log('\n' + (failed ? failed + ' flashcard-fewer check(s) failed' : 'all flashcard-fewer checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
