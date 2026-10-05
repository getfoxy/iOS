import Foundation

/// A version 3 onion address: 56 characters of base32, the last a "d".
///
/// Only the shape is checked. The checksum inside the address is Tor's to
/// check, and a wrong one fails there, before anything leaves the phone.
enum OnionAddress {
    static func isServiceID(_ id: String) -> Bool {
        id.count == 56 && id.hasSuffix("d")
            && id.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("2"..."7").contains($0) }
    }

    /// "<56 characters>.onion", the host of a payment request delivered over Tor.
    static func isHost(_ host: String) -> Bool {
        let h = host.lowercased()
        guard h.hasSuffix(".onion") else { return false }
        return isServiceID(String(h.dropLast(".onion".count)))
    }
}
