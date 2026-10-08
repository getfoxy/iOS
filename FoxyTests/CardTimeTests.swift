import XCTest
import CryptoKit
#if canImport(FoxyCardTime)
@testable import FoxyCardTime
#else
@testable import Foxy
#endif

/// The interim time signer (Foxy/Flashcard/CardTime.swift): the key pair is a
/// pair, a time is four bytes of seconds, and what is signed is what the card
/// verifies. Runs in FoxyTests and in tools/nativetests, where the file is its own
/// module, FoxyCardTime.
final class CardTimeTests: XCTestCase {
    private func bytes(_ hex: String) -> [UInt8] {
        let chars = Array(hex.utf8)
        func nibble(_ c: UInt8) -> UInt8 { c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x61 + 10 }
        return stride(from: 0, to: chars.count - 1, by: 2).map { nibble(chars[$0]) << 4 | nibble(chars[$0 + 1]) }
    }

    private func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    private var publicKey: P256.Signing.PublicKey {
        get throws { try P256.Signing.PublicKey(x963Representation: Data(bytes(InterimCardTime.publicKeyHex))) }
    }

    private func parsed(_ text: String?) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(text).utf8)) as? [String: Any])
    }

    /// The published key is the public half of the private one: a card set up with the first takes the second's times.
    func testThePublicKeyIsThePublicHalfOfThePrivateKey() throws {
        XCTAssertEqual(InterimCardTime.privateKeyHex.count, 64)
        XCTAssertEqual(InterimCardTime.publicKeyHex.count, 130)
        XCTAssertTrue(InterimCardTime.publicKeyHex.hasPrefix("04"), "uncompressed, as the card's time key is")
        for text in [InterimCardTime.privateKeyHex, InterimCardTime.publicKeyHex] {
            XCTAssertEqual(text, text.lowercased())
            XCTAssertTrue(text.allSatisfy { "0123456789abcdef".contains($0) })
        }
        let key = try P256.Signing.PrivateKey(rawRepresentation: Data(bytes(InterimCardTime.privateKeyHex)))
        XCTAssertEqual(hex(key.publicKey.x963Representation), InterimCardTime.publicKeyHex)
        XCTAssertNoThrow(try publicKey, "a point on the curve")
    }

    /// What the card verifies: "FoxyCard/time" and the time, four bytes, big-endian.
    func testWhatIsSignedIsTheTagAndFourBytesBigEndian() {
        let tag = "466f7879436172642f74696d65"   // "FoxyCard/time"
        XCTAssertEqual(Array("FoxyCard/time".utf8), bytes(tag))
        XCTAssertEqual(hex(InterimCardTime.message(time: 0)), tag + "00000000")
        XCTAssertEqual(hex(InterimCardTime.message(time: 1)), tag + "00000001")
        XCTAssertEqual(hex(InterimCardTime.message(time: 0x0102_0304)), tag + "01020304")
        XCTAssertEqual(hex(InterimCardTime.message(time: 1_800_000_000)), tag + "6b49d200")
        XCTAssertEqual(hex(InterimCardTime.message(time: .max)), tag + "ffffffff")
    }

    func testASignatureVerifiesAgainstTheTimeKeyForThatTimeAndNoOther() throws {
        let key = try publicKey
        for time in [0, 1, 86_400, 1_800_000_000, UInt32.max] as [UInt32] {
            let text = try XCTUnwrap(InterimCardTime.signature(time: time))
            XCTAssertEqual(text, text.lowercased())
            XCTAssertTrue(text.hasPrefix("30"), "DER, a sequence")
            let sig = try P256.Signing.ECDSASignature(derRepresentation: Data(bytes(text)))
            // over exactly the tag and the four bytes (CryptoKit hashes once, with SHA-256, as the card does)
            let signed = Data(Array("FoxyCard/time".utf8) + [UInt8(time >> 24), UInt8(truncatingIfNeeded: time >> 16),
                                                              UInt8(truncatingIfNeeded: time >> 8), UInt8(truncatingIfNeeded: time)])
            XCTAssertTrue(key.isValidSignature(sig, for: signed), "\(time)")
            XCTAssertTrue(key.isValidSignature(sig, for: InterimCardTime.message(time: time)))
            // not another time, not another label with the same four bytes, not a bare time
            XCTAssertFalse(key.isValidSignature(sig, for: InterimCardTime.message(time: time &+ 1)))
            XCTAssertFalse(key.isValidSignature(sig, for: Data(Array("FoxyCard/load".utf8) + Array(signed.suffix(4)))))
            XCTAssertFalse(key.isValidSignature(sig, for: Data(signed.suffix(4))))
        }
        // another key does not verify it
        let other = P256.Signing.PrivateKey().publicKey
        let sig = try P256.Signing.ECDSASignature(derRepresentation: Data(bytes(try XCTUnwrap(InterimCardTime.signature(time: 5)))))
        XCTAssertFalse(other.isValidSignature(sig, for: InterimCardTime.message(time: 5)))
    }

    /// A time is whole seconds since 1970 and fits four bytes; a clock outside that is refused, not wrapped.
    func testATimeIsAUInt32OfSecondsAndNothingElse() {
        XCTAssertEqual(InterimCardTime.seconds(Date(timeIntervalSince1970: 0)), 0)
        XCTAssertEqual(InterimCardTime.seconds(Date(timeIntervalSince1970: 1_800_000_000)), 1_800_000_000)
        XCTAssertEqual(InterimCardTime.seconds(Date(timeIntervalSince1970: 1_800_000_000.99)), 1_800_000_000, "the second it is in, not the next")
        XCTAssertEqual(InterimCardTime.seconds(Date(timeIntervalSince1970: 4_294_967_295)), .max)
        XCTAssertEqual(InterimCardTime.seconds(Date(timeIntervalSince1970: 4_294_967_295.5)), .max)
        for refused in [-1, -0.5, 4_294_967_296, 1e12, .infinity, -.infinity, .nan] as [Double] {
            XCTAssertNil(InterimCardTime.seconds(Date(timeIntervalSince1970: refused)), "\(refused)")
        }
        XCTAssertNil(InterimCardTime.seconds(.distantPast))
        XCTAssertNil(InterimCardTime.seconds(.distantFuture))
        // the phone's own clock now is a time: after 2020, long before the year 2106
        let now = InterimCardTime.seconds(Date())
        XCTAssertNotNil(now)
        XCTAssertGreaterThan(now ?? 0, 1_577_836_800)
    }

    /// {"sig": ..., "time": ...} and nothing else, for the clock it was given.
    func testTheReplyIsTheTimeAndItsSignatureAndNothingElse() throws {
        let key = try publicKey
        for seconds in [1_800_000_000.0, 1_800_000_000.75, 0, 4_294_967_295] as [Double] {
            let text = try XCTUnwrap(InterimCardTime.reply(now: Date(timeIntervalSince1970: seconds)))
            let object = try parsed(text)
            XCTAssertEqual(Set(object.keys), ["sig", "time"])
            let time = try XCTUnwrap((object["time"] as? NSNumber)?.uint64Value)
            XCTAssertEqual(time, UInt64(seconds.rounded(.down)))
            XCTAssertLessThanOrEqual(time, UInt64(UInt32.max))
            XCTAssertTrue(text.contains("\"time\":\(time)"), "a number, not a string")
            let sig = try P256.Signing.ECDSASignature(derRepresentation: Data(bytes(try XCTUnwrap(object["sig"] as? String))))
            XCTAssertTrue(key.isValidSignature(sig, for: InterimCardTime.message(time: UInt32(time))))
            XCTAssertFalse(text.contains(InterimCardTime.privateKeyHex), "the private half is never in the answer")
        }
        for refused in [-1.0, 4_294_967_296, .nan] as [Double] {
            XCTAssertNil(InterimCardTime.reply(now: Date(timeIntervalSince1970: refused)), "\(refused)")
        }
        // the clock as it is
        let before = UInt64(Date().timeIntervalSince1970)
        let live = try parsed(InterimCardTime.reply(now: Date()))
        let at = try XCTUnwrap((live["time"] as? NSNumber)?.uint64Value)
        XCTAssertTrue((before...before + 5).contains(at), "\(at) is not now")
    }
}
