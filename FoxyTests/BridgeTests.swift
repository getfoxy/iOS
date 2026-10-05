import XCTest
@testable import Foxy

/// The page-to-native boundary: which messages run what, and the checks on what
/// a message carries.
final class BridgeTests: XCTestCase {

    /// The action names THREAT-MODEL.md §1 says the bridge exposes, read from
    /// the document itself, so the table and the threat model cannot drift apart.
    private func documentedActions() throws -> Set<String> {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let text = try String(contentsOf: root.appendingPathComponent("THREAT-MODEL.md"), encoding: .utf8)
        let start = try XCTUnwrap(text.range(of: "The bridge exposes exactly these actions:"))
        let end = try XCTUnwrap(text.range(of: "Haptics arrive as", range: start.upperBound..<text.endIndex))
        let list = text[start.upperBound..<end.lowerBound]
        let names = list.split(separator: "`").enumerated().filter { $0.offset % 2 == 1 }.map { String($0.element) }
        return Set(names)
    }

    func testTheTableHoldsExactlyTheDocumentedActions() throws {
        let documented = try documentedActions()
        XCTAssertEqual(documented.count, 66, "THREAT-MODEL.md §1 lists \(documented.sorted())")
        XCTAssertEqual(Set(FoxyBridge.handlers.keys), documented)
    }

    func testEveryDocumentedActionRunsItsHandler() throws {
        for action in try documentedActions() {
            guard case .run(_, let id, let body) = FoxyBridge.dispatch(["action": action, "id": "7", "x": 1]) else {
                XCTFail("\(action) does not run")
                continue
            }
            XCTAssertEqual(id, "7")
            XCTAssertEqual(body["x"] as? Int, 1, "the handler gets the whole message")
        }
    }

    func testAnUnknownActionIsRefused() {
        // the review-era actions that were removed, the page's old seed actions, and near misses
        for action in ["open", "vpn", "path", "torcheck", "seedRead", "seedWrite", "seedDelete", "seedSecrets",
                       "", "SCAN", "seedstatus", "seedStatus ", "handleScan", "constructor"] {
            guard case .unknown(let named, let id) = FoxyBridge.dispatch(["action": action, "id": "9"]) else {
                XCTFail("\"\(action)\" was not refused")
                continue
            }
            XCTAssertEqual(named, action)
            XCTAssertEqual(id, "9")
        }
    }

    func testAMessageWithoutAnActionAndIdGetsNoAnswer() {
        let ignored: [Any] = [
            "seedStatus",
            ["action": "seedStatus"],                   // no id: nothing to answer
            ["id": "1"],
            ["action": 5, "id": "1"],
            ["action": "seedStatus", "id": 1],
            [["action": "seedStatus", "id": "1"]],
        ]
        for message in ignored {
            guard case .ignored = FoxyBridge.dispatch(message) else {
                XCTFail("\(message) was not ignored")
                continue
            }
        }
    }

    /// Stage 4: the words never cross the bridge. The page's own word actions are
    /// gone from the table and from THREAT-MODEL.md, and asking for one, words and
    /// replace included, runs nothing.
    func testThePagesOldWordActionsAreGone() throws {
        let documented = try documentedActions()
        for action in ["seedRead", "seedWrite", "seedDelete"] {
            XCTAssertNil(FoxyBridge.handlers[action], "\(action) is in the table")
            XCTAssertFalse(documented.contains(action), "THREAT-MODEL.md §1 still lists \(action)")
            let message: [String: Any] = ["action": action, "id": "6", "replace": true,
                                          "words": "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"]
            guard case .unknown(let named, let id) = FoxyBridge.dispatch(message) else {
                XCTFail("\(action) runs")
                continue
            }
            XCTAssertEqual(named, action)
            XCTAssertEqual(id, "6")
        }
        XCTAssertTrue(documented.contains("seedMigrate"))
    }

    func testHapticsComeFirst() {
        guard case .haptic(let kind) = FoxyBridge.dispatch(["haptic": "success", "action": "seedWipe", "id": "1"]) else {
            return XCTFail("a haptic message ran an action")
        }
        XCTAssertEqual(kind, "success")
    }

    func testOnlyTheStagedPagesMainFrameIsAnswered() {
        XCTAssertTrue(FoxyBridge.answers(isMainFrame: true, originProtocol: "file"))
        XCTAssertFalse(FoxyBridge.answers(isMainFrame: false, originProtocol: "file"))
        XCTAssertFalse(FoxyBridge.answers(isMainFrame: true, originProtocol: "https"))
        XCTAssertFalse(FoxyBridge.answers(isMainFrame: true, originProtocol: ""))
    }

    func testMintRequestsAreGetOrPost() {
        XCTAssertEqual(FoxyBridge.mintMethod([:]), "GET")
        XCTAssertEqual(FoxyBridge.mintMethod(["method": 3]), "GET", "a method that is not text is the default, as before")
        XCTAssertEqual(FoxyBridge.mintMethod(["method": "get"]), "GET")
        XCTAssertEqual(FoxyBridge.mintMethod(["method": "Post"]), "POST")
        for method in ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT", "TRACE", "", " GET", "GET\r\nX-Evil: 1"] {
            XCTAssertNil(FoxyBridge.mintMethod(["method": method]), "\(method) was allowed")
        }
    }

    func testTheScannerSaysOnlyFoxysWords() {
        XCTAssertEqual(FoxyBridge.scannerPrompt("Scan an ecash token"), "Scan an ecash token")
        XCTAssertEqual(FoxyBridge.scannerPrompt("Scan the mint address"), "Scan the mint address")
        XCTAssertEqual(FoxyBridge.scannerPrompt("Scan to claim your prize"), "")
        XCTAssertEqual(FoxyBridge.scannerPrompt(nil), "")
        XCTAssertEqual(FoxyBridge.scannerPrompt(42), "")
    }

    func testFaceIDSaysOnlyFoxysWords() {
        XCTAssertEqual(FoxyBridge.biometricReason("Leave POS mode"), "Leave POS mode")
        XCTAssertEqual(FoxyBridge.biometricReason("Approve sending 1 BTC"), "Unlock Foxy")
        XCTAssertEqual(FoxyBridge.biometricReason(nil), "Unlock Foxy")
    }

    /// I5: Orbot is named only with a stored key and a bypass.
    func testContinueWithoutTorNamesOrbotOnlyWithAKeyAndABypass() {
        let bypass = OrbotLink.State.bypass(port: 9150, onionOnly: false)
        XCTAssertTrue(FoxyBridge.unprotectedMessage(orbot: bypass, keyStored: true).contains("Orbot"))
        for (state, key) in [(bypass, false), (.needsAccess, true), (.needsAccess, false), (.absent, true), (.absent, false)] as [(OrbotLink.State, Bool)] {
            let text = FoxyBridge.unprotectedMessage(orbot: state, keyStored: key)
            XCTAssertFalse(text.contains("Orbot"), "\(state), key \(key): \(text)")
            XCTAssertTrue(text.contains("will see this phone's IP address"))
        }
    }

    /// Tor waits on these when the app is put away, and on nothing else.
    func testOnlyRequestsThatMoveMoneyHoldTorUp() {
        for path in ["/v1/swap", "/api/v1/swap", "/v1/restore", "/v1/melt/bolt11", "/v1/mint/bolt11"] {
            XCTAssertTrue(FoxyBridge.movesMoney(method: "POST", path: path), path)
        }
        for path in ["/v1/melt/quote/bolt11", "/v1/mint/quote/bolt11", "/v1/checkstate", "/v1/keys", "/v1/info"] {
            XCTAssertFalse(FoxyBridge.movesMoney(method: "POST", path: path), path)
        }
        XCTAssertFalse(FoxyBridge.movesMoney(method: "GET", path: "/v1/swap"))
    }
}
