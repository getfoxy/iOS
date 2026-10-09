import Foundation

/// What the page may say to a card, decided before a byte is sent.
///
/// The page builds the commands (build/wallet/08a-flashcard.js) and the phone
/// carries them. A phone that carried anything it was handed would let a page
/// that had been got at talk to whatever was held to it: a bank card, a
/// passport, a door key. So the phone reads each command first, and carries
/// two kinds only: the one that chooses this app's own applet, by its full
/// name, and the applet's own instructions, and those not until the applet
/// has answered that it was chosen. iOS narrows it too, to cards that answer
/// to the name in the app's Info.plist, and this does not lean on that.
///
/// Nothing here touches NFC, so FoxyTests can hold it to its rules.
enum CardGate {
    /// The applet on a Foxy card (applet/build.xml in
    /// https://github.com/getfoxy/card): its package's nine bytes and 01.
    static let applet = Data([0xF0, 0x46, 0x4F, 0x58, 0x59, 0x43, 0x41, 0x52, 0x44, 0x01])

    /// The applet's class byte.
    static let appletClass: UInt8 = 0xB0

    /// The instructions the page uses, and no others the applet has: twenty-five.
    /// tests/flashcard-model.js holds this list to the page's own (`CARD_INS`,
    /// build/wallet/08a-flashcard.js), both ways: an instruction the page sends and
    /// the phone does not carry is a card that cannot be used.
    ///
    /// Three the applet has stay out, because the page does not send them, so the
    /// phone will not carry them for a page that had been got at: the count of
    /// proofs (12); the limit set with the PIN (33), the form for a card that has
    /// no owner, where the page sends the owner's form (34); and locking a card
    /// for good (50).
    static let instructions: Set<UInt8> = [
        0x01, 0x10, 0x11, 0x13, 0x14, 0x15, 0x16, 0x17,   // what it is, its key, what it holds, proof it is the card, its record, which pieces it holds
        0x18,                                       // the card's own log (it gives it to its owner, or under its PIN)
        0x20,                                       // sign for a piece (a card that signs for each)
        0x22, 0x23, 0x24, 0x25,                     // one signature for a payment: its pieces, its outputs, the signature, and the last one again
        0x30, 0x31, 0x32,                           // write a piece, free used places, its record
        0x34,                                       // set the card's daily limit (the owner's proof, no PIN)
        0x35,                                       // tell the card the time, signed (CardTime.swift)
        0x40, 0x41, 0x42,                           // its PIN: check, set, change
        0x43,                                       // give it its owner key, or change it
        0x44,                                       // a nonce to answer with the owner's proof
        0x45,                                       // the owner's grant to load, in this tap, with no PIN
    ]

    /// A short command at its longest: four of header, a length, 255 of data
    /// and the length expected back.
    static let longest = 4 + 1 + 255 + 1

    enum Command: Equatable {
        case select
        case applet(UInt8)
    }

    /// Hex from the page, as bytes: whole bytes, hex and nothing else, and no
    /// longer than a command can be.
    static func bytes(hex: String) -> Data? {
        let text = Array(hex.utf8)
        guard !text.isEmpty, text.count % 2 == 0, text.count <= longest * 2 else { return nil }
        var out = Data(capacity: text.count / 2)
        var high: UInt8 = 0
        for (i, c) in text.enumerated() {
            let v: UInt8
            switch c {
            case 0x30...0x39: v = c - 0x30
            case 0x61...0x66: v = c - 0x61 + 10
            case 0x41...0x46: v = c - 0x41 + 10
            default: return nil
            }
            if i % 2 == 0 { high = v } else { out.append(high << 4 | v) }
        }
        return out
    }

    static func hex(_ data: Data) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        out.reserveCapacity(data.count * 2)
        for b in data {
            out.append(digits[Int(b >> 4)])
            out.append(digits[Int(b & 15)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// What this command is, or nil when it is not one this app sends.
    ///
    /// It must be a well-formed short command first: a header alone, a header
    /// and the length expected back, or a header, a length, that many bytes
    /// and perhaps the length expected back. A command whose length byte does
    /// not match what follows it is read differently by different cards.
    static func read(_ apdu: Data) -> Command? {
        let b = [UInt8](apdu)
        guard b.count >= 4, b.count <= longest else { return nil }
        let after = b.count - 4
        var data: ArraySlice<UInt8> = []
        if after > 1 {
            let lc = Int(b[4])
            guard lc > 0, after == 1 + lc || after == 2 + lc else { return nil }
            data = b[5..<(5 + lc)]
        }
        if b[0] == 0x00, b[1] == 0xA4 {
            guard b[2] == 0x04, b[3] == 0x00, Data(data) == applet else { return nil }
            return .select
        }
        guard b[0] == appletClass, instructions.contains(b[1]) else { return nil }
        return .applet(b[1])
    }

    /// Whether to carry it now. Until the applet has answered that it was
    /// chosen, the only thing said to a card is the choosing.
    static func allows(_ apdu: Data, selected: Bool) -> Bool {
        switch read(apdu) {
        case .select: return true
        case .applet: return selected
        case nil: return false
        }
    }

    /// Whether an answer says the command was carried out (9000).
    static func succeeded(_ answer: Data) -> Bool {
        answer.count >= 2 && answer[answer.endIndex - 2] == 0x90 && answer[answer.endIndex - 1] == 0x00
    }

    /// What the phone's sheet says from the moment a card has connected until
    /// the page says something else.
    static let scanning = "Scanning. Hold still."

    /// The stages the phone reports to the page as a session goes on.
    static let stages: Set<String> = ["connected", "say", "end", "lost"]

    /// The script that tells the page how the session is going, or nil when
    /// the stage is not one of the four. The words are cut down to a line
    /// first, then written as a JSON string, so nothing in them can end the
    /// string or the call: a quote, a backslash and every control character
    /// are escaped, and so is a slash.
    static func progressScript(stage: String, text: String) -> String? {
        guard stages.contains(stage),
              let data = try? JSONSerialization.data(withJSONObject: [line(text)]),
              let array = String(data: data, encoding: .utf8) else { return nil }
        let quoted = String(array.dropFirst().dropLast())       // ["x"] -> "x"
        return "window.FoxyWallet && window.FoxyWallet._card && window.FoxyWallet._card({\"stage\":\"" + stage + "\",\"text\":" + quoted + "})"
    }

    /// A line for the phone's own card sheet: one line, nothing that is not
    /// print, and short. The page chooses the words; it does not get to put a
    /// paragraph, or a control character, on a system sheet.
    static func line(_ text: String?) -> String {
        let kept = (text ?? "").unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) && !CharacterSet.newlines.contains($0) }
        return String(String(String.UnicodeScalarView(kept)).prefix(120))
    }
}
