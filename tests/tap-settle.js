'use strict';
/* tap-settle.js — what the receiver's last word means, and what the payer does
 * with it.
 *
 *     node tests/tap-settle.js
 *
 * The tap's sixth message used to be sealed by the receiver's radio the instant
 * the payment's bytes arrived — `{"ok":true}`, before its page had parsed,
 * checked or written anything down. The payer believes that message: it
 * resolves the send, and `requestDelivered` then deletes the token's text, the
 * audit record's inputs and the last-token record. So a receiver that refused a
 * moment later — its page reloaded and the request no longer open, the mint no
 * longer matching, a duplicate — left the payer holding no copy of a payment
 * nobody had taken.
 *
 * Two halves: what `payRequest` makes of each answer, and what
 * `requestDelivered` forgets on the strength of it.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');
const fs = require('fs');
const path = require('path');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, what) => {
  console.log((good ? 'ok   ' : 'FAIL ') + what);
  if (!good) failed += 1;
};

const ONION = 'http://' + 'a'.repeat(55) + 'd.onion/' + 'ab'.repeat(8);

/* The page, with `tapSend` answering whatever a case scripts and every onion
 * delivery recorded — the fallback must not run when the receiver has spoken. */
function page(script) {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'tapSend') {
        script.taps += 1;
        return script.answer === null
          ? reply(w, m.id, null, 'That phone is no longer connected.')
          : reply(w, m.id, script.answer);
      }
      // the onion answers HTTP: a status line, then the body
      if (m.action === 'onionPost') { script.onions += 1; return reply(w, m.id, '200\n{"ok":true}'); }
      if (m.action === 'inboxOpen') return reply(w, m.id, JSON.stringify({ onion: ONION }));
      if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w, { p2pk: true }); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}

async function payWith(answer) {
  const script = { answer: answer, taps: 0, onions: 0 };
  const ctx = page(script);
  const W = ctx.W;
  await W.connect(MINT, { remember: true });
  const inv = await W.invoice(400, '');
  await W.claim(inv.hash);
  const text = W.paymentRequest(21, { purpose: 'receive', deliverTo: { onion: ONION } });
  const req = W.decodeRequest(text);
  req.viaTap = true;
  let got = null, threw = null;
  try { got = await W.payRequest(req, () => {}); } catch (e) { threw = e; }
  return { got, threw, script, ctx };
}

/* requestDelivered, lifted out of the built app the way tap-offer.js lifts
 * syncTap: what it forgets is the whole question. */
const SRC = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function method(sig) {
  const at = SRC.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  let i = SRC.indexOf('{', at), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(at + 3, j + 1);
}
const lifted = new Function('return {'
  + method('requestDelivered(req, r) {') + ',\n'
  + method('requestPaidHere(ev) {') + ',\n'
  + method('forgetRequests(paid) {') + ',\n'
  + method('syncInbox() {') + ',\n'
  + method('txIsNew(hash) {') + '}')();

function delivered(req, r) {
  const said = { forgot: false, settled: false, cleared: false, watched: false, state: {} };
  const app = Object.assign({
    setState(o) { Object.assign(said.state, typeof o === 'function' ? o(said.state) : o); },
    refreshBalance() {}, loadHistory() {}, tidyChangeLater() {},
    announcePayment() {}, toast() {}, noteReceived() {}, syncPreview() {},
    watchToken() { said.watched = true; },
  }, lifted);
  global.window = {
    FoxyWallet: {
      settleTx() { said.settled = true; },
      forgetClaimedToken() { said.forgot = true; },
      lastTokenHash() { return r.hash; },
      clearLastToken() { said.cleared = true; },
    },
  };
  app.requestDelivered(req, r);
  return said;
}

async function run() {
  // ---- what payRequest makes of each answer -------------------------------
  const cases = [
    ['{"v":2,"ok":true,"code":200}', 'settled', false, 'a 200 is settled'],
    ['{"v":2,"ok":false,"code":409,"why":"already"}', 'unconfirmed', false, 'a 409 is unconfirmed, and does not fall back'],
    ['{"v":2,"ok":false,"code":504,"why":"no answer"}', 'unconfirmed', false, 'a 504 is unconfirmed, and does not fall back'],
    ['{"ok":true}', 'unconfirmed', false, 'a receiver from before this reads as unconfirmed'],
  ];
  for (const [answer, want, fellBack, what] of cases) {
    const { got, threw, script } = await payWith(answer);
    const state = threw ? 'threw' : (got && got.confirmed ? 'settled' : 'unconfirmed');
    ok(state === want && (script.onions > 0) === fellBack,
      what + ' :: ' + state + ', onion ' + script.onions);
  }

  {
    const { got, threw, script } = await payWith('{"v":2,"ok":false,"code":422,"why":"answers no request open here"}');
    ok(!got && threw && !threw.confirmed, 'a 422 refuses the payment rather than settling it');
    ok(script.onions === 0, 'and does not try the onion after a refusal');
    ok(!!(threw && (threw.foxyToken || /took the payment|request open/i.test(String(threw.message)))),
      'and the payer is told why :: ' + String(threw && threw.message).slice(0, 60));
  }

  {
    const { got, script } = await payWith(null);   // the link went
    ok(!!got && script.onions === 1 && got.confirmed === true,
      'a link that has gone falls back to the onion, and that is confirmed :: onion '
      + script.onions + ', confirmed ' + String(got && got.confirmed));
  }

  // ---- and what requestDelivered forgets on the strength of it -------------
  const onion = { delivery: { kind: 'onion' } };
  ok(delivered(onion, { hash: 'h', sats: 21, confirmed: true }).forgot,
    'a confirmed delivery forgets the payer’s copy');
  ok(!delivered({ delivery: { kind: 'nostr' } }, { hash: 'h', sats: 21, confirmed: false }).forgot,
    'a relay taking it does not');
  const tapped = delivered(Object.assign({ viaTap: true }, onion), { hash: 'h', sats: 21, confirmed: false });
  ok(!tapped.forgot && tapped.watched,
    'and a tap nobody confirmed does not either, however the request was addressed');
  ok(!delivered(onion, { hash: 'h', sats: 21 }).forgot,
    'no word at all is not a confirmation');

  /* Unless it was locked. A payer cannot take back proofs carrying the
   * receiver's key, so an amber "pending" row invites a reclaim that cannot
   * work, and the claim watch raises a note later that reads as a second
   * payment. */
  const lockedUnconfirmed = delivered(Object.assign({ viaTap: true }, onion),
    { hash: 'h', sats: 21, confirmed: false, lockedTo: '02' + 'ab'.repeat(32) });
  ok(lockedUnconfirmed.forgot && lockedUnconfirmed.settled && !lockedUnconfirmed.watched,
    'a locked payment is settled when it leaves, and not watched');

  /* And the sending phase ends here, because nothing else ends it.
   *
   * A direct payment sets `sendPhase: 'in'` on its way to the sending screen
   * and the success branch returns straight into `requestDelivered`, so both
   * places that clear it are paths a successful tap never takes. Left at 'in'
   * it tells `syncTap` this phone is mid-payment for ever, and the payer never
   * listens for another receiver: one tap paid and no tap worked again. */
  const after = delivered(Object.assign({ viaTap: true }, onion), { hash: 'h', sats: 21, confirmed: true });
  ok(after.state.sendPhase && after.state.sendPhase !== 'in',
    'a delivered payment ends the sending phase :: ' + JSON.stringify(after.state.sendPhase));
  ok(after.state.reqBusy === false, 'and the request is no longer busy');

  // ---- a share of a split reports itself once ------------------------------
  {
    /* The split's own screens say a share has been paid — the row turns green
     * on COLLECTING and EVERYONE HAS PAID sums them up — so its history entry
     * must not queue a payment screen of its own as well. It did: dismissing
     * EVERYONE HAS PAID dropped the person on home and then played one
     * confirmation per share, back to back, for money they had just been told
     * about. */
    const seenSplit = [];
    const app = Object.assign({
      state: { screen: 'spWaiting' },
      _seenSeeded: true,
      setState() {}, refreshBalance() {}, hideMelt() {}, showMelt() {}, toast() {},
      loadHistory() { seenSplit.push(this.txIsNew('req-abc') ? 'announced' : 'quiet'); },
      spMarkPaid() {}, closeReceive() {}, noteReceived() {},
    }, lifted);
    global.window = { FoxyWallet: { splitPending: () => ({ rows: [{ paid: false, hash: 'h' }] }) } };
    app.requestPaidHere({ stage: 'paid', purpose: 'split:0', id: 'abc', sats: 24 });
    ok(seenSplit[0] === 'quiet', 'a share of a split does not queue a confirmation of its own');

    // an ordinary request still does
    const seenPlain = [];
    const app2 = Object.assign({
      state: { screen: 'confirm' },
      _seenSeeded: true,
      setState() {}, refreshBalance() {}, hideMelt() {}, showMelt() {}, toast() {},
      loadHistory() { seenPlain.push(this.txIsNew('req-xyz') ? 'announced' : 'quiet'); },
      spMarkPaid() {}, closeReceive() {}, noteReceived() {},
    }, lifted);
    app2.requestPaidHere({ stage: 'paid', purpose: 'receive', id: 'xyz', sats: 24 });
    ok(seenPlain[0] === 'announced', 'and an ordinary payment still does');
  }

  // ---- a crossing's own entries are not payments to announce ---------------
  {
    const hush = new Function('return {' + method('hushMove(plan) {') + ',\n' + method('txIsNew(hash) {') + '}')();
    const a = Object.assign({ _seenSeeded: true }, hush);
    a.hushMove({ mintQuote: { quote: 'mq-1' }, meltQuote: { quote: 'xq-1' } });
    ok(a.txIsNew('mq-1') === false && a.txIsNew('xq-1') === false,
      'the claim and the melt of a crossing are not announced as payments');
    ok(a.txIsNew('req-other') === true, 'and a payment beside them still is');
  }

  // ---- a request that has been answered is not offered again ----------------
  /* Kept per amount and never let go offline, so the second person asked for
   * 1,198 sats was handed the request the first had paid — closed, and its
   * lock key dropped. */
  {
    const base = () => ({
      state: { screen: 'confirm', flow: 'receive' },
      _seenSeeded: true,
      setState() {}, refreshBalance() {}, hideMelt() {}, showMelt() {}, toast() {},
      loadHistory() {}, spMarkPaid() {}, closeReceive() {}, noteReceived() {},
    });
    global.window = { FoxyWallet: { splitPending: () => ({ rows: [{ paid: false, hash: 'h' }, { paid: false, hash: 'i' }] }) } };
    const a = Object.assign(base(), lifted);
    a._creqs = { 'm|1198|receive|$0': { text: 'creqA1' }, 'm|0|receive|$100': { text: 'creqA2' },
                 'tap|m|1198': { text: 'creqA3' } };
    a.requestPaidHere({ stage: 'paid', purpose: 'receive', id: 'xyz', sats: 1198 });
    ok(Object.keys(a._creqs).length === 0, 'a paid request is let go, so the same amount gets a fresh one ('
      + Object.keys(a._creqs).join(', ') + ')');

    const b = Object.assign(base(), lifted);
    b.state.screen = 'spWaiting';
    b._creqs = { 'm|24|split:0|$0': { text: 'creqB0' }, 'm|24|split:1|$0': { text: 'creqB1' } };
    b.requestPaidHere({ stage: 'paid', purpose: 'split:0', id: 'abc', sats: 24 });
    ok(Object.keys(b._creqs).join() === 'm|24|split:1|$0',
      'a paid share goes and the shares still owed keep their requests (' + Object.keys(b._creqs).join(', ') + ')');

    // and leaving the receive screen with no address to close: offline
    const c = Object.assign(base(), lifted);
    c.state = { screen: 'home', flow: 'receive' };
    c._inboxUrl = null; c._inboxOpening = null;
    c._creqs = { 'm|1198|receive|$0': { text: 'creqC' } };
    c.syncInbox();
    ok(Object.keys(c._creqs).length === 0, 'a phone with no address still lets its requests go when the screen does');
  }

  console.log('');
  console.log(failed ? failed + ' tap settle check(s) failed' : 'all tap settle checks pass');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
