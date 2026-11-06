'use strict';
/* attack-2026-11-05.js — an attack on the messages between Cashu IDs (build/wallet/08f-cashu-msg.js, docs/CASHU-ID.md
 * "Messages"), building on the review of the Cashu ID payments of 2026-11-04.
 *
 *     node tests/attack-2026-11-05.js
 *
 * Each case marked FINDING fails on this tree: it is a defect, named by its letter, and the report says the fix. The
 * cases marked "sound" or "measured" pass and say what was tried and what was learnt.
 *
 *   M1 one first message from anybody, at index 2^32 - 1, stops the phone listening for every contact: its window for
 *      that sender is empty, the open names a peer with no index, the phone refuses the whole request, and the inbox
 *      stays on the window it had (no new contact, no window moving on). M1b: the same from a contact: its window ends, and
 *      the phone must still name every other conversation and be heard.
 *   M2 a first message taken a second time moves the window back (`cmsgTakeIn` sets `base = i + 1` whatever the base
 *      was). A stranger pushes a contact's first message out of the seen list (500 places, any stranger's first
 *      messages fill it); after two hundred messages with that contact the first has also left the thread; the next
 *      listen reads it again from the relays (thirty-two days back): kept again as new, and the window goes back to 1.
 *      Each old message read again is kept as new and pushes the next oldest out of the 200, which is then kept again in
 *      turn: the month the relays hold comes back as unread messages. (Where the old ones are still in the thread, they are
 *      "seen" without moving the window on, and the window stops there.)
 *   M3 strangers share the contacts' megabyte: five people who are not contacts, writing, push every message with a
 *      contact out of the store.
 *   M4 a side eight or more behind on what the relays still hold hears nothing more from that contact until it writes
 *      itself (only its own `next` makes the other side go by the delivery key). The same after a restore whose
 *      relays no longer hold the conversation: the contact's messages are marked "sent" and never read.
 *   M5 C1 control characters (U+0080 to U+009F, among them NEL and CSI) are kept in a message's text, though the
 *      document says control characters become spaces.
 *   M6 a message that went to a relay while the store could not be written stays "sending…" for ever: its outbox row is
 *      gone and nothing marks it again.
 *
 *   sound: fifty contacts and ten strangers all listened on; a replayed wrap; a far-past and a future `at`; the 1,000-character limit; an app killed mid-send sends on the
 *   next start, once; an answer lost after a relay took it sends again and the receiver keeps one; two phones writing
 *   first at once; a forged first message.
 *   measured: what one listen asks the relays for (keys per contact, each contact's in a REQ of its own, and what a window moving on shows), and
 *   an index used again after a restore.
 *
 * The phone's half (cashuIdMsgSend, cashuIdMsgOpen, cashuIdTag) is harness.js's arithmetic, as in tests/cashu-msg.js; the
 * open is checked as CashuMsg.openCheck checks it (a peer with no index refuses the whole request, and the inbox that
 * was open stays open, as FoxyBridge+CashuID.swift's handleCashuIdMsgOpen does). */
const crypto = require('crypto');
const H = require('./harness');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS, cashuIdKeys, cashuIdTag, cashuMsgDir } = H;
// the harness's BigInt curve is slow; every open works out the same keys again, so they are kept
const memo = new Map();
const kept = (name, fn) => { if (!memo.has(name)) memo.set(name, fn()); return memo.get(name); };
const cashuMsgPair = (d, peer) => kept('p' + d + peer, () => H.cashuMsgPair(d, peer));
const xKey = (kind, pair, dir, i) => kept(kind + pair + dir + ':' + i, () => H.xOnlyOf(H.cashuMsgKey(kind, pair, dir, i)));

const MINT = 'https://m.test';
const B_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const C_WORDS = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 5000); while (Date.now() < end) { if (await fn()) return true; await wait(20); } return false; };
const seedOf = (words) => crypto.pbkdf2Sync(Buffer.from(words, 'utf8'), Buffer.from('mnemonic', 'utf8'), 2048, 64, 'sha512');
const msgId = () => crypto.randomBytes(16).toString('hex');
const freshE = () => { const e = crypto.createECDH('secp256k1'); e.generateKeys(); return e.getPublicKey('hex', 'compressed'); };

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
const say = (line) => console.log('      ' + line);
const ONLY = process.env.ATTACK_ONLY || '';
const on = (k) => !ONLY || ONLY.split(',').includes(k);
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 600000).unref();

function padded(j, size) {
  const o = Object.assign({}, j, { pad: '' });
  const n = Buffer.byteLength(JSON.stringify(o), 'utf8');
  const b = size || [512, 1024, 2048].find((x) => x >= n);
  o.pad = 'x'.repeat(b - n);
  return JSON.stringify(o);
}

/* ---- a world: relays, and the pages listening on them ----------------------------------------------------------- */
function world() {
  const Wd = { relay: [], everKeys: [], pages: [], mint: null, relayDown: false, loseAnswerOnce: false };

  Wd.deliver = (ctx, w) => {
    if (!ctx.listening || ctx.offline) return;
    const hit = ctx.listening.get(w.p);
    if (!hit || ctx.handed.has(w.id)) return;
    ctx.handed.add(w.id);
    if (w.seal !== hit.seal) { ctx.dropped += 1; return; }
    ctx.arrivals.push(ctx.W._cashuMsgArrived(hit.peer, hit.way, hit.i, w.body));
  };
  Wd.publish = (w) => {
    Wd.relay.push(w);
    if (!w.first) Wd.everKeys.push(w.p);
    for (const ctx of Wd.pages) {
      if (ctx.offline) continue;
      if (w.first && ctx.mine && ctx.mine.nostr === w.p && ctx.inboxOn) ctx.arrivals.push(ctx.W._cashuIdArrived(w.body));
      else if (!w.first) Wd.deliver(ctx, w);
    }
  };

  Wd.page = (words, opts) => {
    const o = opts || {};
    const phone = nativePhone({ words });
    const keys = cashuIdKeys(seedOf(words));
    const said = { opens: [], refusedOpens: 0, sends: [], nostr: [] };
    const reply = (w, id, t, e) => setTimeout(() => w.FoxyWallet._scanResult(id, t, e), 0);
    const ctx = loadReal({
      storage: o.storage,
      bridge: (w, m) => {
        if (m.action === 'mintRequest') return reply(w, m.id, Wd.mint.handle(m));
        if (m.action === 'nostrSend') {
          said.nostr.push(m);
          if (Wd.relayDown) return reply(w, m.id, null, 'no relay answered');
          const to = Wd.pages.find((c) => c.mine && w.FoxyWallet._cashuIdNprofile(c.mine.nostr) === m.target);
          Wd.publish({ id: crypto.randomBytes(8).toString('hex'), p: to ? to.mine.nostr : 'nobody', seal: '', body: m.body, first: true });
          return reply(w, m.id, '3');
        }
        if (m.action === 'cashuIdMsgSend') {
          said.sends.push(m);
          if (Wd.relayDown) return reply(w, m.id, null, 'No relay took the message: no answer in time');
          const pair = cashuMsgPair(keys.d, m.peer);
          const dir = cashuMsgDir(keys.id, m.peer);
          Wd.publish({ id: crypto.randomBytes(8).toString('hex'), p: xKey('recv', pair, dir, m.i),
            seal: xKey('seal', pair, dir, m.i), body: m.body, first: false });
          if (Wd.loseAnswerOnce) { Wd.loseAnswerOnce = false; return reply(w, m.id, null, 'The message could not be sent over Nostr.'); }
          return reply(w, m.id, '4');
        }
        if (m.action === 'cashuIdMsgOpen') {
          // CashuMsg.openCheck: 1 to 60 peers, none twice, at most eight each way, and never a peer with no index at all
          const bad = !Array.isArray(m.peers) || !m.peers.length || m.peers.length > 60
            || m.peers.some((e) => (e.in || []).length > 8 || (e.out || []).length > 8 || ((e.in || []).length === 0 && (e.out || []).length === 0)
              || (e.in || []).concat(e.out || []).some((i) => !Number.isInteger(i) || i < 0 || i > 4294967295));
          if (bad) {
            // refused before closeCashuMsgInbox(): the inbox that was open stays as it was
            said.refusedOpens += 1;
            return reply(w, m.id, null, 'bad request');
          }
          said.opens.push(JSON.parse(JSON.stringify(m)));
          const map = new Map();
          for (const e of m.peers) {
            const pair = cashuMsgPair(keys.d, e.peer);
            const out = cashuMsgDir(keys.id, e.peer);
            for (const [way, list, dir] of [['in', e.in || [], 1 - out], ['out', e.out || [], out]]) {
              for (const i of list) {
                map.set(xKey('recv', pair, dir, i), { peer: e.peer, way, i, seal: xKey('seal', pair, dir, i) });
              }
            }
          }
          ctx.listening = map;
          ctx.handed = new Set();
          reply(w, m.id, '1');
          setTimeout(() => { for (const x of Wd.relay.slice()) if (!x.first) Wd.deliver(ctx, x); }, 5);
          return;
        }
        if (m.action === 'cashuIdInboxOpen') {
          ctx.inboxOn = true;
          reply(w, m.id, '1');
          setTimeout(() => {
            if (ctx.offline) return;
            for (const x of Wd.relay.slice()) if (x.first && ctx.mine && x.p === ctx.mine.nostr) ctx.arrivals.push(ctx.W._cashuIdArrived(x.body));
          }, 5);
          return;
        }
        if (m.action === 'cashuIdCopiesOpen' || m.action === 'cashuIdInboxClose') return reply(w, m.id, '1');
        if (m.action === 'cashuIdTag' && typeof m.peer === 'string' && typeof m.e === 'string' && /^0[23][0-9a-f]{64}$/i.test(m.peer) && /^0[23][0-9a-f]{64}$/i.test(m.e)) {
          // harness.js's own answer works the ID key out from the words on every call (a fifth of a second): the same tag,
          // from this page's keys worked out once
          const peer = m.peer.toLowerCase(), e = m.e.toLowerCase();
          return reply(w, m.id, JSON.stringify({ tag: kept('T' + keys.id + peer + e, () => cashuIdTag(keys.d, peer, e)) }));
        }
        const got = phone.answer(w, m);
        if (!got) return reply(w, m.id, null, 'not in this test');
        return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
      },
      before: (w) => {
        phone.attach(w);
        if (!Wd.mint) Wd.mint = fakeMint(w, { p2pk: true });
      },
    });
    ctx.W._nodeProbeDelay = [86400000, 86400000];
    ctx.W._cashuIdRetryMs = 40;
    ctx.W._cashuMsgDelayMs = 0;
    ctx.W._cashuMsgRetryMs = 40;
    ctx.W._cashuMsgReopenMs = 20;
    ctx.said = said;
    ctx.keys = keys;
    ctx.arrivals = [];
    ctx.dropped = 0;
    ctx.handed = new Set();
    ctx.store = (k, d) => { try { const v = JSON.parse(ctx.storage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
    ctx.thread = (peer) => ((ctx.store('foxy.msg.threads', {}).threads || {})[peer]) || null;
    ctx.texts = (peer) => (ctx.W.cashuMsgThread(peer) || { msgs: [] }).msgs.map((m) => m.text);
    ctx.dump = () => { const o = {}; for (let i = 0; i < ctx.storage.length; i++) { const k = ctx.storage.key(i); o[k] = ctx.storage.getItem(k); } return o; };
    Wd.pages.push(ctx);
    return ctx;
  };

  Wd.ready = async (words, opts) => {
    const p = Wd.page(words, opts);
    await p.W.connect(MINT, { remember: true });
    p.mine = await p.W.cashuIdMine();
    await p.W.cashuIdShown();
    return p;
  };

  Wd.settle = async (...ctxs) => { for (let k = 0; k < 8; k++) { await wait(30); for (const c of ctxs) await Promise.all(c.arrivals.splice(0)); } };
  return Wd;
}

/* Two pages that are each other's contacts and have each written once (A first by the delivery key, B's reply by the
 * chain): both chains known. */
async function pairUp(Wd, wordsA, wordsB) {
  const A = await Wd.ready(wordsA);
  const B = await Wd.ready(wordsB);
  await A.W.cashuIdAdd(B.mine.text, 'Bob');
  await B.W.cashuIdAdd(A.mine.text, 'Alice');
  await Wd.settle(A, B);
  await A.W.cashuMsgSend(B.keys.id, 'hello');
  await until(() => A.said.nostr.length === 1 && A.store('foxy.msg.outbox', []).length === 0);
  await Wd.settle(A, B);
  await B.W.cashuMsgSend(A.keys.id, 'hi');
  await until(() => B.said.sends.length === 1 && B.store('foxy.msg.outbox', []).length === 0);
  await Wd.settle(A, B);
  return { A, B };
}

/* A stranger's first message to `to`, made by hand with the stranger's own keys: a valid tag, its ID string. */
function strangerFirst(to, k, j, sameE) {
  // a stranger may use one E for all its first messages: nothing asks for a fresh one (and the tag is then worked out once)
  const E = sameE ? (k.E || (k.E = freshE())) : freshE();
  const card = to.W._cashuIdEncode(k.id, k.nostr, k.sig);
  return padded(Object.assign({ v: 1, type: 'foxy-msg', id: msgId(), text: 'hi', at: Date.now(), i: 0, next: 0,
    from: k.id, tag: kept('t' + k.id + to.keys.id + E, () => cashuIdTag(k.d, to.keys.id, E)), E, card }, j || {}));
}

const lastOpen = (p) => p.said.opens[p.said.opens.length - 1];

async function run() {
  if (on('M1')) /* ---- M1: index 2^32 - 1 ----------------------------------------------------------------------------------------- */
  {
    const Wd = world();
    const { A, B } = await pairUp(Wd, PHONE_WORDS, B_WORDS);
    ok(A.texts(B.keys.id).join('|') === 'hello|hi', 'M1 control: A and B write both ways', A.texts(B.keys.id).join('|'));
    const X = cashuIdKeys(crypto.randomBytes(64));
    const got = await A.W._cashuIdArrived(strangerFirst(A, X, { i: 4294967295, text: 'last index' }));
    ok(got === 'refused', 'M1 a stranger’s first message at index 2^32 − 1 is refused (a window of eight must fit below 2^32)', got);
    // the furthest the stranger can go: a first message at 2^32 − 9, then by the chain (it has the pair secret) every index above
    const near = await A.W._cashuIdArrived(strangerFirst(A, X, { i: 4294967287, text: 'near the end' }));
    let past = 0;
    for (let i = 4294967288; i <= 4294967295; i++) {
      if ((await A.W._cashuMsgArrived(X.id, 'in', i, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'past', at: Date.now(), i }))) !== 'refused') past += 1;
    }
    ok(near === 'kept' && past === 0, 'M1 at 2^32 − 9 it is taken, and nothing by the chain above it', near + ', ' + past + ' taken above');
    await A.W.cashuMsgListen();
    await Wd.settle(A);
    const refusedAfter = A.said.refusedOpens;
    ok(refusedAfter === 0, 'M1 FINDING: after it, the phone still accepts the page’s open (no peer named with no index)', 'opens refused: ' + refusedAfter
      + '; the stranger’s window: ' + JSON.stringify((() => { const t = A.thread(X.id); return t && { base: t.base, known: t.known }; })()));
    // B goes on writing: nine messages; A's inbox stays on the window it had before the stranger
    for (let n = 0; n < 9; n++) { await B.W.cashuMsgSend(A.keys.id, 'b' + n); await until(() => B.store('foxy.msg.outbox', []).length === 0); await Wd.settle(A, B); }
    const heard = A.texts(B.keys.id).filter((t) => /^b\d$/.test(t));
    ok(heard.length === 9, 'M1 FINDING: A hears all nine of B’s next messages', 'A heard ' + heard.length + ' of 9: ' + heard.join(','));
    // a contact added after it is never listened for
    const C = await Wd.ready(C_WORDS);
    await A.W.cashuIdAdd(C.mine.text, 'Carol');
    await C.W.cashuIdAdd(A.mine.text, 'Alice');
    await A.W.cashuMsgSend(C.keys.id, 'hello Carol');
    await until(() => A.store('foxy.msg.outbox', []).length === 0);
    await Wd.settle(A, C);
    await C.W.cashuMsgSend(A.keys.id, 'hi from Carol');
    await until(() => C.store('foxy.msg.outbox', []).length === 0);
    await Wd.settle(A, C);
    ok(A.texts(C.keys.id).indexOf('hi from Carol') >= 0, 'M1 FINDING: a contact added after it is heard', A.texts(C.keys.id).join('|'));
  }

  if (on('M1')) /* ---- M1b: the same index from a contact ----------------------------------------------------------------------- */ {
    const Wd = world();
    const { A, B } = await pairUp(Wd, PHONE_WORDS, B_WORDS);
    // B (a contact: it has the pair secret and its own ID key) writes once by the delivery key at the last index, then at the
    // furthest one taken, then by the chain at every index above it
    const E = freshE();
    const body = padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'last index', at: Date.now(), i: 4294967295, next: 0,
      from: B.keys.id, tag: cashuIdTag(B.keys.d, A.keys.id, E), E, card: B.mine.text });
    ok((await A.W._cashuIdArrived(body)) === 'refused', 'M1b a contact’s first message at index 2^32 − 1 is refused');
    const E2 = freshE();
    const body2 = padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'near the end', at: Date.now(), i: 4294967287, next: 0,
      from: B.keys.id, tag: cashuIdTag(B.keys.d, A.keys.id, E2), E: E2, card: B.mine.text });
    ok((await A.W._cashuIdArrived(body2)) === 'kept', 'M1b at 2^32 − 9 it is taken');
    for (let i = 4294967288; i <= 4294967295; i++) await A.W._cashuMsgArrived(B.keys.id, 'in', i, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'past', at: Date.now(), i }));
    const refusedBefore = A.said.refusedOpens;
    await A.W.cashuMsgListen();
    await Wd.settle(A);
    const open = lastOpen(A);
    ok(A.said.refusedOpens === refusedBefore && !!open && (open.peers || []).every((e) => (e.in || []).length + (e.out || []).length > 0),
      'M1b after it, A’s open is still accepted (every contact it names has an index)', JSON.stringify(open && open.peers && open.peers.map((e) => [e.in, e.out])));
  }

  if (on('M5')) /* ---- M5 and the sound cases on text and time -------------------------------------------------------------------- */
  {
    const Wd = world();
    const { A, B } = await pairUp(Wd, PHONE_WORDS, B_WORDS);
    const base = B.thread(A.keys.id).base;
    const raw = 'one\u0085two\u009b31mthree‮evil​four';
    const r = await B.W._cashuMsgArrived(A.keys.id, 'in', base, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: raw, at: Date.now(), i: base, next: 1 }));
    const kept = B.texts(A.keys.id).slice(-1)[0] || '';
    ok(r === 'kept' && !/[\u0080-\u009f]/.test(kept), 'M5 FINDING: C1 control characters (NEL, CSI) become spaces, as the document says of control characters',
      JSON.stringify(kept));
    say('measured: right-to-left override U+202E and zero-width space U+200B are kept too (' + (/‮/.test(kept) ? 'kept' : 'gone') + ', '
      + (/​/.test(kept) ? 'kept' : 'gone') + '): a contact can make a line read backwards on the screen');
    // far past and future
    const r2 = await B.W._cashuMsgArrived(A.keys.id, 'in', base + 1, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'from 1970', at: 0, i: base + 1 }));
    const r3 = await B.W._cashuMsgArrived(A.keys.id, 'in', base + 2, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'from 2100', at: Date.now() + 2.4e12, i: base + 2 }));
    const view = B.W.cashuMsgThread(A.keys.id).msgs;
    const past = view.find((m) => m.text === 'from 1970'), future = view.find((m) => m.text === 'from 2100');
    ok(r2 === 'kept' && r3 === 'kept' && future.at <= Date.now() && past.at >= Date.now() - 32 * 86400000 - 60000,
      'sound: a future `at` is brought back to now; a far-past one is brought up to thirty-two days back (not shown as 1970, nor first to go when the store is full)',
      JSON.stringify({ past: past && past.at, future: future && future.at }));
    // the replayed wrap and an index below the window
    const again = await B.W._cashuMsgArrived(A.keys.id, 'in', base + 1, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'replayed', at: Date.now(), i: base + 1 }));
    ok(again === 'seen', 'sound: a second wrap to an index already had (another body, same key) is seen, not kept', again);
    // the limit, on the way in: 1,001 characters in a body that fits 2,048
    const long = await B.W._cashuMsgArrived(A.keys.id, 'in', base + 3, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'q'.repeat(1001), at: Date.now(), i: base + 3 }));
    ok(long === 'refused', 'sound: a body with 1,001 characters is refused on the way in too', long);
    // a forged first message: a contact's `from` with a tag made by another key
    const Y = cashuIdKeys(crypto.randomBytes(64));
    const E = freshE();
    const forged = padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'it is me', at: Date.now(), i: 0, next: 0, from: A.keys.id, tag: cashuIdTag(Y.d, B.keys.id, E), E, card: A.mine.text });
    ok((await B.W._cashuIdArrived(forged)) === 'refused', 'sound: a first message naming a contact, its tag made by another key, is refused');
  }

  if (on('M2')) /* ---- M2: a first message read again moves the window back --------------------------------------------------------- */
  {
    const Wd = world();
    const A = await Wd.ready(PHONE_WORDS);
    const B = await Wd.ready(B_WORDS);
    await A.W.cashuIdAdd(B.mine.text, 'Bob');
    await B.W.cashuIdAdd(A.mine.text, 'Alice');
    await Wd.settle(A, B);
    // B writes first (delivery key, index 0), then 209 more by the chain: a busy month
    await B.W.cashuMsgSend(A.keys.id, 'first');
    await until(() => B.store('foxy.msg.outbox', []).length === 0);
    await Wd.settle(A, B);
    const t0 = Date.now();
    for (let n = 1; n < 210; n++) {
      await B.W.cashuMsgSend(A.keys.id, 'n' + n);
      if (n % 8 === 0 || n === 209) { await until(() => B.store('foxy.msg.outbox', []).length === 0); await Wd.settle(A, B); }
    }
    await until(() => B.store('foxy.msg.outbox', []).length === 0);
    await Wd.settle(A, B);
    const before = A.thread(B.keys.id);
    ok(before.base === 210 && before.msgs.length === 200 && before.msgs[0].text === 'n10', 'M2 control: A heard all 210, keeps the last 200 (the first is gone from the thread)',
      JSON.stringify({ base: before.base, n: before.msgs.length, first: before.msgs[0].text, s: ((Date.now() - t0) / 1000).toFixed(1) }));
    // three strangers fill the seen list: 500 first messages
    const strangers = [0, 1, 2].map(() => cashuIdKeys(crypto.randomBytes(64)));
    let taken = 0;
    for (let n = 0; n < 501; n++) {
      if ((await A.W._cashuIdArrived(strangerFirst(A, strangers[n % 3], { text: 'spam ' + n, i: n }, true))) === 'kept') taken += 1;
    }
    const seen = A.store('foxy.msg.seen', []);
    const firstId = JSON.parse(Wd.relay.find((w) => w.first && w.p === A.mine.nostr).body).id.slice(0, 16);
    ok(taken === 501 && seen.indexOf(firstId) < 0, 'M2 three strangers’ 501 first messages push B’s first message out of the seen list', JSON.stringify({ taken, inSeen: seen.indexOf(firstId) >= 0 }));
    const unreadBefore = A.thread(B.keys.id).unread;
    // the next listen reads the delivery key thirty-two days back
    await A.W.cashuIdListen();
    await Wd.settle(A);
    await wait(200);
    await Wd.settle(A);
    const after = A.thread(B.keys.id);
    const firsts = after.msgs.filter((m) => m.text === 'first').length;
    // (A never opened the conversation: its 210 are unread before; none may be added)
    ok(after.base >= 210 && firsts === 0 && after.unread === unreadBefore, 'M2 FINDING: B’s first message read again is not taken a second time, the window does not go back, and nothing old comes back as unread',
      JSON.stringify({ base: after.base, firstsKept: firsts, unread: after.unread, unreadBefore }));
    say('measured: once the window went back, every message of the month the relays still hold came back as new: each one kept again pushes the next '
      + 'oldest out of the 200, which is then not in the thread when its wrap is read, and is kept again in turn');
    await B.W.cashuMsgSend(A.keys.id, 'are you there?');
    await until(() => B.store('foxy.msg.outbox', []).length === 0);
    await Wd.settle(A, B);
    await wait(200);
    await Wd.settle(A, B);
    ok(A.texts(B.keys.id).indexOf('are you there?') >= 0, 'M2 control: B’s next message is still heard (the old ones walk the window back up)', 'A’s window for B: ' + JSON.stringify(lastOpen(A).peers.find((e) => e.peer === B.keys.id)));
  }

  if (on('M3')) /* ---- M3: strangers share the contacts' megabyte ------------------------------------------------------------------- */
  {
    const Wd = world();
    const { A, B } = await pairUp(Wd, PHONE_WORDS, B_WORDS);
    for (let n = 0; n < 10; n++) { await B.W.cashuMsgSend(A.keys.id, 'from Bob ' + n); }
    await until(() => B.store('foxy.msg.outbox', []).length === 0);
    await Wd.settle(A, B);
    ok(A.texts(B.keys.id).length === 12, 'M3 control: A holds its twelve messages with B', String(A.texts(B.keys.id).length));
    const big = 'x'.repeat(1000);
    for (let s = 0; s < 5; s++) {
      const k = cashuIdKeys(crypto.randomBytes(64));
      await A.W._cashuIdArrived(strangerFirst(A, k, { text: big, i: 0 }));
      // then by the chain (the stranger has the pair secret), as fast as the window lets it: here, straight to the page
      for (let i = 1; i < 200; i++) await A.W._cashuMsgArrived(k.id, 'in', i, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: big, at: Date.now(), i }));
    }
    const left = A.texts(B.keys.id).length;
    ok(left === 12, 'M3 FINDING: five strangers’ messages do not push a contact’s out of the store', 'A keeps ' + left + ' of its 12 messages with B; store '
      + Math.round(Buffer.byteLength(A.storage.getItem('foxy.msg.threads'), 'utf8') / 1024) + ' KB');
  }

  if (on('M4')) /* ---- M4: eight behind, and a restore past the relays' horizon ------------------------------------------------------ */
  {
    const Wd = world();
    const { A, B } = await pairUp(Wd, PHONE_WORDS, B_WORDS);
    // B is away for over a month: A writes eight, which the relays drop after thirty-two days, then a ninth and tenth
    B.offline = true;
    const from = Wd.relay.length;
    for (let n = 0; n < 8; n++) await A.W.cashuMsgSend(B.keys.id, 'old ' + n);
    await until(() => A.store('foxy.msg.outbox', []).length === 0);
    Wd.relay.splice(from);
    await A.W.cashuMsgSend(B.keys.id, 'ninth');
    await A.W.cashuMsgSend(B.keys.id, 'tenth');
    await until(() => A.store('foxy.msg.outbox', []).length === 0);
    ok(A.W.cashuMsgThread(B.keys.id).msgs.slice(-2).every((m) => m.mark === 'sent'), 'M4 control: A’s ninth and tenth are marked sent');
    B.offline = false;
    // back in the foreground: what the app does on every return (`cidWake`), the delivery key's inbox and the windows
    await B.W.cashuIdListen();
    await Wd.settle(A, B);
    await wait(150);
    await Wd.settle(A, B);
    const got = B.texts(A.keys.id);
    ok(got.indexOf('ninth') >= 0 && got.indexOf('tenth') >= 0, 'M4 FINDING: back after the relays dropped eight, B hears A’s ninth and tenth without writing first',
      'B has: ' + got.join('|') + '; listens on ' + JSON.stringify(lastOpen(B).peers[0].in));
    // control: once B writes, its `next` makes A go by the delivery key, and the conversation comes back
    await B.W.cashuMsgSend(A.keys.id, 'anyone?');
    await until(() => B.store('foxy.msg.outbox', []).length === 0);
    await Wd.settle(A, B);
    await A.W.cashuMsgSend(B.keys.id, 'eleventh');
    await until(() => A.store('foxy.msg.outbox', []).length === 0);
    await Wd.settle(A, B);
    ok(B.texts(A.keys.id).indexOf('eleventh') >= 0, 'M4 control: after B writes, A’s next goes by the delivery key and B hears it');

    // the same after a restore whose relays no longer hold anything of the conversation
    Wd.relay.splice(0);
    const B2 = Wd.page(B_WORDS);
    B2.storage.setItem('foxy.cid.recover', JSON.stringify(Date.now()));
    await B2.W.connect(MINT, { remember: true });
    B2.mine = await B2.W.cashuIdMine();
    await B2.W.cashuIdShown();
    B.offline = true;
    await B2.W.cashuIdAdd(A.mine.text, 'Alice');
    await B2.W.cashuMsgListen();
    await Wd.settle(B2);
    await A.W.cashuMsgSend(B.keys.id, 'after your restore');
    await until(() => A.store('foxy.msg.outbox', []).length === 0);
    await Wd.settle(A, B2);
    await wait(150);
    await Wd.settle(A, B2);
    ok(A.W.cashuMsgThread(B.keys.id).msgs.slice(-1)[0].mark === 'sent' && B2.texts(A.keys.id).indexOf('after your restore') >= 0,
      'M4 FINDING: restored past what the relays hold, B hears A’s message (A shows it sent)',
      'B2 has ' + JSON.stringify(B2.texts(A.keys.id)) + ', listens on ' + JSON.stringify((lastOpen(B2).peers[0] || {}).in));
    // measured: B2 starts its own chain again from 0, so the relays see keys of B→A again
    const keysBefore = new Set(Wd.everKeys);
    await B2.W.cashuMsgSend(A.keys.id, 'new phone');
    await until(() => B2.store('foxy.msg.outbox', []).length === 0);
    await Wd.settle(A, B2);
    await B2.W.cashuMsgSend(A.keys.id, 'new phone again');
    await until(() => B2.store('foxy.msg.outbox', []).length === 0);
    const reused = Wd.relay.filter((w) => !w.first && keysBefore.has(w.p)).length;
    say('measured: after the restore, B2’s chain to A started again at ' + (B2.said.sends[0] ? B2.said.sends[0].i : '?') + '; wraps to a key a relay saw before: ' + reused
      + ' (the document says so: "an index this phone used before ... may be used again")');
    ok(true, 'measured: index reuse after a restore past the relays’ horizon (' + reused + ' key(s) seen twice)');
  }

  if (on('REQ')) /* ---- sixty peers, and what each contact's REQ tells a relay ------------------------------------------------------------------ */
  {
    const Wd = world();
    const A = await Wd.ready(PHONE_WORDS);
    const contacts = [];
    for (let n = 0; n < 50; n++) {
      const k = cashuIdKeys(crypto.randomBytes(64));
      contacts.push(k);
      await A.W.cashuIdAdd(A.W._cashuIdEncode(k.id, k.nostr, k.sig), 'Friend ' + n);
    }
    for (let s = 0; s < 10; s++) await A.W._cashuIdArrived(strangerFirst(A, cashuIdKeys(crypto.randomBytes(64)), { text: 'hello' }));
    await A.W.cashuMsgListen();
    const listened = new Set(lastOpen(A).peers.map((e) => e.peer));
    const missing = contacts.filter((k) => !listened.has(k.id)).length;
    ok(missing === 0, 'sound: fifty contacts (the most the book keeps) and ten strangers writing: every contact is listened on', missing + ' contacts not listened on');
    // measured: what the relays are asked in this one listen, each contact's keys in a REQ of their own
    const keysN = lastOpen(A).peers.reduce((a, e) => a + e.in.length + e.out.length, 0);
    const unknown = lastOpen(A).peers.filter((e) => e.out.length).length;
    say('measured: one listen asks for ' + keysN + ' keys for ' + lastOpen(A).peers.length + ' peers: 8 for each one this phone has heard from (' + (lastOpen(A).peers.length - unknown)
      + '), 16 for each it has not (' + unknown + '); the phone puts each contact’s keys in a REQ of their own, on a circuit of their own, at one relay (CashuMsgListen), '
      + 'so a relay sees one contact’s 8 or 16 keys a REQ, and the count of contacts only from timing, not from any one REQ');
    // the window moving on: one message from one contact changes that contact's next REQ by one key out and one in
    const k0 = contacts.find((k) => listened.has(k.id));
    const t = A.thread(k0.id);
    const before = lastOpen(A).peers.find((e) => e.peer === k0.id);
    await A.W._cashuMsgArrived(k0.id, 'in', t.base, padded({ v: 1, type: 'foxy-msg', id: msgId(), text: 'one', at: Date.now(), i: t.base }));
    await wait(80);
    await until(() => lastOpen(A).peers.find((e) => e.peer === k0.id).in[0] !== before.in[0], 2000);
    const afterP = lastOpen(A).peers.find((e) => e.peer === k0.id);
    const gone = before.in.filter((i) => afterP.in.indexOf(i) < 0), came = afterP.in.filter((i) => before.in.indexOf(i) < 0);
    say('measured: one message in moves its sender’s eight keys by one (out ' + JSON.stringify(gone) + ', in ' + JSON.stringify(came)
      + '), and the peers go to the phone in the order they last wrote (first now: ' + (lastOpen(A).peers[0].peer === k0.id ? 'the one that just wrote' : 'another') + '); '
      + 'the page names each peer’s keys together and in that order; the phone asks for each peer’s keys in a REQ of their own (CashuMsgListenTests), '
      + 'but seven of a window’s eight keys stay from one of that contact’s REQs to the next, so those keys act as a pseudonym for the conversation from listen to listen');
    ok(gone.length === 1 && came.length === 1, 'measured: after one arrival the sender’s keys move by one key out and one key in, for that sender alone');
  }

  if (on('M6')) /* ---- M6 and the outbox's sound cases ------------------------------------------------------------------------------- */
  {
    const Wd = world();
    const { A, B } = await pairUp(Wd, PHONE_WORDS, B_WORDS);
    // killed mid-send: the outbox row is on disk; the next start sends it, once
    Wd.relayDown = true;
    await A.W.cashuMsgSend(B.keys.id, 'sent before a crash');
    await until(() => A.store('foxy.msg.outbox', []).some((r) => r.tries >= 1), 3000);
    const disk = A.dump();
    A.offline = true;
    Wd.pages.splice(Wd.pages.indexOf(A), 1);
    Wd.relayDown = false;
    const A2 = Wd.page(PHONE_WORDS, { storage: disk });
    await A2.W.connect(MINT, { remember: true });
    A2.mine = await A2.W.cashuIdMine();
    await A2.W.cashuIdListen();
    await until(() => A2.store('foxy.msg.outbox', []).length === 0, 3000);
    await Wd.settle(A2, B);
    ok(B.texts(A2.keys.id).filter((t) => t === 'sent before a crash').length === 1 && A2.W.cashuMsgThread(B.keys.id).msgs.slice(-1)[0].mark === 'sent',
      'sound: a message left in the outbox by an app killed mid-send goes on the next start, once, and is marked sent');
    // the answer lost after a relay took it: sent again to the same key; the receiver keeps one
    Wd.loseAnswerOnce = true;
    const before = Wd.relay.length;
    await A2.W.cashuMsgSend(B.keys.id, 'answer lost');
    await until(() => A2.store('foxy.msg.outbox', []).length === 0, 3000);
    await Wd.settle(A2, B);
    const wraps = Wd.relay.slice(before).filter((w) => !w.first);
    ok(B.texts(A2.keys.id).filter((t) => t === 'answer lost').length === 1 && wraps.length === 2 && wraps[0].p === wraps[1].p,
      'sound: an answer lost after a relay took the wrap: sent again, to the same key (the relay sees that key twice), and kept once', String(wraps.length));
    // M6: the store cannot be written as the relay's OK comes back
    await A2.W.cashuMsgSend(B.keys.id, 'store full');
    const proto = A2.window.Storage.prototype;
    const real = proto.setItem;
    let block = true;
    proto.setItem = function (k, v) { if (block && k === 'foxy.msg.threads') throw new Error('QuotaExceededError'); return real.call(this, k, v); };
    await until(() => A2.store('foxy.msg.outbox', []).length === 0, 3000);
    await Wd.settle(A2, B);
    block = false;
    proto.setItem = real;
    await wait(300);
    const mark = A2.W.cashuMsgThread(B.keys.id).msgs.slice(-1)[0].mark;
    ok(B.texts(A2.keys.id).indexOf('store full') >= 0 && mark === 'sent', 'M6 FINDING: a message a relay took while the store was full is marked sent once it can be', 'B has it; A shows "' + mark + '"');
  }

  if (on('BOTH')) /* ---- both write first at once ------------------------------------------------------------------------------------ */
  {
    const Wd = world();
    const A = await Wd.ready(PHONE_WORDS);
    const B = await Wd.ready(B_WORDS);
    await A.W.cashuIdAdd(B.mine.text, 'Bob');
    await B.W.cashuIdAdd(A.mine.text, 'Alice');
    await Wd.settle(A, B);
    await Promise.all([A.W.cashuMsgSend(B.keys.id, 'A first'), B.W.cashuMsgSend(A.keys.id, 'B first'), A.W.cashuMsgSend(B.keys.id, 'A second')]);
    await until(() => A.store('foxy.msg.outbox', []).length === 0 && B.store('foxy.msg.outbox', []).length === 0);
    await Wd.settle(A, B);
    await A.W.cashuMsgSend(B.keys.id, 'A third');
    await B.W.cashuMsgSend(A.keys.id, 'B second');
    await until(() => A.store('foxy.msg.outbox', []).length === 0 && B.store('foxy.msg.outbox', []).length === 0);
    await Wd.settle(A, B);
    await wait(100);
    await Wd.settle(A, B);
    const a = A.texts(B.keys.id), b = B.texts(A.keys.id);
    ok(['A first', 'A second', 'A third'].every((t) => b.indexOf(t) >= 0) && ['B first', 'B second'].every((t) => a.indexOf(t) >= 0),
      'sound: both phones writing first at once (two of A’s by the delivery key before a relay took the first): everything arrives', JSON.stringify({ a, b }));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
