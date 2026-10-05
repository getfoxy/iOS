'use strict';
/* kept-token.js — a claimed payment's token stays in history, within a budget.
 *
 *     node tests/kept-token.js
 *
 * A token used to be deleted the moment it was claimed. Then somebody says
 * they never got their money, or their change, and there is nothing to show
 * them. Now the text moves from `token` (not claimed: RECLAIM is offered) to
 * `kept` (claimed: SHOW QR and SHARE TOKEN only), so they can scan it with any
 * Cashu wallet and be told it was already claimed. The receiver keeps the
 * payer's change the same way, as `changeToken`.
 */
const fs = require('fs');
const path = require('path');
const { loadReal } = require('./harness');

let failed = 0;
const ok = (good, name, detail) => {
  console.log((good ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : ''));
  if (!good) failed += 1;
};
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const token = (secret) => 'cashuA' + Buffer.from(JSON.stringify({
  token: [{ mint: 'https://m.test', proofs: [{ amount: 8, id: '009a1f293253e41e', secret, C: '02' + 'ab'.repeat(32) }] }],
})).toString('base64url');

{
  const t = token('one');
  const c = loadReal({ storage: { 'foxy.txmeta': JSON.stringify({ a: { token: t, note: 'lunch' }, b: { token: token('two') } }) } });
  const W = c.W || c.window.FoxyWallet;
  const store = c.storage || c.window.localStorage;
  ok(W.forgetClaimedToken(t) !== undefined, 'a claimed token is forgotten without throwing');
  const m = JSON.parse(store.getItem('foxy.txmeta'));
  ok(m.a.kept === t && !('token' in m.a), 'its text moves from token to kept', JSON.stringify(Object.keys(m.a)));
  ok(m.a.note === 'lunch', 'and the rest of the entry is untouched');
  ok(!!m.b.token && !m.b.kept, 'a payment not yet claimed keeps its token as it was');
}

{
  const t = token('three');
  const big = 'x'.repeat(1600000);
  const c = loadReal({ storage: { 'foxy.txmeta': JSON.stringify({
    old: { kept: big }, owed: { token: big, changeToken: 'c'.repeat(10) }, now: { token: t },
  }) } });
  const W = c.W || c.window.FoxyWallet;
  const store = c.storage || c.window.localStorage;
  W.forgetClaimedToken(t);
  const m = JSON.parse(store.getItem('foxy.txmeta'));
  ok(!m.old.kept, 'over the budget, the oldest kept text goes first');
  ok(m.owed.token === big, 'an unclaimed token is never trimmed, whatever its size');
  ok(m.now.kept === t, 'and the one just claimed is kept');
}

const lost = read('build/wallet/04-lost-answers.js');
const deliver = read('build/wallet/07-request-delivery.js');
const split = read('build/wallet/19-bill-split.js');
const hist = read('build/app/26-render-history-and-contacts.js');
const markup = read('build/markup.html');
ok(/function trimKeptTokens\(all\) \{\s*var BUDGET = 1500000;/.test(lost), 'the budget is a megabyte and a half');
ok(/changeToken/.test(deliver) && /changeToken/.test(split), 'the receiver keeps the change it made, both ways it is made');
ok(/tx\.token \|\| \(tx\.dir === 'in' \? tx\.changeToken : tx\.kept\)/.test(hist),
   'history shows the unclaimed token, else the change or the kept one');
ok(/txCanReclaim: !!tx\.token && tx\.dir !== 'in'/.test(hist), 'RECLAIM is offered only for a token not yet claimed');
ok(/PAYER CHANGE TOKENS/.test(hist) && /PAYMENT TOKEN \\u00b7 CLAIMED/.test(hist), 'and the card says which it is');
ok(/txTokenTitle/.test(markup) && /txTokenNoteShown/.test(markup), 'the title and note are on the screen');

const send = read('build/app/03-send.js');
const sent = read('build/app/24-render-receive-and-send.js');
ok(/if \(this\.state\.screen === 'sendDone' \|\| this\.state\.sendPhase\) \{\s*this\.setState\(\{ screen: 'sendConfirm', sendPhase: null, sendSlow: false \}\);\s*\}\s*\/\/ not enough money/.test(send),
   'a failed send leaves SENDING at once, before any card');
ok(/insufficient\|balance\|not enough/.test(send), '"Not enough ecash" is a balance problem, not a lost connection');
ok(/sendStopWaiting: \(\) => \{[\s\S]{0,1600}?sendSlow: false, sendPhase: null/.test(sent),
   'STOP WAITING clears the sending mark, so the phone listens for a tap again');

const tidy = read('build/app/07-history-tokens-mints.js');
const native = read('Foxy/FoxyWebView.swift');
ok(/_putAway\(true\)/.test(native) && /FoxyWallet\._tidying/.test(native) && /timeIntervalSince\(began\) > 20/.test(native),
   'and the phone holds Tor up while it runs, twenty seconds at most');
ok(/TIDY_AWAY_STOP = 12000;/.test(tidy)
   && /if \(this\._putAway && Date\.now\(\) - \(this\._putAwayAt \|\| 0\) > this\.TIDY_AWAY_STOP\) \{[\s\S]{0,200}?this\._tidyOwed = true;[\s\S]{0,140}?return;/.test(tidy),
   'no new swap starts after twelve seconds away, so none is cut off at twenty');
ok(/this\.movingMints\(\) \|\| this\._changeDueAt\) \{ this\.tidyChangeLater\(more\); return; \}/.test(tidy),
   'but not while change is on its way back to this phone');
ok(/tidySteps: function \(\) \{/.test(read('build/wallet/19-bill-split.js')), 'the wallet says how many swaps that is');
ok(/if ready && !wasParked && away < 30 \{/.test(read('Foxy/Tor/TorService.swift')),
   'back while Tor was being kept up, it is left alone and the swap is not cut');
{
  const paid = read('build/app/15-paid-wake-keyboard.js');
  const at = (s) => paid.indexOf(s);
  ok(at('const told = W.tapChangeKept(true);') > 0 && at('const told = W.tapChangeKept(true);') < at('this.changeArrived(net);'),
     'the receiver is told the change was kept before the link is let go');
  ok(/if \(this\._ackHold && Date\.now\(\) < this\._ackHold\) return true;/.test(read('build/app/26d-tap.js')),
     'and the link is held while that word goes out');
}
{
  const lock = read('build/wallet/02-dleq-lock-holds-imports.js');
  ok(/if \(proofGaveUpAt >= asked && \/\^\(sendToken\|pay\|payLnurl\)\$\/\.test/.test(lock) && /stopped\.foxyStopped = true;/.test(lock),
     'a send still waiting its turn when the person stops waiting is not made');
  ok(/if \(W && W\.giveUpWaiting\) W\.giveUpWaiting\(\);/.test(sent) && /Stopped\. The payment was not made\./.test(sent),
     'STOP WAITING says so, and tells the wallet');
  ok(/this\.sendBehindChange\(\) \? 'FINISHING CHANGE' : 'SENDING'/.test(sent), 'and a send that is behind the top-up says FINISHING CHANGE');
}
{
  const pool = read('build/wallet/05-paying-this-mint.js');
  ok(/var PIECES_LOW = 6;/.test(pool) && /if \(count\[d\] > PIECES_LOW\) return;/.test(pool) && /if \(count\[d\] <= DEEP_LOW\) \{/.test(pool),
     'a tier is refilled once it is half gone, not at the first piece spent');
}
ok(/if \(x > 100\) this\.go\('history'\); else this\.goSwitchMint\(\);/.test(read('build/app/23-render-home-and-amount.js')),
   'the balance pill: mint side to the mints, balance side to history');
{
  const tidy2 = read('build/app/07-history-tokens-mints.js');
  ok(/if \(!this\._putAway\) \{ this\._tidyOwed = true; this\._tidyMore = !!more; return; \}/.test(tidy2),
     'a top-up only runs with Foxy put away; in the foreground it is only noted');
  ok(/tidyChangeNow\(\) \{\s*this\._tidyOwed = true;\s*this\._tidyAt = 0;\s*\}/.test(tidy2), 'a payment notes one, and sets the twenty-second rule aside');
  ok(/if \(this\._tidyOwed \|\| this\._tidyT\) this\.tidyChangeLater\(this\._tidyMore\);/.test(tidy2), 'put away, it starts');
  ok(/W\.topUpClosing\(\)/.test(tidy2) && /\}, 18000\);/.test(tidy2), 'and at eighteen seconds a swap still out has its piece checked');
  ok(!/changeMakingShow|data-foxy-making-change/.test(tidy2), 'there is no MAKING CHANGE screen');
  const lost = read('build/wallet/04-lost-answers.js');
  ok(/if \(rec\.freeInputs\) \{[\s\S]{0,300}?writeSwap\(rec\);\s*return 0;/.test(lost), 'a piece checked unspent at the close is not held');
  ok(/topUpClosing: function \(\) \{/.test(read('build/wallet/19-bill-split.js')), 'the wallet does that check');
}
{
  ok(/static let beyond: UInt64 = 1000/.test(read('Foxy/Keychain/SeedCandidates.swift'))
     && /var NATIVE_RESTORE_WINDOW = 1000;/.test(read('build/wallet/03-seed-counters-logs.js'))
     && /if \(empty \* size >= RESTORE_GAP\)/.test(read('build/wallet/13-restore.js')),
     'a restore walks a thousand empty counters before it stops, on the phone and on the page alike');
  ok(/recoveringSats: function \(\) \{/.test(read('build/wallet/22-screen-lock.js'))
     && /is being recovered from the mint/.test(read('build/app/26-render-history-and-contacts.js'))
     && /being recovered from the mint/.test(read('build/app/16-history-lists.js')),
     'what a swap took after Foxy was put away is named on the audit and the home screen');
}
ok(/static let authenticationTries = 8/.test(read('Foxy/Tor/TorService.swift')),
   'Tor is given eight control links, half a minute, to finish loading a large cache before Foxy says it cannot connect');

// A receiver bringing a cross-mint payment home is off the air until it is.
{
  const tap = read('build/app/26d-tap.js');
  ok(/if \(this\._carryingHome\) return null;/.test(tap)
     && /this\._carryingHome = true;\n    if \(this\.syncTap\) this\.syncTap\(\);/.test(tap)
     && /const settle = \(\) => \{\n      this\.hideMelt\(\);\n      this\._quiet = false;\n      this\._carryingHome = false;/.test(tap)
     && /\}\)\.then\(\(r\) => \{\n      settle\(\);/.test(tap) && /\}\)\.catch\(e => \{\n      settle\(\);/.test(tap),
     'the invoice screen offers nothing while its payment is carried home, and offers again whichever way that ends');
}

// The card asks the swap's own selection whether the amount can be made.
ok(/var sel = w\.selectProofsToSend\(have, out, true\);/.test(read('build/wallet/19-bill-split.js'))
   && /W\.sendShortfall\(sats, \{ locked: /.test(read('build/app/24-render-receive-and-send.js')),
   'the shortfall check puts the amount to the same selection the swap makes, locked as the send will be');

// A request another Foxy paid is ecash on the detail screen, not Lightning.
ok(/\/\^\(token-\|req-\|tap-change-\|reclaim-\)\/\.test\(String\(tx\.hash \|\| ''\)\)\) \? 'CASHU'/.test(read('build/app/26-render-history-and-contacts.js')),
   'a paid request, returned change and reclaimed ecash are named CASHU on the detail screen');

// The change maker and the entry work out what is owed the same way: less
// the mint's fee on the pieces that came.
ok(/var owed = Math\.max\(0, paid - asked - \(Number\(p\.inFee\) \|\| 0\)\);\n    if \(!\(owed > 0\)\) return;/.test(read('build/wallet/07-request-delivery.js')),
   'changeBack makes no change for the fee a payer added on purpose');

// Change carries its own cost: cut to what is left over less what it costs to
// make and to take, settled against what was left over, and none at all when
// that leaves nothing. Both change makers, and the payer does the same sum.
{
  const req = read('build/wallet/07-request-delivery.js');
  const split = read('build/wallet/19-bill-split.js');
  ok(/var back = changeFromPile\(wallet, owed\);\n    if \(!\(back > 0\)\) \{/.test(req)
     && /function changeFromPile\(w, owed\) \{\n    var most = changeFor\(w, owed\);/.test(req)
     && /FoxyWallet\.sendToken\(back, \{ unit: 'sat', lockTo: p\.changeTo, purpose: 'change',\n\s+forHash: 'req-' \+ p\.id, owed: owed \}\)/.test(req)
     && /settleChangeMade\('req-' \+ p\.id, owed, \{ sats: made\.sats, fee: made\.fee, back: back \}\);/.test(req),
     'change over the link is what was paid over less its cost, and is settled against what was paid over');
  ok(/var back = changeFromPile\(wallet, owed\);\n      if \(!\(back > 0\)\) return Promise\.resolve\(null\);/.test(split)
     && /if \(hash\) settleChangeMade\(hash, owed, \{ sats: made\.sats, fee: made\.fee, back: back \}\);/.test(split),
     'and so is change for a scanned token');
  ok(/if \(Number\(split\.over\) > 0 && !\(changeFor\(w, Number\(split\.over\)\) > 0\)\) \{\n          dust = Number\(split\.over\);\n          split\.over = 0;/.test(split),
     'a payer that paid over by too little to come back does not wait for change');
  ok(/var kept = Math\.max\(0, Number\(p\.sats\) - giveBack - \(Number\(p\.inFee\) \|\| 0\)\);/.test(read('build/wallet/20-helpers.js'))
     && /fee: tokFee,/.test(split)
     && /var charged = prior \? \(Number\(prior\.changeFee\) \|\| 0\) \+ \(Number\(prior\.topUpFee\) \|\| 0\) : 0;/.test(split)
     && /if \(prior && Number\(prior\.changeDust\) > 0\) entry\.sats \+= Number\(prior\.changeDust\);/.test(split),
     'the kept amount is net of the receive fee, and what was settled on an entry survives the swap that lands after it');
  ok(/const net = W\.changeNet \? W\.changeNet\(token\) : sats;/.test(read('build/app/15-paid-wake-keyboard.js'))
     && /changeNet: function \(token\) \{/.test(read('build/wallet/21-native-bridges.js')),
     'the payer settles its entry with what the change is worth to it, less this mint\u2019s fee for taking it');
}

// A locked payment Foxy was killed in the middle of is finished on reopening:
// held at launch, asked about by its written-down outputs, rebuilt onto its
// own entry, and never dropped on its age.
{
  const lost = read('build/wallet/04-lost-answers.js');
  const recv = read('build/wallet/15-receiving.js');
  ok(/try \{ holdUnanswered\(u\); \}/.test(read('build/wallet/11-routing.js'))
     && /if \(r\.kind !== 'send' \|\| !\(r\.locked && r\.locked\.length\) \|\| r\.freeInputs \|\| heldHas\(r\.id\)\) return;/.test(lost)
     && /if \(canonicalMint\(r\.mint\) !== here \|\| liveSwap\[r\.id\]\) return;/.test(lost),
     'the pieces of a locked send no page is waiting on are held as the wallet connects');
  ok(/if \(r\.kind === 'send' && r\.locked && r\.locked\.length\) \{\n\s+if \(liveSwap\[r\.id\]\) return null;\n\s+return finishLockedSend\(uw, r\)/.test(recv)
     && /var wrote = writeLockedSend\(uw, r, got\.send, got\.change\);/.test(recv),
     'the sweep asks the mint about a locked send by its written-down outputs and writes the payment it rebuilds');
  ok(/return restoreLocked\(w, rec\)\.then\(function \(made\) \{\n      if \(!made\) \{/.test(lost)
     && /if \(!unspent\) \{\n\s+console\.warn\('\[foxy\] a locked payment the mint took the pieces for could not be rebuilt yet; its record is kept'\);/.test(lost)
     && /var hash = 'token-' \+ String\(rec\.id\)\.replace\(\/\^send-\/, ''\);/.test(lost),
     'it is given up only when the mint says its pieces are unspent, and its entry is named from the record so a second pass amends it');
}

// A refusal that keeps nothing, a not-yet said as one, a failed payment's split
// counted once, and a melt held elsewhere asked about from here.
{
  const help = read('build/wallet/20-helpers.js');
  const recv = read('build/wallet/15-receiving.js');
  ok(/var unsure = !spent && !notIssued\(e\)\n\s+&& loadSwaps\(\)\.some\(function \(r\) \{ return r && r\.into === into; \}\);\n\s+if \(!spent && !notIssued\(e\) && !unsure\) dropUnclaimed\(p\.id\);/.test(help)
     && /var code = \(spent \|\| unsure\) \? 409 : 422;/.test(help)
     && /let status = \[200, 409, 422\]\.contains\(asked\) \? asked : 422/.test(read('Foxy/Bridge/FoxyBridge+Delivery.swift'))
     && /if \(!\(code > 0\) \|\| code === 409 \|\| code === 504\) return 'unconfirmed';/.test(read('build/wallet/21-native-bridges.js')),
     'plain ecash the receiver could not swap in is kept and answered 409 only while the mint may have it — a status the phone passes on and the payer reads as unconfirmed; refused, nothing is kept');
  ok(/if \(meltGone\(quote\.quote\)\) chargeUnsentFee\(at, splitFee\);/.test(read('build/wallet/16-sending.js'))
     && (recv.match(/if \(meltGone\(entry\.quote\)\) \{ chargeUnsentFee\(here, entry\.splitFee\); dropMoveNoteFor\(entry\.bolt11\); \}/g) || []).length === 2,
     'a melt that did not go charges its split\u2019s fee once, wherever the hold is given back');
  ok(/return FoxyWallet\._sweepMeltsOnce\(\{ w: ow, here: at \}\);/.test(recv)
     && /return awayWallet\(at\)\.then\(function \(ow\) \{ return FoxyWallet\._sweepMeltsOnce\(\{ w: ow, here: at \}\); \}\)/.test(recv)
     && /counterSource: sharedCounters, requireSigDleq: true \} : \{\}\);\n\s+return withTimeout\(ow\.loadMint\(\), 25000, hostOf\(at\)\)/.test(read('build/wallet/04-lost-answers.js'))
     && /if \(restoreFailed && \(\(q && q\.change\) \|\| \[\]\)\.length\) \{/.test(recv),
     'a melt held at another mint is swept with a wallet on this phone\u2019s seed, and a failed change restore keeps the hold');
}

// Locked pieces signed into a token are struck off once that token is written
// down, never one signature at a time before it exists.
ok(/hash: hash, at: Date\.now\(\), swapped: split\.swapped \}\);\n[\s\S]{0,200}if \(split\.handedOn && split\.handedOn\.length\) \{\n\s+rememberHandedOn\(split\.handedOn\);\n\s+takeFromUnclaimed\(split\.handedOn\);/.test(read('build/wallet/19-bill-split.js'))
   && /if \(opts && opts\.defer\) \{\n\s+return \{ token: out, sats: sumProofs\(signed\), signed: signed \};/.test(read('build/wallet/19-bill-split.js')),
   'locked pieces paid out of are struck off after the token is saved, all together');

// A visit to another mint is never saved as the phone's own, and a launch
// catches up on what was left between two mints.
{
  const move = read('build/wallet/14-moving-between-mints.js');
  const route = read('build/wallet/11-routing.js');
  ok(/if \(!opts \|\| opts\.remember !== false\) save\(K\.mint, u\);/.test(route)
     && /var how = visit \? \{ remember: false \} : undefined;/.test(move)
     && /return FoxyWallet\.connect\(terms\.from, null, null, \{ remember: false \}\)/.test(move)
     && /W\.moveRun\(plan, \(\) => \{\}, \{ visit: true \}\)/.test(read('build/app/26d-tap.js')),
     'a crossing and a carry visit the other mint without saving it as the phone\u2019s own');
  ok(/if \(opts && opts\.remember === false\) return null;\n\s+return FoxyWallet\.crossingsWaiting\(\) \? FoxyWallet\.catchUpCrossings\(\) : null;/.test(route)
     && /return \(mintUrl && FoxyWallet\.crossingsWaiting\(\)\) \? FoxyWallet\.catchUpCrossings\(\) : null;/.test(read('build/wallet/23-screen-capture.js'))
     && /W\.catchUpCrossings\(\)\.then/.test(read('build/app/06-wallet-boot-and-restore.js')),
     'a connect, a resume and a route coming back each catch up on crossings, carries and refusals, and a visit does not');
  ok(/if \(e && e\.movePaid\) \{/.test(read('build/app/26d-tap.js'))
     && /title: 'YOUR SATS ARE ON THEIR WAY'/.test(read('build/app/26d-tap.js'))
     && /chip: made\.lockedTo\n\s+\? 'HIGH RISK: these '/.test(read('build/app/07-history-tokens-mints.js')),
     'the crossing card says the sats left when they did, and a refused locked payment is not called still yours');
}

// Money only passing through a mint is not cut into small change there.
ok(/var shaped = \(isFinite\(expect\) && expect > 0 && !\(opts && opts\.plain\)\)/.test(read('build/wallet/19-bill-split.js'))
   && /plain: \/\^carry:\/\.test\(String\(p\.purpose \|\| ''\)\) \}\)/.test(read('build/wallet/20-helpers.js'))
   && /if \(plain\) all\[id\]\.plain = true;/.test(read('build/wallet/07-request-delivery.js'))
   && /plain: !!one\.plain, visit: true \}\)/.test(read('build/wallet/20-helpers.js')),
   'a payment taken to be carried home is received as the fewest pieces, late or not');

// The receiver tells only the payers still owed the door byte, drops one that
// refuses forty times, and prints the line when it changes (the storm:
// 8,500 lines in fifteen seconds).
{
  const link = read('Foxy/Bluetooth/TapLink.swift');
  ok(/if !doorOwedTo\.isEmpty \{ tellTurned\(only: doorOwedTo\) \}/.test(link)
     && /if n >= 40 \{/.test(link) && /if line != doorSaid \{/.test(link),
     'the door byte is re-sent only to the payers owed it, a dead payer is dropped, and the line prints once');
}

// A system paste button that takes the tap and pastes nothing hands the tap
// to a direct read: 1.5 s, only while Foxy is active,
// and never twice for one tap.
{
  const host = read('Foxy/Bridge/PasteHost.swift');
  ok(/deadline: \.now\(\) \+ 1\.5, execute: work/.test(host)
     && /UIApplication\.shared\.applicationState == \.active/.test(host)
     && /if self\.pastedOnce \{ return \}/.test(host)
     && /self\.onText\(UIPasteboard\.general\.string \?\? ""\)/.test(host),
     'a paste-control tap that pastes nothing reads the pasteboard directly after 1.5 s, once, while Foxy is active');
}
ok(/exact\.length > 24 && exact\.length <= mintArrayCap\(w\) && routeOpen\(\)/.test(read('build/wallet/19-bill-split.js'))
   && /shapeOutputs\(proofs\(intoMint, unit\), expect, mintArrayCap\(w\) - 16\)/.test(read('build/wallet/19-bill-split.js')),
   'a swap never asks a mint for more inputs or outputs than it takes in one request');
ok(/if \(px && n > 0 && \(n \/ 1e8\) \* px < 0\.005\) return /.test(read('build/app/26e-loaders.js')),
   'an amount under half a cent is shown in sats, never as $ 0.00');
ok(/if \(writing \|\| !outgoing\.isEmpty\), let t = target, t\.state == \.connected, !closingAfterWrites \{/.test(read('Foxy/Bluetooth/TapLink.swift'))
   && /the receiver was told the change was kept/.test(read('Foxy/Bluetooth/TapLink.swift')),
   'the payer finishes writing "I kept the change" before it lets the link go, and says when it got through');
{
  const gate = read('Web/foxy-tor-gate.js');
  ok(/if \(bluetoothDue\(\)\) showBluetooth\(\); else gateChanged\(\);/.test(gate) && /action: 'bluetoothAsk'/.test(gate)
     && !/iOS said no; staying/.test(gate) && /rejected; iOS asks when Bluetooth is first needed/.test(gate),
     'after the warning, a Bluetooth screen: APPROVE asks the phone and moves on whatever iOS says, REJECT moves on without asking');
  ok(/"bluetoothAsk": FoxyBridge\.handleBluetoothAsk/.test(read('Foxy/Bridge/FoxyBridge.swift'))
     && /final class BluetoothAsk: NSObject, CBCentralManagerDelegate/.test(read('Foxy/Bridge/FoxyBridge+Tap.swift'))
     && /`bluetoothAsk`/.test(read('THREAT-MODEL.md')),
     'the phone answers that question with one action, and the threat model lists it');
}
ok(/function changeAllowance\(owed\) \{/.test(read('build/wallet/07-request-delivery.js'))
   && /sum > Number\(owed\) \+ changeAllowance\(owed\)/.test(read('build/wallet/07-request-delivery.js')),
   'change a fee over what is owed is kept, on arrival and when matched to its payment later');
ok(/if Date\(\)\.timeIntervalSince\(bootEventAt\) >= 25, nudgedEventAt != bootEventAt \{/.test(read('Foxy/Tor/TorService.swift')),
   'a direct bootstrap that reports nothing for 25 seconds has its connections started again, once per step');
ok(/var owed = Math\.max\(0, paid - asked - \(Number\(p\.inFee\) \|\| 0\)\);\n    \/\/ too little to be worth sending back stays, and the entry says what stayed\n    return changeFor\(wallet, owed\) > 0 \? owed : 0;/.test(read('build/wallet/07-request-delivery.js'))
   && /inFee: inFee, purpose: open\.purpose/.test(read('build/wallet/07-request-delivery.js')),
   'the fee a payer adds for the receiver is fee, not change');
ok(/topUpFees: 'foxy\.cashu\.topupfees'/.test(read('build/wallet/00-header-and-mint-errors.js'))
   && /topUpFeeSats: function \(\) \{/.test(read('build/wallet/22-screen-lock.js'))
   && /const off = whole \? Math\.round\(run\) \+ held \+ back \+ fees : 0;/.test(read('build/app/16-history-lists.js')),
   'the fees top-ups cost are written down and the audit counts them');
ok(/if \(!this\._lockedOnce && this\.pinLock\) this\.pinLock\(\);/.test(read('build/app/06-wallet-boot-and-restore.js')),
   'a cold launch asks for the PIN once the wallet can say one is set');
ok(/\}, 13000\);/.test(read('build/app/19-update-keypad-balance.js')) && /\}, 13000\);/.test(read('Web/foxy-receive-progress.js')),
   'STOP WAITING appears after thirteen seconds, not eight');

console.log('\n' + (failed ? failed + ' kept-token check(s) failed' : 'all kept-token checks pass'));
process.exit(failed ? 1 : 0);
