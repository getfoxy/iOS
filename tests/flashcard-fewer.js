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
 *   the exact set of pieces taken whenever one exists, by search and not by
 *   greed, and change only when none does;
 *   what goes onto a card cut like a cash drawer (every power of two from 1 up to
 *   the largest that fits, then the rest), to fill the gaps in what the card
 *   holds, and no more than sixteen pieces of it, so that any price up to the
 *   balance has an exact set whenever the drawer is complete;
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
    ok(paid.sats === 592 && count(card, CMD.auth) === 0 && count(card, CMD.spend) === 3,
       'a till paid by a card does not ask it to prove its key', card.sent.map((a) => a.slice(0, 6)).join(' '));
    ok((await bal(R)) === 592, 'and is paid, by the mint’s swap');

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
    let cases = 0, exactFound = 0, bad = 0, over = 0;
    for (let n = 0; n < 700; n++) {
      const ppk = [0, 0, 100, 250, 1000][Math.floor(rand() * 5)];
      const stub = { getFeesForProofs: feeOf(ppk) };
      const size = 3 + Math.floor(rand() * 9);
      const pool = [];
      for (let i = 0; i < size; i++) pool.push({ amount: 1 << Math.floor(rand() * 10), secret: 's' + i, id: 'k' });
      const total = pool.reduce((s, p) => s + p.amount, 0);
      const want = 1 + Math.floor(rand() * total);
      const cap = rand() < 0.3 ? 1 + Math.floor(rand() * total) : null;
      // every subset: is there one that comes to exactly the price and the fee on it, and with how few pieces
      let best = -1;
      for (let m = 1; m < (1 << size); m++) {
        const set = pool.filter((p, i) => m & (1 << i));
        const sum = set.reduce((s, p) => s + p.amount, 0);
        if (cap !== null && sum > cap) continue;
        if (sum === want + feeOf(ppk)(set) && (best < 0 || set.length < best)) best = set.length;
      }
      const got = H.W.cardPick(stub, pool, want, cap);
      cases += 1;
      if (best > 0) {
        exactFound += 1;
        const sum = got ? got.reduce((s, p) => s + p.amount, 0) : -1;
        if (!got || sum !== want + feeOf(ppk)(got) || got.length !== best) { bad += 1; if (bad < 4) console.log('  exact missed', JSON.stringify({ ppk, want, cap, pool: pool.map((p) => p.amount), best, got: got && got.map((p) => p.amount) })); }
      } else if (got) {
        const sum = got.reduce((s, p) => s + p.amount, 0);
        if (sum < want + feeOf(ppk)(got) || (cap !== null && sum > cap)) { over += 1; if (over < 4) console.log('  bad cover', JSON.stringify({ ppk, want, cap, pool: pool.map((p) => p.amount), got: got.map((p) => p.amount) })); }
      }
    }
    ok(bad === 0 && exactFound > 100, 'whenever a set of pieces comes to exactly the price and the fee on it, the fewest such pieces are taken, over ' + cases + ' random cards at mints that charge nothing and up to a sat a piece', exactFound + ' of them had one, ' + bad + ' missed');
    ok(over === 0, 'and where there is none, what is taken covers the price and the fee, and keeps to the day’s limit');

    // the owner’s case: more pieces and no change beats fewer pieces and change
    const pool = [1024, 512, 256, 128, 64, 16].map((n, i) => ({ amount: n, secret: 'p' + i, id: 'k' }));
    const stub = { getFeesForProofs: () => 0 };
    const pick = H.W.cardPick(stub, pool, 592, null);
    ok(pick && pick.map((p) => p.amount).sort((x, y) => y - x).join('+') === '512+64+16', 'a price of 592 is paid with 512, 64 and 16, not with the 1024 and 432 of change', pick && pick.map((p) => p.amount).join('+'));
    ok(H.W.cardPick(stub, pool, 1000, null).map((p) => p.amount).join('+') === '1024', 'and where no set is exact, one piece that covers it is taken: 1000 is paid with the 1024');

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
    // the drawer, the rest, and then the smallest rungs deepened with the places left (the default cap is the whole card, 60)
    const two = L(2000);
    ok(two.denominations.length === 32 && total(two.denominations) === 2000 && two.extra === 0
       && show(two) === '512+256+256+128+128+128+128+64+64+64+64+32+32+32+16+16+16+16+8+8+8+4+4+4+2+2+2+2+1+1+1+1',
       '2,000 sats is thirty-two pieces: every power of two from 1 to 512 once, two more of each of 1 to 128, and then 256, 128, 64, 16, 2 and 1', show(two));
    const sixteen = L(2000, 16);
    ok(sixteen.denominations.length === 16 && total(sixteen.denominations) === 2000 && show(sixteen) === '512+512+256+256+128+128+64+64+32+16+16+8+4+2+1+1',
       'in sixteen pieces it is the drawer and the rest alone: 1 to 512 once, then 512, 256, 128, 64, 16 and 1', show(sixteen));
    const big = L(11000);
    ok(big.denominations.length === 41 && total(big.denominations) === 11000 && big.extra === 0 && complete(big.denominations),
       '11,000 sats is a whole drawer to 4096 in forty-one pieces, deepened to 512', show(big));
    const bigSixteen = L(11000, 16);
    ok(bigSixteen.denominations.length === 15 && total(bigSixteen.denominations) === 11000 && bigSixteen.extra === 0 && !complete(bigSixteen.denominations),
       '11,000 sats is not a whole drawer in sixteen pieces: it has fewer rungs, the biggest taken off first (1 to 64), and the big pieces after them', show(bigSixteen));
    ok(L(1).denominations.join('+') === '1' && L(2).denominations.join('+') === '1+1' && L(3).denominations.join('+') === '2+1' && L(5).denominations.join('+') === '2+1+1+1',
       'a few sats are as small a drawer as they can be: 1 is 1, 2 is 1 and 1, 3 is 2 and 1, 5 is 2 and three 1s');
    ok(L(0).denominations.length === 0 && L(0).sats === 0, 'and nothing is no pieces');
    ok(L(131071, 16).denominations.length === 1 && L(131071, 16).sats === 131072 && L(131071, 16).extra === 1,
       'an amount that is more than the pieces allowed even with no drawer is rounded up, its smallest pieces first, until it is not: 131,071 in sixteen is one piece of 131,072, a sat more', JSON.stringify(L(131071, 16)));
    ok(L(131071).denominations.length === 17 && L(131071).extra === 0, 'and in sixty it is its seventeen rungs, nothing added');
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
            const pick = H.W.cardPick(stub, dummy(held), price, null);
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
              const pick = H.W.cardPick(stub, dummy(held), price, null);
              const sum = pick ? pick.reduce((a, p) => a + p.amount, 0) : -1;
              if (!sums[price] || sum !== price) { missed += 1; if (missed < 4) console.log('  no exact set for', price, 'on', held.join(',')); }
            }
          }
          filled += held.length;
        }
      }
      ok(wrong === 0 && missed === 0 && completeCards > 30 && prices > 3000,
         'over random cards and prices, whenever the drawer is complete an exact set exists for every price up to the balance, and the wallet finds it', cards + ' cards, ' + completeCards + ' complete, ' + prices + ' prices, ' + spent + ' payments, ' + missed + ' missed, ' + wrong + ' wrong');
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
    // a card with places for sixteen pieces and no more (the rest taken, as the phone sees it)
    const wide = await Q.W.cardLook(c2).then((seen) => Q.W.cardPrepare(Object.assign({}, seen, { info: Object.assign({}, seen.info, { empty: 20 }) }), 131071));
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
    for (const [load, pieces] of [[2000, 32], [11000, 41]]) {
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
      ok(paid.sats === 600 && paid.change === null && total(took) === 600 && signed === took.length && !Rv.W.cardOwed().length && (await bal(Rv)) === 600,
         'a payment of 600 from it is exact: no change, no second swap, no second tap', took.sort((a, b) => b - a).join('+') + ' signed');
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
    ok(amounts(c).length === 37 && c.balance() === 11165, '11,165 sats on a card is thirty-seven pieces: a drawer to 4096, the rest, and the small rungs deepened', amounts(c).join('+'));
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
    ok(cut && cut.card === 'interrupted' && cut.owed > 0 && owed.length === 1 && owed[0].kind === 'refund' && P.W.cardTaken().length === 0,
       'a withdrawal cut short has taken nothing: what the card signed is made into pieces for the card and waits for it', cut && cut.message);
    ok(w.balance() + cut.owed === total && (await bal(P)) === mine0, 'and the card holds the rest, and the phone has taken nothing', w.balance() + ' + ' + cut.owed + ' of ' + total);
    w.tap();
    const back = await P.W.cardWrite(w, { owner: true });
    ok(back.left === 0 && w.balance() === total && P.W.cardOwed().length === 0 && (await bal(P)) === mine0,
       'the next tap puts it back, with the owner’s proof and no PIN: the card holds all it did', String(w.balance()));
    w.tap();
    const done = await P.W.cardWithdraw(w, { pin: '1234' });
    ok(w.balance() === 0 && done.sats === total && (await bal(P)) === mine0 + total, 'and the tap after that takes everything', String(done.sats));
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
