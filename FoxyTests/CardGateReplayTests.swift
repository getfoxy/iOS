import XCTest
@testable import Foxy

/// The page's own taps, replayed through the phone's rule. tests/fixtures/card-gate-flows.json is written by the node suites run with
/// FOXY_GATE_RECORD (tests/flashcard-gate.js names each flow): every yes the page asked for, every session, the card's answers the rule
/// reads (its key, its limits, its record, the owner's grant) and every owner's signature asked, with whether the model of the rule in
/// tests/harness.js (`cardGate`) signed it. Here the Swift itself (CardOwner.approval and split, cardSaw, cardOwnerAllows) must answer
/// each signature the same: the model is held to the rule, and the rule to the bytes the page really sends.
final class CardGateReplayTests: XCTestCase {
    func testThePagesOwnTapsPassTheRuleAsTheModelSaid() throws {
        let url = repoRoot().appendingPathComponent("tests/fixtures/card-gate-flows.json")
        let data = try Data(contentsOf: url)
        let flows = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(flows.count, 7, "a flow for each that takes money off the keeper's own card")
        var signed = 0
        for flow in flows {
            let name = flow["flow"] as? String ?? "?"
            let steps = try XCTUnwrap(flow["steps"] as? [[String: Any]], name)
            SeedStore.deleteIfPresent(key: CardLifts.key)
            SeedStore.deleteIfPresent(key: CardMoves.key)
            let bridge = FoxyBridge()
            var lifted = false
            for (n, step) in steps.enumerated() {
                switch step["step"] as? String {
                case "approve":
                    let body = try XCTUnwrap(step["body"] as? [String: Any])
                    let approval = try XCTUnwrap(CardOwner.approval(body, at: Date().timeIntervalSince1970), "\(name) #\(n): a yes the phone would refuse to ask")
                    for one in CardOwner.split(approval) {
                        if one.keep { CardMoves.keep(one) } else { bridge.cardApprovals.append((one, nil)) }
                    }
                case "begin": bridge.cardSessionBegan()
                case "again": bridge.cardSeen = CardOwner.Seen()
                case "end": bridge.cardSessionEnded()
                case "saw":
                    let apdu = try XCTUnwrap(CardGate.bytes(hex: step["apdu"] as? String ?? ""))
                    let answer = try XCTUnwrap(CardGate.bytes(hex: step["answer"] as? String ?? ""))
                    bridge.cardSaw(apdu, answer)
                case "sign":
                    let body = try XCTUnwrap(step["body"] as? [String: Any])
                    let request = try XCTUnwrap(CardOwner.signRequest(body), "\(name) #\(n)")
                    let want = step["allowed"] as? Bool ?? false
                    XCTAssertEqual(bridge.cardOwnerAllows(request), want, "\(name) #\(n): \(request.label.rawValue) \(NUT13.hex(request.value))")
                    if want { signed += 1 }
                    if want, request.label == .setLimit, NUT13.hex(Array(request.value.prefix(4))) == "00000000" { lifted = true }
                default: XCTFail("\(name) #\(n): no such step")
                }
            }
            if flow["lifts"] as? Bool == true { XCTAssertTrue(lifted, "\(name): the flow lifted the card's limit under the keeper's yes") }
            bridge.cardSessionEnded()
        }
        XCTAssertGreaterThan(signed, 0)
        SeedStore.deleteIfPresent(key: CardLifts.key)
        SeedStore.deleteIfPresent(key: CardMoves.key)
    }
}
