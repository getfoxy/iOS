import XCTest
import Network
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

        let sub = inbox.subscription

        inbox.took(#"["EOSE","\#(sub)"]"#)
        inbox.took(#"["NOTICE","hello"]"#)
        inbox.took(#"["EVENT","not-this-subscription",\#(event)]"#)
        XCTAssertEqual(payments.count, 0, "chatter was taken for a payment")

        inbox.took(#"["EVENT","\#(sub)",\#(event)]"#)
        inbox.took(#"["EVENT","\#(sub)",\#(event)]"#)   // the same wrap from a second relay
        XCTAssertEqual(payments, [#"{"id":"abc"}"#], "the same payment was announced twice")
    }

    // MARK: paging back (the Foxy ID's inbox, M1)

    /// A relay answers at most `limit` wraps to one REQ. The Foxy ID's inbox
    /// reaches back thirty-two days, so a full page is followed by the next, up
    /// to before its oldest wrap (`until`), until a page is not full, `since` is
    /// reached, or eight pages have been asked.
    func testAFullPageAsksForTheNextBackToSince() throws {
        let secret = try NostrCrypto.newKey()
        let since = 1_700_000_000
        let inbox = try XCTUnwrap(NostrInbox(secret: secret, since: since, label: "test", pages: 3, onPayment: { _ in }))
        defer { inbox.close() }
        var asks: [(Int, String)] = []
        inbox.sendAsk = { asks.append(($0, $1)) }
        let sub = inbox.subscription
        // 500 wraps that parse but open for no one, the oldest at since + 5000
        func page(from top: Int) {
            for k in 0..<500 {
                let fake = "{\"id\":\"\(String(format: "%064x", top - k))\",\"pubkey\":\"\(String(repeating: "a", count: 64))\",\"created_at\":\(top - k),"
                    + "\"kind\":1059,\"tags\":[],\"content\":\"x\",\"sig\":\"\(String(repeating: "b", count: 128))\"}"
                inbox.took("[\"EVENT\",\"\(sub)\",\(fake)]", relay: 2)
            }
        }
        page(from: since + 5499)
        inbox.took("[\"EOSE\",\"\(sub)\"]", relay: 2)
        XCTAssertEqual(asks.count, 1, "a full page asks for the next")
        XCTAssertEqual(asks.first?.0, 2, "of the same relay")
        XCTAssertTrue(asks.first?.1.contains("\"since\":\(since),\"until\":\(since + 5000),\"limit\":500") == true, asks.first?.1 ?? "")
        page(from: since + 4999)
        inbox.took("[\"EOSE\",\"\(sub)\"]", relay: 2)
        XCTAssertEqual(asks.count, 2)
        XCTAssertTrue(asks.last?.1.contains("\"until\":\(since + 4500)") == true, asks.last?.1 ?? "")
        // the third page is the last this inbox may ask for
        page(from: since + 4499)
        inbox.took("[\"EOSE\",\"\(sub)\"]", relay: 2)
        XCTAssertEqual(asks.count, 2, "no more than `pages` pages")
        // and a page that is not full ends it on another relay at once
        inbox.took("[\"EOSE\",\"\(sub)\"]", relay: 0)
        XCTAssertEqual(asks.count, 2, "an empty page asks for nothing")
        // a request's own inbox (one page) never pages
        let one = try XCTUnwrap(NostrInbox(secret: secret, since: since, label: "one", onPayment: { _ in }))
        defer { one.close() }
        var oneAsks = 0
        one.sendAsk = { _, _ in oneAsks += 1 }
        XCTAssertNil(one.pageEnded(relay: 0))
        XCTAssertEqual(oneAsks, 0)
        // the REQ itself
        XCTAssertEqual(NostrInbox.ask(subscription: "s", pubkey: [UInt8](repeating: 1, count: 32), since: 5, until: 9, limit: 3),
                       "[\"REQ\",\"s\",{\"kinds\":[1059],\"#p\":[\"\(String(repeating: "01", count: 32))\"],\"since\":5,\"until\":9,\"limit\":3}]")
    }

    /// A page whose wraps all sit in one second is asked for past that second, or the same page would come back for ever.
    func testAPageInOneSecondMovesOn() throws {
        let secret = try NostrCrypto.newKey()
        let inbox = try XCTUnwrap(NostrInbox(secret: secret, since: 1000, label: "test", pages: 4, onPayment: { _ in }))
        defer { inbox.close() }
        var asks: [String] = []
        inbox.sendAsk = { asks.append($1) }
        let sub = inbox.subscription
        func sameSecond(_ at: Int, _ salt: Int) {
            for k in 0..<500 {
                let fake = "{\"id\":\"\(String(format: "%064x", salt * 1000 + k))\",\"pubkey\":\"\(String(repeating: "a", count: 64))\",\"created_at\":\(at),"
                    + "\"kind\":1059,\"tags\":[],\"content\":\"x\",\"sig\":\"\(String(repeating: "b", count: 128))\"}"
                inbox.took("[\"EVENT\",\"\(sub)\",\(fake)]", relay: 1)
            }
            inbox.took("[\"EOSE\",\"\(sub)\"]", relay: 1)
        }
        sameSecond(5000, 1)
        XCTAssertTrue(asks.last?.contains("\"until\":5000,") == true, asks.last ?? "")
        sameSecond(5000, 2)
        XCTAssertTrue(asks.last?.contains("\"until\":4999,") == true, asks.last ?? "")
    }

    // MARK: the inbox, fed what a relay would send

    private func relayMessage(_ event: NostrEvent.Event, for inbox: NostrInbox) -> String {
        "[\"EVENT\",\"" + inbox.subscription + "\"," + NostrEvent.json(event) + "]"
    }

    /// Relays send whatever they like, and every relay sends the same wrap.
    /// A wrap is remembered as seen only once it has opened and checked out:
    /// one relay sending a wrap that merely claims the genuine wrap's id must
    /// not make the genuine one, arriving from the others, drop as a copy.
    func testAWrapThatOnlyClaimsTheGenuineIdDoesNotShadowIt() throws {
        var got: [String] = []
        let inbox = try XCTUnwrap(NostrInbox(onPayment: { got.append($0) }))
        let payment = #"{"id":"8c0e1f22","mint":"https://mint.test","unit":"sat","proofs":[]}"#
        let wrap = try NostrEvent.giftWrapped(payload: payment, receiver: inbox.pubkey)
        var forged = wrap
        forged.content = "not what the id says"     // the id and the signature are the genuine wrap's
        XCTAssertNil(NostrEvent.unwrap(forged, to: [UInt8](repeating: 1, count: 32)), "it is not a wrap that opens")

        inbox.took(relayMessage(forged, for: inbox))
        XCTAssertEqual(got, [], "a wrap that does not check out pays nothing")
        inbox.took(relayMessage(wrap, for: inbox))
        XCTAssertEqual(got, [payment], "and the genuine wrap, from the next relay, is taken")
        inbox.took(relayMessage(wrap, for: inbox))
        XCTAssertEqual(got.count, 1, "the same wrap from a third relay is one payment, not two")
        inbox.close()
    }


    // MARK: the Foxy ID's drop boxes

    /// The keys of `days` for a delivery secret, as the bridge hands them (FoxyBridge+CashuID.swift): always
    /// `cashuIdAskCount` REQs covering the window that ends `today`.
    private func dayInbox(_ q: [UInt8], days: [Int], today: Int, got: @escaping (String) -> Void = { _ in }) throws -> NostrInbox {
        let wanted = try FoxyBridge.cashuIdAsks(days: days, today: today).map {
            NostrInbox.Wanted(secrets: try CashuID.dropSecrets(base: q, days: $0.days.map { UInt32($0) }), since: $0.since)
        }
        return try XCTUnwrap(NostrInbox(asks: wanted, label: "test id inbox", pages: 8, onPayment: got))
    }

    /// The `#p` keys and the rest of a REQ's filter.
    private func parts(of req: String) throws -> (sub: String, keys: [String], since: Int, shape: String) {
        let parsed = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(req.utf8)) as? [Any])
        var filter = try XCTUnwrap(parsed[2] as? [String: Any])
        let keys = try XCTUnwrap(filter["#p"] as? [String])
        let since = try XCTUnwrap(filter["since"] as? Int)
        filter["#p"] = nil
        filter["since"] = nil
        let shape = String(decoding: try JSONSerialization.data(withJSONObject: filter, options: .sortedKeys), as: UTF8.self)
        return (try XCTUnwrap(parsed[1] as? String), keys, since, "\(parsed[0])|\(shape)")
    }

    private func drain() {
        let drained = expectation(description: "drained")
        DispatchQueue.main.async { DispatchQueue.main.async { drained.fulfill() } }
        wait(for: [drained], timeout: 2)
    }

    /// Opens `inbox` on stand-ins and, unless `ends` is false, has the relay answer every REQ to its end.
    private func opened(_ inbox: NostrInbox, ends: Bool = true, made: inout [StandIn]) -> Bool? {
        var sockets: [StandIn] = []
        inbox.connect = { url, _ in let s = StandIn(url, refuses: false); sockets.append(s); return s }
        var answer: Bool?
        inbox.open { answer = $0 }
        drain()
        if ends { for (place, _) in sockets.enumerated() { for ask in inbox.asks { inbox.took("[\"EOSE\",\"\(ask.subscription)\"]", relay: place) } } }
        drain()
        made += sockets
        return answer
    }

    /// Opened one day and the next, on the stand-in relays: every listen sends the same number of REQs, every REQ
    /// names exactly `askKeys` keys, the day's sixteen among fresh ones, in one shape and with the same `since`s
    /// whatever it carries; and the two days' REQs share no key, so a relay cannot tie the two listens together by
    /// what they asked (before the drop boxes, both named the delivery key).
    func testTwoDaysOfTheIDsREQsShareNoKey() throws {
        let q = try NostrCrypto.newKey()
        let nostr = try NostrCrypto.publicKey(of: q)
        let day = 20_400
        var reqs: [[String]] = []
        for d in [day, day + 1] {
            var made: [StandIn] = []
            let inbox = try dayInbox(q, days: [d], today: d)
            XCTAssertEqual(opened(inbox, made: &made), true)
            XCTAssertEqual(made.count, 1, "one relay a listen")
            reqs.append(made.flatMap(\.sent))
            inbox.close()
        }
        XCTAssertEqual(reqs[0].count, FoxyBridge.cashuIdAskCount)
        XCTAssertEqual(reqs[1].count, FoxyBridge.cashuIdAskCount)
        let one = try reqs[0].map { try parts(of: $0) }, two = try reqs[1].map { try parts(of: $0) }
        XCTAssertTrue((one + two).allSatisfy { $0.keys.count == NostrInbox.askKeys && $0.shape == one[0].shape }, "one shape, 48 keys")
        XCTAssertEqual(one.map(\.since).map { $0 + 86_400 }, two.map(\.since), "the same window, a day on")
        let k1 = Set(one.flatMap(\.keys)), k2 = Set(two.flatMap(\.keys))
        XCTAssertTrue(k1.isDisjoint(with: k2), "no key asked on both days")
        XCTAssertFalse(k1.union(k2).contains(NostrEvent.hex(nostr)), "never the delivery key itself")
        for (d, asked) in [(day, k1), (day + 1, k2)] {
            let real = try (0..<UInt8(CashuID.dropSlots)).map { NUT13.hex(try CashuID.dropKey(nostr: nostr, day: UInt32(d), slot: $0)) }
            XCTAssertTrue(Set(real).isSubset(of: asked), "the day's sixteen are asked")
            XCTAssertTrue(asked.allSatisfy { k in (try? NUT13.withContext { ctx in NUT13.isPoint([2] + (try NUT13.bytes(hex: k)), ctx) }) == true })
        }
        // a phone away thirty-three days: the same eleven REQs of the same size, every key real, none sharing a key
        var made: [StandIn] = []
        let away = try dayInbox(q, days: Array((day - 32)...day).reversed(), today: day)
        XCTAssertEqual(opened(away, made: &made), true)
        let all = try made.flatMap(\.sent).map { try parts(of: $0) }
        XCTAssertEqual(all.count, FoxyBridge.cashuIdAskCount)
        XCTAssertEqual(all.map(\.since), one.map(\.since))
        XCTAssertTrue(all.allSatisfy { $0.keys.count == NostrInbox.askKeys && $0.shape == one[0].shape })
        XCTAssertEqual(Set(all.flatMap(\.keys)).count, FoxyBridge.cashuIdAskCount * NostrInbox.askKeys)
        away.close()
    }

    /// A listen is answered only once the relay listening has ended every REQ (EOSE); one ended early, or one whose
    /// relay drops it half-way and has no other to go to, is never answered "listening", so the page asks the same
    /// days again. One whose relay drops it half-way moves to the next relay, which is asked every REQ again.
    func testTheIDsListenIsAnsweredOnlyWhenEveryREQHasEnded() throws {
        let q = try NostrCrypto.newKey()
        let day = 20_400
        // ended before the relay answered every REQ
        var made: [StandIn] = []
        var answer: Bool?
        let early = try dayInbox(q, days: [day], today: day)
        early.connect = { url, _ in let s = StandIn(url, refuses: false); made.append(s); return s }
        early.open { answer = $0 }
        drain()
        for ask in early.asks.dropLast() { early.took("[\"EOSE\",\"\(ask.subscription)\"]", relay: 0) }
        drain()
        XCTAssertNil(answer, "ten of eleven ended: not yet listening")
        early.close()
        early.took("[\"EOSE\",\"\(early.asks.last!.subscription)\"]", relay: 0)
        drain()
        XCTAssertNil(answer, "closed first: never answered (the bridge answers 0)")
        // the relay drops the socket after half: the next relay is asked all eleven, and its ends answer
        made = []
        answer = nil
        let cut = try dayInbox(q, days: [day], today: day)
        cut.connect = { url, _ in let s = StandIn(url, refuses: false); made.append(s); return s }
        cut.open { answer = $0 }
        drain()
        for ask in cut.asks.prefix(5) { cut.took("[\"EOSE\",\"\(ask.subscription)\"]", relay: 0) }
        cut.took("[\"CLOSED\",\"\(cut.asks[5].subscription)\",\"error: shutting down\"]", relay: 0)
        drain()
        XCTAssertNil(answer)
        XCTAssertEqual(made.count, 2)
        XCTAssertEqual(made[1].sent.count, FoxyBridge.cashuIdAskCount, "the next relay gets every REQ")
        for ask in cut.asks.prefix(10) { cut.took("[\"EOSE\",\"\(ask.subscription)\"]", relay: 1) }
        drain()
        XCTAssertNil(answer, "the first relay's five ends do not count at the second")
        cut.took("[\"EOSE\",\"\(cut.asks[10].subscription)\"]", relay: 1)
        drain()
        XCTAssertEqual(answer, true)
        cut.close()
    }

    /// A payment wrapped to a day's key, worked out from the delivery key alone as a payer does, opens; one to a
    /// filler key, or to the delivery key itself, opens nothing.
    func testAWrapToADaysKeyOpensAndNoOtherDoes() throws {
        let q = try NostrCrypto.newKey()
        let nostr = try NostrCrypto.publicKey(of: q)
        var got: [String] = []
        let inbox = try dayInbox(q, days: [20_400], today: 20_400) { got.append($0) }
        defer { inbox.close() }
        let to = try CashuID.dropKey(nostr: nostr, day: 20_400, slot: 9)
        let wrap = try NostrEvent.giftWrapped(payload: "{\"day\":1}", receiver: to)
        inbox.took(relayMessage(try NostrEvent.giftWrapped(payload: "{\"bare\":1}", receiver: nostr), for: inbox))
        let real = try (0..<UInt8(CashuID.dropSlots)).map { try CashuID.dropKey(nostr: nostr, day: 20_400, slot: $0) }
        let pad = try XCTUnwrap(inbox.asks[0].pubkeys.first { !real.contains($0) })
        inbox.took(relayMessage(try NostrEvent.giftWrapped(payload: "{\"pad\":1}", receiver: pad), for: inbox))
        XCTAssertEqual(got, [], "nothing but the day's keys opens")
        inbox.took(relayMessage(wrap, for: inbox))
        XCTAssertEqual(got, ["{\"day\":1}"])
    }

    /// The ID's inbox asks one relay, picked at random; one that fails is let go and the next asked, on a circuit of
    /// its own; one that refuses a REQ (CLOSED) moves it on again.
    func testTheIDsInboxAsksOneRelayAtRandomAndMovesOnWhenItFails() throws {
        let q = try NostrCrypto.newKey()
        var firsts = Set<String>()
        for _ in 0..<24 {
            var made: [StandIn] = []
            var circuits: [String] = []
            let inbox = try dayInbox(q, days: [20_400], today: 20_400)
            inbox.connect = { url, circuit in circuits.append(circuit); let s = StandIn(url, refuses: made.isEmpty); made.append(s); return s }
            var answer: Bool?
            inbox.open { answer = $0 }
            drain()
            XCTAssertEqual(made.count, 2, "the first failed, the second was asked")
            XCTAssertTrue(made[0].ended && !made[1].ended)
            XCTAssertNotEqual(made[0].url, made[1].url)
            XCTAssertEqual(Set(circuits).count, 2, "each on a circuit of its own")
            XCTAssertEqual(inbox.relaysListening, 1)
            XCTAssertNil(answer)
            firsts.insert(made[0].url.host ?? "")
            inbox.took("[\"CLOSED\",\"\(inbox.subscription)\",\"error: too many keys\"]", relay: 1)
            drain()
            XCTAssertEqual(made.count, 3)
            XCTAssertTrue(made[1].ended)
            XCTAssertEqual(Set(made.map(\.url)).count, 3, "three different relays")
            inbox.close()
        }
        XCTAssertEqual(firsts.count, NostrInbox.relays.count, "every relay is sometimes the one picked first")
    }

    /// A relay that answers the ID's REQs with a NOTICE (over its limits) is let go and the next one asked; one that
    /// takes the REQs and then never ends them is let go at the deadline, which each EOSE moves on; one that ends
    /// every REQ answers the listen. Nothing is answered "listening" before that.
    func testTheIDsInboxMovesOnFromARelayThatSendsANoticeOrHangs() throws {
        let q = try NostrCrypto.newKey()
        var made: [StandIn] = []
        var answer: Bool?
        let inbox = try dayInbox(q, days: [20_400], today: 20_400)
        inbox.relayDeadline = 0.4
        inbox.connect = { url, _ in let s = StandIn(url, refuses: false); made.append(s); return s }
        inbox.open { answer = $0 }
        drain()
        XCTAssertEqual(made.count, 1)
        // the first relay sends a NOTICE before ending its REQs
        inbox.took("[\"NOTICE\",\"ERROR: too many concurrent REQs\"]", relay: 0)
        drain()
        XCTAssertEqual(made.count, 2, "a notice moves the listen to the next relay")
        XCTAssertTrue(made[0].ended)
        XCTAssertNil(answer)
        // the second ends some REQs, each EOSE moving the deadline on, then hangs
        for ask in inbox.asks.prefix(3) {
            inbox.took("[\"EOSE\",\"\(ask.subscription)\"]", relay: 1)
            let step = expectation(description: "under the deadline")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { step.fulfill() }
            wait(for: [step], timeout: 2)
            XCTAssertEqual(made.count, 2, "each EOSE gives the relay the deadline again")
        }
        // waited for in small steps: the third relay's own deadline starts as soon as it is asked
        for _ in 0..<40 where made.count < 3 {
            let step = expectation(description: "a step")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { step.fulfill() }
            wait(for: [step], timeout: 2)
        }
        drain()
        XCTAssertEqual(made.count, 3, "a relay that hangs is let go at the deadline and the third asked")
        XCTAssertTrue(made[1].ended)
        XCTAssertNil(answer)
        XCTAssertEqual(made[2].sent.count, FoxyBridge.cashuIdAskCount, "the third is asked every REQ")
        for ask in inbox.asks { inbox.took("[\"EOSE\",\"\(ask.subscription)\"]", relay: 2) }
        drain()
        XCTAssertEqual(answer, true)
        // listening now: a later NOTICE, or the deadline passing, lets nothing go
        inbox.took("[\"NOTICE\",\"slow down\"]", relay: 2)
        let later = expectation(description: "after")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { later.fulfill() }
        wait(for: [later], timeout: 3)
        XCTAssertFalse(made[2].ended)
        inbox.close()
    }

    /// The ANY WALLET codes' inbox (`everyRelay`) listens at every relay at once, and says once, when a relay has
    /// ended every one of its REQs and every other relay it opened has too or has failed, that the codes were asked
    /// (the page marks them only then): another wallet may have posted to only one of the three.
    func testTheAnyWalletInboxListensAtEveryRelayAndSaysWhenItsREQsEnded() throws {
        let q = try NostrCrypto.newKey()
        let secrets = try CashuID.anySecrets(base: q, ids: (0..<50).map { [0, 0, 0, UInt8($0)] })
        let wanted = stride(from: 0, to: secrets.count, by: NostrInbox.askKeys).map {
            NostrInbox.Wanted(secrets: Array(secrets[$0..<min(secrets.count, $0 + NostrInbox.askKeys)]), since: 1000)
        }
        let inbox = try XCTUnwrap(NostrInbox(asks: wanted, label: "test any", pages: 8, everyRelay: true, onPayment: { _ in }))
        var ended = 0
        inbox.onEnded = { ended += 1 }
        var made: [StandIn] = []
        inbox.connect = { url, _ in let s = StandIn(url, refuses: false); made.append(s); return s }
        var answer: Bool?
        inbox.open { answer = $0 }
        drain()
        XCTAssertEqual(answer, true)
        XCTAssertEqual(made.count, NostrInbox.relays.count, "every relay")
        XCTAssertTrue(made.allSatisfy { $0.sent.count == 2 }, "two REQs of 48 for 50 codes")
        inbox.took("[\"EOSE\",\"\(inbox.asks[0].subscription)\"]", relay: 0)
        inbox.took("[\"EOSE\",\"\(inbox.asks[1].subscription)\"]", relay: 1)
        XCTAssertEqual(ended, 0, "no one relay has ended both")
        inbox.took("[\"EOSE\",\"\(inbox.asks[1].subscription)\"]", relay: 0)
        XCTAssertEqual(ended, 0, "one relay has ended both, the other two not yet")
        inbox.took("[\"EOSE\",\"\(inbox.asks[0].subscription)\"]", relay: 1)
        XCTAssertEqual(ended, 0, "two have, the third not yet")
        // the third fails: every relay opened has ended or failed
        inbox.took("[\"EOSE\",\"\(inbox.asks[0].subscription)\"]", relay: 2)
        XCTAssertEqual(ended, 0)
        let third = try XCTUnwrap(made.last)
        XCTAssertFalse(third.ended)
        inbox.close()
        XCTAssertEqual(ended, 0, "closed first: never said")
        // again, the third relay's socket dying after its first REQ: said once the other two have ended
        let again = try XCTUnwrap(NostrInbox(asks: wanted, label: "test any", pages: 8, everyRelay: true, onPayment: { _ in }))
        var said = 0
        again.onEnded = { said += 1 }
        var sockets: [DyingStandIn] = []
        again.connect = { url, _ in let s = DyingStandIn(url); sockets.append(s); return s }
        again.open { _ in }
        drain()
        for place in 0..<2 { for ask in again.asks { again.took("[\"EOSE\",\"\(ask.subscription)\"]", relay: place) } }
        XCTAssertEqual(said, 0, "the third has neither ended nor failed")
        sockets[2].die()
        drain()
        XCTAssertEqual(said, 1, "said once every relay opened has ended or failed")
        again.close()
    }

    /// A stand-in whose read can be made to fail, as a socket that dies does.
    final class DyingStandIn: NostrRelaySocket {
        let url: URL
        var sent: [String] = []
        private var reader: ((Swift.Result<String, Error>) -> Void)?
        init(_ url: URL) { self.url = url }
        func sendText(_ text: String, _ done: @escaping (Error?) -> Void) { sent.append(text); done(nil) }
        func receiveText(_ done: @escaping (Swift.Result<String, Error>) -> Void) { reader = done }
        func end() {}
        func die() { let r = reader; reader = nil; r?(.failure(URLError(.networkConnectionLost))) }
    }

    /// The deadline counts from the first REQ having gone, not from the socket being asked for (a slow circuit and
    /// handshake are not the relay's silence), and each wrap streaming in starts it again as each EOSE does.
    func testTheIDsRelayDeadlineStartsWhenTheREQsHaveGoneAndEachWrapMovesItOn() throws {
        let q = try NostrCrypto.newKey()
        var made: [StandIn] = []
        var answer: Bool?
        let inbox = try dayInbox(q, days: [20_400], today: 20_400)
        inbox.relayDeadline = 0.4
        inbox.connect = { url, _ in let s = StandIn(url, refuses: false, sendDelay: made.isEmpty ? 0.6 : 0); made.append(s); return s }
        inbox.open { answer = $0 }
        func pause(_ t: TimeInterval) {
            let e = expectation(description: "pause")
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { e.fulfill() }
            wait(for: [e], timeout: t + 2)
        }
        pause(0.8)
        XCTAssertEqual(made.count, 1, "0.6 s to send the first REQ is not counted against a 0.4 s deadline")
        // a backlog streaming in, a wrap every 0.25 s for a second and more, before the first EOSE
        for _ in 0..<5 {
            inbox.took("[\"EVENT\",\"\(inbox.asks[0].subscription)\",{}]", relay: 0)
            pause(0.25)
        }
        XCTAssertEqual(made.count, 1, "each wrap starts the deadline again")
        XCTAssertNil(answer)
        // then nothing: let go at the deadline
        for _ in 0..<40 where made.count < 2 { pause(0.05) }
        drain()
        XCTAssertEqual(made.count, 2)
        XCTAssertTrue(made[0].ended)
        for ask in inbox.asks { inbox.took("[\"EOSE\",\"\(ask.subscription)\"]", relay: 1) }
        drain()
        XCTAssertEqual(answer, true)
        inbox.close()
    }

    // MARK: a relay Tor cannot reach

    /// A relay's socket for these tests: says what it was sent, fails every send
    /// when `refuses` (as a socket whose connection through Tor never opened
    /// does), and never answers a read.
    final class StandIn: NostrRelaySocket {
        let url: URL
        let refuses: Bool
        /// How long a send takes to go (a circuit and a handshake through Tor); none by default.
        let sendDelay: TimeInterval
        var sent: [String] = []
        var ended = false
        init(_ url: URL, refuses: Bool, sendDelay: TimeInterval = 0) { self.url = url; self.refuses = refuses; self.sendDelay = sendDelay }
        func sendText(_ text: String, _ done: @escaping (Error?) -> Void) {
            sent.append(text)
            let error: Error? = refuses ? URLError(.badURL) : nil
            if sendDelay > 0 { DispatchQueue.global().asyncAfter(deadline: .now() + sendDelay) { done(error) } } else { done(error) }
        }
        func receiveText(_ done: @escaping (Swift.Result<String, Error>) -> Void) {}
        func end() { ended = true }
    }

    /// A relay that fails the upgrade (its first send fails) is given up at
    /// once: one ask and no more, its socket let go, nothing later sent to it,
    /// while the others are listening with the ask in hand.
    func testARelayThatFailsIsGivenUpAtOnceAndTheOthersStillGetTheAsk() throws {
        var made: [StandIn] = []
        let inbox = try XCTUnwrap(NostrInbox(secret: try NostrCrypto.newKey(), since: 1000, label: "test inbox",
                                             pages: 3, onPayment: { _ in }))
        defer { inbox.close() }
        let dead = URL(string: NostrInbox.relays[1])!.host!
        inbox.connect = { url, _ in
            let s = StandIn(url, refuses: url.host == dead)
            made.append(s)
            return s
        }
        let opened = expectation(description: "open answers")
        var answer: Bool?
        inbox.open { ok in answer = ok; opened.fulfill() }
        wait(for: [opened], timeout: 2)
        // let every send's answer reach the main queue
        let drained = expectation(description: "main queue drained")
        DispatchQueue.main.async { DispatchQueue.main.async { drained.fulfill() } }
        wait(for: [drained], timeout: 2)

        XCTAssertEqual(answer, true, "the inbox listens on the relays that answered")
        XCTAssertEqual(made.count, NostrInbox.relays.count)
        for s in made {
            XCTAssertEqual(s.sent.count, 1, "\(s.url.host!) was asked once")
            XCTAssertTrue(s.sent.first?.hasPrefix("[\"REQ\"") ?? false)
            XCTAssertEqual(s.ended, s.url.host == dead, "only the relay that failed is let go: \(s.url.host!)")
        }
        XCTAssertEqual(inbox.relaysListening, NostrInbox.relays.count - 1)
        // nothing more goes to it: not the next page's ask
        inbox.sendAsk?(1, "[\"REQ\",\"later\"]")
        XCTAssertEqual(made.first { $0.url.host == dead }?.sent.count, 1, "no second ask to a relay given up")
    }

    /// Every relay failing: the inbox says so, and is not left claiming to be open.
    func testAnInboxWhoseRelaysAllFailIsNotOpen() throws {
        var made: [StandIn] = []
        let inbox = try XCTUnwrap(NostrInbox(secret: try NostrCrypto.newKey(), since: 1000, label: "test inbox",
                                             onPayment: { _ in }))
        defer { inbox.close() }
        inbox.connect = { url, _ in let s = StandIn(url, refuses: true); made.append(s); return s }
        let opened = expectation(description: "open answers")
        var answer: Bool?
        inbox.open { ok in answer = ok; opened.fulfill() }
        wait(for: [opened], timeout: 2)
        XCTAssertEqual(answer, false)
        XCTAssertFalse(inbox.isOpen, "no relay is listening")
        XCTAssertTrue(made.allSatisfy { $0.ended && $0.sent.count == 1 })
    }

    /// The cause of "bad URL": URLSession reports a SOCKS proxy that refuses the
    /// connection (Tor's answer when no exit could reach the relay) as
    /// NSURLErrorBadURL on the websocket's first send. A proxy on loopback that
    /// refuses every connection, with each of the refusals Tor gives.
    func testASocksRefusalReachesTheSendAsBadURL() throws {
        for code: UInt8 in [1, 4, 5, 6] {
            let proxy = try RefusingSocks(code: code)
            defer { proxy.stop() }
            let cfg = URLSessionConfiguration.ephemeral
            var config = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: proxy.port)!))
            config.allowFailover = false
            cfg.proxyConfigurations = [config]
            cfg.timeoutIntervalForRequest = 10
            let session = URLSession(configuration: cfg)
            defer { session.invalidateAndCancel() }
            let task = session.webSocketTask(with: URL(string: "wss://relay.example.com")!)
            task.resume()
            let sent = expectation(description: "send answers")
            var failure: Error?
            task.send(.string("[\"REQ\",\"x\",{}]")) { failure = $0; sent.fulfill() }
            wait(for: [sent], timeout: 15)
            let e = try XCTUnwrap(failure, "SOCKS code \(code): the send did not fail") as NSError
            XCTAssertEqual(e.domain, NSURLErrorDomain)
            XCTAssertEqual(e.code, NSURLErrorBadURL, "SOCKS code \(code)")
            XCTAssertTrue(NostrInbox.whyNot(e).hasPrefix("could not be reached through Tor"))
        }
    }

    /// A SOCKS5 proxy on loopback that takes the greeting and the login, then
    /// refuses every CONNECT with `code`.
    final class RefusingSocks {
        let port: UInt16
        private let fd: Int32
        private var stopped = false
        init(code: UInt8) throws {
            let fd = socket(AF_INET, SOCK_STREAM, 0)
            self.fd = fd
            var addr = sockaddr_in()
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_addr.s_addr = inet_addr("127.0.0.1")
            addr.sin_port = 0
            let bound = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
            guard bound == 0, listen(fd, 8) == 0 else { throw URLError(.cannotConnectToHost) }
            var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            _ = withUnsafeMutablePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
            }
            port = UInt16(bigEndian: addr.sin_port)
            let listening = fd
            Thread.detachNewThread {
                while true {
                    let c = accept(listening, nil, nil)
                    if c < 0 { return }
                    Thread.detachNewThread { RefusingSocks.refuse(c, code: code) }
                }
            }
        }
        private static func refuse(_ c: Int32, code: UInt8) {
            defer { close(c) }
            func read(_ n: Int) -> [UInt8]? {
                var out = [UInt8](repeating: 0, count: n)
                var got = 0
                while got < n {
                    let r = out.withUnsafeMutableBytes { recv(c, $0.baseAddress! + got, n - got, 0) }
                    if r <= 0 { return nil }
                    got += r
                }
                return out
            }
            func write(_ b: [UInt8]) { _ = b.withUnsafeBytes { send(c, $0.baseAddress!, b.count, 0) } }
            guard let hello = read(2), hello[0] == 5, let methods = read(Int(hello[1])) else { return }
            if methods.contains(2) {
                write([5, 2])
                guard let v = read(2), let _ = read(Int(v[1])), let pl = read(1), let _ = read(Int(pl[0])) else { return }
                write([1, 0])
            } else {
                write([5, 0])
            }
            guard let head = read(4) else { return }
            switch head[3] {
            case 1: _ = read(4 + 2)
            case 3: guard let l = read(1), let _ = read(Int(l[0]) + 2) else { return }
            case 4: _ = read(16 + 2)
            default: return
            }
            write([5, code, 0, 1, 0, 0, 0, 0, 0, 0])
            usleep(300_000)
        }
        func stop() {
            guard !stopped else { return }
            stopped = true
            shutdown(fd, SHUT_RDWR)
            close(fd)
        }
    }
}
