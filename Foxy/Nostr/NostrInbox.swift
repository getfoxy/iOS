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
/// One at a time, made and ended on the main queue.
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

    private let secret: [UInt8]
    private let pubkey: [UInt8]
    private var sockets: [(task: URLSessionWebSocketTask, session: URLSession)] = []
    private var seen = Set<String>()
    private var closed = false
    private let subscription: String

    /// nil when a key could not be made, which means secp256k1 is unavailable
    /// and nothing here could work anyway.
    init?(onPayment: @escaping (_ body: String) -> Void) {
        guard let s = try? NostrCrypto.newKey(), let p = try? NostrCrypto.publicKey(of: s) else { return nil }
        self.secret = s
        self.pubkey = p
        self.onPayment = onPayment
        // a name for this subscription, unrelated to the key
        self.subscription = NostrEvent.hex((try? NostrCrypto.newKey())?.prefix(8).map { $0 } ?? [0, 1, 2, 3])
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
         * replay at us but the payment we are waiting for. */
        let backdating = 172_800                            // NIP-59's two days
        let since = Int(Date().timeIntervalSince1970) - backdating - 3600
        let filter = "{\"kinds\":[1059],\"#p\":[\"\(NostrEvent.hex(pubkey))\"],\"since\":\(since),\"limit\":64}"
        let ask = "[\"REQ\",\"\(subscription)\",\(filter)]"

        var answered = false
        var left = urls.count
        let report: (Bool) -> Void = { [weak self] ok in
            guard let self, !self.closed else { return }
            if ok, !answered { answered = true; done(true); return }
            left -= 1
            if left == 0, !answered { answered = true; done(false) }
        }

        for relay in urls {
            guard let socket = Route.startSocket(relay, circuit: MintCircuit.label(nil)) else {
                DispatchQueue.main.async { report(false) }
                continue
            }
            sockets.append(socket)
            socket.task.send(.string(ask)) { [weak self] error in
                DispatchQueue.main.async {
                    guard let self, !self.closed else { return }
                    if let error {
                        #if DEBUG
                        print("[foxy] nostr inbox: \(relay.host ?? "?") would not take the ask: \(error.localizedDescription)")
                        #endif
                        report(false)
                        return
                    }
                    self.listen(on: socket)
                    report(true)
                }
            }
        }
    }

    /// Read from one relay until it stops or this inbox closes.
    private func listen(on socket: (task: URLSessionWebSocketTask, session: URLSession)) {
        socket.task.receive { [weak self] result in
            guard let self else { return }
            guard case .success(let answer) = result else { return }   // a dead socket is simply done
            let text: String
            switch answer {
            case .string(let s): text = s
            case .data(let d): text = String(decoding: d, as: UTF8.self)
            @unknown default: text = ""
            }
            DispatchQueue.main.async { self.took(text) }
            self.listen(on: socket)
        }
    }

    /// One line from a relay. `["EVENT", <sub>, <event>]` is the only kind that
    /// carries anything; everything else (EOSE, NOTICE, CLOSED) is ignored.
    func took(_ text: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !closed, text.utf8.count <= Self.largestPayment,
              let data = text.data(using: .utf8),
              let parts = (try? JSONSerialization.jsonObject(with: data)) as? [Any],
              parts.count >= 3, (parts[0] as? String) == "EVENT",
              (parts[1] as? String) == subscription,
              let object = parts[2] as? [String: Any],
              let json = try? JSONSerialization.data(withJSONObject: object),
              let wrap = NostrEvent.parse(String(decoding: json, as: UTF8.self)) else { return }

        // every relay sends the same wrap, and the payer sent it to all of them
        guard !wrap.id.isEmpty, seen.insert(wrap.id).inserted else { return }
        if seen.count > 128 { seen.removeAll(); seen.insert(wrap.id) }

        guard let rumor = NostrEvent.unwrap(wrap, to: secret) else {
            #if DEBUG
            print("[foxy] nostr inbox: a wrap did not open, or did not check out")
            #endif
            return
        }
        print("[foxy] nostr inbox: a payment arrived")
        onPayment(rumor.content)
    }

    /// End the key and the sockets. The relays keep whatever they were given;
    /// nothing here can take that back, which is the part of this transport the
    /// onion does not have.
    func close() {
        guard !closed else { return }
        closed = true
        for socket in sockets {
            socket.task.cancel(with: .goingAway, reason: nil)
            socket.session.invalidateAndCancel()
        }
        sockets.removeAll()
        seen.removeAll()
        print("[foxy] nostr inbox closed")
    }

    deinit { if !closed { sockets.forEach { $0.session.invalidateAndCancel() } } }
}
