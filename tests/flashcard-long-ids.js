'use strict';
/* flashcard-long-ids.js — a card at a mint whose keysets have the long names.
 *
 *     node tests/flashcard-long-ids.js
 *
 * A place on the card has eight bytes for the keyset a piece is of. A mint's
 * older keysets are named by eight bytes; its newer ones (NUT-02's second
 * kind) by thirty-three, with a short form of eight. The other flashcard
 * suites run at a mint of the older kind. This one runs at the newer, which
 * is what the mints in use had become by the time a card was first tried
 * against one: every piece was refused as a kind the card could not hold.
 *
 * So: the card is given the short form; the phone turns it back into the
 * whole name against the mint's own list before a mint sees the piece; and a
 * short form that could mean two of a mint's keysets is not guessed at. */
const { funded, newCard, why, history, OTHER_WORDS } = require('./flashcard-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const bal = (c) => c.W.balanceSats();

(async () => {
  const H = await funded({ versionByte: 1 }, 6000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const tok = H.W.tokenInfo((await H.W.sendToken(1, { unit: 'sat' })).token);
  const long = String(tok.proofs[0].id);
  ok(/^01[0-9a-f]{64}$/.test(long), 'this mint names its keyset by thirty-three bytes', long.slice(0, 20) + '… (' + long.length / 2 + ' bytes)');

  const card = newCard(H);
  await H.W.cardSetUp(card, { pin: '1234', recoverable: true });
  card.tap();
  const added = await H.W.cardAdd(card, { sats: 2000, pin: '1234' });
  ok(added.sats === 2000 && added.left === 0 && card.balance() === 2000, 'money goes onto a card at it', String(card.balance()));
  card.tap();
  const read = await H.W.cardLook(card);
  ok(read.pieces.length > 0 && read.pieces.every((x) => x.keyset === long.slice(0, 16)),
     'each place holds the first eight bytes of the name, which is its short form', read.pieces[0] && read.pieces[0].keyset);
  const checked = await H.W.cardCheck(read);
  ok(checked.sats === 2000 && checked.spent === 0, 'the mint is asked about the pieces by their whole name, and says they are unspent');

  card.tap();
  const paid = await R.W.cardPay(card, { sats: 1000, pin: '1234' });
  ok(paid.sats === 1000 && (await bal(R)) === 1000 && paid.change && paid.change.written,
     'another phone is paid by it, with change written back', JSON.stringify(paid.change));
  ok(history(R).some((e) => e.hash === paid.hash && e.sats === 1000), 'with its entry');
  card.tap();
  const before = await bal(H);
  const out = await H.W.cardWithdraw(card, { pin: '1234' });
  ok(out.sats > 0 && (await bal(H)) === before + out.sats && card.balance() === 0, 'and its own phone empties it', String(out.sats));

  // a lost card: the registry holds the short form, and the taking back asks by the whole name
  card.tap();
  await H.W.cardAdd(card, { sats: 512, pin: '1234' });
  const real = H.window.Date.now.bind(H.window.Date);
  H.window.Date.now = () => real() + 366 * 86400000;
  const hb = await bal(H);
  const back = await H.W.cardTakeBack(card.key);
  H.window.Date.now = real;
  ok(back.sats > 0 && (await bal(H)) === hb + back.sats, 'a lost card’s money is taken back at such a mint too', String(back.sats));

  /* ---- ecash made for a card and filed nowhere -----------------------------
   * What happened the first time a card was tried at a mint like this one:
   * the pieces were made, locked to the card, and the step after that threw
   * before they were filed as owed to it. They were out of the balance, on
   * no list, and only the card could spend them. Made here the same way: a
   * locked send to the card's key, and nothing else. */
  {
    const cash = newCard(H);
    await H.W.cardSetUp(cash, { pin: '1234' });
    const had = await bal(H);
    const lost = await H.W.sendToken(23, { unit: 'sat', lockTo: cash.key, purpose: 'card' });
    ok(lost.sats === 23 && (await bal(H)) === had - 23 && H.W.cardOwed().length === 0,
       '23 sats locked to a card and owed to nobody: out of the balance and on no list');
    cash.tap();
    await H.W.cardLook(cash);
    const found = H.W.cardOwed();
    ok(found.length === 1 && found[0].card === cash.key && found[0].sats === 23,
       'reading the card finds them: they are filed as owed to it', JSON.stringify(found.map((r) => [r.sats, r.kind])));
    ok(history(H).some((e) => e.hash === lost.hash && e.memo === 'to card') && H.W.tagsFor(lost.hash).to === 'card',
       'and their entry is named for what it is');
    cash.tap();
    await H.W.cardLook(cash);
    ok(H.W.cardOwed().length === 1, 'read again, they are not filed twice');
    cash.tap();
    const put = await H.W.cardWrite(cash, { pin: '1234' });
    ok(put.sats === 23 && put.left === 0 && cash.balance() === 23 && H.W.cardOwed().length === 0, 'the next tap with its PIN puts them on the card', String(cash.balance()));
    cash.tap();
    const home = await H.W.cardWithdraw(cash, { pin: '1234' });
    ok(home.sats === 23 && (await bal(H)) === had, 'and from the card they come home: the balance is what it was', String(await bal(H)));
    cash.tap();
    await H.W.cardLook(cash);
    cash.tap();
    await H.W.cardWrite(cash, { pin: '1234' });      // frees the spent places, as any write does
    cash.tap();
    await H.W.cardLook(cash);
    ok(H.W.cardOwed().length === 0 && cash.balance() === 0, 'spent and cleared from the card, they are not taken for lost a second time');
    // another card's ecash is not this card's
    const other = newCard(H);
    await H.W.cardSetUp(other, { pin: '1234' });
    await H.W.sendToken(8, { unit: 'sat', lockTo: other.key, purpose: 'card' });
    cash.tap();
    await H.W.cardLook(cash);
    ok(H.W.cardOwed().length === 0, 'ecash made for another card is not filed to this one');
    other.tap();
    await H.W.cardLook(other);
    ok(H.W.cardOwed().length === 1 && H.W.cardOwed()[0].card === other.key, 'and is found by the card it was made for');
    other.tap();
    await H.W.cardWrite(other, { pin: '1234' });
    other.tap();
    await H.W.cardWithdraw(other, { pin: '1234' });

    /* What finding must not do. It goes by what this phone wrote down, so two
     * things could fool it, and both did the first time it ran on a phone:
     * ecash made for the same key at another mint, and ecash that was on the
     * card and spent before such things were marked. */
    const notes = () => JSON.parse(H.storage.getItem('foxy.txmeta') || '{}');
    // the same card's key, another mint's name on the token
    const here = await H.W.sendToken(4, { unit: 'sat', lockTo: other.key, purpose: 'card' });
    const elsewhere = H.window.CashuTS.getEncodedToken({ mint: 'https://another.test', proofs: H.W.tokenInfo(here.token).proofs, unit: 'sat' });
    H.W.tag(here.hash, { token: elsewhere });
    other.tap();
    await H.W.cardLook(other);
    ok(H.W.cardOwed().length === 0, 'ecash for this card’s key at another mint is not this card’s: its record names its mint');
    H.W.tag(here.hash, { token: here.token });
    other.tap();
    await H.W.cardLook(other);
    ok(H.W.cardOwed().length === 1, 'at its own mint it is');
    other.tap();
    await H.W.cardWrite(other, { pin: '1234' });
    other.tap();
    await H.W.cardWithdraw(other, { pin: '1234' });
    other.tap();
    await H.W.cardWrite(other, { pin: '1234' });      // frees the spent places
    // as an older build left it: on the card once, spent, and not marked
    const all = notes();
    delete all[here.hash].carded;
    H.storage.setItem('foxy.txmeta', JSON.stringify(all));
    other.tap();
    const again = await H.W.cardLook(other);
    ok(H.W.cardOwed().length === 1, 'spent ecash with no mark on it is found, as it would be');
    const gone = await H.W.cardOwedCheck(again);
    ok(gone === 1 && H.W.cardOwed().length === 0 && !!notes()[here.hash].carded,
       'and the mint is asked before it is trusted: spent, so it is struck off and marked');
    other.tap();
    await H.W.cardLook(other);
    ok(H.W.cardOwed().length === 0, 'and it is not found again');
    // found, not asked about (no route when it was read), and a tap comes: the write asks first
    const all2 = notes();
    delete all2[here.hash].carded;
    H.storage.setItem('foxy.txmeta', JSON.stringify(all2));
    other.tap();
    await H.W.cardLook(other);
    other.tap();
    const wrote = await H.W.cardWrite(other, { pin: '1234' });
    ok(wrote.sats === 0 && other.balance() === 0 && H.W.cardOwed().length === 0, 'nor is it ever written back onto the card: the write asks the mint first');
  }

  /* ---- the short form itself ------------------------------------------------ */
  const P = H.W.cardParse;
  ok(P.shortId(long) === long.slice(0, 16) && P.shortId('00b4cd27d8861a44') === '00b4cd27d8861a44',
     'a long name is cut to its first eight bytes, and an eight-byte name is kept whole');
  ok(P.shortId('02' + 'ab'.repeat(32)) === '' && P.shortId('00b4cd27d8861a4') === '' && P.shortId('') === '' && P.shortId(long + '00') === '',
     'a name of neither kind has no short form, so its ecash is never put on a card');
  const stranger = { keyset: 'ffffffffffffffff', amount: 64, nonce: '11'.repeat(32), C: '02' + '22'.repeat(32), date: 0 };
  ok(P.proof(stranger, card.key, '').id === 'ffffffffffffffff' && P.proof(stranger, card.key, '', long).id === long,
     'a piece is named by the whole name where there is one, and by its eight bytes where there is not');

  console.log('\n' + (failed ? failed + ' flashcard-long-ids check(s) failed' : 'all flashcard-long-ids checks pass'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
