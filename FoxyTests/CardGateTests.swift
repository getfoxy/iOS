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
        // every command build/wallet/08a-flashcard.js builds: class B0, and one of these
        for ins in ["01", "10", "11", "13", "14", "15", "16", "20", "30", "31", "32", "33", "40", "41", "42"] {
            XCTAssertNotNil(CardGate.read(bytes("b0" + ins + "0000")), "instruction \(ins)")
        }
        XCTAssertEqual(CardGate.read(bytes("b040000004" + "31323334")), .applet(0x40), "a PIN to check")
        XCTAssertEqual(CardGate.read(bytes("b020050040")), .applet(0x20), "sign for the piece in place 5")
        // locking a card for good, the count the page never asks for, the signing upstream had, and nothing at all
        for ins in ["50", "12", "21", "00", "ff", "a4"] {
            XCTAssertNil(CardGate.read(bytes("b0" + ins + "0000")), "instruction \(ins) is not one the page sends")
        }
        // another class with one of our instructions
        for cla in ["00", "80", "84", "b1"] {
            XCTAssertNil(CardGate.read(bytes(cla + "400000043132333a")), "class \(cla)")
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
