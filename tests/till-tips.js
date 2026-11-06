'use strict';
/* till-tips.js — tips at the till and the keeper's list of cashier codes, the wallet's half
 * (build/wallet/08f-till-tips.js, with 08d-till.js).
 *
 *     node tests/till-tips.js
 *
 *   1  the answer to ACCEPT TIPS? checked: off, to the keeper, one Cashu ID, a group of up to eight whose whole
 *      percentages add up to 100; every ID named and a contact's (its delivery key from the contact)
 *   2  the split: each share rounded down to a whole sat or cent, the remainder to the first share
 *   3  the keeper's own till: a sale's tip to one person is one Cashu ID payment ("Tip to <name>"), the sale's row says
 *      "tip"; to the keeper, nothing but the word on the row; a sale is passed on once
 *   4  a group: one payment per share; a share under the smallest sent waits and rides with the next tip to that ID
 *   5  the jobs: no route or another mint waits and counts nothing; a failure is tried again a minute later; ten failures
 *      give up, the money stays, the sale's row says so
 *   6  the cashier: a code's tips are one flag on it (nobody's ID in the QR); a request or invoice with a tip carries it
 *      only on a code that offers tips; the outbox row and the delivery say the tip; the keeper passes it on by its own
 *      row of the code, never more than came in, and not where the code takes no tips
 *   7  CASHIER CODE's list: several live codes at once, each with its label and tips; END moves one to PAST; one run
 *      out is PAST too; eight at most; no totals anywhere
 *   8  `tillTips`, the object anything else that passes tips on reuses
 *
 * Pages on harness.js's fake mints; the phone's till and Cashu ID sides are harness.js's, the relays stubbed. */
const crypto = require('crypto');
const { loadReal, fakeMint, nativePhone, cashuIdKeys } = require('./harness');

const MINT = 'https://m.test';
const HOME = 'https://home.test';
const KEEPER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const CASHIER_WORDS = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
const PAYER_WORDS = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => { const end = Date.now() + (ms || 5000); while (Date.now() < end) { if (await fn()) return true; await wait(25); } return false; };
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 120000).unref();

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), name, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));

const mints = {};
let relay = [];
let relayDown = false;

function page(words) {
  const phone = nativePhone({ words });
  const said = { open: [], answers: [] };
  const reply = (w, id, t, e) => setTimeout(() => w.FoxyWallet._scanResult(id, t, e), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const url = String(m.url || '');
        return reply(w, m.id, (url.indexOf('home.test') >= 0 ? mints.home : mints.main).handle(m));
      }
      if (m.action === 'tillKeyMake') {
        const tail = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.split('').sort(() => Math.random() - 0.5).join('');
        return reply(w, m.id, 'nprofile1' + tail + tail);
      }
      if (m.action === 'tillKeyDrop') return reply(w, m.id, 'ok');
      if (m.action === 'tillInboxOpen') { said.open.push(m.ids); return reply(w, m.id, String((m.ids || []).length)); }
      if (m.action === 'tillInboxClose') return reply(w, m.id, 'ok');
      if (m.action === 'cashuIdInboxOpen' || m.action === 'cashuIdCopiesOpen') return reply(w, m.id, '1');
      if (m.action === 'cashuIdInboxClose') return reply(w, m.id, 'ok');
      if (m.action === 'nostrSend') {
        if (relayDown) return reply(w, m.id, null, 'no relay answered');
        relay.push({ target: m.target, body: m.body });
        return reply(w, m.id, '2');
      }
      if (m.action === 'inboxAnswer') { said.answers.push(m); return reply(w, m.id, ''); }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!mints.main) mints.main = fakeMint(w, { p2pk: true });
      if (!mints.home) mints.home = fakeMint(w, { p2pk: true, fill: 9, quoteFrom: 50000 });
    },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._tillRetryMs = 40;
  ctx.W._cashuIdRetryMs = 40;
  ctx.W._tillTipRetryMs = 40;
  ctx.said = said;
  ctx.store = (k, d) => { try { const v = JSON.parse(ctx.storage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  ctx.put = (k, v) => ctx.storage.setItem(k, JSON.stringify(v));
  return ctx;
}

const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x)
  : (x && typeof x === 'object' && typeof x.toNumber === 'function' && !Array.isArray(x) ? x.toNumber() : x))));
const proofsOf = (ctx, token) => plain(ctx.W.tokenInfo(token).proofs);
const logRow = (ctx, hash) => (ctx.store('foxy.cashu.log', []) || []).find((e) => e.hash === hash) || null;
const jobs = (ctx) => ctx.store('foxy.till.tips.jobs', []);
// a Cashu ID of somebody else's, kept as a contact under `name`
async function contact(ctx, name) {
  const k = cashuIdKeys(crypto.randomBytes(64));
  const text = ctx.W._cashuIdEncode(k.id, k.nostr, k.sig);
  await ctx.W.cashuIdAdd(text, name);
  return { id: k.id, nostr: k.nostr, name, text, to: ctx.W._cashuIdNprofile(k.nostr) };
}
const errOf = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
// a delivery to `nprofile` among what went over the relays: the Cashu ID envelope, read
const deliveredTo = (to) => relay.filter((r) => r.target === to).map((r) => { try { return JSON.parse(r.body); } catch (e) { return {}; } });

async function run() {
  const K = page(KEEPER_WORDS);
  const C = page(CASHIER_WORDS);
  const P = page(PAYER_WORDS);
  await K.W.connect(MINT, { remember: true });
  await C.W.connect(HOME, { remember: true });
  await P.W.connect(MINT, { remember: true });
  await K.W.primeLocks();
  await P.W.primeLocks();
  const sale = await K.W.invoice(1000, '');
  await K.W.claim(sale.hash);
  await P.W.claim((await P.W.invoice(3000, '')).hash);
  ok((await K.W.balanceSats()) === 1000, 'the keeper holds 1,000 sats, from one sale');

  const ana = await contact(K, 'Ana');
  const ben = await contact(K, 'Ben');
  const cy = await contact(K, 'Cy');

  /* ---- 1  the answer checked ------------------------------------------------------------------- */
  const T = K.W.tillTips;
  eq(T.check(null), { on: false, to: 'self', ids: [] }, 'no answer is tips off');
  eq(T.check({ on: false, to: 'group', ids: [{ id: ana.id }] }), { on: false, to: 'self', ids: [] }, 'off is off, whatever else it says');
  eq(T.check({ on: true, to: 'self', ids: [{ id: ana.id }] }), { on: true, to: 'self', ids: [] }, 'to the keeper names nobody');
  const one = T.check({ on: true, to: 'one', ids: [{ id: ana.id, name: 'Ana', pct: 7 }] });
  ok(one.to === 'one' && one.ids.length === 1 && one.ids[0].pct === 100 && one.ids[0].nostr === ana.nostr,
    'one person takes 100%, its delivery key read from the contact', JSON.stringify(one.ids[0]));
  ok(/One person/.test(errOf(() => T.check({ on: true, to: 'one', ids: [{ id: ana.id, name: 'Ana' }, { id: ben.id, name: 'Ben' }] }))), 'one person is one');
  ok(/Pick who/.test(errOf(() => T.check({ on: true, to: 'one', ids: [] }))), 'and somebody');
  ok(/Name every/.test(errOf(() => T.check({ on: true, to: 'one', ids: [{ id: ana.id, name: '  ' }] }))), 'every ID is named');
  const stranger = cashuIdKeys(crypto.randomBytes(64));
  ok(/not one of your contacts/.test(errOf(() => T.check({ on: true, to: 'one', ids: [{ id: stranger.id, name: 'X' }] }))),
    'an ID that is not a contact, and comes with no delivery key, is refused');
  ok(T.check({ on: true, to: 'one', ids: [{ id: stranger.id, nostr: stranger.nostr, name: 'X' }] }).ids[0].nostr === stranger.nostr,
    'one with its delivery key is taken as it is');
  ok(/not a Cashu ID/.test(errOf(() => T.check({ on: true, to: 'one', ids: [{ id: 'ab', name: 'X' }] }))), 'a key that is not one is refused');
  ok(/add up to 100%. They add up to 90%/.test(errOf(() => T.check({ on: true, to: 'group', ids: [{ id: ana.id, name: 'Ana', pct: 50 }, { id: ben.id, name: 'Ben', pct: 40 }] }))),
    'a group’s shares add up to 100, said with what they add up to');
  ok(/whole percentage/.test(errOf(() => T.check({ on: true, to: 'group', ids: [{ id: ana.id, name: 'Ana', pct: 50.5 }, { id: ben.id, name: 'Ben', pct: 49.5 }] }))), 'whole percentages');
  ok(/twice/.test(errOf(() => T.check({ on: true, to: 'group', ids: [{ id: ana.id, name: 'Ana', pct: 50 }, { id: ana.id, name: 'Ana', pct: 50 }] }))), 'an ID once');
  const nine = Array.from({ length: 9 }, (_, i) => ({ id: cashuIdKeys(crypto.randomBytes(64)).id, nostr: '11'.repeat(32), name: 'P' + i, pct: i ? 11 : 12 }));
  ok(/eight Cashu IDs at most|8 Cashu IDs at most/.test(errOf(() => T.check({ on: true, to: 'group', ids: nine }))), 'a group is eight at most');
  ok(T.check({ on: true, to: 'group', ids: nine.slice(0, 8).map((r, i) => Object.assign({}, r, { pct: i ? 12 : 16 })) }).ids.length === 8, 'and eight is a group');
  ok(K.W.tillTipsProblem({ on: true, to: 'nobody' }) !== '' && K.W.tillTipsProblem({ on: true, to: 'self' }) === '', 'tillTipsProblem says why, or nothing');

  /* ---- 2  the split ------------------------------------------------------------------------------ */
  const grp = (pcts) => ({ on: true, to: 'group', ids: [ana, ben, cy].slice(0, pcts.length).map((c, i) => ({ id: c.id, nostr: c.nostr, name: c.name, pct: pcts[i] })) });
  eq(T.split(grp([50, 30, 20]), 100).map((r) => r.amount), [50, 30, 20], '100 at 50/30/20 is 50, 30, 20');
  eq(T.split(grp([33, 33, 34]), 7).map((r) => r.amount), [3, 2, 2], '7 at 33/33/34: 2, 2, 2 rounded down, the 1 left to the first');
  eq(T.split(grp([50, 50]), 1).map((r) => r.amount), [1, 0], '1 at 50/50: the first takes it');
  eq(T.split(grp([50, 45, 5]), 21).map((r) => r.amount), [11, 9, 1], '21 at 50/45/5: 10, 9, 1 and the 1 left to the first');
  ok([5, 99, 1234, 99999].every((n) => T.split(grp([34, 33, 33]), n).reduce((s, r) => s + r.amount, 0) === n), 'the shares always add up to the tip');
  eq(T.split({ on: true, to: 'self' }, 100), [], 'no shares when the keeper keeps it');
  eq(T.split(grp([50, 30, 20]), 0), [], 'nor for no tip');

  /* ---- 3  the keeper's own till: one person --------------------------------------------------------- */
  K.W.tillTipsSet({ on: true, to: 'one', ids: [{ id: ana.id, name: 'Ana' }] });
  eq(K.W.tillTipsNow().to, 'one', 'the till’s answer is kept (tillTipsNow)');
  ok(K.store('foxy.till.tips', null) && K.store('foxy.till.tips', null).ids[0].id === ana.id, 'in the till’s own storage');
  relay = [];
  const bal0 = await K.W.balanceSats();
  const f1 = await K.W.tillTipTaken({ amount: 100, unit: 'sat', mint: MINT, hash: sale.hash });
  ok(f1.jobs === 1 && f1.waiting === 0, 'a tip of 100 to one person is one payment', JSON.stringify(f1));
  ok(logRow(K, sale.hash).tillTip === 100 && logRow(K, sale.hash).tillTipUnit === 'sat', 'and the sale’s row says tip 100');
  await until(() => jobs(K).some((j) => j.state === 'sent'), 4000);
  const j1 = jobs(K)[0] || {};
  ok(j1.state === 'sent' && j1.amount === 100 && j1.cid === ana.id && j1.sale === sale.hash, 'the job is sent', JSON.stringify(j1));
  ok((await K.W.balanceSats()) === bal0 - 100, 'and 100 left the keeper’s balance', String(await K.W.balanceSats()));
  const env1 = deliveredTo(ana.to);
  ok(env1.length === 1 && env1[0].type === 'foxy-cashu-id' && /^cashu/.test(env1[0].token), 'Ana was sent a Cashu ID payment over Nostr', JSON.stringify(env1.map((e) => e.type)));
  const tipRow = logRow(K, j1.payHash) || {};
  ok(tipRow.dir === 'out' && tipRow.memo === 'Tip to Ana' && tipRow.tillTipTo === 'Ana' && tipRow.tillTipSale === sale.hash,
    'its history row says "Tip to Ana" and names the sale', JSON.stringify({ memo: tipRow.memo, to: tipRow.tillTipTo }));
  const again = await K.W.tillTipTaken({ amount: 100, unit: 'sat', mint: MINT, hash: sale.hash });
  ok(again.seen === true && jobs(K).length === 1, 'the same sale is passed on once');

  // to the keeper: a word on the row, nothing paid
  const sale2 = await K.W.invoice(500, ''); await K.W.claim(sale2.hash);
  K.W.tillTipsSet({ on: true, to: 'self' });
  const bal1 = await K.W.balanceSats();
  const f2 = await K.W.tillTipTaken({ amount: 50, unit: 'sat', mint: MINT, hash: sale2.hash });
  await wait(80);
  ok(f2.kept === 50 && f2.jobs === 0 && jobs(K).length === 1 && (await K.W.balanceSats()) === bal1, 'to the keeper: kept, nothing paid', JSON.stringify(f2));
  ok(logRow(K, sale2.hash).tillTip === 50, 'and its row says tip 50');
  K.W.tillTipsSet({ on: false });
  ok(K.W.tillTipsNow().on === false, 'tips off is kept as off');

  /* ---- 4  a group, and a share too small to send ---------------------------------------------------- */
  const g = grp([50, 45, 5]);
  K.W.tillTipsSet(g);
  relay = [];
  const sale3 = await K.W.invoice(400, ''); await K.W.claim(sale3.hash);
  const f3 = await K.W.tillTipTaken({ amount: 21, unit: 'sat', mint: MINT, hash: sale3.hash });
  ok(f3.jobs === 1 && f3.waiting === 10, '21 at 50/45/5: Ana’s 11 goes; Ben’s 9 and Cy’s 1 are under 10 and wait', JSON.stringify(f3));
  const carry1 = K.W.tillTips.carry();
  ok(carry1[ben.id + '|sat|' + MINT] === 9 && carry1[cy.id + '|sat|' + MINT] === 1, 'kept for each, by ID, unit and mint', JSON.stringify(carry1));
  await until(() => jobs(K).filter((j) => j.state === 'sent').length === 2, 4000);
  const sale4 = await K.W.invoice(400, ''); await K.W.claim(sale4.hash);
  const f4 = await K.W.tillTipTaken({ amount: 20, unit: 'sat', mint: MINT, hash: sale4.hash });
  ok(f4.jobs === 2 && f4.waiting === 2, 'the next tip of 20: Ana 10, Ben 9 + 9 = 18 goes, Cy 1 + 1 = 2 still waits', JSON.stringify(f4));
  const benJob = jobs(K).find((j) => j.cid === ben.id) || {};
  ok(benJob.amount === 18, 'Ben’s payment carries what waited', String(benJob.amount));
  ok(K.W.tillTips.carry()[cy.id + '|sat|' + MINT] === 2 && !(ben.id + '|sat|' + MINT in K.W.tillTips.carry()), 'Cy’s waits on, Ben’s is cleared');
  await until(() => jobs(K).filter((j) => j.state === 'sent').length === 4, 4000);
  ok(deliveredTo(ben.to).length === 1 && deliveredTo(ana.to).length === 2 && deliveredTo(cy.to).length === 0, 'Ben paid once, Ana twice, Cy not yet');
  ok(logRow(K, (jobs(K).find((j) => j.cid === ben.id) || {}).payHash).memo === 'Tip to Ben', 'each a "Tip to <name>" row');

  // a group in dollars' cents: the smallest sent is a cent, so only a share of nothing waits
  const cents = T.split(grp([50, 45, 5]), 3);
  eq(cents.map((r) => r.amount), [2, 1, 0], '3 cents at 50/45/5: 2, 1, 0');

  /* ---- 5  the jobs: waiting, retrying, giving up ----------------------------------------------------- */
  K.W.tillTipsSet({ on: true, to: 'one', ids: [{ id: ben.id, name: 'Ben' }] });
  // another mint: waits, no try counted
  const fOther = await K.W.tillTipTaken({ amount: 30, unit: 'sat', mint: HOME, hash: 'sale-at-home' });
  await wait(150);
  const away = jobs(K).find((j) => j.sale === 'sale-at-home') || {};
  ok(fOther.jobs === 1 && away.state === 'due' && away.tries === 0, 'a tip landed at another mint waits for the phone to be there, counting nothing', JSON.stringify(away));
  // more than the balance: fails, is tried again, and goes once there is money
  const have = await K.W.balanceSats();
  const fBig = await K.W.tillTipTaken({ amount: have + 200, unit: 'sat', mint: MINT, hash: 'sale-big' });
  await until(() => (jobs(K).find((j) => j.sale === 'sale-big') || {}).tries >= 2, 3000);
  const big = jobs(K).find((j) => j.sale === 'sale-big') || {};
  ok(fBig.jobs === 1 && big.state === 'due' && big.tries >= 2 && !!big.why, 'a payment that fails is tried again a minute later (here 40 ms), its tries counted', JSON.stringify({ tries: big.tries, why: big.why }));
  await K.W.claim((await K.W.invoice(1000, '')).hash);
  await until(() => (jobs(K).find((j) => j.sale === 'sale-big') || {}).state !== 'due', 4000);
  ok((jobs(K).find((j) => j.sale === 'sale-big') || {}).state === 'sent', 'and goes once the balance covers it');
  // ten failures give up: the money stays and the sale's row says so
  const sale5 = await K.W.invoice(300, ''); await K.W.claim(sale5.hash);
  const bal5 = await K.W.balanceSats();
  await K.W.tillTipTaken({ amount: bal5 + 5000, unit: 'sat', mint: MINT, hash: sale5.hash });
  await until(() => (jobs(K).find((j) => j.sale === sale5.hash) || {}).state === 'failed', 6000);
  const gave = jobs(K).find((j) => j.sale === sale5.hash) || {};
  ok(gave.state === 'failed' && gave.tries === 9 && (await K.W.balanceSats()) === bal5, 'ten failures give up, and nothing left the balance', JSON.stringify({ state: gave.state, tries: gave.tries }));
  const row5 = logRow(K, sale5.hash) || {};
  ok(Array.isArray(row5.tillTipFailed) && row5.tillTipFailed[0] === 'Ben' && row5.tillTipLeft === bal5 + 5000, 'the sale’s row says Ben’s tip was not sent and is kept', JSON.stringify(row5));
  // a week old and still waiting: given up
  const rows = jobs(K);
  rows.forEach((j) => { if (j.sale === 'sale-at-home') j.at = Date.now() - 8 * 86400 * 1000; });
  K.put('foxy.till.tips.jobs', rows);
  await K.W.tillTips.run();
  ok((jobs(K).find((j) => j.sale === 'sale-at-home') || {}).state === 'failed', 'a job still waiting a week on is given up');
  // no route: waits, counting nothing
  K.W.tillTipsSet({ on: true, to: 'one', ids: [{ id: cy.id, name: 'Cy' }] });
  K.W._privacy({ tor: 'down', offline: true, network: 'none' });
  const fOff = await K.W.tillTipTaken({ amount: 25, unit: 'sat', mint: MINT, hash: 'sale-off' });
  await wait(150);
  const off = jobs(K).find((j) => j.sale === 'sale-off') || {};
  ok(fOff.jobs === 1 && off.state === 'due' && off.tries === 0, 'with no route it waits, counting nothing', JSON.stringify(off));
  K.W._privacy({ tor: 'up', offline: false, network: 'wifi', everUp: true, progress: 100 });
  await until(() => (jobs(K).find((j) => j.sale === 'sale-off') || {}).state === 'sent', 4000);
  ok((jobs(K).find((j) => j.sale === 'sale-off') || {}).state === 'sent', 'and goes when the route comes back');
  ok(jobs(K).every((j) => j.state !== 'due'), 'nothing is left due, so no timer is left running');

  /* ---- 6  the cashier --------------------------------------------------------------------------- */
  K.W.tillTipsSet({ on: false });
  const tipsBen = { on: true, to: 'one', ids: [{ id: ben.id, name: 'Ben' }] };
  const code = await K.W.tillPassMake({ fresh: true, tips: tipsBen, label: 'Front counter' });
  ok(code.tips === true && code.label === 'Front counter', 'a code made with tips says so, with its label', JSON.stringify({ tips: code.tips, label: code.label }));
  const pass = K.W.tillDecode(code.text);
  ok(pass && pass.tips === true, 'the pass carries tips: true');
  const raw = Buffer.from(code.text.split('#')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  ok(raw.indexOf(ben.id) < 0 && raw.indexOf('Ben') < 0 && raw.indexOf('foxyid') < 0 && raw.indexOf('Front') < 0,
    'and nothing else of them: no ID, no name, no label in the QR', raw.slice(0, 80));
  const row = K.store('foxy.till.passes', []).find((r) => r.id === code.id) || {};
  ok(row.tips && row.tips.to === 'one' && row.tips.ids[0].id === ben.id && row.label === 'Front counter', 'the keeper’s row of the code keeps who');
  const noTips = await K.W.tillPassMake({ fresh: true, tips: { on: false } });
  const passNo = K.W.tillDecode(noTips.text);
  ok(noTips.id !== code.id && passNo && passNo.tips === undefined && JSON.parse(Buffer.from(noTips.text.split('#')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).tips === undefined,
    'a code without tips carries no tips field at all, as before');
  const reqNo = Object.assign({}, pass, { tips: 'yes' });
  const enc = (o) => 'https://getfoxy.io/till#' + Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  ok(K.W.tillDecode(enc(reqNo)) === null, 'a tips field that is not true or false is not a code');

  await C.W.tillJoin(pass);
  const reqText = C.W.paymentRequest(60, { unit: 'sat', lockPub: pass.lock, purpose: 'till', tillTip: 10 });
  const req = C.W.decodeRequest(reqText) || {};
  ok((C.store('foxy.req.open', {})[req.id] || {}).tillTip === 10, 'a cashier’s request with a tip keeps it on the open request');
  const reqHuge = C.W.decodeRequest(C.W.paymentRequest(60, { unit: 'sat', lockPub: pass.lock, purpose: 'till', tillTip: 600 })) || {};
  ok((C.store('foxy.req.open', {})[reqHuge.id] || {}).tillTip === 60, 'never more than the request');
  const inv = await C.W.invoice(70, '', { lockPub: pass.lock, tillTip: 20 });
  const quote = (C.store('foxy.cashu.quotes', []) || []).find((q) => q.quote === inv.hash) || {};
  ok(quote.tillTip === 20 && quote.tillPass === pass.id, 'an invoice’s tip is on its quote’s record', JSON.stringify({ t: quote.tillTip }));

  relay = [];
  const pay = await P.W.sendToken(60, { unit: 'sat', lockTo: pass.lock });
  await C.W._requestPaid(JSON.stringify({ id: req.id, mint: MINT, unit: 'sat', proofs: proofsOf(P, pay.token) }), 'c1', '');
  const outRow = (C.store('foxy.till.outbox', []) || []).find((r) => r.hash === 'till-' + req.id) || {};
  ok(outRow.tip === 10 && outRow.amount === 60, 'the outbox row says 10 of its 60 was a tip', JSON.stringify({ tip: outRow.tip, amount: outRow.amount }));
  await until(() => relay.some((r) => r.target === pass.to), 3000);
  const sent = JSON.parse((relay.find((r) => r.target === pass.to) || {}).body || '{}');
  ok(sent.tip === 10 && sent.memo === 'till' && sent.proofs.length > 0, 'and the delivery to the keeper carries tip: 10', JSON.stringify({ tip: sent.tip }));

  // the keeper takes it and passes the tip on by its own row of the code
  relay = [];
  const kb = await K.W.balanceSats();
  ok((await K.W._tillArrived(pass.id, JSON.stringify(sent))) === 'taken', 'the keeper takes the cashier’s delivery');
  await until(() => jobs(K).some((j) => j.from === 'cashier' && j.state === 'sent'), 4000);
  const benTip = jobs(K).filter((j) => j.from === 'cashier' && j.cid === ben.id);
  ok(benTip.length === 1 && benTip[0].amount === 10 && benTip[0].state === 'sent', 'and sends Ben the 10', JSON.stringify(benTip.map((j) => [j.amount, j.state])));
  ok((await K.W.balanceSats()) === kb + 60 - 10, 'the keeper keeps 50 of the 60', String(await K.W.balanceSats()));
  // a delivery claiming more tip than it carries passes on no more than came in
  const pay2 = await P.W.sendToken(15, { unit: 'sat', lockTo: pass.lock });
  const greedy = { id: 'till:' + pass.id + ':9', mint: MINT, unit: 'sat', proofs: proofsOf(P, pay2.token), memo: 'till', tip: 9999 };
  ok((await K.W._tillArrived(pass.id, JSON.stringify(greedy))) === 'taken', 'a delivery that says its tip is 9,999 is taken');
  await wait(100);
  const greedyJob = jobs(K).filter((j) => j.from === 'cashier').slice(-1)[0] || {};
  ok(greedyJob.amount === 15, 'and passes on no more than the 15 that came', String(greedyJob.amount));
  // a code without tips: a tip it is told of is not passed on
  const pay3 = await P.W.sendToken(12, { unit: 'sat', lockTo: passNo.lock });
  const n0 = jobs(K).length;
  ok((await K.W._tillArrived(passNo.id, JSON.stringify({ id: 'till:' + passNo.id + ':1', mint: MINT, unit: 'sat', proofs: proofsOf(P, pay3.token), memo: 'till', tip: 5 }))) === 'taken'
    && jobs(K).length === n0, 'a code that takes no tips passes on none, whatever its delivery says');
  // a cashier on a code without tips makes no tip on a request
  await C.W.tillLeave();
  await C.W.tillJoin(passNo);
  const reqN = C.W.decodeRequest(C.W.paymentRequest(60, { unit: 'sat', lockPub: passNo.lock, purpose: 'till', tillTip: 10 })) || {};
  ok(!('tillTip' in (C.store('foxy.req.open', {})[reqN.id] || {})), 'a cashier on a code without tips carries none');
  await C.W.tillLeave();

  /* ---- 7  the list of codes ------------------------------------------------------------------------ */
  const list0 = K.W.tillPassList();
  ok(list0.live.length === 2 && list0.live.some((v) => v.id === code.id && v.label === 'Front counter' && v.tips.on && v.tips.names[0] === 'Ben' && v.text === code.text),
    'two cashier codes live at once, each with its label, its tips and its QR', JSON.stringify(list0.live.map((v) => [v.label, v.tips.on])));
  ok(list0.live.every((v) => !('total' in v) && !('taken' in v) && !('sum' in v)), 'and no figure of what any took');
  ok(K.W.tillPassEnd(code.id) === true && K.W.tillPassEnd(code.id) === false, 'END ends a live code, once');
  const list1 = K.W.tillPassList();
  const ended = list1.past.find((v) => v.id === code.id) || {};
  ok(!list1.live.some((v) => v.id === code.id) && ended.how === 'ended' && ended.endedAt > 0 && ended.text === '' && ended.made > 0,
    'it is under PAST, ended, with when it ran and no QR', JSON.stringify(ended));
  ok(K.store('foxy.till.passes', []).some((r) => r.id === code.id), 'its row and key stay: its cashier may still send what it took');
  ok((await K.W.tillPassMake()).id !== code.id, 'CASHIER CODE never answers an ended code again');
  // the code ended is still taken from, the keeper's money
  const pay4 = await P.W.sendToken(8, { unit: 'sat', lockTo: pass.lock });
  ok((await K.W._tillArrived(pass.id, JSON.stringify({ id: 'till:' + pass.id + ':20', mint: MINT, unit: 'sat', proofs: proofsOf(P, pay4.token), memo: 'till' }))) === 'taken',
    'what its cashier sends after END is still taken');
  // run out: PAST, expired
  const pr = K.store('foxy.till.passes', []);
  pr.forEach((r) => { if (r.id === noTips.id) r.exp = Math.floor(Date.now() / 1000) - 60; });
  K.put('foxy.till.passes', pr);
  const lg = K.store('foxy.till.passes.log', []);
  lg.forEach((r) => { if (r.id === noTips.id) r.exp = Math.floor(Date.now() / 1000) - 60; });
  K.put('foxy.till.passes.log', lg);
  const list2 = K.W.tillPassList();
  ok((list2.past.find((v) => v.id === noTips.id) || {}).how === 'expired', 'a code run out is under PAST, expired');
  ok(list2.past[0].until >= list2.past[list2.past.length - 1].until, 'PAST newest first');
  // eight at most at once, while none has run out
  const sNow = Math.floor(Date.now() / 1000);
  const keepRows = K.store('foxy.till.passes', []).filter((r) => r.exp > sNow);
  const base = keepRows[0];
  const fakes = Array.from({ length: 8 - keepRows.length }, (_, i) => Object.assign({}, base, { id: 'e' + String(i).repeat(15), made: Date.now() + i, endedAt: undefined }));
  K.put('foxy.till.passes', keepRows.concat(fakes));
  const ninth = await K.W.tillPassMake({ fresh: true }).then(() => '', (e) => e.message);
  ok(/8 cashier codes are out already/.test(ninth), 'a ninth while eight are out is refused, in words', ninth);
  // and the list survives the rows: a code dropped with its keys stays under PAST
  K.put('foxy.till.passes', []);
  ok(K.W.tillPassList().past.some((v) => v.id === code.id), 'the list outlives the rows and their keys');

  /* ---- 8  the object anything else reuses ---------------------------------------------------------------- */
  ok(['check', 'split', 'forward', 'jobs', 'carry', 'run'].every((k) => typeof K.W.tillTips[k] === 'function') && K.W.tillTips.MAX_IDS === 8
    && K.W.tillTips.MIN.sat === 10 && K.W.tillTips.MIN.usd === 1, 'tillTips: check, split, forward, jobs, carry, run, MAX_IDS 8, MIN 10 sats / 1 cent');
  const viaObj = K.W.tillTips.forward({ tips: { on: true, to: 'self' }, amount: 7, unit: 'sat', mint: MINT, hash: 'other-sale' });
  ok(viaObj.kept === 7, 'forward works the same from anything that calls it');
  ok(K.W.tillKeeperClose && (await K.W.tillKeeperClose()) && K.store('foxy.till.tips', null) === null, 'closing the till lets its answer go');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + (e && e.stack || e)); process.exit(1); });
