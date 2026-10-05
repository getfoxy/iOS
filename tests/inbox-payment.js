'use strict';
/* inbox-payment.js — what a stranger may post into this phone's onion inbox.
 *
 *     node tests/inbox-payment.js
 *
 * `_requestPaid` (build/wallet/20-helpers.js, readPayment in
 * 07-request-delivery.js) is the one place where bytes written by someone else
 * reach the wallet without a person deciding anything: the payer's phone opens
 * a Tor connection to a one-time onion address and POSTs a NUT-18 payment. The
 * Swift side checks the HTTP framing (FoxyTests/OnionHTTPTests.swift); this
 * checks what the page does with the body once it is through.
 *
 * Two properties matter more than the rest, and the fuzz round at the end holds
 * them over thousands of mutated bodies:
 *   - nothing is redeemed unless the payment answers a request open on this
 *     phone, at this mint, for at least what was asked;
 *   - the payer is answered exactly once, whatever arrives — a body that threw
 *     inside the reader would otherwise leave the connection hanging until the
 *     inbox's own 100-second timeout, holding one of four slots.
 */
const { loadReal, fakeMint, nativePhone } = require('./harness');

const MINT = 'https://m.test';
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));

/* The page as it ships, with a fake mint behind the bridge, and every answer
 * the inbox would send back to the payer recorded instead. */
function page(storage) {
  const phone = nativePhone({ words: WORDS });
  const answers = [];
  const refuse = { keys: null };
  /* What the phone says when asked for this page's addresses (`inboxOpen`), the
   * payments handed to relays (`nostrSend`) and how many relays took them. */
  const inbox = { text: '' };
  const nostrSent = [];
  const relays = { took: 2 };
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    storage: storage || undefined,
    bridge: (w, m) => {
      if (m.action === 'inboxAnswer') {
        answers.push({ answer: m.answer, status: m.status, text: String(m.text || '') });
        return reply(w, m.id, 'ok');
      }
      if (m.action === 'inboxOpen') return reply(w, m.id, inbox.text);
      if (m.action === 'nostrSend') {
        nostrSent.push({ target: m.target, body: String(m.body || '') });
        return reply(w, m.id, String(relays.took));
      }
      if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => {
      phone.attach(w);
      mint = fakeMint(w);
      /* A store that refuses one key, so a write can be made to fail where it
       * matters rather than everywhere. It goes on `Storage.prototype`: jsdom
       * honours that, and overriding the instance's `setItem` silently does
       * nothing. */
      const real = w.Storage.prototype.setItem;
      w.Storage.prototype.setItem = function (k, v) {
        if (refuse.keys && refuse.keys.test(String(k))) throw new Error('QuotaExceededError');
        return real.call(this, k, v);
      };
    },
  });
  return Object.assign(ctx, { phone, answers, refuse, inbox, nostrSent, relays, get mint() { return mint; } });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* An answer for this delivery, once one has been sent. The redemption is a
 * swap at the mint, so this waits for it rather than guessing at a delay. */
async function answerFor(ctx, id, ms) {
  const until = Date.now() + (ms || 4000);
  while (Date.now() < until) {
    const hit = ctx.answers.filter((a) => a.answer === id);
    if (hit.length) { await wait(30); return ctx.answers.filter((a) => a.answer === id); }
    await wait(10);
  }
  return [];
}

async function run() {
  const ctx = page();
  const W = ctx.W;
  await W.connect(MINT, { remember: true });

  // funds: an invoice at the fake mint, claimed, so there are proofs to spend
  const inv = await W.invoice(128, '');
  await W.claim(inv.hash);

  /* A payment as a payer's wallet would post it: the proofs of a token for the
   * amount asked, in NUT-18's shape. */
  async function paymentFor(id, sats) {
    const made = await W.sendToken(sats, { unit: 'sat' });
    const info = W.tokenInfo(made.token);
    return {
      id: id,
      memo: 'a coffee',
      mint: String(info.mint).replace(/\/+$/, ''),
      unit: 'sat',
      proofs: info.proofs.map((p) => ({ id: p.id, amount: p.amount, secret: p.secret, C: p.C })),
    };
  }

  function openRequest(sats) {
    const creq = W.paymentRequest(sats, { purpose: 'receive' });
    const read = W.decodeRequest(creq);
    return read.id;
  }

  // ---- the payment that should work -----------------------------------------
  const heard = [];
  W.onRequestPaid((ev) => heard.push(ev));
  const id = openRequest(21);
  const good = await paymentFor(id, 21);
  const before = await W.balanceSats();
  W._requestPaid(JSON.stringify(good), 'd1');
  const first = await answerFor(ctx, 'd1');
  check('a payment for an open request is taken and answered 200',
    first.length === 1 && first[0].status === 200, JSON.stringify(first));
  const after = await W.balanceSats();
  check('the sats land in the wallet', after === before + 21, 'balance ' + after + ', was ' + before);
  check('the page hears that the request was paid',
    heard.some((e) => e.stage === 'paid' && e.sats === 21 && e.id === id),
    JSON.stringify(heard.map((e) => e.stage)));

  // the request is single use: the same id again answers no open request
  const again = await paymentFor(id, 21);
  W._requestPaid(JSON.stringify(again), 'd2');
  const twice = await answerFor(ctx, 'd2');
  check('a request that has been paid is closed', twice.length === 1 && twice[0].status === 422,
    JSON.stringify(twice));

  // ---- what must be refused, one property at a time -------------------------
  /* Every case below starts from a body that would work and breaks one thing,
   * so a refusal can only be the property named.
   *
   * One set of proofs serves them all: a refused payment is never redeemed, so
   * its proofs stay good. Minting a fresh token per case drained the wallet
   * instead, and the suite started failing on "not enough ecash" rather than on
   * anything it was testing.
   */
  const spare = await paymentFor('', 21);

  async function refused(name, change, status) {
    const openId = openRequest(21);
    const body = JSON.parse(JSON.stringify(spare));
    body.id = openId;
    const sent = change(body, openId);
    const key = 'r' + results.length;
    const balanceBefore = await W.balanceSats();
    W._requestPaid(typeof sent === 'string' ? sent : JSON.stringify(sent === undefined ? body : sent), key);
    const got = await answerFor(ctx, key);
    const balanceAfter = await W.balanceSats();
    const ok = got.length === 1 && got[0].status === status && balanceAfter === balanceBefore;
    check(name, ok, JSON.stringify(got) + ' balance ' + balanceAfter + ' was ' + balanceBefore);
  }

  await refused('a payment for no open request is refused', (b) => { b.id = 'ff'.repeat(4); }, 422);
  await refused('a payment with no id is refused', (b) => { delete b.id; }, 422);
  await refused('an id of the wrong type is refused', (b) => { b.id = { toString: () => 'x' }; }, 422);
  await refused('a payment at another mint is refused', (b) => { b.mint = 'https://elsewhere.test'; }, 422);
  await refused('a payment with no mint is refused', (b) => { delete b.mint; }, 422);
  await refused('a payment in another unit is refused', (b) => { b.unit = 'usd'; }, 422);
  await refused('a payment with no proofs is refused', (b) => { b.proofs = []; }, 422);
  await refused('a payment with proofs that are not a list is refused', (b) => { b.proofs = { a: 1 }; }, 422);
  await refused('more proofs than a payment can hold is refused',
    (b) => { b.proofs = new Array(501).fill(b.proofs[0]); }, 422);
  await refused('a proof with no signature is refused', (b) => { delete b.proofs[0].C; }, 422);
  await refused('a proof with no secret is refused', (b) => { delete b.proofs[0].secret; }, 422);
  await refused('a proof with no keyset is refused', (b) => { delete b.proofs[0].id; }, 422);
  await refused('a proof of nothing is refused', (b) => { b.proofs[0].amount = 0; }, 422);
  await refused('a proof of a negative amount is refused', (b) => { b.proofs[0].amount = -64; }, 422);
  await refused('a proof whose amount is not a number is refused', (b) => { b.proofs[0].amount = 'lots'; }, 422);
  await refused('less than the request asked for is refused', async (b) => {
    b.proofs = b.proofs.slice(0, 0).concat(b.proofs.filter((p) => p.amount < 16));
    if (!b.proofs.length) b.proofs = [{ id: 'aa', amount: 1, secret: 'x', C: '02' + 'aa'.repeat(32) }];
  }, 422);
  // a body that is not a payment at all is a bad request, not an unprocessable one
  await refused('a body that is not JSON is refused', () => 'not json at all', 400);
  await refused('an empty body is refused', () => '', 400);
  await refused('a body that is a list is refused', () => '[1,2,3]', 400);
  await refused('a body that is a number is refused', () => '42', 400);
  await refused('a body of nothing but whitespace is refused', () => '   \n  ', 400);

  /* Proofs that are well formed and answer a real request, but which the mint
   * will not swap: the payer hears that, and nothing lands. */
  const spentId = openRequest(21);
  const spentBody = await paymentFor(spentId, 21);
  W._requestPaid(JSON.stringify(spentBody), 's1');
  await answerFor(ctx, 's1');
  const replayId = openRequest(21);
  const replay = Object.assign({}, spentBody, { id: replayId });
  const wasBalance = await W.balanceSats();
  W._requestPaid(JSON.stringify(replay), 's2');
  const spentAnswer = await answerFor(ctx, 's2', 8000);
  const nowBalance = await W.balanceSats();
  check('proofs the mint has already taken are refused, not counted',
    spentAnswer.length === 1 && (spentAnswer[0].status === 409 || spentAnswer[0].status === 422)
      && nowBalance === wasBalance,
    JSON.stringify(spentAnswer) + ' balance ' + nowBalance + ' was ' + wasBalance);

  // ---- a second delivery while the first is still being redeemed ------------
  const raceId = openRequest(21);
  const raceBody = JSON.stringify(await paymentFor(raceId, 21));
  W._requestPaid(raceBody, 'x1');
  W._requestPaid(raceBody, 'x2');
  const second = await answerFor(ctx, 'x2', 6000);
  check('a request already being paid answers 409 rather than redeeming twice',
    second.length === 1 && second[0].status === 409, JSON.stringify(second));
  await answerFor(ctx, 'x1', 8000);

  // ---- a payment that cannot be written down ------------------------------
  {
    /* The store this phone writes an arriving payment to is the first thing
     * `_requestPaid` touches, and its write swallowed a refusal until
     * it was fixed: a full store answered the payer 200, wrote a settled entry
     * into history, counted the sats, and handed the only copy of the token to
     * a timer no relaunch could find. Refused, the payer keeps their ecash. */
    const fullId = openRequest(21);
    const body = JSON.stringify(await paymentFor(fullId, 21));
    const was = await W.balanceSats();
    ctx.refuse.keys = /^foxy\.req\.unclaimed$/;
    W._requestPaid(body, 'full1');
    const said = await answerFor(ctx, 'full1');
    ctx.refuse.keys = null;
    const now = await W.balanceSats();
    check('a payment that cannot be written down is refused, not taken',
      said.length === 1 && said[0].status === 422 && now === was,
      JSON.stringify(said) + ' balance ' + now + ' was ' + was);
    check('and nothing about it reached history',
      !(await W.transactions(50)).some((t) => t.hash === 'req-' + fullId), 'an entry was written');
    check('and nothing is left waiting to be claimed',
      !JSON.parse(ctx.storage.getItem('foxy.req.unclaimed') || '{}')[fullId],
      String(ctx.storage.getItem('foxy.req.unclaimed')));
    /* Still open, and the in-flight flag off: that is what "try again" means to
     * the payer, and the difference between refusing and dropping. */
    W._requestPaid(body, 'full2');
    const retry = await answerFor(ctx, 'full2', 8000);
    check('and the same payment is taken once there is room again',
      retry.length === 1 && retry[0].status === 200 && (await W.balanceSats()) === was + 21,
      JSON.stringify(retry) + ' balance ' + (await W.balanceSats()) + ' was ' + was);
  }

  // ---- fuzz: mutated bodies, deterministic ---------------------------------
  /* A fixed seed, so a failure here is reproducible: this suite runs on every
   * push and a flaky one would be ignored within a week. */
  let seed = 20260917 >>> 0;
  const rnd = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };
  const pick = (list) => list[Math.floor(rnd() * list.length) % list.length];
  const NASTY = [null, undefined, 0, -1, 1e308, '', ' ', ' ', '\\', '"', '{}', '[]',
    'x'.repeat(4096), { toString() { throw new Error('no'); } }, { a: { b: { c: 1 } } },
    [1, 2, 3], true, false, '../../etc/passwd', '<script>', '\ud800'];

  const fuzzId = openRequest(21);
  const template = JSON.parse(JSON.stringify(spare));
  template.id = fuzzId;
  const CASES = 1200;
  let threw = 0, answered = 0, wrongCount = 0, taken = 0;
  const balanceAtStart = await W.balanceSats();
  for (let i = 0; i < CASES; i++) {
    const body = JSON.parse(JSON.stringify(template));
    const how = Math.floor(rnd() * 6);
    if (how === 0) body[pick(['id', 'mint', 'unit', 'memo', 'proofs'])] = pick(NASTY);
    if (how === 1 && body.proofs.length) body.proofs[0][pick(['id', 'amount', 'secret', 'C'])] = pick(NASTY);
    if (how === 2) body.proofs = pick([[], [pick(NASTY)], new Array(600).fill(body.proofs[0])]);
    if (how === 3) body[String(pick(['__proto__', 'constructor', 'toString', 'x']))] = pick(NASTY);
    if (how === 4) body.proofs = body.proofs.concat([{ id: 'aa', amount: pick([1, -1, 0.5]), secret: 's', C: 'C' }]);
    let text;
    try { text = JSON.stringify(body); } catch (e) { text = String(body); }
    if (how === 5) {
      // damaged text, not a damaged object: the reader parses before it checks
      const at = Math.floor(rnd() * text.length);
      text = text.slice(0, at) + pick(['', '}', '{', '"', ' ', ',']) + text.slice(at + 1);
    }
    const key = 'f' + i;
    try { W._requestPaid(text, key); } catch (e) { threw += 1; }
  }
  await wait(600);
  for (let i = 0; i < CASES; i++) {
    const hit = ctx.answers.filter((a) => a.answer === 'f' + i);
    if (hit.length === 1) answered += 1; else wrongCount += 1;
    if (hit.length && hit[0].status === 200) taken += 1;
  }
  check('no mutated body makes the reader throw', threw === 0, threw + ' of ' + CASES + ' threw');
  check('every mutated body is answered exactly once', wrongCount === 0,
    wrongCount + ' of ' + CASES + ' were answered a number of times other than once');
  /* A mutation that only adds a field it does not know leaves a payment that is
   * still valid, and taking it is right — NUT-18 bodies must tolerate fields a
   * wallet has not heard of. What must hold is that the same proofs cannot be
   * taken twice, however the body around them is damaged. */
  const balanceAtEnd = await W.balanceSats();
  check('a mutated body is taken at most once, and only while it is still a payment',
    taken <= 1, taken + ' of ' + CASES + ' were answered 200');
  check('the balance moves by at most the one payment in hand',
    balanceAtEnd - balanceAtStart === (taken === 1 ? 21 : 0),
    'balance ' + balanceAtEnd + ', was ' + balanceAtStart + ', taken ' + taken);

  /* The same mutations again, on a body that answers no request open here: now
   * nothing may be taken at all, whatever the rest of it says. */
  const closedTemplate = JSON.parse(JSON.stringify(spare));
  closedTemplate.id = 'ab'.repeat(4);
  const CLOSED = 400;
  let closedTaken = 0, closedThrew = 0;
  const balanceBeforeClosed = await W.balanceSats();
  for (let i = 0; i < CLOSED; i++) {
    const body = JSON.parse(JSON.stringify(closedTemplate));
    const how = Math.floor(rnd() * 5);
    if (how === 0) body[pick(['mint', 'unit', 'memo', 'proofs'])] = pick(NASTY);
    if (how === 1 && body.proofs.length) body.proofs[0][pick(['id', 'amount', 'secret', 'C'])] = pick(NASTY);
    if (how === 2) body[String(pick(['__proto__', 'constructor', 'x']))] = pick(NASTY);
    if (how === 3) body.id = pick([closedTemplate.id, '', null, 'ff'.repeat(4), { }]);
    let text;
    try { text = JSON.stringify(body); } catch (e) { text = String(body); }
    try { W._requestPaid(text, 'c' + i); } catch (e) { closedThrew += 1; }
  }
  await wait(400);
  for (let i = 0; i < CLOSED; i++) {
    const hit = ctx.answers.filter((a) => a.answer === 'c' + i);
    if (hit.length && hit[0].status === 200) closedTaken += 1;
  }
  const balanceAfterClosed = await W.balanceSats();
  check('nothing is taken for a request that is not open, however the body is mutated',
    closedTaken === 0 && closedThrew === 0 && balanceAfterClosed === balanceBeforeClosed,
    closedTaken + ' taken, ' + closedThrew + ' threw, balance ' + balanceAfterClosed
      + ' was ' + balanceBeforeClosed);

  check('the fuzz round really ran', answered === CASES, answered + ' answered of ' + CASES);

  /* ---- a reload does not forget the request ---------------------------------
   *
   * iOS reloads this page when it likes. The record of a request this wallet
   * issued was memory only, so a payer arriving after a reload was told "That
   * payment answers no request open here" — with the key that opens their ecash
   * still in LOCK_KEYS, where nothing could reach it. The same page, from
   * the same store, still answers
   * the request it made. */
  {
    const id = openRequest(21);
    const body = JSON.stringify(await paymentFor(id, 21));
    const dump = {};
    for (let i = 0; i < ctx.storage.length; i++) {
      const k = ctx.storage.key(i);
      dump[k] = ctx.storage.getItem(k);
    }
    check('the request this wallet issued is written down, not only held',
      /"?[0-9a-f]{2,}"?/.test(String(dump['foxy.req.open'] || '')) && String(dump['foxy.req.open']).includes(id),
      String(dump['foxy.req.open'] || '(nothing)').slice(0, 120));

    const back = page(dump);
    await back.W.connect(MINT, { remember: true });
    back.W._requestPaid(body, 'r1');
    const said = await answerFor(back, 'r1', 6000);
    check('a payment arriving after a reload is still taken',
      said.length === 1 && said[0].status === 200,
      JSON.stringify(said) || '(no answer)');
  }

  /* ---- the addresses the phone hands out for a request ----------------------
   *
   * `openInbox` reads what the phone answers and keeps only what has the shape
   * of an address. Either one alone is a way to be paid, so it is enough; only
   * having neither leaves the request with nowhere to be paid. */
  {
    const onion = 'http://' + 'a'.repeat(55) + 'd.onion/' + 'b'.repeat(32);
    const nostr = 'nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhhy'
      + 'tnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34kytnrdaksjlyr9p';
    const opened = (text) => {
      ctx.inbox.text = text;
      return W.openInbox().then((r) => r, (e) => ({ failed: e.message }));
    };
    const both = await opened(JSON.stringify({ onion: onion, nostr: nostr }));
    check('an inbox with both addresses hands out both',
      both && both.onion === onion && both.nostr === nostr, JSON.stringify(both));
    const onlyOnion = await opened(JSON.stringify({ onion: onion }));
    check('an inbox with only an onion address is still an inbox',
      onlyOnion && onlyOnion.onion === onion && !onlyOnion.nostr && !onlyOnion.failed, JSON.stringify(onlyOnion));
    const onlyNostr = await opened(JSON.stringify({ nostr: nostr }));
    check('an inbox with only a relay address is still an inbox',
      onlyNostr && onlyNostr.nostr === nostr && !onlyNostr.onion && !onlyNostr.failed, JSON.stringify(onlyNostr));
    const oneBad = await opened(JSON.stringify({ onion: 'http://evil.example/x', nostr: nostr }));
    check('an address of the wrong shape is left out, and the good one kept',
      oneBad && oneBad.nostr === nostr && !oneBad.onion, JSON.stringify(oneBad));
    const noneGood = await opened(JSON.stringify({ onion: 'http://evil.example/x', nostr: 'npub1nope' }));
    check('with neither address fit to hand out it is refused',
      !!(noneGood && noneGood.failed) && /no address/i.test(noneGood.failed), JSON.stringify(noneGood));
    const rubbish = await opened('not json at all');
    check('an answer that is not JSON is refused',
      !!(rubbish && rubbish.failed) && /no address/i.test(rubbish.failed), JSON.stringify(rubbish));

    /* ---- paying a request that names only a relay ---------------------------
     *
     * A request made by a phone with no onion to offer carries a Nostr address
     * tagged as NIP-17 and nothing else. It has to read as payable, and paying
     * it has to hand the payment to the phone's relay sender, addressed to
     * that profile, for exactly what was asked. */
    const asked = W.decodeRequest(W.paymentRequest(21, { deliverTo: { nostr: nostr }, purpose: 'receive' }));
    check('a request that names only a relay address can be paid',
      !!asked && asked.deliverable === true && !!asked.delivery && asked.delivery.kind === 'nostr'
        && asked.delivery.target === nostr, JSON.stringify(asked && asked.delivery));
    const held = await W.balanceSats();
    const paid = await W.payRequest(asked).then((r) => r, (e) => ({ failed: e.message }));
    check('paying it goes through', !!paid && !paid.failed && Number(paid.sats) === 21, JSON.stringify(paid).slice(0, 120));
    check('and nobody says it was confirmed, since a relay taking it only means it was handed on',
      !!paid && paid.confirmed === false, String(paid && paid.confirmed));
    const sentTo = ctx.nostrSent;
    check('the payment is handed to the relay sender once, for that profile',
      sentTo.length === 1 && sentTo[0].target === nostr, JSON.stringify(sentTo.map((x) => x.target)));
    const sent = sentTo.length ? JSON.parse(sentTo[0].body) : {};
    const inBody = (sent.proofs || []).reduce((n, pr) => n + Number(pr.amount), 0);
    check('and what is in it answers the request: its id, this mint, the 21 sats',
      sent.id === asked.id && String(sent.mint).replace(/\/+$/, '') === MINT && inBody === 21,
      JSON.stringify({ id: sent.id, mint: sent.mint, sats: inBody }));
    check('those 21 sats have left the balance', (await W.balanceSats()) === held - 21,
      held + ' -> ' + (await W.balanceSats()));
  }

  results.forEach((r) => console.log(r));
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  if (failed) { console.log('\n' + failed + ' inbox check(s) failed'); process.exit(1); }
  console.log('\nall ' + results.length + ' inbox payment checks pass');
  // jsdom keeps its timers, and the wallet's background checks with them
  process.exit(0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
