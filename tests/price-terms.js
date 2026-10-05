'use strict';
/* price-terms.js — who says what a dollar is worth, and when the money moves.
 *
 *     node tests/price-terms.js
 *
 * A receiver with no route has a bitcoin price that may be hours old, and a
 * wrong conversion is a wrong amount of money. So it does not do the
 * conversion: it asks in dollars and says what its own price was. The payer,
 * who has a current one, answers with its price and the sats that makes. The
 * receiver compares the two, and agrees or does not — and only then does a
 * request with a sat amount go back and the payment follow.
 *
 * The order is the point. Nothing leaves the payer until the receiver has
 * agreed to the number.
 *
 * And the receiver never has to trust the payer's price. It is shown the sats
 * and told how the payer's price compares with the last one it saw, and it
 * agrees to the sats. A payer who lies about the price is lying about how many
 * sats they are offering, which is the figure on the screen. That is why this
 * needs no attestation of the other phone's software, which two phones with no
 * route could not do anyway.
 */
const { loadReal, fakeMint, nativePhone, PHONE_WORDS } = require('./harness');

const MINT = 'https://m.test';
let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};

function page(o) {
  const opts = o || {};
  const phone = nativePhone({ words: opts.words || PHONE_WORDS });
  let mint = null;
  let ctx = null;
  const reply = (w, id, text, err) => setTimeout(() => w.FoxyWallet._scanResult(id, text, err), 0);
  ctx = loadReal({
    storage: opts.storage,
    bridge: (w, m) => {
      if (m.action === 'mintRequest') {
        if (ctx.deaf) return reply(w, m.id, null, 'The Internet connection appears to be offline');
        return reply(w, m.id, mint.handle(m));
      }
      const got = phone.answer(w, m);
      if (!got) return reply(w, m.id, null, 'not in this test');
      return Promise.resolve(got).then((r) => reply(w, m.id, r[0], r[1]));
    },
    before: (w) => { phone.attach(w); mint = opts.sharedMint || fakeMint(w, { p2pk: true }); },
  });
  ctx.deaf = !!opts.deaf;
  ctx.mint = mint;
  ctx.W._nodeProbeDelay = [86400000, 86400000];
  return ctx;
}
const goOffline = (W) => {
  W._privacy({ tor: 'connecting', progress: 0, everUp: false, unprotected: false,
               transport: 'direct', network: 'none' });
  W.setOffline(true);
};

async function run() {
  const rx = page({});
  await rx.W.connect(MINT, null, null, { remember: true });
  const payer = page({ sharedMint: rx.mint,
    words: 'legal winner thank year wave sausage worth useful legal winner thank yellow' });
  await payer.W.connect(MINT, null, null, { remember: true });

  /* The receiver is offline and its price is two hours old. It asks for $5.00
   * and does not convert it. */
  const twoHours = Date.now() - 2 * 3600 * 1000;
  rx.W._rate = 100000; rx.W._rateAt = twoHours;
  goOffline(rx.W);
  const text = rx.W.paymentRequest(0, { purpose: 'receive', usd: 500,
                                        rate: rx.W._rate, rateAt: rx.W._rateAt });
  ok(!!text, 'a request is made with no sat amount on it', text ? 'made' : 'none');
  const req = payer.W.decodeRequest(text) || {};
  ok(req.sats === 0, 'and the payer reads no amount', String(req.sats));
  ok(req.usd === 500, 'only the dollars asked for', String(req.usd));
  ok(req.theirRate === 100000 && Math.abs(req.theirRateAt - twoHours) < 1000,
     'and the price the receiver last saw, with when',
     JSON.stringify({ rate: req.theirRate, agoMs: Date.now() - req.theirRateAt }));
  ok(payer.W.asksInDollars(req) === true, 'which is what asking in dollars looks like');

  /* The payer's price is 2% higher and current. */
  payer.W._rate = 102000; payer.W._rateAt = Date.now();
  const quote = payer.W.quoteFor(req);
  ok(!!quote, 'the payer answers with a quote', JSON.stringify(quote && quote.sats));
  const want = Math.round((500 / 100) / 102000 * 1e8);
  ok(quote.sats === want, 'converting at its own price, not theirs',
     String(quote.sats) + ' vs ' + want);
  ok(quote.rate === 102000, 'and saying what that price is', String(quote.rate));

  /* The receiver reads it against what it last saw. */
  const seen = rx.W.readQuote(JSON.stringify(quote));
  ok(!!seen, 'the receiver can read it');
  ok(seen.sats === want, 'and is told the sats it would be paid', String(seen.sats));
  ok(Math.abs(seen.differsPct - 2) < 0.01,
     'and that their price is 2% above the one it last saw',
     String(seen.differsPct));
  ok(Math.abs(seen.myRateAgeMs - 2 * 3600 * 1000) < 5000,
     'which it saw two hours ago', String(Math.round(seen.myRateAgeMs / 60000)) + ' minutes');

  /* The comparison is this phone's arithmetic, not the payer's. A quote that
   * claims a flattering difference cannot change what the receiver is shown. */
  const lying = Object.assign({}, quote, { differsPct: 0, myRate: 102000 });
  const read = rx.W.readQuote(JSON.stringify(lying));
  ok(Math.abs(read.differsPct - 2) < 0.01,
     'a payer cannot dress up the comparison: it is worked out here',
     String(read.differsPct));

  /* A payer with no price of its own offers nothing rather than guessing. */
  payer.W._rate = null; payer.W._rateAt = 0;
  ok(payer.W.quoteFor(req) === null,
     'a payer with no price does not pretend to have one');

  /* And an ordinary request, with sats on it, carries none of this. */
  const plain = rx.W.decodeRequest(rx.W.paymentRequest(2100, { purpose: 'receive' })) || {};
  ok(plain.sats === 2100 && plain.usd === 0 && !rx.W.asksInDollars(plain),
     'a request with a sat amount is untouched by any of it',
     JSON.stringify({ sats: plain.sats, usd: plain.usd }));

  /* ---- the app's half: who is asked, in what order --------------------------
   *
   * The wallet above settles the arithmetic. This settles the choreography: the
   * payer quotes and waits, the receiver's person decides, and the sats request
   * goes back only on a yes. `tapQuote`/`tapTerms` are recorded rather than
   * sent, so what crosses the link is what is checked. */
  {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
    const method = (sig) => {
      const at = src.indexOf('\n  ' + sig);
      if (at < 0) throw new Error('missing ' + sig);
      let i = src.indexOf('{', at), depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
      }
      return src.slice(at + 3, i + 1);
    };
    const SIGS = ['tapQuoteTheirDollars(offer) {', 'tapPriceOffered(text) {',
                  'waitingScreen(kind, o) {', 'waitingForPayer(offline) {',
                  'tapPreQuoteMint(offer, sats) {', 'tapAgreeTheirPrice(offer, sats) {',
                  'saySatsLeftAt(sats, mint) {',
                  'tapWrongMint(offer) {', 'tapPayOffer(offer, sats) {',
                  'agoWords(ms) {', 'group(n) {', 'usd(v) {'];
    const methods = new Function('window', 'return {' + SIGS.map(method).join(',') + '}');

    const sent = [];
    // each app gets the wallet it belongs to as its `window.FoxyWallet`
    const base = (W, extra) => Object.assign({
      state: {}, setState() {}, toast(m) { sent.push({ toast: m }); },
      back() { sent.push({ back: true }); },
      blockedCard(kind) { sent.push({ card: kind }); },
      // the waiting screens that replaced some cards (26e-loaders.js); same kinds
      stageScreen(kind) { sent.push({ card: kind }); },
      hideStage() { return false; }, stageUp() { return false; }, hideConnecting() {},
      dismissCard() {}, haptic() {},
      openRequest(text) { sent.push({ pay: String(text) }); },
      /* Whether a decision is being put to a person with a payer waiting. It is
       * what holds the radio, the screen and the inbox open across the answer —
       * keyed on this and not on the screen, because the answer is sent after
       * the screen has already gone home (26d-tap.js, tests/tap-held.js). */
      tapTalking(on) { sent.push({ talking: !!on }); },
      tapGaveNothing() {},
      // the real one waits for railRequest to fill in (12-receive.js)
      railRequestReady(n) {
        const key = String(n);
        if (this._made[key]) return Promise.resolve(this._made[key]);
        return new Promise((ok) => setTimeout(() => {
          this._made[key] = 'creq-for-' + n; ok(this._made[key]);
        }, 0));
      },
      // the mint questions have their own tests; here the amount is the point
      tapCrossMint(o, n) { sent.push({ cross: n }); },
      tapWrongMint() { sent.push({ wrongMint: true }); },
      acceptTarget() { sent.push({ lightning: true }); return true; },
      offlineNow: () => false,
      /* As the real one behaves, which is the whole point.
       *
       * `railRequest` answers '' for an amount it has not made a request for
       * yet and fills it in a tick later (12-receive.js) — and a stub that
       * answered at once hid an ACCEPT that told the payer it had been refused. */
      _made: {},
      railRequest(n) {
        const key = String(n);
        if (this._made[key]) return this._made[key];
        setTimeout(() => { this._made[key] = 'creq-for-' + n; }, 0);
        return '';
      },
    }, methods({ FoxyWallet: W }), extra || {});

    // the payer, holding a live price, answering the dollar request above
    payer.W._rate = 102000; payer.W._rateAt = Date.now();
    const quoted = [];
    payer.W.tapQuote = (body) => { quoted.push(String(body)); return Promise.resolve('ok'); };
    let heardTerms = null;
    payer.W.onTapTerms = (fn) => { heardTerms = fn; };
    const payerApp = base(payer.W);
    payerApp.tapQuoteTheirDollars({ read: req, req: text, sameMint: true, asksUsd: true });
    ok(quoted.length === 1, 'the payer sends its price and nothing else', JSON.stringify(sent));
    ok(!sent.some((e) => e.pay),
       'no payment screen opens while they are still deciding', JSON.stringify(sent));
    ok(sent.some((e) => e.card === 'priceSent'),
       'and the person holding it is told what is happening', JSON.stringify(sent));

    // the receiver, reading that quote and being asked
    const termsOut = [];
    rx.W.tapTerms = (body) => { termsOut.push(String(body)); return Promise.resolve('ok'); };
    const answer = { yes: true };
    const rxApp = base(rx.W, { priceTermsCard: (q) => { rxApp._sawQuote = q; return Promise.resolve(answer.yes); } });

    answer.yes = false;
    await rxApp.tapPriceOffered(quoted[0]);
    await new Promise((r) => setTimeout(r, 5));
    ok(rxApp._sawQuote && rxApp._sawQuote.sats === want,
       'the receiver is shown the sats the payer offered',
       JSON.stringify(rxApp._sawQuote && rxApp._sawQuote.sats));
    ok(termsOut.length === 1 && JSON.parse(termsOut[0]).no === true,
       'a DENY is sent, not left as a silence the payer has to time out',
       JSON.stringify(termsOut));
    ok(!termsOut.some((t) => JSON.parse(t).req),
       'and no request goes back, so there is nothing to pay', JSON.stringify(termsOut));

    answer.yes = true;
    await rxApp.tapPriceOffered(quoted[0]);
    await new Promise((r) => setTimeout(r, 5));
    const agreed = JSON.parse(termsOut[termsOut.length - 1]);
    ok(agreed.sats === want && /^creq-for-/.test(String(agreed.req)),
       'an ACCEPT sends the request back, now naming the sats agreed',
       JSON.stringify(agreed));

    /* The payer reads the request that comes back and pays it only if it is
     * for the sats it offered. The receiver's stub makes a
     * stand-in, `creq-for-<sats>`, so the payer's reader is taught it. */
    const realDecode = payer.W.decodeRequest;
    payer.W.decodeRequest = (t) => {
      const m = /^creq-for-(\d+)$/.exec(String(t));
      return m ? { id: 'agreed', sats: Number(m[1]), unit: 'sat' } : realDecode.call(payer.W, t);
    };
    // and that request is what the payer opens — the first thing it pays
    ok(typeof heardTerms === 'function', 'the payer was listening for it');
    heardTerms(JSON.stringify(agreed));
    ok(sent.filter((e) => e.pay).length === 1
       && sent.filter((e) => e.pay)[0].pay === agreed.req,
       'the payer opens that request and no other', JSON.stringify(sent.filter((e) => e.pay)));

    /* Their mint is not this phone's mint.
     *
     * With a route on their side there is an invoice and the invoice is paid.
     * Offline there is not one, and the payment is proofs a particular mint
     * issued — which a different mint will not take. So nothing is quoted and
     * nothing is sent, and the card names both mints rather than saying "a mint
     * you hold nothing at", which is often untrue: `sameMint` is only about the
     * mint this wallet is on. */
    {
      const other = 'https://other.test';
      const elsewhere = payer.W.decodeRequest(text) || {};
      const cards = [];
      const holds = { [other]: 0 };
      const wrongApp = base(payer.W, {
        blockedCard(kind, over) { cards.push({ kind, over }); },
        mintNameOf: (u) => String(u || '').replace(/^https?:\/\//, '').split('.')[0],
        goSwitchMint() { cards.push({ went: 'switchMint' }); },
      });
      payer.W.balanceAt = (u) => holds[String(u).replace(/\/+$/, '')] || 0;

      const read = { inv: '', req: text, sameMint: false, asksUsd: false,
                     read: elsewhere, mints: [other] };
      const before = quoted.length;
      wrongApp.tapWrongMint(read);
      ok(quoted.length === before,
         'a mint that does not match is not quoted a price at all', String(quoted.length - before));
      ok(cards.length === 1 && cards[0].kind === 'wrongMint',
         'the person is told, on a card rather than a toast that is gone in two seconds',
         JSON.stringify(cards.map((c) => c.kind)));
      ok(/other/.test(cards[0].over.reason) && /Nothing was sent/.test(cards[0].over.chip),
         'which names their mint and says nothing was sent', cards[0].over.reason);
      ok(/hold nothing there/.test(cards[0].over.reason) && !cards[0].over.retry,
         'with nothing held there, there is nothing to switch to and it says so',
         JSON.stringify({ reason: cards[0].over.reason, retry: cards[0].over.retry }));

      // and the case the old wording got wrong: money IS held at their mint
      holds[other] = 5000;
      cards.length = 0;
      wrongApp.tapWrongMint(read);
      ok(/You do hold money at/.test(cards[0].over.reason),
         'money held at their mint is not called holding nothing', cards[0].over.reason);
      ok(cards[0].over.retry === 'CHOOSE A MINT' && typeof cards[0].over.go === 'function',
         'and the card offers the switch that would make it work',
         JSON.stringify({ retry: cards[0].over.retry }));
      cards[0].over.go();
      ok(cards.some((c) => c.went === 'switchMint'), 'which is where it goes',
         JSON.stringify(cards.map((c) => c.kind || c.went)));
    }

    /* ---- an offline payer is never sent to Lightning ----------------------
     *
     * Every branch of the mint question was gated on "they sent no invoice",
     * which is written for a receiver with no route — it cannot make one. It
     * reads backwards when it is the PAYER that has no route: an online
     * receiver at another mint offers an invoice, all the gates fall through,
     * and the offline payer is walked to a Lightning send screen that can only
     * fail. It did, all the way to "send failed: Foxy is working offline".
     *
     * With no route there is no invoice to speak of. What is left is the mint
     * question, and for a different mint that is the carry-home talk. */
    {
      const seen = [];
      const theirs = 'https://theirs.test';
      const offlineApp = base(payer.W, {
        offlineNow: () => true,
        blockedCard(kind) { seen.push({ card: kind }); },
        acceptTarget(inv) { seen.push({ lightning: String(inv) }); return true; },
        openRequest(text) { seen.push({ pay: String(text) }); },
        tapCrossMint() { seen.push({ cross: true }); },
        tapStuckAtMint(o, stuck) { seen.push({ stuck: stuck && stuck.mint }); },
        tapWrongMint() { seen.push({ wrongMint: true }); },
      });
      payer.W.stuckAtMint = () => ({ mint: 'https://mine.test', have: 5000, sats: 100 });

      // their mint, their invoice, and this phone has no route
      offlineApp.tapPayOffer({ inv: 'lnbc1190n1pfake', req: 'creqA', sameMint: false,
                               crossable: true, mints: [theirs], read: { sats: 100 } }, 100);
      ok(!seen.some((e) => e.lightning),
         'an offline payer is never handed a Lightning invoice to pay',
         JSON.stringify(seen));
      ok(seen.some((e) => e.stuck),
         'it says which mint it is stuck at, so they can quote the way home',
         JSON.stringify(seen));

      // and with nothing held anywhere, it says so rather than trying anything
      seen.length = 0;
      payer.W.stuckAtMint = () => null;
      offlineApp.tapPayOffer({ inv: 'lnbc1190n1pfake', req: 'creqA', sameMint: false,
                               crossable: true, mints: [theirs], read: { sats: 100 } }, 100);
      ok(!seen.some((e) => e.lightning) && seen.some((e) => e.wrongMint),
         'and with nothing to offer it says so rather than reaching for Lightning',
         JSON.stringify(seen));

      // the same mint is still paid in ecash, route or no route
      seen.length = 0;
      offlineApp.tapPayOffer({ inv: 'lnbc1190n1pfake', req: 'creqB', sameMint: true,
                              crossable: false, mints: [], read: { sats: 100 } }, 100);
      ok(seen.length === 1 && seen[0].pay === 'creqB',
         'and the same mint is still paid in ecash, which needs no route at all',
         JSON.stringify(seen));

      // an ONLINE payer still takes the invoice: one payment, not two
      seen.length = 0;
      const onlineApp = base(payer.W, {
        offlineNow: () => false,
        acceptTarget(inv) { seen.push({ lightning: String(inv) }); return true; },
        tapCrossMint() { seen.push({ cross: true }); },
        tapStuckAtMint() { seen.push({ stuck: true }); },
        tapWrongMint() { seen.push({ wrongMint: true }); },
      });
      onlineApp.tapPayOffer({ inv: 'lnbc1190n1pfake', req: 'creqA', sameMint: false,
                             crossable: true, mints: [theirs], read: { sats: 100 } }, 100);
      ok(seen.length === 1 && seen[0].lightning === 'lnbc1190n1pfake',
         'while a payer with a route still pays their invoice, which is one payment not two',
         JSON.stringify(seen));
    }

    /* ---- the two screens, laid out as designed --------------------
     *
     * Both were cards, and a card is for something that went wrong. These are a
     * person looking at figures and deciding, which is what the confirmation
     * shell is for — and the crossing one IS the confirmation, so agreeing to
     * the fee is the last thing there is to press.
     */
    {
      const fs2 = require('fs');
      const src2 = fs2.readFileSync(require('path').join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
      const grab = (sig) => {
        const at = src2.indexOf('\n  ' + sig);
        if (at < 0) throw new Error('missing ' + sig);
        let i = src2.indexOf('{', at), depth = 0;
        for (; i < src2.length; i++) {
          if (src2[i] === '{') depth++;
          else if (src2[i] === '}') { depth--; if (depth === 0) break; }
        }
        return src2.slice(at + 3, i + 1);
      };
      const specs = new Function('window', 'return {'
        + ['priceSpec() {', 'crossSpec() {', 'cfRow(label, value, opt) {',
           'agoWords(ms) {', 'usd(v) {', 'group(n) {'].map(grab).join(',') + '}');

    /* ---- the offline side sees the price it is trusting -------------------
     *
     * A phone with no route converts at whatever it last saw, which can be
     * hours old. In a tap with a phone that IS online it is trusting that
     * phone's price — so it should be showing THAT price, said to be theirs,
     * rather than converting at its own and saying nothing. The payer already tells a receiver this in M10; the offer
     * carries the same fact the other way.
     */
    {
      const M = new Function('window', 'return {'
        + ['peerRate() {', 'peerRateLabel() {', 'px() {', 'peerRateRow() {',
           'cfRow(label, value, opt) {', 'group(n) {'].map(grab).join(',') + '}');
      const phone = (offline, peer) => Object.assign(M({ FoxyWallet: null }), {
        state: { peerRate: peer || 0, peerRateAt: Date.now(), livePrice: 70000 },
        offlineNow: () => offline,
      });

      const off = phone(true, 84123);
      ok(off.px() === 84123,
         'offline, the dollar figures are in the price the other phone gave',
         String(off.px()));
      ok(/At their bitcoin price, \$ 84,123/.test(off.peerRateLabel()),
         'and the screen says whose price that is', off.peerRateLabel());
      const row = off.peerRateRow()[0] || {};
      ok(row.label === 'BITCOIN PRICE' && row.value === '$ 84,123'
         && /theirs, not this phone/.test(row.sub || ''),
         'on the confirmation, as a row of its own', JSON.stringify(row.value + ' / ' + row.sub));

      const on = phone(false, 84123);
      ok(on.px() === 70000 && on.peerRateRow().length === 0,
         'with a route of its own, this phone uses its own price and says nothing',
         String(on.px()));
      const blind = phone(true, 0);
      ok(blind.px() === 70000 && blind.peerRateRow().length === 0,
         'and offline with nothing offered, it falls back to what it last saw',
         String(blind.px()));
    }

      // a receiver with no route, being offered a price 0.6% above its last
      const rx2 = Object.assign(specs({ FoxyWallet: null }), {
        // the row that says whose bitcoin price the dollars are in: none here,
        // because these two screens are tested with this phone's own price
        peerRateRow: () => [], peerRate: () => 0, peerRateLabel: () => '',
        state: { priceQ: { sats: 2876, usd: 242, theirRate: 84123,
                           differsPct: 0.6, myRateAgeMs: 2 * 3600 * 1000 } },
        setState() {}, px: () => 84123,
      });
      const ps = rx2.priceSpec();
      const row = (sp, label) => (sp.rows.find((r) => r.label === label) || {}).value;
      ok(ps.amountLabel === 'CURRENT BITCOIN PRICE' && ps.amount === '$ 84,123' && !ps.amountSub,
         'the price screen leads with the price, which is what is being agreed',
         JSON.stringify({ label: ps.amountLabel, amount: ps.amount, sub: ps.amountSub }));
      ok(ps.title === 'BITCOIN PRICE'
         && /What you receive is based on the Bitcoin price, which has changed since you were last online\./.test(ps.subtitle),
         'it says the price has moved since this phone was last online', ps.subtitle);
      ok(row(ps, 'DIFFERENCE') === '+0.6%', 'then how far it moved', row(ps, 'DIFFERENCE'));
      ok(row(ps, 'RESULT') === 'You are receiving 0.6% less in terms of sats.',
         'then what that does to the sats: a higher price is fewer of them', row(ps, 'RESULT'));
      // no question row: the two buttons are the question
      ok(row(ps, 'DO YOU AGREE?') === undefined && ps.rows.length === 2,
         'and nothing under them but the two answers', ps.rows.length + ' rows');
      ok(ps.cta === 'YES, CONTINUE' && ps.secondary.label === 'NO, CANCEL',
         'and the two answers are the two the design calls for',
         JSON.stringify({ cta: ps.cta, second: ps.secondary.label }));

      // the same screen for a payer with no route: every word turns round
      rx2.state.priceQ = { sats: 2876, usd: 242, theirRate: 84123, differsPct: -2.4,
                           myRateAgeMs: 2 * 3600 * 1000, side: 'pay' };
      const pp = rx2.priceSpec();
      ok(/What you pay is based/.test(pp.subtitle)
         && row(pp, 'DIFFERENCE') === '\u22122%'
         && row(pp, 'RESULT') === 'You are paying 2% more in terms of sats.'
         && pp.rows.length === 2,
         'a payer is asked the same thing in its own words, and a lower price is more sats',
         JSON.stringify({ sub: pp.subtitle, d: row(pp, 'DIFFERENCE'), r: row(pp, 'RESULT') }));

      // and with no price ever seen, it says so rather than implying a number
      rx2.state.priceQ = { sats: 2876, usd: 242, theirRate: 84123, differsPct: null, myRateAgeMs: 0 };
      ok(/no earlier price to compare/.test(rx2.priceSpec().subtitle || ''),
         'with no price ever seen it says there is nothing to compare',
         rx2.priceSpec().subtitle);

      // the crossing screen: total, what they get, what it costs
      const tx2 = Object.assign(specs({ FoxyWallet: null }), {
        peerRateRow: () => [], peerRate: () => 0, peerRateLabel: () => '',
        state: { crossQ: { net: 60, fee: 10, them: 'Minibits', mine: 'Macadamia' } },
        setState() {}, px: () => 84000, mintNameOf: (u) => u,
      });
      const cs = tx2.crossSpec();
      ok(cs.title === 'THEY USE ANOTHER MINT' && cs.amountLabel === 'TOTAL PAYMENT'
         && cs.amount === '$ 0.06' && cs.amountSub === '₿ 70',
         'the crossing screen leads with the total, which is what leaves',
         JSON.stringify({ title: cs.title, amount: cs.amount }));
      ok(row(cs, 'RECEIVER GETS') === '$ 0.05' && row(cs, 'SWAP FEE') === '$ 0.01',
         'and breaks it into what they get and what the crossing costs',
         JSON.stringify({ gets: row(cs, 'RECEIVER GETS'), fee: row(cs, 'SWAP FEE') }));
      ok(/^PAY \$ 0\.06/.test(cs.cta) && cs.secondary.label === 'CANCEL',
         'its button names the total, so pressing it is agreeing to that figure', cs.cta);
      ok(cs.rows.some((r) => r.label === 'THEIR MINT' && r.value === 'MINIBITS')
         && cs.rows.some((r) => r.label === 'PAYING FROM' && r.value === 'MACADAMIA'),
         'and both mints are named, so neither is a surprise',
         JSON.stringify(cs.rows.map((r) => r.label + '=' + r.value)));
    }

    /* ---- money of your own, at somebody else's mint ----------------------
     *
     * Carrying a payment home melts it out of the payer's mint, and a melt
     * reserves more than the route spends. What is left is this phone's, at a
     * mint its user does not use — thousands of sats left at one mint after
     * carrying a payment home to another, and the only place that appeared was
     * the diary.
     *
     * Not a warning: nothing is wrong and nothing is at risk. It names the
     * figure and the mint, and puts the screen that moves it one press away.
     */
    {
      const said = [];
      const rx3 = base(rx.W, {
        blockedCard(kind, over) { said.push({ kind, over }); },
        mintNameOf: (u) => String(u || '').replace(/^https?:\/\//, '').split('.')[0],
        goSwitchMint() { said.push({ went: 'switchMint' }); },
      });
      rx3.saySatsLeftAt(20067, 'https://mint.minibits.cash/Bitcoin');
      const card = (said[0] || {}).over || {};
      ok(said.length === 1 && said[0].kind === 'leftBehind',
         'money left at their mint is said, not left to the diary',
         JSON.stringify(said.map((x) => x.kind)));
      ok(/20,067 sats of yours are at mint/.test(card.reason || ''),
         'with the figure and the mint named', card.reason);
      ok(card.tone === 'ask' && /Nothing is at risk/.test(card.chip || ''),
         'and as a thing to know rather than a thing that went wrong',
         JSON.stringify({ tone: card.tone, chip: card.chip }));
      ok(card.retry === 'MOVE IT' && typeof card.go === 'function',
         'with the screen that moves it one press away', card.retry);
      card.go();
      ok(said.some((x) => x.went === 'switchMint'), 'which is where it goes',
         JSON.stringify(said.map((x) => x.kind || x.went)));
    }

    /* ---- the link is held from the question to the answer ----------------
     *
     * Three builds in a row sent the answer into a link that had already been
     * retired. Each time the hold was keyed on the SCREEN, and each time the
     * screen moved first: `priceAnswer` navigates home and *then* sends the
     * terms, so by the time `tapTerms` runs the screen is 'home' and every
     * screen test has already let go (home first, terms sixteen
     * milliseconds later).
     *
     * So the order is the thing to hold: talking goes ON before the person is
     * asked and OFF only after the answer is on the wire. Anything that reads
     * the screen is downstream of that and cannot race it.
     */
    {
      const order = [];
      rx.W.tapTerms = (body) => {
        let b = {}; try { b = JSON.parse(body); } catch (e) {}
        order.push('terms:' + (b.no ? 'no' : b.sats));
        return Promise.resolve('ok');
      };
      const rx4 = base(rx.W, {
        tapTalking(on) { order.push(on ? 'hold' : 'free'); },
        priceTermsCard: () => Promise.resolve(true),
        railRequestReady: () => Promise.resolve('creq-agreed'),
      });
      await rx4.tapPriceOffered(quoted[0]);
      await new Promise((r) => setTimeout(r, 10));
      ok(order[0] === 'hold',
         'the link is held before the person is asked anything', JSON.stringify(order));
      /* And NOT let go when the answer is sent. `tapTerms` resolving means the
       * write is queued, not delivered — released there, the radio was retired
       * four milliseconds later and took the un-sent write with it (the payer
       * never heard it). After sending the terms this phone is waiting for the
       * payment those terms are about, so the hold belongs to that. */
      ok(order.findIndex((x) => /^terms:/.test(x)) >= 0 && order.indexOf('free') < 0,
         'and kept past the answer, because the payment it agreed to comes next',
         JSON.stringify(order));

      order.length = 0;
      const rx5 = base(rx.W, {
        tapTalking(on) { order.push(on ? 'hold' : 'free'); },
        priceTermsCard: () => Promise.resolve(false),
      });
      await rx5.tapPriceOffered(quoted[0]);
      await new Promise((r) => setTimeout(r, 10));
      /* A refusal really is the end — but the write still has to leave first,
       * so the release waits a beat rather than racing the radio. */
      ok(order[0] === 'hold' && order.indexOf('terms:no') >= 0 && order.indexOf('free') < 0,
         'a rejection is sent and the link is still not dropped on top of it',
         JSON.stringify(order));
      await new Promise((r) => setTimeout(r, 2200));
      ok(order.indexOf('free') > order.indexOf('terms:no'),
         'and let go a beat later, once it has had time to leave',
         JSON.stringify(order));
    }

    /* ---- the mint is worked out while they are deciding -------------------
     *
     * "Same mint?" is answerable the moment the offer arrives, and what a
     * crossing costs depends only on the amount this phone just offered —
     * neither waits on whether the person agrees the price. Asking after their
     * YES meant several more seconds of nothing while two mints were consulted
     * ("don't wait for BTC price agreement to determine the
     * mint... so the payer gets the next correct screen after deciding").
     */
    {
      const asked = [];
      const transferQuote = (from, sats, o) => {
        asked.push({ from: from, sats: sats, to: (o || {}).to, land: !!(o || {}).land });
        return Promise.resolve({ net: sats, feeSats: 9, moving: sats, from: from, to: (o || {}).to });
      };
      /* `mintUrl` is a getter on the real wallet, so the phone this test drives
       * is a thin stand-in carrying just what `tapPreQuoteMint` reads. */
      const asWallet = { mintUrl: MINT, transferQuote: transferQuote };
      const pre = base(asWallet, { offlineNow: () => false });

      // their mint is not this one: the crossing is quoted at once
      pre.tapPreQuoteMint({ mints: ['https://theirs.test'], inv: '' }, 2100);
      ok(asked.length === 1 && asked[0].sats === 2100
         && asked[0].to === 'https://theirs.test' && asked[0].land === true,
         'a crossing is quoted the moment the price goes out, not after the answer',
         JSON.stringify(asked));
      ok(pre._crossReady && pre._crossReady.sats === 2100,
         'and the answer is kept for the screen that will need it',
         JSON.stringify(pre._crossReady && pre._crossReady.sats));

      // the same mint has nothing to quote
      asked.length = 0;
      pre.tapPreQuoteMint({ mints: [MINT], inv: '' }, 2100);
      ok(!asked.length && !pre._crossReady,
         'the same mint asks nothing, because there is no crossing', JSON.stringify(asked));

      // an invoice from an online payer is paid over Lightning, not crossed
      asked.length = 0;
      pre.tapPreQuoteMint({ mints: ['https://theirs.test'], inv: 'lnbc1' }, 2100);
      ok(!asked.length, 'nor does an offer this phone will pay over Lightning',
         JSON.stringify(asked));

      // and an offline payer does not quote it: their side does that
      asked.length = 0;
      const off = base(asWallet, { offlineNow: () => true });
      off.tapPreQuoteMint({ mints: ['https://theirs.test'], inv: '' }, 2100);
      ok(!asked.length && !off._crossReady,
         'and a payer with no route leaves the quoting to the phone that has one',
         JSON.stringify(asked));
    }

    /* ---- whoever is offline agrees the price, whichever side they are on ---
     *
     * The offline RECEIVER asks in dollars and is shown the payer's price. The
     * offline PAYER is handed a request in sats, and every dollar figure it is
     * about to show comes from the price THEY sent — so it agrees to that too,
     * rather than discovering it on a confirmation screen ("offline user will always confirm BTC PRICE difference"). One screen,
     * asked from either side.
     */
    {
      const seen = [];
      const offlinePayer = base(payer.W, {
        offlineNow: () => true,
        tapTalking() {},
        priceTermsCard(q) { seen.push({ asked: q }); return Promise.resolve(true); },
        openRequest(t) { seen.push({ pay: String(t) }); },
        tapCrossMint() { seen.push({ cross: true }); },
        tapStuckAtMint() { seen.push({ stuck: true }); },
        tapWrongMint() { seen.push({ wrongMint: true }); },
        acceptTarget() { seen.push({ lightning: true }); return true; },
      });
      payer.W.lastPrice = () => ({ rate: 80000, at: Date.now() - 3600000, ageMs: 3600000 });

      const theirOffer = { req: 'creqTheirs', sameMint: true, crossable: false, mints: [],
                           inv: '', theirRate: 84000, theirRateAt: Date.now(),
                           read: { sats: 1000 } };
      await offlinePayer.tapPayOffer(theirOffer, 1000);
      await new Promise((r) => setTimeout(r, 5));
      const asked = (seen.find((x) => x.asked) || {}).asked;
      ok(!!asked, 'an offline payer is asked to agree the price it is paying at',
         JSON.stringify(seen.map((x) => Object.keys(x)[0])));
      ok(asked && asked.theirRate === 84000 && Math.abs(asked.differsPct - 5) < 0.01,
         'with their price, and how far it is from the one this phone last saw',
         JSON.stringify(asked && { theirs: asked.theirRate, differs: asked.differsPct }));
      ok(seen.some((x) => x.pay === 'creqTheirs'),
         'and agreeing it carries straight on to the payment', JSON.stringify(seen));

      // and it is asked once per tap, not again on the way through
      seen.length = 0;
      await offlinePayer.tapPayOffer(theirOffer, 1000);
      await new Promise((r) => setTimeout(r, 5));
      ok(!seen.some((x) => x.asked) && seen.some((x) => x.pay),
         'and it is asked once for a tap, not again at every step',
         JSON.stringify(seen.map((x) => Object.keys(x)[0])));

      // a payer WITH a route uses its own price and is asked nothing
      seen.length = 0;
      const onlinePayer = base(payer.W, {
        offlineNow: () => false, tapTalking() {},
        priceTermsCard(q) { seen.push({ asked: q }); return Promise.resolve(true); },
        openRequest(t) { seen.push({ pay: String(t) }); },
      });
      onlinePayer.tapPayOffer(theirOffer, 1000);
      ok(!seen.some((x) => x.asked) && seen.some((x) => x.pay),
         'while a payer with its own price is asked nothing',
         JSON.stringify(seen.map((x) => Object.keys(x)[0])));
    }

    // a payer with no price offers nothing and says so
    const noPrice = page({ sharedMint: rx.mint, words: PHONE_WORDS });
    noPrice.W._rate = null; noPrice.W._rateAt = 0;
    noPrice.W.tapQuote = () => { throw new Error('should not be asked'); };
    const dry = [];
    const dryApp = base(noPrice.W, { blockedCard(kind) { dry.push(kind); },
                                     back() { dry.push('<back>'); } });
    dryApp.tapQuoteTheirDollars({ read: req, req: text, sameMint: true, asksUsd: true });
    ok(dry[0] === 'noPriceToQuote' && dry.indexOf('<back>') > 0,
       'a payer with no price says so rather than quoting one', JSON.stringify(dry));
  }

  console.log('\n' + (failed ? failed + ' price-terms check(s) failed'
    : 'all price-terms checks pass'));
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });
