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

    // MARK: paging back (the Cashu ID's inbox, M1)

    /// A relay answers at most `limit` wraps to one REQ. The Cashu ID's inbox
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


    // MARK: an inbox on many keys (messages between Cashu IDs, CashuMsg.swift)

    /// One REQ, a filter for each hundred keys, and a wrap opened only by the key its p tag names, its rumor handed
    /// over with that key and its seal's author, never to onPayment.
    func testAnInboxOnManyKeys() throws {
        let keys = try (0..<3).map { _ in try NostrCrypto.newKey() }
        let pubs = try keys.map { try NostrCrypto.publicKey(of: $0) }
        var got: [(String, NostrEvent.Event)] = []
        let inbox = try XCTUnwrap(NostrInbox(keys: keys, since: 1000, label: "messages", onRumor: { got.append(($0, $1)) }))
        defer { inbox.close() }
        XCTAssertEqual(inbox.pubkeys.count, 3)
        let many = (0..<150).map { _ in [UInt8](repeating: 2, count: 32) }
        let req = NostrInbox.askMany(subscription: "s", pubkeys: many, since: 5, limit: 500)
        XCTAssertTrue(req.hasPrefix("[\"REQ\",\"s\",{\"kinds\":[1059],\"#p\":["))
        XCTAssertEqual(req.components(separatedBy: "{\"kinds\"").count - 1, 2, "150 keys: two filters")
        // a wrap to the second key, sealed by a key the test chose
        let seal = try NostrCrypto.newKey()
        let wrap = try NostrEvent.giftWrapped(payload: "{\"v\":1}", receiver: pubs[1], seal: seal)
        inbox.took("[\"EVENT\",\"\(inbox.subscription)\",\(NostrEvent.json(wrap))]")
        XCTAssertEqual(got.count, 1)
        XCTAssertEqual(got.first?.0, NostrEvent.hex(pubs[1]))
        XCTAssertEqual(got.first?.1.pubkey, NostrEvent.hex(try NostrCrypto.publicKey(of: seal)))
        XCTAssertEqual(got.first?.1.content, "{\"v\":1}")
        // the same wrap again is one message; a wrap to a key not listened on is nothing
        inbox.took("[\"EVENT\",\"\(inbox.subscription)\",\(NostrEvent.json(wrap))]")
        let other = try NostrEvent.giftWrapped(payload: "{}", receiver: try NostrCrypto.publicKey(of: try NostrCrypto.newKey()))
        inbox.took("[\"EVENT\",\"\(inbox.subscription)\",\(NostrEvent.json(other))]")
        XCTAssertEqual(got.count, 1)
    }

    // MARK: a relay Tor cannot reach

    /// A relay's socket for these tests: says what it was sent, fails every send
    /// when `refuses` (as a socket whose connection through Tor never opened
    /// does), and never answers a read.
    final class StandIn: NostrRelaySocket {
        let url: URL
        let refuses: Bool
        var sent: [String] = []
        var ended = false
        init(_ url: URL, refuses: Bool) { self.url = url; self.refuses = refuses }
        func sendText(_ text: String, _ done: @escaping (Error?) -> Void) {
            sent.append(text)
            done(refuses ? URLError(.badURL) : nil)
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
