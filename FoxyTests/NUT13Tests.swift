import XCTest
@testable import Foxy

/// NUT-13 derived natively must be cashu-ts's derivation byte for byte: the
/// spec's vectors, and the bundled cashu-ts's own answers for random mnemonics,
/// both keyset versions and the counters at the edges. Both fixtures are the
/// files tests/nut13-vectors.js checks the page's bundle against. Runs in
/// FoxyTests and in tools/nativetests; the bridge's range checks are in
/// CounterRangeCheckTests.
final class NUT13Tests: XCTestCase {

    private func fixture(_ name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: repoRoot().appendingPathComponent("tests/fixtures").appendingPathComponent(name))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func seedHex(_ seed: NUT13.Seed) -> String {
        seed.key.withUnsafeBytes { NUT13.hex(Array($0)) }
    }

    // MARK: (a) the spec's vectors

    func testTheSpecVectorsForBothKeysetVersions() throws {
        let vectors = try fixture("nut13-vectors.json")
        let seed = try NUT13.seed(mnemonic: try XCTUnwrap(vectors["mnemonic"] as? String))
        let keysets = try XCTUnwrap(vectors["keysets"] as? [String: [String: [String]]])
        XCTAssertEqual(Set(keysets.keys.map { String($0.prefix(2)) }), ["00", "01"])
        var checked = 0
        for (keysetId, want) in keysets {
            let secrets = try XCTUnwrap(want["secrets"]), factors = try XCTUnwrap(want["blindingFactors"])
            XCTAssertEqual(secrets.count, factors.count)
            // as one batch from counter 0 ...
            let batch = try NUT13.derive(seed: seed, keysetId: keysetId, start: 0, count: secrets.count)
            XCTAssertEqual(batch.map { NUT13.hex($0.secret) }, secrets, keysetId)
            XCTAssertEqual(batch.map { NUT13.hex($0.blindingFactor) }, factors, keysetId)
            // ... and one counter at a time, so start is honoured
            for k in secrets.indices {
                let one = try NUT13.derive(seed: seed, keysetId: keysetId, start: UInt64(k), count: 1)
                XCTAssertEqual(NUT13.hex(one[0].secret), secrets[k], "\(keysetId) secret \(k)")
                XCTAssertEqual(NUT13.hex(one[0].blindingFactor), factors[k], "\(keysetId) r \(k)")
                checked += 1
            }
        }
        XCTAssertEqual(checked, 10, "the spec lists five counters for each version")
    }

    // MARK: (b) the bundled cashu-ts's own answers

    func testEveryCrossCheckEntryMatchesTheBundledCashuTS() throws {
        let cross = try fixture("nut13-cross.json")
        let cases = try XCTUnwrap(cross["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 3)
        var entries = 0, versions = Set<String>(), counters = Set<UInt64>()
        for c in cases {
            let mnemonic = try XCTUnwrap(c["mnemonic"] as? String)
            let seed = try NUT13.seed(mnemonic: mnemonic)
            XCTAssertEqual(seedHex(seed), c["seed"] as? String, "BIP-39 seed of a \(mnemonic.split(separator: " ").count)-word mnemonic")
            for keyset in try XCTUnwrap(c["keysets"] as? [[String: Any]]) {
                let keysetId = try XCTUnwrap(keyset["keysetId"] as? String)
                versions.insert(String(keysetId.prefix(2)))
                let list = try XCTUnwrap(keyset["entries"] as? [[String: Any]])
                for entry in list {
                    let counter = try XCTUnwrap(entry["counter"] as? NSNumber).uint64Value
                    counters.insert(counter)
                    let got = try NUT13.derive(seed: seed, keysetId: keysetId, start: counter, count: 1)[0]
                    XCTAssertEqual(NUT13.hex(got.secret), entry["secret"] as? String, "\(keysetId) secret at \(counter)")
                    XCTAssertEqual(NUT13.hex(got.blindingFactor), entry["blindingFactor"] as? String, "\(keysetId) r at \(counter)")
                    entries += 1
                }
                // counters 0 to 50 as the one batch the page would ask for
                let first = list.prefix { ($0["counter"] as? NSNumber)?.uint64Value ?? .max <= 50 }
                let batch = try NUT13.derive(seed: seed, keysetId: keysetId, start: 0, count: first.count)
                XCTAssertEqual(batch.map { NUT13.hex($0.secret) }, first.map { $0["secret"] as? String ?? "" }, keysetId)
                XCTAssertEqual(batch.map { NUT13.hex($0.blindingFactor) }, first.map { $0["blindingFactor"] as? String ?? "" }, keysetId)
            }
        }
        XCTAssertEqual(versions, ["00", "01"])
        XCTAssertTrue(counters.isSuperset(of: [0, 50, 1000, 0x7FFF_FFFF, 1 << 40, (1 << 53) - 1]), "\(counters.sorted().suffix(5))")
        XCTAssertGreaterThanOrEqual(entries, 800)
    }

    // MARK: the pieces

    func testTheSeedFromBytesIsTheSeedFromWords() throws {
        let words = "half depart obvious quality work element tank gorilla view sugar picture humble"
        let fromWords = try NUT13.seed(mnemonic: words)
        let bytes = fromWords.key.withUnsafeBytes { Array($0) }
        XCTAssertEqual(bytes.count, 64)
        let fromBytes = NUT13.Seed(bytes: bytes)
        for keysetId in ["009a1f293253e41e", "015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a"] {
            XCTAssertEqual(try NUT13.derive(seed: fromWords, keysetId: keysetId, start: 3, count: 2),
                           try NUT13.derive(seed: fromBytes, keysetId: keysetId, start: 3, count: 2))
        }
    }

    /// Review H1: why the counters of these ids must be one. Each is a
    /// valid 00 id, and NUT-13 derives every one of them to the same secrets.
    func testKeysetIdsOfOneDerivationIndexDeriveTheSameSecrets() throws {
        let seed = try NUT13.seed(mnemonic: "half depart obvious quality work element tank gorilla view sugar picture humble")
        let ids = ["009a1f293253e41e", "0000000033882270", "009a1f29b253e41d", "009a1f28b253e41f"]
        let want = try NUT13.derive(seed: seed, keysetId: ids[0], start: 7, count: 3)
        for id in ids {
            XCTAssertEqual(NUT13.derivationIndex(id), 864_559_728, id)
            XCTAssertEqual(try NUT13.derive(seed: seed, keysetId: id, start: 7, count: 3), want, id)
        }
        XCTAssertNotEqual(try NUT13.derive(seed: seed, keysetId: "00b4cd27d8861a44", start: 7, count: 3), want)
        XCTAssertEqual(NUT13.derivationIndex("00000000ffffffff"), 1, "2^32 − 1 mod 2^31 − 1")
        XCTAssertNil(NUT13.derivationIndex("015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a"))
    }

    func testOnlyAMnemonicsWordCountsMakeASeed() {
        let twelve = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        XCTAssertNoThrow(try NUT13.seed(mnemonic: twelve))
        for words in ["", "abandon", twelve + " abandon", twelve.replacingOccurrences(of: " about", with: "  about")] {
            XCTAssertThrowsError(try NUT13.seed(mnemonic: words)) { XCTAssertEqual($0 as? NUT13.Failure, .badMnemonic) }
        }
    }

    func testTheBlindingFactorIsReducedModNOnce() {
        let n = NUT13.order
        func plus(_ x: [UInt8], _ k: UInt8) -> [UInt8] {
            var out = x, carry = UInt16(k)
            for i in (0..<32).reversed() {
                let s = UInt16(out[i]) + carry
                out[i] = UInt8(truncatingIfNeeded: s)
                carry = s >> 8
            }
            return out
        }
        let zero = [UInt8](repeating: 0, count: 32)
        var nMinusOne = n
        nMinusOne[31] -= 1
        XCTAssertEqual(NUT13.reducedOnce(n), zero)
        XCTAssertEqual(NUT13.reducedOnce(plus(n, 1)), plus(zero, 1))
        XCTAssertEqual(NUT13.reducedOnce(nMinusOne), nMinusOne)
        XCTAssertEqual(NUT13.reducedOnce(zero), zero)
        let top = [UInt8](repeating: 0xFF, count: 32)
        // 2^256 − 1 − n = 0x14551231950b75fc4402da1732fc9bebe
        XCTAssertEqual(NUT13.hex(NUT13.reducedOnce(top)), "000000000000000000000000000000014551231950b75fc4402da1732fc9bebe")
    }

    func testKeysetIdsAndCounterRangesTheDerivationRefuses() throws {
        let seed = NUT13.Seed(bytes: [UInt8](repeating: 7, count: 64))
        for id in ["", "00", "009a1f293253e41", "009a1f293253e41e0", "019a1f293253e41e", "029a1f293253e41e",
                   "009a1f293253e41g", "I2yN+iRYfkzT", "00" + String(repeating: "a", count: 64)] {
            XCTAssertThrowsError(try NUT13.derive(seed: seed, keysetId: id, start: 0, count: 1), id) {
                XCTAssertEqual($0 as? NUT13.Failure, .badKeysetId, id)
            }
        }
        let v00 = "009a1f293253e41e", v01 = "01" + String(repeating: "ab", count: 32)
        XCTAssertNoThrow(try NUT13.derive(seed: seed, keysetId: v00, start: 0x7FFF_FFFF, count: 1))
        XCTAssertNoThrow(try NUT13.derive(seed: seed, keysetId: v01, start: (1 << 53) - 1, count: 1))
        for (id, start, count) in [(v00, UInt64(0x8000_0000), 1), (v00, 0x7FFF_FFFF, 2), (v01, 1 << 53, 1),
                                   (v01, (1 << 53) - 1, 2), (v01, .max, 2), (v00, 0, 0)] {
            XCTAssertThrowsError(try NUT13.derive(seed: seed, keysetId: id, start: start, count: count), "\(id) \(start) \(count)") {
                XCTAssertEqual($0 as? NUT13.Failure, .badCounter)
            }
        }
    }

    func testTheReplyIsTheAgreedJSON() throws {
        let seed = try NUT13.seed(mnemonic: "half depart obvious quality work element tank gorilla view sugar picture humble")
        let id = "009a1f293253e41e"
        let text = NUT13.reply(keysetId: id, start: 1, pairs: try NUT13.derive(seed: seed, keysetId: id, start: 1, count: 2))
        XCTAssertEqual(text, "{\"keysetId\":\"009a1f293253e41e\",\"start\":1,\"secrets\":["
            + "\"8f2b39e8e594a4056eb1e6dbb4b0c38ef13b1b2c751f64f810ec04ee35b77270\","
            + "\"bc628c79accd2364fd31511216a0fab62afd4a18ff77a20deded7b858c9860c8\"],\"blindingFactors\":["
            + "\"967d5232515e10b81ff226ecf5a9e2e2aff92d66ebc3edf0987eb56357fd6248\","
            + "\"b20f47bb6ae083659f3aa986bfa0435c55c6d93f687d51a01f26862d9b9a4899\"]}")
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(Set(parsed.keys), ["keysetId", "start", "secrets", "blindingFactors"])
    }

    /// I2: the wipe zeroes in place, whatever the array holds.
    func testWipingZeroesAnExtendedKeyInPlace() {
        var key = NUT13.ExtendedKey(key: [UInt8](repeating: 0xAB, count: 32), chain: [UInt8](repeating: 0xCD, count: 32))
        key.wipe()
        XCTAssertEqual(key.key, [UInt8](repeating: 0, count: 32))
        XCTAssertEqual(key.chain, [UInt8](repeating: 0, count: 32))
        var empty: [UInt8] = []
        NUT13.wipe(&empty)
        XCTAssertEqual(empty, [])
    }

    func testAThousandCountersTakeLittleTime() throws {
        let seed = NUT13.Seed(bytes: [UInt8](repeating: 1, count: 64))
        measure {
            XCTAssertEqual((try? NUT13.derive(seed: seed, keysetId: "00b4cd27d8861a44", start: 0, count: 1000))?.count, 1000)
        }
    }
}
