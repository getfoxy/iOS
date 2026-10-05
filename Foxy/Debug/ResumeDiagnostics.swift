import UIKit
import Network

#if DEBUG && canImport(Tor)
// MARK: - Resume diagnostics — DEBUG only, throwaway: delete once answered
//
// After a few minutes in the background every request failed with "could not
// connect to the server" until the app was killed. The suspicion: iOS reclaims
// the listening sockets of a suspended app, and Tor's SOCKS and control
// listeners are listening sockets. This records, on every return, what is
// still alive. NSLog rather than print, so it reaches the device log and can be
// read in Console.app with no debugger attached — a debugger can keep the app
// from being suspended at all. Every line starts [resume].


enum ResumeDiagnostics {
    private static var installed = false
    private static var wentAway: Date?

    /// Console.app while it runs, and the file for afterwards, so a run with
    /// nothing attached can still be read back.
    static func log(_ s: String) { DebugLog.both("[resume]", s) }

    static func install() {
        guard !installed else { return }
        installed = true
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            wentAway = Date()
            log("to background — tor \(TorService.state), control \(TorService.probeHasController ? "linked" : "none")")
        }
        nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
            let away = wentAway.map { Int(Date().timeIntervalSince($0)) } ?? -1
            log("back after \(away)s — tor \(TorService.state), ready \(TorService.ready), everUp \(TorService.everUp)")
            check("on return")
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) { check("30s later") }
        }
        log("installed — background Foxy for 5+ minutes, then bring it back")
    }

    /// Listener alive? A TCP connect over loopback: accepted, refused, or silent.
    static func connect(_ port: UInt16, _ done: @escaping (String) -> Void) {
        guard let p = NWEndpoint.Port(rawValue: port) else { done("bad port"); return }
        let conn = NWConnection(host: NWEndpoint.Host("127.0.0.1"), port: p, using: .tcp)
        let queue = DispatchQueue(label: "foxy.resume.connect")
        var finished = false
        func finish(_ result: String) {
            if finished { return }
            finished = true
            conn.cancel()
            DispatchQueue.main.async { done(result) }
        }
        conn.stateUpdateHandler = { state in
            switch state {
            case .ready: finish("accepting")
            case .waiting(let e): finish("REFUSED (\(e))")
            case .failed(let e): finish("FAILED (\(e))")
            default: break
            }
        }
        conn.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 5) { finish("no answer in 5s") }
    }

    /// The existing control connection: does Tor still answer on it?
    static func controlAnswers(_ done: @escaping (String) -> Void) {
        guard TorService.probeHasController else { done("no controller"); return }
        var finished = false
        TorService.probeGetInfo(["status/circuit-established", "status/bootstrap-phase", "net/listeners/socks"]) { values in
            if finished { return }
            finished = true
            done("answered: " + values.joined(separator: " | "))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            if finished { return }
            finished = true
            done("NO ANSWER in 5s — the control connection is dead")
        }
    }

    /// One real request through Tor's SOCKS port, with the exact error.
    static func torRequest(_ done: @escaping (String) -> Void) {
        var req = URLRequest(url: URL(string: "https://check.torproject.org/api/ip")!)
        req.timeoutInterval = 20
        req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let t0 = Date()
        // Tor's session whatever Route would pick: this asks about Tor's port itself
        Route.startOnce(TorService.socksSession(), req) { data, _, error in
            let ms = Int(Date().timeIntervalSince(t0) * 1000)
            DispatchQueue.main.async {
                if let e = error as NSError? {
                    done("FAILED after \(ms)ms: \(e.domain) \(e.code) \(e.localizedDescription)")
                } else {
                    done("OK after \(ms)ms: " + (String(data: data ?? Data(), encoding: .utf8).map { String($0.prefix(80)) } ?? ""))
                }
            }
        }
    }

    /// The control listener, the live control link, and Tor's thread.
    static func checkControl(_ label: String) {
        let cp = TorService.probeControlPort()
        let afterControl: (String) -> Void = { control in
            log("\(label): control listener \(cp.map { "127.0.0.1:\($0)" } ?? "?") — \(control); Tor thread \(TorService.probeThreadState)"
                + (TorService.probeControlSocket.map { "; links go to control socket \($0)" } ?? ""))
            controlAnswers { answer in
                log("\(label): control connection — \(answer)")
            }
        }
        if let cp { connect(cp, afterControl) } else { afterControl(TorService.probeControlSocket != nil ? "none: iOS reclaimed it and a control socket replaced it" : "port file unreadable") }
    }

    static func check(_ label: String) {
        // Read the port once. It was read twice — once to probe, once to print —
        // and Tor can reopen its listener between the two, so the line could
        // name a port the probe never tried.
        let port = TorService.socksPort
        // Going to the background closes Tor's SOCKS listener and sets
        // socksPort to 0 (TorService.swift), and Tor opens a NEW one, on a new
        // port, on the way back. Probing during that window connected to
        // 127.0.0.1:0 and reported "REFUSED", and the request that followed went
        // to the discard port Route falls back to when there is no SOCKS port
        // (TorService: `socksPort == 0 ? 9`) and failed with -1004. Both read as
        // a broken resume in the log. They are the opposite: they are the route
        // refusing to let anything leave the app while Tor is down. Say that,
        // and leave the verdict to the check that runs once the circuit is up.
        guard port != 0 else {
            log("\(label): Tor has no SOCKS listener yet, so nothing can leave the app "
                + "— fail-closed, not a failure. tor \(TorService.state)")
            // The control side is still worth asking, and it is the side that
            // failed: after a phone slept on cellular no control link
            // answered until Foxy was killed. This used to return here, and so
            // skipped exactly the probes that would say whether the control
            // listener was gone or Tor's loop had stopped.
            checkControl(label)
            return
        }
        connect(port) { socks in
            log("\(label): SOCKS listener 127.0.0.1:\(port) — \(socks)")
            let cp = TorService.probeControlPort()
            let afterControl: (String) -> Void = { control in
                log("\(label): control listener \(cp.map { "127.0.0.1:\($0)" } ?? "?") — \(control)")
                controlAnswers { answer in
                    log("\(label): control connection — \(answer)")
                    torRequest { result in
                        log("\(label): request through Tor — \(result) — tor now \(TorService.state)")
                    }
                }
            }
            if let cp { connect(cp, afterControl) } else { afterControl(TorService.probeControlSocket != nil ? "none: iOS reclaimed it and a control socket replaced it" : "port file unreadable") }
        }
    }
}
#endif
