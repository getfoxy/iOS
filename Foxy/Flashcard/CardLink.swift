import Foundation
#if targetEnvironment(simulator)
import Network
#else
import CoreNFC
#endif

/* One tap of a card: the phone's NFC session, and the card found in it.
 *
 * The page asks for a session (`cardBegin`), talks to the card through it one
 * command at a time (`cardSend`), may change the one line of text on the
 * phone's sheet (`cardSay`), and closes it (`cardEnd`). FoxyBridge+Flashcard
 * holds one of these for as long as that lasts and reads every command before
 * it is carried (CardGate).
 *
 * What is carried is not kept and not logged. One of the commands is the
 * card's PIN.
 *
 * `CardReader` is the link the bridge builds: NFC on a phone, and in the
 * simulator, which has no NFC, a stand-in that reaches a card running on the
 * Mac (the last part of this file). The page cannot tell which it has. */

/// Why a session ended without a card, in words the page reads
/// (`cardSession` in build/wallet/21a-flashcard.js tells them apart).
enum CardLinkError: Error, Equatable {
    /// This phone cannot read a card at all, or this build may not.
    case unavailable
    /// The sheet was dismissed.
    case cancelled
    /// Nobody held a card up in time.
    case timedOut
    /// The card left, or the session ended under it.
    case lost

    var words: String {
        switch self {
        case .unavailable: return "NFC is not available on this phone"
        case .cancelled: return "the session was cancelled"
        case .timedOut: return "the session timed out"
        case .lost: return "the tag was lost"
        }
    }
}

#if targetEnvironment(simulator)
typealias CardReader = SimCardLink
#else
typealias CardReader = NFCCardLink

final class NFCCardLink: NSObject, NFCTagReaderSessionDelegate {
    static var available: Bool { NFCTagReaderSession.readingAvailable }

    private var session: NFCTagReaderSession?
    private var card: NFCISO7816Tag?
    private var found: ((CardLinkError?) -> Void)?
    /// Told once, when the session has gone for any reason.
    var onGone: (() -> Void)?
    /// Told as the session goes on, so Foxy's own screen behind the sheet can
    /// show what the sheet shows: (stage, text), where the stage is one of
    /// CardGate.stages.
    var onProgress: ((String, String) -> Void)?

    /// Open the sheet with `text` on it. `found(nil)` when a card is there to
    /// talk to; `found(why)` when the session ended first.
    func begin(text: String, found: @escaping (CardLinkError?) -> Void) {
        guard NFCTagReaderSession.readingAvailable,
              let session = NFCTagReaderSession(pollingOption: [.iso14443], delegate: self, queue: .main) else {
            found(.unavailable)
            return
        }
        self.found = found
        self.session = session
        session.alertMessage = text
        Self.sessionOpen = true
        // said, so a sheet that sees no card leaves a trace: one did, for twenty seconds, with nothing in the diary
        print("[card] sheet: open")
        session.begin()
    }

    /// One command, and the card's answer with its two status bytes on the end.
    func send(_ apdu: Data, done: @escaping (Data?, CardLinkError?) -> Void) {
        guard let card, session != nil, let command = NFCISO7816APDU(data: apdu) else {
            done(nil, .lost)
            return
        }
        card.sendCommand(apdu: command) { [weak self] data, sw1, sw2, error in
            DispatchQueue.main.async {
                if error != nil {
                    self?.onProgress?("lost", CardLinkError.lost.words)
                    done(nil, .lost)
                    return
                }
                var answer = data
                answer.append(sw1)
                answer.append(sw2)
                done(answer, nil)
            }
        }
    }

    func say(_ text: String) {
        guard !text.isEmpty else { return }
        if let session { Self.show(text, on: session) }
        onProgress?("say", text)
    }

    /// The sheet's line, changed only when it is different: the same words
    /// set again make the sheet flicker.
    private static func show(_ text: String, on session: NFCTagReaderSession) {
        if session.alertMessage != text { session.alertMessage = text }
    }

    /// Close the sheet: with a tick and `text`, or with `error` said in red.
    func end(error: String?, text: String?) {
        guard let session else { return }
        self.session = nil
        card = nil
        if let error, !error.isEmpty {
            onProgress?("end", error)
            session.invalidate(errorMessage: error)
        } else {
            if let text, !text.isEmpty { Self.show(text, on: session) }
            onProgress?("end", text ?? "")
            session.invalidate()
        }
    }

    func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) { print("[card] sheet: scanning") }

    /// While the system's card sheet is up: the app resigns active for it, and
    /// the app-switcher cover must not go up behind it (FoxyWebView).
    static var sessionOpen = false

    func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: Error) {
        print("[card] sheet: ended — \(error.localizedDescription)")
        Self.sessionOpen = false
        let ended = self.session == nil        // the page closed it: it knows
        self.session = nil
        card = nil
        let why: CardLinkError
        switch (error as? NFCReaderError)?.code {
        case .readerSessionInvalidationErrorUserCanceled: why = .cancelled
        case .readerSessionInvalidationErrorSessionTimeout: why = .timedOut
        // no NFC, or a build signed without the entitlement that allows it
        case .readerErrorUnsupportedFeature, .readerErrorSecurityViolation: why = .unavailable
        default: why = .cancelled
        }
        // before `found` and `onGone`, which let the bridge forget this link
        if !ended { onProgress?("lost", why.words) }
        if let tell = found {
            found = nil
            tell(why)
        }
        let gone = onGone
        onGone = nil
        gone?()
    }

    func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        print("[card] sheet: \(tags.count) tag(s) in the field")
        /* One card, and one that speaks commands. Two cards in the field
         * answer over each other; anything else is not ours. Either way the
         * sheet stays up and goes on looking. */
        guard tags.count == 1, case let .iso7816(tag) = tags[0] else {
            session.alertMessage = "Hold one card to the top of the phone"
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self, self.session === session, self.card == nil else { return }
                session.restartPolling()
            }
            return
        }
        session.connect(to: tags[0]) { [weak self] error in
            DispatchQueue.main.async {
                guard let self, self.session === session else { return }
                if error != nil {
                    session.restartPolling()
                    return
                }
                self.card = tag
                Self.show(CardGate.scanning, on: session)
                self.onProgress?("connected", CardGate.scanning)
                if let tell = self.found {
                    self.found = nil
                    tell(nil)
                }
            }
        }
    }
}
#endif

// MARK: - the simulator's stand-in

/* The iOS Simulator has no NFC, so every card screen could only ever be seen
 * with a card in one hand and a phone in the other. In the simulator the same
 * commands go over a socket on the Mac's own loopback to a card that runs
 * there: the applet itself, in a JavaCard simulator (`tools/cardsim` in
 * https://github.com/getfoxy/card), listening on one of four ports. So the
 * real page, the real bridge, CardGate and a real mint can be driven against
 * the applet's own code before there is a card to hold.
 *
 * It stands in for the radio and nothing else. What it cannot show is the
 * radio: how long a card takes to sign, a card pulled away by a hand, the
 * phone's own sheet. Those stay tests for a phone.
 *
 * The talk is lines of text: "tap" (answered "ok" when a card is on the
 * reader, "none" when not), "apdu <hex>" (answered with hex, or "gone"), and
 * "end". */
#if targetEnvironment(simulator)
final class SimCardLink {
    static let available = true
    /// The phone's link keeps this true while the system's card sheet is up
    /// (FoxyWebView reads it); the simulator has no sheet, so it stays false.
    static var sessionOpen = false
    static let ports: [UInt16] = Array(47431...47434)
    /// As long as the phone's own sheet waits for a card.
    static let wait: TimeInterval = 60

    private var conn: NWConnection?
    private var buffer = Data()
    private var waiting: [(String?) -> Void] = []
    private var found: ((CardLinkError?) -> Void)?
    private var ended = false
    private var deadline = Date()
    var onGone: (() -> Void)?
    /// As the phone's link has it: (stage, text) for Foxy's own screen.
    var onProgress: ((String, String) -> Void)?

    func begin(text: String, found: @escaping (CardLinkError?) -> Void) {
        self.found = found
        deadline = Date().addingTimeInterval(Self.wait)
        look(at: 0)
    }

    /// Each port in turn, and round again, until a card answers or time is up.
    private func look(at index: Int) {
        guard !ended else { return }
        guard Date() < deadline else {
            onProgress?("lost", CardLinkError.timedOut.words)
            finish(.timedOut)
            return
        }
        guard index < Self.ports.count else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in self?.look(at: 0) }
            return
        }
        let conn = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.ports[index])!, using: .tcp)
        var moved = false
        let next = { [weak self] in
            guard let self, !moved else { return }
            moved = true
            conn.stateUpdateHandler = nil
            conn.cancel()
            if self.conn === conn { self.conn = nil; self.waiting = []; self.buffer = Data() }
            self.look(at: index + 1)
        }
        conn.stateUpdateHandler = { [weak self] state in
            guard let self, !self.ended else { return }
            switch state {
            case .ready:
                self.conn = conn
                self.read(conn)
                self.ask("tap") { answer in
                    guard answer == "ok" else { next(); return }
                    moved = true
                    conn.stateUpdateHandler = { [weak self] state in
                        switch state {
                        case .failed, .cancelled: self?.dropped()
                        default: break
                        }
                    }
                    self.onProgress?("connected", CardGate.scanning)
                    if let tell = self.found {
                        self.found = nil
                        tell(nil)
                    }
                }
            // a refused port is `waiting`, not `failed`: nobody is there
            case .failed, .cancelled, .waiting: next()
            default: break
            }
        }
        conn.start(queue: .main)
    }

    private func read(_ conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, done, error in
            guard let self, self.conn === conn else { return }
            if let data, !data.isEmpty {
                self.buffer.append(data)
                while let at = self.buffer.firstIndex(of: 0x0a) {
                    let line = String(decoding: self.buffer.subdata(in: self.buffer.startIndex..<at), as: UTF8.self)
                    self.buffer.removeSubrange(self.buffer.startIndex...at)
                    if !self.waiting.isEmpty { self.waiting.removeFirst()(line.trimmingCharacters(in: .whitespaces)) }
                    if self.conn !== conn { return }
                }
            }
            if done || error != nil {
                if self.found == nil { self.dropped() }
                return
            }
            self.read(conn)
        }
    }

    private func ask(_ line: String, answer: @escaping (String?) -> Void) {
        guard let conn else { answer(nil); return }
        waiting.append(answer)
        conn.send(content: Data((line + "\n").utf8), completion: .contentProcessed { _ in })
    }

    func send(_ apdu: Data, done: @escaping (Data?, CardLinkError?) -> Void) {
        guard conn != nil, !ended else { done(nil, .lost); return }
        ask("apdu " + CardGate.hex(apdu)) { [weak self] answer in
            guard let answer, let bytes = CardGate.bytes(hex: answer), bytes.count >= 2 else {
                // a dropped connection has said so already
                if let self, !self.ended { self.onProgress?("lost", CardLinkError.lost.words) }
                done(nil, .lost)
                return
            }
            done(bytes, nil)
        }
    }

    func say(_ text: String) {
        guard !text.isEmpty else { return }
        print("[foxy] card sheet:", text)
        onProgress?("say", text)
    }

    func end(error: String?, text: String?) {
        print("[foxy] card sheet:", error.map { "ended, " + $0 } ?? (text ?? "ended"))
        if !ended { onProgress?("end", (error?.isEmpty == false ? error : text) ?? "") }
        let waitingForCard = found != nil
        if let conn, !ended { conn.send(content: Data("end\n".utf8), completion: .contentProcessed { _ in conn.cancel() }) }
        if waitingForCard { finish(.cancelled) } else { close() }
    }

    private func finish(_ why: CardLinkError) {
        guard !ended else { return }
        let tell = found
        found = nil
        close()
        tell?(why)
    }

    /// The card's side went away under an open session.
    private func dropped() {
        guard !ended else { return }
        onProgress?("lost", CardLinkError.lost.words)
        close()
    }

    private func close() {
        guard !ended else { return }
        ended = true
        conn?.stateUpdateHandler = nil
        conn = nil
        let unanswered = waiting
        waiting = []
        unanswered.forEach { $0(nil) }
        let gone = onGone
        onGone = nil
        gone?()
    }
}
#endif
