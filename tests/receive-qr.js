'use strict';
/* receive-qr.js — the receive screen's QR waits rather than lying.
 *
 *     node tests/receive-qr.js
 *
 * cashuRequest and railRequest from build/foxy-app.js. A Cashu payment request
 * with no amount in it is offered by the payer's wallet as "pay any amount", so
 * it must never stand in for one the person typed a figure into. While there is
 * no figure to put in, cashuRequest returns '' and the QR shows its loading
 * animation instead (21-render-values.js).
 *
 * Twice over, a receiver typed an amount, switched to
 * CASHU, and the payer's scan read a request for nothing.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');

function method(sig) {
  const start = src.indexOf('\n  ' + sig);
  if (start < 0) throw new Error('missing ' + sig);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start + 3, i + 1);
}
const methods = new Function('return {' +
  [method('cashuRequest() {'), method('railRequest(sats, purpose, usdCents) {'),
   method('railRequestReady(sats, purpose, usdCents) {'), method('wantedSats() {'),
   method('qrDense(text) {'), method('tapOnlyRequest(sats, purpose) {')].join(',') + '}')();

const R = { pass: 0, fail: 0 };
function check(name, ok, detail) {
  if (ok) { R.pass++; console.log('  OK    ' + name + (detail ? ' — ' + detail : '')); }
  else { R.fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

/* A receive screen, with the wallet it talks to. `made` records every figure a
 * request was built for, so a request for nothing is visible even if the screen
 * never shows it. */
function screen(state, opts) {
  const o = opts || {};
  const out = { askedInbox: 0 };
  const made = [];
  let inbox = null;                       // the pending openInbox, resolved by hand
  global.window = {
    FoxyWallet: {
      mintUrl: 'https://mint.test',
      amountOf: (inv) => (inv === 'lnbc10' ? 10 : inv === 'lnbc750' ? 750 : 0),
      paymentRequest: (sats, opt) => {
        const cents = Math.round(Number(opt && opt.usd) || 0);
        made.push(cents > 0 ? '$' + cents : (Number(sats) || 0));
        return cents > 0 ? 'creq-$' + cents : 'creq-' + (Number(sats) || 0);
      },
      openInbox: () => { out.askedInbox += 1; return new Promise((ok) => { inbox = ok; }); },
    },
  };
  const app = Object.assign({
    state: Object.assign({ amount: '', unit: 'SATS', invoice: '', invoiceIsAddress: false }, state),
    px: () => o.price || 0,
    // offline + receive + a price: the amount is dollars all the way into the
    // request, and no conversion happens here (09-melt-paste-switch.js)
    dollarsOnly: () => !!o.dollarsOnly,
    // offline, railRequest asks for no onion address: there is none to be had,
    // and waiting out the bridge's timeout for it costs 25 seconds (12-receive.js)
    offlineNow: () => !!o.offline,
    setState(patch) { Object.assign(this.state, patch); },
  }, methods);
  Object.assign(out, { app, made, openInbox: (url) => { if (inbox) inbox(url || ''); inbox = null; } });
  return out;
}
const settle = () => new Promise((ok) => setTimeout(ok, 0));

/* Offline, asking to be paid, the amount typed is dollars and the request says
 * dollars. Converting it here at a price that may be hours old is the one thing
 * the price leg exists to avoid: the paying phone has a current rate, and it
 * offers the sats back for a person here to agree to (price-terms.js). */
async function dollarQr() {
  const s = screen({ amount: '5.00', unit: 'USD' }, { price: 84000, dollarsOnly: true });
  s.app.cashuRequest();                      // starts it; the address comes next
  s.openInbox('foxy.onion');
  await settle();
  check('offline, the code asks for the dollars typed',
    s.app.cashuRequest() === 'creq-$500', s.app.cashuRequest());
  check('and no sat figure was ever worked out for it',
    s.made.every((m) => typeof m === 'string'), 'built for [' + s.made.join(', ') + ']');
}

/* ---- a caller that cannot make do with '' --------------------------------
 *
 * `railRequest` answers '' for an amount it has not made a request for yet,
 * because the screen that calls it renders many times a second and simply shows
 * nothing until the code exists. A caller with one shot cannot do that.
 *
 * The receiver agreeing a bitcoin price is exactly that caller: it has to send
 * the agreed request the moment the person taps ACCEPT, and the agreed sats are
 * always an amount this screen has not made one for — it asked in dollars. It
 * read '' once and told the payer it had been refused, so ACCEPT reported a
 * rejection on both phones.
 */
/* ---- offline, the code is made at once -------------------------------------
 *
 * `openInbox` is a bridge call with a 25-second timeout and an offline phone
 * can never publish an address, so it waited out the whole 25 and then made the
 * request without one. On the receive screen that is a code shown late. In a
 * tap it is a payment that never happens: the receiver agreed a price and the
 * request it agreed to went back 25 seconds later, long after the payer's link
 * had gone.
 */
/* ---- the tap's own request is made now, not after the invoice --------------
 *
 * A Lightning invoice is the mint's to make and takes seconds over Tor. The
 * request a tap hands over needs nothing but the amount typed, and the payment
 * comes back over the link — so another Foxy at the same mint should be payable
 * the instant the phones touch ("Minibits to Minibits tap to
 * pay both online, it wasn't instant. It waited for the lighting invoice").
 */
function tapRequestIsInstant() {
  const s = screen({ amount: '1200', unit: 'SATS' });
  const req = s.app.tapOnlyRequest(s.app.wantedSats());
  check('the tap request is made synchronously, with no invoice and no address',
    req === 'creq-1200', req || '(nothing)');
  check('and it asked for no onion address at all', s.askedInbox === 0,
    s.askedInbox + ' call(s) to openInbox');
  check('asking twice makes one request, not two',
    s.app.tapOnlyRequest(1200) === req && s.made.filter((m) => m === 1200).length === 1,
    'built for [' + s.made.join(', ') + ']');
  const none = screen({ amount: '', unit: 'SATS' });
  check('and ANY AMOUNT still gets one, so the phones can talk at once',
    none.app.tapOnlyRequest(0) === 'creq-0', none.app.tapOnlyRequest(0) || '(nothing)');
}

async function offlineIsAtOnce() {
  const s = screen({ amount: '10', unit: 'SATS' }, { offline: true });
  const req = await s.app.railRequestReady(4902);
  check('offline, the request is made without asking for an address at all',
    req === 'creq-4902', req || '(nothing)');
  check('and the inbox was never asked, so nothing waited on its timeout',
    s.askedInbox === 0, s.askedInbox + ' call(s) to openInbox');
}

async function readyWaits() {
  const s = screen({ amount: '10', unit: 'SATS' });
  check('the one-shot caller gets nothing at first, exactly as the screen does',
    s.app.railRequest(4902) === '', 'railRequest');
  const waiting = s.app.railRequestReady(4902);
  check('but asking for it to be ready hands back a promise, not the nothing',
    !!(waiting && typeof waiting.then === 'function'), typeof waiting);
  s.openInbox('foxy.onion');
  const got = await waiting;
  check('which answers the request once it exists', got === 'creq-4902', got || '(nothing)');
  check('and asking again answers at once, without making a second one',
    (await s.app.railRequestReady(4902)) === 'creq-4902'
    && s.made.filter((m) => m === 4902).length === 1,
    'built for [' + s.made.join(', ') + ']');

  /* And one that truly cannot be made still answers, rather than hanging: a
   * caller waiting for ever is worse than one told no. */
  const dead = screen({ amount: '10', unit: 'SATS' });
  const never = dead.app.railRequestReady(7);
  dead.openInbox('');                       // the address never came
  check('a request that could not be made answers rather than hanging',
    typeof (await never) === 'string', 'answered');
}

/* ---- one code belongs to one request --------------------------------------
 *
 * A dense request is drawn as animated frames and the render shows whichever
 * frame the animator holds. It did not check WHOSE request that frame was for,
 * so a second request drew the previous one's frames into its image — and a
 * code assembled from two different requests never assembles. That is "it works
 * once and then the QRs do not work again". The token
 * screen has always checked this; the request screen now does too.
 */
function framesBelongToTheirRequest() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
  check('the frame drawn is checked against the request it belongs to',
    /this\._reqQr\.text === creq && this\._reqQr\.src/.test(src),
    'renderValsBase, 21-render-values.js');
  check('and the token screen still checks the same thing',
    /this\._tokQr\.token === tk && this\._tokQr\.src/.test(src),
    'tokenOutQr, 24-render-receive-and-send.js');

  /* And the density question is asked once per request, not once per render:
   * answering it encodes the whole code, and the render asks several times a
   * second on the phone least able to afford it. */
  const s = screen({ amount: '10', unit: 'SATS' });
  let asked = 0;
  global.window.FoxyWallet.qrTooDense = (t) => { asked += 1; return String(t).length > 100; };
  const long = 'creq' + 'A'.repeat(500);
  s.app.qrDense(long); s.app.qrDense(long); s.app.qrDense(long);
  check('the density of one request is worked out once, however often it is asked',
    asked === 1, asked + ' encode(s) for three asks');
  s.app.qrDense('creqB');
  check('and a different request is asked about on its own', asked === 2, asked + ' encodes');
}

(async () => {
  tapRequestIsInstant();
  await dollarQr();
  framesBelongToTheirRequest();
  await offlineIsAtOnce();
  await readyWaits();
  // ---- a figure typed in sats ------------------------------------------
  {
    const s = screen({ amount: '10', unit: 'SATS' });
    check('a figure typed in sats: nothing on the QR until the inbox opens',
      s.app.cashuRequest() === '', 'loading');
    s.openInbox('foxy.onion');
    await settle();
    check('and then a request for that figure',
      s.app.cashuRequest() === 'creq-10', s.app.cashuRequest());
    check('and no request was ever built for nothing',
      s.made.indexOf(0) < 0, 'built for [' + s.made.join(', ') + ']');
  }

  // ---- a figure typed in dollars, before the price lands ----------------
  {
    const s = screen({ amount: '1', unit: 'USD' }, { price: 0 });
    check('$1 with no price yet: the QR waits', s.app.cashuRequest() === '', 'loading');
    s.openInbox('foxy.onion');
    await settle();
    check('it still waits — a dollar is not 0 sats', s.app.cashuRequest() === '', 'loading');
    check('and nothing was built for nothing', s.made.indexOf(0) < 0,
      'built for [' + s.made.join(', ') + ']');
  }

  // ---- the same screen once the price arrives ---------------------------
  {
    const s = screen({ amount: '1', unit: 'USD' }, { price: 100000 });
    s.app.cashuRequest();
    s.openInbox('foxy.onion');
    await settle();
    check('with a price, the request carries the converted figure',
      s.app.cashuRequest() === 'creq-1000', s.app.cashuRequest());
  }

  // ---- reopened from history: only the invoice says the figure ----------
  {
    const s = screen({ amount: '', unit: 'SATS', invoice: 'lnbc750' });
    s.app.cashuRequest();
    s.openInbox('foxy.onion');
    await settle();
    check('reopened from history, the figure comes off the invoice',
      s.app.cashuRequest() === 'creq-750', s.app.cashuRequest());
  }

  // ---- asking for anything is still allowed -----------------------------
  {
    const s = screen({ amount: '', unit: 'SATS' });
    s.app.cashuRequest();
    s.openInbox('foxy.onion');
    await settle();
    check('someone who typed nothing gets the amountless request they meant',
      s.app.cashuRequest() === 'creq-0', s.app.cashuRequest());
  }

  // ---- the QR does not churn -------------------------------------------
  {
    const s = screen({ amount: '1', unit: 'USD' }, { price: 0 });
    for (let i = 0; i < 40; i++) { s.app.cashuRequest(); s.openInbox('foxy.onion'); await settle(); }
    check('a screen that cannot make one yet does not open an inbox each render',
      s.made.length === 0, s.made.length + ' requests built over 40 renders');
  }

  /* The quiet zone: four modules, which is what the spec asks for and what a
 * reader uses to find the code's edge. It was two, and a phone would not
 * read a code that copy-and-paste took fine. */
{
  const { loadReal } = require('./harness');
  // the harness loads bip39 and cashu-ts; the QR builder needs qrcode.js too
  const W = loadReal({ before: (w) => {
    const el = w.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(__dirname, '..', 'Web', 'qrcode.js'), 'utf8');
    w.document.body.appendChild(el);
  } }).W;
  const svg = decodeURIComponent(String(W.qr('cashuBtest')).replace(/^data:image\/svg\+xml;utf8,/, ''));
  const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  const first = /M(\d+) (\d+)h1v1h-1z/.exec(svg);
  check('the code has a quiet zone of four modules on every side',
    !!first && Number(first[1]) >= 4 && Number(first[2]) >= 4,
    first ? 'first dark module at ' + first[1] + ',' + first[2] : 'no modules');
  const modules = Number(box && box[1]);
  check('and the viewBox counts it in', modules > 8, String(modules));
  const tight = decodeURIComponent(String(W.qr('cashuBtest', { quiet: 0 }))
    .replace(/^data:image\/svg\+xml;utf8,/, ''));
  const tightBox = /viewBox="0 0 (\d+)/.exec(tight);
  check('a caller may still ask for none',
    !!tightBox && Number(tightBox[1]) === modules - 8,
    'the default is not forced on anybody: ' + (tightBox ? tightBox[1] : '?') + ' vs ' + modules);
}

/* How fine the code is, which is what a camera has to resolve. Measured in
 * modules, because that is the number the box size divides into: the receive
 * screen on an iPhone XS is about 240 points across, so 93 modules is 2.6
 * points each and 65 is 3.7, and most phone cameras want about three.
 *
 * This is the difference between a request carrying an onion address and a
 * Nostr profile (461 characters, 93 modules) and a token beside it (209, 65) —
 * one scanned and the other did not. */
{
  const { loadReal } = require('./harness');
  const W = loadReal({ before: (w) => {
    const el = w.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(__dirname, '..', 'Web', 'qrcode.js'), 'utf8');
    w.document.body.appendChild(el);
  } }).W;
  const modulesOf = (t) => {
    const svg = decodeURIComponent(String(W.qr(t)).replace(/^data:image\/svg\+xml;utf8,/, ''));
    const m = /viewBox="0 0 (\d+)/.exec(svg);
    return m ? Number(m[1]) : 0;
  };
  check('a short code is not called too dense', !W.qrTooDense('cashuB' + 'a'.repeat(200)),
    String(modulesOf('cashuB' + 'a'.repeat(200))) + ' modules');
  check('and a long one is', W.qrTooDense('cashuB' + 'a'.repeat(460)),
    String(modulesOf('cashuB' + 'a'.repeat(460))) + ' modules');
  check('the line is drawn in modules, not characters',
    /modules > 80/.test(fs.readFileSync(path.join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8')),
    'characters are not what a camera resolves');
  check('and something that will not fit in one code at all counts as too dense',
    W.qrTooDense('x'.repeat(5000)));
}

console.log('\n' + (R.fail ? R.pass + ' passed, ' + R.fail + ' failed' : 'all ' + R.pass + ' receive QR checks pass'));
  process.exit(R.fail ? 1 : 0);
})();
