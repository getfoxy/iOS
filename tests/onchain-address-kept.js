'use strict';
/* onchain-address-kept.js — an address made while a claim is at the mint is kept.
 *
 *     node tests/onchain-address-kept.js
 *
 * `onchainClaim` loaded the whole list of addresses before its round trip and
 * saved that copy back after the mint answered, seconds later over Tor. An
 * address made meanwhile (the watcher claims on its own; a person can be at
 * RECEIVE) was written into the list and then erased by the claim's save, with
 * the random key the mint needs before it releases ecash for that quote:
 * bitcoin sent to the address on the screen was unclaimable for good. A claim
 * writes back only what it changed, into the list as it is, and making an
 * address waits its turn behind a claim (the proof lock).
 *
 * The real wallet in jsdom against a fake mint (tests/harness.js). */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

/* The bridge, with one tap: while `gate.hold` is set, the answer to the
 * claim's quote-state question (GET /v1/mint/quote/onchain/<quote>) is parked,
 * so the test can slip an onchainAddress() in between the claim's load of
 * K.onchain and its save. */
const gate = { hold: false, quote: '', parked: [] };

function page() {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const ctx = loadReal({
    bridge: (w, m) => {
      const reply = (text, err) => setTimeout(() => w.FoxyWallet._scanResult(m.id, text, err), 0);
      if (m.action === 'mintRequest') {
        const url = String(m.url || '');
        const answer = () => reply(mint.handle(m));
        if (gate.hold && gate.quote
            && url.indexOf('/v1/mint/quote/onchain/' + gate.quote) >= 0) {
          gate.parked.push(answer);
          return;
        }
        return answer();
      }
      if (m.action === 'inboxAnswer') return reply('ok');
      const got = phone.answer(w, m);
      if (!got) return reply(null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w, { p2pk: true, onchain: true }); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  ctx.mint = () => mint;
  return ctx;
}

const settle = async (n) => { for (let i = 0; i < (n || 400); i++) await new Promise((r) => setTimeout(r, 0)); };

async function run() {
  const ctx = page();
  const W = ctx.W;
  await W.connect(MINT, { remember: true });

  // address A, and a deposit to it confirms
  const a = await W.onchainAddress();
  ok(!!a && !!a.quote, 'address A is made', JSON.stringify(a));
  ctx.mint().onchainCredit(a.quote, 20000);

  // the watcher claims A; the mint's answer is held at the door for a moment
  gate.quote = a.quote;
  gate.hold = true;
  const claimP = W.onchainClaim(a.quote);
  claimP.catch(() => {});
  await settle(50);               // the claim has loaded K.onchain and asked the mint

  /* The person opens the receive screen again: address B. It waits its turn
   * behind the claim now, so it is asked for here and arrives once the mint
   * has answered the claim. */
  const bP = W.onchainAddress();
  await settle(50);
  // the mint's answer arrives and the claim finishes
  gate.hold = false;
  gate.parked.splice(0).forEach((go) => go());
  const got = await claimP.then((r) => r, (e) => ({ why: e && e.message }));
  const b = await bP;
  await settle(50);
  ok(!!b && !!b.quote && b.quote !== a.quote, 'address B is made, after the claim that was in flight',
    JSON.stringify(b));
  ok(got && Number(got.sats) > 0, 'the deposit to A is claimed', JSON.stringify(got).slice(0, 120));

  // B must still be claimable: its record, with its key, must have survived
  const after = JSON.parse(ctx.window.localStorage.getItem('foxy.cashu.onchain') || '[]');
  const bRec = after.filter((r) => r && r.quote === b.quote)[0];
  ok(!!bRec, 'address B’s record survives the claim', JSON.stringify(after.map((r) => r && r.quote)));
  ok(!!(bRec && bRec.privkey), 'and so does the key a payment to B needs',
    JSON.stringify(bRec || null));

  console.log('\n' + (failed ? failed + ' onchain-stale-save check(s) failed'
    : 'all onchain-stale-save checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
