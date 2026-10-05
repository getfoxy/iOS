'use strict';
/* offline-connect.js — a phone launched with the radios off still has a wallet.
 *
 *     node tests/offline-connect.js
 *
 * A wallet cannot exist without its mint's keysets. Every proof names the
 * keyset that signed it; verifying one (NUT-12) needs that keyset's public
 * keys; and cashu-ts fetches them in loadMint(), which is a request. So a cold
 * launch in airplane mode used to leave the person with no wallet at all — no
 * balance, no mint to select, nothing to spend — while the phone was holding
 * ecash and the only thing missing was a list of public keys the mint had
 * already handed over.
 *
 * So the keysets are written down on every connect that works, and an offline
 * connect is rebuilt from them. What this pins:
 *   - one online connect is enough: the next launch works with the radios off
 *   - and it really is offline — not one request leaves the page
 *   - the balance, the mint list and the keysets are all there
 *   - locked ecash is taken, which is the whole point of being offline-capable
 *   - a mint this phone has never reached still refuses, in the same words
 *   - the cache is capped, so it cannot eat localStorage
 *   - what is kept is public: keyset ids and public keys, no secrets, no seed
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

/* A page. `deaf` refuses every request the way iOS does with no radios, and
 * counts the attempts: the count is the test. */
function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: PHONE_WORDS });
  const tried = [];
  let mint = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  const ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        tried.push(String(m.path || m.url || '?'));
        if (opts.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
        return reply(w, m.id, mint.handle(m));
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w, { p2pk: true }); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.tried = tried;
  return ctx;
}

const settle = async () => { for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0)); };
/* As the app does it: the native side says there is no route, and the person
 * chose to carry on anyway (setOffline, which is page-side). */
const offline = (W) => {
  W._privacy({ tor: 'connecting', progress: 0, everUp: false,
               unprotected: false, transport: 'direct', network: 'none' });
  W.setOffline(true);
};
const dump = (ctx) => {
  const out = {};
  for (let i = 0; i < ctx.storage.length; i++) {
    const k = ctx.storage.key(i);
    out[k] = ctx.storage.getItem(k);
  }
  return out;
};
const threw = async (fn) => { try { await fn(); return null; } catch (e) { return (e && e.message) || String(e); } };

async function run() {
  // ---- one connect with a route, and some money ----------------------------
  const first = page({});
  await first.W.connect(MINT, null, null, { remember: true });
  const inv = await first.W.invoice(2000, '');
  await first.W.claim(inv.hash);
  const balance = await first.W.balanceSats();
  ok(balance === 2000, 'the online phone holds 2000 sat', String(balance));

  const cache = JSON.parse(first.storage.getItem('foxy.cashu.mint.cache') || 'null');
  ok(!!cache && !!cache[MINT], 'the mint\'s keysets were written down on connect',
     cache ? Object.keys(cache).join(',') : 'nothing');
  const kept = cache && cache[MINT];
  ok(!!(kept && kept.keys && kept.keys.keysets && kept.keys.keysets.length),
     'and the entry holds keysets', kept ? JSON.stringify(Object.keys(kept)) : '');
  ok(!!(kept && kept.keys.keysets[0].keys && Object.keys(kept.keys.keysets[0].keys).length > 1),
     'each keyset holds its public keys, one per amount',
     kept ? String(Object.keys(kept.keys.keysets[0].keys || {}).length) : '');

  /* Nothing secret is kept. The check is on the text, not on a field list: a
   * future cashu-ts adding a private half would be caught by this and by
   * nothing else. */
  const asText = first.storage.getItem('foxy.cashu.mint.cache') || '';
  const words = PHONE_WORDS.split(/\s+/).filter((x) => x.length > 3);
  ok(!words.some((x) => asText.indexOf(x) >= 0), 'no word of the seed is in it');
  ok(!/privkey|private_key|secretkey|"seed"/i.test(asText), 'and nothing calls itself a private key');

  const carried = dump(first);

  // ---- a cold launch with the radios off ----------------------------------
  const cold = page({ storage: carried, deaf: true });
  offline(cold.W);
  const mark = cold.tried.length;
  const got = await cold.W.connect(MINT, null, null, { remember: true });
  ok(!!got && got.balanceSats === 2000, 'offline, a cold launch connects and sees its 2000 sat',
     got ? String(got.balanceSats) : 'nothing came back');
  ok(cold.tried.length === mark, 'and not one request left the page',
     cold.tried.slice(mark).join(',') || '0');
  ok(cold.W.mintUrl === MINT, 'the mint is selected', String(cold.W.mintUrl));
  ok(cold.W.fromCache() === true, 'and the wallet says it came from storage, not from the mint',
     String(cold.W.fromCache()));
  ok((cold.W.mints() || []).some((m) => (m.url || m) === MINT), 'and it is in the mint list',
     JSON.stringify(cold.W.mints()));

  /* The keysets are the point, and a send is what proves they are really there:
   * making a token means reading the keyset every proof names, and exact change
   * means it is made without a swap, so it is done with no route at all.
   * (Verifying a signature against them — NUT-12 — is the locked payment
   * further down: it is taken only because its DLEQ verifies on these keys.) */
  const sent = await cold.W.sendToken(16, { unit: 'sat' });
  ok(!!(sent && sent.token), 'offline, exact change is paid out on the cached keysets alone',
     sent ? String(sent.token).slice(0, 12) : 'nothing');
  const sentBits = cold.W.tokenInfo(sent.token);
  ok(sentBits.proofs.every((pr) => !!pr.id) && sentBits.proofs.length >= 1,
     'and every proof in it names its keyset',
     JSON.stringify(sentBits.proofs.map((pr) => pr.id)));

  await settle();
  ok(cold.tried.length === mark, 'and nothing went out in the seconds after, either',
     cold.tried.slice(mark).join(','));

  // ---- the point of it: locked ecash is taken while offline ---------------
  const payer = page({});
  await payer.W.connect(MINT, null, null, { remember: true });
  const pinv = await payer.W.invoice(500, '');
  await payer.W.claim(pinv.hash);
  ok((await cold.W.primeLocks()) > 0, 'the offline phone still derives its lock keys');
  const ask = cold.W.decodeRequest(cold.W.paymentRequest(31, { purpose: 'receive' })) || {};
  ok(!!ask.lockTo, 'and can still ask to be paid, with a lock');
  const paid = await payer.W.sendToken(31, { unit: 'sat', lockTo: ask.lockTo });
  const bits = cold.W.tokenInfo(paid.token);
  const before = await cold.W.balanceSats();
  const body = JSON.stringify({
    id: ask.id, mint: String(bits.mint || '').replace(/\/+$/, ''), unit: 'sat',
    // with its DLEQ: the cached keysets are what it is checked against, with no mint to ask
    proofs: bits.proofs.map((pr) => Object.assign({ id: pr.id, amount: pr.amount, secret: pr.secret, C: pr.C },
      pr.dleq ? { dleq: pr.dleq } : {})),
  });
  cold.W._requestPaid(body, 'offline-locked');
  await settle();
  ok((await cold.W.balanceSats()) === before + 31,
     'locked ecash arriving at the offline phone is taken, on cached keysets alone',
     String(await cold.W.balanceSats()) + ' vs ' + (before + 31));

  /* ---- and it stops saying so once there is a route ----------------------
   * The app watches for this (connectForRealOnceOnline): a wallet assembled
   * from storage has not swept, has not claimed, and may be holding keysets the
   * mint has rotated away from, so it is replaced the moment it can be. */
  const back = page({ storage: carried });
  offline(back.W);
  await back.W.connect(MINT, null, null, { remember: true });
  ok(back.W.fromCache() === true, 'offline again: from storage');
  back.W.setOffline(false);
  back.W._privacy({ tor: 'up', progress: 100, everUp: true, unprotected: false, transport: 'direct' });
  await back.W.connect(MINT, null, null, { remember: true });
  ok(back.W.fromCache() === false, 'and with a route, a real connect clears the mark',
     String(back.W.fromCache()));

  /* ---- the price survives being killed -----------------------------------
   *
   * It lived in `_rate`/`_rateAt` and nowhere else, so a relaunch threw it away.
   * With a route that is invisible — the next fetch is a second away. With none
   * there is no next fetch, and a phone came up in airplane mode with no
   * price at all twenty-two seconds after being told one. */
  {
    const priced = page({});
    await priced.W.connect(MINT, null, null, { remember: true });
    priced.W._rate = 84746;
    priced.W._rateAt = Date.now() - 2 * 3600 * 1000;
    // written the way a real fetch writes it
    priced.storage.setItem('foxy.price.last',
      JSON.stringify({ rate: 84746, at: priced.W._rateAt }));

    const after = page({ storage: dump(priced), deaf: true });
    const seen = after.W.lastPrice();
    ok(seen.rate === 84746, 'a killed app comes back knowing the last price',
       JSON.stringify(seen));
    ok(seen.ageMs > 7000000 && seen.ageMs < 7400000, 'and how long ago it was told',
       String(Math.round(seen.ageMs / 1000)) + 's');

    /* Not trusted as current: a figure outside the sane band, or with no
     * timestamp, is dropped. A wrong price is worse than none. */
    const junk = page({ storage: Object.assign({}, dump(priced), {
      'foxy.price.last': JSON.stringify({ rate: 3, at: Date.now() }) }) });
    ok(junk.W.lastPrice().rate === null, 'an impossible price is ignored',
       JSON.stringify(junk.W.lastPrice()));
    const undated = page({ storage: Object.assign({}, dump(priced), {
      'foxy.price.last': JSON.stringify({ rate: 84746 }) }) });
    ok(undated.W.lastPrice().rate === null, 'and one with no timestamp, because its age is the point',
       JSON.stringify(undated.W.lastPrice()));
  }

  // ---- a mint this phone has never reached --------------------------------
  const stranger = page({ storage: carried, deaf: true });
  offline(stranger.W);
  const refused = await threw(() => stranger.W.connect('https://never.test', null, null, { remember: false }));
  ok(!!refused && /offline/i.test(refused),
     'a mint never connected to is still refused, in the same words', String(refused));
  ok(stranger.W.mintUrl !== 'https://never.test', 'and nothing was switched to it',
     String(stranger.W.mintUrl));

  /* ---- the cache is capped ----------------------------------------------
   * Five entries are already on file, oldest first by `at`, and a sixth mint is
   * connected to. The oldest must go, the newest must stay. Written straight
   * into storage rather than connected to five times: what is being tested is
   * the cap, not the fake mint's ability to answer on six paths. */
  const older = {};
  for (let i = 0; i < 5; i++) {
    older['https://old' + i + '.test'] = {
      info: { name: 'old' + i }, at: 1000 + i,
      keys: { mintUrl: 'https://old' + i + '.test', savedAt: 0,
              keysets: [{ id: '00abcdef0000000' + i, unit: 'sat', active: true, keys: { 1: 'ff' } }] },
    };
  }
  const capped = page({ storage: Object.assign({}, carried, {
    'foxy.cashu.mint.cache': JSON.stringify(older),
  }) });
  await capped.W.connect(MINT, null, null, { remember: true });
  const all = JSON.parse(capped.storage.getItem('foxy.cashu.mint.cache') || '{}');
  ok(Object.keys(all).length === 5, 'the cache holds at most five mints',
     String(Object.keys(all).length));
  ok(!!all[MINT], 'and keeps the one just connected to', Object.keys(all).join(','));
  ok(!all['https://old0.test'], 'dropping the oldest', Object.keys(all).join(','));
  ok(!!all['https://old4.test'], 'and keeping the rest', Object.keys(all).join(','));

  // ---- remember: false now means what it says -----------------------------
  const nr = page({ storage: { 'foxy.cashu.mint': 'https://kept.test' } });
  await nr.W.connect(MINT, null, null, { remember: false });
  ok(nr.storage.getItem('foxy.cashu.mint') === 'https://kept.test',
     'connect(..., { remember: false }) leaves the saved mint alone',
     String(nr.storage.getItem('foxy.cashu.mint')));
  ok(nr.W.mintUrl === MINT, 'while still connecting to the one asked for',
     String(nr.W.mintUrl));

  console.log('\n' + (failed ? failed + ' offline-connect check(s) failed'
    : 'all offline-connect checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
