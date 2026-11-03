import Foundation
import Network

/// The address a Cashu payment request is paid to, over Tor, on this phone.
///
/// NUT-18 lets a request name where the payer's wallet sends the ecash: an
/// HTTP POST of the payment, or a Nostr message. Foxy's requests name an onion
/// address that exists only while the request is on screen. The payer's Foxy
/// connects to it through Tor and posts the proofs; this phone takes them,
/// redeems them, and answers whether that worked. Nobody sits in between: no
/// relay, no server, and neither phone learns the other's network address.
///
/// Tor forwards the onion's port 80 to a listener on 127.0.0.1 here. Other apps
/// on the phone can reach that port too, so the request's path carries 128
/// random bits and anything else is answered 404 without being read. What gets
/// through is only a claim of payment: the page redeems the proofs at the mint,
/// and the mint is what decides.
///
/// One at a time, made and ended on the main queue.
final class OnionInbox {
    /// A request answered with more than this is refused unread. A payment is
    /// its proofs, a few hundred bytes each; 256 kB is several hundred of them.
    static let largestPayment = 256 * 1024
    private static let largestHead = 8 * 1024
    /// How long a payer may take to send its request, once connected.
    private static let readPatience: TimeInterval = 30
    /// How long a connection may take to send a whole head, with the right path,
    /// before it gives up its place. A payer's Foxy sends its head the moment
    /// the stream is open; something that connects and drips bytes, or sends
    /// nothing, is not a payer, and every place it held for the thirty seconds
    /// above was a place a payer could not have.
    private static let headPatience: TimeInterval = 5
    /// How long the page may take to redeem and answer: a swap at the mint over
    /// Tor, which a bridge can make slow.
    private static let answerPatience: TimeInterval = 100

    typealias Answer = (_ status: Int, _ body: String) -> Void
    /// The body of a payment that reached the right path, on the main queue.
    /// Call the answer once; unanswered, the payer hears 504.
    let onPayment: (_ body: String, _ answer: @escaping Answer) -> Void

    let path: String
    private(set) var serviceID: String?
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    /// Who holds the places, in the order they came, and which have sent a head.
    private var places = InboxPlaces<ObjectIdentifier>()
    private let queue = DispatchQueue(label: "foxy.onion.inbox")
    private var closed = false

    /// What this one is for, so the log tells two inboxes apart. Foxy keeps a
    /// spare warming beside the live one, and until this existed both printed
    /// the same "onion inbox open" and the same "closed" — three closes in a
    /// row with nothing to say which was which.
    var note: String

    init(note: String = "for the request on screen",
         onPayment: @escaping (_ body: String, _ answer: @escaping Answer) -> Void) {
        self.note = note
        self.onPayment = onPayment
        path = "/" + MintCircuit.label(nil)
    }

    /// The request's delivery URL, "http://<id>.onion/<path>", or nil when Tor
    /// is not up or would not make an address.
    var url: URL? {
        guard let serviceID, !closed else { return nil }
        return URL(string: "http://\(serviceID).onion\(path)")
    }

    #if DEBUG
    /// The loopback address Tor forwards to, for a check without Tor.
    var localURL: URL? { listener?.port.map { URL(string: "http://127.0.0.1:\($0.rawValue)\(path)")! } ?? nil }
    #endif

    var isOpen: Bool { url != nil && listener?.state == .ready }

    /// Listen on a free loopback port, then ask Tor for an address pointing at it.
    func open(_ done: @escaping (URL?) -> Void) {
        /* Bound to 127.0.0.1, which is what keeps it off the network: Tor
         * forwards the onion's traffic here, and nothing outside the phone can
         * reach it. `acceptLocalOnly` is not that — it means the local link,
         * and with it set the listener refused loopback connections without
         * ever calling this handler (two simulators). */
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        guard let listener = try? NWListener(using: params) else { done(nil); return }
        self.listener = listener
        /* `reported` and `closed` are the main queue's. The listener's state,
         * Tor's answer and the deadline below all come back there, so the
         * answer is given once and a listener just published is never closed
         * by a deadline reading a flag another queue was writing. The deadline
         * used to run on the listener's queue. */
        var reported = false
        let report: (URL?) -> Void = { url in
            guard !reported else { return }
            reported = true
            done(url)
        }
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { conn.cancel(); return }
            self.accept(conn)
        }
        listener.stateUpdateHandler = { [weak self] state in
            DispatchQueue.main.async {
                guard let self, !self.closed else { report(nil); return }
                switch state {
                case .ready:
                    guard let port = listener.port?.rawValue else { report(nil); return }
                    #if canImport(Tor)
                    TorService.addOnion(localPort: port) { id in
                        guard let id, !self.closed else {
                            if let id { TorService.removeOnion(id) }
                            report(nil)
                            return
                        }
                        self.serviceID = id
                        print("[foxy] onion inbox open —", self.note)
                        report(self.url)
                    }
                    #else
                    report(nil)
                    #endif
                case .failed, .cancelled:
                    print("[foxy] onion inbox listener ended —", self.note, "\(state)")
                    report(nil)
                case .waiting(let why):
                    /* Waiting is not starting. OnionPost.connect treats it as
                     * a failure for the same reason: `report` is the only
                     * thing that answers inboxOpen, so a listener that sits
                     * here leaves the receive screen waiting for ever. */
                    print("[foxy] onion inbox listener waiting —", self.note, "\(why)")
                    report(nil)
                default:
                    break
                }
            }
        }
        listener.start(queue: queue)
        /* And a deadline, because `.setup` is not in the switch above either:
         * everything else in this file has one (readPatience,
         * answerPatience), and this was the one path that could hang. */
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard !reported else { return }
            print("[foxy] onion inbox did not open in 20s —", self?.note ?? "")
            report(nil)
            self?.close()
        }
    }

    /// End the address and the listener. Payments already being redeemed finish;
    /// their payers just do not hear back.
    func close() {
        guard !closed else { return }
        closed = true
        #if canImport(Tor)
        if let serviceID { TorService.removeOnion(serviceID) }
        #endif
        listener?.cancel()
        listener = nil
        queue.async {
            self.connections.values.forEach { $0.cancel() }
            self.connections.removeAll()
            self.places = InboxPlaces()
        }
        print("[foxy] onion inbox closed —", note)
    }

    // MARK: One connection: a request in, one answer out

    private func accept(_ conn: NWConnection) {
        // on `queue`
        let key = ObjectIdentifier(conn)
        #if DEBUG
        print("[foxy] onion inbox: a connection arrived (\(connections.count) open)")
        #endif
        /* Every place taken: the oldest that has not sent a head gives its place
         * up, and only with none of those is the newcomer turned away. Another
         * app on the phone can reach this port; four connections that dripped
         * a byte at a time used to hold every place for thirty seconds each,
         * and the payer's own connection, forwarded by Tor, was the one cancelled. */
        let arrival = places.arrive(key)
        if let evicted = arrival.evict {
            print("[foxy] onion inbox: every place was taken; the oldest connection with no request gives its place up")
            connections[evicted]?.cancel()
            connections[evicted] = nil
        }
        guard arrival.admit else { conn.cancel(); return }
        connections[key] = conn
        conn.stateUpdateHandler = { [weak self] state in
            #if DEBUG
            print("[foxy] onion inbox: connection \(state)")
            #endif
            switch state {
            case .failed, .cancelled: self?.queue.async { self?.connections[key] = nil; self?.places.leave(key) }
            default: break
            }
        }
        conn.start(queue: queue)
        queue.asyncAfter(deadline: .now() + Self.headPatience) { [weak self] in
            // connected and still no whole head: not a payer, and its place is given back
            guard let self, self.connections[key] != nil, !self.places.hasHead(key) else { return }
            conn.cancel()
        }
        queue.asyncAfter(deadline: .now() + Self.readPatience) { [weak self] in
            // still reading: a payer that stalls does not hold a slot
            if self?.connections[key] != nil, conn.state != .cancelled, !(self?.answering.contains(key) ?? false) {
                conn.cancel()
            }
        }
        read(conn, key: key, buffer: Data())
    }

    private var answering = Set<ObjectIdentifier>()

    private func read(_ conn: NWConnection, key: ObjectIdentifier, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            // a whole head has come, so this is a request to the right path and not a place held for nothing
            if !self.places.hasHead(key), HTTPRequestHead.headIsWhole(buffer, path: self.path) { self.places.headIn(key) }
            switch HTTPRequestHead.parse(buffer, path: self.path, largestHead: Self.largestHead,
                                         largestBody: Self.largestPayment) {
            case .needMore:
                if complete || error != nil { conn.cancel(); return }
                self.read(conn, key: key, buffer: buffer)
            case .refuse(let status):
                #if DEBUG
                print("[foxy] onion inbox: a request was refused with \(status)")
                #endif
                self.respond(conn, status: status, body: "")
            case .payment(let body):
                self.answering.insert(key)
                let answered = Locked(false)
                let answer: Answer = { status, text in
                    self.queue.async {
                        guard !answered.value else { return }
                        answered.value = true
                        self.answering.remove(key)
                        self.respond(conn, status: status, body: text)
                    }
                }
                self.queue.asyncAfter(deadline: .now() + Self.answerPatience) {
                    answer(504, "{\"error\":\"no answer in time\"}")
                }
                DispatchQueue.main.async {
                    guard !self.closed else { answer(410, ""); return }
                    self.onPayment(body, answer)
                }
            }
        }
    }

    /* The answer, then the close.
     *
     * `cancel()` in the send's completion cut the connection before iOS had
     * put the bytes on the wire: the payer saw a reset and no answer at all
     * (two simulators). `isComplete` sends the close after the
     * answer, and the connection is let go a moment later. */
    private func respond(_ conn: NWConnection, status: Int, body: String) {
        let bytes = Data(body.utf8)
        let reason = [200: "OK", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed",
                      410: "Gone", 413: "Payload Too Large", 422: "Unprocessable Content",
                      504: "Gateway Timeout"][status] ?? "Error"
        var head = "HTTP/1.1 \(status) \(reason)\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n"
        if !bytes.isEmpty { head += "Content-Type: application/json\r\n" }
        head += "\r\n"
        #if DEBUG
        print("[foxy] onion inbox: answering \(status)")
        #endif
        conn.send(content: Data(head.utf8) + bytes, isComplete: true, completion: .contentProcessed { _ in
            self.queue.asyncAfter(deadline: .now() + 2) { conn.cancel() }
        })
    }
}

/// The inbox's places: who holds one, in the order they came, and which have
/// sent a whole head to the right path. Thirty-two of them, which costs little:
/// a connection that has not sent a head holds at most the 8 KB a head may be.
/// When all are taken, the oldest connection that has sent no head gives its
/// place to the newcomer; a connection with a head is a payer's, and is never
/// the one let go. With every place held by a payer, the newcomer is turned away.
struct InboxPlaces<Key: Hashable> {
    static var most: Int { 32 }
    private(set) var order: [Key] = []
    private var headed: Set<Key> = []

    /// Whether `key` may have a place, and whose place it takes, if anyone's.
    mutating func arrive(_ key: Key) -> (admit: Bool, evict: Key?) {
        var evict: Key?
        if order.count >= Self.most {
            guard let oldest = order.first(where: { !headed.contains($0) }) else { return (false, nil) }
            leave(oldest)
            evict = oldest
        }
        order.append(key)
        return (true, evict)
    }

    mutating func headIn(_ key: Key) {
        if order.contains(key) { headed.insert(key) }
    }

    func hasHead(_ key: Key) -> Bool { headed.contains(key) }

    mutating func leave(_ key: Key) {
        order.removeAll { $0 == key }
        headed.remove(key)
    }
}

/// Reading one HTTP/1.1 request, as far as the inbox needs: POST, to the one
/// path, with a Content-Length within the limit. Nothing else is accepted —
/// no chunked bodies, no other methods — and a request that says it is too
/// large is refused before its body is read.
enum HTTPRequestHead {
    enum Outcome: Equatable {
        case needMore
        case refuse(Int)
        case payment(String)
    }

    /// Whether a whole head has arrived and asks for this path: the blank line is
    /// in, and what came before it is a request line to `path`. What the place
    /// rules count as a payer (InboxPlaces); `parse` still decides what it gets.
    static func headIsWhole(_ data: Data, path: String) -> Bool {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: data[data.startIndex..<end.lowerBound], encoding: .utf8),
              let first = head.components(separatedBy: "\r\n").first else { return false }
        let parts = first.split(separator: " ", omittingEmptySubsequences: false)
        return parts.count == 3 && parts[1] == path
    }

    static func parse(_ data: Data, path: String, largestHead: Int, largestBody: Int) -> Outcome {
        let separator = Data("\r\n\r\n".utf8)
        guard let end = data.range(of: separator) else {
            return data.count > largestHead ? .refuse(413) : .needMore
        }
        /* How long the head is, not where it ends. `range(of:)` answers in the
         * numbering of whatever Data it was handed, and a Data that came out of
         * a slice starts where its parent left off rather than at zero. Held up
         * against the cap raw, a twenty-byte head inside such a slice reads as
         * an eight-thousand-byte one and the payer is refused for nothing. The
         * count below and the `data[bodyStart...]` at the end already subtract
         * `startIndex`; this one did not. Too much head is 413 here as it is in
         * the line above, whether or not the blank line has arrived yet: the
         * same head was answered 400 once it finished and 413 while it was
         * still coming. */
        guard end.lowerBound - data.startIndex <= largestHead else { return .refuse(413) }
        guard let head = String(data: data[data.startIndex..<end.lowerBound], encoding: .utf8) else {
            return .refuse(400)
        }
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[2].hasPrefix("HTTP/1.") else { return .refuse(400) }
        // the path first: a caller without it learns nothing else about what is here
        guard parts[1] == path else { return .refuse(404) }
        guard parts[0] == "POST" else { return .refuse(405) }

        var length: Int?
        /* A space or a tab is all that may pad a value. `.whitespaces` is wider
         * than that - a non-breaking space is in it - and trimming one off the
         * end of a Content-Length made a number of something no other reader
         * would take for one. */
        let padding = CharacterSet(charactersIn: " \t")
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { return .refuse(400) }
            let name = line[..<colon]
            /* A line that opens with a space or a tab is HTTP's old folding: it
             * continues the value above rather than naming a header. Foxy never
             * writes one, and read as a header of its own a folded line holding
             * a colon is a second Content-Length smuggled inside somebody's Host
             * line. Space before the colon hides a name the same way. Neither
             * gets in. */
            guard !name.hasPrefix(" "), !name.hasPrefix("\t"),
                  !name.hasSuffix(" "), !name.hasSuffix("\t") else { return .refuse(400) }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: padding)
            switch name.lowercased() {
            case "transfer-encoding":
                return .refuse(400)
            case "content-length":
                // digits, and only digits: Int(_:) also reads "+5" and "-5"
                guard length == nil, !value.isEmpty, value.allSatisfy({ $0.isASCII && $0.isNumber }),
                      let n = Int(value) else { return .refuse(400) }
                length = n
            default:
                break
            }
        }
        guard let length else { return .refuse(400) }
        guard length <= largestBody else { return .refuse(413) }
        let bodyStart = end.upperBound
        let have = data.count - (bodyStart - data.startIndex)
        if have < length { return .needMore }
        if have > length { return .refuse(400) }
        guard let body = String(data: data[bodyStart...], encoding: .utf8) else { return .refuse(400) }
        return .payment(body)
    }
}
