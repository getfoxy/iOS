import XCTest
@testable import Foxy

/// What the phone will carry to a card for the page, and what it will not
/// (Foxy/Flashcard/CardGate.swift).
final class CardGateTests: XCTestCase {
    private func bytes(_ hex: String) -> Data { CardGate.bytes(hex: hex)! }
    private let select = "00a404000af0464f5859434152440100"

    func testHexIsWholeBytesAndNothingElse() {
        XCTAssertEqual(CardGate.bytes(hex: "00A4b0ff"), Data([0x00, 0xA4, 0xB0, 0xFF]))
        XCTAssertEqual(CardGate.hex(Data([0x00, 0xA4, 0xB0, 0xFF])), "00a4b0ff")
        for bad in ["", "0", "0g", "00 a4", "0x00", "00\n", String(repeating: "00", count: CardGate.longest + 1)] {
            XCTAssertNil(CardGate.bytes(hex: bad), "\(bad.prefix(12)) is not hex for a command")
        }
        XCTAssertNotNil(CardGate.bytes(hex: String(repeating: "00", count: CardGate.longest)))
    }

    func testTheAppletIsChosenByItsWholeNameOnly() {
        XCTAssertEqual(CardGate.read(bytes(select)), .select)
        XCTAssertEqual(CardGate.read(bytes("00a404000af0464f58594341524401")), .select, "with no length expected back")
        // its package's nine bytes, a longer name, another applet, another kind of SELECT, a payment card's directory
        for other in ["00a4040009f0464f58594341524400",
                      "00a404000bf0464f5859434152440100",
                      "00a404000af0464f58594341524402",
                      "00a400000af0464f58594341524401",
                      "00a404020af0464f58594341524401",
                      "00a404000e325041592e5359532e444446303100",
                      "00a4040007d276000085010100",
                      "00a40400"] {
            XCTAssertNil(CardGate.read(bytes(other)), "\(other) chooses something else")
        }
    }

    func testOnlyTheInstructionsThePageUsesAreCarried() {
        // every command build/wallet/08a-flashcard.js builds: class B0, and one of these twenty-five
        let carried = ["01", "10", "11", "13", "14", "15", "16", "17", "18", "20", "22", "23", "24", "25",
                       "30", "31", "32", "34", "35", "40", "41", "42", "43", "44", "45"]
        XCTAssertEqual(carried.count, 25)
        XCTAssertEqual(CardGate.instructions, Set(carried.map { UInt8($0, radix: 16)! }), "exactly these, and the table says so")
        for ins in carried {
            XCTAssertNotNil(CardGate.read(bytes("b0" + ins + "0000")), "instruction \(ins)")
        }
        XCTAssertEqual(CardGate.read(bytes("b040000004" + "31323334")), .applet(0x40), "a PIN to check")
        XCTAssertEqual(CardGate.read(bytes("b020050040")), .applet(0x20), "sign for the piece in place 5")
        // one signature for a payment: the places, the outputs (37 bytes each), the signature, and the last one again
        XCTAssertEqual(CardGate.read(bytes("b0220000" + "03" + "000507" + "04")), .applet(0x22), "the places a payment is made of")
        XCTAssertEqual(CardGate.read(bytes("b0230000" + "25" + String(repeating: "ab", count: 37))), .applet(0x23), "one output of its swap")
        XCTAssertEqual(CardGate.read(bytes("b0230000" + "de" + String(repeating: "ab", count: 222))), .applet(0x23), "six of them")
        XCTAssertEqual(CardGate.read(bytes("b024000040")), .applet(0x24), "sign for the payment")
        XCTAssertEqual(CardGate.read(bytes("b025000040")), .applet(0x25), "the last signature again")
        XCTAssertEqual(CardGate.read(bytes("b018000000")), .applet(0x18), "the card's own log")
        XCTAssertEqual(CardGate.read(bytes("b035000006" + "01020304" + "00" + "00")), .applet(0x35), "the time, signed")
        XCTAssertEqual(CardGate.read(bytes("b0450000" + "03" + "300100")), .applet(0x45), "the owner's grant to load")
        XCTAssertEqual(CardGate.read(bytes("b0430000" + "03" + "040102")), .applet(0x43), "an owner key")
        XCTAssertEqual(CardGate.read(bytes("b034000005" + "0102030405")), .applet(0x34), "the limit, with the owner's proof")
        XCTAssertEqual(CardGate.read(bytes("b017000000")), .applet(0x17), "which pieces it holds, from place 0")
        XCTAssertEqual(CardGate.read(bytes("b017400000")), .applet(0x17), "the next page of them")
        XCTAssertTrue(CardGate.allows(bytes("b017000000"), selected: true))
        XCTAssertFalse(CardGate.allows(bytes("b017000000"), selected: false), "not before the applet is chosen")
        // 33 (the limit with the PIN, for a card with no owner) and 50 (lock the card for good) are not sent by the page, so
        // they are refused; and the others are ones the page never asks for, the signing upstream had, and nothing at all
        for ins in ["33", "50", "12", "21", "26", "00", "ff", "a4"] {
            XCTAssertNil(CardGate.read(bytes("b0" + ins + "0000")), "instruction \(ins) is not one the page sends")
        }
        XCTAssertNil(CardGate.read(bytes("b033000004" + "00000000")), "the PIN form of the limit, with its data")
        XCTAssertNil(CardGate.read(bytes("b050" + "00de" + "00")), "locking a card for good")
        // another class with one of our instructions
        for cla in ["00", "80", "84", "b1"] {
            XCTAssertNil(CardGate.read(bytes(cla + "400000043132333a")), "class \(cla)")
            XCTAssertNil(CardGate.read(bytes(cla + "35000001" + "00")), "class \(cla), the time")
        }
    }

    func testACommandMustBeWellFormed() {
        XCTAssertNil(CardGate.read(bytes("b040")), "shorter than a header")
        XCTAssertNil(CardGate.read(bytes("b04000000531323334")), "says five bytes and carries four")
        XCTAssertNil(CardGate.read(bytes("b040000003313233343536")), "says three bytes and carries six")
        XCTAssertNil(CardGate.read(bytes("b0400000000000")), "a length of none with bytes after it")
        XCTAssertNotNil(CardGate.read(bytes("b0400000" + "ff" + String(repeating: "00", count: 255) + "00")), "the longest there is")
    }

    func testNothingIsSaidToACardBeforeTheAppletAnswers() {
        let verify = bytes("b04000000431323334")
        XCTAssertFalse(CardGate.allows(verify, selected: false), "a PIN is not sent to a card that has not been chosen")
        // the time and the owner's grant are the applet's too: carried only once it has answered that it was chosen
        for command in [bytes("b035000006" + "01020304" + "0000"), bytes("b0450000" + "03" + "300100"), bytes("b044000010"), bytes("b0420000" + "02" + "0102")] {
            XCTAssertFalse(CardGate.allows(command, selected: false), "\(CardGate.hex(command)) before the applet is chosen")
            XCTAssertTrue(CardGate.allows(command, selected: true), "\(CardGate.hex(command)) after")
        }
        XCTAssertFalse(CardGate.allows(bytes("b0500000de"), selected: true), "locking is refused even then")
        XCTAssertTrue(CardGate.allows(bytes(select), selected: false))
        XCTAssertTrue(CardGate.allows(verify, selected: true))
        XCTAssertTrue(CardGate.allows(bytes(select), selected: true), "choosing again is how a session starts over")
        XCTAssertFalse(CardGate.allows(bytes("00b2010c00"), selected: true), "reading a payment card's record, even after ours was chosen")
        XCTAssertTrue(CardGate.succeeded(bytes("01009000")))
        XCTAssertTrue(CardGate.succeeded(bytes("9000")))
        XCTAssertFalse(CardGate.succeeded(bytes("6a82")))
        XCTAssertFalse(CardGate.succeeded(bytes("90")))
        XCTAssertFalse(CardGate.succeeded(Data()))
    }

    func testALineForTheSheetIsOneShortLine() {
        XCTAssertEqual(CardGate.line("Keep the card there"), "Keep the card there")
        XCTAssertEqual(CardGate.line("one\ntwo\u{0007}\tthree\u{2028}four"), "onetwothreefour")
        XCTAssertEqual(CardGate.line(String(repeating: "a", count: 500)).count, 120)
        XCTAssertEqual(CardGate.line(nil), "")
    }

    /// The script that tells the page how a session is going.
    func testProgressIsAScriptForTheFourStages() {
        let head = "window.FoxyWallet && window.FoxyWallet._card && window.FoxyWallet._card("
        XCTAssertEqual(CardGate.progressScript(stage: "connected", text: "Scanning. Hold still."),
                       head + "{\"stage\":\"connected\",\"text\":\"Scanning. Hold still.\"})")
        XCTAssertEqual(CardGate.progressScript(stage: "connected", text: CardGate.scanning),
                       head + "{\"stage\":\"connected\",\"text\":\"Scanning. Hold still.\"})")
        XCTAssertEqual(CardGate.progressScript(stage: "say", text: "Keep the card there"),
                       head + "{\"stage\":\"say\",\"text\":\"Keep the card there\"})")
        XCTAssertEqual(CardGate.progressScript(stage: "end", text: "Done"),
                       head + "{\"stage\":\"end\",\"text\":\"Done\"})")
        XCTAssertEqual(CardGate.progressScript(stage: "lost", text: CardLinkError.lost.words),
                       head + "{\"stage\":\"lost\",\"text\":\"the tag was lost\"})")
        XCTAssertEqual(CardGate.progressScript(stage: "end", text: ""),
                       head + "{\"stage\":\"end\",\"text\":\"\"})", "an end with no words is still an end")
        for stage in ["", "Say", "SAY", "say ", "connect", "done", "say\",\"x\":\"", "end\n", "tap"] {
            XCTAssertNil(CardGate.progressScript(stage: stage, text: "x"), "\(stage.debugDescription) is not a stage")
        }
    }

    /// Words from the page, or from a card's error, cannot get out of the string they are put in.
    func testProgressWordsStayInsideTheirString() throws {
        let head = "window.FoxyWallet && window.FoxyWallet._card && window.FoxyWallet._card("
        let hostile = [
            "He said \"stop\" and left",
            "back\\slash \\\" and \\\\",
            "two\nlines\r\nand\ttabs",
            "</script><script>alert(1)</script>",
            "\"});window.evil=1;({\"",
            "bell\u{0007} nul\u{0000} esc\u{001B} del\u{007F} ls\u{2028} ps\u{2029}",
            "emoji \u{1F98A} and e\u{0301}",
            String(repeating: "x", count: 500),
        ]
        for text in hostile {
            let script = try XCTUnwrap(CardGate.progressScript(stage: "say", text: text), text)
            XCTAssertTrue(script.hasPrefix(head), "starts with the call")
            XCTAssertTrue(script.hasSuffix("})"), "ends with the call")
            XCTAssertFalse(script.contains("\n") || script.contains("\r") || script.contains("\u{2028}") || script.contains("\u{2029}"), "one line")
            XCTAssertFalse(script.lowercased().contains("</script"), "no closing tag, whatever the text")
            XCTAssertTrue(script.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value != 0x7F }, "no raw control character")
            // the part inside the call reads back as exactly an object with two keys, and the text is the line it was cut to
            let json = String(script.dropFirst(head.count).dropLast())
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any], "valid JSON: \(json.prefix(80))")
            XCTAssertEqual(Set(object.keys), ["stage", "text"])
            XCTAssertEqual(object["stage"] as? String, "say")
            XCTAssertEqual(object["text"] as? String, CardGate.line(text))
        }
        // the cut-down line itself, for the cases that matter
        let quoted = try XCTUnwrap(CardGate.progressScript(stage: "say", text: "a \"b\" \\ c\nd </script>"))
        let json = String(quoted.dropFirst(head.count).dropLast())
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: String])
        XCTAssertEqual(object["text"], "a \"b\" \\ cd </script>")
    }

    func testWhyASessionEndedIsSaidInThePagesWords() {
        // build/wallet/21a-flashcard.js tells these apart by their words
        XCTAssertTrue(CardLinkError.unavailable.words.contains("not available"))
        XCTAssertTrue(CardLinkError.timedOut.words.contains("timed out"))
        XCTAssertFalse(CardLinkError.cancelled.words.contains("timed out"))
        XCTAssertFalse(CardLinkError.cancelled.words.contains("not available"))
    }

    /// The applet's name is written in four places: here, in the two plists
    /// iOS reads to decide which cards the app is handed, and in the page,
    /// which builds the command that chooses it. They must be one name.
    func testTheAppletHasOneNameEverywhere() throws {
        let name = CardGate.hex(CardGate.applet)
        XCTAssertEqual(name, "f0464f58594341524401")
        let root = repoRoot()
        for file in ["tools/app.plist", "tools/debug-url-scheme.plist"] {
            let data = try Data(contentsOf: root.appendingPathComponent(file))
            let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
            let names = try XCTUnwrap(plist["com.apple.developer.nfc.readersession.iso7816.select-identifiers"] as? [String])
            XCTAssertEqual(names.map { $0.lowercased() }, [name], file)
        }
        let page = try String(contentsOf: root.appendingPathComponent("build/wallet/08a-flashcard.js"), encoding: .utf8)
        XCTAssertTrue(page.contains("var CARD_AID = '\(name)';"), "the page chooses the applet by the same name")
    }

    /// The four actions refuse, with nothing open, what they must.
    func testTheActionsAreInTheTable() {
        for action in ["cardBegin", "cardSend", "cardSay", "cardEnd"] {
            guard case .run = FoxyBridge.dispatch(["action": action, "id": "1"]) else {
                XCTFail("\(action) is not served")
                continue
            }
        }
    }
}
