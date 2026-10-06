import Foundation

/* A card that holds ecash, held to the phone (Foxy/Flashcard).
 *
 * Four actions, and one session at a time. The page opens a session, talks to
 * the card through it, may change the line of text on the phone's sheet, and
 * closes it. What it may say to the card is CardGate's to decide, command by
 * command: this app's applet, chosen by name, and then that applet's own
 * instructions. Nothing a card says or is told is kept or logged here. One of
 * the commands carries the card's PIN.
 *
 * The session ends by itself when the page closes it, when the person
 * dismisses the sheet, after a minute with no card, and when Foxy leaves the
 * foreground (the system ends an NFC session then). */
extension FoxyBridge {
    /// {text}: open the phone's card sheet with this line on it. Answers "ok"
    /// when a card is there to talk to, and otherwise why not: no NFC, the
    /// sheet dismissed, or nobody held a card up.
    func handleCardBegin(id: String, body: [String: Any]) {
        let text = CardGate.line(body["text"] as? String)
        DispatchQueue.main.async {
            // one at a time: a session the page left open is closed before the next opens
            if let old = self.cardLink {
                self.cardLink = nil
                self.cardSelected = false
                old.end(error: nil, text: nil)
            }
            guard CardReader.available else {
                self.resolve(id: id, text: nil, error: CardLinkError.unavailable.words)
                return
            }
            let link = CardReader()
            self.cardLink = link
            self.cardSelected = false
            link.onGone = { [weak self, weak link] in
                guard let self, let link, self.cardLink === link else { return }
                self.cardLink = nil
                self.cardSelected = false
            }
            link.begin(text: text.isEmpty ? "Hold the card to the top of the phone" : text) { [weak self, weak link] why in
                guard let self else { return }
                if let why {
                    if let link, self.cardLink === link { self.cardLink = nil }
                    self.resolve(id: id, text: nil, error: why.words)
                    return
                }
                self.resolve(id: id, text: "ok", error: nil)
            }
        }
    }

    /// {apdu}: one command for the card, as hex. Answers the card's reply as
    /// hex, its two status bytes last. Refused, with nothing sent, when it is
    /// not a command this app sends to its own applet.
    func handleCardSend(id: String, body: [String: Any]) {
        guard let hex = body["apdu"] as? String, let apdu = CardGate.bytes(hex: hex) else {
            resolve(id: id, text: nil, error: "That is not a command for a card.")
            return
        }
        DispatchQueue.main.async {
            guard let link = self.cardLink else {
                self.resolve(id: id, text: nil, error: CardLinkError.lost.words)
                return
            }
            guard CardGate.allows(apdu, selected: self.cardSelected) else {
                self.resolve(id: id, text: nil, error: "That is not a command Foxy sends to a card.")
                return
            }
            let choosing = CardGate.read(apdu) == .select
            link.send(apdu) { [weak self, weak link] answer, why in
                guard let self else { return }
                guard let answer else {
                    self.resolve(id: id, text: nil, error: (why ?? .lost).words)
                    return
                }
                // chosen, or chosen again and refused: either way it is what the card last said
                if choosing, let link, self.cardLink === link { self.cardSelected = CardGate.succeeded(answer) }
                self.resolve(id: id, text: CardGate.hex(answer), error: nil)
            }
        }
    }

    /// {text}: the line on the phone's sheet, changed while a session is open.
    func handleCardSay(id: String, body: [String: Any]) {
        let text = CardGate.line(body["text"] as? String)
        DispatchQueue.main.async {
            self.cardLink?.say(text)
            self.resolve(id: id, text: "ok", error: nil)
        }
    }

    /// {text} or {error}: close the sheet, with a tick and a word, or with the
    /// reason in red. Also how the page takes down a sheet still waiting for
    /// a card.
    func handleCardEnd(id: String, body: [String: Any]) {
        let failed = body["error"] as? String
        let error = failed.map { CardGate.line($0) }
        let text = CardGate.line(body["text"] as? String)
        DispatchQueue.main.async {
            let link = self.cardLink
            self.cardLink = nil
            self.cardSelected = false
            link?.end(error: error, text: text)
            self.resolve(id: id, text: "ok", error: nil)
        }
    }
}
