'use strict';
/* till-wallet.js — point of sale, the wallet's half (build/wallet/08d-till.js).
 *
 *     node tests/till-wallet.js
 *
 * A keeper makes a CASHIER CODE; a cashier joins the till by it, and every
 * payment the cashier takes is locked to the keeper's key, kept in an outbox
 * (never in the cashier's pile) and sent to the keeper over Nostr; the keeper
 * takes what arrives into its own wallet. Three pages on harness.js's fake
 * mints: a keeper, a cashier, and a payer. The phone's side of the till
 * (tillKeyMake, tillKeyDrop, tillInboxOpen, tillInboxClose) and the relays
 * (nostrSend) are stubbed here; what goes over a relay is caught and handed
 * to the keeper as the phone would hand it (`_tillArrived`).
 *
 * The cashier's books are not judged by the harness: its till rows are the
 * keeper's money (`forKeeper`) and the harness's sum does not know that yet.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS, noBooks } = require('./harness');

const MINT = 'https://m.test';
const HOME = 'https://home.test';
// a third mint, issuing dollars as well, for a till at several mints
const USDM = 'https://usd.test';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PAYER_WORDS = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const URL0 = 'https://getfoxy.io/till#';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// waits until `fn` says yes, or `ms` have passed
const until = async (fn, ms) => { const end = Date.now() + (ms || 5000); while (Date.now() < end) { if (await fn()) return true; await wait(25); } return false; };

let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (good || detail === undefined ? '' : ' — ' + detail));
  if (good) passed += 1; else failed += 1;
};

const mints = {};
let relay = [];          // what went over Nostr: { target, body }
let relayDown = false;   // nostrSend refuses while true

function page(words) {
  const phone = nativePhone({ words });
  const said = { keyMake: [], keyDrop: [], open: [], since: [], close: 0, answers: [], mintCalls: [] };
  const reply = (w, id, t, e) => setTimeout(() => w.FoxyWallet._scanResult(id, t, e), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        const url = String(m.url || '');
        // any other host (x0.test …, for a till of eight) answered by a fake mint of its own, made the first time it is asked
        const host = new URL(url).host;
        const extra = /^x\d+\.test$/.test(host) ? (mints[host] || (mints[host] = fakeMint(w, { p2pk: true, fill: 13 + Number(host.slice(1, -5)), quoteFrom: 90000 }))) : null;
        const mint = extra || (url.indexOf('home.test') >= 0 ? mints.home : url.indexOf('usd.test') >= 0 ? mints.usd : mints.main);
        said.mintCalls.push(url);
        return reply(w, m.id, mint.handle(m));
      }
      // the code's id is the message's own, as FoxyBridge+Till.swift reads it, and the answer goes to it
      if (m.action === 'tillKeyMake') {
        said.keyMake.push(String(m.id));
        const tail = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.split('').sort(() => Math.random() - 0.5).join('');
        return reply(w, m.id, /^[0-9a-f]{16}$/.test(String(m.id)) ? 'nprofile1' + tail + tail : null, /^[0-9a-f]{16}$/.test(String(m.id)) ? undefined : 'That is not a cashier code.');
      }
      if (m.action === 'tillKeyDrop') { said.keyDrop.push(String(m.id)); return reply(w, m.id, 'ok'); }
      if (m.action === 'tillInboxOpen') { said.open.push(m.ids); said.since.push(m.since); return reply(w, m.id, String((m.ids || []).length)); }
      if (m.action === 'tillInboxClose') { said.close += 1; return reply(w, m.id, 'ok'); }
      if (m.action === 'nostrSend') {
        if (relayDown) return reply(w, m.id, null, 'no relay answered');
        relay.push({ target: m.target, body: m.body });
        return reply(w, m.id, '2');
      }
      if (m.action === 'inboxAnswer') { said.answers.push({ answer: m.answer, status: m.status, text: m.text }); return reply(w, m.id, ''); }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      if (!mints.main) mints.main = fakeMint(w, { p2pk: true });
      if (!mints.home) mints.home = fakeMint(w, { p2pk: true, fill: 9, quoteFrom: 50000 });
      if (!mints.usd) mints.usd = fakeMint(w, { p2pk: true, fill: 11, quoteFrom: 70000, units: ['sat', 'usd'] });
    },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._tillRetryMs = 40;
  ctx.said = said;
  ctx.phone = phone;
  ctx.store = (k, d) => { try { const v = JSON.parse(ctx.storage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
  return ctx;
}

// a token's proofs as plain JSON, as a payer's wallet would post them
function proofsOf(ctx, token) {
  const info = ctx.W.tokenInfo(token);
  return JSON.parse(JSON.stringify(info.proofs, (k, v) => (typeof v === 'bigint' ? Number(v)
    : (v && typeof v === 'object' && typeof v.toNumber === 'function' && !Array.isArray(v) ? v.toNumber() : v))));
}
const lockOf = (pr) => { try { return JSON.parse(pr.secret)[1].data; } catch (e) { return ''; } };
const bodyFor = (id, proofs, extra) => JSON.stringify(Object.assign({ id, mint: MINT, unit: 'sat', proofs }, extra || {}));

async function run() {
  const K = page(PHONE_WORDS);
  const C = page(OTHER_WORDS);
  const P = page(PAYER_WORDS);
  noBooks(C, 'a cashier’s till rows are the keeper’s money (forKeeper)');

  await K.W.connect(MINT, { remember: true });
  await C.W.connect(HOME, { remember: true });
  await P.W.connect(MINT, { remember: true });
  ok((await K.W.primeLocks()) > 0, 'the keeper derived lock keys');
  ok((await P.W.primeLocks()) > 0, 'the payer derived lock keys of its own');
  await P.W.claim((await P.W.invoice(2000, '')).hash);
  ok(P.W.balanceSats() === 2000 || (await P.W.balanceSats()) === 2000, 'the payer holds 2,000 sats');

  /* ---- the keeper makes a cashier code --------------------------------- */
  const made = await K.W.tillPassMake();
  ok(typeof made.text === 'string' && made.text.indexOf(URL0) === 0, 'tillPassMake answers the code as https://getfoxy.io/till#…', made.text && made.text.slice(0, 40));
  ok(/^[0-9a-f]{16}$/.test(made.id), 'with a 16-hex id', made.id);
  const nowS = Math.floor(Date.now() / 1000);
  ok(Math.abs(made.exp - (nowS + 72 * 3600)) <= 5, 'and it ends 72 hours from now', String(made.exp - nowS));
  ok(K.said.keyMake.length === 1 && K.said.keyMake[0] === made.id, 'the phone was asked to make the code’s Nostr key, by the code’s id', JSON.stringify(K.said.keyMake));
  const pass = K.W.tillDecode(made.text);
  ok(!!pass && pass.v === 1 && pass.id === made.id && pass.mint === MINT && pass.unit === 'sat', 'the code decodes to its pass', JSON.stringify(pass));
  const rows = K.store('foxy.till.passes', []);
  ok(rows.length === 1 && rows[0].id === made.id && rows[0].lock === pass.lock && rows[0].lockId === 'till-' + made.id && rows[0].to === pass.to,
    'the pass row is kept with its lock, lock id and Nostr key', JSON.stringify(rows[0] || {}).slice(0, 120));
  const lockRows = K.store('foxy.req.lockkeys', {});
  ok(lockRows['till-' + made.id] && lockRows['till-' + made.id].pub === pass.lock && Number.isInteger(lockRows['till-' + made.id].i),
    'its lock is a seed-derived key on a row named till-<id>');
  ok(K.W.classify(made.text) === 'till', 'classify says till');
  ok(K.W.tillProblem(made.text) === '', 'tillProblem says nothing about a good code');
  ok(K.W.tillPasses().length === 1 && K.W.tillPasses()[0].text === made.text, 'tillPasses lists it, with its text');
  await wait(30);
  ok(K.said.open.length >= 1 && K.said.open[K.said.open.length - 1].indexOf(made.id) >= 0, 'and the phone is told to listen on it', JSON.stringify(K.said.open));
  ok(JSON.stringify(rows[0]).indexOf('privkey') < 0 && !/"key"/.test(JSON.stringify(rows[0])), 'no private key is in the page for it');

  /* ---- decoding: malformed codes are null, never a throw ----------------- */
  const enc = (o) => URL0 + Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const good = Object.assign({}, pass);
  ok(!!K.W.tillDecode(enc(good)), 'a pass built by hand from the same fields decodes');
  const bad = [
    Object.assign({}, good, { v: 2 }), Object.assign({}, good, { id: 'abc' }), Object.assign({}, good, { id: good.id.toUpperCase() }),
    Object.assign({}, good, { mint: 'http://m.test' }), Object.assign({}, good, { mint: 'ftp://x' }), Object.assign({}, good, { unit: 'eur' }),
    Object.assign({}, good, { lock: '04' + good.lock.slice(2) }), Object.assign({}, good, { lock: good.lock.slice(0, 60) }),
    Object.assign({}, good, { to: 'npub1' + 'q'.repeat(50) }), Object.assign({}, good, { to: 'nprofile1BAD' }),
    Object.assign({}, good, { exp: nowS - 1 }), Object.assign({}, good, { exp: nowS + 30 * 24 * 3600 }), Object.assign({}, good, { exp: String(good.exp) }),
    Object.assign({}, good, { exp: good.exp + 0.5 }), [], null, 'text', 7,
  ];
  ok(bad.every((b) => K.W.tillDecode(enc(b)) === null), 'each hand-broken pass decodes to null', bad.map((b) => !!K.W.tillDecode(enc(b))).join(','));
  ok(/expired/.test(K.W.tillProblem(enc(Object.assign({}, good, { exp: nowS - 60 })))), 'an ended code is said to have expired');
  ok(K.W.tillDecode(made.text + 'A'.repeat(2100)) === null, 'a code longer than 2,048 characters is null');
  ok(K.W.tillDecode('till:' + made.text.slice(URL0.length)) === null && K.W.tillDecode(made.text.replace('https://', 'http://')) === null,
    'only the https://getfoxy.io/till# form is read');
  let threw = 0, nonNull = 0;
  const rnd = (n) => { let s = ''; const cs = 'abcdefABCDEF0123456789-_+/=#{}":,'; for (let i = 0; i < n; i++) s += cs[Math.floor(Math.random() * cs.length)]; return s; };
  for (let i = 0; i < 400; i++) {
    let t;
    const k = i % 4;
    if (k === 0) t = URL0 + rnd(Math.floor(Math.random() * 300));
    else if (k === 1) { const cut = made.text.slice(0, URL0.length + Math.floor(Math.random() * (made.text.length - URL0.length))); t = cut; }
    else if (k === 2) { const a = made.text.split(''); const at = URL0.length + Math.floor(Math.random() * (a.length - URL0.length)); a[at] = rnd(1); t = a.join(''); }
    else {
      const o = Object.assign({}, good);
      const f = ['v', 'id', 'mint', 'unit', 'lock', 'to', 'exp'][i % 7];
      o[f] = [null, 0, -1, '', 'x', [], {}, true, 1e308, 'https://', good.lock + 'a'][Math.floor(Math.random() * 11)];
      t = enc(o);
    }
    try { const d = K.W.tillDecode(t); if (d && t !== made.text) nonNull += (k === 2 ? 0 : 1); } catch (e) { threw += 1; }
    try { K.W.tillProblem(t); K.W.classify(t); } catch (e) { threw += 1; }
  }
  ok(threw === 0, 'four hundred malformed codes: nothing throws', String(threw));
  ok(nonNull === 0, 'and none of the truncated or field-broken ones decodes', String(nonNull));
  ok(K.W.classify('cashuA' + 'x'.repeat(30)) === 'token' && K.W.classify('lnbc10n1' + 'q'.repeat(30)) === 'invoice', 'classify still names tokens and invoices');

  /* ---- the cashier joins ----------------------------------------------- */
  ok(C.W.tillCashier() === null, 'a phone not in a till has no cashier row');
  let joinBad = '';
  try { await C.W.tillJoin(Object.assign({}, pass, { exp: nowS - 5 })); } catch (e) { joinBad = e.message; }
  ok(/expired/.test(joinBad), 'an ended pass is refused at join', joinBad);
  const joined = await C.W.tillJoin(pass);
  ok(joined && joined.pass.id === pass.id && joined.since > 0, 'tillJoin answers the till');
  ok(C.W.mintUrl === MINT, 'and the cashier is at the code’s mint', C.W.mintUrl);
  ok((C.store('foxy.till.home', {}) || {}).mint === HOME, 'the mint it banks at is kept', JSON.stringify(C.store('foxy.till.home', null)));
  ok(String(C.store('foxy.cashu.mint', '')) === HOME, 'and stays the mint on file, so a relaunch is home', String(C.store('foxy.cashu.mint', '')));
  ok(C.W.tillCashier() && C.W.tillCashier().pass.lock === pass.lock, 'tillCashier answers the pass');
  const again = await C.W.tillJoin(made.text);
  ok(again.since === joined.since && (C.store('foxy.till.home', {}) || {}).mint === HOME, 'joining again by the text keeps the start and the home');

  /* ---- a till request ---------------------------------------------------- */
  const poolBefore = JSON.stringify(C.store('foxy.req.lockpool', []));
  const keysBefore = JSON.stringify(C.store('foxy.req.lockkeys', {}));
  const reqText = C.W.paymentRequest(21, { unit: 'sat', lockPub: pass.lock, purpose: 'till' });
  const req = C.W.decodeRequest(reqText) || {};
  ok(!!reqText && req.lockTo === pass.lock, 'a till request carries the keeper’s lock', String(req.lockTo));
  const open = C.store('foxy.req.open', {})[req.id] || {};
  ok(open.purpose === 'till' && open.tillLock === pass.lock && open.tillPass === pass.id && open.tillTo === pass.to, 'and is open with purpose till and where to send', JSON.stringify(open));
  ok(JSON.stringify(C.store('foxy.req.lockpool', [])) === poolBefore && JSON.stringify(C.store('foxy.req.lockkeys', {})) === keysBefore,
    'no key of the cashier’s is taken or filed for it');
  ok(C.W.paymentRequest(21, { unit: 'sat', lockPub: '02' + 'ab'.repeat(32) }) === '', 'a request with any other key is not made');
  ok(C.W.paymentRequest(21, { unit: 'usd', lockPub: pass.lock }) === '', 'nor one in the other unit');

  const paidSaid = [];
  C.W.onRequestPaid((x) => paidSaid.push(x));
  const pileBefore = await C.W.balanceSats();
  const send21 = await P.W.sendToken(21, { unit: 'sat', lockTo: pass.lock });
  const proofs21 = proofsOf(P, send21.token);
  ok(proofs21.every((pr) => lockOf(pr) === pass.lock), 'the payer’s ecash is locked to the keeper');
  relay = [];
  await C.W._requestPaid(bodyFor(req.id, proofs21), 'a1', '');
  const ans1 = C.said.answers.find((a) => a.answer === 'a1') || {};
  ok(ans1.status === 200, 'an exact locked payment is answered 200', JSON.stringify(ans1));
  ok(paidSaid.some((x) => x.stage === 'paid' && x.amount === 21 && x.purpose === 'till'), 'and the screen is told paid, 21', JSON.stringify(paidSaid.map((x) => x.stage)));
  ok((await C.W.balanceSats()) === pileBefore, 'nothing went into the cashier’s pile');
  let out = C.store('foxy.till.outbox', []);
  ok(out.length === 1 && out[0].amount === 21 && out[0].passId === pass.id && out[0].to === pass.to && out[0].proofs.length === proofs21.length,
    'one outbox row, 21, for the keeper', JSON.stringify(out.map((r) => [r.amount, r.passId])));
  let hist = C.store('foxy.cashu.log', []);
  const row1 = hist.find((e) => e.hash === 'till-' + req.id) || {};
  ok(row1.dir === 'in' && row1.sats === 21 && row1.till === true && row1.who === 'cashier' && row1.forKeeper === true,
    'one history row: in, 21, till, cashier, the keeper’s', JSON.stringify(row1));
  ok(!(req.id in C.store('foxy.req.open', {})), 'and the request is closed');
  await wait(60);
  out = C.store('foxy.till.outbox', []);
  ok(relay.length === 1 && relay[0].target === pass.to, 'it went to the keeper’s Nostr key at once', JSON.stringify(relay.map((r) => r.target.slice(0, 12))));
  const sent1 = relay[0] ? JSON.parse(relay[0].body) : {};
  ok(sent1.id === 'till:' + pass.id + ':1' && sent1.mint === MINT && sent1.unit === 'sat' && sent1.memo === 'till' && sent1.proofs.length === proofs21.length,
    'as a NUT-18 payment named till:<id>:<n>', JSON.stringify({ id: sent1.id, mint: sent1.mint }));
  ok(out[0] && out[0].sentAt > 0, 'the row is marked sent');
  hist = C.store('foxy.cashu.log', []);
  ok((hist.find((e) => e.hash === 'till-' + req.id) || {}).tillSent === true, 'and its history row says sent');

  // the same payment again, to a new request
  const req2 = C.W.decodeRequest(C.W.paymentRequest(21, { unit: 'sat', lockPub: pass.lock })) || {};
  await C.W._requestPaid(bodyFor(req2.id, proofs21), 'a2', '');
  const ans2 = C.said.answers.find((a) => a.answer === 'a2') || {};
  ok(ans2.status === 409 && /already/.test(ans2.text), 'the same ecash a second time is refused as taken already', JSON.stringify(ans2));

  // refusals, each with nothing kept
  const outN = () => C.store('foxy.till.outbox', []).length;
  const n0 = outN();
  const plain = await P.W.sendToken(21, { unit: 'sat' });
  const req3 = C.W.decodeRequest(C.W.paymentRequest(21, { unit: 'sat', lockPub: pass.lock })) || {};
  await C.W._requestPaid(bodyFor(req3.id, proofsOf(P, plain.token)), 'a3', '');
  const ans3 = C.said.answers.find((a) => a.answer === 'a3') || {};
  ok(ans3.status === 422 && /not locked to the keeper/.test(ans3.text), 'unlocked ecash is refused', JSON.stringify(ans3));
  ok(paidSaid.some((x) => x.stage === 'failed' && x.id === req3.id && /not locked/.test(x.refused || '')), 'and the screen is told it failed');

  const own = P.W.decodeRequest(P.W.paymentRequest(21, { purpose: 'receive' })) || {};
  ok(!!own.lockTo && own.lockTo !== pass.lock, 'the payer has a key of its own');
  const elsewhere = await P.W.sendToken(21, { unit: 'sat', lockTo: own.lockTo });
  await C.W._requestPaid(bodyFor(req3.id, proofsOf(P, elsewhere.token)), 'a4', '');
  const ans4 = C.said.answers.find((a) => a.answer === 'a4') || {};
  ok(ans4.status === 422 && /not locked to the keeper/.test(ans4.text), 'ecash locked to another key is refused', JSON.stringify(ans4));

  const send25 = await P.W.sendToken(25, { unit: 'sat' });
  const p25 = proofsOf(P, send25.token);
  await C.W._requestPaid(bodyFor(req3.id, p25), 'a5', '');
  const ans5 = C.said.answers.find((a) => a.answer === 'a5') || {};
  ok(ans5.status === 422 && /cannot give change/.test(ans5.text), 'a plain over-payment the payer did not mark is refused, still the payer’s', JSON.stringify(ans5));

  C.W._privacy({ tor: 'connecting', progress: 40, everUp: true });
  const send21b = await P.W.sendToken(21, { unit: 'sat', lockTo: pass.lock });
  const p21b = proofsOf(P, send21b.token);
  await C.W._requestPaid(bodyFor(req3.id, p21b), 'a6', '');
  const ans6 = C.said.answers.find((a) => a.answer === 'a6') || {};
  ok(ans6.status === 422 && /needs a connection/.test(ans6.text), 'with no route, a till takes nothing', JSON.stringify(ans6));
  C.W._privacy({ tor: 'up', progress: 100, everUp: true });

  // spent: the keeper, which holds the key, swaps it in first
  const send21c = await P.W.sendToken(21, { unit: 'sat', lockTo: pass.lock });
  await K.W.receiveToken(send21c.token);
  ok(!!K.store('foxy.req.lockkeys', {})['till-' + pass.id], 'a token locked to a code’s key, taken in the ordinary way, leaves the code’s lock row');
  await C.W._requestPaid(bodyFor(req3.id, proofsOf(P, send21c.token)), 'a7', '');
  const ans7 = C.said.answers.find((a) => a.answer === 'a7') || {};
  ok(ans7.status === 409 && /spent/.test(ans7.text), 'ecash already spent is refused, as not confirmed (409)', JSON.stringify(ans7));
  ok(outN() === n0, 'none of those refusals put anything in the outbox', outN() + ' vs ' + n0);

  /* Over, unmarked, and locked to the keeper: a refusal would strand it (the payer cannot spend it back), so it is taken
   * whole into the outbox, its row saying what came, as the keeper's own till takes one at another mint (below). */
  const reqOver = C.W.decodeRequest(C.W.paymentRequest(21, { unit: 'sat', lockPub: pass.lock })) || {};
  const lock25 = proofsOf(P, (await P.W.sendToken(25, { unit: 'sat', lockTo: pass.lock })).token);
  await C.W._requestPaid(bodyFor(reqOver.id, lock25), 'a5l', '');
  const ans5l = C.said.answers.find((a) => a.answer === 'a5l') || {};
  const rowOverC = C.store('foxy.till.outbox', []).find((r) => r.hash === 'till-' + reqOver.id) || {};
  ok(ans5l.status === 200 && rowOverC.amount === 25 && outN() === n0 + 1,
    'a locked over-payment is taken whole for the keeper, the outbox row saying 25, never refused and stranded', JSON.stringify([ans5l, rowOverC.amount]));

  // the over-payment, marked: taken, no change
  const p25m = proofsOf(P, (await P.W.sendToken(25, { unit: 'sat', lockTo: pass.lock })).token);
  await C.W._requestPaid(bodyFor(req3.id, p25m, { overpaid: true }), 'a8', '');
  const ans8 = C.said.answers.find((a) => a.answer === 'a8') || {};
  ok(ans8.status === 200 && outN() === n0 + 2, 'an over-payment the payer marked is taken, whole', JSON.stringify(ans8));
  await wait(60);

  /* ---- delivery: sent only on success, tried again ------------------------ */
  relayDown = true;
  const req4 = C.W.decodeRequest(C.W.paymentRequest(21, { unit: 'sat', lockPub: pass.lock })) || {};
  await C.W._requestPaid(bodyFor(req4.id, p21b), 'a9', '');
  await wait(30);
  let row4 = C.store('foxy.till.outbox', []).find((r) => r.hash === 'till-' + req4.id) || {};
  ok(row4.amount === 21 && !row4.sentAt && Number(row4.tries) >= 1, 'a send no relay took is not marked sent, and counts a try', JSON.stringify({ s: row4.sentAt, t: row4.tries }));
  ok((C.store('foxy.cashu.log', []).find((e) => e.hash === 'till-' + req4.id) || {}).tillSent === false, 'its row still says not sent');
  await wait(120);
  row4 = C.store('foxy.till.outbox', []).find((r) => r.hash === 'till-' + req4.id) || {};
  ok(Number(row4.tries) >= 2, 'and it is tried again by itself', String(row4.tries));
  relayDown = false;
  await wait(150);
  row4 = C.store('foxy.till.outbox', []).find((r) => r.hash === 'till-' + req4.id) || {};
  ok(row4.sentAt > 0, 'once a relay answers it is sent');
  const relayed = relay.length;
  await wait(150);
  ok(relay.length === relayed, 'and with nothing left to send nothing more is sent (no poller left running)', relay.length + ' vs ' + relayed);

  /* ---- a till invoice ---------------------------------------------------- */
  let invBad = '';
  try { await C.W.invoice(13, '', { unit: 'sat', lockPub: '03' + 'cd'.repeat(32) }); } catch (e) { invBad = e.message; }
  ok(/not the till/.test(invBad), 'an invoice locked to any other key is refused', invBad);
  const pileB = await C.W.balanceSats();
  const outB = outN();
  const inv = await C.W.invoice(13, '', { unit: 'sat', lockPub: pass.lock });
  const qrec = (C.store('foxy.cashu.quotes', []).find((q) => q.quote === inv.hash) || {});
  ok(qrec.lockPub === pass.lock && qrec.till === true && qrec.tillTo === pass.to && qrec.tillPass === pass.id, 'the invoice’s record names the keeper’s lock', JSON.stringify(qrec).slice(0, 160));
  const got13 = await C.W.claim(inv.hash);
  ok(got13 === 13, 'claimed, it resolves the amount', String(got13));
  ok((await C.W.balanceSats()) === pileB, 'and nothing is in the cashier’s pile');
  const row13 = C.store('foxy.till.outbox', []).find((r) => r.hash === inv.hash) || {};
  ok(outN() === outB + 1 && row13.amount === 13, 'one outbox row, 13');
  ok((row13.proofs || []).length > 0 && row13.proofs.every((pr) => lockOf(pr) === pass.lock), 'every piece minted is locked to the keeper');
  const h13 = C.store('foxy.cashu.log', []).filter((e) => e.hash === inv.hash);
  ok(h13.length === 1 && h13[0].till === true && h13[0].forKeeper === true && h13[0].sats === 13, 'one history row, the keeper’s', JSON.stringify(h13));
  ok(!C.store('foxy.cashu.quotes', []).some((q) => q.quote === inv.hash), 'and the quote’s record is gone');
  const again13 = await C.W.claim(inv.hash);
  ok(again13 === 13 && outN() === outB + 1, 'a claim a moment later is told it landed, and adds nothing');

  // a claim whose answer is lost: the outputs were on the record first, and are rebuilt
  const inv2 = await C.W.invoice(8, '', { unit: 'sat', lockPub: pass.lock });
  mints.main.dropAnswerOf('mint');
  let lost = '';
  try { await C.W.claim(inv2.hash); } catch (e) { lost = e.message || String(e); }
  const rec2 = C.store('foxy.cashu.quotes', []).find((q) => q.quote === inv2.hash) || {};
  ok(!!lost && Array.isArray(rec2.tillLocked) && rec2.tillLocked.length > 0, 'a lost answer leaves its locked outputs on the record', lost.slice(0, 60));
  const got8 = await C.W.claim(inv2.hash);
  const row8 = C.store('foxy.till.outbox', []).find((r) => r.hash === inv2.hash) || {};
  ok(got8 === 8 && row8.amount === 8 && row8.proofs.every((pr) => lockOf(pr) === pass.lock), 'and the next claim rebuilds them for the keeper', String(got8));
  await wait(60);

  /* ---- a token scanned at the till ---------------------------------------- */
  const scan = await P.W.sendToken(9, { unit: 'sat', lockTo: pass.lock });
  const took = await C.W.tillTakeToken(scan.token);
  ok(took && took.till === true && took.amount === 9, 'a locked token scanned at the till is taken for the keeper', JSON.stringify(took));
  ok(C.store('foxy.till.outbox', []).some((r) => r.hash === took.hash), 'into the outbox');
  let scanTwice = '';
  try { await C.W.tillTakeToken(scan.token); } catch (e) { scanTwice = e.message; }
  ok(/already/.test(scanTwice), 'and not twice', scanTwice);
  const scanPlain = await P.W.sendToken(5, { unit: 'sat' });
  let scanNo = '';
  try { await C.W.tillTakeToken(scanPlain.token); } catch (e) { scanNo = e.message; }
  ok(/not locked to the keeper/.test(scanNo), 'an unlocked token is refused at the till', scanNo);
  ok((await C.W.balanceSats()) === pileB, 'still nothing in the cashier’s pile');
  await wait(60);

  /* ---- the keeper takes what arrives ---------------------------------------- */
  const kBefore = await K.W.balanceSats();
  const first = relay.find((r) => JSON.parse(r.body).id === 'till:' + pass.id + ':1');
  const t1 = await K.W._tillArrived(pass.id, first.body);
  ok(t1 === 'taken', 'the keeper takes a delivery', t1);
  ok((await K.W.balanceSats()) === kBefore + 21, 'into its own pile', (await K.W.balanceSats()) + ' vs ' + kBefore);
  const kRow = K.store('foxy.cashu.log', []).find((e) => e.till === true) || {};
  ok(kRow.dir === 'in' && kRow.who === 'cashier' && kRow.sats === 21, 'with a history row tagged till, cashier', JSON.stringify(kRow));
  ok(!!K.store('foxy.req.lockkeys', {})['till-' + pass.id], 'and the code’s lock row is kept for the next payment');
  ok(K.store('foxy.till.seen', []).length === JSON.parse(first.body).proofs.length, 'its secrets are noted');
  ok((await K.W._tillArrived(pass.id, first.body)) === 'seen', 'the same delivery read again is taken once');
  ok((await K.W.balanceSats()) === kBefore + 21, 'and the balance is unchanged by it');
  const firstJ = JSON.parse(first.body);
  ok((await K.W._tillArrived('0123456789abcdef', first.body)) === 'refused', 'a delivery for a code it never made is refused');
  ok((await K.W._tillArrived(pass.id, JSON.stringify(Object.assign({}, firstJ, { mint: HOME })))) === 'refused', 'one at another mint is refused');
  const ownK = await P.W.sendToken(4, { unit: 'sat', lockTo: own.lockTo });
  ok((await K.W._tillArrived(pass.id, bodyFor('till:x:9', proofsOf(P, ownK.token)))) === 'refused', 'one locked to another key is refused');
  ok((await K.W._tillArrived(pass.id, 'not json')) === 'refused', 'and something that is not a payment');

  // at another mint, with a route: taken at the code's mint by a wallet made for it, the phone staying where it is
  const second = relay.find((r) => JSON.parse(r.body).id === 'till:' + pass.id + ':2');
  await K.W.connect(HOME, { remember: true });
  const atMintBefore = K.W.balanceAt(MINT);
  const homeBefore = await K.W.balanceSats();
  ok((await K.W._tillArrived(pass.id, second.body)) === 'taken', 'a delivery while the keeper is at another mint is taken at the code’s mint');
  ok(K.W.mintUrl === HOME && K.W.balanceAt(MINT) === atMintBefore + 25 && (await K.W.balanceSats()) === homeBefore,
    'into that mint’s pile, the phone not moving and its own balance as it was', K.W.balanceAt(MINT) + ' vs ' + atMintBefore);
  // and with no route: kept, and taken on the next listen once there is one
  const third = relay.find((r) => JSON.parse(r.body).id === 'till:' + pass.id + ':3');
  K.W._privacy({ tor: 'connecting', progress: 40, everUp: true });
  ok((await K.W._tillArrived(pass.id, third.body)) === 'kept', 'a delivery with no route is kept');
  ok(K.store('foxy.till.inbox', []).length === 1, 'in the till’s inbox');
  K.W._privacy({ tor: 'up', progress: 100, everUp: true });
  await K.W.connect(MINT, { remember: true });
  const kMid = await K.W.balanceSats();
  const thirdSum = JSON.parse(third.body).proofs.reduce((n, pr) => n + Number(pr.amount), 0);
  await K.W.tillListen();
  await wait(50);
  ok(K.store('foxy.till.inbox', []).length === 0 && (await K.W.balanceSats()) === kMid + thirdSum, 'and taken on the next listen with a route',
    (await K.W.balanceSats()) + ' vs ' + kMid + ' + ' + thirdSum + ', inbox ' + K.store('foxy.till.inbox', []).length);
  const opens = K.said.open.length;
  await K.W.tillListen();
  ok(K.said.open.length === opens + 1 && K.said.open[K.said.open.length - 1].length === 1, 'listening asks the phone for the code’s inbox each time');
  ok((await K.W.tillHush()) === true && K.said.close >= 1, 'tillHush closes them');

  /* ---- review w4: the relays are asked from the code's start ---------------- */
  const kRows = K.store('foxy.till.passes', []);
  const wantSince = Math.floor(Math.min(...kRows.map((r) => r.made)) / 1000) - 2 * 86400;
  ok(K.said.since[K.said.since.length - 1] === wantSince, 'tillInboxOpen names since: the oldest listened code’s start less two days',
    K.said.since[K.said.since.length - 1] + ' vs ' + wantSince);

  /* ---- review w3: what anybody who has seen the QR code can send ------------- */
  const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const realKeyset = firstJ.proofs[0].id;
  const forged = (n, kid) => Array.from({ length: n }, () => ({
    id: kid || realKeyset, amount: 1, C: '02' + hex(64),
    secret: JSON.stringify(['P2PK', { nonce: hex(64), data: pass.lock, tags: [] }]),
  }));
  let mintAsked = K.said.mintCalls.length;
  ok((await K.W._tillArrived(pass.id, bodyFor('till:x:1', forged(3)))) === 'refused' && K.said.mintCalls.length === mintAsked,
    'ecash locked to the code’s key that the mint never signed is refused, and the mint is not asked', String(K.said.mintCalls.length - mintAsked));
  const unsigned = JSON.parse(second.body).proofs.map((pr) => Object.assign({}, pr, { dleq: undefined }));
  ok((await K.W._tillArrived(pass.id, bodyFor('till:x:2', unsigned))) === 'refused', 'and real pieces with their DLEQ taken off are refused too');
  ok((await K.W._tillArrived(pass.id, bodyFor('till:x:3', forged(3, '00ffeeddccbbaa99')))) === 'refused', 'as are pieces of a keyset the code’s mint does not have');
  ok((await K.W._tillArrived(pass.id, bodyFor('till:x:4', forged(101)))) === 'refused', 'more than a hundred pieces is refused');
  ok((await K.W._tillArrived(pass.id, JSON.stringify({ id: 'till:x:5', mint: MINT, unit: 'sat', proofs: forged(1), pad: 'x'.repeat(70000) }))) === 'refused',
    'and a body over 64 KB, before it is read');
  await K.W.connect(HOME, { remember: true });
  K.W._privacy({ tor: 'connecting', progress: 40, everUp: true });
  ok((await K.W._tillArrived(pass.id, bodyFor('till:x:6', forged(3)))) === 'refused' && K.store('foxy.till.inbox', []).length === 0,
    'at another mint with no route a forged body is refused, not kept for later');
  const late = await P.W.sendToken(6, { unit: 'sat', lockTo: pass.lock });
  const lateP = proofsOf(P, late.token);
  ok((await K.W._tillArrived(pass.id, bodyFor('till:' + pass.id + ':7', lateP))) === 'kept', 'a real one there is kept, checked by the mint’s keys on file');
  ok((await K.W._tillArrived(pass.id, bodyFor('till:' + pass.id + ':8', lateP))) === 'kept' && K.store('foxy.till.inbox', []).length === 1,
    'the same pieces under another id are kept once', String(K.store('foxy.till.inbox', []).length));
  const junkRows = Array.from({ length: 50 }, (_, i) => ({ key: 'j' + i, pass: pass.id, body: '{"proofs":[]}', at: 1 }));
  const realRow = K.store('foxy.till.inbox', [])[0];
  K.storage.setItem('foxy.till.inbox', JSON.stringify(junkRows));
  const late2 = await P.W.sendToken(7, { unit: 'sat', lockTo: pass.lock });
  const late2Body = bodyFor('till:' + pass.id + ':9', proofsOf(P, late2.token));
  ok((await K.W._tillArrived(pass.id, late2Body)) === 'refused' && K.store('foxy.till.inbox', []).length === 50
    && K.store('foxy.till.inbox', []).every((r) => /^j/.test(r.key)), 'a full inbox (50) refuses the next and pushes none out');
  K.storage.setItem('foxy.till.inbox', JSON.stringify([realRow]));
  K.W._privacy({ tor: 'up', progress: 100, everUp: true });
  await K.W.connect(MINT, { remember: true });
  const kTook = await K.W.balanceSats();
  await K.W.tillListen();
  await wait(50);
  ok(K.store('foxy.till.inbox', []).length === 0 && (await K.W.balanceSats()) === kTook + 6, 'and what was kept is taken at the code’s mint', String((await K.W.balanceSats()) - kTook));

  // the mint turns one down: a refusal is dropped, a busy mint is tried again
  mints.main.lockRefuse(1, 'Proof could not be verified');
  ok((await K.W._tillArrived(pass.id, late2Body)) === 'refused' && K.store('foxy.till.inbox', []).length === 0,
    'a delivery the mint refuses as unverified is dropped, not kept to swap again');
  mints.main.lockRefuse(3);
  const busy = await K.W._tillArrived(pass.id, late2Body);
  ok(busy === 'kept' || busy === 'taken', 'one a busy mint turns away is kept to try again', busy);
  mints.main.lockRefuse(0);
  if (busy === 'kept') { await K.W.tillListen(); await wait(50); }
  ok(K.store('foxy.till.inbox', []).length === 0 && K.store('foxy.till.seen', []).indexOf(JSON.parse(late2Body).proofs[0].secret) >= 0,
    'and is taken once the mint answers');

  /* ---- the cashier leaves; the outbox stays ------------------------------- */
  relayDown = true;
  const req5 = C.W.decodeRequest(C.W.paymentRequest(21, { unit: 'sat', lockPub: pass.lock })) || {};
  const send21d = await P.W.sendToken(21, { unit: 'sat', lockTo: pass.lock });
  await C.W._requestPaid(bodyFor(req5.id, proofsOf(P, send21d.token)), 'a10', '');
  await wait(30);
  const left = await C.W.tillLeave();
  ok(left.left === true && C.W.mintUrl === HOME, 'leaving takes the cashier home', C.W.mintUrl);
  ok(C.W.tillCashier() === null && C.store('foxy.till.home', null) === null, 'with no till and no home row left');
  const unsent = C.store('foxy.till.outbox', []).filter((r) => !r.sentAt);
  ok(unsent.length === 1 && unsent[0].hash === 'till-' + req5.id, 'what was not sent is still in the outbox');
  relayDown = false;
  await C.W.tillDeliver();
  ok(C.store('foxy.till.outbox', []).every((r) => r.sentAt > 0), 'and it still goes, after the till');
  ok(C.W.tillOutbox().every((r) => !('proofs' in r)), 'tillOutbox lists rows without their proofs');
  ok(C.W.paymentRequest(21, { unit: 'sat', lockPub: pass.lock }) === '', 'out of the till, no till request is made');

  /* ---- review w1: one payment at two requests at once ------------------------ */
  await C.W.tillJoin(pass);
  const wr1 = C.W.decodeRequest(C.W.paymentRequest(21, { unit: 'sat', lockPub: pass.lock })) || {};
  const wr2 = C.W.decodeRequest(C.W.paymentRequest(21, { unit: 'sat', lockPub: pass.lock })) || {};
  const twin = proofsOf(P, (await P.W.sendToken(21, { unit: 'sat', lockTo: pass.lock })).token);
  const outW = outN();
  await Promise.all([C.W._requestPaid(bodyFor(wr1.id, twin), 'w1a', ''), C.W._requestPaid(bodyFor(wr2.id, twin), 'w1b', '')]);
  const wst = C.said.answers.filter((a) => a.answer === 'w1a' || a.answer === 'w1b').map((a) => a.status).sort();
  ok(JSON.stringify(wst) === '[200,409]' && outN() === outW + 1, 'the same ecash at two requests at once: one 200, one 409, one outbox row',
    JSON.stringify(wst) + ', outbox +' + (outN() - outW));
  ok(/being taken already/.test((C.said.answers.find((a) => a.status === 409 && (a.answer === 'w1a' || a.answer === 'w1b')) || {}).text || ''),
    'the second is told it is being taken already');
  const wr3 = C.W.decodeRequest(C.W.paymentRequest(9, { unit: 'sat', lockPub: pass.lock })) || {};
  const tw9 = await P.W.sendToken(9, { unit: 'sat', lockTo: pass.lock });
  const outW2 = outN();
  const scanBeside = await Promise.all([
    C.W._requestPaid(bodyFor(wr3.id, proofsOf(P, tw9.token)), 'w1c', ''),
    C.W.tillTakeToken(tw9.token).then(() => 'taken', (e) => e.message),
  ]);
  ok(outN() === outW2 + 1 && /being taken already/.test(scanBeside[1]), 'and posted and scanned at once, one row; the scan is told', scanBeside[1]);
  await wait(60);

  /* ---- review w6: a send with no route, and the route's return ---------------- */
  const wr4 = C.W.decodeRequest(C.W.paymentRequest(21, { unit: 'sat', lockPub: pass.lock })) || {};
  const tw21 = proofsOf(P, (await P.W.sendToken(21, { unit: 'sat', lockTo: pass.lock })).token);
  const relayW = relay.length;
  await C.W._requestPaid(bodyFor(wr4.id, tw21), 'w6', '');
  C.W._privacy({ tor: 'connecting', progress: 40, everUp: true });
  await wait(150);
  let rowW6 = C.store('foxy.till.outbox', []).find((r) => r.hash === 'till-' + wr4.id) || {};
  ok(!rowW6.sentAt && Number(rowW6.tries) >= 2 && relay.length === relayW, 'with no route a send counts a try, and is tried again by itself',
    JSON.stringify({ tries: rowW6.tries, sent: rowW6.sentAt }));
  C.W._tillRetryMs = 60000;
  await wait(100);
  C.W._privacy({ tor: 'up', progress: 100, everUp: true });
  await wait(200);
  rowW6 = C.store('foxy.till.outbox', []).find((r) => r.hash === 'till-' + wr4.id) || {};
  ok(rowW6.sentAt > 0 && relay.length === relayW + 1, 'the route’s return sends it at once, not at the next minute', JSON.stringify({ tries: rowW6.tries }));
  C.W._tillRetryMs = 40;

  /* ---- item 7: a tap refusal goes back to the payer, as the main path's does ---- */
  let dueCalls = 0;
  const dueBefore = C.W.tapChangeDue;
  C.W.tapChangeDue = () => { dueCalls += 1; };
  const wr5 = C.W.decodeRequest(C.W.paymentRequest(21, { unit: 'sat', lockPub: pass.lock })) || {};
  const plainOver = proofsOf(P, (await P.W.sendToken(21, { unit: 'sat' })).token);
  const payerKey = (P.W.decodeRequest(P.W.paymentRequest(1, { purpose: 'receive' })) || {}).lockTo;
  await C.W._requestPaid(bodyFor(wr5.id, plainOver, { changeTo: payerKey }), 'w7a', '');
  ok(dueCalls === 0, 'a refusal that came over a relay sends nothing back');
  await C.W._requestPaid(bodyFor(wr5.id, plainOver, { changeTo: payerKey }), 'w7b', 'tap');
  ok(dueCalls === 1 && (C.said.answers.find((a) => a.answer === 'w7b') || {}).status === 422,
    'a till refusal over a tap starts the refund to the payer (refundRefused)', String(dueCalls));
  await wait(150);
  C.W.tapChangeDue = dueBefore;

  /* ---- item 7: leaving twice ----------------------------------------------- */
  const leaves = await Promise.all([C.W.tillLeave(), C.W.tillLeave()]);
  const leaveAgain = await C.W.tillLeave();
  const shape = (x) => Object.keys(x || {}).sort().join();
  ok(leaves[0] === leaves[1] && shape(leaveAgain) === shape(leaves[0]) && leaveAgain.left === true && C.W.mintUrl === HOME,
    'tillLeave twice at once is one leave, and once more does nothing in the same shape', JSON.stringify([leaves[0], leaveAgain]));

  /* ---- review w2 part 2: a week to send, then stranded, never lost ------------ */
  const stuckProofs = [{ id: 'x', amount: 5, C: '02' + 'ab'.repeat(32), secret: 'stranded-1' }];
  const dayS = 86400;
  const tNow = Math.floor(Date.now() / 1000);
  C.W._tillOutboxAdd({ proofs: stuckProofs, mint: MINT, unit: 'sat', amount: 5, to: pass.to, passId: pass.id, exp: tNow - 8 * dayS, hash: 'w2-stranded' });
  const sendable = proofsOf(P, (await P.W.sendToken(4, { unit: 'sat', lockTo: pass.lock })).token);
  C.W._tillOutboxAdd({ proofs: sendable, mint: MINT, unit: 'sat', amount: 4, to: pass.to, passId: pass.id, exp: tNow - 6 * dayS, hash: 'w2-late' });
  const relayS = relay.length;
  await C.W.tillDeliver();
  await wait(30);
  const stuck = C.store('foxy.till.outbox', []).find((r) => r.hash === 'w2-stranded') || {};
  const lateRow = C.store('foxy.till.outbox', []).find((r) => r.hash === 'w2-late') || {};
  ok(lateRow.sentAt > 0, 'a row whose code ended six days ago is still sent');
  ok(stuck.stranded === true && !stuck.sentAt && stuck.proofs.length === 1 && relay.length === relayS + 1,
    'one whose code ended over a week ago is not sent, and kept with its proofs as stranded', JSON.stringify({ s: stuck.stranded, sent: stuck.sentAt }));
  ok((C.W.tillOutbox().find((r) => r.hash === 'w2-stranded') || {}).stranded === true, 'tillOutbox says stranded');
  const oldSent = C.store('foxy.till.outbox', []);
  oldSent.forEach((r) => { if (r.hash === 'w2-late') r.exp = tNow - 8 * dayS; });
  C.storage.setItem('foxy.till.outbox', JSON.stringify(oldSent));
  C.W._tillOutboxAdd({ proofs: [{ id: 'x', amount: 1, C: '02' + 'cd'.repeat(32), secret: 'tidy-1' }], mint: MINT, unit: 'sat', amount: 1, to: pass.to, passId: pass.id, exp: tNow + dayS, hash: 'w2-tidy' });
  const tidied = C.store('foxy.till.outbox', []);
  ok(!tidied.some((r) => r.hash === 'w2-late') && tidied.some((r) => r.hash === 'w2-stranded'),
    'a row sent goes a week after its code ends; a stranded one stays');
  C.storage.setItem('foxy.till.outbox', JSON.stringify(tidied.filter((r) => r.hash !== 'w2-stranded' && r.hash !== 'w2-tidy')));
  await C.W.tillDeliver();
  await wait(60);
  ok(relay.length >= relayS + 1, '(set-up) the outbox is left as it was');

  /* ---- a code that ends while the cashier works it -------------------------- */
  await C.W.tillJoin(pass);
  ok(C.W.mintUrl === MINT, 'the cashier joins again');
  const row = C.store('foxy.till.cashier', null);
  row.pass.exp = Math.floor(Date.now() / 1000) - 1;
  C.storage.setItem('foxy.till.cashier', JSON.stringify(row));
  ok(C.W.tillCashier() === null, 'once its code has ended, tillCashier is null');
  ok(C.store('foxy.till.cashier', null) === null, 'and the row is cleared');
  await wait(80);
  // the wallet does not start the trip home itself: asked mid-payment, that switched mints under a payment being paid (the screen asks tillLeave once nothing is on screen)
  ok(C.W.mintUrl === MINT, 'and the phone stays where it is until the screen asks to leave', C.W.mintUrl);
  await C.W.tillLeave();
  ok(C.W.mintUrl === HOME, 'tillLeave then takes it home', C.W.mintUrl);

  /* ---- review w2: one live code at a time, and a live code is never dropped ---- */
  const makes0 = K.said.keyMake.length;
  const again4 = [];
  for (let i = 0; i < 4; i++) again4.push(await K.W.tillPassMake());
  ok(again4.every((m) => m.text === made.text && m.id === made.id && m.exp === made.exp), 'while a code is live, asking again answers that same code',
    JSON.stringify(again4.map((m) => m.id)));
  ok(K.said.keyMake.length === makes0 && K.said.keyDrop.indexOf(pass.id) < 0 && K.store('foxy.till.passes', []).length === 1,
    'with no key made and none dropped, and one pass row');
  const sNow = () => Math.floor(Date.now() / 1000);
  let pr = K.store('foxy.till.passes', []);
  pr[0].exp = sNow() - 3600;
  K.storage.setItem('foxy.till.passes', JSON.stringify(pr));
  const twoAsks = await Promise.all([K.W.tillPassMake(), K.W.tillPassMake()]);
  ok(twoAsks[0].id === twoAsks[1].id && twoAsks[0].id !== pass.id && K.said.keyMake.length === makes0 + 1,
    'once it has ended a new one is made, once for two asks at once');
  pr = K.store('foxy.till.passes', []);
  ok(pr.length === 2 && pr.some((r) => r.id === pass.id), 'the ended one is kept, still listened for');
  ok(K.W.tillPasses().length === 1 && K.W.tillPasses()[0].id === twoAsks[0].id, 'tillPasses lists only the live one');

  // a code that ended six days ago is still the keeper's: its key kept, a late payment taken
  const fresh1 = K.W.tillDecode(twoAsks[0].text);
  pr = K.store('foxy.till.passes', []);
  pr.forEach((r) => { if (r.id === fresh1.id) r.exp = sNow() - 6 * 86400; });
  K.storage.setItem('foxy.till.passes', JSON.stringify(pr));
  K.W.tillPasses();
  ok(K.store('foxy.till.passes', []).some((r) => r.id === fresh1.id) && K.said.keyDrop.indexOf(fresh1.id) < 0, 'a code ended six days ago is kept with its key');
  const k6 = await K.W.balanceSats();
  const late6 = await P.W.sendToken(5, { unit: 'sat', lockTo: fresh1.lock });
  ok((await K.W._tillArrived(fresh1.id, bodyFor('till:' + fresh1.id + ':1', proofsOf(P, late6.token)))) === 'taken'
    && (await K.W.balanceSats()) === k6 + 5, 'and a payment sent to it then is taken');

  // four at most: only an ended one goes, oldest first, with its keys
  pr = K.store('foxy.till.passes', []);
  const base = pr.find((r) => r.id === pass.id);
  const fake = (n) => Object.assign({}, base, { id: 'f' + String(n).repeat(15), made: base.made + n, exp: sNow() - 600 * n, lockId: 'till-f' + String(n).repeat(15) });
  pr.push(fake(1), fake(2));
  K.storage.setItem('foxy.till.passes', JSON.stringify(pr));
  const fifth = await K.W.tillPassMake();
  const kept4 = K.store('foxy.till.passes', []);
  ok(kept4.length === 4 && !kept4.some((r) => r.id === pass.id) && kept4.some((r) => r.id === fifth.id), 'a fifth row drops the oldest ended one', kept4.map((r) => r.id.slice(0, 4)).join());
  ok(K.said.keyDrop.indexOf(pass.id) >= 0 && !K.store('foxy.req.lockkeys', {})['till-' + pass.id], 'with its Nostr key and its lock row');

  // the relays are asked from the oldest listened code's start, and never more than twelve days back
  await K.W.tillListen();
  const oldestMade = Math.min(...kept4.map((r) => r.made));
  ok(K.said.since[K.said.since.length - 1] === Math.floor(oldestMade / 1000) - 2 * 86400, 'tillInboxOpen’s since follows the oldest code listened on');
  pr = K.store('foxy.till.passes', []);
  pr[0].made = Date.now() - 20 * 86400 * 1000;
  K.storage.setItem('foxy.till.passes', JSON.stringify(pr));
  await K.W.tillListen();
  const sinceNow = K.said.since[K.said.since.length - 1];
  ok(sinceNow >= sNow() - 12 * 86400 && sinceNow <= sNow() - 12 * 86400 + 600, 'and is held inside the twelve days the phone takes', String(sNow() - sinceNow));

  // past a week after it ended, a code goes with its keys
  pr = K.store('foxy.till.passes', []);
  pr.forEach((r) => { if (r.id === fresh1.id) r.exp = sNow() - 8 * 86400; });
  K.storage.setItem('foxy.till.passes', JSON.stringify(pr));
  K.W.tillPasses();
  ok(!K.store('foxy.till.passes', []).some((r) => r.id === fresh1.id) && K.said.keyDrop.indexOf(fresh1.id) >= 0, 'a code ended over a week ago is dropped with its key');

  /* ---- a dollar code ------------------------------------------------------ */
  // (asked once no code is live: while one is, that one is answered)
  pr = K.store('foxy.till.passes', []);
  pr.forEach((r) => { r.exp = Math.min(r.exp, sNow() - 60); });
  K.storage.setItem('foxy.till.passes', JSON.stringify(pr));
  const usdNo = await K.W.tillPassMake({ unit: 'usd' }).then(() => '', (e) => e.message);
  ok(/does not issue dollars/.test(usdNo), 'a dollar code at a mint without dollars is refused', usdNo);

  /* ---- a code in the unit asked ------------------------------------------- */
  const satCode = await K.W.tillPassMake({ unit: 'sat' });
  ok(/^[0-9a-f]{16}$/.test(satCode.id) && K.store('foxy.till.passes', []).some((r) => r.id === satCode.id && r.unit === 'sat'), 'tillPassMake({ unit }) makes a code in that unit once none is live in it', satCode.id);
  ok((await K.W.tillPassMake({ unit: 'sat' })).id === satCode.id && (await K.W.tillPassMake()).id === satCode.id, 'and answers it again, asked in that unit or in none', satCode.id);

  /* ---- the keeper's till at another of its mints ---------------------------- */
  const atBefore = K.W.mintUrl;
  const opened = await K.W.tillKeeperOpen(HOME);
  ok(opened.moved === true && K.W.mintUrl === HOME, 'tillKeeperOpen visits the mint named for the till', K.W.mintUrl);
  const wayHome = K.store('foxy.till.keeper.home', null);
  ok(wayHome && String(wayHome.mint).replace(/\/+$/, '') === String(atBefore).replace(/\/+$/, ''), 'and keeps the way home', JSON.stringify(wayHome));
  ok((await K.W.tillKeeperOpen(HOME)).moved === false && K.store('foxy.till.keeper.home', null), 'opened again where it is: nothing moves, the way home stays');
  const closed = await K.W.tillKeeperClose();
  ok(closed.moved === true && K.W.mintUrl === atBefore && !K.store('foxy.till.keeper.home', null), 'tillKeeperClose comes home and forgets the way', K.W.mintUrl);
  ok((await K.W.tillKeeperClose()).moved === false && K.W.mintUrl === atBefore, 'closed again: nothing to do');
  ok((await K.W.tillKeeperOpen(atBefore)).moved === false && !K.store('foxy.till.keeper.home', null), 'opened at the mint it is on: no visit, and no way home kept');


  /* ---- the till at several mints -------------------------------------------- */
  const sumOf = (list) => list.reduce((n, pr) => n + Number(pr.amount), 0);
  const MINTc = String(MINT).replace(/\/+$/, '');
  ok(K.W.mintUrl === MINT, '(set-up) the keeper is at its own mint', K.W.mintUrl);
  const set2 = await K.W.tillKeeperOpen([MINT, HOME], MINT);
  ok(set2.moved === false && JSON.stringify(set2.mints) === JSON.stringify([MINT, HOME]) && set2.def === MINT,
    'tillKeeperOpen([MINT, HOME], MINT) opens the till at both, the default first, with no visit', JSON.stringify(set2));
  const kRec = K.store('foxy.till.keeper', null);
  ok(kRec && JSON.stringify(kRec.mints) === JSON.stringify([MINT, HOME]) && kRec.def === MINT && JSON.stringify(K.W.tillKeeper()) === JSON.stringify({ mints: [MINT, HOME], def: MINT }),
    'and keeps the till as foxy.till.keeper, read back by tillKeeper()', JSON.stringify(kRec));
  ok(!!K.store('foxy.cashu.mint.cache', {})[HOME], 'every mint of the till has its keys on file');
  const openNo = async (a, d) => K.W.tillKeeperOpen(a, d).then(() => '', (e) => e.message);
  ok(/default mint has to be one/.test(await openNo([MINT, HOME], USDM)), 'a default that is not among the mints is refused');
  ok(/at most/.test(await openNo(Array.from({ length: 9 }, (_, i) => 'https://m' + i + '.test'))), 'more than eight mints is refused');
  ok(/not a mint address/.test(await openNo([MINT, 'http://plain.test'])), 'a mint address Foxy would not use is refused');
  K.W._privacy({ tor: 'connecting', progress: 40, everUp: true });
  const unseen = await openNo([MINT, USDM], MINT);
  ok(/usd\.test has not been seen/.test(unseen) && K.store('foxy.till.keeper', null).mints.length === 2 && K.store('foxy.till.keeper', null).mints[1] === HOME,
    'with no route, a mint never seen is refused by name, and the open till is left as it was', unseen);
  K.W._privacy({ tor: 'up', progress: 100, everUp: true });

  // the cashier code carries the set; a live code for another set is not answered for this one
  const liveSat = K.W.tillPasses().find((r) => r.id === satCode.id);
  const code2 = await K.W.tillPassMake({ unit: 'sat' });
  ok(code2.id !== satCode.id && JSON.stringify(code2.mints) === JSON.stringify([MINT, HOME]), 'a code for the two mints is a new code, answered with its mints', JSON.stringify(code2.mints));
  const pass2 = K.W.tillDecode(code2.text);
  ok(pass2 && pass2.mint === MINT && JSON.stringify(pass2.mints) === JSON.stringify([MINT, HOME]), 'it decodes to mint: the default, and mints: both', JSON.stringify(pass2 && pass2.mints));
  const raw2 = JSON.parse(Buffer.from(code2.text.slice(URL0.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  ok(raw2.mint === MINT && JSON.stringify(raw2.mints) === JSON.stringify([MINT, HOME]), 'and its text says so, mint first for a Foxy from before');
  ok((await K.W.tillPassMake({ unit: 'sat' })).id === code2.id, 'asked again, the same code');
  ok(!!liveSat && K.W.tillPasses().some((r) => r.id === satCode.id), 'and the one-mint code stays live for the cashiers already on it');
  const oldShape = Object.assign({}, pass2); delete oldShape.mints;
  ok(JSON.stringify((K.W.tillDecode(enc(oldShape)) || {}).mints) === JSON.stringify([MINT]), 'a code with no mints reads as its one mint');
  ok(K.W.tillDecode(enc(Object.assign({}, pass2, { mints: [HOME] }))) === null, 'a code whose mints leave out its mint is null');
  ok(K.W.tillDecode(enc(Object.assign({}, pass2, { mints: Array.from({ length: 9 }, (_, i) => 'https://m' + i + '.test').concat([MINT]) }))) === null,
    'one with more than eight mints is null');
  ok(K.W.tillDecode(enc(Object.assign({}, pass2, { mints: [MINT, 'http://plain.test'] }))) === null && K.W.tillDecode(enc(Object.assign({}, pass2, { mints: 'x' }))) === null,
    'one naming an address Foxy would not use, or no list at all, is null');

  // the keeper's request names both, the default first
  const kReq = K.W.decodeRequest(K.W.paymentRequest(30, { unit: 'sat', mints: [HOME, MINT] })) || {};
  ok(JSON.stringify(kReq.mints) === JSON.stringify([MINT, HOME]) && !!kReq.lockTo, 'a request from the till lists both mints, the one the phone is on first', JSON.stringify(kReq.mints));
  ok(JSON.stringify((K.store('foxy.req.open', {})[kReq.id] || {}).mints) === JSON.stringify([MINT, HOME]), 'and its open row keeps them');
  const kReq1 = K.W.decodeRequest(K.W.paymentRequest(30, { unit: 'sat' })) || {};
  ok(JSON.stringify(kReq1.mints) === JSON.stringify([MINT]) && !('mints' in (K.store('foxy.req.open', {})[kReq1.id] || {})), 'one with no mints named lists the phone’s own, as ever');
  ok(K.W.paymentRequest(30, { unit: 'sat', mints: [HOME, USDM] }) === '', 'one whose mints leave out the mint the phone is on is not made');

  // the payer pays at HOME: read, and kept in HOME's pile, the keeper staying at MINT
  await P.W.connect(HOME, { remember: true });
  await P.W.claim((await P.W.invoice(500, '')).hash);
  const atHome = proofsOf(P, (await P.W.sendToken(30, { unit: 'sat', lockTo: kReq.lockTo })).token);
  const kHome0 = K.W.balanceAt(HOME), kMint0 = await K.W.balanceSats();
  const paidK = [];
  K.W.onRequestPaid((x) => paidK.push(x));
  await K.W._requestPaid(JSON.stringify({ id: kReq.id, mint: HOME, unit: 'sat', proofs: atHome }), 'k1', '');
  await until(() => K.W.balanceAt(HOME) > kHome0);
  const ansK1 = K.said.answers.find((a) => a.answer === 'k1') || {};
  ok(ansK1.status === 200 && paidK.some((x) => x.stage === 'paid' && x.id === kReq.id && x.amount === 30), 'a payment at HOME is answered 200 and told paid, 30', JSON.stringify(ansK1));
  ok(K.W.mintUrl === MINT && K.W.balanceAt(HOME) === kHome0 + 30 && (await K.W.balanceSats()) === kMint0,
    'and swapped into HOME’s pile, the phone at MINT and MINT’s balance as it was', K.W.balanceAt(HOME) + ' vs ' + kHome0 + ', MINT ' + (await K.W.balanceSats()) + ' vs ' + kMint0);
  const kRowH = K.store('foxy.cashu.log', []).find((e) => e.hash === 'req-' + kReq.id) || {};
  ok(kRowH.dir === 'in' && kRowH.sats === 30 && String(kRowH.mint).replace(/\/+$/, '') === HOME && kRowH.settled === true, 'one history row, in, 30, at HOME', JSON.stringify(kRowH));
  ok(!Object.keys(K.store('foxy.req.unclaimed', {})).length, 'with nothing left waiting');

  // at a mint the request does not name: refused; and one naming a single mint is answered only there
  const kReq2 = K.W.decodeRequest(K.W.paymentRequest(30, { unit: 'sat', mints: [MINT, HOME] })) || {};
  await K.W._requestPaid(JSON.stringify({ id: kReq2.id, mint: USDM, unit: 'sat', proofs: atHome }), 'k2', '');
  ok((K.said.answers.find((a) => a.answer === 'k2') || {}).status === 422 && /not at the mint the request named/.test((K.said.answers.find((a) => a.answer === 'k2') || {}).text),
    'a payment at a third mint is refused');
  const rpNo = (b) => { try { K.W.readPayment(b); return ''; } catch (e) { return e.message; } };
  ok(/not at the mint the request named/.test(rpNo(JSON.stringify({ id: kReq1.id, mint: HOME, unit: 'sat', proofs: atHome }))),
    'readPayment refuses HOME for a request that names MINT alone');
  ok(rpNo(JSON.stringify({ id: kReq2.id, mint: HOME, unit: 'sat', proofs: atHome })) === '' && /not at the mint/.test(rpNo(JSON.stringify({ id: kReq2.id, mint: USDM, unit: 'sat', proofs: atHome }))),
    'and reads HOME for one that names it, but not a mint it leaves out');

  /* A payment at HOME over what was asked, not marked: no change can be made there. Plain, it is refused, and the payer
   * keeps it; locked to the keeper, a refusal would strand it (the payer cannot spend it back), so it is kept whole, as an
   * over-payment no change can be made for is at the mint the phone is on (review). */
  const kReqP = K.W.decodeRequest(K.W.paymentRequest(30, { unit: 'sat', mints: [MINT, HOME] })) || {};
  const plain35 = proofsOf(P, (await P.W.sendToken(35, { unit: 'sat' })).token);
  await K.W._requestPaid(JSON.stringify({ id: kReqP.id, mint: HOME, unit: 'sat', proofs: plain35 }), 'k3p', 'tap');
  ok((K.said.answers.find((a) => a.answer === 'k3p') || {}).status === 422 && /cannot give change at home\.test/.test((K.said.answers.find((a) => a.answer === 'k3p') || {}).text),
    'a plain over-payment at another mint is refused: no change can be made there, and the ecash is still the payer’s');
  const hOver = K.W.balanceAt(HOME);
  const over35 = proofsOf(P, (await P.W.sendToken(35, { unit: 'sat', lockTo: kReq2.lockTo })).token);
  await K.W._requestPaid(JSON.stringify({ id: kReq2.id, mint: HOME, unit: 'sat', proofs: over35 }), 'k3', 'tap');
  await until(() => K.W.balanceAt(HOME) > hOver);
  const rowOver = K.store('foxy.cashu.log', []).find((e) => e.hash === 'req-' + kReq2.id) || {};
  ok((K.said.answers.find((a) => a.answer === 'k3') || {}).status === 200 && K.W.balanceAt(HOME) === hOver + 35 && rowOver.sats === 35
     && String(rowOver.mint).replace(/\/+$/, '') === HOME && K.W.mintUrl === MINT,
    'a locked over-payment at another mint is taken whole into its pile, the row saying 35, never refused and stranded',
    JSON.stringify([K.said.answers.find((a) => a.answer === 'k3'), K.W.balanceAt(HOME) - hOver, rowOver.sats]));

  // offline: a locked HOME token is kept under HOME, and swept there when the route returns, the phone not moving
  const kReq3 = K.W.decodeRequest(K.W.paymentRequest(20, { unit: 'sat', mints: [MINT, HOME] })) || {};
  const lock20 = proofsOf(P, (await P.W.sendToken(20, { unit: 'sat', lockTo: kReq3.lockTo })).token);
  const plain20 = proofsOf(P, (await P.W.sendToken(20, { unit: 'sat' })).token);
  K.W._privacy({ tor: 'connecting', progress: 40, everUp: true });
  await K.W._requestPaid(JSON.stringify({ id: kReq3.id, mint: HOME, unit: 'sat', proofs: plain20 }), 'k4', 'tap');
  ok((K.said.answers.find((a) => a.answer === 'k4') || {}).status === 422 && /offline/.test((K.said.answers.find((a) => a.answer === 'k4') || {}).text),
    'with no route, plain ecash at another mint is refused', JSON.stringify(K.said.answers.find((a) => a.answer === 'k4')));
  const kHome1 = K.W.balanceAt(HOME);
  await K.W._requestPaid(JSON.stringify({ id: kReq3.id, mint: HOME, unit: 'sat', proofs: lock20 }), 'k5', 'tap');
  await wait(60);
  const unc = K.store('foxy.req.unclaimed', {})[kReq3.id] || {};
  ok((K.said.answers.find((a) => a.answer === 'k5') || {}).status === 200 && String(unc.mint).replace(/\/+$/, '') === HOME && unc.away === true && unc.amount === 20,
    'with no route, ecash at HOME locked to the keeper is taken, kept unclaimed under HOME', JSON.stringify(unc).slice(0, 120));
  ok(K.W.unclaimedSats(HOME) === 20 && K.W.unclaimedSats(MINTc) === 0 && K.W.balanceAt(HOME) === kHome1, 'counted as waiting at HOME, nowhere else');
  K.W._privacy({ tor: 'up', progress: 100, everUp: true });
  await K.W.claimUnclaimed();
  await until(() => K.W.balanceAt(HOME) > kHome1);
  ok(K.W.balanceAt(HOME) === kHome1 + 20 && !K.store('foxy.req.unclaimed', {})[kReq3.id] && K.W.mintUrl === MINT,
    'and swept into HOME’s pile when the route returns, the phone still at MINT', K.W.balanceAt(HOME) + ' vs ' + kHome1 + ', at ' + K.W.mintUrl);

  // at a mint of sats alone, a dollar request is not made, whatever mints it names: the mint the phone is on asks it
  ok(K.W.paymentRequest(500, { unit: 'usd', mints: [MINT, USDM] }) === '', 'a dollar request at the mint the phone is on, which issues no dollars, is not made');
  // and a code for both is refused there: a cashier's dollar invoices are made at the default
  const bothNo = await K.W.tillPassMake({ unit: 'both' }).then(() => '', (e) => e.message);
  ok(/m\.test does not issue dollars/.test(bothNo), 'a code for both at a default of sats alone is refused, naming it', bothNo);

  // a till at a dollar mint and HOME, which issues sats alone: HOME drops off a dollar request's list, and stays on a sat one's
  await K.W.tillKeeperClose();
  const usdOpen = await K.W.tillKeeperOpen([USDM, HOME], USDM);
  ok(usdOpen.moved === true && K.W.mintUrl === USDM, '(set-up) a till opened at a dollar mint and HOME', K.W.mintUrl);
  const usdReq = K.W.decodeRequest(K.W.paymentRequest(500, { unit: 'usd', mints: [USDM, HOME] })) || {};
  ok(usdReq.unit === 'usd' && JSON.stringify(usdReq.mints) === JSON.stringify([USDM]) && JSON.stringify((K.store('foxy.req.open', {})[usdReq.id] || {}).mints) === JSON.stringify([USDM]),
    'a dollar request naming HOME, which issues no dollars, is made with HOME dropped from its list, the open row too', JSON.stringify(usdReq.mints));
  const satReqU = K.W.decodeRequest(K.W.paymentRequest(30, { unit: 'sat', mints: [USDM, HOME] })) || {};
  ok(JSON.stringify(satReqU.mints) === JSON.stringify([USDM, HOME]), 'a sat request at the same till lists both', JSON.stringify(satReqU.mints));
  const usdCode = await K.W.tillPassMake({ unit: 'usd' }).then((c) => c, (e) => ({ no: e.message }));
  const usdPass = usdCode.text ? K.W.tillDecode(usdCode.text) : null;
  ok(!!usdPass && usdPass.unit === 'usd' && JSON.stringify(usdPass.mints) === JSON.stringify([USDM, HOME]),
    'a dollar code for the set is made: its default issues dollars, and HOME may issue sats alone', usdCode.no || JSON.stringify(usdPass));
  const bothCode = await K.W.tillPassMake({ unit: 'both' }).then((c) => c, (e) => ({ no: e.message }));
  const bothPass = bothCode.text ? K.W.tillDecode(bothCode.text) : null;
  ok(!!bothPass && bothPass.unit === 'both' && bothCode.id !== usdCode.id && JSON.stringify(bothPass.mints) === JSON.stringify([USDM, HOME]),
    'a code for both at a default issuing both is a code of its own, unit both, at the set', bothCode.no || JSON.stringify(bothPass));
  const rawBoth = bothCode.text ? JSON.parse(Buffer.from(bothCode.text.slice(URL0.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()) : {};
  ok(rawBoth.unit === 'both', 'and its text says both', JSON.stringify(rawBoth.unit));
  ok((await K.W.tillPassMake({ unit: 'both' })).id === bothCode.id && (await K.W.tillPassMake({ unit: 'usd' })).id === usdCode.id,
    'each asked again answers its own: a live code is reused only for the same unit and set');

  /* A till in both, its main said on the code: `main` on a code for both alone (sats on one from before it said), and a code
   * for both with dollars first is a code of its own. */
  ok(rawBoth.main === 'sat' && bothPass.main === 'sat' && !('main' in (usdCode.text ? JSON.parse(Buffer.from(usdCode.text.slice(URL0.length).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()) : { main: 1 })),
    'a code for both says its main, sats where none was asked; a dollar code says nothing of one', JSON.stringify([rawBoth.main, bothPass.main]));
  const bothUsdCode = await K.W.tillPassMake({ unit: 'both', main: 'usd' }).then((c) => c, (e) => ({ no: e.message }));
  const bothUsdPass = bothUsdCode.text ? K.W.tillDecode(bothUsdCode.text) : null;
  ok(!!bothUsdPass && bothUsdPass.unit === 'both' && bothUsdPass.main === 'usd' && bothUsdCode.main === 'usd' && bothUsdCode.id !== bothCode.id
    && (await K.W.tillPassMake({ unit: 'both', main: 'sat' })).id === bothCode.id,
    'a code for both, dollars first, is a code of its own, and each main asked again answers its own', bothUsdCode.no || JSON.stringify(bothUsdPass));
  const noMain = Object.assign({}, rawBoth); delete noMain.main;
  ok((K.W.tillDecode(URL0 + Buffer.from(JSON.stringify(noMain)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')) || {}).main === 'sat'
    && K.W.tillDecode(URL0 + Buffer.from(JSON.stringify(Object.assign({}, rawBoth, { main: 'eur' }))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')) === null,
    'a code for both from before codes said a main reads as sats first; one naming another main is null');

  /* The keeper's pair: one price, a request in each currency, each naming the other (12-receive.js `tillTwinRequest`). A payment
   * to either is taken in its own unit, and the other is closed: paid to as well, it is refused as already paid. */
  await P.W.connect(USDM, { remember: true });
  await P.W.claim((await P.W.invoice(300, '')).hash);
  await P.W.claim((await P.W.invoice(800, '', { unit: 'usd' })).hash);
  const kpSatText = K.W.paymentRequest(30, { unit: 'sat', mints: [USDM, HOME], kept: true });
  const kpSat = K.W.decodeRequest(kpSatText) || {};
  const kpUsd = K.W.decodeRequest(K.W.paymentRequest(150, { unit: 'usd', mints: [USDM, HOME], kept: true, twin: kpSatText })) || {};
  const openK = () => K.store('foxy.req.open', {});
  ok(kpSat.unit === 'sat' && kpUsd.unit === 'usd' && openK()[kpSat.id].twin === kpUsd.id && openK()[kpUsd.id].twin === kpSat.id && !!kpSat.lockTo && !!kpUsd.lockTo,
    'a pair is made: a sat request and a dollar one, each naming the other, each locked to this phone', JSON.stringify([openK()[kpSat.id], openK()[kpUsd.id]]));
  const kU0 = K.W.balanceOf('usd'), kS0 = K.W.balanceOf('sat');
  const payUsd = proofsOf(P, (await P.W.sendToken(150, { unit: 'usd', lockTo: kpUsd.lockTo })).token);
  await K.W._requestPaid(JSON.stringify({ id: kpUsd.id, mint: USDM, unit: 'usd', proofs: payUsd }), 'kp1', '');
  await until(() => K.W.balanceOf('usd') >= kU0 + 150);
  const ansKp = (k) => K.said.answers.find((a) => a.answer === k) || {};
  ok(ansKp('kp1').status === 200 && K.W.balanceOf('usd') === kU0 + 150 && K.W.balanceOf('sat') === kS0,
    'a dollar payment to the pair lands in dollars, the sats as they were', JSON.stringify([ansKp('kp1'), K.W.balanceOf('usd') - kU0, K.W.balanceOf('sat') - kS0]));
  ok(openK()[kpSat.id] && openK()[kpSat.id].twinPaid === kpUsd.id && !openK()[kpUsd.id], 'and its sat twin is closed, the dollar one gone as paid', JSON.stringify(openK()[kpSat.id]));
  const paySat = proofsOf(P, (await P.W.sendToken(30, { unit: 'sat', lockTo: kpSat.lockTo })).token);
  await K.W._requestPaid(JSON.stringify({ id: kpSat.id, mint: USDM, unit: 'sat', proofs: paySat }), 'kp2', '');
  await wait(150);
  ok(ansKp('kp2').status === 422 && /already been paid/.test(ansKp('kp2').text) && K.W.balanceOf('sat') === kS0,
    'a second payment, to the closed twin, is refused as already paid, and nothing taken', JSON.stringify([ansKp('kp2'), K.W.balanceOf('sat') - kS0]));
  // and the other way round: sats paid, the dollar twin closed
  const kq = K.W.paymentRequest(25, { unit: 'sat', mints: [USDM, HOME], kept: true });
  const kqSat = K.W.decodeRequest(kq) || {};
  const kqUsd = K.W.decodeRequest(K.W.paymentRequest(120, { unit: 'usd', mints: [USDM, HOME], kept: true, twin: kqSat.id })) || {};
  const kS1 = K.W.balanceOf('sat'), kU1 = K.W.balanceOf('usd');
  await P.W.claim((await P.W.invoice(200, '')).hash);
  const paySat2 = proofsOf(P, (await P.W.sendToken(25, { unit: 'sat', lockTo: kqSat.lockTo })).token);
  await K.W._requestPaid(JSON.stringify({ id: kqSat.id, mint: USDM, unit: 'sat', proofs: paySat2 }), 'kp3', '');
  await until(() => K.W.balanceOf('sat') >= kS1 + 25);
  ok(ansKp('kp3').status === 200 && K.W.balanceOf('sat') === kS1 + 25 && K.W.balanceOf('usd') === kU1 && openK()[kqUsd.id] && openK()[kqUsd.id].twinPaid === kqSat.id,
    'a sat payment to a pair (paired by id) lands in sats, and its dollar twin is closed', JSON.stringify([ansKp('kp3'), K.W.balanceOf('sat') - kS1, openK()[kqUsd.id]]));
  const payUsd2 = proofsOf(P, (await P.W.sendToken(120, { unit: 'usd', lockTo: kqUsd.lockTo })).token);
  await K.W._requestPaid(JSON.stringify({ id: kqUsd.id, mint: USDM, unit: 'usd', proofs: payUsd2 }), 'kp4', '');
  await wait(150);
  ok(ansKp('kp4').status === 422 && K.W.balanceOf('usd') === kU1, 'and dollars sent to it after are refused', JSON.stringify(ansKp('kp4')));
  // nothing pairs a request that is not open here, nor one with itself
  const lone = K.W.decodeRequest(K.W.paymentRequest(10, { unit: 'sat', twin: 'ffffffffffffffff' })) || {};
  ok(!!lone.id && !('twin' in (openK()[lone.id] || {})), 'a request named the twin of one not open here is made unpaired');

  // a cashier on the code for both takes sats and dollars, each in its own unit, and the keeper takes both in
  ok(C.W.mintUrl === HOME && C.W.tillCashier() === null, '(set-up) the cashier is home, out of the till', C.W.mintUrl);
  const jBoth = await C.W.tillJoin(bothCode.text);
  ok(jBoth && jBoth.pass.unit === 'both' && C.W.mintUrl === USDM, 'the cashier joins the code for both, at its default', C.W.mintUrl);
  await P.W.connect(USDM, { remember: true });
  await P.W.claim((await P.W.invoice(300, '')).hash);
  await P.W.claim((await P.W.invoice(800, '', { unit: 'usd' })).hash);
  const cbSat = C.W.decodeRequest(C.W.paymentRequest(30, { unit: 'sat', lockPub: bothPass.lock, purpose: 'till' })) || {};
  const cbUsd = C.W.decodeRequest(C.W.paymentRequest(150, { unit: 'usd', lockPub: bothPass.lock, purpose: 'till' })) || {};
  ok(cbSat.unit === 'sat' && cbSat.lockTo === bothPass.lock && JSON.stringify(cbSat.mints) === JSON.stringify([USDM, HOME]),
    'its sat request: locked to the keeper, at both mints', JSON.stringify([cbSat.unit, cbSat.mints]));
  ok(cbUsd.unit === 'usd' && cbUsd.lockTo === bothPass.lock && JSON.stringify(cbUsd.mints) === JSON.stringify([USDM]),
    'its dollar request: locked to the keeper, at the dollar mint alone', JSON.stringify([cbUsd.unit, cbUsd.mints]));
  const cbInv = await C.W.invoice(150, '', { unit: 'usd', lockPub: bothPass.lock }).then((q) => q, (e) => ({ no: e.message }));
  ok(!cbInv.no && cbInv.unit === 'usd', 'and a dollar invoice is made for it, in the unit of the receive', cbInv.no || JSON.stringify(cbInv.unit));
  const pbSat = proofsOf(P, (await P.W.sendToken(30, { unit: 'sat', lockTo: bothPass.lock })).token);
  const pbUsd = proofsOf(P, (await P.W.sendToken(150, { unit: 'usd', lockTo: bothPass.lock })).token);
  relay = [];
  await C.W._requestPaid(JSON.stringify({ id: cbSat.id, mint: USDM, unit: 'sat', proofs: pbSat }), 'cb1', '');
  await C.W._requestPaid(JSON.stringify({ id: cbUsd.id, mint: USDM, unit: 'usd', proofs: pbUsd }), 'cb2', '');
  const ansB = (k) => C.said.answers.find((a) => a.answer === k) || {};
  ok(ansB('cb1').status === 200 && ansB('cb2').status === 200, 'the cashier takes a sat payment and a dollar one on the one code', JSON.stringify([ansB('cb1'), ansB('cb2')]));
  const obSat = C.store('foxy.till.outbox', []).find((r) => r.hash === 'till-' + cbSat.id) || {};
  const obUsd = C.store('foxy.till.outbox', []).find((r) => r.hash === 'till-' + cbUsd.id) || {};
  ok(obSat.unit === 'sat' && obSat.amount === 30 && obUsd.unit === 'usd' && obUsd.amount === 150 && obUsd.passId === bothPass.id,
    'into the outbox, each in its own unit, for the keeper', JSON.stringify([[obSat.unit, obSat.amount], [obUsd.unit, obUsd.amount]]));
  const tokUsd = await P.W.sendToken(40, { unit: 'usd', lockTo: bothPass.lock });
  const tookUsd = await C.W.tillTakeToken(tokUsd.token).then((r) => r, (e) => ({ no: e.message }));
  ok(tookUsd.till === true && tookUsd.unit === 'usd' && tookUsd.amount === 40, 'a dollar token scanned at the till is taken for the keeper too', tookUsd.no || JSON.stringify(tookUsd));
  await until(() => relay.length >= 3);
  const kbSat = K.W.balanceOf('sat'), kbUsd = K.W.balanceOf('usd');
  const bodiesB = relay.map((r) => r.body).filter((b) => { try { return JSON.parse(b).id.indexOf('till:' + bothPass.id + ':') === 0; } catch (e) { return false; } });
  const tookB = [];
  for (const b of bodiesB) tookB.push(await K.W._tillArrived(bothPass.id, b));
  await until(() => K.W.balanceOf('usd') >= kbUsd + 190);
  ok(bodiesB.length === 3 && tookB.every((x) => x === 'taken') && K.W.balanceOf('sat') === kbSat + 30 && K.W.balanceOf('usd') === kbUsd + 190,
    'the keeper takes all three in: 30 sats and $1.90, each into its own balance', JSON.stringify([tookB, K.W.balanceOf('sat') - kbSat, K.W.balanceOf('usd') - kbUsd]));
  const eurBody = Object.assign(JSON.parse(bodiesB[0] || '{}'), { unit: 'eur' });
  ok((await K.W._tillArrived(bothPass.id, JSON.stringify(eurBody))) === 'refused', 'and a delivery in neither unit is refused');
  // the cashier's pair, both locked to the keeper: the dollar half paid goes to the outbox in dollars, and the sat half is closed
  const cpSatText = C.W.paymentRequest(20, { unit: 'sat', lockPub: bothPass.lock, purpose: 'till', kept: true });
  const cpSat = C.W.decodeRequest(cpSatText) || {};
  const cpUsd = C.W.decodeRequest(C.W.paymentRequest(100, { unit: 'usd', lockPub: bothPass.lock, purpose: 'till', kept: true, twin: cpSatText })) || {};
  const openC = () => C.store('foxy.req.open', {});
  ok(cpSat.lockTo === bothPass.lock && cpUsd.lockTo === bothPass.lock && openC()[cpSat.id].twin === cpUsd.id && openC()[cpUsd.id].twin === cpSat.id,
    'a cashier’s pair: both locked to the keeper, each naming the other', JSON.stringify([cpSat.lockTo, cpUsd.lockTo]));
  const cpPayUsd = proofsOf(P, (await P.W.sendToken(100, { unit: 'usd', lockTo: bothPass.lock })).token);
  await C.W._requestPaid(JSON.stringify({ id: cpUsd.id, mint: USDM, unit: 'usd', proofs: cpPayUsd }), 'cp1', '');
  const obCp = C.store('foxy.till.outbox', []).find((r) => r.hash === 'till-' + cpUsd.id) || {};
  ok(ansB('cp1').status === 200 && obCp.unit === 'usd' && obCp.amount === 100 && openC()[cpSat.id] && openC()[cpSat.id].twinPaid === cpUsd.id,
    'its dollar half paid: into the outbox in dollars, for the keeper, and the sat half closed', JSON.stringify([ansB('cp1'), obCp.unit, obCp.amount, openC()[cpSat.id]]));
  const cpPaySat = proofsOf(P, (await P.W.sendToken(20, { unit: 'sat', lockTo: bothPass.lock })).token);
  await C.W._requestPaid(JSON.stringify({ id: cpSat.id, mint: USDM, unit: 'sat', proofs: cpPaySat }), 'cp2', '');
  ok(ansB('cp2').status === 422 && /already been paid/.test(ansB('cp2').text) && !C.store('foxy.till.outbox', []).some((r) => r.hash === 'till-' + cpSat.id),
    'a payment to the closed sat half after: refused as already paid, nothing in the outbox', JSON.stringify(ansB('cp2')));
  await C.W.tillLeave();
  ok(C.W.mintUrl === HOME && C.W.tillCashier() === null, 'the cashier leaves for home', C.W.mintUrl);
  // (and forgets the dollar mint's keys, for the join below that finds a mint it never saw)
  { const c = C.store('foxy.cashu.mint.cache', {}); delete c[USDM]; C.storage.setItem('foxy.cashu.mint.cache', JSON.stringify(c)); }

  await K.W.tillKeeperClose();
  ok(K.W.mintUrl === MINT && K.store('foxy.till.keeper', null) === null, 'tillKeeperClose comes home and forgets the till', K.W.mintUrl);
  await K.W.tillKeeperOpen([MINT, HOME], MINT);

  // the cashier: a join loads the keys of every mint the code takes, and refuses one it cannot ask
  await P.W.connect(MINT, { remember: true });
  ok(C.W.mintUrl === HOME && C.W.tillCashier() === null, '(set-up) the cashier is home, out of the till', C.W.mintUrl);
  const withUsd = Object.assign({}, pass2, { mints: [MINT, USDM] });
  C.W._privacy({ tor: 'connecting', progress: 40, everUp: true });
  const joinNo = await C.W.tillJoin(withUsd).then(() => '', (e) => e.message);
  ok(/usd\.test/.test(joinNo) && C.W.tillCashier() === null && C.W.mintUrl === HOME, 'with no route, a code naming a mint the cashier never saw is refused by name, nothing written', joinNo);
  C.W._privacy({ tor: 'up', progress: 100, everUp: true });
  await C.W.tillJoin(withUsd);
  ok(!!C.store('foxy.cashu.mint.cache', {})[USDM] && C.W.mintUrl === MINT, 'with one, the join puts that mint’s keys on file and goes to the default', C.W.mintUrl);
  await C.W.tillLeave();
  const j2 = await C.W.tillJoin(code2.text);
  const cache2 = C.store('foxy.cashu.mint.cache', {});
  ok(j2 && JSON.stringify(j2.pass.mints) === JSON.stringify([MINT, HOME]) && C.W.mintUrl === MINT && !!cache2[MINTc] && !!cache2[HOME],
    'joined by the two-mint code: at MINT, both mints’ keys on file', C.W.mintUrl);
  const cReq = C.W.decodeRequest(C.W.paymentRequest(30, { unit: 'sat', lockPub: pass2.lock, purpose: 'till' })) || {};
  ok(JSON.stringify(cReq.mints) === JSON.stringify([MINT, HOME]) && cReq.lockTo === pass2.lock, 'the cashier’s request lists the code’s mints, locked to the keeper', JSON.stringify(cReq.mints));
  await P.W.connect(HOME, { remember: true });
  const cHome = proofsOf(P, (await P.W.sendToken(30, { unit: 'sat', lockTo: pass2.lock })).token);
  relay = [];
  const cPile = await C.W.balanceSats();
  await C.W._requestPaid(JSON.stringify({ id: cReq.id, mint: HOME, unit: 'sat', proofs: cHome }), 'c1', '');
  await until(() => relay.length > 0);
  ok((C.said.answers.find((a) => a.answer === 'c1') || {}).status === 200, 'a HOME payment to the cashier is answered 200', JSON.stringify(C.said.answers.find((a) => a.answer === 'c1')));
  const cRow = C.store('foxy.till.outbox', []).find((r) => r.hash === 'till-' + cReq.id) || {};
  ok(String(cRow.mint).replace(/\/+$/, '') === HOME && cRow.amount === 30 && cRow.passId === pass2.id && (await C.W.balanceSats()) === cPile,
    'into the outbox under HOME, for the keeper, nothing in the cashier’s pile', JSON.stringify({ m: cRow.mint, a: cRow.amount }));
  const cSent = relay.map((r) => JSON.parse(r.body)).find((b) => b.id === 'till:' + pass2.id + ':' + cRow.n) || {};
  ok(String(cSent.mint).replace(/\/+$/, '') === HOME && (C.store('foxy.till.outbox', []).find((r) => r.hash === 'till-' + cReq.id) || {}).sentAt > 0,
    'and delivered, the body naming HOME', JSON.stringify({ id: cSent.id, m: cSent.mint }));
  const cScan = await P.W.sendToken(7, { unit: 'sat', lockTo: pass2.lock });
  const cTook = await C.W.tillTakeToken(cScan.token);
  ok(cTook.till === true && cTook.amount === 7 && String(cTook.mint).replace(/\/+$/, '') === HOME, 'a HOME token scanned at the till is taken for the keeper, at HOME', JSON.stringify(cTook));
  await wait(80);
  const kHome2 = K.W.balanceAt(HOME), kMint2 = await K.W.balanceSats();
  const forK = relay.find((r) => JSON.parse(r.body).id === 'till:' + pass2.id + ':' + cRow.n);
  ok(!!forK, '(set-up) the delivery is on the relay');
  const kTake = forK ? await K.W._tillArrived(pass2.id, forK.body) : '';
  ok(kTake === 'taken' && K.W.balanceAt(HOME) === kHome2 + 30 && (await K.W.balanceSats()) === kMint2 && K.W.mintUrl === MINT,
    'the keeper takes it into HOME’s pile, staying at MINT', kTake + ', ' + K.W.balanceAt(HOME) + ' vs ' + kHome2);
  const kTill = K.store('foxy.cashu.log', []).filter((e) => e.till === true && String(e.mint).replace(/\/+$/, '') === HOME);
  ok(kTill.length >= 1 && kTill.some((e) => e.sats === 30 && e.who === 'cashier'), 'with a till row at HOME', JSON.stringify(kTill.map((e) => [e.sats, e.mint])));
  ok((await K.W._tillArrived(pass2.id, JSON.stringify(Object.assign(JSON.parse(forK.body), { mint: USDM })))) === 'refused', 'a delivery naming a mint the code does not take is refused');

  /* ---- a till's mints keep their keys, and fetch them again when they have gone (review, cache-evict) -------------- */
  const CACHE = 'foxy.cashu.mint.cache';
  const dropKeys = (ctx, m) => { const c = ctx.store(CACHE, {}); delete c[m]; ctx.storage.setItem(CACHE, JSON.stringify(c)); };
  // a cache full of other mints, HOME's entry the oldest of all: the oldest of the rest go, never a till mint's
  const filled = K.store(CACHE, {});
  const homeEntry = filled[HOME];
  for (let i = 0; i < 14; i++) filled['https://old' + i + '.test'] = Object.assign({}, homeEntry, { at: 1000 + i });
  filled[HOME] = Object.assign({}, homeEntry, { at: 10 });
  K.storage.setItem(CACHE, JSON.stringify(filled));
  await K.W.connect(MINT, { remember: true });
  const cacheNow = K.store(CACHE, {});
  ok(Object.keys(cacheNow).length === 12 && !!cacheNow[HOME] && !!cacheNow[MINTc] && !cacheNow['https://old0.test'] && !!cacheNow['https://old13.test'],
    'a full mint cache keeps twelve, dropping the oldest of the rest and never the open till’s mints', Object.keys(cacheNow).join(' '));
  await K.W.tillKeeperClose();
  filled[HOME] = Object.assign({}, cacheNow[HOME], { at: 10 });
  K.storage.setItem(CACHE, JSON.stringify(Object.assign({}, cacheNow, { 'https://old0.test': filled['https://old0.test'], [HOME]: filled[HOME] })));
  await K.W.connect(MINT, { remember: true });
  ok(!!K.store(CACHE, {})[HOME], 'with the till closed, a cashier code still listened on keeps its mints’ keys', Object.keys(K.store(CACHE, {})).join(' '));
  await K.W.tillKeeperOpen([MINT, HOME], MINT);

  // the cashier's next HOME payments, delivered: the keeper's copy of HOME's keys gone
  const deliver = async (n) => {
    relay = [];
    const t = await P.W.sendToken(n, { unit: 'sat', lockTo: pass2.lock });
    await C.W.tillTakeToken(t.token);
    await until(() => relay.length > 0);
    return (relay.find((r) => sumOf(JSON.parse(r.body).proofs) === n) || {}).body;
  };
  const body9 = await deliver(9);
  dropKeys(K, HOME);
  const h9 = K.W.balanceAt(HOME);
  const got9 = body9 ? await K.W._tillArrived(pass2.id, body9) : '';
  ok(got9 === 'taken' && K.W.balanceAt(HOME) === h9 + 9 && !!K.store(CACHE, {})[HOME] && K.W.mintUrl === MINT,
    'a cashier’s HOME payment, HOME’s keys gone: asked for once, and taken into HOME’s pile', got9 + ', ' + (K.W.balanceAt(HOME) - h9));
  const body11 = await deliver(11);
  const notSigned = JSON.parse(body9);
  notSigned.proofs = notSigned.proofs.map((pr, i) => Object.assign({}, pr, { secret: pr.secret.replace(/"nonce":"[0-9a-f]+"/, '"nonce":"' + 'ab'.repeat(16) + String(i) + '"') }));
  dropKeys(K, HOME);
  K.W._privacy({ tor: 'connecting', progress: 40, everUp: true });
  const h11 = K.W.balanceAt(HOME);
  const got11 = body11 ? await K.W._tillArrived(pass2.id, body11) : '';
  const gotF = await K.W._tillArrived(pass2.id, JSON.stringify(notSigned));
  ok(got11 === 'kept' && gotF === 'kept' && K.store('foxy.till.inbox', []).length === 2,
    'with no route and no keys for HOME, a delivery is kept in the inbox, not refused', got11 + ' ' + gotF + ', inbox ' + K.store('foxy.till.inbox', []).length);
  K.W._privacy({ tor: 'up', progress: 100, everUp: true });
  await K.W.tillListen();
  await until(() => K.W.balanceAt(HOME) >= h11 + 11 && !K.store('foxy.till.inbox', []).length);
  ok(K.W.balanceAt(HOME) === h11 + 11 && K.store('foxy.till.inbox', []).length === 0 && !!K.store(CACHE, {})[HOME],
    'when the route returns the keys are asked for: the real one taken at HOME, the one HOME never signed refused and let go',
    (K.W.balanceAt(HOME) - h11) + ', inbox ' + K.store('foxy.till.inbox', []).length);

  // the keeper's own request at HOME, HOME's keys gone: asked for once and read again
  const kReq4 = K.W.decodeRequest(K.W.paymentRequest(25, { unit: 'sat', mints: [MINT, HOME] })) || {};
  const pay25 = proofsOf(P, (await P.W.sendToken(25, { unit: 'sat', lockTo: kReq4.lockTo })).token);
  dropKeys(K, HOME);
  const h25 = K.W.balanceAt(HOME);
  await K.W._requestPaid(JSON.stringify({ id: kReq4.id, mint: HOME, unit: 'sat', proofs: pay25 }), 'k6', 'tap');
  await until(() => K.W.balanceAt(HOME) > h25);
  ok((K.said.answers.find((a) => a.answer === 'k6') || {}).status === 200 && K.W.balanceAt(HOME) === h25 + 25 && !!K.store(CACHE, {})[HOME],
    'a payment at HOME to the keeper’s request, HOME’s keys gone: the keys asked for once, the payment read again and taken',
    JSON.stringify(K.said.answers.find((a) => a.answer === 'k6')));
  // and the cashier's
  const cReq5 = C.W.decodeRequest(C.W.paymentRequest(15, { unit: 'sat', lockPub: pass2.lock, purpose: 'till' })) || {};
  const pay15 = proofsOf(P, (await P.W.sendToken(15, { unit: 'sat', lockTo: pass2.lock })).token);
  dropKeys(C, HOME);
  await C.W._requestPaid(JSON.stringify({ id: cReq5.id, mint: HOME, unit: 'sat', proofs: pay15 }), 'c5', '');
  await until(() => (C.said.answers.find((a) => a.answer === 'c5') || {}).status > 0);
  ok((C.said.answers.find((a) => a.answer === 'c5') || {}).status === 200 && !!C.store('foxy.till.outbox', []).find((r) => r.hash === 'till-' + cReq5.id),
    'and the cashier’s, the same: taken for the keeper, into the outbox', JSON.stringify(C.said.answers.find((a) => a.answer === 'c5')));
  await C.W.tillLeave();
  await K.W.tillKeeperClose();

  /* ---- a till of eight: every key on file at the end, or the true reason (review, cache-evict) ------------------- */
  const eight = [MINT, HOME].concat(Array.from({ length: 6 }, (_, i) => 'https://x' + i + '.test'));
  const open8 = await K.W.tillKeeperOpen(eight, MINT).then((r) => r, (e) => ({ no: e.message }));
  const cache8 = K.store(CACHE, {});
  ok(!open8.no && eight.every((m) => !!cache8[String(m).replace(/\/+$/, '')]), 'a till of eight mints opens with every one’s keys on file', open8.no || Object.keys(cache8).join(' '));
  ok(!!K.W.paymentRequest(30, { unit: 'sat', mints: eight }), 'and its request names all eight');
  await K.W.tillKeeperClose();
  // keys lost between their loading and the end of the opening (the store dropping one): refused by that, by name
  const SP = K.window.Storage.prototype;
  const setItem0 = SP.setItem;
  SP.setItem = function (k, v) {
    if (k === CACHE && /x5\.test/.test(String(v))) { const all = JSON.parse(v); delete all[HOME]; v = JSON.stringify(all); }
    return setItem0.call(this, k, v);
  };
  dropKeys(K, 'https://x5.test');
  const open8b = await K.W.tillKeeperOpen(eight, MINT).then(() => '', (e) => e.message);
  SP.setItem = setItem0;
  ok(/keys of home\.test could not be kept/.test(open8b) && K.store('foxy.till.keeper', null) === null,
    'keys gone by the end of the opening: refused for that, naming the mint, no till written', open8b);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

run().then(() => setTimeout(() => process.exit(process.exitCode || 0), 50), (e) => {
  console.log('FAIL  the suite stopped: ' + (e && e.stack || e));
  process.exit(1);
});
