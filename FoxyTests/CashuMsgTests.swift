import XCTest
import CryptoKit
@testable import Foxy

/// Messages between two Cashu IDs (CashuMsg.swift, docs/CASHU-ID.md "Messages"):
/// the pair secret, the direction, each message's key and its seal's key, held to
/// tests/fixtures/cashu-msg-vectors.json, which tests/harness.js's BigInt
/// arithmetic wrote and tests/cashu-msg.js holds the page bundle's noble curve to.
/// And the page's two requests, checked before the seed is read.
///
/// Runs in FoxyTests and in tools/nativetests.
final class CashuMsgTests: XCTestCase {

    private struct Vectors: Decodable {
        struct Side: Decodable { let words, id: String }
        struct Key: Decodable { let i: UInt32; let key, xonly: String }
        let a, b: Side
        let pair: String
        let dirAtoB, dirBtoA: UInt8
        let recvAtoB, recvBtoA, sealAtoB, sealBtoA: [Key]
    }

    private func vectors() throws -> Vectors {
        let url = repoRoot().appendingPathComponent("tests/fixtures/cashu-msg-vectors.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func b(_ hex: String) throws -> [UInt8] { try NUT13.bytes(hex: hex) }

    func testBothSidesWorkOutTheSamePairSecret() throws {
        let v = try vectors()
        let a = try NUT13.seed(mnemonic: v.a.words), bSeed = try NUT13.seed(mnemonic: v.b.words)
        let fromA = try CashuMsg.pair(seed: a, peer: try b(v.b.id))
        let fromB = try CashuMsg.pair(seed: bSeed, peer: try b(v.a.id))
        XCTAssertEqual(NUT13.hex(fromA.secret), v.pair)
        XCTAssertEqual(NUT13.hex(fromB.secret), v.pair)
        // A's out is B's in, and the lower key's out is 0
        XCTAssertEqual(fromA.out, v.dirAtoB)
        XCTAssertEqual(fromA.inward, v.dirBtoA)
        XCTAssertEqual(fromB.out, v.dirBtoA)
        XCTAssertEqual(CashuMsg.direction(from: try b(v.a.id), to: try b(v.b.id)), v.dirAtoB)
        XCTAssertNil(CashuMsg.direction(from: try b(v.a.id), to: try b(v.a.id)))
        // the pair with oneself is refused
        XCTAssertThrowsError(try CashuMsg.pair(seed: a, peer: try b(v.a.id)))
    }

    func testEachMessagesKeyAndItsSeal() throws {
        let v = try vectors()
        let secret = try b(v.pair)
        try NUT13.withContext { ctx in
            for (list, dir, prefix) in [(v.recvAtoB, v.dirAtoB, CashuMsg.recvPrefix), (v.recvBtoA, v.dirBtoA, CashuMsg.recvPrefix),
                                        (v.sealAtoB, v.dirAtoB, CashuMsg.sealPrefix), (v.sealBtoA, v.dirBtoA, CashuMsg.sealPrefix)] {
                for k in list {
                    let key = try CashuMsg.key(prefix, secret: secret, dir: dir, index: k.i, ctx)
                    XCTAssertEqual(NUT13.hex(key), k.key, "index \(k.i)")
                    XCTAssertEqual(NUT13.hex(try NUT13.xOnlyKey(key, ctx)), k.xonly, "index \(k.i)")
                }
            }
        }
    }

    func testWhatASenderAndAListenerDerive() throws {
        let v = try vectors()
        let a = try NUT13.seed(mnemonic: v.a.words), bSeed = try NUT13.seed(mnemonic: v.b.words)
        // A sends its message 1 to B: the key B listens on for A's 1, sealed by the key B checks
        let sent = try CashuMsg.sendKeys(seed: a, peer: try b(v.b.id), index: 1)
        XCTAssertEqual(NUT13.hex(sent.to), v.recvAtoB[1].xonly)
        XCTAssertEqual(NUT13.hex(sent.seal), v.sealAtoB[1].key)
        let heard = try CashuMsg.listenKeys(seed: bSeed, wants: [CashuMsg.Want(peer: try b(v.a.id), inward: [0, 1, 2], outward: [0])])
        XCTAssertEqual(heard.count, 4)
        let one = try XCTUnwrap(heard.first { $0.inward && $0.index == 1 })
        XCTAssertEqual(NUT13.hex(one.secret), v.recvAtoB[1].key)
        XCTAssertEqual(NUT13.hex(one.seal), v.sealAtoB[1].xonly)
        XCTAssertEqual(one.peer, v.a.id)
        // B's own message 0 to A, read back while B has lost its place
        let own = try XCTUnwrap(heard.first { !$0.inward })
        XCTAssertEqual(NUT13.hex(own.secret), v.recvBtoA[0].key)
        XCTAssertEqual(NUT13.hex(own.seal), v.sealBtoA[0].xonly)
    }

    func testTheSessionCacheKeepsAndWipes() throws {
        let v = try vectors()
        let a = try NUT13.seed(mnemonic: v.a.words)
        CashuMsg.cache.clear()
        _ = try CashuMsg.pair(seed: a, peer: try b(v.b.id))
        XCTAssertEqual(CashuMsg.cache.count, 1)
        _ = try CashuMsg.pair(seed: a, peer: try b(v.b.id))
        XCTAssertEqual(CashuMsg.cache.count, 1)
        XCTAssertEqual(NUT13.hex(try CashuMsg.pair(seed: a, peer: try b(v.b.id)).secret), v.pair)
        CashuMsg.cache.clear()
        XCTAssertEqual(CashuMsg.cache.count, 0)
    }

    func testTheRequestsAreCheckedBeforeTheSeedIsRead() throws {
        let v = try vectors()
        let ok = CashuMsg.sendCheck(["peer": v.b.id, "i": 3, "body": "{\"v\":1}"])
        XCTAssertEqual(ok?.index, 3)
        XCTAssertNil(CashuMsg.sendCheck(["peer": v.b.id, "i": -1, "body": "{}"]))
        XCTAssertNil(CashuMsg.sendCheck(["peer": v.b.id, "i": true, "body": "{}"]))
        XCTAssertNil(CashuMsg.sendCheck(["peer": v.b.id, "i": 1.5, "body": "{}"]))
        XCTAssertNil(CashuMsg.sendCheck(["peer": "04" + String(v.b.id.dropFirst(2)), "i": 0, "body": "{}"]))
        XCTAssertNil(CashuMsg.sendCheck(["peer": v.b.id, "i": 0, "body": "not json"]))
        XCTAssertNil(CashuMsg.sendCheck(["peer": v.b.id, "i": 0, "body": "[1]"]))
        XCTAssertNil(CashuMsg.sendCheck(["peer": v.b.id, "i": 0, "body": "{\"a\":\"" + String(repeating: "x", count: 4100) + "\"}"]))

        let wants = CashuMsg.openCheck(["peers": [["peer": v.a.id, "in": [0, 1, 2], "out": []], ["peer": v.b.id, "in": [5]]]])
        XCTAssertEqual(wants?.count, 2)
        XCTAssertEqual(wants?[1].outward, [])
        XCTAssertNil(CashuMsg.openCheck(["peers": []]))
        XCTAssertNil(CashuMsg.openCheck(["peers": [["peer": v.a.id, "in": Array(0..<9)]]]))
        XCTAssertNil(CashuMsg.openCheck(["peers": [["peer": v.a.id, "in": [1, 1]]]]))
        XCTAssertNil(CashuMsg.openCheck(["peers": [["peer": v.a.id, "in": [1]], ["peer": v.a.id, "in": [2]]]]))
        XCTAssertNil(CashuMsg.openCheck(["peers": [["peer": v.a.id, "in": [], "out": []]]]))
        // a contact named with no index is left out, and the others listened on: one such peer no longer refuses them all
        let rest = CashuMsg.openCheck(["peers": [["peer": v.a.id, "in": [], "out": []], ["peer": v.b.id, "in": [7, 8]]]])
        XCTAssertEqual(rest, [CashuMsg.Want(peer: try b(v.b.id), inward: [7, 8], outward: [])])
        XCTAssertNil(CashuMsg.openCheck(["peers": [["peer": v.a.id, "in": []], ["peer": v.a.id, "in": [1]]]]))
        XCTAssertNil(CashuMsg.openCheck(["peers": Array(repeating: ["peer": v.a.id, "in": [1]], count: 61)]))
    }

    /// The keys of one open come back shuffled, so the REQ does not keep a conversation's keys together.
    func testTheKeysListenedOnAreShuffled() throws {
        let v = try vectors()
        let bSeed = try NUT13.seed(mnemonic: v.b.words)
        // the curve's generator: a point nobody else in these vectors is
        let other = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        let wants = [CashuMsg.Want(peer: try b(v.a.id), inward: Array(0..<8), outward: Array(0..<8)),
                     CashuMsg.Want(peer: try b(other), inward: Array(0..<8), outward: [])]
        var grouped = 0
        for _ in 0..<4 {
            var got = try CashuMsg.listenKeys(seed: bSeed, wants: wants)
            defer { for i in got.indices { NUT13.wipe(&got[i].secret) } }
            XCTAssertEqual(got.count, 24)
            XCTAssertEqual(Set(got.map { "\($0.peer)\($0.inward)\($0.index)" }).count, 24)
            // as the wants name them: A's in, A's out, then the other's
            let order = got.map { "\($0.peer == v.a.id ? "a" : "o")\($0.inward ? "i" : "u")\($0.index)" }
            let plain = (0..<8).map { "ai\($0)" } + (0..<8).map { "au\($0)" } + (0..<8).map { "oi\($0)" }
            if order == plain { grouped += 1 }
            // and not two runs of one peer's keys either: each peer's keys are spread across the list
            let firstOther = order.firstIndex { $0.hasPrefix("o") } ?? 0
            let lastA = order.lastIndex { $0.hasPrefix("a") } ?? 0
            if firstOther > lastA { grouped += 1 }
        }
        XCTAssertEqual(grouped, 0)
    }

    func testTheRequestForManyKeysIsSplitIntoFilters() {
        // the REQ's shape is NostrInbox.askMany's, which the app's own tests cover; the split is CashuMsg's figure
        XCTAssertEqual(CashuMsg.keysPerFilter, 100)
        XCTAssertEqual(CashuMsg.window, 8)
        XCTAssertLessThanOrEqual(CashuMsg.mostPeers * CashuMsg.mostPerDirection * 2, 1000)
    }
}
