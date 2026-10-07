import UIKit

/// Orbot, when the person runs it: noticed, and asked for a way around it.
///
/// Orbot is a VPN that sends the whole phone through its own Tor. Foxy's Tor
/// cannot run inside that — Tor over Tor is refused connection after
/// connection. Orbot offers apps that run their own Tor a bypass: a SOCKS port
/// on 127.0.0.1 whose connections leave the phone directly instead of entering
/// Orbot's tunnel. Foxy's Tor reaches its relays through that port, and
/// everything Foxy sends still goes only to Foxy's Tor.
///
/// If Orbot stops, the port closes, Foxy's Tor loses its relays, and requests
/// are refused until Tor reconnects directly. Nothing reaches a mint outside
/// Tor at any point.
///
/// Access is granted by the person, in Orbot. Orbot copies the key it issues to
/// the clipboard, and Foxy reads it when it next comes to the foreground — only
/// after asking for it, so the clipboard is not read on every return.
enum OrbotLink {
    enum State: Equatable {
        case absent                                   // nothing answers on 127.0.0.1:15182
        case needsAccess                              // Orbot runs; no key with bypass
        case bypass(port: UInt16, onionOnly: Bool)
    }

    static let apiPort: UInt16 = 15182
    static let tokenKey = "foxy.orbot.token"

    private(set) static var state: State = .absent
    /// Told on every change, on the main queue.
    static var onChange: ((State) -> Void)?

    private static var timer: Timer?
    private static var awaitingKey = false
    /// Polls in a row that got no answer at all. See refresh().
    private static var silentPolls = 0
    /// Whether the "nothing answers" line has been printed this run.
    private static var saidSilent = false
    private static var awaitingSince: Date?
    private static var lastDoubt: String?

    /// Orbot has issued this install a key at some point. It says nothing
    /// about Orbot running now — only that Orbot is the tunnel Foxy has dealt
    /// with, which is what the screen needs to know to keep offering the way
    /// out that works instead of the one that exposes an IP.
    static var hasKey: Bool { SeedStore.load(key: tokenKey) != nil }

    /// A VPN tunnel is up: an interface iOS lists with its own proxy settings
    /// under a tunnel's name. Orbot's is a packet tunnel, utun.
    /// The last interface this matched on, so the log can name it. A tunnel is
    /// inferred from a scoped interface name and nothing more, so when this is
    /// wrong — a phone with no VPN that Foxy tells to turn one off — the name
    /// is the only thing that says which interface fooled it.
    private static var saidTunnel: String?
    /// Whether the line above has been printed at all. Without it the first
    /// reading of "no tunnel" is silent, since nil is what it starts as, and a
    /// log showing nothing cannot be told from a check that never ran.
    private static var saidOnce = false

    static func vpnActive() -> Bool {
        guard let settings = CFNetworkCopySystemProxySettings()?.takeRetainedValue() as? [String: Any],
              let scoped = settings["__SCOPED__"] as? [String: Any] else {
            if saidTunnel != nil || !saidOnce {
                saidTunnel = nil; saidOnce = true
                print("[foxy] tunnel: none (no scoped interfaces)")
            }
            return false
        }
        let found = scoped.keys.sorted().first { NetworkKind.isTunnel($0) }
        if found != saidTunnel || !saidOnce {
            saidTunnel = found; saidOnce = true
            print("[foxy] tunnel:", found.map { "on \($0), of \(scoped.keys.sorted().joined(separator: " "))" }
                    ?? "none, of \(scoped.keys.sorted().joined(separator: " "))")
        }
        return found != nil
    }
    private static var observing = false

    static var name: String {
        switch state {
        case .absent: return "none"
        case .needsAccess: return "needs-access"
        case .bypass: return "bypass"
        }
    }

    /// Watch for Orbot for as long as the app runs: now, every 15 seconds while
    /// in the foreground, and whenever the app comes back.
    static func start(_ firstAnswer: (() -> Void)? = nil) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !observing else { firstAnswer?(); return }
        observing = true
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            // two minutes to approve in Orbot and come back; after that the
            // clipboard is not read on every return
            if awaitingKey, let since = awaitingSince, Date().timeIntervalSince(since) > 120 {
                // Said out loud. It used to give up in silence, so a hand-off
                // that never reached Orbot's approval screen looked exactly
                // like one the person declined — and the wrong URL that caused
                // it went unnoticed.
                print("[foxy] orbot: asked for a key two minutes ago and none came back")
                awaitingKey = false
            }
            if awaitingKey { pickUpKey() }   // logs when it stores one
            refresh()
            schedule()
        }
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            timer?.invalidate()
            timer = nil
        }
        refresh(firstAnswer)
        schedule()
    }

    private static func schedule() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in refresh() }
    }

    /// One look at Orbot's API. A 403 means Orbot is running and the key Foxy
    /// holds, if any, is refused.
    static func refresh(_ done: (() -> Void)? = nil) {
        let token = SeedStore.load(key: tokenKey)
        LoopbackHTTP.get(port: apiPort, path: "/info", token: token) { code, body in
            var next: State = .absent
            /* No answer at all is not the same as "Orbot is gone".
             *
             * The poll runs on every return to the foreground, and coming back
             * from Orbot is exactly when iOS is least willing to carry a
             * request: on one phone the key was stored and the very
             * next poll — fired as the app was backgrounding again — got
             * nothing, so Orbot was written off in the same second it had
             * just issued a key. Foxy then tried to
             * connect directly inside Orbot's tunnel, sat at 10% with every
             * guard down, and offered no way on but exposing the IP.
             *
             * So silence keeps the last answer and is counted. Only a run of
             * them, or an answer that really says Orbot is not there, clears
             * it. A 403 or a 200 is an answer and resets the count. */
            if code == nil {
                silentPolls += 1
                if silentPolls < 3, state != .absent {
                    print("[foxy] orbot: no answer on its port (\(silentPolls) of 3), keeping", name)
                    done?()
                    return
                }
                if state != .absent {
                    print("[foxy] orbot: no answer on its port three times running; treating it as gone")
                } else if !saidSilent {
                    /* Already absent, so nothing changes and nothing was said —
                     * and an Orbot that is running, has granted a bypass, and
                     * simply never answers on its port looked exactly like no
                     * Orbot at all in the log.
                     * Said once per run, since it repeats every fifteen
                     * seconds and the point is only that it happened. */
                    saidSilent = true
                    print("[foxy] orbot: nothing answers on 127.0.0.1:\(apiPort)",
                          SeedStore.load(key: tokenKey) != nil
                            ? "(Foxy holds a key it issued)" : "(no key held)")
                }
            } else {
                silentPolls = 0
            }
            if code == 403 {
                next = .needsAccess
            } else if code == 200,
                      let json = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any] {
                let started = (json["status"] as? String) == "started"
                if started, let port = (json["bypassPort"] as? NSNumber)?.uint16Value, port > 0 {
                    next = .bypass(port: port, onionOnly: (json["onionOnly"] as? Bool) ?? false)
                } else if started {
                    next = .needsAccess                     // a key without bypass
                }
            }
            /* Anything on the phone can listen on 127.0.0.1:15182 and answer
             * like Orbot, and a bypass port it names would carry Foxy's Tor.
             * Two things another app cannot fake:
             *   Orbot is a VPN. Without a VPN up, whatever answers is not Orbot
             *     protecting this phone — and starting a VPN takes an app the
             *     person installed and approved as one.
             *   Orbot hands a bypass port only to a key it issued. An answer
             *     with a bypass port to a request carrying no key is not Orbot's.
             * Either failing, it is treated as no Orbot at all.
             *
             * Known limit: once a real key is stored, the second check proves
             * less than it reads. The key is sent in the request, so whatever
             * answers learns it, and while Orbot itself is stopped another app
             * can hold 127.0.0.1:15182 and, with any VPN up, name its own bypass
             * port. Orbot's API has no challenge a reply could be checked
             * against, and iOS does not say which app owns a port or a VPN, so
             * there is nothing stronger to tie the answer to. What that app
             * would carry is Tor's own encrypted connections to relays or
             * bridges, never a mint request in the clear. */
            var doubt: String?
            if next != .absent && !vpnActive() {
                doubt = "something answers on Orbot's port, but no VPN is running: not Orbot, ignored"
            } else if case .bypass = next, token == nil {
                doubt = "a bypass port offered without Orbot's key: not how Orbot answers, ignored"
            }
            if let doubt {
                if doubt != lastDoubt { print("[foxy] orbot:", doubt) }
                lastDoubt = doubt
                next = .absent
            } else {
                lastDoubt = nil
            }
            if next != state {
                let was = name
                state = next
                // why, not just what: "none" on its own told nobody anything
                print("[foxy] orbot:", name, "(was \(was), answer \(code.map(String.init) ?? "none"))")
                onChange?(next)
            }
            done?()
        }
    }

    /// Open Orbot's approval screen for a key with bypass.
    static func requestAccess(_ done: @escaping (Bool) -> Void) {
        awaitingKey = true
        awaitingSince = Date()
        /* `orbot:` and a path, with NO `//`.
         *
         * Orbot builds its own links that way — OrbotKit sets `scheme` and
         * `path` and never a host, and its install check is
         * `URL(string: "orbot:show")`. Written `orbot://request/token`, the
         * `//` makes "request" the HOST and "/token" the path, Orbot matches
         * no route, and it opens on its home screen having been told nothing.
         * Which is precisely what it did on a phone:
         * the tap worked, Orbot opened, and no approval was ever offered.
         *
         * The three query names are OrbotKit's own: app-id, need-bypass,
         * app-name. */
        let url = URL(string: "orbot:request/token?app-id=io.getfoxi.foxy&need-bypass=true&app-name=Foxy")!
        UIApplication.shared.open(url) { opened in
            if !opened { awaitingKey = false }
            done(opened)
        }
    }

    /// Orbot copied the key it issued. Take it, and clear the clipboard: it is
    /// a credential.
    private static func pickUpKey() {
        guard UIPasteboard.general.hasStrings,
              let text = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines),
              UUID(uuidString: text) != nil else { return }
        awaitingKey = false
        UIPasteboard.general.string = ""
        if SeedStore.save(text, key: tokenKey) { print("[foxy] orbot: access key stored") }
    }
}
