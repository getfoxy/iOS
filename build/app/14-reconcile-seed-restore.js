
  /* Ecash reconcile set aside instead of deleting: the person sees it and
   * decides. There was no way to see or restore it before. */
  /* Set-aside ecash with no record of its mint (quarantinedUnknown) is said
   * separately. It was counted in the card's figure and offered back, and
   * PUT IT BACK left it where it was without a word: unquarantine will not
   * guess a mint for it. When that is all there is, the card only says so \u2014
   * there is nothing to press. Nothing here deletes anything. */
  offerQuarantine() {
    const W = window.FoxyWallet;
    const sats = W && W.quarantinedSats ? W.quarantinedSats() : 0;
    const unknown = Math.min(sats, W && W.quarantinedUnknown ? W.quarantinedUnknown() : 0);
    const shown = sats + '|' + unknown;
    if (!sats || this._quarantineShown === shown) return;
    this._quarantineShown = shown;
    const noMint = (n) => this.group(n) + ' sats of set-aside ecash ' + (n === sats ? '' : 'also ')
      + 'have no record of which mint issued them, so Foxy keeps them aside rather than guess. '
      + 'They are not in your balance and nothing has been deleted.';
    if (unknown >= sats) {
      this.blockedCard('quarantine', {
        tone: 'warn',
        title: 'ECASH SET ASIDE',
        reason: noMint(unknown),
      });
      return;
    }
    this.blockedCard('quarantine', {
      tone: 'warn',
      title: 'ECASH SET ASIDE',
      reason: this.group(sats - unknown) + ' sats the mint called spent could not be rebuilt from your '
        + 'seed, so Foxy set them aside instead of deleting them. If you know this ecash is '
        + 'still good, put it back; otherwise leave it.',
      chip: unknown ? noMint(unknown) : undefined,
      retry: 'PUT IT BACK',
      go: () => {
        // asks the mint first, and waits its turn behind any payment
        W.unquarantine().then(r => {
          if (r.back) this.toast(this.group(r.back) + ' sats put back');
          else if (r.stillSpent) this.toast('The mint still says that ecash is spent, so it stays set aside.', true);
          else if (r.elsewhere) this.toast('That ecash is from another mint \u2014 switch to it to put it back.', true);
          else if (r.unknown) this.toast(this.group(r.unknown) + ' sats have no record of their mint, so they stay set aside.', true);
          this.refreshBalance();
        }).catch(e => this.toast(W.reason(e), true));
      },
    });
  }

  // The seed phrase, shown on demand. Built in plain DOM for the same reason
  // as the other overlays: it must appear reliably, and it must not depend on
  // the design runtime re-rendering.
  showSeed() {
    const W = window.FoxyWallet;
    if (!W || !W.showSeedNative) { this.toast('Seed phrases are not available on this build.', true); return; }
    /* The words are the phone's, and its own screen shows them
     * (W.showSeedNative), opened as this sheet opens. The sheet keeps what is
     * around them: showing them again, verifying, and deleting everything. */

    const el = (style, text) => {
      const d = document.createElement('div');
      d.style.cssText = style;
      if (text) d.textContent = text;
      return d;
    };

    // Metrics lifted from the confirm screens so this reads as part of the app
    // rather than a panel bolted onto it.
    const TITLE = 'font-family:SatSymbol,Sora,system-ui,sans-serif;font-size:22px;font-weight:800;'
      + 'letter-spacing:-0.022em;color:#fff;text-align:center;line-height:1.25';
    const SUB = 'padding:3px 6px 16px;font-size:22px;font-weight:600;letter-spacing:-0.005em;'
      + 'color:rgba(255,255,255,.62);text-align:center;text-wrap:pretty;line-height:1.35';
    const RULE = 'height:1px;background:rgba(255,255,255,.12);margin:0 0 16px';
    const SECONDARY = 'height:56px;border-radius:28px;background:rgba(255,255,255,.07);'
      + 'border:1.5px solid rgba(255,255,255,.18);box-sizing:border-box;display:flex;'
      + 'align-items:center;justify-content:center;font-family:SatSymbol,Sora,system-ui,sans-serif;'
      + 'font-size:22px;font-weight:700;letter-spacing:0.02em;color:#fff;cursor:pointer';
    const CTA = 'height:60px;border-radius:30px;background-color:#DC7F1C;'
      + "background-image:radial-gradient(120% 84% at 26% 0%,rgba(255,240,220,.26),"
      + "rgba(255,240,220,0) 62%),linear-gradient(168deg,rgba(247,154,60,.62),"
      + "rgba(232,98,42,.72) 48%,rgba(194,74,27,.78)),url('foxy-fur.webp');"
      + 'background-repeat:no-repeat,no-repeat,no-repeat;background-size:auto,auto,150% auto;'
      + 'background-position:center,center,50% 34%;display:flex;align-items:center;'
      + 'justify-content:center;font-family:SatSymbol,Sora,system-ui,sans-serif;font-size:22px;'
      + 'font-weight:700;letter-spacing:0.02em;color:#fff;cursor:pointer;'
      + 'box-shadow:inset 0 2px 0 rgba(255,255,255,.4),inset 0 -4px 0 rgba(0,0,0,.16),'
      + '0 12px 24px rgba(220,127,28,.34)';
    const SHEET = 'position:absolute;inset:0;z-index:2147483551;background:#050805;'
      + 'overflow:auto;font-family:Figtree,system-ui,-apple-system,sans-serif;'
      + 'padding:0 22px 34px;box-sizing:border-box;display:flex;flex-direction:column';

    const root = document.createElement('div');
    root.style.cssText = SHEET.replace('2147483551', '2147483550');
    // its DELETE wipes the wallet: closed by the lock, as the delete prompts are (pinLock)
    root.setAttribute('data-foxy-close-on-lock', '');

    // header row: back on the left, delete on the right, title centred under.
    // Leaving by the back button changes nothing — the words are already saved.
    const bar = el('display:flex;align-items:center;justify-content:space-between;'
      + 'gap:12px;padding:56px 0 0;flex:none');
    const del = el('flex:none;width:52px;height:52px;border-radius:50%;'
      + 'background:rgba(255,92,92,.14);border:1px solid rgba(255,92,92,.4);'
      + 'box-sizing:border-box;display:flex;align-items:center;justify-content:center;'
      + 'cursor:pointer');
    del.innerHTML = '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" '
      + 'stroke="#FF5C5C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7'
      + 'M6.5 7l.8 12.1A1.6 1.6 0 0 0 8.9 20.6h6.2a1.6 1.6 0 0 0 1.6-1.5L17.5 7'
      + 'M10.5 11v5.5M13.5 11v5.5"></path></svg>';
    const back = el('flex:none;width:52px;height:52px;border-radius:50%;'
      + 'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.16);'
      + 'box-sizing:border-box;display:flex;align-items:center;justify-content:center;'
      + 'cursor:pointer');
    back.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" '
      + 'stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M19.5 12H5m0 0 6-6m-6 6 6 6"></path></svg>';
    back.addEventListener('click', () => root.remove());
    bar.appendChild(back);
    bar.appendChild(el('flex:1'));
    bar.appendChild(del);
    root.appendChild(bar);

    root.appendChild(el('padding:14px 0 0;' + TITLE, 'YOUR SEED PHRASE'));
    root.appendChild(el(SUB,
      'These twelve words recover everything, on any Cashu wallet. The phone shows them '
      + 'on its own screen, where Foxy’s page cannot read them. Write them down on paper, '
      + 'never take a photo of them or save them on a computer.'));
    root.appendChild(el(RULE));

    // the words are on the phone's screen, behind its TAP TO REVEAL; from here they are shown again
    const again = el('flex:none;' + SECONDARY, 'SHOW MY WORDS');
    again.addEventListener('click', () => this.showSeedOnPhone(false, shown));
    root.appendChild(again);

    root.appendChild(el('flex:1;min-height:16px'));

    

    // once the phrase has been checked there is nothing left to verify
    const done = el('margin-top:10px;flex:none;' + CTA, 'VERIFY WORDS');
    /* Hidden until the words have been looked at: there is nothing to verify
     * before TAP TO REVEAL has been pressed on the phone's screen. The phone says whether it was, and a quiz passed there
     * leaves nothing to verify here either. */
    done.style.display = 'none';
    const checked = !!(W.backedUp && W.backedUp());
    const shown = (r) => {
      if (checked || (r && r.verified)) { done.style.display = 'none'; return; }
      if (r && r.revealed) done.style.display = '';
    };
    done.addEventListener('click', () => {
      root.remove();
      // straight into the check, which is an overlay like this screen is
      this.showVerify();
    });
    root.appendChild(done);

    del.addEventListener('click', () => this.askDeleteAll(root));

    document.body.appendChild(root);
    this.showSeedOnPhone(false, shown);
  }

  /* DELETE ALL DATA, held on the phone's seed screen (or the delete on the
   * older sheet): two prompts, then the wipe, which asks iOS for Face ID or the
   * passcode. `overlay` is removed once it is done. */
  askDeleteAll(overlay) {
    const el = (style, text) => {
      const d = document.createElement('div');
      d.style.cssText = style;
      if (text) d.textContent = text;
      return d;
    };
    /* Two prompts before anything is erased. The first states what goes, the
     * second exists because the first is the one people tap through. */
    /* A card rather than a full sheet: dimmed backdrop, red-edged panel from
     * the bottom, bin in a red circle, the destructive action first and a
     * plain dismiss under it. Same words as before. */
    const ask = (title, body, onYes) => {
      const back = document.createElement('div');
      back.setAttribute('data-foxy-close-on-lock', '');     // pinLock closes it
      back.style.cssText =
        'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.72);'
        + 'display:flex;flex-direction:column;justify-content:flex-end;'
        + 'animation:foxyIn .16s ease';

      const card = el(
        'position:relative;background:#141518;border-radius:28px 28px 0 0;'
        + 'padding:28px 26px calc(31px + env(safe-area-inset-bottom));display:flex;'
        + 'flex-direction:column;align-items:center;'
        + 'border-top:1px solid rgba(255,92,92,.5);'
        + 'box-shadow:inset 0 2px 0 rgba(255,92,92,.55)');

      const ring = el('width:72px;height:72px;border-radius:50%;background:rgba(255,92,92,.14);'
        + 'display:flex;align-items:center;justify-content:center;flex:none');
      ring.innerHTML =
        '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#FF5C5C" '
        + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M4 7h16M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7"></path>'
        + '<path d="M6.4 7 7.3 19a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5L17.6 7"></path>'
        + '</svg>';
      card.appendChild(ring);

      card.appendChild(el('font-family:Sora,system-ui,sans-serif;font-size:22px;font-weight:700;'
        + 'letter-spacing:-0.022em;color:#fff;text-align:center;margin-top:16px', title));
      card.appendChild(el('font-size:18px;font-weight:500;line-height:1.4;'
        + 'color:rgba(255,255,255,.62);text-align:center;margin-top:7px;text-wrap:pretty', body));

      const go = el('align-self:stretch;margin-top:24px;flex:none;height:60px;border-radius:30px;'
        + 'background:#E05252;display:flex;align-items:center;justify-content:center;'
        + 'font-family:Sora,system-ui,sans-serif;font-size:20px;font-weight:800;'
        + 'letter-spacing:0.02em;color:#fff;cursor:pointer', 'DELETE');
      const no = el('align-self:stretch;margin-top:12px;flex:none;height:56px;border-radius:28px;'
        + 'border:1.5px solid rgba(255,255,255,.22);box-sizing:border-box;display:flex;'
        + 'align-items:center;justify-content:center;font-family:Sora,system-ui,sans-serif;'
        + 'font-size:18px;font-weight:800;color:#fff;cursor:pointer', 'DISMISS');

      go.addEventListener('click', () => { back.remove(); onYes(); });
      no.addEventListener('click', () => back.remove());
      back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
      card.appendChild(go);
      card.appendChild(no);
      back.appendChild(card);
      document.body.appendChild(back);
    };

    ask('DELETE ALL DATA',
        'Are you sure you want to delete the keys and all data on this device?',
        () => ask('ARE YOU TRIPLE SURE?',
          'Every mint balance on this phone is erased and a new seed phrase is '
          + 'generated. Only this wallet’s twelve words can bring it back.',
          () => this.wipeAndRestart(overlay)));
  }

  /* The phone's own screen for the words (verify false) or its quiz (true).
   * Resolves { verified } or null; the wallet marks a passed quiz backed up.
   * `then` hears the answer; a refusal is said as a toast. */
  showSeedOnPhone(verify, then) {
    const W = window.FoxyWallet;
    return Promise.resolve().then(() => W.showSeedNative({ verify: !!verify })).then(r => {
      if (verify && r && r.verified) this.toast('Your seed phrase is checked');
      if (r && r.deleteAsked) this.askDeleteAll(null);
      if (then) then(r);
      return r;
    }).catch(e => {
      this.toast(W.reason(e), true);
      return null;
    });
  }

  /* Wipe, then act as if the app had just been installed. */
  wipeAndRestart(overlay) {
    const W = window.FoxyWallet;
    // the seed's delete waits on an iOS alert; a Cancel there erases nothing
    return Promise.resolve().then(() => W.wipeDevice()).then(res => this.wipedAndRestarting(overlay, res),
      e => this.toast(W.reason(e), true));
  }

  wipedAndRestarting(overlay, res) {
    const W = window.FoxyWallet;
    if (overlay) overlay.remove();
    clearInterval(this._refreshT);
    this.setState({
      walletLive: false, balSats: null, balUsd: null,
      screen: 'home', stack: [], contacts: [], txs: [],
    });
    console.log('[foxy] device wiped;', res.removed, 'keys removed, new seed generated');
    this.toast('Everything erased. A new seed phrase was generated.');
    this.retryConnect(W.defaultMint, 0);
  }

  // Swipe in from the left edge to go back, the way iOS does everywhere else.
  //
  // Listens on the document rather than any one screen, so it works wherever
  // you are without touching the markup. Only gestures that START within 24px
  // of the left edge count, so it never fights a horizontal scroll or a drag
  // inside the page.
  watchEdgeSwipe() {
    if (this._edgeOn) return;
    this._edgeOn = true;

    const EDGE = 24;      // how close to the edge it has to start
    const TRAVEL = 64;    // how far right before it counts
    const SLOP = 48;      // vertical wander allowed
    let live = false, x0 = 0, y0 = 0, t0 = 0;

    const start = (e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      live = t.clientX <= EDGE;
      x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
    };

    const end = (e) => {
      if (!live) return;
      live = false;
      const t = (e.changedTouches && e.changedTouches[0]);
      if (!t) return;

      const dx = t.clientX - x0;
      const dy = Math.abs(t.clientY - y0);
      const ms = Date.now() - t0;
      if (dx < TRAVEL || dy > SLOP || ms > 800) return;

      // the menu is a layer, not a screen: close that first
      if (this.state.open0) { this.setState({ open0: false }); return; }
      // and never leave a payment mid-flight
      if (this.state.sendPhase === 'in' || this.state.sendPhase === 'onchain') return;
      if (this.state.screen === 'home') return;

      console.log('[foxy] edge swipe: back');
      this.back();
    };

    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchend', end, { passive: true });
    this._edgeOff = () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchend', end);
    };
  }

  // Clear a list, on two taps. A single tap arms it and says so; a second
  // within four seconds does it. Neither touches money — history is a local
  // record the mint does not keep, and contacts are just saved names.
  askClear(which) {
    const W = window.FoxyWallet;
    if (!W) return;
    const now = Date.now();
    if (this._armed === which && now - (this._armedAt || 0) < 4000) {
      this._armed = null;
      if (which === 'history') {
        const clear = (forgetToken) => {
          W.clearHistory({ forgetToken });
          this.loadHistory();
          this.toast('History cleared');
        };
        /* A sent token nobody has claimed is money in a string. Clearing
         * history forgets its text, so say so first. */
        if (!W.tokensNotClaimed) { clear(false); return; }
        W.tokensNotClaimed().then(list => {
          if (!list.length) { clear(true); return; }
          const sats = list.reduce((a, t) => a + (Number(t.sats) || 0), 0);
          this.blockedCard('unclaimedTokens', {
            tone: 'warn',
            title: 'UNCLAIMED ECASH',
            reason: (list.length === 1 ? 'A token you sent' : list.length + ' tokens you sent') + ', '
              + this.group(sats) + ' sats, ' + (list.length === 1 ? 'has' : 'have') + ' not been claimed. '
              + 'Clearing history forgets ' + (list.length === 1 ? 'it' : 'them') + ' on this phone.',
            chip: 'Your twelve words can still restore unclaimed ecash.',
            retry: 'CLEAR ANYWAY',
            go: () => clear(true),
          });
        }).catch(() => clear(false));
      } else {
        W.clearContacts();
        // history would otherwise write every past payee straight back
        this._contactsCleared = true;
        this.setState({ contacts: [] });
        this.toast('Contacts cleared');
      }
      return;
    }
    this._armed = which;
    this._armedAt = now;
    this.toast('Tap again to clear ' + which);
  }
