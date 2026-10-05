import Foundation

/// Cashu payment requests (NUT-18) paid straight to whoever asked, instead of a
/// token shown and scanned back.
///
/// Receiving: `inboxOpen` makes an onion address for the request on screen
/// (OnionInbox); a payment posted there reaches the page as
/// `FoxyWallet._requestPaid(body, answerId)`, and the page redeems it and says
/// how that went with `inboxAnswer`. `inboxClose` ends the address.
///
/// Paying: `onionPost` sends a payment to another phone's onion address
/// (OnionPost). Everything here is Tor only.
extension FoxyBridge {

    /// An address opened ahead of being wanted, and handed to nobody.
    ///
    /// Tor takes about half a minute to publish a new address before anyone
    /// else can find it. Made at the moment it is needed, the payer scans a
    /// code naming an address that is not listed yet and their wallet retries
    /// until it is — which is most of the wait on a Cashu payment between two
    /// phones.
    ///
    /// So one is kept warm. When the page asks for an address, the warm one is
    /// handed over — published minutes ago, found first time — and another is
    /// started at once for the next payment.
    ///
    /// It costs no privacy that keeping ONE address alive would. Every address
    /// is a fresh key that Tor never gives Foxy (ADD_ONION NEW:ED25519-V3,
    /// DiscardPK), each payer still gets one of their own, and the spare's
    /// address has been given to nobody, so nobody can probe whether it is up.
    func warmSpare() {
        guard spareInbox == nil else { return }
#if canImport(Tor)
        guard TorService.isRunning else { return }
#else
        return
#endif
        let made = OnionInbox(note: "the spare") { [weak self] payment, answer in
            self?.paymentArrived(payment, answer)
        }
        spareInbox = made
        made.open { [weak self] url in
            guard let self else { made.close(); return }
            guard url != nil, self.spareInbox === made else {
                if self.spareInbox === made { self.spareInbox = nil }
                made.close()
                return
            }
        }
    }

    /// Both addresses the request on screen is paid to, as
    /// `{"onion": "...", "nostr": "nprofile1..."}`.
    ///
    /// The onion is the one Foxy itself uses and the only one that leaves
    /// nothing behind. The Nostr key is for everybody else: a browser cannot
    /// resolve `.onion`, and a request naming only an unreachable address is
    /// how cashu.me came to swap 100 sats at the mint and then find it had
    /// nowhere to send them (tools/live/production.md). Either may
    /// be missing; the page leaves out what it did not get.
    private func answerInboxOpen(id: String, onion: String?) {
        openNostrInbox { [weak self] nprofile in
            guard let self else { return }
            var parts = [String]()
            if let onion, !onion.isEmpty { parts.append("\"onion\":" + Self.literalStatic(onion)) }
            if let nprofile { parts.append("\"nostr\":" + Self.literalStatic(nprofile)) }
            guard !parts.isEmpty else {
                self.resolve(id: id, text: nil, error: "No address: Tor is not ready.")
                return
            }
            self.resolve(id: id, text: "{" + parts.joined(separator: ",") + "}", error: nil)
        }
    }

    /// The Nostr key this request is also paid to, or nil when no relay would
    /// listen. A fresh key every time: see NostrInbox.
    private func openNostrInbox(_ done: @escaping (String?) -> Void) {
        if let open = nostrInbox, open.isOpen, let nprofile = open.nprofile { done(nprofile); return }
        nostrInbox?.close()
        guard let made = NostrInbox(onPayment: { [weak self] payment in
            self?.nostrPaymentArrived(payment)
        }) else { done(nil); return }
        nostrInbox = made
        made.open { [weak self] ok in
            guard let self, self.nostrInbox === made else { made.close(); done(nil); return }
            guard ok, let nprofile = made.nprofile else {
                self.nostrInbox = nil
                made.close()
                print("[foxy] nostr inbox: no relay would listen; the request goes without it")
                done(nil)
                return
            }
            print("[foxy] nostr inbox open, a key made for this request only")
            done(nprofile)
        }
    }

    /// A payment that came over Nostr. Nobody to answer — the payer published
    /// and walked away — so the answer key is empty and `_requestPaid`'s
    /// `inboxAnswer` call fails harmlessly. The claim watch is what tells the
    /// payer, the same as for a token that was shown rather than delivered.
    private func nostrPaymentArrived(_ payment: String) {
        print("[foxy] nostr inbox: a payment arrived (\(payment.utf8.count) bytes)")
        evaluate("window.FoxyWallet && window.FoxyWallet._requestPaid && window.FoxyWallet._requestPaid("
                 + Self.literalStatic(payment) + ", \"\")")
    }

    /// {url} of the address the request on screen is paid to: the one already
    /// open, the warm spare, or a new one. An error when Tor is not up (Orbot,
    /// or not yet).
    func handleInboxOpen(id: String, body: [String: Any]) {
        if let open = inbox, open.isOpen, let url = open.url {
            answerInboxOpen(id: id, onion: url.absoluteString)
            return
        }
        /* The warm one, if it got as far as an address. Handed over and
         * replaced in the same breath, so the next payment has one too. */
        if let ready = spareInbox, ready.isOpen, let url = ready.url {
            inbox?.close()
            /* It stops being the spare the moment it is handed over, and its
             * name has to stop saying so: without this, backgrounding closed
             * two inboxes and the log called both of them "the spare". */
            ready.note = "for the request on screen"
            inbox = ready
            spareInbox = nil
            print("[foxy] onion inbox handed the spare, already published")
            answerInboxOpen(id: id, onion: url.absoluteString)
            warmSpare()
            return
        }
        inbox?.close()
        let made = OnionInbox { [weak self] payment, answer in
            self?.paymentArrived(payment, answer)
        }
        inbox = made
        made.open { [weak self] url in
            // the address goes with us; warmSpare next door has always done this
            guard let self else { made.close(); return }
            guard let url, self.inbox === made else {
                if self.inbox === made { self.inbox = nil }
                made.close()
                self.resolve(id: id, text: nil, error: "No onion address: Tor is not ready.")
                return
            }
            #if DEBUG
            print("[foxy] onion inbox at \(made.localURL?.absoluteString ?? "?")")
            #endif
            self.answerInboxOpen(id: id, onion: url.absoluteString)
        }
    }

    /// Foxy leaving the foreground ends the address, as `inboxClose` does, but
    /// with no page call to answer. The page forgets its side when it comes
    /// back (`inboxWake`, build/app/12-receive.js) and opens a fresh one, so a
    /// request left on screen across a background cannot go on naming an
    /// address that is gone (nothing closed it and nothing reopened it).
    func closeInboxForBackground() {
        // the spare as well: no address of this phone's outlives the foreground
        spareInbox?.close()
        spareInbox = nil
        nostrInbox?.close()
        nostrInbox = nil
        // and any that were still answering for a payment on the wire: nothing
        // of this phone's survives backgrounding, and Tor is about to be told
        // to stop anyway (TorService.backgrounded)
        retiringInboxes.forEach { $0.close() }
        retiringInboxes.removeAll()
        guard inbox != nil else { return }
        inbox?.close()
        inbox = nil
        inboxAnswers.removeAll()
        print("[foxy] onion inbox closing: Foxy is leaving the foreground")
    }

    /// The screen is done with the address. `hold` seconds keep it answering.
    ///
    /// A payment can be on the wire towards it. Closing at once is `DEL_ONION`,
    /// and that is worse than an address nobody knows: the descriptor is still
    /// cached at the directories, so the payer's Tor fetches it, tries
    /// introduction points with nothing behind them, refetches, and holds the
    /// SOCKS stream to its own 120-second ceiling before saying "unreachable".
    /// Measured on two phones: a tap whose link dropped
    /// because the receiver changed screen fell back to the onion and took
    /// 120893 ms, then 130714 ms — against an address destroyed 1.6 s after the
    /// screen changed, which was before the payer had even finished minting the
    /// token. There was no ordering in which it could have worked.
    ///
    /// This is what `TapLink.stop(whenIdle:)` already does for the radio, done
    /// for the address: a payment that may be on the wire outlives the screen
    /// that was showing it. A retiring inbox goes on answering — `paymentArrived`
    /// is bound to the bridge rather than to the `inbox` property, and the
    /// page's `openRequests` entry lives an hour — and the screen gets a fresh
    /// address immediately from `warmSpare`, so nothing waits on the hold.
    ///
    /// It costs no privacy. The address was already handed to a payer; keeping
    /// it up a little longer tells nobody anything they could not already probe,
    /// and it is discarded for good at the end of the hold.
    func handleInboxClose(id: String, body: [String: Any]) {
        let hold = min(max((body["hold"] as? NSNumber)?.doubleValue ?? 0, 0), 180)
        if let going = inbox, hold > 0 {
            retiringInboxes.append(going)
            print("[foxy] onion inbox kept answering for \(Int(hold))s: a payment may be on its way")
            DispatchQueue.main.asyncAfter(deadline: .now() + hold) { [weak self] in
                guard let self else { going.close(); return }
                if let at = self.retiringInboxes.firstIndex(where: { $0 === going }) {
                    self.retiringInboxes.remove(at: at)
                }
                going.close()
            }
        } else {
            inbox?.close()
        }
        inbox = nil
        // the key dies with the request it was made for (NostrInbox)
        nostrInbox?.close()
        nostrInbox = nil
        resolve(id: id, text: "ok", error: nil)
        // the next receive should not wait for Tor to publish either
        warmSpare()
    }

    /// The page's word on a payment it was handed: {answer, status, text}.
    /// Only the statuses a payer is told are let through, and a short text.
    func handleInboxAnswer(id: String, body: [String: Any]) {
        guard let key = body["answer"] as? String, let answer = inboxAnswers.removeValue(forKey: key) else {
            resolve(id: id, text: nil, error: "No payment is waiting on that answer.")
            return
        }
        let asked = (body["status"] as? NSNumber)?.intValue ?? 422
        let status = [200, 409, 422].contains(asked) ? asked : 422
        let text = String((body["text"] as? String ?? "").prefix(300))
        let json = (try? JSONSerialization.data(withJSONObject: status == 200 ? ["ok": true] : ["error": text]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? ""
        answer(status, json)
        resolve(id: id, text: "ok", error: nil)
    }

    private func paymentArrived(_ payment: String, _ answer: @escaping OnionInbox.Answer) {
        let key = MintCircuit.label(nil)
        inboxAnswers[key] = answer
        // unanswered, the inbox answers 504 on its own; the key goes too
        DispatchQueue.main.asyncAfter(deadline: .now() + 110) { [weak self] in
            self?.inboxAnswers[key] = nil
        }
        print("[foxy] onion inbox: a payment arrived (\(payment.utf8.count) bytes)")
        evaluate("window.FoxyWallet && window.FoxyWallet._requestPaid && window.FoxyWallet._requestPaid("
                 + Self.literalStatic(payment) + ", " + Self.literalStatic(key) + ")")
    }

    /// {target, body}: a payment handed to the relays a request's nprofile
    /// names, over Tor (NostrDelivery). Answers how many took it.
    func handleNostrSend(id: String, body: [String: Any]) {
        guard let target = body["target"] as? String, !target.isEmpty else {
            resolve(id: id, text: nil, error: "That request names no Nostr address.")
            return
        }
        let payload = body["body"] as? String ?? ""
        guard !payload.isEmpty, payload.utf8.count <= NostrCrypto.longestMessage / 2 else {
            resolve(id: id, text: nil, error: "That payment is too large to send over Nostr.")
            return
        }
        NostrDelivery.send(payload: payload, to: target) { [weak self] result in
            switch result {
            case .success(let answer):
                print("[foxy] nostr: \(answer.accepted.count) relay(s) took the payment, "
                      + "\(answer.refused.count) did not")
                guard !answer.accepted.isEmpty else {
                    let why = answer.refused.values.first ?? "no relay took it"
                    self?.resolve(id: id, text: nil, error: "No relay took the payment: " + why)
                    return
                }
                self?.resolve(id: id, text: String(answer.accepted.count), error: nil)
            case .failure(let error):
                print("[foxy] nostr: the payment could not be wrapped: \(error)")
                self?.resolve(id: id, text: nil, error: "The payment could not be sent over Nostr.")
            }
        }
    }

    /// {url, body, circuit}: "status\nbody" from the other phone, or an error
    /// the page shows as it is.
    func handleOnionPost(id: String, body: [String: Any]) {
        guard let text = body["url"] as? String, let url = URL(string: text) else {
            resolve(id: id, text: nil, error: OnionPost.Failure.notOnion.text)
            return
        }
        let payment = Data((body["body"] as? String ?? "").utf8)
        guard !payment.isEmpty, payment.count <= OnionInbox.largestPayment else {
            resolve(id: id, text: nil, error: "That payment is too large to send.")
            return
        }
        /* How long this one attempt may take, from the page's own budget.
         *
         * Left to itself `OnionPost.send` waits 120 seconds, which is also
         * Tor's `SocksTimeout`, and the page's retry budget was only ever
         * consulted *between* attempts — so a single attempt ran past it and
         * the two failures measured were 120893 ms and 130714 ms, one
         * ceiling and two. A live rendezvous between two Foxys takes about
         * three seconds; nothing that has not answered in a few tens of seconds
         * is going to. */
        let seconds = (body["timeout"] as? NSNumber)?.doubleValue ?? 0
        let ceiling = seconds > 0 ? min(max(seconds / 1000, 3), 120) : 120
        OnionPost.send(url, body: payment, circuit: MintCircuit.label(body["circuit"]),
                       timeout: ceiling) { [weak self] result in
            switch result {
            case .success(let answer):
                self?.resolve(id: id, text: "\(answer.status)\n" + answer.body, error: nil)
            case .failure(let failure):
                print("[foxy] onion post failed: \(failure)")
                self?.resolve(id: id, text: nil, error: failure.text)
            }
        }
    }
}
