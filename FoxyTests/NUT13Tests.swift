import XCTest
import CryptoKit
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

    // MARK: A card's owner key (CardOwner)

    private let abandonAbout = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    private let secp256k1G = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"

    private func bytes(_ hex: String) -> [UInt8] { (try? NUT13.bytes(hex: hex)) ?? [] }

    /// The seed of one of the fixture's cases: the words where there are any (which
    /// also holds our BIP-39 to Node's), and the bytes where there are not.
    private func seed(of c: [String: Any]) throws -> NUT13.Seed {
        let want = try XCTUnwrap(c["seed"] as? String)
        guard let words = c["mnemonic"] as? String else { return NUT13.Seed(bytes: bytes(want)) }
        let seed = try NUT13.seed(mnemonic: words)
        XCTAssertEqual(seedHex(seed), want, "the BIP-39 seed of \(words.prefix(20))")
        return seed
    }

    private func ownerCases() throws -> [[String: Any]] {
        try XCTUnwrap(fixture("card-owner-vectors.json")["cases"] as? [[String: Any]])
    }

    /// The scalar and the public key, which Node worked out from its own HMAC, BigInt
    /// and P-256 (tests/fixtures/card-owner-vectors.json, written by tools/gen-card-owner-vectors.js).
    func testTheOwnerKeyIsWhatNodeWorksOutForThreeSeedsAndCards() throws {
        let cases = try ownerCases()
        XCTAssertEqual(cases.count, 3)
        XCTAssertEqual(cases.filter { $0["mnemonic"] is String }.count, 2, "one seed is no phrase, only bytes")
        for c in cases {
            let seed = try self.seed(of: c)
            let card = bytes(try XCTUnwrap(c["cardKey"] as? String))
            XCTAssertTrue(CardOwner.isCardKey(card))
            var d = try XCTUnwrap(CardOwner.scalar(seed: seed, cardKey: card))
            defer { NUT13.wipe(&d) }
            XCTAssertEqual(NUT13.hex(d), c["scalar"] as? String)
            let pub = try CardOwner.publicKey(seed: seed, cardKey: card)
            XCTAssertEqual(pub.count, 65)
            XCTAssertEqual(pub.first, 0x04)
            XCTAssertEqual(NUT13.hex(pub), c["pub"] as? String)
            // CryptoKit's own public key for that scalar is the same point
            let viaCryptoKit = try P256.Signing.PrivateKey(rawRepresentation: d).publicKey.x963Representation
            XCTAssertEqual(NUT13.hex(Array(viaCryptoKit)), c["pub"] as? String)
        }
        // the first, as the HMAC alone gives it, apart from the derivation: abandon ... about, and the generator
        let first = try seed(of: cases[0])
        XCTAssertEqual(seedHex(first).prefix(16), "5eb00bbddcf06908")
        XCTAssertEqual(cases[0]["cardKey"] as? String, secp256k1G)
        XCTAssertEqual(cases[0]["scalar"] as? String, "7857475d975c2a11f98b0e05512092a107ce8c9ee3d48ec3518e7407a30fa6b9")
    }

    func testTheOwnerKeyFollowsTheSeedAndTheCardsKeyAndNothingElse() throws {
        let seed = try NUT13.seed(mnemonic: abandonAbout)
        let other = try NUT13.seed(mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow")
        func d(_ seed: NUT13.Seed, _ key: String) -> String {
            NUT13.hex(CardOwner.scalar(seed: seed, cardKey: bytes(key)) ?? [])
        }
        let first = d(seed, secp256k1G)
        XCTAssertEqual(first.count, 64)
        XCTAssertEqual(d(seed, secp256k1G), first, "the same seed and card, the same key: it is derived again on a new phone")
        XCTAssertNotEqual(d(other, secp256k1G), first, "another seed")
        XCTAssertNotEqual(d(seed, "02" + String(repeating: "11", count: 32)), first, "another card")
        // one bit of the key: the first byte, the last byte
        XCTAssertNotEqual(d(seed, "03" + String(secp256k1G.dropFirst(2))), first)
        XCTAssertNotEqual(d(seed, String(secp256k1G.dropLast(2)) + "99"), first)
        // and it is not a keyset's secret
        let keyset = try NUT13.derive(seed: seed, keysetId: "01" + String(repeating: "ab", count: 32), start: 0, count: 1)
        XCTAssertNotEqual(NUT13.hex(keyset[0].secret), first)
    }

    /// 256-bit values are below 2n, so mod n is one subtraction, whatever the value.
    func testTheReductionIsOneSubtractionOfP256sOrder() throws {
        let fixture = try self.fixture("card-owner-vectors.json")
        XCTAssertEqual(NUT13.hex(CardOwner.order), fixture["n"] as? String)
        let table = try XCTUnwrap(fixture["reductions"] as? [[String: String]])
        XCTAssertGreaterThanOrEqual(table.count, 8)
        for row in table {
            let got = NUT13.reducedOnce(bytes(try XCTUnwrap(row["hash"])), modulo: CardOwner.order)
            XCTAssertEqual(NUT13.hex(got), row["reduced"], "\(row["hash"] ?? "")")
        }
        // the edges, built here: n is 0, n + 1 is 1, n − 1 stays, the largest 256-bit value is 2^256 − 1 − n
        let n = CardOwner.order
        var nMinusOne = n, nPlusOne = n
        nMinusOne[31] -= 1
        nPlusOne[31] += 1
        let zero = [UInt8](repeating: 0, count: 32)
        XCTAssertEqual(NUT13.reducedOnce(n, modulo: n), zero)
        XCTAssertEqual(NUT13.reducedOnce(nPlusOne, modulo: n), Array(zero.dropLast()) + [1])
        XCTAssertEqual(NUT13.reducedOnce(nMinusOne, modulo: n), nMinusOne)
        XCTAssertEqual(NUT13.reducedOnce(zero, modulo: n), zero)
        XCTAssertEqual(NUT13.hex(NUT13.reducedOnce([UInt8](repeating: 0xFF, count: 32), modulo: n)),
                       "00000000ffffffff00000000000000004319055258e8617b0c46353d039cdaae")
        // secp256k1's order is still the one the other callers get
        XCTAssertEqual(NUT13.reducedOnce(NUT13.order), zero)
    }

    /// A value of 0 (or n, which is 0 too) is not a key: the next counter is tried, as many as it takes.
    func testAScalarThatIsZeroTriesTheNextCounter() {
        let zero = [UInt8](repeating: 0, count: 32)
        let one: [UInt8] = Array(zero.dropLast()) + [1]
        let five: [UInt8] = Array(zero.dropLast()) + [5]
        var asked: [UInt8] = []
        XCTAssertEqual(CardOwner.scalar { counter in asked.append(counter); return counter == 0 ? zero : one }, one)
        XCTAssertEqual(asked, [0, 1], "0 is no key, so counter 1")
        asked = []
        XCTAssertEqual(CardOwner.scalar { counter in asked.append(counter); return counter < 3 ? CardOwner.order : five }, five)
        XCTAssertEqual(asked, [0, 1, 2, 3], "n is 0 mod n, as 0 is")
        asked = []
        XCTAssertEqual(CardOwner.scalar { counter in asked.append(counter); return one }, one)
        XCTAssertEqual(asked, [0], "a key at once asks once")
        asked = []
        XCTAssertNil(CardOwner.scalar { counter in asked.append(counter); return zero })
        XCTAssertEqual(asked.count, 256)
        XCTAssertEqual(asked.last, 255)
    }

    /// The message hashed: the tag, a zero byte, the card's key, and from counter 1 on that counter.
    func testTheHashedMessageHasACounterOnlyAfterTheFirstTry() {
        let key = bytes(secp256k1G)
        let head = "466f7879436172642f6f776e6572" + "00" + secp256k1G   // "FoxyCard/owner", 00, the key
        XCTAssertEqual(NUT13.hex(CardOwner.hashInput(cardKey: key, counter: 0)), head)
        XCTAssertEqual(NUT13.hex(CardOwner.hashInput(cardKey: key, counter: 1)), head + "01")
        XCTAssertEqual(NUT13.hex(CardOwner.hashInput(cardKey: key, counter: 255)), head + "ff")
        XCTAssertEqual(CardOwner.tag, Array("FoxyCard/owner".utf8))
    }

    func testOnlyACompressedKeyIsACardKey() {
        let body = [UInt8](repeating: 0x11, count: 32)
        XCTAssertTrue(CardOwner.isCardKey([0x02] + body))
        XCTAssertTrue(CardOwner.isCardKey([0x03] + body))
        for first: UInt8 in [0x00, 0x01, 0x04, 0x05, 0xFF] {
            XCTAssertFalse(CardOwner.isCardKey([first] + body), "starts \(first)")
        }
        XCTAssertFalse(CardOwner.isCardKey([]))
        XCTAssertFalse(CardOwner.isCardKey([0x02] + body.dropLast()), "32 bytes")
        XCTAssertFalse(CardOwner.isCardKey([0x02] + body + [0x11]), "34 bytes")
        XCTAssertFalse(CardOwner.isCardKey([0x04] + body + body), "an uncompressed key, 65 bytes")
    }

    // MARK: What the owner key may sign

    /// The five names, and nothing the card also signs or verifies: LOCK_CARD and the time are not here.
    func testTheLabelsAreFiveAndNoNameStartsAnother() {
        let names = CardOwner.Label.allCases.map { $0.rawValue }
        XCTAssertEqual(Set(names), ["change-pin", "set-limit", "set-owner", "set-card", "load"])
        XCTAssertEqual(names.count, 5)
        for a in names {
            for b in names where a != b {
                XCTAssertFalse(a.hasPrefix(b), "\(a) starts with \(b), so a signature could name either")
            }
            // what is signed never begins as a lock, a time or the card's own proof does
            let signed = CardOwner.message(label: CardOwner.Label(rawValue: a) ?? .load, nonce: bytes(nonceText), value: [])
            for other in ["FoxyCard/lock", "FoxyCard/time", "FoxyCard/auth"] {
                XCTAssertFalse(signed.starts(with: Array(other.utf8)), "\(a) signs as \(other)")
            }
        }
    }

    /// SET_CARD's data: unit (1), refund key (33), time key (65), mint length (1), mint. `carried` is
    /// how many bytes of mint follow, when that is not what the length byte says. `noTimeKey`: the
    /// 65 bytes are zeros, as a card of software 1.15 and on is given (it has no time key);
    /// `spoilTimeKey` then sets one of the 65 to 1.
    private func record(unit: UInt8 = 1, timeKeyFirst: UInt8 = 0x04, noTimeKey: Bool = false, spoilTimeKey: Int? = nil,
                        length: Int, carried: Int? = nil) -> [UInt8] {
        var out: [UInt8] = [unit, 0x02]
        out += [UInt8](repeating: 0x22, count: 32)
        var key: [UInt8] = noTimeKey ? [UInt8](repeating: 0x00, count: 65) : [timeKeyFirst] + [UInt8](repeating: 0x33, count: 64)
        if let at = spoilTimeKey { key[at] = 0x01 }
        out += key
        out.append(UInt8(truncatingIfNeeded: length))
        out += [UInt8](repeating: 0x6D, count: carried ?? length)
        return out
    }

    func testEachLabelTakesTheShapeOfValueItsCommandReads() {
        let digits = { (n: Int) in [UInt8](repeating: 0x35, count: n) }
        // change-pin: 4 to 8 ASCII digits
        for n in 4...8 { XCTAssertTrue(CardOwner.Label.changePin.accepts(digits(n)), "\(n) digits") }
        for bad in [[], digits(3), digits(9), [0x31, 0x32, 0x33, 0x3A], [0x31, 0x32, 0x33, 0x2F], [0x31, 0x32, 0x33, 0x20], [0x31, 0x32, 0x33, 0x00],
                    [0x61, 0x62, 0x63, 0x64], [0x31, 0x32, 0x33, 0xB1]] as [[UInt8]] {
            XCTAssertFalse(CardOwner.Label.changePin.accepts(bad), "\(bad)")
        }
        // set-limit: exactly 4 bytes (the day's limit), or exactly 8 (the day's and the one tap's)
        XCTAssertTrue(CardOwner.Label.setLimit.accepts([0, 0, 0, 0]))
        XCTAssertTrue(CardOwner.Label.setLimit.accepts([0xFF, 0xFF, 0xFF, 0xFF]))
        XCTAssertTrue(CardOwner.Label.setLimit.accepts([0, 0, 0, 0, 0, 0, 0x13, 0x88]))
        for n in [0, 1, 3, 5, 6, 7, 9, 12] { XCTAssertFalse(CardOwner.Label.setLimit.accepts([UInt8](repeating: 1, count: n)), "\(n) bytes") }
        // set-owner: 65 bytes, 04 first
        let key = [0x04] + [UInt8](repeating: 0x55, count: 64)
        XCTAssertTrue(CardOwner.Label.setOwner.accepts(key))
        for first: UInt8 in [0x00, 0x02, 0x03, 0x05, 0xFF] { XCTAssertFalse(CardOwner.Label.setOwner.accepts([first] + key.dropFirst()), "starts \(first)") }
        XCTAssertFalse(CardOwner.Label.setOwner.accepts(Array(key.dropLast())))
        XCTAssertFalse(CardOwner.Label.setOwner.accepts(key + [0x55]))
        XCTAssertFalse(CardOwner.Label.setOwner.accepts([]))
        // set-card: 100 + L bytes for a mint of L, 1 to 80, the time key (index 34 on) starting 04, or all zeros (a card of software 1.15 has none)
        for length in [1, 2, 24, 79, 80] { XCTAssertTrue(CardOwner.Label.setCard.accepts(record(length: length)), "mint of \(length)") }
        for length in [1, 24, 80] { XCTAssertTrue(CardOwner.Label.setCard.accepts(record(noTimeKey: true, length: length)), "no time key, mint of \(length)") }
        for at in [0, 1, 30, 63, 64] { XCTAssertFalse(CardOwner.Label.setCard.accepts(record(noTimeKey: true, spoilTimeKey: at, length: 5)), "zeros but for byte \(at) of the time key") }
        XCTAssertEqual(record(length: 80).count, CardOwner.mostValueBytes)
        XCTAssertFalse(CardOwner.Label.setCard.accepts(record(length: 0)), "no mint")
        XCTAssertFalse(CardOwner.Label.setCard.accepts(record(length: 81)), "a mint past 80 bytes")
        XCTAssertFalse(CardOwner.Label.setCard.accepts(record(length: 255)))
        XCTAssertFalse(CardOwner.Label.setCard.accepts(record(length: 5, carried: 4)), "says 5 and carries 4")
        XCTAssertFalse(CardOwner.Label.setCard.accepts(record(length: 5, carried: 6)), "says 5 and carries 6")
        XCTAssertFalse(CardOwner.Label.setCard.accepts(record(length: 5, carried: 0)))
        XCTAssertFalse(CardOwner.Label.setCard.accepts(record(timeKeyFirst: 0x02, length: 5)), "a time key that is not uncompressed")
        XCTAssertFalse(CardOwner.Label.setCard.accepts(record(timeKeyFirst: 0x00, length: 5)), "a first byte of zero and a key after it")
        XCTAssertFalse(CardOwner.Label.setCard.accepts(Array(record(length: 5).prefix(99))), "shorter than the fixed part")
        XCTAssertFalse(CardOwner.Label.setCard.accepts(Array(record(length: 5).prefix(100))), "the fixed part and a length with no mint")
        XCTAssertFalse(CardOwner.Label.setCard.accepts([]))
        // load: nothing at all
        XCTAssertTrue(CardOwner.Label.load.accepts([]))
        for n in 1...3 { XCTAssertFalse(CardOwner.Label.load.accepts([UInt8](repeating: 0, count: n)), "\(n) bytes") }
    }

    private let nonceText = "000102030405060708090a0b0c0d0e0f"

    private func sign(_ label: Any?, _ value: Any?, key: Any? = nil, nonce: Any? = nil) -> [String: Any] {
        var body: [String: Any] = ["action": "cardOwnerSign", "id": "4"]   // what the bridge hands over, besides what was asked
        body["key"] = key ?? secp256k1G
        body["label"] = label
        body["nonce"] = nonce ?? nonceText
        body["value"] = value
        return body.compactMapValues { $0 is NSNull ? nil : $0 }
    }

    /// {key, label, nonce, value} as the page sends them: whole and exact, or nothing.
    func testASignRequestIsTheFiveLabelsAndTheirValuesAndNothingElse() throws {
        let ok: [(String, String)] = [("change-pin", "31323334"), ("change-pin", "3132333435363738"), ("set-limit", "000186a0"),
                                      ("set-owner", "04" + String(repeating: "ab", count: 64)), ("load", ""),
                                      ("set-card", NUT13.hex(record(length: 24)))]
        for (label, value) in ok {
            let request = try XCTUnwrap(CardOwner.signRequest(sign(label, value)), "\(label) \(value.prefix(8))")
            XCTAssertEqual(request.label.rawValue, label)
            XCTAssertEqual(request.key, bytes(secp256k1G))
            XCTAssertEqual(request.nonce, bytes(nonceText))
            XCTAssertEqual(NUT13.hex(request.value), value)
            XCTAssertTrue(request.isWellFormed)
        }
        // either case, as the key is
        let upper = try XCTUnwrap(CardOwner.signRequest(sign("set-limit", "000186A0", key: secp256k1G.uppercased(), nonce: nonceText.uppercased())))
        XCTAssertEqual(upper.value, [0, 1, 0x86, 0xA0])
        XCTAssertEqual(upper.key, bytes(secp256k1G))
        // a label that is not one of the five, however near: LOCK_CARD and the time in particular
        let labels: [Any] = ["lock", "time", "auth", "FoxyCard/lock", "FoxyCard/time", "FoxyCard/load", "FoxyCard/change-pin", "", " ",
                             "Load", "LOAD", "Change-Pin", "change-pin ", " load", "load\n", "load\0", "change_pin", "changePin", "setLimit",
                             "set-allowance", "set-", "set", "change-pin,load", 5, true, ["load"], ["label": "load"]]
        for label in labels {
            XCTAssertNil(CardOwner.signRequest(sign(label, "")), "label \(label)")
            XCTAssertNil(CardOwner.signRequest(sign(label, "31323334")), "label \(label) with a value")
        }
        XCTAssertNil(CardOwner.signRequest(sign(nil, "")), "no label")
        // a value that is not that label's, or not hex at all
        XCTAssertNil(CardOwner.signRequest(sign("load", "00")), "load takes nothing")
        XCTAssertNil(CardOwner.signRequest(sign("change-pin", "313233")), "three digits")
        XCTAssertNil(CardOwner.signRequest(sign("change-pin", "3132333g")))
        XCTAssertNil(CardOwner.signRequest(sign("change-pin", "313233343")), "odd")
        XCTAssertNil(CardOwner.signRequest(sign("change-pin", "0x31323334")))
        XCTAssertNil(CardOwner.signRequest(sign("change-pin", " 31323334")))
        XCTAssertNil(CardOwner.signRequest(sign("set-limit", "00000000ff")))
        XCTAssertNil(CardOwner.signRequest(sign("set-owner", "02" + String(repeating: "ab", count: 64))))
        XCTAssertNil(CardOwner.signRequest(sign("set-card", NUT13.hex(record(length: 81)))), "181 bytes: past the longest record")
        XCTAssertNil(CardOwner.signRequest(sign("set-card", NUT13.hex(record(length: 5, carried: 6)))))
        XCTAssertNil(CardOwner.signRequest(sign("set-card", String(repeating: "00", count: 4_000))), "a long text is refused before it is read")
        for value in [5, true, ["31323334"], ["value": "31323334"]] as [Any] {
            XCTAssertNil(CardOwner.signRequest(sign("change-pin", value)), "value \(value)")
        }
        XCTAssertNil(CardOwner.signRequest(sign("load", nil)), "no value, not even for load")
        XCTAssertNil(CardOwner.signRequest(sign("load", NSNull())))
        // a nonce of 16 bytes as 32 hex characters, and no other
        let shortNonce = String(nonceText.dropLast(2)), oddNonce = String(nonceText.dropLast())
        let badNonces: [String] = ["", "00", shortNonce, oddNonce, nonceText + "00", nonceText + "0", oddNonce + "g",
                                   "0x" + shortNonce, " " + String(nonceText.dropFirst()),
                                   String(repeating: "é", count: 16), String(repeating: "00", count: 32)]
        for bad in badNonces {
            XCTAssertNil(CardOwner.signRequest(sign("load", "", nonce: bad)), "nonce \(bad.prefix(12))")
        }
        for bad in [5, true, [nonceText], NSNull()] as [Any] {
            XCTAssertNil(CardOwner.signRequest(sign("load", "", nonce: bad)), "nonce \(bad)")
        }
        var noNonce = sign("load", "")
        noNonce["nonce"] = nil
        XCTAssertNil(CardOwner.signRequest(noNonce))
        // and a key that is not a card's
        let tail = String(secp256k1G.dropFirst(2))
        let badKeys: [String] = ["", "02", String(secp256k1G.dropLast(2)), secp256k1G + "00", "04" + tail, "00" + tail,
                                 String(secp256k1G.dropLast()) + "g", " " + secp256k1G]
        for bad in badKeys {
            XCTAssertNil(CardOwner.signRequest(sign("load", "", key: bad)), "key \(bad.prefix(12))")
        }
        var noKey = sign("load", "")
        noKey["key"] = nil
        XCTAssertNil(CardOwner.signRequest(noKey))
    }

    func testAKeyRequestIsACardsCompressedKeyAndNothingElse() {
        XCTAssertEqual(CardOwner.key(from: secp256k1G), bytes(secp256k1G))
        XCTAssertEqual(CardOwner.key(from: secp256k1G.uppercased()), bytes(secp256k1G))
        XCTAssertEqual(CardOwner.key(from: "03" + String(repeating: "Ab", count: 32)), [0x03] + [UInt8](repeating: 0xAB, count: 32))
        let tail = String(secp256k1G.dropFirst(2))
        let notHex: [String] = ["", "02", String(secp256k1G.dropLast(2)), secp256k1G + "00", String(secp256k1G.dropLast()) + "g"]
        let notCompressed: [String] = ["04" + tail, "00" + tail, "01" + tail, "05" + tail, "ff" + tail, "0x" + tail, secp256k1G + "\n"]
        let wrongLength: [String] = ["02" + String(repeating: "é", count: 32), String(repeating: "02", count: 64), String(repeating: "0", count: 66)]
        let notStrings: [Any] = [5, NSNull(), true, [secp256k1G], ["key": secp256k1G]]
        let notKeys: [Any] = notHex + notCompressed + wrongLength + notStrings
        for bad in notKeys { XCTAssertNil(CardOwner.key(from: bad), "\(bad)") }
        XCTAssertNil(CardOwner.key(from: nil))
    }

    /// What Node signed, checked here with CryptoKit; and what this signs, checked against Node's public key.
    func testTheSignaturesNodeMadeVerifyAndSoDoOurs() throws {
        var checked = 0
        for c in try ownerCases() {
            let seed = try self.seed(of: c)
            let card = try XCTUnwrap(c["cardKey"] as? String)
            let pub = try P256.Signing.PublicKey(x963Representation: Data(bytes(try XCTUnwrap(c["pub"] as? String))))
            let list = try XCTUnwrap(c["signatures"] as? [[String: String]])
            XCTAssertEqual(list.map { $0["label"] ?? "" }, CardOwner.Label.allCases.map { $0.rawValue }, "every label, in this order")
            for s in list {
                let body = sign(s["label"], s["value"], key: card, nonce: s["nonce"])
                let request = try XCTUnwrap(CardOwner.signRequest(body), "the fixture's \(s["label"] ?? "") passes its own shape checks")
                // the message is the one Node signed
                let message = CardOwner.message(label: request.label, nonce: request.nonce, value: request.value)
                XCTAssertEqual(NUT13.hex(message), s["message"], s["label"] ?? "")
                XCTAssertEqual(Array(("FoxyCard/" + request.label.rawValue).utf8) + request.nonce + request.value, message)
                // Node's signature verifies here ...
                let theirs = try P256.Signing.ECDSASignature(derRepresentation: Data(bytes(try XCTUnwrap(s["sig"]))))
                XCTAssertTrue(pub.isValidSignature(theirs, for: Data(message)), "Node's \(s["label"] ?? "")")
                // ... and ours verifies against the public key Node gave, and against nothing near it
                let der = try CardOwner.signature(for: request, seed: seed)
                let ours = try P256.Signing.ECDSASignature(derRepresentation: Data(der))
                XCTAssertTrue(pub.isValidSignature(ours, for: Data(message)), "ours, for \(s["label"] ?? "")")
                var wrong = message
                wrong[wrong.count - 1] ^= 1
                XCTAssertFalse(pub.isValidSignature(ours, for: Data(wrong)), "a changed message")
                checked += 1
            }
        }
        XCTAssertEqual(checked, 15)
    }
}
