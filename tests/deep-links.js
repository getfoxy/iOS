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
 * screen and ignores every parameter. The last group is that build. */
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
  ok(inDebug(swift.indexOf('.onOpenURL')),
    'and the SwiftUI hook that calls it');
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

console.log(failures ? '\n' + failures + ' FAILED' : '\nall deep-link checks pass');
process.exit(failures ? 1 : 0);
