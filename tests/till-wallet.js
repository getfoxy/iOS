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
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PAYER_WORDS = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const URL0 = 'https://getfoxy.io/till#';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
        const mint = url.indexOf('home.test') >= 0 ? mints.home : mints.main;
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

  const send25 = await P.W.sendToken(25, { unit: 'sat', lockTo: pass.lock });
  const p25 = proofsOf(P, send25.token);
  await C.W._requestPaid(bodyFor(req3.id, p25), 'a5', '');
  const ans5 = C.said.answers.find((a) => a.answer === 'a5') || {};
  ok(ans5.status === 422 && /cannot give change/.test(ans5.text), 'an over-payment the payer did not mark is refused', JSON.stringify(ans5));

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

  // the over-payment, marked: taken, no change
  await C.W._requestPaid(bodyFor(req3.id, p25, { overpaid: true }), 'a8', '');
  const ans8 = C.said.answers.find((a) => a.answer === 'a8') || {};
  ok(ans8.status === 200 && outN() === n0 + 1, 'an over-payment the payer marked is taken, whole', JSON.stringify(ans8));
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

  // at another mint: kept, and taken on the next listen at the code's mint
  const second = relay.find((r) => JSON.parse(r.body).id === 'till:' + pass.id + ':2');
  await K.W.connect(HOME, { remember: true });
  ok((await K.W._tillArrived(pass.id, second.body)) === 'kept', 'a delivery while the keeper is at another mint is kept');
  ok(K.store('foxy.till.inbox', []).length === 1, 'in the till’s inbox');
  await K.W.connect(MINT, { remember: true });
  const kMid = await K.W.balanceSats();
  await K.W.tillListen();
  await wait(50);
  ok(K.store('foxy.till.inbox', []).length === 0 && (await K.W.balanceSats()) === kMid + 25, 'and taken at its own mint on the next listen',
    (await K.W.balanceSats()) + ' vs ' + kMid);
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
  ok((await K.W._tillArrived(pass.id, bodyFor('till:x:6', forged(3)))) === 'refused' && K.store('foxy.till.inbox', []).length === 0,
    'at another mint a forged body is refused, not kept for later');
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

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

run().then(() => setTimeout(() => process.exit(process.exitCode || 0), 50), (e) => {
  console.log('FAIL  the suite stopped: ' + (e && e.stack || e));
  process.exit(1);
});
