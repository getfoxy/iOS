import Foundation

/// The second address a Cashu payment request is paid to: a Nostr key, for the
/// wallets that cannot reach the first one.
///
/// Foxy's requests have always named an onion (OnionInbox), which is the best
/// of the two — the payment goes phone to phone over Tor and nothing is left
/// anywhere afterwards. But a browser cannot resolve `.onion`, so a wallet like
/// cashu.me cannot use it, and it was found doing something worse
/// than refusing: it swapped the ecash at the mint first and only then
/// discovered it could not deliver, so the payer's balance fell by 100 sats
/// that never arrived. A request that names only an address the payer cannot
/// reach is a way to lose somebody else's money.
///
/// So a request now names a Nostr transport as well, and this listens on it.
/// NIP-17 over NIP-59: the payer wraps the payment for this key and publishes
/// it to the relays the request names; relays see an encrypted message
/// addressed to a key, from nobody.
///
/// **The key is made for one request and thrown away with it.** It is never
/// derived from the twelve words. A key that outlived the screen would be a
/// name for the person holding the phone, and every request they ever showed
/// would be linkable to the same one. That is the whole cost of this transport,
/// and paying it once per request is what keeps it small.
///
/// What is left behind, and is not nothing: the relays hold a ciphertext
/// addressed to that key for as long as they choose to. The onion leaves
/// nothing at all, which is why it stays the transport Foxy itself prefers
/// (`deliveryFor`, build/wallet/07-request-delivery.js).
///
/// One at a time, made and ended on the main queue. The till's inboxes are
/// the exception, up to eight beside it (FoxyBridge+Till.swift), and the Cashu
/// ID's (FoxyBridge+CashuID.swift), whose key is derived from the words on
/// purpose: it is a name the person gives out, and lasts as long as it.
final class NostrInbox {

    /// The relays this inbox listens on, and which its `nprofile` names. The
    /// ones cashu.me and Minibits publish to by default, so a payment from
    /// either reaches here; the same list NostrDelivery falls back to.
    static var relays: [String] { NostrDelivery.fallbackRelays }
    /// At most this many sockets for one request.
    static let mostRelays = 4
    /// A payment larger than this is dropped unread — the same cap the onion
    /// inbox uses, for the same reason.
    static let largestPayment = 256 * 1024

    /// The payment JSON a payer sent, on the main queue. Called once per
    /// distinct wrap; the page decides whether it answers a request it knows.
    let onPayment: (_ body: String) -> Void

    private var secret: [UInt8]
    /// Internal, not private, so that a test can wrap a payment for this inbox.
    let pubkey: [UInt8]
    private var sockets: [NostrRelaySocket] = []
    /// How a socket to one relay is opened, on the circuit named: over Tor (`Route.startSocket`), or a test's stand-in.
    var connect: (URL, String) -> NostrRelaySocket? = { url, circuit in
        Route.startSocket(url, circuit: circuit).map { URLSessionRelaySocket(task: $0.task, session: $0.session) }
    }
    private var seen = Set<String>()
    private var closed = false
    /// Internal, not private, so that a test can hand `took` a relay's message.
    let subscription: String
    /// What the log calls this inbox. The request's keeps the words it always
    /// had; a till's says which, so four of them closing are not one line four times.
    let label: String
    /// The oldest wrap asked for, fixed when the inbox was made; nil for the
    /// request's own, which works its window out as it opens (`open`).
    private let since: Int?
    /// How many stored wraps a relay is asked for, and how many ids are held
    /// as opened before the set is emptied.
    private let limit: Int
    private let seenCap: Int
    /// How many pages one relay is asked for, back to `since` (1: one answer and no more).
    let pages: Int
    /// Per relay, by its place in `open`'s list: what the page being read has held,
    /// the oldest `created_at` in it, the `until` it was asked with, and how many
    /// pages have been asked. A test reads it; `took` writes it.
    struct Paging: Equatable {
        var count = 0
        var oldest = Int.max
        var until: Int? = nil
        var asked = 1
    }
    private(set) var paging: [Int: Paging] = [:]
    /// Where the next page's ask goes: the socket at that place, or a test's hand.
    var sendAsk: ((_ relay: Int, _ ask: String) -> Void)?

    /// nil when a key could not be made, which means secp256k1 is unavailable
    /// and nothing here could work anyway.
    init?(onPayment: @escaping (_ body: String) -> Void) {
        guard let s = try? NostrCrypto.newKey(), let p = try? NostrCrypto.publicKey(of: s) else { return nil }
        self.secret = s
        self.pubkey = p
        self.onPayment = onPayment
        // a name for this subscription, unrelated to the key
        self.subscription = NostrEvent.hex((try? NostrCrypto.newKey())?.prefix(8).map { $0 } ?? [0, 1, 2, 3])
        self.label = "nostr inbox"
        self.since = nil
        self.limit = 64
        self.seenCap = 128
        self.pages = 1
    }

    /// An inbox on a key that was made earlier and kept: a cashier code's,
    /// which lives as long as the code (three days, and a week after) so that a cashier's phone
    /// can deliver to it while this phone is off. Still never from the words,
    /// still one key per code, and thrown away with the code (`tillKeyDrop`);
    /// what it costs is that the relays can tell every payment taken on one
    /// code went to the same key.
    ///
    /// `since` is the caller's, because the window has to reach back to when
    /// the code was made and not to when this phone last woke: a payment
    /// published while it was off is waiting at the relays, backdated by
    /// NIP-59 up to two days before that. A whole shift can be waiting, so
    /// the relays are asked for more stored wraps than a request's inbox
    /// asks for, and more ids are held as opened, or one relay's copies would
    /// arrive again after the set was emptied.
    ///
    /// nil for a secret that is not a secp256k1 key.
    /// `pages`: how many answers of `limit` wraps one relay is asked for, each
    /// reaching back from the oldest wrap the last one held (`until`), until one
    /// holds fewer than `limit` or `since` is reached (the Cashu ID's, whose window
    /// is thirty-two days: FoxyBridge+CashuID.swift).
    init?(secret: [UInt8], since: Int, label: String, pages: Int = 1, onPayment: @escaping (_ body: String) -> Void) {
        guard secret.count == 32, let p = try? NostrCrypto.publicKey(of: secret) else { return nil }
        self.secret = secret
        self.pubkey = p
        self.onPayment = onPayment
        self.subscription = NostrEvent.hex((try? NostrCrypto.newKey())?.prefix(8).map { $0 } ?? [0, 1, 2, 3])
        self.label = label
        self.since = since
        self.limit = 500
        self.seenCap = 4096
        self.pages = max(1, pages)
        self.askSince = since
    }

    /// What the payment request names: this inbox's key and its relays.
    var nprofile: String? {
        closed ? nil : Bech32.nprofile(pubkey: pubkey, relays: Array(Self.relays.prefix(Self.mostRelays)))
    }

    var isOpen: Bool { !closed && !sockets.isEmpty }

    /// Open a socket to each relay and ask it for gift wraps addressed to this
    /// key. `done` with true once at least one relay is listening.
    func open(_ done: @escaping (Bool) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !closed else { done(false); return }
        let urls = NostrDelivery.relays(Array(Self.relays.prefix(Self.mostRelays)))
        guard !urls.isEmpty else { done(false); return }

        /* Only gift wraps, and only ones addressed to this key.
         *
         * `since` has to cover the whole of NIP-59's backdating, not the
         * moment this inbox opened. A wrap's `created_at` is deliberately
         * random up to two days in the past (NostrEvent.backdated, and every
         * other wallet does the same) precisely so that it says nothing about
         * when the message was really sent. Asked for the last minute, a relay
         * quite correctly returned nothing, and a real 50 sat payment from
         * cashu.me was never delivered (found in the first end-to-end run).
         *
         * It stays bounded rather than being dropped altogether, because the
         * key in this filter is minutes old and has never been published
         * anywhere else: within this window there is nothing for a relay to
         * replay at us but the payment we are waiting for. A till's key was
         * shown as a QR code and is days old, so its window does hold
         * payments already taken, every time it opens: the page keeps the
         * proofs it has seen and takes each once (`_tillArrived`). */
        let backdating = 172_800                            // NIP-59's two days
        let since = self.since ?? (Int(Date().timeIntervalSince1970) - backdating - 3600)
        let ask = Self.ask(subscription: subscription, pubkey: pubkey, since: since, until: nil, limit: limit)
        askSince = since

        var answered = false
        var left = urls.count
        let report: (Bool) -> Void = { [weak self] ok in
            guard let self, !self.closed else { return }
            if ok, !answered { answered = true; done(true); return }
            left -= 1
            if left == 0, !answered { answered = true; done(false) }
        }

        for (place, relay) in urls.enumerated() {
            guard let socket = connect(relay, MintCircuit.label(nil)) else {
                DispatchQueue.main.async { report(false) }
                continue
            }
            sockets.append(socket)
            paging[place] = Paging()
            if sendAsk == nil {
                sendAsk = { [weak self] at, text in
                    guard let self, !self.closed, let open = self.relaySockets[at] else { return }
                    open.sendText(text) { _ in }
                }
            }
            relaySockets[place] = socket
            socket.sendText(ask) { [weak self] error in
                DispatchQueue.main.async {
                    guard let self, !self.closed else { return }
                    if let error {
                        /* Given up for this listen, at once and once: the socket and
                         * its session are let go, nothing is asked of it again, and
                         * the other relays go on. A socket whose connection never
                         * opened fails its first send; when Tor could not reach the
                         * relay (nos.lol, whose host Tor's exits could not connect
                         * to), that failure reads "bad URL" (`whyNot`). */
                        print("[foxy] \(self.label): \(LogRedaction.host(relay.host)) \(Self.whyNot(error)); left for this listen")
                        self.drop(socket, relay: place)
                        report(false)
                        return
                    }
                    self.listen(on: socket, relay: place)
                    report(true)
                }
            }
        }
    }

    /// The REQ for gift wraps addressed to `pubkey`, from `since`, and up to
    /// `until` for a page after the first.
    static func ask(subscription: String, pubkey: [UInt8], since: Int, until: Int?, limit: Int) -> String {
        let upTo = until.map { ",\"until\":\($0)" } ?? ""
        let filter = "{\"kinds\":[1059],\"#p\":[\"\(NostrEvent.hex(pubkey))\"],\"since\":\(since)\(upTo),\"limit\":\(limit)}"
        return "[\"REQ\",\"\(subscription)\",\(filter)]"
    }

    private var askSince = 0
    private var relaySockets: [Int: NostrRelaySocket] = [:]

    /// How many relays this inbox still has a socket to. A test reads it.
    var relaysListening: Int { sockets.count }

    /// Let go of one relay's socket for the rest of this listen.
    private func drop(_ socket: NostrRelaySocket, relay: Int) {
        socket.end()
        sockets.removeAll { $0 === socket }
        if relaySockets[relay] === socket { relaySockets[relay] = nil }
        paging[relay] = nil
    }

    /// Why a relay's socket failed, in words. URLSession reports a SOCKS
    /// proxy's refusal to connect, which is what Tor answers when no exit
    /// could reach the relay, as NSURLErrorBadURL: the address is fine, the
    /// relay could not be reached through Tor (NostrInboxTests proves the
    /// mapping against a proxy that refuses).
    static func whyNot(_ error: Error) -> String {
        let e = error as NSError
        if e.domain == NSURLErrorDomain, e.code == NSURLErrorBadURL {
            return "could not be reached through Tor (the proxy refused the connection)"
        }
        if e.domain == NSURLErrorDomain, e.code == NSURLErrorTimedOut {
            return "did not answer through Tor in time"
        }
        return "failed: \(e.localizedDescription)"
    }

    /// The relay at `relay` said EOSE: when the page it just sent was full and
    /// reached back no further than `since`, the next page is asked for, up to
    /// before its oldest wrap (the same second once more, if a whole page sat in
    /// it), at most `pages` in all. Returns the ask sent, for a test.
    @discardableResult
    func pageEnded(relay: Int) -> String? {
        guard relay >= 0, var p = paging[relay] else { return nil }
        defer { paging[relay] = p }
        let full = p.count >= limit
        let oldest = p.oldest
        p.count = 0
        p.oldest = Int.max
        guard full, p.asked < pages, oldest != Int.max, oldest > askSince else { return nil }
        // a page whose wraps all sat in one second is asked past it, or the same page comes back for ever
        let until = (p.until.map { oldest >= $0 } ?? false) ? oldest - 1 : oldest
        guard until > askSince else { return nil }
        p.until = until
        p.asked += 1
        let next = Self.ask(subscription: subscription, pubkey: pubkey, since: askSince, until: until, limit: limit)
        sendAsk?(relay, next)
        return next
    }

    /// Read from one relay until it stops or this inbox closes.
    private func listen(on socket: NostrRelaySocket, relay: Int) {
        socket.receiveText { [weak self] result in
            guard let self else { return }
            guard case .success(let text) = result else {
                // a dead socket is done, and let go: never opened again in this listen
                DispatchQueue.main.async {
                    guard !self.closed else { return }
                    self.drop(socket, relay: relay)
                }
                return
            }
            DispatchQueue.main.async { self.took(text, relay: relay) }
            self.listen(on: socket, relay: relay)
        }
    }

    /// One line from a relay. `["EVENT", <sub>, <event>]` is the only kind that
    /// carries anything; an EOSE for this subscription may ask for the next page
    /// (`pageEnded`); everything else (NOTICE, CLOSED) is ignored. `relay`: the
    /// relay's place in `open`'s list, -1 where no page is followed.
    func took(_ text: String, relay: Int = -1) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !closed, text.utf8.count <= Self.largestPayment,
              let data = text.data(using: .utf8),
              let parts = (try? JSONSerialization.jsonObject(with: data)) as? [Any],
              parts.count >= 2, (parts[1] as? String) == subscription else { return }
        if (parts[0] as? String) == "EOSE" {
            if pages > 1 { pageEnded(relay: relay) }
            return
        }
        guard parts.count >= 3, (parts[0] as? String) == "EVENT",
              let object = parts[2] as? [String: Any],
              let json = try? JSONSerialization.data(withJSONObject: object),
              let wrap = NostrEvent.parse(String(decoding: json, as: UTF8.self)) else { return }
        // counted for the page whether or not it opens: the relay's limit counts every wrap it sends
        if relay >= 0, pages > 1 {
            var p = paging[relay] ?? Paging()
            p.count += 1
            p.oldest = min(p.oldest, wrap.createdAt)
            paging[relay] = p
        }

        // every relay sends the same wrap, and the payer sent it to all of them:
        // one that has opened is not opened again. An id is remembered only
        // once its wrap has opened and checked out, so that a relay sending a
        // wrap that only claims the id (the id is not checked until `unwrap`)
        // cannot make the genuine one from every other relay drop as a copy.
        guard !wrap.id.isEmpty, !seen.contains(wrap.id) else { return }

        guard let rumor = NostrEvent.unwrap(wrap, to: secret) else {
            #if DEBUG
            print("[foxy] \(label): a wrap did not open, or did not check out")
            #endif
            return
        }
        if seen.count >= seenCap { seen.removeAll() }
        seen.insert(wrap.id)
        print("[foxy] \(label): a payment arrived")
        onPayment(rumor.content)
    }

    /// End the key and the sockets. The relays keep whatever they were given;
    /// nothing here can take that back, which is the part of this transport the
    /// onion does not have.
    func close() {
        guard !closed else { return }
        closed = true
        for socket in sockets { socket.end() }
        sockets.removeAll()
        relaySockets.removeAll()
        sendAsk = nil
        seen.removeAll()
        NUT13.wipe(&secret)
        print("[foxy] \(label) closed")
    }

    deinit { if !closed { sockets.forEach { $0.end() } } }
}

/// One relay's socket, as NostrInbox uses it: send a line, read a line, let go.
protocol NostrRelaySocket: AnyObject {
    func sendText(_ text: String, _ done: @escaping (Error?) -> Void)
    func receiveText(_ done: @escaping (Swift.Result<String, Error>) -> Void)
    func end()
}

/// The real one: a websocket over Tor and the session made for it alone.
final class URLSessionRelaySocket: NostrRelaySocket {
    let task: URLSessionWebSocketTask
    let session: URLSession
    init(task: URLSessionWebSocketTask, session: URLSession) { self.task = task; self.session = session }
    func sendText(_ text: String, _ done: @escaping (Error?) -> Void) { task.send(.string(text), completionHandler: done) }
    func receiveText(_ done: @escaping (Swift.Result<String, Error>) -> Void) {
        task.receive { result in
            switch result {
            case .failure(let error): done(.failure(error))
            case .success(.string(let s)): done(.success(s))
            case .success(.data(let d)): done(.success(String(decoding: d, as: UTF8.self)))
            case .success: done(.success(""))
            }
        }
    }
    func end() {
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }
}
