import XCTest
@testable import Foxy

/// The receiving half of the Nostr transport: the `nprofile` a request names,
/// and the unwrapping of a payment sent to it.
///
/// Both halves are written here, so a mistake shared by both would pass
/// unnoticed. The defence is external vectors: the bech32 encoder is checked
/// against BIP-173's own test strings and against NIP-19's worked `nprofile`
/// example, neither of which Foxy produced.
final class NostrInboxTests: XCTestCase {

    // MARK: bech32, written as well as read

    /// BIP-173's valid strings. If the encoder disagrees with these it is not
    /// bech32, whatever the decoder thinks.
    ///
    /// Only the vectors that carry data: Foxy's decoder wants at least one
    /// data byte (`values.count > 6`), which is right for an `nprofile` — one
    /// with no payload names nobody — but means the spec's empty-data strings
    /// ("a12uel5l", "?1ezyfcl") cannot be read back here to compare.
    func testEncodesBIP173Vectors() {
        let vectors = [
            "abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw",
            "11qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8247j",
            "split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w",
        ]
        for text in vectors {
            guard let (prefix, data) = Bech32.decode(text) else {
                XCTFail("could not read the vector \(text)"); continue
            }
            XCTAssertEqual(Bech32.encode(prefix: prefix, data: data), text,
                           "re-encoding \(text) did not give it back")
        }
    }

    /// NIP-19's own worked example. The key and relays are the spec's, and so
    /// is the string: nothing here was produced by this code.
    func testNIP19NprofileExample() {
        let pubkey = NostrEvent.bytes("3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d")
        let relays = ["wss://r.x.com", "wss://djbas.sadkb.com"]
        let expected = "nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyaw"
            + "d24mayt8gpp4mhxue69uhhytnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34kytnrdaksjlyr9p"
        XCTAssertEqual(Bech32.nprofile(pubkey: pubkey, relays: relays), expected)
    }

    /// And what Foxy writes, Foxy reads.
    func testNprofileRoundTrip() throws {
        let secret = try NostrCrypto.newKey()
        let pubkey = try NostrCrypto.publicKey(of: secret)
        let relays = NostrInbox.relays
        let text = try XCTUnwrap(Bech32.nprofile(pubkey: pubkey, relays: relays))
        XCTAssertTrue(text.hasPrefix("nprofile1"))
        let read = try XCTUnwrap(Bech32.nprofile(text))
        XCTAssertEqual(read.pubkey, pubkey)
        XCTAssertEqual(read.relays, relays)
    }

    func testNprofileRefusesAKeyOfTheWrongLength() {
        XCTAssertNil(Bech32.nprofile(pubkey: [1, 2, 3], relays: []))
    }

    // MARK: a payment, wrapped and unwrapped

    func testUnwrapsAPaymentSentToThisKey() throws {
        let secret = try NostrCrypto.newKey()
        let pubkey = try NostrCrypto.publicKey(of: secret)
        let payment = #"{"id":"74134073","mint":"https://mint.test","unit":"sat","proofs":[]}"#
        let wrap = try NostrEvent.giftWrapped(payload: payment, receiver: pubkey)

        let rumor = try XCTUnwrap(NostrEvent.unwrap(wrap, to: secret))
        XCTAssertEqual(rumor.content, payment)
        XCTAssertEqual(rumor.kind, 14)
    }

    func testAPaymentForSomebodyElseDoesNotOpen() throws {
        let mine = try NostrCrypto.newKey()
        let theirs = try NostrCrypto.publicKey(of: try NostrCrypto.newKey())
        let wrap = try NostrEvent.giftWrapped(payload: "{}", receiver: theirs)
        XCTAssertNil(NostrEvent.unwrap(wrap, to: mine))
    }

    /// A relay hands out whatever it likes. A wrap whose signature does not
    /// hold must not open, or a relay could put words in a payer's mouth.
    func testARewrittenWrapIsRefused() throws {
        let secret = try NostrCrypto.newKey()
        let pubkey = try NostrCrypto.publicKey(of: secret)
        var wrap = try NostrEvent.giftWrapped(payload: "{}", receiver: pubkey)
        XCTAssertNotNil(NostrEvent.unwrap(wrap, to: secret), "the untouched wrap should open")

        var broken = wrap
        broken.sig = String(repeating: "0", count: 128)
        XCTAssertNil(NostrEvent.unwrap(broken, to: secret), "a bad signature opened")

        broken = wrap
        broken.id = String(repeating: "0", count: 64)
        XCTAssertNil(NostrEvent.unwrap(broken, to: secret), "a wrong id opened")

        wrap.kind = 1
        XCTAssertNil(NostrEvent.unwrap(wrap, to: secret), "a wrap of the wrong kind opened")
    }

    /// The seal may only carry its own author's rumor. Without this check,
    /// anyone could take a rumor somebody else wrote and seal it as their own.
    func testASealCannotCarryAnotherAuthorsRumor() throws {
        let secret = try NostrCrypto.newKey()
        let pubkey = try NostrCrypto.publicKey(of: secret)

        // a rumor written by a key that is not the one sealing it
        let stranger = try NostrCrypto.newKey()
        let strangerPub = try NostrCrypto.publicKey(of: stranger)
        let rumor = NostrEvent.withID(NostrEvent.Event(
            id: "", pubkey: NostrEvent.hex(strangerPub), createdAt: 1, kind: 14,
            tags: [["p", NostrEvent.hex(pubkey)]], content: "{}", sig: ""))

        let sealKey = try NostrCrypto.newKey()
        let sealPub = try NostrCrypto.publicKey(of: sealKey)
        let toReceiver = try NostrCrypto.conversationKey(secret: sealKey, peer: pubkey)
        let seal = try NostrEvent.signed(NostrEvent.Event(
            id: "", pubkey: NostrEvent.hex(sealPub), createdAt: 1, kind: 13, tags: [],
            content: NostrCrypto.encrypt(Array(NostrEvent.json(rumor).utf8), conversationKey: toReceiver),
            sig: ""), with: sealKey)

        let wrapKey = try NostrCrypto.newKey()
        let wrapPub = try NostrCrypto.publicKey(of: wrapKey)
        let fromWrap = try NostrCrypto.conversationKey(secret: wrapKey, peer: pubkey)
        let wrap = try NostrEvent.signed(NostrEvent.Event(
            id: "", pubkey: NostrEvent.hex(wrapPub), createdAt: 1, kind: 1059,
            tags: [["p", NostrEvent.hex(pubkey)]],
            content: NostrCrypto.encrypt(Array(NostrEvent.json(seal).utf8), conversationKey: fromWrap),
            sig: ""), with: wrapKey)

        XCTAssertNil(NostrEvent.unwrap(wrap, to: secret),
                     "a seal carrying somebody else's rumor was accepted")
    }

    /// The subscription must cover NIP-59's backdating.
    ///
    /// A gift wrap's `created_at` is random up to two days in the past, on
    /// purpose, so that it says nothing about when the message was really
    /// sent. A `since` measured from when the inbox opened therefore filters
    /// out almost every real payment — about 0.03% of wraps would have landed
    /// inside the one minute this first asked for, and the first live payment
    /// from cashu.me duly never arrived.
    func testTheSubscriptionCoversTheWholeBackdatingWindow() throws {
        let source = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Nostr/NostrInbox.swift"),
                                encoding: .utf8)
        XCTAssertTrue(source.contains("- backdating - "),
                      "the subscription no longer measures `since` from the backdating window")

        // and the window really is as wide as what giftWrapped produces
        let now = 1_700_000_000
        var oldest = now
        for _ in 0..<4000 { oldest = min(oldest, NostrEvent.backdated(now: now)) }
        let since = now - 172_800 - 3600
        XCTAssertLessThanOrEqual(since, oldest,
                                 "a wrap backdated to \(now - oldest)s ago falls outside `since`")
    }

    // MARK: the inbox itself

    /// Two inboxes never share a key: it is made for one request and dies with
    /// it, which is the whole privacy cost of this transport being bounded.
    func testEveryInboxHasItsOwnKey() throws {
        let a = try XCTUnwrap(NostrInbox(onPayment: { _ in }))
        let b = try XCTUnwrap(NostrInbox(onPayment: { _ in }))
        let one = try XCTUnwrap(a.nprofile), two = try XCTUnwrap(b.nprofile)
        XCTAssertNotEqual(one, two)
        a.close(); b.close()
    }

    /// A closed inbox names nothing, so a request cannot go out pointing at a
    /// key nobody is listening on.
    func testAClosedInboxNamesNothing() throws {
        let inbox = try XCTUnwrap(NostrInbox(onPayment: { _ in }))
        XCTAssertNotNil(inbox.nprofile)
        inbox.close()
        XCTAssertNil(inbox.nprofile)
    }

    /// Only EVENT lines for this subscription are read, and each wrap once —
    /// every relay sends the same one, because the payer published to them all.
    func testRelayChatterIsIgnoredAndWrapsAreDeduplicated() throws {
        var payments = [String]()
        let inbox = try XCTUnwrap(NostrInbox(onPayment: { payments.append($0) }))
        defer { inbox.close() }
        let pubkey = try XCTUnwrap(Bech32.nprofile(try XCTUnwrap(inbox.nprofile))).pubkey
        let wrap = try NostrEvent.giftWrapped(payload: #"{"id":"abc"}"#, receiver: pubkey)
        let event = NostrEvent.json(wrap)

        // the subscription name is private, so read it off a line the inbox accepts
        let mirror = Mirror(reflecting: inbox)
        let sub = try XCTUnwrap(mirror.children.first { $0.label == "subscription" }?.value as? String)

        inbox.took(#"["EOSE","\#(sub)"]"#)
        inbox.took(#"["NOTICE","hello"]"#)
        inbox.took(#"["EVENT","not-this-subscription",\#(event)]"#)
        XCTAssertEqual(payments.count, 0, "chatter was taken for a payment")

        inbox.took(#"["EVENT","\#(sub)",\#(event)]"#)
        inbox.took(#"["EVENT","\#(sub)",\#(event)]"#)   // the same wrap from a second relay
        XCTAssertEqual(payments, [#"{"id":"abc"}"#], "the same payment was announced twice")
    }
}
