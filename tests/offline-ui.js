'use strict';
/* offline-ui.js — what the screens offer when the person chose to work offline.
 *
 *     node tests/offline-ui.js
 *
 * Working offline is a state somebody picked and stays in, not a blip. Most of
 * Foxy cannot work in it: a Lightning invoice is the mint's to make, an on-chain
 * address is the mint's to give, a Lightning address has to be resolved and then
 * paid. What can work is Cashu — a request this phone writes itself, answered by
 * pieces already held.
 *
 * So the screens have to say which is which. Greyed rather than hidden, because a
 * control that vanishes leaves somebody hunting for a feature they used
 * yesterday, and every greyed control says why when tapped, because one that
 * looks dead and does nothing reads as a bug.
 *
 * The one that matters most is the receive screen: it asked for an invoice
 * whatever the rail, so opening RECEIVE while offline would spend the three tries
 * and put the person back where they came from with an error.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'build', 'foxy-app.js'), 'utf8');
const markup = fs.readFileSync(path.join(root, 'build', 'markup.html'), 'utf8');
const wallet = fs.readFileSync(path.join(root, 'Web', 'foxy-wallet.js'), 'utf8');
const gate = fs.readFileSync(path.join(root, 'Web', 'foxy-tor-gate.js'), 'utf8');

const R = { pass: 0, fail: 0 };
function check(name, ok, detail) {
  if (ok) { R.pass++; console.log('  OK    ' + name + (detail ? ' — ' + detail : '')); }
  else { R.fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
function body(src, sig, label) {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + (label || sig));
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at + 3, i + 1);
}

/* 1 — the predicate, run for real ------------------------------------------ */

const probe = new Function('return {' + body(app, 'offlineNow() {', 'offlineNow') + '}')();
const at = (privacy) => {
  global.window = { FoxyWallet: privacy === null ? null : { privacy: () => privacy } };
  return probe.offlineNow();
};
check('the choice is read from the route', at({ tor: 'connecting', offline: true }) === true);
check('merely connecting is not offline', at({ tor: 'connecting', offline: false }) === false,
  'the gate is up saying so; nothing should be greyed on a screen they cannot see');
check('Tor up is not offline', at({ tor: 'up', offline: false }) === false);
check('no wallet yet does not throw', at(null) === false);
/* Never remembered: `_privacy` surrenders the choice the moment Tor is up, and a
 * screen that cached this would go on grey­ing out controls that work again. */
check('nothing is cached between reads',
  at({ tor: 'connecting', offline: true }) === true && at({ tor: 'up', offline: false }) === false);

/* 2 — the receive screen: one network, and no invoice ----------------------- */

const recv = body(app, 'openReceiveNow() {', 'openReceiveNow');
check('offline forces the Cashu rail', /offlineNow\(\)\)\s*rail\s*=\s*'CASHU'/.test(recv));
/* The early return is the whole point: everything after it asks the mint for an
 * invoice. A gate that only set the rail would still bounce the person out. */
const guard = /if\s*\(this\.offlineNow\(\)\)\s*\{[\s\S]{0,400}?return;\s*\}/.test(recv);
check('and returns before an invoice is ever asked for', guard);
const retAt = recv.search(/if\s*\(this\.offlineNow\(\)\)\s*\{[\s\S]{0,400}?return;\s*\}/);
const askAt = recv.indexOf('W.invoice(');
check('the return really is above the ask', retAt >= 0 && askAt >= 0 && retAt < askAt,
  'offline: ' + retAt + ', invoice: ' + askAt);

const rend = body(app, 'renderReceive(c) {', 'renderReceive');
check('the network chooser refuses offline and says why',
  /pickNetwork[\s\S]{0,200}?offlineNow\(\)[\s\S]{0,120}?offlineNo\(/.test(rend));
check('and the pill is dimmed with it', /networkPillDim/.test(rend) && /networkPillDim/.test(markup));

/* 3 — the send screen: two of four go grey --------------------------------- */

const send = body(app, 'renderSend(c) {', 'renderSend');
check('typing an address refuses offline',
  /pickType[\s\S]{0,200}?offlineNow[\s\S]{0,140}?offlineNo\(/.test(send)
  || /if\s*\(off\)\s*\{\s*this\.offlineNo\(/.test(send));
check('TYPE and CONTACTS are dimmed', /clTypeDim/.test(send) && /clContactsDim/.test(send));
check('and the markup actually applies both opacities',
  /opacity:\{\{ clTypeDim \}\}/.test(markup) && /opacity:\{\{ clContactsDim \}\}/.test(markup));
/* SCAN and PASTE stay live: both can carry a Cashu payment request, which a
 * phone with the right pieces can answer without asking the mint anything. */
check('SCAN and PASTE are left alone', !/clPasteDim/.test(send) && !/clScanDim/.test(send),
  'a request paid from pieces already held needs no route');

const contacts = /goContacts[\s\S]{0,260}?offlineNow\(\)[\s\S]{0,140}?offlineNo\(/.test(app);
check('paying a contact refuses offline', contacts);

/* 4 — no price must not become no spending -------------------------------- */

/* The trap: `satUsd()` is null with no price, so `renderContext`'s cap becomes
 * zero and every typed dollar figure reads as more than the balance, while
 * `amountInSats` cannot convert it either. A keypad left in USD is one that
 * cannot send at all — permanent while offline, which is precisely when an
 * offline payer needs to spend the pieces they already hold. */
const unit = body(app, 'syncUnit() {', 'syncUnit');
check('a keypad in dollars with no price goes back to sats',
  /unit\s*!==\s*'USD'/.test(unit) && /satUsd\(\)/.test(unit) && /unit:\s*'SATS'/.test(unit));
check('and does nothing at all while there is a price',
  /if\s*\(this\.satUsd\(\)\)\s*return;/.test(unit));
check('it runs on every update, not once', /this\.syncUnit\(\)/.test(app));

/* And the NO BITCOIN PRICE card's TRY AGAIN calls refreshBalance, which cannot
 * succeed without a route — so offline it is a loop with no exit but NOT NOW,
 * sitting over somebody who chose this and can read the banner. */
const card = body(app, 'showPriceError() {', 'showPriceError');
check('the price card stays away while offline', /offlineNow\(\)\)\s*return;/.test(card));

/* 5 — a stale price says how stale ----------------------------------------- */

/* `livePrice` is never cleared, so a price that stopped refreshing goes on being
 * shown — and dollar figures go on being computed from it — with nothing to say
 * how old it is. Offline that can be hours. The age is the fix, and it goes in
 * the one label the collapsed pill and the open chart share. */
const PRICE_STANDS_MS = 3 * 60 * 1000;
const ago = new Function('PRICE_STANDS_MS', 'return {' + body(app, 'priceAgo() {', 'priceAgo') + '}')(PRICE_STANDS_MS);
const now = Date.now();
const aged = (agoMs, live) => {
  global.window = { FoxyWallet: { _rateAt: agoMs === null ? 0 : now - agoMs } };
  ago.state = { livePrice: live === undefined ? 84000 : live };
  return ago.priceAgo();
};
const ageCases = [
  [0, '', 'a price fetched just now says nothing'],
  [60 * 1000, '', 'a minute old is still current'],
  [2.9 * 60 * 1000, '', 'under three minutes is the window the app already calls current'],
  [4 * 60 * 1000, '4M AGO', 'four minutes says so'],
  [59 * 60 * 1000, '59M AGO', 'minutes, up to an hour'],
  [90 * 60 * 1000, '1H AGO', 'then hours'],
  [23 * 3600 * 1000, '23H AGO', 'hours, up to a day'],
  [50 * 3600 * 1000, '2D AGO', 'then days'],
  [null, '', 'no stamp says nothing rather than guessing'],
];
let ageOk = 0;
for (const [ms, want, why] of ageCases) {
  if (aged(ms) === want) ageOk++; else check(why, false, 'got ' + JSON.stringify(aged(ms)));
}
check('the price says how old it is, coarsely', ageOk === ageCases.length,
  ageOk + '/' + ageCases.length + ' ages');
check('and with no price there is no age to claim', aged(50 * 3600 * 1000, null) === '');
/* The label must actually incorporate the age — `priceLabel` merely existing
 * proved nothing, and a version that dropped priceAgo() passed this once. */
/* On its own line under the price, in red. */
check('the age line is built from the age, not just named',
  /priceAge: this\.priceAgeWords\(\)/.test(app)
  && /priceAgeWords\(\) \{[\s\S]{0,120}?priceAgo\(\)/.test(app));
check('and the age is red, under the price, in both the pill and the chart',
  (markup.match(/color:var\(--bad\)[^>]*>\{\{ priceAge \}\}/g) || []).length === 2);
check('and both the pill and the chart use it',
  (markup.match(/\{\{ priceLabel \}\}/g) || []).length === 2,
  'collapsed and expanded share one label');

/* A dated price may be read, and it may name what somebody is owed. It may not
 * decide how much money leaves: a rate hours old converting a typed dollar
 * amount into sats is a real mis-send, and sats need no rate at all.
 *
 * Asking to be paid is the other direction — the person naming the amount is
 * the one carrying the stale price — so that one is allowed and warned about
 * instead of taken away. */
check('offline a SEND keypad is put back into sats',
  /offlineNow\(\) && this\.state\.flow !== 'receive'\)[\s\S]{0,200}?unit:\s*'SATS'/.test(unit));
check('and a RECEIVE keypad is left in dollars',
  /flow !== 'receive'/.test(unit),
  'the person asking is the one who carries a stale price');
check('the warning says what it is based on and how old that is',
  /WARNING: This is based on the price of Bitcoin '\s*\+/.test(app));
check('and only offline, in dollars, with a price to convert at',
  /: \(this\.offlineNow\(\) && s\.unit === 'USD' && this\.satUsd\(\)\)\s*\? 'WARNING: This is based on the price of Bitcoin '/.test(app));
check('the markup draws it',
  /\{\{ priceWarn \}\}/.test(markup) && /\{\{ priceWarnShown \}\}/.test(markup),
  'a warning nothing reads is a warning nobody sees');

/* The price itself has to survive being killed, or none of the above has
 * anything to work with: it lived in two variables and died with the app, and a
 * relaunch in airplane mode came up with no price at all twenty-two seconds
 * after being told one. */
check('a price that arrives is written down, not just held',
  /save\(K\.rate, \{ rate: n, at: FoxyWallet\._rateAt \}\)/.test(wallet));
check('and read back at load',
  /lastPriceBack[\s\S]{0,600}?FoxyWallet\._rateAt = at;/.test(wallet));
check('a stored price outside the sane band is ignored',
  /lastPriceBack[\s\S]{0,400}?n < 5000 \|\| n > 1000000/.test(wallet),
  'a wrong price is worse than none');
check('offline, the last price stands however old it is',
  /age < PRICE_STANDS_MS \|\| this\.offlineNow\(\)/.test(app),
  'three minutes is the window for a fetch that will succeed in a moment');

/* 6 — the way back is in the banner ---------------------------------------- */

check('the banner tap leaves offline rather than explaining Tor',
  /torBannerOffline[\s\S]{0,200}?leaveOffline/.test(app),
  'TAP TO RETRY has to do what it says');

/* 7 — the mint list, offline ------------------------------------------------
 *
 * A wallet with no route is rebuilt from the keysets a mint gave this phone
 * earlier, so the mints that can be switched to are exactly the ones on file.
 * The rest are greyed, say why under their name, and say it again when tapped —
 * a person could not select a mint at all before this. */
const mintUi = new Function('return {' + body(app, 'mintReachable(url) {', 'mintReachable')
  + ',' + body(app, 'mintDownText(url) {', 'mintDownText')
  + ',' + body(app, 'mintQuietSince(t, now) {', 'mintQuietSince')
  + ',' + body(app, 'offlineNow() {', 'offlineNow') + '}')();
const asPhone = (offline, cached) => {
  global.window = { FoxyWallet: {
    privacy: () => ({ tor: offline ? 'connecting' : 'up', offline: offline }),
    mintCached: (u) => cached.indexOf(String(u)) >= 0,
    mintDown: () => null,
  } };
};

asPhone(true, ['https://m.test']);
check('offline, a mint whose keysets are on file can be switched to',
  mintUi.mintReachable('https://m.test') === true);
check('and one whose are not cannot',
  mintUi.mintReachable('https://other.test') === false);
check('the row says why, under the name',
  mintUi.mintDownText('https://other.test') === 'needs a connection',
  JSON.stringify(mintUi.mintDownText('https://other.test')));
check('and the usable one says nothing',
  mintUi.mintDownText('https://m.test') === '');

asPhone(false, []);
check('with a route every mint is reachable, cache or no cache',
  mintUi.mintReachable('https://other.test') === true);
check('and nothing is labelled', mintUi.mintDownText('https://other.test') === '');

check('the row is dimmed by what the render decided, not by a guess',
  /dim: reach \? '1' : '0.4'/.test(app));
check('and the markup really binds it',
  /opacity:\{\{ m\.dim \}\}/.test(markup),
  'a computed dim nothing reads is a dim nobody sees');
check('a tap on a greyed mint says why rather than doing nothing',
  /!reach \? \(\(\) => this\.offlineNo\(/.test(app));

/* 8 — money that is out there and can still be taken away ------------------
 *
 * Every other thing the history ring turns for is money in Foxy's own hands
 * that needs time: a broadcast, a redeem, a bill being collected. Nobody can
 * take those away. A payment accepted while both phones were offline is the one
 * kind somebody else can still make disappear, and it is counted in the balance
 * while they can — so it rings red and the row says what it is, rather than
 * sitting in a list reading "Pending". */
check('the history ring turns red for a payment that can still be taken back',
  /const atRisk = someOf\(W21 && W21\.trustedWaiting\)/.test(app));
check('and red beats amber, so one glance tells them apart',
  /histRingInk = \(atRisk \|\| short \|\| changeTodo\) \? RISK_RED : waiting \? AMBER/.test(app));
check('and it turns at all',
  /histRing = \(atRisk \|\| waiting \|\| short \|\| changeTodo\) \? 'foxyRing/.test(app));

check('the row says AT RISK rather than Pending',
  /t\.failed \? 'Failed' : t\.atRisk \? 'AT RISK/.test(app));
check('in the colour of something wrong, not of something slow',
  /metaColor: \(t\.failed \|\| t\.atRisk \|\| A\.flagged\.has\(t\)\) \? 'var\(--bad\)'/.test(app));
check('and the tile matches it',
  /tileBg: \(t\.failed \|\| t\.atRisk \|\| A\.flagged\.has\(t\)\) \? 'var\(--bad\)'/.test(app));
check('a row is at risk only while it is still waiting',
  /atRisk: !!t\.trusted && !t\.settled && t\.state !== 'failed'/.test(app),
  'the claim settles the same entry, and settled money is ordinary money');

check('the detail screen says AT RISK where it would say PENDING',
  /txStatus: tx\.highRisk \? 'HIGH RISK' : tx\.atRisk \? 'AT RISK' : tx\.failed \? 'FAILED' : tx\.pending \? 'PENDING' : 'COMPLETE'/.test(app));
check('and explains what that means, in the person\u2019s words',
  /txAtRiskLine[\s\S]{0,240}?spend their copy and take it back/.test(app));
check('and the markup really draws that explanation',
  /\{\{ txAtRiskLine \}\}/.test(markup) && /\{\{ txStatusInk \}\}/.test(markup),
  'a line nothing reads is a line nobody sees');

/* 9 — the four gates that have to agree about one question ------------------
 *
 * "Can this phone reach anything." Tor's `up` is a circuit Foxy built and it
 * outlives the interface by up to its whole deadline; the path monitor is the
 * system's answer and it is current. Four places ask, and every time one of
 * them believed the older answer the app argued with itself:
 *
 *   the gate said NO CONNECTION while `setOffline` refused the choice, and the
 *   two looped until there was no way in;
 *   `routeOpen` said the route was open, so a send tried to swap instead of
 *   using pieces on hand, a payer kept a lock it could not make, and a receiver
 *   recorded the net of change it could not make;
 *   and `_privacy` threw the person's choice away on the next push.
 *
 * Only a definite 'none' counts in any of them: 'unknown', before the monitor's
 * first word, is not an accusation that the phone is off the air. */
check('the gate: no interface is no route, whatever Tor says',
  /if \(p && p\.network === 'none' && !p\.offline\) return false;/.test(gate),
  'through()');
check('the gate: and NO CONNECTION is the honest screen even unprotected',
  /return !!p && p\.network === 'none';\s*\}/.test(gate), 'noNetwork()');
check('the wallet: routeOpen agrees',
  /if \(privacy\.network === 'none'\) return false;/.test(wallet), 'routeOpen()');
check('the wallet: setOffline agrees',
  /var reallyUp = privacy\.tor === 'up' && privacy\.network !== 'none';/.test(wallet),
  'the choice sticks with the radios off');
check('the wallet: and a push does not throw the choice away',
  /offline: !!privacy\.offline[\s\S]{0,200}?String\(next\.network \|\| 'unknown'\) !== 'none'/
    .test(wallet), '_privacy');

/* 10 — a payment handed over is not the payer's to take back -----------------
 *
 * RECLAIM is a swap that takes a token's proofs back. It exists for a token
 * that was made and never handed to anybody. Offered on a payment that crossed
 * a tap it is a double spend, and the receiver is the one who cannot see it
 * coming: with no route they are holding it on trust, unswapped, exactly
 * because they agreed to that risk. One phone reclaimed one and the other
 * read `spent by the payer`. */
check('a payment that crossed a tap is marked as handed over',
  /if \(req && req\.viaTap && W\.tag\)[\s\S]{0,80}?handed: 'tap'/.test(app));
check('and the token is kept, because an unconfirmed tap may not have arrived',
  /handedByTap: meta\.handed === 'tap'/.test(app) && /txHasToken: !!txText,/.test(app),
  'showing it again hands it to the same person, which is not a double spend');
check('but it is never offered back',
  /txCanReclaim: !!tx\.token && tx\.dir !== 'in' && !tx\.handedByTap && !this\.offlineNow\(\)/.test(app),
  'RECLAIM swaps the proofs away from whoever is holding them on trust');
check('and the markup really gates the button on it',
  /<sc-if value="\{\{ txCanReclaim \}\}">/.test(markup),
  'a computed guard nothing reads guards nothing');

check('a payment still on its way is not announced as one that happened',
  /if \(tags\.inflight\) return;/.test(app),
  'the history pass announces settled entries, and a token exists before it is handed over');
check('and the mark is cleared the moment it lands or fails',
  (app.match(/W\.tag\((?:r|made)\.hash, \{ inflight: false \}\)/g) || []).length >= 3,
  'delivered, refused, and made-but-undelivered');

/* Offline, asking to be paid is in dollars and only in dollars --------------
 *
 * This phone's bitcoin price may be hours old, so it does not convert: it names
 * the amount in the money the price is named in, and the paying phone — which
 * has a current rate — says what that makes in sats and offers it back. A sats
 * figure beside the dollars here would be this phone showing a conversion it is
 * refusing to make. */
{
  const only = new Function('return {' + body(app, 'dollarsOnly() {', 'dollarsOnly') + ','
    + body(app, 'syncUnit() {', 'syncUnit') + '}')();
  const put = (o) => {
    only.state = Object.assign({ flow: 'receive', unit: 'SATS' }, o.state || {});
    only.offlineNow = () => o.offline !== false;
    only.satUsd = () => (o.price === undefined ? 84000 / 1e8 : o.price);
    only.px = () => (only.satUsd() || 0) * 1e8;
    only._set = null;
    only.setState = (u) => {
      const patch = typeof u === 'function' ? u(only.state) : u;
      only._set = patch; Object.assign(only.state, patch);
    };
    return only;
  };
  check('offline, asking to be paid is dollars only', put({}).dollarsOnly() === true);
  check('with a route it is the person\'s choice as before',
    put({ offline: false }).dollarsOnly() === false);
  check('sending offline is unchanged: sats, which need no rate',
    put({ state: { flow: 'send' } }).dollarsOnly() === false);
  check('and with no price ever seen there is nothing to type dollars against',
    put({ price: null }).dollarsOnly() === false,
    'the keypad stays in sats rather than offering a unit it cannot use');

  const forced = put({ state: { amount: '2100' } });
  forced.syncUnit();
  check('so the keypad is put into dollars rather than waiting to be switched',
    forced.state.unit === 'USD', JSON.stringify(forced.state));
  check('and the figure already typed is converted, not relabelled',
    forced.state.amount === '1.76', forced.state.amount
      + ' \u2014 2,100 sats at $84,000 is $1.76, and calling it $2,100 is eighty thousand times the money');
  const sending = put({ state: { flow: 'send', unit: 'USD' } });
  sending.syncUnit();
  check('while a send offline still goes back to sats',
    sending.state.unit === 'SATS', JSON.stringify(sending.state));

  check('the sats line under the figure is dropped with it',
    /if \(this\.dollarsOnly\(\)\) return '';/.test(app),
    'amountSub, 23-render-home-and-amount.js');
  check('and the swap control is hidden rather than left to be pressed',
    /swapVis: this\.dollarsOnly\(\) \? 'hidden' : 'visible'/.test(app)
    && /visibility:\{\{ swapVis \}\};pointer-events:\{\{ swapPE \}\}[^>]*toggleUnit|toggleUnit[^>]*visibility:\{\{ swapVis \}\}/.test(markup),
    'hidden, not removed: taking it out of the flow moves the keypad mid-entry');
  check('and pressing it anyway says why rather than doing nothing',
    /if \(this\.dollarsOnly\(\)\) \{\s*this\.toast\('Offline, Foxy asks in dollars/.test(app),
    'toggleUnit');
  check('the request that goes out names the dollars, not a conversion',
    /if \(this\.dollarsOnly\(\)\) \{\s*const cents = Math\.round\(\(parseFloat\(s\.amount\)/.test(app),
    'cashuRequest');
}

/* ---- a code too dense to read is animated, and one that is not is not -------
 *
 * `qrTooDense` measured this and nothing acted on it. A request
 * carrying both an onion address and a Nostr profile is 93 modules, which is
 * 2.6 points each in the box an iPhone XS gives it; phone cameras want about three,
 * and more at an angle or in poor light. So the code was drawn, and it could
 * not be scanned, and the same code read fine on the bigger phone. The measurement now drives the same animated frames the token
 * screen has always used.
 */
function densityDrives() {
  /* The measurement itself has no harness here — `qr()` needs `window.qrcode`,
   * which this source-level test does not load — so what is held is the wiring:
   * that the screen asks the measurement rather than guessing, and draws the
   * frames the token screen already draws. */
  check('the receive screen animates on that measurement, not on a guess',
    /const animate = !!\(text && this\.qrDense\(text\)\)/.test(app)
    && /qrDense\(text\) \{[\s\S]{0,400}W\.qrTooDense\(t\)/.test(app),
    'syncReqQr asks qrDense, which asks qrTooDense once per request');
  check('and the frames it draws are the ones the token screen already uses',
    /syncReqQr\(\)[\s\S]{0,1600}W\.animatedQr\(text, this\.REQ_QR\.fragment\)/.test(app),
    'the same UR frames cashu.me and Foxy both read');
  check('the image it writes into is on the receive screen',
    /data-req-qr="1"/.test(markup), 'markup.html');
  check('and the driver runs on every update, as the token one does',
    /this\.syncTokenQr\(\);[\s\S]{0,200}this\.syncReqQr\(\);/.test(app),
    '19-update-keypad-balance.js');
}

densityDrives();

/* ---- an invoice of your own does not refuse somebody else's payment --------
 *
 * `refuseSwitchWhileBusy` counts a watched invoice as busy, and rightly for a
 * mint switch the PERSON asked for: the live watch claims at whichever mint is
 * connected. But a cross-mint payment reached for the same guard and refused
 * the payment — "Wait for the payment to finish before switching mints", about
 * an invoice of the payer's own that had nothing to do with it.
 *
 * The watch is stopped instead. Nothing is lost: the quote is written down with
 * the mint that issued it, and the sweep claims it there on the next connect.
 */
{
  const src2 = app;
  check('a crossing asks whether money is moving, not whether a screen is busy',
    /tapCrossMint[\s\S]{0,2600}if \(this\.moneyMoving\(\)\) \{/.test(src2),
    '26d-tap.js');
  check('and a watched invoice is stopped rather than used to refuse the payment',
    /tapCrossMint[\s\S]{0,3000}if \(this\._watching\) \{[\s\S]{0,260}this\.stopReceive\(\);/.test(src2),
    'the sweep claims it at the mint that issued it');
  check('the quote is written down with its own mint, which is what makes that safe',
    /mint: mintOf\(w\),/.test(wallet),
    '15-receiving.js');
  check('money genuinely in flight still stops it',
    /moneyMoving\(\) \{[\s\S]{0,320}proofLockDepth\(\) > 0[\s\S]{0,120}_sendRun/.test(src2),
    'a swap or a melt holding the proof lock');
}

console.log('\n' + (R.fail ? 'FAILED ' + R.fail : 'PASSED ' + R.pass) + ' of ' + (R.pass + R.fail));
process.exit(R.fail ? 1 : 0);
