'use strict';
/* flashcard-mend.js — change a till bound to a key that is not the mint's (card software 1.22): mended, or given up.
 *
 *     node tests/flashcard-mend.js
 *
 * A till names the mint's key for each piece of change a card of 1.21 and on makes for itself (SPEND_ALL_CHANGE), and the card keeps
 * it with the opening; LOAD_CHANGE then takes the mint's answer under that key and no other. A till that names another has made
 * change the mint's answer can never be loaded under. On 1.22 the holder mends it: the mint's answer under its real key, taken
 * under the PIN, in a tap that paid nothing, with the holder's say (the owner's grant, or with no owner the history held for). What
 * cannot be mended is given up: RESET_CARD with P1 = 1 and P2 = the opening's number, which writes bit 4 in the tap's log.
 *
 * Against the model of the card (tests/flashcard-card.js, `software: 22` and `software: 21`):
 *
 *   the card itself     LOAD_CHANGE under the bound key from anyone; another key 6A80 with no PIN, 6982 with the PIN and no
 *                       grant or hold, 6985 in a tap that paid, 6A80 for a proof that does not hold, taken with the PIN and the
 *                       grant or the hold; 1.21 takes no other key; the let-go's every refusal (6A83, 6A91, 6982, 6A97, 6985, 6700,
 *                       6B00, 6A88, 6A94), the log's bit 4, and 6B00 from 1.21;
 *   the wallet          a till that names a wrong key at SPEND_ALL_CHANGE, and the owner's phone that mends it at its next tap
 *                       (`cardMend`: VERIFY_PIN, ALLOW_LOAD, GET_CHANGE, LOAD_CHANGE under the mint's key), the card whole after;
 *                       a holder's card with no owner mended in VIEW AS GUEST's held tap, and by `cardMend` under the hold;
 *                       `cardGiveUp` by the owner's proof and under the PIN and the hold, with the bytes it sends, the log's
 *                       line for it, and 1.21's "This card’s software cannot do that.";
 *   the screens         the owner's card screen: NEEDS THE CARD’S PIN and FINISH THIS CHANGE where the mint's answer is here,
 *                       GIVE UP THIS CHANGE only where an opening is stuck, and both run through the tap. */
const crypto = require('crypto');
const { funded, newCard, binaryLoad, why, OTHER_WORDS, settle } = require('./flashcard-kit');
const { appOn, until, pad, card: cardUi, vals } = require('./flashcard-ui-kit');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

const SELECT = '00a404000af0464f5859434152440100';
const sw = (r) => String(r).slice(-4);
const hexOf = (pin) => Buffer.from(pin, 'latin1').toString('hex');
const two = (n) => ('0' + (n & 255).toString(16)).slice(-2);
// what a card paid 200 from one piece of 1,024 holds once all the change it made for itself is on it (512 + 256 + 32 + 16)
const WHOLE = 816;
const ins = (c) => c.sent.filter((a) => a.slice(0, 2) === 'b0').map((a) => a.slice(2, 4));

// an owner key of this test's own (P-256), to prove ownership to the model with directly
const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = pair.publicKey.export({ format: 'jwk' });
const OWNER_PUB = '04' + Buffer.from(jwk.x, 'base64url').toString('hex') + Buffer.from(jwk.y, 'base64url').toString('hex');
const OTHER = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
// an owner's command: the proof's length, the proof over "FoxyCard/<label>", a nonce the card gives now and `value`, then `value`
async function owned(card, label, valueHex, key) {
  const nonce = (await card.send('b044000010')).slice(0, 32);
  const value = Buffer.from(valueHex || '', 'hex');
  const sig = crypto.sign('sha256', Buffer.concat([Buffer.from('FoxyCard/' + label), Buffer.from(nonce, 'hex'), value]), { key: key || pair.privateKey, dsaEncoding: 'der' });
  return Buffer.concat([Buffer.from([sig.length]), sig, value]).toString('hex');
}
const apdu = (insHex, p1, p2, dataHex, le) => 'b0' + insHex + two(p1) + two(p2) + (dataHex ? two(dataHex.length / 2) + dataHex : '') + (le === undefined ? '' : two(le));

/* A card held through a till that names, for the `nth` piece of change the card makes for itself, `bad` (a key that is not the
 * mint's) in place of the mint's key. Everything else goes through as it is. */
function poisoned(card, bad, nth) {
  let k = 0;
  return new Proxy(card, {
    get(t, p) {
      if (p !== 'send') return t[p];
      return (a) => {
        let x = String(a).toLowerCase();
        if (x.slice(0, 10) === 'b026000025') { k += 1; if (k === (nth || 1)) x = x.slice(0, 18) + bad + x.slice(84); }
        return t.send(x);
      };
    },
  });
}
// GET_CHANGE of a card of 1.21 and on, read raw: each opening's number, amount, keyset, date, blinded message and key
async function openingsOf(card) {
  const out = [];
  for (let page = 0; page < 3; page++) {
    const h = (await card.send('b01900' + two(page) + '00')).slice(0, -4);
    const n = parseInt(h.slice(0, 2), 16);
    for (let i = 0; i < n; i++) {
      const q = h.substr(2 + i * 166, 166);
      out.push({ number: parseInt(q.slice(0, 2), 16), amount: parseInt(q.slice(2, 10), 16), keyset: q.slice(10, 26), B: q.slice(34, 100), K: q.slice(100, 166) });
    }
    if (n < 3) break;
  }
  return out;
}

(async () => {
  const H = await funded({}, 30000);
  const R = await funded({ sharedMint: H.mint, words: OTHER_WORDS }, 0);
  const G = await funded({ sharedMint: H.mint, words: 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above' }, 0);
  // the phone that sets up and loads the cards of holders with no phone of their own
  const L = await funded({ sharedMint: H.mint, words: 'army van defense carry jealous true garbage claim echo media make crunch' }, 20000);
  const CT = H.window.CashuTS;
  const wide = (h) => CT.pointFromHex(String(h)).toHex(false);
  // a key that is a point and is not the mint's: a till's own
  const BAD = Buffer.from(CT.getPubKeyFromPrivKey(H.window.Uint8Array.from(crypto.randomBytes(32)))).toString('hex');
  // the mint's real answer for an opening, from the till's row it could not finish: C_, the mint's key, e and s, as LOAD_CHANGE takes them
  const answerFor = (till, B) => {
    const b = till.W.cardStuck().reduce((all, r) => all.concat(r.blind), []).filter((x) => String(x.B_).toLowerCase() === B)[0];
    return b ? { data: wide(b.C_) + wide(b.K) + b.dleq.e.toLowerCase() + b.dleq.s.toLowerCase(), K: String(b.K).toLowerCase(), amount: b.amount } : null;
  };
  /* An owner's card (this phone's, `owner`) of `software`, one piece of 1,024 on it, paid 200 by `till` through a till that names a
   * wrong key for the first piece of change, and tapped again at the till for its change (with no PIN: the card's own change goes on
   * by LOAD_CHANGE; `cut`, never). The card makes 816 of the 824 itself (512 + 256 + 32 + 16); the till's own 8 waits for a PIN and is
   * not this suite's. Answers the card and the opening that was poisoned. */
  const poisonedPayment = async (owner, till, software, o) => {
    const opts = o || {};
    const c = newCard(owner, undefined, { format: 4, software });
    c.tap();
    if (opts.holder) await opts.holder.W.cardSetUpFor(c, { pin: '5555' });
    else await owner.W.cardSetUp(c, { pin: '1234' });
    await binaryLoad(opts.holder || owner, c, 1024, { pin: opts.holder ? '5555' : '1234' });
    c.tap();
    await till.W.cardPay(poisoned(c, BAD, 1), { sats: 200, pin: opts.holder ? '5555' : '1234' });
    c.tap();
    if (!opts.cut) await till.W.cardWrite(c, { change: true }).then(() => {}, () => {});
    const bad = c.state.openings.map((x, k) => Object.assign({ k }, x)).filter((x) => x.state === 'pending' && x.K === BAD)[0];
    return { c, bad };
  };

  /* ======== the card itself: LOAD_CHANGE ============================================================================ */
  {
    // the bound key, from anyone: an honest till's change goes on in the same tap
    const c = newCard(H, undefined, { format: 4, software: 22 });
    c.tap();
    await H.W.cardSetUp(c, { pin: '1234' });
    await binaryLoad(H, c, 1024, { pin: '1234' });
    c.tap();
    c.sent.length = 0;
    await R.W.cardPay(c, { sats: 200, pin: '1234' });
    c.tap();
    c.sent.length = 0;
    await R.W.cardWrite(c, { change: true }).then(() => {}, () => {});
    ok(c.balance() === WHOLE && c.state.openings.every((x) => x.state !== 'pending') && ins(c).includes('53') && !ins(c).includes('40') && !c.state.mended,
       'an honest till’s change: at the change tap, LOAD_CHANGE under the key each opening was bound to, from the till, with no PIN; the card has all 816 of its own change', String(c.balance()));
    ok(c.sent.filter((a) => /^b053/.test(a)).every((a) => a.length === 2 * (5 + 194 + 1)), 'each LOAD_CHANGE is 194 bytes of data (C_, K, e, s) and asks 83 back');
  }
  {
    // another key: the rules, raw, on a card whose owner is this test's key
    const { c, bad } = await poisonedPayment(H, R, 22);
    ok(!!bad && bad.amount > 0, 'a till that names a key of its own leaves that opening bound to it', bad && String(bad.amount));
    const real = answerFor(R, bad.B);
    ok(!!real && real.K !== BAD && R.W.cardStuck().some((r) => r.blind.some((b) => b.why === 'key')),
       'the till holds the mint’s real answer and keeps it as stuck for a key that is not the card’s (`key`), sending nothing it knows the card refuses');
    c.state.owner = OWNER_PUB;
    const n = bad.k;
    const load = (data) => c.send(apdu('53', n, 0, data, 83)).then(sw);
    c.tap(); await c.send(SELECT);
    ok((await load(real.data)) === '6a80', 'another key with no PIN: 6A80, as for a key that is no key');
    await c.send('b0400000' + '04' + hexOf('1234'));
    ok((await load(real.data)) === '6982', 'with the PIN and no grant: 6982');
    ok(sw(await c.send(apdu('45', 0, 0, await owned(c, 'load', '')))) === '9000', 'the owner’s grant (ALLOW_LOAD)');
    c.state.tapPaid = true;
    ok((await load(real.data)) === '6985', 'the PIN and the grant in a tap that paid: 6985');
    c.state.tapPaid = false;
    const spoiled = real.data.slice(0, -2) + (parseInt(real.data.slice(-2), 16) ^ 1).toString(16).padStart(2, '0');
    ok((await load(spoiled)) === '6a80', 'the PIN, the grant and a proof that does not hold: 6A80');
    const before = c.balance();
    const got = await c.send(apdu('53', n, 0, real.data, 83));
    ok(sw(got) === '9000' && got.length === 2 * 83 + 4 && c.balance() === before + bad.amount && c.state.openings[n].state === 'empty' && c.state.mended === 1,
       'with the PIN and the grant, the mint’s answer under its real key is taken: the piece, its place and its proof kept (83 bytes), and the opening let go', sw(got));
    ok((await load(real.data)) === '6a88', 'and the opening is gone: 6A88');
    // with no owner: the hold in place of the grant
    const h = await poisonedPayment(H, G, 22, { holder: L });
    const hr = answerFor(G, h.bad.B);
    const hload = () => h.c.send(apdu('53', h.bad.k, 0, hr.data, 83)).then(sw);
    h.c.tap(); await h.c.send(SELECT);
    await h.c.send('b0400000' + '04' + hexOf('5555'));
    ok((await hload()) === '6982', 'a card with no owner: the PIN and no hold, 6982');
    for (let i = 0; i < 10; i++) await h.c.send('b018000000');
    ok(h.c.state.tapRead && (await hload()) === '9000', 'and with the history held for, the mint’s answer under its real key is taken');
    // 1.21 takes no other key, whatever is in the tap
    const old = await poisonedPayment(H, R, 21);
    const or = answerFor(R, old.bad.B);
    old.c.state.owner = OWNER_PUB;
    old.c.tap(); await old.c.send(SELECT);
    await old.c.send('b0400000' + '04' + hexOf('1234'));
    await old.c.send(apdu('45', 0, 0, await owned(old.c, 'load', '')));
    ok(sw(await old.c.send(apdu('53', old.bad.k, 0, or.data, 83))) === '6a80', 'a card of 1.21 takes the bound key and no other, PIN and grant or not: 6A80');
  }

  /* ======== the card itself: the let-go (RESET_CARD, P1 = 1) ========================================================= */
  {
    const { c, bad } = await poisonedPayment(H, R, 22);
    c.state.owner = OWNER_PUB;
    const n = bad.k;
    const go = (data, p2) => c.send(apdu('51', 1, p2 === undefined ? n : p2, data)).then(sw);
    c.tap(); await c.send(SELECT);
    ok((await go(two(8), 8)) === '6a83', 'a number past 7: 6A83, before anything else');
    ok((await go(two(n))) === '6a91', 'the number alone on a card with an owner (no nonce asked for): 6A91');
    ok((await go(await owned(c, 'reset', two(n), OTHER.privateKey))) === '6a91', 'another key’s proof: 6A91');
    ok((await go(await owned(c, 'reset', ''))) === '6700', 'the reset’s own proof, with no number after it: 6700');
    ok((await go(await owned(c, 'reset', two(n) + two(n)))) === '6700', 'a byte after the number: 6700');
    ok((await go(await owned(c, 'reset', two((n + 1) & 7)))) === '6b00', 'a number that is not P2: 6B00');
    const empty = c.state.openings.findIndex((x) => x.state === 'empty');
    ok((await go(await owned(c, 'reset', two(empty)), empty)) === '6a88', 'an opening that waits for nothing: 6A88');
    c.state.locked = true;
    ok((await go(await owned(c, 'reset', two(n)))) === '6982', 'a locked card, the PIN not given: 6982');
    c.state.locked = false;
    const taps = c.state.log.taps;
    ok((await go(await owned(c, 'reset', two(n)))) === '9000' && c.state.openings[n].state === 'empty', 'the owner’s proof over the number: the opening is let go');
    const log = H.W.cardParse.log((await (async () => { await c.send(apdu('45', 0, 0, await owned(c, 'load', ''))); return c.send('b018000000'); })()).slice(0, -4), true, true);
    ok(log.last[0].letGo === true && (c.state.log.ring[(c.state.log.taps - 1) & 7].flags & 0x10) === 0x10 && c.state.log.taps >= taps,
       'the tap’s log entry carries bit 4 (0x10), and the phone reads it as an opening given up (`letGo`)', JSON.stringify(log.last[0]));
    ok(log.last.slice(1).every((x) => !x.letGo), 'and no other tap does');
    // 6A94: the opening's piece is on the card already: let go, and nothing in the log
    const { c: c2, bad: b2 } = await poisonedPayment(H, R, 22);
    c2.state.owner = OWNER_PUB;
    const at = c2.state.slots.findIndex((x) => x.status === 0);
    c2.state.slots[at] = { status: 2, data: '00'.repeat(12) + c2.state.openings[b2.k].nonce + '00'.repeat(37) };
    c2.tap(); await c2.send(SELECT);
    const flagsBefore = c2.state.log.ring.map((e) => e.flags).join();
    ok((await c2.send(apdu('51', 1, b2.k, await owned(c2, 'reset', two(b2.k)))).then(sw)) === '6a94' && c2.state.openings[b2.k].state === 'empty'
       && c2.state.log.ring.map((e) => e.flags).join() === flagsBefore, 'an opening whose piece is on the card: 6A94, let go, and nothing written in the log');
    // with no owner: the PIN and the hold
    const h = await poisonedPayment(H, G, 22, { holder: L });
    const hgo = (data) => h.c.send(apdu('51', 1, h.bad.k, data)).then(sw);
    h.c.tap(); await h.c.send(SELECT);
    ok((await hgo(two(h.bad.k))) === '6982', 'with no owner: the PIN not given, 6982');
    await h.c.send('b0400000' + '04' + hexOf('5555'));
    h.c.state.tapPaid = true;
    ok((await hgo(two(h.bad.k))) === '6985', 'the PIN in a tap that paid: 6985');
    h.c.state.tapPaid = false;
    ok((await hgo(two(h.bad.k))) === '6982', 'the PIN and no hold: 6982');
    for (let i = 0; i < 10; i++) await h.c.send('b018000000');
    ok((await hgo(two(h.bad.k) + '00')) === '6700' && (await hgo(two((h.bad.k + 1) & 7))) === '6b00', 'held: anything but the number is 6700, another number 6B00');
    ok((await hgo(two(h.bad.k))) === '9000' && h.c.state.openings[h.bad.k].state === 'empty', 'and the number alone under the PIN and the hold lets it go');
    const bare = newCard(H, undefined, { format: 4, software: 22 });
    await bare.send(SELECT);
    ok(sw(await bare.send(apdu('51', 1, 3, two(3)))) === '6a97', 'a card with no PIN: 6A97');
    const old = newCard(H, undefined, { format: 4, software: 21 });
    await old.send(SELECT);
    ok(sw(await old.send(apdu('51', 1, 3, two(3)))) === '6b00', 'a card of 1.21 has no let-go: 6B00');
  }

  /* ======== the wallet: the owner's phone mends what a till spoiled ================================================= */
  {
    const { c, bad } = await poisonedPayment(H, R, 22);
    const whole = WHOLE;
    ok(c.balance() === whole - bad.amount, 'after the payment the card is short by the poisoned piece of its change', c.balance() + ' of ' + whole);
    c.tap();
    const look = await H.W.cardLook(c, { mine: true, change: true });
    const mendPart = (look.owes && look.owes.parts || []).filter((p) => p.state === 'mend')[0];
    ok(look.mine === true && mendPart && mendPart.amount === bad.amount && look.owes.openings.every((x) => !x.giveUp) && c.balance() === whole - bad.amount,
       'the owner’s read sees it: the key the card kept is not the mint’s, the mint’s answer is fetched, and it NEEDS THE CARD’S PIN (nothing to give up)', JSON.stringify(look.owes && look.owes.parts));
    c.tap();
    const from = c.sent.length;
    const r = await H.W.cardMend(c, { pin: '1234' });
    const tail = c.sent.slice(from);
    const order = tail.map((a) => a.slice(2, 4));
    const at = (x) => order.indexOf(x);
    const sent53 = tail.filter((a) => /^b053/.test(a));
    ok(r.amount === bad.amount && c.balance() === whole && r.card.balance === whole && c.state.mended === 1 && c.state.openings.every((x) => x.state !== 'pending'),
       'the next tap, under the PIN, mends it: the card is whole', c.balance() + ' of ' + whole);
    ok(at('40') > 0 && at('45') > at('40') && at('19') > at('45') && at('53') > at('19') && !order.slice(at('40'), at('53')).some((x) => x >= '22' && x <= '26'),
       'in the order VERIFY_PIN, ALLOW_LOAD (the owner’s grant), GET_CHANGE, LOAD_CHANGE, and nothing paid in it', order.join(' '));
    ok(sent53.length === 1 && sent53[0].slice(0, 10) === 'b05300c2'.slice(0, 4) + two(bad.k) + '00c2' && sent53[0].slice(140, 270) === wide(answerFor(R, bad.B) ? answerFor(R, bad.B).K : '') && sent53[0].slice(-2) === '53',
       'the LOAD_CHANGE: B0 53 <the opening> 00 C2, C_ (65), the mint’s own key (65, not the till’s), e, s, and 53 back', sent53[0] && sent53[0].slice(0, 12));
    console.log('      mend: ' + tail.filter((a) => /^b0(40|44|45|19|53)/.test(a)).map((a) => a.slice(0, 8) + (a.length > 12 ? '…' + (a.length / 2 - 5) + ' bytes' : a.slice(8))).join(' | '));
    c.tap();
    ok((await H.W.cardLook(c, { mine: true, change: true })).owes == null, 'read again, the card owes nothing');
    // a card of 1.21 cannot be mended
    const old = await poisonedPayment(H, R, 21);
    old.c.tap();
    const oldLook = await H.W.cardLook(old.c, { mine: true, change: true });
    ok(oldLook.owes.parts.every((p) => p.state !== 'mend') && oldLook.owes.openings.some((x) => x.giveUp && x.state === 'stuck'),
       'on a card of 1.21 the same opening cannot be finished: CANNOT BE FINISHED, and it may be given up', JSON.stringify(oldLook.owes.parts));
    old.c.tap();
    const e = await H.W.cardMend(old.c, { pin: '1234' }).then(() => null, (x) => x);
    ok(e && e.card === 'old-card' && e.message === 'This card’s software cannot do that.', 'and cardMend says so before anything is sent', e && e.message);
  }
  {
    // a holder's card with no owner: VIEW AS GUEST's held tap mends it, and nothing is kept on the guest's phone
    const { c, bad } = await poisonedPayment(H, G, 22, { holder: L });
    const whole = WHOLE;
    c.tap();
    const g = await H.W.cardGuestLook(c, { pin: '5555' });
    ok(g.guest && c.balance() === whole && g.owes && g.owes.wrote === bad.amount && g.balance === whole && !H.W.cardOwed().some((r) => r.card === c.key),
       'VIEW AS GUEST, in its held tap, puts the mint’s answer on under the mint’s key: the card is whole, and the guest’s phone keeps no row', c.balance() + ' of ' + whole);
    // and cardMend on such a card holds for the history in place of the grant
    const two2 = await poisonedPayment(H, G, 22, { holder: L });
    two2.c.tap();
    const from = two2.c.sent.length;
    const m = await H.W.cardMend(two2.c, { pin: '5555' });
    const order = two2.c.sent.slice(from).map((a) => a.slice(2, 4));
    ok(m.amount === two2.bad.amount && two2.c.balance() === whole && order.filter((x) => x === '18').length === 10 && order.indexOf('45') < 0
       && order.lastIndexOf('18') < order.indexOf('19') && order.indexOf('19') < order.indexOf('53'),
       'cardMend on a card with no owner: VERIFY_PIN, the history held for (ten askings), GET_CHANGE, LOAD_CHANGE; no grant', order.join(' '));
  }

  /* ======== the wallet: an opening given up ========================================================================= */
  {
    // the owner's: the mint has no answer for a poisoned opening (its restore answers nothing), so it is stuck and may be given up
    const restoreNothing = (m) => (/\/v1\/restore$/.test(String(m.url || '')) ? '200\n' + JSON.stringify({ outputs: [], signatures: [] }) : null);
    const { c, bad } = await poisonedPayment(H, R, 22, { cut: true });
    H.fate = restoreNothing;
    c.tap();
    const look = await H.W.cardLook(c, { mine: true, change: true });
    const mine = look.owes.openings.filter((x) => x.number === bad.k)[0];
    const others = look.owes.openings.filter((x) => x.number !== bad.k);
    ok(mine && mine.state === 'unmade' && mine.giveUp && others.length > 0 && others.every((x) => x.state === 'unmade' && !x.giveUp),
       'the mint has no answer: the poisoned opening may be given up, and the honest ones the till has not brought back may not', JSON.stringify(look.owes.openings));
    // the answers the card gives, to check the proof with
    const heard = [];
    const link = new Proxy(c, { get(t, p) { return p === 'send' ? (a) => t.send(a).then((r) => { heard.push([String(a), r]); return r; }) : t[p]; } });
    c.tap();
    // named by its number and its blinded message; a message that is not the opening's of that number is refused before anything is sent
    c.tap();
    const otherB = look.owes.openings.filter((x) => x.number !== bad.k)[0].B_;
    const wrongB = await H.W.cardGiveUp(c, { number: bad.k, B_: otherB }).then(() => null, (x) => x);
    ok(wrongB && wrongB.card === 'nothing-owed' && c.state.openings[bad.k].state === 'pending' && !c.sent.some((a) => /^b05101/.test(a)),
       'a give-up that names the opening by a blinded message that is not that opening’s: refused, and nothing is given up', wrongB && wrongB.message);
    const r = await H.W.cardGiveUp(link, { number: bad.k, B_: mine.B_, amount: mine.amount });
    const i51 = heard.findIndex(([a]) => /^b05101/.test(a));
    const [cmd] = heard[i51];
    const nonce = heard.slice(0, i51).filter(([a]) => /^b0440000/.test(a)).slice(-1)[0][1].slice(0, 32);
    const data = Buffer.from(cmd.slice(10), 'hex');
    const sigLen = data[0];
    const proofOk = crypto.verify('sha256', Buffer.concat([Buffer.from('FoxyCard/reset'), Buffer.from(nonce, 'hex'), Buffer.from([bad.k])]),
      { key: crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Buffer.from(c.state.owner.slice(2, 66), 'hex').toString('base64url'), y: Buffer.from(c.state.owner.slice(66), 'hex').toString('base64url') }, format: 'jwk' }), dsaEncoding: 'der' },
      data.subarray(1, 1 + sigLen));
    ok(r.amount === bad.amount && c.state.openings[bad.k].state === 'empty' && cmd.slice(0, 8) === 'b05101' + two(bad.k) && data.length === 1 + sigLen + 1 && data[data.length - 1] === bad.k && proofOk,
       'given up by the owner: GET_NONCE, then B0 51 01 <n> with the proof’s length, the owner’s proof over "FoxyCard/reset", the nonce and n, and n', cmd.slice(0, 12) + '… ' + data.length + ' bytes');
    console.log('      let-go (owner): b0440000 10 | ' + cmd.slice(0, 8) + ' ' + cmd.slice(8, 10) + ' ' + cmd.slice(10, 12) + ' <proof ' + sigLen + ' bytes> ' + cmd.slice(-2));
    H.fate = null;
    c.tap();
    const after = await H.W.cardLook(c, { mine: true });
    ok(after.log && after.log.last[0].letGo === true, 'and the card’s own log says it: an opening given up in that tap', JSON.stringify(after.log && after.log.last[0]));
    // under the PIN and the hold, on a card with no owner
    const h = await poisonedPayment(H, G, 22, { holder: L, cut: true });
    h.c.tap();
    const from = h.c.sent.length;
    const gr = await G.W.cardGiveUp(h.c, { number: h.bad.k, B_: String(h.bad.B).toLowerCase(), pin: '5555' });
    const tail = h.c.sent.slice(from);
    const last = tail.filter((a) => /^b051/.test(a));
    ok(gr.amount === h.bad.amount && h.c.state.openings[h.bad.k].state === 'empty' && last.length === 1 && last[0] === 'b05101' + two(h.bad.k) + '01' + two(h.bad.k)
       && tail.map((a) => a.slice(2, 4)).filter((x) => x === '18').length === 10,
       'given up on a card with no owner: VERIFY_PIN, the history held for, and then exactly B0 51 01 n 01 n', last.join());
    console.log('      let-go (no owner): ' + last[0]);
    // a card of 1.21 has no let-go (it would answer 6B00): said as its software being unable, and nothing is sent for it
    const old = await poisonedPayment(H, R, 21);
    old.c.tap();
    const before21 = old.c.sent.length;
    const e = await H.W.cardGiveUp(old.c, { number: old.bad.k, B_: String(old.bad.B).toLowerCase() }).then(() => null, (x) => x);
    ok(e && e.card === 'old-card' && e.message === 'This card’s software cannot do that.' && old.c.state.openings[old.bad.k].state === 'pending'
       && !old.c.sent.slice(before21).some((a) => /^b05101/.test(a) || /^b0440000/.test(a)), 'a card of 1.21: "This card’s software cannot do that." and nothing else, no nonce and no let-go sent, and it keeps the opening', e && e.message);
  }
  {
    // a number used again: the opening given up, a later payment's change takes its number, and a give-up of the old one changes nothing
    const restoreNothing = (m) => (/\/v1\/restore$/.test(String(m.url || '')) ? '200\n' + JSON.stringify({ outputs: [], signatures: [] }) : null);
    const { c, bad } = await poisonedPayment(H, R, 22, { cut: true });
    const oldB = String(bad.B).toLowerCase();
    H.fate = restoreNothing;
    c.tap();
    const look = await H.W.cardLook(c, { mine: true, change: true });
    const shown = look.owes.openings.filter((x) => x.number === bad.k)[0];
    H.fate = null;
    c.tap();
    await H.W.cardGiveUp(c, { number: bad.k, B_: shown.B_, amount: shown.amount });
    await binaryLoad(H, c, 256, { pin: '1234' });
    c.tap();
    await R.W.cardPay(c, { sats: 50, pin: '1234' });
    const reused = c.state.openings[bad.k];
    c.tap();
    const from = c.sent.length;
    const e = await H.W.cardGiveUp(c, { number: bad.k, B_: shown.B_, amount: shown.amount }).then(() => null, (x) => x);
    ok(reused.state === 'pending' && String(reused.B).toLowerCase() !== oldB && e && e.card === 'nothing-owed' && c.state.openings[bad.k].state === 'pending'
       && !c.sent.slice(from).some((a) => /^b05101/.test(a)),
       'a screen left open: the number is a later payment’s change now, and giving up the opening it showed gives up nothing', (e && e.message) + ' | ' + reused.state);
  }
  {
    // honest change, and the mint's keys not to be had for a moment: nothing may be given up, and the next read puts all of it on
    const c = newCard(H, undefined, { format: 4, software: 22 });
    c.tap(); await H.W.cardSetUp(c, { pin: '1234' });
    await binaryLoad(H, c, 1024, { pin: '1234' });
    c.tap(); await R.W.cardPay(c, { sats: 200, pin: '1234' });
    let P = null;
    Object.keys(CT).forEach((k) => { const f = CT[k]; if (typeof f === 'function' && f.prototype && Object.getOwnPropertyDescriptor(f.prototype, 'keyChain')) P = f.prototype; });
    const chain = Object.getOwnPropertyDescriptor(P, 'keyChain');
    const ensure = P.ensureOperableKeysets;
    Object.defineProperty(P, 'keyChain', { configurable: true, get() {
      const real = this._keyChain; if (!real) return real;
      return new Proxy(real, { get: (t, k) => (k === 'getKeyset'
        ? (id) => { const ks = t.getKeyset(id); return ks ? new Proxy(ks, { get: (kt, kk) => (kk === 'hasKeys' ? false : kt[kk]) }) : ks; }
        : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
    } });
    P.ensureOperableKeysets = function () { return Promise.reject(new Error('no route')); };
    c.tap();
    const look = await H.W.cardLook(c, { mine: true, change: true }).finally(() => { Object.defineProperty(P, 'keyChain', chain); P.ensureOperableKeysets = ensure; });
    const opens = (look.owes && look.owes.openings) || [];
    ok(opens.length === 4 && opens.every((x) => !x.giveUp), 'the mint’s keys not fetched in this tap: no honest opening may be given up', JSON.stringify(opens));
    c.tap();
    await H.W.cardLook(c, { mine: true, change: true });
    ok(c.balance() === WHOLE, 'and with the keys back the next read puts every piece on: the card is whole', c.balance() + ' of ' + WHOLE);
  }
  {
    // honest change the mint answers without its proof: not to be given up, as the till that made it can still put it on
    const c = newCard(H, undefined, { format: 4, software: 22 });
    c.tap(); await H.W.cardSetUp(c, { pin: '1234' });
    await binaryLoad(H, c, 1024, { pin: '1234' });
    c.tap(); await R.W.cardPay(c, { sats: 200, pin: '1234' });
    H.fate = (m) => {
      if (!/\/v1\/restore$/.test(String(m.url || ''))) return null;
      const real = String(H.mint.handle(m));
      const cut = real.indexOf('\n');
      const body = JSON.parse(real.slice(cut + 1));
      (body.signatures || []).forEach((x) => { delete x.dleq; });
      return real.slice(0, cut) + '\n' + JSON.stringify(body);
    };
    c.tap();
    const look = await H.W.cardLook(c, { mine: true, change: true });
    H.fate = null;
    const opens = (look.owes && look.owes.openings) || [];
    ok(opens.length > 0 && opens.every((x) => !x.giveUp), 'the mint’s answer with no proof: nothing may be given up', JSON.stringify(opens));
    c.tap();
    await R.W.cardWrite(c, { change: true }).then(() => {}, () => {});
    ok(c.balance() === WHOLE, 'and the till’s change tap puts it on with the proof it kept: the card is whole', c.balance() + ' of ' + WHOLE);
  }

  /* ======== the screens ============================================================================================= */
  {
    const owner = appOn(H);
    owner.price = 60000;
    // the mint's answer is here: NEEDS THE CARD'S PIN, FINISH THIS CHANGE, and nothing to give up
    const { c, bad } = await poisonedPayment(H, R, 22);
    H.nfc = c;
    owner.goFlashcard();
    await until('the card to be read', () => owner.state.fc && owner.state.fc.key === c.key);
    let v = vals(owner);
    const price = owner.fcPrice(bad.amount, 'sat');
    ok(v.fcOwesLines.some((l) => /— NEEDS THE CARD’S PIN$/.test(l.text)) && v.fcChangeRows.map((r) => r.name).join() === 'FINISH THIS CHANGE (' + price + ')',
       'the owner’s screen: CHANGE OWED … NEEDS THE CARD’S PIN, and one row, FINISH THIS CHANGE, with no GIVE UP', v.fcChangeRows.map((r) => r.name).join() + ' | ' + v.fcOwesLines.map((l) => l.text).join());
    v.fcChangeRows[0].tap();
    ok(pad(owner) && pad(owner).title === 'CARD PIN' && pad(owner).cta === 'FINISH ' + price, 'FINISH THIS CHANGE asks for the card’s PIN on the card PIN pad, its button saying what it does', pad(owner) && pad(owner).cta);
    c.tap();
    pad(owner).type('1234');
    await until('the change to be put on', () => c.balance() === WHOLE && owner.toasts.some((t) => /went onto the card/.test(t)));
    await settle();
    v = vals(owner);
    ok(v.fcChangeRows.length === 0 && v.fcOwesLines.map((l) => l.text).join() === 'CHANGE OWED TO THIS CARD · ' + owner.fcBoth(bad.amount) + ' — FETCHED AND PUT ON',
       'and one tap later the card is whole, the line says the change went on, and there is nothing more to do', String(c.balance()) + ' | ' + v.fcOwesLines.map((l) => l.text).join());

    // stuck: the mint has no answer for the poisoned opening: GIVE UP THIS CHANGE for it, and for no other
    const s = await poisonedPayment(H, R, 22, { cut: true });
    H.fate = (m) => (/\/v1\/restore$/.test(String(m.url || '')) ? '200\n' + JSON.stringify({ outputs: [], signatures: [] }) : null);
    H.nfc = s.c;
    owner.setState({ screen: 'home', stack: [], fc: null });
    owner.goFlashcard();
    await until('the stuck card to be read', () => owner.state.fc && owner.state.fc.key === s.c.key);
    v = vals(owner);
    const sp = owner.fcPrice(s.bad.amount, 'sat');
    ok(v.fcChangeRows.map((r) => r.name).join() === 'GIVE UP THIS CHANGE (' + sp + ')' && v.fcOwesLines.every((l) => /NOT YET MADE BY THE TILL$/.test(l.text)),
       'an opening the mint has no answer for and a till’s key on it: GIVE UP THIS CHANGE for it alone; the honest ones the till owes have none', v.fcChangeRows.map((r) => r.name).join());
    v.fcChangeRows[0].tap();
    ok(cardUi(owner) && cardUi(owner).title === 'GIVE UP THIS CHANGE?' && /will be gone for good/.test(cardUi(owner).reason) && cardUi(owner).has('GIVE UP ' + sp) && !cardUi(owner).has('CANCEL'),
       'tapped: one sentence that the money of that change is gone, and GIVE UP with its amount', cardUi(owner) && cardUi(owner).all);
    s.c.tap();
    cardUi(owner).press('GIVE UP ' + sp);
    await until('the opening to be given up', () => s.c.state.openings[s.bad.k].state === 'empty' && owner.toasts.indexOf('The change is given up.') >= 0);
    v = vals(owner);
    ok(v.fcChangeRows.length === 0 && v.fcOwesLines.length > 0, 'and the row is gone with it, the change the till still owes still said', v.fcOwesLines.map((l) => l.text).join());
    H.fate = null;

    // the card's own log: the tap it was given up in is a line of its own
    s.c.tap();
    owner.fcRead();
    await until('the card read again', () => owner.state.fc && owner.state.fc.log && owner.state.fc.key === s.c.key);
    owner.fcLogCard();
    ok(cardUi(owner) && /: change owed to the card given up/.test(cardUi(owner).reason), 'the card’s own log has the tap it was given up in as a line of its own', cardUi(owner) && cardUi(owner).reason.split('\n').filter((l) => /given up/.test(l)).join());
    cardUi(owner).press('CLOSE');
    await settle();

    // a card of 1.21: the row is there for what is stuck, and the card's answer is said in one sentence
    const o21 = await poisonedPayment(H, R, 21);
    H.nfc = o21.c;
    owner.setState({ screen: 'home', stack: [], fc: null });
    owner.goFlashcard();
    await until('the 1.21 card to be read', () => owner.state.fc && owner.state.fc.key === o21.c.key);
    const row = vals(owner).fcChangeRows.filter((r) => /^GIVE UP/.test(r.name))[0];
    const sent21 = o21.c.sent.length;
    row.tap();
    await until('the refusal', () => cardUi(owner) && cardUi(owner).title === 'NOT ON THIS CARD');
    ok(cardUi(owner).reason === 'This card’s software cannot do that.' && o21.c.sent.length === sent21,
       'and on a card of 1.21 GIVE UP says "This card’s software cannot do that." and nothing else: no warning that money is gone, no tap', cardUi(owner).reason);
  }

  console.log('\n' + (failed || until.failed ? (failed + until.failed) + ' flashcard-mend check(s) failed' : 'all flashcard-mend checks pass'));
  process.exit(failed || until.failed ? 1 : 0);
})().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
