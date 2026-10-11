  /* ---- the screen behind the card sheet --------------------------------------
   *
   * Foxy's own screen while the phone's NFC sheet is up, from the design: a card
   * comes down behind a phone with three waves rising, the title says what to do,
   * and the amount is under it. Everything is in the top half, where the sheet
   * (the phone's own, drawn nowhere here) leaves room; the bottom holds only
   * CANCEL, which is under the sheet's own on a phone.
   *
   * Two grounds. Light blue while no card is connected (TAP BEHIND PHONE, and the
   * asking again: TAP FOR CHANGE, PLEASE TAP AGAIN, ENTER PIN); orange, with the
   * fur over it, from the moment the sheet reports a card connected (KEEP
   * HOLDING, VERIFYING CARD, REMOVE) until it is lost or the sheet ends. The card
   * and the waves loop while a card is wanted and settle behind the phone once it
   * is there; the page's stylesheet stops the loop for a person who asks for
   * less motion (build/markup.html, `[data-look]`), and the card is then just
   * drawn settled.
   *
   * What it says, by where the tap has got to (`fcTapLook`):
   *
   *   TAP BEHIND PHONE         waiting for the first contact
   *   KEEP HOLDING · N s       in contact, the card being asked; N counts up from
   *                            the contact, a whole second at a time
   *   VERIFYING CARD           the card has signed and is still there: the mint is
   *                            asked, and change is fetched or written
   *   REMOVE                   the card has signed and nothing more is wanted of it
   *   TAP FOR CHANGE           the card has signed and contact broke before the
   *                            change went on (or the second tap is waiting for it)
   *   PLEASE TAP AGAIN         contact broke part way, and the same sheet asks again
   *   ENTER PIN                the sheet ended asking for the PIN; the pad is up
   *
   * The sheet's own line is the wallet's and 26f's (FC_STEPS, fcProgressText);
   * nothing of it is repeated here, and no estimate of how long a tap will take:
   * the till cannot know the count, and the card does not say it.
   *
   * The card in the animation is the card screen's own face (build/markup.html,
   * `[data-card-face]`) at 250px: its design is the card's (FX1 is the picture,
   * FL1 the drawn face, EL1 the animated beaker), FX1 until a card has been read at a till.
   */
  FC_TAP_FACE = '<div data-card-face style="width:100cqw;height:63.02cqw;border-radius:4.17cqw;box-sizing:border-box;position:relative;overflow:hidden;background:repeating-linear-gradient(92deg,rgba(255,255,255,.05) 0 1px,rgba(255,255,255,0) 1px 3px),repeating-linear-gradient(0deg,rgba(0,0,0,.16) 0 1px,rgba(0,0,0,0) 1px 4px),radial-gradient(circle at 22% 8%,rgba(255,255,255,.14),rgba(255,255,255,0) 46%),linear-gradient(146deg,#3A3B3D 0%,#1B1C1E 38%,#101113 72%,#26272A 100%);box-shadow:inset 0 1.5px 0 rgba(255,255,255,.34),inset 0 -2px 0 rgba(0,0,0,.7),inset 1.5px 0 0 rgba(255,255,255,.14),inset -1.5px 0 0 rgba(0,0,0,.6),0 2px 0 rgba(0,0,0,.7),0 14px 28px rgba(0,0,0,.6)"><div style="position:absolute;inset:3.52cqw;border-radius:2.34cqw;border:1px solid rgba(255,255,255,.16);box-shadow:inset 0 0 0 1px rgba(0,0,0,.5);pointer-events:none"></div><div style="position:absolute;inset:4.56cqw;border-radius:1.82cqw;background:repeating-linear-gradient(45deg,rgba(255,255,255,.045) 0 1px,rgba(255,255,255,0) 1px 5px),repeating-linear-gradient(-45deg,rgba(255,255,255,.045) 0 1px,rgba(255,255,255,0) 1px 5px);pointer-events:none"></div><div style="position:absolute;inset:6.25cqw;border-radius:1.04cqw;background:radial-gradient(circle at 50% 46%,rgba(0,0,0,.5),rgba(0,0,0,0) 72%);pointer-events:none"></div><div style="position:absolute;left:50%;top:50%;width:31.25cqw;height:31.25cqw;transform:translate(-50%,-50%);border-radius:50%;background:linear-gradient(150deg,#2E2F32,#121315);box-shadow:inset 0 2px 3px rgba(0,0,0,.8),inset 0 -1.5px 0 rgba(255,255,255,.16),0 1px 0 rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;pointer-events:none"><svg viewBox="0 0 236.5 366" style="height:16.15cqw;width:10.43cqw;display:block;opacity:.5"><path d="M81.1,364.6c-11.8-3.1-21.4-11.1-26.8-22-5.1-10.1-6-22.6-1.5-33.1l15.3-33,17.8-37.6c.3-.7-.1-1.6-.4-2.1s-1-.9-1.9-.9h-40.8c-9,0-17.4-2.6-24.7-7.9-5-3.6-9.1-8.1-12.3-13.4-5.6-9.4-7.3-21.3-4.3-31.8l4.3-14.8L37.9,56.1c4.3-20.8,21.7-34.8,42.9-34.2,14.7.4,28.3,8.2,35.6,21,5.7,10,6.7,21.9,3.5,32.9l-6.6,22.7-15.4,51.9c-.2.8-.3,1.5.2,2.1s1,1.1,1.9,1.1h53.6c5.7,0,11,1.7,16,4,13.5,6.2,22.4,19.3,23.8,34,.8,8.4-.9,16.3-4.6,23.7l-8.2,17.8-50.5,108.9c-8.4,18.2-29.3,27.9-48.8,22.7Z" fill="#050505"></path><path d="M103,355c-11.8-3.1-21.4-11.1-26.8-22-5.1-10.1-6-22.6-1.5-33.1l15.3-33,17.8-37.6c.3-.7-.1-1.6-.4-2.1s-1-.9-1.9-.9h-40.8c-9,0-17.4-2.6-24.7-7.9-5-3.6-9.1-8.1-12.3-13.4-5.6-9.4-7.3-21.3-4.3-31.8l4.3-14.8L59.7,46.4c4.3-20.8,21.7-34.8,42.9-34.2,14.7.4,28.3,8.2,35.6,21,5.7,10,6.7,21.9,3.5,32.9l-6.6,22.7-15.4,51.9c-.2.8-.3,1.5.2,2.1s1,1.1,1.9,1.1h53.6c5.7,0,11,1.7,16,4,13.5,6.2,22.4,19.3,23.8,34,.8,8.4-.9,16.3-4.6,23.7l-8.2,17.8-50.5,108.9c-8.4,18.2-29.3,27.9-48.8,22.7Z" fill="#5C5C5C"></path><path d="M124.1,342.8c-11.8-3.1-21.4-11.1-26.8-22-5.1-10.1-6-22.6-1.5-33.1l15.3-33,17.8-37.6c.3-.7-.1-1.6-.4-2.1s-1-.9-1.9-.9h-40.8c-9,0-17.4-2.6-24.7-7.9-5-3.6-9.1-8.1-12.3-13.4-5.6-9.4-7.3-21.3-4.3-31.8l4.3-14.8,32.1-112C85.2,13.5,102.6-.5,123.8,0c14.7.4,28.3,8.2,35.6,21,5.7,10,6.7,21.9,3.5,32.9l-6.6,22.7-15.4,51.9c-.2.8-.3,1.5.2,2.1s1,1.1,1.9,1.1h53.6c5.7,0,11,1.7,16,4,13.5,6.2,22.4,19.3,23.8,34,.8,8.4-.9,16.3-4.6,23.7l-8.2,17.8-50.5,108.9c-8.4,18.2-29.3,27.9-48.8,22.7Z" fill="#C9C9C9"></path></svg></div><div style="position:absolute;left:9.92cqw;top:8.75cqw;width:15.18cqw;height:13.78cqw;border-radius:1.56cqw;background:linear-gradient(150deg,#E8E4D8,#A9A392);box-shadow:inset 0 1px 0 rgba(255,255,255,.7),inset 0 -1px 0 rgba(60,58,50,.4),0 2px 4px rgba(0,0,0,.5);overflow:hidden"><div style="position:absolute;left:0;right:0;top:33%;height:1px;background:rgba(70,68,60,.4)"></div><div style="position:absolute;left:0;right:0;top:66%;height:1px;background:rgba(70,68,60,.4)"></div><div style="position:absolute;top:0;bottom:0;left:33%;width:1px;background:rgba(70,68,60,.4)"></div><div style="position:absolute;top:0;bottom:0;left:66%;width:1px;background:rgba(70,68,60,.4)"></div></div><div style="position:absolute;right:7.81cqw;bottom:6.25cqw;display:flex;flex-direction:column;align-items:center;gap:2px"><div style="font-size:5.99cqw;font-weight:800;line-height:1;color:rgba(255,255,255,.5)">₿</div><div style="font-family:Sora,sans-serif;font-size:2.86cqw;font-weight:600;letter-spacing:0.24em;color:rgba(255,255,255,.42)">BEARER</div></div>' + this.FC_EL1_FACE + '</div>';
  FC_TAP_GROUNDS = {
    '01': { ground: '#BFE3EC', ink: '#0F2A33', shadow: '0 14px 30px rgba(15,42,51,.28)' },
    '03': { ground: '#EB6A2E', ink: '#1A0A04', shadow: '0 14px 30px rgba(26,10,4,.32)' },
  };
  FC_TAP_TITLES = {
    hold: 'TAP BEHIND PHONE', keep: 'KEEP HOLDING · ', verify: 'VERIFYING CARD', remove: 'REMOVE',
    change: 'TAP FOR CHANGE', again: 'PLEASE TAP AGAIN', pin: 'ENTER PIN',
  };
  // the steps that mean the card is in the field, whether or not the phone has said so
  FC_TAP_CONTACT = { reading: 1, signing: 1, writing: 1, resetting: 1, mint: 1, change: 1 };

  /* What this tap knows of the card so far. It lives on the tap's own options (`_fcTapO.t`), so a tap that begins
   * has none of the one before. `o.lost` and `o.wrote` are said by whatever begins a tap that follows a card leaving
   * (and by the flows as it leaves): taken once into the state. */
  fcTapState() {
    const o = this._fcTapO || (this._fcTapO = {});
    if (!o.t) {
      o.t = {
        connected: false, since: 0,
        // something has been asked of the card, or the card has been found: CANCEL goes
        touched: false,
        // the card has signed (a payment's second tap, and a put back, begin so)
        signed: o.look === 'receive' || !!o.putBack,
        // the card is let go and nothing more is wanted of it
        gone: false,
        lost: false, wrote: false,
        // the sheet ended asking for the PIN; and the tap that follows the pad
        pin: false, pinAgain: !!o.pinAgain,
        design: '',
      };
    }
    const t = o.t;
    if (o.lost) { t.lost = true; t.connected = false; o.lost = false; }
    if (o.wrote) { t.wrote = true; o.wrote = false; }
    return t;
  }

  /* Contact: the card is in the field. `again` is a connection the phone reported, which starts the count afresh. */
  fcContact(again) {
    const t = this.fcTapState();
    if (t.gone || t.pin) return;
    if (again || !t.connected) { t.connected = true; t.since = Date.now(); }
    t.lost = false;
    t.touched = true;
  }

  /* The card left, and the same sheet is about to ask for it again. */
  fcTapLost() {
    const t = this.fcTapState();
    if (t.gone || t.pin) return;
    t.lost = true;
    t.connected = false;
    if (this.stageUp('card')) this.fcTapDraw();
  }

  /* The sheet ended asking for the PIN: the pad comes up over this, and the tap that follows it starts as PLEASE TAP AGAIN. */
  fcTapPin() {
    const t = this.fcTapState();
    t.pin = true;
    t.connected = false;
    if (this.stageUp('card')) this.fcTapDraw();
  }

  /* A card read at this tap has said which design it is (`info.design` of a step, `design` of a progress report). */
  fcTapSeen(code) {
    this.fcTapState().design = this.fcDesignOf({ design: code });
    if (this.stageUp('card')) this.fcTapDraw();
  }

  /* What the phone's own link reports (`FoxyWallet.onCard`): the card found, the card lost. */
  fcTapEvent(ev) {
    if (!ev || !this.stageUp('card')) return;
    if (ev.stage === 'seen') { this.fcTapSeen(ev.design); return; }
    if (ev.stage === 'connected') {
      this.fcContact(true);
      this.fcTapDraw();
    } else if (ev.stage === 'lost') {
      this.fcTapLost();
    }
  }

  /* The seconds since the card connected. */
  fcHeldSeconds() {
    const t = this.fcTapState();
    return t.connected ? Math.max(0, Math.floor((Date.now() - t.since) / 1000)) : 0;
  }

  /* Which screen this is, from where the tap has got to. */
  fcTapLook() {
    const o = this._fcTapO || {};
    const t = this.fcTapState();
    let key;
    if (t.pin) key = 'pin';
    else if (t.gone) key = 'remove';
    else if (t.connected) key = t.signed ? 'verify' : 'keep';
    // contact broke: before any of the change went on it is the change that is asked for, and otherwise it is the tap
    else if (t.lost) key = (t.signed && !t.wrote) ? 'change' : 'again';
    else if (o.putBack) key = 'again';
    else if (t.signed) key = 'change';
    // the tap that follows the PIN pad: nothing has been asked of the card yet, and it was asked before
    else if (t.pinAgain) key = 'again';
    else key = 'hold';
    const warm = key === 'keep' || key === 'verify' || key === 'remove';
    return {
      key, scheme: warm ? '03' : '01',
      // the card is wanted, and the loop says so; once it is there it stays settled
      loop: key === 'hold' || key === 'again' || key === 'change',
      // nothing has been asked of the card: the one way out is here (after that, finishing is)
      cancel: !t.touched && !t.connected && (key === 'hold' || key === 'again' || key === 'change'),
    };
  }

  /* The screen, made once for a tap and kept: what changes is its ground, its title, and whether the card moves. */
  fcTapBuild() {
    this.hideStage();
    const root = document.createElement('div');
    root.id = 'foxy-stage';
    root.setAttribute('data-stage', 'card');
    root.setAttribute('data-look', 'hold');
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483300;display:flex;flex-direction:column;overflow:hidden;'
      + 'box-sizing:border-box;padding-top:env(safe-area-inset-top);font-family:Sora,system-ui,sans-serif;'
      + '-webkit-font-smoothing:antialiased;transition:background-color .35s ease,color .35s ease;animation:foxyIn .18s ease';
    const BLUE = '#0A84FF';
    const wave = (d, delay) => '<path data-tap-wave d="' + d + '" style="opacity:0;animation:cvWave 4.2s ease-out ' + delay + 's infinite"></path>';
    root.innerHTML =
      '<div data-tap-fur style="position:absolute;inset:0;background-image:url(snow-fur.jpg);background-size:cover;'
      + 'mix-blend-mode:soft-light;opacity:0;pointer-events:none;transition:opacity .35s ease"></div>'
      + '<div style="position:relative;width:100%;max-width:430px;margin:0 auto;flex:1 1 auto;min-height:0;display:flex;flex-direction:column">'
      + '<div style="position:relative;flex:0 0 auto;height:269px;overflow:hidden">'
      + '<div data-tap-card style="position:absolute;left:50%;top:40px;width:250px;margin-left:-125px;aspect-ratio:1.585;'
      + 'border-radius:15px;overflow:hidden;animation:cvBehind 4.2s cubic-bezier(.5,0,.3,1) infinite">'
      + '<div data-card-design="FX1" style="container-type:inline-size;width:100%">' + this.FC_TAP_FACE + '</div></div>'
      + '<svg viewBox="0 0 220 60" width="220" height="60" fill="none" style="position:absolute;left:50%;top:83px;margin-left:-110px;z-index:2;overflow:visible">'
      + '<g stroke="' + BLUE + '" stroke-width="4" stroke-linecap="round">'
      + wave('M70 40 Q110 14 150 40', 0) + wave('M52 34 Q110 -4 168 34', .25) + wave('M34 28 Q110 -22 186 28', .5)
      + '</g></svg>'
      + '<div style="position:absolute;left:50%;top:119px;width:300px;height:150px;margin-left:-150px;z-index:3;'
      + 'border-radius:46px 46px 0 0;background:#0F2A33;box-shadow:0 -8px 24px rgba(15,42,51,.25);padding:8px 8px 0;box-sizing:border-box">'
      + '<div style="width:100%;height:100%;border-radius:38px 38px 0 0;background:linear-gradient(180deg,#1E4450,#163842);position:relative">'
      + '<div style="position:absolute;left:50%;top:12px;width:70px;height:20px;margin-left:-35px;border-radius:999px;background:#0A1B21"></div>'
      + '</div></div></div>'
      + '<div style="position:relative;padding:22px 32px 0;display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center">'
      + '<h1 style="margin:0;font-weight:800;font-size:31px;line-height:1.05;white-space:nowrap;letter-spacing:-.01em;'
      + 'text-transform:uppercase"></h1>'
      + '<div data-tap-amount style="margin-top:6px;font-weight:800;font-size:42px;letter-spacing:-.02em"></div>'
      + '</div></div>';
    /* CANCEL, where the phone's sheet would be: under it on a phone, whose sheet has its own, and the way out wherever
     * there is no sheet. */
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;z-index:1;margin-top:auto;padding:20px 24px calc(44px + env(safe-area-inset-bottom))';
    const b = document.createElement('div');
    b.style.cssText = 'width:100%;height:60px;border-radius:18px;box-sizing:border-box;border:2px solid;'
      + 'background:rgba(255,255,255,.35);font-family:Sora,system-ui,sans-serif;font-weight:800;font-size:17px;'
      + 'letter-spacing:.04em;text-transform:uppercase;display:flex;align-items:center;justify-content:center;cursor:pointer';
    b.textContent = 'CANCEL';
    b.setAttribute('data-stage-button', '1');
    // the session ends as cancelled, and that is what takes this screen down
    b.addEventListener('click', () => { const W = this.fcW(); if (W) W.cardStop(); });
    wrap.appendChild(b);
    root.firstElementChild.nextElementSibling.appendChild(wrap);
    document.body.appendChild(root);
    // the rule every stage keeps: one that outlives what it waited for hides a working app
    this._stageT = setTimeout(() => this.hideStage('card'), 120000);
    return root;
  }

  /* Draw the screen for where the tap has got to: made if it is not up, and otherwise changed in place, so that the
   * card does not start again when only the title has moved. */
  fcTapDraw() {
    const o = this._fcTapO || {};
    const k = this.fcTapLook();
    let root = document.getElementById('foxy-stage');
    const fresh = !(root && root.getAttribute('data-stage') === 'card' && root.getAttribute('data-look'));
    if (fresh) root = this.fcTapBuild();
    if (!root) return;
    const g = this.FC_TAP_GROUNDS[k.scheme];
    const was = root.getAttribute('data-look');
    root.setAttribute('data-look', k.key);
    root.setAttribute('data-scheme', k.scheme);
    root.style.backgroundColor = g.ground;
    root.style.color = g.ink;
    const fur = /** @type {HTMLElement | null} */ (root.querySelector('[data-tap-fur]'));
    if (fur) fur.style.opacity = k.scheme === '03' ? '.5' : '0';
    // the card's design: FX1 is its picture and FL1 the face drawn in CSS (build/markup.html)
    const t = this.fcTapState();
    const design = t.design || (this.state && this.state.fc ? this.fcDesignOf(this.state.fc) : 'FX1');
    const face = root.querySelector('[data-card-design]');
    if (face && face.getAttribute('data-card-design') !== design) face.setAttribute('data-card-design', design);
    const card = /** @type {HTMLElement | null} */ (root.querySelector('[data-tap-card]'));
    if (card) card.style.boxShadow = g.shadow;
    // the loop starts when a card is wanted and stops where it is when it is there
    const looping = root.getAttribute('data-loop') === '1';
    if (k.loop !== looping || fresh) {
      root.setAttribute('data-loop', k.loop ? '1' : '0');
      if (card) card.style.animation = k.loop ? 'cvBehind 4.2s cubic-bezier(.5,0,.3,1) infinite' : 'none';
      Array.from(root.querySelectorAll('[data-tap-wave]')).forEach((w, i) => {
        /** @type {HTMLElement} */ (w).style.animation = k.loop ? 'cvWave 4.2s ease-out ' + (i * 0.25) + 's infinite' : 'none';
      });
    }
    const amount = /** @type {HTMLElement | null} */ (root.querySelector('[data-tap-amount]'));
    if (amount) {
      amount.textContent = o.amount || '';
      amount.style.display = o.amount ? '' : 'none';
    }
    this.fcTapTitle(root, k);
    const btn = /** @type {HTMLElement | null} */ (root.querySelector('[data-stage-button]'));
    if (btn) { btn.style.visibility = k.cancel ? 'visible' : 'hidden'; btn.style.color = g.ink; btn.style.borderColor = g.ink; }
    // the count runs only while it is on the screen
    if (k.key === 'keep' && !this._fcCountT) this._fcCountT = setInterval(() => this.fcTapTick(), 500);
    else if (k.key !== 'keep') { clearInterval(this._fcCountT); this._fcCountT = null; }
    if (fresh || was !== k.key) console.log('[foxy] screen: card, ' + k.key);
    if (fresh && this.syncPreview) this.syncPreview();
  }

  /* The title, one line: KEEP HOLDING carries the seconds, whose unit stays lowercase. */
  fcTapTitle(root, k) {
    const h = /** @type {HTMLElement | null} */ (root.querySelector('h1'));
    if (!h) return;
    const secs = k.key === 'keep' ? this.fcHeldSeconds() : -1;
    const sig = k.key + ':' + secs;
    if (h.getAttribute('data-sig') !== sig) {
      h.setAttribute('data-sig', sig);
      h.textContent = this.FC_TAP_TITLES[k.key];
      if (secs >= 0) {
        const u = document.createElement('span');
        u.style.textTransform = 'none';
        u.textContent = secs + ' s';
        h.appendChild(u);
      }
    }
    // one line, whatever the phone's width: smaller when it would not fit (the design is 31px on 430)
    try {
      h.style.fontSize = '31px';
      const col = h.parentElement;
      const room = col ? col.clientWidth - 64 : 0;
      const need = h.scrollWidth;
      if (room > 0 && need > room) h.style.fontSize = Math.max(18, Math.floor(310 * room / need) / 10) + 'px';
    } catch (e) { /* no layout to measure */ }
  }

  /* One turn of the count: it stops by itself when the screen it was counting for is gone. */
  fcTapTick() {
    const root = document.getElementById('foxy-stage');
    if (!root || root.getAttribute('data-stage') !== 'card' || root.getAttribute('data-look') !== 'keep') {
      clearInterval(this._fcCountT);
      this._fcCountT = null;
      return;
    }
    this.fcTapTitle(root, { key: 'keep' });
  }

