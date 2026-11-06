import Foundation

/// Listening for the messages between Cashu IDs (CashuMsg.swift, `cashuIdMsgOpen`): one inbox for each contact.
///
/// One REQ naming every contact's next keys, on one socket, told a relay that all of those keys were one phone's,
/// how many contacts it had, and (because a key not yet used is asked for again next time) which listens were the
/// same phone's. So each contact's keys are asked for on their own: in a NostrInbox of their own, on a Tor circuit
/// of their own, at ONE of the three relays. Every message is posted to all three (`cashuIdMsgSend`), so one is
/// enough to hear it. Which one is the contact's own rotation's (CashuMsgRotation): a random order of the three,
/// kept for the session, moved on at each reopening, so within three reopenings every relay has been asked. A
/// contact whose relay fails, at the open, by closing the request or by going, is tried once more at another, on a
/// fresh circuit; one that found none is tried again after two minutes, then every ten, while Foxy stays open.
///
/// Nothing in a REQ is shared by one phone's contacts and by nobody else: the subscription is the inbox's own, the
/// keys are the contact's, and the `since` is the same for every phone all day (`commonSince`).
///
/// The opens are spread out: each contact's waits a random time inside a window that grows with the number of
/// contacts being opened (`window`), retries and reopenings too, and at most `mostAtOnce` are opening at a time,
/// each given `attemptBy` seconds, so neither a relay watching Tor's exits nor Tor itself sees forty circuits at once.
///
/// A listen that asks for the same keys of a contact as the one before keeps that contact's inbox: a message moving
/// one contact's window on reopens that contact alone, and the others do not all connect again together.
///
/// The answer is the one `cashuIdMsgOpen` always gave: 1 once a relay is listening (for any contact), 0 when none
/// would. Within `answerBy` seconds, whatever the opens still under way are doing, so the page's wait is never
/// outrun; those go on and are heard as they come.
///
/// Made, used and ended on the main queue.
final class CashuMsgListen {

    /// The window's floor, what each contact adds, and its ceiling, in seconds.
    static let windowBase: TimeInterval = 3
    static let windowPerContact: TimeInterval = 0.4
    static let windowMost: TimeInterval = 20
    /// The most contacts' inboxes opening at once (a retry keeps its place).
    static let mostAtOnce = 6
    /// How long one try at a relay may take before it counts as failed and its place is given up.
    static let attemptBy: TimeInterval = 20
    /// The latest the page is answered, in seconds (its own wait is 70).
    static let answerBy: TimeInterval = 60
    /// How many relays one contact is tried at in one go: its own, and once more another.
    static let triesEach = 2
    /// A contact that found no relay is tried again after the first of these, then after the second, again and again.
    static let reviveAfter: [TimeInterval] = [120, 600]

    /// How long the opens of `contacts` contacts are spread over.
    static func window(contacts: Int) -> TimeInterval {
        min(windowMost, windowBase + windowPerContact * Double(max(0, contacts)))
    }

    /// The oldest wrap asked for: the start of the day before the one `since` falls in, the same for every phone all
    /// day. The page's `since` is to the second, and the same in every contact's REQ: it named the moment a listen
    /// began and tied that listen's REQs together, and to the ID inbox's, opened a moment before. A day earlier than
    /// asked costs nothing: each key is used for one message.
    static func commonSince(_ since: Int) -> Int { (since / 86_400) * 86_400 - 86_400 }

    /// A message that opened and was sealed by the key it came to: whose, which way, which index, its body.
    let onMessage: (_ peer: String, _ inward: Bool, _ index: UInt32, _ body: String) -> Void
    /// Each contact's order of the relays, which outlives this listener (the bridge keeps it for the session).
    let rotation: CashuMsgRotation

    /// Stand-ins for the tests: the clock, the random draws and the sockets. `fraction` is in [0, 1), `pick(n)` in
    /// 0..<n; `connect` nil is a socket over Tor (NostrInbox's own).
    var after: (TimeInterval, @escaping () -> Void) -> Void = { delay, run in
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: run)
    }
    var fraction: () -> Double = { Double.random(in: 0..<1) }
    var pick: (Int) -> Int = { Int.random(in: 0..<$0) }
    var connect: ((URL, String) -> NostrRelaySocket?)?
    var relays: [String] = NostrInbox.relays

    init(rotation: CashuMsgRotation = CashuMsgRotation(),
         onMessage: @escaping (_ peer: String, _ inward: Bool, _ index: UInt32, _ body: String) -> Void) {
        self.rotation = rotation
        self.onMessage = onMessage
    }

    /// One contact's inbox, from the moment its open is planned until it is let go.
    private final class Slot {
        enum State { case planned, queued, opening, listening, deaf, ended }
        let peer: String
        /// The x-only keys it asks for, sorted and joined: the same keys, the same inbox.
        let names: String
        var keys: [CashuMsg.Listened]
        let since: Int
        var state = State.planned
        var inbox: NostrInbox?
        /// The relays tried in this go, by place; the first comes from the contact's rotation.
        var tried: [Int] = []
        /// How many times it has been tried again after finding no relay.
        var revived = 0
        init(peer: String, names: String, keys: [CashuMsg.Listened], since: Int) {
            self.peer = peer; self.names = names; self.keys = keys; self.since = since
        }
    }

    private var slots: [String: Slot] = [:]
    private var queue: [Slot] = []
    private var opening = 0
    private var waiting: ((Int) -> Void)?
    private var asked = 0
    private var closed = false

    /// How many contacts' inboxes are listening, and opening. Tests read them.
    var listening: Int { slots.values.filter { $0.state == .listening }.count }
    var openingNow: Int { opening }

    /// Listen for `contacts` (each contact's keys, by its ID), answering `answer` once as above. A contact asked for
    /// with the same keys as before keeps its inbox; one asked for with other keys, or whose inbox is deaf, gets a new
    /// one; one not asked for any more is let go. An answer still waiting from the listen before is given 0. The keys
    /// are taken out of `contacts`, which is left empty: a kept contact's are wiped, the others' are the inboxes' now.
    func listen(_ contacts: inout [String: [CashuMsg.Listened]], since: Int, answer: @escaping (Int) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !closed else { Self.wipe(&contacts); answer(0); return }
        let before = waiting
        waiting = nil
        before?(0)
        asked += 1
        let ask = asked
        waiting = answer

        for (peer, slot) in slots where contacts[peer] == nil { end(slot) }
        var fresh = [Slot]()
        for peer in Array(contacts.keys) {
            guard var keys = contacts.removeValue(forKey: peer) else { continue }
            let names = keys.compactMap { (try? NostrCrypto.publicKey(of: $0.secret)).map(NostrEvent.hex) }.sorted().joined(separator: ",")
            if let kept = slots[peer], kept.names == names, kept.state != .deaf, kept.state != .ended {
                for i in keys.indices { NUT13.wipe(&keys[i].secret) }
                continue
            }
            if let old = slots[peer] { end(old) }
            let slot = Slot(peer: peer, names: names, keys: keys, since: since)
            keys.removeAll()
            slots[peer] = slot
            fresh.append(slot)
        }
        let spread = Self.window(contacts: fresh.count)
        for slot in fresh { plan(slot, within: spread) }
        after(Self.answerBy) { [weak self] in
            guard let self, self.asked == ask, let late = self.waiting else { return }
            self.waiting = nil
            late(self.listening > 0 ? 1 : 0)
        }
        settle()
    }

    /// Ends every inbox and plan, and answers a listen still waiting with 0.
    func close() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !closed else { return }
        closed = true
        for slot in Array(slots.values) { end(slot) }
        slots.removeAll()
        queue.removeAll()
        let late = waiting
        waiting = nil
        late?(0)
    }

    private static func wipe(_ contacts: inout [String: [CashuMsg.Listened]]) {
        for peer in Array(contacts.keys) {
            guard var keys = contacts.removeValue(forKey: peer) else { continue }
            for i in keys.indices { NUT13.wipe(&keys[i].secret) }
        }
    }

    // MARK: the opens

    /// The slot opens after its own random wait inside `spread`.
    private func plan(_ slot: Slot, within spread: TimeInterval) {
        slot.state = .planned
        let delay = max(0, min(1, fraction())) * spread
        after(delay) { [weak self, weak slot] in
            guard let self, let slot, !self.closed, self.slots[slot.peer] === slot, slot.state == .planned else { return }
            slot.state = .queued
            self.queue.append(slot)
            self.pump()
        }
    }

    private func pump() {
        while opening < Self.mostAtOnce, !queue.isEmpty {
            let slot = queue.removeFirst()
            guard slots[slot.peer] === slot, slot.state == .queued else { continue }
            slot.state = .opening
            opening += 1
            attempt(slot)
        }
    }

    /// One try at a relay: the contact's next in its rotation for a first try, another not tried in this go after.
    private func attempt(_ slot: Slot) {
        let left = relays.indices.filter { !slot.tried.contains($0) }
        guard slot.tried.count < Self.triesEach, !left.isEmpty else { giveUp(slot); return }
        let place: Int
        if slot.tried.isEmpty {
            place = min(relays.count - 1, rotation.next(slot.peer, of: relays.count))
        } else {
            place = left[max(0, min(left.count - 1, pick(left.count)))]
        }
        slot.tried.append(place)
        let circuit = MintCircuit.label(nil)
        // by the x-only key each listens on: which way, which index, and the key its seal must be by
        var which = [String: (inward: Bool, index: UInt32, seal: String)]()
        for k in slot.keys {
            guard let p = try? NostrCrypto.publicKey(of: k.secret) else { continue }
            which[NostrEvent.hex(p)] = (k.inward, k.index, NUT13.hex(k.seal))
        }
        let peer = slot.peer
        guard let inbox = NostrInbox(keys: slot.keys.map { $0.secret }, since: Self.commonSince(slot.since),
                                     label: "cashu id messages " + String(circuit.prefix(6)),
                                     onRumor: { [weak self] key, rumor in
            guard let who = which[key], rumor.pubkey.lowercased() == who.seal else {
                print("[foxy] cashu id messages: a wrap was not sealed by the key it came to")
                return
            }
            self?.onMessage(peer, who.inward, who.index, rumor.content)
        }) else { giveUp(slot); return }
        inbox.circuit = circuit
        inbox.listensOn = [relays[place]]
        if let connect { inbox.connect = connect }
        slot.inbox = inbox
        print("[foxy] cashu id messages: a contact's inbox opens on circuit \(circuit.prefix(6)) at "
              + LogRedaction.host(URL(string: relays[place])?.host) + (slot.tried.count > 1 ? " (its second relay)" : ""))
        inbox.onDropped = { [weak self, weak slot, weak inbox] in
            guard let self, let slot, let inbox, slot.inbox === inbox, slot.state == .listening else { return }
            print("[foxy] cashu id messages: a contact's relay went (circuit \(circuit.prefix(6)))")
            inbox.close()
            slot.inbox = nil
            if slot.tried.count < Self.triesEach, slot.tried.count < self.relays.count {
                // after a wait of its own: a relay that drops every socket at once does not get them all back together
                self.plan(slot, within: Self.window(contacts: self.slots.count))
            } else {
                self.deaf(slot)
                self.settle()
            }
        }
        after(Self.attemptBy) { [weak self, weak slot, weak inbox] in
            guard let self, let slot, let inbox, slot.inbox === inbox, slot.state == .opening else { return }
            print("[foxy] cashu id messages: a contact's relay did not answer in time (circuit \(circuit.prefix(6)))")
            inbox.close()
            slot.inbox = nil
            self.attempt(slot)
        }
        inbox.open { [weak self, weak slot, weak inbox] ok in
            guard let self, let slot, let inbox, slot.inbox === inbox, slot.state == .opening else { return }
            if ok {
                slot.state = .listening
                slot.revived = 0
                self.opening -= 1
                self.settle()
                self.pump()
                return
            }
            inbox.close()
            slot.inbox = nil
            if inbox.noRoute {
                // Tor was not running: not a try at that relay; tried again when the route is back
                slot.tried.removeLast()
                self.opening -= 1
                self.deaf(slot)
                self.settle()
                self.pump()
                return
            }
            self.attempt(slot)
        }
    }

    /// The end of a go that found no relay.
    private func giveUp(_ slot: Slot) {
        if slot.state == .opening { opening -= 1 }
        slot.inbox?.close()
        slot.inbox = nil
        print("[foxy] cashu id messages: a contact's inbox found no relay")
        deaf(slot)
        settle()
        pump()
    }

    /// Deaf until the page listens again, or until a revival: two minutes, then every ten, each a new go.
    private func deaf(_ slot: Slot) {
        slot.state = .deaf
        let wait = Self.reviveAfter[min(slot.revived, Self.reviveAfter.count - 1)]
        after(wait) { [weak self, weak slot] in
            guard let self, let slot, !self.closed, self.slots[slot.peer] === slot, slot.state == .deaf else { return }
            slot.revived += 1
            slot.tried = []
            self.plan(slot, within: Self.window(contacts: 1))
        }
    }

    /// Lets one contact's inbox go, and its keys.
    private func end(_ slot: Slot) {
        if slot.state == .opening { opening -= 1 }
        if slot.state == .queued { queue.removeAll { $0 === slot } }
        slot.state = .ended
        slot.inbox?.close()
        slot.inbox = nil
        for i in slot.keys.indices { NUT13.wipe(&slot.keys[i].secret) }
        slot.keys.removeAll()
        if slots[slot.peer] === slot { slots[slot.peer] = nil }
        if !closed { pump() }
    }

    /// Answers the listen waiting, once one inbox is listening, or once none is and none is still to open.
    private func settle() {
        guard let answer = waiting else { return }
        let all = slots.values
        if all.contains(where: { $0.state == .listening }) {
            waiting = nil
            answer(1)
        } else if !all.contains(where: { [.planned, .queued, .opening].contains($0.state) }) {
            waiting = nil
            answer(0)
        }
    }
}

/// Which relay each contact's messages are asked for at, for the session: a random order of the relays for each
/// contact on its own, the next at each reopening, shuffled afresh once all have been used. Never a counter shared by
/// contacts: that would show each relay the same group of one phone's contacts every third opening. Memory only; a
/// new launch starts new orders.
final class CashuMsgRotation {
    /// The most contacts remembered; past it the order of one is forgotten, which only means it starts a new one.
    static let most = 256
    /// The shuffle (the tests' stand-in).
    var shuffle: ([Int]) -> [Int] = { $0.shuffled() }
    private var orders: [String: (order: [Int], next: Int)] = [:]

    /// The place of the relay `peer` is asked at this time, of `count`.
    func next(_ peer: String, of count: Int) -> Int {
        guard count > 0 else { return 0 }
        var entry = orders[peer] ?? (order: [], next: 0)
        if entry.order.count != count || entry.next >= count {
            if orders[peer] == nil, orders.count >= Self.most, let any = orders.keys.first { orders[any] = nil }
            let fresh = shuffle(Array(0..<count))
            entry = (Set(fresh) == Set(0..<count) && fresh.count == count ? fresh : Array(0..<count).shuffled(), 0)
        }
        let place = entry.order[entry.next]
        entry.next += 1
        orders[peer] = entry
        return place
    }
}
