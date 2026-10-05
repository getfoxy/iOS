'use strict';
/* backup-logic.js — the seed backup, run outside the page.
 *
 *     node tests/backup-logic.js
 *
 * showSeedOnPhone, showVerify, goBkPhrase and showSeed's guard from
 * build/foxy-app.js, against a stand-in app and wallet. A
 * security report found the export's twelve demo words shown as the person's
 * seed, and passing the quiz. The page now has no words at all, demo or real:
 * the words and their quiz are the phone's screens, and only a quiz passed
 * there marks the wallet backed up (the wallet's showSeedNative sets it). */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'build', 'foxy-app.js'), 'utf8');
function block(start) {
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
function method(sig) {
  const at = src.indexOf('\n  ' + sig);
  if (at < 0) throw new Error('missing ' + sig);
  return block(at + 3);
}
const methods = new Function('return {' + [method('showSeedOnPhone(verify, then) {'), method('showVerify() {'),
  method('showSeed() {')].join(',\n') + '}')();

const results = [];
const check = (name, ok, detail) => results.push((ok ? 'ok    ' : 'FAIL  ') + name + (ok ? '' : '  — ' + detail));

function app(wallet) {
  global.window = wallet === undefined ? {} : { FoxyWallet: wallet };
  return Object.assign({ toasts: [], toast(m, amber) { this.toasts.push([m, !!amber]); } }, methods);
}
const wallet = (answer) => ({
  asked: [],
  showSeedNative(o) { this.asked.push(o); return typeof answer === 'function' ? answer() : Promise.resolve(answer); },
  reason: (e) => (e && e.message) || String(e),
});

(async () => {
  // 1. no words in the page, demo or real
  check('the export\'s demo words are gone', !/BK_PHRASE|BK_SCRAMBLE/.test(src) && !/'absurd','gravity','pelican'/.test(src), 'still in build/foxy-app.js');
  check('nothing in the app reads the words or has a quiz of its own', !/seedWords|bkTapWord|bkShuffled|bkPhrase\(/.test(src), 'still there');
  check('the page never marks the backup itself', !/setBackedUp\(/.test(src), 'setBackedUp is called in the app');

  // 2. the phone's quiz, passed: said, and the answer passed on
  {
    const W = wallet({ verified: true });
    const a = app(W);
    let heard = null;
    const r = await a.showSeedOnPhone(true, (x) => { heard = x; });
    check('a quiz passed on the phone is said and passed on', r && r.verified && heard === r && /checked/.test((a.toasts[0] || [])[0]),
      JSON.stringify({ r, toasts: a.toasts }));
    check('the phone was asked for its quiz', W.asked.length === 1 && W.asked[0].verify === true, JSON.stringify(W.asked));
  }
  // 3. not passed, or refused: nothing said to be checked
  {
    const W = wallet({ verified: false });
    const a = app(W);
    const r = await a.showSeedOnPhone(true);
    check('a quiz not passed says nothing is checked', r && !r.verified && !a.toasts.length, JSON.stringify(a.toasts));
    const refused = app(wallet(() => Promise.reject(new Error('cancelled'))));
    let heard = 'not called';
    const r2 = await refused.showSeedOnPhone(false, (x) => { heard = x; });
    check('a refusal from the phone is a toast, and nothing else', r2 === null && heard === 'not called'
      && refused.toasts.length === 1 && refused.toasts[0][0] === 'cancelled' && refused.toasts[0][1], JSON.stringify(refused.toasts));
  }
  // 4. verify is the phone's quiz
  {
    const W = wallet({ verified: true });
    const a = app(W);
    await a.showVerify();
    check('verify asks the phone for its quiz', W.asked.length === 1 && W.asked[0].verify === true, JSON.stringify(W.asked));
  }
  // 5. a phone whose wallet script failed to load: nothing to show, nothing to verify (review of af333d8, finding 13)
  for (const [label, w] of [['a phone with no wallet', undefined], ['a wallet with no way to the phone\'s screens', {}]]) {
    const a = app(w);
    let threw = null;
    try { a.showSeed(); } catch (e) { threw = e; }
    check(label + ': BACKUP says it is not available and draws nothing', !threw && a.toasts.length === 1 && /not available/.test(a.toasts[0][0]),
      JSON.stringify({ threw: threw && threw.message, toasts: a.toasts }));
  }
  // 6. bkStart's button opens the phone's screen
  check('bkStart\'s button opens BACKUP, the phone\'s screen', /goBkPhrase: \(\) => this\.showSeed\(\),/.test(src), 'goBkPhrase is not this.showSeed()');

  results.forEach(r => console.log(r));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(failed ? failed + ' backup logic check(s) failed' : 'all backup logic checks pass');
  process.exit(failed ? 1 : 0);
})();
