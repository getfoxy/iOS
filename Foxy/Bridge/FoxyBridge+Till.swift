import Foundation

/// The till (point of sale): where a cashier's phone sends the money it takes.
///
/// A keeper's CASHIER CODE names a Nostr key made for that code alone. The
/// cashier's phone locks every payment it takes to the keeper and gift-wraps it
/// to that key at once (`nostrSend`, the same road a NUT-18 payment takes), and
/// the relays hold it until this phone listens. So the key has to outlive the
/// screen that showed it, which no other key of Foxy's does: it is kept in the
/// Keychain, never in page storage, for the code's three days and the week
/// after it ends that a late payment may still arrive in, and thrown away
/// with the code.
///
/// `tillKeyMake {id}` makes the key and answers its nprofile; `tillKeyDrop {id}`
/// throws it away. `tillInboxOpen {ids, since}` listens on up to four of them, each
/// payment reaching the page as `FoxyWallet._tillArrived(id, body)`, and
/// answers how many are listening. `tillInboxClose` ends them,
/// as Foxy leaving the foreground does (`closeInboxForBackground`); the page
/// opens them again on its wake.
extension FoxyBridge {

    /// The till's inboxes and the page's `tillInboxOpen` waiting on them.
    ///
    /// A NostrInbox that is closed while it is opening never calls back, so a
    /// reopen, a drop or a trip to the background would otherwise leave the
    /// page's call unanswered for good. Whatever ends an inbox here also counts
    /// it as answered. Main queue only.
    final class TillInboxes {
        /// The most codes a phone keeps live, and so the most listened on.
        static let most = 4

        private(set) var open: [String: NostrInbox] = [:]
        private var pending = Set<String>()
        private var opened = 0
        private var answer: ((Int) -> Void)?

        var isEmpty: Bool { open.isEmpty }

        /// Open every inbox in `made`; `done` once each has opened or failed.
        /// The ones that failed are closed, so `open` holds only listening ones.
        func start(_ made: [String: NostrInbox], done: @escaping (Int) -> Void) {
            dispatchPrecondition(condition: .onQueue(.main))
            open = made
            pending = Set(made.keys)
            opened = 0
            answer = done
            guard !made.isEmpty else { finish(); return }
            for (id, inbox) in made {
                inbox.open { [weak self, weak inbox] ok in
                    guard let self, let inbox, self.open[id] === inbox, self.pending.remove(id) != nil else { return }
                    if ok {
                        self.opened += 1
                    } else {
                        inbox.close()
                        self.open[id] = nil
                    }
                    self.finishIfDone()
                }
            }
        }

        /// One code's inbox ended (its key is being thrown away).
        func drop(_ id: String) {
            dispatchPrecondition(condition: .onQueue(.main))
            open.removeValue(forKey: id)?.close()
            if pending.remove(id) != nil { finishIfDone() }
        }

        /// All of them ended. A call still waiting is told how many are open,
        /// which is none.
        func close() {
            dispatchPrecondition(condition: .onQueue(.main))
            open.values.forEach { $0.close() }
            open.removeAll()
            pending.removeAll()
            opened = 0
            finish()
        }

        private func finishIfDone() { if pending.isEmpty { finish() } }

        private func finish() {
            let waiting = answer
            answer = nil
            waiting?(opened)
        }
    }

    /// The furthest back the page may ask the relays to reach: a code's three
    /// days, the week after it ends that the page still listens for it, and
    /// NIP-59's two of backdating on its first payment, which may be stamped
    /// two days before it was sent (NostrInbox.open). The page asks from the
    /// oldest listened code's start less those two (`tillSinceFor`,
    /// 08d-till.js), so a keeper back days after a code was made still reads
    /// its first sales. A fixed five days from each open missed them.
    static let tillWindow = 12 * 86_400

    /// What is asked for when the page names no start, or one outside
    /// `tillWindow`: a code's three days and the two of backdating.
    static let tillWindowDefault = 5 * 86_400

    /// The page's `since`, in unix seconds, when it is a number inside the
    /// last `tillWindow`; otherwise `tillWindowDefault` back from now. A start
    /// in the future or weeks ago is not something the page makes, and is
    /// not let ask the relays for every wrap they hold for a key.
    static func tillSince(_ value: Any?, now: Int) -> Int {
        let fallback = now - tillWindowDefault
        guard let number = value as? NSNumber, !(value is Bool) else { return fallback }
        let seconds = number.doubleValue
        guard seconds.isFinite, seconds >= Double(now - tillWindow), seconds <= Double(now) else { return fallback }
        return Int(seconds)
    }

    /// A cashier code's id, as the page makes it: 16 lowercase hex. Checked
    /// before it goes anywhere near the Keychain, so that nothing the page
    /// sends can name another item there, the seed's among them.
    static func tillID(_ value: Any?) -> String? {
        guard let text = value as? String, text.utf8.count == 16,
              text.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        return text
    }

    static func tillKeyName(_ id: String) -> String { "till.nostr." + id }

    /// A secret as it is kept: 64 lowercase hex, 32 bytes.
    private static func tillSecret(_ hex: String) -> [UInt8]? {
        guard hex.utf8.count == 64,
              hex.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        let bytes = NostrEvent.bytes(hex)
        return bytes.count == 32 ? bytes : nil
    }

    /// {id} → the nprofile the cashier's phone delivers to.
    ///
    /// A key already kept for this id is answered again rather than replaced:
    /// a page that asks twice (a retry after an answer it never saw) may have
    /// shown the first nprofile already, and a replaced key would leave every
    /// payment sent to it unreadable. A Keychain that does not answer is not
    /// taken for "no key" for the same reason.
    func handleTillKeyMake(id: String, body: [String: Any]) {
        guard let pass = Self.tillID(body["id"]) else {
            resolve(id: id, text: nil, error: "That is not a cashier code.")
            return
        }
        let name = Self.tillKeyName(pass)
        var secret: [UInt8]
        switch SeedStore.read(key: name) {
        case .found(let hex) where Self.tillSecret(hex) != nil:
            secret = Self.tillSecret(hex) ?? []
        case .failed:
            resolve(id: id, text: nil, error: "The Keychain did not answer. Try again.")
            return
        default:
            guard let made = try? NostrCrypto.newKey() else {
                resolve(id: id, text: nil, error: "A key for the cashier code could not be made.")
                return
            }
            secret = made
            guard SeedStore.save(NostrEvent.hex(made), key: name) else {
                resolve(id: id, text: nil, error: "The cashier code's key could not be kept.")
                return
            }
        }
        let pubkey = try? NostrCrypto.publicKey(of: secret)
        for i in secret.indices { secret[i] = 0 }
        guard let pubkey,
              let nprofile = Bech32.nprofile(pubkey: pubkey, relays: Array(NostrInbox.relays.prefix(NostrInbox.mostRelays))) else {
            resolve(id: id, text: nil, error: "A key for the cashier code could not be made.")
            return
        }
        resolve(id: id, text: nprofile, error: nil)
    }

    /// {id}: the code is over, and its key with it. Whatever the relays still
    /// hold for it is unreadable from here on, which is the point.
    func handleTillKeyDrop(id: String, body: [String: Any]) {
        guard let pass = Self.tillID(body["id"]) else {
            resolve(id: id, text: nil, error: "That is not a cashier code.")
            return
        }
        tillInboxes.drop(pass)
        guard SeedStore.delete(key: Self.tillKeyName(pass)) else {
            resolve(id: id, text: nil, error: "The cashier code's key could not be thrown away.")
            return
        }
        resolve(id: id, text: "ok", error: nil)
    }

    /// {ids: [...], since} → how many inboxes are listening, as a number.
    /// `since` is the oldest wrap asked for (`tillSince`).
    ///
    /// The set before is closed first, so a page that calls this on every
    /// connect and every wake never has two sockets per relay on one key: the
    /// XS's own Tor was once saturated by pollers nothing stopped. An id with
    /// no key kept is skipped (its code was dropped, or made on another
    /// install), as is anything past the fourth.
    func handleTillInboxOpen(id: String, body: [String: Any]) {
        guard let listed = body["ids"] as? [Any] else {
            resolve(id: id, text: nil, error: "No cashier codes were named.")
            return
        }
        closeTillInboxes()
        var ids = [String]()
        for value in listed {
            guard let pass = Self.tillID(value), !ids.contains(pass) else { continue }
            ids.append(pass)
            if ids.count == TillInboxes.most { break }
        }
        let since = Self.tillSince(body["since"], now: Int(Date().timeIntervalSince1970))
        var made = [String: NostrInbox]()
        for pass in ids {
            guard case .found(let hex) = SeedStore.read(key: Self.tillKeyName(pass)),
                  let secret = Self.tillSecret(hex) else { continue }
            let inbox = NostrInbox(secret: secret, since: since, label: "till inbox " + String(pass.prefix(4))) { [weak self] payment in
                self?.tillPaymentArrived(pass, payment)
            }
            if let inbox { made[pass] = inbox }
        }
        tillInboxes.start(made) { [weak self] count in
            print("[foxy] till: \(count) of \(made.count) inbox(es) listening")
            self?.resolve(id: id, text: String(count), error: nil)
        }
    }

    /// Stop listening on every code. The keys stay; the codes are still live.
    func handleTillInboxClose(id: String, body: [String: Any]) {
        closeTillInboxes()
        resolve(id: id, text: "ok", error: nil)
    }

    func closeTillInboxes() {
        if !tillInboxes.isEmpty { print("[foxy] till: closing the inboxes") }
        tillInboxes.close()
    }

    /// One payment from a cashier's phone. Nobody to answer, as with any
    /// payment over Nostr; the page decides whether it is one it takes.
    private func tillPaymentArrived(_ pass: String, _ payment: String) {
        print("[foxy] till: a payment arrived (\(payment.utf8.count) bytes)")
        evaluate("window.FoxyWallet && window.FoxyWallet._tillArrived && window.FoxyWallet._tillArrived("
                 + Self.literalStatic(pass) + ", " + Self.literalStatic(payment) + ")")
    }
}
