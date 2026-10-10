import Foundation
import CryptoKit

/// The time a card is told, and the signature it checks it by. For a card of
/// software 1.14 and before: a card of 1.15 and on has no time key and takes no
/// signed time, its clock being the newest Bitcoin block header it has been shown
/// (build/wallet/08b-block-headers.js), so nothing here is asked of it.
///
/// A Foxy card keeps no clock. Its day (the window its limit is counted in) is
/// measured by the last time it was told, and it takes a time only with a
/// signature by the TIME KEY written to it when it was set up (SET_TIME, 35: the
/// card verifies ECDSA, P-256, SHA-256, over "FoxyCard/time" and the time, four
/// bytes big-endian). The page asks for the time with the bridge's `cardTime`, and
/// sends it to the card. Nothing about it is secret, and a signed time is a public
/// broadcast: it only moves a card's clock forward.
///
/// Who signs is the whole question, and today the answer is this file.
enum InterimCardTime {
    /* INTERIM. READ THIS BEFORE TRUSTING THE DAILY LIMIT.
     *
     * The private half of the time key is built into the app, here, in the clear,
     * so anyone can extract it from any copy of the app and sign any time they
     * like. This is as weak as trusting the receiving phone's own clock, because
     * that is what it is: the phone signs its own clock.
     *
     * What it bounds: an honest receiver cannot be talked into taking more than a
     * day's limit by accident, and the holder's own overspending is held to the
     * day. What it does not bound: a terminal built to cheat. It can sign a time
     * a day later, again and again, in one tap, and take the whole balance within
     * the PIN's reach. With the PIN and the card, the limit stops it no better than
     * having no limit. No screen may say that the limit stops an attacker.
     *
     * A real signer replaces it by PROVISIONING, not by a new applet: the card
     * verifies against the time key in its record, so a card is given another
     * key and nothing in the card changes. The real signer is a service that signs
     * only its own disciplined clock, and holds its private key well, away from the
     * service. No such server exists yet.
     *
     * The public half below is what set-up writes to a card as its time key. A card
     * set up with it takes this signer's time, and only an empty card can be given
     * another.
     */
    static let privateKeyHex = "5d3aa8864437b69bc699905ded587014b3d1f7e0de402684e5eec162d540b2ca"

    /// The public half of `privateKeyHex`: 65 bytes, uncompressed, hex. It is a card's time key.
    static let publicKeyHex = "04403d6dc56a7e17ce887410e510f6214ff8699d5e09bf43dbbbb4159a9856cd0fe0737a186bbc8cbdaa924c49c3e5bc390968348d30c1c5406ba530a040fb17f8"

    /// What the card verifies a time with begins with these bytes.
    static let tag = Array("FoxyCard/time".utf8)

    /// "FoxyCard/time" and the time, four bytes big-endian: the bytes that are signed (the
    /// signer hashes them once, itself).
    static func message(time: UInt32) -> Data {
        Data(tag + [UInt8(truncatingIfNeeded: time >> 24), UInt8(truncatingIfNeeded: time >> 16),
                    UInt8(truncatingIfNeeded: time >> 8), UInt8(truncatingIfNeeded: time)])
    }

    /// A clock reading in the card's terms: whole seconds since 1970, which must
    /// fit in four bytes. Nil for a clock before 1970 or past the year 2106, and for
    /// a reading that is no number.
    static func seconds(_ date: Date) -> UInt32? {
        let whole = date.timeIntervalSince1970.rounded(.down)
        guard whole.isFinite, whole >= 0, whole <= Double(UInt32.max) else { return nil }
        return UInt32(whole)
    }

    private static func bytes(hex: String) -> [UInt8]? {
        let chars = Array(hex.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = [UInt8]()
        for i in stride(from: 0, to: chars.count, by: 2) {
            guard let high = nibble(chars[i]), let low = nibble(chars[i + 1]) else { return nil }
            out.append(high << 4 | low)
        }
        return out
    }

    private static func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x61...0x66: return c - 0x61 + 10
        case 0x41...0x46: return c - 0x41 + 10
        default: return nil
        }
    }

    private static func hex(_ data: Data) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        for b in data {
            out.append(digits[Int(b >> 4)])
            out.append(digits[Int(b & 15)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// The signature over `message(time:)`, DER, as lowercase hex. ECDSA is
    /// randomised, so the same time gives a different signature each time, and
    /// each one verifies.
    static func signature(time: UInt32) -> String? {
        guard let raw = bytes(hex: privateKeyHex),
              let key = try? P256.Signing.PrivateKey(rawRepresentation: raw),
              let signed = try? key.signature(for: message(time: time)) else { return nil }
        return hex(signed.derRepresentation)
    }

    /// cardTime's answer for this clock reading: `{"sig": "<DER hex>", "time": <seconds>}`.
    /// The clock is a parameter so a test can hold it still. Nil when the clock
    /// cannot be told to a card (`seconds`), or the signature could not be made.
    static func reply(now: Date) -> String? {
        guard let time = seconds(now), let sig = signature(time: time) else { return nil }
        return "{\"sig\":\"\(sig)\",\"time\":\(time)}"
    }
}
