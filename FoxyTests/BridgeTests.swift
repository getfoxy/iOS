import XCTest
import WebKit
@testable import Foxy

/// The page-to-native boundary: which messages run what, and the checks on what
/// a message carries.
final class BridgeTests: XCTestCase {

    /// The action names THREAT-MODEL.md §1 says the bridge exposes, read from
    /// the document itself, so the table and the threat model cannot drift apart.
    private func documentedActions() throws -> Set<String> {
        let text = try String(contentsOf: repoRoot().appendingPathComponent("docs/THREAT-MODEL.md"), encoding: .utf8)
        let start = try XCTUnwrap(text.range(of: "The bridge exposes exactly these actions:"))
        let end = try XCTUnwrap(text.range(of: "Haptics arrive as", range: start.upperBound..<text.endIndex))
        let list = text[start.upperBound..<end.lowerBound]
        let names = list.split(separator: "`").enumerated().filter { $0.offset % 2 == 1 }.map { String($0.element) }
        return Set(names)
    }

    func testTheTableHoldsExactlyTheDocumentedActions() throws {
        let documented = try documentedActions()
        XCTAssertEqual(documented.count, 80, "THREAT-MODEL.md §1 lists \(documented.sorted())")
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
        XCTAssertTrue(FoxyBridge.answers(isMainFrame: true, originProtocol: "foxy-app", originHost: "wallet"))
        XCTAssertFalse(FoxyBridge.answers(isMainFrame: false, originProtocol: "foxy-app", originHost: "wallet"))
        XCTAssertFalse(FoxyBridge.answers(isMainFrame: true, originProtocol: "foxy-app", originHost: "other"))
        XCTAssertFalse(FoxyBridge.answers(isMainFrame: true, originProtocol: "file", originHost: ""),
                       "the file:// page Foxy used to be is not answered")
        XCTAssertFalse(FoxyBridge.answers(isMainFrame: true, originProtocol: "https", originHost: "wallet"))
        XCTAssertFalse(FoxyBridge.answers(isMainFrame: true, originProtocol: "", originHost: ""))
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
        // asked once when a PIN was set, and asked by nothing now
        XCTAssertEqual(FoxyBridge.biometricReason("Use Face ID to unlock Foxy?"), "Unlock Foxy")
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

/// Where the system paste button may go: over one of the page's own paste
/// buttons, as a script in a world of the bridge's own finds the page, and
/// nowhere else (PasteAffordance). A rectangle in the lower two-thirds was all
/// that was checked, and that is where the confirm buttons are.
final class PasteAffordanceTests: XCTestCase {
    private let page = """
    <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{margin:0} div{position:absolute;left:20px;width:300px;height:60px}</style></head><body>
    <div id="paste" data-foxy-paste="1" style="top:500px"><span>PASTE</span></div>
    <div id="home" data-foxy-paste="1" aria-label="PASTE" style="top:420px;width:80px;height:82px"></div>
    <div id="send" style="top:600px">SEND 21 SATS</div>
    <div id="lure" data-foxy-paste="1" style="top:680px">CONFIRM</div>
    <div id="faint" data-foxy-paste="1" style="top:340px;opacity:0.1">PASTE</div>
    <script>
      // a page script that tries to make the bridge's check see a paste button everywhere
      Element.prototype.getBoundingClientRect = function () { return { left: 20, top: 600, width: 300, height: 60 }; };
      document.elementFromPoint = function () { return document.getElementById('paste'); };
    </script></body></html>
    """

    /// On screen, as the app's is: a web view in no window lays nothing out, and has nothing at any point.
    private var window: UIWindow?

    override func tearDown() {
        window?.isHidden = true
        window = nil
        super.tearDown()
    }

    private func loaded() throws -> WKWebView {
        let frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let web = WKWebView(frame: frame)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: frame)
        window.frame = frame
        window.addSubview(web)
        window.isHidden = false
        self.window = window
        web.loadHTMLString(page, baseURL: nil)
        let ready = expectation(description: "the page is up")
        func poll() {
            // this page's, not the blank one that is up before it
            web.evaluateJavaScript("document.readyState === 'complete' && !!document.getElementById('send')") { state, _ in
                if (state as? Bool) == true { ready.fulfill() } else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: poll) }
            }
        }
        poll()
        wait(for: [ready], timeout: 10)
        return web
    }

    private func check(_ rect: CGRect, in web: WKWebView) -> Bool {
        var answer: Bool?
        let done = expectation(description: "checked")
        PasteAffordance.check(rect, in: web) { answer = $0; done.fulfill() }
        wait(for: [done], timeout: 10)
        return answer ?? false
    }

    func testOnlyThePagesPasteButtonsTakeTheControl() throws {
        let web = try loaded()
        XCTAssertTrue(check(CGRect(x: 20, y: 500, width: 300, height: 60), in: web), "the send screen's PASTE")
        XCTAssertTrue(check(CGRect(x: 21, y: 421, width: 79, height: 81), in: web), "the home screen's PASTE, as the page rounds it")
        XCTAssertFalse(check(CGRect(x: 20, y: 600, width: 300, height: 60), in: web),
                       "a confirm button, even with the page's own functions saying otherwise")
        XCTAssertFalse(check(CGRect(x: 20, y: 680, width: 300, height: 60), in: web), "marked, but its label is not PASTE")
        XCTAssertFalse(check(CGRect(x: 20, y: 340, width: 300, height: 60), in: web), "a paste button that cannot be seen")
        // and that one was found, and turned away for being faint, not for not being there
        var faint: [String: Any]?
        let read = expectation(description: "read")
        web.evaluateJavaScript(PasteAffordance.script(for: CGRect(x: 20, y: 340, width: 300, height: 60)), in: nil, in: .defaultClient) {
            if case .success(let answer) = $0 { faint = answer as? [String: Any] }
            read.fulfill()
        }
        wait(for: [read], timeout: 10)
        XCTAssertEqual(faint?["found"] as? Bool, true)
        XCTAssertEqual(faint?["shown"] as? Bool, false)
        XCTAssertFalse(check(CGRect(x: 20, y: 500, width: 300, height: 140), in: web), "a rectangle bigger than the button")
        XCTAssertFalse(check(CGRect(x: 20, y: 300, width: 300, height: 60), in: web), "nothing there at all")
    }

    func testAnAnswerIsReadStrictly() {
        let rect = CGRect(x: 20, y: 500, width: 300, height: 60)
        let good: [String: Any] = ["found": true, "word": true, "shown": true, "x": 20, "y": 500, "w": 300, "h": 60]
        XCTAssertTrue(PasteAffordance.accepts(good, rect: rect))
        for (key, value) in [("found", false), ("word", false), ("shown", false)] as [(String, Any)] {
            var bad = good
            bad[key] = value
            XCTAssertFalse(PasteAffordance.accepts(bad, rect: rect), key)
        }
        var off = good
        off["y"] = 503
        XCTAssertFalse(PasteAffordance.accepts(off, rect: rect), "three points off")
        XCTAssertFalse(PasteAffordance.accepts(nil, rect: rect))
        XCTAssertFalse(PasteAffordance.accepts("yes", rect: rect))
    }
}

/// The keeper's yeses before a card session, as the bridge holds them: each is
/// for the next session to begin, ends with it or after ninety seconds, and the
/// card's own answers in a session are what a signature with no yes is held to.
final class CardApprovalTests: XCTestCase {
    private func approval(_ body: [String: Any], at: TimeInterval = Date().timeIntervalSince1970) throws -> CardOwner.Approval {
        try XCTUnwrap(CardOwner.approval(body, at: at))
    }

    func testAYesIsForTheNextSessionAndEndsWithIt() throws {
        let bridge = FoxyBridge()
        bridge.cardApprovals.append((try approval(["label": "reset", "value": ""]), nil))
        bridge.cardSessionBegan()
        XCTAssertEqual(bridge.cardApprovals.first?.session, bridge.cardSession, "bound to the session that began after it")
        bridge.cardSessionEnded()
        XCTAssertTrue(bridge.cardApprovals.isEmpty, "a session that ended takes its yes with it")
        // one given while a session is open is for the next one, not that one
        bridge.cardSessionBegan()
        bridge.cardApprovals.append((try approval(["label": "reset", "value": ""]), nil))
        bridge.cardSessionBegan()
        XCTAssertEqual(bridge.cardApprovals.count, 1)
        XCTAssertEqual(bridge.cardApprovals.first?.session, bridge.cardSession)
        // and none lasts past ninety seconds
        bridge.cardApprovals = [(try approval(["label": "reset", "value": ""], at: Date().timeIntervalSince1970 - 91), nil)]
        bridge.cardSessionBegan()
        XCTAssertTrue(bridge.cardApprovals.isEmpty)
    }

    func testTheCardsOwnAnswersAreKeptForTheSessionOnly() {
        let bridge = FoxyBridge()
        bridge.cardSessionBegan()
        var info = [UInt8](repeating: 0, count: 51)
        info[16] = 1
        info[12...15] = [0, 0, 0x03, 0xE8]
        bridge.cardSaw(Data([0xB0, 0x01, 0x03, 0x00, 0x00]), Data(info + [0x90, 0x00]))
        XCTAssertEqual(bridge.cardSeen.limits?[.day], 1000)
        XCTAssertFalse(bridge.cardSeen.unowned)
        // a refusal says nothing of the card
        bridge.cardSaw(Data([0xB0, 0x01, 0x03, 0x00, 0x00]), Data([UInt8](repeating: 0, count: 51) + [0x69, 0x85]))
        XCTAssertEqual(bridge.cardSeen.limits?[.day], 1000)
        let mint = Array("https://mint.example.com".utf8)
        var record = [UInt8](repeating: 0, count: 106)
        record[2] = 0x01
        record[105] = UInt8(mint.count)
        record += mint
        bridge.cardSaw(Data([0xB0, 0x16, 0x00, 0x00, 0x00]), Data(record + [0x90, 0x00]))
        XCTAssertEqual(bridge.cardSeen.mint, mint)
        XCTAssertEqual(bridge.cardSeen.unit, 0x01)
        bridge.cardSessionEnded()
        XCTAssertEqual(bridge.cardSeen, CardOwner.Seen(), "forgotten when the session ends")
    }
}
