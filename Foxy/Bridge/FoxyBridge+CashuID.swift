import Foundation

/// The Foxy ID's inbox (docs/FOXY-ID.md).
///
/// A Foxy ID names a Nostr key for this wallet's deliveries: the delivery key Q,
/// derived from the seed at its own path (CashuID.swift) and used for nothing
/// else on Nostr. A payer gift-wraps each payment not to Q but to one of the
/// sixteen keys Q moves to on the UTC day it posts (`CashuID.dropTweak`), and a
/// second copy to one of the next day's (NIP-17 over NIP-59, the road `nostrSend`
/// takes); the relays hold them until this phone listens.
///
/// The ID outlives every screen: that is the point of an ID somebody keeps in
/// their contacts. What the relays are asked changes every day: one day's keys,
/// padded to `NostrInbox.askKeys`, at one relay picked at random, so a relay sees
/// no key one day that it saw another (THREAT-MODEL.md says what is left).
///
/// `cashuIdInboxOpen {days, any}` listens on the keys of the UTC days named
/// (`cashuIdDays`: today and the days since the phone last finished a listen),
/// always in `cashuIdAskCount` REQs of `NostrInbox.askKeys` keys covering the
/// window three days each, the days not asked filled with keys made for the REQ,
/// so neither a REQ's size nor their count says how long the phone was away.
/// A random few seconds later, in REQs of their own at every relay, it listens
/// on each ANY WALLET request's key in `any` (8 hex each), and once every relay
/// has ended all their REQs or failed hands the ids back (`_cashuIdAnyHeard`). Q itself is never
/// asked for: it is all a relay needs to work out every day's keys. Each delivery
/// reaches the page as `FoxyWallet._cashuIdArrived(body)`; it answers "1" once
/// the relay listening has answered every REQ of the day keys to its end (EOSE),
/// or "0" when none would or the listen was ended first; a second open closes
/// the first. `cashuIdInboxClose` ends it, as Foxy
/// leaving the foreground does (`closeInboxForBackground`); the page opens it
/// again on its wake. The private half is read on the seed queue and handed to
/// the inbox; nothing of it reaches the page.
///
/// `cashuIdCopiesOpen {since}` is the same on the recovery key
/// (m/129373'/20'/3'/0'/0'): the copies this phone sends itself of its own
/// payments to contacts, read back only after its words were restored, each
/// reaching the page as `FoxyWallet._cashuIdCopy(body)`. It is closed with the
/// other (`cashuIdInboxClose`, and Foxy leaving the foreground).
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

    /// The days one open covers: the window's thirty-two and today.
    static let cashuIdWindowDays = 33
    /// Days of keys in one REQ: three days of sixteen fill `NostrInbox.askKeys`.
    static let cashuIdDaysPerAsk = NostrInbox.askKeys / CashuID.dropSlots
    /// The REQs of every listen, whatever it asks: the window, three days each.
    static let cashuIdAskCount = (cashuIdWindowDays + cashuIdDaysPerAsk - 1) / cashuIdDaysPerAsk
    /// The most ANY WALLET requests listened for at once: a year of them, opened often, in REQs of `NostrInbox.askKeys`.
    static let cashuIdMostAny = 20 * NostrInbox.askKeys
    /// How long after the day's keys the ANY WALLET keys are asked for, at the least and at the most, in seconds.
    static let cashuIdLastingDelay: ClosedRange<Double> = 3...30

    /// The page's `days`: whole numbers from 32 days before `today` to `today`,
    /// each once, newest first; today alone when it names none that are.
    static func cashuIdDays(_ value: Any?, today: Int) -> [Int] {
        var out: [Int] = []
        for item in (value as? [Any]) ?? [] {
            guard let number = item as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { continue }
            let double = number.doubleValue
            guard double.isFinite, double == double.rounded() else { continue }
            let day = Int(double)
            guard day >= today - (cashuIdWindowDays - 1), day <= today, !out.contains(day) else { continue }
            out.append(day)
        }
        out.sort(by: >)
        return out.isEmpty ? [today] : out
    }

    /// The page's `any`: 4-byte request ids in hex, each once, at most `cashuIdMostAny`.
    static func cashuIdAnyIds(_ value: Any?) -> [[UInt8]] {
        var out: [[UInt8]] = []
        for item in (value as? [Any]) ?? [] {
            guard let text = item as? String, text.utf8.count == 8,
                  let bytes = try? NUT13.bytes(hex: text.lowercased()), bytes.count == 4, !out.contains(bytes) else { continue }
            out.append(bytes)
            if out.count == cashuIdMostAny { break }
        }
        return out
    }

    /// The `cashuIdAskCount` REQs of a listen on `today`: the window's days, three to a REQ, newest first, each from
    /// two days (NIP-59's backdating) before the start of its oldest day; `days` the ones of them asked for (the rest
    /// of each REQ is filler).
    static func cashuIdAsks(days asked: [Int], today: Int) -> [(days: [Int], since: Int)] {
        (0..<cashuIdAskCount).map { at in
            let group = (0..<cashuIdDaysPerAsk).map { today - at * cashuIdDaysPerAsk - $0 }
            return (group.filter { asked.contains($0) }, (group.min() ?? today) * 86_400 - 172_800)
        }
    }

    /// {days, any} → "1" once the relay listening has answered every REQ of the day keys to its end, "0" otherwise.
    func handleCashuIdInboxOpen(id: String, body: [String: Any]) {
        closeCashuIdInbox(.delivery)
        let now = Int(Date().timeIntervalSince1970)
        let today = now / 86_400
        let plan = Self.cashuIdAsks(days: Self.cashuIdDays(body["days"], today: today), today: today)
        let any = Self.cashuIdAnyIds(body["any"])
        // an ANY WALLET request is heard for a year; its payments reach back as far as a payment waits, rounded to the day
        let lastingSince = (today - 32) * 86_400
        let ticket = UUID()
        cashuIdTicket = ticket
        Self.seedQueue.async {
            let read = Result { () -> (days: [NostrInbox.Wanted], lasting: [NostrInbox.Wanted]) in
                var q = try SeedActions.cashuIdDeliverySecret(.live)
                defer { NUT13.wipe(&q) }
                let days = try plan.map { ask in
                    NostrInbox.Wanted(secrets: try CashuID.dropSecrets(base: q, days: ask.days.map { UInt32($0) }), since: ask.since)
                }
                let secrets = try CashuID.anySecrets(base: q, ids: any)
                let lasting = stride(from: 0, to: secrets.count, by: NostrInbox.askKeys).map {
                    NostrInbox.Wanted(secrets: Array(secrets[$0..<min(secrets.count, $0 + NostrInbox.askKeys)]), since: lastingSince)
                }
                return (days, lasting)
            }
            let anyHex = any.map { NUT13.hex($0) }
            DispatchQueue.main.async { self.listenCashuIdDays(id: id, read: read, any: anyHex, ticket: ticket) }
        }
    }

    /// The day's inbox, made and opened on the main queue unless a close (or
    /// another open) came while the seed was read; then the ANY WALLET one, later, at every relay. `any`: the
    /// requests' ids, handed back to the page (`_cashuIdAnyHeard`) once every relay has ended their REQs or failed.
    private func listenCashuIdDays(id: String, read: Result<(days: [NostrInbox.Wanted], lasting: [NostrInbox.Wanted]), Error>,
                                   any: [String], ticket: UUID) {
        dispatchPrecondition(condition: .onQueue(.main))
        var wanted: (days: [NostrInbox.Wanted], lasting: [NostrInbox.Wanted])
        switch read {
        case .failure(let error): resolve(id: id, text: nil, error: SeedActions.problem(error)); return
        case .success(let made): wanted = made
        }
        defer {
            for i in wanted.days.indices { for j in wanted.days[i].secrets.indices { NUT13.wipe(&wanted.days[i].secrets[j]) } }
            for i in wanted.lasting.indices { for j in wanted.lasting[i].secrets.indices { NUT13.wipe(&wanted.lasting[i].secrets[j]) } }
        }
        guard cashuIdTicket == ticket else { resolve(id: id, text: "0", error: nil); return }
        guard let inbox = NostrInbox(asks: wanted.days, label: "foxy id inbox", pages: Self.cashuIdPages,
                                     onPayment: { [weak self] body in self?.cashuIdArrived(body) }) else {
            resolve(id: id, text: nil, error: "The Foxy ID's inbox could not be made.")
            return
        }
        let lasting = wanted.lasting.isEmpty ? nil
            : NostrInbox(asks: wanted.lasting, label: "foxy id any wallet", pages: Self.cashuIdPages, everyRelay: true,
                         onPayment: { [weak self] body in self?.cashuIdArrived(body) })
        lasting?.onEnded = { [weak self] in
            // only now does the page count these requests as asked (a listen put away before this asks them again)
            self?.evaluate("window.FoxyWallet && window.FoxyWallet._cashuIdAnyHeard && window.FoxyWallet._cashuIdAnyHeard("
                           + Self.literalStatic(any.joined(separator: ",")) + ")")
        }
        cashuIdInbox = inbox
        cashuIdAnswer = { [weak self] count in self?.resolve(id: id, text: String(count), error: nil) }
        print("[foxy] foxy id inbox: \(wanted.days.count) REQ(s) of the day's keys" + (lasting == nil ? "" : ", the ANY WALLET keys later"))
        inbox.open { [weak self, weak inbox] ok in
            guard let self, let inbox, self.cashuIdInbox === inbox else { return }
            if !ok {
                inbox.close()
                self.cashuIdInbox = nil
            }
            print("[foxy] foxy id inbox: " + (ok ? "every REQ answered; listening" : "not listening: no relay answered every REQ"))
            let waiting = self.cashuIdAnswer
            self.cashuIdAnswer = nil
            waiting?(ok ? 1 : 0)
        }
        guard let lasting else { return }
        /* Not in the same REQ, nor on the same circuit, nor at the same moment:
         * an ANY WALLET key is asked on many days, so a REQ holding it beside
         * the day's keys would tie those days together. At every relay, as a
         * request's inbox listens (another wallet may post to only one of the
         * code's relays, and the key is the same at each, so asking all three
         * tells them nothing more); a random few seconds on. What is left is
         * that relays comparing notes and watching the time can guess the two
         * go together (THREAT-MODEL.md). */
        cashuIdLasting = lasting
        let wait = Double.random(in: Self.cashuIdLastingDelay)
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self, weak lasting] in
            guard let self, let lasting, self.cashuIdLasting === lasting, self.cashuIdTicket == ticket else { return }
            lasting.open { [weak self, weak lasting] ok in
                guard let self, let lasting, self.cashuIdLasting === lasting else { return }
                if !ok { lasting.close(); self.cashuIdLasting = nil }
                print("[foxy] foxy id any wallet: " + (ok ? "listening" : "not listening: no relay answered"))
            }
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
        let label = which == .delivery ? "foxy id inbox" : "foxy id copies"
        guard let inbox = NostrInbox(secret: secret, since: since, label: label, pages: Self.cashuIdPages, onPayment: { [weak self] body in
            switch which {
            case .delivery: self?.cashuIdArrived(body)
            case .copies: self?.cashuIdCopyArrived(body)
            }
        }) else {
            resolve(id: id, text: nil, error: "The Foxy ID's inbox could not be made.")
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

    /// Stop listening, on both keys. The keys are the seed's; nothing is thrown away.
    func handleCashuIdInboxClose(id: String, body: [String: Any]) {
        closeCashuIdInbox()
        resolve(id: id, text: "ok", error: nil)
    }

    /// Ends every inbox of the ID's (Foxy leaving the foreground, `closeInboxForBackground`).
    func closeCashuIdInbox() {
        closeCashuIdInbox(.delivery)
        closeCashuIdInbox(.copies)
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
            if let lasting = cashuIdLasting { cashuIdLasting = nil; lasting.close() }
        case .copies:
            cashuIdCopiesTicket = nil
            open = cashuIdCopies; cashuIdCopies = nil
            waiting = cashuIdCopiesAnswer; cashuIdCopiesAnswer = nil
        }
        if let open {
            print("[foxy] foxy id: closing the " + (which == .delivery ? "inbox" : "copies' inbox"))
            open.close()
        }
        waiting?(0)
    }

    /// One delivery. Nobody to answer, as with any payment over Nostr; the page
    /// decides whether it is one it takes (`_cashuIdArrived`).
    private func cashuIdArrived(_ payment: String) {
        print("[foxy] foxy id: a delivery arrived (\(payment.utf8.count) bytes)")
        evaluate("window.FoxyWallet && window.FoxyWallet._cashuIdArrived && window.FoxyWallet._cashuIdArrived("
                 + Self.literalStatic(payment) + ")")
    }

    /// One of this phone's own copies, read back after a restore. The page
    /// believes it only where this seed made it (`cidCopyArrived`).
    private func cashuIdCopyArrived(_ copy: String) {
        print("[foxy] foxy id: a copy of a payment arrived (\(copy.utf8.count) bytes)")
        evaluate("window.FoxyWallet && window.FoxyWallet._cashuIdCopy && window.FoxyWallet._cashuIdCopy("
                 + Self.literalStatic(copy) + ")")
    }
}
