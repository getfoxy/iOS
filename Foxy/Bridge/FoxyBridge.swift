import UIKit
import CoreHaptics
import AudioToolbox
import WebKit
import LocalAuthentication
import UniformTypeIdentifiers
import UserNotifications
import LinkPresentation

/// Camera QR scanning for the web layer.
///
/// The prototype asks for a scan with:
///
///     const text = await FoxyWallet.scan('Scan your LNbits address');
///
/// which posts to the `foxy` message handler, gets a full-screen scanner, and
/// resolves with whatever was read. Wire it up once, where the web view is made:
///
///     let bridge = FoxyBridge()
///     bridge.webView = webView
///     bridge.presenter = self                       // any UIViewController
///     webView.configuration.userContentController.add(bridge, name: "foxy")
///
/// Info.plist needs NSCameraUsageDescription or the app is killed on first use.
/// Something plain: "Foxy uses the camera to scan payment codes."
final class FoxyBridge: NSObject, WKScriptMessageHandler {

    weak var webView: WKWebView?
    weak var presenter: UIViewController?

    /// Live camera sitting on top of the web view, inside the send screen's pane.
    private var live: LiveScanner?

    /// The system paste button, laid over the page's own paste button.
    private var pasteHost: PasteHost?

    /// The onion address the Cashu request on screen is paid to, and the
    /// payments waiting on the page's answer (FoxyBridge+Delivery.swift).
    var inbox: OnionInbox?
    /// An address opened ahead of time and given to nobody yet. See warmSpare().
    var spareInbox: OnionInbox?
    /// Addresses the screen has finished with that are still answering, because
    /// a payment may be crossing to one of them. See handleInboxClose(hold:).
    var retiringInboxes: [OnionInbox] = []
    var inboxAnswers: [String: OnionInbox.Answer] = [:]
    /// Which of those answers are for a payment that came over the tap link
    /// and not to an onion address. They outlive a trip to the background
    /// (`closeInboxForBackground`).
    var tapAnswerKeys: Set<String> = []
    /// The Nostr key the same request is also paid to, for the wallets that
    /// cannot reach an onion (NostrInbox). Made and thrown away with it.
    var nostrInbox: NostrInbox?
    /// Tap to pay over Bluetooth (FoxyBridge+Tap.swift): the invoice on screen,
    /// advertised; or the search for one, and the page's request waiting on it.
    /// `TapRx`/`TapTx`: the Bluetooth link on a phone, its stand-in in the
    /// simulator, which has no Bluetooth (TapLink.swift).
    var tapReceiver: TapRx?
    var tapPayer: TapTx?
    /// Whether a shake presses TAP right now: on only while the receive invoice
    /// screen is up with something to offer (TAP-TO-PAY.md).
    var shakeArmed = false
    /// Where the paste control was last said to be, so the log says it once.
    var pasteLogged = CGRect.null
    /// The phone is top-down. Kept so a receiver armed later starts out knowing.
    var tapTurned = false
    var tapPayId: String?
    /// The first install's Bluetooth question while it is on screen (handleBluetoothAsk).
    var bluetoothAsk: BluetoothAsk?
    /// A card held to the phone (FoxyBridge+Flashcard.swift): the one session
    /// open, and whether this app's applet has answered that it was chosen in
    /// it. `CardReader`: NFC on a phone, its stand-in in the simulator.
    var cardLink: CardReader?
    var cardSelected = false
    /* How the payer's page answers for change it was handed: held from the moment
     * M7 arrives until the page says whether it kept it. One at a time, because a
     * link carries one change message. */
    var tapChangeKeep: ((Bool) -> Void)?


    /// Bring Tor up as the app starts, and tell the page about every change.
    ///
    /// Nothing waits on it: the page asks for the state when it needs it and
    /// is told whenever it changes, and every native network call is refused
    /// until Tor is up or the person chooses to continue without it.
    ///
    /// Tor over Tor does not work, so with Orbot running Foxy's Tor goes past it
    /// through Orbot's bypass port, once the person allows that in Orbot; until
    /// then the Orbot screen asks them to.
    func startTor() {
        /* The system knows whether this phone is on a network, and the page has to
         * hear it: without this Foxy spends thirty seconds pretending to connect
         * through an interface that is not there before anything says so. */
        Route.onNetworkChange = { [weak self] in self?.pushPrivacy() }
        _ = Route.network
#if canImport(Tor)
        TorService.onChange = { [weak self] in
            self?.pushPrivacy()
            /* Tor up: start publishing an address before anyone asks for one.
             * Half a minute of publishing done in advance is half a minute a
             * payer does not spend retrying (warmSpare). */
            self?.warmSpare()
        }
        OrbotLink.onChange = { [weak self] state in
            TorService.orbotChanged(state)
            self?.pushPrivacy()
        }
        // Tor waits for Orbot's first answer — a refused connection or a reply,
        // well under a second — so its first connection already goes the right
        // way: past Orbot when Orbot runs, instead of into Orbot's tunnel.
        OrbotLink.start { TorService.start() }
        #if DEBUG
        ResumeDiagnostics.install()
        KeychainSelfTest.runIfAsked()
        #endif
#else
        pushPrivacy()
#endif
    }

    /// The app came forward after `away` seconds in the background.
    func torResumed(away: Int) {
#if canImport(Tor)
        TorService.resumed(away: TimeInterval(away))
        /* Back to a Tor that never went down: nothing changes, so nothing
         * says "up" and the address kept warm for the next request, closed as
         * Foxy left, was never started again (warmSpare runs on a change).
         * It does nothing unless Tor is up and there is no spare. */
        warmSpare()
#endif
    }

    /// The app is going to the background; `done` once Tor is off the network.
    func torBackgrounded(_ done: @escaping () -> Void) {
#if canImport(Tor)
        TorService.backgrounded(done)
#else
        done()
#endif
    }

    /// The screen started or stopped being recorded, mirrored or captured.
    func pushCapture(_ captured: Bool) {
        evaluate("window.FoxyWallet && window.FoxyWallet._captured && window.FoxyWallet._captured("
                 + (captured ? "true" : "false") + ")")
    }

    /// A screenshot was just taken. iOS cannot stop one; the page can say what it holds.
    func pushScreenshot() {
        evaluate("window.FoxyWallet && window.FoxyWallet._screenshot && window.FoxyWallet._screenshot()")
    }

    /// Is the screen being captured right now.
    static func screenCaptured(_ from: UIViewController?) -> Bool {
        (from?.traitCollection ?? UITraitCollection.current).sceneCaptureState == .active
    }

    private func pushPrivacy() {
        evaluate("window.FoxyWallet && window.FoxyWallet._privacy && window.FoxyWallet._privacy("
                 + Route.snapshot() + ")")
    }

    // MARK: Questions iOS draws

    /// How long a seed write waits for a yes to replacing the seed. Time enough
    /// to read the alert and decide; no answer by then is a no.
    static let seedAnswerWait: TimeInterval = 120

    /// The two seed alerts, word for word: seedAdopt asks the first before typed
    /// words replace a saved seed, and then Face ID or the passcode (review
    /// M8), and seedWipe the second before the seed is deleted and a
    /// new one made.
    static let replaceSeedTitle = "Replace this wallet's seed?"
    static let replaceSeedMessage = "Only replace it with words you wrote down yourself. Whoever gave you these words can take everything this wallet receives."
    static let deleteSeedTitle = "Delete this wallet's seed?"
    static let deleteSeedMessage = "The twelve words are removed from this iPhone, with everything else Foxy holds. Only a written copy of them can bring the money back."

    /// A seed write or delete is under way. Main queue.
    private var seedChanging = false

    /// A yes or no to deleting or replacing the seed, from an alert iOS draws,
    /// in the one queue every native question waits in (NativePrompts). No,
    /// when there is nothing to present it on. Main queue; `done` runs there.
    @discardableResult
    func confirmSeedChange(title: String, message: String, action: String,
                                   _ done: @escaping (Bool) -> Void) -> PromptQueue.Ticket {
        dispatchPrecondition(condition: .onQueue(.main))
        return NativePrompts.ask(NativePrompt(title: title, message: message, no: "Cancel",
                                              yes: action, yesStyle: .destructive),
                                 on: presenter, done)
    }

    /// The same question, for seedAdopt's thread, which waits inside
    /// SeedVault.write for the answer. It used to wait with no limit, so each
    /// write left behind while its alert was hidden or never presented held a
    /// thread for good. Now it waits `seedAnswerWait`; after that the answer is
    /// no, and the alert is taken down so a late tap cannot count (audit
    /// I3). Never on the main queue, which draws the alert.
    func confirmSeedChangeAndWait(title: String, message: String, action: String) -> Bool {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let answered = DispatchSemaphore(value: 0)
        let answer = Locked<Bool?>(nil)
        var ticket: PromptQueue.Ticket?
        DispatchQueue.main.async {
            ticket = self.confirmSeedChange(title: title, message: message, action: action) { yes in
                answer.value = yes
                answered.signal()
            }
        }
        if answered.wait(timeout: .now() + Self.seedAnswerWait) == .timedOut {
            DispatchQueue.main.sync { ticket?.cancel() }
            print("[foxy] seed change: no answer in \(Int(Self.seedAnswerWait))s, taken as no")
        } else {
            // Which button, in the log. A test run once showed
            // seedAdopt {"adopted":true} where Cancel was meant, and nothing in the
            // log could say whether Replace had been tapped or Cancel had done the
            // wrong thing; only asking the tester could. The answer carries no secret.
            print("[foxy] seed change: \"\(title)\" answered \(answer.value == true ? action : "Cancel")")
        }
        return answer.value ?? false
    }

    /// One seed change at a time. A second create, migrate, adopt or wipe, while one still
    /// waits for the keychain or for the person, is refused rather than stacked
    /// behind it (audit I3). Main queue.
    func beginSeedChange(id: String) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !seedChanging else {
            print("[foxy] seed change refused: another is still waiting")
            resolve(id: id, text: nil, error: "Another change to the seed is still waiting. Nothing was changed.")
            return false
        }
        seedChanging = true
        return true
    }

    /// The change is over, from any queue: the next may begin, and the page hears.
    func endSeedChange(id: String, text: String?, error: String?) {
        DispatchQueue.main.async {
            self.seedChanging = false
            self.resolve(id: id, text: text, error: error)
        }
    }

    /// The only way Tor is turned off: a tap on an alert iOS draws.
    ///
    /// The page used to ask for two taps on its own button. A script in the
    /// page — injected, or a bug — could have simulated both and switched
    /// every request to the open connection without the person knowing. It
    /// cannot tap a UIAlertController.
    private var confirming = false

    private func confirmUnprotected(_ done: @escaping (Bool) -> Void) {
        guard presenter != nil, !confirming else { done(false); return }
        confirming = true
        let orbotKey = SeedStore.load(key: OrbotLink.tokenKey) != nil
        NativePrompts.ask(NativePrompt(
            title: "Continue without Tor?",
            message: Self.unprotectedMessage(orbot: OrbotLink.state, keyStored: orbotKey),
            no: "Stay protected", yes: "Continue without Tor", yesStyle: .destructive),
                          on: presenter) { yes in
            self.confirming = false
            done(yes)
        }
    }

    /// What "Continue without Tor?" says. Orbot is named only when Foxy holds
    /// the key Orbot issued and Orbot answered it with a bypass port. Anything
    /// on the phone can answer 403 on Orbot's port while any VPN is up, and that
    /// used to make the alert say this traffic goes through Orbot's Tor
    /// (audit I5). Otherwise it says what happens without Tor.
    static func unprotectedMessage(orbot: OrbotLink.State, keyStored: Bool) -> String {
        if case .bypass = orbot, keyStored {
            return "Orbot is on, so this goes through Orbot's Tor for now. If Orbot stops, the mint and anyone you pay will see this phone's IP address. Foxy keeps trying its own Tor and switches to it as soon as it connects."
        }
        return "The mint, and anyone you pay, will see this phone's IP address. Foxy keeps trying Tor and switches to it as soon as it connects."
    }

    /// success on a payment, error on a rejection or an amount over balance,
    /// warning for the softer alerts, and a light tap for everything else.
    /// Kept alive while it plays; a released engine plays nothing.
    private static var hapticEngine: CHHapticEngine?

    private static func buzz(for seconds: Double) {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
            return
        }
        do {
            let engine = try hapticEngine ?? CHHapticEngine()
            hapticEngine = engine
            try engine.start()
            let event = CHHapticEvent(eventType: .hapticContinuous, parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: 1.0),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5),
            ], relativeTime: 0, duration: seconds)
            let pattern = try CHHapticPattern(events: [event], parameters: [])
            let player = try engine.makePlayer(with: pattern)
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        }
    }

    private func fireHaptic(_ kind: String) {
        DispatchQueue.main.async {
            switch kind {
            case "success", "error", "warning":
                let gen = UINotificationFeedbackGenerator()
                gen.prepare()
                gen.notificationOccurred(kind == "success" ? .success
                                       : kind == "error" ? .error : .warning)
            case "pulse":
                // a short knock, repeated by the page for as long as it wants one
                Self.buzz(for: 0.1)
            case "long":
                /* One strong buzz of half a second, for the moment two phones
                 * make contact: the person is holding one against the other and
                 * can see neither screen, so the phone in their hand is what
                 * tells them it landed.
                 *
                 * Core Haptics, because it is the only thing on iOS that can be
                 * asked for a duration — the feedback generators give taps, not
                 * lengths. Falls back to the system vibration, which is about
                 * the same length, where Core Haptics is unavailable. */
                Self.buzz(for: 0.5)
            case "heavy":
                let gen = UIImpactFeedbackGenerator(style: .heavy)
                gen.prepare()
                gen.impactOccurred()
            default:
                let gen = UIImpactFeedbackGenerator(style: .light)
                gen.prepare()
                gen.impactOccurred()
            }
        }
    }

    // MARK: The page's messages

    /// An action's handler: the id to answer with, and the whole message.
    typealias Handler = (FoxyBridge) -> (_ id: String, _ body: [String: Any]) -> Void

    /// Every action the page may ask for, and the one function that answers it.
    /// An action not listed here is refused. THREAT-MODEL.md §1 lists the same
    /// names, and FoxyTests fails when the two differ.
    static let handlers: [String: Handler] = [
        "scan": FoxyBridge.handleScan,
        "log": FoxyBridge.handleLog,
        "fieldLog": FoxyBridge.handleFieldLog,
        "fieldLogClear": FoxyBridge.handleFieldLogClear,
        "covered": FoxyBridge.handleCovered,
        "price": FoxyBridge.handlePrice,
        "candles": FoxyBridge.handleCandles,
        "clipboard": FoxyBridge.handleClipboard,
        "copy": FoxyBridge.handleCopy,
        "biometric": FoxyBridge.handleBiometric,
        // The seed and its counters, in every build (NativeSeedBridge.swift). The
        // words never cross the bridge: the page's seedRead, seedWrite and
        // seedDelete are gone, and asking for one is an unknown action.
        "seedStatus": FoxyBridge.handleSeedStatus,
        "seedCreate": FoxyBridge.handleSeedCreate,
        "seedMigrate": FoxyBridge.handleSeedMigrate,
        "countersImport": FoxyBridge.handleCountersImport,
        "counterReserve": FoxyBridge.handleCounterReserve,
        "counterReserveAt": FoxyBridge.handleCounterReserveAt,
        "counterAdvance": FoxyBridge.handleCounterAdvance,
        "counterSnapshot": FoxyBridge.handleCounterSnapshot,
        "restoreSecrets": FoxyBridge.handleRestoreSecrets,
        // The keys a payment request locks ecash to, derived from the seed at
        // NUT-13's P2PK path (Foxy/Keychain/P2PK.swift)
        "p2pkReserve": FoxyBridge.handleP2PKReserve,
        "p2pkPubkeys": FoxyBridge.handleP2PKPubkeys,
        "p2pkKey": FoxyBridge.handleP2PKKey,
        "seedShow": FoxyBridge.handleSeedShow,
        "seedEnter": FoxyBridge.handleSeedEnter,
        "seedAdopt": FoxyBridge.handleSeedAdopt,
        "seedCandidateForget": FoxyBridge.handleSeedCandidateForget,
        "seedWipe": FoxyBridge.handleSeedWipe,
        "seedProtection": FoxyBridge.handleSeedProtection,
        "seedProtect": FoxyBridge.handleSeedProtect,
        "orbotAccess": FoxyBridge.handleOrbotAccess,
        "orbotRefresh": FoxyBridge.handleOrbotRefresh,
        "privacy": FoxyBridge.handlePrivacy,
        "captured": FoxyBridge.handleCaptured,
        "torRetry": FoxyBridge.handleTorRetry,
        "unprotected": FoxyBridge.handleUnprotected,
        "mintRequest": FoxyBridge.handleMintRequest,
        "hostsKnown": FoxyBridge.handleHostsKnown,
        "isDebug": FoxyBridge.handleIsDebug,
        "previewStart": FoxyBridge.startPreview,
        "previewStop": FoxyBridge.handlePreviewStop,
        "pasteStart": FoxyBridge.startPasteControl,
        "pasteStop": FoxyBridge.handlePasteStop,
        "notify": FoxyBridge.notify,
        "share": FoxyBridge.handleShare,
        "openSettings": FoxyBridge.handleOpenSettings,
        "openCompany": FoxyBridge.handleOpenCompany,
        // Payment requests paid straight to the requester (FoxyBridge+Delivery.swift)
        "inboxOpen": FoxyBridge.handleInboxOpen,
        "inboxClose": FoxyBridge.handleInboxClose,
        "inboxAnswer": FoxyBridge.handleInboxAnswer,
        "onionPost": FoxyBridge.handleOnionPost,
        "nostrSend": FoxyBridge.handleNostrSend,
        // Tap to pay: an invoice handed between two phones over Bluetooth (FoxyBridge+Tap.swift)
        "tapReceiveStart": FoxyBridge.handleTapReceiveStart,
        "tapReceiveStop": FoxyBridge.handleTapReceiveStop,
        "tapPayStart": FoxyBridge.handleTapPayStart,
        "tapChange": FoxyBridge.handleTapChange,
        "tapChangeKept": FoxyBridge.handleTapChangeKept,
        "tapAsking": FoxyBridge.handleTapAsking,
        "tapChangeDue": FoxyBridge.handleTapChangeDue,
        "tapQuote": FoxyBridge.handleTapQuote,
        "tapTerms": FoxyBridge.handleTapTerms,
        "tapPayStop": FoxyBridge.handleTapPayStop,
        "bluetoothAsk": FoxyBridge.handleBluetoothAsk,
        "tapSend": FoxyBridge.handleTapSend,
        // A card that holds ecash, held to the phone (FoxyBridge+Flashcard.swift)
        "cardBegin": FoxyBridge.handleCardBegin,
        "cardSend": FoxyBridge.handleCardSend,
        "cardSay": FoxyBridge.handleCardSay,
        "cardAgain": FoxyBridge.handleCardAgain,
        "cardEnd": FoxyBridge.handleCardEnd,
        // A card's owner key stays in native code: the page gets its public half and signatures for a
        // fixed list of labels (NativeSeedBridge.swift)
        "cardOwnerKey": FoxyBridge.handleCardOwnerKey,
        "cardOwnerSign": FoxyBridge.handleCardOwnerSign,
        // The time a card is told, signed by the interim key (FoxyBridge+Flashcard.swift, CardTime.swift)
        "cardTime": FoxyBridge.handleCardTime,
        // A shake of the phone presses TAP (TAP-TO-PAY.md)
        "shakeStart": FoxyBridge.handleShakeStart,
        "shakeStop": FoxyBridge.handleShakeStop,
        "awake": FoxyBridge.handleAwake,
    ]

    /// What a message asks for, decided before anything runs.
    enum Dispatch {
        /// Not a message this bridge reads: no answer at all.
        case ignored
        case haptic(String)
        /// An action with no handler: answered with an error.
        case unknown(action: String, id: String)
        case run(Handler, id: String, body: [String: Any])
    }

    static func dispatch(_ message: Any) -> Dispatch {
        guard let body = message as? [String: Any] else { return .ignored }
        // Haptics arrive as { haptic: kind } with no action or id, so they are
        // handled before the guard below. The web side already decides when to
        // buzz and rate-limits repeats; this just makes it physical.
        if let kind = body["haptic"] as? String { return .haptic(kind) }
        guard let action = body["action"] as? String,
              let id = body["id"] as? String else { return .ignored }
        guard let handler = handlers[action] else { return .unknown(action: action, id: id) }
        return .run(handler, id: id, body: body)
    }

    /// The page Foxy staged, in its own main frame, and nothing else. The
    /// page's policy refuses frames and navigation is locked to that file,
    /// so this should never refuse anything; if it does, a frame or another
    /// page asked for the seed, the camera or the network, and gets none.
    static func answers(isMainFrame: Bool, originProtocol: String) -> Bool {
        isMainFrame && originProtocol == "file"
    }

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard Self.answers(isMainFrame: message.frameInfo.isMainFrame,
                           originProtocol: message.frameInfo.securityOrigin.protocol) else {
            print("[foxy] bridge message refused:", message.frameInfo.securityOrigin.protocol,
                  message.frameInfo.isMainFrame ? "main frame" : "subframe")
            return
        }
        switch Self.dispatch(message.body) {
        case .ignored:
            return
        case .haptic(let kind):
            fireHaptic(kind)
        case .unknown(let action, let id):
            resolve(id: id, text: nil, error: "Unknown action: \(action)")
        case .run(let handler, let id, let body):
            handler(self)(id, body)
        }
    }

    // MARK: One function per action

    // No "open": nothing used it, and it handed https links to Safari,
    // which reaches them outside Tor.

    /// The page says it has something of its own over the whole screen — the
    /// launch intro, or the CONNECTING screen — so the native splash can go
    /// without leaving a gap where the bare home shell shows through. Nothing
    /// is read from the message: it is a nudge, and the splash comes down on
    /// its own timers anyway (webView didFinish, and the 8s failsafe).
    static let pageCovered = Notification.Name("FoxyPageCovered")

    /* Screens somebody is looking at, not touching.
     *
     * An invoice on screen is held up for another phone to read, and the
     * connecting screen is watched while nothing is tapped — so iOS dims and
     * then locks in the middle of both. Asked for by the page, which is the
     * only side that knows which screen is up, and given back the moment that
     * screen goes: nothing here is allowed to outlive it.
     *
     * Also released whenever Foxy leaves the foreground, since iOS keeps the
     * flag per app and a stale one would be handed back a dimmed-screen bug
     * nobody could explain. */
    private func handleAwake(id: String, body: [String: Any]) {
        let on = (body["on"] as? Bool) ?? false
        DispatchQueue.main.async {
            guard UIApplication.shared.isIdleTimerDisabled != on else {
                self.resolve(id: id, text: "ok", error: nil)
                return
            }
            UIApplication.shared.isIdleTimerDisabled = on
            print("[foxy] screen kept awake:", on ? "yes" : "no")
            self.resolve(id: id, text: "ok", error: nil)
        }
    }

    /// Let the screen sleep again. Called as Foxy goes to the background: the
    /// flag belongs to the app, not the screen, so one left set would outlive
    /// the page that asked for it.
    static func letScreenSleep() {
        guard UIApplication.shared.isIdleTimerDisabled else { return }
        UIApplication.shared.isIdleTimerDisabled = false
        print("[foxy] screen kept awake: no (Foxy went away)")
    }


    private func handleCovered(id: String, body: [String: Any]) {
        NotificationCenter.default.post(name: Self.pageCovered, object: nil)
        resolve(id: id, text: "ok", error: nil)
    }

    /// The full-screen scanner.
    private func handleScan(id: String, body: [String: Any]) {
        presentScanner(id: id, prompt: Self.scannerPrompt(body["prompt"]))
    }

    /// Fixed wording only: the page does not write what a native screen says (I8).
    static func scannerPrompt(_ asked: Any?) -> String {
        let text = asked as? String ?? ""
        return scannerPrompts.contains(text) ? text : ""
    }

    /// JavaScript logs, forwarded so they show up in Xcode's console
    /// alongside the native ones — Safari's inspector is not always to hand.
    private func handleLog(id: String, body: [String: Any]) {
        print("[foxy-js]", body["text"] as? String ?? "")
        resolve(id: id, text: "ok", error: nil)
    }

    /// What Foxy has been doing, for the ERRORS and LOGS screens: the native
    /// lines and the page's own, in one list, redacted on the way in
    /// (FieldLog). `bad` for the short list.
    private func handleFieldLog(id: String, body: [String: Any]) {
        resolve(id: id, text: FieldLog.json(onlyBad: (body["bad"] as? Bool) ?? false), error: nil)
    }

    private func handleFieldLogClear(id: String, body: [String: Any]) {
        FieldLog.clear()
        print("[foxy] the log was cleared from the LOGS screen")
        resolve(id: id, text: "ok", error: nil)
    }

    /// The price, fetched natively. Two reasons: a file-loaded page cannot
    /// call these APIs cross-origin, and Coinbase refuses Tor exits — so
    /// the price silently stopped updating once everything went over Tor.
    ///
    /// mempool.space's onion leads. What was slow was never Tor:
    /// it was clearnet services turning Tor exits away — Coinbase outright,
    /// Cloudflare with a challenge, the rest by rate-limiting an exit address
    /// thousands of people share. Each refusal cost a four-second timeout, six
    /// times over, and a device log showed eight seconds of them
    /// after a circuit that had taken two. An onion has no exit in its path,
    /// so there is nothing to refuse it, and mempool answers it from its own
    /// cache. The address is the one mempool.space publishes in its
    /// Onion-Location header.
    /// mempool.space's own onion, as its Onion-Location header gives it.
    /// Public, and the same for everybody: it names nothing about this phone.
    static let mempoolOnion = "mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion"

    /// One circuit label for the price, made when the app starts. Within a
    /// session the asks ride the circuit already built, so only the first
    /// pays for the rendezvous; a new one each launch keeps the price from
    /// being a thread between sessions, and it is never a mint's circuit.
    private static let priceCircuit = MintCircuit.label(nil)

    private func handlePrice(id: String, body: [String: Any]) {
        // Tor, or the open connection if the person chose it, or refused.
        guard Route.available else {
            self.resolve(id: id, text: "", error: Route.refusal)
            return
        }
        // Six sources, tried in order, each with a short timeout. Over Tor
        // any single one can hang — mempool.space timed out at 10s and the
        // whole price fetch went with it, so each clearnet attempt gets 4s and
        // there are five more to fall through to.
        //
        // mempool's onion leads, and Kraken follows it: of the clearnet six
        // Kraken is the one that has answered every time over Tor. Coinbase
        // stays last because it turns Tor exits away.
        //
        // mempool.space over clearnet is gone, rather than kept behind its own
        // onion. A payment typed in dollars needs two sources within 2% of
        // each other before any sats move, and PriceWalk compares figures, not
        // who sent them: one operator answering twice would have satisfied
        // that check alone. The six left are six different operators.
        let sources: [(String, (Any) -> Double?)] = [
            ("http://\(Self.mempoolOnion)/api/v1/prices", { j in
                ((j as? [String: Any])?["USD"] as? NSNumber)?.doubleValue
            }),
            ("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", { j in
                guard let r = (j as? [String: Any])?["result"] as? [String: Any],
                      let pair = r.values.first as? [String: Any],
                      let c = pair["c"] as? [Any],
                      let last = c.first as? String else { return nil }
                return Double(last)
            }),
            ("https://www.bitstamp.net/api/v2/ticker/btcusd/", { j in
                guard let last = (j as? [String: Any])?["last"] as? String else { return nil }
                return Double(last)
            }),
            ("https://blockchain.info/ticker", { j in
                guard let usd = (j as? [String: Any])?["USD"] as? [String: Any] else { return nil }
                return (usd["last"] as? NSNumber)?.doubleValue
            }),
            ("https://api.gemini.com/v1/pubticker/btcusd", { j in
                guard let last = (j as? [String: Any])?["last"] as? String else { return nil }
                return Double(last)
            }),
            ("https://api.coinbase.com/v2/prices/BTC-USD/spot", { j in
                guard let d = (j as? [String: Any])?["data"] as? [String: Any],
                      let a = d["amount"] as? String else { return nil }
                return Double(a)
            })
        ]

        // Six sources at 4s each is 24s of worst case, and the page gives up
        // at 14s — so the chain gets its own deadline rather than working
        // through a list nobody is listening to any more. Failures are
        // usually instant refusals, so this only bites when everything hangs.
        //
        /* Through a bridge that walk could not work. With IsolateDestAddr
         * every source is a new destination and needs its own circuit, and
         * through obfs4 a first circuit took 3 to 24 seconds in simulator
         * trials. Each source timed out at 4 seconds before
         * its circuit existed, the walk gave up at 12 with the mint check
         * beside it, and the confirming check, finding nothing had got
         * through, tore down the circuits that were about to carry both.
         * So on a bridge two sources are asked at once, each given 20
         * seconds, the next starting as either fails, and the whole
         * request 30. The page waits a little longer than each limit
         * (12-reading-and-price.js).
         *
         * Direct used to keep one at a time — a direct circuit is there in
         * about a second, and a source that hangs is better dropped fast.
         * Two at a time now, because source 1 is an onion: reaching one means
         * fetching its descriptor and meeting it at a rendezvous point, which
         * on the first ask of a session is seconds of work, and four would
         * drop it before it began. So the onion gets a longer deadline of its
         * own (onion:) and Kraken starts beside it rather than behind it: a
         * cold onion can never make the price later than it was, and when the
         * exits are being refused the onion is the one that answers. */
#if canImport(Tor)
        let bridged = TorService.isRunning && TorService.transport != .direct
#else
        let bridged = false
#endif
        // agree: for a payment typed in dollars, whose sats this price decides.
        // Two sources must be within 2% of each other; one alone could be wrong.
        let agree = (body["agree"] as? Bool) ?? false
        PriceWalk(sources: sources, together: 2, perSource: bridged ? 20 : 4,
                  onion: bridged ? 25 : 10, circuit: Self.priceCircuit,
                  agree: agree) { price, error in
            self.resolve(id: id, text: price.map { String($0) } ?? "", error: price == nil ? error : nil)
        }.start(limit: agree ? (bridged ? 45 : 25) : (bridged ? 30 : 12))
    }

    /// Chart history, fetched natively for the same two reasons as the price:
    /// a file-loaded page cannot call these cross-origin, and this way the
    /// request sits behind the same gate everything else does. Kraken, so the
    /// chart and the price agree and one less company sees the traffic.
    private func handleCandles(id: String, body: [String: Any]) {
        // Tor, or the open connection if the person chose it, or refused.
        guard Route.available else {
            self.resolve(id: id, text: "", error: Route.refusal)
            return
        }
        // within what the chart offers: a number from the page must not
        // overflow the arithmetic below
        let want = min(max((body["g"] as? NSNumber)?.intValue ?? 3600, 60), 86400)
        let span = min(max((body["span"] as? NSNumber)?.intValue ?? 86400, 3600), 1461 * 86400)
        // Kraken takes minutes, from a fixed set, and returns at most 720
        // candles — so a long range steps up to a coarser interval rather
        // than coming back truncated.
        let allowed = [1, 5, 15, 30, 60, 240, 1440, 10080, 21600]
        var interval = allowed.first { $0 >= max(1, want / 60) } ?? 21600
        while span / (interval * 60) > 720, let next = allowed.first(where: { $0 > interval }) {
            interval = next
        }
        let since = Int(Date().timeIntervalSince1970) - span
        let url = URL(string: "https://api.kraken.com/0/public/OHLC?pair=XBTUSD"
                      + "&interval=\(interval)&since=\(since)")!
        var creq = URLRequest(url: url)
        creq.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        creq.timeoutInterval = 12
        let candleTask = Route.start(creq) { data, _, error in
            if let error {
                self.resolve(id: id, text: "", error: error.localizedDescription)
                return
            }
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let result = json["result"] as? [String: Any] else {
                self.resolve(id: id, text: "", error: "unreadable candles")
                return
            }
            // the pair key varies (XXBTZUSD), so take the first array value
            let series = result.values.compactMap { $0 as? [[Any]] }.first ?? []
            let rows: [[Double]] = series.compactMap { row in
                guard row.count > 4,
                      let t = (row[0] as? NSNumber)?.doubleValue,
                      let c = Double(String(describing: row[4])) else { return nil }
                return [t, c]
            }
            guard let out = try? JSONSerialization.data(withJSONObject: rows),
                  let text = String(data: out, encoding: .utf8) else {
                self.resolve(id: id, text: "", error: "could not encode candles")
                return
            }
            print("[foxy] candles:", rows.count, "at", interval, "min")
            self.resolve(id: id, text: text, error: nil)
        }
        if candleTask == nil { resolve(id: id, text: "", error: Route.refusal) }
    }

    private func handleClipboard(id: String, body: [String: Any]) {
        readClipboard(id: id)
    }

    /// Copy, with an expiry for things that are money.
    ///
    /// An ecash token is a bearer instrument: whoever holds the text can
    /// spend it. On the general pasteboard it has no expiry and iOS pushes
    /// it to every iCloud-paired Mac and iPad. Only native code can say
    /// otherwise, so the page asks here for anything sensitive.
    private func handleCopy(id: String, body: [String: Any]) {
        let text = body["text"] as? String ?? ""
        let sensitive = (body["sensitive"] as? Bool) ?? false
        if text.isEmpty {
            resolve(id: id, text: "", error: "nothing to copy")
            return
        }
        DispatchQueue.main.async {
            if sensitive {
                UIPasteboard.general.setItems(
                    [[UTType.utf8PlainText.identifier: text]],
                    options: [
                        .localOnly: true,
                        .expirationDate: Date().addingTimeInterval(120),
                    ])
                print("[foxy] copied \(text.count) chars, device-only, expires in 120s")
            } else {
                UIPasteboard.general.string = text
            }
            // words copied here are refused on the restore screen (SeedPasteboard)
            SeedPasteboard.foxyWrote()
            self.resolve(id: id, text: "ok", error: nil)
        }
    }

    /// Face ID or Touch ID, for the screen lock.
    ///
    /// Three answers, not two: "unavailable" means the device has no
    /// enrolled biometrics, which is different from the user refusing.
    /// Offering a Face ID button on a device that has none would be a
    /// control that cannot work.
    ///
    /// `passcode: true` lets the phone's own passcode stand in for a face.
    /// The lock screen asks for that, and nothing else does.
    ///
    /// Why the difference. Biometrics alone is right for a question — "use
    /// Face ID?" — and for a second check in front of one action, where a
    /// refusal costs nothing: Foxy's own PIN is still there behind it. It is
    /// wrong for the lock over the whole wallet, because when Face ID is the
    /// ONLY thing set there is nothing behind it: a face that will not scan —
    /// a mask, sunglasses, a bandaged hand on Touch ID — would mean the money
    /// cannot be reached at all. With the passcode allowed, the lock is as
    /// strong as the phone's own, and somebody who can unlock the phone could
    /// open Foxy regardless, so it gives nothing away.
    private func handleBiometric(id: String, body: [String: Any]) {
        let passcode = (body["passcode"] as? Bool) ?? false
        let policy: LAPolicy = passcode ? .deviceOwnerAuthentication
                                        : .deviceOwnerAuthenticationWithBiometrics
        let ctx = LAContext()
        // no "Enter Password" on the biometrics-only path; Foxy has its own PIN
        if !passcode { ctx.localizedFallbackTitle = "" }
        var authError: NSError?
        guard ctx.canEvaluatePolicy(policy, error: &authError) else {
            resolve(id: id, text: "unavailable", error: nil)
            return
        }
        ctx.evaluatePolicy(policy,
                           localizedReason: Self.biometricReason(body["reason"])) { ok, _ in
            // the seed read after an unlock uses this approval instead of asking again
            if ok { SeedVault.noteUnlock(ctx) }
            self.resolve(id: id, text: ok ? "yes" : "no", error: nil)
        }
    }

    /// The page picks one of these, never its own words: a prompt whose
    /// text a script wrote could ask for Face ID for anything.
    static let biometricReasons = ["Unlock Foxy", "Leave POS mode"]

    static func biometricReason(_ asked: Any?) -> String {
        let text = asked as? String ?? ""
        return biometricReasons.contains(text) ? text : "Unlock Foxy"
    }

    /// ALLOW FOXY IN ORBOT: Orbot's own approval screen, for a key with bypass.
    private func handleOrbotAccess(id: String, body: [String: Any]) {
        OrbotLink.requestAccess { opened in
            self.resolve(id: id, text: opened ? "opened" : "no", error: nil)
        }
    }

    /// Poll Orbot now, instead of waiting out the fifteen-second timer.
    ///
    /// TRY AGAIN on the quiet-Orbot screen calls this. Retrying Tor there is
    /// useless on its own — Tor is not what is wrong — and the state the page
    /// is deciding on can be a quarter-minute old, which is long enough for
    /// somebody who has just fixed Orbot to tap the button and be told nothing
    /// changed.
    private func handleOrbotRefresh(id: String, body: [String: Any]) {
        OrbotLink.refresh {
            self.resolve(id: id, text: OrbotLink.name, error: nil)
        }
    }

    /// Where traffic goes. Also pushed on every change; this answers a page
    /// that asks before it has heard a push.
    private func handlePrivacy(id: String, body: [String: Any]) {
        resolve(id: id, text: Route.snapshot(), error: nil)
    }

    /// Whether the screen is being recorded or mirrored, for a page that
    /// starts while it already is. Changes are pushed after that.
    private func handleCaptured(id: String, body: [String: Any]) {
        resolve(id: id, text: FoxyBridge.screenCaptured(presenter) ? "yes" : "no", error: nil)
    }

    /// RETRY on the failure screen, and the warning row.
    /// RETRY, and RESTART TOR on the connecting screen: the full reset
    /// (`TorService.restart`), not a nudge on whatever link is there.
    private func handleTorRetry(id: String, body: [String: Any]) {
#if canImport(Tor)
        TorService.restart("the person asked")
#endif
        resolve(id: id, text: Route.snapshot(), error: nil)
    }

    /// CONTINUE UNPROTECTED, for this session. Turning it on needs a tap
    /// on an alert iOS draws: the page can ask, but no script can answer.
    /// Turning it off needs nothing. Ignored while Tor is up.
    private func handleUnprotected(id: String, body: [String: Any]) {
        let on = (body["on"] as? Bool) ?? false
        if !on {
            Route.unprotected = false
            pushPrivacy()
            resolve(id: id, text: Route.snapshot(), error: nil)
            return
        }
#if canImport(Tor)
        if TorService.isRunning {
            resolve(id: id, text: Route.snapshot(), error: nil)
            return
        }
#endif
        confirmUnprotected { confirmed in
#if canImport(Tor)
            Route.unprotected = confirmed && !TorService.isRunning
#else
            Route.unprotected = confirmed
#endif
            print("[foxy] unprotected:", Route.unprotected, confirmed ? "(confirmed in the iOS alert)" : "(declined)")
            self.pushPrivacy()
            self.resolve(id: id, text: Route.snapshot(), error: nil)
        }
    }

    /// A mint request through the SOCKS proxy.
    ///
    /// With Tor down the connection to 127.0.0.1 is refused and this fails,
    /// including for a request already in flight when the daemon dies —
    /// which is the half the page's gate cannot do.
    private func handleMintRequest(id: String, body: [String: Any]) {
        guard let raw = body["url"] as? String, let url = URL(string: raw) else {
            resolve(id: id, text: nil, error: "That is not a mint address Foxy will use.")
            return
        }
        // https, or http to an .onion, and a host Foxy will ask for. The
        // same rules are applied again to every redirect, by the session.
        if let problem = Route.urlProblem(url) {
            resolve(id: id, text: nil, error: problem)
            return
        }
        // GET or POST, before anything is asked of the person
        guard let method = Self.mintMethod(body) else {
            resolve(id: id, text: nil, error: "That is not a request Foxy will send.")
            return
        }
        // Tor, or the open connection if the person chose it, or refused.
        guard Route.available else {
            resolve(id: id, text: nil, error: Route.refusal)
            return
        }
        // A host Foxy has not used is asked about first, in an alert iOS
        // draws (HostApprovals). A script cannot answer it.
        let host = url.host ?? ""
        guard HostApprovals.isApproved(host) else {
            HostApprovals.ask(host, on: presenter) { allowed in
                if allowed {
                    self.sendMintRequest(id: id, body: body, url: url, method: method)
                } else {
                    self.resolve(id: id, text: nil, error: "You did not allow Foxy to contact \(HostApprovals.normal(host)).")
                }
            }
            return
        }
        sendMintRequest(id: id, body: body, url: url, method: method)
    }

    /// The methods a mint, a lightning-address server or an LNURL callback is
    /// asked with: cashu-ts sends GET and POST, and nothing else in the wallet
    /// sends any. Anything else the page names is refused, not sent (audit
    /// I9). No method at all is a GET, as before.
    static func mintMethod(_ body: [String: Any]) -> String? {
        let method = (body["method"] as? String ?? "GET").uppercased()
        return ["GET", "POST"].contains(method) ? method : nil
    }

    /// The mints and payment addresses a wallet already used, once: the first
    /// time this version runs (HostApprovals.carryOver). Later calls change nothing.
    private func handleHostsKnown(id: String, body: [String: Any]) {
        HostApprovals.carryOver((body["hosts"] as? [String]) ?? [])
        resolve(id: id, text: "ok", error: nil)
    }

    /// Is this a debug build? The page asks before mirroring its console
    /// to the native log, which would otherwise walk around the release
    /// guard that silences it.
    private func handleIsDebug(id: String, body: [String: Any]) {
        #if DEBUG
        resolve(id: id, text: "yes", error: nil)
        #else
        resolve(id: id, text: "no", error: nil)
        #endif
    }

    private func handlePreviewStop(id: String, body: [String: Any]) {
        live?.stop()
        resolve(id: id, text: "", error: nil)
    }

    /// Take the control away — unless a paste is on its way through it.
    ///
    /// The page stops the control whenever the screen changes, and it changes
    /// under a paste: iOS's own prompt takes focus, which the page sees. A
    /// control removed then is a paste dropped, so this waits (startPasteControl).
    private func handlePasteStop(id: String, body: [String: Any]) {
        if let host = pasteHost, Self.pastePromptExpected {
            /* Kept, but not in the way.
             *
             * This used to return here and leave the control sitting on the
             * page. The window it is protecting is thirty seconds long and is
             * armed by any touch inside the control's rectangle — PasteHost's
             * hitTest — so a tap on PASTE and then a walk into another screen
             * left an invisible system button parked over whatever landed
             * under that rectangle. The split's NEXT button was found
             * dead in the middle and live at its left edge, which is the shape
             * of the rectangle, not of the button.
             *
             * The page has said that screen is gone, so the control stops
             * taking touches at once and the page has its taps back. The view
             * stays a moment longer because a paste already on its way arrives
             * through the responder chain, not through a hit test, and then it
             * goes. */
            host.isUserInteractionEnabled = false
            let until = Self.pastePromptUntil
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, until.timeIntervalSinceNow) + 0.25) {
                [weak self] in
                guard let self, self.pasteHost === host else { return }
                host.removeFromSuperview()
                self.pasteHost = nil
            }
            print("[foxy] paste control let go of the page; it stops taking touches now")
            resolve(id: id, text: "", error: nil)
            return
        }
        pasteHost?.removeFromSuperview()
        pasteHost = nil
        resolve(id: id, text: "", error: nil)
    }

    private func handleShare(id: String, body: [String: Any]) {
        presentShare(id: id, text: body["text"] as? String ?? "")
    }

    /// Foxy's own page in Settings, and nothing else: the one URL iOS gives an
    /// app for this. For a permission refused once — Bluetooth, the camera —
    /// which iOS never asks about again, so the button on the page is the only
    /// way back.
    private func handleOpenSettings(id: String, body: [String: Any]) {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            resolve(id: id, text: nil, error: "No settings page to open.")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { ok in
                self.resolve(id: id, text: ok ? "ok" : nil, error: ok ? nil : "Settings would not open.")
            }
        }
    }

    /* The GET DOLLARS screen's four web addresses, and no others. The page
     * says which by name; the address itself is here, so nothing the page
     * holds can become a URL this app opens. It opens in the phone's browser,
     * outside Foxy and outside its Tor connection. */
    static let companySites: [String: String] = [
        "cashapp": "https://cash.app",
        "strike": "https://strike.me",
        "river": "https://river.com",
        "flash": "https://getflash.io",
    ]

    private func handleOpenCompany(id: String, body: [String: Any]) {
        guard let which = body["which"] as? String, let site = Self.companySites[which],
              let url = URL(string: site) else {
            resolve(id: id, text: nil, error: "Not one of the listed sites.")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { ok in
                self.resolve(id: id, text: ok ? "ok" : nil, error: ok ? nil : "The browser would not open.")
            }
        }
    }

    private func presentScanner(id: String, prompt: String) {
        guard let presenter else {
            resolve(id: id, text: nil, error: "Nothing to present the scanner from.")
            return
        }
        let scanner = QRScannerViewController(prompt: prompt) { [weak self] result in
            switch result {
            case .success(let text):  self?.resolve(id: id, text: text, error: nil)
            case .failure(let error): self?.resolve(id: id, text: nil, error: error.localizedDescription)
            }
        }
        scanner.modalPresentationStyle = .fullScreen
        presenter.present(scanner, animated: true)
    }

    /// Show the camera inside a rectangle the page measured for us.
    ///
    /// The preview sits above the web view rather than behind it. Punching a
    /// transparent hole through the page would mean every ancestor of the pane
    /// going transparent too, which is fragile; covering the pane is not.
    /// The scanner's wording, from this list or the default.
    private static let scannerPrompts: Set<String> = ["Scan an ecash token", "Scan the mint address"]

    /// The page is gone (its process ended, or it is loading again): no camera
    /// preview or paste control of its stays over whatever comes next (I7).
    func pageGone() {
        live?.stop()
        pasteHost?.removeFromSuperview()
        pasteHost = nil
        // and no seed kept for its secrets, and no typed words (SeedVault drops them)
        SeedVault.forgetNativeSeed()
        // and no seed screen of Foxy's left for a page that is not there
        SeedScreens.closeAll()
        // and nothing advertised or searched for on behalf of a page that is gone
        stopTap()
    }

    private func startPreview(id: String, body: [String: Any]) {
        /* A refusal reaches the page. It used to be resolved to a promise
         * nobody awaited: the page believed the camera was up, drew nothing,
         * and never asked again while the screen stayed (SCAN FOR CHANGE,
         * and no camera). */
        func refuse(_ why: String) {
            print("[scan] the camera pane was refused: \(why)")
            resolve(id: id, text: "", error: why)
            evaluate("window.FoxyWallet && window.FoxyWallet._previewRefused(\(Self.literalStatic(why)))")
        }
        guard let presenter, let webView else {
            refuse("Nothing to show the camera in.")
            return
        }
        let rect = CGRect(
            x: body["x"] as? Double ?? 0,
            y: body["y"] as? Double ?? 0,
            width: body["w"] as? Double ?? 0,
            height: body["h"] as? Double ?? 0
        )
        guard [rect.origin.x, rect.origin.y, rect.width, rect.height].allSatisfy(\.isFinite),
              rect.width > 40, rect.height > 40 else {
            refuse("That pane is too small for a camera (\(Int(rect.width))x\(Int(rect.height))).")
            return
        }
        // on screen, inside the page: a preview parked out of sight ran the camera
        // with only the system indicator to show it (audit I7)
        guard webView.bounds.insetBy(dx: -1, dy: -1).contains(rect) else {
            refuse("The camera pane must be on screen (at \(Int(rect.origin.x)),\(Int(rect.origin.y)) "
                   + "\(Int(rect.width))x\(Int(rect.height)) in \(Int(webView.bounds.width))x\(Int(webView.bounds.height))).")
            return
        }

        if live == nil {
            live = LiveScanner(onCode: { [weak self] text in
                // hand it to the page the same way a full-screen scan would
                self?.evaluate("window.FoxyWallet && window.FoxyWallet._liveScan(\(Self.literalStatic(text)))")
            })
            live?.attach(to: presenter.view, above: webView)
        }
        live?.show(in: rect)
        resolve(id: id, text: "ok", error: nil)
    }

    func evaluate(_ js: String) {
        DispatchQueue.main.async { self.webView?.evaluateJavaScript(js) }
    }

    static func literalStatic(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let arr = String(data: data, encoding: .utf8)
        else { return "null" }
        return String(arr.dropFirst().dropLast())
    }

    /// Put a real UIPasteControl over the page's paste button.
    ///
    /// This is the only way to read the clipboard without iOS showing its
    /// "allow paste" alert: the user taps Apple's own button, which counts as
    /// consent. The trade-off is that it must look like Apple's button, so the
    /// page's own paste button ends up hidden underneath it. That is a deliberate
    /// decision: the designed button stays, the system control
    /// sits over it nearly invisible, and the rectangle checks below keep it
    /// from being parked anywhere else.
    private func startPasteControl(id: String, body: [String: Any]) {
        guard let presenter, let webView else {
            resolve(id: id, text: "", error: "Nothing to attach the button to.")
            return
        }
        let rect = CGRect(
            x: body["x"] as? Double ?? 0,
            y: body["y"] as? Double ?? 0,
            width: body["w"] as? Double ?? 0,
            height: body["h"] as? Double ?? 0
        )
        // The control is a system paste button rendered nearly invisible at a
        // rectangle the page chooses. Without a sanity check, anything that
        // could run script in the page could park it over "Confirm send" and
        // have the user's tap drop the clipboard into the page instead.
        //
        // So: inside the view, not more than half of it in either dimension,
        // and in the lower two-thirds — where this app's paste affordances
        // are. Anything else is refused rather than placed.
        let bounds = webView.bounds
        let sane = rect.width > 30 && rect.height > 20
            && rect.width <= bounds.width * 0.9
            && rect.height <= bounds.height * 0.5
            && bounds.contains(rect)
            && rect.minY >= bounds.height * 0.33
        guard sane else {
            print("[foxy] paste control refused at \(rect) in \(bounds)")
            resolve(id: id, text: "", error: "That is not a place a paste button goes.")
            return
        }

        /* A control already sitting at this rectangle is left alone.
         *
         * Every one of these used to tear the control down and build another,
         * and the page asks on any render — a balance counting up, the snow
         * moving, a card closing. So the button under the person's finger was
         * being replaced while they were using it, and the paste it was
         * waiting for went nowhere: four taps to paste one token on a
         * phone, and only the last one landed.
         *
         * Rebuilding is also the one thing that must not happen while iOS has
         * a paste prompt up, so a rectangle that really has moved waits for
         * that to finish rather than cancelling it. */
        if let host = pasteHost, host.superview != nil {
            if host.frame == rect {
                // a control the page let go of and has now asked for again,
                // still within its prompt window: it takes touches once more
                host.isUserInteractionEnabled = true
                resolve(id: id, text: "ok", error: nil)
                return
            }
            if Self.pastePromptExpected {
                print("[foxy] paste control left where it is: a paste is in flight")
                resolve(id: id, text: "ok", error: nil)
                return
            }
        }

        pasteHost?.removeFromSuperview()
        let host = PasteHost(onText: { [weak self] text in
            // never a seed phrase: the page hears an empty paste
            let given = SeedPasteboard.forPage(text, from: "paste control")
            self?.evaluate("window.FoxyWallet && window.FoxyWallet._pasted(\(Self.literalStatic(given)))")
        })
        host.frame = rect
        host.build(cornerRadius: min(rect.height / 2, 27))
        presenter.view.insertSubview(host, aboveSubview: webView)
        pasteHost = host
        // once per place: it is put back at the same spot on every render
        if rect != pasteLogged {
            pasteLogged = rect
            print("[foxy] paste control placed at \(rect)")
        }
        resolve(id: id, text: "ok", error: nil)
    }

    /// A local notification for a payment.
    ///
    /// This only fires while the app is running or freshly backgrounded — the
    /// websocket that spots the payment dies when iOS suspends the app. Real
    /// notifications with the app closed need a server holding an LNbits
    /// webhook and talking to Apple's push service; that cannot be done from
    /// inside the app.
    /// So a page that can run script cannot post a wall of banners.
    private static var lastNotifyAt = Date.distantPast

    /// The category every payment notification carries. It sets what iOS shows
    /// when previews are hidden, so a locked phone says only "Foxy".
    private static let paymentCategory = "foxy.payment"
    private static var categoryRegistered = false

    private func notify(id: String, body: [String: Any]) {
        // Any script in the page can reach this. A fake "you received 0.05
        // BTC" is a social-engineering tool, so the page does not supply text
        // at all: it names a kind, and the words are ours. Anything else,
        // including a bare `text`, is refused. The title is ours too, and there
        // is at most one every 3s.
        let text: String
        switch body["kind"] as? String {
        case "sent": text = "Payment sent"
        case "received": text = "Payment received"
        default:
            print("[foxy] notification refused — unknown kind")
            resolve(id: id, text: "", error: "unknown notification kind")
            return
        }

        let now = Date()
        guard now.timeIntervalSince(Self.lastNotifyAt) > 3 else {
            print("[foxy] notification dropped — too soon after the last")
            resolve(id: id, text: "throttled", error: nil)
            return
        }
        Self.lastNotifyAt = now

        let title = "Foxy"
        let category = Self.paymentCategory
        let center = UNUserNotificationCenter.current()
        center.delegate = Self.presenterDelegate
        if !Self.categoryRegistered {
            Self.categoryRegistered = true
            center.setNotificationCategories([UNNotificationCategory(
                identifier: category, actions: [], intentIdentifiers: [],
                hiddenPreviewsBodyPlaceholder: "Foxy", options: [])])
        }
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = text
            content.sound = .default
            content.categoryIdentifier = category
            // An ordinary banner and sound; it does not break through Focus.
            // It hides nothing: no amount reaches the lock screen or history
            // because the text above is fixed and never carries one.
            content.interruptionLevel = .active
            content.userInfo = ["foxy": true]
            let request = UNNotificationRequest(
                identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(request)
        }
        resolve(id: id, text: "ok", error: nil)
    }

    /// Keeps banners visible while the app is in the foreground.
    private static let presenterDelegate = ForegroundNotifications()

    /// The system share sheet, with whatever text the page handed over.
    private func presentShare(id: String, text: String) {
        guard let presenter, !text.isEmpty else {
            resolve(id: id, text: "", error: "Nothing to share.")
            return
        }
        // Presenting while something else is already up gives a black screen
        // rather than a sheet, and the web view underneath stays covered.
        if presenter.presentedViewController != nil {
            resolve(id: id, text: "", error: "Something else is already open.")
            return
        }

        DispatchQueue.main.async {
            // never the bare string: the sheet would look for a link in it to preview (ShareText)
            let sheet = UIActivityViewController(activityItems: [ShareText(text)], applicationActivities: nil)
            // iPad needs an anchor or this traps
            sheet.popoverPresentationController?.sourceView = presenter.view
            sheet.popoverPresentationController?.sourceRect = CGRect(
                x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 80, width: 1, height: 1)
            sheet.completionWithItemsHandler = { activity, completed, _, error in
                if let error { print("[foxy] share sheet:", error) }
                // the sheet's Copy is Foxy writing the pasteboard too
                if completed, activity == .copyToPasteboard { SeedPasteboard.foxyWrote() }
            }
            print("[foxy] presenting share sheet,", text.count, "characters")
            presenter.present(sheet, animated: true)
        }
        resolve(id: id, text: "ok", error: nil)
    }

    /// Read the pasteboard, but only when there is text to read.
    ///
    /// `hasStrings` is free — it does not prompt. The read itself does, on
    /// iOS 16 and later, and that alert is the system's: an app cannot opt out
    /// of it. Checking first at least means no prompt on an empty clipboard.
    private func readClipboard(id: String) {
        guard UIPasteboard.general.hasStrings else {
            resolve(id: id, text: "", error: nil)
            return
        }
        // iOS's "Allow Paste" takes focus from Foxy: that is not leaving it (WebHostController.resigningActive)
        Self.pastePromptUntil = Date().addingTimeInterval(30)
        // never a seed phrase: answered as a clipboard with nothing usable on it
        let text = SeedPasteboard.forPage(UIPasteboard.general.string ?? "", from: "clipboard")
        Self.pastePromptUntil = Date().addingTimeInterval(2)
        resolve(id: id, text: text, error: nil)
    }

    /// Until when a loss of focus is iOS's paste prompt, which Foxy asked for.
    /// Main thread only.
    static var pastePromptUntil = Date.distantPast
    static var pastePromptExpected: Bool { Date() < pastePromptUntil }

    /// What the person is told when a mint request fails.
    ///
    /// "bad URL" is never the truth here. The URL was built from a mint address
    /// this app validated, and NSURLErrorBadURL (-1000) came back against it
    /// while Tor said it was up (seen more than once). On this stack that is what a session answers
    /// when the SOCKS proxy it was configured with has been torn down under it
    /// — the port moves every time Tor restarts. The request is worth making
    /// again, and "bad URL" sent the person to edit a mint address that was
    /// fine. Every other code keeps its own words: they name real things.
    static func mintFailureWords(_ e: NSError) -> String {
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorBadURL {
            return "Foxy's private connection was rebuilt mid-request. Try again."
        }
        return e.localizedDescription
    }

    /// Hand the result back to the promise waiting in JavaScript.
    /// The request itself, once the URL, the route and the host are settled.
    private func sendMintRequest(id: String, body: [String: Any], url: URL, method: String) {
        var mreq = URLRequest(url: url)
        mreq.httpMethod = method                       // GET or POST (mintMethod)
        mreq.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        // the body's type, and nothing that could put a name back on the request
        if let headers = body["headers"] as? [String: String] {
            for (k, v) in headers where ["content-type", "accept"].contains(k.lowercased()) {
                mreq.setValue(v, forHTTPHeaderField: k)
            }
        }
        if let payload = body["body"] as? String, !payload.isEmpty {
            mreq.httpBody = payload.data(using: .utf8)
            if mreq.value(forHTTPHeaderField: "Content-Type") == nil {
                mreq.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
        }
        if Self.movesMoney(method: method, path: url.path) {
            DispatchQueue.main.async { self.moneyInFlight.insert(id) }
        }
        // one job's requests share a circuit; anything unlabelled gets one of its own
        let circuit = MintCircuit.label(body["circuit"])
        #if DEBUG
        DebugLog.write("mint \(method) \(url.path) on circuit \(circuit.prefix(6))")
        #endif
        sendMintRequest(id: id, mreq, url: url, circuit: circuit, triesLeft: 1)
    }

    /* Asked again, once, when the request never left.
     *
     * NSURLErrorBadURL against a URL this app built is the proxy refusing the
     * connection before a byte of the request has gone: Tor could not open a
     * stream on the circuit it was given. It happens with Tor up and nothing
     * restarting — a phone lost a payment to it three
     * seconds into the swap, with the other phone waiting on its four digits
     * — and the second try goes through. The page was
     * being told to try again; it is tried again here instead, where it costs
     * a second rather than the payment.
     *
     * Only this code and only once. A timeout or a lost connection may have
     * reached the mint, and those are the page's to reason about. */
    private func sendMintRequest(id: String, _ mreq: URLRequest, url: URL, circuit: String, triesLeft: Int) {
        let mintTask = Route.start(mreq, circuit: circuit) { data, response, error in
            // the session stopped reading at Route.largestAnswer (RedirectGuard)
            if error is AnswerTooLarge {
                self.resolve(id: id, text: nil, error: "The answer from \(url.host ?? "that address") was too large.")
                return
            }
            if let error {
                let e = error as NSError
                if e.domain == NSURLErrorDomain, e.code == NSURLErrorBadURL, triesLeft > 0 {
                    print("[foxy] mint request to", url.host ?? "?",
                          "never left (the proxy refused the stream); asking again")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                        self.sendMintRequest(id: id, mreq, url: url, circuit: circuit, triesLeft: triesLeft - 1)
                    }
                    return
                }
                #if DEBUG && canImport(Tor)
                ResumeDiagnostics.log("mint request to \(url.host ?? "?") failed: \(e.domain) \(e.code) \(e.localizedDescription) — tor \(TorService.state)")
                #endif
                // the code in every build, for the same reason the price
                // sources carry it: "bad URL" alone names nothing
                print("[foxy] mint request to", url.host ?? "?", "failed:",
                      "\(e.localizedDescription) [\(e.domain) \(e.code)] — tor \(TorService.state)")
                self.resolve(id: id, text: nil, error: Self.mintFailureWords(e))
                return
            }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            // cannot happen now the session stops at the limit; kept as a second line
            if (data?.count ?? 0) > Route.largestAnswer {
                self.resolve(id: id, text: nil, error: "The answer from \(url.host ?? "that address") was too large.")
                return
            }
            let text = String(data: data ?? Data(), encoding: .utf8) ?? ""
            // the status matters: a mint reports a refusal as JSON with a
            // 4xx, and that body is the message the app reads
            self.resolve(id: id, text: "\(code)\n" + text, error: nil)
        }
        if mintTask == nil { resolve(id: id, text: nil, error: Route.refusal) }
    }

    func resolve(id: String, text: String?, error: String?) {
        let js = "window.FoxyWallet && window.FoxyWallet._scanResult(\(literal(id)), \(literal(text)), \(literal(error)))"
        DispatchQueue.main.async {
            self.moneyInFlight.remove(id)
            self.webView?.evaluateJavaScript(js)
        }
    }

    /* Requests that move money and have not been answered: a swap, a melt, a
     * mint of new pieces, a restore. Counted so that backgrounding can wait
     * for them (FoxyWebView.appEnteredBackground). Tor leaves the network the
     * moment Foxy is put away, and a swap in flight at that instant was cut:
     * the mint may or may not have acted, the piece that went in had to be
     * held out of the balance until it could be asked, and twice
     * a phone showed thousands of sats fewer than it owned.
     * Main thread only. */
    var moneyInFlight: Set<String> = []
    static func movesMoney(method: String, path: String) -> Bool {
        guard method == "POST" else { return false }
        if path.contains("/quote") || path.hasSuffix("/checkstate") { return false }
        return path.hasSuffix("/v1/swap") || path.hasSuffix("/v1/restore")
            || path.contains("/v1/melt/") || path.contains("/v1/mint/")
    }

    /// JSON-encode so a scanned string with quotes or newlines can't break out.
    private func literal(_ value: String?) -> String {
        guard let value,
              let data = try? JSONSerialization.data(withJSONObject: [value]),
              let arr = String(data: data, encoding: .utf8)
        else { return "null" }
        return String(arr.dropFirst().dropLast())      // ["x"] -> "x"
    }
}

/// One `price` request: the sources in order, `together` at a time, each
/// started on the route as it is at that moment, and the first usable answer
/// wins. Main queue only.
private final class PriceWalk {
    typealias Source = (String, (Any) -> Double?)

    private let sources: [Source]
    private let together: Int
    private let perSource: TimeInterval
    /// What a source named by an onion gets instead of `perSource`: the first
    /// ask of a session pays for a descriptor and a rendezvous.
    private let onion: TimeInterval
    /// The circuit label an onion source rides (FoxyBridge.priceCircuit).
    private let circuit: String
    private let finish: (Double?, String) -> Void
    /// Two sources within 2% of each other, rather than the first to answer.
    private let agree: Bool
    private var answers: [Double] = []
    private let began = Date()
    private var next = 0
    /// How to stop each source still running: a URLSession task's cancel, or
    /// an onion exchange's. Not the tasks themselves — a price source is not
    /// always a URLSession one any more.
    private var running: [Int: () -> Void] = [:]
    private var over = false
    private var clock: DispatchWorkItem?

    init(sources: [Source], together: Int, perSource: TimeInterval,
         onion: TimeInterval = 10, circuit: String = "", agree: Bool = false,
         finish: @escaping (Double?, String) -> Void) {
        self.sources = sources
        self.together = max(1, together)
        self.perSource = perSource
        self.onion = onion
        self.circuit = circuit
        self.agree = agree
        self.finish = finish
    }

    private var nothing: String {
        agree && !answers.isEmpty ? "the price sources did not agree" : "no price source answered"
    }

    func start(limit: TimeInterval) {
        dispatchPrecondition(condition: .onQueue(.main))
        // held until it fires or end() cancels it, which is what keeps this walk alive
        let clock = DispatchWorkItem { [self] in end(nil, nothing) }
        self.clock = clock
        DispatchQueue.main.asyncAfter(deadline: .now() + limit, execute: clock)
        fill()
    }

    private func fill() {
        while !over, running.count < together, next < sources.count {
            let i = next
            next += 1
            guard let url = URL(string: sources[i].0) else { continue }
            if url.scheme == "http" {
                running[i] = ask(onion: url, i)
                continue
            }
            var req = URLRequest(url: url)
            req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            req.timeoutInterval = perSource
            // Tor's port as it is now, not as it was when the first source was tried
            guard let task = Route.start(req, { data, _, error in
                DispatchQueue.main.async { self.answered(i, data, error) }
            }) else {
                end(nil, Route.refusal)
                return
            }
            running[i] = { task.cancel() }
        }
        if !over, running.isEmpty { end(nil, nothing) }
    }

    /// A source named by an onion. Plain http, which URLSession will not send
    /// (App Transport Security), so this goes through Tor's SOCKS port the way
    /// a payment to another phone does.
    ///
    /// The answer is handed on through the main queue even where it is already
    /// there: with no Tor, OnionPost answers before it returns, and `answered`
    /// would run inside the loop that is still filling — before the line below
    /// that records how to stop this one.
    private func ask(onion url: URL, _ i: Int) -> () -> Void {
        return OnionPost.get(url, circuit: circuit, timeout: onion) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let answer) where answer.status == 200:
                    self.answered(i, Data(answer.body.utf8), nil)
                case .success(let answer):
                    print("[foxy] price source failed:", url.host ?? "onion", "answered \(answer.status)")
                    self.answered(i, nil, nil)
                case .failure(let why):
                    print("[foxy] price source failed:", url.host ?? "onion", why.text)
                    self.answered(i, nil, nil)
                }
            }
        }
    }

    private func answered(_ i: Int, _ data: Data?, _ error: Error?) {
        running[i] = nil
        guard !over else { return }
        if let error {
            /* The code as well as the words. "bad URL" against
             * https://blockchain.info/ticker says nothing about what went
             * wrong, and two others in the same second said "The request timed
             * out" — a URL that is plainly fine cannot be badly formed, so the
             * words are standing in for something else. The domain and code
             * name it. */
            let e = error as NSError
            print("[foxy] price source failed:", sources[i].0,
                  "\(e.localizedDescription) [\(e.domain) \(e.code)]")
        }
        if let data,
           let json = try? JSONSerialization.jsonObject(with: data),
           let price = sources[i].1(json), price > 0 {
            print("[foxy] price", price, "from", sources[i].0,
                  String(format: "in %.1fs", Date().timeIntervalSince(began)))
            guard agree else { end(price, ""); return }
            if let other = answers.first(where: { abs($0 - price) / min($0, price) <= 0.02 }) {
                print("[foxy] price: two sources agree")
                end((other + price) / 2, "")
                return
            }
            answers.append(price)
        }
        fill()
    }

    private func end(_ price: Double?, _ error: String) {
        guard !over else { return }
        over = true
        clock?.cancel()
        clock = nil
        if price == nil {
            print("[foxy] price: none answered,", error, String(format: "after %.1fs", Date().timeIntervalSince(began)))
        }
        // the others are not needed; the circuits they were building stay in Tor
        let others = running.values
        running = [:]
        others.forEach { $0() }
        finish(price, error)
    }
}

/// What the share sheet is given: the text, and a header Foxy wrote.
///
/// Handed a bare string, the share sheet looks in it for a link to preview,
/// and LinkPresentation fetches that page's title and icon from the share
/// sheet's own process — straight out of the phone, not through Tor. A token
/// or an invoice shared with a note beside it can carry a link. So the header's
/// metadata is supplied here, a title and no URL, which leaves nothing to
/// fetch; the placeholder is empty, so there is no text to search for one
/// before an activity is picked; and every activity gets plain text, never a
/// URL item. What an app does with the text after the person sends it —
/// Messages previewing a link in the message — happens in that app, not Foxy.
private final class ShareText: NSObject, UIActivityItemSource {
    private let text: String

    init(_ text: String) {
        self.text = text
    }

    func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController) -> Any {
        ""
    }

    func activityViewController(_ activityViewController: UIActivityViewController,
                                itemForActivityType activityType: UIActivity.ActivityType?) -> Any? {
        text
    }

    func activityViewController(_ activityViewController: UIActivityViewController,
                                dataTypeIdentifierForActivityType activityType: UIActivity.ActivityType?) -> String {
        UTType.plainText.identifier
    }

    func activityViewControllerLinkMetadata(_ activityViewController: UIActivityViewController) -> LPLinkMetadata? {
        let metadata = LPLinkMetadata()
        metadata.title = "Foxy"
        return metadata
    }
}
