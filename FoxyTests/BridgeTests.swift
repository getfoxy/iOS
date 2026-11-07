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
        XCTAssertEqual(documented.count, 91, "THREAT-MODEL.md §1 lists \(documented.sorted())")
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

    private let key = [UInt8]((try? NUT13.bytes(hex: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")) ?? [])
    private func u32(_ n: UInt32) -> [UInt8] { [UInt8(n >> 24), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)] }
    private func limit(_ figures: UInt32...) -> CardOwner.SignRequest {
        CardOwner.SignRequest(key: key, label: .setLimit, nonce: [UInt8](repeating: 7, count: 16), value: figures.flatMap { u32($0) })
    }
    /// A card of 1.23's GET_INFO answer (P1 = 3) with these limits, as the phone carries it; `quick`, a card that says its limit on one
    /// payment only after its owner's grant (0 before it).
    private func sawInfo(_ bridge: FoxyBridge, day: UInt32, tap: UInt32, noPin: UInt32, quick: Bool = false, length: Int = 51) {
        var info = [UInt8](repeating: 0, count: length)
        info[0] = 1
        info[1] = 23
        info[6] = quick ? 31 : 15
        info[16] = 1
        info.replaceSubrange(12..<16, with: u32(day))
        if length >= 42 {
            info.replaceSubrange(30..<34, with: u32(tap))
            info.replaceSubrange(34..<38, with: u32(noPin))
        }
        bridge.cardSaw(Data([0xB0, 0x01, length == 30 ? 0x00 : 0x03, 0x00, 0x00]), Data(info + [0x90, 0x00]))
    }
    private func sawKey(_ bridge: FoxyBridge, _ k: [UInt8]? = nil) {
        bridge.cardSaw(Data([0xB0, 0x10, 0x00, 0x00, 0x00]), Data((k ?? key) + [0x90, 0x00]))
    }
    private func sawGrant(_ bridge: FoxyBridge) {
        bridge.cardSaw(Data([0xB0, 0x45, 0x00, 0x00, 0x03, 0x30, 0x01, 0x00]), Data([0x90, 0x00]))
    }
    private func given(_ bridge: FoxyBridge, _ body: [String: Any]) throws {
        for one in CardOwner.split(try approval(body)) { bridge.cardApprovals.append((one, nil)) }
    }

    /// The tap 2026-11-06 lost three times: WITHDRAW from the keeper's own card, which lifts its limit with the owner key and puts it
    /// back. With no yes that covered the lift, the phone refused it and the tap failed. Now WITHDRAW asks one yes naming the lift, and
    /// with it the phone signs the lift and the limits put back as the card said them, and nothing else.
    func testAWithdrawalsLiftIsSignedAndPutBackAsTheCardSaidIt() throws {
        SeedStore.deleteIfPresent(key: CardLifts.key)
        defer { SeedStore.deleteIfPresent(key: CardLifts.key) }
        let bridge = FoxyBridge()
        // no yes: the lift is refused, as on the phone that morning
        bridge.cardSessionBegan()
        sawKey(bridge)
        sawInfo(bridge, day: 1000, tap: 200, noPin: 50)
        XCTAssertFalse(bridge.cardOwnerAllows(limit(0, 0, 50, 97_000)), "a lift nobody said yes to")
        bridge.cardSessionEnded()
        // the yes to the lift, before the tap
        try given(bridge, ["label": "set-limit", "lift": true])
        bridge.cardSessionBegan()
        sawKey(bridge)
        sawInfo(bridge, day: 1000, tap: 200, noPin: 50)
        XCTAssertFalse(bridge.cardOwnerAllows(limit(5000, 200, 50, 97_000)), "a limit raised is no lift")
        XCTAssertFalse(bridge.cardOwnerAllows(limit(0, 0, 999, 97_000)), "nor one with another allowance")
        XCTAssertTrue(bridge.cardOwnerAllows(limit(0, 0, 50, 97_000)), "the lift")
        XCTAssertFalse(bridge.cardOwnerAllows(limit(0, 0)), "a second lift before the first is put back")
        XCTAssertFalse(bridge.cardOwnerAllows(limit(0, 0, 0, 97_000)), "nor one that takes the allowance with it")
        XCTAssertFalse(bridge.cardOwnerAllows(limit(2000, 200, 50, 97_000)), "limits put back that are not the card's")
        XCTAssertTrue(bridge.cardOwnerAllows(limit(1000, 200, 50, 97_000)), "the card's own put back")
        XCTAssertFalse(bridge.cardOwnerAllows(limit(9000, 200, 50, 97_000)), "and nothing after that")
        // a card of two currencies: lifted for the second, and put back again, in the same tap
        XCTAssertTrue(bridge.cardOwnerAllows(limit(0, 0, 50, 97_000)))
        XCTAssertTrue(bridge.cardOwnerAllows(limit(1000, 200, 50, 97_000)))
        // the yes lasts the session it was for, past its ninety seconds: the money can take that long to come off
        bridge.cardApprovals = bridge.cardApprovals.map { (CardOwner.Approval(label: $0.approval.label, value: nil, mint: nil, units: nil, figures: nil, card: nil,
                                                                              keep: false, at: $0.approval.at - 120, lift: true), $0.session) }
        XCTAssertTrue(bridge.cardOwnerAllows(limit(0, 0, 50, 97_000)), "lifted again, the card having come back to the sheet")
        // the card leaves lifted; the next tap finds it so and puts it back, with no yes
        bridge.cardSessionEnded()
        XCTAssertTrue(bridge.cardApprovals.isEmpty, "the lift's yes went with its session")
        bridge.cardSessionBegan()
        sawKey(bridge)
        sawInfo(bridge, day: 0, tap: 0, noPin: 50)
        XCTAssertFalse(bridge.cardOwnerAllows(limit(3000, 200, 50, 97_000)), "not to other figures")
        XCTAssertFalse(bridge.cardOwnerAllows(limit(1000, 0, 50, 97_000)), "nor with the limit on one payment left lifted")
        XCTAssertTrue(bridge.cardOwnerAllows(limit(1000, 200, 50, 97_000)), "put back as it was before it was lifted")
        bridge.cardSessionEnded()
        // that put-back never reached the card (it left, or refused it): the next tap that finds it lifted is let put it back again
        bridge.cardSessionBegan()
        sawKey(bridge)
        sawInfo(bridge, day: 0, tap: 0, noPin: 50)
        XCTAssertTrue(bridge.cardOwnerAllows(limit(1000, 200, 50, 97_000)), "a put-back that did not land is asked again")
        // and once the card is seen holding its figures, the lift is done with
        sawKey(bridge)
        sawInfo(bridge, day: 1000, tap: 200, noPin: 50)
        XCTAssertTrue(CardLifts.kept().isEmpty, "seen put back")
        bridge.cardSessionEnded()
        bridge.cardSessionBegan()
        sawKey(bridge)
        sawInfo(bridge, day: 0, tap: 0, noPin: 50)
        XCTAssertFalse(bridge.cardOwnerAllows(limit(1000, 200, 50, 97_000)), "after that, nothing")
        bridge.cardSessionEnded()
    }

    /// A quick card says its limit on one payment as 0 until its owner's grant in the tap. Read before the grant, that 0 is no figure
    /// the card said: neither a write of it with nobody asked, nor a lift kept from it, which would put the card back without that limit.
    func testALimitReadBeforeTheGrantIsNotTheCards() throws {
        SeedStore.deleteIfPresent(key: CardLifts.key)
        defer { SeedStore.deleteIfPresent(key: CardLifts.key) }
        let bridge = FoxyBridge()
        bridge.cardSessionBegan()
        sawKey(bridge)
        sawInfo(bridge, day: 1000, tap: 0, noPin: 50, quick: true, length: 55)
        XCTAssertFalse(bridge.cardOwnerAllows(limit(1000, 0, 50, 97_000)), "the limit on one payment written to 0 with nobody asked")
        bridge.cardSessionEnded()
        try given(bridge, ["label": "set-limit", "lift": true])
        bridge.cardSessionBegan()
        sawKey(bridge)
        sawInfo(bridge, day: 1000, tap: 0, noPin: 50, quick: true, length: 55)
        XCTAssertFalse(bridge.cardOwnerAllows(limit(0, 0, 50, 97_000)), "a lift from a figure the card has not said")
        XCTAssertTrue(CardLifts.kept().isEmpty)
        // after the grant the card says it, and the lift is from it
        sawGrant(bridge)
        sawInfo(bridge, day: 1000, tap: 200, noPin: 50, quick: true, length: 55)
        XCTAssertTrue(bridge.cardOwnerAllows(limit(0, 0, 50, 97_000)))
        XCTAssertFalse(bridge.cardOwnerAllows(limit(1000, 0, 50, 97_000)), "put back without the limit on one payment")
        XCTAssertTrue(bridge.cardOwnerAllows(limit(1000, 200, 50, 97_000)))
        // the grant is the tap's: the sheet that looks for the card again starts without it
        bridge.cardSeen = CardOwner.Seen()
        sawInfo(bridge, day: 1000, tap: 0, noPin: 50, quick: true, length: 55)
        XCTAssertNil(bridge.cardSeen.limits?[.tap])
        bridge.cardSessionEnded()
    }

    /// The lift's four ways round: a part lift then a lift, the day put back alone, the thirty bytes of P1 = 0, and a read before the
    /// grant (above). None of them leaves the card, or the phone's note of it, without the keeper's limits.
    func testALiftKeptIsNotWrittenOverOrPutBackShort() throws {
        SeedStore.deleteIfPresent(key: CardLifts.key)
        defer { SeedStore.deleteIfPresent(key: CardLifts.key) }
        let bridge = FoxyBridge()
        try given(bridge, ["label": "set-limit", "lift": true])
        bridge.cardSessionBegan()
        sawKey(bridge)
        sawInfo(bridge, day: 1000, tap: 200, noPin: 50)
        // A: the day's alone is no lift where the card has a limit on one payment; nor is a lift over a kept one
        XCTAssertFalse(bridge.cardOwnerAllows(limit(0)), "A: a part lift")
        XCTAssertTrue(bridge.cardOwnerAllows(limit(0, 0)))
        XCTAssertFalse(bridge.cardOwnerAllows(limit(0, 0)), "A: a second lift, which would keep 0 as the card's")
        XCTAssertEqual(CardLifts.kept().first?.figures, [.day: 1000, .tap: 200, .noPin: 50])
        // B: the day put back alone is no put-back
        XCTAssertFalse(bridge.cardOwnerAllows(limit(1000)), "B: the day alone")
        XCTAssertFalse(bridge.cardOwnerAllows(limit(0, 200)), "nor the limit on one payment alone")
        XCTAssertTrue(bridge.cardOwnerAllows(limit(1000, 200)))
        bridge.cardSessionEnded()
        // C: P1 = 0's thirty bytes from a card of 1.3 and on say nothing of its limits
        try given(bridge, ["label": "set-limit", "lift": true])
        bridge.cardSessionBegan()
        sawKey(bridge)
        sawInfo(bridge, day: 1000, tap: 0, noPin: 0, length: 30)
        XCTAssertNil(bridge.cardSeen.limits)
        XCTAssertFalse(bridge.cardOwnerAllows(limit(0, 0)), "C: no lift from them")
        // L3: a card that gave its key is the only one signed for
        sawKey(bridge, [0x03] + [UInt8](repeating: 0x22, count: 32))
        sawInfo(bridge, day: 1000, tap: 200, noPin: 50)
        XCTAssertFalse(bridge.cardOwnerAllows(limit(1000, 200, 50, 97_000)), "a request for another card than the one held")
        bridge.cardSessionEnded()
    }

    /// What signs unasked is looked at before any yes, so that it does not use up the yes the keeper gave the tap's own command: a
    /// rate written with the card's own figures, then the no-PIN allowance the keeper chose, in one tap.
    func testWhatSignsUnaskedUsesUpNoYes() throws {
        SeedStore.deleteIfPresent(key: CardLifts.key)
        defer { SeedStore.deleteIfPresent(key: CardLifts.key) }
        let bridge = FoxyBridge()
        try given(bridge, ["label": "set-limit", "figures": ["noPin"]])
        bridge.cardSessionBegan()
        sawKey(bridge)
        sawInfo(bridge, day: 1000, tap: 200, noPin: 50)
        XCTAssertTrue(bridge.cardOwnerAllows(limit(1000, 200, 50, 98_000)), "the rate, unasked")
        XCTAssertEqual(bridge.cardApprovals.count, 1, "and the keeper's yes is still there")
        XCTAssertTrue(bridge.cardOwnerAllows(limit(1000, 200, 800, 98_000)), "for the allowance the keeper set")
        XCTAssertTrue(bridge.cardApprovals.isEmpty)
        XCTAssertFalse(bridge.cardOwnerAllows(limit(1000, 200, 900, 98_000)), "once")
        bridge.cardSessionEnded()
    }

    /// A kept lift is done with only when a GET_INFO answer shows the card holding its figures: not when its put-back is signed (the
    /// card may never take it), nor on GET_KEY, nor on an answer that says nothing of them (P1 = 0's thirty bytes).
    func testALiftIsSettledOnlyByWhatTheCardSays() throws {
        SeedStore.deleteIfPresent(key: CardLifts.key)
        defer { SeedStore.deleteIfPresent(key: CardLifts.key) }
        for answer in ["key", "thirty"] {
            let bridge = FoxyBridge()
            try given(bridge, ["label": "set-limit", "lift": true])
            bridge.cardSessionBegan()
            sawKey(bridge)
            sawInfo(bridge, day: 1000, tap: 200, noPin: 50)
            XCTAssertTrue(bridge.cardOwnerAllows(limit(0, 0, 50, 97_000)))
            XCTAssertTrue(bridge.cardOwnerAllows(limit(1000, 200, 50, 97_000)), "the put-back, signed and never sent")
            if answer == "key" { sawKey(bridge) } else { sawInfo(bridge, day: 1000, tap: 200, noPin: 50, length: 30) }
            XCTAssertEqual(CardLifts.kept().count, 1, "F/G (\(answer)): the lift is still kept")
            bridge.cardSessionEnded()
            bridge.cardSessionBegan()
            sawKey(bridge)
            sawInfo(bridge, day: 0, tap: 0, noPin: 50)
            XCTAssertTrue(bridge.cardOwnerAllows(limit(1000, 200, 50, 97_000)), "F/G (\(answer)): the next tap that finds it lifted puts it back")
            bridge.cardSessionEnded()
            SeedStore.deleteIfPresent(key: CardLifts.key)
        }
    }

    /// The card held gives its key in the tap (GET_KEY), and nothing is signed for an owner's command without it.
    func testNothingIsSignedWithoutTheCardsKey() throws {
        SeedStore.deleteIfPresent(key: CardLifts.key)
        defer { SeedStore.deleteIfPresent(key: CardLifts.key) }
        let bridge = FoxyBridge()
        try given(bridge, ["label": "set-limit", "lift": true])
        bridge.cardSessionBegan()
        sawInfo(bridge, day: 1000, tap: 200, noPin: 50)
        XCTAssertFalse(bridge.cardOwnerAllows(limit(0, 0, 50, 97_000)), "no key said in this tap")
        XCTAssertFalse(bridge.cardOwnerAllows(limit(1000, 200, 50, 98_000)), "not even a rate")
        sawKey(bridge)
        XCTAssertTrue(bridge.cardOwnerAllows(limit(0, 0, 50, 97_000)))
        bridge.cardSessionEnded()
    }

    /// A move kept for a later tap is used up when the card takes its record (SET_CARD answered 9000), not when it is signed: a TRANSFER
    /// whose card left before it was told its new mint is finished by the next tap, whose record is signed against the same yes.
    func testAKeptMoveIsUsedUpWhenTheCardTakesItsRecord() throws {
        SeedStore.deleteIfPresent(key: CardMoves.key)
        defer { SeedStore.deleteIfPresent(key: CardMoves.key) }
        let mint = Array("https://mint.example.com".utf8)
        CardMoves.keep(try approval(["label": "set-card", "mint": "https://mint.example.com", "keep": true, "card": NUT13.hex(key)]))
        var record: [UInt8] = [0x00]
        record += [0x02] + [UInt8](repeating: 0x44, count: 32)
        record += [UInt8](repeating: 0, count: 65)
        record.append(UInt8(mint.count))
        record += mint
        let write = CardOwner.SignRequest(key: key, label: .setCard, nonce: [UInt8](repeating: 7, count: 16), value: record)
        let bridge = FoxyBridge()
        bridge.cardSessionBegan()
        sawKey(bridge)
        XCTAssertTrue(bridge.cardOwnerAllows(write), "the record, against the move kept for this card")
        // the card leaves before SET_CARD reaches it
        bridge.cardSessionEnded()
        XCTAssertEqual(CardMoves.kept().count, 1, "the move is still kept")
        bridge.cardSessionBegan()
        sawKey(bridge)
        XCTAssertTrue(bridge.cardOwnerAllows(write), "TAP CARD: the record signed again")
        // a refusal is not the card taking it
        bridge.cardSaw(Data([0xB0, 0x32, 0x00, 0x00, 0x01, 0x00]), Data([0x6A, 0x80]))
        XCTAssertEqual(CardMoves.kept().count, 1)
        bridge.cardSaw(Data([0xB0, 0x32, 0x00, 0x00, 0x01, 0x00]), Data([0x90, 0x00]))
        XCTAssertTrue(CardMoves.kept().isEmpty, "the card took it: done with")
        XCTAssertFalse(bridge.cardOwnerAllows(write), "and nothing after that")
        bridge.cardSessionEnded()
    }

    /// A withdraw from a card with a per-second limit alone: a card of 1.25 with no daily limit (a quick card: the limit on one
    /// payment said only after the grant). With no yes the lift is refused, as on the phone; with the yes asked before the tap it is
    /// signed and put back. A card with the no-PIN allowance alone, or no limit at all, has nothing to lift: no lift signs there.
    func testAWithdrawalFromACardWithAPerSecondLimitAlone() throws {
        SeedStore.deleteIfPresent(key: CardLifts.key)
        defer { SeedStore.deleteIfPresent(key: CardLifts.key) }
        let bridge = FoxyBridge()
        let read = { (tap: UInt32, noPin: UInt32) in
            self.sawKey(bridge)
            self.sawInfo(bridge, day: 0, tap: 0, noPin: noPin, quick: true, length: 55)
            self.sawGrant(bridge)
            self.sawInfo(bridge, day: 0, tap: tap, noPin: noPin, quick: true, length: 55)
        }
        bridge.cardSessionBegan()
        read(3000, 0)
        XCTAssertFalse(bridge.cardOwnerAllows(limit(0, 0, 0, 1000)), "the log: a lift nobody said yes to")
        bridge.cardSessionEnded()
        try given(bridge, ["label": "set-limit", "lift": true])
        bridge.cardSessionBegan()
        read(3000, 0)
        XCTAssertTrue(bridge.cardOwnerAllows(limit(0, 0, 0, 1000)), "the per-second limit lifted under the yes")
        XCTAssertTrue(bridge.cardOwnerAllows(limit(0, 3000, 0, 1000)), "and put back")
        bridge.cardSessionEnded()
        for (name, noPin) in [("the no-PIN allowance alone", UInt32(500)), ("no limit at all", UInt32(0))] {
            try given(bridge, ["label": "set-limit", "lift": true])
            bridge.cardSessionBegan()
            read(0, noPin)
            // (a sixteen-byte write of the figures the card holds is a rate, which signs unasked and changes nothing; a lift is not that)
            XCTAssertFalse(bridge.cardOwnerAllows(limit(0, 0)), "\(name): no lift, even with a yes")
            bridge.cardSessionEnded()
        }
    }

    /// A limit the keeper chose is not undone by a lift kept from before it.
    func testALimitTheKeeperChoseDropsALiftFromBeforeIt() throws {
        SeedStore.deleteIfPresent(key: CardLifts.key)
        defer { SeedStore.deleteIfPresent(key: CardLifts.key) }
        let bridge = FoxyBridge()
        try given(bridge, ["label": "set-limit", "lift": true])
        bridge.cardSessionBegan()
        sawKey(bridge)
        sawInfo(bridge, day: 1000, tap: 200, noPin: 0)
        XCTAssertTrue(bridge.cardOwnerAllows(limit(0, 0)))
        bridge.cardSessionEnded()
        try given(bridge, ["label": "set-limit", "figures": ["tap"]])
        bridge.cardSessionBegan()
        sawKey(bridge)
        sawInfo(bridge, day: 0, tap: 0, noPin: 0)
        XCTAssertTrue(bridge.cardOwnerAllows(limit(0, 500)), "NO LIMIT for the day, and 500 on one payment, as the keeper set")
        XCTAssertFalse(bridge.cardOwnerAllows(limit(1000, 200)), "and the old limits are not put back over it")
        bridge.cardSessionEnded()
    }
}
