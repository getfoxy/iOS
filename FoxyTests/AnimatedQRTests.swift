import XCTest
@testable import Foxy

/// Animated QR codes (AnimatedQRReader) against frames cashu.me's own library
/// made: tests/fixtures/animated-qr.json, from @gandlaf21/bc-ur 1.1.12 with the
/// dependency versions cashu.me locks (tests/fixtures/animated-qr-generate.js).
final class AnimatedQRTests: XCTestCase {

    private struct Case { let name: String; let token: String; let seqLength: Int; let frames: [String] }

    private static let fixture: [String: Any] = {
        let url = repoRoot().appendingPathComponent("tests/fixtures/animated-qr.json")
        let data = (try? Data(contentsOf: url)) ?? Data()
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }()

    private var cases: [Case] {
        (Self.fixture["cases"] as? [[String: Any]] ?? []).map {
            Case(name: $0["name"] as? String ?? "", token: $0["token"] as? String ?? "",
                 seqLength: $0["seqLength"] as? Int ?? 0, frames: $0["frames"] as? [String] ?? [])
        }
    }

    /// Frames in this order until the reader has the message; nil if it never does.
    private func read(_ frames: [String], _ order: [Int], reader: AnimatedQRReader = AnimatedQRReader()) -> (String, Int)? {
        var used = 0
        for i in order {
            used += 1
            if case .done(let text) = reader.receive(frames[i]) { return (text, used) }
        }
        return nil
    }

    func testTheFixtureIsThere() {
        XCTAssertEqual(cases.count, 6)
        XCTAssertGreaterThan((Self.fixture["chooseFragments"] as? [Any])?.count ?? 0, 280)
    }

    func testMixedFramesHoldTheFragmentsTheEncoderChose() {
        for c in Self.fixture["chooseFragments"] as? [[String: Any]] ?? [] {
            let seqNum = UInt32(truncating: c["seqNum"] as! NSNumber)
            let seqLen = c["seqLen"] as! Int
            let checksum = UInt32(truncating: c["checksum"] as! NSNumber)
            XCTAssertEqual(Fountain.chooseFragments(seqNum: seqNum, seqLength: seqLen, checksum: checksum),
                           c["indexes"] as? [Int], "seqNum \(seqNum), \(seqLen) fragments, checksum \(checksum)")
        }
    }

    func testEveryFrameInOrderGivesTheToken() {
        for c in cases {
            let got = read(c.frames, Array(c.frames.indices))
            XCTAssertEqual(got?.0, c.token, c.name)
            XCTAssertEqual(got?.1, c.seqLength, c.name + ": the plain fragments alone are enough")
        }
    }

    func testJoiningTheLoopAfterItsPlainFramesStillGivesTheToken() {
        for c in cases where c.seqLength > 1 {
            XCTAssertEqual(read(c.frames, Array(c.seqLength..<c.frames.count))?.0, c.token, c.name + ": mixed frames only")
        }
    }

    func testFramesOutOfOrderAndRepeatedGiveTheToken() {
        for c in cases {
            // a fixed shuffle, every frame seen twice
            var order = Array(c.frames.indices) + Array(c.frames.indices)
            var x: UInt64 = 0x9E37_79B9_7F4A_7C15
            for k in stride(from: order.count - 1, to: 0, by: -1) {
                x = x &* 6364136223846793005 &+ 1442695040888963407
                order.swapAt(k, Int(x >> 33) % (k + 1))
            }
            XCTAssertEqual(read(c.frames, order)?.0, c.token, c.name)
        }
    }

    func testAMisreadFrameIsSkippedWithoutLosingTheOthers() {
        guard let c = cases.first(where: { $0.seqLength > 10 }) else { return XCTFail("no long case") }
        let reader = AnimatedQRReader()
        for i in 0..<5 { _ = reader.receive(c.frames[i]) }
        let before = reader.progress
        var bent = Array(c.frames[5])
        let at = bent.count - 3
        bent[at] = bent[at] == "a" ? "e" : "a"
        XCTAssertEqual(reader.receive(String(bent)), .progress(before))
        XCTAssertEqual(read(c.frames, Array(5..<c.frames.count), reader: reader)?.0, c.token)
    }

    func testPlainCodesAndOtherURsAreNotTakenAsTokens() {
        let reader = AnimatedQRReader()
        XCTAssertEqual(reader.receive("cashuBo2Ftd2h0dHBzOi8vbWludC5leGFtcGxl"), .notAnimated)
        XCTAssertEqual(reader.receive("lnbc1pvjluez"), .notAnimated)
        XCTAssertEqual(reader.receive("ur:crypto-psbt/1-3/lpadaxcsencylobemohsgmoyadhdeynteelblrcygldwvarfl"), .rejected)
        XCTAssertEqual(reader.receive("ur:bytes/1-3/zzzz"), .rejected)
        XCTAssertEqual(reader.receive("ur:bytes"), .rejected)
    }

    func testAnotherAnimatedCodeStartsOver() {
        let long = cases.filter { $0.seqLength > 5 }
        guard long.count >= 2 else { return XCTFail("two long cases needed") }
        let reader = AnimatedQRReader()
        for i in 0..<3 { _ = reader.receive(long[0].frames[i]) }
        XCTAssertEqual(read(long[1].frames, Array(long[1].frames.indices), reader: reader)?.0, long[1].token)
    }

    func testForgedFramesOverTheLimitsAreRefused() {
        // a frame claiming 3,000 fragments, and one claiming a 200 kB message
        func frame(seqNum: UInt32, seqLength: Int, messageLength: Int, fragment: [UInt8]) -> String {
            var cbor: [UInt8] = [0x85]
            for v in [UInt64(seqNum), UInt64(seqLength), UInt64(messageLength), 1] {
                cbor += [0x1A, UInt8(v >> 24), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)]
            }
            cbor += [0x58, UInt8(fragment.count)] + fragment
            let sum = CRC32.checksum(cbor)
            let all = cbor + [UInt8(sum >> 24), UInt8((sum >> 16) & 0xFF), UInt8((sum >> 8) & 0xFF), UInt8(sum & 0xFF)]
            let words = Array(Bytewords.words.utf8)
            let minimal = all.map { String(decoding: [words[Int($0) * 4], words[Int($0) * 4 + 3]], as: UTF8.self) }.joined()
            return "ur:bytes/\(seqNum)-\(seqLength)/\(minimal)"
        }
        let fragment = [UInt8](repeating: 7, count: 100)
        // a well-formed one first, so the check is the limit and not the encoding
        XCTAssertEqual(AnimatedQRReader().receive(frame(seqNum: 1, seqLength: 3, messageLength: 250, fragment: fragment)), .progress(1.0 / 3.0))
        XCTAssertEqual(AnimatedQRReader().receive(frame(seqNum: 1, seqLength: 3000, messageLength: 299_950, fragment: fragment)), .rejected)
        XCTAssertEqual(AnimatedQRReader().receive(frame(seqNum: 1, seqLength: 2000, messageLength: 199_950, fragment: fragment)), .rejected)
        // lengths that do not add up
        XCTAssertEqual(AnimatedQRReader().receive(frame(seqNum: 1, seqLength: 3, messageLength: 900, fragment: fragment)), .rejected)
    }

    func testAMessageThatFailsItsChecksumIsDropped() {
        guard let c = cases.first(where: { $0.seqLength == 5 }) else { return XCTFail("no five-fragment case") }
        // the same frames under another checksum cannot assemble: each frame is refused on its own CRC first,
        // so change the message checksum inside every frame consistently
        let reader = AnimatedQRReader()
        var last: AnimatedQRReader.Step = .notAnimated
        for f in c.frames.prefix(5) {
            guard let payload = Bytewords.decodeMinimal(String(f.split(separator: "/")[2])),
                  let part = MiniCBOR.fountainPart(payload) else { return XCTFail("fixture frame did not read") }
            var cbor: [UInt8] = [0x85]
            for v in [UInt64(part.seqNum), UInt64(part.seqLength), UInt64(part.messageLength), UInt64(part.checksum ^ 1)] {
                cbor += [0x1A, UInt8(v >> 24), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)]
            }
            cbor += [0x58, UInt8(part.fragment.count)] + part.fragment
            let sum = CRC32.checksum(cbor)
            let all = cbor + [UInt8(sum >> 24), UInt8((sum >> 16) & 0xFF), UInt8((sum >> 8) & 0xFF), UInt8(sum & 0xFF)]
            let words = Array(Bytewords.words.utf8)
            let minimal = all.map { String(decoding: [words[Int($0) * 4], words[Int($0) * 4 + 3]], as: UTF8.self) }.joined()
            last = reader.receive("ur:bytes/\(part.seqNum)-\(part.seqLength)/\(minimal)")
        }
        XCTAssertEqual(last, .rejected)
        XCTAssertEqual(reader.progress, 0)
    }

    func testTheDivisionMatchesBignumberJS() {
        XCTAssertEqual(Xoshiro.bigNumberFraction(0), 0)
        XCTAssertEqual(Xoshiro.bigNumberFraction(UInt64.max), 1)          // rounds up to 1.00000000000000000000
        XCTAssertEqual(Xoshiro.bigNumberFraction(1 << 63), 0.5)
        XCTAssertEqual(Xoshiro.bigNumberFraction(1), Double("0.00000000000000000005")!)   // 5.42e-20, half up
    }

    func testCRC32() {
        XCTAssertEqual(CRC32.checksum(Array("Hello, world!".utf8)), 0xEBE6_C6E6)
        XCTAssertEqual(CRC32.checksum([]), 0)
    }
}
