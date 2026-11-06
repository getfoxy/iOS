
    /* ---- tips at the till, and the keeper's list of codes (08f-till-tips.js) ---
     *
     * For the screens. The keeper's answer to ACCEPT TIPS? as its till opens
     * (`tillTipsSet`, read back by `tillTipsNow`): { on, to, ids }, `to` 'self',
     * 'one' or 'group', `ids` up to eight { id, nostr, name, pct } whose
     * percentages add up to 100. A sale's tip in the keeper's own till is passed
     * on by `tillTipTaken`; a cashier's comes with its delivery and is passed on
     * by the wallet. `tillPassList` and `tillPassEnd` are CASHIER CODE's list. */

    tillTipsSet: function (t) { return tillTipsSet(t); },
    tillTipsNow: function () { return tillTipsNow(); },
    // an answer checked without keeping it: '' for a good one, else why not in a sentence
    tillTipsProblem: function (t) {
      try { tipsCheck(t); return ''; } catch (e) { return String((e && e.message) || e); }
    },

    /* Keeper: a sale in this phone's till has landed with a tip in it. `o`: { amount, unit, mint,
     * hash }, `amount` the tip in whole sats or cents of `unit`; passed on as the till's answer says.
     * Resolves { kept, jobs, waiting, seen }. */
    tillTipTaken: function (o) {
      try {
        return Promise.resolve(tipForward({ tips: tillTipsNow(), amount: o && o.amount, unit: o && o.unit,
          mint: (o && o.mint) || mintUrl, hash: o && o.hash, from: 'till' }));
      } catch (e) { return Promise.reject(e); }
    },

    /* Keeper: the codes, { live, past } (see `tillPassList`): each { id, label, unit, main, mints,
     * tips: { on, to, names, pcts }, made, exp, endedAt, how, until, text }. */
    tillPassList: function () { return tillPassList(); },
    // Keeper: END on a live code. True where one was ended.
    tillPassEnd: function (id) { return tillPassEnd(String(id || '')); },

    /* The tips, as one object for anything that passes tips on: check, split,
     * forward, jobs, carry, run, MAX_IDS, MIN. */
    tillTips: tillTips,
    // for the suites: the wait between a failed tip payment and the next try (ms), on a test page only
    _tillTipRetryMs: 0,
