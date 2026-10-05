'use strict';
/* screen-lock.js — what stands in front of the wallet.
 *
 *     node tests/screen-lock.js
 *
 * Foxy has two settings people both call Face ID, and until it was fixed neither
 * locked the screen:
 *
 *   - `secureChoice` is the menu's Face ID row, and it guards the SEED in
 *     the keychain, so a face was asked when money was SPENT and never for
 *     looking;
 *   - `pinBio` only put a Face ID button on the PIN's lock screen, so it did
 *     nothing at all without a PIN. It is `faceInsteadOfPin` now, and it is
 *     kept rather than folded into the other one: it is the only thing that
 *     says whether a face may open a screen a PIN is already on.
 *
 * And `pinLock()` opened with `if (!W.pinIsSet()) return`. So on a
 * phone — Face ID on, no PIN — killing Foxy and opening it again showed the
 * balance, the history and the mint with nothing asked.
 *
 * These run the real Web/foxy-wallet.js in jsdom against a fake native side,
 * and then read build/foxy-app.js for the parts of pinLock that are drawn
 * rather than computed. */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (c, msg, detail) => {
  console.log((c ? 'ok   ' : 'FAIL ') + msg + (detail && !c ? ' — ' + detail : ''));
  if (!c) failures++;
};

/* The wallet alone, with whatever is already in storage. */
function wallet(storage) {
  const dom = new JSDOM('<body></body>', {
    runScripts: 'dangerously', url: 'https://foxy.test/', pretendToBeVisual: true,
  });
  const w = dom.window;
  w.CashuTS = {};
  const asked = [];
  w.webkit = { messageHandlers: { foxy: { postMessage: m => asked.push(m) } } };
  Object.keys(storage || {}).forEach(k => w.localStorage.setItem(k, storage[k]));
  w.eval(fs.readFileSync(path.join(ROOT, 'Web', 'foxy-wallet.js'), 'utf8'));
  return { W: w.FoxyWallet, asked, window: w };
}

const PIN = { 'foxy.pin.v1': JSON.stringify({ salt: 'aa', hash: 'bb' }) };

(async () => {
  // ---- what counts as a lock ------------------------------------------
  {
    /* A lock nobody chose is not security, it is an obstacle with the person's
     * money behind it. This read `secureChoice() !== 'none'`, and nobody having
     * been asked is '', so an unconfigured wallet locked its screen behind a
     * face by default — Face ID on opening, on returning, at moments the person
     * had never agreed to guard ("FACE ID should not be
     * asked by default ... it should be enabled by user in menu"). */
    const { W } = wallet({});
    ok(W.faceLock() === false,
       'a phone whose user has never chosen is not locked behind a face',
       'faceLock() = ' + W.faceLock());
    ok(W.screenLocked() === false,
       'and nothing stands in front of the wallet until they ask for it');
  }
  {
    const { W } = wallet({ 'foxy.secure.choice': '"device"' });
    ok(W.faceLock() === true && W.screenLocked() === true,
       'Face ID chosen, no PIN: the screen is locked');
  }
  {
    const { W } = wallet({ 'foxy.secure.choice': '"none"' });
    ok(W.faceLock() === false && W.screenLocked() === false,
       'NO PROTECTION chosen, no PIN: nothing stands in front, as asked');
  }
  {
    const { W } = wallet(Object.assign({ 'foxy.secure.choice': '"none"' }, PIN));
    ok(W.screenLocked() === true,
       'a PIN alone still locks the screen, whatever was said about Face ID');
  }
  {
    const { W } = wallet(Object.assign({ 'foxy.secure.choice': '"device"' }, PIN));
    ok(W.screenLocked() === true, 'both together, still locked');
  }

  /* ---- a face instead of the PIN --------------------------------------
   *
   * The second Face ID setting, renamed from `pinBio` and kept.
   * It answers a question the seed's guard does not: a PIN is on the screen
   * already — may a face be shown instead of typing it? Somebody sets a PIN
   * because a face is the one key that can be taken from them while they hold
   * the phone, so this must not follow secureChoice. Off unless they said yes.
   *
   * The stored key stays 'foxy.pin.bio' so no install has to be migrated.
   *
   * Web/foxy-wallet.js is joined from build/wallet/*.js, so until it is joined
   * again these read the old name and there is nothing to test. Say so once
   * rather than throwing over every case. */
  const renamed = typeof wallet({}).W.faceInsteadOfPin === 'function';
  ok(renamed, 'faceInsteadOfPin is on the wallet (join Web/foxy-wallet.js again if not)');
  if (renamed) {
  {
    const { W } = wallet({});
    ok(W.faceInsteadOfPin() === false,
       'a face does not open a PIN screen unless they asked for it',
       'faceInsteadOfPin() = ' + W.faceInsteadOfPin());
    ok(W.pinBio === undefined, 'and the old name is gone rather than left as a second way in');
  }
  {
    // Face ID guards the seed, and they were never asked about the PIN screen
    const { W } = wallet(Object.assign({ 'foxy.secure.choice': '"device"' }, PIN));
    ok(W.faceLock() === true && W.faceInsteadOfPin() === false,
       'a face on the keychain does not silently become a way past the PIN');
  }
  {
    // the answer an existing install already gave, under the key it gave it in
    const yes = wallet(Object.assign({ 'foxy.pin.bio': 'true' }, PIN));
    ok(yes.W.faceInsteadOfPin() === true,
       'an install that said yes keeps its Face ID shortcut without being migrated');
    const no = wallet(Object.assign({ 'foxy.pin.bio': 'false' }, PIN));
    ok(no.W.faceInsteadOfPin() === false, 'and one that said no keeps its answer too');
  }
  {
    const { W, window: win } = wallet(PIN);
    W.faceInsteadOfPin(true);
    ok(win.localStorage.getItem('foxy.pin.bio') === 'true' && W.faceInsteadOfPin() === true,
       'it is still written where it was read, so nothing needs migrating either way',
       String(win.localStorage.getItem('foxy.pin.bio')));
    W.faceInsteadOfPin(false);
    ok(W.faceInsteadOfPin() === false, 'and it can be taken off again');
  }
  {
    // it says nothing about the screen on its own: with no PIN, faceLock rules
    const { W } = wallet({ 'foxy.secure.choice': '"none"', 'foxy.pin.bio': 'true' });
    ok(W.screenLocked() === false,
       'a Face ID shortcut past a PIN that is not set is not a lock by itself');
  }
  }

  // ---- the passcode may stand in for a face ---------------------------
  {
    const { W, asked } = wallet({ 'foxy.secure.choice': '"device"' });
    W.biometric('Unlock Foxy', true);
    const m = asked[asked.length - 1];
    ok(m && m.action === 'biometric' && m.passcode === true,
       'the lock may fall back to the phone passcode',
       JSON.stringify(m));
    W.biometric('Unlock Foxy');
    const n = asked[asked.length - 1];
    ok(n && n.passcode === false,
       'and nothing else does — a second check in front of one action stays biometrics only');
  }

  // ---- what pinLock and the overlay actually do -----------------------
  {
    const app = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
    const lock = /\n  pinLock\(\) \{([\s\S]*?)\n  \}\n/.exec(app);
    ok(!!lock && /if \(!W \|\| !W\.screenLocked \|\| !W\.screenLocked\(\)\) return;/.test(lock[1]),
       'pinLock stands on screenLocked, not on a PIN alone');
    ok(!!lock && /const byFaceAlone = !W\.pinIsSet\(\);/.test(lock[1]),
       'and knows when a face is the only way in');
    ok(!!lock && /W\.biometric\('Unlock Foxy', byFaceAlone\)/.test(lock[1]),
       'which is exactly when the passcode is allowed');
    ok(!!lock && /answer === 'unavailable' && byFaceAlone[\s\S]{0,700}?unlocked\(\);/.test(lock[1]),
       'a phone that can check neither face nor passcode is let in rather than stranded');
    ok(!!lock && /noKeypad: byFaceAlone/.test(lock[1]),
       'and no dead keypad is drawn when there is no PIN to type');
    ok(/if \(!o\.noKeypad\) root\.appendChild\(pad\);/.test(app),
       'the overlay honours it');
    ok(/if \(o\.noKeypad\) \{ if \(o\.face\) o\.face\(\); return; \}/.test(app),
       'and its button asks for the face again instead of submitting nothing');

    /* Which of the two settings the lock reads, and when. With no PIN the
     * face IS the lock (faceLock); with a PIN it is a shortcut past it, and
     * only where they asked for one (faceInsteadOfPin). Reading faceLock in
     * both places would open a screen that today only the PIN opens. */
    ok(!!lock && /byFaceAlone \? W\.faceLock && W\.faceLock\(\)\s*\n?\s*: W\.faceInsteadOfPin && W\.faceInsteadOfPin\(\)/.test(lock[1]),
       'the lock asks faceLock when a face is all there is, and faceInsteadOfPin when a PIN is set');
    ok(!!lock && !/W\.pinBio/.test(lock[1]), 'and nothing still reads the old name');
    ok(/W\.faceInsteadOfPin && W\.faceInsteadOfPin\(\)\) \{\s*\n?\s*face\.style\.display = 'flex';/.test(app),
       'the USE FACE ID button on the PIN screen is drawn only where they asked for it');
    ok(/W\.faceInsteadOfPin\(answer === 'yes'\);/.test(app),
       'and setting a PIN is where that answer is given');
    ok(!/\bpinBio\b/.test(app), 'the old name is gone from the app as well');
  }

  /* ---- the menu says what the tap does, not what is on ------------------
   *
   * 'FACE ID OFF' sat directly under 'SET PIN'. One of those is plainly an
   * action, so the other reads as a state — and it says the opposite of the
   * truth: it appears when Face ID is ON. A row that lies about a lock is
   * worse than no row. Read from the source rather than the built app, and
   * evaluated, so this is about which label appears when, not about text. */
  {
    const vals = fs.readFileSync(path.join(ROOT, 'build', 'app', '21-render-values.js'), 'utf8');
    /* The label expression is the one immediately above that row's icon. */
    const labelFor = (icon) => {
      const at = vals.indexOf('path: MENU_ICON.' + icon + ',');
      if (at < 0) return null;
      const head = vals.slice(0, at);
      const li = head.lastIndexOf('label:');
      if (li < 0) return null;
      const expr = head.slice(li + 'label:'.length).replace(/,\s*$/, '').trim();
      const fn = new Function('window', 'return (' + expr + ');');
      return (state) => fn({ FoxyWallet: state });
    };

    const pin = labelFor('lock');
    ok(!!pin, 'the PIN row is still there');
    if (pin) {
      const off = pin({ pinIsSet: () => false }), on = pin({ pinIsSet: () => true });
      ok(off === 'SET PIN', 'no PIN: SET PIN', String(off));
      ok(on === 'REMOVE PIN', 'a PIN: REMOVE PIN, not the state "PIN OFF"', String(on));
    }

    const face = labelFor('faceid');
    ok(!!face, 'the Face ID row is still there');
    if (face) {
      /* A switch now: the label never changes, and the switch says the state,
       * so there is no "FACE ID OFF" to misread. */
      const off = face({ secureChoice: () => 'none' });
      const on = face({ secureChoice: () => 'device' });
      ok(off === 'USE FACE ID' && on === 'USE FACE ID', 'Face ID is one label, USE FACE ID, whichever way it is',
         [off, on].join(' / '));
      ok(/const faceOn = !!\(W22 && W22\.secureChoice && W22\.secureChoice\(\) === 'device'\)/.test(vals)
         && /\}, sw\(faceOn\)\)/.test(vals),
         'and its switch is on only when the answer is `device` — nobody having answered reads as off');
    }
  }

  // ---- the wait after a wrong PIN -------------------------------------
  /* DEVICE-TESTS §8, which nothing tested. The count lives in storage rather
   * than in memory, because closing Foxy and opening it again used to give
   * five fresh tries; and while a wait runs the PIN is not checked at all,
   * however many are typed. */
  {
    const { W, window: win } = wallet({});
    W.pinSet('4917');
    const wrong = () => W.pinAttempt('0000');

    ok(W.pinIsSet() === true, 'a PIN can be set');
    ok(W.pinAttempt('4917').ok === true, 'and the right one opens it');

    let last = null;
    for (let i = 1; i <= 5; i++) last = wrong();
    ok(last.tries === 5 && last.ok === false, 'five tries are free', JSON.stringify(last));

    /* The fifth miss is the one that starts the wait, so the sixth attempt —
     * made straight after it — is refused without being checked at all, with
     * what is left of the second on it. */
    const six = wrong();
    ok(six.locked === true && six.waitMs > 0 && six.waitMs <= 1000,
       'the sixth is refused unchecked, inside the second the fifth started',
       JSON.stringify(six));

    // while the wait runs, even the RIGHT pin is refused and not checked
    const during = W.pinAttempt('4917');
    ok(during.ok === false && during.locked === true,
       'the right PIN is refused while the wait runs, and not even checked',
       JSON.stringify(during));

    // the doubling
    const rec = () => JSON.parse(win.localStorage.getItem('foxy.pin.tries'));
    const waits = [];
    for (let i = 0; i < 4; i++) {
      const r = rec();
      win.localStorage.setItem('foxy.pin.tries', JSON.stringify({ n: r.n, at: 0, up: 0 }));
      waits.push(wrong().waitMs);
    }
    ok(waits.join(',') === '2000,4000,8000,16000',
       'and then it doubles: 1s, 2s, 4s, 8s, 16s', waits.join(','));
    ok(W._pinWait(100) === W.PIN_MAX_WAIT_MS, 'up to an hour and no further');

    // a force quit is a new page, and the count must survive it
    const kept = win.localStorage.getItem('foxy.pin.tries');
    const again = wallet({ 'foxy.pin.v1': win.localStorage.getItem('foxy.pin.v1'),
                           'foxy.pin.tries': kept });
    const after = again.W.pinAttempt('4917');
    ok(after.ok === false && after.locked === true,
       'and a force quit does not give five fresh tries',
       JSON.stringify(after));

    // the person proving themselves clears it
    again.W.pinTriesClear();
    ok(again.W.pinAttempt('4917').ok === true,
       'Face ID, or a new PIN, starts the count again');
  }

  // ---- a clock moved forward does not skip the wait --------------------
  {
    const { W, window: win } = wallet({});
    W.pinSet('4917');
    for (let i = 0; i < 6; i++) W.pinAttempt('0000');
    const r = JSON.parse(win.localStorage.getItem('foxy.pin.tries'));
    // the phone says only a moment has passed, whatever the clock says
    win.__foxyUptime = { s: 0, p: win.performance.now() };
    win.localStorage.setItem('foxy.pin.tries',
      JSON.stringify({ n: r.n, at: Date.now() - 3600000, up: 0 }));
    const jumped = W.pinAttempt('4917');
    ok(jumped.ok === false && jumped.locked === true,
       'an hour added to the clock does not skip the wait; uptime is believed too',
       JSON.stringify(jumped));
  }

  // ---- the lock is still the first thing that runs --------------------
  {
    const life = fs.readFileSync(path.join(ROOT, 'build', 'app', '18-lifecycle-and-chart.js'), 'utf8');
    ok(/before anything else is usable[\s\S]{0,80}this\.pinLock\(\);/.test(life),
       'the lock runs at launch, before the Tor gate and the home screen');
    const wake = fs.readFileSync(path.join(ROOT, 'build', 'app', '15-paid-wake-keyboard.js'), 'utf8');
    ok(/this\.pinLock\(\);/.test(wake), 'and again on every return from the background');
  }

  console.log('\n' + (failures ? failures + ' failed' : 'all screen lock checks pass'));
  process.exit(failures ? 1 : 0);
})();
