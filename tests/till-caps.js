'use strict';
/* till-caps.js — what a phone with no route takes before it settles.
 *
 *     node tests/till-caps.js
 *
 * The owner's caps (2026-10-16): $50 from one payer this phone does not know,
 * $300 held unsettled in all, with a prompt at half of that. Kept in sats at
 * the phone's last price, and two settings (07-request-delivery.js,
 * `tillCaps`, `tillRefusal`).
 *
 * Two wallets as they ship and a third payer, one fake mint, and the tap link
 * between them, as counter-refusal.js has it. The price is set so that a
 * dollar is 10 sats ($ 10,000,000 a bitcoin): $50 is 500 sats, $300 is 3,000.
 *
 *   A. the defaults, in sats at the last price, and none with no price;
 *   B. one payer, over $50: told no when it asks first, nothing made, nothing
 *      sent; another payer is a payer of its own;
 *   C. a payer whose payments settled is not counted again;
 *   D. all held: the prompt, the cap, and the refusal at it; a setting moves it;
 *   E. a card counts toward all held and toward no payer;
 *   F. a token scanned with no route: over a cap it is refused before the
 *      person is asked, and stays theirs;
 *   G. the payer names itself only to a phone that said it is offline;
 *   H. the screens: two SETTINGS rows in dollars with sats under, the amount
 *      typed on SET AMOUNT kept in sats, and the receive screen's notice.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const THIRD_WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RATE = 10000000;   // a dollar is 10 sats
let failed = 0, passed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined && !good ? ' — ' + detail : ''));
  if (good) passed += 1; else failed += 1;
};
setTimeout(() => { console.log('WATCHDOG: a check never finished'); process.exit(2); }, 240000).unref();
const settle = async (n) => { for (let i = 0; i < (n || 400); i++) await new Promise((r) => setTimeout(r, 0)); };

function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  const answers = [];
  let ctx = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    bridge: (w, m) => {
      const L = ctx.link;
      const gone = () => reply(w, m.id, null, 'That phone is no longer connected.');
      switch (m.action) {
        case 'mintRequest':
          if (ctx.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
          return reply(w, m.id, ctx.mint.handle(m));
        case 'inboxAnswer':
          answers.push({ status: [200, 409, 422].indexOf(Number(m.status)) >= 0 ? Number(m.status) : 422, text: String(m.text || '') });
          return reply(w, m.id, 'ok');
        case 'tapChangeDue': case 'tapAsking':
          return reply(w, m.id, 'ok');
        case 'tapQuote':
          if (!L || !L.up) return gone();
          L.log.push('M10');
          L.asked.push(String(m.body || ''));
          setTimeout(() => L.receiver.W._tapQuote(String(m.body || '')), 0);
          return reply(w, m.id, 'ok');
        case 'tapTerms':
          if (!L || !L.up) return gone();
          L.log.push('M11');
          setTimeout(() => L.payer.W._tapTerms(String(m.body || '')), 0);
          return reply(w, m.id, 'ok');
        case 'tapSend': {
          if (!L || !L.up) return gone();
          L.log.push('M5');
          L.bodies.push(String(m.body || ''));
          setTimeout(() => L.receiver.W._requestPaid(String(m.body || ''), 'wire', 'tap'), 0);
          const began = L.receiver.answers.length;
          const wait = setInterval(() => {
            const said = L.receiver.answers;
            if (said.length <= began) return;
            clearInterval(wait);
            const last = said[said.length - 1];
            L.log.push('M6 ' + last.status);
            reply(w, m.id, JSON.stringify(last.status === 200 ? { v: 2, ok: true, code: 200 }
              : { v: 2, ok: false, code: last.status, why: String(last.text || '').slice(0, 160) }));
          }, 1);
          return null;
        }
        default: {
          const got = phone.answer(w, m);
          if (!got) return reply(w, m.id, null, 'not in this test');
          return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
        }
      }
    },
    before: (w) => { phone.attach(w); shared = opts.mint || fakeMint(w, { p2pk: true }); },
  });
  ctx.mint = shared;
  ctx.answers = answers;
  ctx.deaf = false;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.W._askWaitMs = 400;
  ctx.W._rate = RATE; ctx.W._rateAt = Date.now() - 60000;
  return ctx;
}
let shared = null;
const goOffline = (c) => { c.deaf = true; c.W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false, transport: 'direct', network: 'none' }); c.W.setOffline(true); };
const goOnline = (c) => { c.deaf = false; c.W.setOffline(false); c.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' }); };

async function funded(words, sats, mint) {
  const c = page({ words, mint });
  await c.W.connect(MINT, null, null, { remember: true });
  await c.W.claim((await c.W.invoice(sats, '')).hash);
  for (let i = 0; i < 6; i++) { const r = await c.W.tidyChange().catch(() => null); if (!r || r.skipped) break; }
  await c.W.primeLocks();
  return c;
}

async function run() {
  // one receiver, three payers, one mint
  const rx = await funded(OTHER_WORDS, 200);
  const a = await funded(PHONE_WORDS, 4000, rx.mint);
  const b = await funded(THIRD_WORDS, 4000, rx.mint);
  const L = { up: true, log: [], asked: [], bodies: [], payer: a, receiver: rx };
  [rx, a, b].forEach((c) => { c.link = L; });
  const pay = async (payer, sats) => {
    L.payer = payer;
    const text = rx.W.paymentRequest(sats, { purpose: 'receive' });
    const ask = payer.W.decodeRequest(text) || {};
    // a receiver with no route gives its till tag on its offer (26d-tap.js), and the payer names itself by it
    const req = Object.assign({}, ask, { sats: sats, unit: 'sat', viaTap: true, theirRoute: !rx.deaf, asks: true },
      rx.deaf ? { theirTill: rx.W.tillTag() } : {});
    const before = await payer.W.balanceSats();
    const m5 = L.log.filter((x) => x === 'M5').length;
    const r = await payer.W.payRequest(req, () => {}, {}).then((made) => ({ made }), (e) => ({ e, why: (e && e.message) || String(e) }));
    await settle();
    r.sent = L.log.filter((x) => x === 'M5').length - m5;
    r.spent = before - (await payer.W.balanceSats());
    return r;
  };

  /* A payer's name to this receiver (`payerTag`): sha256 of its kept secret and the receiver's till tag, 16 hex. */
  const nameOf = (c, till) => crypto.createHash('sha256')
    .update('foxy/payer/' + c.storage.getItem('foxy.payer.tag') + '/' + (till || rx.W.tillTag())).digest('hex').slice(0, 16);

  console.log('A. the defaults');
  {
    const caps = rx.W.tillCaps();
    ok(caps.payerSats === 500 && caps.holdSats === 3000 && caps.promptSats === 1500 && !caps.payerSet && !caps.holdSet,
      '$50 and $300 at the last price, as sats, with the prompt at half; neither set', JSON.stringify(caps));
    const keep = [rx.W._rate, rx.W._rateAt];
    rx.W._rate = null; rx.W._rateAt = 0;
    const none = rx.W.tillCaps();
    ok(none.payerSats === 0 && none.holdSats === 0, 'no price ever seen and nothing set: no figure', JSON.stringify(none));
    goOffline(rx);
    ok(rx.W.tillRefusal(100000, 'sat', '', false) === '', 'and then nothing is held to a cap');
    goOnline(rx);
    rx.W._rate = keep[0]; rx.W._rateAt = keep[1];
    goOffline(rx);
    ok(rx.W.tillRefusal(100000, 'sat', '', false) !== '' && (goOnline(rx), rx.W.tillRefusal(100000, 'sat', '', false) === ''),
      'with a route nothing is refused: a phone that can settle at once is carrying nothing');
  }

  console.log('B. one payer');
  goOffline(rx);
  {
    const one = await pay(a, 300);
    ok(!!one.made && one.sent === 1, 'a payer this phone does not know pays $30 to it offline', one.why);
    const tagA = nameOf(a);
    ok(/^[0-9a-f]{64}$/.test(String(a.storage.getItem('foxy.payer.tag'))) && rx.W.payerHeld(tagA) === 300,
      'it is counted under the name the payer gave this receiver',
      tagA + ' ' + rx.W.payerHeld(tagA));
    const two = await pay(a, 300);
    ok(!two.made && two.e && two.e.foxyAskedNo === true
      && two.why === 'This phone takes up to $ 50.00 from one payer while it is offline, so it cannot take this until it connects.',
      'the same payer, $30 more: told no when it asks first, in one sentence', two.why);
    ok(two.sent === 0 && two.spent === 0 && rx.W.payerHeld(tagA) === 300, 'and nothing was made, sent or kept',
      'sent ' + two.sent + ', spent ' + two.spent);
    const other = await pay(b, 300);
    ok(!!other.made && rx.W.payerHeld(nameOf(b)) === 300, 'another payer has a cap of its own', other.why);
    ok(rx.W.unsettledHeld() === 600, 'and both are held, unsettled', String(rx.W.unsettledHeld()));
  }

  console.log('C. settled is not counted again');
  {
    goOnline(rx);
    await rx.W.claimUnclaimed();
    await settle();
    ok(rx.W.unsettledHeld() === 0 && rx.W.payerHeld(nameOf(a)) === 0, 'the route back settles both',
      String(rx.W.unsettledHeld()));
    goOffline(rx);
    const again = await pay(a, 400);
    ok(!!again.made, 'and the first payer can pay $40 offline again', again.why);
  }

  console.log('D. all held');
  {
    rx.W.setTillCap('hold', 700);
    ok(rx.W.tillCaps().holdSats === 700 && rx.W.tillCaps().holdSet && rx.W.tillCaps().promptSats === 350,
      'the setting moves the cap, kept in sats', JSON.stringify(rx.W.tillCaps()));
    ok(rx.W.tillNotice().level === 'prompt' && rx.W.tillNotice().heldSats === 400 && rx.W.tillNotice().heldCents === 4000,
      'at half of it the receive screen is prompted', JSON.stringify(rx.W.tillNotice()));
    const over = await pay(b, 400);
    ok(!over.made && over.sent === 0
      && over.why === 'This phone is holding $ 70.00 of payments that are not settled yet, so it cannot take more until it connects.',
      'a payment that would take it over the cap: told no first, in the same words made firm', over.why);
    const fits = await pay(b, 300);
    ok(!!fits.made && rx.W.unsettledHeld() === 700 && rx.W.tillNotice().level === 'full', 'one that fits is taken, and the notice is firm at the cap',
      fits.why + ' ' + JSON.stringify(rx.W.tillNotice()));
    rx.W.setTillCap('hold', 0);
    ok(!rx.W.tillCaps().holdSet && rx.W.tillCaps().holdSats === 3000, 'nought puts the default back');
  }

  console.log('E. a card');
  {
    rx.W.setTillCap('payer', 100);
    ok(rx.W.tillRefusal(200, 'sat', '', true) === '', 'a card is held to no payer’s cap');
    rx.W.setTillCap('hold', 800);
    ok(/holding \$ 80\.00/.test(rx.W.tillRefusal(200, 'sat', '', true)), 'and is held to what is held in all',
      rx.W.tillRefusal(200, 'sat', '', true));
    ok(rx.W.tillRefusal(5, 'usd', '', true) === '' && /holding/.test(rx.W.tillRefusal(2000, 'usd', '', true)),
      'a dollar card’s cents are counted at the last price: 5 cents is half a sat and fits, $20 is 200 sats and does not');
    rx.W.setTillCap('hold', 0); rx.W.setTillCap('payer', 0);
    const src = fs.readFileSync(path.join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8');
    ok(/tillRefusal\(want, cu, '', true\)/.test(src) && /cardError\('till-full'/.test(src),
      'the card’s offline payment asks the cap before any PIN or signature (`cardTake`)');
  }

  console.log('F. a token scanned with no route');
  {
    rx.W.setTillCap('hold', 900);
    rx.W._offlineToOffline && rx.W._offlineToOffline(false);
    let asked = 0;
    rx.W.onOfflineOffer && rx.W.onOfflineOffer(() => { asked += 1; return Promise.resolve(true); });
    const made = await a.W.sendToken(300);
    const r = await rx.W.receiveToken(made.token).then((x) => ({ x }), (e) => ({ e: (e && e.message) || String(e) }));
    ok(!!r.e && /holding \$ 90\.00 of payments that are not settled yet/.test(r.e) && asked === 0,
      'plain ecash over the cap: refused before the person is asked', JSON.stringify(r) + ' asked ' + asked);
    ok(rx.W.unsettledHeld() === 700, 'and nothing was kept', String(rx.W.unsettledHeld()));
    rx.W.setTillCap('hold', 0);
  }

  console.log('G. the payer names itself only to a phone that is offline');
  {
    goOnline(rx);
    L.asked.length = 0; L.bodies.length = 0;
    const r = await pay(a, 50);
    const asked = L.asked.map((t) => { try { return JSON.parse(t); } catch (e) { return {}; } }).filter((j) => j.intend);
    const bodies = L.bodies.map((t) => { try { return JSON.parse(t); } catch (e) { return {}; } });
    ok(!!r.made && asked.length >= 1 && asked.every((j) => !('from' in j.intend)) && bodies.every((j) => !('from' in j)),
      'paying a phone with a route: neither the question nor the payment names the payer', JSON.stringify(asked.map((j) => j.intend)));
    goOffline(rx);
    L.asked.length = 0; L.bodies.length = 0;
    await pay(a, 50);
    const asked2 = L.asked.map((t) => { try { return JSON.parse(t); } catch (e) { return {}; } }).filter((j) => j.intend);
    const bodies2 = L.bodies.map((t) => { try { return JSON.parse(t); } catch (e) { return {}; } });
    const tag = nameOf(a);
    ok(asked2.length >= 1 && asked2.every((j) => j.intend.from === tag) && bodies2.length === 1 && bodies2[0].from === tag,
      'paying one that said it is offline: both name it, by the same tag', JSON.stringify(asked2.map((j) => j.intend.from)));
  }

  console.log('H. the screens');
  {
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
    const method = (sig) => {
      const at = appSrc.indexOf('\n  ' + sig);
      if (at < 0) throw new Error('missing ' + sig);
      let i = appSrc.indexOf('{', at + sig.length - 1), depth = 0;
      for (; i < appSrc.length; i++) {
        if (appSrc[i] === '{') depth++;
        else if (appSrc[i] === '}') { depth--; if (depth === 0) break; }
      }
      return appSrc.slice(at + 3, i + 1);
    };
    const sigs = ['tillCapRows(path, shut) {', 'tillCapAsk(which) {', 'tillCapQuestion() {', 'tillCapNote() {', 'tillCapDefaultLabel() {',
      'tillCapSet(sats) {', 'tillNoticeText() {', 'unitFigure(amount, unit) {', 'money(sats, fiatCents) {', 'usd(v) {', 'group(n) {'];
    const t = Object.assign(new Function('window', 'return {' + sigs.map(method).join(',\n') + '}')({ FoxyWallet: rx.W }), {
      state: { screen: 'home', stack: [] }, toasts: [],
      setState(u) { Object.assign(this.state, typeof u === 'function' ? u(this.state) : u); },
      toast(x) { this.toasts.push(x); }, px: () => RATE, satUsd: () => RATE / 1e8, offlineNow: () => true,
    });
    const rows = t.tillCapRows('M0', null);
    ok(rows.length === 2 && rows[0].label === 'OFFLINE, PER PAYER' && rows[0].value === '$ 50.00' && rows[0].valueSub === '₿ 500'
      && rows[1].label === 'OFFLINE, TOTAL' && rows[1].value === '$ 300.00' && rows[1].valueSub === '₿ 3,000',
      'two SETTINGS rows, dollars with the sats under', JSON.stringify(rows.map((r) => [r.label, r.value, r.valueSub])));
    rows[0].tap();
    ok(t.state.screen === 'amount' && t.state.flow === 'tillCap' && t.state.tillCapWhich === 'payer' && t.state.unit === 'USD'
      && /one payer/.test(t.tillCapQuestion()) && t.tillCapDefaultLabel() === 'USE THE DEFAULT ($ 50.00)',
      'a tap opens SET AMOUNT in dollars, asking the question', JSON.stringify(t.state));
    ok(t.tillCapNote() === 'The most one payer may hand this phone while it is offline, before it connects to settle. Cards don\u2019t count.',
      'and a plain line under it says what the figure is', t.tillCapNote());
    t.state.tillCapWhich = 'hold';
    ok(t.tillCapNote() === 'The most this phone holds unsettled from everyone while offline. It warns at half.',
      'the total’s own line', t.tillCapNote());
    const amountVals = method('renderAmount(c) {');
    ok(/amountNote: s\.flow === 'tillCap' && this\.tillCapNote \? this\.tillCapNote\(\) : '',/.test(amountVals)
      && /\{\{ amountNote \}\}/.test(fs.readFileSync(path.join(__dirname, '..', 'build', 'markup.html'), 'utf8')),
      'SET AMOUNT draws it under the question');
    t.state.tillCapWhich = 'payer';
    t.tillCapSet(250);
    ok(rx.W.tillCaps().payerSats === 250 && t.state.screen === 'home' && t.toasts[t.toasts.length - 1] === 'Set to $ 25.00',
      'NEXT keeps the figure in sats and says it in dollars', JSON.stringify(rx.W.tillCaps()) + ' ' + t.toasts.join('|'));
    t.state.tillCapWhich = 'payer';
    t.tillCapSet(0);
    ok(!rx.W.tillCaps().payerSet && t.toasts[t.toasts.length - 1] === 'Set to $ 50.00', 'USE THE DEFAULT puts $50 back', t.toasts.join('|'));
    // the notice: 750 held offline now (C, D, and G's second payment; its first, to a phone with a route, settled)
    rx.W.setTillCap('hold', 1000);
    ok(t.tillNoticeText() === 'You are holding $ 75.00 of payments that are not settled yet. Connect to settle them.',
      'over half the cap, the receive screen’s notice', t.tillNoticeText() + ' / ' + rx.W.unsettledHeld());
    rx.W.setTillCap('hold', 750);
    ok(t.tillNoticeText() === 'You are holding $ 75.00 of payments that are not settled yet. Connect to settle them before you take more.',
      'at the cap, the same words made firm', t.tillNoticeText());
    t.offlineNow = () => false;
    ok(t.tillNoticeText() === '', 'and nothing with a route');
    const values = method('renderReceive(c) {');
    ok(/tillNoticeText\(\)/.test(values) && /recvAmber: tillNote,/.test(values) && /recvAmberShown: !!tillNote,/.test(values)
      && /recvNoteShown: onchain,/.test(values), 'the receive screen shows it, in its own place');
    // in the app's amber notice: the box with the warning sign, not amber text (review finding 5)
    const markup = fs.readFileSync(path.join(__dirname, '..', 'build', 'markup.html'), 'utf8');
    const amberBox = /<sc-if value="\{\{ recvAmberShown \}\}">\s*<div style="[^"]*background:rgba\(247,147,26,\.1\);border:1px solid rgba\(247,147,26,\.28\)[^"]*"><svg[^>]*stroke="#F7931A"[^>]*><path d="M12 4\.4 21 19\.6H3z"><\/path>[\s\S]{0,400}\{\{ recvAmber \}\}/;
    ok(amberBox.test(markup), 'and it is the amber notice, the box with the warning sign');
    const confirmShell = method('renderConfirmShell(c) {');
    ok(/cfDiffAmberShown: !!\(cf\.diffLine && cf\.diffLine\.text && cf\.diffLine\.amber\)/.test(confirmShell)
      && /cfDiffShown: !!\(cf\.diffLine && cf\.diffLine\.text && !cf\.diffLine\.amber\)/.test(confirmShell)
      && /<sc-if value="\{\{ cfDiffAmberShown \}\}">[^\n]*background:rgba\(247,147,26,\.1\)[^\n]*\{\{ cfDiff \}\}/.test(markup),
      'and the price line at 2 % is the same amber notice on CONFIRM PAYMENT');
  }

  console.log('I. no bitcoin price: dollars are still held to dollars');
  {
    rx.W.setTillCap('hold', 0); rx.W.setTillCap('payer', 0);
    goOffline(rx);
    const keep = [rx.W._rate, rx.W._rateAt];
    const rows = JSON.parse(rx.storage.getItem('foxy.req.unclaimed') || '{}');
    rx.W._rate = null; rx.W._rateAt = 0;
    ok(rx.W.tillRefusal(100000, 'usd', '', false)
      === 'This phone is holding $ 300.00 of payments that are not settled yet, so it cannot take more until it connects.',
      '$ 1,000 in dollars with no price: refused at the $300 default (it was taken)', rx.W.tillRefusal(100000, 'usd', '', false));
    ok(rx.W.tillRefusal(4000, 'usd', '', false) === ''
      && rx.W.tillRefusal(6000, 'usd', '0123456789abcdef', false)
        === 'This phone takes up to $ 50.00 from one payer while it is offline, so it cannot take this until it connects.',
      'and one payer to the $50 default, which needs no price');
    rx.storage.setItem('foxy.req.unclaimed', JSON.stringify(Object.assign({}, rows,
      { usdHeld: { token: 'x', amount: 25000, unit: 'usd', payer: '', at: Date.now() } })));
    ok(rx.W.unsettledHeld('usd') === 25000 && /holding \$ 300\.00/.test(rx.W.tillRefusal(6000, 'usd', 'fedcba9876543210', false)),
      'held dollar rows are counted in cents (they counted nought)', String(rx.W.unsettledHeld('usd')));
    const n = rx.W.tillNotice();
    ok(n.level === 'prompt' && n.heldCents === 25000, 'and the receive screen is prompted, in dollars', JSON.stringify(n));
    // figures set while a price was known, then no price
    rx.W._rate = keep[0]; rx.W._rateAt = keep[1];
    rx.W.setTillCap('hold', 2800);   // $ 280.00 at 10 sats a dollar
    rx.W._rate = null; rx.W._rateAt = 0;
    ok(rx.W.tillCaps().holdCents === 28000 && rx.W.tillRefusal(4000, 'usd', '', false)
        === 'This phone is holding $ 280.00 of payments that are not settled yet, so it cannot take more until it connects.',
      'a figure set while a price was known holds dollars to what it came to then', JSON.stringify(rx.W.tillCaps()));
    const sats = rx.W.unsettledHeld();
    ok(rx.W.tillRefusal(2800 - sats, 'sat', '', false) === '' && /holding/.test(rx.W.tillRefusal(2801 - sats, 'sat', '', false)),
      'and sats to the sats it was set at', String(sats));
    rx.storage.setItem('foxy.req.unclaimed', JSON.stringify(rows));
    rx.W.setTillCap('hold', 0);
    rx.W._rate = keep[0]; rx.W._rateAt = keep[1];
  }

  console.log('J. one name for each receiver');
  {
    const intents = () => L.asked.map((t) => { try { return JSON.parse(t); } catch (e) { return {}; } }).filter((j) => j.intend).map((j) => j.intend);
    L.payer = a;
    const other = '0123456789abcdef';
    L.asked.length = 0;
    await a.W.askFirst({ id: 'aa11bb22', unit: 'sat', sats: 10, theirRoute: false, theirTill: other }, { locked: false });
    await a.W.askFirst({ id: 'aa11bb23', unit: 'sat', sats: 10, theirRoute: false, theirTill: rx.W.tillTag() }, { locked: false });
    const said = intents();
    ok(said.length === 2 && said[0].from === nameOf(a, other) && said[1].from === nameOf(a) && said[0].from !== said[1].from,
      'two receivers are told two names that cannot be joined', JSON.stringify(said.map((i) => i.from)));
    L.asked.length = 0;
    await a.W.askFirst({ id: 'aa11bb24', unit: 'sat', sats: 10, theirRoute: false }, { locked: false });
    ok(intents().length === 1 && !('from' in intents()[0]), 'a receiver that gave no till tag is told no name', JSON.stringify(intents()));
    const tapSrc = fs.readFileSync(path.join(__dirname, '..', 'build', 'app', '26d-tap.js'), 'utf8');
    ok(/till: \(this\.offlineNow\(\) && W\.tillTag\) \? W\.tillTag\(\) : undefined/.test(tapSrc)
      && (tapSrc.match(/if \(offer\.theirTill\) read\.theirTill = offer\.theirTill;/g) || []).length === 3
      && /theirTill: offer\.theirTill \}\); return; \}/.test(tapSrc),
      'the till tag is on the offer only with no route, and goes with the request on every way it is paid');
  }

  console.log('K. the question still fits its one sealed message');
  {
    const intents = () => L.asked.filter((t) => /"intend"/.test(t));
    const ROOM = 252;
    const shape = (mint, from) => JSON.stringify({ intend: Object.assign({ id: 'aa11bb25', unit: 'sat', amount: 2100000, mint: mint,
      locked: true, sats: 2100000 }, from ? { from: from } : {}) }).length;
    let k = 10;
    while (!(shape('https://' + 'm'.repeat(k) + '.test', '') <= ROOM && shape('https://' + 'm'.repeat(k) + '.test', 'x'.repeat(16)) > ROOM)) k += 1;
    const mint = 'https://' + 'm'.repeat(k) + '.test';
    L.asked.length = 0;
    await a.W.askFirst({ id: 'aa11bb25', unit: 'sat', sats: 2100000, theirRoute: false, theirTill: rx.W.tillTag() }, { locked: true, mint: mint });
    const long = intents();
    ok(long.length === 1 && Buffer.byteLength(long[0]) <= ROOM && !/"from"/.test(long[0]),
      'a mint address long enough that the name would not fit: asked without it, within 252 bytes', (long[0] || '').length + ' ' + mint.length);
    L.asked.length = 0;
    await a.W.askFirst({ id: 'aa11bb26', unit: 'sat', sats: 2100000, theirRoute: false, theirTill: rx.W.tillTag() }, { locked: true, mint: 'https://m.test' });
    ok(intents().length === 1 && /"from":"[0-9a-f]{16}"/.test(intents()[0]) && Buffer.byteLength(intents()[0]) <= ROOM,
      'and with an ordinary one the name goes', intents()[0]);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.log('FAIL  threw: ' + ((e && e.stack) || e)); process.exit(1); });
