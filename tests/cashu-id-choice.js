'use strict';
/* cashu-id-choice.js — a payment to this phone's Foxy ID at a mint it does not use: the receiver's choice, and dollars.
 *
 *     node tests/cashu-id-choice.js
 *
 * The payer cannot know which mints the receiver uses, so the receiver decides (build/wallet/08e-cashu-id.js `cidForeign`,
 * docs/FOXY-ID.md "Receiving from a mint you don't use"). The way home is quoted first, and the delivery waits for a card:
 *
 *   C1  it waits, and the app is told once (`_onCashuIdOffer`) with what the card says: who, how much, where, the fee of
 *       BRING IT HOME, and whether SEND IT BACK can be offered; read again, the mint is not asked again
 *   C2  BRING IT HOME: taken there and crossed to the default mint; its row says the fee
 *   C3  the tick: the answer remembered for that mint (`foxy.cid.choice.<host>`) runs the next one with no card; listed and
 *       cleared (`cashuIdChoices`, `cashuIdChoiceClear`), after which the next one asks again
 *   C4  KEEP IT THERE: taken there, the mint listed as one this phone uses (and off `foxy.cid.brought`), and the next
 *       payment there taken with no card
 *   C5  SEND IT BACK: taken there and paid back to the payer's ID at the same mint, as a contact payment; only where the
 *       payer proved its ID and this phone knows where to send it; a pay-back that fails leaves it there, listed as used
 *   C6  too small to bring home: the card all the same, BRING IT HOME off with the reason, KEEP IT THERE still works
 *   C7  a way home that cannot be quoted: the card, BRING IT HOME off with why; a remembered BRING IT HOME takes nothing
 *   D1  dollars at Forge, the receiver at a sats-only mint (Minibits): melted into Lightning and landed as sats
 *   D2  dollars at Forge, the receiver at a mint that issues dollars (macadamia): landed as dollars
 *   D3  a dollar crossing that dies after the take (the melt quote does not come) is finished by `carryResume`, and one
 *       that dies after the melt (the claim does not come) by `finishMove`, in dollars
 *   D4  dollars too small to bring home: the card with BRING IT HOME off
 *
 * Pages on harness.js's fake mints, as tests/cashu-id.js runs them; the seed side is harness.js's second implementation of
 * CashuID.swift, the relays stubbed here. */
const H = require('./harness');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = H;

const FORGE = 'https://forge.test';        // the payer's mint: dollars and sats
const MINIBITS = 'https://minibits.test';  // a receiver's default mint: sats only
const MACA = 'https://macadamia.test';     // a receiver's default mint: dollars and sats
const PAYER_WORDS = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};
setTimeout(() => { console.log('WATCHDOG: a scenario never finished'); process.exit(2); }, 240000).unref();

const mints = {};
let relay = [];
// what a test makes a mint not answer: { host: [path, …] }, each taken once when it is asked
const deaf = {};
// a mint path that stays deaf until cleared, from the moment another path is asked: { host, after, path, on }
let deafAfter = null;

function page(words) {
  const phone = nativePhone({ words });
  const said = { asked: [], sign: 0 };
  const reply = (w, id, t, e) => setTimeout(() => w.FoxyWallet._scanResult(id, t, e), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const url = String(m.url || '');
        said.asked.push({ url, body: String(m.body || '') });
        const host = (/^https:\/\/([^/]+)/.exec(url) || [])[1] || '';
        const p = url.replace(/^https:\/\/[^/]+/, '');
        const once = deaf[host] || [];
        const at = once.indexOf(p);
        if (at >= 0) { once.splice(at, 1); return setTimeout(() => w.FoxyWallet._scanResult(m.id, null, 'did not answer'), 5); }
        if (deafAfter && deafAfter.host === host) {
          if (p === deafAfter.after) deafAfter.on = true;
          if (deafAfter.on && p === deafAfter.path) return setTimeout(() => w.FoxyWallet._scanResult(m.id, null, 'did not answer'), 5);
        }
        const mint = host === 'forge.test' ? mints.forge : host === 'minibits.test' ? mints.minibits : mints.maca;
        return reply(w, m.id, mint.handle(m));
      }
      if (m.action === 'nostrSend') { relay.push({ target: m.target, body: m.body }); return reply(w, m.id, '3'); }
      if (m.action === 'cashuIdInboxOpen' || m.action === 'cashuIdCopiesOpen') return reply(w, m.id, '1');
      if (m.action === 'cashuIdInboxClose') return reply(w, m.id, 'ok');
      if (m.action === 'cashuIdSign') said.sign += 1;
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!mints.forge) mints.forge = fakeMint(w, { p2pk: true, fill: 21, units: ['sat', 'usd'], quoteFrom: 10000 });
      if (!mints.minibits) mints.minibits = fakeMint(w, { p2pk: true, fill: 23, quoteFrom: 40000 });
      if (!mints.maca) mints.maca = fakeMint(w, { p2pk: true, fill: 25, units: ['sat', 'usd'], quoteFrom: 70000 });
    },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  // a payment's second wrap (to tomorrow's keys, 08e-cashu-id.js `cidAheadAll`) held an hour, so each case reads its own first
  ctx.W._cashuIdAheadMs = 3600000;
  ctx.W._cashuIdRetryMs = 40;
  ctx.said = said;
  ctx.store = (k, d) => { try { const v = JSON.parse(ctx.storage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  ctx.put = (k, v) => ctx.storage.setItem(k, JSON.stringify(v));
  ctx.offers = [];
  ctx.W._onCashuIdOffer = (v) => ctx.offers.push(v);
  return ctx;
}

const pile = (ctx, url, unit) => (ctx.store('foxy.cashu.proofs.' + url + (unit && unit !== 'sat' ? '@' + unit : ''), []) || [])
  .reduce((n, p) => n + Number(p.amount || 0), 0);
const logRows = (ctx) => ctx.store('foxy.cashu.log', []) || [];
const asked = (ctx, host) => ctx.said.asked.filter((x) => x.url.indexOf(host) >= 0).length;

async function run() {
  // the payer, Carol, at Forge with dollars and sats; her ID in use, so she names herself to those she pays
  const C = page(PAYER_WORDS);
  await C.W.connect(FORGE, { remember: true });
  await C.W.claim((await C.W.invoice(5000, '', { unit: 'usd' })).hash);
  await C.W.claim((await C.W.invoice(20000, '')).hash);
  const cId = await C.W.cashuIdMine();
  await C.W.cashuIdShown();
  // a stranger, Dan, at Forge, whose ID is not in use: he names himself to nobody
  const D = page(OTHER_WORDS);
  await D.W.connect(FORGE, { remember: true });
  await D.W.claim((await D.W.invoice(3000, '')).hash);

  /* Each receiver a phone of its own words: two phones of one seed at one mint would make the same outputs there, which
   * the mint refuses as signed already. Carol and Dan keep each as Alice; each keeps Carol. */
  const B39 = C.window.FoxyBip39;
  let first = true;
  const receiver = async (home) => {
    const R = page(first ? PHONE_WORDS : B39.generateMnemonic(B39.wordlist, 128));
    first = false;
    await R.W.connect(home, { remember: true });
    R.id = await R.W.cashuIdMine();
    await C.W.cashuIdAdd(R.id.text, 'Alice');
    await D.W.cashuIdAdd(R.id.text, 'Alice');
    await R.W.cashuIdAdd(cId.text, 'Carol');
    return R;
  };
  let to = null;
  const pay = async (P, amount, unit) => { relay = []; await P.W.cashuIdPay(to.id.text, amount, unit ? { unit } : {}); return relay[0].body; };

  /* ---- C1 / C2: the card, and BRING IT HOME ---- */
  console.log('C1, C2: the card, and BRING IT HOME');
  {
    const R = to = await receiver(MINIBITS);
    const body = await pay(C, 300);
    const b0 = Number(await R.W.balanceSats()) || 0;
    const got = await R.W._cashuIdArrived(body);
    ok(got === 'waiting', 'C1: a payment at a mint this phone does not use waits for its receiver', got);
    const v = R.offers[0] || {};
    ok(R.offers.length === 1 && v.name === 'Carol' && v.amount === 300 && v.host === 'forge.test' && v.unit === 'sat',
      'C1: the app is told once, with who, how much and where', JSON.stringify(R.offers));
    ok(v.lands > 0 && v.lands < 300 && v.fee > 0 && v.fee === 300 - v.lands && v.toUnit === 'sat' && !v.why,
      'C1: with the way home as quoted: what lands, and the fee', JSON.stringify({ lands: v.lands, fee: v.fee, why: v.why }));
    ok(v.back === true, 'C1: SEND IT BACK can be offered: Carol proved her ID, and she is a contact', String(v.back));
    ok((Number(await R.W.balanceSats()) || 0) === b0 && R.said.sign === 0 && pile(R, FORGE) === 0, 'C1: nothing was signed or taken, and nothing is in the balance');
    ok(R.W.cashuIdWaiting().length === 1 && !('body' in R.W.cashuIdWaiting()[0]), 'C1: listed for HISTORY, with no token');
    const n = asked(R, 'forge.test');
    ok((await R.W._cashuIdArrived(body)) === 'waiting' && asked(R, 'forge.test') === n && R.offers.length === 1,
      'C1: read again, the mint is not asked again and no second card is raised');
    const d = await R.W.cashuIdDecide(v.key, 'home', false);
    ok(d.state === 'taken', 'C2: BRING IT HOME takes it there and brings it home', JSON.stringify(d));
    const landed = (Number(await R.W.balanceSats()) || 0) - b0;
    ok(landed === v.lands, 'C2: what lands is what the card quoted', landed + ' / ' + v.lands);
    const row = logRows(R).filter((e) => e.dir === 'in' && e.mint === MINIBITS && /came home/.test(e.memo || ''))[0] || {};
    ok(/^From Carol, came home from forge\.test, fee \d+ sats?$/.test(row.memo || '') && row.cid === 'in', 'C2: its row at home: From Carol, came home from forge.test, fee …', row.memo);
    ok(R.W.cashuIdWaiting().length === 0 && R.W.cashuIdChoices().length === 0, 'C2: nothing waits, and nothing was remembered without the tick');
    ok((await R.W._cashuIdArrived(body)) === 'seen', 'C2: read again, it is taken already');

    /* ---- C3: the tick ---- */
    console.log('\nC3: the tick');
    const body2 = await pay(C, 200);
    ok((await R.W._cashuIdArrived(body2)) === 'waiting' && R.offers.length === 2, 'C3: the next one at forge.test asks again');
    const d2 = await R.W.cashuIdDecide(R.offers[1].key, 'home', true);
    ok(d2.state === 'taken' && R.store('foxy.cid.choice.forge.test', '') === 'home', 'C3: BRING IT HOME with the tick is remembered for forge.test', JSON.stringify(d2));
    const b1 = Number(await R.W.balanceSats()) || 0;
    const body3 = await pay(C, 250);
    ok((await R.W._cashuIdArrived(body3)) === 'taken' && R.offers.length === 2 && (Number(await R.W.balanceSats()) || 0) > b1,
      'C3: the one after comes home by itself, with no card');
    const list = R.W.cashuIdChoices();
    ok(list.length === 1 && list[0].host === 'forge.test' && list[0].choice === 'home', 'C3: the remembered answers are listed', JSON.stringify(list));
    ok(R.W.cashuIdChoiceClear('forge.test').length === 0 && !R.store('foxy.cid.choice.forge.test', ''), 'C3: and cleared');
    const body4 = await pay(C, 150);
    ok((await R.W._cashuIdArrived(body4)) === 'waiting' && R.offers.length === 3, 'C3: once cleared, the next one asks again');
  }

  /* ---- C4: KEEP IT THERE ---- */
  console.log('\nC4: KEEP IT THERE');
  {
    const R = to = await receiver(MINIBITS);
    const body = await pay(C, 400);
    ok((await R.W._cashuIdArrived(body)) === 'waiting', 'C4: it waits');
    const d = await R.W.cashuIdDecide(R.offers[0].key, 'keep', false);
    ok(d.state === 'there', 'C4: KEEP IT THERE takes it at forge.test', JSON.stringify(d));
    ok(pile(R, FORGE) >= 398 && pile(R, FORGE) <= 400 && R.W.mintUrl === MINIBITS, 'C4: the money is at forge.test, and the phone still at its own mint', String(pile(R, FORGE)));
    ok(R.W.mints().indexOf(FORGE) >= 0 && (R.store('foxy.cid.brought', []) || []).indexOf(FORGE) < 0, 'C4: forge.test is in the mint list, as a mint this phone uses', JSON.stringify(R.W.mints()));
    const row = logRows(R).filter((e) => e.dir === 'in' && e.mint === FORGE)[0] || {};
    ok(row.memo === 'From Carol' && row.cid === 'in', 'C4: its row: From Carol, at forge.test', JSON.stringify({ memo: row.memo, mint: row.mint }));
    const body2 = await pay(C, 120);
    ok((await R.W._cashuIdArrived(body2)) === 'taken' && R.offers.length === 1, 'C4: the next payment there is taken with no card');
    ok(R.W.cashuIdWaiting().length === 0, 'C4: and nothing waits');
  }

  /* ---- C5: SEND IT BACK ---- */
  console.log('\nC5: SEND IT BACK');
  {
    const R = to = await receiver(MINIBITS);
    const body = await pay(C, 500);
    ok((await R.W._cashuIdArrived(body)) === 'waiting' && R.offers[0].back === true, 'C5: it waits, and can be sent back');
    relay = [];
    const cBefore = Number(await C.W.balanceSats()) || 0;
    const d = await R.W.cashuIdDecide(R.offers[0].key, 'back', false);
    ok(d.state === 'back', 'C5: SEND IT BACK', JSON.stringify(d));
    const out = R.W.cashuIdOutbox();
    ok(out.length === 1 && out[0].contact === cId.id && out[0].mint === FORGE && out[0].amount >= 497 && out[0].amount <= 500 && out[0].sentAt,
      'C5: paid back to Carol at forge.test as a contact payment, less the mint’s own fee at most', JSON.stringify(out));
    const sent = logRows(R).filter((e) => e.dir === 'out' && e.mint === FORGE)[0] || {};
    ok(sent.memo === 'Sent back to Carol' && sent.cid === 'out', 'C5: its history row: Sent back to Carol', JSON.stringify({ memo: sent.memo }));
    const took = logRows(R).filter((e) => e.dir === 'in' && e.mint === FORGE)[0] || {};
    ok(took.memo === 'From Carol, sent back', 'C5: and the one it came in on: From Carol, sent back', took.memo);
    ok(R.W.mintUrl === MINIBITS && (R.store('foxy.cid.brought', []) || []).indexOf(FORGE) >= 0 && pile(R, FORGE) <= 3,
      'C5: the phone is home, forge.test is still not a mint it uses, and nothing is left there but a fee’s change', String(pile(R, FORGE)));
    const toCarol = relay.find((x) => /foxy-cashu-id"/.test(x.body) && !/copy/.test(x.body));
    ok(!!toCarol && (await C.W._cashuIdArrived(toCarol.body)) === 'taken' && (Number(await C.W.balanceSats()) || 0) - cBefore >= 497,
      'C5: and Carol’s phone takes it in, locked to her ID as any payment to it', toCarol ? '' : JSON.stringify(relay.map((x) => x.body.slice(0, 60))));
    ok(R.W.cashuIdWaiting().length === 0, 'C5: nothing waits');

    // a payer who did not say who it is: no SEND IT BACK
    const bodyD = await pay(D, 300);
    ok((await R.W._cashuIdArrived(bodyD)) === 'waiting', 'C5: a payment from an unnamed payer waits');
    const vD = R.offers[R.offers.length - 1];
    ok(vD.back === false && vD.name === '', 'C5: and cannot be sent back: no proved ID', JSON.stringify({ back: vD.back, name: vD.name }));
    const dD = await R.W.cashuIdDecide(vD.key, 'back', false);
    ok(dD.state === 'refused' && /did not say who it is/.test(dD.why) && R.W.cashuIdWaiting().length === 1, 'C5: SEND IT BACK is refused for it, and it still waits', JSON.stringify(dD));
    // a `from` naming Carol with a tag that is not hers: not believed
    const forged = JSON.stringify(Object.assign(JSON.parse(await pay(C, 210)), { tag: '00'.repeat(32) }));
    ok((await R.W._cashuIdArrived(forged)) === 'waiting', 'C5: one naming Carol without proving it waits');
    const vF = R.offers[R.offers.length - 1];
    ok(vF.back === false && vF.name === '', 'C5: and is neither Carol’s nor one to send back', JSON.stringify({ back: vF.back, name: vF.name }));
  }
  {
    // the pay-back fails after the take: the money stays there, the mint is listed as used, the row says so
    const R = to = await receiver(MINIBITS);
    const body = await pay(C, 300);
    await R.W._cashuIdArrived(body);
    const real = R.W.sendToken;
    R.W.sendToken = () => Promise.reject(new Error('the mint is busy'));
    const d = await R.W.cashuIdDecide(R.offers[0].key, 'back', false);
    R.W.sendToken = real;
    ok(d.state === 'there' && /busy/.test(d.why), 'C5: a pay-back that fails after the take: it stays at forge.test', JSON.stringify(d));
    ok(pile(R, FORGE) === 300 && R.W.mints().indexOf(FORGE) >= 0 && (R.store('foxy.cid.brought', []) || []).indexOf(FORGE) < 0,
      'C5: this phone’s, at a mint it now uses', String(pile(R, FORGE)));
    const row = logRows(R).filter((e) => e.dir === 'in' && e.mint === FORGE)[0] || {};
    ok(row.memo === 'From Carol, kept at forge.test: it could not be sent back', 'C5: its row says so', row.memo);
    ok(R.W.cashuIdOutbox().length === 0 && R.W.mintUrl === MINIBITS, 'C5: nothing went out, and the phone is home');
  }
  {
    // SEND IT BACK remembered: runs with no card
    const R = to = await receiver(MINIBITS);
    R.put('foxy.cid.choice.forge.test', 'back');
    const got = await R.W._cashuIdArrived(await pay(C, 260));
    ok(got === 'back' && R.offers.length === 0 && R.W.cashuIdOutbox().length === 1, 'C5: SEND IT BACK remembered for forge.test runs with no card', got);
    const gotD = await R.W._cashuIdArrived(await pay(D, 240));
    ok(gotD === 'waiting' && R.offers.length === 1, 'C5: but not for a payer it cannot send back to: the card asks', gotD);
  }

  /* ---- C6: too small to bring home ---- */
  console.log('\nC6: too small to bring home');
  {
    const R = to = await receiver(MINIBITS);
    const got = await R.W._cashuIdArrived(await pay(C, 6));
    const v = R.offers[0] || {};
    ok(got === 'waiting' && v.lands === 0 && v.small === true && /Too small to bring home/.test(v.why), 'C6: 6 sats wait, the card raised with BRING IT HOME off and why', JSON.stringify(v));
    ok(v.back === true, 'C6: SEND IT BACK still offered');
    const d = await R.W.cashuIdDecide(v.key, 'home', false);
    ok(d.state === 'waiting' && /Too small/.test(d.why) && R.W.cashuIdWaiting().length === 1, 'C6: BRING IT HOME, asked anyway, leaves it waiting with the reason', JSON.stringify(d));
    const k = await R.W.cashuIdDecide(v.key, 'keep', false);
    ok(k.state === 'there' && pile(R, FORGE) === 6 && R.W.cashuIdWaiting().length === 0, 'C6: KEEP IT THERE takes it', JSON.stringify(k));
  }
  {
    // remembered BRING IT HOME, too small: it waits quietly, and comes home with the next one there
    const R = to = await receiver(MINIBITS);
    R.put('foxy.cid.choice.forge.test', 'home');
    ok((await R.W._cashuIdArrived(await pay(C, 6))) === 'waiting' && R.offers.length === 0 && R.W.cashuIdWaiting().length === 1,
      'C6: with BRING IT HOME remembered, a small one waits with no card');
    const b0 = Number(await R.W.balanceSats()) || 0;
    ok((await R.W._cashuIdArrived(await pay(C, 40))) === 'taken' && R.W.cashuIdWaiting().length === 0 && (Number(await R.W.balanceSats()) || 0) > b0,
      'C6: and comes home with the next one there');
  }

  /* ---- C7: a way home that cannot be quoted ---- */
  console.log('\nC7: a way home that cannot be quoted');
  {
    const R = to = await receiver(MINIBITS);
    deaf['minibits.test'] = ['/v1/mint/quote/bolt11', '/v1/mint/quote/bolt11', '/v1/mint/quote/bolt11'];
    const got = await R.W._cashuIdArrived(await pay(C, 300));
    deaf['minibits.test'] = [];
    const v = R.offers[0] || {};
    ok(got === 'waiting' && v.lands === 0 && /could not be quoted/.test(v.why) && R.said.sign === 0, 'C7: the card, BRING IT HOME off, and why; nothing signed', JSON.stringify(v));
    const k = await R.W.cashuIdDecide(v.key, 'keep', false);
    ok(k.state === 'there' && pile(R, FORGE) === 300, 'C7: KEEP IT THERE still takes it', JSON.stringify(k));
    const R2 = to = await receiver(MINIBITS);
    R2.put('foxy.cid.choice.forge.test', 'home');
    deaf['minibits.test'] = ['/v1/mint/quote/bolt11', '/v1/mint/quote/bolt11', '/v1/mint/quote/bolt11'];
    const got2 = await R2.W._cashuIdArrived(await pay(C, 300));
    deaf['minibits.test'] = [];
    ok(got2 === 'refused' && R2.said.sign === 0 && R2.W.cashuIdWaiting().length === 0, 'C7: with BRING IT HOME remembered, nothing is taken or kept (the relays still hold it)', got2);
  }

  /* ---- D1: dollars at Forge, home at a mint of sats ---- */
  console.log('\nD1: dollars to sats');
  {
    const R = to = await receiver(MINIBITS);
    const got = await R.W._cashuIdArrived(await pay(C, 300, 'usd'));
    const v = R.offers[0] || {};
    ok(got === 'waiting' && v.unit === 'usd' && v.amount === 300 && v.toUnit === 'sat', 'D1: $3.00 at forge.test waits, to land as sats', JSON.stringify(v));
    ok(v.lands > 3700 && v.lands < 3902 && v.fee > 0 && v.fee < 20, 'D1: quoted: about 3,9xx sats less the fee, the fee in cents', JSON.stringify({ lands: v.lands, fee: v.fee }));
    const b0 = Number(await R.W.balanceSats()) || 0;
    const d = await R.W.cashuIdDecide(v.key, 'home', false);
    ok(d.state === 'taken', 'D1: BRING IT HOME', JSON.stringify(d));
    const landed = (Number(await R.W.balanceSats()) || 0) - b0;
    ok(landed === v.lands, 'D1: the sats quoted land at minibits.test', landed + ' / ' + v.lands);
    const row = logRows(R).filter((e) => e.dir === 'in' && e.mint === MINIBITS && /came home/.test(e.memo || ''))[0] || {};
    const words = 'From Carol, came home from forge.test as ' + landed.toLocaleString('en-US') + ' sats, fee $';
    ok(String(row.memo || '').indexOf(words) === 0 && /fee \$0\.\d\d$/.test(row.memo), 'D1: its row names what left and what landed: ' + words + '…', row.memo);
    ok(pile(R, FORGE, 'usd') <= 3 && pile(R, FORGE) === 0 && R.W.mintUrl === MINIBITS, 'D1: what is left at forge.test is a reserve’s change at most, and the phone is home',
      pile(R, FORGE, 'usd') + ' / ' + pile(R, FORGE));
    ok(!(R.store('foxy.cashu.carry', []) || []).length && !(R.store('foxy.cashu.move', null) || []).length, 'D1: no walk home or crossing left open');
  }

  /* ---- D2: dollars at Forge, home at a mint that issues dollars ---- */
  console.log('\nD2: dollars to dollars');
  {
    const R = to = await receiver(MACA);
    const got = await R.W._cashuIdArrived(await pay(C, 300, 'usd'));
    const v = R.offers[0] || {};
    ok(got === 'waiting' && v.unit === 'usd' && v.toUnit === 'usd' && v.lands > 280 && v.lands < 300 && v.fee === 300 - v.lands,
      'D2: $3.00 at forge.test, to land as dollars at macadamia.test', JSON.stringify(v));
    const u0 = R.W.balanceOf('usd', MACA) || 0;
    const d = await R.W.cashuIdDecide(v.key, 'home', false);
    const u1 = R.W.balanceOf('usd', MACA) || 0;
    ok(d.state === 'taken' && u1 - u0 === v.lands && pile(R, MACA) === 0, 'D2: the dollars land in macadamia.test’s dollars', JSON.stringify(d) + ' ' + (u1 - u0));
    const row = logRows(R).filter((e) => e.dir === 'in' && e.mint === MACA && /came home/.test(e.memo || ''))[0] || {};
    ok(/^From Carol, came home from forge\.test as \$2\.\d\d, fee \$0\.\d\d$/.test(row.memo || '') && row.unit === 'usd', 'D2: its row: … as $2.xx, fee $0.xx', JSON.stringify({ memo: row.memo, unit: row.unit }));
  }

  /* ---- D3: a dollar crossing cut short, finished later ---- */
  console.log('\nD3: cut short, finished later');
  {
    // after the take, the melt's quote does not come: `carryResume`
    const R = to = await receiver(MINIBITS);
    await R.W._cashuIdArrived(await pay(C, 300, 'usd'));
    const v = R.offers[0];
    deafAfter = { host: 'forge.test', after: '/v1/swap', path: '/v1/melt/quote/bolt11', on: false };
    const d = await R.W.cashuIdDecide(v.key, 'home', false);
    deafAfter = null;
    const jobs = R.store('foxy.cashu.carry', []) || [];
    ok(d.state === 'away' && jobs.length === 1 && jobs[0].unit === 'usd' && jobs[0].state === 'paid' && pile(R, FORGE, 'usd') === 300,
      'D3: taken at forge.test and not crossed: the dollars are this phone’s there, its walk home written down', JSON.stringify({ d, jobs, there: pile(R, FORGE, 'usd') }));
    const b0 = Number(await R.W.balanceSats()) || 0;
    await R.W.carryResume();
    const landed = (Number(await R.W.balanceSats()) || 0) - b0;
    ok(landed > 3700 && !(R.store('foxy.cashu.carry', []) || []).length && R.W.mintUrl === MINIBITS, 'D3: carryResume brings it home', String(landed));
    const row = logRows(R).filter((e) => e.dir === 'in' && e.mint === MINIBITS && /came home/.test(e.memo || ''))[0] || {};
    ok(/^From Carol, came home from forge\.test as [\d,]+ sats, fee \$0\.\d\d$/.test(row.memo || ''), 'D3: with its row', row.memo);
  }
  {
    // after the melt, the claim at home does not come: `finishMove`, in dollars
    const R = to = await receiver(MACA);
    await R.W._cashuIdArrived(await pay(C, 300, 'usd'));
    const v = R.offers[0];
    deaf['macadamia.test'] = ['/v1/mint/bolt11'];
    const d = await R.W.cashuIdDecide(v.key, 'home', false);
    deaf['macadamia.test'] = [];
    const notes = R.store('foxy.cashu.move', null) || [];
    ok(d.state === 'away' && notes.length === 1 && notes[0].unit === 'usd', 'D3: paid and not claimed: its crossing’s note says dollars', JSON.stringify({ d, notes }));
    const u0 = R.W.balanceOf('usd', MACA) || 0;
    await R.W.finishMove();
    const u1 = R.W.balanceOf('usd', MACA) || 0;
    ok(u1 - u0 === v.lands && !(R.store('foxy.cashu.carry', []) || []).length && !(R.store('foxy.cashu.move', null) || []).length,
      'D3: finishMove claims it in macadamia.test’s dollars, and nothing is left open', String(u1 - u0));
    const row = logRows(R).filter((e) => e.dir === 'in' && e.mint === MACA && /came home/.test(e.memo || ''))[0] || {};
    ok(/^From Carol, came home from forge\.test as \$2\.\d\d, fee \$0\.\d\d$/.test(row.memo || ''), 'D3: with its row', row.memo);
  }

  /* ---- D4: dollars too small ---- */
  console.log('\nD4: dollars too small');
  {
    const R = to = await receiver(MINIBITS);
    const got = await R.W._cashuIdArrived(await pay(C, 2, 'usd'));
    const v = R.offers[0] || {};
    ok(got === 'waiting' && v.unit === 'usd' && v.lands === 0 && v.small && /Too small/.test(v.why), 'D4: $0.02 waits, BRING IT HOME off', JSON.stringify(v));
    const k = await R.W.cashuIdDecide(v.key, 'keep', false);
    ok(k.state === 'there' && pile(R, FORGE, 'usd') === 2, 'D4: KEEP IT THERE takes the dollars there', JSON.stringify(k));
  }

  // the call other arrivals can use
  ok(typeof C.W.bringHome === 'function' && typeof C.W.bringHomeQuote === 'function', 'bringHome and bringHomeQuote are wallet calls');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
