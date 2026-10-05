'use strict';
/* onion-fallback.js — the address outlives the screen, and the wait is bounded.
 *
 *     node tests/onion-fallback.js
 *
 * A tap whose Bluetooth link drops falls back to the request's onion address.
 * On two phones that fallback took 120893 ms and then
 * 130714 ms and delivered nothing, for two reasons that compounded.
 *
 * The receiver destroyed the address about 1.6 s after the screen changed —
 * before the payer had finished minting the token, so there was no ordering in
 * which the post could have arrived. And a destroyed onion fails *slowly*: the
 * descriptor is still cached where it was published, so Tor fetches it, tries
 * introduction points with nothing behind them, refetches, and holds the SOCKS
 * stream to its own 120-second ceiling. The page's 90-second budget never saw
 * any of it, because the budget was read only between attempts.
 *
 * So: the address is held open when a request naming it was shown, and the
 * page's remaining budget is handed to the phone as the ceiling for each
 * attempt. Both are checked here.
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

/* The page, with every onionPost and inboxClose recorded and the onion
 * answering whatever a case scripts. */
function page(script) {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'onionPost') {
        script.posts.push({ timeout: m.timeout, at: Date.now() });
        return script.reachable
          ? reply(w, m.id, '200\n{"ok":true}')
          : reply(w, m.id, null, 'Their phone could not be reached over Tor.');
      }
      if (m.action === 'inboxClose') { script.closes.push(m.hold); return reply(w, m.id, 'ok'); }
      if (m.action === 'inboxOpen') return reply(w, m.id, JSON.stringify({ onion: ONION }));
      if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w, { p2pk: true }); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return Object.assign(ctx, { script });
}

/* syncInbox, lifted out of the built app the way tap-settle.js lifts
 * requestDelivered: what it passes to closeInbox is the whole question. */
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
const lifted = new Function('return {' + method('syncInbox() {') + '}')();

/* Run syncInbox off a receive screen and report what closeInbox was told.
 * `creqs` is whether a request naming the address was ever put on screen. */
function leaving(creqs) {
  let told = 'never called';
  const app = Object.assign({
    state: { screen: 'home', flow: null },
    _inboxUrl: { onion: ONION },
    _inboxOpening: null,
    _inboxLeftAt: Date.now() - 5000,        // the 1.5 s settling beat is past
    _creqs: creqs ? { 21: 'creqA...' } : {},
  }, lifted);
  global.window = { FoxyWallet: { closeInbox(hold) { told = hold; } } };
  app.syncInbox();
  return told;
}

async function run() {
  // ---- the address is held open when somebody was given it -----------------
  {
    ok(leaving(true) === 90,
      'an address a request was built on keeps answering after the screen goes ('
      + leaving(true) + 's)');
    ok(leaving(false) === 0,
      'an address nobody was ever given is dropped at once (' + leaving(false) + 's)');
  }

  // ---- and the wallet carries that through to the phone --------------------
  {
    const ctx = page({ posts: [], closes: [], reachable: true });
    await ctx.W.closeInbox(90);
    await ctx.W.closeInbox();
    await ctx.W.closeInbox(9999);
    await ctx.W.closeInbox(-5);
    ok(ctx.script.closes[0] === 90, 'the hold reaches the phone (' + ctx.script.closes[0] + ')');
    ok(ctx.script.closes[1] === 0, 'no hold asked for is no hold');
    ok(ctx.script.closes[2] === 180, 'and it is capped at three minutes (' + ctx.script.closes[2] + ')');
    ok(ctx.script.closes[3] === 0, 'a negative hold is none (' + ctx.script.closes[3] + ')');
  }

  // ---- every attempt is bounded by what is left of the budget --------------
  {
    /* An address that answers first time still carries a ceiling, because the
     * phone's own default is 120 s — which is Tor's SocksTimeout, and the thing
     * that produced the two-minute waits. */
    const ctx = page({ posts: [], closes: [], reachable: true });
    const W = ctx.W;
    await W.connect(MINT, { remember: true });
    const inv = await W.invoice(400, '');
    await W.claim(inv.hash);
    const req = W.decodeRequest(W.paymentRequest(21, { purpose: 'receive', deliverTo: { onion: ONION } }));
    await W.payRequest(req, () => {});
    const first = ctx.script.posts[0];
    ok(ctx.script.posts.length === 1, 'a reachable address is posted to once');
    ok(first && first.timeout > 0 && first.timeout <= 30000,
      'and the attempt carries a ceiling inside the budget (' + (first && first.timeout) + ' ms)');
  }

  // ---- an address that is gone gives up inside the budget ------------------
  {
    /* The failure that was measured. Every attempt is refused at once here, so
     * what is being checked is the arithmetic: the budget shrinks, the last
     * attempt is not handed more time than is left, and the whole thing ends
     * around 30 s rather than the 90 s it used to allow or the 120 s per
     * attempt the phone would otherwise take on its own. */
    const ctx = page({ posts: [], closes: [], reachable: false });
    const W = ctx.W;
    await W.connect(MINT, { remember: true });
    const inv = await W.invoice(400, '');
    await W.claim(inv.hash);
    const req = W.decodeRequest(W.paymentRequest(21, { purpose: 'receive', deliverTo: { onion: ONION } }));
    let threw = null;
    try { await W.payRequest(req, () => {}); } catch (e) { threw = e; }
    const posts = ctx.script.posts;
    ok(!!threw, 'an address that cannot be reached fails the delivery');
    ok(!!(threw && threw.foxyToken && threw.foxyToken.token),
      'and the token comes back with it, so the money is not lost');
    ok(posts.length > 1, 'it was tried again (' + posts.length + ' attempts)');
    ok(posts.every((p) => p.timeout > 0 && p.timeout <= 30000),
      'no attempt is given more than the whole budget');
    const falling = posts.every((p, i) => i === 0 || p.timeout <= posts[i - 1].timeout);
    ok(falling, 'and each is given less than the last, because the budget is spent');
    const span = posts[posts.length - 1].at - posts[0].at;
    ok(span < 30000, 'the last attempt starts inside the budget (' + span + ' ms in)');
  }
}

run().then(() => {
  console.log(failed ? '\n' + failed + ' failed' : '\nall onion fallback checks pass');
  process.exit(failed ? 1 : 0);
}, (e) => { console.log('THREW', e && e.stack || e); process.exit(1); });
