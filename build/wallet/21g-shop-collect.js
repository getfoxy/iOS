    /* ---- SHOPS (08g-shop-collect.js, docs/CASHU-ID.md "Shops") -------------
     *
     * For the screens. SHOPS lists `shops()`; ADD A SHOP reads a link with
     * `shopRead` and keeps it with `shopAdd`; REMOVE is `shopRemove`. The phone
     * collects by itself on every open and every ten minutes while open
     * (`shopCollectNow` asks at once), and says how it goes to
     * `_onShopCollect({ state, shop, id, n, of, why })`: 'collecting' (n of
     * `of`), 'collected' (n sales), 'idle' (nothing waited) or 'failed'. */

    /* The shops this phone collects for: { id, url, host, name, onion, at, lastAt, lastN, lastWhy,
     * paid: [{ id, name, n, at }] }, the collaborators each paid, newest first. A copy. */
    shops: function () { return JSON.parse(JSON.stringify(shopList())); },

    /* A shop link read: { url, host, name, onion, id }, or { why }. Never throws. */
    shopRead: function (text) { return shopRead(text); },

    /* A shop link kept (and collected from at once where there is a route): the shop. Throws with the sentence to show. */
    shopAdd: function (text) { return JSON.parse(JSON.stringify(shopAdd(text))); },

    /* Off the list: true where it was on it. */
    shopRemove: function (id) { return shopRemove(String(id || '')); },

    /* A collection now, every shop: resolves the sales collected. One at a time. */
    shopCollectNow: function () { return shopCollect(); },

    /* Whether one is running. */
    shopCollecting: function () { return !!shopRunning; },

    /** @type {?function(any): void} */
    _onShopCollect: null,
    // the suites' wait between collections (honoured only on a page a test marked: CID_TESTS)
    _shopEveryMs: 0,

