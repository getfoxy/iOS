    /* ---- the reminder after fifteen days away (08i-remind.js) ----
     *
     * `remindView` { eligible, on } for the switch REMIND ME AFTER 15 DAYS; `remindStatus` resolves 'none', 'on', 'off' or
     * 'ask' (the card is due); `remindTurnOn` resolves 'on' or 'refused'; `remindTurnOff` and `remindNotNow`. */
    remindView: function () { return remindView(); },
    remindStatus: function () { return remindStatus(); },
    remindTurnOn: function () { return remindTurnOn(); },
    remindTurnOff: function () { return remindTurnOff(); },
    remindNotNow: function () { remindNotNow(); },

