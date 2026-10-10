import Foundation
import Network
import UIKit
import Security

/// The Tor circuit a mint request leaves on.
///
/// A mint sees the exit a request comes from. With one circuit per mint, every
/// request in the same ten minutes arrived from one exit: a launch's checks, a
/// payment and a receive all looked like one person. The page labels each job
/// (a payment, a receive, one invoice's polls, one token's checks) and Tor
/// keeps different labels on different circuits. A request with no label, or
/// one that is not a label the page makes, gets a circuit of its own rather
/// than a shared one.
enum MintCircuit {
    static func label(_ value: Any?) -> String {
        if let s = value as? String, s.count >= 16, s.count <= 64,
           s.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }) {
            return s
        }
        var bytes = [UInt8](repeating: 0, count: 16)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            bytes = (0..<16).map { _ in UInt8.random(in: 0...255) }
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

/// Where a request goes: the one decision every native network call makes.
///
/// Tor, if it is up. The open connection, if the person chose to continue
/// unprotected this session. Otherwise nowhere — the call is refused before a
/// socket opens. Tor connecting clears the unprotected choice, so the app
/// moves onto Tor as soon as it can.
///
/// This replaces nine checks spread across the page and the native bridge, each of
/// which had to be taught about embedded Tor by something breaking.
enum Route {
    /// Session only. Set by CONTINUE UNPROTECTED, cleared when Tor connects.
    /// Written on the main queue and read wherever a request is decided, so
    /// behind a lock (audit I9).
    static var unprotected: Bool {
        get { unprotectedStore.value }
        set { unprotectedStore.value = newValue }
    }
    private static let unprotectedStore = Locked(false)

    static let refusal = "Foxy is not connected to Tor."

    /// The largest answer any request is let collect. A mint's, a price feed's
    /// or a lightning-address server's are kilobytes; a hostile one could
    /// otherwise send enough to take the app's memory, copied three times on its
    /// way to the page. The session stops reading at this size, rather than
    /// holding the whole answer first and measuring it after (audit I6).
    static let largestAnswer = 4 * 1024 * 1024

    /// No app name, iOS or CFNetwork version on the wire. The default,
    /// "Foxy/1 CFNetwork/… Darwin/…", picked Foxy users out of everyone else a
    /// mint or price server sees arriving over Tor. These are Tor Browser's
    /// desktop values, the largest crowd there is on Tor. (The TLS handshake is
    /// still Apple's; this removes the label, not every trace.)
    static let genericHeaders: [String: String] = [
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0",
        "Accept-Language": "en-US,en;q=0.5",
    ]

    /// The open connection, when the person chose it: the same bland headers,
    /// no cookies, no cache.
    private static let clearSession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.urlCache = nil
        cfg.httpCookieStorage = nil
        cfg.httpShouldSetCookies = false
        cfg.httpAdditionalHeaders = genericHeaders
        cfg.timeoutIntervalForRequest = 60
        // a server that keeps dripping bytes still ends, as Tor's session does
        cfg.timeoutIntervalForResource = 60
        return URLSession(configuration: cfg, delegate: redirectGuard, delegateQueue: nil)
    }()

    /// The delegate every session Route hands out is made with, Tor's and the
    /// open one alike, so a redirect meets the same rules as the first URL.
    static let redirectGuard = RedirectGuard()

    /// Whether a request would go anywhere right now: Tor, or the open
    /// connection the person chose. Asks without making a session.
    static var available: Bool {
#if canImport(Tor)
        if TorService.isRunning { return true }
#endif
        return unprotected
    }

    /// One request, on the route as it is at this moment; nil, with nothing
    /// sent, when there is no route.
    ///
    /// Tor's session is made for the request, with Tor's SOCKS port as it is
    /// now — the port changes on every reconnect, and a price source tried
    /// twelve seconds after the first must not use the port from then. Those
    /// sessions used to be made by Route.session() and never invalidated. A
    /// URLSession keeps its delegate, configuration and connection pool until
    /// it is, so every mint request, price source and chart load left one
    /// behind, each holding the redirect guard, for as long as the app ran.
    /// The session is now invalidated as soon as its task has started: the
    /// task finishes, its completion handler and the redirect guard still run,
    /// and then the session lets go. A fresh session per request, as before.
    /// The open connection's one shared session is never invalidated.
    ///
    /// `circuit`: the Tor circuit label for this request (TorService.socksSession).
    /// Nil shares the circuit other requests to the same host use.
    @discardableResult
    static func start(_ request: URLRequest, circuit: String? = nil,
                      _ done: @escaping (Data?, URLResponse?, Error?) -> Void) -> URLSessionDataTask? {
        // Foxy is being put away: nothing new leaves (the door, below)
        guard !shut() else {
            print("[foxy] route: a request to", request.url?.host ?? "?", "not sent; Foxy is being put away")
            return nil
        }
#if canImport(Tor)
        if TorService.isRunning { return startOnce(TorService.socksSession(circuit: circuit), request, counted(done)) }
#endif
        guard unprotected else { return nil }
        let task = clearSession.dataTask(with: request)
        redirectGuard.collect(task, limit: largestAnswer, counted(done))
        task.resume()
        return task
    }

    /* What is out on the route, and the door that stops more leaving.
     *
     * Putting Foxy away takes Tor off the network (TorService.backgrounded).
     * A request out at that moment is cut, and one whose circuit Tor was
     * still building is counted against the entry relay it was being built
     * through, which Tor then trusts less. A phone came back from two such
     * trips with a relay marked down each time, and from every trip with
     * nothing out with all of them up; its invoices then took many seconds
     * where another phone's took one. Only swaps and payments were waited
     * for (FoxyBridge.moneyInFlight); a fee quote, a check of a piece or a
     * circuit being warmed was not.
     *
     * So putting away waits for everything that is out, a few seconds at
     * most (`leaving`, FoxyWebView.appEnteredBackground), and from the moment
     * it stops waiting nothing new leaves: `start` answers nil, which every
     * caller already reads as nothing sent.
     *
     * The door shuts for a few seconds, not until told otherwise. Tor refuses
     * everything itself once it is off the network, so the door is needed
     * only for the moment between; and a door that waited for a signal to
     * open would be a wallet that never works again the day that signal is
     * missed. Coming back opens it at once (FoxyWebView). */
    static var out: Int { traffic.value }
    private static let traffic = Locked(0)

    /// `done`, counted: out from now until it is called.
    private static func counted(_ done: @escaping (Data?, URLResponse?, Error?) -> Void)
        -> (Data?, URLResponse?, Error?) -> Void {
        traffic.exchange { $0 + 1 }
        return { data, response, error in
            traffic.exchange { max(0, $0 - 1) }
            done(data, response, error)
        }
    }

    /// How long the door stays shut. Parking Tor takes half a second from here.
    static let shutFor: TimeInterval = 5
    private static let shutUntil = Locked<TimeInterval>(0)
    static func shut(at now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Bool {
        now < shutUntil.value
    }
    static func shutDoor(at now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        shutUntil.value = now + shutFor
    }
    static func openDoor() {
        shutUntil.value = 0
    }

    /// What putting Foxy away does next: wait, or leave the network after a moment.
    enum Leaving: Equatable {
        case wait
        case leave(after: TimeInterval)
    }

    /// How long a swap or payment is waited for, and its change top-up: iOS
    /// allows about thirty seconds in all.
    static let waitForMoney: TimeInterval = 20
    /// How long anything else is waited for once no money is moving.
    static let waitForTheRest: TimeInterval = 3

    /// The rule for putting Foxy away.
    ///
    /// `money`: swaps and payments not answered. `tidying`: the page's change
    /// top-up. `out`: every request not answered, those included. `waited`:
    /// since Foxy was put away. `onTheRest`: how long of that has been for
    /// requests that move no money, since money last moved.
    ///
    /// Half a second after the last answer, for the page to write down what
    /// came back; no wait at all when the time is up, since what is out is
    /// about to be cut either way.
    static func leaving(money: Int, tidying: Bool, out: Int,
                        waited: TimeInterval, onTheRest: TimeInterval) -> Leaving {
        if waited > waitForMoney { return .leave(after: money > 0 || tidying || out > 0 ? 0 : 0.5) }
        if money > 0 || tidying { return .wait }
        if out > 0 { return onTheRest > waitForTheRest ? .leave(after: 0) : .wait }
        return .leave(after: 0.5)
    }

    /// What taking Tor off the network needs before iOS suspends Foxy: Tor's
    /// answer can take four seconds (TorService.backgrounded), and two to spare.
    static let holdReserve: TimeInterval = 6
    /// And never longer than this since Foxy was put away, whatever iOS says
    /// is left: with a debugger attached it says there is no limit.
    static let holdAtMost: TimeInterval = 26

    /// Whether Tor stays on the network a while longer, once the work of
    /// being put away is over.
    ///
    /// Tor was taken off the network about two seconds after Foxy left the
    /// screen, so a look at another app that lasted four came back to a
    /// connection being set up again: three or four seconds of SECURING YOUR
    /// CONNECTION over a wallet that had been connected a moment before. iOS
    /// lets an app go on for about thirty seconds; Foxy already used twenty of
    /// them when a payment was with the mint. Now it uses what there is, every
    /// time, and comes back inside that to the circuit it left.
    ///
    /// `waited`: since Foxy was put away. `remaining`: what iOS says is left
    /// (UIApplication.backgroundTimeRemaining). Leaving with less than the
    /// reserve risks being suspended with Tor still on the network, which is
    /// what parking it exists to prevent: connections that die in a suspended
    /// app are held against the relays they were to.
    ///
    /// Only the connection is held. The door is shut and the seed is dropped
    /// as the work ends, as before: nothing new leaves while Foxy is away.
    static func holding(waited: TimeInterval, remaining: TimeInterval) -> Bool {
        guard waited < holdAtMost else { return false }
        return remaining > holdReserve
    }

    /// A websocket to a Nostr relay, through Tor and nowhere else.
    ///
    /// Foxy opens one only to hand over a payment a request asked for over
    /// Nostr (Foxy/Nostr). Never the open connection: a relay reached that way
    /// would see the phone's address, which is the whole point of not having
    /// one. `wss` only, and the host meets the same rules a mint's does.
    ///
    /// The session is made for this one socket, as startOnce's is for one
    /// request; the caller invalidates it when the socket is done.
    static func startSocket(_ url: URL, circuit: String) -> (task: URLSessionWebSocketTask, session: URLSession)? {
        guard url.scheme == "wss", let host = url.host, hostProblem(url) == nil, !host.isEmpty else { return nil }
#if canImport(Tor)
        guard TorService.isRunning else { return nil }
        let session = TorService.socksSession(circuit: circuit)
        let task = session.webSocketTask(with: url)
        task.resume()
        return (task, session)
#else
        return nil
#endif
    }

    /// A session made for one request: start its task, then let it go once
    /// the task is over. Smoke check 17e fails if a Tor session is used any
    /// other way.
    ///
    /// The task has no completion handler: URLSession gives such a task's bytes
    /// to no delegate, so nothing could stop one that is too large. The session
    /// delegate collects them instead, stops at `limit`, and calls `done` as
    /// the completion handler would have. The session must be made with
    /// `redirectGuard`, as every session here is (smoke check 17d).
    static func startOnce(_ session: URLSession, _ request: URLRequest, limit: Int = largestAnswer,
                          _ done: @escaping (Data?, URLResponse?, Error?) -> Void) -> URLSessionDataTask {
        let task = session.dataTask(with: request)
        redirectGuard.collect(task, limit: limit, done)
        task.resume()
        session.finishTasksAndInvalidate()
        return task
    }

    /// Hosts Foxy will not ask for, whoever supplied the address.
    ///
    /// A mint URL, LNURL or lightning address comes from a QR code or a paste.
    /// Over Tor, an address on the phone's own network cannot be reached, but in
    /// unprotected mode a crafted one could make the phone call a router, a
    /// printer or an attacker's machine on the same Wi-Fi. An IP literal skips
    /// the name a mint is known by. And an .onion without Tor would be looked
    /// up by the phone's DNS resolver, in the clear.
    static func hostProblem(_ url: URL) -> String? {
        let refuse = "That is not a mint address Foxy will use."
        let host = (url.host ?? "").lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]."))
        if host.isEmpty || host == "localhost" { return refuse }
        if host.contains(":") { return refuse }                                     // IPv6 literal
        if !host.contains(".") { return refuse }                                    // one label: a LAN name
        // An IPv4 literal in any form the resolver takes: 127.0.0.1, but also
        // 0x7f.1 or 127.1, which a digits-and-dots test let through to loopback
        // and the local network in unprotected mode.
        var literal = in_addr()
        if inet_aton(host, &literal) != 0 { return refuse }
        for suffix in [".local", ".localhost", ".localdomain", ".internal", ".lan", ".home", ".home.arpa", ".corp"]
            where host.hasSuffix(suffix) {
            return refuse
        }
        if host.hasSuffix(".onion") {
#if canImport(Tor)
            if TorService.isRunning { return nil }
#endif
            return "An .onion address needs Tor, and Foxy is not connected to Tor."
        }
        return nil
    }

    /// Whether Foxy will ask for this URL at all: https, or http to an .onion
    /// (Tor authenticates and encrypts that end to end), and a host that
    /// passes hostProblem.
    ///
    /// The scheme test used to accept anything whose host ended in .onion, so
    /// file://x.onion/ or ftp://x.onion/ got as far as URLSession. Only the
    /// two schemes a mint or LNURL server is reached by get through now.
    static func urlProblem(_ url: URL) -> String? {
        let refuse = "That is not a mint address Foxy will use."
        let scheme = (url.scheme ?? "").lowercased()
        let host = (url.host ?? "").lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        guard scheme == "https" || (scheme == "http" && host.hasSuffix(".onion")) else { return refuse }
        return hostProblem(url)
    }

    /// A redirect is a new request to a URL the server chose, and nothing
    /// checked it. In unprotected mode a hostile mint could have answered
    /// with http://192.168.1.1/ or a .local name, which App Transport Security
    /// does not cover, and the phone would have followed it onto its own
    /// network. Over Tor it would fail there (ClientRejectInternalAddresses),
    /// but it is refused here first, whichever session is in use.
    ///
    /// A redirect also stays on the host that was asked. A mint, a price feed
    /// or an LNURL server has no reason to send Foxy to another name, and
    /// following one would show a third party this request — with the phone's
    /// own address, unprotected — and, on a 307, hand it the body as well.
    ///
    /// Known limit: these are checks on names. A public name whose DNS answer
    /// is a private address still passes, and the open connection would
    /// connect to it. URLSession gives no hook between resolving and
    /// connecting, and resolving first to check would be answered differently
    /// the second time by a server that wants to (DNS rebinding). What stops
    /// it going further is TLS: only https reaches the open connection, and a
    /// device on the local network cannot present a valid certificate for the
    /// attacker's name, so the handshake fails before any request is sent.
    static func redirectProblem(from original: URL?, to target: URL) -> String? {
        if let problem = urlProblem(target) { return problem }
        let host = { (u: URL?) in (u?.host ?? "").lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) }
        guard !host(original).isEmpty, host(original) == host(target) else {
            return "A redirect to another host is not followed."
        }
        return nil
    }

    /// What the page is told: {tor, progress, everUp, unprotected}.
    /* Whether this phone has any way onto a network at all.
     *
     * Tor cannot connect through nothing, and Foxy used to spend thirty seconds
     * finding that out: the fox ran, the percentage climbed to 99, and only then
     * did the native side call it stuck and offer RESTART TOR — which is the one
     * thing that cannot help when wifi and cellular are both off. The system
     * already knows. Asking it costs nothing and turns
     * half a minute of pretending into a screen that says what is wrong.
     *
     * A monitor rather than a one-off question, because the answer changes while
     * the app is open — somebody turns airplane mode off and Foxy should notice
     * without being asked. Started once, read from anywhere, and it reports the
     * kind of interface as well as the fact of one, so the screen can say "wifi or
     * cellular" rather than a shrug. */
    private static let pathMonitor: NWPathMonitor = {
        let m = NWPathMonitor()
        m.pathUpdateHandler = { path in
            // a VPN's tunnel with nothing under it is not a network (NetworkKind)
            let kind = NetworkKind.of(satisfied: path.status == .satisfied,
                                      wifi: path.usesInterfaceType(.wifi),
                                      cellular: path.usesInterfaceType(.cellular),
                                      wired: path.usesInterfaceType(.wiredEthernet),
                                      interfaces: path.availableInterfaces.map { $0.name })
#if targetEnvironment(simulator)
            Route.networkLock.lock()
            Route.simPath = kind
            let pretend = Route.simOffline
            Route.networkLock.unlock()
            Route.networkBecame(pretend ? "none" : kind)
#else
            Route.networkBecame(kind)
#endif
        }
        let queue = DispatchQueue(label: "foxy.network.path")
        m.start(queue: queue)
#if targetEnvironment(simulator)
        Route.simWatch(on: queue)
#endif
        return m
    }()

    /// The network is this kind now. Said, and acted on, only when it changed.
    private static func networkBecame(_ now: String) {
        networkLock.lock()
        let was = networkKind
        networkKind = now
        networkLock.unlock()
        /* Only on a change, and pushed, because a screen that says NO
         * CONNECTION has to stop saying it the moment there is one. */
        guard was != now else { return }
        print("[foxy] network: " + now)
        /* Tor is told, because a stretch with no interface makes its
         * transport ladder's verdicts worthless: every bridge fails the
         * same way with nothing to reach, and the one standing there
         * when the radios come back must not take the credit. */
#if canImport(Tor)
        TorService.networkWent(now != "none")
#endif
        DispatchQueue.main.async { Route.onNetworkChange?() }
    }

#if targetEnvironment(simulator)
    /* A pretend airplane mode, for the simulator only.
     *
     * A simulator is on the Mac's network and has no switch of its own, so
     * nothing offline — the gate's NO CONNECTION, PROCEED OFFLINE, paying
     * from what is held, the catch-up on the way back — could be driven
     * there. A file named `sim-offline` in the app's Documents folder is that
     * switch: while it exists the path monitor's answer is replaced by "none",
     * through the same door a real change comes through, so Tor comes off the
     * network and the page hears it exactly as it would on a phone.
     *
     *     touch "$(xcrun simctl get_app_container <device> <bundle id> data)/Documents/sim-offline"
     *
     * Not compiled for a phone. */
    private static var simPath = "unknown"
    private static var simOffline = false
    private static var simTimer: DispatchSourceTimer?
    private static func simWatch(on queue: DispatchQueue) {
        let flag = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
            .first?.appendingPathComponent("sim-offline").path ?? ""
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 1)
        t.setEventHandler {
            let want = !flag.isEmpty && FileManager.default.fileExists(atPath: flag)
            networkLock.lock()
            let was = simOffline
            simOffline = want
            let real = simPath
            networkLock.unlock()
            guard was != want else { return }
            print("[foxy] simulator: pretend airplane mode " + (want ? "on" : "off"))
            networkBecame(want ? "none" : real)
        }
        t.resume()
        simTimer = t
    }
#endif

    /// Set by the bridge, the way TorService.onChange is: the page has to hear
    /// that a network arrived or went, or a NO CONNECTION screen would sit there
    /// after somebody turned airplane mode off.
    static var onNetworkChange: (() -> Void)?

    private static let networkLock = NSLock()
    private static var networkKind = "unknown"

    /// The kind of network this phone is on: wifi, cellular, wired, other, none,
    /// or unknown before the first answer.
    static var network: String {
        _ = pathMonitor
        networkLock.lock(); defer { networkLock.unlock() }
        return networkKind
    }

    /// Is there any way onto a network at all?
    ///
    /// 'unknown' counts as yes: before the path monitor's first answer, nothing
    /// should act as though the phone were off the air. Only a definite 'none'
    /// is one, and it is what stops the transport ladder walking in the dark
    /// (TorService.deadlineExpired).
    static var hasNetwork: Bool { network != "none" }

    static func snapshot() -> String {
#if canImport(Tor)
        let tor = TorService.state
        let progress = TorService.progress
        let everUp = TorService.everUp
        let transport = TorService.transport.rawValue
        let firstSetup = TorService.firstSetup
#else
        let tor = "none"
        let progress = 0
        let everUp = false
        let transport = "direct"
        let firstSetup = false
#endif
        /* Whether a VPN tunnel is up at this moment, asked every time rather
         * than remembered: somebody who proceeds with their VPN and then
         * switches it off must stop being told they are behind one, and the
         * banner flips to IP ADDRESS EXPOSED on its own. Any tunnel counts —
         * Orbot is one (OrbotLink.vpnActive). */
        let obj: [String: Any] = ["tor": tor, "progress": progress, "everUp": everUp,
                                  "unprotected": unprotected, "transport": transport,
                                  "orbot": OrbotLink.name, "firstSetup": firstSetup,
                                  "vpn": OrbotLink.vpnActive(),
                                  /* Foxy holds a key Orbot issued. Independent
                                   * of whether its API answered this second:
                                   * the screen must not stop calling this
                                   * Orbot just because a poll went quiet. */
                                  "orbotKey": OrbotLink.hasKey,
                                  // wifi, cellular, wired, other, none, unknown
                                  "network": network]
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }
}

/// Checks each redirect before URLSession follows it, and collects each answer
/// up to its limit.
///
/// A session delegate, not a per-task one, so no call site can forget it:
/// Route's open session and TorService.socksSession() are both made with it
/// (an invalidated session still asks it about its unfinished tasks),
/// and smoke check 17d fails the build if a URLSession is made without it.
/// Every request here is a task Route started, with no completion handler, so
/// URLSession hands its answer to this delegate as it arrives.
final class RedirectGuard: NSObject, URLSessionTaskDelegate, URLSessionDataDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        guard let target = request.url else { completionHandler(nil); return }
        let original = task.originalRequest?.url ?? response.url
        if let problem = Route.redirectProblem(from: original, to: target) {
            // Cancelled: the task completes with the redirect response itself,
            // a 3xx the page reports as a failure, and nothing is sent to the target.
            print("[foxy] redirect refused:", original?.host ?? "?", "->",
                  target.absoluteString.prefix(120), "-", problem)
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }

    // MARK: Answers, collected up to a limit

    /// One task's answer so far. Sessions call their delegate on their own
    /// queues, and every session shares this delegate, so `collecting` is locked.
    private struct Collecting {
        let cap: AnswerCap
        let done: (Data?, URLResponse?, Error?) -> Void
        var data = Data()
        var tooLarge = false
    }
    private let lock = NSLock()
    /// Keyed by the task object: a task identifier is unique only within its
    /// session, and each Tor request has a session of its own.
    private var collecting: [ObjectIdentifier: Collecting] = [:]

    /// Before `task` resumes: collect its answer up to `limit`, then call `done`.
    func collect(_ task: URLSessionTask, limit: Int, _ done: @escaping (Data?, URLResponse?, Error?) -> Void) {
        lock.lock(); defer { lock.unlock() }
        collecting[ObjectIdentifier(task)] = Collecting(cap: AnswerCap(limit: limit), done: done)
    }

    /// A server that says it will send more than the limit is refused before
    /// any of its body is read.
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock()
        let refuse = collecting[ObjectIdentifier(dataTask)].map {
            $0.cap.refusesUpFront(expectedLength: response.expectedContentLength)
        } ?? false
        if refuse { collecting[ObjectIdentifier(dataTask)]?.tooLarge = true }
        lock.unlock()
        completionHandler(refuse ? .cancel : .allow)
    }

    /// One that says nothing, or says less and sends more, is stopped at the
    /// chunk that would pass the limit; that chunk is not kept.
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        var stop = false
        if var entry = collecting[ObjectIdentifier(dataTask)], !entry.tooLarge {
            if entry.cap.allows(held: entry.data.count, more: data.count) {
                entry.data.append(data)
            } else {
                entry.data = Data()
                entry.tooLarge = true
                stop = true
            }
            collecting[ObjectIdentifier(dataTask)] = entry
        }
        lock.unlock()
        if stop { dataTask.cancel() }
    }

    /// What a completion handler would have been given: the data, or nil with an
    /// error; AnswerTooLarge when this delegate stopped the task.
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let entry = collecting.removeValue(forKey: ObjectIdentifier(task))
        lock.unlock()
        guard let entry else { return }
        if entry.tooLarge {
            print("[foxy] answer refused: more than \(entry.cap.limit) bytes from", task.originalRequest?.url?.host ?? "?")
            entry.done(nil, task.response, AnswerTooLarge())
        } else if let error {
            entry.done(nil, task.response, error)
        } else {
            entry.done(entry.data, task.response, nil)
        }
    }
}

/// The size rule for an answer, apart from URLSession so the unit tests can
/// hold it to its numbers.
struct AnswerCap {
    let limit: Int

    /// The server's own Content-Length is over the limit. -1, unknown, is not.
    func refusesUpFront(expectedLength: Int64) -> Bool {
        expectedLength > Int64(limit)
    }

    /// `more` bytes on top of `held` stay within the limit.
    func allows(held: Int, more: Int) -> Bool {
        more <= limit - held
    }
}

/// An answer stopped at Route.largestAnswer.
struct AnswerTooLarge: LocalizedError {
    var errorDescription: String? { "The answer was too large." }
}

/// Hosts Foxy may contact, and the question iOS asks before a new one.
///
/// Any script that ran in the page could send what the page holds — the seed
/// included — to an address of its own through `mintRequest`, over Tor, and
/// nothing would say so. Now the first request to a host Foxy has not used shows
/// an alert that iOS draws and no script can answer: the host's name, Allow or
/// Don't Allow. Allowed hosts are remembered, in the keychain on this device
/// only — not in UserDefaults, which goes into backups and would list the mints
/// and payment domains this person uses.
///
/// Approved without asking: the mints Foxy lists by default and any host under
/// one, the two block explorers a card's clock comes from (`explorers`), a host
/// the person allowed and any host under it (a lightning address's
/// callback on its own subdomain), and exactly the mints and contact domains a
/// wallet already had the first time this version ran.
///
/// Those carried hosts are approved as themselves, not with their subdomains.
/// The list comes from the page, and a page that carried `co.uk` used to approve
/// every name under it (audit I4). A mint is always asked for by its
/// own host, and a redirect never leaves it, so no mint that worked stops
/// working; a lightning address's callback on a subdomain of a carried domain
/// is asked about once. Refusing short names instead would have refused
/// two-label mints and contact domains, and still let a three-label public
/// suffix through.
enum HostApprovals {
    /// The mints the app offers by default (build/app DEFAULT_MINTS).
    static let builtIn: Set<String> = [
        "mint.minibits.cash", "mint.westernbtc.com",
        "mint.macadamia.cash", "nofee.testnut.cashu.space", "testnut.cashu.space",
    ]
    /// The two block explorers, by their onion addresses, that a card's clock is fetched from
    /// (build/wallet/08b-block-headers.js: mempool.space's and Blockstream's). The page asks them on its
    /// own, as Tor comes up or a card is tapped, with nobody adding a mint, so an alert for a host
    /// that nobody has heard of would be asked about for nothing, and a refusal would stop the clock.
    /// They are published addresses, the same for everybody, and a request to either goes
    /// to its operator and to no one the page chose.
    static let explorers: Set<String> = [
        "mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion",
        "explorerzydxu5ecjrkwceayqybizmpjjznk5izmitf2modhcusuqlid.onion",
    ]
    /// Hosts the person allowed in the alert. In earlier builds the carried
    /// hosts were added here too, and those still approve their subdomains:
    /// nothing records which entries they were.
    static let storeKey = "foxy.hosts.approved"
    /// The carried hosts, as a JSON list, and the note that the carry-over has
    /// happened. Installs from earlier builds hold "yes" here, which lists
    /// no host.
    static let carriedKey = "foxy.hosts.carried"
    private static var cache: Set<String>?
    private static var carriedCache: Set<String>?
    private static var waiting: [String: [(Bool) -> Void]] = [:]
    private static var asking: String?

    private static func stored() -> Set<String> {
        if let cache { return cache }
        let raw = SeedStore.load(key: storeKey) ?? "[]"
        let list = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String] ?? []
        cache = Set(list)
        return cache!
    }

    private static func store(_ hosts: Set<String>) {
        cache = hosts
        if let data = try? JSONSerialization.data(withJSONObject: Array(hosts).sorted()),
           let text = String(data: data, encoding: .utf8) {
            _ = SeedStore.save(text, key: storeKey)
        }
    }

    static func normal(_ host: String) -> String {
        host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ". "))
    }

    private static func carried() -> Set<String> {
        if let carriedCache { return carriedCache }
        let raw = SeedStore.load(key: carriedKey) ?? "[]"
        let list = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String] ?? []
        carriedCache = Set(list)
        return carriedCache!
    }

    static func isApproved(_ host: String) -> Bool {
        approves(host, approved: builtIn.union(explorers).union(stored()), carried: carried())
    }

    /// The rule, apart from the keychain: a host in `approved` or under one, or
    /// exactly a host in `carried`.
    static func approves(_ host: String, approved: Set<String>, carried: Set<String>) -> Bool {
        let h = normal(host)
        guard !h.isEmpty else { return false }
        return approved.contains(h) || carried.contains(h) || approved.contains { h.hasSuffix("." + $0) }
    }

    /// What of a page's list is carried: at most 200 names, each a plausible
    /// host name, normalised.
    static func carriable(_ hosts: [String]) -> [String] {
        hosts.prefix(200).map(normal).filter { h in
            !h.isEmpty && h.count <= 253 && h.contains(".")
                && h.allSatisfy { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" }
        }
    }

    /// The hosts a wallet already used, once: the first time this version runs.
    /// Later calls change nothing, so a script injected afterwards cannot add
    /// its own host this way.
    static func carryOver(_ hosts: [String]) {
        dispatchPrecondition(condition: .onQueue(.main))
        // absent, not merely unreadable: a keychain that did not answer used to
        // count as never carried, and a page's list was taken again (I4)
        guard case .absent = SeedStore.read(key: carriedKey) else { return }
        let clean = Set(carriable(hosts))
        // kept apart from the hosts the person allowed, so each is matched exactly
        guard let data = try? JSONSerialization.data(withJSONObject: Array(clean).sorted()),
              let text = String(data: data, encoding: .utf8) else { return }
        carriedCache = clean
        _ = SeedStore.save(text, key: carriedKey)
        print("[foxy] hosts: carried over \(clean.count) the wallet already used")
    }

    /// After a Don't Allow, no alert for this long: a page cannot keep asking
    /// until the person taps Allow to make it stop.
    private static var quietUntil = Date.distantPast

    /// Asks once per host, one alert at a time; everything waiting on that host
    /// hears the answer. With nothing to present on, the answer is no.
    static func ask(_ host: String, on presenter: UIViewController?, _ done: @escaping (Bool) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        let h = normal(host)
        if isApproved(h) { done(true); return }
        if Date() < quietUntil { done(false); return }
        waiting[h, default: []].append(done)
        if waiting[h]!.count == 1 { next(on: presenter) }
    }

    /// The alert goes into NativePrompts' one queue, so it never shows over,
    /// or under, a seed or Tor question (audit I3).
    private static func next(on presenter: UIViewController?) {
        guard asking == nil, let h = waiting.keys.sorted().first else { return }
        guard presenter != nil else { finish(h, false, on: presenter); return }
        asking = h
        let prompt = NativePrompt(
            title: "Allow Foxy to contact \(h)?",
            message: "Foxy has not contacted this address before. It happens when you add a mint, receive a token from one, or pay a lightning address. If you did not just do one of those, tap Don't Allow. Allowing it also allows addresses under it, such as pay.\(h).",
            no: "Don't Allow", yes: "Allow", yesStyle: .default)
        NativePrompts.ask(prompt, on: presenter) { allowed in
            guard allowed else {
                quietUntil = Date().addingTimeInterval(30)
                // every other host still waiting is refused with it
                let others = waiting.filter { $0.key != h }
                others.keys.forEach { waiting.removeValue(forKey: $0) }
                others.values.forEach { list in list.forEach { $0(false) } }
                finish(h, false, on: presenter)
                return
            }
            store(stored().union([h]))
            print("[foxy] hosts: allowed \(h)")
            finish(h, true, on: presenter)
        }
    }

    private static func finish(_ h: String, _ allowed: Bool, on presenter: UIViewController?) {
        let done = waiting.removeValue(forKey: h) ?? []
        if asking == h { asking = nil }
        done.forEach { $0(allowed) }
        next(on: presenter)
    }
}
