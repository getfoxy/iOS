'use strict';
/* claim-guards.js — one claim at a time, and everyone hears the answer.
 *
 *     node tests/claim-guards.js
 *
 * takingToken (build/app/09-melt-paste-switch.js) and the shared melt sweep
 * (build/wallet/15-receiving.js). Both are the same bug in two places: work
 * that takes seconds, guarded by something that does not last that long — or
 * not guarded at all — so a second start races the first. Once that
 * cost a paste that ran twice; the melt sweep's version quietly tells a caller
 * that nothing settled when another sweep settled it.
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
const R = { pass: 0, fail: 0 };
function check(name, ok, detail) {
  if (ok) { R.pass++; console.log('  OK    ' + name + (detail ? ' — ' + detail : '')); }
  else { R.fail++; console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
const guard = new Function('return {' + method('takingToken(run) {') + '}')();
const MAX = Number(/TOKEN_CLAIM_MAX_MS = (\d+)/.exec(src)[1]);
const app = () => Object.assign({ TOKEN_CLAIM_MAX_MS: MAX }, guard);
const later = ms => new Promise(ok => setTimeout(ok, ms));

(async () => {
  // ---- the guard lasts as long as the claim does ----------------------
  {
    const a = app();
    let done;
    const claim = new Promise(ok => { done = ok; });
    let started = 0;
    check('the first claim starts', a.takingToken(() => { started++; return claim; }) === true);
    check('a second start while it runs is refused',
      a.takingToken(() => { started++; return claim; }) === false, started + ' started');
    await later(30);
    check('and still refused a moment later — no timer lets it through',
      a.takingToken(() => { started++; return claim; }) === false, started + ' started');
    done();
    await later(0);
    check('once the claim finishes, the next one may start',
      a.takingToken(() => { started++; return Promise.resolve(); }) === true, started + ' started');
  }

  // ---- a claim that fails still frees the door -------------------------
  {
    const a = app();
    a.takingToken(() => Promise.reject(new Error('mint said no')).catch(() => {}));
    await later(0);
    check('a refused claim does not lock the door behind it',
      a.takingToken(() => Promise.resolve()) === true);
  }
  {
    const a = app();
    try { a.takingToken(() => { throw new Error('threw at once'); }); } catch (e) {}
    check('nor does one that throws before it starts',
      a.takingToken(() => Promise.resolve()) === true);
  }

  // ---- deciding not to claim is not a claim ---------------------------
  {
    const a = app();
    a.takingToken(() => null);            // offerNewMint took over, say
    check('a run that claims nothing frees the door at once',
      a.takingToken(() => Promise.resolve()) === true);
  }

  // ---- the backstop cannot fire during a real claim -------------------
  {
    check('the backstop is far longer than a claim over Tor takes',
      MAX >= 30000, MAX + 'ms, against the 4-6s a swap takes');
    const old = /setTimeout\(\(\) => \{ this\._pasting = false; \}, 1500\)/.test(src);
    check('the 1.5-second flag that expired mid-claim is gone', !old);
  }

  // ---- both doors share it --------------------------------------------
  {
    const doors = ['takeTokenFromPaste(text) {', 'pasteEcashToken() {']
      .filter(sig => /this\.takingToken\(/.test(method(sig)));
    check('both ways into a token claim take the same guard',
      doors.length === 2, doors.length + ' of 2');
  }

  // ---- the melt sweep hands its answer to everyone who asks ------------
  {
    const w = fs.readFileSync(path.join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8');
    check('sweepMelts shares one walk rather than starting a second',
      /sweepMelts: function \(\) \{[\s\S]{0,200}?if \(sweeping\) return sweeping;/.test(w));
    check('and the proof lock holds the inner walk, not the sharing',
      /'_sweepMeltsOnce'/.test(w) && !/'sweepMelts',/.test(w),
      'the lock must not make the second caller wait for an emptied list');
  }

  // ---- the overlay outlasts the work it covers -------------------------
  {
    const dflt = Number(/MELT_PATIENCE_MS = (\d+)/.exec(src)[1]);
    check('the default backstop is unchanged for the short waits', dflt === 45000, dflt + 'ms');
    /* A delivered payment is no longer covered by the overlay at all: it shows
     * the sending screen, the same one a Lightning send shows, which has no
     * patience timer to outlast. So what is guarded now is
     * that it did not quietly go back to an overlay whose backstop is shorter
     * than the delivery — which is the bug the old pair of checks existed for.
     * The onion retries for 90s inside a 130s bridge call; 45s of overlay would
     * be stripped in the middle of it. */
    check('a delivered payment shows the sending screen, not a timed overlay',
      /if \(direct\) \{[\s\S]{0,400}?screen: 'sendDone'[\s\S]{0,120}?sendPhase: 'in'/.test(src)
        && !/showMelt\(direct \?/.test(src));
    const w = fs.readFileSync(path.join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8');
    const reach = Number(/ONION_REACH_MS = (\d+)/.exec(w)[1]);
    check('and no overlay shorter than the delivery covers one',
      !/showMelt\([^)]*\b(\d{4,5})\b/.test(src) || Number(/showMelt\([^)]*\b(\d{4,5})\b/.exec(src)[1]) > reach,
      reach + 'ms of retries');
  }

  // ---- a claim that already landed is not lost money -------------------
  {
    const w = fs.readFileSync(path.join(__dirname, '..', 'Web', 'foxy-wallet.js'), 'utf8');
    check('a claim that succeeds writes down that it did',
      /noteClaimed\(quoteId, sumProofs\(fresh\)\)/.test(w));
    check('and the no-such-invoice path asks before crying loss',
      /var done = claimedMomentsAgo\(quoteId\);[\s\S]{0,240}?return Promise\.resolve\(done\.sats\);/.test(w),
      'the split reconcile and the screen watcher ask each other this');
    check('the memory is short enough not to hide a real loss',
      /CLAIMED_JUST_NOW_MS = (\d+)/.test(w) && Number(RegExp.$1) <= 300000,
      RegExp.$1 + 'ms');
    check('the words about restoring from twelve are still there for a real miss',
      /twelve words will find it/.test(w));
  }

  console.log('\n' + (R.fail ? R.pass + ' passed, ' + R.fail + ' failed' : 'all ' + R.pass + ' claim guard checks pass'));
  process.exit(R.fail ? 1 : 0);
})();
