  /* ---- the reminder after fifteen days away -----------------------------------------------------------------------
   *
   * Payments to this phone's Cashu ID wait at the relays until Foxy is opened. So a phone whose ID is in use
   * (`cidInUse`) can have Foxy remind it, once, fifteen days after Foxy was last in front: a notification made on the
   * phone (Reminder.swift, the `reminder` action) and sent by nobody. The phone replaces it every time Foxy comes to the
   * front or goes away, so it fires only after fifteen days away. The words are the phone's own; the page gives none.
   *
   * The page keeps two things (REMIND_KEY): `on`, the switch REMIND ME AFTER 15 DAYS in SETTINGS, and `asked`, that the
   * person has been asked once, the first time the ID is in use. iOS's own question is shown only after a yes.
   */
  var REMIND_KEY = 'foxy.remind';
  var REMIND_DAYS = 15;

  function remindLoad() {
    var s = load(REMIND_KEY, null);
    if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
    return { on: s.on === true, asked: s.asked === true, owed: s.owed === true };
  }

  function remindSave(s) { save(REMIND_KEY, { on: s.on === true, asked: s.asked === true, owed: s.owed === true }); }

  // { eligible, on }: the switch shows only with an ID in use
  function remindView() {
    var s = remindLoad();
    return { eligible: cidInUse(), on: s.on };
  }

  /* Where the reminder stands, asked of the phone only while nobody has been asked:
   * 'none' (no ID in use, or no phone to ask), 'on', 'off', or 'ask' (the card is due). Notifications already allowed
   * for payments turn it on with no card; refused in Settings, it is off and the question is over. */
  function remindStatus() {
    if (!cidInUse()) return Promise.resolve('none');
    var s = remindLoad();
    // a cancel that did not reach the phone is sent again now (the phone would keep reminding)
    if (s.owed && !s.on) {
      return bridgeAsk('reminder', { cancel: true }, 20000).then(function () {
        remindSave({ on: false, asked: true, owed: false });
        return 'off';
      }, function () { return 'off'; });
    }
    if (s.on) return Promise.resolve('on');
    if (s.asked) return Promise.resolve('off');
    return bridgeAsk('reminder', { days: REMIND_DAYS, ask: false }, 20000).then(function (t) {
      if (t === 'ok') { remindSave({ on: true, asked: true, owed: false }); return 'on'; }
      if (t === 'needs') return 'ask';
      remindSave({ on: false, asked: true, owed: false });
      return 'off';
    }, function () { return 'none'; });
  }

  // yes to the card, or the switch turned on: iOS is asked if it never was. Resolves 'on' or 'refused'.
  function remindTurnOn() {
    if (!cidInUse()) return Promise.resolve('refused');
    return bridgeAsk('reminder', { days: REMIND_DAYS }, 60000).then(function (t) {
      var on = t === 'ok';
      remindSave({ on: on, asked: true, owed: false });
      return on ? 'on' : 'refused';
    });
  }

  function remindTurnOff() {
    remindSave({ on: false, asked: true, owed: true });
    return bridgeAsk('reminder', { cancel: true }, 20000).then(function () {
      remindSave({ on: false, asked: true, owed: false });
      return 'off';
    }, function () { return 'off'; });
  }

  // NOT NOW: the question is not asked again; the switch is still there
  function remindNotNow() {
    var s = remindLoad();
    remindSave({ on: s.on, asked: true, owed: s.owed });
  }

