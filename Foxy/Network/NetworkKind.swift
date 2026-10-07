import Foundation

/// What kind of network the phone is on, from what the path monitor says.
///
/// "none" is the answer everything else turns on: with it Tor is taken off the
/// network, the page stops believing a circuit Tor still thinks it has, a
/// choice to work offline is accepted, and the wallet sends nothing
/// (`routeOpen`). So a network that is not one must not be called one.
///
/// A VPN left on with Wi-Fi and cellular both off is exactly that. Its tunnel
/// interface stays up with nothing under it, the path reads as satisfied, and
/// it is none of Wi-Fi, cellular or wired, so it was called "other", which is
/// a network. A phone in that state took a payment by tap, believed it had a
/// route and sent the swap to the mint into the tunnel; the request sat for
/// its minute holding the wallet's lock, and the payment made after it never
/// went, with nothing on either screen (from a phone log; the person holding
/// it said which switches were off).
///
/// By name, because a tunnel has no type of its own: iOS calls every one of
/// them `other`, the same as a phone tethered over Bluetooth, which is a real
/// network and still counts. The prefixes are the ones `OrbotLink.vpnActive`
/// knows a tunnel by.
enum NetworkKind {
    static let tunnelPrefixes = ["utun", "ipsec", "ppp", "tun", "tap"]

    static func isTunnel(_ interface: String) -> Bool {
        tunnelPrefixes.contains { interface.hasPrefix($0) }
    }

    /// wifi, cellular, wired, other or none. `interfaces` are the names of the
    /// interfaces the path may use.
    static func of(satisfied: Bool, wifi: Bool, cellular: Bool, wired: Bool, interfaces: [String]) -> String {
        guard satisfied else { return "none" }
        if wifi { return "wifi" }
        if cellular { return "cellular" }
        if wired { return "wired" }
        // tunnels and nothing else: there is no network under them
        if !interfaces.isEmpty && interfaces.allSatisfy(isTunnel) { return "none" }
        return "other"
    }
}
