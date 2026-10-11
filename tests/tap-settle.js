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
 * `requestDelivered` forgets on the strength of it. And, after them, a share of
 * a split bill reports itself once, whether it was paid over the tap
 * (`requestPaidHere`) or by a card (`fcShareMoved`).
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
  + method('fcW() {') + ',\n'
  + method('fcShareMoved(share, hash) {') + ',\n'
  + method('fcShareNote(share, hash) {') + ',\n'
  + method('splitCardEntries() {') + ',\n'
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

  // ---- a share of a split paid by a card reports itself once, too ----------
  {
    /* The same for a card (26f-flashcard.js, `fcShareMoved`): the bill's own screens say the share is paid, so the card
     * payment's entry is not announced as well, whichever stage it has reached. A history pass may have queued it
     * already, the change being made for it may be holding it, or neither may have happened yet. */
    const base = (record, over) => {
      const said = { marked: [], moved: [], state: { screen: 'spPayer', spIdx: 0, tapArmed: true } };
      const app = Object.assign({
        said, state: said.state, _seenSeeded: true,
        setState(o) { Object.assign(said.state, typeof o === 'function' ? o(said.state) : o); },
        spMarkPaid(i, hash) { said.marked.push([i, hash]); },
        spPaidOnScreen(i, how) { said.moved.push([i, how]); },
        _paidQueue: [{ hash: 'card-a' }, { hash: 'card-b' }],
        _heldConfirm: { hash: 'card-a', dir: 'in', sats: 100 },
      }, lifted, over || {});
      global.window = { FoxyWallet: { cardSession() {}, splitRecord: () => record } };
      return app;
    };
    const owed = { rows: [{ hash: 'h0', paid: false }, { hash: 'h1', paid: false }] };

    const a = base(owed);
    a.fcShareMoved({ idx: 0, hash: 'h0' }, 'card-a');
    ok(a.said.marked.length === 1 && a.said.marked[0][0] === 0 && a.said.marked[0][1] === 'h0' && a.said.moved.length === 1 && a.said.moved[0][1] === 'by card',
      'the share is ticked by its own row and its screen moves on, said to be by a card');
    ok(a.txIsNew('card-a') === false, 'its entry is marked announced, so a history pass that comes later queues nothing for it');
    ok(a._paidQueue.map((q) => q.hash).join() === 'card-b', 'one a pass had queued already is let go, and the others stay');
    ok(a._heldConfirm === null, 'and so is one held behind its change');
    ok(a.said.state.tapArmed === false, 'a radio armed for this share is not left armed for the next');

    const b = base(owed);
    b._heldConfirm = { hash: 'card-other', dir: 'in', sats: 5 };
    b.fcShareMoved({ idx: 1, hash: 'h1' }, 'card-a');
    ok(b._heldConfirm && b._heldConfirm.hash === 'card-other', 'another payment\u2019s held confirmation is left as it was');

    const c = base({ rows: [{ hash: 'h0', paid: true }, { hash: 'h1', paid: false }] });
    c.fcShareMoved({ idx: 0, hash: 'h0' }, 'card-a');
    ok(c.said.marked.length === 0 && c.said.moved.length === 1, 'a share already ticked (its invoice was paid meanwhile) is not ticked again, and the screen still moves');

    const d = base(null);
    d.fcShareMoved({ idx: 0, hash: 'h0' }, 'card-a');
    ok(d.said.marked.length === 0 && d.said.moved.length === 0 && d.txIsNew('card-a') === true && d._paidQueue.length === 2 && d._heldConfirm !== null && d.said.state.tapArmed === true,
      'a bill that is no longer collected has no share to tick: the payment is an ordinary one, with its own confirmation');

    const e = base({ rows: [{ hash: 'other', paid: false }] });
    e.fcShareMoved({ idx: 0, hash: 'h0' }, 'card-a');
    ok(e.said.marked.length === 0 && e.txIsNew('card-a') === true, 'nor does a share of another bill: it is found by its row, and not by its place');

    const f = base(owed);
    f.fcShareMoved({ idx: 0, hash: 'h0' }, '');
    ok(f.said.marked.length === 1 && f._paidQueue.length === 2, 'a payment with no entry yet still ticks its share, and lets go of nothing');

    // the rest of a payment's handling (its change, its confirmation) is not cut short by a share that cannot be ticked
    const g = base(owed, { spMarkPaid() { throw new Error('the store is full'); } });
    const warn0 = console.warn;
    console.warn = () => {};
    let escaped = null;
    try { g.fcShareMoved({ idx: 0, hash: 'h0' }, 'card-a'); } catch (x) { escaped = x; }
    console.warn = warn0;
    ok(escaped === null, 'a share that cannot be ticked does not take the rest of the payment’s handling with it');
  }

  // ---- and a card's payment that lands late is not announced either ---------
  {
    /* The payment's entry is named on the share's row as soon as the card has signed (`fcShareNote`), before the mint has answered, and a
     * history pass leaves alone an entry a row names (`splitCardEntries`), whenever it settles: the bill's own screens tick the share. */
    const noted = [];
    const wallet = (record) => ({
      cardSession() {}, splitRecord: () => record,
      splitNoteCard(hash, entry) { noted.push([hash, entry]); },
    });
    const app = Object.assign({}, lifted);
    global.window = { FoxyWallet: wallet({ rows: [{ hash: 'h0', paid: false, card: 'card-late' }, { hash: 'h1', paid: false }, { hash: 'h2', paid: true, card: 'req-card-trusted' }] }) };
    const named = app.splitCardEntries();
    ok(named['card-late'] === true && named['req-card-trusted'] === true && Object.keys(named).length === 2,
      'the entries the bill’s rows name are found, a payment taken on trust among them', JSON.stringify(named));
    global.window = { FoxyWallet: wallet(null) };
    ok(Object.keys(app.splitCardEntries()).length === 0, 'a bill that has been stopped names none, and a payment that lands after it is an ordinary one');
    global.window = { FoxyWallet: {} };
    ok(Object.keys(app.splitCardEntries()).length === 0, 'nor does a wallet that keeps no bill');

    global.window = { FoxyWallet: wallet({ rows: [] }) };
    app.fcShareNote({ idx: 1, hash: 'h1' }, 'card-new');
    ok(noted.length === 1 && noted[0][0] === 'h1' && noted[0][1] === 'card-new', 'a share is noted by its row, with the name of the payment');
    global.window = { FoxyWallet: Object.assign(wallet(null), { splitNoteCard() { throw new Error('the store is full'); } }) };
    const warn0 = console.warn;
    console.warn = () => {};
    let escaped = null;
    try { app.fcShareNote({ idx: 1, hash: 'h1' }, 'card-new'); } catch (x) { escaped = x; }
    console.warn = warn0;
    ok(escaped === null, 'and a note that cannot be written does not stop the payment');

    /* The history pass itself is too large to run here; what is pinned is that it asks for those entries before it decides what to announce,
     * and that an entry a row names is marked announced and not queued, as an entry tagged as change is. */
    const pass = method('loadHistory() {');
    const at = pass.indexOf('shareCards[t.hash]');
    ok(/const shareCards = this\.splitCardEntries\(\);/.test(pass) && at > 0 && /if \(shareCards\[t\.hash\]\) \{ this\.txIsNew\(t\.hash\); return; \}/.test(pass) && at < pass.indexOf('fresh.push(t)'),
      'the history pass marks such an entry announced and queues nothing for it, before it decides what to announce');
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
