'use strict';
/* cashu-id-any.js — ANY WALLET, and a payment paid to the ID key itself (build/wallet/08e-cashu-id.js, docs/CASHU-ID.md).
 *
 *     node tests/cashu-id-any.js
 *
 *   1  ANY WALLET: a standard NUT-18 request (creqA…) cashu-ts decodes: no amount, the unit asked, this phone's mints
 *      with the default first, single use, locked (nut10 P2PK) to a key of the seed's lock pool and never the ID, a
 *      Nostr transport to the delivery key's nprofile naming NostrDelivery's three relays; two openings, two keys
 *   2  paid by another wallet (a NUT-18 payload, no E, locked to that key): taken, "From another wallet", once; a
 *      second payment to the same key (a stale one) taken once too; a key no row names is found by the walk, five an
 *      hour; a key of somebody else's, a mint this phone does not use: refused
 *   3  paid to the ID key itself, unblinded: nothing signed, the card asked (`_onCashuIdUnblinded`) once; TAKE IT
 *      ANYWAY signs with the ID key for that delivery alone (`cashuIdSignUnblinded`) and takes it, "From someone,
 *      unblinded"; LEAVE IT drops it and it is not asked again; a blinded payment never asks; a mixed one is refused
 *
 * Pages on harness.js's fake mints; the phone's seed side is harness.js's second implementation. */
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS, cashuIdKeys, p2pkParent, p2pkAt } = H;

const MINT = 'https://m.test';
const PLAIN = 'https://plain.test';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const THIRD_WORDS = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 180000).unref();

const mints = {};
let relay = [];

function page(words) {
  const phone = nativePhone({ words });
  const said = { sign: 0, bare: 0, open: 0 };
  const reply = (w, id, t, e) => setTimeout(() => w.FoxyWallet._scanResult(id, t, e), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const url = String(m.url || '');
        const at = url.indexOf('plain.test') >= 0 ? mints.plain : mints.main;
        return reply(w, m.id, at.handle(m));
      }
      if (m.action === 'nostrSend') { relay.push({ target: m.target, body: m.body }); return reply(w, m.id, '3'); }
      if (m.action === 'cashuIdInboxOpen') { said.open += 1; return reply(w, m.id, '1'); }
      if (m.action === 'cashuIdCopiesOpen') return reply(w, m.id, '1');
      if (m.action === 'cashuIdInboxClose') return reply(w, m.id, 'ok');
      if (m.action === 'cashuIdSign') said.sign += 1;
      if (m.action === 'cashuIdSignUnblinded') said.bare += 1;
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!mints.main) mints.main = fakeMint(w, { p2pk: true });
      if (!mints.plain) mints.plain = fakeMint(w, { p2pk: true, fill: 11, quoteFrom: 70000 });
    },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
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
const seedOf = (ctx, words) => Buffer.from(ctx.window.FoxyBip39.mnemonicToSeedSync(words));
const balance = async (ctx) => Number(await ctx.W.balanceSats()) || 0;
const logRows = (ctx) => ctx.store('foxy.cashu.log', []) || [];
const lastIn = (ctx) => logRows(ctx).filter((e) => e.dir === 'in')[0] || {};
const payload = (id, mint, unit, proofs) => JSON.stringify({ id, memo: 'thanks', mint, unit, proofs });

/* NIP-19, read back: the key (TLV 0) and the relays (TLV 1) an nprofile names. */
function nprofileRead(text) {
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data = text.slice(text.lastIndexOf('1') + 1, -6).split('').map((c) => CHARSET.indexOf(c));
  let acc = 0, bits = 0;
  const bytes = [];
  for (const v of data) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); } }
  const out = { key: '', relays: [] };
  for (let i = 0; i + 2 <= bytes.length;) {
    const t = bytes[i], l = bytes[i + 1], v = bytes.slice(i + 2, i + 2 + l);
    if (t === 0) out.key = Buffer.from(v).toString('hex');
    if (t === 1) out.relays.push(Buffer.from(v).toString('utf8'));
    i += 2 + l;
  }
  return out;
}

async function run() {
  const A = page(PHONE_WORDS);     // the one with the ID
  const B = page(OTHER_WORDS);     // pays as another wallet would: locked ecash, no blinding
  const C = page(THIRD_WORDS);
  const CT = A.window.CashuTS;
  await A.W.connect(MINT, { remember: true });
  await B.W.connect(MINT, { remember: true });
  await C.W.connect(MINT, { remember: true });
  await B.W.claim((await B.W.invoice(3000, '')).hash);
  const mine = await A.W.cashuIdMine();
  const keysA = cashuIdKeys(seedOf(A, PHONE_WORDS));
  const parentA = p2pkParent(seedOf(A, PHONE_WORDS));
  let unblinded = [];
  A.W._onCashuIdUnblinded = (v) => unblinded.push(v);

  /* ---- 1 the request -------------------------------------------------------- */
  const r1 = await A.W.cashuIdAnyRequest({ unit: 'sat' });
  ok(/^creqA/.test(r1.text), 'ANY WALLET is a NUT-18 request, creqA…', r1.text.slice(0, 16));
  console.log('      example: ' + r1.text);
  const d1 = CT.decodePaymentRequest(r1.text);
  ok(d1.amount === undefined && d1.unit === 'sat' && d1.singleUse === true && d1.description === undefined,
    'no amount, the unit asked, single use, no description', JSON.stringify({ a: d1.amount, u: d1.unit, s: d1.singleUse }));
  ok(Array.isArray(d1.mints) && d1.mints[0] === MINT, 'this phone’s mints, the default first', JSON.stringify(d1.mints));
  ok(d1.id === r1.id && /^[0-9a-f]{8}$/.test(d1.id), 'an id of its own', d1.id);
  const n10 = d1.nut10 || {};
  ok(n10.kind === 'P2PK' && n10.data === r1.pub && /^0[23][0-9a-f]{64}$/.test(n10.data), 'locked (nut10 P2PK) to one key', JSON.stringify(n10));
  ok(n10.data !== mine.id && n10.data.slice(2) !== mine.id.slice(2), 'never the ID key itself');
  const rows = A.store('foxy.req.lockkeys', {});
  const row = rows['cid-any-' + r1.id];
  ok(!!row && row.pub === r1.pub && Number.isInteger(row.i), 'filed as a seed-derived lock key (cid-any-<id>)', JSON.stringify(row));
  ok(!!row && p2pkAt(parentA, row.i).pub === r1.pub, 'the key the words give at that index of the lock path: the walk finds it after a restore');
  const tr = (d1.transport || [])[0] || {};
  ok(d1.transport.length === 1 && tr.type === 'nostr' && /^nprofile1/.test(tr.target) && JSON.stringify(tr.tags) === JSON.stringify([['n', '17']]),
    'one transport: Nostr, NIP-17', JSON.stringify(d1.transport).slice(0, 120));
  const np = nprofileRead(tr.target);
  ok(np.key === mine.nostr, 'to the ID’s delivery key', np.key);
  const swift = fs.readFileSync(path.join(__dirname, '..', 'Foxy', 'Nostr', 'NostrDelivery.swift'), 'utf8');
  const fallback = (/static let fallbackRelays = \[([^\]]*)\]/.exec(swift) || [])[1] || '';
  const relaysSwift = (fallback.match(/"(wss:[^"]+)"/g) || []).map((x) => x.slice(1, -1));
  ok(relaysSwift.length === 3 && JSON.stringify(np.relays) === JSON.stringify(relaysSwift),
    'naming the three relays the ID’s inbox listens on (NostrDelivery.fallbackRelays)', JSON.stringify(np.relays));
  ok(A.said.open >= 1, 'and the phone listens on the delivery key from then on');
  const r2 = await A.W.cashuIdAnyRequest({ unit: 'sat' });
  ok(r2.pub !== r1.pub && r2.id !== r1.id && CT.decodePaymentRequest(r2.text).nut10.data === r2.pub, 'a second opening: a new key', r2.pub.slice(0, 12));
  let usdNo = '';
  try { await A.W.cashuIdAnyRequest({ unit: 'eur' }); } catch (e) { usdNo = e.message; }
  ok(usdNo === 'Foxy asks only in sats or dollars.', 'a unit Foxy does not ask in is refused', usdNo);

  /* ---- 2 paid by another wallet ------------------------------------------------ */
  const before = await balance(A);
  const pay1 = await B.W.sendToken(21, { unit: 'sat', lockTo: r1.pub });
  const p1 = proofsOf(B, pay1.token);
  ok(p1.every((p) => lockOf(p) === r1.pub && !p.p2pk_e), 'the payer locks to the request’s key as it is, no E');
  const body1 = payload(r1.id, MINT, 'sat', p1);
  const signs0 = A.said.sign;
  ok((await A.W._cashuIdArrived(body1)) === 'taken', 'the payment, arriving on the ID’s inbox, is taken');
  ok((await balance(A)) === before + 21, 'and the balance is 21 more', String(await balance(A)));
  ok(lastIn(A).memo === 'From another wallet', 'history: From another wallet', JSON.stringify(lastIn(A)));
  ok(A.said.sign === signs0 && A.said.bare === 0, 'the ID key signed nothing for it');
  ok((await A.W._cashuIdArrived(body1)) === 'seen' && (await balance(A)) === before + 21, 'the same delivery again: nothing more');
  // a stale key: a second payer pays the code that was paid already
  const pay2 = await B.W.sendToken(13, { unit: 'sat', lockTo: r1.pub });
  const body2 = payload(r1.id, MINT, 'sat', proofsOf(B, pay2.token));
  ok((await A.W._cashuIdArrived(body2)) === 'taken' && (await balance(A)) === before + 34, 'a payment to a key already used is still taken');
  ok((await A.W._cashuIdArrived(body2)) === 'seen' && (await balance(A)) === before + 34, 'once');
  ok(!!A.store('foxy.req.lockkeys', {})['cid-any-' + r1.id] && (A.store('foxy.cid.walks', []) || []).length === 0,
    'its row stays once paid, so a second payer’s payment is found by it and not by a walk of the seed');
  // the row gone (a restore from the words): the walk finds the key
  const rr = A.store('foxy.req.lockkeys', {});
  delete rr['cid-any-' + r2.id];
  A.put('foxy.req.lockkeys', rr);
  const pay3 = await B.W.sendToken(8, { unit: 'sat', lockTo: r2.pub });
  ok((await A.W._cashuIdArrived(payload(r2.id, MINT, 'sat', proofsOf(B, pay3.token)))) === 'taken' && (await balance(A)) === before + 42,
    'with no row naming its key (the words restored), the walk of the seed finds it');
  ok((A.store('foxy.cid.walks', []) || []).length === 1, 'one walk counted against the hour', JSON.stringify(A.store('foxy.cid.walks', null)));
  // somebody else's key
  const cReq = await C.W.cashuIdAnyRequest({ unit: 'sat' });
  const pay4 = await B.W.sendToken(5, { unit: 'sat', lockTo: cReq.pub });
  ok((await A.W._cashuIdArrived(payload(cReq.id, MINT, 'sat', proofsOf(B, pay4.token)))) === 'refused' && (await balance(A)) === before + 42,
    'ecash locked to another phone’s key is refused');
  ok((await C.W._cashuIdArrived(payload(cReq.id, MINT, 'sat', proofsOf(B, pay4.token)))) === 'taken', 'and taken by that phone');
  // five walks an hour
  A.put('foxy.cid.walks', [Date.now(), Date.now(), Date.now(), Date.now(), Date.now()]);
  const walksBefore = A.phone.said.filter((x) => /pubkeys/.test(x.text)).length;
  const pay5 = await B.W.sendToken(5, { unit: 'sat', lockTo: '02' + 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5' });
  ok((await A.W._cashuIdArrived(payload('x', MINT, 'sat', proofsOf(B, pay5.token)))) === 'refused'
    && A.phone.said.filter((x) => /pubkeys/.test(x.text)).length === walksBefore, 'after five walks in the hour a key no row names is refused without one');
  A.put('foxy.cid.walks', []);
  // a mint this phone does not use
  const Pp = page(OTHER_WORDS);
  await Pp.W.connect(PLAIN, { remember: true });
  await Pp.W.claim((await Pp.W.invoice(200, '')).hash);
  const r3 = await A.W.cashuIdAnyRequest({ unit: 'sat' });
  const pay6 = await Pp.W.sendToken(9, { unit: 'sat', lockTo: r3.pub });
  ok((await A.W._cashuIdArrived(payload(r3.id, PLAIN, 'sat', proofsOf(Pp, pay6.token)))) === 'refused', 'paid at a mint this phone does not use: refused (the request names only its own)');

  /* ---- 3 paid to the ID key itself, unblinded ------------------------------------ */
  const b0 = await balance(A);
  const bare = await B.W.sendToken(15, { unit: 'sat', lockTo: mine.id });
  const bp = proofsOf(B, bare.token);
  ok(bp.every((p) => lockOf(p) === mine.id && !p.p2pk_e), 'a payer locks to the ID key as it is');
  const env1 = JSON.stringify({ v: 2, type: 'foxy-cashu-id', token: bare.token });
  unblinded = [];
  const sign1 = A.said.sign;
  ok((await A.W._cashuIdArrived(env1)) === 'unblinded', 'delivered to the ID: not taken, its receiver asked');
  ok(unblinded.length === 1 && unblinded[0].amount === 15 && unblinded[0].name === '' && unblinded[0].mint === MINT,
    'the card is raised once, for 15 sats from somebody unnamed', JSON.stringify(unblinded));
  ok(A.said.sign === sign1 && A.said.bare === 0 && (await balance(A)) === b0, 'and nothing is signed, by any key');
  ok((await A.W._cashuIdArrived(env1)) === 'unblinded' && unblinded.length === 1, 'read again from another relay: asked no second time');
  const took = await A.W.cashuIdUnblinded(unblinded[0].key, true);
  ok(took.state === 'taken' && (await balance(A)) === b0 + 15, 'TAKE IT ANYWAY: taken', JSON.stringify(took));
  ok(A.said.bare === 1 && A.phone.cashuIdSignedBare === bp.length, 'the ID key itself signed, by its own action, for this delivery’s pieces alone', String(A.phone.cashuIdSignedBare));
  ok(lastIn(A).memo === 'From someone, unblinded', 'history: From someone, unblinded', lastIn(A).memo);
  ok((await A.W._cashuIdArrived(env1)) === 'seen', 'and read again: seen');
  // the NUT-18 shape, left
  const bare2 = await B.W.sendToken(12, { unit: 'sat', lockTo: mine.id });
  const body3 = payload('', MINT, 'sat', proofsOf(B, bare2.token));
  unblinded = [];
  ok((await A.W._cashuIdArrived(body3)) === 'unblinded' && unblinded.length === 1, 'a NUT-18 payload locked to the ID key: asked too');
  const left = await A.W.cashuIdUnblinded(unblinded[0].key, false);
  ok(left.state === 'left' && (await balance(A)) === b0 + 15 && A.said.bare === 1, 'LEAVE IT: nothing taken, nothing signed', JSON.stringify(left));
  ok((await A.W._cashuIdArrived(body3)) === 'left' && unblinded.length === 1, 'and read again: left, not asked again');
  ok((await A.W.cashuIdUnblinded(unblinded[0].key, true)).state === 'gone' && A.said.bare === 1, 'a TAKE IT ANYWAY after LEAVE IT finds nothing');
  // the other parity of the ID's x: still the ID key
  const other = (mine.id.startsWith('02') ? '03' : '02') + mine.id.slice(2);
  const bare3 = await B.W.sendToken(4, { unit: 'sat', lockTo: other });
  unblinded = [];
  ok((await A.W._cashuIdArrived(payload('', MINT, 'sat', proofsOf(B, bare3.token)))) === 'unblinded' && unblinded.length === 1, 'the ID’s x with the other parity: asked as well');
  ok((await A.W.cashuIdUnblinded(unblinded[0].key, true)).state === 'taken' && (await balance(A)) === b0 + 19, 'and taken on TAKE IT ANYWAY');
  // a blinded payment never asks
  await B.W.cashuIdAdd(mine.text, 'Alice');
  relay = [];
  await B.W.cashuIdPay(mine.text, 10);
  unblinded = [];
  ok((await A.W._cashuIdArrived(relay[0].body)) === 'taken' && unblinded.length === 0 && A.said.bare === 2, 'a blinded payment is taken with no card and no ID-key signature');
  // mixed: one piece bare, the others blinded
  const bare4 = await B.W.sendToken(3, { unit: 'sat', lockTo: mine.id });
  relay = [];
  await B.W.cashuIdPay(mine.text, 6);
  const blinded = proofsOf(B, JSON.parse(relay[0].body).token);
  const mixed = payload('', MINT, 'sat', blinded.concat(proofsOf(B, bare4.token)));
  ok((await A.W._cashuIdArrived(mixed)) === 'refused' && unblinded.length === 0, 'one piece to the ID key among blinded ones: refused, nobody asked');
  // the phone itself refuses a blinded key on the unblinded action
  const asked = A.phone.answer(A.window, { action: 'cashuIdSignUnblinded', id: 'x', secrets: [blinded[0].secret] });
  const ans = await Promise.resolve(asked);
  ok(!ans[0] && /not locked to this Cashu ID/.test(String(ans[1])), 'the phone’s unblinded action signs nothing locked to a blinded key', JSON.stringify(ans));
  void keysA;
}

run().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}, (e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
