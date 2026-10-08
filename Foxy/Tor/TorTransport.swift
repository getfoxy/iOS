import Foundation

/// How Foxy's Tor reaches the Tor network.
///
/// Direct first. Where that is blocked, the built-in obfs4 bridges, then
/// Snowflake, tried in that order without asking. The one that last worked is
/// tried first next launch, so a place where direct Tor never works does not
/// sit out a failed direct attempt every time the app opens.
///
/// obfs4 before Snowflake, for privacy: an obfs4 bridge is one party that sees
/// the phone's IP address, like a guard. Snowflake shows it to a broker, the
/// STUN servers and a volunteer proxy, all outside Tor.
///
/// A bridge is remembered for a day, then direct is tried again: one bad
/// network used to leave every later launch, anywhere, on Snowflake.
enum TorTransport: String {
    case direct, snowflake, obfs4

    static let order: [TorTransport] = [.direct, .obfs4, .snowflake]

    /// How long a bootstrap may take before the next transport is tried.
    var patience: TimeInterval {
        #if DEBUG
        if self == .direct, UserDefaults.standard.double(forKey: "FoxyDirectPatience") > 0 {
            return UserDefaults.standard.double(forKey: "FoxyDirectPatience")
        }
        #endif
        switch self {
        /* Five seconds, not forty-five.
         *
         * Direct either moves in the first few seconds or it is stuck on a guard
         * that will not answer, and forty-five seconds of watching a number sit
         * still is the whole of what made reconnecting feel slow. A restart is
         * what a relaunch does, and a relaunch is what was found fastest, so
         * direct gets three goes of five seconds each before a
         * bridge is tried at all — fifteen seconds to a fresh set of guards
         * rather than forty-five to obfs4.
         *
         * Only for a bootstrap that is standing still. `deadlineExpired`
         * extends this whenever the number is moving, so a slow-but-working
         * direct connection is never cut off at five seconds. */
        case .direct: return 5
        case .snowflake: return 90
        case .obfs4: return 60
        }
    }

    private static let key = "foxy.tor.transport"
    private static let sinceKey = "foxy.tor.transport.since"
    /// How long a bridge that worked is used first, before direct is tried again.
    static let bridgeMemory: TimeInterval = 24 * 60 * 60

    /* A bridge learned before this version was learned in the dark.
     *
     * Earlier the transport ladder walked while the phone had no
     * interface at all, so a stretch of airplane mode taught it that direct and
     * obfs4 were broken — and whichever bridge was standing there when the
     * radios came back took the credit for the circuit. A phone came out
     * of an afternoon of offline testing starting every launch on Snowflake,
     * with wifi in the room.
     *
     * The ladder no longer learns that way, but the wrong answer is already on
     * disk with up to a day to run. Cleared once, the first time this version
     * starts: direct is tried, and if this really is a network that needs a
     * bridge, the next escalation learns it again honestly. */
    static func forgetBridgeLearnedInTheDark() {
        let d = UserDefaults.standard
        let done = "foxy.tor.transport.relearn.1"
        guard !d.bool(forKey: done) else { return }
        d.set(true, forKey: done)
        let had = d.string(forKey: key) ?? ""
        guard !had.isEmpty, had != TorTransport.direct.rawValue else { return }
        print("[foxy] tor: forgetting the remembered \(had) once — it may have been learned off the network")
        d.removeObject(forKey: key)
        d.removeObject(forKey: sinceKey)
    }

    static var remembered: TorTransport {
        get {
            let d = UserDefaults.standard
            let t = TorTransport(rawValue: d.string(forKey: key) ?? "") ?? .direct
            guard t != .direct else { return .direct }
            let since = d.double(forKey: sinceKey)
            return since > 0 && Date().timeIntervalSince1970 - since < bridgeMemory ? t : .direct
        }
        set {
            let d = UserDefaults.standard
            let before = TorTransport(rawValue: d.string(forKey: key) ?? "") ?? .direct
            let since = d.double(forKey: sinceKey)
            d.set(newValue.rawValue, forKey: key)
            if newValue == .direct {
                d.removeObject(forKey: sinceKey)
            } else if newValue != before || since == 0 || Date().timeIntervalSince1970 - since >= bridgeMemory {
                // a bridge reached after direct failed again starts a new day
                d.set(Date().timeIntervalSince1970, forKey: sinceKey)
            }
        }
    }
}

/// When RESTART TOR is offered: only when a restart can help.
///
/// It used to follow the page's percentage: offered once that stood still.
/// On weak cellular the percentage stood at 50% while Tor was
/// still downloading, and the button kept coming back. Each tap switched Tor's
/// network off mid-connection, which Tor counts against the relays it was
/// reaching (entry guards marked down for ten minutes: never-connected went
/// from 20 to 42), and one tap threw away a directory completed four seconds
/// before. That run never connected.
///
/// A restart helps when Foxy's link to Tor is wedged, or when nothing at all
/// is happening. It does harm while anything is arriving. So:
///  - no control link: offered after `wedgedAfter` (the authentication hang);
///  - a link, and no sign of life - no bytes from relays, no event from Tor -
///    for `silentAfter`, or `silentAfterUncounted` where Tor cannot count the
///    bytes (a bridge, or past Orbot: both reach relays through 127.0.0.1,
///    which Tor does not count), so only its events are seen;
///  - Snowflake waits `silentAfterSnowflake`. On good signal,
///    it sent no event for 70 seconds while downloading the consensus and
///    connected 11 seconds later; at 60 it was offered RESTART TOR mid-download,
///    where a tap would have started Snowflake over. 120 is the value chosen.
enum TorStuck {
    static let wedgedAfter: TimeInterval = 10
    static let silentAfter: TimeInterval = 30
    static let silentAfterUncounted: TimeInterval = 60
    static let silentAfterSnowflake: TimeInterval = 120

    /// Whether Tor is trying to connect: the only time a restart can help.
    ///
    /// Not while it is off the network on purpose. `parked` is Foxy put away.
    /// `offNetwork` is the phone having no network at all: Tor is taken off it
    /// so that it holds nothing against its guards, and it is silent because it
    /// was told to be. A return to the front clears `parked` and, with no
    /// network, leaves Tor off; that was read as connecting and quiet, and
    /// RESTART TOR was offered thirty seconds into every stretch with the
    /// radios off, where a restart has nothing to connect through.
    static func connecting(running: Bool, ready: Bool, failed: Bool, stopped: Bool,
                           parked: Bool, offNetwork: Bool) -> Bool {
        running && !ready && !failed && !stopped && !parked && !offNetwork
    }

    static func offered(connecting: Bool, hasLink: Bool, quiet: TimeInterval, bytesCounted: Bool,
                        snowflake: Bool = false) -> Bool {
        guard connecting else { return false }
        if !hasLink { return quiet >= wedgedAfter }
        if bytesCounted { return quiet >= silentAfter }
        return quiet >= (snowflake ? silentAfterSnowflake : silentAfterUncounted)
    }
}
