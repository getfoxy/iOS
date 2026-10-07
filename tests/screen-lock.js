'use strict';
/* screen-lock.js — what stands in front of the wallet.
 *
 *     node tests/screen-lock.js
 *
 * Foxy had two settings people both call Face ID, and until it was fixed neither
 * locked the screen:
 *
 *   - `secureChoice` is the menu's USE FACE ID switch, and it guards the SEED
 *     in the keychain, so a face was asked when money was SPENT and never for
 *     looking;
 *   - `pinBio`, later `faceInsteadOfPin`, was asked once as a PIN was set and
 *     kept by itself with no switch for it. It is gone: a phone that said yes
 *     to it opened by face with the PIN screen never showing, under a menu
 *     whose USE FACE ID was off, and only removing the PIN undid it. The
 *     switch is the one thing that says whether a face opens the screen.
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

  /* ---- one switch, and no answer kept beside it ------------------------
   *
   * There was a second Face ID setting, `faceInsteadOfPin`, stored under
   * 'foxy.pin.bio' and asked once as a PIN was set. Nothing in the menu showed
   * it, so the menu could say Face ID was off while a face opened Foxy. The
   * switch (`secureChoice`, read by `faceLock`) is all there is now. */
  {
    const { W } = wallet({});
    ok(W.faceInsteadOfPin === undefined && W.pinBio === undefined,
       'no second Face ID setting is on the wallet, under either name it had');
  }
  {
    // the phone in the report: a PIN, the switch off, and the yes it gave at set-up
    const { W } = wallet(Object.assign({ 'foxy.secure.choice': '"none"', 'foxy.pin.bio': 'true' }, PIN));
    ok(W.faceLock() === false && W.screenLocked() === true,
       'a yes an older Foxy kept does not make a face a way in while the switch is off');
  }
  {
    const { W } = wallet(Object.assign({ 'foxy.secure.choice': '"device"', 'foxy.pin.bio': 'false' }, PIN));
    ok(W.faceLock() === true,
       'and a no it kept does not hold a face back once the switch is on');
  }
  {
    // the leftover is not left to be read by something later
    const set = wallet({ 'foxy.pin.bio': 'true' });
    set.W.pinSet('4917');
    ok(set.window.localStorage.getItem('foxy.pin.bio') === null,
       'setting a PIN removes the answer an older Foxy kept',
       String(set.window.localStorage.getItem('foxy.pin.bio')));
    const gone = wallet(Object.assign({ 'foxy.pin.bio': 'true' }, PIN));
    gone.W.pinClear();
    ok(gone.window.localStorage.getItem('foxy.pin.bio') === null && gone.W.pinIsSet() === false,
       'and so does removing one');
  }
  {
    const { W } = wallet({ 'foxy.secure.choice': '"none"', 'foxy.pin.bio': 'true' });
    ok(W.screenLocked() === false,
       'with no PIN and the switch off, that old answer locks nothing either');
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

    /* The lock reads the menu's switch and nothing else, PIN or no PIN. */
    ok(!!lock && /const wanted = W\.faceLock && W\.faceLock\(\);/.test(lock[1]),
       'the lock asks faceLock whether a face is wanted, whether or not a PIN is set');
    ok(/&& W\.faceLock && W\.faceLock\(\)\) \{\s*\n?\s*face\.style\.display = 'flex';/.test(app),
       'and the USE FACE ID button on the PIN screen follows the same switch');
    ok(!/faceInsteadOfPin|\bpinBio\b/.test(app), 'nothing in the app reads a second setting');
    ok(!/Use Face ID to unlock Foxy\?/.test(app),
       'and no question about a face is put as a PIN is set');
    const bridge = fs.readFileSync(path.join(ROOT, 'Foxy', 'Bridge', 'FoxyBridge.swift'), 'utf8');
    ok(/static let biometricReasons = \["Unlock Foxy", "Leave POS mode"\]/.test(bridge),
       'so the phone has no such prompt left to show');
  }

  /* ---- the lock, run -------------------------------------------------------
   *
   * pinLock, pinOverlay and the PIN set-up from build/foxy-app.js, mounted on
   * the real wallet, with the phone's answer to a face decided here.
   *
   * The report: somebody set a PIN, let the phone scan their face when asked,
   * and from then on Foxy opened by face — the PIN screen never showed — while
   * the menu's USE FACE ID stayed off. Removing the PIN was the only way out. */
  {
    const src = fs.readFileSync(path.join(ROOT, 'build', 'foxy-app.js'), 'utf8');
    const method = (sig) => {
      const start = src.indexOf('\n  ' + sig);
      if (start < 0) throw new Error('missing ' + sig);
      let i = src.indexOf('{', start), depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
      }
      return src.slice(start + 3, i + 1);
    };
    const body = ['pinOverlay(opts) {', 'pinDismiss() {', 'pinSetup(onDone) {',
                  'pinConfirmWarning(pin, onDone) {', 'pinTry(pin) {', 'pinLock() {']
      .map(method).join(',\n');
    /* `face` is what the phone answers when a face is asked: 'yes', 'no' or
     * 'unavailable'. */
    const mount = (storage, face) => {
      const m = wallet(storage);
      const faces = [];
      m.window.webkit.messageHandlers.foxy.postMessage = (msg) => {
        if (msg.action !== 'biometric') return;
        faces.push(msg);
        m.W._scans[msg.id].ok(face);
      };
      const toasts = [], cards = [];
      const app = Object.assign(m.window.eval('(function () { return {' + body + '}; })()'), {
        haptic() {}, toast: (t) => toasts.push(t), blockedCard: (k, c) => cards.push(c),
      });
      const root = () => app._pinEl;
      const pad = () => root() && Array.from(root().children).find(d => d.style.display === 'grid');
      const button = (label) => root() && Array.from(root().children).find(d => d.textContent === label);
      const type = (pin) => {
        pin.split('').forEach(d => Array.from(pad().children).find(c => c.textContent === d)
          .dispatchEvent(new m.window.Event('pointerdown', { bubbles: true })));
        button('UNLOCK').dispatchEvent(new m.window.Event('click', { bubbles: true }));
      };
      return { app, W: m.W, window: m.window, faces, toasts, cards, root, pad, button, type };
    };
    const settle = () => new Promise(r => setTimeout(r, 5));
    const realPin = (extra) => {
      const made = wallet({});
      made.W.pinSet('4917');
      return Object.assign({ 'foxy.pin.v1': made.window.localStorage.getItem('foxy.pin.v1') }, extra);
    };

    // a PIN, the switch off: the pad, and no face
    for (const [what, extra] of [
      ['USE FACE ID off', { 'foxy.secure.choice': '"none"' }],
      ['nobody asked about Face ID', {}],
      ['USE FACE ID off and the yes an older Foxy kept', { 'foxy.secure.choice': '"none"', 'foxy.pin.bio': 'true' }],
    ]) {
      const t = mount(realPin(extra), 'yes');
      t.app.pinLock();
      await settle();
      ok(t.faces.length === 0 && t.app._pinLocked === true && !!t.pad(),
         'a PIN, ' + what + ': the PIN pad is up and no face is asked',
         t.faces.length + ' asked, locked ' + t.app._pinLocked);
      const face = t.button('USE FACE ID');
      ok(!!face && face.style.display === 'none', '  and no USE FACE ID button is offered on it',
         face ? face.style.display : 'no button');
      t.type('0000');
      ok(t.app._pinLocked === true, '  a wrong PIN leaves it locked');
      t.type('4917');
      ok(t.app._pinLocked === false && !t.root(), '  and the PIN opens it');
    }

    // a PIN, the switch on: a face first, and the PIN behind it
    {
      const t = mount(realPin({ 'foxy.secure.choice': '"device"' }), 'yes');
      t.app.pinLock();
      ok(t.faces.length === 1 && t.faces[0].reason === 'Unlock Foxy' && t.faces[0].passcode === false,
         'a PIN, USE FACE ID on: a face is asked as the lock comes up, biometrics only',
         JSON.stringify(t.faces));
      await settle();
      ok(t.app._pinLocked === false && !t.root(), '  and the face opens Foxy');
    }
    {
      const t = mount(realPin({ 'foxy.secure.choice': '"device"', 'foxy.pin.bio': 'false' }), 'no');
      t.app.pinLock();
      await settle();
      ok(t.faces.length === 1 && t.app._pinLocked === true && !!t.pad(),
         'a face that will not scan leaves the PIN pad, still locked');
      const face = t.button('USE FACE ID');
      ok(!!face && face.style.display === 'flex', '  with a USE FACE ID button to ask again',
         face ? face.style.display : 'no button');
      face.dispatchEvent(new t.window.Event('click', { bubbles: true }));
      await settle();
      ok(t.faces.length === 2 && t.app._pinLocked === true, '  which asks, and a second no changes nothing');
      t.type('4917');
      ok(t.app._pinLocked === false && !t.root(), '  and the PIN opens it');
    }
    {
      const t = mount(realPin({ 'foxy.secure.choice': '"device"' }), 'unavailable');
      t.app.pinLock();
      await settle();
      ok(t.app._pinLocked === true && !!t.pad(),
         'a phone that cannot check a face does not open a screen a PIN is on');
    }

    // no PIN, the switch on: the face is the lock, and the passcode may stand in
    {
      const t = mount({ 'foxy.secure.choice': '"device"' }, 'yes');
      t.app.pinLock();
      ok(t.faces.length === 1 && t.faces[0].passcode === true && !t.pad(),
         'no PIN, USE FACE ID on: the face is the lock, with the passcode behind it and no keypad',
         JSON.stringify(t.faces));
      await settle();
      ok(t.app._pinLocked === false, '  and it opens');
    }

    // setting a PIN asks nothing about a face, and keeps nothing about one
    for (const [what, extra, on] of [
      ['USE FACE ID off', { 'foxy.secure.choice': '"none"' }, false],
      ['nobody asked about Face ID', {}, false],
      ['USE FACE ID on', { 'foxy.secure.choice': '"device"' }, true],
    ]) {
      const t = mount(extra, 'yes');
      let done = null;
      t.app.pinConfirmWarning('4917', (v) => { done = v; });
      t.cards[0].go();
      await settle();
      ok(t.W.pinIsSet() === true && done === true && t.faces.length === 0,
         'setting a PIN with ' + what + ' asks for no face', t.faces.length + ' asked');
      ok(t.toasts.join('|') === 'PIN set' && t.window.localStorage.getItem('foxy.pin.bio') === null
         && t.W.faceLock() === on,
         '  and leaves the switch as it was, with nothing kept beside it',
         t.toasts.join('|') + ' / faceLock ' + t.W.faceLock());
    }

    // what the PIN is said to be for, at the moment it is chosen
    {
      const off = mount({ 'foxy.secure.choice': '"none"' }, 'yes');
      off.app.pinSetup();
      ok(/You will enter this every time you open Foxy\./.test(off.root().textContent),
         'choosing a PIN with USE FACE ID off says it is entered at every opening');
      const on = mount({ 'foxy.secure.choice': '"device"' }, 'yes');
      on.app.pinSetup();
      ok(/It opens Foxy when Face ID does not\./.test(on.root().textContent)
         && !/every time/.test(on.root().textContent),
         'and with it on, that it opens Foxy when a face does not');
    }
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
    /* And the phone's cover over the return comes off the lock at once. The
     * connection screen, which is what tells the phone the page has the
     * screen, waits for the unlock; so nothing said it, and the splash sat
     * over the PIN pad until the phone's own four seconds were up. */
    ok(/this\.pinLock\(\);[\s\S]{0,500}?if \(this\._pinLocked && window\.FoxyGate && window\.FoxyGate\.uncover\) window\.FoxyGate\.uncover\(\);/.test(wake),
       'with the phone told at once that the lock has the screen, so its cover does not sit over the PIN pad');
  }

  console.log('\n' + (failures ? failures + ' failed' : 'all screen lock checks pass'));
  process.exit(failures ? 1 : 0);
})();
