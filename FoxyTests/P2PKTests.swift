import XCTest
@testable import Foxy

/// The keys a payment request locks ecash to: NUT-13's path,
/// m/129373'/10'/0'/0'/{index}, and the rules around handing one out.
///
/// Three things here can be wrong without anything looking wrong, and each of
/// them is somebody's money:
///
///   - **a hardened last level.** The wallet would be perfectly consistent with
///     itself. Its ecash would open on this phone and on no other wallet, ever,
///     and nobody would find out until a restore somewhere else came up empty.
///     So the normal child is checked against BIP-32's own published vector, not
///     only against Foxy's other implementation of it.
///   - **the chain code leaving with the key.** A non-hardened child plus its
///     parent's chain code gives the parent, and the parent gives every index
///     there will ever be. The reply carries 32 bytes and 33 bytes and nothing
///     else.
///   - **an index handed out with nothing in front of it.** The window is
///     narrower than "any index you like" and wider than "only what is
///     reserved", because a restore on another phone has reserved nothing.
///
/// The vectors below were produced by a second implementation written from the
/// spec in `tests/harness.js` — node's own HMAC, BigInt arithmetic and
/// `createECDH('secp256k1')`, sharing no code with this one. That file's BIP-32
/// reproduces the standard's test vector 1, which is checked here too, so the
/// chain is: the published standard, then two implementations of NUT-13's path
/// that agree with each other.
///
/// Runs in FoxyTests and in tools/nativetests.
final class P2PKTests: XCTestCase {

    /// The phrase SeedActionsTests saves, and the one tests/harness.js gives a phone.
    private let saved = "legal winner thank year wave sausage worth useful legal winner thank yellow"
    private let phone = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    private func seed(_ words: String) throws -> NUT13.Seed {
        try NUT13.seed(mnemonic: words)
    }

    // MARK: BIP-32 itself

    /// BIP-32's test vector 1, seed `000102030405060708090a0b0c0d0e0f`, down to
    /// **m/0'/1** — a normal child of a hardened parent, which is the exact shape
    /// of this path's last level. Hardened here would give different bytes, and
    /// this is where that shows.
    func testANormalChildMatchesBip32sOwnVector() throws {
        let master = NUT13.Seed(bytes: try NUT13.bytes(hex: "000102030405060708090a0b0c0d0e0f"))
        try NUT13.withContext { ctx in
            var m = try NUT13.master(seed: master, ctx)
            defer { m.wipe() }
            XCTAssertEqual(NUT13.hex(m.key), "e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35")
            XCTAssertEqual(NUT13.hex(m.chain), "873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508")

            var hardened = try NUT13.child(m, 0 | 0x8000_0000, ctx)
            defer { hardened.wipe() }
            XCTAssertEqual(NUT13.hex(hardened.key), "edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea")
            XCTAssertEqual(NUT13.hex(hardened.chain), "47fdacbd0f1097043b78c63c20c34ef4ed9a111d980047ad16282c7ae6236141")

            var normal = try NUT13.child(hardened, 1, ctx)
            defer { normal.wipe() }
            XCTAssertEqual(NUT13.hex(normal.key), "3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368",
                           "m/0'/1 is a NORMAL child: hashed over the parent's public key, not 0x00 || k")
            XCTAssertEqual(NUT13.hex(normal.chain), "2a7857631386ba23dacac34180dd1983734e444fdbf774041578e9b6adb37c19")
        }
    }

    // MARK: The path

    /// index, private key, public key — from tests/harness.js's own derivation.
    private let savedKeys: [(UInt64, String, String)] = [
        (0, "120921e8a32e61ac8ef0d3680e698e72bb6ec9fc36f8a8a68111e8aa61542f32",
            "03b11b8eb689103aebc20cd57fe4c11b9f629dbd79b40e83b13c9ebd857b543391"),
        (1, "ed677d91ed3081bd0e122ee177b5a555c4ab7f49f8b501b339d76c979c4e40bf",
            "03aa4d871b3193ba1a3f69c525a5c1ee9f214f77ea8391ba3dadcb8eb6b53c672d"),
        (2, "b828a729e2352748505c8540a2293a4278d5c4bec3b3e3cd3d30460d89363b7a",
            "03a242e9753fabd1680800cc462ca94d17d49e8654986b3d9f0749625e2733fd74"),
        (300, "47ff48bfbc28a53b2deb8c1442bb46aa98ea5986de1a0ac509d6c54c3625a0ab",
            "0289876dc9ff4a6cad10444c9937a2c4a1dcebeeab0ce5453558d4bbf03b92290c"),
        (20_000, "6105c2567fc907fdb35efca75142088be9a76c786e2a9c26a7470560c29b5aea",
            "03b4f3c9f4ef6373ee2e15f618145c2a4cf78317fb388d84dce3de9d936da37c61"),
        (0x7FFF_FFFF, "c92da9f5eb99533f8a75b4a62dde1c8c89cec8d96f3f3466701a8b1364792bd3",
            "032dcf3ee2df4188fb5347539d154fead88b64675dba77f1b5851319c2f9912f25"),
    ]

    private let phoneKeys: [(UInt64, String, String)] = [
        (0, "83686ff4170082b77dc0d20b9b726b24c07e10aaed01e33205a714c6e9621821",
            "03d5e349add0f7c450d20e0968ecdb9e5e4b64ceecfd1a5c8c90664b482ab37649"),
        (1, "f33b913c92a8544d089a9e5c989dab7d32522829354c81eeea807b285b3711fc",
            "037db85d2a01d197b59a906526300d675f9b46700106282ee55b2a414f25a7e618"),
        (2, "ba8fc1ee8ecc9c05b5ce1988d45a4c6dc9a4b8e0484777c53aa25c833ad9f49a",
            "038d7afee85b98e2d5a05c7bdea42be33d4717053d8eaf82d986bbd25a6c10424c"),
        (300, "27f7ba5e158dea44d2ef087ed5a775551d96a85294b70fa6d76d6c7cfef87d05",
            "0373bbee8538e14758c359c8f6f224f3b0b6e6cefadff0538c2eb9772b1f221448"),
        (20_000, "64003e5a7b96ee27e18a9aa5e7210b1b305a15b2de54df32108fa6d4a7b3f295",
            "030c8d8e1c56759fc071574aea3f8447178de1479ea0247651ede71f6e9d7f64ba"),
        (0x7FFF_FFFF, "427007b5869f404e204fab719831e31a89adbb663d6dd92c1ac40f0091d119d3",
            "02ea562cbdc3b291d49f36112a729820f9b2c6e12f5c610e6c49083a62da7a6dd1"),
    ]

    func testThePathIsTheOneNut13Writes() throws {
        XCTAssertEqual(P2PK.purpose, 129_373)
        XCTAssertEqual(P2PK.account, 10)
        for (words, vectors) in [(saved, savedKeys), (phone, phoneKeys)] {
            let s = try seed(words)
            for (index, privateKey, publicKey) in vectors {
                let pair = try P2PK.key(seed: s, index: index)
                XCTAssertEqual(pair.index, index)
                XCTAssertEqual(NUT13.hex(pair.privateKey), privateKey, "m/129373'/10'/0'/0'/\(index)")
                XCTAssertEqual(NUT13.hex(pair.publicKey), publicKey, "m/129373'/10'/0'/0'/\(index)")
                XCTAssertEqual(pair.publicKey.count, 33)
            }
        }
    }

    /// The same path walked by hand, level by level, with the last one hardened.
    /// Every key it gives has to be a key this file does *not* give — a wallet
    /// that derived these would be consistent with itself and with nothing else.
    func testAHardenedLastLevelWouldGiveDifferentKeys() throws {
        let s = try seed(phone)
        let hardened = try NUT13.withContext { ctx -> [String] in
            var parent = try NUT13.master(seed: s, ctx)
            defer { parent.wipe() }
            for level in [P2PK.purpose, P2PK.account, 0, 0] as [UInt32] {
                var next = try NUT13.child(parent, level | 0x8000_0000, ctx)
                swap(&parent, &next)
                next.wipe()
            }
            return try (0..<3).map { index in
                var child = try NUT13.child(parent, UInt32(index) | 0x8000_0000, ctx)
                defer { child.wipe() }
                return NUT13.hex(try NUT13.publicKey(child.key, ctx))
            }
        }
        let normal = try P2PK.publicKeys(seed: s, start: 0, count: 3).map { NUT13.hex($0) }
        XCTAssertEqual(normal, phoneKeys.prefix(3).map { $0.2 })
        for key in hardened { XCTAssertFalse(normal.contains(key)) }
    }

    /// The four hardened levels are walked once and reused, so a range has to
    /// give exactly what the same indices give one at a time.
    func testARangeIsTheSameAsOneAtATime() throws {
        let s = try seed(phone)
        let range = try P2PK.derive(seed: s, start: 7, count: 5)
        XCTAssertEqual(range.map { $0.index }, [7, 8, 9, 10, 11])
        for pair in range {
            let alone = try P2PK.key(seed: s, index: pair.index)
            XCTAssertEqual(NUT13.hex(pair.privateKey), NUT13.hex(alone.privateKey))
            XCTAssertEqual(NUT13.hex(pair.publicKey), NUT13.hex(alone.publicKey))
        }
    }

    /// And each public key really is its private key's, checked through
    /// libsecp256k1 rather than taken on trust from the table above.
    func testEachPublicKeyIsItsOwnPrivateKeys() throws {
        let s = try seed(saved)
        for pair in try P2PK.derive(seed: s, start: 0, count: 4) {
            let derived = try NUT13.withContext { try NUT13.publicKey(pair.privateKey, $0) }
            XCTAssertEqual(NUT13.hex(derived), NUT13.hex(pair.publicKey))
        }
    }

    /// Two seeds, one index: different keys. This is what `lockPrivkey`'s check
    /// of the answered public key against the stored one catches, and it is the
    /// only thing that catches a row left behind by a seed that was replaced.
    func testTheSameIndexUnderAnotherSeedIsAnotherKey() throws {
        let one = try P2PK.key(seed: try seed(saved), index: 4)
        let other = try P2PK.key(seed: try seed(phone), index: 4)
        XCTAssertNotEqual(NUT13.hex(one.publicKey), NUT13.hex(other.publicKey))
        XCTAssertNotEqual(NUT13.hex(one.privateKey), NUT13.hex(other.privateKey))
    }

    // MARK: What exists

    func testOnlyNormalChildIndicesExist() throws {
        XCTAssertEqual(P2PK.lastIndex, 0x7FFF_FFFF)
        XCTAssertEqual(P2PK.largestNext, 1 << 31)
        XCTAssertTrue(P2PK.indicesFit(start: 0, count: 1))
        XCTAssertTrue(P2PK.indicesFit(start: 0x7FFF_FFFF, count: 1))
        XCTAssertFalse(P2PK.indicesFit(start: 0x8000_0000, count: 1), "2^31 is 0', a different key")
        XCTAssertFalse(P2PK.indicesFit(start: 0x7FFF_FFFF, count: 2))
        XCTAssertFalse(P2PK.indicesFit(start: 0, count: 0))
        XCTAssertFalse(P2PK.indicesFit(start: .max, count: 1))
        XCTAssertThrowsError(try P2PK.derive(seed: try seed(phone), start: 0x8000_0000, count: 1)) {
            XCTAssertEqual($0 as? P2PK.Failure, .badIndex)
        }
        XCTAssertEqual(SeedActions.problem(P2PK.Failure.badIndex), "outside the lock-key window")
    }

    func testAScanStopsAtTwentyThousand() {
        XCTAssertEqual(P2PK.lastScanned, 20_000)
        XCTAssertEqual(P2PK.mostScanned, 300)
        XCTAssertEqual(P2PK.mostReserved, 64)
        XCTAssertTrue(P2PK.scanFits(start: 0, count: 300))
        XCTAssertTrue(P2PK.scanFits(start: 19_700, count: 300))
        XCTAssertFalse(P2PK.scanFits(start: 19_701, count: 300))
        XCTAssertFalse(P2PK.scanFits(start: 20_000, count: 1))
        XCTAssertFalse(P2PK.scanFits(start: 0, count: 0))
    }

    // MARK: The window a private key may be asked in

    func testAKeyIsAnsweredNearWhatIsReservedOrInsideWhatAScanServed() {
        XCTAssertEqual(P2PK.beyond, RestoreWindow.beyond)
        // a fresh install: the first few indices, which is every row it can have
        XCTAssertTrue(P2PK.keyAllowed(index: 0, next: 0, served: 0))
        XCTAssertTrue(P2PK.keyAllowed(index: 999, next: 0, served: 0))
        XCTAssertFalse(P2PK.keyAllowed(index: 1000, next: 0, served: 0))
        // a wallet that has made a few hundred requests
        XCTAssertTrue(P2PK.keyAllowed(index: 500, next: 400, served: 0), "a row below next")
        XCTAssertTrue(P2PK.keyAllowed(index: 1399, next: 400, served: 0))
        XCTAssertFalse(P2PK.keyAllowed(index: 1400, next: 400, served: 0))
        /* A restore on another phone: nothing reserved, and the index is where
         * the old phone left it. Only the scan opens it, which is the whole
         * reason the derived key exists. */
        XCTAssertFalse(P2PK.keyAllowed(index: 1480, next: 0, served: 0))
        XCTAssertTrue(P2PK.keyAllowed(index: 1480, next: 0, served: 1600), "the walk that found it")
        XCTAssertFalse(P2PK.keyAllowed(index: 1600, next: 0, served: 1600), "the end is one past")
        // and nothing past the last index a normal child has
        XCTAssertFalse(P2PK.keyAllowed(index: 0x8000_0000, next: 0, served: .max))
        XCTAssertTrue(P2PK.keyAllowed(index: 0x7FFF_FFFF, next: .max, served: 0), "next + 1000 overflowing is not a hole")
    }

    // MARK: The replies

    func testTheRepliesCarryKeysAndNothingElse() throws {
        let keys = try P2PK.publicKeys(seed: try seed(phone), start: 0, count: 2)
        let reply = P2PK.pubkeysReply(start: 0, next: 2, pubkeys: keys)
        XCTAssertEqual(reply, "{\"start\":0,\"next\":2,\"pubkeys\":[\"\(phoneKeys[0].2)\",\"\(phoneKeys[1].2)\"]}")
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["start", "next", "pubkeys"])

        XCTAssertEqual(P2PK.pubkeysReply(start: 9, next: 9, pubkeys: []), "{\"start\":9,\"next\":9,\"pubkeys\":[]}")

        var pair = try P2PK.key(seed: try seed(phone), index: 1)
        defer { pair.wipe() }
        let one = P2PK.keyReply(pair)
        XCTAssertEqual(one, "{\"index\":1,\"privkey\":\"\(phoneKeys[1].1)\",\"pubkey\":\"\(phoneKeys[1].2)\"}")
        let single = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(one.utf8)) as? [String: Any])
        XCTAssertEqual(Set(single.keys), ["index", "privkey", "pubkey"],
                       "the parent's chain code and a child private key together give every other index")
    }

    /// A pair's private half is wiped in place. The array it came from is the
    /// only holder of those bytes, so this is the wipe that happens on the phone.
    func testWipingAPairClearsThePrivateHalf() throws {
        var pair = try P2PK.key(seed: try seed(phone), index: 3)
        let publicKey = pair.publicKey
        pair.wipe()
        XCTAssertTrue(NUT13.isZero(pair.privateKey))
        XCTAssertEqual(pair.publicKey, publicKey, "the public half is not a secret and stays")
    }
}
