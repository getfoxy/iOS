import SwiftUI
import WebKit
import Network
import CryptoKit

/// Hosts the Foxy web app and wires the camera bridge to it.
///
/// The controller is what presents the scanner, so `bridge.presenter` is self —
/// no digging around for a root view controller.
final class WebHostController: UIViewController {

    private var webView: WKWebView!
    private let bridge = FoxyBridge()
    private var splash: UIImageView?

    /// The green at the top of the splash art. Everything that could show a
    /// bare frame — the host view, the web view before it paints — is set to
    /// this rather than black, so there is nothing dark to flash.
    /* The ground the splash art sits on, and the colour of any frame before it
     * paints. It is the art's own background — black since the sleeping fox
     * replaced the green one — so a launch never shows a
     * band of some other colour at an edge. */
    private static let splashGreen = UIColor(red: 0, green: 0, blue: 0, alpha: 1)

    /// What the app itself paints, straight from its stylesheet. The green is
    /// only right until the page has painted; after that it is the colour that
    /// shows in any gap iOS opens — moving the web view for the keyboard, most
    /// of all — and a band of bright green is not what belongs there.
    private static let appBackground = UIColor(red: 5/255, green: 5/255, blue: 5/255, alpha: 1)

    /* A shake presses TAP on the receive screen (TAP-TO-PAY.md). iOS
     * recognises the gesture — the same one as shake to undo — and hands it
     * down the responder chain; the web view does not take it, so it lands
     * here. Shake to undo itself is off, or a text field being edited would
     * put an Undo alert over the page on the same shake. */
    override var canBecomeFirstResponder: Bool { true }

    @objc private func deviceTurned() {
        let o = UIDevice.current.orientation
        // only the two that mean something here; face up, face down and landscape leave it as it was
        guard o == .portrait || o == .portraitUpsideDown else { return }
        bridge.turned(upsideDown: o == .portraitUpsideDown)
    }

    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake { bridge.shaken() }
        super.motionEnded(motion, with: event)
    }

    override func viewDidLoad() {
        UIApplication.shared.applicationSupportsShakeToEdit = false
        /* Which way up the phone is, for the invoice screen to turn itself
         * round: a receiver lays the phone on the table top-down, and the
         * payer across it reads the code the right way up.
         * The app stays locked to portrait for iOS; the page does the turn. */
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        NotificationCenter.default.addObserver(self, selector: #selector(deviceTurned),
                                               name: UIDevice.orientationDidChangeNotification, object: nil)
        super.viewDidLoad()

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // the confirmation chime and the denial buzz are synthesised with
        // WebAudio; without this iOS refuses to start the context until a tap
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(bridge, name: "foxy")

        // The proofs live in this store, and they are the money. By default iOS copies it
        // into iCloud and iTunes backups, so the whole wallet leaves the phone
        // every time the phone backs up — readable by Apple on a standard
        // iCloud account, by a forensic tool, or by anyone holding an
        // unencrypted computer backup.
        //
        // Excluding it stops the copy. Protecting it means the file is
        // unreadable while the device is locked, except across a lock that
        // happens with the file already open.
        //
        // The seed itself is in the keychain (SeedStore), this device only, and
        // never in this store on a phone.
        Self.protectWebStore()

        // No connection the page's engine opens reaches the network, whatever
        // kind of load opens it. The content rules and the page policy stop
        // requests; a connection WebKit opens on its own, such as a
        // <link rel="preconnect">, may be neither (audit I1). So every
        // connection this web view's network process makes goes to a SOCKS proxy
        // on 127.0.0.1:9, where nothing listens, with no failover: it fails.
        // Foxy's own requests go through Route, never through the web view.
        var deadEndPort: NWEndpoint.Port = 9
        #if DEBUG
        // -FoxyWebProxyOff YES: only as the control run for -FoxyNetBlockTest.
        // -FoxyWebProxyPort N: point the proxy at a listener, to see what uses it.
        let deadEndOff = UserDefaults.standard.bool(forKey: "FoxyWebProxyOff")
        let debugPort = UserDefaults.standard.integer(forKey: "FoxyWebProxyPort")
        if debugPort > 0, debugPort < 65536, let port = NWEndpoint.Port(rawValue: UInt16(debugPort)) { deadEndPort = port }
        #else
        let deadEndOff = false
        #endif
        var deadEnd = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: deadEndPort))
        deadEnd.allowFailover = false
        if !deadEndOff {
            config.websiteDataStore.proxyConfigurations = [deadEnd]
        }

        // the page's user-scalable=no is obeyed (no zoom, below)
        config.ignoresViewportScaleLimits = false
        webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        /* No zoom. A pinch magnified the whole app past the screen's edges and
         * left it there. The page's viewport says
         * user-scalable=no, which WKWebView honours while
         * ignoresViewportScaleLimits is off (set before the web view is made);
         * the scroll view is held at 1 as well, so a pinch has nothing to do
         * either way. */
        webView.scrollView.minimumZoomScale = 1
        webView.scrollView.maximumZoomScale = 1
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isOpaque = false
        webView.backgroundColor = Self.splashGreen
        webView.navigationDelegate = self
        // a long press shows no link preview, which would load the link outside Tor
        webView.allowsLinkPreview = false

        // lets you attach Safari's inspector to the running app
        #if DEBUG
        webView.isInspectable = true
        #endif

        // No WebRTC, in any frame, before any of the page's own script runs.
        //
        // The content rule list and the page policy stop every request the page
        // could make — except WebRTC. A peer connection's STUN traffic is UDP
        // that neither of them sees, and it goes straight out, not through Tor,
        // so any hostile script in the page could learn the phone's IP address
        // with it. The page never uses WebRTC; it is removed, not fenced.
        config.userContentController.addUserScript(WKUserScript(
            source: Self.noWebRTC,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false))

        // No long-press callout or text-selection menu outside text fields.
        // Look Up, Translate and Search Web hand the selected text to system
        // services on the open network.
        config.userContentController.addUserScript(WKUserScript(
            source: """
            (function () {
              var s = document.createElement('style');
              s.textContent = 'html{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}'
                + 'input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text}';
              (document.head || document.documentElement).appendChild(s);
            }());
            """,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true))

        // Twelve hours or twenty-four, as this phone's Settings say. The
        // page's own locale knows the region's habit and not that switch, so
        // history would show 2:45 PM on a phone set to 14:45. Read once, at
        // launch; nothing about the phone but this leaves it.
        let hour = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: Locale.current) ?? ""
        config.userContentController.addUserScript(WKUserScript(
            source: "window.__foxyClock24 = " + (hour.contains("a") ? "false" : "true") + ";",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))

        // Debug builds mirror the page's console into the native log. The
        // page used to ask over the bridge, which raced its own boot; a flag
        // set before any script runs is answerable synchronously.
        #if DEBUG
        config.userContentController.addUserScript(WKUserScript(
            source: "window.FOXY_DEBUG = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        // the first-launch warning again, on a debug build launched with FOXY_SHOW_WARNING=1
        if ProcessInfo.processInfo.environment["FOXY_SHOW_WARNING"] == "1" {
            config.userContentController.addUserScript(WKUserScript(
                source: "window.FOXY_SHOW_WARNING = true;",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true))
        }
        #endif

        // In release, the page says nothing.
        //
        // The logs name mint hosts, balances, Tor exit IPs and clipboard
        // prefixes. That is useful at a desk and it is a gift to anything that
        // can read the device console. console.error survives — when something
        // fails you still want to know why.
        #if !DEBUG
        config.userContentController.addUserScript(WKUserScript(
            source: """
            (function () {
              var noop = function () {};
              console.log = noop;
              console.warn = noop;
              console.info = noop;
              console.debug = noop;
            }());
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        #endif

        view.backgroundColor = Self.splashGreen
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        addSplash()

        bridge.webView = webView
        bridge.presenter = self
        // from launch, what Foxy puts on the pasteboard, the web view's own copies
        // included, so the restore screen can refuse to take it as typed words
        SeedPasteboard.watch()

        // iOS suspends the web view when the app goes away, and visibilitychange
        // is not dependable across that. Tell the page explicitly that it is back.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appBecameActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )

        // How long Foxy was really in the background, for the page's confirming
        // check. Face ID and Control Center take the app's focus without
        // sending it to the background, and do not count.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appEnteredBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )

        // Cover the screen whenever Foxy stops being the active app, before
        // iOS takes the app-switcher snapshot.
        // only a real return from the background, not a prompt or Control Center
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(cameToFront),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(resigningActive),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )

        // Recording, AirPlay mirroring or a capture app: the page hides the seed
        // while it lasts. A screenshot cannot be stopped, but the page is told.
        registerForTraitChanges([UITraitSceneCaptureState.self]) { (host: WebHostController, _: UITraitCollection) in
            host.captureChanged()
        }
        NotificationCenter.default.addObserver(
            self, selector: #selector(screenshotTaken),
            name: UIApplication.userDidTakeScreenshotNotification, object: nil)

        #if DEBUG
        // The unit tests (tools/unit-tests.sh) run inside this app and test
        // rules, not the running wallet. Hosting them, Foxy touches no keychain
        // item, starts no Tor and loads no page, so nothing reaches the network
        // and nothing changes the state the tests read.
        if Self.hostingUnitTests {
            print("[foxy] hosting unit tests: no keychain, Tor or page")
            return
        }
        #endif

        // A fresh install must not inherit the last one's seed.
        Self.forgetSeedIfReinstalled()
        /* Tor starts itself, and the page is told every change.
         *
         * Nothing reaches a mint until Tor is up, or until the person chooses
         * to continue without it on the screen that appears when it cannot
         * connect. With Orbot on, Foxy's Tor goes past it through Orbot's
         * bypass port once the person allows it. */
        bridge.startTor()

        load()

        /* The page says when it has the screen covered itself — the launch
         * intro, or CONNECTING TO TOR — and the splash goes then, with nothing
         * of the bare home shell showing in between. */
        NotificationCenter.default.addObserver(forName: FoxyBridge.pageCovered, object: nil,
                                               queue: .main) { [weak self] _ in
            self?.hideSplash()
            self?.removeCover()
        }

        // A page that never finishes must not leave the splash up forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            self?.hideSplash()
        }

        #if DEBUG
        // From here a foxy:// link has a page to reach. Set after the unit-test
        // return above, so a test host — which loads no page — is never it.
        Self.live = self
        flushDeepLink()
        #endif
    }

    /// Covers the web view from the moment the controller exists until the page
    /// has painted, so the launch image hands over to this rather than to black.
    private func addSplash() {
        let image = UIImageView(image: UIImage(named: "FoxySplash"))
        image.contentMode = .scaleAspectFill      // fill the screen, crop the overflow
        image.clipsToBounds = true
        image.backgroundColor = Self.splashGreen
        image.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(image)
        NSLayoutConstraint.activate([
            image.topAnchor.constraint(equalTo: view.topAnchor),
            image.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            image.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            image.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        splash = image
    }

    private func hideSplash() {
        // Set every time, not just on the first call: this is the moment the
        // handover is over, whichever path got here.
        webView?.backgroundColor = Self.appBackground
        view.backgroundColor = Self.appBackground
        guard let image = splash else { return }
        splash = nil
        UIView.animate(withDuration: 0.35, animations: {
            image.alpha = 0
        }, completion: { _ in
            image.removeFromSuperview()
        })
    }

    /// The web view may load nothing from the network. WebKit enforces it.
    ///
    /// Every request Foxy makes goes through the native side, which sends it
    /// over Tor or refuses it. The page itself never needs the network, but
    /// until this it could reach it: its Content-Security-Policy allowed
    /// connect-src https: and wss:, so a fetch or a WebSocket from the page —
    /// written by mistake, or injected — would have gone straight out from
    /// this phone's address. A policy lives inside the page and can be undone
    /// by the page; a content rule list is installed on the web view from here
    /// and applies whatever the JavaScript does.
    private static let noNetworkRules = """
    [
      {"trigger": {"url-filter": "^https?:"}, "action": {"type": "block"}},
      {"trigger": {"url-filter": "^wss?:"}, "action": {"type": "block"}},
      {"trigger": {"url-filter": "^ftp:"}, "action": {"type": "block"}}
    ]
    """

    private func load() {
        // before the page's first load writes any storage (SeedMigrationWindow)
        SeedMigrationWindow.noteLaunch()
        guard let index = stageWebFiles() else {
            showMissingBundle()
            return
        }
        // Tell the page its own hash, before any of its script runs.
        //
        // The drawer shows the first twelve characters (21-render-values.js),
        // so the person can compare the page on the phone with
        // `python3 tools/page-hash.py` at the commit they reviewed. A document-
        // start script rather than an evaluateJavaScript after loading, so the
        // value is there for the page's first render and cannot be raced.
        // Only hex from manifestHash goes in, never a path or a name.
        webView.configuration.userContentController.addUserScript(WKUserScript(
            source: "window.__foxyPageHash = '\(Self.pageHash.filter { $0.isHexDigit })';",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))

        #if DEBUG
        if UserDefaults.standard.bool(forKey: "FoxyNetBlockOff") {
            DebugLog.both("[netblock]", "rule list DISABLED for a control run")
            loadStaged(index)
            return
        }
        #endif
        // The page is not loaded until the block is in place. If it cannot be
        // built, Foxy does not start rather than starting without it.
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "foxy-no-network",
            encodedContentRuleList: Self.noNetworkRules
        ) { [weak self] list, error in
            DispatchQueue.main.async {
                guard let self else { return }
                guard let list else {
                    print("[foxy] could not build the web view's network block:", error.map { "\($0)" } ?? "?")
                    self.hideSplash()
                    self.showFatal("Foxy could not start safely.\n\nThe block that keeps this screen off the network could not be built. Close Foxy and open it again.")
                    return
                }
                self.webView.configuration.userContentController.add(list)
                self.loadStaged(index)
            }
        }
    }

    private func loadStaged(_ index: URL) {
        let readRoot = index.deletingLastPathComponent()
        print("[foxy] loading", index.path)
        SeedVault.pageWillLoad()                  // nothing kept for the page before carries over
        webView.loadFileURL(index, allowingReadAccessTo: readRoot)
    }

    private func showFatal(_ text: String) {
        let label = UILabel()
        label.text = text
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = .white
        label.font = .systemFont(ofSize: 15)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28),
        ])
    }

    /// Removes the page's WebRTC constructors and locks them so a later script
    /// cannot put them back.
    static let noWebRTC = """
    (function () {
      ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate',
       'RTCSessionDescription', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver',
       'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport', 'RTCCertificate',
       'RTCPeerConnectionIceEvent', 'RTCDataChannelEvent', 'RTCTrackEvent'].forEach(function (name) {
        try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch (e) {}
      });
    }());
    """

    #if DEBUG

    // MARK: - Driving Foxy from outside (Debug only)

    /// The host that is on screen, so a `foxy://` link can reach the page it shows.
    private static weak var live: WebHostController?

    /// The hash a link asked for, waiting for a page that can be told about it.
    /// A link that launches Foxy arrives long before the page has loaded.
    private static var pendingDeepLink: String?

    /// `foxy://receive?amt=50&unit=sat&rail=cashu` → the page's own
    /// `#foxy=receive&amt=50&unit=sat&rail=cashu` (`applyDeepLink`, 05-device-shell.js).
    ///
    /// Putting a simulator on a screen with an amount on it took a dozen taps and was the
    /// single biggest drag on testing; it is now one command:
    ///
    ///     xcrun simctl openurl booted "foxy://receive?amt=50&unit=sat&rail=cashu"
    ///
    /// DEBUG ONLY, and deliberately so: a URL that drives a wallet to a send screen with
    /// an amount filled in is an attack surface, and any app on the phone can open a
    /// registered scheme. The scheme is registered from a Debug-only Info.plist
    /// (project.yml), this code is compiled out of Release, and the page reads the
    /// parameters only where `window.FOXY_DEBUG` is set — which is injected inside
    /// `#if DEBUG` too. A Release Foxy has no scheme to be reached through, would run
    /// none of this, and would ignore the parameters if a hash reached it anyway.
    ///
    /// Nothing from the URL is interpolated into the page. The target is matched against
    /// the list below and each parameter against what it is allowed to be; the hash is
    /// rebuilt from what matched, so what goes to JavaScript is drawn from a fixed set
    /// (plus digits). Anything else is dropped without a word to the page.
    static func receiveDeepLink(_ url: URL) {
        guard url.scheme?.lowercased() == "foxy" else { return }
        // foxy://receive, foxy:///receive and foxy:receive all name the same screen
        let named = url.host ?? url.path.split(separator: "/").first.map(String.init) ?? ""
        let target = named.lowercased()
        guard ["home", "receive", "send", "token", "nfc", "split"].contains(target) else {
            print("[deeplink] no such screen:", url.absoluteString.prefix(80))
            return
        }
        var parts = ["foxy=" + target]
        for item in URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [] {
            let value = (item.value ?? "").lowercased()
            switch item.name.lowercased() {
            case "amt":
                // digits, at most two decimal places. The page checks it again against
                // the unit the screen is in, and drops it if it does not fit.
                if value.range(of: "^[0-9]{1,9}([.][0-9]{1,2})?$", options: .regularExpression) != nil {
                    parts.append("amt=" + value)
                }
            case "unit":
                if ["sat", "sats", "usd"].contains(value) { parts.append("unit=" + value) }
            case "rail":
                if ["lightning", "cashu", "onchain", "on-chain"].contains(value) {
                    parts.append("rail=" + value)
                }
            default:
                print("[deeplink] ignored parameter:", item.name)
            }
        }
        pendingDeepLink = parts.joined(separator: "&")
        live?.flushDeepLink()
    }

    /// Hands the waiting link to the page, once there is a loaded page to hand it to.
    /// Called when the controller appears and again when the page finishes loading, so
    /// a link that launched Foxy lands as soon as there is something to land on.
    func flushDeepLink() {
        guard let hash = Self.pendingDeepLink, let webView, webView.url != nil else { return }
        Self.pendingDeepLink = nil
        print("[deeplink] #" + hash)
        /* applyDeepLink clears the hash once it has acted, so the same link twice in a
         * row is still a change and still fires hashchange. The page also re-reads the
         * hash for the first second and a half after it mounts, which covers a link that
         * arrives while it is still booting. */
        webView.evaluateJavaScript("location.hash = '\(hash)'")
    }

    /// With -FoxyNetBlockTest YES: try the network from the page and log what
    /// happened. Run once with the block and once with -FoxyNetBlockOff YES, and
    /// once with -FoxyWebProxyOff YES. -FoxyNetBlockHost names where the link,
    /// image, beacon and worker attempts go (default example.com), so a listener
    /// there can see whether any connection arrived: those loads may not report
    /// failure to the page.
    static func runNetBlockTest(_ webView: WKWebView) {
        let js = """
        const r = [];
        // WebRTC: only whether it exists, in this frame and a fresh blank one —
        // never a real peer connection, which would contact a STUN server
        r.push(typeof RTCPeerConnection === 'undefined' ? 'webrtc removed' : 'webrtc AVAILABLE');
        try {
          const f = document.createElement('iframe');
          document.body.appendChild(f);
          const cw = f.contentWindow;
          r.push(!cw ? 'blank frame has no window' :
            (typeof cw.RTCPeerConnection === 'undefined' ? 'webrtc removed in a blank frame' : 'webrtc AVAILABLE in a blank frame'));
          f.remove();
        } catch (e) { r.push('blank frame refused (' + e.message + ')'); }
        try { await fetch('https://example.com/?foxy-netblock', { mode: 'no-cors', cache: 'no-store' }); r.push('fetch SENT'); }
        catch (e) { r.push('fetch blocked (' + e.message + ')'); }
        await new Promise(function (ok) {
          let ws;
          try { ws = new WebSocket('wss://echo.websocket.org/'); }
          catch (e) { r.push('websocket blocked at construction (' + e.message + ')'); ok(); return; }
          const t = setTimeout(function () { r.push('websocket no answer in 8s'); ok(); }, 8000);
          ws.onopen = function () { clearTimeout(t); r.push('websocket OPENED'); ws.close(); ok(); };
          ws.onerror = function () { clearTimeout(t); r.push('websocket blocked'); ok(); };
        });
        // Connections the page may not hear about: preconnect, DNS prefetch,
        // prefetch, an image, a beacon and a worker's fetch. What reached the
        // network is seen at the listener, not here.
        for (const [tag, attrs] of [
          ['link', { rel: 'preconnect', href: 'https://' + host + '/foxy-preconnect' }],
          ['link', { rel: 'dns-prefetch', href: 'https://' + host + '/' }],
          ['link', { rel: 'prefetch', href: 'https://' + host + '/foxy-prefetch' }],
          ['img', { src: 'https://' + host + '/foxy-img.png' }],
        ]) {
          try { const e = document.createElement(tag); Object.assign(e, attrs); document.head.appendChild(e); r.push(tag + ' ' + (attrs.rel || 'src') + ' added'); }
          catch (e) { r.push(tag + ' refused (' + e.message + ')'); }
        }
        try { r.push('beacon ' + (navigator.sendBeacon('https://' + host + '/foxy-beacon', 'x') ? 'queued' : 'refused')); }
        catch (e) { r.push('beacon threw (' + e.message + ')'); }
        await new Promise(function (ok) {
          try {
            const src = "fetch('https://" + host + "/foxy-worker', { mode: 'no-cors' }).then(function () { postMessage('SENT'); }, function (e) { postMessage('blocked (' + e.message + ')'); })";
            const wk = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            const t = setTimeout(function () { r.push('worker no answer in 6s'); ok(); }, 6000);
            wk.onmessage = function (m) { clearTimeout(t); r.push('worker fetch ' + m.data); ok(); };
            wk.onerror = function (e) { clearTimeout(t); r.push('worker refused (' + (e.message || 'error') + ')'); ok(); };
          } catch (e) { r.push('worker refused at construction (' + e.message + ')'); ok(); }
        });
        await new Promise(function (ok) { setTimeout(ok, 3000); });
        return r.join(' | ');
        """
        let host = UserDefaults.standard.string(forKey: "FoxyNetBlockHost") ?? "example.com"
        webView.callAsyncJavaScript(js, arguments: ["host": host], in: nil, in: .page) { result in
            switch result {
            case .success(let value): DebugLog.both("[netblock]", String(describing: value))
            case .failure(let error): DebugLog.both("[netblock]", "test threw: \(error)")
            }
        }
    }

    /// With -FoxySeedSelfTest YES: the wallet's own steps on the fake-money test
    /// mint, every output built from secrets the phone derives (counterReserve,
    /// restoreSecrets), over the app's own Tor. Connects to
    /// nofee.testnut.cashu.space without making it the saved mint, claims a
    /// 100-sat invoice the test mint pays itself, sends a 21-sat token and takes
    /// it back, then scans this wallet's own seed there with no words, since the
    /// page has none, and logs the phone's counters for the keysets that scan
    /// walked. Logs one [nativesecretstest] line.
    static func runSeedSelfTest(_ webView: WKWebView) {
        let js = """
        const out = [];
        const W = window.FoxyWallet;
        const MINT = 'https://nofee.testnut.cashu.space';
        const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
        // the launch connect first, so this does not race it
        for (let i = 0; i < 240 && !(W && W.mintHost && W.mintHost()); i++) await wait(1000);
        try {
          await W.connect(MINT, null, null, { remember: false });
          out.push('connected ' + W.mintHost());
          const inv = await W.invoice(100, 'seed self-test');
          const sats = await new Promise((ok, no) => {
            const t = setTimeout(() => no(new Error('not paid within 180s')), 180000);
            W.watch(inv.hash, (r) => { clearTimeout(t); ok(r.sats); }, { pollMs: 3000 });
          });
          out.push('claimed ' + sats);
          const tok = await W.sendToken(21);
          out.push('token ' + tok.sats);
          const back = await W.receiveToken(tok.token);
          out.push('took back ' + back.sats);
          // this wallet's own seed, with no words: the phone serves its secrets
          const rows = await W.scanSeed(null, [MINT]);
          const row = rows[0] || {};
          out.push('own seed scan ' + row.state + ' ' + row.sats + ' sat');
          // The phone's counters, where the page exposes them; keyset ids and
          // counters are not secret. The scan's keysets pick out the test mint's,
          // and without them every counter is logged.
          const snap = W.counterSnapshot ? await W.counterSnapshot() : null;
          if (snap) {
            const all = snap.counters && typeof snap.counters === 'object' ? snap.counters : snap;
            const ids = row.counters && typeof row.counters === 'object' ? Object.keys(row.counters) : Object.keys(all);
            out.push('counters ' + (ids.map((k) => k + ' ' + all[String(k).toLowerCase()]).join(', ') || 'none'));
          } else {
            out.push('counters skipped (the page has no counterSnapshot)');
          }
          out.push('balance here ' + (await W.balanceSats()) + ' sat');
          if (W._secretsHeld) out.push('secrets still held ' + W._secretsHeld());
          out.push('PASS');
        } catch (e) {
          out.push('FAIL ' + (e && e.message ? e.message : String(e)));
        }
        return out.join(' | ');
        """
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value): DebugLog.both("[nativesecretstest]", String(describing: value))
            case .failure(let error): DebugLog.both("[nativesecretstest]", "threw: \(error)")
            }
        }
    }

    /// With -FoxySeedScreenTest show, verify, enter, counters or wipe: the seed
    /// actions asked for from the page, through the bridge as the page asks, and
    /// each answer logged in one [seedscreentest] line. Secrets are logged only
    /// as counts. Checks first that the page's old word actions (seedRead,
    /// seedWrite, seedDelete) are unknown, and makes a seed if there is none.
    /// `counters` also sends seedMigrate words that are not a BIP-39 phrase, then
    /// a phrase that is: "bad request", then same or different, and the saved
    /// seed is never changed by it.
    static func runSeedScreenTest(_ webView: WKWebView, _ which: String) {
        let js = """
        const out = [];
        const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
        for (let i = 0; i < 60 && !(window.FoxyWallet && window.FoxyWallet._scanResult); i++) await wait(500);
        const W = window.FoxyWallet;
        if (!W) return 'FAIL no page';
        const ask = (action, extra) => new Promise((ok) => {
          const id = 'seedscreentest-' + Math.random().toString(36).slice(2);
          const prior = W._scanResult;
          W._scanResult = function (rid, text, error) {
            if (rid !== id) return prior.apply(this, arguments);
            W._scanResult = prior;
            let parsed = null;
            try { parsed = JSON.parse(text); } catch (e) {}
            let shown = error ? 'error "' + error + '"' : text;
            if (parsed && parsed.secrets) {
              shown = parsed.keysetId + ' start ' + parsed.start + ', ' + parsed.secrets.length + ' secrets, '
                + parsed.blindingFactors.length + ' blinding factors';
            }
            out.push(action + ': ' + shown);
            ok(error ? null : parsed);
          };
          window.webkit.messageHandlers.foxy.postMessage(Object.assign({ action: action, id: id }, extra || {}));
        });
        const K = '009a1f293253e41e';
        await ask('seedRead');
        await ask('seedWrite', { words: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' });
        await ask('seedDelete');
        const status = await ask('seedStatus');
        if (status && status.exists === false) await ask('seedCreate');
        if (which === 'show') await ask('seedShow', { verify: false });
        if (which === 'verify') await ask('seedShow', { verify: true });
        if (which === 'enter') {
          const typed = await ask('seedEnter');
          if (typed && typed.candidate) {
            await ask('restoreSecrets', { keysetId: K, start: 0, count: 5, candidate: typed.candidate });
            await ask('restoreSecrets', { keysetId: K, start: 900, count: 5, candidate: typed.candidate });
            await ask('seedAdopt', { candidate: typed.candidate });
            await ask('seedCandidateForget', { candidate: typed.candidate });
          }
        }
        if (which === 'counters') {
          await ask('counterSnapshot');
          await ask('countersImport', { counters: { [K]: 7 } });
          await ask('counterReserve', { keysetId: K, count: 3 });
          await ask('counterReserve', { keysetId: K, count: 0 });
          await ask('counterReserveAt', { keysetId: K, start: 5, count: 1 });
          await ask('counterReserveAt', { keysetId: K, start: 20, count: 2 });
          await ask('counterAdvance', { keysetId: K, next: 2 });
          await ask('restoreSecrets', { keysetId: K, start: 300, count: 22 });
          await ask('restoreSecrets', { keysetId: K, start: 300, count: 23 });
          await ask('seedMigrate', { words: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon' });
          await ask('seedMigrate', { words: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' });
        }
        if (which === 'wipe') await ask('seedWipe');
        await ask('counterSnapshot');
        return out.join(' | ');
        """
        webView.callAsyncJavaScript(js, arguments: ["which": which], in: nil, in: .page) { result in
            switch result {
            case .success(let value): DebugLog.both("[seedscreentest]", String(describing: value))
            case .failure(let error): DebugLog.both("[seedscreentest]", "threw: \(error)")
            }
        }
    }
    #endif

    /// Copy the web files out of the app bundle and into Caches, then load from
    /// there.
    ///
    /// WKWebView cannot be granted read access to the bundle directory — iOS
    /// refuses the sandbox extension, which shows up in the log as
    /// "Could not create a sandbox extension for …" and leaves sibling files
    /// like foxy-wallet.js failing to load, intermittently and confusingly.
    /// A directory the app owns has no such restriction.
    /// Library/Caches/web: where the page is staged, and the only place the
    /// navigation check lets the web view load from.
    private static var webDirectory: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("web", isDirectory: true)
    }

    private func stageWebFiles() -> URL? {
        let fm = FileManager.default
        guard let dir = Self.webDirectory else { return nil }

        // start clean so a rebuild never serves a stale mix of old and new
        try? fm.removeItem(at: dir)
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            print("[foxy] could not make the staging folder:", error)
            return nil
        }

        // The files may sit in a Web/ folder or be flattened into the bundle
        // root, depending on how Xcode added them. Either way, take everything
        // the web layer could need rather than a list of names — a hardcoded
        // list silently misses any file added later.
        let wanted = ["html", "js", "css", "json", "svg", "png", "jpg", "webp", "woff2", "woff", "wasm", "mp4"]
        var sources: [URL] = []

        if let webDir = Bundle.main.url(forResource: "Web", withExtension: nil),
           let items = try? fm.contentsOfDirectory(at: webDir, includingPropertiesForKeys: nil) {
            sources = items
        } else if let root = Bundle.main.resourceURL,
                  let items = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
            sources = items.filter { wanted.contains($0.pathExtension.lowercased()) }
        }

        // index.html has to be among them or there is nothing to load
        guard sources.contains(where: { $0.lastPathComponent == "index.html" }) else {
            print("[foxy] no index.html in the bundle; found:", sources.map { $0.lastPathComponent })
            return nil
        }

        // copyItem THROWS if the destination exists, so without removing the old
        // copy first the cache is written once on the very first launch and
        // never updated again — every later change to the web files silently
        // never reaches the screen. Remove, then copy.
        var staged = 0
        for source in sources {
            let target = dir.appendingPathComponent(source.lastPathComponent)
            do {
                if fm.fileExists(atPath: target.path) {
                    try fm.removeItem(at: target)
                }
                try fm.copyItem(at: source, to: target)
                staged += 1
            } catch {
                print("[foxy] could not stage", source.lastPathComponent, error)
            }
        }

        let index = dir.appendingPathComponent("index.html")
        guard fm.fileExists(atPath: index.path) else { return nil }
        // report bytes too, so a stale file is obvious at a glance
        let sizes = sources.sorted { $0.lastPathComponent < $1.lastPathComponent }.map { url -> String in
            let n = (try? fm.attributesOfItem(atPath: dir.appendingPathComponent(url.lastPathComponent).path)[.size]) as? Int ?? 0
            return "\(url.lastPathComponent) \(n)"
        }
        print("[foxy] staged \(staged)/\(sources.count) files:", sizes.joined(separator: ", "))
        Self.pageHash = Self.manifestHash(of: dir)
        // In groups of sixteen, which is not an evasion of the log's redaction
        // but the reason it does not apply: DebugLog hides runs of 64 hex
        // characters because that shape is a key or a seed in this app's logs.
        // This one is neither — tools/page-hash.py prints it, and the drawer
        // shows its first twelve characters — and a redacted line would leave
        // the log unable to say which page ran. page-hash.py prints the same
        // grouping, so the two can be compared as they stand.
        print("[foxy] page hash", Self.grouped(Self.pageHash))
        return index
    }

    /// The one number that ties this phone to the reviewed sources.
    ///
    /// `tools/verify-shipped.sh` proves the three generated files regenerate
    /// byte for byte from their sources at a commit, and `tools/verify-vendor.py`
    /// pins every vendored byte — but neither says anything about the app a
    /// person installed. Between the commit and the phone sit a build machine,
    /// a signing step and a delivery, and a page swapped anywhere along that
    /// road looks exactly like the reviewed one from inside the app. This
    /// hashes what was actually staged, so the person can read the number off
    /// the menu drawer and compare it with `python3 tools/page-hash.py` at the
    /// commit they reviewed.
    ///
    /// THE RULE, WHICH tools/page-hash.py FOLLOWS TOO
    ///
    /// One line per file, `"<sha256 of its bytes>␠␠<name>\n"`, sorted by name
    /// as bytes, files whose name begins with a dot left out; the manifest hash
    /// is the SHA-256 of those lines joined. `tools/page-hash.py` is where that
    /// rule is written down in prose — the two implementations have to agree on
    /// exactly which files count and in which order or the numbers mean nothing.
    ///
    /// The name is hashed alongside the content, so a file added, removed or
    /// renamed changes the number even when no file's content changed — a
    /// digest over the contents alone would not notice an extra script dropped
    /// into the folder. The line format is the one `shasum -a 256` prints, so a
    /// third party can recompute the whole thing with shasum and nothing else.
    ///
    /// Returns an empty string if the staged folder cannot be read, rather than
    /// a hash of nothing: a number that looks real but covers no files would be
    /// worse than none.
    static func manifestHash(of dir: URL) -> String {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return "" }
        var lines = ""
        for name in names.filter({ !$0.hasPrefix(".") }).sorted(by: { $0.utf8.lexicographicallyPrecedes($1.utf8) }) {
            guard let bytes = try? Data(contentsOf: dir.appendingPathComponent(name)) else { return "" }
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            lines += "\(digest)  \(name)\n"
        }
        guard !lines.isEmpty else { return "" }
        return SHA256.hash(data: Data(lines.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The hash of the page this run staged. Empty until staging has run.
    private(set) static var pageHash = ""

    /// A digest in groups of sixteen, for the log. tools/page-hash.py prints
    /// the same shape under the plain digest.
    static func grouped(_ hex: String) -> String {
        stride(from: 0, to: hex.count, by: 16).map { i -> String in
            let a = hex.index(hex.startIndex, offsetBy: i)
            let b = hex.index(a, offsetBy: min(16, hex.count - i))
            return String(hex[a..<b])
        }.joined(separator: " ")
    }

    /// What the app switcher shows is not the wallet.
    ///
    /// iOS photographs the screen as an app leaves the foreground and keeps
    /// that picture — in the switcher, and on disk. Without a cover it could be
    /// a balance, an invoice, a token, or the twelve words. The splash goes
    /// over everything first. It also appears for a moment during Face ID or
    /// when Control Center is pulled down, which is the price of never being
    /// late for the snapshot.
    ///
    /// Over the window, not this controller's view: the scanner, the share
    /// sheet and the Tor alert are presented above this view, and were left
    /// out from under a cover laid on it. Put up again on entering the
    /// background, in case anything was presented between the two.
    private var cover: UIImageView?

    /// Focus lost, which is usually the way out. Not when it is iOS's "Allow
    /// Paste" alert, which Foxy's own paste asked for: the splash flashed over
    /// the receive screen for as long as the alert was up. The app
    /// switcher cannot be reached while that alert is showing, and leaving
    /// Foxy still puts the cover up on entering the background.
    /// A tap that was mid-payment when Foxy went away asks the receiver what it
    /// missed, a moment after the app is running again.
    @objc private func cameToFront() {
        // before the page hears it is back: requests may leave again
        parkRun += 1
        Route.openDoor()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.bridge.tapWoke()
        }
    }

    @objc private func resigningActive() {
        if FoxyBridge.pastePromptExpected {
            print("[foxy] no app-switcher cover: the paste prompt has focus")
            return
        }
        coverScreen()
    }

    @objc private func coverScreen() {
        let host: UIView = view.window ?? view
        if let image = cover {
            host.bringSubviewToFront(image)
            return
        }
        let image = UIImageView(image: UIImage(named: "FoxySplash"))
        image.contentMode = .scaleAspectFill
        image.clipsToBounds = true
        image.backgroundColor = Self.appBackground
        image.frame = host.bounds
        image.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.addSubview(image)
        cover = image
        print("[foxy] app-switcher cover up")
    }

    private func removeCover() {
        guard let image = cover else { return }
        cover = nil
        UIView.animate(withDuration: 0.2, animations: { image.alpha = 0 },
                       completion: { _ in image.removeFromSuperview() })
    }

    @objc private func captureChanged() {
        bridge.pushCapture(FoxyBridge.screenCaptured(self))
    }

    @objc private func screenshotTaken() {
        bridge.pushScreenshot()
    }

    private var backgroundedAt: Date?
    /// Which putting-away is under way; a return makes the one before it stale.
    private var parkRun = 0

    @objc private func appEnteredBackground() {
        backgroundedAt = Date()
        coverScreen()
        // a seed kept for the native actions, or typed words, do not sit in memory while Foxy is away
        SeedVault.forgetNativeSeed()
        // nor does a seed screen stay up, to be found over the PIN lock on return
        SeedScreens.closeAll()
        /* The connection diary, written here because this is where a force-quit
         * begins: the app switcher only reaches an app already backgrounded, so
         * somebody killing Foxy to escape a stuck screen is who this is for. */
        FieldLog.saveForNextRun()
        // the screen sleeps again when Foxy is not the one being looked at
        FoxyBridge.letScreenSleep()

        /* The onion inbox goes with it. Tor is about to leave the network, and
         * the listener behind the address may not survive being suspended — so
         * an address that cannot be served would otherwise stay published,
         * pointing at nothing, while the request naming it sat on screen
         * looking fine. The page opens a fresh one when it comes back. */
        bridge.closeInboxForBackground()
        // Tor off the network before iOS suspends Foxy (TorService.backgrounded).
        // The background task holds the moment Tor's answer takes.
        var task = UIBackgroundTaskIdentifier.invalid
        let finish = {
            guard task != .invalid else { return }
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
        }
        task = UIApplication.shared.beginBackgroundTask(withName: "Tor off the network") { finish() }
        /* Not under a payment, not under the top-up that follows one, and not
         * under anything else that is with a mint.
         *
         * A swap, melt or mint that is with the mint right now is waited for,
         * and so is the small-change top-up the page starts when it is put
         * away (`_tidying`, tidyChangeLater): somebody who is paid and pockets
         * the phone would otherwise come back to a wallet with no change to
         * give. Twenty seconds at most — iOS allows about thirty — and half a
         * second after the last of it, for the page to write down what came
         * back.
         *
         * Then whatever else is out, three seconds at most, and from there
         * nothing new leaves (Route's door): a request cut while Tor was still
         * building its circuit costs Tor's trust in an entry relay, and the
         * next invoice pays for it. The rule is Route.leaving.
         *
         * If Foxy is brought back meanwhile, Tor stays where it is and the
         * door opens (appBecameActive). `parkRun` is which putting-away this
         * is: one that was overtaken by a return, and then by another
         * putting-away, must not park Tor under the second one's payment. */
        parkRun += 1
        let run = parkRun
        let began = Date()
        var said = false, saidRest = false
        var restSince: Date?
        func stillAway() -> Bool {
            run == self.parkRun && UIApplication.shared.applicationState == .background
        }
        func park() {
            guard stillAway() else {
                if run == self.parkRun { Route.openDoor() }
                finish()
                return
            }
            bridge.torBackgrounded { finish() }
        }
        func waitForRequests() {
            guard stillAway() else { finish(); return }
            webView.evaluateJavaScript("!!(window.FoxyWallet && window.FoxyWallet._tidying)") { [weak self] answer, _ in
                guard let self, run == self.parkRun else { finish(); return }
                let money = self.bridge.moneyInFlight.count
                let tidying = (answer as? Bool) == true
                let out = Route.out
                // the three seconds are for a stretch with no money moving, and start again after one that had
                if money > 0 || tidying { restSince = nil } else if out > 0, restSince == nil { restSince = Date() }
                let step = Route.leaving(money: money, tidying: tidying, out: out,
                                         waited: Date().timeIntervalSince(began),
                                         onTheRest: restSince.map { Date().timeIntervalSince($0) } ?? 0)
                guard case .leave(let after) = step else {
                    if (money > 0 || tidying) && !said {
                        said = true
                        print("[foxy] tor: staying on the network for \(money) money request(s) and the change top-up, 20s at most")
                    } else if money == 0 && !tidying && !saidRest {
                        saidRest = true
                        print("[foxy] tor: staying on the network for \(out) request(s) still out, 3s at most")
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { waitForRequests() }
                    return
                }
                if money > 0 || tidying {
                    print("[foxy] tor: still busy with the mint after 20s; leaving the network anyway")
                } else if out > 0 {
                    print("[foxy] tor: \(out) request(s) still out; leaving the network anyway")
                }
                // nothing new from here; what the page starts now is told it was not sent
                Route.shutDoor()
                DispatchQueue.main.asyncAfter(deadline: .now() + after) { park() }
            }
        }
        // a moment for the page to hear it has been put away and start its top-up
        webView.evaluateJavaScript("window.FoxyWallet && window.FoxyWallet._putAway && window.FoxyWallet._putAway(true)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { waitForRequests() }
    }

    @objc private func appBecameActive() {
        /* Whether Foxy actually went away, or only lost focus for a moment.
         *
         * A screenshot, Control Center, Face ID and a system alert all resign
         * active without backgrounding, and the cover goes up for every one of
         * them (resigningActive, before iOS takes its snapshot). Nothing
         * follows them: the page's wake path ignores an absence under a second
         * and never covers itself, so the backstop below was the only thing
         * taking the cover down — four seconds of splash after every
         * screenshot, and no launch screen behind it ("I
         * see the splash image for three or four seconds, and then the home
         * screen"). Nothing was reconnecting, so there was nothing to wait
         * for. */
        // back: a putting-away still waiting stops here, and requests may leave again
        parkRun += 1
        Route.openDoor()
        let wentAway = backgroundedAt != nil
        if !wentAway {
            removeCover()
        } else {
            /* The cover stays until the page has the screen again.
             *
             * Taking it off here showed whatever the page was last drawing —
             * the home screen — for the moment before the launch screen came
             * back up, which read as a flash on every return. The page says when it is covering itself
             * (FoxyBridge.pageCovered); this is the backstop for a page that
             * says nothing, so a return can never strand the cover on screen. */
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                self?.removeCover()
            }
        }
        // a paste alert that was up has been answered; leaving now is leaving
        FoxyBridge.pastePromptUntil = min(FoxyBridge.pastePromptUntil, Date().addingTimeInterval(2))
        let away = backgroundedAt.map { max(0, Int(Date().timeIntervalSince($0))) } ?? 0
        backgroundedAt = nil
        pushUptime()
        // Tor first: a set-up marks it not ready before the page hears of the return
        bridge.torResumed(away: away)
        webView?.evaluateJavaScript("window.FoxyWallet && window.FoxyWallet._resumed(\(away))")
    }

    /// Seconds since the phone started, which moving the clock does not change.
    /// The page counts the PIN wait with it (22-screen-lock.js), with the
    /// page's own monotonic clock between one of these and the next.
    private func pushUptime() {
        let s = ProcessInfo.processInfo.systemUptime
        webView?.evaluateJavaScript("window.__foxyUptime = { s: \(s), p: performance.now() }")
    }

    /// The one failure that looks like a blank screen otherwise.
    private func showMissingBundle() {
        let label = UILabel()
        label.text = "Could not stage the web files.\n\nCheck the target's Build Phases → Copy Bundle Resources lists index.html, foxy-wallet.js and qrcode.js."
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = .white
        label.font = .systemFont(ofSize: 15)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28),
        ])
    }

    override var prefersStatusBarHidden: Bool { false }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    /// Remove a seed left behind by a previous installation.
    ///
    /// Keychain items outlive app deletion. Without this, deleting Foxy and
    /// installing it again produced a wallet that already held a seed — with
    /// no proofs, no history and no onboarding, because the app believed it
    /// was set up. Confirmed on device.
    ///
    /// The signal is a file in the app's own container, not the web view's
    /// storage. WebKit can evict a web view's data when the device is short of
    /// space, and reading that as a reinstall would destroy the seed of a
    /// wallet still in use — which is the loss the keychain was adopted to
    /// prevent. This file is removed only when the app itself is, and an
    /// update leaves it alone.
    ///
    /// Runs before the web view exists, so nothing in JavaScript can see a
    /// seed that is on its way out.
    ///
    /// The marker goes into backups, like the installation it describes. It
    /// used to be excluded, and that turned a restore into a reinstall: a
    /// this-device-only keychain item comes back when a phone is restored
    /// from its own encrypted backup, the excluded marker did not, and the
    /// restored seed was deleted here — with the proofs, which are excluded
    /// from backups, already gone. The seed was the one thing left that could
    /// bring them back. A reinstall still removes the marker with the app, and
    /// a backup restored to a different phone brings the marker but not the
    /// seed, so neither case keeps a seed it should not.
    #if DEBUG
    /// XCTest launched this app to run FoxyTests in it.
    static var hostingUnitTests: Bool {
        ProcessInfo.processInfo.environment.keys.contains { $0.hasPrefix("XCTest") }
    }
    #endif

    static func forgetSeedIfReinstalled() {
        let fm = FileManager.default
        guard let support = fm.urls(for: .applicationSupportDirectory,
                                    in: .userDomainMask).first else { return }
        let marker = support.appendingPathComponent("foxy.install")

        if fm.fileExists(atPath: marker.path) {
            includeInBackups(marker)                // markers written before this were excluded
            return                                  // an ordinary launch, or an update
        }

        /* No marker: this installation has never run before, and whatever the
         * keychain holds came from one that was deleted. Both seed items go —
         * the one behind Face ID too, which this used to miss once the seed
         * moved there, so a reinstall offered the old words — and the hosts
         * that installation approved, and its Orbot key. Deleting reads
         * nothing, so it asks for no Face ID. */
        let seeds = [SeedStore.protectedKey, SeedStore.mnemonicKey]
            .map { SeedStore.deleteIfPresent(key: $0) }
        if seeds.contains(true) { print("[foxy] a seed from a previous installation was removed") }
        // and its note that a seed was behind the passcode, which a new wallet must not inherit
        SeedStore.deleteIfPresent(key: SeedStore.heldKey)
        for key in [HostApprovals.storeKey, HostApprovals.carriedKey, OrbotLink.tokenKey] {
            if SeedStore.deleteIfPresent(key: key) { print("[foxy] \(key) from a previous installation was removed") }
        }

        /* And nothing stands in front of a new wallet until its user puts it
         * there. The seed used to start behind Face ID, so a first receive put
         * "allow Face ID?" up over the invoice — and over a tap, where the
         * payer gave up while the receiver was being asked. The SECURE FOXY
         * card asks once money has arrived, and MENU changes it at any time.
         * Only here, on an installation that
         * has never run: one that already keeps its seed behind Face ID is
         * left exactly as it is. */
        SeedVault.protection = .none
        print("[foxy] seed: a new wallet starts with nothing in front of it; SECURE FOXY asks later")

        try? fm.createDirectory(at: support, withIntermediateDirectories: true)
        // in backups: it says nothing, and a restored backup must look like the
        // installation it came from
        try? Data("1".utf8).write(to: marker, options: .completeFileProtection)
        print("[foxy] install marker written")
    }

    private static func includeInBackups(_ url: URL) {
        var u = url
        guard (try? u.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup == true else { return }
        var values = URLResourceValues()
        values.isExcludedFromBackup = false
        do {
            try u.setResourceValues(values)
            print("[foxy] install marker now included in backups")
        } catch {
            print("[foxy] could not include the install marker in backups:", error)
        }
    }

    /// Keep the web view's storage on this device, and unreadable while locked.
    ///
    /// WKWebView keeps localStorage under Library/WebKit. Both attributes are
    /// applied to the directory and to everything already inside it, since the
    /// store exists before this runs on every launch after the first.
    static func protectWebStore() {
        let lib = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)
        guard let root = lib.first?.appendingPathComponent("WebKit") else { return }

        func apply(_ url: URL) {
            var u = url
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            do { try u.setResourceValues(values) }
            catch { print("[foxy] could not exclude from backup:", url.lastPathComponent, error) }

            do {
                try FileManager.default.setAttributes(
                    [.protectionKey: FileProtectionType.completeUnlessOpen],
                    ofItemAtPath: url.path)
            } catch {
                print("[foxy] could not set file protection:", url.lastPathComponent, error)
            }
        }

        if !FileManager.default.fileExists(atPath: root.path) {
            try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        }
        apply(root)
        if let walk = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) {
            for case let child as URL in walk { apply(child) }
        }
        print("[foxy] web store excluded from backups, protection completeUnlessOpen")
    }
}

extension WebHostController: WKNavigationDelegate {
    /// The page's process died — memory pressure, most often. The page is gone
    /// with it, so a fresh one is loaded, and the seed kept for its secrets and
    /// any typed words go too. Without this the screen was left blank.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        print("[foxy] the page's process ended; loading it again")
        SeedVault.forgetUnlock()
        bridge.pageGone()
        SeedVault.pageWillLoad()
        webView.reload()
    }


    /// didFinish fires when loading is done, which is a moment before the first
    /// paint. The short delay covers that gap; without it the splash lifts onto
    /// a blank page for a frame or two.
    /// What this web view is allowed to load: its own staged file, and
    /// nothing else.
    ///
    /// Nothing in the app navigates. If anything ever did — a bug, a crafted
    /// link, one future line of code — the page it landed on would inherit
    /// the entire native bridge: camera, clipboard, share, notifications,
    /// native network calls. Ten lines close that off permanently.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        // The staged copy under Library/Caches/web, and nothing above it. A
        // prefix of the real directory, both sides standardized and with
        // symlinks resolved: a substring test also let through any path that
        // merely contained "/Caches/web/", and "web/../" climbed out of it.
        if url.isFileURL, url.pathExtension == "html", let dir = Self.webDirectory {
            let root = dir.standardizedFileURL.resolvingSymlinksInPath().path
            let path = url.standardizedFileURL.resolvingSymlinksInPath().path
            if path.hasPrefix(root.hasSuffix("/") ? root : root + "/") {
                decisionHandler(.allow)
                return
            }
        }
        print("[foxy] navigation refused:", url.absoluteString.prefix(120))
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // WebKit sets the scroll view's zoom range from the page as it loads: held at 1 again
        webView.scrollView.minimumZoomScale = 1
        webView.scrollView.maximumZoomScale = 1
        webView.scrollView.setZoomScale(1, animated: false)
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "FoxyNetBlockTest") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { Self.runNetBlockTest(webView) }
        }
        if UserDefaults.standard.bool(forKey: "FoxySeedSelfTest") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { Self.runSeedSelfTest(webView) }
        }
        if let which = UserDefaults.standard.string(forKey: "FoxySeedScreenTest") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { Self.runSeedScreenTest(webView, which) }
        }
        // a foxy:// link that launched Foxy has been waiting for this
        flushDeepLink()
        #endif
        pushUptime()
        /* The splash is not lifted here at all.
         *
         * The page has only *loaded* at this point: it still has to unpack
         * itself, boot React and reach the gate. A timer here lifted the
         * splash onto whatever it had drawn by then, and on a slow boot that
         * was the bare home screen for a moment before the launch screen
         * appeared. The page says when it has the screen
         * covered (FoxyBridge.pageCovered); the only backstop is the eight
         * seconds armed in load(), for a page that never says anything. */
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        hideSplash()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        hideSplash()
    }
}

struct WebHost: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebHostController { WebHostController() }
    func updateUIViewController(_ controller: WebHostController, context: Context) {}
}

struct ContentView: View {
    var body: some View {
        #if DEBUG
        /* foxy://receive?amt=50&unit=sat — a testing affordance, and the whole of it is
         * here in Debug: Release registers no such scheme (project.yml) and has no
         * handler for one either. See WebHostController.receiveDeepLink. */
        WebHost()
            .ignoresSafeArea()
            .onOpenURL { WebHostController.receiveDeepLink($0) }
        #else
        WebHost().ignoresSafeArea()
        #endif
    }

}
