    /* ---- the source interface -------------------------------------------
     *
     * Every money operation runs against a source. Today there is one kind —
     * Cashu — and one source at a time: the mint the wallet is connected to.
     * A source's id is therefore that mint's URL, byte for byte, and a key,
     * scope or record that named the current mint reads the same string from
     * sourceId() as it did from mintUrl. Nothing stored or shown changes by
     * one character, and there is no second kind yet.
     *
     * The typedef is the contract a second kind (a federation) would keep.
     * The adapter holds no state: its verbs call the wallet's own, which stay
     * where they are with their words and their error paths, and its id reads
     * the live connection. Flows that handle a mint URL as data — a visit and
     * its restore, a crossing, a token, a card — keep asking for `mintUrl`:
     * that is still the honest name for what they hold. */

    /**
     * @typedef {Object} MoneySource
     * @property {'cashu'} kind — the only kind in the seam phase
     * @property {() => string} sourceId — the current source's id ('' when none)
     * @property {() => Promise<Object|null>} info — the mint's own record; null when not connected
     * @property {() => Promise<number>} balance — 12-reading-and-price.js: balanceSats
     * @property {(sats: number, memo?: string) => Promise<Object>} invoice — 15-receiving.js: invoice
     * @property {(quoteId: string, onPaid: Function, opts?: Object) => *} watchInvoice — 15-receiving.js: watch
     * @property {(bolt11: string) => Promise<Object|null>} payQuote — 22-screen-lock.js: quoteFee
     * @property {(bolt11: string, onStage?: Function, opts?: Object) => Promise<Object>} pay — 16-sending.js: pay
     * @property {(sats: number, opts?: Object) => Promise<Object>} sendEcash — 19-bill-split.js: sendToken
     * @property {(text: string, opts?: Object) => Promise<Object>} receiveEcash — 19-bill-split.js: receiveToken
     * @property {() => Promise<Object>} onchainAddress — 16a-onchain.js
     * @property {(address: string, sats: number) => Promise<Object>} onchainQuote — 16a-onchain.js
     * @property {(plan: Object, feeIndex: number, onStage?: Function) => Promise<Object>} onchainPay — 16a-onchain.js
     * @property {(phrase: string, onEach?: Function) => Promise<Object>} recover — 13-restore.js: scanSeed, scoped to this source
     */

    /** The current source's id ('' when none). Today: the mint's own URL. */
    function currentSourceId() { return mintUrl; }

    /* The one adapter. Every verb delegates, resolved at call time. */
    var cashuSource = {
      kind: 'cashu',
      sourceId: function () { return currentSourceId(); },
      info: function () {
        return Promise.resolve(wallet ? (wallet.mintInfo || (wallet.getMintInfo && wallet.getMintInfo()) || null) : null);
      },
      balance: function () { return FoxyWallet.balanceSats(); },
      invoice: function (sats, memo) { return FoxyWallet.invoice(sats, memo); },
      watchInvoice: function (quoteId, onPaid, opts) { return FoxyWallet.watch(quoteId, onPaid, opts); },
      payQuote: function (bolt11) { return FoxyWallet.quoteFee(bolt11); },
      pay: function (bolt11, onStage, opts) { return FoxyWallet.pay(bolt11, onStage, opts); },
      sendEcash: function (sats, opts) { return FoxyWallet.sendToken(sats, opts); },
      receiveEcash: function (text, opts) { return FoxyWallet.receiveToken(text, opts); },
      onchainAddress: function () { return FoxyWallet.onchainAddress(); },
      onchainQuote: function (address, sats) { return FoxyWallet.onchainQuote(address, sats); },
      onchainPay: function (plan, feeIndex, onStage) { return FoxyWallet.onchainPay(plan, feeIndex, onStage); },
      recover: function (phrase, onEach) {
        return FoxyWallet.scanSeed(phrase, currentSourceId() ? [currentSourceId()] : [], onEach);
      },
    };
