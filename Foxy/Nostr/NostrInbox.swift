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
/// the exception, up to eight beside it (FoxyBridge+Till.swift), and the Foxy
/// ID's (FoxyBridge+CashuID.swift), whose key is derived from the words on
/// purpose: it is a name the person gives out, and lasts as long as it. The ID's
/// inbox asks the relays for none of that key's own wraps, but for the keys
/// the day moves it to (CashuID.swift `dropTweak`), in REQs of `askKeys` keys
/// each, padded with keys made for the one REQ, at one relay picked at random
/// (`init(asks:…)`).
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

    /// The secret of every key asked for, by its x-only public half in hex; a
    /// wrap is opened with the one its `p` tag names.
    private var secrets: [String: [UInt8]] = [:]
    /// Internal, not private, so that a test can wrap a payment for this inbox:
    /// the one key a request's or a till's inbox listens on, the first real key of an ID's.
    let pubkey: [UInt8]
    private var sockets: [NostrRelaySocket] = []
    /// How a socket to one relay is opened, on the circuit named: over Tor (`Route.startSocket`), or a test's stand-in.
    var connect: (URL, String) -> NostrRelaySocket? = { url, circuit in
        Route.startSocket(url, circuit: circuit).map { URLSessionRelaySocket(task: $0.task, session: $0.session) }
    }
    private var seen = Set<String>()
    private var closed = false
    /// Internal, not private, so that a test can hand `took` a relay's message: the first REQ's.
    var subscription: String { asks[0].subscription }

    /// The most keys one REQ names, and how many every REQ of an ID's inbox
    /// names: the real ones, and fresh keys nobody holds after them, in a
    /// shuffled order. Three days of a Foxy ID's keys fill one; the relays
    /// take a hundred and more in a filter, and a REQ the same size whatever
    /// it carries tells a relay nothing by its size.
    static let askKeys = 48

    /// One REQ: its subscription, the keys it names in the order sent, and how far back it reaches.
    struct Ask {
        let subscription: String
        let pubkeys: [[UInt8]]
        let since: Int
    }
    /// What `init(asks:…)` is handed for one REQ: the real keys' secrets, and its `since`.
    struct Wanted {
        var secrets: [[UInt8]]
        let since: Int
    }
    /// The REQs this inbox sends to each relay it opens, in order. Internal for a test.
    private(set) var asks: [Ask]
    /// Whether this inbox listens at one relay of the list, picked at random,
    /// and moves to another only when that one fails or refuses (the Foxy
    /// ID's), or at every relay at once (a request's and a till's).
    let oneRelay: Bool
    /// The relays in the order this listen tries them, and how many have been tried.
    private var order: [URL] = []
    private var tried = 0
    /// The REQs each relay has answered to their end (EOSE, and no page left to ask), by the relay's place.
    private var finished: [Int: Set<Int>] = [:]
    /// Called once: for an inbox at every relay, when each relay it opened has
    /// answered every REQ to its end or failed, and at least one ended them; for
    /// a `oneRelay` inbox, when the relay listening has ended them.
    var onEnded: (() -> Void)?
    /// How many relays an every-relay inbox opened, and the places that have ended every REQ or been let go.
    private var opened = 0
    private var settled = Set<Int>()
    private var endedAll = false
    /// How long a `oneRelay` inbox waits for the relay it asked to end its next
    /// REQ, from the REQs going out and again from each EOSE, before it lets
    /// that relay go and asks the next (a relay that hangs). A test shortens it.
    var relayDeadline: TimeInterval = 30
    private var deadline: DispatchWorkItem?
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
    /// Which page: the relay's place and the REQ's.
    struct PageKey: Hashable {
        let relay: Int
        let ask: Int
    }
    private(set) var paging: [PageKey: Paging] = [:]
    /// Where the next page's ask goes: the socket at that place, or a test's hand.
    var sendAsk: ((_ relay: Int, _ ask: String) -> Void)?

    /// nil when a key could not be made, which means secp256k1 is unavailable
    /// and nothing here could work anyway.
    init?(onPayment: @escaping (_ body: String) -> Void) {
        guard let s = try? NostrCrypto.newKey(), let p = try? NostrCrypto.publicKey(of: s) else { return nil }
        self.secrets = [NostrEvent.hex(p): s]
        self.pubkey = p
        self.onPayment = onPayment
        // a name for this subscription, unrelated to the key; `since` is worked out as it opens
        self.asks = [Ask(subscription: Self.newSubscription(), pubkeys: [p], since: 0)]
        self.oneRelay = false
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
    /// holds fewer than `limit` or `since` is reached (the Foxy ID's, whose window
    /// is thirty-two days: FoxyBridge+CashuID.swift).
    init?(secret: [UInt8], since: Int, label: String, pages: Int = 1, onPayment: @escaping (_ body: String) -> Void) {
        guard secret.count == 32, let p = try? NostrCrypto.publicKey(of: secret) else { return nil }
        self.secrets = [NostrEvent.hex(p): secret]
        self.pubkey = p
        self.onPayment = onPayment
        self.asks = [Ask(subscription: Self.newSubscription(), pubkeys: [p], since: since)]
        self.oneRelay = false
        self.label = label
        self.since = since
        self.limit = 500
        self.seenCap = 4096
        self.pages = max(1, pages)
    }

    /// The Foxy ID's inbox: one REQ for each of `wanted`, every one naming
    /// exactly `askKeys` keys, its real ones and then fresh keys made for this
    /// REQ alone (real points, so nothing tells them apart), shuffled; a REQ
    /// with no real key is all filler. At one relay picked at random, the next
    /// tried only when it fails, drops the socket or refuses a REQ; `open`
    /// answers true only once that relay has answered every REQ to its end.
    /// Each REQ is read back page by page to its own `since`, as
    /// `init(secret:…)`'s. nil for a list with more keys in one REQ than
    /// `askKeys`, no real key at all, or a secret that is not a key. The
    /// secrets are copied; the caller wipes its own.
    init?(asks wanted: [Wanted], label: String, pages: Int = 1, everyRelay: Bool = false,
          onPayment: @escaping (_ body: String) -> Void) {
        guard !wanted.isEmpty, wanted.contains(where: { !$0.secrets.isEmpty }),
              wanted.allSatisfy({ $0.secrets.count <= Self.askKeys }) else { return nil }
        var made: [Ask] = []
        var held: [String: [UInt8]] = [:]
        var first: [UInt8]?
        for one in wanted {
            var keys: [[UInt8]] = []
            for secret in one.secrets {
                guard secret.count == 32, let p = try? NostrCrypto.publicKey(of: secret) else {
                    for k in Array(held.keys) { NUT13.wipe(&held[k]!) }
                    return nil
                }
                if first == nil { first = p }
                held[NostrEvent.hex(p)] = secret
                keys.append(p)
            }
            while keys.count < Self.askKeys {
                guard var pad = try? NostrCrypto.newKey(), let p = try? NostrCrypto.publicKey(of: pad) else {
                    for k in Array(held.keys) { NUT13.wipe(&held[k]!) }
                    return nil
                }
                NUT13.wipe(&pad)
                keys.append(p)
            }
            keys.shuffle()
            made.append(Ask(subscription: Self.newSubscription(), pubkeys: keys, since: one.since))
        }
        guard let first else { return nil }
        self.secrets = held
        self.pubkey = first
        self.onPayment = onPayment
        self.asks = made
        self.oneRelay = !everyRelay
        self.label = label
        self.since = made.map(\.since).min()
        self.limit = 500
        self.seenCap = 4096
        self.pages = max(1, pages)
    }

    /// A subscription's name: 16 hex characters, fresh for each REQ and unrelated to any key.
    private static func newSubscription() -> String {
        NostrEvent.hex((try? NostrCrypto.newKey())?.prefix(8).map { $0 } ?? [0, 1, 2, 3])
    }

    /// What the payment request names: this inbox's key and its relays.
    var nprofile: String? {
        closed ? nil : Bech32.nprofile(pubkey: pubkey, relays: Array(Self.relays.prefix(Self.mostRelays)))
    }

    var isOpen: Bool { !closed && !sockets.isEmpty }

    /// Open a socket to each relay and ask it for gift wraps addressed to this
    /// key; or, for the Foxy ID's (`oneRelay`), to one relay picked at random,
    /// with every REQ. `done` with true once a relay is listening, false once
    /// none would.
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
        if self.since == nil, asks.count == 1 {
            let since = Int(Date().timeIntervalSince1970) - backdating - 3600
            asks[0] = Ask(subscription: asks[0].subscription, pubkeys: asks[0].pubkeys, since: since)
        }
        if sendAsk == nil {
            sendAsk = { [weak self] at, text in
                guard let self, !self.closed, let open = self.relaySockets[at] else { return }
                open.sendText(text) { _ in }
            }
        }

        if oneRelay {
            order = urls.shuffled()
            tried = 0
            answer = done
            tryNextRelay()
            return
        }

        var answered = false
        var left = urls.count
        let report: (Bool) -> Void = { [weak self] ok in
            guard let self, !self.closed else { return }
            if ok, !answered { answered = true; done(true); return }
            left -= 1
            if left == 0, !answered { answered = true; done(false) }
        }
        opened = urls.count
        for (place, relay) in urls.enumerated() {
            start(relay, place: place, report: report)
        }
    }

    /// `open`'s answer while a `oneRelay` inbox has not yet had a relay listen.
    private var answer: ((Bool) -> Void)?

    /// The next relay of this listen's random order, on a circuit of its own;
    /// when every one has been tried, a listen still waiting is told none would.
    private func tryNextRelay() {
        guard !closed else { return }
        guard tried < order.count else {
            print("[foxy] \(label): no relay left to ask")
            let waiting = answer
            answer = nil
            waiting?(false)
            return
        }
        let place = tried
        tried += 1
        finished[place] = nil
        deadline?.cancel()
        // the answer waits for every REQ's end (`took`); a relay whose first REQ did not go is passed over. The
        // deadline starts once that first REQ has gone (`start`): the circuit and the handshake are not counted
        start(order[place], place: place) { [weak self] ok in
            guard let self, !self.closed, !ok else { return }
            self.tryNextRelay()
        }
    }

    /// From now, `relayDeadline` for the relay at `place` to end its next REQ or
    /// send the next wrap; past it, while the listen still waits for its answer,
    /// the relay is let go.
    private func armDeadline(_ place: Int) {
        deadline?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.closed, self.answer != nil, self.relaySockets[place] != nil else { return }
            print("[foxy] \(self.label): the relay did not end every REQ in time")
            self.relayLost(place)
        }
        deadline = work
        DispatchQueue.main.asyncAfter(deadline: .now() + relayDeadline, execute: work)
    }

    /// One relay: its socket, and every REQ on it. `report` once, with whether the first REQ went.
    private func start(_ relay: URL, place: Int, report: @escaping (Bool) -> Void) {
        guard let socket = connect(relay, MintCircuit.label(nil)) else {
            if !oneRelay { settled.insert(place) }
            DispatchQueue.main.async { [weak self] in self?.endedCheck(); report(false) }
            return
        }
        sockets.append(socket)
        relaySockets[place] = socket
        for index in asks.indices { paging[PageKey(relay: place, ask: index)] = Paging() }
        let texts = asks.map { Self.ask(subscription: $0.subscription, pubkeys: $0.pubkeys, since: $0.since, until: nil, limit: limit) }
        socket.sendText(texts[0]) { [weak self] error in
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
                for text in texts.dropFirst() { socket.sendText(text) { _ in } }
                if self.oneRelay, self.answer != nil, self.relaySockets[place] === socket { self.armDeadline(place) }
                self.listen(on: socket, relay: place)
                report(true)
            }
        }
    }

    /// The REQ for gift wraps addressed to `pubkey`, from `since`, and up to
    /// `until` for a page after the first.
    static func ask(subscription: String, pubkey: [UInt8], since: Int, until: Int?, limit: Int) -> String {
        ask(subscription: subscription, pubkeys: [pubkey], since: since, until: until, limit: limit)
    }

    /// The same for several keys, in the order given.
    static func ask(subscription: String, pubkeys: [[UInt8]], since: Int, until: Int?, limit: Int) -> String {
        let upTo = until.map { ",\"until\":\($0)" } ?? ""
        let keys = pubkeys.map { "\"\(NostrEvent.hex($0))\"" }.joined(separator: ",")
        let filter = "{\"kinds\":[1059],\"#p\":[\(keys)],\"since\":\(since)\(upTo),\"limit\":\(limit)}"
        return "[\"REQ\",\"\(subscription)\",\(filter)]"
    }

    private var relaySockets: [Int: NostrRelaySocket] = [:]

    /// How many relays this inbox still has a socket to. A test reads it.
    var relaysListening: Int { sockets.count }

    /// Let go of one relay's socket for the rest of this listen.
    private func drop(_ socket: NostrRelaySocket, relay: Int) {
        socket.end()
        sockets.removeAll { $0 === socket }
        if relaySockets[relay] === socket { relaySockets[relay] = nil }
        for key in paging.keys where key.relay == relay { paging[key] = nil }
        if !oneRelay { settled.insert(relay); endedCheck() }
    }

    /// An every-relay inbox's `onEnded`, once every relay it opened has ended or failed and one has ended.
    private func endedCheck() {
        guard !oneRelay, endedAll, opened > 0, settled.count >= opened, let ended = onEnded else { return }
        onEnded = nil
        ended()
    }

    /// A relay of a `oneRelay` inbox that was listening and is no longer
    /// (its socket ended, or it refused a REQ): let go, and the next one tried.
    private func relayLost(_ relay: Int) {
        guard oneRelay, !closed, let socket = relaySockets[relay] else { return }
        print("[foxy] \(label): the relay stopped answering; trying another")
        drop(socket, relay: relay)
        tryNextRelay()
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

    /// The relay at `relay` said EOSE to the REQ at `ask`: when the page it
    /// just sent was full and reached back no further than that REQ's `since`,
    /// the next page is asked for, up to before its oldest wrap (the same second
    /// once more, if a whole page sat in it), at most `pages` in all. Returns
    /// the ask sent, for a test.
    @discardableResult
    func pageEnded(relay: Int, ask index: Int = 0) -> String? {
        let key = PageKey(relay: relay, ask: index)
        guard relay >= 0, asks.indices.contains(index), var p = paging[key] else { return nil }
        defer { paging[key] = p }
        let full = p.count >= limit
        let oldest = p.oldest
        let since = asks[index].since
        p.count = 0
        p.oldest = Int.max
        guard full, p.asked < pages, oldest != Int.max, oldest > since else { return nil }
        // a page whose wraps all sat in one second is asked past it, or the same page comes back for ever
        let until = (p.until.map { oldest >= $0 } ?? false) ? oldest - 1 : oldest
        guard until > since else { return nil }
        p.until = until
        p.asked += 1
        let next = Self.ask(subscription: asks[index].subscription, pubkeys: asks[index].pubkeys, since: since, until: until, limit: limit)
        sendAsk?(relay, next)
        return next
    }

    /// Read from one relay until it stops or this inbox closes.
    private func listen(on socket: NostrRelaySocket, relay: Int) {
        socket.receiveText { [weak self] result in
            guard let self else { return }
            guard case .success(let text) = result else {
                // a dead socket is done, and let go: never opened again in this listen; the ID's moves to another relay
                DispatchQueue.main.async {
                    guard !self.closed else { return }
                    if self.oneRelay, self.relaySockets[relay] === socket {
                        self.relayLost(relay)
                    } else {
                        self.drop(socket, relay: relay)
                    }
                }
                return
            }
            DispatchQueue.main.async { self.took(text, relay: relay) }
            self.listen(on: socket, relay: relay)
        }
    }

    /// One line from a relay. `["EVENT", <sub>, <event>]` is the only kind that
    /// carries anything; an EOSE for one of this inbox's subscriptions may ask
    /// for the next page (`pageEnded`); a CLOSED for one moves the Foxy ID's
    /// inbox to another relay; everything else (NOTICE, AUTH) is ignored.
    /// `relay`: the relay's place in `open`'s list, -1 where no page is followed.
    func took(_ text: String, relay: Int = -1) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !closed, text.utf8.count <= Self.largestPayment,
              let data = text.data(using: .utf8),
              let parts = (try? JSONSerialization.jsonObject(with: data)) as? [Any] else { return }
        // a NOTICE while the Foxy ID's listen waits for its REQs' ends is a refusal (a relay over its limits says so)
        if (parts.first as? String) == "NOTICE", oneRelay, relay >= 0, answer != nil, relaySockets[relay] != nil {
            print("[foxy] \(label): the relay sent a notice before ending every REQ; trying another")
            relayLost(relay)
            return
        }
        guard parts.count >= 2, let sub = parts[1] as? String,
              let index = asks.firstIndex(where: { $0.subscription == sub }) else { return }
        if (parts[0] as? String) == "EOSE" {
            let more = pages > 1 ? pageEnded(relay: relay, ask: index) : nil
            guard relay >= 0, relaySockets[relay] != nil else { return }
            if oneRelay, answer != nil { armDeadline(relay) }
            guard more == nil else { return }
            finished[relay, default: []].insert(index)
            guard finished[relay]?.count == asks.count else { return }
            if oneRelay {
                if let ended = onEnded { onEnded = nil; ended() }
            } else {
                endedAll = true
                settled.insert(relay)
                endedCheck()
            }
            if oneRelay, let waiting = answer {
                deadline?.cancel()
                deadline = nil
                answer = nil
                waiting(true)
            }
            return
        }
        if (parts[0] as? String) == "CLOSED" {
            if relay >= 0 { relayLost(relay) }
            return
        }
        // a wrap streaming in is the relay answering: the deadline starts again
        if (parts[0] as? String) == "EVENT", oneRelay, relay >= 0, answer != nil, relaySockets[relay] != nil { armDeadline(relay) }
        guard parts.count >= 3, (parts[0] as? String) == "EVENT",
              let object = parts[2] as? [String: Any],
              let json = try? JSONSerialization.data(withJSONObject: object),
              let wrap = NostrEvent.parse(String(decoding: json, as: UTF8.self)) else { return }
        // counted for the page whether or not it opens: the relay's limit counts every wrap it sends
        if relay >= 0, pages > 1 {
            let key = PageKey(relay: relay, ask: index)
            var p = paging[key] ?? Paging()
            p.count += 1
            p.oldest = min(p.oldest, wrap.createdAt)
            paging[key] = p
        }

        // every relay sends the same wrap, and the payer sent it to all of them:
        // one that has opened is not opened again. An id is remembered only
        // once its wrap has opened and checked out, so that a relay sending a
        // wrap that only claims the id (the id is not checked until `unwrap`)
        // cannot make the genuine one from every other relay drop as a copy.
        guard !wrap.id.isEmpty, !seen.contains(wrap.id) else { return }

        // the key the wrap names; an inbox of one key tries that key whatever it names
        let named = wrap.tags.first { $0.count >= 2 && $0[0] == "p" }?[1].lowercased()
        guard let secret = named.flatMap({ secrets[$0] }) ?? (secrets.count == 1 ? secrets.values.first : nil),
              let rumor = NostrEvent.unwrap(wrap, to: secret) else {
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

    /// End the keys and the sockets. The relays keep whatever they were given;
    /// nothing here can take that back, which is the part of this transport the
    /// onion does not have.
    func close() {
        guard !closed else { return }
        closed = true
        for socket in sockets { socket.end() }
        sockets.removeAll()
        relaySockets.removeAll()
        sendAsk = nil
        answer = nil
        onEnded = nil
        deadline?.cancel()
        deadline = nil
        seen.removeAll()
        for key in Array(secrets.keys) { NUT13.wipe(&secrets[key]!) }
        secrets.removeAll()
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
