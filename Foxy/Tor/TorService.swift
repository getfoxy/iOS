import Foundation
#if canImport(Tor)
import Tor
#else
// A build without Tor installs and runs, and can only ever offer to continue
// without it. That happened once, silently: xcodegen generate after pod install
// rewrote the project without the pods. Refuse to build instead.
#error("Tor.framework is not linked. Run xcodegen generate, then pod install, then open Foxy.xcworkspace.")
#endif
import Network

#if canImport(Tor)
/// Tor, in this process: the only way Foxy reaches a mint, a price feed or a
/// lightning address, unless the person using it has chosen otherwise for
/// this session.
///
/// Modelled on ZeusLN/react-native-tor: a daemon on a known SOCKS port, and a
/// URLSession whose proxy configuration points at it. With the daemon
/// down, the connection to 127.0.0.1 is refused and nothing leaves.
///
/// Things learned the hard way, all undocumented:
///   a Unix socket path caps at 104 characters, and a simulator container
///     runs to 183 while a phone's had eight to spare — so the control link
///     is a TCP port on 127.0.0.1, which has no such limit
///   the data directory is kept 0700; Tor refuses one others can read
///   TorController.connect() can report failure while having succeeded
///   the classes are TorThread, TorController, TorConfiguration — not the
///     TOR-prefixed names in the README
///   there is one TorThread per process — TORThread.m asserts it, and
///     tor_run_main cannot run twice — so a retry nudges the running daemon
///     rather than starting another. The version before this stopped the
///     thread and made a new one, which asserts in a debug build.
///
/// Every property is written on the main queue, and read there, except `ready`
/// and `socksPort`, which are also read off it and so are locked.
enum TorService {
    /// Tor's SOCKS port, chosen by Tor and read back over the control link; 0
    /// while not known.
    ///
    /// It was a fixed 9050. Every app on the phone can reach 127.0.0.1, and Tor
    /// closes and reopens its listener whenever its network is switched off and
    /// on — so for a moment 9050 was free for anything to take, and Foxy would
    /// then have handed its requests to whatever held it, still believing Tor
    /// was up. A port Tor picks cannot be predicted, and the port is forgotten
    /// before anything that reopens the listener and read again after.
    ///
    /// Written on the main queue like everything here, but also read off it
    /// (Debug diagnostics), so behind a lock (audit I9).
    private(set) static var socksPort: UInt16 {
        get { socksPortStore.value }
        set { socksPortStore.value = newValue }
    }
    private static let socksPortStore = Locked<UInt16>(0)

    /// A bootstrap with no circuit after this long is reported as failed.
    /// Seventeen seconds cold on a good connection; this is for a bad one.
    /// Tor keeps trying after the page is told, so a circuit that arrives
    /// late still moves the app onto it.
    static let patience: TimeInterval = 45

    private static var thread: TorThread?
    private static var conf: TorConfiguration?
    private static var controller: TorController?
    /// The last reason Tor gave for not getting through, so the same one is not
    /// printed every second while it keeps happening.
    private static var lastTrouble: String?
    private static var authenticating = false
    /// How long authentication on a new control link may go unanswered before
    /// that link is dropped and another connected, and how many links are
    /// tried before Foxy says it could not connect. The reply is local and
    /// arrives in milliseconds once Tor's main loop is running — but Tor reads
    /// its whole microdescriptor cache before that loop starts, and a cache of
    /// 44 MB took it past three links of four seconds, so Foxy said it could
    /// not connect to a Tor that was still loading (in the simulator).
    /// Eight links, half a minute, cover a cache that size on a slow phone.
    static let authenticationPatience: TimeInterval = 4
    static let authenticationTries = 8
    /// The link being authenticated now; a reply to one given up on is ignored.
    private static var authGen = 0
    private static var authTries = 0
    /// The last sign a connection attempt was getting somewhere: bytes from
    /// relays, an event from Tor, a new link, set-up or transport (`noteLife`).
    private static var lifeAt = Date()
    /// What the page was last told about being stuck, so it hears each change once.
    private static var stuckTold = false
    private static var lifeTicking = false
    /// The set-up a restart asked for keeps the fallback clock and the transports
    /// already tried. On a network that lets nothing through, a restart that
    /// started the clock again kept Foxy on one transport for as long as the taps
    /// came, never trying a bridge and never saying it could not connect.
    private static var keepClock = false
    private static var clockKeptFor = -1
    /// The control socket Tor opened after iOS reclaimed its TCP control
    /// listener (`recoverControlListener`); links go there once it is set.
    private static var controlSocketURL: URL?
    private static var recoveringControl = false
    private static var controlSockets = 0
    /// Tor runs, and nothing in Foxy can reach it again: reported as stopped,
    /// so the page says to reopen Foxy rather than offer RESTART TOR for ever.
    private static var controlUnreachable = false
    #if DEBUG
    /// -FoxyTorStall auth: every authentication reply is dropped until a restart
    /// is asked for, which is the state a phone was once found in and
    /// could not be made to reach on purpose. So the authentication deadline, the
    /// CANNOT CONNECT it ends in, and RESTART TOR can be tested on a phone.
    private static var stallAuthUntilRestart = UserDefaults.standard.string(forKey: "FoxyTorStall") == "auth"
    /// -FoxyTorStall listener: the TCP control port is treated as refused, as iOS
    /// leaves it after reclaiming a suspended app's sockets, so the recovery
    /// (recoverControlListener) runs on demand. Once only: the socket it gets
    /// Tor to open is used for real.
    private static var stallListenerOnce = UserDefaults.standard.string(forKey: "FoxyTorStall") == "listener"
    #endif
    private static var deadline: DispatchWorkItem?

    /// Written on the main queue, and read from any: Route's redirect guard asks
    /// `isRunning` on URLSession's queue. So behind a lock (audit I9).
    private(set) static var ready: Bool {
        get { readyStore.value }
        set { readyStore.value = newValue }
    }
    private static let readyStore = Locked(false)
    /// Tor's own two answers. Ready needs both: a circuit, and directory info
    /// enough to build the next one. With IsolateDestAddr every new destination
    /// is a new circuit, so a circuit without directory info carries the mint
    /// and nothing else — after a fallback to Snowflake the price feeds timed
    /// out for a minute while "circuit established" had already been reported.
    private static var circuitUp = false
    private static var dirInfo = true
    /// A circuit has existed since launch or the last set-up (`setUp`). A drop
    /// after that is Tor finding its way back, not a place it cannot reach, and
    /// the page shows no screen for it; before it, the page shows its launch
    /// screens.
    private(set) static var everUp = false
    /// Tor has no relay list saved: this launch downloads it whole, which is the
    /// slow first start (13 seconds on good signal, 80 on weak).
    /// The connecting screen says so. False from the first circuit on.
    private(set) static var firstSetup = false
    private(set) static var failed = false
    private(set) static var progress = 0
    /// Direct, or the bridge carrying Tor right now.
    private(set) static var transport: TorTransport = .direct
    /// Transports tried since the last start, so the fallback does not loop.
    private static var tried: Set<TorTransport> = []
    /// When the current transport's clock started, the progress it had then,
    /// and how many times a bootstrap still moving has been given longer.
    /// Orbot's bypass port while Orbot runs and has let Foxy past; nil otherwise.
    private static var orbotBypass: UInt16?
    /// Orbot changed after Tor launched but before its control link was up.
    private static var orbotPending = false
    private static var armedAt = Date()
    private static var progressAtArm = 0
    /// When Tor last reported a bootstrap step, at any percentage.
    private static var bootEventAt = Date.distantPast
    /// The last percentage Tor itself reported, as against `progress`, which a
    /// set-up also counts its own steps into.
    private static var bootSaid = 0
    private static var extensions = 0

    /// The stall watch (`stallTick`), while direct Tor has not yet reached a
    /// circuit: at launch and on every return, which is where it was asked for.
    ///
    /// On a new install Tor downloads the whole relay directory, and a download
    /// from a slow relay could hang with nothing arriving: on a phone the
    /// launch screen sat at 30% for more than 30 seconds, where killing and
    /// reopening the app got it moving at once. Once data has arrived and then
    /// nothing more does for `stallAfter`, Tor is nudged: its connections start
    /// again, and what it already downloaded is kept.
    ///
    /// "Data" is Tor's traffic/read, bytes from relays. Tor does not count
    /// 127.0.0.1 (connection_is_rate_limited), so the control link's own
    /// traffic never looks like progress, and neither would a bridge's or
    /// Orbot's: only direct Tor with no Orbot bypass is watched. Nothing is
    /// nudged before data has arrived, because on a slow network the first
    /// handshake can take longer than this, and restarting it would never let
    /// it finish. The transport's patience still applies on top.
    static let stallAfter: TimeInterval = 5
    private static var stallWatching = false
    /// The bootstrap step a nudge was already given for (deadlineExpired).
    private static var nudgedEventAt: Date?
    private static var stallAsking = false
    /// Tor's network is meant to be on; a set-up and the background switch it off.
    private static var stallOn = false
    private static var stallGen = 0
    private static var stallBytes: UInt64?
    private static var stallSince = Date()
    private static var stallSawData = false

    /// The set-up running now; a callback from an earlier one is ignored.
    private static var setUpGen = 0
    /// A set-up asked for while the control link was being connected again.
    private static var setUpPending = false
    /// Off the network because Foxy went to the background (`backgrounded`).
    /// The return sets up a private connection; nothing else does.
    private static var parked = false
    /// Moves on every change that can close Tor's listener, so an answer about
    /// the old one is never used; and the generation a read is in flight for,
    /// so one read answers for everyone waiting on it.
    private static var socksGen = 0
    private static var socksReadingGen = -1

    /// Told on every change of ready, failed or progress, on the main queue.
    static var onChange: (() -> Void)?

    static var isRunning: Bool { ready }

    /// "up", "connecting", "failed", or "stopped": Tor's thread has exited, and
    /// only reopening Foxy can start it again (one TorThread per process, above).
    static var state: String {
        ready ? "up" : (stopped ? "stopped" : (failed ? "failed" : (stuck ? "stuck" : "connecting")))
    }

    /// RESTART TOR is offered, as "stuck" (`TorStuck` says when, and why not on
    /// a percentage standing still).
    static var stuck: Bool {
        TorStuck.offered(connecting: TorStuck.connecting(running: thread != nil, ready: ready,
                                                         failed: failed, stopped: stopped,
                                                         parked: parked, offNetwork: offForBlackout),
                         hasLink: controller != nil,
                         quiet: Date().timeIntervalSince(lifeAt),
                         bytesCounted: transport == .direct && orbotBypass == nil,
                         snowflake: transport == .snowflake)
    }

    static var stopped: Bool { thread?.isFinished == true || controlUnreachable }

    /// Start Tor; or, if it is running without a circuit, try again now.
    static func start() {
        dispatchPrecondition(condition: .onQueue(.main))
        if ready { return }
        failed = false

        if thread == nil {
            changed()
            launch()                  // picks the transport, then starts its clock
        } else if controller == nil {
            armDeadline()
            changed()
            connectControl()          // the daemon runs; the control link never came
        } else {
            setUp("retrying")         // the launch's steps, and its fallback, again
        }
    }

    /// RESTART TOR, and RETRY: everything short of the Tor process.
    ///
    /// Tor runs once per app, so nothing here can start a new daemon. What can be
    /// thrown away is thrown away: the control link, dropped even when it looks
    /// alive, since a link that answers nothing looks alive; any authentication
    /// in flight; and Tor's network, which the set-up switches off and on again
    /// once a new link is in (`setUpPending`). `start()` did less: with a
    /// controller it ran the set-up on that same link, and with an authentication
    /// hanging it did nothing at all. A Tor whose thread has exited cannot be
    /// helped from here; the page is told `stopped` and says to reopen Foxy
    /// rather than offer a button that cannot work.
    static func restart(_ reason: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        #if DEBUG
        if stallAuthUntilRestart { print("[foxy] tor: -FoxyTorStall auth ends with this restart") }
        stallAuthUntilRestart = false
        #endif
        if ready { return }
        guard thread != nil else { start(); return }
        if stopped {
            print(controlUnreachable
                  ? "[foxy] tor: Tor runs but no control link can reach it; only reopening Foxy can"
                  : "[foxy] tor: the Tor thread has exited; only reopening Foxy can start it again")
            changed()
            return
        }
        if parked { setUp(reason); return }       // it says so, and waits for Foxy to come back
        /* Not over a set-up that began a moment ago because the network came
         * back. The page asks for a restart on the same news, and a restart
         * here would switch Tor's network off in the middle of its first
         * attempt — which is a failure held against the guard it was reaching. */
        if Date().timeIntervalSince(networkBackAt) < 4, controller != nil {
            print("[foxy] tor: \(reason) — already setting up, the network came back a moment ago")
            return
        }
        print("[foxy] tor: restarting (\(reason)): a new control link, then a new set-up")
        noteLife()
        keepClock = true
        failed = false
        authGen += 1                              // an authentication in flight is given up on
        authenticating = false
        authTries = 0
        if let old = controller {
            controller = nil                      // first: its observers now answer for nothing
            closeLink(old)                        // the link only; Tor keeps running
        }
        setUpPending = true
        if deadline == nil { armDeadline() }      // the clock already running is kept
        changed()
        connectControl()
    }

    // MARK: A control listener iOS reclaimed

    /// Tor's control listener, reopened by Tor itself after iOS reclaimed it.
    ///
    /// iOS reclaims every socket of a suspended app - TCP, Unix-domain and
    /// socket pairs alike (XNU networking_defunct_callout, socket_defunct), and
    /// only root may exempt one (SO_DEFUNCTOK). After a return of
    /// ten seconds on Wi-Fi, the log showed `control listener 127.0.0.1:56282 —
    /// REFUSED (61); Tor thread running`: Tor was fine and nothing could reach it.
    /// RESTART TOR could not help, since every command to Tor, the one that would
    /// reopen a listener included, goes through that listener. Tor reopens dead
    /// listeners itself every 60 seconds only while its network is on, and Foxy
    /// turns it off in the background; and a non-blocking listener with nothing
    /// queued answers accept() with EWOULDBLOCK, which Tor takes as "later", so
    /// it never learns the listener is dead.
    ///
    /// What does reach Tor is a signal: Tor registers SIGHUP unless
    /// __DisableSignalHandlers is set, and on SIGHUP reloads its configuration
    /// from the cached command line and its torrc, then opens every configured
    /// listener it does not have. `ControlPort auto` would match the dead TCP
    /// listener and open nothing, so the torrc names a Unix control socket
    /// (ControlSocket, a separate option the command line does not override) at a
    /// new path each time: nothing old can match it, and a socket reclaimed by a
    /// later suspension is replaced the same way. The directory is 0700, as Tor
    /// requires. A reload also resets what SETCONF changed - the network comes on,
    /// a bridge chosen since launch goes - so the set-up runs again afterwards.
    ///
    /// The handler is checked first: with none installed SIGHUP would end Foxy.
    /// If Tor opens no socket within 10 seconds, Foxy says to reopen it.
    private static func recoverControlListener() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !recoveringControl, !controlUnreachable, !parked,
              let t = thread, !t.isFinished else { return }
        guard sighupReachesTor() else {
            print("[foxy] tor: the control listener is gone, and no signal handler is installed to have Tor open another; only reopening Foxy can reach it")
            controlUnreachable = true
            changed()
            return
        }
        controlSockets += 1
        let socket = recoverySocketDir.appendingPathComponent("c\(controlSockets)")
        guard socket.path.utf8.count < 100 else {         // sun_path is 104 bytes
            print("[foxy] tor: the control listener is gone, and a control socket path would be too long here (\(socket.path.utf8.count)); only reopening Foxy can reach Tor")
            controlUnreachable = true
            changed()
            return
        }
        let fm = FileManager.default
        guard let dataDir = conf?.dataDirectory else { return }
        do {
            try? fm.removeItem(at: recoverySocketDir)     // earlier sockets, dead with the suspension
            try fm.createDirectory(at: recoverySocketDir, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: recoverySocketDir.path)
            try Data("ControlSocket \(socket.path)\n".utf8).write(to: recoveryTorrc(dataDir), options: .atomic)
        } catch {
            print("[foxy] tor: could not write the control socket's torrc: \(error); only reopening Foxy can reach Tor")
            controlUnreachable = true
            changed()
            return
        }
        recoveringControl = true
        print("[foxy] tor: the control listener is gone (iOS reclaims a suspended app's sockets); asking Tor to open control socket \(socket.lastPathComponent)")
        kill(getpid(), SIGHUP)
        DispatchQueue.global(qos: .utility).async {
            var opened = false
            for _ in 0..<40 {
                if fm.fileExists(atPath: socket.path) { opened = true; break }
                Thread.sleep(forTimeInterval: 0.25)
            }
            DispatchQueue.main.async {
                recoveringControl = false
                guard opened else {
                    print("[foxy] tor: no control socket 10s after the reload signal; only reopening Foxy can reach Tor")
                    controlUnreachable = true
                    changed()
                    return
                }
                print("[foxy] tor: Tor opened control socket \(socket.lastPathComponent); connecting to it")
                controlSocketURL = socket
                // the link waiting on the dead listener is given up now, not at its deadline
                authGen += 1
                authenticating = false
                authTries = 0
                setUpPending = true                   // the reload reset the network and transport
                noteLife()
                changed()
                connectControl()
            }
        }
    }

    /// The torrc Tor is told to use (-f, in launch), in its own 0700 data directory.
    private static func recoveryTorrc(_ dataDir: URL) -> URL {
        dataDir.appendingPathComponent("torrc")
    }

    /// Short on purpose: a Unix socket path must fit in 104 bytes.
    private static var recoverySocketDir: URL {
        URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("tmp/tc", isDirectory: true)
    }

    /// Whether a SIGHUP would reach a handler rather than end the process.
    private static func sighupReachesTor() -> Bool {
        var current = sigaction()
        guard sigaction(SIGHUP, nil, &current) == 0 else { return false }
        let handler = unsafeBitCast(current.__sigaction_u.__sa_handler, to: Int.self)
        return handler != 0 && handler != 1          // neither SIG_DFL nor SIG_IGN
    }

    // MARK: Stuck, for RESTART TOR

    /// For the log: whether Tor's own thread is still running its loop.
    static func threadState(_ t: TorThread?) -> String {
        guard let t else { return "not started" }
        return t.isFinished ? "finished" : (t.isExecuting ? "running" : "not running")
    }

    private static func noteLife() {
        lifeAt = Date()
    }

    /// Once a second from launch: tell the page when stuck starts or ends.
    private static func lifeTick() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { lifeTick() }
        let now = stuck
        guard now != stuckTold else { return }
        stuckTold = now
        let quiet = Int(Date().timeIntervalSince(lifeAt))
        print(now
              ? "[foxy] tor: nothing has moved for \(quiet)s" + (controller == nil ? ", with no control link" : "") + "; RESTART TOR offered"
              : "[foxy] tor: moving again; RESTART TOR withdrawn")
        changed()
    }

    /// The app came forward after `away` seconds in the background.
    ///
    /// Every return sets up a private connection the way launch does (`setUp`),
    /// on a Tor that went off the network as Foxy left (`backgrounded`). Nothing
    /// is tried on the connection from before: iOS breaks a suspended app's
    /// sockets, and testing that connection, then reconnecting when it failed,
    /// is what left returns stuck while a fresh launch connected in seconds.
    /// Face ID and Control Center take the app's focus without sending it to
    /// the background; Tor was not parked for those, and nothing changes.
    /* Every return to the foreground, not only a long one.
     *
     * `away >= 1` meant a quick switch away and back left whatever state Tor was
     * in, which is the state that needed fixing: the fastest way to get
     * connected was killing the app and launching it again, and a return should
     * not be worse than that.
     *
     * A connection that is genuinely up is left alone — there is nothing to
     * reconnect, and tearing down a working circuit to rebuild it would be the
     * slow thing this is meant to cure. */
    static func resumed(away: TimeInterval) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard thread != nil else { return }
        let wasParked = parked
        parked = false
        /* Not parked and up: nothing to set up, however long that took. Tor is
         * now kept on the network for up to twenty seconds after Foxy is put
         * away, while a payment or the change top-up is with the mint
         * (FoxyWebView.appEnteredBackground). Somebody back inside that time
         * was "away" two seconds, and the set-up that followed cut the swap
         * it had been kept up for, and left its sats held. */
        if ready && !wasParked && away < 30 {
            print("[foxy] tor: back after \(Int(away))s and the circuit is up; nothing to set up")
            return
        }
        /* Nor over a set-up that is already running.
         *
         * A permission alert, Face ID and Control Center all take the app's
         * focus and hand it back without Foxy ever leaving — Tor was not parked,
         * so whatever it was doing it is still doing. Setting up again switches
         * its network off in the middle of that. On a first launch iOS asks
         * about Bluetooth a few seconds in, and the set-up that followed the
         * answer cut Tor off at 14%, mid-handshake with its first relay; it
         * never recovered and the launch screen sat at 99% until the app was
         * killed (on a first install). */
        if !wasParked && away < 1 && !failed && (deadline != nil || setUpPending) {
            print("[foxy] tor: back after \(Int(away))s with a set-up already running; left alone")
            return
        }
        setUp("back after \(Int(away))s")
    }

    /// A private connection set up on the daemon that is already running — Tor
    /// cannot be started twice in one process (see the top of this file) — the
    /// way launch sets one up:
    ///
    ///   1. not ready, progress from 0, no SOCKS port: requests are refused, and
    ///      `everUp` is cleared, so the page shows its launch screens
    ///   2. Tor's network off: already, on a return from the background;
    ///      otherwise this closes every stale connection
    ///   3. the transport started fresh: a Snowflake peer or an obfs4
    ///      connection does not survive a suspension
    ///   4. its settings applied, then the network on and the listener read again
    ///   5. the transport's clock and fallback, as at launch
    ///   6. ready on Tor's own CIRCUIT_ESTABLISHED, as at launch. With its
    ///      network off Tor forgot it had a circuit
    ///      (note_that_we_maybe_cant_complete_circuits), so the next one it
    ///      announces was built after the network came back, and Tor never
    ///      announces a one-hop directory tunnel (circuitbuild.c)
    ///
    /// A control link that does not answer within three seconds is connected
    /// again, and the set-up runs once it is. Every return and RETRY use this.
    static func setUp(_ reason: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        if parked {
            print("[foxy] tor: \(reason) — waiting for Foxy to come back")
            return
        }
        guard thread != nil else { start(); return }
        setUpGen += 1
        let gen = setUpGen
        let keep = keepClock
        keepClock = false
        clockKeptFor = keep ? gen : -1
        noteLife()
        stallOff()                                // until the network is back on (networkOn)
        if !keep {
            deadline?.cancel()
            deadline = nil
        }
        ready = false
        circuitUp = false
        failed = false
        everUp = false
        socksPort = 0
        socksGen += 1                             // an answer about the old listener is not used
        progress = 0
        if !keep { tried = [transport] }
        changed()
        guard let ctrl = controller else {
            setUpPending = true
            if !authenticating {
                armDeadline()
                connectControl()
            }
            return
        }
        /* Nothing to set up through. Tor stays off the network until there is
         * one (`networkCameBack`), so a retry pressed in airplane mode cannot
         * start it failing against its guards. */
        if !Route.hasNetwork {
            offForBlackout = true
            print("[foxy] tor: \(reason) — the phone has no network; off it until there is one")
            setConf(ctrl, ["DisableNetwork=1"], timeout: 4) { _, _ in }
            return
        }
        print("[foxy] tor: setting up a private connection (\(reason)) through \(transport.rawValue)")
        #if DEBUG
        logGuards("setting up")
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
            if gen == setUpGen && !ready { logGuards("still setting up after 15s") }
        }
        #endif

        var answered = false
        setConf(ctrl, ["DisableNetwork=1"], timeout: 4) { _, _ in
            guard gen == setUpGen, !answered else { return }
            answered = true
            networkOff(gen, ctrl)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            guard gen == setUpGen, !answered else { return }
            answered = true
            print("[foxy] tor: the control link is not answering — connecting it again; Tor thread \(threadState(thread))")
            controller = nil                      // first: its observers now answer for nothing
            closeLink(ctrl)                       // the link only; Tor keeps running
            setUpPending = true
            armDeadline()
            connectControl()
        }
    }

    /// Foxy is going to the background: Tor comes off the network now, while
    /// iOS still lets it answer.
    ///
    /// iOS suspends the app seconds later and breaks its sockets. Tor used to
    /// wake with them broken and start connecting to its guards again, and the
    /// reconnect Foxy then ran switched its network off mid-attempt. Tor counts
    /// a guard connection that closes before it opens as that guard failing
    /// (connection_or_about_to_close, entry_guard_chan_failed), and tries a
    /// primary guard marked down again only after ten minutes
    /// (get_retry_schedule). So a return waited on guards Tor trusted less and
    /// sat at 44%, while a fresh launch — which remembers no such failures —
    /// connected in seconds. Off the network before the suspension, Tor has no
    /// connection to lose and nothing to count against a guard.
    ///
    /// `done` runs once Tor has answered, or has had four seconds to.
    static func backgrounded(_ done: @escaping () -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard thread != nil, let ctrl = controller, !parked else { done(); return }
        parked = true
        setUpGen += 1                             // a set-up in flight stops here
        let gen = setUpGen
        setUpPending = false
        stallOff()
        deadline?.cancel()
        deadline = nil
        ready = false
        circuitUp = false
        socksPort = 0
        socksGen += 1                             // the listener closes with the network
        changed()
        #if DEBUG
        logGuards("going to the background")
        #endif
        setConf(ctrl, ["DisableNetwork=1"], timeout: 4) { ok, message in
            if gen == setUpGen && parked {
                #if canImport(IPtProxy)
                if transport != .direct { Bridges.stopAll() }
                #endif
                print(ok ? "[foxy] tor: off the network while Foxy is in the background"
                         : "[foxy] tor: could not switch its network off (\(message))")
            }
            done()
        }
    }

    #if DEBUG
    /// Debug builds: whether Tor counts its guards reachable, in the log. A
    /// "down" on a guard used a minute ago is what a suspension used to leave
    /// behind, and what a fresh launch never has.
    private static func logGuards(_ when: String) {
        guard let ctrl = controller else { return }
        getInfo(ctrl, ["entry-guards"], timeout: 5) { values in
            let rows = (values.first ?? "").split(whereSeparator: \.isNewline)
                .map { $0.split(separator: " ") }
                .filter { $0.count >= 2 }
            guard !rows.isEmpty else {
                print("[foxy] tor guards (\(when)): no answer")
                return
            }
            var counts: [String: Int] = [:]
            for row in rows { counts[String(row[1]), default: 0] += 1 }
            let first = rows.prefix(3).map { String($0[1]) }.joined(separator: ", ")
            let tally = counts.sorted { $0.key < $1.key }.map { "\($0.value) \($0.key)" }.joined(separator: ", ")
            print("[foxy] tor guards (\(when)): first three \(first); \(tally)")
        }
    }
    #endif

    /// Steps 3 and 4: Tor's network is off.
    private static func networkOff(_ gen: Int, _ ctrl: TorController) {
        setUpProgress(10)
        guard let dir = conf?.dataDirectory else { return }
        #if canImport(IPtProxy)
        if transport != .direct { Bridges.stopAll() }
        #endif
        guard let settings = transportSettings(transport, dir: dir) else {
            // this transport will not start now: on with the network, and the next one
            networkOn(gen, ctrl) { deadlineExpired() }
            return
        }
        setUpProgress(20)
        if clockKeptFor != gen { armDeadline() }  // this transport's patience, from now
        // Settings first, network after: switching the network on straight
        // after a transport change is what broke a Snowflake handshake before
        // (see apply). Here the network is off while the settings change.
        apply(settings, on: ctrl) { networkOn(gen, ctrl) }
    }

    private static func networkOn(_ gen: Int, _ ctrl: TorController, then: (() -> Void)? = nil) {
        setConf(ctrl, ["DisableNetwork=0"]) { ok, _ in
            guard gen == setUpGen else { return }
            if !ok { print("[foxy] tor: could not switch the network back on") }
            stallReset()
            setUpProgress(30)
            getInfo(ctrl, ["status/enough-dir-info"]) { values in dirInfoChanged(values.first != "0") }
            readSocksPort()
            guard let then else {
                // the clock again, from here: the steps so far reached no relay
                if clockKeptFor != gen { armDeadline() }
                askForCircuit(gen)
                return
            }
            then()
        }
    }

    /// Tor builds the circuits it predicts a need for, and after a long idle it
    /// may predict none, while the page waits for a circuit before it asks for
    /// anything. So one is asked for (EXTENDCIRCUIT 0: a general circuit on a
    /// path Tor picks, as it builds on its own), again every five seconds until
    /// Tor announces one. Tor refuses it while it lacks directory info.
    private static func askForCircuit(_ gen: Int) {
        guard gen == setUpGen, !ready, !circuitUp, let ctrl = controller else { return }
        control(ctrl, "EXTENDCIRCUIT", ["0"], timeout: 5, claims: { c, l in
            c.count == 1 && ((c[0] == 250 && (l.first ?? "").hasPrefix("EXTENDED ")) || c[0] >= 500)
        }, done: { _, _ in })
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { askForCircuit(gen) }
    }

    /// Set-up progress, which only goes up. A first bootstrap shows Tor's own.
    private static func setUpProgress(_ p: Int) {
        guard p > progress, p < 100 else { return }
        progress = p
        changed()
    }

    /// Where Tor's SOCKS listener is, from Tor itself.
    ///
    /// Asked until Tor answers, one read per listener at a time. A read that
    /// lost its reply to another command used to end there, silently: Tor had
    /// its new listener open, and the app waited on port 0 for good.
    private static func readSocksPort(attempt: Int = 0, asked: Int? = nil) {
        guard let ctrl = controller else { socksReadingGen = -1; return }
        let gen = asked ?? socksGen
        guard gen == socksGen else { return }                   // the listener changed since
        if asked == nil {
            guard socksReadingGen != gen else { return }         // one in flight answers for all
            socksReadingGen = gen
        }
        getInfo(ctrl, ["net/listeners/socks"], timeout: 3) { values in
            guard gen == socksGen else { return }
            let port = values.first.flatMap(loopbackPort) ?? 0
            guard port != 0 else {
                if attempt < 20 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { readSocksPort(attempt: attempt + 1, asked: gen) }
                } else {
                    socksReadingGen = -1
                    print("[foxy] tor: reports no SOCKS listener")
                }
                return
            }
            socksReadingGen = -1
            if port != socksPort { print("[foxy] tor: SOCKS on 127.0.0.1:\(port)") }
            socksPort = port
            if circuitUp { established() }
        }
    }

    /// "127.0.0.1:53211", quoted, first of any listed. Loopback only.
    private static func loopbackPort(_ raw: String) -> UInt16? {
        let first = raw.replacingOccurrences(of: "\"", with: "").split(separator: " ").first.map(String.init) ?? ""
        let prefix = "127.0.0.1:"
        guard first.hasPrefix(prefix), let port = UInt16(first.dropFirst(prefix.count)), port != 0 else { return nil }
        return port
    }

    /// Before anything that can make Tor close and reopen its listener: no
    /// request goes to a port until Tor has said it is still its own.
    private static func forgetSocksPort() {
        socksPort = 0
        socksGen += 1
        if ready {
            ready = false
            changed()
        }
    }

    /// Tor gained or lost the directory info it needs to build circuits.
    private static func dirInfoChanged(_ enough: Bool) {
        guard enough != dirInfo else { return }
        dirInfo = enough
        if enough {
            print("[foxy] tor: directory info complete")
            if circuitUp { established() }
        } else if ready {
            // Not a lost circuit — the next destination just cannot get one yet.
            ready = false
            print("[foxy] tor: directory info incomplete; new circuits wait for it")
            armDeadline()
            changed()
        }
    }

    private static func launch() {
        let dir = dataDirectory()
        /* The relay directory Foxy ships with, on a first run only. Tor cannot
         * build a circuit before it holds the relays' microdescriptors, and
         * downloading all of them was 37 of the 45 seconds a first launch took
         * on a phone (TorSeed). Tor verifies every one of them
         * against the signed consensus regardless of where they came from. */
        TorSeed.plant(in: dir)

        let c = TorConfiguration()
        c.ignoreMissingTorrc = true
        c.cookieAuthentication = true
        c.dataDirectory = dir
        // Tor picks a free port on 127.0.0.1 and writes it to controlport. The
        // cookie, readable only inside this app's container, keeps anything
        // else on the device from using it.
        c.autoControlPort = true
        c.avoidDiskWrites = true
        // One circuit per destination. Without this the mint, the price feed
        // and a lightning-address server shared a circuit and an exit, so an
        // observer there could link "checks the price, pays this address, at
        // this mint" to one person. Orbot sets the same flag.
        //
        // Through `options`, which Tor.framework passes as one --SocksPort
        // argument. An earlier attempt to pin the port through `arguments`
        // made Tor refuse its config; if Tor ever refuses this one, check here.
        //
        // `ExtendedErrors` only changes what a *failure* says. RFC 1928 has one
        // code for every onion-side failure — reply 4, "host unreachable" — so
        // a descriptor that was never published, one that is stale, a refused
        // introduction and a rendezvous that timed out all arrive as the same
        // byte, and two minutes of waiting could not be told apart from a fast
        // refusal. With the flag Tor answers 0xF0
        // "not found", 0xF2 "introduction failed", 0xF3 "rendezvous failed",
        // 0xF7 "introduction timed out" instead. OnionPost treats any non-zero
        // reply as `.unreachable(code)` and says the same thing to the person
        // either way; the number is for the log.
        c.options["SocksPort"] = "auto IsolateDestAddr ExtendedErrors"   // 127.0.0.1, a port of Tor's choosing
        // No conflux (multipath) circuits. Tor 0.4.9.6 logged internal "Bug:"
        // warnings from its conflux code when recovery switched its network off
        // and on — 27 in one of two simulator trials, none in two trials with it
        // off. Conflux helps large transfers; a wallet's requests are small, and
        // off, recovery took about two seconds longer. THREAT-MODEL.md §9.
        c.options["ConfluxEnabled"] = "0"
        // A request that reaches Tor as a bare IP address is refused. Foxy gives
        // Tor hostnames; if anything ever looked one up on the phone first, the
        // phone's DNS resolver saw it. This makes that fail where it would be
        // noticed, rather than work quietly.
        c.options["SafeSocks"] = "1"
        // never a private, loopback or link-local address through an exit
        c.options["ClientRejectInternalAddresses"] = "1"
        #if !DEBUG
        // Tor's notices name relays and bootstrap detail. A release build
        // keeps its errors and nothing else.
        c.options["Log"] = "err stderr"
        // and nothing before that setting is read: without --hush Tor prints its
        // startup notices, listener ports among them, to the console first
        c.arguments.add("--hush")
        #endif

        // the last launch's port and cookie must not be read as this one's
        for stale in ["controlport", "control_auth_cookie"] {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(stale))
        }
        // nor its recovery torrc, which Tor would otherwise read at start, or its control sockets
        try? FileManager.default.removeItem(at: recoveryTorrc(dir))
        try? FileManager.default.removeItem(at: recoverySocketDir)
        controlSocketURL = nil
        // Tor's torrc is named, and missing at start (--ignore-missing-torrc): a
        // reload reads this path, and only a recovery writes it. Tor's default,
        // ~/.torrc, is the root of the app container, which iOS does not let an
        // app write (EPERM on a phone; a Mac allowed it).
        c.arguments.add("-f")
        c.arguments.add(recoveryTorrc(dir).path)

        #if DEBUG
        if let forced = UserDefaults.standard.string(forKey: "FoxyForceTransport"),
           let t = TorTransport(rawValue: forced) {
            TorTransport.remembered = t
        }
        #endif
        // The transport that last worked goes in from the start. One that will
        // not start falls back to direct rather than to nothing.
        TorTransport.forgetBridgeLearnedInTheDark()
        transport = TorTransport.remembered
        var settings = transportSettings(transport, dir: dir)
        if settings == nil {
            transport = .direct
            settings = []
        }
        tried = [transport]
        // A fresh start learns nothing from an earlier blackout
        blackout = !Route.hasNetwork
        directTries = 0
        // The clock starts now, with this transport's patience. It used to
        // start before the transport was chosen, so a remembered Snowflake was
        // given direct's 45 seconds and abandoned while still bootstrapping.
        armDeadline()
        for (key, value) in settings ?? [] {
            c.arguments.add("--\(key)")
            c.arguments.add(value)
        }
        if transport == .direct, let port = orbotBypass {
            c.arguments.add("--Socks5Proxy")
            c.arguments.add("127.0.0.1:\(port)")
            print("[foxy] tor: starting past Orbot through its bypass port \(port)")
        }
        if transport != .direct { print("[foxy] tor: starting through \(transport.rawValue)") }

        // a relay list saved by an earlier launch means this is not the first setup
        let fm = FileManager.default
        firstSetup = !["cached-microdesc-consensus", "cached-consensus", "unverified-microdesc-consensus"]
            .contains { fm.fileExists(atPath: dir.appendingPathComponent($0).path) }
        if firstSetup { print("[foxy] tor: no relay list saved yet: the first setup") }
        let t = TorThread(configuration: c)
        thread = t
        noteLife()
        if !lifeTicking { lifeTicking = true; lifeTick() }
        conf = c
        t.start()
        print("[foxy] tor starting; it chooses its SOCKS port")
        connectControl()
    }

    /// Tor's state, kept where iOS will not delete it.
    ///
    /// It was in Library/Caches, which iOS may empty when storage runs low.
    /// That state holds the entry guards Tor keeps for months on purpose:
    /// losing them makes Tor choose again, and every new choice is another
    /// chance of picking a hostile guard — plus a 17-second cold start.
    ///
    /// Application Support survives. Out of backups, because a restored
    /// backup would carry another device's guards; 0700, because Tor refuses
    /// a directory others can read. A copy already in Caches is moved, not
    /// thrown away, so an update keeps the guards it has.
    private static func dataDirectory() -> URL {
        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = support.appendingPathComponent("tor", isDirectory: true)
        let old = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("t")
        try? fm.createDirectory(at: support, withIntermediateDirectories: true)
        if !fm.fileExists(atPath: dir.path), fm.fileExists(atPath: old.path) {
            do {
                try fm.moveItem(at: old, to: dir)
                print("[foxy] tor: state moved out of Caches")
            } catch {
                print("[foxy] tor: could not move state out of Caches:", error)
            }
        }
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true,
                                attributes: [.posixPermissions: 0o700])
        try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
        var url = dir
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return dir
    }

    /// Authenticate to the control socket and start listening. The cookie
    /// appears once the control port is up; waiting beats guessing.
    ///
    /// Authentication has a deadline, as every other command on the link does.
    /// On a phone (launched with -FoxySeedScreenTest show) Tor
    /// bootstrapped to 100% in three seconds and logged the control connection
    /// opening, and the reply to AUTHENTICATE never reached its callback.
    /// TORController calls back only once it has read a reply, and its read
    /// loop ignores the end of a read, so a lost reply is silence. Silence was
    /// permanent: `authenticating` is cleared only in that callback, and every
    /// way back — connectControl, setUp, RETRY, the deadline — checks it first
    /// and did nothing. Foxy sat on CONNECTING TO TOR, with no percentage and
    /// no log line, until it was killed. Why the reply was lost is not known;
    /// this makes the app recover whatever the cause, and say so.
    private static func connectControl() {
        guard !authenticating, let c = conf, let dir = c.dataDirectory,
              let portFile = c.controlPortFile else { return }
        authenticating = true
        authGen += 1
        let gen = authGen
        let torThread = thread                    // read here, on main; used off it only to describe it
        let socketURL = controlSocketURL          // after a recovery, the socket Tor opened; else the TCP port

        DispatchQueue.global(qos: .utility).async {
            var cookie: Data?
            var address: (String, UInt16)?
            for _ in 0..<60 {
                Thread.sleep(forTimeInterval: 0.5)
                if cookie == nil {
                    cookie = c.cookie
                        ?? (try? Data(contentsOf: dir.appendingPathComponent("control_auth_cookie")))
                }
                if address == nil, socketURL == nil { address = readControlPort(portFile) }
                if cookie != nil && (address != nil || socketURL != nil) { break }
            }
            guard let cookie, address != nil || socketURL != nil else {
                DispatchQueue.main.async {
                    guard gen == authGen else { return }
                    authenticating = false
                    authTries = 0
                    print("[foxy] tor: no control cookie or port after 30s")
                    fail()
                }
                return
            }

            let ctrl: TorController
            let target: String
            if let socketURL {
                ctrl = TorController(socketURL: socketURL)
                target = "socket \(socketURL.lastPathComponent)"
            } else if let address {
                ctrl = TorController(socketHost: address.0, port: address.1)
                target = "port \(address.1)"
            } else {
                return                            // the guard above rules this out
            }
            // TORController's initializer connects already ([self connect:nil]) and
            // keeps no error; a second connect() only reports that it is connected.
            // So whether the socket connected is read from isConnected. After a
            // phone slept on cellular every control link went
            // unanswered until Foxy was killed; not connected here means the
            // listener was gone, connected and then unanswered means Tor was not
            // running its loop, and the two need different fixes.
            if !ctrl.isConnected { try? ctrl.connect() }
            var connected = ctrl.isConnected
            #if DEBUG
            var simulated = false
            if socketURL == nil {
                DispatchQueue.main.sync {
                    if stallListenerOnce { stallListenerOnce = false; simulated = true }
                }
                if simulated {
                    print("[foxy] tor: -FoxyTorStall listener — this TCP control link is treated as refused")
                    connected = false
                }
            }
            #endif
            print("[foxy] tor: control link to \(target) \(connected ? "connected" : "NOT connected: the listener refused it") (Tor thread \(threadState(torThread)))")
            if !connected {
                // the listener is gone: have Tor open another (recoverControlListener)
                DispatchQueue.main.async { if gen == authGen { recoverControlListener() } }
                #if DEBUG
                if simulated { return }                // no authentication on a link treated as refused
                #endif
            }
            ctrl.authenticate(with: cookie) { ok, _ in
                DispatchQueue.main.async {
                    // a link already given up on: its late answer must not become the controller
                    guard gen == authGen else { return }
                    #if DEBUG
                    if stallAuthUntilRestart {
                        print("[foxy] tor: -FoxyTorStall auth — this authentication reply is dropped")
                        return
                    }
                    #endif
                    authenticating = false
                    authTries = 0
                    guard ok else {
                        print("[foxy] tor: control authentication refused")
                        fail()
                        return
                    }
                    controller = ctrl
                    noteLife()
                    observe(ctrl)
                    getInfo(ctrl, ["status/enough-dir-info"]) { values in dirInfoChanged(values.first != "0") }
                    /* Where Tor has got to, asked rather than waited for. It
                     * bootstraps from the moment its thread starts and reports
                     * each step once, so a control link that came up late heard
                     * none of them: Tor was most of the way through the relay
                     * list, this side believed nothing had happened, called it
                     * stuck and restarted it (on a first launch on cellular). */
                    getInfo(ctrl, ["status/bootstrap-phase"], timeout: 5) { values in
                        guard controller === ctrl, let line = values.first,
                              let at = line.range(of: "PROGRESS=") else { return }
                        let digits = line[at.upperBound...].prefix { $0.isNumber }
                        guard let p = Int(digits), p > 0 else { return }
                        print("[foxy] tor: already at \(p)% when the control link came up")
                        bootSaid = max(bootSaid, p)
                        bootEventAt = Date()
                        if p > progress, p < 100 { progress = p; changed() }
                    }
                    readSocksPort()
                    // Tor's network is on from launch; a set-up run below switches it off first
                    stallReset()
                    watchForStall()
                    // Orbot answered before the control link was up
                    if orbotPending { orbotPending = false; reapply() }
                    // a set-up that found the old link dead runs now
                    if setUpPending { setUpPending = false; setUp("control link connected again") }
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + authenticationPatience) {
                authenticationTimedOut(gen, ctrl)
            }
        }
    }

    /// No answer to AUTHENTICATE on this link: drop it and connect another, or,
    /// after `authenticationTries` links, say Foxy could not connect. The
    /// CANNOT CONNECT screen's RETRY starts from nothing again (`start`), which
    /// is better than a spinner nobody can leave. A pending set-up is kept and
    /// runs once a link authenticates.
    private static func authenticationTimedOut(_ gen: Int, _ ctrl: TorController) {
        guard gen == authGen, authenticating else { return }   // it answered, or a newer link is trying
        authGen += 1                                           // a reply after this is not used
        authenticating = false
        closeLink(ctrl)                                        // the link only; Tor keeps running
        authTries += 1
        guard authTries < authenticationTries else {
            authTries = 0
            print("[foxy] tor: control authentication did not answer on \(authenticationTries) links")
            fail()
            return
        }
        print("[foxy] tor: control authentication did not answer in \(Int(authenticationPatience))s"
              + " — connecting again (\(authTries + 1) of \(authenticationTries)); Tor thread \(threadState(thread))")
        connectControl()
    }

    /// Close one control link, and leave Tor running.
    ///
    /// Never `TorController.disconnect()`. It sends SIGNAL SHUTDOWN
    /// (TORController.m), which stops Tor itself, and Tor runs once per app, so
    /// nothing short of reopening Foxy brings it back. On a phone
    /// the authentication deadline and RESTART TOR each called it, and each
    /// turned a stuck link into TOR STOPPED; the set-up's reconnect after three
    /// seconds of silence had done the same since it was written. QUIT asks Tor
    /// to close this one connection. A link that answers nothing will not answer
    /// QUIT either, and is left for Tor to drop; its events are ignored once it
    /// is no longer the controller (`observe`). Smoke check 30d fails the build
    /// if `.disconnect()` comes back.
    private static func closeLink(_ ctrl: TorController) {
        // only Tor's own answer to QUIT, "250 closing connection", is claimed
        control(ctrl, "QUIT", [], timeout: 5, claims: { c, l in
            c.count == 1 && c[0] == 250 && (l.first ?? "").lowercased().contains("closing")
        }, done: { _, _ in })
    }

    /// Tor writes "PORT=127.0.0.1:49651". Read here rather than through
    /// TorController(controlPortFile:), which asserts when the file is not
    /// there yet — and it is not, for the first second or two.
    private static func readControlPort(_ file: URL) -> (String, UInt16)? {
        guard let text = try? String(contentsOf: file, encoding: .utf8),
              let value = text.split(separator: "=").last?
                  .trimmingCharacters(in: .whitespacesAndNewlines),
              let colon = value.lastIndex(of: ":"),
              let port = UInt16(value[value.index(after: colon)...]) else { return nil }
        let host = String(value[..<colon])
        return host.isEmpty ? nil : (host, port)
    }

    /// Both directions, for the whole session.
    ///
    /// An observer that answers true for an event stops it reaching observers
    /// added after it (TORController.m). The circuit observer answers true
    /// only for circuit events, and the progress watcher answers false for
    /// everything, so neither hides anything from the other.
    private static func observe(_ ctrl: TorController) {
        // Each event is used only while its link is still the controller: a link
        // closed with QUIT (`closeLink`) can deliver a last event on its way out.
        _ = ctrl.addObserver(forCircuitEstablished: { [weak ctrl] up in
            DispatchQueue.main.async {
                guard let ctrl, controller === ctrl else { return }
                noteLife()
                up ? established() : lost()
            }
        })
        _ = ctrl.addObserver(forStatusEvents: { [weak ctrl] type, severity, action, arguments in
            /* Why Tor is not getting anywhere, in Foxy's own log.
             *
             * Tor writes "Problem bootstrapping. Stuck at 10% (CONNECTRESET…)"
             * to its own stderr, which reaches Console or a USB console and
             * nothing else — so every report from a phone said "stuck at 10%"
             * with no reason attached, and the reason was the whole answer
             * (every connection reset on the first TLS packet,
             * which is what Orbot's tunnel does to Foxy's Tor). Tor sends the
             * same thing here as a WARN with REASON and COUNT, so it costs
             * nothing to keep.
             *
             * Once per distinct reason. It repeats every second while stuck,
             * and a log that is nine tenths the same line is a log nobody
             * reads. */
            if type == "STATUS_CLIENT", action == "BOOTSTRAP", severity == "WARN",
               let reason = arguments?["REASON"] {
                let at = arguments?["PROGRESS"] ?? "?"
                if lastTrouble != reason {
                    lastTrouble = reason
                    print("[foxy] tor: not getting through at \(at)% —", reason,
                          "(\(arguments?["COUNT"] ?? "?") so far)")
                }
                return false
            }
            if type == "STATUS_CLIENT", action == "ENOUGH_DIR_INFO" || action == "NOT_ENOUGH_DIR_INFO" {
                let enough = action == "ENOUGH_DIR_INFO"
                DispatchQueue.main.async {
                    guard let ctrl, controller === ctrl else { return }
                    noteLife()
                    dirInfoChanged(enough)
                }
                return false
            }
            guard type == "STATUS_CLIENT", action == "BOOTSTRAP",
                  let raw = arguments?["PROGRESS"], let p = Int(raw) else { return false }
            #if DEBUG
            /* Tor writes its own notices to stderr, so the bootstrap percentages
             * reach Console.app but never the file DebugLog keeps — and they are
             * the most useful thing in a launch, and the whole of what a "stuck
             * at N%" report is about. Tor already hands them to this observer,
             * so put them through print, which is where the file log picks lines
             * up. Nothing is asked of Tor's configuration, which TorService has
             * been bitten by before (see the SocksPort note in launch()). */
            let tag = arguments?["TAG"] ?? ""
            let summary = arguments?["SUMMARY"] ?? ""
            print("[foxy] tor: bootstrapped \(p)%"
                  + (tag.isEmpty ? "" : " (\(tag))")
                  + (summary.isEmpty ? "" : " - \(summary)"))
            #endif
            DispatchQueue.main.async {
                guard let ctrl, controller === ctrl else { return }
                noteLife()                        // an event, even at the same percentage
                bootEventAt = Date()
                bootSaid = max(bootSaid, p)
                // only up: a set-up counts its own steps, and Tor's bootstrap finished long ago
                guard p > progress else { return }
                progress = p
                // past the consensus and into the relay descriptors: from here
                // on, a launch that never gets through counts against the seed
                if let dir = conf?.dataDirectory { TorSeed.reached(p, in: dir) }
                changed()
            }
            return false
        })
    }

    private static func established() {
        circuitUp = true
        guard !parked else { return }             // off the network in the background: not ready
        /* A set-up that is still waiting for its control link is not connected,
         * whatever the old session says.
         *
         * A return whose control link had died deferred its set-up (setUpPending)
         * and asked Tor for a new control socket. Tor answers that by replaying
         * where it had got to — 100%, done, from before the app was suspended —
         * and this took it for the truth: ready, so the launch screen decided
         * everything was through and went to the home screen. The pending set-up
         * then ran, switched the network off and on, and the launch screen came
         * straight back: "securing your connection, then home, then securing
         * your connection again" (in the log, two gate shows either side of
         * "control link connected again"). */
        guard !setUpPending else {
            if !ready { print("[foxy] tor: circuit up from before the return; the set-up waiting on the control link decides") }
            return
        }
        guard dirInfo else {
            if !ready { print("[foxy] tor: circuit up, waiting for directory info") }
            return
        }
        guard socksPort != 0 else {
            if !ready { print("[foxy] tor: circuit up, reading its SOCKS port") }
            readSocksPort()                       // a read already in flight answers instead
            return
        }
        deadline?.cancel()
        deadline = nil
        if ready { return }
        ready = true
        everUp = true
        directTries = 0                           // connected: the next stall starts from one
        // the shipped directory built a circuit, so it is not taken out next launch
        if let dir = conf?.dataDirectory { TorSeed.proven(in: dir) }
        firstSetup = false
        bootSaid = 0                          // the next set-up's steps are its own
        failed = false
        progress = 100
        /* A bridge reached while a tunnel was up is not remembered.
         *
         * The memory exists so a bad network is not re-learned every launch,
         * and it lasts a day. But a tunnel is not a bad network: Orbot resets
         * Tor's TLS handshakes, direct times out, Foxy escalates to Snowflake,
         * Snowflake gets through — and the phone is then on the slow path for
         * twenty-four hours, including with Orbot switched off. That is what
         * happened on one phone: a direct connect that takes
         * four seconds was taking fourteen, and the mint nine, with no tunnel
         * anywhere in sight. The tunnel broke direct, so the tunnel's verdict
         * on direct is worth nothing. */
        if OrbotLink.vpnActive(), transport != .direct {
            print("[foxy] tor:", transport.rawValue,
                  "got through, but a tunnel is up — not remembering it")
        } else if blackout, transport != .direct {
            /* The phone had no interface at some point since this transport was
             * chosen, so whatever the ladder learned on the way here it learned
             * in the dark. The bridge that happened to be standing there when
             * the radios came back is not the bridge this network needs, and
             * remembering it puts the phone on the slow path for a day. */
            print("[foxy] tor:", transport.rawValue,
                  "got through, but the phone was off the network on the way here — not remembering it")
            TorTransport.remembered = .direct
        } else {
            TorTransport.remembered = transport
        }
        blackout = false
        tried = [transport]
        // continuing unprotected lasts until Tor can carry the traffic
        Route.unprotected = false
        print("[foxy] tor: circuit established")
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "FoxyBridgeTest") {
            let via = transport.rawValue
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                ResumeDiagnostics.check("after circuit via \(via)")
            }
        }
        #endif
        changed()
    }

    /// Silent to the person — the page shows no screen for a drop — but the
    /// route closes at once: requests are refused until a circuit is back.
    private static func lost() {
        circuitUp = false
        guard ready else { return }
        ready = false
        print("[foxy] tor: circuit lost, reconnecting")
        armDeadline()
        changed()
    }

    private static func fail() {
        deadline?.cancel()
        deadline = nil
        guard !ready, !failed else { return }
        failed = true
        print("[foxy] tor: could not connect")
        changed()
    }

    private static func armDeadline(extending: Bool = false) {
        deadline?.cancel()
        if !extending { extensions = 0 }
        armedAt = Date()
        progressAtArm = progress
        let work = DispatchWorkItem { if !ready { deadlineExpired() } }
        deadline = work
        /* The first set-up has the relay list to load, and that is not five
         * seconds' work on an old phone: it sat at 30%, loading the consensus,
         * was called stuck, and was restarted out of the very thing it was
         * doing — three times, and then handed to a bridge (on a first
         * install). */
        let wait = (transport == .direct && firstSetup) ? max(20, transport.patience) : transport.patience
        DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: work)
    }

    /// Orbot started, stopped, or let Foxy past. The bypass port changes how
    /// Tor reaches its relays, never where Foxy's requests go: they still go
    /// only to Foxy's Tor, which refuses them while it has no circuit.
    static func orbotChanged(_ state: OrbotLink.State) {
        dispatchPrecondition(condition: .onQueue(.main))
        var port: UInt16?
        if case .bypass(let p, _) = state { port = p }
        guard port != orbotBypass else { return }
        orbotBypass = port
        print(port.map { "[foxy] tor: going past Orbot through its bypass port \($0)" }
              ?? "[foxy] tor: no Orbot bypass; reaching relays directly")
        // off the network for the background: the return applies it with the transport
        guard !parked else { return }
        guard controller != nil else {
            orbotPending = thread != nil          // launch() reads it itself if not yet started
            return
        }
        reapply()
    }

    /// The current transport, applied again: after Orbot's bypass changes.
    private static func reapply() {
        guard let ctrl = controller, let dir = conf?.dataDirectory else { return }
        #if canImport(IPtProxy)
        if transport != .direct { Bridges.stopAll() }   // restarted with the new upstream
        #endif
        guard let settings = transportSettings(transport, dir: dir) else {
            deadlineExpired()
            return
        }
        if !ready { armDeadline() }
        apply(settings, on: ctrl, nudging: transport == .direct)
    }

    /// One SETCONF for the transport and Orbot's bypass together.
    ///
    /// No nudge after a transport switch. Changing UseBridges already makes Tor
    /// start over, and the nudge's DisableNetwork shut down every connection
    /// Tor had just opened — the pluggable transport's among them, mid
    /// handshake. After a fallback to Snowflake that left one bridge without a
    /// descriptor, and Tor reported a circuit that carried nothing for more
    /// than a minute. A running direct Tor that Orbot started or stopped under
    /// is nudged: its open connections went the old way.
    ///
    /// Sent directly rather than through setConfs: that always writes key=value,
    /// and clearing Socks5Proxy needs the bare keyword. It also never reports a
    /// refusal — its observer ignores every reply but OK — so a rejected
    /// setting went unnoticed. This one logs what Tor answered.
    private static func apply(_ settings: [(String, String)], on ctrl: TorController, nudging: Bool = false,
                              then after: (() -> Void)? = nil) {
        var args = (settings.isEmpty ? [("UseBridges", "0")] : settings).map { "\($0.0)=\"\($0.1)\"" }
        if transport == .direct, let port = orbotBypass {
            args.append("Socks5Proxy=\"127.0.0.1:\(port)\"")   // direct Tor, past Orbot
        } else {
            args.append("Socks5Proxy")                           // none; a bridge carries its own
        }
        forgetSocksPort()
        setConf(ctrl, args) { ok, message in
            if !ok { print("[foxy] tor: settings refused: \(message)") }
            if let after { after() } else if nudging { nudge() } else { readSocksPort() }
        }
    }

    /// A bootstrap out of time: the next transport not yet tried, or the
    /// failure the page shows.
    /// Has the phone had no way onto a network since this transport was chosen?
    ///
    /// Set by the path monitor, cleared whenever a transport is armed. It is the
    /// same reasoning the tunnel carve-out already carries: a thing that broke
    /// direct makes direct's failure meaningless, and no interface at all breaks
    /// every transport equally.
    private static var blackout = false

    /// How many times direct has been restarted on this attempt, and the most
    /// it may be. Three goes in all: the first, then two restarts.
    static let directTriesMax = 2
    private static var directTries = 0

    /// The path monitor's word, from Route. Nothing here acts on it directly —
    /// it only decides what the ladder is allowed to conclude.
    static func networkWent(_ have: Bool) {
        if !have { blackout = true }
        if have {
            DispatchQueue.main.async { networkCameBack() }
        } else {
            /* After a moment, as the page waits before it says NO CONNECTION:
             * iOS reports a brief gap while it hands a phone from wifi to
             * cellular, and a working circuit is not torn down for one. */
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                if !Route.hasNetwork { networkWentAway() }
            }
        }
    }

    /// Tor's network is off because the phone has none (`networkWentAway`).
    private static var offForBlackout = false
    /// When the phone's network last came back, for `restart` to see.
    private static var networkBackAt = Date.distantPast

    /* The phone lost its network, so Tor comes off it too.
     *
     * Left on, Tor spends the blackout trying its guards, and every attempt
     * that fails is counted against the guard that could not be reached — it
     * could not be reached because the radio was off. By the time the network
     * is back every guard is marked down ("first three down, down, down; 45
     * down") and Tor waits out its own retry schedule before it will try them:
     * twelve and sixteen seconds to a circuit on an older phone, and once no
     * circuit at all inside the twenty the screen allows, where a launch on
     * the same wifi takes three.
     *
     * It is what `backgrounded` does and for its reason: off the network, Tor
     * has no connection to lose and nothing to hold against a guard. */
    private static func networkWentAway() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard thread != nil, !parked, !offForBlackout, let ctrl = controller else { return }
        offForBlackout = true
        setUpGen += 1                             // a set-up in flight stops here
        setUpPending = false
        stallOff()
        deadline?.cancel()
        deadline = nil
        ready = false
        circuitUp = false
        socksPort = 0
        socksGen += 1                             // the listener closes with the network
        changed()
        setConf(ctrl, ["DisableNetwork=1"], timeout: 4) { ok, message in
            print(ok ? "[foxy] tor: off the network while the phone has none"
                     : "[foxy] tor: could not switch its network off (\(message))")
        }
    }

    /* And back on the moment there is one, without being asked: the set-up a
     * launch runs, on guards that have nothing held against them. */
    private static func networkCameBack() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard offForBlackout else { return }
        offForBlackout = false
        guard thread != nil, !parked, !ready else { return }   // parked: `resumed` sets it up
        networkBackAt = Date()
        directTries = 0
        setUp("the network is back")
    }

    private static func deadlineExpired() {
        guard !ready else { return }
        /* Nothing to escalate to.
         *
         * Every transport fails identically with no interface, so walking the
         * ladder in airplane mode only spends three and a half minutes arriving
         * at a verdict about the network that is really a verdict about the
         * radios. Worse, it leaves the ladder wherever it had got to — and the
         * transport standing there when the radios come back takes the credit
         * for the circuit. That is how an older phone ended up starting every
         * launch on Snowflake: direct, obfs4, direct, snowflake, all in airplane
         * mode, then wifi and a circuit four seconds later that
         * direct would have made instantly.
         *
         * The deadline is re-armed rather than dropped, so a network that comes
         * back is picked up by the transport that was already chosen. */
        if !Route.hasNetwork {
            blackout = true
            /* Off the network rather than waiting on it. A launch in airplane
             * mode came through here every five seconds with Tor still trying
             * its guards, which is the thing `networkWentAway` exists to stop. */
            if controller != nil, !offForBlackout, !parked {
                print("[foxy] tor: no network at all, so \(transport.rawValue) is not what is wrong")
                networkWentAway()
                return
            }
            print("[foxy] tor: no network at all, so \(transport.rawValue) is not what is wrong; waiting")
            armDeadline(extending: true)
            return
        }
        // Tor's thread has exited: no transport and no wait will help. The page
        // hears `stopped`, and tells the person to reopen Foxy.
        if stopped {
            print("[foxy] tor: the Tor thread has exited; only reopening Foxy can start it again")
            changed()
            return
        }
        // A circuit is up and Tor is fetching the last descriptors it needs.
        // That is minutes from done at most; switching transports now would
        // throw it away and start over.
        if circuitUp && !dirInfo {
            print("[foxy] tor: \(transport.rawValue) has a circuit and is fetching directory info, giving it longer")
            armDeadline(extending: true)
            return
        }
        // Still moving: Snowflake and bridges bootstrap slowly on a bad
        // network, and abandoning one that is getting there is worse than
        // waiting. Two extensions at most, then the next transport.
        /* Tor said something a moment ago, so it is not standing still — whatever
         * the number says. A set-up counts its own steps up to 30 before Tor has
         * reported anything, so Tor's 5, 10, 14, 15, 20, 25 and 30 all arrive as
         * "no higher than it was" and the bootstrap they describe was being
         * called stuck while it ran. */
        if Date().timeIntervalSince(bootEventAt) < 3, progress < 100, extensions < 4 {
            extensions += 1
            print("[foxy] tor: \(transport.rawValue) reported a step a moment ago, giving it longer")
            armDeadline(extending: true)
            return
        }
        if progress > progressAtArm, progress < 100, extensions < 2 {
            extensions += 1
            print("[foxy] tor: \(transport.rawValue) still bootstrapping at \(progress)%, giving it longer")
            armDeadline(extending: true)
            return
        }
        // No control link yet: nothing can be switched, and connectControl
        // reports its own failure — no cookie or port after 30 seconds, or no
        // answer to authentication on three links. Wait rather than call a
        // bootstrap failed that has not had its control link.
        guard controller != nil else {
            armDeadline(extending: true)
            return
        }
        /* Direct, three times, before any bridge.
         *
         * A stuck direct connection is usually a guard that will not answer, and
         * the cure is a fresh set of them — which is what a relaunch does, and
         * why a relaunch was the fastest way to get connected.
         * So it is restarted where it used to be abandoned: three goes of five
         * seconds, then the ladder as before.
         *
         * `setUp` is the same restart every return from the background runs, so
         * this adds no new path — only a reason to take it. The count is reset
         * whenever a circuit is established or the transport changes. */
        /* Not out of a download. Past the handshake Tor is fetching the relay
         * list and its descriptors, which on a first set-up over cellular is
         * tens of seconds with long gaps between the steps it reports. It was
         * at 59%, was called stuck after twenty seconds and restarted — and a
         * restarted Tor does not report the steps it has already passed, so
         * the second try said nothing at all and was restarted too. A minute
         * and eighteen seconds to a circuit, on a first launch.
         * A minute's silence is stuck;
         * twenty seconds of it, there, is a download. */
        if transport == .direct, bootSaid >= 15, progress < 100,
           Date().timeIntervalSince(bootEventAt) < 60 {
            /* And not with its connections left as they are. A download that
             * has reported nothing for 25 seconds is nudged — Tor's connections
             * start again and what it already fetched is kept — rather than
             * waited on to the minute: a first launch sat at 69%, loading
             * descriptors, for 77 seconds, and the restart that finally came
             * reached a circuit in four. Once per
             * reported step, so a slow but moving download is not kicked twice. */
            if Date().timeIntervalSince(bootEventAt) >= 25, nudgedEventAt != bootEventAt {
                nudgedEventAt = bootEventAt
                print("[foxy] tor: direct has reported nothing for \(Int(Date().timeIntervalSince(bootEventAt)))s at \(bootSaid)%; starting its connections again")
                nudge()
                armDeadline(extending: true)
                return
            }
            print("[foxy] tor: direct is loading the relay list (\(bootSaid)%), giving it longer")
            armDeadline(extending: true)
            return
        }
        if transport == .direct, directTries < TorService.directTriesMax {
            directTries += 1
            print("[foxy] tor: direct has not moved in \(Int(transport.patience))s; "
                  + "restarting it (try \(directTries + 1) of \(TorService.directTriesMax + 1))")
            setUp("direct did not move")
            return
        }
        guard let next = TorTransport.order.first(where: { !tried.contains($0) }) else {
            fail()
            return
        }
        switchTransport(to: next)
    }

    private static func transportSettings(_ t: TorTransport, dir: URL) -> [(String, String)]? {
        #if canImport(IPtProxy)
        do {
            return try Bridges.torSettings(for: t, stateDir: dir.appendingPathComponent("pt", isDirectory: true),
                                           proxy: orbotBypass.map { "socks5://127.0.0.1:\($0)" })
        } catch {
            print("[foxy] tor: \(t.rawValue) would not start:", error)
            return nil
        }
        #else
        return t == .direct ? [] : nil
        #endif
    }

    private static func switchTransport(to next: TorTransport) {
        tried.insert(next)
        guard let ctrl = controller, let dir = conf?.dataDirectory,
              let settings = transportSettings(next, dir: dir) else {
            deadlineExpired()                     // could not start it: the one after
            return
        }
        print("[foxy] tor: \(transport.rawValue) did not connect after \(Int(Date().timeIntervalSince(armedAt)))s at \(progress)%, trying \(next.rawValue)")
        transport = next
        directTries = 0                           // a new transport starts its own count
        progress = 0
        noteLife()
        armDeadline()
        changed()
        // One SETCONF, so Tor goes through a single configuration change. The
        // version before reset three keys one at a time and then set new ones,
        // and each change made Tor close and reopen its SOCKS listener —
        // refusing whatever was connecting at that moment. For direct,
        // UseBridges=0 is enough: Bridge lines are ignored without it.
        apply(settings, on: ctrl) {
            readSocksPort()
            askForCircuit(setUpGen)               // a circuit on the new transport, at launch or in a set-up
        }
    }

    /// Make a running daemon try again now rather than on its own backoff:
    /// switching its network off and on restarts its attempts to reach a relay.
    private static func nudge() {
        guard let ctrl = controller, !parked else { return }
        let gen = setUpGen
        print("[foxy] tor: retrying")
        forgetSocksPort()                         // switching the network closes the listener
        stallReset()
        setConf(ctrl, ["DisableNetwork=1"]) { _, _ in
            // Foxy went to the background, or a set-up began, while this was on
            // its way: the network stays as that left it. Switching it back on here
            // put a parked Tor back on the network (audit T3).
            guard gen == setUpGen, !parked else { return }
            setConf(ctrl, ["DisableNetwork=0"]) { ok, _ in
                guard gen == setUpGen, !parked else { return }
                if !ok { print("[foxy] tor: could not switch the network back on") }
                stallReset()                      // the stall clock from here, once data arrives again
                readSocksPort()
            }
        }
    }

    /// The stall watch starts over: Tor's network has just come on.
    private static func stallReset() {
        stallOn = true
        stallGen += 1
        stallBytes = nil
        stallSawData = false
        stallSince = Date()
    }

    private static func stallOff() {
        stallOn = false
        stallGen += 1
    }

    private static func watchForStall() {
        guard !stallWatching else { return }
        stallWatching = true
        stallTick()
    }

    /// Once a second, Tor's byte count, while direct Tor is connecting, at launch
    /// or after a return (see `stallAfter`). Tor is asked nothing otherwise.
    private static func stallTick() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { stallTick() }
        guard stallOn, !stallAsking, !ready, !everUp, !parked, transport == .direct, orbotBypass == nil,
              let ctrl = controller else { return }
        let gen = stallGen
        stallAsking = true
        getInfo(ctrl, ["traffic/read"], timeout: 2) { values in
            stallAsking = false
            guard gen == stallGen, !ready, let bytes = values.first.flatMap({ UInt64($0) }) else { return }
            let now = Date()
            guard let before = stallBytes else {
                stallBytes = bytes                // where this watch starts counting
                stallSince = now
                return
            }
            if bytes != before {
                stallBytes = bytes
                stallSince = now
                stallSawData = true
                noteLife()                        // bytes from relays: getting somewhere
                return
            }
            guard stallSawData, now.timeIntervalSince(stallSince) >= stallAfter else { return }
            print("[foxy] tor: no data for \(Int(stallAfter))s at \(progress)%, starting its connections again")
            nudge()
        }
    }

    private static func changed() {
        onChange?()
    }

    // MARK: Control commands, each claiming only its own reply

    /// A command on the control link that takes only a reply that can be its own.
    ///
    /// Tor.framework offers each reply to the most recently sent command first,
    /// and its helpers take any reply that looks close enough: setConfForKey
    /// claims any 250, getInfoForKeys drops out on a reply that is not its own.
    /// With several commands in flight — a reconnect asks every half second — a
    /// reply went to the wrong command. After a reconnect through obfs4 the
    /// SOCKS port read then waited for good: two of three simulator trials never
    /// got past it. Here a command recognises its reply by its shape, and has a
    /// deadline, after which it answers empty and lets a late reply pass on.
    /// `done` runs on the main queue.
    private static func control(_ ctrl: TorController, _ command: String, _ args: [String],
                                timeout: TimeInterval = 10,
                                claims: @escaping (_ codes: [Int], _ lines: [String]) -> Bool,
                                done: @escaping (_ codes: [Int], _ lines: [String]) -> Void) {
        let once = ControlOnce()
        ctrl.sendCommand(command, arguments: args, data: nil) { codes, lines, stop in
            let c = codes.map { $0.intValue }
            if c.first == 650 { return false }                  // an event, not a reply
            if once.isDone { stop.pointee = true; return false } // out of time: pass it on
            let l = lines.map { String(data: $0, encoding: .utf8) ?? "" }
            guard claims(c, l), once.claim() else { return false }
            stop.pointee = true
            DispatchQueue.main.async { done(c, l) }
            return true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
            if once.claim() { done([], []) }
        }
    }

    /// SETCONF: a single `250 OK`, or a refusal. `ok` is false on no answer.
    private static func setConf(_ ctrl: TorController, _ args: [String], timeout: TimeInterval = 10,
                                done: @escaping (_ ok: Bool, _ message: String) -> Void) {
        control(ctrl, "SETCONF", args, timeout: timeout, claims: { c, l in
            c.count == 1 && ((c[0] == 250 && l.first == "OK") || c[0] >= 500)
        }, done: { c, l in
            done(c.first == 250, c.isEmpty ? "no answer" : (l.first ?? ""))
        })
    }

    /// GETINFO: the reply whose first line names the first key. Values in key
    /// order, without quotes; an empty array when Tor did not answer.
    private static func getInfo(_ ctrl: TorController, _ keys: [String], timeout: TimeInterval = 10,
                                done: @escaping ([String]) -> Void) {
        control(ctrl, "GETINFO", keys, timeout: timeout, claims: { c, l in
            c.count == keys.count + 1 && (l.first?.hasPrefix(keys[0] + "=") ?? false)
        }, done: { c, l in
            guard c.count == keys.count + 1 else { done([]); return }
            done(keys.indices.map { i in
                let line = l[i]
                guard let eq = line.firstIndex(of: "=") else { return "" }
                return String(line[line.index(after: eq)...])
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\"").union(.whitespacesAndNewlines))
            })
        })
    }

    // MARK: Onion services, for payment requests delivered over Tor

    /// A new onion address that forwards to 127.0.0.1:`localPort`, on this
    /// phone, for as long as a Cashu payment request is on screen.
    ///
    /// NEW:ED25519-V3 with DiscardPK: Tor makes a key, and nothing keeps it, so
    /// every request gets an address never seen before and never seen again. No
    /// payer can tell two of this wallet's requests came from one phone.
    /// Detach: the address outlives the control link that made it, which a
    /// recovery replaces (the listener iOS reclaims); `removeOnion` ends it.
    /// `done` gets the 56-character service id without ".onion", or nil.
    static func addOnion(localPort: UInt16, done: @escaping (String?) -> Void) {
        guard ready, let ctrl = controller, localPort > 0 else { done(nil); return }
        control(ctrl, "ADD_ONION", ["NEW:ED25519-V3", "Flags=DiscardPK,Detach",
                                    "Port=80,127.0.0.1:\(localPort)"], claims: { c, l in
            (c.first == 250 && l.first?.hasPrefix("ServiceID=") == true) || (c.count == 1 && c[0] >= 500)
        }, done: { c, l in
            guard c.first == 250, let line = l.first, line.hasPrefix("ServiceID=") else {
                print("[foxy] tor: no onion address: \(c.isEmpty ? "no answer" : (l.first ?? ""))")
                done(nil)
                return
            }
            let id = String(line.dropFirst("ServiceID=".count))
            done(OnionAddress.isServiceID(id) ? id : nil)
        })
    }

    /// End an address `addOnion` made. Quietly nothing when Tor is gone, which
    /// takes the address with it.
    static func removeOnion(_ serviceID: String) {
        guard OnionAddress.isServiceID(serviceID), let ctrl = controller else { return }
        control(ctrl, "DEL_ONION", [serviceID], claims: { c, l in
            c.count == 1 && ((c[0] == 250 && l.first == "OK") || c[0] >= 500)
        }, done: { _, _ in })
    }

    /// A session that goes through Tor, or nowhere.
    ///
    /// The same shape Zeus uses. With the daemon down, the connection to
    /// 127.0.0.1 is refused and the request fails. Made for one request and
    /// used only through Route.startOnce, which invalidates it once that
    /// request is over.
    ///
    /// `circuit`, when given, is the SOCKS username and password the request
    /// logs in with. Tor keeps streams with different logins on different
    /// circuits (IsolateSOCKSAuth, on by default), so each job at a mint leaves
    /// from its own exit. Without one, requests to the same host share a
    /// circuit for up to ten minutes, as the price sources' do.
    static func socksSession(circuit: String? = nil) -> URLSession {
        // Port 9 when Tor's is not known: nothing listens there, so a request
        // made anyway is refused rather than sent somewhere else.
        let port = socksPort == 0 ? 9 : socksPort
        let cfg = URLSessionConfiguration.default
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        /* A proxy that cannot fail over.
         *
         * The older proxy dictionary belongs to a system Apple describes as
         * designed to make requests work when they would otherwise have failed:
         * nothing promised it would refuse rather than go around Tor. It was
         * the path on iOS 16, and it is gone — Foxy requires iOS 17, where
         * ProxyConfiguration states it: with allowFailover false, a request
         * that cannot reach Tor fails. */
        var proxy = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1",
                                                               port: NWEndpoint.Port(rawValue: port)!))
        proxy.allowFailover = false
        if let circuit { proxy.applyCredential(username: circuit, password: circuit) }
        cfg.proxyConfigurations = [proxy]
        cfg.timeoutIntervalForRequest = 60
        cfg.timeoutIntervalForResource = 60
        cfg.urlCache = nil
        cfg.httpCookieStorage = nil
        cfg.httpShouldSetCookies = false
        cfg.httpAdditionalHeaders = Route.genericHeaders
        // redirects meet the same rules as the first URL (Route.redirectProblem)
        return URLSession(configuration: cfg, delegate: Route.redirectGuard, delegateQueue: nil)
    }
}

/// Answered once: by its reply, or by its deadline. Read on Tor.framework's
/// control queue and the main queue, so locked.
private final class ControlOnce {
    private let lock = NSLock()
    private var over = false
    var isDone: Bool { lock.lock(); defer { lock.unlock() }; return over }
    /// True the first time only.
    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if over { return false }
        over = true
        return true
    }
}
#endif

#if DEBUG && canImport(Tor)
// Probes for Debug/ResumeDiagnostics.swift — DEBUG only. They read the private
// control link, so they live in this file rather than widen its visibility.
extension TorService {
    static var probeHasController: Bool { controller != nil }

    static func probeGetInfo(_ keys: [String], _ done: @escaping ([String]) -> Void) {
        guard let ctrl = controller else { done([]); return }
        getInfo(ctrl, keys, done: done)
    }

    static var probeThreadState: String { threadState(thread) }
    static var probeControlSocket: String? { controlSocketURL?.lastPathComponent }

    static func probeControlPort() -> UInt16? {
        guard let file = conf?.controlPortFile else { return nil }
        return readControlPort(file)?.1
    }
}
#endif
