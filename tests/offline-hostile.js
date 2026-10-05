'use strict';
/* offline-hostile.js — a cheat on the other end of an offline payment.
 *
 *     node tests/offline-hostile.js
 *
 * One phone has a route and one has not, and the one with the route is not
 * honest. Every case hands this wallet something a modified app could send,
 * and asks what it does with it. Written as a probe, and every case
 * in it was accepted at the time; each is refused now, and this holds them there.
 *
 *   A. a payer cheating a receiver that has no route (locked ecash, taken
 *      without the mint): a proof repeated, a sat short, the wrong request, an
 *      altered amount, no proof of the mint's signature;
 *   B. a receiver cheating a payer that has no route (change coming back
 *      over the link): a proof repeated;
 *   C. the app's side: carry terms whose request is not for the figure the
 *      fee card shows, and a refund far smaller than what was paid.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
const fs = require('fs');
const path = require('path');

const MINT = 'https://m.test';
let failed = 0;
const findings = [];
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) { failed += 1; findings.push(name + (detail ? ' — ' + detail : '')); }
};
const say = (t) => console.log('      ' + t);
const settle = async (n) => { for (let i = 0; i < (n || 400); i++) await new Promise((r) => setTimeout(r, 0)); };

const answers = [];
function page() {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') { ctx.asked.push(String(m.url || '')); return reply(w, m.id, mint.handle(m)); }
      if (m.action === 'inboxAnswer') {
        answers.push({ status: Number(m.status), text: String(m.text || '') });
        return reply(w, m.id, 'ok');
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w, { p2pk: true }); },
  });
  ctx.asked = [];
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}
const offline = (W) => { W._privacy({ tor: 'connecting', progress: 0, everUp: true, unprotected: false, transport: 'direct', network: 'none' }); W.setOffline(true); };
const online = (W) => { W.setOffline(false); W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' }); };
const wire = (pr) => Object.assign({ id: pr.id, amount: Number(String(pr.amount)), secret: pr.secret, C: pr.C }, pr.dleq ? { dleq: pr.dleq } : {});

async function run() {
  const ctx = page();
  const W = ctx.W;
  const CT = ctx.window.CashuTS;
  await W.connect(MINT, null, null, { remember: true });
  await W.primeLocks();
  await W.claim((await W.invoice(4000, '')).hash);
  const unclaimedRows = () => JSON.parse(ctx.storage.getItem('foxy.req.unclaimed') || '{}');
  const history = () => JSON.parse(ctx.storage.getItem('foxy.cashu.log') || '[]');

  /* One arrival over the link, with the receiver offline: what it answered,
   * what it then shows, and what it wrote down. */
  const arrive = async (ask, proofs) => {
    const before = await W.balanceSats();
    const mark = answers.length;
    W._requestPaid(JSON.stringify({ id: ask.id, mint: MINT, unit: 'sat', proofs: proofs }), 'wire-' + mark, 'tap');
    await settle();
    const said = answers.slice(mark)[0] || {};
    const row = history().filter((e) => e.hash === 'req-' + ask.id)[0] || null;
    return { status: said.status, text: said.text, up: (await W.balanceSats()) - before, kept: !!unclaimedRows()[ask.id], row };
  };
  const lockedFor = async (askSats, paySats) => {
    online(W);
    const ask = W.decodeRequest(W.paymentRequest(askSats, { purpose: 'receive' })) || {};
    const pay = await W.sendToken(paySats, { unit: 'sat', lockTo: ask.lockTo });
    const proofs = W.tokenInfo(pay.token).proofs.map(wire);
    offline(W);
    return { ask, pay, proofs };
  };

  console.log('\nA. a cheating payer, and a receiver with no route');
  {
    // the control: an honest locked payment is taken
    const t = await lockedFor(64, 64);
    const r = await arrive(t.ask, t.proofs);
    ok(r.status === 200 && r.up === 64 && r.kept, 'control: an honest locked payment is taken offline for what it is', 'answered ' + r.status + ', up ' + r.up);
  }
  {
    /* 64 sats of real ecash, locked to this phone, sent as the same proofs
     * twice for a request of 128. The lock is right and the mint's signature
     * verifies on every one, because every one is the same proof. */
    const t = await lockedFor(128, 64);
    const twice = t.proofs.concat(t.proofs);
    const r = await arrive(t.ask, twice);
    ok(r.status !== 200 && r.up === 0 && !r.kept, 'a payment made of the same proofs twice is refused',
       'asked 128, sent 64 twice: answered ' + r.status + (r.status === 200 ? ' — PAYMENT RECEIVED for ' + (r.row ? r.row.sats : '?') + ' sats, balance up ' + r.up : ': ' + String(r.text).slice(0, 80)));
    if (r.status === 200) {
      // what becomes of it when the receiver finds a route
      online(W);
      const pileBefore = W.balanceAt(MINT);
      await W.claimUnclaimed();
      await settle();
      const left = unclaimedRows()[t.ask.id];
      const rowNow = history().filter((e) => e.hash === 'req-' + t.ask.id)[0] || {};
      say('with a route: the pile went up ' + (W.balanceAt(MINT) - pileBefore) + ' for an entry that says ' + rowNow.sats + ' (' + rowNow.state + '); '
        + (left ? 'the payment is still written down as waiting, ' + left.sats + ' sats counted in the balance' : 'nothing is left waiting'));
      const stuck = !!unclaimedRows()[t.ask.id];
      ok(!stuck, 'and it does not stay in the balance as money the mint will never honour', stuck ? 'it does: ' + W.unclaimedSats() + ' sats waiting for ever' : '');
      if (stuck) { const all = unclaimedRows(); delete all[t.ask.id]; ctx.storage.setItem('foxy.req.unclaimed', JSON.stringify(all)); }
      offline(W);
    }
  }
  {
    // the same, shown as a code and scanned
    const t = await lockedFor(128, 64);
    const token = CT.getEncodedToken({ mint: MINT, unit: 'sat', proofs: W.tokenInfo(t.pay.token).proofs.concat(W.tokenInfo(t.pay.token).proofs) });
    const before = await W.balanceSats();
    const got = await W.receiveToken(token).then((x) => x, (e) => ({ why: e && e.message }));
    const up = (await W.balanceSats()) - before;
    ok(!got.kept && up === 0, 'the same proofs twice in a scanned token are refused', got.kept ? 'kept as ' + got.sats + ' sats, balance up ' + up : String(got.why).slice(0, 90));
    if (got.kept) { const all = unclaimedRows(); Object.keys(all).forEach((k) => { if (/^scan-/.test(k)) delete all[k]; }); ctx.storage.setItem('foxy.req.unclaimed', JSON.stringify(all)); }
  }
  {
    const t = await lockedFor(100, 99);
    const r = await arrive(t.ask, t.proofs);
    ok(r.status === 422 && r.up === 0 && !r.kept, 'one sat short is refused, and says so', 'answered ' + r.status + ': ' + String(r.text).slice(0, 70));
  }
  {
    // locked to the key of one open request, sent as the answer to another
    online(W);
    const other = W.decodeRequest(W.paymentRequest(50, { purpose: 'receive' })) || {};
    const t = await lockedFor(50, 50);
    const r = await arrive(other, t.proofs);
    ok(r.status !== 200 && r.up === 0 && !r.kept, 'ecash locked for one request is not taken as the answer to another', 'answered ' + r.status + ': ' + String(r.text).slice(0, 80));
  }
  {
    // a 1-sat proof that says it is 64
    const t = await lockedFor(128, 65);
    const small = t.proofs.filter((p) => p.amount === 1)[0];
    const rest = t.proofs.filter((p) => p !== small);
    const lied = rest.concat([Object.assign({}, small, { amount: 64 })]);
    const r = await arrive(t.ask, lied);
    ok(!!small && r.status !== 200 && r.up === 0 && !r.kept, 'a proof that claims a larger amount than the mint signed is refused',
       small ? 'answered ' + r.status + ': ' + String(r.text).slice(0, 80) : 'no 1-sat piece to alter');
  }
  {
    const t = await lockedFor(64, 64);
    const bare = t.proofs.map((p) => { const q = Object.assign({}, p); delete q.dleq; return q; });
    const r = await arrive(t.ask, bare);
    ok(r.status !== 200 && r.up === 0 && !r.kept, 'locked ecash that carries no proof of the mint’s signature is refused with no route', 'answered ' + r.status + ': ' + String(r.text).slice(0, 80));
  }

  console.log('\nB. a cheating receiver, and a payer with no route');
  {
    /* Change coming back over the link: owed 100, and the receiver sends 50
     * sats locked to this phone as the same proofs twice. */
    online(W);
    const mine = W.decodeRequest(W.paymentRequest(1, { purpose: 'receive' })) || {};
    const half = await W.sendToken(50, { unit: 'sat', lockTo: mine.lockTo });
    const bits = W.tokenInfo(half.token).proofs;
    const padded = CT.getEncodedToken({ mint: MINT, unit: 'sat', proofs: bits.concat(bits) });
    offline(W);
    const chk = W.checkChange(padded, 100);
    ok(chk.ok === false, 'change made of the same proofs twice is refused', chk.ok ? 'taken as ' + chk.sats + ' sats of change for 50 of real ecash' : chk.why);
    const honest = W.checkChange(half.token, 100);
    ok(honest.ok === true && honest.sats === 50, 'control: the same change sent once is taken for what it is', JSON.stringify(honest));
    if (chk.ok) {
      const before = await W.balanceSats();
      W.keepChange(padded, chk.sats);
      say('kept, the balance goes up ' + ((await W.balanceSats()) - before) + ' for 50 sats of ecash: the payer’s entry says all its change came back');
      const all = unclaimedRows(); Object.keys(all).forEach((k) => { if (/^change-/.test(k)) delete all[k]; }); ctx.storage.setItem('foxy.req.unclaimed', JSON.stringify(all));
    }
    online(W);
  }

  console.log('\nC. the app, paying a receiver that carries the payment home');
  {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
    const method = (sig) => {
      const at = SRC.indexOf('\n  ' + sig);
      if (at < 0) throw new Error('missing ' + sig);
      let i = SRC.indexOf('{', at + sig.length - 1), depth = 0, j = i;
      for (; j < SRC.length; j++) { if (SRC[j] === '{') depth++; else if (SRC[j] === '}') { depth--; if (depth === 0) break; } }
      return SRC.slice(at + 3, j + 1);
    };
    /* The payer has no route and is at another mint. The receiver answers
     * with its terms: "send 1,028 and 1,000 lands", and a request to pay.
     * The request inside is for 5,000. */
    const run1 = async (termsSats, requestSats) => {
      let heard = null;
      const stub = { mintUrl: 'https://their.test',
        onTapTerms(fn) { heard = fn; }, tapQuote() { return Promise.resolve(); },
        decodeRequest() { return { id: 'r1', sats: requestSats, unit: 'sat', mints: ['https://their.test'] }; },
        reason(e) { return String((e && e.message) || e); } };
      const lifted = new Function('window', 'return {' + method('tapStuckAtMint(offer, stuck, sats) {') + '};')({ FoxyWallet: stub });
      const app = Object.assign({
        state: {}, paid: 0, shown: null, toasts: [],
        waitingScreen() {}, dismissCard() {}, hideStage() {}, tapGaveNothing() {}, back() {}, toast(t) { this.toasts.push(t); },
        group(n) { return String(n); }, setState(s) { Object.assign(this.state, s); },
        crossFeeCard(terms) { this.shown = { sats: Number(terms.sats), net: Number(terms.net) }; return Promise.resolve(true); },
        makeTokenForRequest() { this.paid += 1; this.paidSats = this.state.req && this.state.req.sats; },
      }, lifted);
      app.tapStuckAtMint({ read: { id: 'o1', sats: 1000 }, mints: ['https://home.test'], theirRoute: true }, { mint: 'https://their.test', have: 9000 }, 1000);
      heard(JSON.stringify({ req: 'creqA-something', sats: termsSats, net: 1000, fee: termsSats - 1000, at: 'https://their.test' }));
      await settle(50);
      clearTimeout(app._tapQuoteT);
      return app;
    };
    const honest = await run1(1028, 1028);
    ok(honest.paid === 1 && honest.paidSats === 1028 && honest.shown.sats === 1028, 'control: terms whose request is for the figure shown are paid');
    const lied = await run1(1028, 5000);
    ok(lied.paid === 0, 'terms whose request is for more than the fee card shows are not paid',
       lied.paid ? 'the card showed ' + lied.shown.sats + ' sats and PAY sent ' + lied.paidSats + ', with no second confirmation' : String(lied.toasts[0] || ''));

    /* The price talk: the receiver asked in dollars, this phone offered 1,000
     * sats, and the answer is a request for 5,000 that says it is for 1,000. */
    const run2 = async (requestSats) => {
      let heard = null;
      const stub = { mintUrl: 'https://their.test',
        quoteFor() { return { id: 'o1', usd: 100, rate: 100000, at: 1, ageMs: 0, sats: 1000 }; },
        onTapTerms(fn) { heard = fn; }, tapQuote() { return Promise.resolve(); },
        decodeRequest() { return { id: 'r2', sats: requestSats, unit: 'sat' }; },
        reason(e) { return String((e && e.message) || e); } };
      const lifted = new Function('window', 'return {' + method('tapQuoteTheirDollars(offer) {') + '};')({ FoxyWallet: stub });
      const app = Object.assign({
        state: {}, opened: [], toasts: [],
        tapPreQuoteMint() {}, waitingScreen() {}, dismissCard() {}, hideStage() {}, tapGaveNothing() {}, back() {},
        toast(t) { this.toasts.push(t); }, group(n) { return String(n); }, setState(s) { Object.assign(this.state, s); },
        tapPayOffer(offer, sats) { this.opened.push({ req: offer.req, sats: sats }); },
      }, lifted);
      app.tapQuoteTheirDollars({ read: { id: 'o1', usd: 100 }, mints: ['https://their.test'] });
      heard(JSON.stringify({ req: 'creqA-agreed', sats: 1000 }));
      await settle(50);
      clearTimeout(app._tapQuoteT);
      return app;
    };
    const fair = await run2(1000);
    ok(fair.opened.length === 1 && fair.opened[0].sats === 1000, 'control: a request for the sats this phone offered is opened');
    const more = await run2(5000);
    ok(more.opened.length === 0, 'a request for more sats than this phone offered is not opened',
       more.opened.length ? 'opened for ' + more.opened[0].sats : String(more.toasts[0] || ''));

    /* A refund for a payment the receiver could not bring home, checked by
     * the payer's phone: it has a ceiling (no more than was paid). Does it
     * have a floor? */
    const hook = SRC.slice(SRC.indexOf('W.onTapChange(token => {'), SRC.indexOf('W.onTapChange(token => {') + 6000);
    const floor = /refund[\s\S]{0,400}(net|chk\.sats|sats)\s*<\s*[\s\S]{0,60}carried\.sats/.test(hook) || /carried\.sats[\s\S]{0,80}(>|>=)\s*(net|chk\.sats)/.test(hook);
    ok(floor, 'a refund far smaller than what was paid is not announced as the payment coming back',
       floor ? '' : 'the card says YOUR PAYMENT CAME BACK for any amount up to what was paid; the figure under it is the true one');
  }

  console.log(failed ? '\n' + failed + ' finding(s):\n  - ' + findings.join('\n  - ') : '\nevery cheat was refused');
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
