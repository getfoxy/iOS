import Foundation

/// The Cashu ID's inbox (docs/CASHU-ID.md).
///
/// A Cashu ID names a Nostr key for this wallet's deliveries: the delivery key,
/// derived from the seed at its own path (CashuID.swift) and used for nothing
/// else on Nostr. A payer gift-wraps each payment to it (NIP-17 over NIP-59, the
/// road `nostrSend` takes), and the relays hold it until this phone listens.
///
/// Unlike a request's inbox (NostrInbox), this key outlives every screen: that is
/// the point of an ID somebody keeps in their contacts. What it costs is said in
/// THREAT-MODEL.md: the relays can tell every payment to one ID went to the same
/// key, and nothing else about them.
///
/// `cashuIdInboxOpen {since}` listens, each delivery reaching the page as
/// `FoxyWallet._cashuIdArrived(body)`, and answers "1" when a relay is listening
/// or "0"; a second open closes the first. `cashuIdInboxClose` ends it, as Foxy
/// leaving the foreground does (`closeInboxForBackground`); the page opens it
/// again on its wake. The private half is read on the seed queue and handed to
/// the inbox; nothing of it reaches the page.
///
/// `cashuIdCopiesOpen {since}` is the same on the recovery key
/// (m/129373'/20'/3'/0'/0'): the copies this phone sends itself of its own
/// payments to contacts, read back only after its words were restored, each
/// reaching the page as `FoxyWallet._cashuIdCopy(body)`. It is closed with the
/// other (`cashuIdInboxClose`, and Foxy leaving the foreground).
///
/// `cashuIdMsgSend` and `cashuIdMsgOpen` are the messages between two Cashu IDs
/// (CashuMsg.swift): a message wrapped to the next key of a chain only the two
/// phones can work out, and an inbox for each contact on its next keys. The pair
/// secret, the keys and the seals' keys stay here; the page gets plaintexts.
extension FoxyBridge {

    /// The furthest back the page may ask the relays to reach, and what is asked
    /// when it names no start: a payment waits thirty days for its receiver
    /// before its payer may take it back (08e-cashu-id.js), and NIP-59 backdates a
    /// wrap up to two days, so a payment its payer sent once and never again is
    /// still in reach on its last day. The relays are asked page by page back to
    /// it (NostrInbox `pages`), so a busy ID's oldest payments are not cut off by
    /// one answer's limit.
    static let cashuIdWindow = 32 * 86_400
    static let cashuIdWindowDefault = 32 * 86_400
    /// How many pages of 500 one relay is asked for, back to `since`.
    static let cashuIdPages = 8

    /// The page's `since`, in unix seconds, when it is a number inside the last
    /// `cashuIdWindow`; otherwise `cashuIdWindowDefault` back from now.
    static func cashuIdSince(_ value: Any?, now: Int) -> Int {
        let fallback = now - cashuIdWindowDefault
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return fallback }
        let seconds = number.doubleValue
        guard seconds.isFinite, seconds >= Double(now - cashuIdWindow), seconds <= Double(now) else { return fallback }
        return Int(seconds)
    }

    /// {since} → "1" when a relay is listening, "0" when none would.
    func handleCashuIdInboxOpen(id: String, body: [String: Any]) {
        closeCashuIdInbox(.delivery)
        let since = Self.cashuIdSince(body["since"], now: Int(Date().timeIntervalSince1970))
        let ticket = UUID()
        cashuIdTicket = ticket
        Self.seedQueue.async {
            let secret = Result { try SeedActions.cashuIdDeliverySecret(.live) }
            DispatchQueue.main.async { self.listenCashuId(.delivery, id: id, secret: secret, since: since, ticket: ticket) }
        }
    }

    /// {since} → "1" when a relay is listening, "0" when none would: the recovery
    /// key's inbox, for this phone's own copies after a restore.
    func handleCashuIdCopiesOpen(id: String, body: [String: Any]) {
        closeCashuIdInbox(.copies)
        let since = Self.cashuIdSince(body["since"], now: Int(Date().timeIntervalSince1970))
        let ticket = UUID()
        cashuIdCopiesTicket = ticket
        Self.seedQueue.async {
            let secret = Result { try SeedActions.cashuIdRecoverySecret(.live) }
            DispatchQueue.main.async { self.listenCashuId(.copies, id: id, secret: secret, since: since, ticket: ticket) }
        }
    }

    /// Which of the two keys an inbox listens on.
    enum CashuIdInbox {
        /// The delivery key's: payments to this ID, to `_cashuIdArrived`.
        case delivery
        /// The recovery key's: this phone's own copies, to `_cashuIdCopy`.
        case copies
    }

    /// The inbox on a key read on the seed queue, made and opened on the main
    /// queue, unless a close (or another open) came while the seed was read.
    private func listenCashuId(_ which: CashuIdInbox, id: String, secret read: Result<[UInt8], Error>, since: Int, ticket: UUID) {
        dispatchPrecondition(condition: .onQueue(.main))
        var secret: [UInt8]
        switch read {
        case .failure(let error): resolve(id: id, text: nil, error: SeedActions.problem(error)); return
        case .success(let bytes): secret = bytes
        }
        defer { NUT13.wipe(&secret) }
        let current = which == .delivery ? cashuIdTicket : cashuIdCopiesTicket
        guard current == ticket else { resolve(id: id, text: "0", error: nil); return }
        let label = which == .delivery ? "cashu id inbox" : "cashu id copies"
        guard let inbox = NostrInbox(secret: secret, since: since, label: label, pages: Self.cashuIdPages, onPayment: { [weak self] body in
            switch which {
            case .delivery: self?.cashuIdArrived(body)
            case .copies: self?.cashuIdCopyArrived(body)
            }
        }) else {
            resolve(id: id, text: nil, error: "The Cashu ID's inbox could not be made.")
            return
        }
        let answer: (Int) -> Void = { [weak self] count in self?.resolve(id: id, text: String(count), error: nil) }
        switch which {
        case .delivery: cashuIdInbox = inbox; cashuIdAnswer = answer
        case .copies: cashuIdCopies = inbox; cashuIdCopiesAnswer = answer
        }
        inbox.open { [weak self, weak inbox] ok in
            guard let self, let inbox else { return }
            guard (which == .delivery ? self.cashuIdInbox : self.cashuIdCopies) === inbox else { return }
            if !ok {
                inbox.close()
                switch which {
                case .delivery: self.cashuIdInbox = nil
                case .copies: self.cashuIdCopies = nil
                }
            }
            print("[foxy] \(label): " + (ok ? "listening" : "not listening: no relay would"))
            let waiting: ((Int) -> Void)?
            switch which {
            case .delivery: waiting = self.cashuIdAnswer; self.cashuIdAnswer = nil
            case .copies: waiting = self.cashuIdCopiesAnswer; self.cashuIdCopiesAnswer = nil
            }
            waiting?(ok ? 1 : 0)
        }
    }

    // MARK: Messages between Cashu IDs (CashuMsg.swift)

    /// {peer, i, body} → how many relays took it: the body gift-wrapped (NIP-17) to the x-only half of k_i, this
    /// phone's message `i` to `peer`, its seal signed by s_i, and published to Foxy's three relays over Tor. Both keys
    /// come from the pair secret on the seed queue and neither is answered.
    func handleCashuIdMsgSend(id: String, body: [String: Any]) {
        guard let request = CashuMsg.sendCheck(body) else { resolve(id: id, text: nil, error: "bad request"); return }
        Self.seedQueue.async {
            let keys = Result { try SeedActions.cashuMsgSendKeys(peer: request.peer, index: request.index, env: .live) }
            DispatchQueue.main.async {
                switch keys {
                case .failure(let error):
                    self.resolve(id: id, text: nil, error: SeedActions.problem(error))
                case .success(var k):
                    // the wrap is made before `send` returns; the seal's key is not kept past it
                    NostrDelivery.send(payload: request.body, receiver: k.to, relays: [], seal: k.seal) { [weak self] result in
                        switch result {
                        case .success(let answer) where !answer.accepted.isEmpty:
                            print("[foxy] cashu id messages: \(answer.accepted.count) relay(s) took a message")
                            self?.resolve(id: id, text: String(answer.accepted.count), error: nil)
                        case .success(let answer):
                            self?.resolve(id: id, text: nil, error: "No relay took the message: " + (answer.refused.values.first ?? "no relay took it"))
                        case .failure:
                            self?.resolve(id: id, text: nil, error: "The message could not be sent over Nostr.")
                        }
                    }
                    NUT13.wipe(&k.seal)
                }
            }
        }
    }

    /// {since, peers: [{peer, in, out}]} → "1" when a relay is listening, "0" when none would: gift wraps to every key
    /// named (each contact's next keys from it, and while this phone has lost its place after a restore, its own next
    /// keys to it), each contact's in a REQ of its own on a circuit of its own at one relay (CashuMsgListen.swift). A
    /// wrap opens only by the key it names, and reaches the page (`_cashuMsgArrived(peer, way, i, body)`) only when its
    /// seal is by that key's s_i. No key is answered. A contact asked for with the keys it had keeps its inbox.
    func handleCashuIdMsgOpen(id: String, body: [String: Any]) {
        guard let wants = CashuMsg.openCheck(body) else { resolve(id: id, text: nil, error: "bad request"); return }
        // an open still waiting is answered; the inboxes stay until this one says which are still wanted
        let waiting = cashuMsgAnswer
        cashuMsgAnswer = nil
        waiting?(0)
        let since = Self.cashuIdSince(body["since"], now: Int(Date().timeIntervalSince1970))
        let ticket = UUID()
        cashuMsgTicket = ticket
        Self.seedQueue.async {
            let keys = Result { try SeedActions.cashuMsgListenKeys(wants: wants, env: .live) }
            DispatchQueue.main.async { self.listenCashuMsg(id: id, keys: keys, since: since, ticket: ticket) }
        }
    }

    /// Internal, not private, so that a test can hand it keys and a rigged listener (BridgeTests).
    func listenCashuMsg(id: String, keys read: Result<[CashuMsg.Listened], Error>, since: Int, ticket: UUID) {
        dispatchPrecondition(condition: .onQueue(.main))
        var list: [CashuMsg.Listened]
        switch read {
        case .failure(let error): resolve(id: id, text: nil, error: SeedActions.problem(error)); return
        case .success(let got): list = got
        }
        defer { for i in list.indices { NUT13.wipe(&list[i].secret) } }
        guard cashuMsgTicket == ticket else { resolve(id: id, text: "0", error: nil); return }
        // each contact's keys on their own: the listener asks for them in a REQ of their own, never with another's
        var byPeer = [String: [CashuMsg.Listened]]()
        for k in list { byPeer[k.peer, default: []].append(k) }
        list.removeAll()        // moved, not copied: the listener wipes or keeps the only copy
        let contacts = byPeer.count
        let listen = cashuMsgInbox ?? CashuMsgListen(rotation: cashuMsgRotation, onMessage: { [weak self] peer, inward, index, body in
            self?.cashuMsgArrived(peer: peer, inward: inward, index: index, body: body)
        })
        cashuMsgInbox = listen
        var answered = false
        let answer: (Int) -> Void = { [weak self] count in
            guard !answered else { return }
            answered = true
            if self?.cashuMsgTicket == ticket { self?.cashuMsgAnswer = nil }
            print("[foxy] cashu id messages: " + (count > 0 ? "listening for \(contacts) contact(s)" : "not listening: no relay would"))
            self?.resolve(id: id, text: String(count), error: nil)
        }
        cashuMsgAnswer = answer
        listen.listen(&byPeer, since: since, answer: answer)
    }

    /// Ends the messages' inboxes, and answers an open still waiting on them with "0".
    func closeCashuMsgInbox() {
        dispatchPrecondition(condition: .onQueue(.main))
        cashuMsgTicket = nil
        let open = cashuMsgInbox
        cashuMsgInbox = nil
        let waiting = cashuMsgAnswer
        cashuMsgAnswer = nil
        open?.close()
        waiting?(0)
    }

    /// One message, opened and sealed by the right key. The page decides whether it is one it keeps.
    private func cashuMsgArrived(peer: String, inward: Bool, index: UInt32, body: String) {
        evaluate("window.FoxyWallet && window.FoxyWallet._cashuMsgArrived && window.FoxyWallet._cashuMsgArrived("
                 + Self.literalStatic(peer) + "," + Self.literalStatic(inward ? "in" : "out") + "," + String(index) + ","
                 + Self.literalStatic(body) + ")")
    }

    /// Stop listening, on both keys. The keys are the seed's; nothing is thrown away.
    func handleCashuIdInboxClose(id: String, body: [String: Any]) {
        closeCashuIdInbox()
        resolve(id: id, text: "ok", error: nil)
    }

    /// Ends every inbox of the ID's, the messages' too (Foxy leaving the foreground, `closeInboxForBackground`), and
    /// wipes the pair secrets worked out this session (CashuMsg.Cache).
    func closeCashuIdInbox() {
        closeCashuIdInbox(.delivery)
        closeCashuIdInbox(.copies)
        closeCashuMsgInbox()
        CashuMsg.cache.clear()
    }

    /// Ends one, and answers an open still waiting on it with "0": a NostrInbox
    /// closed while it opens never calls back.
    func closeCashuIdInbox(_ which: CashuIdInbox) {
        dispatchPrecondition(condition: .onQueue(.main))
        let open: NostrInbox?
        let waiting: ((Int) -> Void)?
        switch which {
        case .delivery:
            cashuIdTicket = nil
            open = cashuIdInbox; cashuIdInbox = nil
            waiting = cashuIdAnswer; cashuIdAnswer = nil
        case .copies:
            cashuIdCopiesTicket = nil
            open = cashuIdCopies; cashuIdCopies = nil
            waiting = cashuIdCopiesAnswer; cashuIdCopiesAnswer = nil
        }
        if let open {
            print("[foxy] cashu id: closing the " + (which == .delivery ? "inbox" : "copies' inbox"))
            open.close()
        }
        waiting?(0)
    }

    /// One delivery. Nobody to answer, as with any payment over Nostr; the page
    /// decides whether it is one it takes (`_cashuIdArrived`).
    private func cashuIdArrived(_ payment: String) {
        print("[foxy] cashu id: a delivery arrived (\(payment.utf8.count) bytes)")
        evaluate("window.FoxyWallet && window.FoxyWallet._cashuIdArrived && window.FoxyWallet._cashuIdArrived("
                 + Self.literalStatic(payment) + ")")
    }

    /// One of this phone's own copies, read back after a restore. The page
    /// believes it only where this seed made it (`cidCopyArrived`).
    private func cashuIdCopyArrived(_ copy: String) {
        print("[foxy] cashu id: a copy of a payment arrived (\(copy.utf8.count) bytes)")
        evaluate("window.FoxyWallet && window.FoxyWallet._cashuIdCopy && window.FoxyWallet._cashuIdCopy("
                 + Self.literalStatic(copy) + ")")
    }
}
