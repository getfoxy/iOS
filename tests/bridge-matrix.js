'use strict';
/* bridge-matrix.js — THREAT-MODEL.md's table of what each bridge action needs,
 * held to the Swift that implements it.
 *
 *     node tests/bridge-matrix.js
 *
 * The bridge is the line a script in the page has to cross to reach the camera,
 * the clipboard, notifications, the network and the seed. `BridgeTests` already
 * asserts the action table is exactly the list §1 documents. This asserts the
 * harder half: that what §1 says stands in front of each action is what the
 * handler actually does.
 *
 * Both directions, because only one of them is the interesting one:
 *
 *   - a row claiming a gate its handler does not have — the table flattering
 *     the code, which is how a reviewer is misled;
 *   - a handler with a gate no row mentions — the table falling behind, which
 *     is how the next reviewer stops trusting it.
 *
 * Whoever removes `guard Route.available` from `handlePrice` fails this, and so
 * does whoever adds a gate and leaves the table alone.
 *
 * Why here and not in Swift: a Swift version would need `FoxyBridge`, which the
 * test package cannot build (it compiles `Foxy/Keychain` alone), so it would run
 * only on the simulator, where nothing runs it in CI. This runs in check-all and
 * on every push. It reads the sources as text, which is what `BridgeTests`
 * already does with THREAT-MODEL.md.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const BRIDGE = read('Foxy/Bridge/FoxyBridge.swift');
const SEED = read('Foxy/Bridge/NativeSeedBridge.swift');
const DELIVERY = read('Foxy/Bridge/FoxyBridge+Delivery.swift');
const TAP = read('Foxy/Bridge/FoxyBridge+Tap.swift');
const CARD = read('Foxy/Bridge/FoxyBridge+Flashcard.swift');
const DOC = read('docs/THREAT-MODEL.md');

/* The tokens the table may use, and the Swift each one means. A token with no
 * pattern is documentation: named in a row, not checked here, and listed as
 * unchecked at the end so nobody mistakes it for a guarantee. */
const TOKENS = {
  'route': /Route\.available/,
  'mint url': /Route\.urlProblem/,
  'seed queue': /onSeedQueue\(|seedQueue\.async/,
  'one change': /beginSeedChange/,
  'seed alert': /confirmSeedChange/,
  'tor alert': /confirmUnprotected/,
  'screen queue': /SeedScreens\.queue/,
  'presenter': /guard let presenter/,
  'throttle': /lastNotifyAt/,
  'once': /carryOver/,
  'expiry': /expirationDate/,
  'reasons': /biometricReason/,
  'kinds': /case "sent"/,
  'rect limits': /let sane =/,
  // payment requests paid over Tor (FoxyBridge+Delivery.swift)
  'onion inbox': /OnionInbox \{/,
  'onion only': /OnionPost\.send/,
  'answer limits': /\[200, 409, 422\]\.contains/,
  'nostr only': /NostrDelivery\.send/,
  // the screen kept lit: the flag is the only thing this action touches
  'screen only': /isIdleTimerDisabled = on/,
  // tap to pay over Bluetooth (FoxyBridge+Tap.swift)
  'offer only': /TapProtocol\.isPayload/,
  // TapTx: the Bluetooth payer on a phone, its stand-in in the simulator (TapLink.swift)
  'tap payer': /Tap(Payer|Tx)\(/,
  /* Over the link this tap already has, or not at all.
   *
   * Five actions go across that one link and each does it through its own
   * method: the payment out (`payer.send`), the change back (`sendChange`), the
   * payer's page saying it kept the change (the closure the receiver is
   * holding), the receiver's page saying a person is deciding (`sendAsking`),
   * and the receiver's page saying change is owed (`expectChange`). All five
   * mean the same thing — there is one link, and when it has gone the action
   * does not reach for another.
   *
   * `tapAsking` is the one of the four that carries no money, and it is the one
   * that resolves rather than refusing when the link has gone: a card is already
   * on screen by then and the person's answer still has to go somewhere. What it
   * must not do — and what this pins — is find some other way to tell them. */
  'one link': /payer\.send\(text\)|\.sendChange\(|answer\(kept\)|\.sendAsking\(|\.expectChange\(|\.sendQuote\(|\.sendTerms\(/,
  /* A card held to the phone (FoxyBridge+Flashcard.swift). All four actions
   * act on the one session the bridge holds and on nothing else; and the one
   * that carries a command to the card reads it first (CardGate), so only
   * Foxy's own applet is ever spoken to. */
  'card session': /self\.cardLink/,
  'card commands': /CardGate\.allows\(/,
  // a flag, and nothing else: a shake is told to the page as a stage while it is set (TAP-TO-PAY.md)
  'shake flag': /self\.shakeArmed = true/,
  // the one URL iOS provides for an app's own Settings page, and nothing else
  'settings url': /UIApplication\.openSettingsURLString/,
  // four fixed web addresses picked by name; the page never supplies a URL
  'company sites': /Self\.companySites\[which\]/,
};

const failures = [];
const fail = (msg) => { failures.push(msg); console.log('FAIL  ' + msg); };
const ok = (msg) => console.log('ok    ' + msg);

/* ---- the code: every action, and the body of its handler ------------------ */

const handlers = {};
for (const m of BRIDGE.matchAll(/"([A-Za-z][A-Za-z0-9]*)": FoxyBridge\.([A-Za-z][A-Za-z0-9]*),/g)) handlers[m[1]] = m[2];

/* A Swift function body, by brace matching from its declaration. */
function body(name) {
  for (const source of [BRIDGE, SEED, DELIVERY, TAP, CARD]) {
    const at = source.search(new RegExp('\\n {4}(?:private )?(?:static )?func ' + name + '\\('));
    if (at < 0) continue;
    let depth = 0;
    for (let i = source.indexOf('{', at); i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) return source.slice(at, i);
    }
  }
  return null;
}

/* ---- the table: what THREAT-MODEL.md says each action needs --------------- */

const rows = {};
for (const line of DOC.split('\n')) {
  const m = /^\| `([A-Za-z][A-Za-z0-9]*)` \| ([^|]+) \| /.exec(line);
  if (!m) continue;
  const needs = m[2].trim();
  rows[m[1]] = needs === '—' ? [] : needs.split('+').map((s) => s.trim());
}

/* ---- 1. the table covers exactly the actions that exist ------------------- */

const inCode = Object.keys(handlers).sort();
const inDoc = Object.keys(rows).sort();
if (!inCode.length) fail('no actions found in FoxyBridge.swift — the table is not being read');
else if (inCode.join() !== inDoc.join()) {
  const missing = inCode.filter((a) => !rows[a]);
  const extra = inDoc.filter((a) => !handlers[a]);
  fail('the table and the bridge disagree about which actions exist'
    + (missing.length ? '\n      no row for: ' + missing.join(' ') : '')
    + (extra.length ? '\n      a row for what is not an action: ' + extra.join(' ') : ''));
} else ok(inCode.length + ' actions, each with one row');

/* ---- 1b. and the page asks for nothing that is not an action -------------- */
/*
 * The other direction, which nothing checked. §1 reads as "every action the
 * page may ask for", and `BridgeTests` and the check above both work from the
 * Swift outwards — so a door the page knocks on that native never opens is
 * invisible to all of them. `tapArm` was one: written when the payer was armed
 * by a call of its own, left behind when arming moved inside `tapPayStart`, and
 * it would have thrown if anything had ever called it.
 *
 * Dead is the harmless half. The same blind spot would hide a page asking for
 * an action somebody had removed, and a reviewer reading §1 would see a
 * complete list and a page that does not match it.
 */
const WALLET_SRC = fs.readdirSync(path.join(ROOT, 'build', 'wallet'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => read(path.join('build', 'wallet', f)))
  .join('\n');
/*
 * Both of the page's doors, not one.
 *
 * This read `bridgeAsk(` alone, and the seed and counter actions do not go
 * through it — they go through `nativeJson(`, which wraps `bridgeSeed`. So the
 * half of the bridge that holds the seed, the counters and the lock keys was
 * outside the only check that looks from the page outwards: sixteen actions the
 * page asks for by name, and a typo in any of them would have reached the phone
 * as an unknown action and been invisible here (found while adding the
 * p2pk actions).
 */
const asked = [...new Set([
  ...[...WALLET_SRC.matchAll(/bridgeAsk\(\s*'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1]),
  ...[...WALLET_SRC.matchAll(/nativeJson\(\s*'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1]),
])].sort();
const unserved = asked.filter((a) => !handlers[a]);
if (!asked.length) fail('no bridgeAsk or nativeJson calls found in build/wallet — the page side is not being read');
else if (unserved.length) {
  fail('the page asks for actions no bridge serves: ' + unserved.join(' '));
} else ok('the page asks for ' + asked.length + ' actions, every one of them served');

/* And the seed half of the bridge routes every action its own table names. */
const SEED_LISTED = [...(/nativeSeedActions: Set<String> = \[([^\]]*)\]/.exec(SEED) || ['', ''])[1]
  .matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]).sort();
const seedUnserved = SEED_LISTED.filter((a) => !handlers[a]);
if (!SEED_LISTED.length) fail('nativeSeedActions was not found in NativeSeedBridge.swift');
else if (seedUnserved.length) fail('nativeSeedActions names actions the table does not run: ' + seedUnserved.join(' '));
else ok(SEED_LISTED.length + ' seed actions, every one of them in the table');

/* ---- 2. every token is one the table is allowed to use -------------------- */

for (const [action, needs] of Object.entries(rows)) {
  for (const token of needs) {
    if (!(token in TOKENS)) fail(action + ': "' + token + '" is not a token this test knows');
  }
}

/* ---- 3. the row and the handler say the same thing, both ways ------------- */

for (const action of inCode) {
  const fn = handlers[action];
  const text = body(fn);
  if (text === null) { fail(action + ': the body of ' + fn + ' was not found'); continue; }
  const claimed = new Set(rows[action] || []);
  for (const [token, pattern] of Object.entries(TOKENS)) {
    const inSwift = pattern.test(text);
    if (inSwift && !claimed.has(token)) {
      fail(action + ': ' + fn + ' has "' + token + '" (' + pattern + ') and the table does not say so');
    }
    if (!inSwift && claimed.has(token)) {
      fail(action + ': the table says "' + token + '" and ' + fn + ' does not have it');
    }
  }
}
if (!failures.length) ok('every row matches its handler, and every handler its row');

/* ---- 4. the frame gate, which covers all of them -------------------------- */

const frame = body('answers');
if (!frame || !/isMainFrame && originProtocol == "file"/.test(frame)) {
  fail('FoxyBridge.answers no longer refuses subframes and non-file origins');
} else ok('every message still has to come from the main frame of a file: page');

/* ---- what this does not check -------------------------------------------- */

const unchecked = Object.entries(TOKENS).filter(([, p]) => !p).map(([t]) => t);
console.log('');
console.log('not checked here: each action\'s own argument checks (FoxyTests/NativeSeedTests.swift,');
console.log('CounterRangeCheckTests), and Face ID or the passcode, which SeedVault enforces on the');
console.log('read rather than at the bridge' + (unchecked.length ? '; tokens: ' + unchecked.join(', ') : '.'));
console.log('');
console.log(failures.length
  ? failures.length + ' mismatch(es) between THREAT-MODEL.md §1 and the bridge'
  : 'all ' + inCode.length + ' actions match what THREAT-MODEL.md §1 says they need');
process.exit(failures.length ? 1 : 0);
