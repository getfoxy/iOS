import XCTest
@testable import Foxy

/// Listening for messages between Cashu IDs (CashuMsgListen.swift): what a relay is shown. One REQ for each contact,
/// never two contacts' keys in one filter, one relay for each contact from its own rotation, a circuit for each, a
/// `since` every phone shares all day, the opens and retries spread over a window by a stand-in clock, a failed or
/// closed relay tried once more at another, a deaf contact tried again later, and at most six opening at once.
final class CashuMsgListenTests: XCTestCase {

    /// A relay's socket: what it was sent, on which circuit; its first send answered at once (refused or taken), or
    /// held until the test answers it.
    final class Socket: NostrRelaySocket {
        let url: URL
        let circuit: String
        let refuses: Bool
        let holds: Bool
        var sent: [String] = []
        var ended = false
        var held: ((Error?) -> Void)?
        var reading: ((Swift.Result<String, Error>) -> Void)?
        init(_ url: URL, _ circuit: String, refuses: Bool, holds: Bool) {
            self.url = url; self.circuit = circuit; self.refuses = refuses; self.holds = holds
        }
        func sendText(_ text: String, _ done: @escaping (Error?) -> Void) {
            sent.append(text)
            if holds { held = done; return }
            done(refuses ? URLError(.badURL) : nil)
        }
        func receiveText(_ done: @escaping (Swift.Result<String, Error>) -> Void) { reading = done }
        func end() { ended = true }
        private var request: [Any] {
            guard let first = sent.first, let data = first.data(using: .utf8),
                  let parts = try? JSONSerialization.jsonObject(with: data) as? [Any] else { return [] }
            return parts
        }
        /// The `#p` keys of every filter of its REQ, one set a filter.
        var filters: [Set<String>] {
            request.dropFirst(2).compactMap { ($0 as? [String: Any])?["#p"] as? [String] }.map(Set.init)
        }
        var sinces: [Int] { request.dropFirst(2).compactMap { ($0 as? [String: Any])?["since"] as? Int } }
        var subscription: String { request.count > 1 ? (request[1] as? String ?? "") : "" }
        var host: String { url.host ?? "" }
    }

    /// A listener whose clock, draws and sockets are the test's.
    final class Rig {
        var timers: [(delay: TimeInterval, run: () -> Void)] = []
        var sockets: [Socket] = []
        var refused: Set<String> = []
        /// Hosts for which no socket can be made at all (no route).
        var unrouted = false
        var hold = false
        var picks: [Int] = []
        var fractions: [Double] = []
        var drawn: [Double] = []
        var orders: [[Int]] = []
        var heard: [(String, Bool, UInt32, String)] = []
        let listen: CashuMsgListen

        init(realDraws: Bool = false) {
            var heardHere: (String, Bool, UInt32, String) -> Void = { _, _, _, _ in }
            listen = CashuMsgListen(onMessage: { heardHere($0, $1, $2, $3) })
            heardHere = { [unowned self] in self.heard.append(($0, $1, $2, $3)) }
            listen.after = { [unowned self] delay, run in self.timers.append((delay, run)) }
            if !realDraws {
                listen.fraction = { [unowned self] in
                    let f = self.fractions.isEmpty ? 0.5 : self.fractions.removeFirst()
                    self.drawn.append(f)
                    return f
                }
                listen.pick = { [unowned self] n in self.picks.isEmpty ? 0 : min(n - 1, self.picks.removeFirst()) }
                listen.rotation.shuffle = { [unowned self] in self.orders.isEmpty ? $0 : self.orders.removeFirst() }
            }
            listen.connect = { [unowned self] url, circuit in
                if self.unrouted { return nil }
                let s = Socket(url, circuit, refuses: self.refused.contains(url.host!), holds: self.hold)
                self.sockets.append(s)
                return s
            }
        }

        func go(_ people: [String: [CashuMsg.Listened]], since: Int = 1_800_000_123, answer: @escaping (Int) -> Void = { _ in }) {
            var p = people
            listen.listen(&p, since: since, answer: answer)
        }

        /// Runs the timers `which` picks that are due now (not those they add), and lets the main queue run.
        func fire(_ which: (TimeInterval) -> Bool) {
            let due = timers.filter { which($0.delay) }
            timers.removeAll { which($0.delay) }
            for t in due { t.run() }
            drain()
        }
        /// The waits before an open (never as long as the 20 s window's ceiling).
        func fire() { fire { $0 < CashuMsgListen.windowMost } }
        var waits: [TimeInterval] { timers.map { $0.delay }.filter { $0 < CashuMsgListen.windowMost } }
        func drain() { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    }

    /// `n` keys for one contact, with seals the test holds.
    static func contact(_ peer: String, keys n: Int) throws -> (keys: [CashuMsg.Listened], seals: [[UInt8]]) {
        var keys = [CashuMsg.Listened]()
        var seals = [[UInt8]]()
        for i in 0..<n {
            let seal = try NostrCrypto.newKey()
            seals.append(seal)
            keys.append(CashuMsg.Listened(peer: peer, inward: i % 2 == 0, index: UInt32(i), secret: try NostrCrypto.newKey(),
                                          seal: try NostrCrypto.publicKey(of: seal)))
        }
        return (keys, seals)
    }
    func contact(_ peer: String, keys n: Int) throws -> (keys: [CashuMsg.Listened], seals: [[UInt8]]) {
        try Self.contact(peer, keys: n)
    }

    static func names(_ keys: [CashuMsg.Listened]) throws -> Set<String> {
        Set(try keys.map { NostrEvent.hex(try NostrCrypto.publicKey(of: $0.secret)) })
    }
    func names(_ keys: [CashuMsg.Listened]) throws -> Set<String> { try Self.names(keys) }

    func many(_ n: Int, keys: Int = 1) throws -> [String: [CashuMsg.Listened]] {
        var people = [String: [CashuMsg.Listened]]()
        for i in 0..<n { let p = String(format: "%02x", i); people[p] = try contact(p, keys: keys).keys }
        return people
    }

    // MARK: what a relay is shown

    /// Three contacts: three sockets, each with one REQ naming exactly one contact's keys, each at one relay, each on
    /// its own circuit; no filter anywhere holds two contacts' keys.
    func testOneREQPerContactAtOneRelayOnItsOwnCircuit() throws {
        let rig = Rig()
        var people = [String: [CashuMsg.Listened]]()
        for p in ["aa", "bb", "cc"] { people[p] = try contact(p, keys: 8).keys }
        var answer: Int?
        rig.go(people) { answer = $0 }
        XCTAssertTrue(rig.sockets.isEmpty, "nothing opens before its wait")
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 3, "one socket a contact, at one relay")
        var seen = Set<String>()
        for s in rig.sockets {
            XCTAssertEqual(s.sent.count, 1)
            XCTAssertEqual(s.filters.count, 1)
            let asked = s.filters.reduce(Set<String>()) { $0.union($1) }
            let whose = try people.filter { try names($0.value) == asked }
            XCTAssertEqual(whose.count, 1, "a REQ names one contact's keys, all of them, and nobody else's")
            seen.insert(whose.keys.first ?? "")
        }
        XCTAssertEqual(seen, ["aa", "bb", "cc"])
        XCTAssertEqual(Set(rig.sockets.map { $0.circuit }).count, 3, "a circuit for each contact")
        XCTAssertEqual(Set(rig.sockets.map { $0.subscription }).count, 3, "a subscription for each contact")
        XCTAssertTrue(rig.sockets.allSatisfy { NostrInbox.relays.contains("wss://" + $0.host) })
        XCTAssertEqual(answer, 1)
        XCTAssertEqual(rig.listen.listening, 3)
        rig.listen.close()
        XCTAssertTrue(rig.sockets.allSatisfy { $0.ended })
    }

    /// Every REQ of a listen asks from the start of the day before, the same for every phone all day, never from the
    /// page's own second, which named the moment the listen began and was the same in every contact's REQ.
    func testEveryREQAsksFromTheDayNotTheListensSecond() throws {
        let t = 1_800_000_123
        let day = (t / 86_400) * 86_400 - 86_400
        XCTAssertEqual(CashuMsgListen.commonSince(t), day)
        XCTAssertEqual(CashuMsgListen.commonSince(t + 3_000), day, "the same value all day")
        let rig = Rig()
        rig.go(try many(3, keys: 2), since: t)
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 3)
        for s in rig.sockets {
            XCTAssertEqual(s.sinces, [day])
            XCTAssertEqual((s.sinces.first ?? 1) % 86_400, 0)
            XCTAssertFalse(s.sinces.contains(t), "never the page's second")
        }
        rig.listen.close()
    }

    /// The first relay is the contact's rotation's; with real draws, contacts land on different relays.
    func testTheRelayComesFromTheContactsRotationAndContactsLandApart() throws {
        for place in 0..<NostrInbox.relays.count {
            let rig = Rig()
            var order = [0, 1, 2]
            order.swapAt(0, place)
            rig.orders = [order]
            rig.go(["aa": try contact("aa", keys: 2).keys])
            rig.fire()
            XCTAssertEqual(rig.sockets.map { "wss://" + $0.host }, [NostrInbox.relays[place]])
            rig.listen.close()
        }
        let real = Rig(realDraws: true)
        real.go(try many(30))
        real.fire()
        XCTAssertEqual(real.sockets.count, 30)
        XCTAssertGreaterThan(Set(real.sockets.map { $0.host }).count, 1, "thirty contacts, each its own draw, not one relay for all")
        real.listen.close()
    }

    /// One contact reopened three times (its keys moving on each time) has been asked at every relay; two contacts'
    /// orders are their own, never one counter.
    func testRotationCoversTheThreeInThreeReopeningsAndIsEachContactsOwn() throws {
        let real = Rig(realDraws: true)
        for _ in 0..<3 {
            real.go(["aa": try contact("aa", keys: 2).keys])
            real.fire()
        }
        XCTAssertEqual(real.sockets.count, 3)
        XCTAssertEqual(Set(real.sockets.map { $0.host }).count, 3, "every relay within three reopenings")
        real.listen.close()

        let r = CashuMsgRotation()
        r.shuffle = { $0 }
        XCTAssertEqual(r.next("a", of: 3), 0)
        XCTAssertEqual(r.next("b", of: 3), 0, "b's order is its own: a's turn did not move it")
        XCTAssertEqual(r.next("a", of: 3), 1)
        XCTAssertEqual(r.next("a", of: 3), 2)
        XCTAssertEqual(r.next("b", of: 3), 1)
        var shuffled = 0
        r.shuffle = { (_: [Int]) -> [Int] in shuffled += 1; return [2, 0, 1] }
        XCTAssertEqual(r.next("a", of: 3), 2, "used up: a new order")
        XCTAssertEqual(shuffled, 1)
        // real shuffles: two contacts' orders differ somewhere among many
        let free = CashuMsgRotation()
        let firsts = Set((0..<40).map { free.next("p\($0)", of: 3) })
        XCTAssertGreaterThan(firsts.count, 1)
    }

    /// Each contact's open waits its own fraction × window, the window 3 s and 0.4 s a contact up to 20 s; nothing
    /// connects until its wait is over; real draws give two contacts different waits.
    func testTheOpensAreSpreadOverAWindowThatGrowsWithTheContacts() throws {
        XCTAssertEqual(CashuMsgListen.window(contacts: 1), 3.4, accuracy: 1e-9)
        XCTAssertEqual(CashuMsgListen.window(contacts: 10), 7, accuracy: 1e-9)
        XCTAssertEqual(CashuMsgListen.window(contacts: 40), 19, accuracy: 1e-9)
        XCTAssertEqual(CashuMsgListen.window(contacts: 60), 20, accuracy: 1e-9)
        XCTAssertLessThan(CashuMsgListen.answerBy, 70)
        let rig = Rig()
        rig.fractions = (0..<10).map { Double($0) / 10 }
        rig.go(try many(10))
        let waits = rig.waits.sorted()
        XCTAssertEqual(waits.count, 10, "a wait for each contact")
        for (i, w) in waits.enumerated() { XCTAssertEqual(w, Double(i) / 10 * 7, accuracy: 1e-9, "each its own draw") }
        XCTAssertTrue(rig.timers.contains { $0.delay == CashuMsgListen.answerBy }, "the page's answer has its own deadline")
        rig.drain()
        XCTAssertTrue(rig.sockets.isEmpty, "nothing connects before its wait is over")
        rig.listen.close()

        let real = Rig(realDraws: true)
        real.go(try many(2))
        XCTAssertEqual(real.waits.count, 2)
        XCTAssertNotEqual(real.waits[0], real.waits[1], "two contacts, two draws")
        real.listen.close()
    }

    // MARK: failing relays

    /// A relay that refuses is tried once more at another, on a fresh circuit, and no more: both refusing, the contact
    /// is deaf, and with nobody listening the answer is 0.
    func testARefusedRelayIsTriedOnceMoreAtAnother() throws {
        let rig = Rig()
        let first = URL(string: NostrInbox.relays[0])!.host!
        rig.refused = [first]
        rig.picks = [0]
        var answer: Int?
        rig.go(["aa": try contact("aa", keys: 2).keys]) { answer = $0 }
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 2)
        XCTAssertEqual(rig.sockets[0].host, first)
        XCTAssertNotEqual(rig.sockets[1].host, first, "the second try is at another relay")
        XCTAssertNotEqual(rig.sockets[0].circuit, rig.sockets[1].circuit)
        XCTAssertEqual(rig.sockets[0].filters, rig.sockets[1].filters, "the same keys")
        XCTAssertEqual(answer, 1)

        let both = Rig()
        both.refused = Set(NostrInbox.relays.map { URL(string: $0)!.host! })
        var none: Int?
        both.go(["aa": try contact("aa", keys: 2).keys]) { none = $0 }
        both.fire()
        XCTAssertEqual(both.sockets.count, CashuMsgListen.triesEach, "two relays tried, not three")
        XCTAssertEqual(none, 0)
        XCTAssertEqual(both.listen.openingNow, 0)
        both.listen.close()
    }

    /// A relay that closes this contact's request (rate-limited, auth-required) is a dead socket: let go, and the
    /// contact tried at another after its own wait.
    func testAClosedRequestIsTriedAtAnotherRelay() throws {
        let rig = Rig()
        rig.go(["aa": try contact("aa", keys: 2).keys])
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 1)
        let s = rig.sockets[0]
        s.reading?(.success("[\"CLOSED\",\"\(s.subscription)\",\"rate-limited: slow down\"]"))
        rig.drain()
        XCTAssertTrue(s.ended, "the relay that closed the request is let go")
        XCTAssertEqual(rig.listen.listening, 0)
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 2)
        XCTAssertNotEqual(rig.sockets[1].host, s.host)
        XCTAssertEqual(rig.listen.listening, 1)
        // another subscription's CLOSED is nothing
        rig.sockets[1].reading?(.success("[\"CLOSED\",\"not-ours\",\"x\"]"))
        rig.drain()
        XCTAssertFalse(rig.sockets[1].ended)
        rig.listen.close()
    }

    /// Five sockets dying together (a relay restarting, the network changing): nothing reopens at once; each waits
    /// its own draw, and only then opens at another relay.
    func testRetriesAfterADropWaitTheirOwnTime() throws {
        let rig = Rig()
        rig.go(try many(5))
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 5)
        rig.fractions = [0.1, 0.3, 0.5, 0.7, 0.9]
        rig.drawn = []
        for s in rig.sockets { s.reading?(.failure(URLError(.networkConnectionLost))) }
        rig.drain()
        XCTAssertEqual(rig.sockets.count, 5, "no retry opens before its wait")
        XCTAssertEqual(rig.drawn, [0.1, 0.3, 0.5, 0.7, 0.9], "five draws, one each")
        XCTAssertEqual(Set(rig.waits).count, 5, "five different waits")
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 10)
        for (old, new) in zip(rig.sockets[0..<5], rig.sockets[5..<10]) where old.filters == new.filters {
            XCTAssertNotEqual(old.host, new.host)
        }
        XCTAssertEqual(rig.listen.listening, 5)
        // a second drop is once too many: deaf
        for s in rig.sockets[5..<10] { s.reading?(.failure(URLError(.networkConnectionLost))) }
        rig.drain()
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 10)
        XCTAssertEqual(rig.listen.listening, 0)
        rig.listen.close()
    }

    /// With no route (Tor not running) no socket is made: that is not a try at a relay. The contact is tried again
    /// later with both of its tries.
    func testATryWithNoRouteIsNotCounted() throws {
        let rig = Rig()
        rig.unrouted = true
        var answer: Int?
        rig.go(["aa": try contact("aa", keys: 2).keys]) { answer = $0 }
        rig.fire()
        XCTAssertEqual(answer, 0)
        XCTAssertEqual(rig.listen.openingNow, 0)
        rig.unrouted = false
        let first = URL(string: NostrInbox.relays[1])!.host!
        rig.refused = [first]
        rig.fire { $0 == CashuMsgListen.reviveAfter[0] }
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 2, "both tries are still there: the refused relay, then another")
        XCTAssertEqual(rig.listen.listening, 1)
        rig.listen.close()
    }

    /// A deaf contact is tried again after two minutes, then ten, while the listener is open.
    func testADeafContactIsTriedAgainAfterTwoThenTenMinutes() throws {
        let rig = Rig()
        rig.refused = Set(NostrInbox.relays.map { URL(string: $0)!.host! })
        rig.go(["aa": try contact("aa", keys: 2).keys])
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 2)
        XCTAssertTrue(rig.timers.contains { $0.delay == 120 })
        rig.fire { $0 == 120 }
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 4, "two minutes on: two more tries")
        XCTAssertTrue(rig.timers.contains { $0.delay == 600 }, "then ten minutes")
        XCTAssertFalse(rig.timers.contains { $0.delay == 120 })
        rig.refused = []
        rig.fire { $0 == 600 }
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 5)
        XCTAssertEqual(rig.listen.listening, 1)
        // closed: a revival does nothing
        rig.listen.close()
        let after = Rig()
        after.refused = rig.refused.union(Set(NostrInbox.relays.map { URL(string: $0)!.host! }))
        after.go(["aa": try contact("aa", keys: 2).keys])
        after.fire()
        after.listen.close()
        after.fire { $0 == 120 }
        after.fire()
        XCTAssertEqual(after.sockets.count, 2)
    }

    /// A relay that never answers holds its place for 20 s, then counts as a failed try and lets the next try go.
    func testAHungOpenGivesUpItsPlaceAfterTwentySeconds() throws {
        let rig = Rig()
        rig.hold = true
        rig.go(try many(7))
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 6)
        let hung = rig.sockets[0]
        rig.fire { $0 == CashuMsgListen.attemptBy }
        XCTAssertTrue(hung.ended, "the hung socket is let go")
        XCTAssertGreaterThan(rig.sockets.count, 6, "the tries go on")
        XCTAssertEqual(rig.listen.openingNow, 6)
        rig.listen.close()
    }

    /// A relay that goes after it listened is replaced once at another.
    func testARelayThatGoesIsReplacedOnceAtAnother() throws {
        let rig = Rig()
        rig.go(["aa": try contact("aa", keys: 2).keys])
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 1)
        rig.sockets[0].reading?(.failure(URLError(.networkConnectionLost)))
        rig.drain()
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 2)
        XCTAssertNotEqual(rig.sockets[1].host, rig.sockets[0].host)
        XCTAssertEqual(rig.listen.listening, 1)
        rig.sockets[1].reading?(.failure(URLError(.networkConnectionLost)))
        rig.drain()
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 2, "once, and no more in this go")
        XCTAssertEqual(rig.listen.listening, 0)
        rig.listen.close()
    }

    /// Ten contacts whose relays have not answered: six open, the other four wait; one answering lets the seventh in.
    func testAtMostSixOpenAtOnce() throws {
        let rig = Rig()
        rig.hold = true
        rig.go(try many(10))
        rig.fire()
        XCTAssertEqual(CashuMsgListen.mostAtOnce, 6)
        XCTAssertEqual(rig.sockets.count, 6)
        XCTAssertEqual(rig.listen.openingNow, 6)
        rig.sockets[0].held?(nil)
        rig.drain()
        XCTAssertEqual(rig.sockets.count, 7, "one listening lets the next open")
        rig.sockets[1].held?(URLError(.badURL))
        rig.drain()
        XCTAssertEqual(rig.sockets.count, 8, "a retry keeps its place: one more socket, the retry's")
        XCTAssertEqual(rig.listen.openingNow, 6)
        rig.listen.close()
        XCTAssertEqual(rig.listen.openingNow, 0)
    }

    // MARK: what reaches the page

    /// A wrap to a contact's key is handed on with the contact, its way and index; one sealed by another key is not.
    func testAMessageReachesThePageWithItsKeyAndASealByAnotherIsDropped() throws {
        let rig = Rig()
        let a = try contact("aa", keys: 2)
        let b = try contact("bb", keys: 2)
        rig.go(["aa": a.keys, "bb": b.keys])
        rig.fire()
        let to = try NostrCrypto.publicKey(of: b.keys[1].secret)
        let socket = try XCTUnwrap(rig.sockets.first { $0.filters.first?.contains(NostrEvent.hex(to)) ?? false })
        let good = try NostrEvent.giftWrapped(payload: "{\"hi\":1}", receiver: to, seal: b.seals[1])
        socket.reading?(.success("[\"EVENT\",\"\(socket.subscription)\",\(NostrEvent.json(good))]"))
        rig.drain()
        XCTAssertEqual(rig.heard.count, 1)
        XCTAssertEqual(rig.heard.first?.0, "bb")
        XCTAssertEqual(rig.heard.first?.1, false)
        XCTAssertEqual(rig.heard.first?.2, 1)
        XCTAssertEqual(rig.heard.first?.3, "{\"hi\":1}")
        let forged = try NostrEvent.giftWrapped(payload: "{}", receiver: to, seal: try NostrCrypto.newKey())
        socket.reading?(.success("[\"EVENT\",\"\(socket.subscription)\",\(NostrEvent.json(forged))]"))
        rig.drain()
        XCTAssertEqual(rig.heard.count, 1, "a seal by another key is dropped")
        rig.listen.close()
    }

    /// A second listen with one contact's keys moved on reopens that contact alone, lets a contact no longer asked
    /// for go, and is answered at once while another is still listening. The keys handed in are taken out.
    func testASecondListenReopensOnlyTheContactWhoseKeysChanged() throws {
        let rig = Rig()
        let a = try contact("aa", keys: 2).keys
        let b = try contact("bb", keys: 2).keys
        let c = try contact("cc", keys: 2).keys
        rig.go(["aa": a, "bb": b, "cc": c])
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 3)
        let socketOf = { (keys: [CashuMsg.Listened]) throws -> Socket in
            let n = try self.names(keys)
            return try XCTUnwrap(rig.sockets.first { $0.filters.first == n })
        }
        let sa = try socketOf(a)
        let sb = try socketOf(b)
        let sc = try socketOf(c)
        let moved = try contact("bb", keys: 2).keys
        var answer: Int?
        var handed: [String: [CashuMsg.Listened]] = ["aa": a, "bb": moved]
        rig.listen.listen(&handed, since: 1_800_000_123) { answer = $0 }
        XCTAssertTrue(handed.isEmpty, "the keys are taken out: kept ones wiped, the others the inboxes'")
        XCTAssertEqual(answer, 1, "a contact is still listening")
        XCTAssertTrue(sb.ended, "the contact whose keys moved lets its inbox go")
        XCTAssertTrue(sc.ended, "a contact no longer asked for is let go")
        XCTAssertFalse(sa.ended, "a contact with the same keys keeps its inbox")
        rig.fire()
        XCTAssertEqual(rig.sockets.count, 4, "one new socket, the moved contact's")
        XCTAssertEqual(rig.sockets.last?.filters.first, try names(moved))
        rig.listen.close()
    }

    /// The answer: an answer still waiting is given 0 by the next listen, and by close.
    func testAnAnswerWaitingIsGivenZeroByTheNextListenAndByClose() throws {
        let rig = Rig()
        rig.hold = true
        var first: Int?
        rig.go(["aa": try contact("aa", keys: 1).keys]) { first = $0 }
        rig.fire()
        XCTAssertNil(first)
        var second: Int?
        rig.go(["bb": try contact("bb", keys: 1).keys]) { second = $0 }
        XCTAssertEqual(first, 0)
        rig.listen.close()
        XCTAssertEqual(second, 0)
    }

    /// The 60 s deadline, run: nobody listening by then, the page is answered 0, once; a later listening says nothing more.
    func testTheSixtySecondAnswerRuns() throws {
        let rig = Rig()
        rig.hold = true
        var answers: [Int] = []
        rig.go(try many(2)) { answers.append($0) }
        rig.fire()
        XCTAssertEqual(answers, [])
        rig.fire { $0 == CashuMsgListen.answerBy }
        XCTAssertEqual(answers, [0])
        rig.sockets[0].held?(nil)
        rig.drain()
        XCTAssertEqual(rig.listen.listening, 1)
        XCTAssertEqual(answers, [0], "answered once")
        // a listen answered 1 before its deadline: the deadline says nothing
        let early = Rig()
        var got: [Int] = []
        early.go(try many(1)) { got.append($0) }
        early.fire()
        early.fire { $0 == CashuMsgListen.answerBy }
        XCTAssertEqual(got, [1])
        rig.listen.close()
        early.listen.close()
    }
}
