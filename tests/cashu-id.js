'use strict';
/* cashu-id.js — the Cashu ID, the wallet's half (build/wallet/08e-cashu-id.js).
 *
 *     node tests/cashu-id.js
 *
 * A wallet shows MY CASHU ID; another Foxy keeps it as a contact and pays it by
 * NUT-28 (pay-to-blinded-key), as cashu-ts does with `blindKeys`: for each piece
 * a throwaway key e, E = e·G on the proof (`p2pk_e`), the ID blinded at slot 0
 * and the payer's refund key at slot 1 (rᵢ = SHA-256("Cashu_P2BK_v1" ‖ x(e·P) ‖ i),
 * P′ = P + rᵢ·G), a locktime about thirty days out, and the token gift-wrapped to
 * the delivery key. The receiver's phone works r₀ out from d·E and signs for
 * pieces locked to the ID's blinding alone (cashuIdSign), and the wallet takes
 * them in. Pages on harness.js's fake mints; the phone's seed side is harness.js's
 * second implementation of CashuID.swift, the relays (nostrSend) and the inbox
 * (cashuIdInboxOpen) are stubbed here.
 *
 * The arithmetic is held to tests/fixtures/cashu-id-vectors.json: NUT-28's own
 * vectors, and Foxy's, the same ones FoxyTests/CashuIDTests.swift holds
 * libsecp256k1 to; and to cashu-ts's own deriveP2BKBlindedPubkeys.
 *
 * The review of 2026-11-03 is pinned here finding by finding (H1 … L10).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS, cashuIdKeys, cashuIdOneTime, cashuIdBlind, cashuIdTag, cashuIdPayBase,
  cashuIdPieceKey, cashuIdBindDigest, p2bkTweak, sharedX, schnorrSign, p2pkParent, p2pkAt } = H;

const MINT = 'https://m.test';
const HOME = 'https://home.test';
const PLAIN = 'https://plain.test';
const DOWN = 'https://down.test';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const THIRD_WORDS = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const FOURTH_WORDS = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const DAY = 86400;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 5000); while (Date.now() < end) { if (await fn()) return true; await wait(25); } return false; };
const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cashu-id-vectors.json'), 'utf8'));
const V = VEC.foxy;

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};

const mints = {};
let relay = [];          // what went over Nostr: { target, body }
let relayDown = false;

function page(words, opts) {
  const o = opts || {};
  const phone = nativePhone({ words });
  const said = { open: [], copies: [], close: 0, sign: 0, tag: 0, asked: [] };
  const reply = (w, id, t, e) => setTimeout(() => w.FoxyWallet._scanResult(id, t, e), 0);
  const ctx = loadReal({
    release: o.release,
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const url = String(m.url || '');
        said.asked.push({ url, body: String(m.body || '') });
        if (url.indexOf('down.test') >= 0 || /dead\d*\.test/.test(url)) return setTimeout(() => w.FoxyWallet._scanResult(m.id, null, 'did not answer'), 5);
        const at = url.indexOf('home.test') >= 0 ? mints.home : url.indexOf('plain.test') >= 0 ? mints.plain : mints.main;
        return reply(w, m.id, at.handle(m));
      }
      if (m.action === 'nostrSend') {
        if (relayDown) return reply(w, m.id, null, 'no relay answered');
        relay.push({ target: m.target, body: m.body });
        return reply(w, m.id, '3');
      }
      if (m.action === 'cashuIdInboxOpen') { said.open.push(m.since); return reply(w, m.id, '1'); }
      if (m.action === 'cashuIdCopiesOpen') { said.copies.push(m.since); return reply(w, m.id, '1'); }
      if (m.action === 'cashuIdInboxClose') { said.close += 1; return reply(w, m.id, 'ok'); }
      if (m.action === 'cashuIdSign') said.sign += 1;
      if (m.action === 'cashuIdTag') said.tag += 1;
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!mints.main) mints.main = fakeMint(w, { p2pk: true });
      if (!mints.home) mints.home = fakeMint(w, { p2pk: true, fill: 9, quoteFrom: 50000 });
      if (!mints.plain) mints.plain = fakeMint(w, { fill: 11, quoteFrom: 70000 });
    },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._cashuIdRetryMs = 40;
  ctx.said = said;
  ctx.phone = phone;
  ctx.store = (k, d) => { try { const v = JSON.parse(ctx.storage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  ctx.put = (k, v) => ctx.storage.setItem(k, JSON.stringify(v));
  return ctx;
}

const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x)
  : (x && typeof x === 'object' && typeof x.toNumber === 'function' && !Array.isArray(x) ? x.toNumber() : x))));
const proofsOf = (ctx, token) => plain(ctx.W.tokenInfo(token).proofs);
const lockOf = (pr) => { try { return JSON.parse(pr.secret)[1].data; } catch (e) { return ''; } };
const tagsOf = (pr) => { try { return JSON.parse(pr.secret)[1].tags || []; } catch (e) { return []; } };
const tag = (pr, name) => (tagsOf(pr).find((t) => t[0] === name) || [])[1];
const seedOf = (ctx, words) => Buffer.from(ctx.window.FoxyBip39.mnemonicToSeedSync(words));
const balance = async (ctx) => Number(await ctx.W.balanceSats()) || 0;
const logRow = (ctx, hash) => (ctx.store('foxy.cashu.log', []) || []).find((e) => e.hash === hash) || null;
const logRows = (ctx) => ctx.store('foxy.cashu.log', []) || [];
const envelope = (body, change) => JSON.stringify(Object.assign(JSON.parse(body), change || {}));
const reToken = (ctx, mint, unit, proofs) => ctx.window.CashuTS.getEncodedToken({ mint, unit, proofs: proofs.map((p) => Object.assign({}, p)) });

async function run() {
  const A = page(PHONE_WORDS);     // the one with the ID (the vectors' words)
  const B = page(OTHER_WORDS);     // pays it
  const C = page(THIRD_WORDS);     // a third, for a delivery that is not to A, and a mint A does not use
  const CT = A.window.CashuTS;

  await A.W.connect(MINT, { remember: true });
  await B.W.connect(MINT, { remember: true });
  await C.W.connect(MINT, { remember: true });
  await B.W.claim((await B.W.invoice(3000, '')).hash);
  ok((await balance(B)) === 3000, 'the payer holds 3,000 sats');

  /* ---- NUT-28, by its own vectors, through cashu-ts and harness.js ----------- */
  {
    const N = VEC.nut28;
    const zx = sharedX(BigInt('0x' + N.e), N.P);
    ok(zx.toString('hex') === N.Zx && sharedX(BigInt('0x' + N.p), N.E).toString('hex') === N.Zx, 'NUT-28: Zx = x(e·P) = x(p·E)');
    ok(N.r.every((r, i) => p2bkTweak(zx, i).toString(16).padStart(64, '0') === r), 'NUT-28: r0 … r10 = SHA-256("Cashu_P2BK_v1" ‖ Zx ‖ i)');
    const cts = CT.deriveP2BKBlindedPubkeys(Array(11).fill(N.P), new A.window.Uint8Array(Buffer.from(N.e, 'hex')));
    ok(cts.Ehex === N.E && JSON.stringify(cts.blinded) === JSON.stringify(N.blinded), 'NUT-28: cashu-ts gives the spec’s eleven blinded keys', JSON.stringify(cts.blinded.slice(0, 2)));
    ok(N.blinded.every((b, i) => cashuIdBlind(N.P, BigInt('0x' + N.e), i) === b), 'NUT-28: and so does the phone’s second implementation');
    const p = BigInt('0x' + N.p);
    const one = cashuIdOneTime(p, N.E, N.blinded[0]);
    ok(!!one && one.k.toString(16).padStart(64, '0') === N.skNeg0, 'NUT-28: the receiver’s key of the other parity: −p + r0 (skNeg)');
    const ctsKey = CT.deriveP2BKSecretKeys(N.E, N.p, N.blinded[0]);
    ok(ctsKey.length === 1 && ctsKey[0] === N.skNeg0, 'NUT-28: and cashu-ts’s receiver agrees', JSON.stringify(ctsKey));
  }

  /* ---- Foxy's vectors: the phone words' ID, e = 3 ------------------------------ */
  const mine = await A.W.cashuIdMine();
  const keysA = cashuIdKeys(seedOf(A, PHONE_WORDS));
  ok(mine.id === V.id && mine.nostr === V.nostr && mine.sig === V.bindSig, 'the phone’s keys and its binding signature are the vectors’');
  ok(keysA.d.toString(16).padStart(64, '0') === V.d && keysA.pay.toString(16).padStart(64, '0') === V.pay, 'm/129373\'/20\'/0\'/0\'/0\' and the paying key m/129373\'/20\'/2\'/0\'/0\'');
  ok(CT.schnorrVerifyDigest(V.bindSig, cashuIdBindDigest(V.id, V.nostr).toString('hex'), V.id) === true, 'the ID key signed SHA-256("foxy-cashu-id-bind-v1" ‖ ID ‖ delivery key)');
  const bl = A.W._cashuIdBlind(V.id, V.e, V.refund);
  ok(bl.E === V.E && bl.L === V.L && bl.R === V.refundBlinded, 'the page blinds by cashu-ts: E, the ID at slot 0, the refund key at slot 1', JSON.stringify(bl));
  ok(cashuIdBlind(V.id, 3n, 0) === V.L && cashuIdBlind(V.refund, 3n, 1) === V.refundBlinded, 'and harness.js, without cashu-ts, gives the same');
  const one3 = cashuIdOneTime(keysA.d, V.E);
  ok(one3.r.toString(16).padStart(64, '0') === V.r0 && one3.k.toString(16).padStart(64, '0') === V.k && one3.L === V.L, 'the receiver: r0 from d·E, k = d + r0, k·G = L′');
  const ecdh = crypto.createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(V.k, 'hex'));
  ok(ecdh.getPublicKey('hex', 'compressed') === V.L, 'and node’s own curve agrees: k·G is L′');
  const negL = cashuIdOneTime(keysA.d, V.E, V.lockOfNegatedId);
  ok(!!negL && negL.k.toString(16).padStart(64, '0') === V.kOfNegatedId, 'a payer that blinded the other parity of the ID: −d + r0');
  const ctsMine = CT.deriveP2BKSecretKeys(V.E, V.d, [V.L]);
  ok(ctsMine.length === 1 && ctsMine[0] === V.k, 'cashu-ts’s receiver finds the same one-time key from d');
  const secretL = JSON.stringify(['P2PK', { nonce: '00'.repeat(16), data: V.L, tags: [] }]);
  const sigL = schnorrSign(BigInt('0x' + V.k), crypto.createHash('sha256').update(secretL, 'utf8').digest());
  ok(CT.isP2PKSpendAuthorised({ id: '00ad268c4d1f5826', amount: 1, secret: secretL, C: '02' + '11'.repeat(32), witness: JSON.stringify({ signatures: [sigL] }) }) === true,
    'a signature by k verifies under L′ (NUT-11)');
  ok(CT.isP2PKSpendAuthorised({ id: '00ad268c4d1f5826', amount: 1, secret: JSON.stringify(['P2PK', { nonce: '00', data: V.id, tags: [] }]), C: '02' + '11'.repeat(32),
    witness: JSON.stringify({ signatures: [sigL] }) }) === false, 'and does not open a piece locked to the ID key');
  ok(cashuIdTag(keysA.d, V.peer, V.E) === V.tag, 'the payer’s name, proved: SHA-256("foxy-cashu-id-from-v1" ‖ x(d·peer) ‖ E)');
  const keysB = cashuIdKeys(seedOf(B, OTHER_WORDS));
  ok(cashuIdTag(keysB.d, V.id, V.E) === V.tag, 'the same tag from the other side');
  ok(cashuIdPayBase(keysA.pay, V.peer, V.baseIndex, V.baseLocktime) === V.base, 'the paying key’s base for a payment');
  ok(A.W._cashuIdPieceKey(V.base, 0) === V.piece0 && A.W._cashuIdPieceKey(V.base, 1) === V.piece1
    && cashuIdPieceKey(V.base, 1).toString(16).padStart(64, '0') === V.piece1, 'and each piece’s throwaway key from it');

  /* ---- the string ------------------------------------------------------ */
  ok(/^foxyid1[A-Za-z0-9_-]{179}$/.test(mine.text) && mine.text.length === 186, 'the ID string: foxyid1 and 179 characters of base64url (version 2, signed)', mine.text);
  ok(mine.text === A.W._cashuIdEncode(V.id, V.nostr, V.bindSig), 'built from the two keys and the signature');
  const docs = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CASHU-ID.md'), 'utf8');
  ok(docs.indexOf(mine.text) >= 0, 'the ID string of the vectors’ words is the one CASHU-ID.md shows', mine.text);
  const dec = A.W.cashuIdDecode(mine.text);
  ok(dec && dec.id === V.id && dec.nostr === V.nostr, 'and read back to them');
  ok(A.W.classify(mine.text) === 'cashuid' && A.W.classify('  ' + mine.text + '\n') === 'cashuid', 'classify says cashuid');
  const flip = (t, at) => t.slice(0, at) + (t[at] === 'A' ? 'B' : 'A') + t.slice(at + 1);
  let refused = 0;
  for (let at = 7; at < mine.text.length; at++) if (A.W.cashuIdDecode(flip(mine.text, at)) === null) refused += 1;
  ok(refused === mine.text.length - 7, 'one character changed anywhere is refused', String(refused));
  ok(A.W.cashuIdProblem(flip(mine.text, 40)) === 'That is not a Cashu ID.', 'in those words');
  ok(A.W.classify(flip(mine.text, 40)) === 'cashuid' && A.W.classify(mine.text.slice(0, 60)) === 'cashuid', 'a mistyped or cut one is still named a Cashu ID');
  ok(A.W.cashuIdDecode(mine.text.slice(0, 60)) === null && A.W.cashuIdDecode(mine.text + 'A') === null, 'cut short or too long: refused');
  const v1 = A.W._cashuIdEncode(V.id, V.nostr);
  ok(v1.length === 101 && A.W.cashuIdDecode(v1) === null && A.W.cashuIdProblem(v1) === 'That is not a Cashu ID.' && A.W.classify(v1) === 'cashuid',
    'version 1 (no signature, 101 characters) is refused: That is not a Cashu ID.', A.W.cashuIdProblem(v1));
  let v1No = '';
  try { await A.W.cashuIdCheck(v1); } catch (e) { v1No = e.message; }
  ok(v1No === 'That is not a Cashu ID.', 'and refused when pasted or scanned', v1No);
  const resum = (bytes) => 'foxyid1' + Buffer.from(bytes.concat([...crypto.createHash('sha256').update(Buffer.from(bytes)).digest().subarray(0, 4)])).toString('base64url');
  const v3 = resum([3].concat([...Buffer.from(V.id, 'hex')], [...Buffer.from(V.nostr, 'hex')], [...Buffer.from(V.bindSig, 'hex')]));
  ok(/newer Foxy/.test(A.W.cashuIdProblem(v3)), 'a newer version is said to be from a newer Foxy', A.W.cashuIdProblem(v3));
  // a signed string whose delivery key is not the one the ID signed: refused, checksum and all
  const C0 = cashuIdKeys(seedOf(C, THIRD_WORDS));
  const forged = resum([2].concat([...Buffer.from(V.id, 'hex')], [...Buffer.from(C0.nostr, 'hex')], [...Buffer.from(V.bindSig, 'hex')]));
  const forged2 = resum([2].concat([...Buffer.from(V.id, 'hex')], [...Buffer.from(C0.nostr, 'hex')], [...Buffer.from(C0.sig, 'hex')]));
  ok(A.W.cashuIdDecode(forged) === null && A.W.cashuIdDecode(forged2) === null, 'a version 2 string whose signature is not the ID’s over its own delivery key is not an ID');
  let threw = 0, read = 0;
  for (let i = 0; i < 300; i++) {
    const t = 'foxyid1' + crypto.randomBytes(i % 2 ? 70 : 134).toString('base64url');
    try { if (A.W.cashuIdDecode(t)) read += 1; A.W.cashuIdProblem(t); A.W.classify(t); } catch (e) { threw += 1; }
  }
  ok(threw === 0 && read === 0, 'three hundred random strings: none throws and none reads', threw + '/' + read);

  /* ---- adding a contact ------------------------------------------------- */
  const own = await A.W.cashuIdCheck(mine.text);
  ok(own.own === true, 'pasting your own ID is seen as yours');
  let ownNo = '';
  try { await A.W.cashuIdAdd(mine.text, 'Me'); } catch (e) { ownNo = e.message; }
  ok(ownNo === 'That is your own Cashu ID.', 'and is not added', ownNo);
  const check = await B.W.cashuIdCheck(mine.text);
  ok(check.own === false && check.name === '' && check.id === V.id && !('conflict' in check), 'on another phone it is a new ID');
  const added = await B.W.cashuIdAdd(mine.text, 'Alice');
  ok(added.name === 'Alice' && added.cid.id === V.id && added.cid.nostr === V.nostr && added.handle === mine.text,
    'kept as a contact with its keys and the name', JSON.stringify(added).slice(0, 120));
  await B.W.cashuIdAdd(mine.text, '  Alicia  ');
  const book = B.store('foxy.contacts', []);
  ok(book.filter((c) => c.cid && c.cid.id === V.id).length === 1 && book.find((c) => c.cid).name === 'Alicia', 'the same ID again updates the contact, never a second one');
  await B.W.cashuIdAdd(mine.text, 'Alice');
  ok((await B.W.cashuIdCheck(mine.text)).name === 'Alice', 'and the check names it');
  let badNo = '';
  try { await B.W.cashuIdAdd(flip(mine.text, 50), 'X'); } catch (e) { badNo = e.message; }
  ok(badNo === 'That is not a Cashu ID.', 'a mistyped one is refused at the add too', badNo);
  ok(B.W.cashuIdContacts().length === 1, 'cashuIdContacts lists the one');

  /* L1: Alice's ID with somebody else's delivery key and no signature (version 1) is not an ID at all */
  const swapped = B.W._cashuIdEncode(V.id, C0.nostr);
  let swapNo = '', swapChk = '';
  try { await B.W.cashuIdCheck(swapped); } catch (e) { swapChk = e.message; }
  try { await B.W.cashuIdAdd(swapped, 'Alice'); } catch (e) { swapNo = e.message; }
  ok(swapChk === 'That is not a Cashu ID.' && swapNo === 'That is not a Cashu ID.' && B.W.cashuIdContacts()[0].cid.nostr === V.nostr
    && B.W.cashuIdContacts()[0].cid.sig === V.bindSig, 'L1: an unsigned string naming a contact’s ID with another address is refused, the contact unchanged', swapNo);

  /* ---- paying a contact ---------------------------------------------------- */
  const bId = await B.W.cashuIdMine();
  relay = [];
  const asked0 = B.said.asked.length;
  const before = await balance(B);
  const t0 = Math.floor(Date.now() / 1000);
  const paid = await B.W.cashuIdPay(mine.text, 100, { note: 'lunch' });
  const t1 = Math.floor(Date.now() / 1000);
  ok(paid.sent === true && paid.name === 'Alice', 'paid, and sent once a relay took it', JSON.stringify(paid).slice(0, 120));
  ok((await balance(B)) === before - 100, 'the payer’s balance is 100 less', String(await balance(B)));
  ok(relay.length === 1 && relay[0].target === B.W._cashuIdNprofile(V.nostr) && /^nprofile1/.test(relay[0].target), 'one message, to the nprofile of the contact’s delivery key');
  const msg1 = JSON.parse(relay[0].body);
  ok(msg1.v === 2 && msg1.type === 'foxy-cashu-id' && /^0[23][0-9a-f]{64}$/.test(msg1.E) && msg1.note === 'lunch' && /^cashuB/.test(msg1.token),
    'the message: { v: 2, type, token, E, note }', JSON.stringify(Object.keys(msg1)));
  ok(!('from' in msg1) && !('tag' in msg1), 'M6: a payer whose own ID was never shown does not name itself', JSON.stringify(Object.keys(msg1)));
  const p1 = proofsOf(B, msg1.token);
  const r1 = B.store('foxy.cid.outbox', []).find((r) => r.id === paid.row) || {};
  ok(p1.length > 0 && p1.every((pr) => /^0[23][0-9a-f]{64}$/.test(pr.p2pk_e || '')), 'every proof carries its E (p2pk_e, `pe` in the V4 token)');
  ok(new Set(p1.map((pr) => pr.p2pk_e)).size === p1.length, 'a fresh E for every piece, as NUT-28 asks');
  ok(p1.some((pr) => pr.p2pk_e === msg1.E), 'the envelope’s E is one of the proofs’');
  ok(p1.every((pr) => {
    const t = cashuIdOneTime(keysA.d, pr.p2pk_e, lockOf(pr));
    return !!t && t.L === lockOf(pr);
  }), 'every piece is locked to the ID blinded by its own E: the receiver finds its key');
  ok(p1.every((pr) => lockOf(pr) !== V.id && tag(pr, 'refund') !== r1.refundPub), 'neither the ID nor the refund key is in any secret as it is');
  const idxB = r1.index;
  const lt = Number(tag(p1[0], 'locktime'));
  const base = cashuIdPayBase(keysB.pay, V.id, idxB, lt);
  const es = []; for (let j = 0; j < 64; j++) es.push(cashuIdPieceKey(base, j));
  const fromSeed = p1.every((pr) => es.some((e) => {
    const bl2 = B.W._cashuIdBlind(V.id, e.toString(16).padStart(64, '0'), r1.refundPub);
    return bl2.E === pr.p2pk_e && bl2.L === lockOf(pr) && bl2.R === tag(pr, 'refund');
  }));
  ok(fromSeed, 'M5: every E is the payer’s seed’s, from the contact, the refund key’s index and the locktime; the refund key blinded at slot 1');
  ok(p1.every((pr) => Number(tag(pr, 'locktime')) === lt), 'one locktime for the payment');
  const days = [t0, t1].map((t) => Math.floor((t + 30 * DAY) / DAY) * DAY);
  ok(days.some((d) => lt >= d && lt < d + DAY), 'M4: the locktime is the day thirty days on, at a second of it', String(lt - t0));
  ok(B.said.asked.slice(asked0).filter((x) => /\/v1\/swap$/.test(x.url)).every((x) => x.body.indexOf('p2pk_e') < 0 && x.body.indexOf('"pe"') < 0),
    'the mint is never shown an E');
  ok(r1.refundPub && /^0[23]/.test(r1.refundPub) && Number.isInteger(r1.index), 'the outbox row keeps the refund key and its index');
  const lockRows = B.store('foxy.req.lockkeys', {});
  ok(lockRows[r1.refundRow] && lockRows[r1.refundRow].pub === r1.refundPub && lockRows[r1.refundRow].i === r1.index, 'the refund key is a seed-derived lock key, on its own row');
  ok(r1.state === 'out' && r1.sentAt > 0 && r1.E === msg1.E && r1.name === 'Alice' && !('e' in r1) && JSON.stringify(r1).indexOf(base) < 0,
    'the outbox row: out, sent, with E and no throwaway key or base', JSON.stringify(Object.keys(r1)));
  ok((logRow(B, paid.hash) || {}).memo === 'To Alice', 'the payer’s history row says To Alice');
  /* the recovery copy: due one to thirty minutes after the relay took the payment, never with it */
  ok(r1.copyAt - r1.sentAt >= 60000 && r1.copyAt - r1.sentAt <= 30 * 60000 && !r1.copiedAt && relay.length === 1,
    'R1: the copy to the recovery key is due one to thirty minutes after a relay took the payment, and not sent with it', String(r1.copyAt - r1.sentAt));
  {
    const keepRelay = relay.slice();
    const delays = [];
    for (let i = 0; i < 40; i++) {
      const rows = B.store('foxy.cid.outbox', []);
      rows.forEach((r) => { if (r.id === paid.row) { delete r.copyAt; delete r.sentAt; } });
      B.put('foxy.cid.outbox', rows);
      await B.W.cashuIdDeliver();
      const r = B.store('foxy.cid.outbox', []).find((x) => x.id === paid.row) || {};
      delays.push(r.copyAt - r.sentAt);
    }
    ok(delays.every((d) => d >= 60000 && d <= 30 * 60000) && new Set(delays.map((d) => Math.floor(d / 1000))).size > 30,
      'R1: and at a random second of that half hour each time', JSON.stringify(delays.slice(0, 4)));
    relay = keepRelay;
  }
  ok(B.phone.said.every((x) => x.text.indexOf(keysB.d.toString(16)) < 0 && x.text.indexOf(keysB.pay.toString(16)) < 0), 'no answer from the phone holds the ID key or the paying key');
  let selfNo = '';
  try { await A.W.cashuIdPay(mine.text, 10); } catch (e) { selfNo = e.message; }
  ok(selfNo === 'That is your own Cashu ID.', 'paying your own ID is refused', selfNo);

  /* ---- receiving ---------------------------------------------------------- */
  const aBefore = await balance(A);
  const got1 = await A.W._cashuIdArrived(relay[0].body);
  ok(got1 === 'taken', 'the receiver takes it', got1);
  ok((await balance(A)) === aBefore + 100, 'and holds 100 more', String(await balance(A)));
  ok(A.said.sign === 1, 'the phone signed for it once (the key itself never left it)');
  const inRow = logRows(A).filter((e) => e.dir === 'in')[0] || {};
  ok(inRow.memo === 'From a Cashu ID' && inRow.cid === 'in', 'a payer that names nobody: From a Cashu ID', JSON.stringify(inRow));
  ok(A.phone.said.every((x) => x.text.indexOf(V.k) < 0 && x.text.indexOf(V.d) < 0 && x.text.indexOf(keysA.d.toString(16)) < 0),
    'no answer from the phone holds the ID key or a one-time key');
  ok(A.store('foxy.cid.seen', []).every((s) => /^[0-9a-f]{32}$/.test(s)), 'what was taken is remembered by a hash of each secret, not the secret');

  const got2 = await A.W._cashuIdArrived(relay[0].body);
  ok(got2 === 'seen' && (await balance(A)) === aBefore + 100, 'the same message twice is one receipt', got2);
  const both = await Promise.all([A.W._cashuIdArrived(relay[0].body), A.W._cashuIdArrived(relay[0].body)]);
  ok(both.every((x) => x === 'seen') && (await balance(A)) === aBefore + 100, 'and two at once take nothing more', both.join(','));

  /* H1/M6: named only when proved */
  await A.W.cashuIdAdd(bId.text, 'Bob');
  await B.W.cashuIdShown();
  relay = [];
  await B.W.cashuIdPay(added.cid.id, 50);
  const m2 = JSON.parse(relay[0].body);
  ok(m2.from === bId.id && m2.tag === cashuIdTag(keysB.d, V.id, m2.E), 'M6: once its ID is in use, the payer names itself with the proving tag');
  // a payment uses up no index of the message chain: nothing a server could be asked about, and the chain only counts messages
  const bThreads = JSON.parse(B.storage.getItem('foxy.msg.threads') || '{}').threads || {};
  ok(!('i' in m2) && !(Number((bThreads[V.id] || {}).out) > 0), 'a proved payment to a contact carries no chain index and leaves the message chain where it was',
    JSON.stringify({ i: m2.i, out: (bThreads[V.id] || {}).out }));
  const tagsBefore = A.said.tag;
  ok((await A.W._cashuIdArrived(relay[0].body)) === 'taken' && (logRows(A).filter((e) => e.dir === 'in')[0] || {}).memo === 'From Bob', 'a payer who is a contact and proves it: From Bob');
  ok(A.said.tag === tagsBefore + 1, 'the tag was worked out by the phone');
  // INBOX's payments (08f-cashu-msg.js `cmsgPaymentsNow`): the proved payer's row carries its ID key; the one that named nobody does not
  const proved = logRows(A).filter((e) => e.dir === 'in')[0] || {};
  ok(proved.cidPeer === bId.id && !inRow.cidPeer, 'the row of a proved payer carries its ID key (`cidPeer`), the row of one that named nobody none',
    JSON.stringify([proved.cidPeer, inRow.cidPeer]));
  const aPays = A.W.cashuMsgPayments();
  ok(aPays.length === 1 && aPays[0].peer === bId.id && aPays[0].dir === 'in' && aPays[0].unit === 'sat' && aPays[0].amount === 50
     && Math.abs(aPays[0].at - Date.now()) < 120000, 'INBOX’s payments on the receiver: 50 sats from Bob, in milliseconds', JSON.stringify(aPays));
  const bPays = B.W.cashuMsgPayments();
  ok(bPays.length === 2 && bPays.every((p) => p.peer === V.id && p.dir === 'out') && bPays[0].amount === 50 && bPays[1].amount === 100 && bPays[0].at >= bPays[1].at,
    'and on the payer: both payments to that ID, newest first', JSON.stringify(bPays));
  ok(m2.E !== msg1.E, 'a new E for every payment');

  /* H1: a spoofed `from` — the attacker's own payment, naming Bob */
  const D = page(FOURTH_WORDS);
  await D.W.connect(MINT, { remember: true });
  await D.W.claim((await D.W.invoice(500, '')).hash);
  await D.W.cashuIdAdd(mine.text, 'victim');
  await D.W.cashuIdShown();
  relay = [];
  await D.W.cashuIdPay(mine.text, 7);
  const spoof = envelope(relay[0].body, { from: bId.id });
  ok((await A.W._cashuIdArrived(spoof)) === 'taken' && (logRows(A).filter((e) => e.dir === 'in')[0] || {}).memo === 'From a Cashu ID',
    'H1: a delivery naming Bob with somebody else’s tag: From a Cashu ID, not From Bob');
  ok(!(logRows(A).filter((e) => e.dir === 'in')[0] || {}).cidPeer && A.W.cashuMsgPayments().length === 1,
    'H1: and INBOX does not put it under Bob');
  relay = [];
  await D.W.cashuIdPay(mine.text, 6);
  const noTag = JSON.parse(relay[0].body);
  delete noTag.tag;
  noTag.from = bId.id;
  ok((await A.W._cashuIdArrived(JSON.stringify(noTag))) === 'taken' && (logRows(A).filter((e) => e.dir === 'in')[0] || {}).memo === 'From a Cashu ID',
    'H1: and one naming Bob with no tag at all');

  /* ---- deliveries that are not this ID's ------------------------------------ */
  relay = [];
  await B.W.cashuIdPay(mine.text, 20);
  const m3 = JSON.parse(relay[0].body);
  const signsBefore = A.said.sign;
  // another payment's E on every proof: the phone signs nothing
  const pm3 = proofsOf(B, m3.token);
  const wrongE = envelope(relay[0].body, { token: reToken(B, MINT, 'sat', pm3.map((p) => Object.assign({}, p, { p2pk_e: msg1.E }))) });
  ok((await A.W._cashuIdArrived(wrongE)) === 'refused', 'the right pieces with another payment’s E are refused');
  ok(A.phone.refusals.some((x) => x.action === 'cashuIdSign' && /not locked to this Cashu ID/.test(x.error)), 'by the phone: not locked to this Cashu ID');
  ok(A.store('foxy.cid.inbox', []).length === 0, 'and nothing of it is kept');
  // a payment to C's ID delivered to A
  const cId = await C.W.cashuIdMine();
  await B.W.cashuIdAdd(cId.text, 'Carol');
  relay = [];
  await B.W.cashuIdPay(cId.text, 30);
  const toC = relay[0].body;
  ok((await A.W._cashuIdArrived(toC)) === 'refused', 'a payment to someone else’s ID is refused here');
  ok((await C.W._cashuIdArrived(toC)) === 'taken', 'and taken by its own');
  // ecash locked straight to the ID key, unblinded
  const direct = await B.W.sendToken(15, { unit: 'sat', lockTo: V.id });
  const dp = proofsOf(B, direct.token);
  // (asked of its receiver, never signed for by itself: PAID TO YOUR ID KEY, tests/cashu-id-any.js)
  const bareSigns = A.said.sign;
  const bareBal = await balance(A);
  ok((await A.W._cashuIdArrived(JSON.stringify({ v: 2, type: 'foxy-cashu-id', token: direct.token, E: V.E }))) === 'unblinded', 'ecash locked to the ID key itself, with no E, is not taken: its receiver is asked');
  ok((await A.W._cashuIdArrived(JSON.stringify({ v: 2, type: 'foxy-cashu-id', token: reToken(B, MINT, 'sat', dp.map((p) => Object.assign({}, p, { p2pk_e: V.E }))) }))) === 'unblinded',
    'nor with a made-up E: the ID key is never a lock key by itself');
  ok(A.said.sign === bareSigns && !A.phone.cashuIdSignedBare && (await balance(A)) === bareBal, 'and nothing is signed for either');
  // L2: the DLEQ gate — none, and a wrong one
  const noDleq = envelope(relay[0].body);
  relay = [];
  await B.W.cashuIdPay(mine.text, 9);
  const m9 = relay[0].body;
  const pm9 = proofsOf(B, JSON.parse(m9).token);
  const kept0 = A.store('foxy.cid.inbox', []).length;
  const signsDleq = A.said.sign;
  ok((await A.W._cashuIdArrived(envelope(m9, { token: reToken(B, MINT, 'sat', pm9.map((p) => { const c = Object.assign({}, p); delete c.dleq; return c; })) }))) === 'refused',
    'L2: a delivery without the mint’s DLEQ is refused');
  ok((await A.W._cashuIdArrived(envelope(m9, { token: reToken(B, MINT, 'sat', pm9.map((p) => Object.assign({}, p, { dleq: Object.assign({}, p.dleq, { s: '11'.repeat(32) }) }))) }))) === 'refused',
    'L2: and one whose DLEQ does not verify');
  ok(A.store('foxy.cid.inbox', []).length === kept0 && A.said.sign === signsDleq, 'neither is kept, and the phone signs for neither');
  // L2: the keyset-unit gate — sat pieces labelled dollars
  ok((await A.W._cashuIdArrived(envelope(m9, { token: reToken(B, MINT, 'usd', pm9) }))) === 'refused', 'L2: sat pieces in a token that says dollars are refused');
  // a bad E: not a point
  ok((await A.W._cashuIdArrived(envelope(m9, { token: reToken(B, MINT, 'sat', pm9.map((p) => Object.assign({}, p, { p2pk_e: '02' + 'ff'.repeat(32) }))) }))) === 'refused',
    'an E that is not a point is refused before anything is written');
  // shapes that are not a payment, and the earlier test build's envelope
  const shapes = ['', 'x', '[]', '{"v":3}', JSON.stringify({ v: 2, type: 'foxy-cashu-id', token: 'cashuBnope' }),
    JSON.stringify(Object.assign({}, JSON.parse(m9), { v: 1 })), JSON.stringify(Object.assign({}, JSON.parse(m9), { token: 'x'.repeat(70000) }))];
  const shaped = [];
  for (const s of shapes) shaped.push(await A.W._cashuIdArrived(s));
  ok(shaped.every((x) => x === 'refused'), 'malformed deliveries, and version 1’s, are refused and never throw', shaped.join(','));
  ok((await A.W._cashuIdArrived(m9)) === 'taken' && (await A.W._cashuIdArrived(JSON.stringify(m3))) === 'taken' && A.said.sign > signsBefore, 'the real ones are taken');
  void noDleq;

  /* ---- another wallet's NUT-18 payload (no E on the envelope, E on the proofs) ---- */
  {
    // cashu-ts's own blinding, its random e per piece, no locktime and no refund: as another wallet pays a static request
    const other = await B.W.sendToken(11, { unit: 'sat', lockTo: V.id, blindKeys: true });
    const op = proofsOf(B, other.token);
    ok(op.every((p) => /^0[23]/.test(p.p2pk_e || '') && lockOf(p) !== V.id && !tag(p, 'locktime')), 'cashu-ts’s own blindKeys: an E on each piece, no locktime');
    const payload = JSON.stringify({ id: 'req1', memo: 'from another wallet', mint: MINT, unit: 'sat', proofs: op });
    const aMid = await balance(A);
    ok((await A.W._cashuIdArrived(payload)) === 'taken' && (await balance(A)) === aMid + 11, 'a NUT-18 payload from another wallet, no locktime or refund, is taken');
    ok((logRows(A).filter((e) => e.dir === 'in')[0] || {}).memo === 'From a Cashu ID', 'and names nobody');
  }

  /* ---- with no route: kept, and taken when the route comes back -------------- */
  relay = [];
  await B.W.cashuIdPay(mine.text, 25);
  A.W._privacy({ tor: 'connecting', progress: 40, everUp: true });
  const aMid = await balance(A);
  ok((await A.W._cashuIdArrived(relay[0].body)) === 'kept', 'offline it is kept');
  const keptRow = A.store('foxy.cid.inbox', [])[0] || {};
  const lt25 = Number(tag(proofsOf(B, JSON.parse(relay[0].body).token)[0], 'locktime'));
  ok(A.store('foxy.cid.inbox', []).length === 1 && keptRow.drop === (lt25 - DAY) * 1000 && keptRow.mint === MINT, 'H2: in the inbox, to go a day before its locktime', JSON.stringify({ drop: keptRow.drop }));
  ok((await balance(A)) === aMid, 'not in the balance');
  // the same payment without a locktime is not kept (the relays still hold it)
  const unlocked = await B.W.sendToken(4, { unit: 'sat', lockTo: V.id, blindKeys: true });
  ok((await A.W._cashuIdArrived(JSON.stringify({ mint: MINT, unit: 'sat', proofs: proofsOf(B, unlocked.token) }))) === 'refused' && A.store('foxy.cid.inbox', []).length === 1,
    'H2: one with no locktime is not kept offline');
  A.W._privacy({ tor: 'up', progress: 100, everUp: true });
  // the 4 with no locktime, read again later as the relays still have it
  ok((await A.W._cashuIdArrived(JSON.stringify({ mint: MINT, unit: 'sat', proofs: proofsOf(B, unlocked.token) }))) === 'taken', 'and taken when it is read again online');
  // a fresh page: A had shown nothing yet
  const A2opens = A.said.open.length;
  await A.W.cashuIdListen();
  ok(A.said.open.length === A2opens, 'before MY CASHU ID was ever shown the phone is not asked to listen');
  await A.W.cashuIdShown();
  ok(A.said.open.length === A2opens + 1 && Math.abs(A.said.open[A.said.open.length - 1] - (Math.floor(Date.now() / 1000) - 32 * DAY)) < 600,
    'M2: once shown, the phone listens from thirty-two days back (thirty to collect, two of NIP-59 backdating)', String(A.said.open[A.said.open.length - 1]));
  ok(await until(async () => (await balance(A)) === aMid + 25 + 4), 'and what was kept is taken', String(await balance(A)));
  ok(A.store('foxy.cid.inbox', []).length === 0, 'and leaves the inbox');
  // H2: a kept row whose day-before-locktime has passed goes unread
  A.put('foxy.cid.inbox', [{ key: 'cid:old', body: '{}', at: 1, mint: MINT, drop: Date.now() - 1000 }]);
  await A.W.cashuIdListen();
  ok(A.store('foxy.cid.inbox', []).length === 0, 'H2: a kept row is let go a day before its locktime');

  /* ---- at a mint the receiver does not use: brought home to its default mint ----
   * With BRING IT HOME remembered for that mint (the card's tick, `foxy.cid.choice.<host>`), which runs as every one ran
   * before there was a card. The card itself, KEEP IT THERE, SEND IT BACK and dollars: tests/cashu-id-choice.js. */
  A.put('foxy.cid.choice.home.test', 'home');
  await C.W.connect(HOME, { remember: true });
  await C.W.claim((await C.W.invoice(800, '')).hash);
  await C.W.cashuIdAdd(mine.text, 'Alice');
  await C.W.cashuIdShown();
  await A.W.cashuIdAdd(cId.text, 'Carol');
  ok(A.store('foxy.cashu.mint', '') === MINT || A.W.mintUrl === MINT, 'the receiver’s default mint is m.test, and it has never used home.test');
  relay = [];
  await C.W.cashuIdPay(mine.text, 60);
  const atHome = relay[0].body;
  const homeAsked = () => A.said.asked.filter((x) => x.url.indexOf('home.test') >= 0).length;
  const aMain0 = await balance(A);
  const aHome0 = Number(await A.W.balanceAt(HOME)) || 0;
  const paidSeen = [];
  A.W._onCashuIdPaid = (x) => paidSeen.push(x);
  const homeGot = await A.W._cashuIdArrived(atHome);
  ok(homeGot === 'taken', 'F1: a payment at a mint this phone does not use is taken there and brought home', homeGot);
  ok(homeAsked() > 0 && A.W.mintUrl === MINT, 'F1: that mint was asked, and the phone is back at its own');
  const aMain1 = await balance(A);
  const aHome1 = Number(await A.W.balanceAt(HOME)) || 0;
  ok(aMain1 - aMain0 === 50, 'F1: what lands at the default mint is the payment less the crossing (60, the route’s reserve of 10 held back)', String(aMain1 - aMain0));
  ok(aHome1 - aHome0 === 8, 'F1: and the reserve the route did not use is change at home.test', String(aHome1 - aHome0));
  const homeRow = logRows(A).filter((e) => e.dir === 'in' && e.mint === MINT)[0] || {};
  ok(homeRow.memo === 'From Carol, came home from home.test, fee 2 sats' && homeRow.cid === 'in' && homeRow.sats === 50,
    'F1: its row at home: From Carol, came home from home.test, fee 2 sats', JSON.stringify({ memo: homeRow.memo, sats: homeRow.sats }));
  ok(paidSeen.length === 1 && paidSeen[0].sats === 50 && paidSeen[0].fee === 2 && paidSeen[0].name === 'Carol', 'F1: and the app is told once, when it is home', JSON.stringify(paidSeen));
  ok(A.W.cashuIdWaiting().length === 0 && A.store('foxy.cid.offers', []).length === 0 && !(A.store('foxy.cashu.carry', []) || []).length,
    'F1: no offer, nothing waiting, and no walk home left open');
  ok((await A.W._cashuIdArrived(atHome)) === 'seen', 'F1: read again, it is the same payment');

  /* smaller than its crossing's fee: it waits, listed, and comes home with the next one there */
  relay = [];
  await C.W.cashuIdPay(mine.text, 5);
  const five = relay[0].body;
  const aMain2 = await balance(A);
  ok((await A.W._cashuIdArrived(five)) === 'waiting', 'F2: 5 sats at home.test cost more than that to bring home: it waits');
  const waits = A.W.cashuIdWaiting();
  ok(waits.length === 1 && waits[0].amount === 5 && waits[0].host === 'home.test' && waits[0].name === 'Carol' && !('body' in waits[0]),
    'F2: listed for HISTORY, with no token', JSON.stringify(waits));
  ok((await balance(A)) === aMain2 && (A.store('foxy.cid.offers', [])[0] || {}).body === five, 'F2: not in the balance, and kept in storage to survive a restart');
  const askedWait = homeAsked();
  ok((await A.W._cashuIdArrived(five)) === 'waiting' && homeAsked() === askedWait, 'F2: read again, the mint is not asked again');
  relay = [];
  await C.W.cashuIdPay(mine.text, 20);
  const twenty = relay[0].body;
  ok((await A.W._cashuIdArrived(twenty)) === 'taken', 'F2: 20 more there makes 25 worth the crossing: both come home');
  ok((await balance(A)) - aMain2 === 15 && A.W.cashuIdWaiting().length === 0, 'F2: 15 landed, and nothing waits', String((await balance(A)) - aMain2));
  ok(((logRows(A).filter((e) => e.dir === 'in' && e.mint === MINT)[0] || {}).memo || '') === 'From Carol, came home from home.test, fee 2 sats', 'F2: with its own row');
  ok((await A.W._cashuIdArrived(five)) === 'seen', 'F2: and the waiting one, read again, is taken already');
  {
    // a waiting row, and the hour's count, from storage on a fresh start
    const W2 = page(PHONE_WORDS);
    W2.put('foxy.cid.choice.home.test', 'home');
    W2.put('foxy.cid.offers', [{ key: 'cid:w1', body: five, at: Date.now(), mint: HOME, unit: 'sat', amount: 5, name: 'Carol', drop: Date.now() + DAY * 1000 }]);
    W2.put('foxy.cid.foreign', [Date.now(), Date.now(), Date.now(), Date.now(), Date.now()]);
    await W2.W.connect(MINT, { remember: true });
    ok(W2.W.cashuIdWaiting().length === 1 && W2.W.cashuIdWaiting()[0].amount === 5, 'F2: a waiting payment is still listed after a restart');
    relay = [];
    await C.W.cashuIdPay(mine.text, 30);
    const w2Home = () => W2.said.asked.filter((x) => x.url.indexOf('home.test') >= 0).length;
    ok((await W2.W._cashuIdArrived(relay[0].body)) === 'refused' && w2Home() === 0, 'F3: and the hour’s cap of five, kept in storage, still stops the next one unasked');
    void W2;
  }

  /* a fake mint: nothing is taken, nothing kept */
  {
    relay = [];
    await B.W.cashuIdPay(mine.text, 12);
    const real = JSON.parse(relay[0].body);
    const fake = envelope(relay[0].body, { token: reToken(B, PLAIN, 'sat', proofsOf(B, real.token)) });
    const aBefore = await balance(A);
    const signsF = A.said.sign;
    ok((await A.W._cashuIdArrived(fake)) === 'refused' && A.said.sign === signsF && (await balance(A)) === aBefore
      && A.W.cashuIdWaiting().length === 0 && !(A.store('foxy.cashu.carry', []) || []).length,
      'F4: m.test’s pieces said to be plain.test’s: refused at its keys, nothing signed, kept or brought home');
    const plainAsked = A.said.asked.filter((x) => x.url.indexOf('plain.test') >= 0).length;
    ok((await A.W._cashuIdArrived(fake)) === 'refused' && A.said.asked.filter((x) => x.url.indexOf('plain.test') >= 0).length === plainAsked,
      'F4: and plain.test is backed off: not asked again at once');
    ok((await A.W._cashuIdArrived(relay[0].body)) === 'taken', 'the real one is taken where it really is');
  }
  // the reviewer's junk (attack.js P1): forged pieces at mints nobody can reach
  const junkE = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const junk = (i, dleq) => {
    const proofs = [{ id: '00ad268c4d1f5826', amount: 1, secret: JSON.stringify(['P2PK', { nonce: crypto.randomBytes(8).toString('hex'), data: '02' + crypto.randomBytes(32).toString('hex'),
      tags: [['locktime', String(Math.floor(Date.now() / 1000) + 20 * DAY)]] }]), C: '02' + '11'.repeat(32), p2pk_e: junkE }];
    if (dleq) proofs[0].dleq = { e: '11'.repeat(32), s: '22'.repeat(32), r: '33'.repeat(32) };
    return JSON.stringify({ mint: 'https://dead' + i + '.test', unit: 'sat', proofs });
  };
  const deadHosts = () => new Set(A.said.asked.filter((x) => /dead\d+\.test/.test(x.url)).map((x) => /dead\d+\.test/.exec(x.url)[0]));
  const j0 = await A.W._cashuIdArrived(junk(0, false));
  ok(j0 === 'refused' && deadHosts().size === 0, 'L2: forged pieces with no DLEQ are dropped before any mint is asked');
  const answers = [];
  for (let i = 1; i <= 12; i++) answers.push(await A.W._cashuIdArrived(junk(i, true)));
  ok(answers.every((x) => x === 'refused'), 'H1: forged pieces at mints that do not answer are refused', answers.join(','));
  ok(deadHosts().size === 1, 'H1: and only one of those mints is asked: five foreign mints an hour (four were asked above), the rest refused unasked',
    JSON.stringify([...deadHosts()]));
  ok(A.W.cashuIdWaiting().length === 0 && A.store('foxy.cid.offers', []).length === 0 && A.store('foxy.cid.inbox', []).length === 0, 'H1: nothing of them is stored');
  ok(A.store('foxy.cid.foreign', []).length === 5, 'H1: the hour’s count is in storage');

  /* ---- H2: a mint this phone uses whose keys will not come: fetched once, then backed off ---- */
  {
    const E2 = page(PHONE_WORDS);
    await E2.W.connect(MINT, { remember: true });
    E2.put('foxy.cashu.mints', [MINT, DOWN]);
    relay = [];
    await B.W.cashuIdPay(mine.text, 5);
    const toDown = envelope(relay[0].body, { token: reToken(B, DOWN, 'sat', proofsOf(B, JSON.parse(relay[0].body).token)) });
    const downAsked = () => E2.said.asked.filter((x) => x.url.indexOf('down.test') >= 0).length;
    ok((await E2.W._cashuIdArrived(toDown)) === 'kept' && downAsked() > 0, 'H2: at a mint this phone uses, its keys are fetched, and it is kept when they do not come');
    const n1 = downAsked();
    ok((await E2.W._cashuIdArrived(toDown)) === 'kept' && downAsked() === n1, 'H2: read again at once, that mint is not asked again (backoff)');
    await E2.W.cashuIdShown();
    ok(downAsked() === n1, 'H2: nor when the inbox drains');
    // and the real one, at the mint it is really at, still arrives for A
    ok((await A.W._cashuIdArrived(relay[0].body)) === 'taken', 'the real payment is taken where it is');
  }

  /* ---- the outbox: a relay down, tried again ---------------------------------- */
  relay = [];
  relayDown = true;
  const paidLate = await B.W.cashuIdPay(mine.text, 10);
  ok(paidLate.sent === false, 'with no relay answering it is not marked sent');
  const rowLate = () => B.store('foxy.cid.outbox', []).find((r) => r.id === paidLate.row) || {};
  ok(!rowLate().sentAt && rowLate().tries >= 1, 'it waits in the outbox with a try counted', JSON.stringify({ tries: rowLate().tries }));
  relayDown = false;
  ok(await until(() => rowLate().sentAt > 0, 3000), 'and goes once a relay takes it');
  ok(relay.length === 1, 'once');
  const rows = B.store('foxy.cid.outbox', []);
  rows.forEach((r) => { if (r.id === paidLate.row) { r.lastSentAt = Date.now() - 25 * 3600 * 1000; } });
  B.put('foxy.cid.outbox', rows);
  relay = [];
  await B.W.cashuIdDeliver();
  ok(relay.length === 1 && JSON.parse(relay[0].body).E === rowLate().E, 'a day later it is sent again, the same E');
  ok((await A.W._cashuIdArrived(relay[0].body)) === 'taken' && (await A.W._cashuIdArrived(relay[0].body)) === 'seen', 'and taken once');

  /* ---- collected ------------------------------------------------------------- */
  const watched = await B.W.cashuIdWatch();
  ok(watched.collected >= 5, 'the payer sees the mint has them spent: collected', JSON.stringify(watched));
  ok((B.store('foxy.cid.outbox', []).find((r) => r.id === paid.row) || {}).state === 'collected', 'its row says collected');
  relay = [];
  await B.W.cashuIdDeliver();
  ok(relay.length === 0, 'and nothing collected is sent again');

  /* ---- the refund key: refused before the locktime, and the money back after ---- */
  B.W._cashuIdLockS = 8;
  relay = [];
  const bMid = await balance(B);
  const early = await B.W.cashuIdPay(mine.text, 40);
  const earlyAt = Date.now();
  ok((await balance(B)) === bMid - 40, 'a payment with a locktime eight seconds out');
  ok((await B.W.cashuIdWatch()).back === 0, 'before the locktime the watch takes nothing back');
  const rowE = B.store('foxy.cid.outbox', []).find((r) => r.id === early.row) || {};
  const pE = proofsOf(B, rowE.token);
  const refundKey = p2pkAt(p2pkParent(seedOf(B, OTHER_WORDS)), rowE.index);
  ok(refundKey.pub === rowE.refundPub, 'the refund key is this seed’s at the index its row names');
  const BCT = B.window.CashuTS;
  ok(pE.every((pr) => BCT.deriveP2BKSecretKeys(pr.p2pk_e, refundKey.priv, [lockOf(pr), tag(pr, 'refund')]).length === 1), 'and opens the blinded refund key of every piece (slot 1)');
  const signedEarly = BCT.signP2PKProofs(pE.map((x) => Object.assign({}, x)), refundKey.priv);
  let earlyNo = '';
  try { await B.W.receiveToken(BCT.getEncodedToken({ mint: MINT, unit: 'sat', proofs: signedEarly })); } catch (e) { earlyNo = e.message; }
  ok(!!earlyNo && (await balance(B)) === bMid - 40, 'the mint refuses the payer’s refund key before the locktime', earlyNo.slice(0, 90));
  ok((await A.W._cashuIdArrived(relay[0].body)) === 'refused', 'the receiver will not take ecash its payer can have back so soon');
  await wait(Math.max(0, earlyAt + 9000 - Date.now()));
  relay = [];
  await B.W.cashuIdDeliver();
  ok(relay.length === 0, 'L2: past its locktime a payment is not sent again');
  const after = await B.W.cashuIdWatch();
  ok(after.back === 1, 'after it, the payer’s refund key brings it back', JSON.stringify(after));
  ok((await balance(B)) === bMid, 'the whole 40', String(await balance(B)));
  ok((B.store('foxy.cid.outbox', []).find((r) => r.id === early.row) || {}).state === 'back', 'its row says back');
  ok((logRows(B).filter((e) => e.dir === 'in')[0] || {}).memo === 'Came back: Alice did not collect it', 'and the history: Came back: Alice did not collect it');
  ok((await B.W.cashuIdWatch()).back === 0, 'once');

  /* M3: a payment no relay ever took comes back after its locktime too (attack.js P4) */
  B.W._cashuIdLockS = 2;
  relayDown = true;
  const bStuck = await balance(B);
  const stuck = await B.W.cashuIdPay(mine.text, 77);
  await wait(2600);
  const w1 = await B.W.cashuIdWatch();
  relayDown = false;
  const srow = B.store('foxy.cid.outbox', []).find((r) => r.id === stuck.row) || {};
  ok(w1.back === 1 && srow.state === 'back' && !srow.sentAt && (await balance(B)) === bStuck, 'M3: a payment no relay took is reclaimed after its locktime', JSON.stringify(w1));
  B.W._cashuIdLockS = 0;

  /* L5: a send that fails gives its refund key's row back */
  const lockBefore = Object.keys(B.store('foxy.req.lockkeys', {})).filter((k) => /^cid-refund-/.test(k)).length;
  let bigNo = '';
  try { await B.W.cashuIdPay(mine.text, 10000000); } catch (e) { bigNo = e.message; }
  ok(!!bigNo && Object.keys(B.store('foxy.req.lockkeys', {})).filter((k) => /^cid-refund-/.test(k)).length === lockBefore,
    'L5: a payment the wallet cannot make leaves no refund-key row behind', bigNo.slice(0, 80));

  /* L3: a mint that does not say it honours a lock */
  {
    const P = page(FOURTH_WORDS);
    await P.W.connect(PLAIN, { remember: true });
    await P.W.claim((await P.W.invoice(200, '')).hash);
    await P.W.cashuIdAdd(mine.text, 'Alice');
    let no = '';
    try { await P.W.cashuIdPay(mine.text, 10); } catch (e) { no = e.message; }
    ok(/does not say it honours a lock \(NUT-11\)/.test(no) && (await balance(P)) === 200, 'L3: no payment to a contact from a mint without NUT-11', no);
  }

  /* ---- M5 and the restore: the same words, a new phone ------------------------- */
  {
    relay = [];
    B.W._cashuIdLockS = 2;
    const lost = await B.W.cashuIdPay(mine.text, 33);
    B.W._cashuIdLockS = 0;
    const lrow = B.store('foxy.cid.outbox', []).find((r) => r.id === lost.row) || {};
    const B2 = page(OTHER_WORDS);
    await B2.W.connect(MINT, { remember: true });
    // what the new phone's seed gives for that payment, asked of the phone as the old one asked it
    const again = await new Promise((resolve) => {
      const got = B2.phone.answer(B2.window, { action: 'cashuIdEphemeral', id: 'x1', to: V.id, index: lrow.index, locktime: lrow.lockUntil });
      Promise.resolve(got).then((r) => resolve(JSON.parse(r[0]).base));
    });
    const lp = proofsOf(B, lrow.token);
    const es2 = []; for (let j = 0; j < 64; j++) es2.push(B2.W._cashuIdPieceKey(again, j));
    ok(lp.every((pr) => es2.some((e) => { const x = B2.W._cashuIdBlind(V.id, e, lrow.refundPub); return x.E === pr.p2pk_e && x.R === tag(pr, 'refund'); })),
      'M5: the same words, the contact, the index and the locktime give every E and blinded refund key again');
    ok(B2.W.cashuIdOutbox().length === 0, 'M5: the words alone do not bring back the outbox itself');

    /* ---- R: the recovery copy, and a restore that reads it back ---------------- */
    // the copy of `lost`: its moment brought forward, and sent to B's own recovery key
    const toRecovery = B.W._cashuIdNprofile(keysB.recovery);
    relay = [];
    const rowsL = B.store('foxy.cid.outbox', []);
    rowsL.forEach((r) => { if (r.id === lost.row) r.copyAt = Date.now() - 1; });
    B.put('foxy.cid.outbox', rowsL);
    await B.W.cashuIdCopies();
    const copyMsg = relay.find((x) => x.target === toRecovery);
    ok(!!copyMsg && relay.length === 1, 'R2: the copy goes to the payer’s recovery key (m/129373\'/20\'/3\'/0\'/0\'), once', relay.map((x) => x.target.slice(0, 20)).join(','));
    ok(toRecovery !== B.W._cashuIdNprofile(V.nostr) && toRecovery !== B.W._cashuIdNprofile(keysB.nostr) && keysB.recovery !== keysB.nostr,
      'R2: not the contact’s delivery key, nor the payer’s own');
    const copy = JSON.parse(copyMsg.body);
    ok(copy.type === 'foxy-cashu-id-copy' && copy.v === 1 && copy.token === lrow.token && copy.contact === V.id && copy.to === V.nostr
      && copy.locktime === lrow.lockUntil && copy.index === lrow.index && copy.refund === lrow.refundPub && copy.name === 'Alice' && copy.E === lrow.E,
      'R2: the copy holds the token, E, the contact, its delivery key, the locktime, the refund key and its index, and the name', Object.keys(copy).join(','));
    ok(!!(B.store('foxy.cid.outbox', []).find((r) => r.id === lost.row) || {}).copiedAt, 'R2: and the row says it went');
    relay = [];
    await B.W.cashuIdCopies();
    ok(relay.length === 0, 'R2: once');
    const myId = await B.W.cashuIdMine();
    ok(Object.keys(myId).indexOf('recovery') < 0 && myId.text.length === 186 && myId.text.indexOf(keysB.recovery) < 0,
      'R2: the recovery key is in nothing the screens are given, nor in the ID string');
    // a copy sent only once a relay took the payment
    {
      relayDown = true;
      B.W._cashuIdCopyMs = 150;
      const waitRelay = await B.W.cashuIdPay(mine.text, 3);
      await wait(400);
      const r0 = B.store('foxy.cid.outbox', []).find((r) => r.id === waitRelay.row) || {};
      ok(!r0.sentAt && !r0.copyAt && !r0.copiedAt && relay.length === 0, 'R1: no relay took the payment: no copy is due or sent');
      relayDown = false;
      relay = [];
      await B.W.cashuIdDeliver();
      ok(relay.length === 1 && relay[0].target !== toRecovery, 'R1: the payment goes first, alone');
      ok(await until(() => relay.some((x) => x.target === toRecovery), 3000), 'R1: and its copy after its delay');
      // the relay stub sees the copy a moment before the wallet marks the row (copiedAt is written once the
      // delivery's promise settles); read the row only once it is marked, or copiedAt is still undefined here
      await until(() => (B.store('foxy.cid.outbox', []).find((r) => r.id === waitRelay.row) || {}).copiedAt, 1000);
      const r1c = B.store('foxy.cid.outbox', []).find((r) => r.id === waitRelay.row) || {};
      ok(r1c.copiedAt - r1c.sentAt >= 150, 'R1: not in the same moment as the payment', String(r1c.copiedAt - r1c.sentAt));
      B.W._cashuIdCopyMs = 0;
      await A.W._cashuIdArrived(relay.find((x) => x.target !== toRecovery).body);
    }

    // the restore: the same words on a phone with nothing else, reading the copies back
    B2.put('foxy.cid.recover', Date.now());
    B2.put('foxy.cid.shown', Date.now());
    await B2.W.cashuIdListen();
    ok(B2.said.copies.length === 1 && B2.said.open.length === 1, 'R3: a restored phone listens on its recovery key as well, thirty-two days back',
      JSON.stringify(B2.said.copies));
    const bBack = await balance(B2);
    ok((await B2.W._cashuIdCopy(copyMsg.body)) === 'rebuilt', 'R3: the copy of the uncollected payment rebuilds its outbox row');
    const rebuilt = B2.W.cashuIdOutbox()[0] || {};
    ok(B2.W.cashuIdOutbox().length === 1 && rebuilt.state === 'out' && rebuilt.name === 'Alice' && rebuilt.lockUntil === lrow.lockUntil && rebuilt.restored === true,
      'R3: out, to Alice, with its locktime', JSON.stringify(rebuilt));
    ok((await B2.W._cashuIdCopy(copyMsg.body)) === 'seen' && B2.W.cashuIdOutbox().length === 1, 'R3: the same copy twice (four relays) is one row, by its token');
    await wait(Math.max(0, lrow.lockUntil * 1000 + 1000 - Date.now()));
    const back2 = await B2.W.cashuIdWatch();
    ok(back2.back === 1 && (await balance(B2)) === bBack + 33, 'R3: after the locktime the restored phone’s refund key brings the 33 back', JSON.stringify(back2));
    ok((logRows(B2).filter((e) => e.dir === 'in')[0] || {}).memo === 'Came back: Alice did not collect it', 'R3: Came back: Alice did not collect it');
    ok((await B2.W._cashuIdCopy(copyMsg.body)) === 'seen', 'R3: and a copy read again after that is nothing new');

    // a copy of a payment its contact collected: ignored
    const collectedCopy = Object.assign({}, copy, { token: r1.token, E: r1.E, locktime: r1.lockUntil, index: r1.index, refund: r1.refundPub });
    ok((await B2.W._cashuIdCopy(JSON.stringify(collectedCopy))) === 'collected' && B2.W.cashuIdOutbox().length === 1,
      'R4: a copy of a payment Alice collected is ignored: no row', B2.W.cashuIdOutbox().length);

    // forged copies, on a restored phone that has none of this yet: dropped
    const B3 = page(OTHER_WORDS);
    await B3.W.connect(MINT, { remember: true });
    const F = [];
    F.push(await B3.W._cashuIdCopy(JSON.stringify(Object.assign({}, copy, { refund: r1.refundPub }))));          // another index's key
    F.push(await B3.W._cashuIdCopy(JSON.stringify(Object.assign({}, copy, { index: copy.index + 1 }))));         // its key, but not its pieces
    F.push(await B3.W._cashuIdCopy(JSON.stringify(Object.assign({}, copy, { locktime: copy.locktime + 1 }))));   // pieces not of that locktime
    F.push(await B3.W._cashuIdCopy(JSON.stringify(Object.assign({}, copy, { contact: cId.id }))));               // E not this seed's for that contact
    F.push(await B3.W._cashuIdCopy(JSON.stringify(Object.assign({}, copy, { type: 'foxy-cashu-id' }))));
    F.push(await B3.W._cashuIdCopy('{"v":1}'));
    F.push(await B3.W._cashuIdCopy('x'.repeat(70000)));
    // a real copy of somebody else's payment (D's seed), however well formed
    D.W._cashuIdLockS = 60;
    relay = [];
    await D.W.cashuIdPay(mine.text, 4);
    const dRow = D.store('foxy.cid.outbox', []).slice(-1)[0];
    D.W._cashuIdLockS = 0;
    const dRows = D.store('foxy.cid.outbox', []);
    dRows.forEach((r) => { if (r.id === dRow.id) r.copyAt = Date.now() - 1; });
    D.put('foxy.cid.outbox', dRows);
    relay = [];
    await D.W.cashuIdCopies();
    const dCopy = relay[0] && relay[0].body;
    ok(!!dCopy && JSON.parse(dCopy).type === 'foxy-cashu-id-copy', 'D’s own copy, to D’s recovery key');
    F.push(await B3.W._cashuIdCopy(dCopy));
    ok(F.every((x) => x === 'refused') && B3.W.cashuIdOutbox().length === 0, 'R5: forged copies (another key, index, locktime or contact, bad shape, another seed’s) are dropped', F.join(','));
    ok((await B3.W._cashuIdCopy(copyMsg.body)) === 'collected' && B3.W.cashuIdOutbox().length === 0, 'R4: and the real copy, once its money came back, is nothing to rebuild');
    ok((await A.W._cashuIdArrived(copyMsg.body)) === 'refused', 'R5: and a copy delivered to an ID’s delivery key is not a payment');
    ok(/words/i.test(docs) && /recovery key/i.test(docs), 'and CASHU-ID.md says how a restore finds them');
  }

  /* L10: words restored on a phone: it listens without MY CASHU ID being opened */
  {
    const R = page(THIRD_WORDS);
    await R.W.seedReady();
    ok(!R.storage.getItem('foxy.cid.shown'), 'a phone that never showed its ID');
    R.phone.hooks.enter = () => PHONE_WORDS;
    const candidate = await R.W.enterSeedNative();
    await R.W.adoptScan([], { candidate });
    ok(await until(() => !!R.storage.getItem('foxy.cid.shown') && R.said.open.length === 1, 3000), 'L10: restoring words marks the ID in use and the phone listens', String(R.said.open.length));
    ok(await until(() => R.said.copies.length === 1, 3000) && !!R.storage.getItem('foxy.cid.recover'), 'R3: and reads back its copies on the recovery key', String(R.said.copies.length));
  }

  /* ---- speed: the inbox open from the moment there is a route, opened once, and a payment said as arriving ----
   * A launch listened only once the whole of a connect's catch-up was over (ten to eighteen seconds after Tor was up on
   * two phones), a return listened twice (the wake's, then the catch-up's, deaf for two seconds between), and nothing was
   * said until the mint had swapped the payment (three to six seconds after it was read). */
  {
    const Q = page(PHONE_WORDS);
    await Q.W.connect(MINT, { remember: true });
    await Q.W.cashuIdShown();
    await wait(50);
    const o0 = Q.said.open.length;
    Q.W._privacy({ tor: 'connecting', progress: 40, everUp: true });
    Q.W._privacy({ tor: 'up', progress: 100, everUp: true });
    ok(await until(() => Q.said.open.length === o0 + 1, 2000), 'S1: Tor coming up opens the Cashu ID inbox at once, not after the next connect',
      String(Q.said.open.length - o0));
    await wait(50);
    const o1 = Q.said.open.length;
    await Q.W.connect(MINT, { remember: true });
    await wait(400);
    ok(Q.said.open.length === o1, 'S2: a connect a moment after a listen takes what was kept from the inbox that is open, and does not open it again',
      String(Q.said.open.length - o1));
    Q.W._cashuIdFreshMs = 1;
    await wait(20);
    await Q.W.connect(MINT, { remember: true });
    ok(await until(() => Q.said.open.length === o1 + 1, 2000), 'S2: one older than that is opened again by the catch-up, as before', String(Q.said.open.length - o1));
    Q.W._cashuIdFreshMs = 0;
    await wait(50);
    const o2 = Q.said.open.length;
    Q.W._resumed(40);
    ok(await until(() => Q.said.open.length === o2 + 1, 2000), 'S2: and a return from the background always opens it again (the phone closed it)',
      String(Q.said.open.length - o2));

    // read while the wallet is still the one built from storage: held, unsigned and unswapped, until the mint is connected for real
    await wait(50);
    await Q.W.connect(MINT, null, null, { fromCache: true });
    ok(Q.W.fromCache(), 'a wallet rebuilt from storage, with a route');
    relay = [];
    await B.W.cashuIdPay(mine.text, 30);
    const qBefore = await balance(Q);
    const signs0 = Q.said.sign;
    const minted0 = Q.said.asked.length;
    ok((await Q.W._cashuIdArrived(relay[0].body)) === 'held' && Q.said.sign === signs0 && Q.said.asked.length === minted0 && (await balance(Q)) === qBefore,
      'S3: a payment read before the real connect is held: nothing signed, nothing asked of the mint, nothing counted');
    ok(Q.store('foxy.cid.inbox', []).length === 0, 'S3: and nothing written down (the relays still hold it)');
    const order = [];
    Q.W._onCashuIdArriving = (v) => order.push({ said: 'arriving', v });
    Q.W._onCashuIdPaid = (v) => order.push({ said: 'paid', v });
    await Q.W.connect(MINT, { remember: true });
    ok(await until(async () => (await balance(Q)) === qBefore + 30, 3000), 'S3: and taken the moment the mint is connected for real', String((await balance(Q)) - qBefore));
    ok(order.length === 2 && order[0].said === 'arriving' && order[1].said === 'paid', 'S4: said as arriving before it is said as paid',
      JSON.stringify(order.map((x) => x.said)));
    ok(order[0] && order[0].v.amount === 30 && order[0].v.unit === 'sat' && typeof order[0].v.name === 'string',
      'S4: arriving says how much and in what unit', JSON.stringify(order[0] && order[0].v));
    // arriving is said only for one the phone has checked: a refused one says nothing
    order.length = 0;
    relay = [];
    await B.W.cashuIdPay(mine.text, 12);
    const bad = envelope(relay[0].body, { token: reToken(B, MINT, 'sat', proofsOf(B, JSON.parse(relay[0].body).token).map((p) => Object.assign({}, p, { dleq: Object.assign({}, p.dleq, { s: '11'.repeat(32) }) }))) });
    ok((await Q.W._cashuIdArrived(bad)) === 'refused' && order.length === 0, 'S4: one whose mint signature does not check out is never said as arriving');
    // the good one of that pair, taken once and said once
    order.length = 0;
    const qMid = await balance(Q);
    const good = relay[0].body;
    ok((await Q.W._cashuIdArrived(good)) === 'taken', 'the good one is taken');
    ok((await Q.W._cashuIdArrived(good)) === 'seen' && order.filter((x) => x.said === 'paid').length === 1 && (await balance(Q)) === qMid + 12,
      'S4: read again, it is neither said nor counted twice');
    // a payment from an earlier test build, whose envelope still names a chain index (`i`, the row's `wi`): taken all the same
    relay = [];
    await B.W.cashuIdPay(mine.text, 11);
    const qLegacy = await balance(Q);
    const legacy = envelope(relay[0].body, { i: 0, wi: 0 });
    ok((await Q.W._cashuIdArrived(legacy)) === 'taken' && (await balance(Q)) === qLegacy + 11,
      'a payment from an earlier build that still names a chain index is taken', JSON.stringify(JSON.parse(legacy).from ? 'proved' : 'unnamed'));
  }

  /* L6: the suites' switches do nothing on a page that is not a test's */
  {
    const P = page(PHONE_WORDS, { release: true });
    P.W._cashuIdLockS = 2;
    ok(P.W.cashuIdLockSeconds() === 30 * DAY && P.W._cashuIdBlind(V.id, V.e) === null && P.W._cashuIdEncode(V.id, V.nostr) === null,
      'L6: a page in the app ignores _cashuIdLockS and answers no test arithmetic');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
