import XCTest
import CryptoKit
@testable import Foxy

/// Foxy's Nostr cryptography against the specs' own vectors: RFC 8439 for
/// ChaCha20, and tests/fixtures/nip44.vectors.json — the NIP-44 reference
/// vectors from paulmillr/nip44, sha256
/// 269ed0f69e4c192512cc779e78c555090cebc7c785b609e338a62afc3ce25040, the one
/// NIP-44 itself names — for the conversation keys, the message keys, the
/// padding, and encrypting and decrypting, valid and invalid.
///
/// Anything here is what a payment delivered over Nostr rests on, so the whole
/// file is vectors: nothing checks Foxy's code against Foxy's code, except the
/// gift wrap at the end, which is unwrapped the way a receiving wallet does.
final class NostrCryptoTests: XCTestCase {

    private static let vectors: [String: Any] = {
        let url = repoRoot().appendingPathComponent("tests/fixtures/nip44.vectors.json")
        let data = (try? Data(contentsOf: url)) ?? Data()
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return (json["v2"] as? [String: Any]) ?? [:]
    }()

    private var valid: [String: Any] { (Self.vectors["valid"] as? [String: Any]) ?? [:] }
    private var invalid: [String: Any] { (Self.vectors["invalid"] as? [String: Any]) ?? [:] }
    private func cases(_ group: String, _ where: String = "valid") -> [[String: Any]] {
        let from = `where` == "valid" ? valid : invalid
        return (from[group] as? [[String: Any]]) ?? []
    }
    private func bytes(_ hex: String) -> [UInt8] { NostrEvent.bytes(hex) }

    func testTheVectorsAreTheOnesTheNIPNames() {
        let url = repoRoot().appendingPathComponent("tests/fixtures/nip44.vectors.json")
        let data = (try? Data(contentsOf: url)) ?? Data()
        XCTAssertEqual(NostrEvent.hex([UInt8](SHA256.hash(data: data))),
                       "269ed0f69e4c192512cc779e78c555090cebc7c785b609e338a62afc3ce25040")
        XCTAssertEqual(cases("get_conversation_key").count, 35)
        XCTAssertEqual(cases("encrypt_decrypt").count, 10)
        XCTAssertEqual(cases("calc_padded_len").count, 0)     // pairs, not objects
    }

    // MARK: ChaCha20 (RFC 8439)

    func testChaCha20BlockAtCounterZero() {
        let stream = ChaCha20.keystream(key: [UInt8](repeating: 0, count: 32),
                                        nonce: [UInt8](repeating: 0, count: 12), counter: 0)
        XCTAssertEqual(NostrEvent.hex(stream),
                       "76b8e0ada0f13d90405d6ae55386bd28bdd219b8a08ded1aa836efcc8b770dc7"
                       + "da41597c5157488d7724e03fb8d84a376a43b8f41518a11cc387b669b2ee6586")
    }

    func testChaCha20SunscreenVector() {
        let key = (0..<32).map { UInt8($0) }
        let nonce = bytes("000000000000004a00000000")
        let text = Array("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.".utf8)
        let out = ChaCha20.apply(text, key: key, nonce: nonce, counter: 1)
        XCTAssertEqual(NostrEvent.hex(out),
                       "6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b"
                       + "f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8"
                       + "07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736"
                       + "5af90bbf74a35be6b40b8eedf2785e42874d")
    }

    func testChaCha20AtACounterOtherThanOne() {
        // RFC 8439 A.2 #3: counter 42
        let key = bytes("1c9240a5eb55d38af333888604f6b5f0473917c1402b80099dca5cbc207075c0")
        let nonce = bytes("000000000000000000000002")
        let text = Array("'Twas brillig, and the slithy toves\nDid gyre and gimble in the wabe:\nAll mimsy were the borogoves,\nAnd the mome raths outgrabe.".utf8)
        let out = ChaCha20.apply(text, key: key, nonce: nonce, counter: 42)
        XCTAssertEqual(NostrEvent.hex(out).prefix(64),
                       "62e6347f95ed87a45ffae7426f27a1df5fb69110044c0d73118effa95b01e5cf")
        XCTAssertEqual(out.count, text.count)
    }

    // MARK: NIP-44 v2

    func testConversationKeys() throws {
        var checked = 0
        for c in cases("get_conversation_key") {
            guard let sec1 = c["sec1"] as? String, let pub2 = c["pub2"] as? String,
                  let want = c["conversation_key"] as? String else { continue }
            let key = try NostrCrypto.conversationKey(secret: bytes(sec1), peer: bytes(pub2))
            XCTAssertEqual(NostrEvent.hex(key), want, (c["note"] as? String) ?? "")
            checked += 1
        }
        XCTAssertEqual(checked, 35)
    }

    func testConversationKeysThatMustBeRefused() {
        var checked = 0
        for c in cases("get_conversation_key", "invalid") {
            guard let sec1 = c["sec1"] as? String, let pub2 = c["pub2"] as? String else { continue }
            XCTAssertThrowsError(try NostrCrypto.conversationKey(secret: bytes(sec1), peer: bytes(pub2)),
                                 (c["note"] as? String) ?? "")
            checked += 1
        }
        XCTAssertEqual(checked, 8)
    }

    func testMessageKeys() {
        guard let group = valid["get_message_keys"] as? [String: Any],
              let conversation = group["conversation_key"] as? String,
              let list = group["keys"] as? [[String: Any]] else { return XCTFail("no message-key vectors") }
        let key = bytes(conversation)
        XCTAssertGreaterThan(list.count, 20)
        for c in list {
            guard let nonce = c["nonce"] as? String else { continue }
            let keys = NostrCrypto.messageKeys(conversationKey: key, nonce: bytes(nonce))
            XCTAssertEqual(NostrEvent.hex(keys.chacha), c["chacha_key"] as? String)
            XCTAssertEqual(NostrEvent.hex(keys.nonce), c["chacha_nonce"] as? String)
            XCTAssertEqual(NostrEvent.hex(keys.hmac), c["hmac_key"] as? String)
        }
    }

    func testPaddedLengths() {
        guard let pairs = valid["calc_padded_len"] as? [[Int]] else { return XCTFail("no padding vectors") }
        XCTAssertEqual(pairs.count, 24)
        for pair in pairs where pair.count == 2 {
            XCTAssertEqual(NostrCrypto.paddedLength(pair[0]), pair[1], "length \(pair[0])")
        }
    }

    func testEncryptAndDecryptTheVectors() throws {
        var checked = 0
        for c in cases("encrypt_decrypt") {
            guard let sec1 = c["sec1"] as? String, let sec2 = c["sec2"] as? String,
                  let nonce = c["nonce"] as? String, let plaintext = c["plaintext"] as? String,
                  let want = c["payload"] as? String,
                  let conversation = c["conversation_key"] as? String else { continue }
            let pub2 = try NostrCrypto.publicKey(of: bytes(sec2))
            let key = try NostrCrypto.conversationKey(secret: bytes(sec1), peer: pub2)
            XCTAssertEqual(NostrEvent.hex(key), conversation)
            let payload = try NostrCrypto.encrypt(Array(plaintext.utf8), conversationKey: key, nonce: bytes(nonce))
            XCTAssertEqual(payload, want)
            let back = NostrCrypto.decrypt(want, conversationKey: key)
            XCTAssertEqual(back.map { String(decoding: $0, as: UTF8.self) }, plaintext)
            checked += 1
        }
        XCTAssertEqual(checked, 10)
    }

    func testPayloadsThatMustNotDecrypt() {
        var checked = 0
        for c in cases("decrypt", "invalid") {
            guard let conversation = c["conversation_key"] as? String,
                  let payload = c["payload"] as? String else { continue }
            XCTAssertNil(NostrCrypto.decrypt(payload, conversationKey: bytes(conversation)),
                         (c["note"] as? String) ?? "")
            checked += 1
        }
        XCTAssertGreaterThanOrEqual(checked, 10)
    }

    func testLengthsThatMustNotEncrypt() throws {
        let key = try NostrCrypto.conversationKey(secret: [UInt8](repeating: 1, count: 32),
                                                  peer: try NostrCrypto.publicKey(of: [UInt8](repeating: 2, count: 32)))
        for length in (invalid["encrypt_msg_lengths"] as? [Int]) ?? [] {
            XCTAssertThrowsError(try NostrCrypto.encrypt([UInt8](repeating: 0x61, count: length),
                                                         conversationKey: key), "length \(length)")
        }
        // and the largest one that must work
        XCTAssertNoThrow(try NostrCrypto.encrypt([UInt8](repeating: 0x61, count: 65535), conversationKey: key))
    }

    // MARK: Events (NIP-01) and the gift wrap (NIP-59)

    func testTheEventIdIsTheHashOfTheCanonicalArray() {
        // NIP-01's rules, with the characters that used to be escaped wrongly
        let event = NostrEvent.Event(id: "", pubkey: String(repeating: "ab", count: 32), createdAt: 1_700_000_000,
                                     kind: 14, tags: [["p", String(repeating: "cd", count: 32)]],
                                     content: "{\"mint\":\"https://mint.example/Bitcoin\"}\n\t\"x\"",
                                     sig: "")
        let canonical = NostrEvent.canonical(event)
        XCTAssertTrue(canonical.contains("https://mint.example/Bitcoin"), "a mint URL must not be escaped: \(canonical)")
        XCTAssertTrue(canonical.contains("\\n\\t\\\""), canonical)
        XCTAssertFalse(canonical.contains("\\/"), "JSONSerialization's slash escaping would change every id")
        let with = NostrEvent.withID(event)
        XCTAssertEqual(with.id.count, 64)
        // the same event hashes the same way twice, and a changed character changes it
        XCTAssertEqual(with.id, NostrEvent.withID(event).id)
        var other = event
        other.content += " "
        XCTAssertNotEqual(with.id, NostrEvent.withID(other).id)
    }

    func testASignedEventVerifiesUnderItsOwnKey() throws {
        let secret = try NostrCrypto.newKey()
        let pubkey = try NostrCrypto.publicKey(of: secret)
        let event = try NostrEvent.signed(NostrEvent.Event(id: "", pubkey: NostrEvent.hex(pubkey),
                                                           createdAt: 1_700_000_000, kind: 13, tags: [],
                                                           content: "hello", sig: ""), with: secret)
        XCTAssertTrue(NostrCrypto.verify(NostrEvent.bytes(event.sig), digest: NostrEvent.bytes(event.id),
                                         pubkey: pubkey))
        // a different key does not verify it
        let other = try NostrCrypto.publicKey(of: try NostrCrypto.newKey())
        XCTAssertFalse(NostrCrypto.verify(NostrEvent.bytes(event.sig), digest: NostrEvent.bytes(event.id),
                                          pubkey: other))
    }

    /// The whole wrap, opened the way a receiving wallet opens it (nostr-tools'
    /// unwrapEvent, rust-nostr's UnwrappedGift): the wrap decrypts to a seal,
    /// the seal's signature holds, the rumor's author is the seal's author, and
    /// the rumor holds the payment.
    func testAWrappedPaymentOpensTheWayAWalletOpensIt() throws {
        let receiverSecret = try NostrCrypto.newKey()
        let receiver = try NostrCrypto.publicKey(of: receiverSecret)
        let payload = "{\"id\":\"a1b2\",\"mint\":\"https://mint.minibits.cash/Bitcoin\",\"unit\":\"sat\",\"proofs\":[]}"
        let wrap = try NostrEvent.giftWrapped(payload: payload, receiver: receiver, now: 1_700_000_000)

        XCTAssertEqual(wrap.kind, 1059)
        XCTAssertEqual(wrap.tags, [["p", NostrEvent.hex(receiver)]])
        XCTAssertTrue(NostrCrypto.verify(NostrEvent.bytes(wrap.sig), digest: NostrEvent.bytes(wrap.id),
                                         pubkey: NostrEvent.bytes(wrap.pubkey)))
        XCTAssertLessThanOrEqual(wrap.createdAt, 1_700_000_000)
        XCTAssertGreaterThanOrEqual(wrap.createdAt, 1_700_000_000 - 172_800)

        let toWrap = try NostrCrypto.conversationKey(secret: receiverSecret, peer: NostrEvent.bytes(wrap.pubkey))
        guard let sealJSON = NostrCrypto.decrypt(wrap.content, conversationKey: toWrap) else {
            return XCTFail("the wrap did not open")
        }
        guard let seal = (try? JSONSerialization.jsonObject(with: Data(sealJSON))) as? [String: Any],
              let sealPub = seal["pubkey"] as? String, let sealID = seal["id"] as? String,
              let sealSig = seal["sig"] as? String, let sealContent = seal["content"] as? String else {
            return XCTFail("the seal did not read")
        }
        XCTAssertEqual(seal["kind"] as? Int, 13)
        XCTAssertEqual((seal["tags"] as? [[String]]) ?? [], [])
        XCTAssertNotEqual(sealPub, wrap.pubkey, "the seal and the wrap must be signed by different keys")
        XCTAssertTrue(NostrCrypto.verify(NostrEvent.bytes(sealSig), digest: NostrEvent.bytes(sealID),
                                         pubkey: NostrEvent.bytes(sealPub)),
                      "wallets check the seal's signature")

        let toSeal = try NostrCrypto.conversationKey(secret: receiverSecret, peer: NostrEvent.bytes(sealPub))
        guard let rumorJSON = NostrCrypto.decrypt(sealContent, conversationKey: toSeal),
              let rumor = (try? JSONSerialization.jsonObject(with: Data(rumorJSON))) as? [String: Any] else {
            return XCTFail("the seal did not open")
        }
        XCTAssertEqual(rumor["kind"] as? Int, 14)
        XCTAssertEqual(rumor["pubkey"] as? String, sealPub, "wallets refuse a rumor from another key")
        XCTAssertEqual(rumor["content"] as? String, payload)
        XCTAssertEqual(rumor["created_at"] as? Int, 1_700_000_000, "the rumor keeps the real time")
        XCTAssertNil(rumor["sig"], "a rumor is not signed")
    }

    // MARK: nprofile (NIP-19)

    func testTheNIP19ExampleProfileReads() {
        let text = "nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhhytnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34kytnrdaksjlyr9p"
        guard let read = Bech32.nprofile(text) else { return XCTFail("the example did not read") }
        XCTAssertEqual(NostrEvent.hex(read.pubkey),
                       "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d")
        XCTAssertEqual(read.relays, ["wss://r.x.com", "wss://djbas.sadkb.com"])
    }

    func testABentProfileIsRefused() {
        XCTAssertNil(Bech32.nprofile("nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhhytnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34kytnrdaksjlyr9q"),
                     "a wrong checksum")
        XCTAssertNil(Bech32.nprofile("npub1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4"), "not an nprofile")
        XCTAssertNil(Bech32.nprofile("nprofile1"), "nothing to read")
        XCTAssertNil(Bech32.nprofile(""), "nothing at all")
    }

    func testTheRelaysAPaymentGoesTo() {
        // a request's own relays, at most five, wss only
        let listed = ["wss://relay.one", "ws://relay.two", "https://relay.three", "wss://relay.one",
                      "wss://a", "wss://b", "wss://c", "wss://d", "wss://e"]
        let urls = NostrDelivery.relays(listed).map { $0.absoluteString }
        XCTAssertEqual(urls, ["wss://relay.one", "wss://a", "wss://b", "wss://c", "wss://d"])
        // none named: Foxy's fallbacks, which are where these wallets listen
        XCTAssertEqual(NostrDelivery.relays([]).map { $0.absoluteString }, NostrDelivery.fallbackRelays)
    }

    func testWhatARelaySaysAboutTheEvent() {
        let id = String(repeating: "ab", count: 32)
        XCTAssertEqual(NostrDelivery.reading("[\"OK\",\"\(id)\",true,\"\"]", id: id), "")
        XCTAssertEqual(NostrDelivery.reading("[\"OK\",\"\(id)\",false,\"duplicate: have it\"]", id: id), "")
        XCTAssertEqual(NostrDelivery.reading("[\"OK\",\"\(id)\",false,\"blocked: no\"]", id: id), "blocked: no")
        XCTAssertNil(NostrDelivery.reading("[\"NOTICE\",\"hello\"]", id: id))
        XCTAssertNil(NostrDelivery.reading("[\"OK\",\"someone else\",true,\"\"]", id: id))
        XCTAssertNil(NostrDelivery.reading("not json", id: id))
    }
}
