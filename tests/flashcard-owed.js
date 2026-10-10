'use strict';
/* flashcard-owed.js — change a till never handed over, finished by the card's owner (software 1.12 and 1.13).
 *
 *     node tests/flashcard-owed.js
 *
 * A card of software 1.12 makes a payment's change itself and keeps what each piece is made of (an opening: its nonce and
 * its blinding factor) until the piece is written back. The till that owes the change finishes the pieces at the second tap
 * (tests/flashcard-sigall.js, 25 and on). This is the other case, the one the design exists for: a till that never hands the
 * change over, because its phone died or it was never held to the card a second time. The change is at the mint, locked to the
 * card's key, and nobody but the card can spend it; the card still has the openings. So the card's owner reads them, asks the
 * mint for the signatures it already gave for those blinded messages (NUT-09), takes the blinding off, checks the DLEQ, and
 * writes the pieces onto the card in the same tap, with its own grant and no PIN.
 *
 * The mint is the test mint (tests/harness.js), which keeps every signature it makes and answers a restore of the ones it
 * knows and no others, as NUT-09 says; the card is the model, held to the applet's own answers (tests/flashcard-model.js).
 * "The till's phone dies" is its owed row dropped from its storage: what a different phone never had. As every suite that
 * drives the real wallet does, this one ends by asking whether each phone's entries account for what it holds.
 */
const { funded, binaryLoad, history, settle, MINT, MINT2, OTHER_WORDS } = require('./flashcard-kit');
const { makeCard } = require('./flashcard-card');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();
const count = (card, ins) => card.sent.filter((a) => a.slice(0, 4) === 'b0' + ins).length;
const owedRows = (c) => JSON.parse(c.storage.getItem('foxy.flashcard.owed') || '[]');
const swaps = (c) => JSON.parse(c.storage.getItem('foxy.flashcard.swaps') || '[]');
const restores = (c) => c.mint.posted.filter((p) => p.path === '/v1/restore');
const pending = (card) => card.state.openings.filter((x) => x.state === 'pending');
const entry = (c, hash) => history(c).filter((e) => e.hash === hash)[0] || {};
const nonces = (card) => card.state.slots.filter((x) => x.status === 1).map((x) => x.data.substr(24, 64));
const WORDS3 = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const offline = (W) => W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct' });
const online = (W) => W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
// the card that makes its own change and waits four signatures to a limit's worth (1.12), and the card after it (1.13), whose change is cut plainly in four pieces at the most
const card12 = (ctx) => makeCard({ window: ctx.window, format: 4, software: 12 });
const card13 = (ctx) => makeCard({ window: ctx.window, format: 4 });

/* The owner (H, whose words made the card theirs), a till (R) at the same mint, and a card of software 1.12 set up by H. */
async function world(make, opts) {
  const H = await funded(Object.assign({}, opts || {}), 9000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const card = (make || card12)(H);
  await H.W.cardSetUp(card, { pin: '1234', recoverable: true });
  card.tap();
  return { H, R, card };
}
/* The till's phone dies: what it owed the card is gone from it. */
const dies = (c) => c.storage.setItem('foxy.flashcard.owed', '[]');
/* What the owner's read says, as the screen is given it: each state, what it comes to and in how many pieces. */
const says = (card) => (card.owes ? JSON.stringify(card.owes.parts.map((p) => [p.state, p.sats, p.count])) : 'nothing');
const parts = (list) => JSON.stringify(list);
/* An owner's read of the card, with its change looked into. */
async function read(ctx, card, opts) {
  card.tap();
  card.sent.length = 0;
  return ctx.W.cardLook(card, Object.assign({ mine: true, change: true }, opts || {}));
}
/* The mint’s answers to a restore held back until `release()`, for a mint that is slow. */
function holdRestores(ctx) {
  const real = ctx.W._scanResult.bind(ctx.W);
  const held = [], ids = new Set();
  ctx.fate = (m) => { if (/\/v1\/restore$/.test(String(m.url || ''))) ids.add(m.id); return null; };
  ctx.W._scanResult = (id, text, err) => { if (ids.has(id)) { held.push([id, text, err]); return undefined; } return real(id, text, err); };
  return {
    held: () => held.length,
    release() { ctx.W._scanResult = real; ctx.fate = null; held.splice(0).forEach((a) => real(a[0], a[1], a[2])); },
  };
}

(async () => {
  /* ---- 1: a till that never handed the change over ------------------------------------------------------------------ */
  // (1,000 from 1024 512 256 128 64 16: the card of 1.12 takes the 1024 and the 256 and is given 280 back, in three pieces; the card of 1.13 takes the 1024 and is given 24, in two)
  for (const [make, change, k] of [[card12, 280, 3], [card13, 24, 2]]) {
    const { H, R, card } = await world(make);
    await binaryLoad(H, card, 2000);            // 1024 512 256 128 64 16: no exact set for 1000
    card.tap();
    const paid = await R.W.cardPay(card, { sats: 1000, pin: '1234' });
    ok(paid.sats === 1000 && paid.change.sats === change && paid.change.written === false && pending(card).length === k && card.balance() === 1000 - change && R.W.cardOwed().length === 1,
       'a payment the card makes change for: the till is paid 1,000, the card has its openings and the rest of its pieces, and the till owes it the change', JSON.stringify(paid.change));
    const hOwed = owedRows(H).length;
    const openings = pending(card).map((x) => ({ amount: x.amount, nonce: x.nonce, r: x.r, date: x.date }));
    dies(R);
    ok(R.W.cardOwed().length === 0 && pending(card).length === k, 'the till’s phone dies: it owes the card nothing any more, and the card still has its openings');
    // a read that is not asked to look into the change does not
    const plain = await H.W.cardLook(card, { mine: true });
    ok(plain.owes === undefined && owedRows(H).length === hOwed && restores(H).length === 0, 'a read not asked to look into the change (no `change`) does not: the card as it was, nothing fetched');

    const asked = [];
    H.fate = (m) => { if (/\/v1\/restore$/.test(String(m.url || ''))) asked.push(JSON.parse(m.body)); return null; };
    const steps = [], lines = [];
    const seen = await read(H, card, { on: (s) => steps.push(s), progress: (p) => lines.push(p) });
    H.fate = null;
    const cmds = card.sent.map((a) => a.slice(2, 4));
    ok(says(seen) === parts([['put', change, k]]) && seen.owes.wrote === change && seen.owes.sats === change && seen.balance === 1000 && card.balance() === 1000,
       'the owner’s read finds the change owed to the card, fetches it, and puts it on in the same tap: the card holds 1,000 again', says(seen) + ', card ' + seen.balance);
    ok(restores(H).length === 1 && asked.length === 1 && asked[0].outputs.length === k, 'the mint was asked once, for the outputs', parts(asked.map((a) => a.outputs.length)));
    // each output asked for is an opening’s blinded message, made here from the opening: its secret in the card’s own form (the wallet’s text, held to the
    // applet’s vectors), hashed to the curve, plus r times G, by the library the mint’s own signing uses
    const CT = H.window.CashuTS;
    const blindedFor = (op) => CT.blindMessage(H.window.Uint8Array.from(Buffer.from(H.W.cardSecret(op.nonce, card.key, op.date, card.state.record.refund, 4), 'utf8')), BigInt('0x' + op.r)).B_.toHex(true);
    const want = openings.map((op) => op.amount + ':' + blindedFor(op)).sort();
    const got = asked[0].outputs.map((o) => Number(o.amount) + ':' + o.B_).sort();
    ok(parts(got) === parts(want) && asked[0].outputs.every((o) => o.id === H.mint.id), 'and they are the openings’ blinded messages, with their sizes and the mint’s keyset', got.map((x) => x.slice(0, 14)).join(' '));
    ok(cmds.indexOf('19') > 0 && cmds.indexOf('19') < cmds.indexOf('30') && count(card, '19') === (k === 3 ? 2 : 1) && count(card, '30') === 1 && count(card, '40') === 0,
       'the openings are read (a page of three, and the page after it where that page is full), then the pieces go on, three to a command, and no PIN is sent',
       count(card, '19') + ' GET_CHANGE, ' + count(card, '30') + ' LOAD, ' + count(card, '40') + ' PIN');
    ok(steps.join(' ') === 'mint writing' && lines.filter((p) => p.step === 'fetching' && p.sats === change).length === 1 && lines.filter((p) => p.step === 'writing' && p.n === k).length === 1,
       'the screen is told the mint is being asked, for how much, and then that pieces are being written', steps.join(' ') + '; ' + lines.length + ' line(s)');
    ok(pending(card).length === 0 && (await card.send('b019000000')) === '009000', 'the card lists no openings after: it let each go as its piece was written');
    ok(owedRows(H).length === hOwed && H.W.cardOwed().length === 0 && new Set(nonces(card)).size === nonces(card).length, 'the owner owes it nothing, and nothing is on the card twice');
    // a second look finds nothing owed, and asks the mint nothing
    const again = await read(H, card);
    ok(again.owes === undefined && restores(H).length === 1 && count(card, '19') === 1 && count(card, '30') === 0, 'read again, the card has no openings: one command to know it, and the mint is not asked', says(again));
    // and the pieces are the card’s to spend: the whole card pays 1,000 more, at the mint
    card.tap();
    const rest = await R.W.cardPay(card, { sats: 1000, pin: '1234' });
    ok(rest.sats === 1000 && card.balance() === 0 && (await bal(R)) === 2000, 'the pieces made from the card’s openings are good at the mint: the whole card pays 1,000 more', (await bal(R)) + ', card ' + card.balance());
    ok(H.mint.issuedSats() - H.mint.takenSats() === (await bal(R)) + (await bal(H)) + card.balance(),
       'the books: every sat the mint honours is in the till, the owner, or the card', String(H.mint.issuedSats() - H.mint.takenSats()));
    ok(entry(R, paid.hash).changeState === 'not handed', 'the dead till’s entry still says the change was not handed over: that phone was not asked');
    await settle();
  
  }

  /* ---- 2: what the mint has not signed is not made yet ----------------------------------------------------------------
   * The till signed (the card burned its pieces and made its change) but never submitted the swap: the mint knows nothing of the
   * card’s outputs, and answers a restore with none of them. Nothing can be done for them from here; they stay openings, and the
   * holder’s money is in the pieces the card burned, which the take-back by the refund key brings home after their date. */
  {
    const { H, R, card } = await world();
    await binaryLoad(H, card, 2000);
    card.tap();
    R.fate = (m) => (/\/v1\/swap$/.test(String(m.url || '')) ? '0\n' : null);
    const lost = await R.W.cardPay(card, { sats: 1000, pin: '1234' }).then(() => null, (e) => e);
    R.fate = null;
    ok(lost && lost.card === 'waiting' && card.balance() === 720 && pending(card).length === 3 && swaps(R).length === 1 && R.W.cardTaken().length === 1 && (await bal(R)) === 0,
       'the swap never reaches the mint: the card has signed, its three openings are pending, and the till holds what it signed and its swap’s row', lost && lost.card);
    const n0 = restores(H).length;
    const seen = await read(H, card);
    ok(says(seen) === parts([['unmade', 280, 3]]) && seen.owes.wrote === 0 && seen.balance === 720 && restores(H).length === n0 + 1,
       'the owner’s read asks, and the mint has signed nothing for them: said as not made yet by the till', says(seen));
    ok(pending(card).length === 3 && owedRows(H).length === 0 && H.W.cardOwed().length === 0 && count(card, '30') === 0, 'the openings are as they were, nothing is owed, and nothing was written');
    const again = await read(H, card);
    ok(says(again) === parts([['unmade', 280, 3]]) && restores(H).length === n0 + 2, 'asked again at the next read, as often as the owner reads the card', says(again));
    // the till comes back and makes its swap: the mint signs the card’s outputs, and the next read of the owner finds them
    await R.W.recoverSwaps();
    await settle();
    const settled = await R.W.cardSettle();
    await settle();
    const made = settled.filter((x) => x.state === 'paid')[0] || {};
    ok(made.sats === 1000 && (await bal(R)) === 1000 && R.W.cardOwed().length === 1, 'the till comes back and the swap is made: it is paid, and it owes the card its change', parts(made));
    const done = await read(H, card);
    ok(says(done) === parts([['put', 280, 3]]) && done.owes.wrote === 280 && card.balance() === 1000 && pending(card).length === 0, 'and the owner’s next read fetches it and puts it on', says(done));
    // the till, still holding its row, taps the card for its change after all: the pieces are on the card, and are not written twice
    card.tap();
    card.sent.length = 0;
    const late = await R.W.cardWrite(card, { change: true });
    ok(late.left === 0 && card.balance() === 1000 && count(card, '30') === 0 && R.W.cardOwed().length === 0 && new Set(nonces(card)).size === nonces(card).length,
       'the till’s own tap after that writes nothing: the card holds the pieces, none is on it twice, and the till’s row is cleared', 'card ' + card.balance());
    ok(entry(R, made.id).changeState === 'given back', 'and its entry says given back');
    await settle();
  }

  /* ---- 3: one read, two tills: part is fetched, part is not made yet ------------------------------------------------- */
  {
    const { H, R, card } = await world();
    const R2 = await funded({ sharedMint: H.mint, words: WORDS3 }, 0);
    await binaryLoad(H, card, 2000);
    card.tap();
    const first = await R.W.cardPay(card, { sats: 1000, pin: '1234' });
    dies(R);
    const afterFirst = card.balance();
    card.tap();
    R2.fate = (m) => (/\/v1\/swap$/.test(String(m.url || '')) ? '0\n' : null);
    const second = await R2.W.cardPay(card, { sats: 400, pin: '1234' }).then(() => null, (e) => e);
    R2.fate = null;
    const open = pending(card).length;
    const owedSecond = pending(card).reduce((n, x) => n + x.amount, 0) - first.change.sats;
    ok(first.change.sats === 280 && second && second.card === 'waiting' && open > 3 && owedSecond > 0 && card.balance() + 400 + owedSecond === afterFirst,
       'two payments by two tills: the first’s till dies, the second’s never makes its swap; the card has the openings of both', open + ' openings, ' + owedSecond + ' for the second');
    const seen = await read(H, card);
    ok(says(seen) === parts([['put', 280, 3], ['unmade', owedSecond, open - 3]]) && seen.owes.wrote === 280 && seen.owes.sats === 280 + owedSecond && seen.balance === afterFirst - 400 - owedSecond + 280,
       'one read says each by itself: what was fetched and put on, and what the second till has not made', says(seen));
    ok(pending(card).length === open - 3, 'and the card has the second payment’s openings left', String(pending(card).length));
    await settle();
  }

  /* ---- 4: the same phone is the till and the owner ------------------------------------------------------------------- */
  {
    const { H, card } = await world();
    await binaryLoad(H, card, 2000);
    card.tap();
    const paid = await H.W.cardPay(card, { sats: 1000, pin: '1234' });
    const owed = H.W.cardOwed();
    ok(paid.sats === 1000 && paid.change.sats === 280 && owed.length === 1 && owed[0].kind === 'change' && owed[0].sats === 280 && pending(card).length === 3,
       'the phone that owns a card is paid by it: it owes the card its change, as any till does', parts(paid.change));
    const seen = await read(H, card);
    ok(says(seen) === parts([['fetched', 280, 3]]) && seen.owes.wrote === 0 && restores(H).length === 0 && card.balance() === 720 && count(card, '30') === 0,
       'the owner’s read finds the openings are this phone’s to finish: the mint is not asked, nothing is written, and it says the change is fetched', says(seen));
    ok(H.W.cardOwed().length === 1 && entry(H, paid.hash).changeState === 'not handed', 'it is still owed to the card, and the payment’s entry still says not handed over');
    // the change tap, as before
    card.tap();
    const wrote = await H.W.cardWrite(card, { owner: true });
    ok(wrote.left === 0 && wrote.change === 280 && card.balance() === 1000 && pending(card).length === 0 && H.W.cardOwed().length === 0 && entry(H, paid.hash).changeState === 'given back',
       'and the change tap writes it, as before: the entry says given back', 'card ' + card.balance());

    // the same, with the row lost: the owner fetches it, and the payment’s entry is found by what its change came to
    card.tap();
    const again = await H.W.cardPay(card, { sats: 500, pin: '1234' });
    const change2 = again.change.sats, pieces2 = owedRows(H)[0].blind.length;
    ok(again.sats === 500 && change2 > 0 && owedRows(H).length === 1 && entry(H, again.hash).changeState === 'not handed', 'a second payment to the same phone, its change owed', parts(again.change));
    dies(H);
    const fetched = await read(H, card);
    ok(says(fetched) === parts([['put', change2, pieces2]]) && restores(H).length === 1 && pending(card).length === 0,
       'its row lost, the owner’s read has nothing of this phone’s for the openings: it fetches the change from the mint and puts it on', says(fetched));
    ok(entry(H, again.hash).changeState === 'given back' && entry(H, again.hash).changeKept === true && entry(H, paid.hash).changeState === 'given back',
       'and the payment’s entry, found by what its change came to, says given back; the other is as it was', entry(H, again.hash).changeState);
    await settle();
  }

  /* ---- 5: no connection, and a card at another mint ------------------------------------------------------------------- */
  {
    const { H, R, card } = await world(null, { second: true });
    await binaryLoad(H, card, 2000);
    card.tap();
    await R.W.cardPay(card, { sats: 1000, pin: '1234' });
    dies(R);
    offline(H.W);
    const seen = await read(H, card);
    ok(says(seen) === parts([['offline', 280, 3]]) && seen.owes.wrote === 0 && restores(H).length === 0 && pending(card).length === 3 && count(card, '30') === 0,
       'with no connection the owner’s read says so and leaves them: the mint is not asked, nothing is written', says(seen));
    online(H.W);
    // this phone is at another mint than the card’s: the mint to ask is the card’s
    await H.W.connect(MINT2, null, null, { remember: false });
    const away = await read(H, card);
    ok(says(away) === parts([['away', 280, 3]]) && away.owes.wrote === 0 && restores(H).length === 0 && H.mint2.posted.filter((p) => p.path === '/v1/restore').length === 0 && pending(card).length === 3,
       'at another mint than the card’s, it says so, and asks neither: the card’s mint is the one that signed for it', says(away));
    await H.W.connect(MINT, null, null, { remember: false });
    const back = await read(H, card);
    ok(says(back) === parts([['put', 280, 3]]) && card.balance() === 1000, 'back at the card’s mint, the next read does it', says(back));
    await settle();
  }

  /* ---- 6: a mint that is slow ---------------------------------------------------------------------------------------- */
  {
    const { H, R, card } = await world();
    await binaryLoad(H, card, 2000);
    card.tap();
    await R.W.cardPay(card, { sats: 1000, pin: '1234' });
    dies(R);
    H.W._cardFetchWait = 40;
    const hold = holdRestores(H);
    const seen = await read(H, card);
    ok(says(seen) === parts([['fetching', 280, 3]]) && seen.owes.wrote === 0 && typeof seen.owes.later.then === 'function' && card.balance() === 720 && count(card, '30') === 0,
       'a mint that has not answered when the wait is over: the tap goes on, nothing is written, and the read says it is being fetched', says(seen));
    // a second read while the first is still being answered joins it: one request
    const second = await read(H, card);
    ok(says(second) === parts([['fetching', 280, 3]]) && hold.held() === 1, 'a second read while the mint is still being asked is the same asking: one request', 'held ' + hold.held());
    hold.release();
    const later = await seen.owes.later;
    await settle();
    ok(parts(later.parts.map((p) => [p.state, p.sats, p.count])) === parts([['fetched', 280, 3]]) && owedRows(H).length === 1 && owedRows(H)[0].fetched === true && owedRows(H)[0].kind === 'change' && owedRows(H)[0].sats === 280,
       'when it does, what the mint signed is kept as owed to the card, once', parts(later.parts) + ', ' + owedRows(H).length + ' row(s)');
    ok(H.W.cardOwed().length === 1 && H.W.cardOwed()[0].sats === 280 && H.W.cardOwed()[0].kind === 'change', 'and it is on the list of what is waiting to go onto a card');
    H.W._cardFetchWait = 15000;
    const n = restores(H).length;
    const next = await read(H, card);
    ok(says(next) === parts([['put', 280, 3]]) && next.owes.wrote === 280 && card.balance() === 1000 && restores(H).length === n && owedRows(H).length === 0,
       'the owner’s next read puts it on, and does not ask the mint again', says(next));
    await settle();

    // the till is late and not dead: it puts the change on after the owner has fetched it and before the owner has put it on; the
    // owner’s next read finds no openings and settles what it had fetched, with nothing put on the card twice
    const L = await world();
    await binaryLoad(L.H, L.card, 2000);
    L.card.tap();
    await L.R.W.cardPay(L.card, { sats: 1000, pin: '1234' });
    L.H.W._cardFetchWait = 40;
    const holdL = holdRestores(L.H);
    const lateRead = await read(L.H, L.card);
    holdL.release();
    await lateRead.owes.later;
    await settle();
    ok(owedRows(L.H).length === 1 && owedRows(L.H)[0].fetched === true && L.H.W.cardOwed().length === 1, 'a mint that answered late: what it signed is owed to the card, on the owner’s phone');
    L.card.tap();
    const taken = await L.R.W.cardWrite(L.card, { change: true });
    ok(taken.left === 0 && L.card.balance() === 1000 && pending(L.card).length === 0 && L.R.W.cardOwed().length === 0, 'the till taps the card for its change, and puts it on', 'card ' + L.card.balance());
    const stale = await read(L.H, L.card);
    ok(stale.owes === undefined && L.H.W.cardOwed().length === 0 && owedRows(L.H).length === 0 && L.H.W.cardStuck().length === 0 && L.card.balance() === 1000
       && new Set(nonces(L.card)).size === nonces(L.card).length && count(L.card, '30') === 0,
       'the owner’s read finds no openings and settles what it had fetched: nothing is left saying change is waiting, nothing is stuck, and nothing was written', 'card ' + L.card.balance());
    L.H.W._cardFetchWait = 15000;

    // two readings while the mint is slow, the second with more openings than the first: both are answered, and each output of
    // the card’s is owed to it once
    const Q = await world();
    await binaryLoad(Q.H, Q.card, 2000);
    Q.card.tap();
    await Q.R.W.cardPay(Q.card, { sats: 1000, pin: '1234' });
    dies(Q.R);
    Q.H.W._cardFetchWait = 40;
    const holdQ = holdRestores(Q.H);
    const qFirst = await read(Q.H, Q.card);
    Q.card.tap();
    await Q.R.W.cardPay(Q.card, { sats: 400, pin: '1234' });
    dies(Q.R);
    const both = pending(Q.card).length, bothSats = pending(Q.card).reduce((n, x) => n + x.amount, 0), heldSats = Q.card.balance();
    const qSecond = await read(Q.H, Q.card);
    ok(says(qFirst) === parts([['fetching', 280, 3]]) && says(qSecond) === parts([['fetching', bothSats, both]]) && both > 3 && holdQ.held() === 2,
       'two readings while the mint is slow, the second with more openings: two askings, since they are not the same set', says(qSecond) + ', held ' + holdQ.held());
    holdQ.release();
    await Promise.all([qFirst.owes.later, qSecond.owes.later]);
    await settle();
    const filed = owedRows(Q.H).reduce((all, r) => all.concat(r.blind.map((b) => b.B_)), []);
    ok(owedRows(Q.H).length >= 1 && filed.length === both && new Set(filed).size === both && owedRows(Q.H).reduce((n, r) => n + r.sats, 0) === bothSats && Q.H.W.cardOwed().reduce((n, r) => n + r.sats, 0) === bothSats,
       'both are answered, and every output the card made is owed to it once and no more', owedRows(Q.H).map((r) => r.blind.length + ' for ' + r.sats).join(', '));
    Q.H.W._cardFetchWait = 15000;
    const finish = await read(Q.H, Q.card);
    ok(says(finish) === parts([['put', bothSats, both]]) && Q.card.balance() === heldSats + bothSats && pending(Q.card).length === 0 && Q.H.W.cardOwed().length === 0 && new Set(nonces(Q.card)).size === nonces(Q.card).length,
       'and the next read puts all of it on, none of it twice', says(finish) + ', card ' + Q.card.balance());

    // a mint that does not answer at all: said so, and left
    const K = await world();
    await binaryLoad(K.H, K.card, 2000);
    K.card.tap();
    await K.R.W.cardPay(K.card, { sats: 1000, pin: '1234' });
    dies(K.R);
    K.H.fate = (m) => (/\/v1\/restore$/.test(String(m.url || '')) ? '500\n{"detail":"down"}' : null);
    const silent = await read(K.H, K.card);
    K.H.fate = null;
    ok(says(silent) === parts([['silent', 280, 3]]) && silent.owes.wrote === 0 && owedRows(K.H).length === 0 && pending(K.card).length === 3, 'a mint that answers with an error: said, and the openings are left', says(silent));
    await settle();
  }

  /* ---- 7: a signature that does not check out is not written ----------------------------------------------------------- */
  {
    const { H, R, card } = await world();
    await binaryLoad(H, card, 2000);
    card.tap();
    await R.W.cardPay(card, { sats: 1000, pin: '1234' });
    dies(R);
    const realHandle = H.mint.handle.bind(H.mint);
    const flip = (hex) => (hex[0] === 'a' ? 'b' : 'a') + hex.slice(1);
    H.fate = (m) => {
      if (!/\/v1\/restore$/.test(String(m.url || ''))) return null;
      const res = realHandle(m), at = res.indexOf('\n');
      const body = JSON.parse(res.slice(at + 1));
      body.signatures[1].dleq.e = flip(body.signatures[1].dleq.e);
      return res.slice(0, at + 1) + JSON.stringify(body);
    };
    const seen = await read(H, card);
    H.fate = null;
    const stuck = H.W.cardStuck();
    const bad = stuck[0] ? stuck[0].sats : 0;
    ok(stuck.length === 1 && stuck[0].why === 'signature' && stuck[0].blind.length === 1 && bad > 0 && says(seen) === parts([['put', 280 - bad, 2], ['stuck', bad, 1]]),
       'a mint whose DLEQ on one output does not check out: that piece is not written, and is kept apart; the others went on, and the read says which', says(seen));
    ok(card.balance() === 720 + 280 - bad && pending(card).length === 1 && H.W.cardOwed().length === 0, 'the card has the pieces that were good, and the opening of the one that was not is still on it', 'card ' + card.balance());
    const n = restores(H).length;
    const again = await read(H, card);
    ok(says(again) === parts([['stuck', bad, 1]]) && restores(H).length === n, 'at the next read it is said again, and the mint is not asked for what it signed wrongly', says(again));
    await settle();
  }

  /* ---- 8: the card leaves ---------------------------------------------------------------------------------------------- */
  {
    // part way through the pieces: what went on stays on, and the next read finishes the rest and writes nothing twice
    const { H, R, card } = await world();
    await binaryLoad(H, card, 4000);               // 2048 1024 512 256 128 32
    card.tap();
    const paid = await R.W.cardPay(card, { sats: 681, pin: '1234' });
    dies(R);
    const after = card.balance();
    ok(paid.sats === 681 && paid.change.sats === 343 && pending(card).length === 6, 'a change of six pieces, two commands to write', pending(card).length + ' openings');
    card.tap();
    card.sent.length = 0;
    card.leaveBefore('30', 2);
    const cut = await H.W.cardLook(card, { mine: true, change: true });
    ok(says(cut) === parts([['fetched', 343, 6]]) && cut.owes.wrote === 0 && card.balance() > after && card.balance() < after + 343 && pending(card).length === 3 && owedRows(H).length === 1,
       'the card is taken away after the first three pieces: they are on it, the rest is kept as owed, and the read still answers', says(cut) + ', card ' + card.balance());
    const leftSats = pending(card).reduce((n, x) => n + x.amount, 0);
    const fin = await read(H, card);
    ok(says(fin) === parts([['put', leftSats, 3]]) && card.balance() === after + 343 && pending(card).length === 0 && owedRows(H).length === 0 && new Set(nonces(card)).size === nonces(card).length && count(card, '30') === 1,
       'the next read finishes the three that are left, and no more: nothing is on the card twice', says(fin) + ', card ' + card.balance());

    // gone as the pieces were put on, before it could be read again: the card as it was read, with what went on added
    const G = await world();
    await binaryLoad(G.H, G.card, 2000);
    G.card.tap();
    await G.R.W.cardPay(G.card, { sats: 1000, pin: '1234' });
    dies(G.R);
    G.card.tap();
    // (the read before the write sends GET_INFO twice; its read again is the third)
    G.card.leaveBefore('01', 3);
    const gone = await G.H.W.cardLook(G.card, { mine: true, change: true });
    ok(says(gone) === parts([['put', 280, 3]]) && gone.owes.wrote === 280 && gone.balance === 1000 && G.card.balance() === 1000 && pending(G.card).length === 0,
       'gone as it was put on, before the card could be read again: the read still answers, with what went on added to its balance', says(gone) + ', ' + gone.balance);
    await settle();
  }

  /* ---- 9: whose it is to finish ---------------------------------------------------------------------------------------- */
  {
    // a card of software 1.11 has no openings, and nobody asks it for any
    const { H, R } = await world();
    const old = makeCard({ window: H.window, format: 4, software: 11 });
    await H.W.cardSetUp(old, { pin: '1234', recoverable: true });
    await binaryLoad(H, old, 2000);
    old.tap();
    await R.W.cardPay(old, { sats: 1000, pin: '1234' });
    const seen = await read(H, old);
    ok(seen.owes === undefined && count(old, '19') === 0 && seen.info.ownChange === false, 'a card before 1.12 is not asked for its openings: it has none', says(seen));
    old.tap();
    await R.W.cardWrite(old, { change: true });

    // a phone that is not the owner is a till like any other: the card says so, and nothing is read or fetched
    const W2 = await world();
    await binaryLoad(W2.H, W2.card, 2000);
    W2.card.tap();
    await W2.R.W.cardPay(W2.card, { sats: 1000, pin: '1234' });
    dies(W2.R);
    const notMine = await read(W2.R, W2.card);
    ok(notMine.mine === false && notMine.owes === undefined && count(W2.card, '19') === 0 && restores(W2.R).length === 0 && pending(W2.card).length === 3,
       'a phone that does not own the card reads it and does not look into its change: it is not its to finish', 'mine ' + notMine.mine);

    // a card with nothing owed: one command to know it
    const N = await world();
    await binaryLoad(N.H, N.card, 2000);
    const none = await read(N.H, N.card);
    ok(none.owes === undefined && count(N.card, '19') === 1 && restores(N.H).length === 0 && count(N.card, '30') === 0, 'a card with no openings costs the owner’s read one command', count(N.card, '19') + ' GET_CHANGE');
    await settle();
  }

  console.log('\n' + (failed ? failed + ' flashcard-owed check(s) failed' : 'all flashcard-owed checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
