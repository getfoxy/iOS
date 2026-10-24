'use strict';
/* deep-links.js — what a link from outside Foxy is allowed to do.
 *
 *     node tests/deep-links.js
 *
 * `applyDeepLink` from build/app/05-device-shell.js, in jsdom, against a stub of
 * the app class. The page has always taken `#foxy=receive|send|home|nfc` from
 * the Swift shell; a Debug build now also registers a `foxy://` URL scheme and
 * turns `foxy://receive?amt=50&unit=sat&rail=cashu` into that hash with its
 * parameters (WebHostController.receiveDeepLink), so putting a simulator on a
 * screen with an amount on it is one command instead of a dozen taps.
 *
 * Three things matter here and each has its own group below:
 *
 *   - every target lands on the screen it names, and nothing else does;
 *   - the parameters are applied in the app's own terms — `amount`/`unit` as the
 *     keypad holds them, the rail as the NETWORK sheet names it;
 *   - RUBBISH IS DROPPED, NOT OBEYED AND NOT THROWN. A bad value, an unknown key
 *     and a missing one are the same thing: absent. A hash with no `foxy=` in it
 *     applies nothing at all.
 *
 * And the gate: the parameters are read only where `window.FOXY_DEBUG` is set,
 * which the shell injects inside `#if DEBUG` and nowhere else. A Release build
 * registers no scheme; handed one of these hashes anyway, it opens the bare
 * screen and ignores every parameter. The group after the Swift is that build.
 *
 * One link IS taken in every build: a card held to the phone raises
 * `https://getfoxy.io/card`, and iOS opens Foxy with it when the person taps the
 * banner. The phone checks the address and tells the page one thing, that a card
 * was tapped (Foxy/Flashcard/CardAddress.swift, CardTapDelivery.swift; their rules
 * are FoxyTests'). The last groups are what can only be seen across the two
 * languages, and the page's side of it: `cardTapRule` says act, keep or ignore
 * for what is on screen, a request that is kept waits a minute and no more, and a
 * second one is the same tap. Nothing of the address reaches the page. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const ok = (c, msg, detail) => {
  console.log((c ? 'ok   ' : 'FAIL ') + msg + (!c && detail ? ' — ' + detail : ''));
  if (!c) failures++;
};

/* The part, not the joined file: these tests are about the source that is
 * edited and reviewed, and they pass whether or not the join has been run. */
const src = fs.readFileSync(path.join(ROOT, 'build', 'app', '05-device-shell.js'), 'utf8');
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
const { applyDeepLink } = new Function('return {' + method('applyDeepLink() {') + '}')();

const dom = new JSDOM('<body></body>');
global.document = dom.window.document;

/* One link, on a fresh app. `debug` false is a Release build: the shell never
 * sets window.FOXY_DEBUG there. `rail` is what the wallet's stored default
 * already is, since a receive opens on that. */
function link(hash, opts) {
  opts = opts || {};
  let stored = opts.rail || 'LIGHTNING';
  const wallet = {
    defaultRail: function (r) {
      if (r === undefined) return stored;
      stored = (r === 'CASHU' || r === 'ON-CHAIN') ? r : 'LIGHTNING';
      return stored;
    },
  };
  const state = { screen: 'home', stack: ['a', 'b'] };
  let cleared = 0;
  global.window = { FoxyWallet: wallet, document: global.document };
  if (opts.debug !== false) global.window.FOXY_DEBUG = true;
  global.location = { hash: hash, pathname: '/index.html', search: '' };
  global.history = { replaceState: function () { cleared++; global.location.hash = ''; } };
  const app = {
    state: state,
    setState: function (p) { Object.assign(state, typeof p === 'function' ? p(state) : p); },
    applyDeepLink: applyDeepLink,
  };
  const took = app.applyDeepLink();
  return { took: took, s: state, cleared: cleared, rail: stored };
}

// ---- every target, and only these ------------------------------------------

{
  const t = link('#foxy=home');
  ok(t.took === true && t.s.screen === 'home', 'home: the home screen');
  ok(Array.isArray(t.s.stack) && t.s.stack.length === 0, 'home: the back stack is emptied');
  ok(t.cleared === 1, 'a link that was acted on clears the hash behind it');
}
{
  const t = link('#foxy=send');
  ok(t.took === true && t.s.screen === 'sendHow' && t.s.flow === 'send', 'send: the ways to pay');
}
{
  const t = link('#foxy=nfc');
  /* There is no tap screen any more: the payer listens from home and from
   * SEND, so a link that meant "get ready to tap" lands on home, where it
   * already is. */
  ok(t.took === true && t.s.screen === 'home', 'nfc: home, which is already listening');
}
{
  const t = link('#foxy=receive');
  ok(t.took === true && t.s.screen === 'amount' && t.s.flow === 'receive', 'receive: the amount keypad');
  ok(t.s.amount === '' && t.s.unit === 'USD', 'receive: no amount named, no amount typed');
  ok(t.s.recipient === '' && t.s.recipientKind === '',
    'receive: a recipient left over from sending is cleared');
}
{
  const t = link('#foxy=token');
  ok(t.took === true && t.s.screen === 'amount' && t.s.flow === 'send' && t.s.tokenMode === true,
    'token: the amount keypad, making ecash');
  ok(t.s.unit === 'USD', 'token: dollars, as that screen opens');
}
{
  const t = link('#foxy=split');
  ok(t.took === true && t.s.screen === 'spAmount', 'split: the bill keypad');
  ok(t.s.spAmt === '0' && t.s.spWays === 4 && t.s.spShares === null,
    'split: a fresh split, not the last one');
}
{
  const t = link('#foxy=settings');
  ok(t.took === false && t.s.screen === 'home' && t.cleared === 0,
    'a screen that is not on the list is not a screen: nothing applied, hash left alone');
}

// ---- nothing happens without the foxy= marker ------------------------------

['', '#', '#amt=50&unit=sat', '#rail=cashu', '#receive', '#foxy', '#foxyreceive',
 '#notfoxy=receive', '#f=receive'].forEach(h => {
  const t = link(h);
  ok(t.took === false && t.s.screen === 'home' && t.s.stack.length === 2 && t.cleared === 0,
    'no foxy= marker, nothing applied: ' + JSON.stringify(h));
});
{
  // the marker has to be a key, not a fragment of one
  const t = link('#xfoxy=receive');
  ok(t.took === false && t.s.screen === 'home', 'foxy= inside another key is not the marker');
}

// ---- the parameters, in the app's own terms --------------------------------

{
  const t = link('#foxy=receive&amt=50&unit=sat');
  ok(t.s.amount === '50' && t.s.unit === 'SATS', 'receive: amt and unit=sat reach the keypad');
}
{
  const t = link('#foxy=receive&amt=50&unit=sats');
  ok(t.s.unit === 'SATS', 'unit=sats is the same as unit=sat');
}
{
  const t = link('#foxy=receive&amt=5.25&unit=usd');
  ok(t.s.amount === '5.25' && t.s.unit === 'USD', 'receive: dollars and cents');
}
{
  const t = link('#foxy=receive&amt=007');
  ok(t.s.amount === '7', 'a padded figure is the figure the keypad would hold');
}
{
  const t = link('#foxy=RECEIVE&AMT=50&UNIT=SAT');
  ok(t.s.screen === 'amount' && t.s.amount === '50' && t.s.unit === 'SATS',
    'the target and the keys are read whatever their case');
}
{
  const t = link('#foxy=receive&rail=cashu');
  ok(t.s.recvRail === 'CASHU', 'receive: rail=cashu sets the screen network');
  ok(t.rail === 'CASHU',
    'receive: and the stored default, which is what NEXT reads (openReceiveNow)');
}
{
  const t = link('#foxy=receive&rail=onchain');
  ok(t.s.recvRail === 'ON-CHAIN' && t.rail === 'ON-CHAIN', 'receive: onchain is ON-CHAIN');
}
{
  const t = link('#foxy=receive&rail=on-chain');
  ok(t.s.recvRail === 'ON-CHAIN', 'the hyphen in ON-CHAIN is optional');
}
{
  const t = link('#foxy=receive', { rail: 'CASHU' });
  ok(t.s.recvRail === undefined && t.rail === 'CASHU',
    'no rail named: the stored default is left exactly as it was');
}
{
  const t = link('#foxy=token&amt=210&unit=sat');
  ok(t.s.amount === '210' && t.s.unit === 'SATS', 'token: an amount in sats');
}
{
  const t = link('#foxy=token&amt=1.50&unit=usd');
  ok(t.s.amount === '1.50' && t.s.unit === 'USD', 'token: or in dollars, when asked for');
}
{
  const t = link('#foxy=split&amt=200');
  ok(t.s.spAmt === '200', 'split: amt is what the keypad counts in, cents — 200 is $2.00');
}
{
  const t = link('#foxy=split&rail=cashu');
  ok(t.s.spRail === 'CASHU', 'split: rail=cashu collects in ecash');
}
{
  const t = link('#foxy=split&rail=onchain');
  ok(t.s.spRail === 'LIGHTNING',
    'split: on chain is not a way to collect a share, so it is not one here');
}
{
  const t = link('#foxy=split', { rail: 'CASHU' });
  ok(t.s.spRail === 'CASHU', 'split: with no rail named it starts on the stored default');
}

// ---- rubbish is dropped, not obeyed and not thrown -------------------------

['abc', '-5', '', '0', '0.00', '5.555', '1234567890', '1e3', '5,25', '5.', '.5', ' ',
 '50%20', 'NaN', 'Infinity', '0x20', '<script>'].forEach(v => {
  let t;
  try { t = link('#foxy=receive&amt=' + encodeURIComponent(v)); }
  catch (e) { ok(false, 'amt=' + JSON.stringify(v) + ' threw', e.message); return; }
  ok(t.took === true && t.s.screen === 'amount' && t.s.amount === '',
    'rubbish amount dropped, screen still opens: amt=' + JSON.stringify(v),
    'amount ' + JSON.stringify(t.s.amount));
});
{
  const t = link('#foxy=receive&amt=5.25&unit=sat');
  ok(t.s.unit === 'SATS' && t.s.amount === '',
    'a fraction of a sat is not an amount the keypad can hold: dropped');
}
['btc', 'eur', 'satoshi', 'SAT S', '', '1'].forEach(v => {
  const t = link('#foxy=receive&unit=' + encodeURIComponent(v));
  ok(t.s.unit === 'USD', 'unknown unit falls back to the screen default: unit=' + JSON.stringify(v));
});
['telepathy', 'liquid', 'lightning-network', '', 'onchain ', 'CASH'].forEach(v => {
  const t = link('#foxy=receive&rail=' + encodeURIComponent(v));
  const named = v.trim().toLowerCase() === 'onchain';
  ok(named ? t.s.recvRail === 'ON-CHAIN' : (t.s.recvRail === undefined && t.rail === 'LIGHTNING'),
    'unknown rail changes nothing: rail=' + JSON.stringify(v));
});
{
  const t = link('#foxy=receive&zzz=1&screen=sendConfirm&amount=99999&recipient=me&amt=50');
  ok(t.s.screen === 'amount' && t.s.amount === '50' && t.s.recipient === '',
    'a key that is not amt, unit or rail cannot reach the state');
}
{
  const t = link('#foxy=split&amt=abc');
  ok(t.took === true && t.s.spAmt === '0', 'split: a rubbish amount is no amount');
}
{
  const t = link('#foxy=split&amt=2.50');
  ok(t.s.spAmt === '0', 'split: its keypad has no decimal point, so a decimal is dropped');
}

// ---- a Release build: no scheme, and no parameters either -------------------

{
  const t = link('#foxy=receive&amt=50&unit=sat&rail=cashu', { debug: false });
  ok(t.took === true && t.s.screen === 'amount' && t.s.flow === 'receive',
    'Release: the bare targets still work, as they always did (the widget uses them)');
  ok(t.s.amount === '' && t.s.unit === 'USD',
    'Release: the amount and unit on the link are ignored');
  ok(t.s.recvRail === undefined && t.rail === 'LIGHTNING',
    'Release: and the rail, so nothing stored is changed either');
}
{
  const t = link('#foxy=split&amt=200&rail=cashu', { debug: false });
  ok(t.s.spAmt === '0' && t.s.spRail === 'LIGHTNING', 'Release: split takes no parameters either');
}

// ---- the Swift side is fenced to Debug too ---------------------------------
//
// Reading it rather than running it: there is no Swift here. What must hold is
// that the scheme and the code that receives one exist in one configuration.
{
  const swift = fs.readFileSync(path.join(ROOT, 'Foxy', 'FoxyWebView.swift'), 'utf8');
  const spans = [];
  const re = /#if DEBUG|#else|#endif/g;
  let m, open = -1, depth = 0;
  while ((m = re.exec(swift))) {
    if (m[0] === '#if DEBUG') { if (depth === 0) open = m.index; depth++; }
    else if (m[0] === '#else' && depth === 1) { spans.push([open, m.index]); open = -1; }
    else if (m[0] === '#endif') { depth--; if (depth === 0 && open >= 0) { spans.push([open, m.index]); open = -1; } }
  }
  const inDebug = i => i >= 0 && spans.some(([a, b]) => i >= a && i < b);
  ok(inDebug(swift.indexOf('static func receiveDeepLink')),
    'the function that receives a foxy:// URL is inside #if DEBUG');
  ok(inDebug(swift.indexOf('func flushDeepLink')),
    'and the one that hands it to the page');
  ok(inDebug(swift.indexOf('WebHostController.receiveDeepLink(url)')),
    'and the SwiftUI hook\'s call to it');
  const mentions = [];
  for (let at = swift.indexOf('receiveDeepLink'); at >= 0; at = swift.indexOf('receiveDeepLink', at + 1)) mentions.push(at);
  ok(mentions.length >= 3 && mentions.every(inDebug),
    'every mention of it is inside #if DEBUG: a Release build has no way to reach it');
  ok(inDebug(swift.indexOf('url.scheme?.lowercased() == "foxy"')),
    'the scheme is only ever compared, and that comparison is inside #if DEBUG');

  const yml = fs.readFileSync(path.join(ROOT, 'project.yml'), 'utf8');
  const plist = fs.readFileSync(path.join(ROOT, 'tools', 'debug-url-scheme.plist'), 'utf8');
  ok(/configs:\s*(?:#[^\n]*\n\s*)*Debug:\s*(?:#[^\n]*\n\s*)*INFOPLIST_FILE: tools\/debug-url-scheme\.plist/.test(yml),
    'project.yml names the URL-scheme plist under Debug only');
  ok(!/^\s*Release:/m.test(yml), 'project.yml gives Release no configuration of its own to hold one');
  // every other configuration's plist: the card applet's name, the export-compliance answer, and no scheme
  const base = fs.readFileSync(path.join(ROOT, 'tools', 'app.plist'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const keys = (base.match(/<key>([^<]*)<\/key>/g) || []).map((k) => k.replace(/<\/?key>/g, ''));
  ok(/^\s*INFOPLIST_FILE: tools\/app\.plist$/m.test(yml) && !/CFBundleURL|LSApplicationQueriesSchemes|CFBundleDocumentTypes/.test(base)
     && keys.length === 2
     && keys.includes('com.apple.developer.nfc.readersession.iso7816.select-identifiers')
     && keys.includes('ITSAppUsesNonExemptEncryption'),
    'and the plist Release does use registers no scheme: the card applet name and the compliance answer, neither a scheme');
  ok(/<string>foxy<\/string>/.test(plist) && /CFBundleURLSchemes/.test(plist),
    'and that plist is what registers foxy://');
}

// ---- the one link a Release build takes: a card's address -------------------
//
// Read as text where the other language is: the phone's message is the call the page registers; the page registers it only
// after it has decided whether it is locked; the phone tells a return before it lets a card through; and the entitlement
// that lets iOS hand the address over names one domain and nothing else.
{
  const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
  const strip = (t) => t.replace(/<!--[\s\S]*?-->/g, '');
  const address = read('Foxy', 'Flashcard', 'CardAddress.swift');
  const call = (/static let pageCall = "([^"]*)"/.exec(address) || [])[1];
  ok(call === 'window.FoxyWallet && window.FoxyWallet._cardTapped && window.FoxyWallet._cardTapped()',
    'the phone\'s one message to the page is a call with nothing in it', call);
  const boot = read('build', 'app', '06-wallet-boot-and-restore.js');
  const lock = boot.indexOf('if (!this._lockedOnce && this.pinLock) this.pinLock();');
  const reg = boot.indexOf('W._cardTapped = () => this.cardTapped();');
  ok(lock > 0 && reg > lock && boot.split('W._cardTapped =').length === 2,
    'and the page puts it on the wallet once, after it has decided whether it is locked: before that it answers nothing, and the phone asks again');
  const web = read('Foxy', 'FoxyWebView.swift');
  // the body of one Swift function, by its first line
  const swiftBody = (sig) => {
    const start = web.indexOf(sig);
    if (start < 0) return '';
    let i = web.indexOf('{', start), d = 0;
    for (; i < web.length; i++) {
      if (web[i] === '{') d++;
      else if (web[i] === '}') { d--; if (d === 0) break; }
    }
    return web.slice(start, i + 1);
  };
  const active = swiftBody('@objc private func appBecameActive()');
  const away = swiftBody('@objc private func appEnteredBackground()');
  ok(active.indexOf('window.FoxyWallet._resumed(') > 0 && active.indexOf('CardTapDelivery.shared.cameBack()') > active.indexOf('window.FoxyWallet._resumed(')
     && away.indexOf('CardTapDelivery.shared.wentToBackground()') > 0,
    'the phone tells the page of a return before it lets a card through, so a lock raised by the return is up when the card is heard');

  // Release takes this address through the same handler and nothing else
  const spans = [];
  const re = /#if DEBUG|#else|#endif/g;
  let m, openAt = -1, depth = 0;
  while ((m = re.exec(web))) {
    if (m[0] === '#if DEBUG') { if (depth === 0) openAt = m.index; depth++; }
    else if (m[0] === '#else' && depth === 1) { spans.push([openAt, m.index]); openAt = -1; }
    else if (m[0] === '#endif') { depth--; if (depth === 0 && openAt >= 0) { spans.push([openAt, m.index]); openAt = -1; } }
  }
  const inDebug = (i) => i >= 0 && spans.some(([a, b]) => i >= a && i < b);
  const hooks = ['.onOpenURL', '.onContinueUserActivity(NSUserActivityTypeBrowsingWeb)'].map((h) => web.indexOf(h));
  const recvs = ['CardTapDelivery.shared.received(url)', 'CardTapDelivery.shared.received(activity.webpageURL)'].map((h) => web.indexOf(h));
  ok(hooks.every((i) => i > 0 && !inDebug(i)) && recvs.every((i) => i > 0 && !inDebug(i)),
    'a Release build takes a universal link both ways SwiftUI hands one over, as a URL and as a browsing-web activity');
  const delivery = read('Foxy', 'Flashcard', 'CardTapDelivery.swift');
  ok(/func received\(_ url: URL\?\) \{\s*guard CardAddress\.isCard\(url\) else \{ return \}\s*cardTapped\(\)/.test(delivery),
    'and both end where the card\'s address is the only thing let through, and anything else is dropped without a word');

  // the entitlement that lets iOS hand the address over
  const ent = strip(read('tools', 'flashcard.entitlements'));
  const domains = /<key>com\.apple\.developer\.associated-domains<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(ent);
  const listed = domains ? (domains[1].match(/<string>([^<]*)<\/string>/g) || []).map((x) => x.replace(/<\/?string>/g, '')) : [];
  ok(listed.length === 1 && listed[0] === 'applinks:getfoxy.io' && (ent.match(/associated-domains/g) || []).length === 1,
    'the device entitlements name one associated domain, applinks:getfoxy.io, and no other', JSON.stringify(listed));
  ok(!/associated-domains|applinks/.test(strip(read('tools', 'simulator.entitlements'))),
    'the simulator build asks for none: its team is no team the site\'s association file names');
  ok(!/applinks|webcredentials|associated/i.test(strip(read('tools', 'app.plist'))) && !/applinks|associated-domains/.test(strip(read('tools', 'debug-url-scheme.plist'))),
    'and no plist carries one: it is an entitlement, never a thing the page or the Info.plist can widen');
}

// ---- the page: act, keep or ignore ----------------------------------------------------------
//
// The class is the app's own parts (flashcard-ui-kit.js builds it as the flashcard suites do) with the card's tap stood in for,
// so these are about what the page decides. tests/flashcard-screens.js has it begin a real tap.
const { appOn } = require('./flashcard-ui-kit');

/* Every screen the app names, found in its sources as the render code names them. The list in the page and the two below must
 * between them hold every one, so a screen added later cannot slip by unclassified. */
function screensInTheSource() {
  const dir = path.join(ROOT, 'build', 'app');
  const names = new Set();
  const pats = [/screen: *'([A-Za-z0-9_-]+)'/g, /\bgo\('([A-Za-z0-9_-]+)'/g, /screen *={2,3} *'([A-Za-z0-9_-]+)'/g,
    /screen *!={1,2} *'([A-Za-z0-9_-]+)'/g, /\bsc *={2,3} *'([A-Za-z0-9_-]+)'/g];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    pats.forEach((p) => { let hit; while ((hit = p.exec(text))) names.add(hit[1]); });
    [/CONFIRM_SCREENS *= *\[([^\]]*)\]/, /SPLIT_SCREENS *= *\[([^\]]*)\]/].forEach((p) => {
      const list = p.exec(text);
      if (list) (list[1].match(/'([A-Za-z0-9_-]+)'/g) || []).forEach((q) => names.add(q.slice(1, -1)));
    });
  }
  return Array.from(names).sort();
}
// where nothing is in progress, and where a payment, an amount being typed, a confirmation or anything else is
const FREE_SCREENS = ['change', 'contacts', 'fieldLog', 'flashcard', 'history', 'home', 'switchMint', 'txDetail'];
const BUSY_SCREENS = ['amount', 'bkStart', 'confirm', 'crossConfirm', 'depConfirm', 'fcLimitConfirm', 'fcLimits', 'fcMoveConfirm', 'fcName', 'fcSpeed', 'fcWelcome', 'fcXmConfirm', 'fcXlConfirm', 'fcOuConfirm', 'feeTooLow',
  'importSeed', 'newMint', 'ocConfirm', 'paid', 'priceConfirm', 'reqOffer', 'rsConfirm', 'sendConfirm', 'sendDone', 'sendFail',
  'sendHow', 'sendScan', 'sendType', 'spAllPaid', 'spAmount', 'spAssign', 'spPayer', 'spShares', 'spWaiting', 'spWays', 'tokenOut',
  'trConfirm',
  // two balances at one mint: what to hold, CURRENCY, WALLET, and SWAP are choices in progress
  'currency', 'holdChoice', 'swap', 'walletPick',
  // and SWAP's confirmation and SWAPPED: a swap being decided, and one just made
  'swapConfirm', 'swapDone'];

/* What the page logs for a card tap (one line per outcome), taken off the console as it goes. */
const cardLines = [];
const realLog = console.log;
console.log = function () {
  const text = Array.prototype.join.call(arguments, ' ');
  if (text.indexOf('[foxy] card tap:') === 0) { cardLines.push(text.slice('[foxy] card tap: '.length)); return undefined; }
  return realLog.apply(console, arguments);
};

/* A page with an app on it whose tap is a count, and whose screen for a tap goes up as the real one does (the stage). */
function pageApp(start) {
  const win = new JSDOM('<body><div id="dc-root"></div></body>', { url: 'https://foxy.test/' }).window;
  const app = appOn({ window: win, W: {} }, start);
  app.CARD_TAP_POLL_MS = 4;
  app.acted = 0;
  app.goFlashcard = () => {
    app.acted += 1;
    const stage = win.document.createElement('div');
    stage.id = 'foxy-stage';
    stage.style.cssText = 'position:fixed;inset:0';
    win.document.body.appendChild(stage);
  };
  const overlay = (id, extra) => {
    const el = win.document.createElement(extra && extra.tag || 'div');
    if (id) el.id = id;
    el.style.cssText = 'position:fixed;inset:0';
    win.document.body.appendChild(el);
    return el;
  };
  const facts = (over) => Object.assign({ locked: false, starting: false, screen: 'home', transfer: false, pick: false, over: '' }, over || {});
  return { app, win, overlay, facts };
}
const nap = (ms) => new Promise((go) => setTimeout(go, ms));

(async () => {
  // ---- the rule, for every screen the app has ----
  {
    const { app, facts } = pageApp();
    const found = screensInTheSource();
    const classed = FREE_SCREENS.concat(BUSY_SCREENS);
    const unnamed = found.filter((n) => classed.indexOf(n) < 0);
    const gone = classed.filter((n) => found.indexOf(n) < 0);
    ok(unnamed.length === 0, 'every screen the app has is classified here as a place to leave or not (a new one fails this until it is)', unnamed.join(' '));
    ok(gone.length === 0, 'and every one classified here is still a screen', gone.join(' '));
    ok(JSON.stringify(app.CARD_TAP_FREE.slice().sort()) === JSON.stringify(FREE_SCREENS),
      'the page\'s list of places to leave is exactly the free ones', app.CARD_TAP_FREE.join(' '));
    const wrongFree = FREE_SCREENS.filter((n) => app.cardTapRule(facts({ screen: n })) !== 'act');
    ok(wrongFree.length === 0, 'act: home, history, contacts, a transaction, the card\'s own screen, your change, the logs, the mint list', wrongFree.join(' '));
    const wrongBusy = BUSY_SCREENS.filter((n) => app.cardTapRule(facts({ screen: n })) !== 'ignore');
    ok(wrongBusy.length === 0, 'ignore: every send, receive and amount screen, every confirmation, sending, paid and failed screen, a split bill, a token, a restore, a backup, a new mint', wrongBusy.join(' '));
    ok(app.cardTapRule(facts({ screen: 'somethingNew' })) === 'ignore' && app.cardTapRule(facts({ screen: '' })) === 'ignore'
       && app.cardTapRule(facts({ screen: undefined })) === 'ignore', 'a screen the rule has never heard of is ignored');
    ok(app.cardTapRule(facts({ screen: 'switchMint', transfer: true })) === 'ignore' && app.cardTapRule(facts({ screen: 'switchMint', pick: true })) === 'ignore'
       && app.cardTapRule(facts({ screen: 'switchMint' })) === 'act',
      'the mint list is a place to leave, except while it is asking where money moves from or to, or which mint a card moves to');
  }
  // ---- locked, or starting: keep; and anything underneath that is not ours to leave: ignore ----
  {
    const { app, facts } = pageApp();
    ok(app.cardTapRule(facts({ locked: true })) === 'keep' && app.cardTapRule(facts({ starting: true })) === 'keep'
       && app.cardTapRule(facts({ locked: true, starting: true, screen: 'history' })) === 'keep',
      'locked, or still starting: keep');
    const wrong = BUSY_SCREENS.filter((n) => app.cardTapRule(facts({ screen: n, locked: true })) !== 'ignore'
      || app.cardTapRule(facts({ screen: n, starting: true })) !== 'ignore');
    ok(wrong.length === 0, 'a payment under the lock, or under the launch screens, is ignored there and then and not kept to be acted on later', wrong.join(' '));
    ok(app.cardTapRule(facts({ over: 'foxy-stage' })) === 'ignore' && app.cardTapRule(facts({ over: 'a card', locked: true })) === 'ignore'
       && app.cardTapRule(facts({ over: 'a PIN pad', screen: 'flashcard' })) === 'ignore',
      'anything up over the screen is ignored, on any screen and locked or not');
  }
  // ---- what the facts are made from ----
  {
    const { app, win, overlay } = pageApp();
    const at = () => app.cardTapFacts();
    ok(JSON.stringify(at()) === JSON.stringify({ locked: false, starting: false, screen: 'home', transfer: false, pick: false, over: '' }),
      'a page with nothing up reads as home with nothing over it', JSON.stringify(at()));
    const stage = overlay('foxy-stage');
    ok(at().over === 'foxy-stage', 'the stage screens, the loaders and the like are named by what they are', at().over);
    stage.remove();
    const unknown = overlay('');
    ok(at().over === 'an overlay', 'and any other fixed thing on the body is an overlay too: what is not known is not left');
    unknown.remove();
    const pad = overlay('');
    app._pinEl = pad;
    ok(at().over === 'a PIN pad' && at().locked === false, 'a PIN pad that is not the lock\'s is a reason to stay');
    app._pinLocked = true;
    ok(at().over === '' && at().locked === true, 'the lock\'s own pad is the lock, not an overlay');
    app._pinLocked = false;
    app._pinEl = null;
    pad.remove();
    const blocked = overlay('');
    app._blockedEl = blocked;
    ok(at().over === 'a card', 'a card is named');
    blocked.remove();
    app._blockedEl = null;
    app.state.bkAskOpen = true;
    ok(at().over === 'the backup question' && app.cardTapRule(at()) === 'ignore', 'the question over home that asks for a backup is a reason to stay, though the template draws it and not the body');
    app.state.bkAskOpen = false;
    overlay('foxy-get-dollars');
    overlay('ftg-warn');
    const field = overlay('', { tag: 'input' });
    ok(at().over === '', 'the list of apps that sell bitcoin, the gate\'s own pieces and a field that only holds focus are not overlays');
    field.remove();
    win.FoxyGate = { visible: () => true };
    overlay('foxy-stage');
    ok(at().starting === true && at().over === '', 'while a screen of the gate\'s is up the overlays are not looked at: the gate\'s own are among them');
    win.FoxyGate = { visible: () => { throw new Error('no'); } };
    ok(at().starting === false, 'a gate that cannot say is not starting');
    app.state.screen = 'switchMint';
    app.state.trStep = 'from';
    app.state.fcPick = true;
    ok(at().screen === 'switchMint' && at().transfer === true && at().pick === true, 'a transfer\'s step and a card\'s pick are read off the state');
  }

  // ---- from home, nothing in the way: act, and what MENU > FLASHCARD does ----
  {
    const { app } = pageApp();
    cardLines.length = 0;
    app.state.open0 = true;
    ok(app.cardTapped() === true, 'the page says it has the request');
    ok(app.acted === 1 && app.state.open0 === false && app._cardTapAt === 0 && !app._cardTapT,
      'at home it acts at once: the drawer is shut as a menu row shuts it, and nothing is left waiting', JSON.stringify({ acted: app.acted, open0: app.state.open0 }));
    ok(cardLines.length === 1 && cardLines[0] === 'opening the card screen from home', 'one line for the outcome', JSON.stringify(cardLines));
    // the tap's screen is up now, as it is the moment the real one begins: a second request is ignored
    cardLines.length = 0;
    app.cardTapped();
    ok(app.acted === 1 && cardLines.length === 1 && /^ignored, something is up over the screen \(foxy-stage\)$/.test(cardLines[0]),
      'a second request while the first is being acted on is ignored, and says why', JSON.stringify(cardLines));
  }
  {
    const { app } = pageApp();
    let hid = 0;
    app.hideGetDollars = () => { hid += 1; };
    app.cardTapped();
    ok(hid === 1 && app.acted === 1, 'and the list of apps that sell bitcoin is closed as it goes');
  }
  // ---- mid-payment: ignored, on every screen of a payment, and over any of them ----
  {
    cardLines.length = 0;
    let acted = 0;
    for (const screen of ['sendConfirm', 'amount', 'sendDone', 'paid', 'spPayer', 'tokenOut', 'reqOffer', 'fcMoveConfirm', 'sendScan', 'confirm']) {
      const { app } = pageApp({ screen });
      app.cardTapped();
      acted += app.acted;
      ok(app.acted === 0 && app._cardTapAt === 0 && !app._cardTapT, 'a card resting behind the phone does not pull the person out of ' + screen);
    }
    ok(acted === 0 && cardLines.length === 10 && cardLines.every((l) => /^ignored, the screen is /.test(l)), 'one line each, saying so', JSON.stringify(cardLines.slice(0, 2)));
    const { app, overlay } = pageApp();
    overlay('foxy-stage');
    app.cardTapped();
    ok(app.acted === 0, 'nor with the sheet of a tap up on the card\'s own screen');
    const another = pageApp({ screen: 'flashcard' });
    another.overlay('foxy-explainer');
    another.app.cardTapped();
    ok(another.app.acted === 0, 'nor from the card\'s screen with one of its flows up');
  }

  // ---- locked: kept, and acted on once the person is in; starting the same ----
  {
    const { app, win, overlay } = pageApp();
    const pad = overlay('');
    app._pinEl = pad;
    app._pinLocked = true;
    cardLines.length = 0;
    app.cardTapped();
    app.cardTapped();
    ok(app.acted === 0 && app._cardTapAt > 0 && !!app._cardTapT, 'locked: nothing is done, and the request waits');
    ok(cardLines.join('|') === 'kept until Foxy is open, it is locked|ignored, one is already waiting', 'a second request while one waits is the same tap, said twice', JSON.stringify(cardLines));
    await nap(40);
    ok(app.acted === 0 && app._cardTapAt > 0, 'it is looked at again and still waits while the lock is up');
    // the person unlocks (10-pin.js: the pad goes and the lock is down in one turn)
    app._pinLocked = false;
    pad.remove();
    app._pinEl = null;
    await nap(40);
    ok(app.acted === 1 && app._cardTapAt === 0 && !app._cardTapT, 'unlocked within the minute: the card screen opens, once');
    ok(/^opening the card screen from home, after \d+ s kept$/.test(cardLines[cardLines.length - 1]), 'and the line says it was kept', cardLines[cardLines.length - 1]);
    // starting: the launch screens, the warning, the gate
    const second = pageApp();
    second.win.FoxyGate = { visible: () => true };
    second.app.cardTapped();
    ok(second.app.acted === 0 && second.app._cardTapAt > 0 && /^kept until Foxy is open, it is starting$/.test(cardLines[cardLines.length - 1]),
      'starting: kept as well, and the line says why', cardLines[cardLines.length - 1]);
    second.win.FoxyGate = { visible: () => false };
    await nap(40);
    ok(second.app.acted === 1, 'and acted on when the screens have gone');
    // a payment that turns up under the lock while it waits
    const third = pageApp();
    third.app._pinLocked = true;
    third.app.cardTapped();
    third.app.state.screen = 'sendConfirm';
    await nap(40);
    ok(third.app.acted === 0 && third.app._cardTapAt === 0 && /^ignored, the screen is sendConfirm/.test(cardLines[cardLines.length - 1]),
      'a request kept under the lock is dropped, not acted on, if what is under it turns out to be a payment', cardLines[cardLines.length - 1]);
    third.app._pinLocked = false;
    await nap(40);
    ok(third.app.acted === 0, 'and stays dropped');
  }

  // ---- a minute, and no more ----
  {
    ok(pageApp().app.CARD_TAP_KEEP_MS === 60000, 'a request waits a minute');
    const { app } = pageApp();
    app._pinLocked = true;
    cardLines.length = 0;
    app.cardTapped();
    app._cardTapAt = Date.now() - 59000;
    app.cardTapSettle();
    ok(app._cardTapAt > 0 && !!app._cardTapT && app.acted === 0, 'at 59 seconds it still waits');
    app._cardTapAt = Date.now() - 61000;
    app.cardTapSettle();
    ok(app._cardTapAt === 0 && !app._cardTapT && app.acted === 0, 'at 61 it has lapsed, with no timer left running');
    ok(cardLines[cardLines.length - 1] === 'lapsed, Foxy was not open within 60 s', 'and says so', cardLines[cardLines.length - 1]);
    app._pinLocked = false;
    await nap(30);
    ok(app.acted === 0, 'the person getting in afterwards is not sent anywhere');
    app.cardTapped();
    ok(app.acted === 1, 'and the next tap is a new request');
    // the real constants: a request that lapses does so without a timer to stop it
    const quick = pageApp();
    quick.app.CARD_TAP_KEEP_MS = 30;
    quick.app._pinLocked = true;
    quick.app.cardTapped();
    await nap(80);
    ok(quick.app._cardTapAt === 0 && !quick.app._cardTapT && quick.app.acted === 0, 'it lapses by itself when nobody comes');
  }
  // the timer is cleared when the app goes (componentWillUnmount lists it)
  ok(/\['_toastT',[^\]]*'_cardTapT'\]/.test(fs.readFileSync(path.join(ROOT, 'build', 'app', '18-lifecycle-and-chart.js'), 'utf8')),
    'the timer a kept request runs on is cleared when the app is taken down');

  console.log = realLog;
  console.log(failures ? '\n' + failures + ' FAILED' : '\nall deep-link checks pass');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log = realLog; console.log('THREW ' + ((e && e.stack) || e)); process.exit(1); });

