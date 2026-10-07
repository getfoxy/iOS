
  /* Type a mint url rather than scanning one. Uses the same prompt sheet the
   * rest of the app uses for text entry. */
  /* Type a mint's address.
   *
   * window.prompt was a placeholder: it renders as an iOS system dialog with
   * none of the app's styling and no control over the keyboard. This is the
   * app's own sheet, with the keyboard up on open and ADD live only once what
   * has been typed could actually be a mint.
   */
  typeMint() {
    const root = document.createElement('div');
    root.style.cssText =
      'position:fixed;inset:0;z-index:2147483500;background:rgba(0,0,0,.72);' +
      'display:flex;flex-direction:column;justify-content:flex-end;' +
      'animation:foxyIn .16s ease';

    const card = document.createElement('div');
    card.style.cssText =
      'background:#141518;border-radius:28px 28px 0 0;padding:26px 24px ' +
      'calc(26px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:14px;' +
      'transition:transform .18s ease';

    /* Sit above the keyboard.
     *
     * The page is not resized for the keyboard here, so a card anchored to the
     * bottom ends up underneath it — field invisible, ADD unreachable.
     * visualViewport reports how much is covered; the card moves by that. */
    const kbTimers = [];
    const pinScroll = () => {
      if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0);
    };
    window.addEventListener('scroll', pinScroll, true);
    const lift = () => {
      pinScroll();
      const vv = window.visualViewport;
      if (!vv) return;
      const gap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      card.style.transform = gap > 80 ? 'translateY(-' + Math.round(gap) + 'px)' : 'none';
    };
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', lift);
      window.visualViewport.addEventListener('scroll', lift);
    }
    const done = () => {
      kbTimers.forEach(clearTimeout);
      window.removeEventListener('scroll', pinScroll, true);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', lift);
        window.visualViewport.removeEventListener('scroll', lift);
      }
      root.remove();
    };

    const title = document.createElement('div');
    title.style.cssText =
      'font-family:Sora,system-ui,sans-serif;font-size:22px;font-weight:800;' +
      'letter-spacing:-0.022em;color:#F5F1EC;text-align:center';
    title.textContent = 'MINT ADDRESS';
    card.appendChild(title);

    const hint = document.createElement('div');
    hint.style.cssText =
      'font-size:18px;font-weight:600;line-height:1.4;color:rgba(245,241,236,.55);' +
      'text-align:center;text-wrap:pretty';
    hint.textContent = 'The web address of a Cashu mint.';
    card.appendChild(hint);

    const input = document.createElement('input');
    input.type = 'url';
    input.value = 'https://';
    input.autocapitalize = 'none';
    /* The attribute, not the property. The autocorrect property is a boolean, so
     * assigning it 'off' turned autocorrect on where WebKit has the property,
     * and did nothing where it does not. Found by the app's type check. */
    input.setAttribute('autocorrect', 'off');
    input.spellcheck = false;
    input.style.cssText =
      'height:56px;border-radius:18px;background:#0B0B0C;border:1.5px solid ' +
      'rgba(245,241,236,.18);box-sizing:border-box;padding:0 16px;color:#F5F1EC;' +
      'font-family:ui-monospace,Menlo,monospace;font-size:17px;outline:none';
    card.appendChild(input);

    const add = document.createElement('div');
    const setLive = () => {
      const ok = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(input.value.trim());
      add.style.background = ok ? '#F2802E' : 'rgba(245,241,236,.12)';
      add.style.color = ok ? '#fff' : 'rgba(245,241,236,.4)';
      add.style.cursor = ok ? 'pointer' : 'default';
      add.dataset.ok = ok ? '1' : '';
    };
    add.style.cssText =
      'height:60px;border-radius:30px;display:flex;align-items:center;' +
      'justify-content:center;font-family:Sora,system-ui,sans-serif;font-size:20px;' +
      'font-weight:800;letter-spacing:0.02em';
    add.textContent = 'ADD';
    add.addEventListener('click', () => {
      if (!add.dataset.ok) return;
      if (add.dataset.busy) return;
      const clean = input.value.trim().replace(/\/+$/, '');

      /* Stay up while it connects.
       *
       * Over Tor this is a second or two. Closing first put the person back on
       * the list with nothing moving and no sign the tap had registered. */
      add.dataset.busy = '1';
      input.blur();
      add.innerHTML =
        '<div style="width:19px;height:19px;border-radius:50%;border:2px solid ' +
        'rgba(255,255,255,.28);border-top-color:#fff;margin-right:10px" ' +
        'id="fx-mint-spin"></div>CONNECTING\u2026';
      add.style.display = 'flex';
      add.style.alignItems = 'center';
      add.style.justifyContent = 'center';

      const spin = document.getElementById('fx-mint-spin');
      const t0 = performance.now();
      let raf = requestAnimationFrame(function turn(now) {
        if (spin) spin.style.transform = 'rotate(' + ((now - t0) / 900 * 360 % 360).toFixed(1) + 'deg)';
        raf = requestAnimationFrame(turn);
      });

      // justSwitch owns switchBusy; watching it means the sheet closes on
      // whatever ends the connect, success or failure, with no second timer
      // that could disagree with it.
      const watch = setInterval(() => {
        if (this.state.switchBusy) return;
        clearInterval(watch);
        cancelAnimationFrame(raf);
        done();
      }, 200);
      // and a ceiling, so a connect that never settles cannot strand the sheet
      setTimeout(() => {
        clearInterval(watch);
        cancelAnimationFrame(raf);
        done();
      }, 45000);

      this.justSwitch(clean);
    });
    card.appendChild(add);

    const cancel = document.createElement('div');
    cancel.style.cssText =
      'height:52px;display:flex;align-items:center;justify-content:center;' +
      'font-family:Sora,system-ui,sans-serif;font-size:18px;font-weight:800;' +
      'color:rgba(245,241,236,.55);cursor:pointer';
    cancel.textContent = 'CANCEL';
    cancel.addEventListener('click', done);
    card.appendChild(cancel);

    input.addEventListener('input', setLive);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add.click(); });
    setLive();

    root.appendChild(card);
    root.addEventListener('click', (e) => { if (e.target === root) done(); });
    document.body.appendChild(root);
    /* Synchronous, for the same reason as the note sheet: iOS only opens the
     * keyboard for a focus inside the gesture that caused it. */
    input.focus();
    try {
      const n = input.value.length;
      input.setSelectionRange(n, n);
    } catch (e) {}
    lift();
    kbTimers.push(setTimeout(() => {
      input.focus();
      const n = input.value.length;
      try { input.setSelectionRange(n, n); } catch (e) {}
      lift();
    }, 140));
    kbTimers.push(setTimeout(lift, 320));
    kbTimers.push(setTimeout(lift, 700));
  }

  /* Money arrived, by whatever route.
   *
   * The prompt used to hang off the invoice watcher alone, so a token claimed
   * by paste or scan — which is most of how this wallet receives — never
   * raised it. Every arrival calls this instead.
   */
  noteReceived() {
    const W = window.FoxyWallet;
    this.setState({ everReceived: true });
    if (!W.backedUp || W.backedUp() || this.state.dismissedBackup) return;
    if (this.backupAskedLately()) return;

    // Wait for home. The prompt was rising over the payment confirmation,
    // stacking one thing to read on top of another and burying the amount
    // that had just arrived. It belongs on the screen you land on afterwards.
    clearTimeout(this._bkAskT);
    let waited = 0;
    const raise = () => {
      if (W.backedUp() || this.state.dismissedBackup) return;
      // another arrival may have raised it while this one waited for home
      if (this.backupAskedLately()) return;
      if (this.state.screen !== 'home') {
        waited += 900;
        if (waited > 90000) return;
        this._bkAskT = setTimeout(raise, 900);
        return;
      }
      this.backupAskedNow();
      this.setState({ bkAskOpen: true });
    };
    this._bkAskT = setTimeout(raise, 1400);
  }

  /* BACK UP YOUR BITCOIN, once in a day.
   *
   * It rose after every payment until the words were written down, which is
   * the right thing to say and the wrong number of times to say it: somebody
   * taking payments all afternoon pressed DO THIS LATER after each one. Now
   * it is said once and not again for twenty-four hours, counted from when
   * it was raised and kept across launches. A clock that has gone backwards
   * does not silence it. The line on the home screen is still there in
   * between. */
  BACKUP_ASK_EVERY_MS = 86400000;

  backupAskedLately() {
    let at = 0;
    try { at = Number(localStorage.getItem('foxy.backup.asked')) || 0; } catch (e) {}
    const since = Date.now() - at;
    return at > 0 && since >= 0 && since < this.BACKUP_ASK_EVERY_MS;
  }

  backupAskedNow() {
    try { localStorage.setItem('foxy.backup.asked', String(Date.now())); } catch (e) {}
  }

  /* Check the phrase was actually written down: the phone's own quiz, with
   * the words it keeps (showSeedOnPhone). The page's quiz, which tapped the
   * twelve words back in order here, is gone with the words. */
  showVerify() {
    return this.showSeedOnPhone(true);
  }

  /* The note on a payment being sent, on its own overlay.
   *
   * Same reason as the token screen's: the shared editor renders on top of
   * the screen beneath it rather than replacing it, so both headers draw at
   * once and neither is readable.
   */
  editSendNote() {
    this.noteSheet(this.state.note || '', (text) => {
      this.setState({ note: text });
    });
  }

  /* A note on the token, written on its own overlay.
   *
   * The shared note editor assumes the invoice screen underneath it; on this
   * screen both headers drew at once. This is plain DOM, like the seed screen
   * and the loader, so nothing can render through it.
   */
  editTokenNote() {
    const W = window.FoxyWallet;
    const out = W.lastToken() || {};
    const hash = out.hash;
    if (!hash) { this.toast('Nothing to note yet.', true); return; }
    this.noteSheet((W.tagsFor(hash) || {}).note || '', (text) => {
      W.tag(hash, { note: text });
      this.loadHistory();
    });
  }

  /* The note on a payment already made, from its detail screen: added where
   * there is none, changed where there is one, and taken off by saving it
   * empty. Kept on this phone only (`W.tag`), like every note. */
  editTxNote() {
    const W = window.FoxyWallet;
    const tx = this.state.tx || {};
    if (!tx.hash || !W || !W.tag) return;
    this.noteSheet(tx.note || '', (text) => {
      const note = String(text || '').trim();
      W.tag(tx.hash, { note: note });
      this.setState(p => ({ tx: Object.assign({}, p.tx, { note: note }) }));
      this.loadHistory();
    }, { edit: true });
  }

  /* One sheet, every caller. `o.edit`: a note that exists may be saved
   * empty, which removes it. */
  noteSheet(existing, onSave, o) {
    const editing = !!(o && o.edit) && !!String(existing || '').trim();

    const root = document.createElement('div');
    root.style.cssText =
      'position:fixed;inset:0;z-index:2147483500;background:rgba(0,0,0,.72);' +
      'display:flex;flex-direction:column;justify-content:flex-end;' +
      'animation:foxyIn .16s ease';

    const card = document.createElement('div');
    card.style.cssText =
      'background:#141518;border-radius:28px 28px 0 0;padding:26px 24px ' +
      'calc(26px + env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:14px;' +
      'transition:transform .18s ease';

    /* Sit above the keyboard.
     *
     * iOS does not resize the page for the keyboard here, so a sheet anchored
     * to the bottom ends up underneath it — the field invisible and the button
     * unreachable.
     *
     * visualViewport is the measurement when it works: it says how much of the
     * page is covered and the card lifts by exactly that. In this web view it
     * frequently reports nothing at all, and then there is no height to lift
     * by. So the fallback does not guess a keyboard height — it moves the card
     * to the top of the screen, which no keyboard can reach. Decided ~420ms
     * after focus, by which time a real measurement would have arrived.
     */
    const timers = [];
    let pinned = false;

    /* iOS scrolls the document to bring a focused field into view. This card
     * is position:fixed, so there is nothing to scroll to and the attempt just
     * slides the page, showing whatever is behind it. Hold it at zero. */
    const pinScroll = () => {
      if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0);
    };
    window.addEventListener('scroll', pinScroll, true);

    const covered = () => {
      const vv = window.visualViewport;
      if (!vv) return 0;
      return Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    };

    const lift = () => {
      pinScroll();
      const gap = covered();
      if (gap > 80) {
        pinned = false;
        root.style.justifyContent = 'flex-end';
        card.style.borderRadius = '28px 28px 0 0';
        card.style.paddingTop = '26px';
        card.style.paddingBottom = '26px';
        card.style.transform = 'translateY(-' + Math.round(gap) + 'px)';
      } else if (!pinned) {
        root.style.justifyContent = 'flex-end';
        card.style.borderRadius = '28px 28px 0 0';
        card.style.paddingTop = '26px';
        card.style.paddingBottom = 'calc(26px + env(safe-area-inset-bottom))';
        card.style.transform = 'none';
      }
    };

    const pinTop = () => {
      if (covered() > 80) return;
      pinned = true;
      root.style.justifyContent = 'flex-start';
      card.style.borderRadius = '0 0 28px 28px';
      card.style.paddingTop = 'calc(26px + env(safe-area-inset-top))';
      card.style.paddingBottom = '26px';
      card.style.transform = 'none';
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', lift);
      window.visualViewport.addEventListener('scroll', lift);
    }

    const title = document.createElement('div');
    title.style.cssText =
      'font-family:Sora,system-ui,sans-serif;font-size:22px;font-weight:800;' +
      'letter-spacing:-0.022em;color:#F5F1EC;text-align:center';
    title.textContent = 'WHAT IS THIS FOR?';
    card.appendChild(title);

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 120;
    input.value = existing;
    input.placeholder = 'Lunch, rent, a gift\u2026';
    input.style.cssText =
      'height:56px;border-radius:18px;background:#0B0B0C;border:1.5px solid ' +
      'rgba(245,241,236,.18);box-sizing:border-box;padding:0 16px;color:#F5F1EC;' +
      'font-family:Figtree,system-ui,sans-serif;font-size:18px;outline:none';
    card.appendChild(input);

    const save = document.createElement('div');
    save.style.cssText =
      'height:60px;border-radius:30px;display:flex;align-items:center;' +
      'justify-content:center;font-family:Sora,system-ui,sans-serif;font-size:20px;' +
      'font-weight:800;letter-spacing:0.02em';
    save.textContent = editing ? 'SAVE' : 'ADD';
    const setLive = () => {
      const ok = editing || input.value.trim().length > 0;
      save.style.background = ok ? '#F2802E' : 'rgba(245,241,236,.12)';
      save.style.color = ok ? '#fff' : 'rgba(245,241,236,.4)';
      save.style.cursor = ok ? 'pointer' : 'default';
      save.dataset.ok = ok ? '1' : '';
    };
    save.addEventListener('click', () => {
      if (!save.dataset.ok) return;
      close();
      onSave(input.value.trim());
    });
    input.addEventListener('input', setLive);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
    setLive();
    card.appendChild(save);

    const cancel = document.createElement('div');
    cancel.style.cssText =
      'height:52px;display:flex;align-items:center;justify-content:center;' +
      'font-family:Sora,system-ui,sans-serif;font-size:18px;font-weight:800;' +
      'color:rgba(245,241,236,.55);cursor:pointer';
    cancel.textContent = 'CANCEL';
    cancel.addEventListener('click', () => close());
    card.appendChild(cancel);

    function close() {
      timers.forEach(clearTimeout);
      window.removeEventListener('scroll', pinScroll, true);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', lift);
        window.visualViewport.removeEventListener('scroll', lift);
      }
      root.remove();
    }

    root.appendChild(card);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    document.body.appendChild(root);
    /* Synchronous, inside the tap that opened this sheet.
     *
     * iOS raises the keyboard only for a focus that happens within the user
     * gesture. Deferring it by even one tick left the field focused with the
     * keyboard down, which is why tapping the field again fixed it — that tap
     * was itself a gesture. The timed call below stays as a fallback. */
    input.focus();
    timers.push(setTimeout(() => { input.focus(); lift(); }, 90));
    timers.push(setTimeout(lift, 260));
    timers.push(setTimeout(pinTop, 420));
    timers.push(setTimeout(pinTop, 900));
  }
