import XCTest
import CryptoKit
@testable import Foxy

/// The v2 handshake, without a radio (TAP-TO-PAY.md). What is checked here is
/// the thing the four digits on two screens are supposed to mean.
final class TapCryptoTests: XCTestCase {

    /// One run of the handshake, as the two phones would do it.
    private struct Run {
        let receiver: Curve25519.KeyAgreement.PrivateKey
        let payer: Curve25519.KeyAgreement.PrivateKey
        let keys: TapCrypto.Keys
        let payerKeys: TapCrypto.Keys
    }

    private func handshake(service: UUID = UUID()) throws -> Run {
        let r = Curve25519.KeyAgreement.PrivateKey()
        let p = Curve25519.KeyAgreement.PrivateKey()
        let nr = TapCrypto.randomNonce(), np = TapCrypto.randomNonce()
        let R = r.publicKey.rawRepresentation, P = p.publicKey.rawRepresentation

        // the payer promises P before it has seen R
        let commit = TapCrypto.commitment(publicKey: P, nonce: np)
        XCTAssertEqual(commit, TapCrypto.commitment(publicKey: P, nonce: np), "the promise is the same every time")

        let th = TapCrypto.transcript(service: service, r: R, p: P, nr: nr, np: np)
        let onReceiver = TapCrypto.keys(shared: try r.sharedSecretFromKeyAgreement(with: p.publicKey), transcript: th)
        let onPayer = TapCrypto.keys(shared: try p.sharedSecretFromKeyAgreement(with: r.publicKey), transcript: th)
        return Run(receiver: r, payer: p, keys: onReceiver, payerKeys: onPayer)
    }

    func testBothSidesEndUpWithTheSameKeysAndCode() throws {
        let run = try handshake()
        XCTAssertEqual(run.keys.code, run.payerKeys.code)
        XCTAssertEqual(run.keys.code.count, 4)
        XCTAssertTrue(run.keys.code.allSatisfy(\.isNumber))
        XCTAssertEqual(run.keys.receiverToPayer, run.payerKeys.receiverToPayer)
        XCTAssertEqual(run.keys.payerToReceiver, run.payerKeys.payerToReceiver)
        XCTAssertNotEqual(run.keys.receiverToPayer, run.keys.payerToReceiver,
                          "one key each way: neither side seals with the other's")
    }

    /// The whole point. Somebody relaying between the two phones runs two
    /// handshakes and cannot make the digits agree — they have committed
    /// before they knew what they would have to match.
    func testSomebodyInTheMiddleIsCaughtByTheDigits() throws {
        var agreed = 0
        let tries = 300
        for _ in 0..<tries {
            let service = UUID()
            // the real receiver, the impostor, and the real payer
            let receiver = Curve25519.KeyAgreement.PrivateKey()
            let middleToReceiver = Curve25519.KeyAgreement.PrivateKey()
            let middleToPayer = Curve25519.KeyAgreement.PrivateKey()
            let payer = Curve25519.KeyAgreement.PrivateKey()
            let n1 = TapCrypto.randomNonce(), n2 = TapCrypto.randomNonce()
            let n3 = TapCrypto.randomNonce(), n4 = TapCrypto.randomNonce()

            // receiver's side of the room
            let thA = TapCrypto.transcript(service: service, r: receiver.publicKey.rawRepresentation,
                                           p: middleToReceiver.publicKey.rawRepresentation, nr: n1, np: n2)
            let codeA = TapCrypto.keys(shared: try receiver.sharedSecretFromKeyAgreement(
                with: middleToReceiver.publicKey), transcript: thA).code
            // payer's side of the room
            let thB = TapCrypto.transcript(service: service, r: middleToPayer.publicKey.rawRepresentation,
                                           p: payer.publicKey.rawRepresentation, nr: n3, np: n4)
            let codeB = TapCrypto.keys(shared: try payer.sharedSecretFromKeyAgreement(
                with: middleToPayer.publicKey), transcript: thB).code
            if codeA == codeB { agreed += 1 }
        }
        // one guess in ten thousand, so a handful in three hundred would be
        // astonishing; this catches a code that ignores its inputs
        XCTAssertLessThan(agreed, 4, "\(agreed) of \(tries) relayed handshakes produced matching digits")
    }

    func testThePromiseIsCheckable() {
        let p = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        let np = TapCrypto.randomNonce()
        let commit = TapCrypto.commitment(publicKey: p, nonce: np)
        XCTAssertNotEqual(commit, TapCrypto.commitment(publicKey: p, nonce: TapCrypto.randomNonce()))
        let other = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation
        XCTAssertNotEqual(commit, TapCrypto.commitment(publicKey: other, nonce: np))
    }

    /// The code must not be computable by somebody who only listened: the
    /// transcript is all public, so the secret has to be in there too.
    func testTheCodeNeedsTheSharedSecretNotJustTheTranscript() throws {
        let service = UUID()
        let r = Curve25519.KeyAgreement.PrivateKey(), p = Curve25519.KeyAgreement.PrivateKey()
        let nr = TapCrypto.randomNonce(), np = TapCrypto.randomNonce()
        let th = TapCrypto.transcript(service: service, r: r.publicKey.rawRepresentation,
                                      p: p.publicKey.rawRepresentation, nr: nr, np: np)
        let real = TapCrypto.keys(shared: try r.sharedSecretFromKeyAgreement(with: p.publicKey), transcript: th)
        // a bystander has the transcript but some other secret
        let x = Curve25519.KeyAgreement.PrivateKey()
        let guess = TapCrypto.keys(shared: try x.sharedSecretFromKeyAgreement(with: p.publicKey), transcript: th)
        XCTAssertNotEqual(real.code, guess.code)
    }

    func testASealedMessageOpensWithItsOwnKey() throws {
        let run = try handshake()
        let body = Data("the offer".utf8)
        let sealed = try XCTUnwrap(TapCrypto.seal(body, with: run.keys.receiverToPayer,
                                                  counter: 0, transcript: run.keys.transcript))
        XCTAssertEqual(TapCrypto.open(sealed, with: run.payerKeys.receiverToPayer,
                                      counter: 0, transcript: run.keys.transcript), body)
    }

    func testTheWrongKeyDoesNotOpenIt() throws {
        let run = try handshake()
        let sealed = try XCTUnwrap(TapCrypto.seal(Data("x".utf8), with: run.keys.receiverToPayer,
                                                  counter: 0, transcript: run.keys.transcript))
        XCTAssertNil(TapCrypto.open(sealed, with: run.keys.payerToReceiver,
                                    counter: 0, transcript: run.keys.transcript))
    }

    func testTheWrongCounterDoesNotOpenIt() throws {
        let run = try handshake()
        let sealed = try XCTUnwrap(TapCrypto.seal(Data("x".utf8), with: run.keys.receiverToPayer,
                                                  counter: 0, transcript: run.keys.transcript))
        XCTAssertNil(TapCrypto.open(sealed, with: run.keys.receiverToPayer,
                                    counter: 1, transcript: run.keys.transcript))
    }

    func testAnotherHandshakeDoesNotOpenIt() throws {
        let run = try handshake()
        let sealed = try XCTUnwrap(TapCrypto.seal(Data("x".utf8), with: run.keys.receiverToPayer,
                                                  counter: 0, transcript: run.keys.transcript))
        XCTAssertNil(TapCrypto.open(sealed, with: run.keys.receiverToPayer,
                                    counter: 0, transcript: Data(repeating: 9, count: 32)))
    }

    func testAChangedByteDoesNotOpenIt() throws {
        let run = try handshake()
        var sealed = try XCTUnwrap(TapCrypto.seal(Data("the offer".utf8), with: run.keys.receiverToPayer,
                                                  counter: 0, transcript: run.keys.transcript))
        sealed[3] ^= 0x01
        XCTAssertNil(TapCrypto.open(sealed, with: run.keys.receiverToPayer,
                                    counter: 0, transcript: run.keys.transcript))
    }

    /// What seal hands back must be indexable from zero.
    ///
    /// A SealedBox's ciphertext is a slice starting at 12 and `+` keeps the
    /// left side's indices, so this once returned a Data whose first byte was
    /// at [12]. Every caller that indexed it from zero trapped, and a trap in
    /// a test takes the host down instead of failing.
    func testWhatSealHandsBackStartsAtZero() throws {
        let run = try handshake()
        let sealed = try XCTUnwrap(TapCrypto.seal(Data("x".utf8), with: run.keys.receiverToPayer,
                                                  counter: 0, transcript: run.keys.transcript))
        XCTAssertEqual(sealed.startIndex, 0)
        XCTAssertEqual(sealed.indices.first, 0)
        _ = sealed[0]                      // would trap on an offset slice
    }

    func testTheCharacteristicsFollowTheServiceAndNothingElse() {
        let a = UUID(), b = UUID()
        XCTAssertEqual(TapCrypto.inCharacteristic(for: a), TapCrypto.inCharacteristic(for: a))
        XCTAssertNotEqual(TapCrypto.inCharacteristic(for: a), TapCrypto.outCharacteristic(for: a),
                          "the two directions are different doors")
        XCTAssertNotEqual(TapCrypto.inCharacteristic(for: a), TapCrypto.inCharacteristic(for: b),
                          "a new invoice is a new set of numbers")
        XCTAssertNotEqual(TapCrypto.inCharacteristic(for: a), a)
    }

    func testPaddingHidesTheSizeAndComesBackUnchanged() {
        for n in [0, 1, 300, 1200, 2043] {
            let body = Data(repeating: 7, count: n)
            let padded = TapCrypto.pad(body, to: TapCrypto.offerSize)
            XCTAssertEqual(padded?.count, TapCrypto.offerSize, "every offer is one size")
            XCTAssertEqual(TapCrypto.unpad(padded ?? Data()), body)
        }
        XCTAssertNil(TapCrypto.pad(Data(repeating: 1, count: 2045), to: TapCrypto.offerSize),
                     "an offer that will not fit is refused rather than truncated")
        // payments go to a whole block, so the size says "about this much"
        for (n, want) in [(10, 4096), (4093, 8192), (5000, 8192), (9000, 12288)] {
            let padded = TapCrypto.padPayment(Data(repeating: 3, count: n))
            XCTAssertEqual(padded?.count, want, "\(n) bytes")
            XCTAssertEqual(TapCrypto.unpad(padded ?? Data())?.count, n)
        }
        XCTAssertNil(TapCrypto.padPayment(Data(repeating: 1, count: TapCrypto.mostPayment)))
    }

    func testUnpadRefusesNonsense() {
        XCTAssertNil(TapCrypto.unpad(Data([0, 0, 0])))
        XCTAssertNil(TapCrypto.unpad(Data([0xff, 0xff, 0xff, 0xff, 1, 2, 3])), "a length past the end")
    }
}
