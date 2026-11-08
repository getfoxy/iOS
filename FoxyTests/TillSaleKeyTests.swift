import XCTest
import CryptoKit
@testable import Foxy

/// A till sale's key (build/wallet/08d-till.js `tillSaleKey`, docs/MONEY.md §19): a
/// cashier code's key L, one of the seed's lock keys (P2PK.swift), moved by
/// t = SHA-256("foxy-till-lock-v1" ‖ L ‖ n) to K = L + t·G, and spent with l + t.
///
/// The page does this arithmetic itself (the keeper's spend is in the page: the
/// phone hands it l for L's index, `p2pkKey`, and the page adds t and signs), so
/// nothing in the app derives it natively. This holds libsecp256k1 and P2PK.swift's
/// derivation to tests/fixtures/till-key-vectors.json, made by tests/harness.js's
/// BigInt arithmetic, to which tests/till-wallet.js holds the page: three
/// implementations that share no code agree on L, t, K and l + t.
///
/// Runs in FoxyTests and in tools/nativetests.
final class TillSaleKeyTests: XCTestCase {

    private struct Vectors: Decodable {
        struct Case: Decodable {
            let index: UInt64
            let L, l, n, t, K, k: String
        }
        let tag: String
        let words: String
        let cases: [Case]
    }

    private func vectors() throws -> Vectors {
        let url = repoRoot().appendingPathComponent("tests/fixtures/till-key-vectors.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func b(_ hex: String) throws -> [UInt8] { try NUT13.bytes(hex: hex) }

    func testTheSaleKeysAgreeWithTheFixture() throws {
        let v = try vectors()
        XCTAssertEqual(v.tag, "foxy-till-lock-v1")
        XCTAssertGreaterThanOrEqual(v.cases.count, 4)
        let seed = try NUT13.seed(mnemonic: v.words)
        var parities = Set<UInt8>()
        for c in v.cases {
            var pair = try P2PK.key(seed: seed, index: c.index)
            defer { pair.wipe() }
            // L and l are the seed's lock key at that index, as the page's code carries it
            XCTAssertEqual(NUT13.hex(pair.publicKey), c.L, "L at index \(c.index)")
            XCTAssertEqual(NUT13.hex(pair.privateKey), c.l, "l at index \(c.index)")
            parities.insert(pair.publicKey[0])
            // t: the tag, L's 33 bytes and the nonce's 16, once through SHA-256 (never 0 or past n for these)
            let msg = Array(v.tag.utf8) + pair.publicKey + (try b(c.n))
            let t = Array(SHA256.hash(data: msg))
            XCTAssertEqual(NUT13.hex(t), c.t, "t at index \(c.index)")
            try NUT13.withContext { ctx in
                XCTAssertTrue(NUT13.isScalar(t, ctx))
                let K = try NUT13.addTweak(point: pair.publicKey, t, ctx)
                XCTAssertEqual(NUT13.hex(K), c.K, "K = L + t·G at index \(c.index)")
                var k = try NUT13.addScalar(pair.privateKey, t, ctx)
                defer { NUT13.wipe(&k) }
                XCTAssertEqual(NUT13.hex(k), c.k, "l + t at index \(c.index)")
                // and l + t is the private half of K, with K's own parity
                XCTAssertEqual(NUT13.hex(try NUT13.publicKey(k, ctx)), c.K)
            }
        }
        XCTAssertEqual(parities, [2, 3], "the fixture has an L of either parity")
    }

    /// Another nonce is another key: a payment to one sale's K is no other sale's.
    func testAnotherNonceIsAnotherKey() throws {
        let v = try vectors()
        let c = v.cases[0]
        let L = try b(c.L)
        let other = Array(SHA256.hash(data: Array(v.tag.utf8) + L + [UInt8](repeating: 0x11, count: 16)))
        try NUT13.withContext { ctx in
            let K2 = try NUT13.addTweak(point: L, other, ctx)
            XCTAssertNotEqual(NUT13.hex(K2), c.K)
            XCTAssertNotEqual(NUT13.hex(K2), c.L)
        }
    }
}
