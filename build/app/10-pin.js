
  // Retry banner, built in plain DOM so it does not depend on the design
  // runtime re-rendering.
  /* A failure, over the screen it happened on.
   *
   * The BLOCKED entries were designed as full screens. As screens they render
   * black here, and they take the whole view for something that should not
   * cost you the amount you just typed. Same words, same tone, same retry
   * target — as a card.
   *
   * Plain DOM on document.body, so it does not depend on the design runtime,
   * and therefore outside the theme scope: every colour here is literal.
   */
  /* The lock, and the flow that sets it up.
   *
   * These are DOM overlays rather than template screens: the lock has to be
   * up before the app is usable, including before the gate, and an overlay
   * does not wait on a render. It is the same approach blockedCard uses.
   */
  /* ---- SECURE FOXY: what stands in front of the wallet ---------------------
   *
   * Shown once, when the first money has landed and its confirmation has been
   * dismissed (paidDismissed). Before that there is nothing to protect and the
   * ask is friction in front of somebody who has not started; after it, Face ID starts being asked on every return to the
   * foreground, and this is where that is explained rather than sprung.
   *
   * Three answers, and none of them is a trap:
   *
   *   FACE ID        the seed stays behind .userPresence, which is what every
   *                  Foxy did before there was a choice
   *   FOXY PIN       a code for Foxy itself — the only one of the three that
   *                  helps when somebody is holding the phone already unlocked
   *   NO PROTECTION  the seed moves to the older keychain item, which the
   *                  phone's own lock screen protects and nothing else
   *
   * The last one is a deliberate choice, and it really is none: it would be
   * worse to offer it and still ask for Face ID on every return. The card says
   * what it costs, it is never the default, and MENU > SECURITY changes it
   * later.
   */
  SECURE_ASKED = 'foxy.secure.asked';

  /* Due once: money has arrived, and this has never been shown. */
  secureCardDue() {
    const W = window.FoxyWallet;
    if (!W || !W.bridged || !W.bridged()) return false;
    try { if (localStorage.getItem(this.SECURE_ASKED)) return false; } catch (e) { return false; }
    // the figure the screen is showing, which is an object of both units
    return (this.balNow().sats || 0) > 0;
  }

  secureCardShown() {
    try { localStorage.setItem(this.SECURE_ASKED, String(Date.now())); } catch (e) {}
  }

  offerSecureFoxy() {
    if (!this.secureCardDue()) return;
    this.secureCardShown();
    const W = window.FoxyWallet;
    this.blockedCard('secureFoxy', {
      tone: 'ask',
      title: 'SECURE FOXY',
      reason: 'You have bitcoin in Foxy now. What should stand in front of it?',
      chip: 'Face ID also guards your twelve words. With no protection, nothing does.',
      retry: 'USE FACE ID',
      go: () => this.chooseProtection('device'),
      shut: { label: 'SET A FOXY PIN', tap: () => this.pinSetup(() => {}) },
      also: { label: 'NO PROTECTION', tap: () => this.confirmNoProtection() },
    });
  }

  /* Never on one tap: this is the one choice that takes a guard off. */
  /* Reached from the SECURE FOXY card and from MENU > STOP FACE ID, so it says
   * what it costs rather than what to pick. */
  confirmNoProtection() {
    this.blockedCard('noProtection', {
      tone: 'warn',
      title: 'NO PROTECTION?',
      reason: 'Anyone holding your phone unlocked will be able to spend what is in '
        + 'Foxy and read your twelve words.',
      chip: 'MENU \u203a USE FACE ID turns it back on.',
      retry: 'KEEP FACE ID',
      go: () => this.chooseProtection('device'),
      shut: { label: 'TURN IT OFF', tap: () => this.chooseProtection('none') },
    });
  }

  chooseProtection(mode) {
    const W = window.FoxyWallet;
    if (!W || !W.setSeedProtection) return;
    W.setSeedProtection(mode).then(() => {
      // what they answered, which openSeedForVisit reads on every wake
      if (W.secureChoice) W.secureChoice(mode);
      /* Says what it now does, which is more than it used to: this answer
       * locks the screen as well as the seed. */
      this.toast(mode === 'none' ? 'Foxy is not protected.' : 'Face ID now locks Foxy.');
      this.forceUpdate();
    }, e => {
      this.toast(W.reason ? W.reason(e) : 'That could not be changed.', true);
    });
  }

  /* Three things a card's PIN pad asks of this one (26f-flashcard.js), none
   * of which the lock uses:
   *   `o.warn`  a line already in red when the pad comes up: a wrong PIN, said
   *             on the pad that asks for it again;
   *   `o.back`  a back button at the top left, where every screen's is, in
   *             place of CANCEL at the bottom;
   *   `o.gate`  the button is grey and does nothing until four digits are in,
   *             because it says what the PIN will do ("PAY $0.43") and must
   *             not look ready before it is. */
  pinOverlay(opts) {
    const o = opts || {};
    if (this._pinEl) this._pinEl.remove();

    const el = (style, text) => {
      const d = document.createElement('div');
      d.style.cssText = style;
      if (text != null) d.textContent = text;
      return d;
    };

    // Above everything the page draws: the seed screens (2147483550), the
    // delete prompts (2147483600) and the Tor gate (2147483602) included.
    const root = el('position:fixed;inset:0;z-index:2147483647;background:var(--bg,#050505);'
      + 'display:flex;flex-direction:column;align-items:center;justify-content:flex-start;'
      // under the back button's row, where there is one
      + 'padding:' + (o.back ? '118px' : '76px') + ' 26px 26px;box-sizing:border-box;'
      /* No fade for the lock. It is a cover, drawn under the phone's own
       * cover before that comes off, and its fade-in showed the home screen
       * through it for a moment: the connection screen used to sit underneath
       * and hide that, and opens on the home screen now. */
      + 'font-family:SatSymbol,Sora,system-ui,sans-serif'
      + (o.cover ? '' : ';animation:foxyIn .16s ease'));

    const title = el('font-size:26px;font-weight:800;letter-spacing:-0.02em;'
      + 'color:var(--ink,#F5F1EC);text-align:center', o.title || '');
    const sub = el('margin-top:10px;font-size:17px;font-weight:500;line-height:1.4;'
      + 'color:rgba(245,241,236,.6);text-align:center;text-wrap:pretty', o.subtitle || '');
    root.appendChild(title);
    root.appendChild(sub);

    // the dots
    const dots = el('display:flex;gap:14px;margin-top:38px;height:18px;align-items:center');
    root.appendChild(dots);

    const note = el('margin-top:18px;min-height:22px;font-size:16px;font-weight:700;'
      + 'color:#FF5C5C;text-align:center', o.warn || '');
    root.appendChild(note);

    let entry = '';
    const MAXLEN = 8;

    const paint = () => {
      dots.textContent = '';
      const n = Math.max(entry.length, 4);
      for (let i = 0; i < n; i++) {
        const filled = i < entry.length;
        dots.appendChild(el('width:14px;height:14px;border-radius:50%;'
          + (filled ? 'background:var(--acc,#F2802E)'
                    : 'background:transparent;border:2px solid rgba(245,241,236,.28)')));
      }
    };
    if (!o.noKeypad) paint();
    /* Whether the button may be pressed (`o.gate`), drawn with every key. Set
     * once the button exists, further down. */
    let ready = () => {};

    // the keypad
    /* The whole cell takes the touch, not only the round key drawn in it.
     *
     * The keys were 66 high with 14 between them, and the 14 was dead: a thumb
     * landing between two keys pressed neither. And they waited for a click,
     * which iOS gives only for a touch that barely moves and ends alone, so a
     * quick second key, or a thumb that slid a little, was a tap that did
     * nothing. Now the cells meet edge to edge, a key takes the touch the
     * moment it lands, and it turns orange while it is down so there is no
     * doubt it was felt. */
    const pad = el('margin-top:auto;display:grid;grid-template-columns:repeat(3,1fr);'
      + 'width:100%;max-width:336px;touch-action:manipulation;'
      + '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none');
    const key = (label, onTap, quiet) => {
      const k = el('height:80px;display:flex;align-items:center;justify-content:center;'
        + 'cursor:pointer;-webkit-tap-highlight-color:transparent');
      const rest = quiet ? 'transparent' : 'rgba(245,241,236,.08)';
      const ink = quiet ? 'rgba(245,241,236,.55)' : 'var(--ink,#F5F1EC)';
      const face = el('flex:1;margin:0 7px;height:66px;border-radius:33px;display:flex;align-items:center;'
        + 'justify-content:center;font-size:26px;font-weight:700;pointer-events:none;'
        + 'transition:background .1s ease;color:' + ink + ';background:' + rest, label);
      k.appendChild(face);
      // the empty corner is not a key
      if (!label) return k;
      let litAt = 0, dim = null, touched = false;
      const lit = () => {
        clearTimeout(dim);
        litAt = Date.now();
        face.style.background = 'var(--acc,#F2802E)';
        face.style.color = '#fff';
      };
      // long enough to be seen, however quick the tap
      const unlit = () => {
        clearTimeout(dim);
        dim = setTimeout(() => { face.style.background = rest; face.style.color = ink; },
                         Math.max(0, 140 - (Date.now() - litAt)));
      };
      k.addEventListener('pointerdown', () => { touched = true; lit(); onTap(); });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((kind) => k.addEventListener(kind, unlit));
      // a click with no touch before it (a pointer-less browser, a test): the same key press
      k.addEventListener('click', () => {
        if (touched) { touched = false; return; }
        lit(); onTap(); unlit();
      });
      return k;
    };
    for (let d = 1; d <= 9; d++) {
      pad.appendChild(key(String(d), () => {
        if (entry.length >= MAXLEN) return;
        entry += String(d);
        note.textContent = '';
        paint(); ready();
        this.haptic && this.haptic('light');
      }));
    }
    pad.appendChild(key('', () => {}, true));
    pad.appendChild(key('0', () => {
      if (entry.length >= MAXLEN) return;
      entry += '0';
      note.textContent = '';
      paint();
      this.haptic && this.haptic('light');
    }));
    pad.appendChild(key('\u232B', () => {
      entry = entry.slice(0, -1);
      note.textContent = '';
      paint(); ready();
    }, true));
    /* No keypad when a face is the only way in: there is no PIN to type, and
     * a dead keypad on a lock screen reads as a wallet that will not open. */
    if (!o.noKeypad) root.appendChild(pad);

    const cta = el((o.noKeypad ? 'margin-top:auto;' : 'margin-top:16px;')
      + 'width:100%;max-width:300px;height:60px;border-radius:30px;'
      + 'background:var(--acc,#F2802E);color:#fff;display:flex;align-items:center;'
      + 'justify-content:center;font-size:19px;font-weight:800;letter-spacing:0.02em;'
      + 'cursor:pointer', o.cta || 'CONTINUE');
    if (o.gate) {
      cta.setAttribute('data-pin-cta', '1');
      /* The SET AMOUNT screen's NEXT, to the pixel: the same width, height,
       * type and fur when it can be pressed, and the same grey when it
       * cannot (build/markup.html, `next`). */
      cta.style.cssText = 'margin-top:16px;align-self:stretch;margin-left:2px;margin-right:2px;height:60px;'
        + 'border-radius:30px;display:flex;align-items:center;justify-content:center;'
        + 'font-family:SatSymbol,Sora,sans-serif;font-size:22px;font-weight:800;letter-spacing:0.02em;'
        + 'background-repeat:no-repeat,no-repeat,no-repeat;background-size:auto,auto,150% auto;'
        + 'background-position:center,center,50% 34%;white-space:nowrap';
      const FUR = 'radial-gradient(120% 84% at 26% 0%,rgba(255,240,220,.26),rgba(255,240,220,0) 62%),'
        + 'linear-gradient(168deg,rgba(247,154,60,.62),rgba(232,98,42,.72) 48%,rgba(194,74,27,.78)),'
        + "url('foxy-fur.webp')";
      ready = () => {
        const on = entry.length >= 4;
        cta.style.backgroundColor = on ? 'var(--acc,#E8622A)' : 'rgba(245,241,236,.14)';
        cta.style.backgroundImage = on ? FUR : 'none';
        cta.style.boxShadow = on
          ? 'inset 0 2px 0 rgba(255,255,255,.4),inset 0 -4px 0 rgba(0,0,0,.16),0 12px 24px rgba(232,98,42,.34)' : 'none';
        cta.style.color = on ? '#fff' : 'rgba(245,241,236,.4)';
        cta.style.cursor = on ? 'pointer' : 'default';
        cta.setAttribute('data-pin-ready', on ? '1' : '0');
      };
      ready();
    }
    cta.addEventListener('click', () => {
      // with no keypad the button IS the face: it asks again
      if (o.noKeypad) { if (o.face) o.face(); return; }
      if (entry.length < 4) {
        // a gated button says nothing: it is grey, and that is the saying
        if (!o.gate) note.textContent = 'At least four digits.';
        return;
      }
      const value = entry;
      entry = '';
      paint(); ready();
      o.onSubmit(value, (message) => { note.textContent = message; });
    });
    root.appendChild(cta);

    if (o.face) {
      const W = window.FoxyWallet;
      const face = el('margin-top:10px;width:100%;max-width:300px;height:52px;'
        + 'border-radius:26px;border:1.5px solid rgba(245,241,236,.2);'
        + 'display:flex;align-items:center;justify-content:center;font-size:17px;'
        + 'font-weight:800;letter-spacing:0.02em;color:var(--ink,#F5F1EC);'
        + 'cursor:pointer;display:none', 'USE FACE ID');
      face.addEventListener('click', o.face);
      root.appendChild(face);
      /* Shown only where the menu's USE FACE ID is on and there is a PIN to
       * type beside it — and never beside a CTA that is already the same
       * button (noKeypad, the face-alone lock, where the face IS the way in). */
      if (W && W.biometric && !o.noKeypad
          && W.faceLock && W.faceLock()) {
        face.style.display = 'flex';
      }
    }

    if (o.onCancel) {
      const back = el('margin-top:8px;height:46px;display:flex;align-items:center;'
        + 'justify-content:center;font-size:17px;font-weight:700;'
        + 'color:rgba(245,241,236,.5);cursor:pointer', 'CANCEL');
      back.addEventListener('click', () => { root.remove(); this._pinEl = null; o.onCancel(); });
      root.appendChild(back);
    }

    /* Back, at the top left, as on every screen: the same round button, in
     * the same place. Added last so the pad's own parts keep their order. */
    if (o.back) {
      const b = el('position:absolute;left:22px;top:56px;width:52px;height:52px;border-radius:50%;'
        + 'background:linear-gradient(180deg,var(--lift,#2A2B2E),var(--sink,#151618)),var(--chip,#1C1D20);'
        + 'border-top:1px solid var(--lift-edge,rgba(255,255,255,.14));'
        + 'box-shadow:inset 0 2px 0 var(--lift-edge,rgba(255,255,255,.14)),inset 0 -3px 0 var(--sink-edge,rgba(0,0,0,.5)),0 8px 16px rgba(0,0,0,.34);'
        + 'box-sizing:border-box;display:flex;align-items:center;justify-content:center;cursor:pointer');
      b.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--ink,#F5F1EC)" '
        + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12H5m0 0 6-6m-6 6 6 6"></path></svg>';
      b.setAttribute('data-pin-back', '1');
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', 'Back');
      b.addEventListener('click', () => { root.remove(); this._pinEl = null; o.back(); });
      root.appendChild(b);
    }

    document.body.appendChild(root);
    this._pinEl = root;
    return root;
  }

  pinDismiss() {
    if (this._pinEl) { this._pinEl.remove(); this._pinEl = null; }
  }

  /* Setup: enter, repeat, then read what forgetting it costs. */
  pinSetup(onDone) {
    const W = window.FoxyWallet;
    this.pinOverlay({
      title: 'CHOOSE A PIN',
      // true to the menu's switch: with USE FACE ID on, a face opens Foxy first
      subtitle: W && W.faceLock && W.faceLock()
        ? 'Four digits or more. It opens Foxy when Face ID does not.'
        : 'Four digits or more. You will enter this every time you open Foxy.',
      cta: 'NEXT',
      onCancel: () => { if (onDone) onDone(false); },
      onSubmit: (first) => {
        this.pinOverlay({
          title: 'ENTER IT AGAIN',
          subtitle: 'So a mistyped digit does not become your PIN.',
          cta: 'NEXT',
          onCancel: () => { if (onDone) onDone(false); },
          onSubmit: (second, warn) => {
            if (second !== first) {
              warn('Those did not match. Start again.');
              setTimeout(() => this.pinSetup(onDone), 700);
              return;
            }
            this.pinConfirmWarning(first, onDone);
          },
        });
      },
    });
  }

  /* The honest screen.
   *
   * A PIN that gates this app does not destroy the seed, so "you can never
   * get back in" would be false — and a user who believed it might do
   * something worse than reinstall. What is true is the route back, and what
   * it depends on. */
  pinConfirmWarning(pin, onDone) {
    const W = window.FoxyWallet;
    this.pinDismiss();
    this.blockedCard('pinWarn', {
      tone: 'warn',
      title: 'IF YOU FORGET THIS PIN',
      reason: 'There is no way to reset it and no one to ask. You would have to '
        + 'delete Foxy, reinstall it, and restore from your twelve words. '
        + 'If those words are not written down somewhere safe, the money is '
        + 'gone. Write them down before you set a PIN.',
      retry: 'SET THE PIN',
      /* CLOSE on this card abandons setup, and said nothing about it — the
       * likeliest reason a PIN "was set" and then never appeared. It says so
       * now, because a lock the user believes is on and is not is worse than
       * no lock at all. */
      onClose: () => { if (!W.pinIsSet()) this.toast('No PIN was set.', true); },
      go: () => {
        try {
          W.pinSet(pin);
          this.toast('PIN set');
          /* Nothing is asked about a face here. It was, once, and the answer
           * was kept where no switch showed it: a face then opened Foxy with
           * the PIN screen never appearing, under a menu that said Face ID
           * was off. MENU > USE FACE ID is the one place a face is turned on
           * or off (faceLock, 22-screen-lock.js). */
          if (onDone) onDone(true);
        } catch (e) {
          this.toast(W.reason(e), true);
          if (onDone) onDone(false);
        }
      },
    });
  }

  /* One PIN attempt, through the wallet's stored count of wrong ones.
   *
   * Used by the app lock and by leaving POS mode. The count outlives the app,
   * and while a wait runs the PIN is not checked at all — typing quickly, or
   * closing Foxy and opening it again, does not get more guesses. */
  pinTry(pin) {
    const W = window.FoxyWallet;
    const r = W.pinAttempt ? W.pinAttempt(pin) : { ok: W.pinCheck(pin), waitMs: 0 };
    if (r.ok) return { ok: true };
    const secs = Math.ceil((r.waitMs || 0) / 1000);
    const span = secs >= 120 ? Math.ceil(secs / 60) + ' minutes'
      : secs + (secs === 1 ? ' second' : ' seconds');
    if (r.locked) return { ok: false, message: 'Too many wrong PINs. Try again in ' + span + '.' };
    return { ok: false, message: secs > 0 ? 'Wrong PIN. Try again in ' + span + '.' : 'Wrong PIN.' };
  }

  /* Resolves once the lock is dismissed; at once when there is no lock up. */
  pinUnlocked() {
    return this._pinLocked && this._unlockWait ? this._unlockWait : Promise.resolve();
  }

  /* The lock itself, at launch and on resume.
   *
   * A PIN, or a face, or both — `screenLocked()`. It used to be a PIN alone:
   * `pinIsSet()` and nothing else, so somebody who had turned Face ID on and
   * set no PIN had no lock at all — kill Foxy, open it, and the balance, the
   * history and the mint were on screen with nothing asked. The menu's Face
   * ID row sets `secureChoice`, which guards the
   * SEED, so a face was asked when money was spent and never for looking.
   *
   * One setting decides whether a face is offered, the menu's USE FACE ID
   * (`faceLock()`, 22-screen-lock.js), and whether a PIN is set decides what
   * the face is:
   *
   *   no PIN     the face is the lock, and the phone's own passcode may
   *              stand in for it
   *   a PIN      the face is the quick way in and the PIN is the way in when
   *              it will not scan; with USE FACE ID off, only the PIN opens */
  pinLock() {
    const W = window.FoxyWallet;
    if (!W || !W.screenLocked || !W.screenLocked()) return;
    const byFaceAlone = !W.pinIsSet();
    /* Nothing the lock guards stays open, above it or under it.
     *
     * The seed and verify screens and the delete prompts sat above the lock
     * and were not closed: a phone handed over after a trip to the background
     * showed TAP TO REVEAL, the words to verify, or DELETE over FOXY IS
     * LOCKED, and no PIN was asked. They close now, and opening them again
     * goes through the unlocked app. The words themselves are on the phone's
     * screens, which close as Foxy goes to the background; the BACKUP sheet
     * around them, with its DELETE, is marked like the prompts. */
    document.querySelectorAll('[data-foxy-close-on-lock]')
      .forEach(n => n.remove());
    if (this._pinLocked) return;
    this._pinLocked = true;
    this._lockedOnce = true;
    // said, so a diary shows the lock: it drew and asked in silence, and a report about it had nothing to go on
    console.log('[foxy] lock: up, ' + (byFaceAlone ? 'a face is the way in' : 'the PIN pad') + (W.faceLock && W.faceLock() ? ', a face is asked' : ''));
    this._unlockWait = new Promise(resolve => { this._unlockDone = resolve; });
    const unlocked = () => {
      this._pinLocked = false;
      this.pinDismiss();
      if (this._unlockDone) { this._unlockDone(); this._unlockDone = null; }
    };

    /* Face ID first, when it is there and wanted.
     *
     * The keypad is built either way, so a refusal or a cancel lands on
     * something usable rather than on nothing.
     *
     * With a face and no PIN there is nothing behind it, so the phone's own
     * passcode is allowed to stand in: a face that will not scan must not mean
     * the money cannot be reached. It gives nothing away — anybody who can
     * unlock the phone can open Foxy anyway. With a PIN set, that PIN is the
     * way in and Face ID stays biometrics-only. */
    const tryFace = (auto) => {
      // the menu's switch, whether or not a PIN stands behind the face
      const wanted = W.faceLock && W.faceLock();
      if (!W.biometric || !wanted) return;
      W.biometric('Unlock Foxy', byFaceAlone).then(answer => {
        if (answer === 'unavailable' && byFaceAlone) {
          /* A face was the only lock and this phone cannot check one — Face ID
           * turned off in Settings, or no passcode at all. Refusing to open
           * would strand the money behind a door with no key, so Foxy says so
           * and lets them in, which is no worse than the phone itself. */
          console.warn('[foxy] lock: this phone cannot check a face or a passcode; opening');
          unlocked();
          return;
        }
        if (answer !== 'yes') return;
        if (W.pinTriesClear) W.pinTriesClear();
        unlocked();
      }).catch(() => {});
    };

    const ask = (message) => {
      this.pinOverlay({
        title: 'FOXY IS LOCKED',
        // no keypad to point at when a face is the only way in
        subtitle: message || (byFaceAlone ? 'Look at your phone to unlock.' : 'Enter your PIN.'),
        cta: byFaceAlone ? 'UNLOCK WITH FACE ID' : 'UNLOCK',
        noKeypad: byFaceAlone,
        cover: true,
        face: () => tryFace(false),
        onSubmit: (pin, warn) => {
          /* Slow down guessing on a phone in someone's hand. This does
           * nothing against reading the stored hash offline — that is in the
           * threat model, not hidden behind a delay. */
          const r = this.pinTry(pin);
          if (r.ok) {
            unlocked();
            return;
          }
          warn(r.message);
        },
      });
    };
    ask();
    tryFace(true);
    /* And the phone is told the page has the screen: the lock is drawn, opaque
     * and without a fade, so the launch image over it, or the cover put up as
     * Foxy went away, can come off now. Said from here, whoever raised the lock.
     * At launch it is raised from the wallet's boot, a moment after the page
     * mounted, and nothing there said it: the splash sat over the PIN pad for
     * the phone's eight seconds. */
    if (window.FoxyGate && window.FoxyGate.uncover) window.FoxyGate.uncover();
  }
