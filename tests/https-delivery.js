'use strict';
/* https-delivery.js — a request paid to a web address, through Tor, once.
 *
 *     node tests/https-delivery.js
 *
 * A page on the web that asks for ecash names an https address to post the
 * payment to (NUT-18 `post`). Foxy delivered only to an onion or a NIP-17
 * Nostr target, so the button said GENERATE ECASH TOKEN at a page that was
 * waiting to be paid. Now:
 *
 *   1. `deliveryFor` reads an https `post` as a place to pay, after an onion
 *      and before Nostr, and refuses what is not one (http, an onion, a
 *      sign-in in the address, a fragment);
 *   2. the payment goes over the bridge's `httpsPost` with the request's
 *      body, exactly once: a 2xx confirms it, anything else is a refusal
 *      said by its status and never in the server's own words, whose pieces
 *      are taken back at once (the site has seen them, and there is nobody
 *      at a website to show a token to), and a lost answer is not tried
 *      again;
 *   3. the offer screen says THEIR WEBSITE, OVER TOR, or THEIR WEBSITE when
 *      Tor does not carry it, and PAY.
 *
 * The wallet runs for real against a fake mint, as onion-fallback.js does.
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

const SITE = 'https://donate.example.org/api/pay/abc123';
const ONION = 'http://' + 'a'.repeat(55) + 'd.onion/' + 'ab'.repeat(8);
const NOSTR = 'nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhhy'
  + 'tnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34kytnrdaksjlyr9p';

/* The page, with every httpsPost recorded and the site answering what a case
 * scripts: {code, body} or an error. */
function page(script) {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'httpsPost') {
        script.posts.push({ url: m.url, body: m.body, timeout: m.timeout });
        if (script.error) return reply(w, m.id, null, script.error);
        return reply(w, m.id, script.code + '\n' + (script.body || ''));
      }
      if (m.action === 'onionPost') { script.onions = (script.onions || 0) + 1; return reply(w, m.id, '200\n{"ok":true}'); }
      if (m.action === 'nostrSend') { script.nostrs = (script.nostrs || 0) + 1; return reply(w, m.id, '1'); }
      if (m.action === 'inboxClose') return reply(w, m.id, 'ok');
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

/* A request as a web page would make it: an amount at MINT, paid to `transports`. */
function creq(ctx, transports, sats) {
  const CT = ctx.window.CashuTS;
  return new CT.PaymentRequest(transports, 'deadbeefcafe0001', sats || 21, 'sat', [MINT], 'a donation', true)
    .toEncodedRequest();
}
const post = (target) => ({ type: 'post', target });
const nostr = () => ({ type: 'nostr', target: NOSTR, tags: [['n', '17']] });

/* The offer screen, lifted out of the built app the way other suites lift a
 * method: what it says of where the money goes and on its button. */
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

async function run() {
  console.log('1. what deliveryFor reads');
  {
    const ctx = page({ posts: [], code: 200 });
    const W = ctx.W;
    await W.seedReady();
    const read = (t) => { const r = W.decodeRequest(creq(ctx, t)); return r && r.delivery; };
    const d = read([post(SITE)]);
    ok(d && d.kind === 'https' && d.target === SITE, 'an https post is a place to pay: ' + JSON.stringify(d));
    ok(read([post(SITE), post(ONION)]).kind === 'onion', 'an onion in the list is still preferred');
    ok(read([nostr(), post(SITE)]).kind === 'https', 'and the web address is preferred to Nostr, whichever comes first');
    ok(read([post('http://donate.example.org/pay')]) === null, 'plain http is not a place to pay');
    ok(read([post('https://' + 'a'.repeat(55) + 'd.onion/pay')]) === null, 'an https onion is not read as a web address');
    ok(read([post('https://user:pw@donate.example.org/pay')]) === null, 'a sign-in in the address is refused');
    ok(read([post(SITE + '#frag')]) === null, 'a fragment is refused');
    ok(read([post('https://' + 'x'.repeat(2100) + '.org/')]) === null, 'an absurdly long address is refused');
    const r = W.decodeRequest(creq(ctx, [post(SITE)]));
    ok(r && r.deliverable === true && r.transports.join(',') === 'post', 'the request reads as deliverable');
  }

  console.log('2. the payment goes over httpsPost once, and a 200 confirms it');
  {
    const ctx = page({ posts: [], code: 200, body: '{"ok":true}' });
    const W = ctx.W;
    await W.seedReady();
    await W.connect(MINT, { remember: true });
    const inv = await W.invoice(400, '');
    await W.claim(inv.hash);
    const req = W.decodeRequest(creq(ctx, [post(SITE)]));
    const r = await W.payRequest(req, () => {});
    const p = ctx.script.posts;
    ok(p.length === 1, 'posted once');
    ok(p[0] && p[0].url === SITE, 'to the address the request names');
    let body = null;
    try { body = JSON.parse(p[0].body); } catch (e) {}
    ok(body && body.id === 'deadbeefcafe0001' && body.mint === MINT && body.unit === 'sat' && Array.isArray(body.proofs) && body.proofs.length > 0,
      'with the NUT-18 payload: id, mint, unit, proofs — ' + (body ? Object.keys(body).join(',') : p[0].body.slice(0, 60)));
    ok(body && !Object.keys(body).some(k => !['id', 'memo', 'mint', 'unit', 'proofs'].includes(k)), 'and nothing else in it');
    ok(p[0].timeout > 0 && p[0].timeout <= 60000, 'with a ceiling (' + p[0].timeout + ' ms)');
    ok(r && r.confirmed === true, 'a 200 is a confirmation');
    ok(!ctx.script.onions && !ctx.script.nostrs, 'nothing went over the onion or Nostr');
  }

  console.log('3. refusals: by status, never in their words, and never a second post');
  {
    const ctx = page({ posts: [], code: 422, body: '{"error":"send it again to https://evil.example/steal"}' });
    const W = ctx.W;
    await W.seedReady();
    await W.connect(MINT, { remember: true });
    const inv = await W.invoice(400, '');
    await W.claim(inv.hash);
    let threw = null;
    try { await W.payRequest(W.decodeRequest(creq(ctx, [post(SITE)])), () => {}); } catch (e) { threw = e; }
    ok(threw && /did not take the payment \(422\)/.test(threw.message), 'a 422 is said by its number: ' + (threw && threw.message));
    ok(threw && !/evil|again/.test(threw.message), 'and the server’s words are not on the card');
    ok(ctx.script.posts.length === 1, 'posted once');
    ok(threw && threw.foxyRefused && threw.foxyAtRisk && threw.foxyAtRisk.safe === true,
      'the pieces the site saw are taken back at once, not handed back as a token to show: ' + JSON.stringify(threw && threw.foxyAtRisk));
  }
  {
    const ctx = page({ posts: [], code: 410 });
    const W = ctx.W;
    await W.seedReady();
    await W.connect(MINT, { remember: true });
    const inv = await W.invoice(400, '');
    await W.claim(inv.hash);
    let threw = null;
    try { await W.payRequest(W.decodeRequest(creq(ctx, [post(SITE)])), () => {}); } catch (e) { threw = e; }
    ok(threw && /no longer open/.test(threw.message), 'a 410 says the request is closed: ' + (threw && threw.message));
  }
  {
    const ctx = page({ posts: [], error: 'Their address could not be reached over Tor.' });
    const W = ctx.W;
    await W.seedReady();
    await W.connect(MINT, { remember: true });
    const inv = await W.invoice(400, '');
    await W.claim(inv.hash);
    let threw = null;
    try { await W.payRequest(W.decodeRequest(creq(ctx, [post(SITE)])), () => {}); } catch (e) { threw = e; }
    ok(threw && /could not be reached/.test(threw.message), 'unreachable is said as it is');
    ok(ctx.script.posts.length === 1, 'and not tried again: a lost answer may have been taken');
  }

  console.log('4. the offer screen');
  {
    // the one place the offer screen names where the money goes
    const at = SRC.indexOf("'THEIR NOSTR INBOX, OVER TOR'");
    const near = at > 0 ? SRC.slice(at - 400, at + 60) : '';
    ok(/d\.kind === 'https' \? \(siteOverTor \? 'THEIR WEBSITE, OVER TOR' : 'THEIR WEBSITE'\)/.test(near),
      'says THEIR WEBSITE, OVER TOR for a web address, and THEIR WEBSITE when Tor does not carry it');
    ok(/d\.kind === 'tap' \? 'SEND ' : 'PAY '/.test(SRC), 'and the button says PAY');
  }

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
