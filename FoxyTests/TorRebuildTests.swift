import XCTest
#if canImport(FoxyTorReturn)
@testable import FoxyTorReturn
#else
@testable import Foxy
#endif

/// Tor up and carrying nothing after a return from the background
/// (Foxy/Tor/TorReturn.swift, `Rebuild`), and an .onion asked for while Tor's
/// control link comes back (`onionWhenTorIsBack`). A fake control link stands
/// in for Tor: it writes down every signal sent, and can be gone. Runs in
/// FoxyTests and in tools/nativetests, as TorReturnTests does.
final class TorRebuildTests: XCTestCase {

    /// The control link: signals sent on it, whether it is there, and the
    /// answer it gives (held until `answer` unless `answersAtOnce`).
    private final class FakeLink {
        var there = true
        var sent: [String] = []
        var answersAtOnce = true
        var held: [(Bool) -> Void] = []
        func send(_ done: @escaping (Bool) -> Void) -> Bool {
            guard there else { return false }
            sent.append("SIGNAL NEWNYM")
            if answersAtOnce { done(true) } else { held.append(done) }
            return true
        }
    }

    private func rebuild(_ link: FakeLink) -> TorReturn.Rebuild {
        TorReturn.Rebuild { done in link.send(done) }
    }

    func testTheNumberIsThreeAndTheCoolDownAMinute() {
        XCTAssertEqual(TorReturn.rebuildAfterSilent, 3)
        XCTAssertEqual(TorReturn.rebuildCoolDown, 60)
    }

    func testSentAfterNInARowAndNotAfterNMinusOne() {
        let link = FakeLink()
        let r = rebuild(link)
        r.returned()
        let n = TorReturn.rebuildAfterSilent
        for k in 1..<n {
            XCTAssertEqual(r.silent(k), .tooFew, "\(k) in a row")
            XCTAssertTrue(link.sent.isEmpty, "nothing sent at \(k), one short of \(n)")
        }
        XCTAssertEqual(r.silent(n), .sent)
        XCTAssertEqual(link.sent, ["SIGNAL NEWNYM"], "one signal, at \(n)")
        XCTAssertEqual(TorReturn.Rebuild.Answer.sent.rawValue, "rebuilding", "the word the page waits for")
    }

    func testAtMostOncePerReturn() {
        let link = FakeLink()
        let r = rebuild(link)
        let t0 = Date()
        r.returned()
        XCTAssertEqual(r.silent(3, now: t0), .sent)
        // more askings unanswered, long after the cool-down: still this return
        for (k, later) in [(4, 5.0), (5, 61.0), (9, 600.0)] {
            XCTAssertEqual(r.silent(k, now: t0.addingTimeInterval(later)), .doneThisReturn, "\(k) at +\(later) s")
        }
        XCTAssertEqual(link.sent.count, 1, "once on this return, however many follow")
        // the next return may ask again, past the cool-down
        r.returned()
        XCTAssertEqual(r.silent(3, now: t0.addingTimeInterval(700)), .sent)
        XCTAssertEqual(link.sent.count, 2)
    }

    func testTheCoolDownHoldsAcrossReturns() {
        let link = FakeLink()
        let r = rebuild(link)
        let t0 = Date()
        r.returned()
        XCTAssertEqual(r.silent(3, now: t0), .sent)
        // put away and back twenty seconds later, and the next three go unanswered at once
        r.returned()
        XCTAssertEqual(r.silent(3, now: t0.addingTimeInterval(20)), .coolingDown)
        XCTAssertEqual(r.silent(4, now: t0.addingTimeInterval(59.9)), .coolingDown)
        XCTAssertEqual(link.sent.count, 1, "nothing within a minute of the last")
        XCTAssertEqual(r.silent(5, now: t0.addingTimeInterval(60)), .sent, "a minute on, the same return may")
        XCTAssertEqual(link.sent.count, 2)
    }

    func testNothingBeforeAReturn() {
        // a launch has its own screens for a Tor still connecting: only a return from the background counts
        let link = FakeLink()
        let r = rebuild(link)
        XCTAssertEqual(r.silent(3), .notAfterReturn)
        XCTAssertEqual(r.silent(10), .notAfterReturn)
        XCTAssertTrue(link.sent.isEmpty)
    }

    func testNoLinkUsesNothingUp() {
        // the control link gone (iOS took it; Tor not up): nothing is sent, and the return's one asking is kept
        let link = FakeLink()
        link.there = false
        let r = rebuild(link)
        r.returned()
        XCTAssertEqual(r.silent(3), .noLink)
        XCTAssertNil(r.lastAsked, "no cool-down started by a signal never sent")
        link.there = true
        XCTAssertEqual(r.silent(4), .sent, "the link back: the next one asks")
        XCTAssertEqual(link.sent.count, 1)
    }

    func testTorsAnswerIsTold() {
        let link = FakeLink()
        link.answersAtOnce = false
        let r = rebuild(link)
        var told: [Bool] = []
        r.told = { told.append($0) }
        r.returned()
        XCTAssertEqual(r.silent(3), .sent)
        XCTAssertTrue(told.isEmpty, "nothing said before Tor answers")
        link.held.first?(true)
        XCTAssertEqual(told, [true])
    }

    /// The lines TorService prints for this are not trouble on the ERRORS screen, and name nothing.
    func testTheLinesAreCalm() throws {
        let src = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Tor/TorService.swift"), encoding: .utf8)
        for needle in ["askings in a row on fresh circuits went unanswered since the return; asking Tor for new circuits (NEWNYM)",
                       "Tor took the request for new circuits"] {
            XCTAssertTrue(src.contains(needle), "TorService no longer says: \(needle)")
            for t in ["failed", "refused", "error"] { XCTAssertFalse(needle.contains(t), needle) }
        }
        // the signal, and nothing heavier: no restart, no network off and on, from the rebuild
        guard let a = src.range(of: "private static let rebuild: TorReturn.Rebuild = {"),
              let b = src[a.upperBound...].range(of: "}()") else { return XCTFail("TorService.rebuild not found") }
        let body = String(src[a.upperBound..<b.lowerBound])
        XCTAssertTrue(body.contains("\"SIGNAL\", [\"NEWNYM\"]"), body)
        for heavy in ["restart(", "DisableNetwork", "nudge(", "setUp("] {
            XCTAssertFalse(body.contains(heavy), "the rebuild does \(heavy)")
        }
    }

    // MARK: The second stage: Tor's network off and on

    /// The switch: how many times Tor's network was switched off and on, and whether there is a link to do it on.
    private final class FakeSwitch {
        var there = true
        var nudges = 0
        func nudge() -> Bool {
            guard there else { return false }
            nudges += 1
            return true
        }
    }

    /// A return, the new circuits asked for at `t0`, and the stage-two rule on `sw`.
    private func afterNewCircuits(_ sw: FakeSwitch, at t0: Date) -> TorReturn.Restart {
        let r = TorReturn.Restart { sw.nudge() }
        r.returned()
        r.rebuilt(now: t0)
        return r
    }

    func testTheSecondStageNumbers() {
        XCTAssertEqual(TorReturn.restartAfterSilent, 3)
        XCTAssertEqual(TorReturn.restartWithin, 20)
        XCTAssertEqual(TorReturn.restartCoolDown, 300)
        XCTAssertEqual(TorReturn.Restart.Answer.sent.rawValue, "restarting", "the word the page waits for")
    }

    func testOnlyAfterTheNewCircuits() {
        // three, five, ten unanswered on a return with no NEWNYM sent: nothing heavier is done first
        let sw = FakeSwitch()
        let r = TorReturn.Restart { sw.nudge() }
        let t0 = Date()
        r.returned()
        for k in 0..<10 {
            XCTAssertEqual(r.silent(now: t0.addingTimeInterval(Double(k)), lastNudge: nil, moneyOut: false), .notAfterRebuild)
        }
        XCTAssertEqual(sw.nudges, 0)
        // and before any return at all
        let fresh = TorReturn.Restart { sw.nudge() }
        XCTAssertEqual(fresh.silent(lastNudge: nil, moneyOut: false), .notAfterRebuild)
        XCTAssertEqual(sw.nudges, 0)
    }

    func testThreeMoreAndNotTwo() {
        let sw = FakeSwitch()
        let t0 = Date()
        let r = afterNewCircuits(sw, at: t0)
        XCTAssertEqual(r.silent(now: t0.addingTimeInterval(5), lastNudge: nil, moneyOut: false), .tooFew)
        XCTAssertEqual(r.silent(now: t0.addingTimeInterval(10), lastNudge: nil, moneyOut: false), .tooFew)
        XCTAssertEqual(sw.nudges, 0, "two more: nothing")
        XCTAssertEqual(r.silent(now: t0.addingTimeInterval(15), lastNudge: nil, moneyOut: false), .sent)
        XCTAssertEqual(sw.nudges, 1, "the third more: Tor's network off and on")
    }

    func testThreeMoreMustFallWithinTwentySeconds() {
        let sw = FakeSwitch()
        let t0 = Date()
        let r = afterNewCircuits(sw, at: t0)
        // a slow mint's pace: twelve seconds apart, never three in twenty
        for k in 1...6 {
            XCTAssertEqual(r.silent(now: t0.addingTimeInterval(Double(k) * 12), lastNudge: nil, moneyOut: false), .tooFew, "at \(k * 12) s")
        }
        XCTAssertEqual(sw.nudges, 0)
        // then three in twenty: the last two of the slow ones are too old for the window by now
        let t1 = t0.addingTimeInterval(200)
        XCTAssertEqual(r.silent(now: t1, lastNudge: nil, moneyOut: false), .tooFew)
        XCTAssertEqual(r.silent(now: t1.addingTimeInterval(10), lastNudge: nil, moneyOut: false), .tooFew)
        XCTAssertEqual(r.silent(now: t1.addingTimeInterval(20), lastNudge: nil, moneyOut: false), .sent, "three within twenty, the edge included")
        XCTAssertEqual(sw.nudges, 1)
    }

    func testAnyHostAnsweringStopsItForTheReturn() {
        // a dead mint, while the price source or an explorer answers: Tor carries, and nothing is switched
        let sw = FakeSwitch()
        let t0 = Date()
        let r = afterNewCircuits(sw, at: t0)
        XCTAssertEqual(r.silent(now: t0.addingTimeInterval(1), lastNudge: nil, moneyOut: false), .tooFew)
        XCTAssertEqual(r.silent(now: t0.addingTimeInterval(2), lastNudge: nil, moneyOut: false), .tooFew)
        r.answered()
        XCTAssertTrue(r.hostAnswered)
        for k in 3...12 {
            XCTAssertEqual(r.silent(now: t0.addingTimeInterval(Double(k)), lastNudge: nil, moneyOut: false), .answered, "at +\(k) s")
        }
        XCTAssertEqual(sw.nudges, 0, "a dead mint alone never switches Tor's network")
        // an answer before the new circuits counts the same: since the return is what is asked
        let r2 = TorReturn.Restart { sw.nudge() }
        r2.returned()
        r2.answered()
        r2.rebuilt(now: t0)
        for k in 1...5 { XCTAssertEqual(r2.silent(now: t0.addingTimeInterval(Double(k)), lastNudge: nil, moneyOut: false), .answered) }
        XCTAssertEqual(sw.nudges, 0)
        // the next return starts over
        r.returned()
        r.rebuilt(now: t0.addingTimeInterval(100))
        for k in 1...3 { _ = r.silent(now: t0.addingTimeInterval(100 + Double(k)), lastNudge: nil, moneyOut: false) }
        XCTAssertEqual(sw.nudges, 1, "a new return, nothing heard: the third more switches")
    }

    func testAtMostOncePerReturnAndFiveMinutesApart() {
        let sw = FakeSwitch()
        let t0 = Date()
        let r = afterNewCircuits(sw, at: t0)
        for k in 1...3 { _ = r.silent(now: t0.addingTimeInterval(Double(k)), lastNudge: nil, moneyOut: false) }
        XCTAssertEqual(sw.nudges, 1)
        let nudged = t0.addingTimeInterval(3)
        for k in 4...20 {
            XCTAssertEqual(r.silent(now: t0.addingTimeInterval(Double(k) * 60), lastNudge: nudged, moneyOut: false), .doneThisReturn)
        }
        XCTAssertEqual(sw.nudges, 1, "once on this return, however long it goes on")
        // a return two minutes later: within five minutes of the last, it waits
        r.returned()
        let t1 = t0.addingTimeInterval(120)
        r.rebuilt(now: t1)
        for k in 1...3 { XCTAssertNotEqual(r.silent(now: t1.addingTimeInterval(Double(k)), lastNudge: nudged, moneyOut: false), .sent) }
        XCTAssertEqual(r.silent(now: t1.addingTimeInterval(4), lastNudge: nudged, moneyOut: false), .coolingDown)
        XCTAssertEqual(sw.nudges, 1)
        // a nudge of Tor's own stall watch counts too, and five minutes on the same return may
        XCTAssertEqual(r.silent(now: nudged.addingTimeInterval(299), lastNudge: nudged, moneyOut: false), .tooFew, "the window has emptied by then")
        XCTAssertEqual(r.silent(now: nudged.addingTimeInterval(305), lastNudge: nudged, moneyOut: false), .tooFew)
        XCTAssertEqual(r.silent(now: nudged.addingTimeInterval(310), lastNudge: nudged, moneyOut: false), .sent)
        XCTAssertEqual(sw.nudges, 2)
    }

    func testNeverWithASwapOut() {
        // a swap or restore out: it is not cut; the next asking unanswered may switch once it is back
        let sw = FakeSwitch()
        let t0 = Date()
        let r = afterNewCircuits(sw, at: t0)
        XCTAssertEqual(r.silent(now: t0.addingTimeInterval(1), lastNudge: nil, moneyOut: true), .tooFew)
        XCTAssertEqual(r.silent(now: t0.addingTimeInterval(2), lastNudge: nil, moneyOut: true), .tooFew)
        XCTAssertEqual(r.silent(now: t0.addingTimeInterval(3), lastNudge: nil, moneyOut: true), .moneyOut)
        XCTAssertEqual(sw.nudges, 0)
        XCTAssertEqual(r.silent(now: t0.addingTimeInterval(4), lastNudge: nil, moneyOut: false), .sent)
        XCTAssertEqual(sw.nudges, 1)
    }

    func testNoLinkUsesNothingUpForTheSecondStage() {
        let sw = FakeSwitch()
        sw.there = false
        let t0 = Date()
        let r = afterNewCircuits(sw, at: t0)
        for k in 1...3 { _ = r.silent(now: t0.addingTimeInterval(Double(k)), lastNudge: nil, moneyOut: false) }
        XCTAssertEqual(r.silent(now: t0.addingTimeInterval(4), lastNudge: nil, moneyOut: false), .noLink)
        sw.there = true
        XCTAssertEqual(r.silent(now: t0.addingTimeInterval(5), lastNudge: nil, moneyOut: false), .sent, "the link back: the next one switches")
        XCTAssertEqual(sw.nudges, 1)
    }

    /// TorService wires the second stage as the rule says: the network off and on through `nudge`, the
    /// time of every nudge kept, a host answering told from the route, and a swap out passed from the bridge.
    func testTheSecondStageIsWired() throws {
        let tor = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Tor/TorService.swift"), encoding: .utf8)
        guard let a = tor.range(of: "private static let restartRule: TorReturn.Restart = TorReturn.Restart {"),
              let b = tor[a.upperBound...].range(of: "\n    }\n") else { return XCTFail("TorService.restartRule not found") }
        let body = String(tor[a.upperBound..<b.lowerBound])
        XCTAssertTrue(body.contains("nudge()"), body)
        for heavy in ["restart(", "setUp(", "NEWNYM"] { XCTAssertFalse(body.contains(heavy), "the second stage does \(heavy)") }
        XCTAssertTrue(tor.contains("starting Tor's connections again (network off and on)"))
        guard let n = tor.range(of: "private static func nudge() {"),
              let m = tor[n.upperBound...].range(of: "print(\"[foxy] tor: retrying\")") else { return XCTFail("nudge not found") }
        XCTAssertTrue(tor[n.upperBound..<m.lowerBound].contains("nudgedAt = Date()"), "every nudge is timed, for the five minutes")
        XCTAssertTrue(tor.contains("restartRule.rebuilt()"), "the new circuits arm the second stage")
        XCTAssertTrue(tor.contains("rebuild.returned(); restartRule.returned()"), "a return starts both over")
        let route = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Network/Route.swift"), encoding: .utf8)
        XCTAssertTrue(route.contains("if response is HTTPURLResponse { DispatchQueue.main.async { TorService.hostAnswered() } }"),
                      "every answer through the route is told")
        let bridge = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Bridge/FoxyBridge.swift"), encoding: .utf8)
        XCTAssertTrue(bridge.contains("moneyOut: !moneyInFlight.isEmpty"), "the bridge passes a swap out")
    }

    // MARK: An .onion while Tor's link comes back

    private let needsTor = "An .onion address needs Tor, and Foxy is not connected to Tor."

    func testAnOnionWaitsForTorOnItsWayAndIsCheckedOnce() {
        var up = false
        var checks = 0
        var waited = 0
        var then: (() -> Void)?
        var answer: String?? = .none
        TorReturn.onionWhenTorIsBack(problem: { checks += 1; return up ? nil : self.needsTor }, needsTor: needsTor,
                                     torComing: { true }, wait: { waited += 1; then = $0 }) { answer = .some($0) }
        XCTAssertEqual(checks, 1)
        XCTAssertEqual(waited, 1, "it waits for Tor")
        XCTAssertNil(answer, "and is not answered while it waits")
        up = true                                   // the control link back, Tor up
        then?()
        XCTAssertEqual(checks, 2, "checked once more")
        XCTAssertEqual(answer, .some(nil), "and goes ahead")
    }

    func testAnOnionStillRefusedAfterTheWaitIsRefusedOnce() {
        var checks = 0
        var waited = 0
        var answer: String?? = .none
        TorReturn.onionWhenTorIsBack(problem: { checks += 1; return self.needsTor }, needsTor: needsTor,
                                     torComing: { true }, wait: { waited += 1; $0() }) { answer = .some($0) }
        XCTAssertEqual(checks, 2)
        XCTAssertEqual(waited, 1, "one wait, never a loop")
        XCTAssertEqual(answer, .some(needsTor))
    }

    func testNoWaitWhenTorIsNotOnItsWayOrTheRefusalIsAnother() {
        var waited = 0
        var answers: [String?] = []
        // Tor stopped, failed or parked: refused at once, as before
        TorReturn.onionWhenTorIsBack(problem: { self.needsTor }, needsTor: needsTor, torComing: { false },
                                     wait: { waited += 1; $0() }) { answers.append($0) }
        // another refusal: at once
        TorReturn.onionWhenTorIsBack(problem: { "That is not a mint address Foxy will use." }, needsTor: needsTor,
                                     torComing: { true }, wait: { waited += 1; $0() }) { answers.append($0) }
        // nothing wrong: at once
        TorReturn.onionWhenTorIsBack(problem: { nil }, needsTor: needsTor, torComing: { true },
                                     wait: { waited += 1; $0() }) { answers.append($0) }
        XCTAssertEqual(waited, 0)
        XCTAssertEqual(answers, [needsTor, "That is not a mint address Foxy will use.", nil])
    }

    func testTheRouteSaysTheSameWords() throws {
        let src = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Network/Route.swift"), encoding: .utf8)
        XCTAssertTrue(src.contains("static let onionNeedsTor = \"\(needsTor)\""), "Route.onionNeedsTor changed its words")
        XCTAssertEqual(TorReturn.onionWaitsForTor, 10)
    }
}
