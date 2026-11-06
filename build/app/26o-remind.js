  /* ---- REMIND ME AFTER 15 DAYS (08i-remind.js, Reminder.swift) ----
   *
   * Only on a phone whose Cashu ID is in use. The first time it is, a card asks once (`remindAskCard`) and says why;
   * TURN ON has iOS ask its own question, NOT NOW leaves the switch in SETTINGS for later. Notifications already allowed
   * for payments turn it on with no card. The switch is the first row of SETTINGS. */

  // the row in SETTINGS: [the row], or [] with no ID in use. `sw` is the menu's own switch look.
  remindMenuRow(sw) {
    const W = window.FoxyWallet;
    if (!W || !W.remindView) return [];
    const v = W.remindView() || {};
    if (!v.eligible) return [];
    return [Object.assign({ label: 'REMIND ME AFTER 15 DAYS', path: 'M12 6v6l4 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
      tap: () => this.remindTap() }, sw(v.on === true))];
  }

  remindPaint() { this.setState({ menuTick: (this.state.menuTick || 0) + 1 }); }

  remindTap() {
    const W = window.FoxyWallet;
    if (!W || !W.remindView || this._remindBusy) return;
    if ((W.remindView() || {}).on === true) {
      this._remindBusy = true;
      Promise.resolve(W.remindTurnOff()).then(() => {
        this._remindBusy = false;
        this.remindPaint();
        this.toast('No reminder.');
      });
      return;
    }
    this.remindOn();
  }

  remindOn() {
    const W = window.FoxyWallet;
    if (!W || !W.remindTurnOn) return;
    this._remindBusy = true;
    Promise.resolve(W.remindTurnOn()).then((st) => {
      this._remindBusy = false;
      this.remindPaint();
      if (st === 'on') { this.toast('Foxy will remind you after 15 days away.'); return; }
      this.blockedCard('remindRefused', {
        tone: 'warn', title: 'NOTIFICATIONS ARE OFF',
        reason: 'Foxy is not allowed to notify you. Turn notifications on for Foxy in Settings, then try again.',
        retry: 'OPEN SETTINGS', go: () => { if (W.openSettings) W.openSettings(); },
        shut: { label: 'NOT NOW' },
      });
    }).catch((e) => {
      this._remindBusy = false;
      this.remindPaint();
      this.toast(W.reason ? W.reason(e) : String((e && e.message) || e), true);
    });
  }

  /* The ID is in use and nobody has been asked: the card, once. Called at every return past the lock (`wakeWork`), never over the code of MY CASHU ID. */
  remindMaybeAsk() {
    const W = window.FoxyWallet;
    if (!W || !W.remindStatus || this._remindAsking) return;
    this._remindAsking = true;
    Promise.resolve(W.remindStatus()).then((st) => {
      this._remindAsking = false;
      if (st === 'ask') this.remindAskCard();
      else if (st === 'on') this.remindPaint();
    }).catch(() => { this._remindAsking = false; });
  }

  remindAskCard() {
    const W = window.FoxyWallet;
    this.blockedCard('remindAsk', {
      tone: 'ask', title: 'REMIND YOU?',
      reason: 'Foxy can remind you after 15 days away, so a payment waiting for you is not missed.',
      retry: 'TURN ON', go: () => this.remindOn(),
      shut: { label: 'NOT NOW', tap: () => { if (W && W.remindNotNow) W.remindNotNow(); } },
    });
  }

