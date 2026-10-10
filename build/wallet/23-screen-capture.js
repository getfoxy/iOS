    /* ---- the screen being recorded, mirrored or photographed -------------
     *
     * Anything marked data-foxy-secret — the seed words — is blurred while the
     * screen is recorded or shared, with a line saying why. A screenshot
     * cannot be stopped; the app is told, so it can say what the picture
     * holds. The native side pushes both; captureCheck asks at start. */
    _captureState: false,
    /** @type {Array<function(boolean): void>} */
    _captureFns: [],
    /** @type {Array<function(): void>} */
    _screenshotFns: [],

    _captured: function (on) {
      FoxyWallet._captureState = !!on;
      FoxyWallet._captureStyle();
      try { document.documentElement.classList.toggle('foxy-captured', !!on); } catch (e) {}
      FoxyWallet._captureFns.forEach(function (fn) { try { fn(!!on); } catch (e) {} });
    },

    _screenshot: function () {
      FoxyWallet._screenshotFns.forEach(function (fn) { try { fn(); } catch (e) {} });
    },

    _captureStyle: function () {
      if (document.getElementById('foxy-capture-style')) return;
      var st = document.createElement('style');
      st.id = 'foxy-capture-style';
      st.textContent =
        'html.foxy-captured [data-foxy-secret]{position:relative}' +
        'html.foxy-captured [data-foxy-secret]>*{filter:blur(18px)!important;pointer-events:none}' +
        'html.foxy-captured [data-foxy-secret]::after{content:"Hidden while the screen is recorded or shared";' +
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;' +
        'padding:0 24px;font:700 17px/1.35 system-ui,sans-serif;color:#F5F1EC}';
      (document.head || document.documentElement).appendChild(st);
    },

    captured: function () { return FoxyWallet._captureState; },
    onCapture: function (fn) { if (typeof fn === 'function') FoxyWallet._captureFns.push(fn); },
    onScreenshot: function (fn) { if (typeof fn === 'function') FoxyWallet._screenshotFns.push(fn); },

    captureCheck: function () {
      if (!bridged()) return Promise.resolve(false);
      return bridgeAsk('captured', null, 3000).then(function (t) {
        FoxyWallet._captured(t === 'yes');
        return t === 'yes';
      }).catch(function () { return FoxyWallet._captureState; });
    },

    /* 'sent' or 'received'. The native side turns it into fixed words; it no
     * longer takes text from the page, which let any script post anything. */
    notify: function (kind) {
      var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
      if (!mh || (kind !== 'sent' && kind !== 'received')) return false;
      mh.postMessage({ action: 'notify', id: 'n' + Date.now(), kind: kind });
      return true;
    },

    startPreview: function (el, onCode) {
      var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
      if (!mh || !el) return false;
      var r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return false;
      FoxyWallet._onLive = onCode || null;
      mh.postMessage({
        action: 'previewStart', id: 'p' + Date.now(),
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
      });
      return true;
    },

    stopPreview: function () {
      var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
      FoxyWallet._onLive = null;
      if (mh) mh.postMessage({ action: 'previewStop', id: 'p' + Date.now() });
    },

    /** @type {?function(string): void} */
    _onPreviewRefused: null,
    /* The native side would not put the camera where it was asked to. */
    _previewRefused: function (why) {
      if (FoxyWallet._onPreviewRefused) FoxyWallet._onPreviewRefused(String(why || ''));
    },

    /** @type {?function(string): void} */
    _onLive: null,
    _liveScan: function (text) {
      /* Said when nobody is listening. The camera reading a code and the page
       * doing nothing with it looks, from the chair, exactly like the camera
       * reading nothing. */
      if (!FoxyWallet._onLive) {
        console.warn('[foxy] scan: the camera read a code and no screen was waiting for one');
        return;
      }
      FoxyWallet._onLive(String(text || ''));
    },

    startPasteButton: function (el, onText) {
      var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
      if (!mh || !el) return false;
      var r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 20) return false;
      FoxyWallet._onPaste = onText || null;
      mh.postMessage({
        action: 'pasteStart', id: 'b' + Date.now(),
        x: Math.round(r.left), y: Math.round(r.top),
        w: Math.round(r.width), h: Math.round(r.height),
      });
      return true;
    },

    stopPasteButton: function () {
      var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.foxy;
      FoxyWallet._onPaste = null;
      if (mh) mh.postMessage({ action: 'pasteStop', id: 'b' + Date.now() });
    },

    /** @type {?function(string): void} */
    _onPaste: null,
    _pasted: function (text) {
      if (FoxyWallet._onPaste) FoxyWallet._onPaste(String(text || ''));
    },

    onResume: function (fn) { FoxyWallet._onResume = fn || null; },
    /** @type {?function(number): void} */
    _onResume: null,

    /* Back from the background, with the seconds away the native side measured.
     *
     * The app is told first. It confirms the connection before anything asks a
     * mint, and runs resumeSweeps after. The sweeps used to run first: on a
     * connection that no longer worked each waited out its own timeout, and the
     * app heard nothing until they had. */
    _resumed: function (away) {
      // secrets from the phone that no operation used do not outlive a trip to the background
      clearNativeSecrets(false, false);
      /* Nor does the circuit kept ready: iOS closes what a suspended app had
       * open, so it is opened again now, as Foxy comes to the front, on the
       * guess that the person is about to pay or be paid. With Tor still
       * coming back this does nothing, and Tor coming up asks again. */
      dropSpare();
      warmSpareSoon();
      // and the newest block header for the cards, if the one kept has grown old while the app was away
      headerLater();
      if (FoxyWallet._onResume) {
        FoxyWallet._onResume(Number(away) || 0);
        return;
      }
      FoxyWallet.resumeSweeps();
    },

    /* Claim anything paid while the app was away, settle any melt still in
     * flight, restore any swap whose answer was lost, and give an interrupted
     * mint switch another go. */
    resumeSweeps: function () {
      return FoxyWallet.sweepQuotes()
        .then(sweepPause).then(function () { return FoxyWallet.sweepMelts(); })
        .then(sweepPause).then(function () { return FoxyWallet.recoverSwaps(); })
        .catch(function (e) { console.warn('[foxy] resume sweep:', e && e.message); })
        /* After the melts are settled, so a crossing whose melt was cut has
         * been paid or given back by the time its note is looked at. */
        .then(function () { return (mintUrl && FoxyWallet.crossingsWaiting()) ? FoxyWallet.catchUpCrossings() : null; });
    },

    /* There is no wallet-wide event stream: a mint has no account to watch.
     * Kept so the app's listenWallet() call is harmless. */
    listen: function () { return function () {}; },

    expiry: { receive: 900, split: 900 },
  };

