'use strict';
/* cashu-msg.js — messages between Cashu IDs, the wallet's half (build/wallet/08f-cashu-msg.js).
 *
 *     node tests/cashu-msg.js
 *
 * Two phones that hold each other's ID work out one secret, natively,
 * SHA-256("foxy-msg-pair-v1" ‖ x(d_mine·ID_peer)), and from it a chain of keys
 * each way: message i goes to the x-only half of
 * k_i = SHA-256("foxy-msg-recv-v1" ‖ secret ‖ dir ‖ i), its seal signed by s_i
 * ("foxy-msg-seal-v1"). The page never holds either; it keeps the counters and
 * the messages. Here the phone's half (cashuIdMsgSend, cashuIdMsgOpen) is
 * harness.js's BigInt arithmetic, and the relays are a list in this file that
 * hands each wrap to whichever page listens on its key, only when its seal is
 * the key's s_i, as native does.
 *
 *   1  the vectors (tests/fixtures/cashu-msg-vectors.json): harness.js, and the page bundle's noble curve, agree; both
 *      sides work out the same secret; FoxyTests/CashuMsgTests.swift holds libsecp256k1 to the same file
 *   2  a first message to a contact goes once to the delivery key, proved and padded, with "ratchet from now"; after a
 *      relay took it, the ratchet; the reply comes back by the ratchet; both directions
 *   3  the window: the next eight indices not had, moved on as messages come, out of order too
 *   4  dedupe: the same wrap from four relays, a first message read again on the next listen
 *   5  padding buckets 512 / 1,024 / 2,048 and the 1,000-character limit
 *   6  the outbox: kept until a relay takes it, tried again, at once when the route comes back
 *   7  the caps: 200 a contact, a megabyte in all, ten people who are not contacts
 *   8  someone who is not a contact, a forged first message, no ID in use
 *   9  a contact restored from the words resumes: its own and the other's messages read back from the chains, its first
 *      message says where it stands, and the side with the stored state goes on from it
 *  10  `next` says the other side is a window behind: the next message goes by the delivery key again
 *  11  the last indices, a first message read again, the budget of people who are not contacts, eight unanswered, a
 *      restored phone's "where I stand", control characters, a far-past `at`, a store full as a relay takes one */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const H = require('./harness');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS, cashuIdKeys, cashuIdTag, cashuMsgPair, cashuMsgDir, cashuMsgKey, xOnlyOf } = H;

const MINT = 'https://m.test';
const B_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const C_WORDS = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const D_WORDS = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 5000); while (Date.now() < end) { if (await fn()) return true; await wait(20); } return false; };
const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'cashu-msg-vectors.json'), 'utf8'));
const seedOf = (words) => crypto.pbkdf2Sync(Buffer.from(words, 'utf8'), Buffer.from('mnemonic', 'utf8'), 2048, 64, 'sha512');
const hex64 = (k) => k.toString(16).padStart(64, '0');

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 420000).unref();

/* ---- the relays, and the phone's half ------------------------------------------------------------------------- */
const relay = [];           // { id, p, seal (x-only or ''), body, first }
let relayDown = false;
const pages = [];           // every page, for the delivery keys and the listening

function deliver(ctx, w) {
  // the phone's inbox on the window: each wrap once per open, only when sealed by the key's s_i
  if (!ctx.listening) return;
  const hit = ctx.listening.get(w.p);
  if (!hit || ctx.handed.has(w.id)) return;
  ctx.handed.add(w.id);
  if (w.seal !== hit.seal) { ctx.dropped += 1; return; }
  ctx.arrivals.push(ctx.W._cashuMsgArrived(hit.peer, hit.way, hit.i, w.body));
}

function publish(w) {
  relay.push(w);
  for (const ctx of pages) {
    if (w.first && ctx.mine && ctx.mine.nostr === w.p && ctx.inboxOn) ctx.arrivals.push(ctx.W._cashuIdArrived(w.body));
    else deliver(ctx, w);
  }
}

function page(words, opts) {
  const o = opts || {};
  const phone = nativePhone({ words });
  const keys = cashuIdKeys(seedOf(words));
  const said = { opens: [], sends: [], nostr: [] };
  const reply = (w, id, t, e) => setTimeout(() => w.FoxyWallet._scanResult(id, t, e), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
      if (m.action === 'nostrSend') {
        said.nostr.push(m);
        if (relayDown) return reply(w, m.id, null, 'no relay answered');
        const to = pages.find((c) => c.mine && w.FoxyWallet._cashuIdNprofile(c.mine.nostr) === m.target);
        publish({ id: crypto.randomBytes(8).toString('hex'), p: to ? to.mine.nostr : 'nobody', seal: '', body: m.body, first: true });
        return reply(w, m.id, '3');
      }
      if (m.action === 'cashuIdMsgSend') {
        said.sends.push(m);
        if (relayDown) return reply(w, m.id, null, 'No relay took the message: no answer in time');
        const pair = cashuMsgPair(keys.d, m.peer);
        const dir = cashuMsgDir(keys.id, m.peer);
        const wrap = { id: crypto.randomBytes(8).toString('hex'), p: xOnlyOf(cashuMsgKey('recv', pair, dir, m.i)),
          seal: xOnlyOf(cashuMsgKey('seal', pair, dir, m.i)), body: m.body, first: false };
        publish(wrap);
        return reply(w, m.id, '4');
      }
      if (m.action === 'cashuIdMsgOpen') {
        said.opens.push(JSON.parse(JSON.stringify(m)));
        const map = new Map();
        for (const e of m.peers) {
          const pair = cashuMsgPair(keys.d, e.peer);
          const out = cashuMsgDir(keys.id, e.peer);
          for (const [way, list, dir] of [['in', e.in || [], 1 - out], ['out', e.out || [], out]]) {
            for (const i of list) {
              map.set(xOnlyOf(cashuMsgKey('recv', pair, dir, i)), { peer: e.peer, way, i, seal: xOnlyOf(cashuMsgKey('seal', pair, dir, i)) });
            }
          }
        }
        ctx.listening = map;
        ctx.handed = new Set();
        reply(w, m.id, '1');
        setTimeout(() => { for (const x of relay.slice()) if (!x.first) deliver(ctx, x); }, 5);
        return;
      }
      if (m.action === 'cashuIdInboxOpen') {
        ctx.inboxOn = true;
        reply(w, m.id, '1');
        // the delivery key's wraps from the last thirty-two days, read again on every listen
        setTimeout(() => { for (const x of relay.slice()) if (x.first && ctx.mine && x.p === ctx.mine.nostr) ctx.arrivals.push(ctx.W._cashuIdArrived(x.body)); }, 5);
        return;
      }
      if (m.action === 'cashuIdCopiesOpen' || m.action === 'cashuIdInboxClose') return reply(w, m.id, '1');
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!mint) mint = fakeMint(w, { p2pk: true });
    },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._cashuIdRetryMs = 40;
  ctx.W._cashuMsgDelayMs = o.delay === undefined ? 0 : o.delay;
  ctx.W._cashuMsgRetryMs = 40;
  ctx.W._cashuMsgReopenMs = 20;
  ctx.said = said;
  ctx.keys = keys;
  ctx.arrivals = [];
  ctx.dropped = 0;
  ctx.handed = new Set();
  ctx.store = (k, d) => { try { const v = JSON.parse(ctx.storage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  ctx.thread = (peer) => ((ctx.store('foxy.msg.threads', {}).threads || {})[peer]) || null;
  pages.push(ctx);
  return ctx;
}
let mint = null;

const settle = async (...ctxs) => { for (let k = 0; k < 6; k++) { await wait(40); for (const c of ctxs) await Promise.all(c.arrivals.splice(0)); } };
const bucketOf = (body) => Buffer.byteLength(body, 'utf8');

/* A body as another Foxy pads it, for the cases a test writes by hand. */
function padded(j, size) {
  const o = Object.assign({}, j, { pad: '' });
  const n = Buffer.byteLength(JSON.stringify(o), 'utf8');
  const b = size || [512, 1024, 2048].find((x) => x >= n);
  o.pad = 'x'.repeat(b - n);
  return JSON.stringify(o);
}
const msgId = () => crypto.randomBytes(16).toString('hex');

async function run() {
  /* ---- 1. the vectors ------------------------------------------------------------------------------------------- */
  const A = page(PHONE_WORDS);
  const B = page(B_WORDS);
  const CT = A.window.CashuTS;
  const kA = A.keys, kB = B.keys;
  ok(kA.id === VEC.a.id && kB.id === VEC.b.id, 'the vectors’ two IDs are the two phones’');
  ok(cashuMsgPair(kA.d, kB.id) === VEC.pair && cashuMsgPair(kB.d, kA.id) === VEC.pair, 'harness.js: both sides work out the same pair secret');
  ok(cashuMsgDir(kA.id, kB.id) === VEC.dirAtoB && cashuMsgDir(kB.id, kA.id) === VEC.dirBtoA && VEC.dirAtoB + VEC.dirBtoA === 1,
    'the direction: 0 from the lower ID key to the higher');
  const nobleX = (pointHex, d) => Buffer.from(CT.pointFromHex(pointHex).multiply(d).toBytes(true)).subarray(1);
  const noblePair = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('foxy-msg-pair-v1'), nobleX(kB.id, kA.d)])).digest('hex');
  const noblePair2 = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('foxy-msg-pair-v1'), nobleX(kA.id, kB.d)])).digest('hex');
  ok(noblePair === VEC.pair && noblePair2 === VEC.pair, 'and the page bundle’s noble curve, from either side', noblePair);
  let allKeys = true, allNoble = true;
  for (const [list, dir, kind] of [[VEC.recvAtoB, VEC.dirAtoB, 'recv'], [VEC.recvBtoA, VEC.dirBtoA, 'recv'], [VEC.sealAtoB, VEC.dirAtoB, 'seal'], [VEC.sealBtoA, VEC.dirBtoA, 'seal']]) {
    for (const k of list) {
      const key = cashuMsgKey(kind, VEC.pair, dir, k.i);
      if (hex64(key) !== k.key || xOnlyOf(key) !== k.xonly) allKeys = false;
      const pub = Buffer.from(CT.getPubKeyFromPrivKey(new A.window.Uint8Array(Buffer.from(k.key, 'hex')))).toString('hex');
      if (pub.slice(2) !== k.xonly) allNoble = false;
    }
  }
  ok(allKeys, 'harness.js: every message key and seal key of the vectors, both ways, to index 2^32 − 1');
  ok(allNoble, 'noble’s public half of each is the vectors’ x-only key');
  ok(new Set([...VEC.recvAtoB, ...VEC.recvBtoA, ...VEC.sealAtoB, ...VEC.sealBtoA].map((k) => k.xonly)).size === 11, 'no key repeats across indices, directions, or the seal');

  await A.W.connect(MINT, { remember: true });
  await B.W.connect(MINT, { remember: true });
  A.mine = await A.W.cashuIdMine();
  B.mine = await B.W.cashuIdMine();

  /* ---- 8a. no ID in use: nothing ---------------------------------------------------------------------------------- */
  await A.W.cashuIdAdd(B.mine.text, 'Bob');
  await B.W.cashuIdAdd(A.mine.text, 'Alice');
  let off = '';
  try { await A.W.cashuMsgSend(kB.id, 'hello'); } catch (e) { off = e.message; }
  ok(off === 'Open MY CASHU ID first: messages go from your own Cashu ID.', 'with no ID in use, nothing can be written', off);
  ok(A.W.cashuMsgOn() === false && A.W.cashuMsgThreads().length === 0 && A.W.cashuMsgThread(kB.id) === null, 'and nothing is shown');
  ok((await A.W.cashuMsgListen()) === 0 && A.said.opens.length === 0, 'and nothing is listened for');

  await A.W.cashuIdShown();
  await B.W.cashuIdShown();
  await settle(A, B);
  ok(A.W.cashuMsgOn() && B.W.cashuMsgOn(), 'MY CASHU ID shown: messages on');
  const open0 = A.said.opens[A.said.opens.length - 1];
  ok(!!open0 && open0.peers.length === 1 && open0.peers[0].peer === kB.id && JSON.stringify(open0.peers[0].in) === '[0,1,2,3,4,5,6,7]',
    'the phone listens on the contact’s next eight keys, 0 to 7', JSON.stringify(open0 && open0.peers));
  ok(JSON.stringify(open0.peers[0].out) === '[0,1,2,3,4,5,6,7]', 'and, while the contact may not know this phone’s place, on its own next eight too');
  ok(typeof open0.since === 'number' && Math.floor(Date.now() / 1000) - open0.since > 31 * 86400, 'from about thirty-two days back');

  /* ---- 2. the first message, then the ratchet ---------------------------------------------------------------------- */
  const s1 = await A.W.cashuMsgSend(kB.id, 'Hello Bob');
  ok(s1.first === true && s1.i === 0, 'A’s first message to B goes by the delivery key, index 0', JSON.stringify(s1));
  ok(A.W.cashuMsgThread(kB.id).msgs[0].mark === 'sending\u2026', 'kept at once, marked sending…');
  await until(() => A.said.nostr.length === 1 && !(A.store('foxy.msg.outbox', []).length));
  await settle(A, B);
  const first = JSON.parse(A.said.nostr[0].body);
  ok(A.said.nostr[0].target === A.W._cashuIdNprofile(kB.nostr), 'to B’s delivery key (its nprofile)');
  ok(first.v === 1 && first.type === 'foxy-msg' && first.text === 'Hello Bob' && first.i === 0 && first.next === 0 && /^[0-9a-f]{32}$/.test(first.id),
    'the message: {v:1, type:foxy-msg, id, text, at, i, next, pad}', JSON.stringify(Object.keys(first)));
  ok(first.from === kA.id && first.tag === cashuIdTag(kA.d, kB.id, first.E) && first.card === A.mine.text, 'proved: from, its tag over a fresh E, and A’s ID string');
  ok(bucketOf(A.said.nostr[0].body) === 1024, 'padded to 1,024 bytes (its proof and ID string take half of it)', String(bucketOf(A.said.nostr[0].body)));
  ok(A.W.cashuMsgThread(kB.id).msgs[0].mark === 'sent', 'a relay took it: sent');
  ok(A.thread(kB.id).known === true && A.thread(kB.id).out === 1, 'A’s chain to B is known from now, its next index 1');
  const bt = B.thread(kA.id);
  ok(!!bt && bt.base === 1 && bt.unread === 1 && bt.msgs[0].text === 'Hello Bob', 'B kept it, unread, and listens for A from index 1 ("ratchet from now")', JSON.stringify(bt && { base: bt.base, unread: bt.unread }));
  ok(B.W.cashuMsgThreads().find((t) => t.peer === kA.id).unread === 1, 'the contacts list counts it unread');
  B.W.cashuMsgSeen(kA.id);
  ok(B.W.cashuMsgThreads().find((t) => t.peer === kA.id).unread === 0, 'read: 0');
  await until(() => { const o = B.said.opens[B.said.opens.length - 1]; return o && o.peers[0].in[0] === 1; });
  ok(JSON.stringify(B.said.opens[B.said.opens.length - 1].peers[0].in) === '[1,2,3,4,5,6,7,8]', 'B’s window moved on: 1 to 8');

  const r1 = await B.W.cashuMsgSend(kA.id, 'Hi Alice');
  ok(r1.first === false && r1.i === 0, 'B’s reply goes by the ratchet (B has heard from A): index 0 of B→A', JSON.stringify(r1));
  await until(() => B.said.sends.length === 1);
  await settle(A, B);
  const sentWrap = relay[relay.length - 1];
  ok(sentWrap.p === xOnlyOf(cashuMsgKey('recv', VEC.pair, VEC.dirBtoA, 0)) && sentWrap.p !== kA.nostr, 'to k_0 of B→A, not to A’s delivery key');
  ok(bucketOf(B.said.sends[0].body) === 512 && JSON.parse(B.said.sends[0].body).from === undefined, 'padded, and naming nobody: the seal says who');
  ok(A.W.cashuMsgThread(kB.id).msgs.map((m) => m.text).join('|') === 'Hello Bob|Hi Alice', 'A has it, after its own', A.W.cashuMsgThread(kB.id).msgs.map((m) => m.text).join('|'));
  ok(A.thread(kB.id).base === 1, 'A listens for B from index 1 now');

  for (const t of ['two', 'three']) await A.W.cashuMsgSend(kB.id, t);
  await until(() => A.said.sends.length === 2);
  await settle(A, B);
  ok(A.said.sends.map((m) => m.i).join() === '1,2', 'A’s next two by the ratchet, indices 1 and 2');
  ok(B.W.cashuMsgThread(kA.id).msgs.map((m) => m.text).join('|') === 'Hello Bob|Hi Alice|two|three', 'B has them, in order');
  ok(B.thread(kA.id).base === 3, 'B’s window for A starts at 3');
  const keysSeen = relay.filter((w) => !w.first).map((w) => w.p);
  ok(new Set(keysSeen).size === keysSeen.length && keysSeen.indexOf(kA.nostr) < 0 && keysSeen.indexOf(kB.nostr) < 0, 'every ratchet wrap went to a key no other wrap went to');

  /* ---- 4. dedupe ---------------------------------------------------------------------------------------------------- */
  const before = B.thread(kA.id).msgs.length;
  const again = relay.filter((w) => !w.first && w.p === xOnlyOf(cashuMsgKey('recv', VEC.pair, VEC.dirAtoB, 2)))[0];
  ok((await B.W._cashuMsgArrived(kA.id, 'in', 2, again.body)) === 'seen', 'the same wrap from another relay: seen');
  ok((await B.W._cashuIdArrived(A.said.nostr[0].body)) === 'seen', 'the first message read again on the next listen: seen, and the window stays', String(B.thread(kA.id).base));
  ok(B.thread(kA.id).msgs.length === before && B.thread(kA.id).base === 3, 'nothing written twice');
  // a wrap to a key of the window sealed by somebody else: the phone drops it before the page
  const dropped = B.dropped;
  publish({ id: 'forged1', p: xOnlyOf(cashuMsgKey('recv', VEC.pair, VEC.dirAtoB, 3)), seal: xOnlyOf(5n), body: padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'forged', at: Date.now(), i: 3 }) });
  await settle(B);
  ok(B.dropped === dropped + 1 && B.thread(kA.id).base === 3, 'a wrap to a window key not sealed by its s_i never reaches the page');

  /* ---- 3. the window, out of order ---------------------------------------------------------------------------------- */
  const sealedAs = (from, toId, i, j) => {
    const pair = cashuMsgPair(from.keys.d, toId);
    const dir = cashuMsgDir(from.keys.id, toId);
    publish({ id: crypto.randomBytes(8).toString('hex'), p: xOnlyOf(cashuMsgKey('recv', pair, dir, i)), seal: xOnlyOf(cashuMsgKey('seal', pair, dir, i)),
      body: padded(Object.assign({ v: 1, type: 'foxy-msg', id: msgId(), at: Date.now(), i: i, next: 1 }, j)), first: false });
  };
  sealedAs(A, kB.id, 4, { text: 'five first' });
  await settle(B);
  ok(B.W.cashuMsgThread(kA.id).msgs.slice(-1)[0].text === 'five first', 'index 4 before 3: kept');
  ok(B.thread(kA.id).base === 3 && JSON.stringify(B.thread(kA.id).got) === '[4]', 'the window still starts at 3, with 4 had');
  await until(() => { const o = B.said.opens[B.said.opens.length - 1]; return o && JSON.stringify(o.peers[0].in) === '[3,5,6,7,8,9,10,11]'; });
  ok(JSON.stringify(B.said.opens[B.said.opens.length - 1].peers[0].in) === '[3,5,6,7,8,9,10,11]', 'the next eight not had: 3, then 5 to 11');
  sealedAs(A, kB.id, 3, { text: 'four late' });
  await settle(B);
  ok(B.W.cashuMsgThread(kA.id).msgs.slice(-1)[0].text === 'four late', 'then 3');
  ok(B.thread(kA.id).base === 5 && B.thread(kA.id).got.length === 0, 'and the window moves past both: 5');
  ok((await B.W._cashuMsgArrived(kA.id, 'in', 3, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'old', at: Date.now(), i: 3 }))) === 'seen', 'an index below the window: seen');
  ok((await B.W._cashuMsgArrived(kA.id, 'in', 6, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'bad', at: Date.now(), i: 7 }))) === 'refused', 'a body whose index is not the key’s: refused');
  ok((await B.W._cashuMsgArrived(kA.id, 'in', 6, JSON.stringify({ v: 1, type: 'foxy-msg', id: msgId(), text: 'short', at: Date.now(), i: 6 }))) === 'refused', 'a body not padded to a bucket: refused');
  // A's own counter catches up for the rest of the run: two hand-written ones used 3 and 4
  A.storage.setItem('foxy.msg.threads', JSON.stringify(Object.assign(A.store('foxy.msg.threads', {}), {})));
  const at = A.store('foxy.msg.threads', {}); at.threads[kB.id].out = 5; A.storage.setItem('foxy.msg.threads', JSON.stringify(at));

  /* ---- 5. padding and the limit ------------------------------------------------------------------------------------- */
  const sizes = [];
  for (const t of ['x'.repeat(300), 'y'.repeat(700), 'é'.repeat(950)]) {
    await A.W.cashuMsgSend(kB.id, t);
    await until(() => A.said.sends.length === 2 + sizes.length + 1);
    sizes.push(bucketOf(A.said.sends[A.said.sends.length - 1].body));
  }
  ok(sizes.join() === '512,1024,2048', 'padded to the bucket that holds it: 512, 1,024, 2,048', sizes.join());
  let long = '', wide = '', none = '';
  try { await A.W.cashuMsgSend(kB.id, 'z'.repeat(1001)); } catch (e) { long = e.message; }
  try { await A.W.cashuMsgSend(kB.id, '漢'.repeat(990)); } catch (e) { wide = e.message; }
  try { await A.W.cashuMsgSend(kB.id, '   '); } catch (e) { none = e.message; }
  ok(/at most 1000 characters/.test(long), '1,001 characters: refused', long);
  ok(/too long/.test(wide), 'a thousand characters that do not fit 2,048 bytes: refused', wide);
  ok(none === 'Type a message first.', 'nothing: refused', none);
  ok(A.said.sends.every((m) => [512, 1024, 2048].indexOf(bucketOf(m.body)) >= 0) && A.said.nostr.every((m) => [512, 1024, 2048].indexOf(bucketOf(m.body)) >= 0),
    'every message A sent was one of three sizes');
  await settle(A, B);
  ok(B.W.cashuMsgThread(kA.id).msgs.slice(-3).map((m) => m.text.length).join() === '300,700,950', 'and B read them, the padding gone');

  /* ---- 6. the outbox ------------------------------------------------------------------------------------------------ */
  relayDown = true;
  const nSends = A.said.sends.length;
  await A.W.cashuMsgSend(kB.id, 'while no relay answers');
  await until(() => A.said.sends.length >= nSends + 2, 3000);
  const row = A.store('foxy.msg.outbox', [])[0];
  ok(!!row && row.tries >= 1 && A.W.cashuMsgThread(kB.id).msgs.slice(-1)[0].mark === 'sending\u2026', 'no relay took it: kept in the outbox, tried again, still marked sending…', JSON.stringify(row && { tries: row.tries }));
  relayDown = false;
  await until(() => A.store('foxy.msg.outbox', []).length === 0, 3000);
  await settle(A, B);
  ok(A.W.cashuMsgThread(kB.id).msgs.slice(-1)[0].mark === 'sent', 'a relay took it on a later try: sent');
  ok(B.W.cashuMsgThread(kA.id).msgs.slice(-1)[0].text === 'while no relay answers', 'and B has it once', String(B.W.cashuMsgThread(kA.id).msgs.filter((m) => m.text === 'while no relay answers').length));
  ok(B.W.cashuMsgThread(kA.id).msgs.filter((m) => m.text === 'while no relay answers').length === 1, 'once');
  // the random wait: a message does not go before it
  const slow = page(C_WORDS, { delay: 400 });
  await slow.W.connect(MINT, { remember: true });
  slow.mine = await slow.W.cashuIdMine();
  await slow.W.cashuIdShown();
  await slow.W.cashuIdAdd(A.mine.text, 'Alice');
  const t0 = Date.now();
  await slow.W.cashuMsgSend(kA.id, 'after a wait');
  await wait(150);
  const early = slow.said.nostr.length;
  await until(() => slow.said.nostr.length === 1, 3000);
  ok(early === 0 && Date.now() - t0 >= 380, 'a message waits its random delay before it goes (0 to 20 s; 400 ms here)');
  const delays = [];
  const D0 = page(D_WORDS, { delay: undefined });
  D0.W._cashuMsgDelayMs = undefined;
  ok(D0.W._cashuMsgDelayMs === undefined, 'a page with no test wait uses the real one');
  await settle(A, slow);

  /* ---- 8. someone who is not a contact, forged, too many --------------------------------------------------------- */
  const stranger = A.W.cashuMsgThreads().find((t) => t.peer === slow.keys.id);
  ok(!!stranger && stranger.contact === false && stranger.name === 'A Cashu ID' && stranger.unread === 1, 'a first message from someone who is not a contact: kept, as A Cashu ID');
  const sv = A.W.cashuMsgThread(slow.keys.id);
  ok(sv.card === slow.mine.text, 'with the ID string they sent, for ADD CONTACT');
  const r2 = await A.W.cashuMsgSend(slow.keys.id, 'who is this?');
  ok(r2.first === false, 'and A can answer by the ratchet');
  await until(() => A.said.sends.some((m) => m.peer === slow.keys.id));
  await settle(A, slow);
  ok((slow.W.cashuMsgThread(kA.id).msgs || []).some((m) => m.text === 'who is this?'), 'which reaches them');
  // forged: a tag that is not the one A works out
  const forgedFirst = padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'trust me', at: Date.now(), i: 0, next: 0,
    from: kB.id, tag: '00'.repeat(32), E: kB.id, card: B.mine.text });
  ok((await A.W._cashuIdArrived(forgedFirst)) === 'refused', 'a first message whose tag A does not work out: refused');
  // ten people who are not contacts at most
  let kept = 0, last = '';
  for (let n = 0; n < 11; n++) {
    const k = cashuIdKeys(crypto.randomBytes(64));
    const card = A.W._cashuIdEncode(k.id, k.nostr, k.sig);
    const Ec = Buffer.from(A.window.CashuTS.getPubKeyFromPrivKey(new A.window.Uint8Array(Buffer.from(hex64(7n + BigInt(n)), 'hex')))).toString('hex');
    const body = padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'hi ' + n, at: Date.now(), i: 0, next: 0, from: k.id, tag: cashuIdTag(k.d, kA.id, Ec), E: Ec, card });
    last = await A.W._cashuIdArrived(body);
    if (last === 'kept') kept += 1;
  }
  const strangers = A.W.cashuMsgThreads().filter((t) => !t.contact).length;
  ok(strangers === 10 && kept === 9 && last === 'refused', 'ten people who are not contacts are kept, the eleventh refused', strangers + ' ' + kept + ' ' + last);

  /* ---- 7. the caps ------------------------------------------------------------------------------------------------ */
  const C = page(C_WORDS);  // the same words as `slow`, a second phone of the same person: a contact of A now
  await A.W.cashuIdAdd(slow.mine.text, 'Carol');
  const baseC = A.thread(slow.keys.id).base;
  for (let n = 0; n < 205; n++) {
    await A.W._cashuMsgArrived(slow.keys.id, 'in', baseC + n, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'm' + n, at: Date.now() + n, i: baseC + n }));
  }
  const ct = A.W.cashuMsgThread(slow.keys.id);
  ok(ct.msgs.length === 200 && ct.msgs[199].text === 'm204', 'the last 200 messages with a contact are kept, the oldest gone', ct.msgs.length + ' ' + ct.msgs[0].text);
  const D = page(D_WORDS);
  D.mine = await D.W.cashuIdMine();
  await A.W.cashuIdAdd(D.mine.text, 'Dan');
  await A.W.cashuMsgListen();
  const big = 'é'.repeat(950);
  for (const [peer, start] of [[kB.id, A.thread(kB.id).base], [D.keys.id, 0]]) {
    for (let n = 0; n < 200; n++) {
      await A.W._cashuMsgArrived(peer, 'in', start + n, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: big, at: Date.now() + 1000 + n, i: start + n }));
    }
  }
  for (let n = 0; n < 200; n++) {
    await A.W._cashuMsgArrived(slow.keys.id, 'in', baseC + 205 + n, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: big, at: Date.now() + 2000 + n, i: baseC + 205 + n }));
  }
  const bytes = Buffer.byteLength(A.storage.getItem('foxy.msg.threads'), 'utf8');
  ok(bytes <= 1024 * 1024 && bytes > 900 * 1024, 'a megabyte in all, the oldest messages of any contact going first', String(bytes));
  ok(A.W.cashuMsgThread(slow.keys.id).msgs.slice(-1)[0].text === big && A.W.cashuMsgThread(kB.id).msgs.length < 200, 'the newest kept, the oldest let go');
  void C;

  /* ---- 9. restored from the words ----------------------------------------------------------------------------------- */
  // B's phone is lost; the same words on a new phone, with nothing stored
  const lastAtoB = A.thread(kB.id).out;
  const B2 = page(B_WORDS);
  // what a restore from the words writes (`cidRestored`): for a week, the conversations it begins have lost their place
  B2.storage.setItem('foxy.cid.recover', JSON.stringify(Date.now()));
  await B2.W.connect(MINT, { remember: true });
  B2.mine = await B2.W.cashuIdMine();
  ok(B2.mine.id === kB.id, 'the words give B’s ID again');
  await B2.W.cashuIdShown();
  await B2.W.cashuIdAdd(A.mine.text, 'Alice');
  await B2.W.cashuMsgListen();
  await until(async () => { await settle(B2); const t = B2.thread(kA.id); return t && t.out === 1 && t.base >= 7; }, 6000);
  const bt2 = B2.thread(kA.id);
  ok(!!bt2 && bt2.out === 1, 'its own message to A, read back from its chain: its next index is 1', JSON.stringify(bt2 && { out: bt2.out, base: bt2.base }));
  const texts2 = B2.W.cashuMsgThread(kA.id).msgs.map((m) => m.text);
  ok(texts2.indexOf('Hi Alice') >= 0 && texts2.indexOf('two') >= 0 && texts2.indexOf('Hello Bob') >= 0, 'A’s messages and its own, read back, the first one too (the delivery key)', texts2.slice(0, 5).join('|'));
  ok(bt2.base === lastAtoB, 'walked forward to where A’s chain stands: ' + lastAtoB, String(bt2.base));
  const r3 = await B2.W.cashuMsgSend(kA.id, 'back on a new phone');
  ok(r3.first === true && r3.i === 1, 'its first message after the restore goes by the delivery key, at index 1: "ratchet from now"', JSON.stringify(r3));
  await until(() => B2.said.nostr.length === 1);
  await settle(A, B2);
  ok(A.W.cashuMsgThread(kB.id).msgs.slice(-1)[0].text === 'back on a new phone' && A.thread(kB.id).base === 2, 'A, with its stored state, takes it and goes on from index 2');
  await A.W.cashuMsgSend(kB.id, 'welcome back');
  await until(() => A.said.sends.length > 0 && JSON.parse(A.said.sends[A.said.sends.length - 1].body).text === 'welcome back');
  await settle(A, B2);
  ok(B2.W.cashuMsgThread(kA.id).msgs.slice(-1)[0].text === 'welcome back', 'and B, restored, hears A by the ratchet again');
  const r4 = await B2.W.cashuMsgSend(kA.id, 'ratchet again');
  ok(r4.first === false && r4.i === 2, 'its next goes by the ratchet, index 2');
  await until(() => B2.said.sends.length === 1);
  await settle(A, B2);
  ok(A.W.cashuMsgThread(kB.id).msgs.slice(-1)[0].text === 'ratchet again', 'which A hears');

  /* ---- 10. a window behind: by the delivery key again --------------------------------------------------------------- */
  // eight messages of A's to B2 the relays dropped, then B2 writes, saying how far it has read
  const dropFrom = relay.length;
  for (let n = 0; n < 8; n++) await A.W.cashuMsgSend(kB.id, 'lost ' + n);
  await until(() => A.store('foxy.msg.outbox', []).length === 0);
  relay.splice(dropFrom);
  await wait(60);
  B2.arrivals.splice(0);
  const t2 = B2.store('foxy.msg.threads', {}); t2.threads[kA.id].msgs = t2.threads[kA.id].msgs.filter((m) => !/^lost /.test(m.text));
  t2.threads[kA.id].base = A.thread(kB.id).out - 8; t2.threads[kA.id].got = []; B2.storage.setItem('foxy.msg.threads', JSON.stringify(t2));
  await B2.W.cashuMsgSend(kA.id, 'anyone there?');
  await until(() => B2.said.sends.length === 2);
  await settle(A, B2);
  ok(A.thread(kB.id).resync === true, 'B’s `next` says it is eight behind A’s chain: A notes it');
  const nNostr = A.said.nostr.length;
  const r5 = await A.W.cashuMsgSend(kB.id, 'here, by your public key');
  ok(r5.first === true, 'and A’s next message goes by B’s delivery key, saying where A stands');
  await until(() => A.said.nostr.length === nNostr + 1);
  await settle(A, B2);
  ok(B2.W.cashuMsgThread(kA.id).msgs.slice(-1)[0].text === 'here, by your public key' && B2.thread(kA.id).base === r5.i + 1, 'B takes it and listens from there');
  ok(A.thread(kB.id).resync === false, 'and the ratchet goes on');

  /* ---- 11. the 2026-11-05 attack's fixes ------------------------------------------------------------------------------- */
  const E_WORDS = 'scheme spot photo card baby mountain device kick cradle pact join borrow';
  const F_WORDS = 'cat swing flag economy stadium alone churn speed unique patch report train';
  const ready = async (words, o) => { const p = page(words, o); await p.W.connect(MINT, { remember: true }); p.mine = await p.W.cashuIdMine(); await p.W.cashuIdShown(); return p; };
  const Ep = await ready(E_WORDS);
  const Fp = await ready(F_WORDS);
  const kE = Ep.keys, kF = Fp.keys;
  await Ep.W.cashuIdAdd(Fp.mine.text, 'Fay');
  await Fp.W.cashuIdAdd(Ep.mine.text, 'Eve');
  await settle(Ep, Fp);
  const firstOf = (from, to, j) => {
    const Ex = Buffer.from(to.window.CashuTS.getPubKeyFromPrivKey(to.window.CashuTS.createRandomSecretKey())).toString('hex');
    return padded(Object.assign({ v: 1, type: 'foxy-msg', id: msgId(), text: 'hi', at: Date.now(), i: 0, next: 0, from: from.keys.id,
      tag: cashuIdTag(from.keys.d, to.keys.id, Ex), E: Ex, card: from.mine.text }, j || {}));
  };
  const lastOpenOf = (p) => p.said.opens[p.said.opens.length - 1];

  // 11a. the last indices: a first message past 2^32 − 9 is refused, and the window is never empty
  const IMAX = 4294967295 - 8;
  ok((await Ep.W._cashuIdArrived(firstOf(Fp, Ep, { i: 4294967295 }))) === 'refused', 'a first message at index 2^32 − 1 is refused (a window of eight must fit below 2^32)');
  ok((await Ep.W._cashuIdArrived(firstOf(Fp, Ep, { i: IMAX + 1 }))) === 'refused', 'and at 2^32 − 8');
  ok((await Ep.W._cashuIdArrived(firstOf(Fp, Ep, { i: IMAX, text: 'near the end' }))) === 'kept', 'at 2^32 − 9 it is taken');
  ok((await Ep.W._cashuMsgArrived(kF.id, 'in', IMAX + 1, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'past', at: Date.now(), i: IMAX + 1 }))) === 'refused',
    'and a message by the chain past 2^32 − 9 too');
  await Ep.W.cashuMsgListen();
  const wE = lastOpenOf(Ep).peers.find((e) => e.peer === kF.id);
  ok(!!wE && wE.in.length === 8 && wE.in[0] === IMAX + 1 && wE.in[7] === 4294967295, 'so the window there is still eight keys', JSON.stringify(wE));
  // a thread stored with nothing left to listen on (written before this check): left out of the open, the others still named
  const tE = Ep.store('foxy.msg.threads', {});
  tE.threads[kF.id].base = 4294967296; tE.threads[kF.id].known = true;
  const ghost = cashuIdKeys(crypto.randomBytes(64));
  tE.threads[ghost.id] = Object.assign({}, tE.threads[kF.id], { peer: ghost.id, base: 0, msgs: [{ id: msgId(), dir: 'in', text: 'x', at: Date.now(), i: 0 }] });
  Ep.storage.setItem('foxy.msg.threads', JSON.stringify(tE));
  await Ep.W.cashuMsgListen();
  const oE = lastOpenOf(Ep);
  ok(oE.peers.every((e) => e.in.length + e.out.length > 0) && !oE.peers.some((e) => e.peer === kF.id) && oE.peers.some((e) => e.peer === ghost.id),
    'a peer with no index left is left out of the open; the others are still named', JSON.stringify(oE.peers.map((e) => [e.peer.slice(0, 6), e.in.length])));
  // back to a usable chain for the rest
  const tE2 = Ep.store('foxy.msg.threads', {});
  delete tE2.threads[kF.id]; delete tE2.threads[ghost.id];
  Ep.storage.setItem('foxy.msg.threads', JSON.stringify(tE2));
  Ep.storage.setItem('foxy.msg.seen', '[]');

  // 11b. a first message read again never moves the window back
  const f0 = firstOf(Fp, Ep, { i: 0, text: 'first of F', at: Date.now() - 60000 });
  ok((await Ep.W._cashuIdArrived(f0)) === 'kept', 'F’s first message, index 0');
  for (let n = 1; n <= 12; n++) await Ep.W._cashuMsgArrived(kF.id, 'in', n, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'f' + n, at: Date.now() - 50000 + n, i: n }));
  const unread0 = Ep.thread(kF.id).unread;
  ok(Ep.thread(kF.id).base === 13, 'then twelve by the chain: the window at 13', String(Ep.thread(kF.id).base));
  // gone from the shared seen list (strangers can fill it) and from the thread (two hundred later): read again
  const tF = Ep.store('foxy.msg.threads', {}); tF.threads[kF.id].msgs = tF.threads[kF.id].msgs.filter((m) => m.text !== 'first of F');
  Ep.storage.setItem('foxy.msg.threads', JSON.stringify(tF));
  Ep.storage.setItem('foxy.msg.seen', '[]');
  ok((await Ep.W._cashuIdArrived(f0)) === 'seen' && Ep.thread(kF.id).base === 13 && Ep.thread(kF.id).unread === unread0,
    'the same first message read again, gone from the seen list and the thread: seen, the window stays at 13', JSON.stringify({ base: Ep.thread(kF.id).base, unread: Ep.thread(kF.id).unread }));
  // an older first message, never had (it came late): its text is kept, the window does not go back
  const late = firstOf(Fp, Ep, { i: 0, text: 'late first', at: Date.now() - 55000 });
  ok((await Ep.W._cashuIdArrived(late)) === 'kept' && Ep.thread(kF.id).base === 13, 'an older first message never had is kept, and the window stays', String(Ep.thread(kF.id).base));
  // a newer one below the window: F's phone started its chain again (restored past what the relays hold)
  ok((await Ep.W._cashuIdArrived(firstOf(Fp, Ep, { i: 0, text: 'new phone' }))) === 'kept' && Ep.thread(kF.id).base === 1,
    'a newer first message below the window (a phone that started its chain again): the window goes to it', String(Ep.thread(kF.id).base));

  // 11c. people who are not contacts have their own budget
  const fBefore = Ep.thread(kF.id).msgs.length;
  for (let s = 0; s < 3; s++) {
    const k = cashuIdKeys(crypto.randomBytes(64));
    const Ex = Buffer.from(Ep.window.CashuTS.getPubKeyFromPrivKey(Ep.window.CashuTS.createRandomSecretKey())).toString('hex');
    const card = Ep.W._cashuIdEncode(k.id, k.nostr, k.sig);
    await Ep.W._cashuIdArrived(padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'z'.repeat(1000), at: Date.now(), i: 0, next: 0, from: k.id, tag: cashuIdTag(k.d, kE.id, Ex), E: Ex, card }));
    for (let i = 1; i < 120; i++) await Ep.W._cashuMsgArrived(k.id, 'in', i, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'z'.repeat(1000), at: Date.now(), i }));
  }
  const allE = Ep.store('foxy.msg.threads', {});
  const strangerBytes = Object.keys(allE.threads).filter((p) => p !== kF.id).reduce((a, p) => a + Buffer.byteLength(JSON.stringify(allE.threads[p].msgs), 'utf8'), 0);
  ok(strangerBytes <= 128 * 1024 && strangerBytes > 100 * 1024, 'the messages of people who are not contacts keep to their own 128 KB', String(strangerBytes));
  ok(Ep.thread(kF.id).msgs.length === fBefore, 'and a contact’s are untouched by them', Ep.thread(kF.id).msgs.length + ' of ' + fBefore);

  // 11d. eight unanswered by the chain: the ninth goes by the delivery key; a restored phone says where it stands
  Ep.storage.setItem('foxy.msg.threads', JSON.stringify({ mine: kE.id, threads: {} }));
  Fp.storage.setItem('foxy.msg.threads', JSON.stringify({ mine: kF.id, threads: {} }));
  await Ep.W.cashuMsgSend(kF.id, 'e0');
  await until(() => Ep.store('foxy.msg.outbox', []).length === 0);
  await settle(Ep, Fp);
  await Fp.W.cashuMsgSend(kE.id, 'f reply');
  await until(() => Fp.store('foxy.msg.outbox', []).length === 0);
  await settle(Ep, Fp);
  const ackE = Ep.thread(kF.id).ack;
  const ways = [];
  for (let n = 1; n <= 17; n++) ways.push((await Ep.W.cashuMsgSend(kF.id, 'e' + n)).first ? 'K' : 'c');
  await until(() => Ep.store('foxy.msg.outbox', []).length === 0);
  await settle(Ep, Fp);
  // message n goes at index n: out − ack is 8 at e9 and 16 at e17 (ack 1: F has had e0)
  ok(ackE === 1 && ways.join('') === 'ccccccccKcccccccK', 'with no answer, each message eight past what the other has said it read goes by the delivery key', ackE + ' ' + ways.join(''));
  ok(Fp.W.cashuMsgThread(kE.id).msgs.filter((m) => /^e\d+$/.test(m.text)).length === 18, 'and the other side has all of them', String(Fp.W.cashuMsgThread(kE.id).msgs.length));
  // F restored past what the relays hold: it says where it stands, silently, and E's next goes by the delivery key
  relay.splice(0);
  const F2 = page(F_WORDS);
  F2.storage.setItem('foxy.cid.recover', JSON.stringify(Date.now()));
  await F2.W.connect(MINT, { remember: true });
  F2.mine = await F2.W.cashuIdMine();
  await F2.W.cashuIdShown();
  Fp.listening = null; Fp.inboxOn = false;
  const nF2 = F2.said.nostr.length;
  const unreadE = Ep.thread(kF.id).unread, linesE = Ep.thread(kF.id).msgs.length;
  await F2.W.cashuIdAdd(Ep.mine.text, 'Eve');
  await until(() => F2.said.nostr.length > nF2 && F2.store('foxy.msg.outbox', []).length === 0, 3000);
  await settle(Ep, F2);
  const stand = F2.said.nostr[nF2] ? JSON.parse(F2.said.nostr[nF2].body) : {};
  ok(stand.type === 'foxy-msg-stand' && stand.text === '' && stand.next === 0 && stand.from === kF.id, 'a restored phone sends each contact added back a "where I stand": no text, its `next`', JSON.stringify({ type: stand.type, next: stand.next }));
  ok(F2.W.cashuMsgThread(kE.id).msgs.length === 0, 'shown nowhere on its own phone');
  ok(Ep.thread(kF.id).msgs.length === linesE && Ep.thread(kF.id).unread === unreadE && Ep.thread(kF.id).resync === true,
    'the contact shows no line for it, counts nothing unread, and knows to go by the delivery key', JSON.stringify({ lines: Ep.thread(kF.id).msgs.length, resync: Ep.thread(kF.id).resync }));
  const back = await Ep.W.cashuMsgSend(kF.id, 'welcome back, F');
  await until(() => Ep.store('foxy.msg.outbox', []).length === 0);
  await settle(Ep, F2);
  ok(back.first === true && F2.W.cashuMsgThread(kE.id).msgs.some((m) => m.text === 'welcome back, F'), 'so the restored phone hears the next message');
  ok((await Ep.W._cashuIdArrived((F2.said.nostr[nF2] || { body: '' }).body)) === 'seen', 'the same "where I stand" read again: seen');
  const standChain = padded({ v: 1, type: 'foxy-msg-stand', id: msgId(), text: '', at: Date.now(), i: Ep.thread(kF.id).base, next: 0 });
  ok((await Ep.W._cashuMsgArrived(kF.id, 'in', Ep.thread(kF.id).base, standChain)) === 'refused', 'a "where I stand" by the chain is refused: it is never a line of a conversation');
  ok((await Ep.W._cashuIdArrived(firstOf(F2, Ep, { type: 'foxy-msg-stand', text: 'shown?' }))) === 'refused', 'and one with text is refused');

  // 11e. text and time
  const bE = Ep.thread(kF.id).base;
  await Ep.W._cashuMsgArrived(kF.id, 'in', bE, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'a\u0085b\u009bc\u202ed\u2067e\u200bf\u2060g\ufeffh\u200di', at: 0, i: bE }));
  const lastE = Ep.W.cashuMsgThread(kF.id).msgs.slice(-1)[0];
  ok(lastE.text === 'a b c d efgh\u200di', 'C1 controls and direction overrides become spaces, zero-width spaces go, a joiner (emoji) stays', JSON.stringify(lastE.text));
  ok(lastE.at >= Date.now() - 32 * 86400000 - 5000, 'a far-past `at` is brought up to thirty-two days back', String(lastE.at));
  // a relay takes a message while the store is full: marked sent once it can be
  await Ep.W.cashuMsgSend(kF.id, 'store full');
  const proto = Ep.window.Storage.prototype, realSet = proto.setItem;
  let block = true;
  proto.setItem = function (k, v) { if (block && k === 'foxy.msg.threads') throw new Error('QuotaExceededError'); return realSet.call(this, k, v); };
  await until(() => F2.W.cashuMsgThread(kE.id).msgs.some((m) => m.text === 'store full'), 3000);
  await wait(100);
  block = false; proto.setItem = realSet;
  await until(() => Ep.W.cashuMsgThread(kF.id).msgs.slice(-1)[0].mark === 'sent', 3000);
  ok(Ep.W.cashuMsgThread(kF.id).msgs.slice(-1)[0].mark === 'sent' && Ep.store('foxy.msg.outbox', []).length === 0,
    'a message a relay took while the store was full is marked sent once there is room, and leaves the outbox',
    Ep.W.cashuMsgThread(kF.id).msgs.slice(-1)[0].mark);
  ok(F2.W.cashuMsgThread(kE.id).msgs.filter((m) => m.text === 'store full').length === 1, 'and the other side has it once');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
