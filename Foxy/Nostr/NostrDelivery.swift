import Foundation

/// Handing a Cashu payment to a wallet that asked for it over Nostr (NUT-18).
///
/// The payment is wrapped for the receiver (NostrEvent) and published to the
/// relays their request names, each over Tor on its own circuit. What a relay
/// sees is an encrypted message addressed to the receiver's key, signed by a
/// key made for this payment and thrown away after. It never learns who sent
/// it, what it holds, or where this phone is.
///
/// Foxy only sends. It has no Nostr identity, listens on no relay, and reads
/// nothing: its own requests are answered over Tor instead (OnionInbox).
enum NostrDelivery {

    /// Relays Foxy will fall back to when a request names none. The ones
    /// cashu.me and Minibits publish to and listen on by default, so a payment
    /// still reaches them.
    static let fallbackRelays = ["wss://relay.damus.io", "wss://nos.lol",
                                 "wss://relay.primal.net", "wss://relay.minibits.cash"]
    /// At most this many relays for one payment, and this long on each.
    static let mostRelays = 5
    static let patience: TimeInterval = 25

    struct Result {
        var accepted: [String] = []
        var refused: [String: String] = [:]
    }

    /// Wrap `payload` for the `nprofile` in a payment request and publish it.
    /// `done` on the main queue once every relay has answered or timed out.
    static func send(payload: String, to nprofile: String,
                     done: @escaping (Swift.Result<Result, Error>) -> Void) {
        guard let (pubkey, listed) = Bech32.nprofile(nprofile) else {
            done(.failure(NostrCrypto.Failure.badPeer))
            return
        }
        let urls = relays(listed)
        guard !urls.isEmpty else {
            done(.failure(NostrCrypto.Failure.badPeer))
            return
        }
        let wrap: NostrEvent.Event
        do {
            wrap = try NostrEvent.giftWrapped(payload: payload, receiver: pubkey)
        } catch {
            done(.failure(error))
            return
        }
        let json = NostrEvent.json(wrap)
        let message = "[\"EVENT\",\(json)]"

        var result = Result()
        var left = urls.count
        let finish: (String, String?) -> Void = { relay, refusal in
            // on the main queue
            if let refusal { result.refused[relay] = refusal } else { result.accepted.append(relay) }
            left -= 1
            if left == 0 { done(.success(result)) }
        }
        #if DEBUG
        print("[foxy] nostr: wrap \(wrap.id) to \(urls.count) relay(s)")
        #endif
        for relay in urls {
            publish(message, id: wrap.id, to: relay) { refusal in finish(relay.absoluteString, refusal) }
        }
    }

    /// The relays to try: the request's own first, then Foxy's fallbacks when it
    /// named none. Only wss, and at most `mostRelays`.
    static func relays(_ listed: [String]) -> [URL] {
        let names = listed.isEmpty ? fallbackRelays : listed
        var out = [URL]()
        for name in names {
            guard out.count < mostRelays, let url = URL(string: name.trimmingCharacters(in: .whitespaces)),
                  url.scheme == "wss", url.host != nil,
                  !out.contains(where: { $0.absoluteString == url.absoluteString }) else { continue }
            out.append(url)
        }
        return out
    }

    /// One relay: send the event, wait for its OK. `done` with nil when the
    /// relay took it, or why it did not.
    private static func publish(_ message: String, id: String, to relay: URL,
                                done: @escaping (String?) -> Void) {
        guard let socket = Route.startSocket(relay, circuit: MintCircuit.label(nil)) else {
            DispatchQueue.main.async { done(Route.refusal) }
            return
        }
        let answered = Locked(false)
        func finish(_ refusal: String?) {
            /* One step, not two. The timeout below runs on a global queue and
             * the socket's completions run on URLSession's — a read then a
             * write let both through, and this relay finished twice. `left`
             * in send() then skipped 0, so the page's promise was never
             * answered; or it reached 0 early and was answered twice. */
            if answered.exchange({ _ in true }) { return }
            socket.task.cancel(with: .goingAway, reason: nil)
            socket.session.invalidateAndCancel()
            DispatchQueue.main.async { done(refusal) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + patience) { finish("no answer in time") }

        func listen() {
            socket.task.receive { result in
                switch result {
                case .failure(let error):
                    finish(error.localizedDescription)
                case .success(let answer):
                    let text: String
                    switch answer {
                    case .string(let s): text = s
                    case .data(let d): text = String(decoding: d, as: UTF8.self)
                    @unknown default: text = ""
                    }
                    switch reading(text, id: id) {
                    case .some(let refusal): finish(refusal.isEmpty ? nil : refusal)
                    case .none: listen()               // something else the relay said
                    }
                }
            }
        }
        socket.task.send(.string(message)) { error in
            if let error { finish(error.localizedDescription); return }
            listen()
        }
    }

    /// A relay's answer about this event: nil when it is about something else,
    /// "" when the event was taken, and the reason when it was not.
    ///
    /// NIP-01: `["OK", <id>, <true|false>, <message>]`. A "duplicate:" refusal
    /// means the relay already has it, which is as good as taking it.
    static func reading(_ text: String, id: String) -> String? {
        guard let data = text.data(using: .utf8),
              let parts = (try? JSONSerialization.jsonObject(with: data)) as? [Any],
              parts.count >= 3, (parts[0] as? String) == "OK", (parts[1] as? String) == id else { return nil }
        let took = (parts[2] as? Bool) ?? ((parts[2] as? NSNumber)?.boolValue ?? false)
        let said = parts.count > 3 ? (parts[3] as? String ?? "") : ""
        if took || said.hasPrefix("duplicate:") { return "" }
        return said.isEmpty ? "the relay refused it" : String(said.prefix(120))
    }
}
