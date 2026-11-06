
    /* ---- BANK ACCOUNT (08f-bank.js) -------------------------------------
     *
     * For SEND > BANK ACCOUNT. `bankExchanges` lists the three; a username is
     * cleaned by `bankUser` and looked up by `bankLookup`; what is chosen is
     * kept by `bankSave` and read back by `bankSaved` (`bankForget` drops it);
     * `bankOpen` opens the exchange's site, which opens its app where it is
     * installed (the native side holds the addresses: FoxyBridge
     * `companySites`). */

    // [{ key, name, domain, by }], in the order the list shows them
    bankExchanges: function () {
      return ['strike', 'river', 'cashapp'].map(function (k) {
        return { key: k, name: BANK[k].name, domain: BANK[k].domain, by: BANK[k].by, unchecked: !!BANK[k].unchecked };
      });
    },
    bankUser: function (ex, raw) { return bankUser(ex, raw); },
    bankLookup: function (ex, raw) { return bankLookup(ex, raw); },
    bankSaved: function () { return bankSaved(); },
    bankSave: function (ex, raw) { return bankSave(ex, raw); },
    bankForget: function () { try { localStorage.removeItem(BANK_KEY); } catch (e) {} },
    bankOpen: function (ex) {
      var b = BANK[ex];
      if (!b || !FoxyWallet.openCompany) return Promise.resolve();
      return FoxyWallet.openCompany(b.site);
    },
