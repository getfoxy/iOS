import Foundation

/// The rules that decide how fast a set-up (TorService.setUp) gets Foxy back
/// onto Tor, as plain functions: what Tor says about its circuits and its relay
/// connections, whether a return leaves a set-up alone, and what direct's
/// patience running out does to a circuit that is being built.
///
/// No Tor here, so tools/nativetests can build it on a Mac (FoxyTorReturn) and
/// TorReturnTests can hold the rules without a phone.
enum TorReturn {

    // MARK: What Tor says about circuits and relay connections

    /// One CIRC or ORCONN event from the control link, as the set-up reads it.
    ///
    /// Never a relay's name, fingerprint or address: the diary says how a
    /// circuit went, not which relays carried it. A guard named in a log that
    /// gets pasted is a way to tell this phone from another.
    struct Event: Equatable {
        enum Kind: Equatable { case circuit, relayLink }
        let kind: Kind
        /// The circuit's id; for a relay connection, Tor's ID= for it (empty when Tor gave none).
        let id: String
        /// LAUNCHED, EXTENDED, BUILT, FAILED, CLOSED; for a relay connection NEW, LAUNCHED, CONNECTED, FAILED, CLOSED.
        let status: String
        /// How many relays the circuit has reached (0 when the event names no path).
        let hops: Int
        /// GENERAL, HS_SERVICE_INTRO, …; empty for a relay connection.
        let purpose: String
        /// Tor's REASON=, when it gave one.
        let reason: String
    }

    /// The line Tor.framework hands over, without its "650 ": "CIRC 12 BUILT $A~a,$B~b,$C~c BUILD_FLAGS=… PURPOSE=GENERAL …"
    /// or "ORCONN $A~a CONNECTED ID=7". Anything else is nil.
    static func parse(_ line: String) -> Event? {
        let words = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard words.count >= 3 else { return nil }
        func value(_ key: String) -> String {
            for w in words.dropFirst(2) where w.hasPrefix(key + "=") {
                return String(w.dropFirst(key.count + 1)).replacingOccurrences(of: "\"", with: "")
            }
            return ""
        }
        switch words[0] {
        case "CIRC":
            var hops = 0
            if words.count >= 4, !words[3].contains("=") {
                hops = words[3].split(separator: ",").count
            }
            return Event(kind: .circuit, id: words[1], status: words[2], hops: hops,
                         purpose: value("PURPOSE"), reason: value("REASON"))
        case "ORCONN":
            return Event(kind: .relayLink, id: value("ID"), status: words[2], hops: 0,
                         purpose: "", reason: value("REASON"))
        default:
            return nil
        }
    }

    /// The event in the diary's words.
    ///
    /// In calm words: circuits that are not built and relay connections that
    /// do not open are Tor's routine, and the field log reads "failed",
    /// "refused" and "error" as trouble (FieldLog.troubles), which would put
    /// every one of them on the ERRORS screen. Nor what a circuit is for: the
    /// diary is kept across a relaunch and says nothing about a payment, and
    /// an onion circuit's purpose would say that one was being made or taken.
    static func words(_ e: Event) -> String {
        let why = e.reason.isEmpty ? "" : " (\(reasonWords(e.reason)))"
        switch e.kind {
        case .circuit:
            let reach = e.hops > 0 ? ", \(e.hops) relay\(e.hops == 1 ? "" : "s")" : ""
            let status = e.status == "FAILED" ? "not built" : e.status.lowercased()
            return "circuit \(e.id) \(status)\(reach)\(why)"
        case .relayLink:
            let status = e.status == "FAILED" ? "not opened" : e.status.lowercased()
            return "relay connection\(e.id.isEmpty ? "" : " " + e.id) \(status)\(why)"
        }
    }

    /// Tor's REASON= for the diary: its own word in lower case, except the
    /// three that hold a word the field log takes for trouble.
    static func reasonWords(_ reason: String) -> String {
        switch reason.uppercased() {
        case "CONNECTFAILED": return "connect did not go through"
        case "CONNECTREFUSED": return "connect turned away"
        case "IOERROR": return "input/output"
        default: return reason.lowercased()
        }
    }

    /// Does this event say the set-up is getting somewhere? A relay connection
    /// that opened, or a circuit that reached another relay. A failure is not
    /// progress: a Tor failing its circuits over and over is stuck, and must
    /// still be shown as stuck.
    static func isProgress(_ e: Event) -> Bool {
        switch e.kind {
        case .circuit: return e.status == "EXTENDED" || e.status == "BUILT"
        case .relayLink: return e.status == "CONNECTED"
        }
    }

    /// A circuit the set-up asked for (EXTENDCIRCUIT 0) failed before it was
    /// built: another is asked for at once, rather than on the next five-second
    /// round. Only while no circuit is up.
    static func askAgain(after e: Event, asked: Set<String>, circuitUp: Bool) -> Bool {
        e.kind == .circuit && e.status == "FAILED" && asked.contains(e.id) && !circuitUp
    }

    /// The relay connections open now, by Tor's id, after this event.
    static func openLinks(_ open: Set<String>, after e: Event) -> Set<String> {
        guard e.kind == .relayLink, !e.id.isEmpty else { return open }
        var next = open
        switch e.status {
        case "CONNECTED": next.insert(e.id)
        case "FAILED", "CLOSED": next.remove(e.id)
        default: break
        }
        return next
    }

    // MARK: A return to the foreground

    /// A Tor that is up, and was brought back on the network less than this
    /// long ago, is left as it is by a return.
    static let upLeftAlone: TimeInterval = 30

    /// Does Foxy coming back find the route up, with nothing to set up?
    ///
    /// Up and not parked, and brought back on the network less than half a
    /// minute ago: counted from when Foxy was put away, or from when Tor was
    /// last brought back on the network, whichever is later. Tor is kept on
    /// the network after Foxy is put away while a payment or the change top-up
    /// is with the mint, and it can be brought back while Foxy is still away;
    /// a set-up on the return then switches its network off in the middle of
    /// that, cuts the request that is out and leaves its sats held. After half
    /// a minute away from both, the connection may be one a suspension broke,
    /// and it is set up again as before.
    ///
    /// Never when Tor's SOCKS listener does not answer (`listenerUp` false): iOS
    /// reclaims every socket of a suspended app, the listeners included, and a
    /// Tor whose flags still say ready behind a dead listener refuses every
    /// request in milliseconds until it is set up again. The listener was
    /// found dead three times on the way back from a suspension, each time
    /// with "nothing to set up" said a moment before, and each time the
    /// person killed Foxy to get connected. Not probed (`nil`) is not dead.
    static func returnFindsRouteUp(ready: Bool, wasParked: Bool, away: TimeInterval,
                                   sinceBroughtBack: TimeInterval?, listenerUp: Bool? = nil) -> Bool {
        guard ready, !wasParked, listenerUp != false else { return false }
        return min(away, sinceBroughtBack ?? away) < upLeftAlone
    }

    /// The time away a return reckons with.
    ///
    /// A Foxy that was put away knows how long ago (`leftKnown`). One that iOS
    /// launched in the background, for a Bluetooth accessory, and that was
    /// never in front has no such time: it was suspended for anything from
    /// seconds to hours, and its first coming to the front read as away for
    /// no time at all, which left a Tor broken by the suspension alone. With no
    /// time known, the return reckons with at least `upLeftAlone`: a set-up
    /// unless Tor was brought back on the network since, or is mid set-up.
    static func awayReckoned(away: TimeInterval, leftKnown: Bool) -> TimeInterval {
        leftKnown ? away : max(away, upLeftAlone)
    }

    /// A set-up younger than this, that is still moving, is not started over by a return.
    static let youngSetUp: TimeInterval = 15
    /// "Still moving": something from Tor (a step, bytes from a relay, a relay
    /// connection, a circuit reaching a relay) within this long.
    static let movingWithin: TimeInterval = 3

    /// Does Foxy coming back leave the set-up that is running alone?
    ///
    /// Never after Tor was parked (it went off the network as Foxy left: the
    /// return is what sets it up), and never after a failure. Otherwise yes,
    /// in two cases:
    ///
    ///   the app's focus was taken and given back without Foxy leaving (Face ID,
    ///   Control Center, a permission alert): `away` under a second, as before;
    ///
    ///   a set-up begun moments ago that is still moving. Foxy put away and
    ///   brought back within seconds, while the connection was still being
    ///   made, started it over, and the new one switched Tor's network off in
    ///   the middle of a handshake with its guard. That cost the handshake, and
    ///   a guard connection cut before it opens counts against the guard.
    ///   A set-up that is not moving, or is old, is set up again as before:
    ///   that is still what cures one left broken by a suspension.
    static func returnLeavesSetUpAlone(wasParked: Bool, away: TimeInterval, failed: Bool, stuck: Bool,
                                       setUpRunning: Bool, setUpAge: TimeInterval?, quiet: TimeInterval) -> Bool {
        guard !wasParked, !failed, setUpRunning else { return false }
        if away < 1 { return true }
        guard !stuck, let age = setUpAge else { return false }
        return age < youngSetUp && quiet < movingWithin
    }

    /// How long the first command of a set-up may go unanswered before its
    /// control link is taken for dead and connected again.
    ///
    /// Tor answers a SETCONF on 127.0.0.1 in milliseconds once its loop runs.
    /// On a return from the background the loop has been running all along,
    /// and the one way the answer does not come is a link iOS took away while
    /// Foxy was suspended: then every second waited is a second of the return,
    /// and connecting again costs a fraction of one. Elsewhere (RETRY, a
    /// network back, a restart of direct) Tor may be busy loading, and the
    /// three seconds stay.
    static func linkAnswerWait(onReturn: Bool) -> TimeInterval { onReturn ? 1 : 3 }

    // MARK: Direct's patience, out with no circuit

    enum OnDeadline: Equatable {
        /// set up again from the network off: a fresh guard connection, as before
        case restart
        /// keep the relay connection that is open, ask for another circuit, give it longer
        case anotherCircuit
    }

    /// Direct has had its patience (five seconds) and has no circuit.
    ///
    /// Restarting it switches the network off and on: right when no relay
    /// answers (the guard that will not answer, which is what the restart is
    /// for), and wasteful when Tor holds an open connection to its guard and a
    /// circuit is on its way through a slow relay, since the restart throws the
    /// open connection away with it and the next circuit starts with a new
    /// handshake. So with a relay connection open, another circuit is asked for
    /// over it and the clock given two more rounds; with none, or after those,
    /// the restart as before.
    static func onDirectDeadline(relayLinksOpen: Int, extensions: Int) -> OnDeadline {
        relayLinksOpen > 0 && extensions < 2 ? .anotherCircuit : .restart
    }
}
