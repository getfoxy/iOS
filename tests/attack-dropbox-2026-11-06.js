'use strict';
/* attack-dropbox-2026-11-06.js — what the relays can tie together from a Foxy ID's listens, before and after the
 * drop boxes (docs/FOXY-ID.md "The drop boxes", CashuID.swift `dropTweak`, 08e-cashu-id.js `cidListenPlan`).
 *
 *     node tests/attack-dropbox-2026-11-06.js
 *
 * THE WORLD. Receive-only phones, each with a Foxy ID, open Foxy a Poisson number of times a day (mean 4, some days
 * none) for 21 days. Every open is a listen: one REQ, or one per three days of keys, on a fresh circuit. The relays
 * all compare notes and see every REQ's keys and when it came; nothing else ties two REQs (the circuit is new).
 *
 * BEFORE (base13): every listen names the ID's delivery key. A relay ties every listen of one ID together: its whole
 * daily profile, every day, under one name. With DROPBOX_BEFORE_WALLET=<an older Web/foxy-wallet.js>, the before row
 * is driven through that page's own listen (its `cashuIdInboxOpen` carried no days: the phone asked the delivery key,
 * FoxyBridge+CashuID.swift of that build); without it, the row is that rule as written.
 * AFTER: each listen names the keys of the UTC days the page's own plan asks (`_cashuIdListenPlan`, driven here
 * through a real page): today's, and the days since the last listen. The adversary ties two listens when their REQs
 * share a key. Measured: how many pairs of an ID's listen-days are tied (want: none across days), and that the REQs
 * all name 48 keys.
 *
 * WHAT IS LEFT, measured and said: (a) the listens of one UTC day share their keys, so a day's sessions are one
 * profile; (b) anybody holding the ID string (a payer, or a relay handed it) works every key out and ties everything,
 * as before; (c) the next-day wrap of a payment: a relay pairing the two wraps of one payment (seconds apart; their
 * sizes are drawn apart by random filler) can tie a paid day to the next. Here as an upper bound: the share of day
 * pairs a perfect pairing would tie, at a payment on one day in five; (d) an ANY WALLET code's key is asked on many
 * days, in REQs of its own at another relay: those REQs tie their days together, measured for a phone that showed one;
 * (e) the delivery key itself is never asked (checked: no plan carries it, and no REQ names it).
 *
 * Seeded; the same numbers every run.
 */
const fs = require('fs');
const H = require('./harness');

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function poisson(R, mean) { const l = Math.exp(-mean); let k = 0, p = 1; do { k += 1; p *= R(); } while (p > l); return k - 1; }

const DAY_MS = 86400000;
const PHONES = 40;
const DAYS = 21;
const ASK_KEYS = 48;
const R = rng(20261106);

// one real page, its storage reset per phone: the plan is the page's own
const ctx = H.loadReal({ bridge: () => {} });
const W = ctx.W;
const keysCache = new Map();
const dayKeys = (nostr, day) => {
  const k = nostr + ':' + day;
  // the page's own payer half (noble); tests/cashu-id.js holds it to harness.js's BigInt and the vectors
  if (!keysCache.has(k)) keysCache.set(k, Array.from({ length: 16 }, (_, j) => W._cashuIdDropKey(nostr, day, j)));
  return keysCache.get(k);
};

const start = (Math.floor(Date.now() / DAY_MS) + 1) * DAY_MS;
const before = [];   // { phone, day, keys }
const phones = [];
const opensOf = [];  // { phone, day } for the before row
let namedQ = 0, planFields = true;
const anyListens = [];
const after = [];
let shapes = true;
let paidPairs = 0, dayPairs = 0;
for (let p = 0; p < PHONES; p++) {
  const secret = new ctx.window.Uint8Array(Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 + Math.floor(R() * 200) : Math.floor(R() * 256))));
  const nostr = Buffer.from(ctx.window.CashuTS.getPubKeyFromPrivKey(secret)).toString('hex').slice(2);
  for (const k of ['foxy.cid.heard', 'foxy.cid.any']) ctx.storage.removeItem(k);
  // one phone in four showed one ANY WALLET code, the day before the window
  const anyId = p % 4 === 0 ? (0x20000000 + p).toString(16) : '';
  if (anyId) ctx.storage.setItem('foxy.cid.any', JSON.stringify([{ id: anyId, at: start - DAY_MS / 2, asked: 0 }]));
  phones.push({ nostr, anyId });
  // a phone in use before the window: it listened the day before
  ctx.storage.setItem('foxy.cid.heard', JSON.stringify(Math.floor(start / DAY_MS) - 1));
  let openDays = 0;
  for (let d = 0; d < DAYS; d++) {
    const opens = poisson(R, 4);
    if (opens) openDays += 1;
    const times = Array.from({ length: opens }, () => start + d * DAY_MS + Math.floor(R() * DAY_MS)).sort((a, b) => a - b);
    for (const t of times) {
      before.push({ phone: p, day: d, keys: [nostr] });
      opensOf.push({ phone: p, day: d });
      const plan = W._cashuIdListenPlan(t);
      if (JSON.stringify(Object.keys(plan).sort()) !== '["any","days","today"]') planFields = false;
      const keys = plan.days.flatMap((x) => dayKeys(nostr, x));
      if (keys.indexOf(nostr) >= 0) namedQ += 1;
      if (plan.any.length) {
        anyListens.push({ phone: p, day: d, keys: plan.any.map((id) => W._cashuIdAnyKey(nostr, id)) });
        const rows = JSON.parse(ctx.storage.getItem('foxy.cid.any'));
        rows.forEach((r) => { if (plan.any.indexOf(r.id) >= 0) r.asked = plan.today; });
        ctx.storage.setItem('foxy.cid.any', JSON.stringify(rows));
      }
      // the REQs as the bridge makes them: three days each, every one padded to 48
      for (let i = 0; i < plan.days.length; i += 3) if (plan.days.slice(i, i + 3).length * 16 > ASK_KEYS) shapes = false;
      after.push({ phone: p, day: d, keys });
      ctx.storage.setItem('foxy.cid.heard', JSON.stringify(plan.today));
    }
  }
  // the payments' second wraps: a paid day tied to the next, at best for the adversary
  for (let d = 0; d + 1 < DAYS; d++) { dayPairs += 1; if (R() < 0.2) paidPairs += 1; }
  void openDays;
}

function tiedAcrossDays(listens) {
  const byKey = new Map();
  listens.forEach((l, i) => l.keys.forEach((k) => { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(i); }));
  const pairs = new Set();
  let total = 0;
  const perPhone = new Map();
  listens.forEach((l) => { if (!perPhone.has(l.phone)) perPhone.set(l.phone, new Set()); perPhone.get(l.phone).add(l.day); });
  perPhone.forEach((days) => { const n = days.size; total += n * (n - 1) / 2; });
  byKey.forEach((idx) => {
    for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
      const x = listens[idx[a]], y = listens[idx[b]];
      if (x.phone === y.phone && x.day !== y.day) pairs.add(x.phone + ':' + Math.min(x.day, y.day) + ':' + Math.max(x.day, y.day));
    }
  });
  return { tied: pairs.size, total };
}

async function beforeFromWallet(file) {
  // that page, loaded in place of this one's, listening at every open of the same phones
  const text = fs.readFileSync(file, 'utf8');
  const read = fs.readFileSync;
  fs.readFileSync = function (f, o) { return /Web[\/\\]foxy-wallet\.js$/.test(String(f)) ? text : read.apply(fs, arguments); };
  let asks = [];
  let old;
  try {
    old = H.loadReal({ bridge: (w, m) => {
      if (m.action === 'cashuIdInboxOpen') asks.push(m);
      setTimeout(() => w.FoxyWallet._scanResult(m.id, m.action === 'cashuIdInboxOpen' ? '1' : null, m.action === 'cashuIdInboxOpen' ? null : 'not here'), 0);
    } });
  } finally { fs.readFileSync = read; }
  old.storage.setItem('foxy.cid.shown', JSON.stringify(Date.now()));
  const rows = [];
  for (const o of opensOf) {
    asks = [];
    await old.W.cashuIdListen();
    // a listen that names no days asks the delivery key itself (that build's bridge)
    const m = asks[0];
    if (m) rows.push({ phone: o.phone, day: o.day, keys: m.days ? ['days?'] : [phones[o.phone].nostr] });
  }
  return rows;
}

(async () => {
const driven = process.env.DROPBOX_BEFORE_WALLET ? await beforeFromWallet(process.env.DROPBOX_BEFORE_WALLET) : null;
const b = tiedAcrossDays(driven || before);
const a = tiedAcrossDays(after);
console.log('listens: ' + after.length + ' over ' + PHONES + ' phones and ' + DAYS + ' days');
console.log('before' + (driven ? ' (driven through ' + process.env.DROPBOX_BEFORE_WALLET.split('/').slice(-3).join('/') + ', ' + driven.length + ' listens)' : ' (the rule as written)') + ': ' + b.tied + ' of ' + b.total + ' pairs of an ID’s listen-days tied by a shared key');
console.log('after:  ' + a.tied + ' of ' + a.total);
ok(b.total > 0 && b.tied === b.total, 'BEFORE: the delivery key in every REQ ties every listen-day of an ID to every other', b.tied + '/' + b.total);
ok(a.tied === 0, 'AFTER: no key is asked on two days: no two listen-days of an ID are tied by what they asked', a.tied + '/' + a.total);
ok(shapes, 'AFTER: every REQ the plan makes holds at most three days of keys, padded to 48');
ok(planFields && namedQ === 0, 'AFTER (H1): no plan asks for the delivery key, and no REQ names it', namedQ + ' REQs named it');
{
  const anyTied = tiedAcrossDays(anyListens);
  const anyPhones = new Set(anyListens.map((l) => l.phone)).size;
  console.log('ANY WALLET: ' + anyPhones + ' phones that showed a code; their code REQs tie ' + anyTied.tied + ' of ' + anyTied.total
    + ' pairs of the days they were asked (daily in the first month), and none of the day-key REQs');
  ok(anyTied.tied === anyTied.total && anyTied.total > 0 && anyListens.every((l) => l.keys.every((k) => !after.some((x) => x.keys.indexOf(k) >= 0))),
    'LEFT (said in the docs): a code’s REQs tie the days it is asked, in REQs apart from the day keys');
}
// within a day, still one profile (said in the docs)
const sameDay = after.filter((l, i) => after.some((m, j) => j > i && m.phone === l.phone && m.day === l.day && m.keys[0] === l.keys[0])).length;
ok(sameDay > 0, 'LEFT (said in the docs): the listens of one UTC day share their keys, so a day is still one profile', String(sameDay));
// a holder of the ID string computes every key
{
  const nostr = H.cashuIdKeys(Buffer.alloc(64, 7)).nostr;
  const anyDay = Math.floor(start / DAY_MS) + 5;
  const theirs = Array.from({ length: 16 }, (_, j) => H.cashuIdDropKey(nostr, anyDay, j));
  ok(JSON.stringify(theirs) === JSON.stringify(dayKeys(nostr, anyDay)),
    'LEFT (said in the docs): anybody with the ID string works out every day’s keys, so a relay handed the string ties everything as before');
}
console.log('next-day wraps: at a payment one day in five, a perfect pairing of a payment’s two wraps ties at most '
  + paidPairs + ' of ' + dayPairs + ' consecutive day pairs (' + Math.round(100 * paidPairs / dayPairs) + ' %); before, all of them');
ok(paidPairs < dayPairs, 'LEFT (said in the docs): a paid day can be tied to the next by its payment’s two wraps; an unpaid one cannot');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
})();
