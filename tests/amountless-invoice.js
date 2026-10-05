'use strict';
/* amountless-invoice.js — a Lightning invoice that names no amount.
 *
 *     node tests/amountless-invoice.js
 *
 * Foxy turned these away for a year, with a note saying "LNbits needs the
 * amount at pay time, which is a different call". That was true of LNbits and
 * has not been true since Foxy paid through a mint: NUT-05 carries an
 * `amount_msat` beside the request for exactly this, and cashu-ts passes it
 * through when the mint advertises `options.amountless`. A zero-amount invoice
 * is what a "pay me what you like" link hands you, so refusing them refused an
 * ordinary way of being asked for money.
 *
 * What is checked here is the *deciding*, not a payment: the harness's mint
 * does not advertise amountless, so the last thing this proves is that a mint
 * which cannot do it is named rather than left to fail somewhere further in.
 * A real amountless melt is `tools/live`'s job.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

/* A real amountless invoice, from a bug report. `lnbc1` with no
 * amount field at all — not `lnbc0`, which is a different thing. */
const NONE = 'lnbc1p4ttszqpp5c6utwdk6cmla7kmz4nf89avnlyrzqrkhz0jx06hsltwmw9afwheqdqqcqzzs'
  + 'xqrrs0fppq9eka5xeg7p7sezkmmkc02cpffc2ekcdssp5hcpux550uxjsc3nj3qhvqa7rmz7hsp7yel3eveh3'
  + 'vg8awmve4fds9qxpqysgqtsd5g8er8mhnst3eres2455nxxm4kd44c4uwa3fvu8ueqsgf4vd5ft94jk8u54ahh'
  + 'vx9nmlz4r4z2w7yvcpd7nrk7d8yy489lfg5djspkrewuj';
const PRICED = 'lnbc170n1pcheque' + 'q'.repeat(40);      // 17 sats

let failed = 0;
const ok = (good, what) => {
  console.log((good ? 'ok   ' : 'FAIL ') + what);
  if (!good) failed += 1;
};

async function run() {
  const phone = nativePhone({ words: PHONE_WORDS });
  let mint = null;
  const reply = (w, id, t, e) => setTimeout(() => w.FoxyWallet._scanResult(id, t, e), 0);
  const ctx = loadReal({
    bridge: (w, m) => {
      if (m.action === 'mintRequest') return reply(w, m.id, mint.handle(m));
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = fakeMint(w); },
  });
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  const W = ctx.W;
  await W.connect('https://m.test', { remember: true });

  // ---- it is an invoice, and it names nothing ------------------------------
  ok(W.classify(NONE) === 'invoice', 'an amountless invoice reads as an invoice, not as rubbish');
  ok(W.amountOf(NONE) === null, 'and its amount reads as nothing, not as zero');
  ok(W.amountOf(PRICED) === 17, 'a priced one still reads its amount (' + W.amountOf(PRICED) + ')');

  const why = async (fn) => {
    try { await fn(); return ''; } catch (e) { return String((e && e.message) || e); }
  };

  // ---- the three ways of asking -------------------------------------------
  {
    /* No amount anywhere. Nothing can be sent, and the reason names the
     * invoice rather than the mint: this one never reaches a mint. */
    const said = await why(() => W.pay(NONE, () => {}));
    ok(/names no amount/.test(said), 'an amountless invoice with no amount given is refused :: ' + said.slice(0, 70));
  }
  {
    /* An amount given, and a mint that does not advertise NUT-05's amountless
     * option. The mint is named, because that is the thing to change — and it
     * is refused *before* any money moves, not after a melt quote fails. */
    const said = await why(() => W.pay(NONE, () => {}, { sats: 21 }));
    ok(/does not pay invoices that name no amount/.test(said),
      'a mint that cannot do it is named before anything moves :: ' + said.slice(0, 70));
    ok(/m\.test/.test(said), 'and named by host, so it is clear which mint to change');
  }
  {
    /* Both. The invoice is what the payee signed, so an amount beside one that
     * already carries its own is refused rather than quietly preferred. */
    const said = await why(() => W.pay(PRICED, () => {}, { sats: 21 }));
    ok(/already names an amount/.test(said),
      'an amount beside a priced invoice is refused :: ' + said.slice(0, 70));

    // and the same amount is not a way in either: it is still two sources
    const same = await why(() => W.pay(PRICED, () => {}, { sats: 17 }));
    ok(!/already names an amount/.test(same),
      'though the same amount is not treated as a disagreement');
  }
}

run().then(() => {
  console.log(failed ? '\n' + failed + ' failed' : '\nall amountless invoice checks pass');
  process.exit(failed ? 1 : 0);
}, (e) => { console.log('THREW', (e && e.stack) || e); process.exit(1); });
