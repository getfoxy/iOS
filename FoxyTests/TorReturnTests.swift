import XCTest
#if canImport(FoxyTorReturn)
@testable import FoxyTorReturn
#else
@testable import Foxy
#endif

/// The rules a set-up runs by on the way back to Tor (Foxy/Tor/TorReturn.swift),
/// and that TorService still asks them where it decides. Runs in FoxyTests and
/// in tools/nativetests, where the file is its own module, FoxyTorReturn.
final class TorReturnTests: XCTestCase {

    // MARK: Tor's events

    func testACircuitEventIsReadWithoutItsRelays() {
        let e = TorReturn.parse("CIRC 12 EXTENDED $AAAA~guard,$BBBB~middle BUILD_FLAGS=NEED_CAPACITY PURPOSE=GENERAL TIME_CREATED=2026-10-22T10:00:00.000000")
        XCTAssertEqual(e, TorReturn.Event(kind: .circuit, id: "12", status: "EXTENDED", hops: 2, purpose: "GENERAL", reason: ""))
        let words = TorReturn.words(e!)
        XCTAssertEqual(words, "circuit 12 extended, 2 relays")
        XCTAssertFalse(words.contains("AAAA") || words.contains("guard"), "never a relay's name or fingerprint")
    }

    func testALaunchedCircuitHasNoPath() {
        let e = TorReturn.parse("CIRC 3 LAUNCHED BUILD_FLAGS=NEED_CAPACITY PURPOSE=GENERAL TIME_CREATED=2026-10-22T10:00:00.000000")
        XCTAssertEqual(e?.hops, 0)
        XCTAssertEqual(TorReturn.words(e!), "circuit 3 launched")
    }

    func testAFailedCircuitSaysWhy() {
        let e = TorReturn.parse("CIRC 7 FAILED $AAAA~a BUILD_FLAGS=NEED_CAPACITY PURPOSE=GENERAL REASON=TIMEOUT")
        XCTAssertEqual(e?.reason, "TIMEOUT")
        XCTAssertEqual(TorReturn.words(e!), "circuit 7 not built, 1 relay (timeout)")
        XCTAssertFalse(TorReturn.isProgress(e!), "a failure is not progress: a Tor failing every circuit is stuck")
    }

    func testAnOnionCircuitDoesNotSayWhatItIsFor() {
        // the diary is kept across a relaunch and says nothing about a payment
        let e = TorReturn.parse("CIRC 9 BUILT $A~a,$B~b,$C~c BUILD_FLAGS=IS_INTERNAL,NEED_CAPACITY,NEED_UPTIME PURPOSE=HS_SERVICE_INTRO HS_STATE=HSSI_ESTABLISHED")
        XCTAssertEqual(e?.purpose, "HS_SERVICE_INTRO")
        XCTAssertEqual(TorReturn.words(e!), "circuit 9 built, 3 relays")
        let r = TorReturn.parse("CIRC 10 EXTENDED $A~a PURPOSE=HS_CLIENT_REND HS_STATE=HSCR_CONNECTING")!
        XCTAssertFalse(TorReturn.words(r).lowercased().contains("hs_"), TorReturn.words(r))
    }

    /// FieldLog's trouble words, read from its source, so the two cannot drift apart.
    private func fieldLogTroubles() throws -> [String] {
        let src = try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Debug/FieldLog.swift"), encoding: .utf8)
        guard let a = src.range(of: "private static let troubles = ["),
              let b = src[a.upperBound...].range(of: "]") else { XCTFail("FieldLog.troubles not found"); return [] }
        let list = src[a.upperBound..<b.lowerBound].split(separator: ",").map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        }.filter { !$0.isEmpty }
        XCTAssertTrue(list.contains("failed") && list.contains("refused") && list.contains("error"), "\(list)")
        return list
    }

    func testRoutineCircuitsAndConnectionsAreNotTrouble() throws {
        let troubles = try fieldLogTroubles()
        // every status and reason Tor's control spec gives CIRC and ORCONN
        let circReasons = ["", "NONE", "TORPROTOCOL", "INTERNAL", "REQUESTED", "HIBERNATING", "RESOURCELIMIT",
                           "CONNECTFAILED", "OR_IDENTITY", "CHANNEL_CLOSED", "FINISHED", "TIMEOUT", "DESTROYED",
                           "NOPATH", "NOSUCHSERVICE", "MEASUREMENT_EXPIRED", "IP_NOW_REDUNDANT", "OR_CONN_CLOSED"]
        let orReasons = ["", "MISC", "DONE", "CONNECTREFUSED", "IDENTITY", "CONNECTRESET", "TIMEOUT", "NOROUTE",
                         "IOERROR", "RESOURCELIMIT", "PT_MISSING"]
        var lines: [String] = []
        for st in ["LAUNCHED", "EXTENDED", "BUILT", "FAILED", "CLOSED"] {
            for r in circReasons { lines.append("CIRC 4 \(st) $A~a PURPOSE=GENERAL" + (r.isEmpty ? "" : " REASON=\(r)")) }
        }
        for st in ["NEW", "LAUNCHED", "CONNECTED", "FAILED", "CLOSED"] {
            for r in orReasons { lines.append("ORCONN $A~a \(st)" + (r.isEmpty ? "" : " REASON=\(r)") + " ID=3") }
        }
        for l in lines {
            let w = TorReturn.words(TorReturn.parse(l)!).lowercased()
            for t in troubles { XCTAssertFalse(w.contains(t), "\"\(w)\" reads as trouble (\(t))") }
        }
    }

    func testTheSetUpsOwnLinesAreNotTrouble() throws {
        let troubles = try fieldLogTroubles()
        let src = try torService()
        // the diary lines of a return that are routine: a link iOS took, an ask for a circuit, one not built
        for needle in ["step(\"the control link said nothing in", "\"nothing back yet\"", "\"Tor said no (",
                       "why: \"circuit \\(e.id) not built\")"] {
            guard let r = src.range(of: needle) else { XCTFail("not found: \(needle)"); continue }
            let line = String(src[r.lowerBound...].prefix(while: { $0 != "\n" })).lowercased()
            for t in troubles { XCTAssertFalse(line.contains(t), "\(line) (\(t))") }
        }
    }

    func testARelayConnectionIsReadWithoutItsAddress() {
        let e = TorReturn.parse("ORCONN $ABCDEF~someguard CONNECTED ID=41")
        XCTAssertEqual(e, TorReturn.Event(kind: .relayLink, id: "41", status: "CONNECTED", hops: 0, purpose: "", reason: ""))
        XCTAssertEqual(TorReturn.words(e!), "relay connection 41 connected")
        let f = TorReturn.parse("ORCONN 192.0.2.7:9001 FAILED REASON=CONNECTREFUSED NCIRCS=2 ID=42")
        XCTAssertEqual(TorReturn.words(f!), "relay connection 42 not opened (connect turned away)")
        XCTAssertFalse(TorReturn.words(f!).contains("192.0.2.7"), "never a relay's address")
    }

    func testOtherLinesAreNotEvents() {
        XCTAssertNil(TorReturn.parse("STATUS_CLIENT NOTICE CIRCUIT_ESTABLISHED"))
        XCTAssertNil(TorReturn.parse("OK"))
        XCTAssertNil(TorReturn.parse("CIRC 1"))
    }

    func testProgressIsAnOpenConnectionOrAnotherRelayReached() {
        let yes = ["CIRC 1 EXTENDED $A~a PURPOSE=GENERAL", "CIRC 1 BUILT $A~a,$B~b,$C~c PURPOSE=GENERAL", "ORCONN $A~a CONNECTED ID=1"]
        let no = ["CIRC 1 LAUNCHED PURPOSE=GENERAL", "CIRC 1 FAILED PURPOSE=GENERAL REASON=TIMEOUT", "CIRC 1 CLOSED PURPOSE=GENERAL",
                  "ORCONN $A~a LAUNCHED ID=1", "ORCONN $A~a FAILED REASON=DONE ID=1", "ORCONN $A~a CLOSED ID=1"]
        for l in yes { XCTAssertTrue(TorReturn.isProgress(TorReturn.parse(l)!), l) }
        for l in no { XCTAssertFalse(TorReturn.isProgress(TorReturn.parse(l)!), l) }
    }

    func testOpenRelayConnectionsAreCounted() {
        var open: Set<String> = []
        for l in ["ORCONN $A~a LAUNCHED ID=1", "ORCONN $A~a CONNECTED ID=1", "ORCONN $B~b CONNECTED ID=2"] {
            open = TorReturn.openLinks(open, after: TorReturn.parse(l)!)
        }
        XCTAssertEqual(open, ["1", "2"])
        open = TorReturn.openLinks(open, after: TorReturn.parse("ORCONN $A~a CLOSED REASON=DONE ID=1")!)
        open = TorReturn.openLinks(open, after: TorReturn.parse("ORCONN $C~c FAILED REASON=TIMEOUT ID=3")!)
        XCTAssertEqual(open, ["2"])
        open = TorReturn.openLinks(open, after: TorReturn.parse("CIRC 5 BUILT $A~a PURPOSE=GENERAL")!)
        XCTAssertEqual(open, ["2"], "a circuit event leaves the connections as they are")
    }

    func testOnlyAnAskedCircuitThatFailedIsAskedForAgain() {
        let failed = TorReturn.parse("CIRC 5 FAILED $A~a PURPOSE=GENERAL REASON=TIMEOUT")!
        XCTAssertTrue(TorReturn.askAgain(after: failed, asked: ["5"], circuitUp: false))
        XCTAssertFalse(TorReturn.askAgain(after: failed, asked: ["6"], circuitUp: false), "Tor's own circuits are Tor's to retry")
        XCTAssertFalse(TorReturn.askAgain(after: failed, asked: ["5"], circuitUp: true), "nothing more once a circuit is up")
        let closed = TorReturn.parse("CIRC 5 CLOSED $A~a PURPOSE=GENERAL REASON=TIMEOUT")!
        XCTAssertFalse(TorReturn.askAgain(after: closed, asked: ["5"], circuitUp: false), "its CLOSED follows its FAILED: once")
    }

    // MARK: A return

    func testAReturnSoonAfterTorWasBroughtBackLeavesItUp() {
        // Foxy away four minutes, Tor brought back on the network ten seconds ago and up: left as it is
        XCTAssertTrue(TorReturn.returnFindsRouteUp(ready: true, wasParked: false, away: 240, sinceBroughtBack: 10))
        // the old rule, which still holds: away under half a minute
        XCTAssertTrue(TorReturn.returnFindsRouteUp(ready: true, wasParked: false, away: 2, sinceBroughtBack: 900))
        XCTAssertTrue(TorReturn.returnFindsRouteUp(ready: true, wasParked: false, away: 2, sinceBroughtBack: nil))
    }

    func testAReturnLongAfterBothSetsUpAsBefore() {
        // a connection left up through half a minute or more away may be one a suspension broke
        XCTAssertFalse(TorReturn.returnFindsRouteUp(ready: true, wasParked: false, away: 240, sinceBroughtBack: 300))
        XCTAssertFalse(TorReturn.returnFindsRouteUp(ready: true, wasParked: false, away: 240, sinceBroughtBack: nil))
        XCTAssertFalse(TorReturn.returnFindsRouteUp(ready: true, wasParked: false, away: 30, sinceBroughtBack: 30))
        XCTAssertFalse(TorReturn.returnFindsRouteUp(ready: false, wasParked: false, away: 2, sinceBroughtBack: 2), "not up")
        XCTAssertFalse(TorReturn.returnFindsRouteUp(ready: true, wasParked: true, away: 2, sinceBroughtBack: 2), "parked")
    }

    func testAReturnAfterTorWasParkedAlwaysSetsUp() {
        XCTAssertFalse(TorReturn.returnLeavesSetUpAlone(wasParked: true, away: 0, failed: false, stuck: false,
                                                        setUpRunning: true, setUpAge: 1, quiet: 0))
    }

    func testFocusTakenAndGivenBackLeavesARunningSetUp() {
        XCTAssertTrue(TorReturn.returnLeavesSetUpAlone(wasParked: false, away: 0, failed: false, stuck: false,
                                                       setUpRunning: true, setUpAge: 40, quiet: 20))
        XCTAssertFalse(TorReturn.returnLeavesSetUpAlone(wasParked: false, away: 0, failed: true, stuck: false,
                                                        setUpRunning: true, setUpAge: 1, quiet: 0), "a failure is set up again")
        XCTAssertFalse(TorReturn.returnLeavesSetUpAlone(wasParked: false, away: 0, failed: false, stuck: false,
                                                        setUpRunning: false, setUpAge: nil, quiet: 0), "nothing running: set up")
    }

    func testAYoungSetUpThatIsMovingIsNotStartedOver() {
        XCTAssertTrue(TorReturn.returnLeavesSetUpAlone(wasParked: false, away: 6, failed: false, stuck: false,
                                                       setUpRunning: true, setUpAge: 4, quiet: 0.5))
    }

    func testAnOldQuietOrStuckSetUpIsStartedOver() {
        XCTAssertFalse(TorReturn.returnLeavesSetUpAlone(wasParked: false, away: 6, failed: false, stuck: false,
                                                        setUpRunning: true, setUpAge: TorReturn.youngSetUp + 1, quiet: 0.5), "old")
        XCTAssertFalse(TorReturn.returnLeavesSetUpAlone(wasParked: false, away: 6, failed: false, stuck: false,
                                                        setUpRunning: true, setUpAge: 4, quiet: TorReturn.movingWithin + 1), "quiet")
        XCTAssertFalse(TorReturn.returnLeavesSetUpAlone(wasParked: false, away: 6, failed: false, stuck: true,
                                                        setUpRunning: true, setUpAge: 4, quiet: 0.5), "stuck")
        XCTAssertFalse(TorReturn.returnLeavesSetUpAlone(wasParked: false, away: 6, failed: false, stuck: false,
                                                        setUpRunning: true, setUpAge: nil, quiet: 0.5), "no age known")
    }

    func testAReturnWaitsLessForADeadControlLink() {
        XCTAssertLessThan(TorReturn.linkAnswerWait(onReturn: true), TorReturn.linkAnswerWait(onReturn: false))
        XCTAssertEqual(TorReturn.linkAnswerWait(onReturn: false), 3)
    }

    // MARK: Direct's patience

    func testNoRelayConnectionRestartsAsBefore() {
        XCTAssertEqual(TorReturn.onDirectDeadline(relayLinksOpen: 0, extensions: 0), .restart)
    }

    func testAnOpenRelayConnectionGetsAnotherCircuitTwiceThenTheRestart() {
        XCTAssertEqual(TorReturn.onDirectDeadline(relayLinksOpen: 1, extensions: 0), .anotherCircuit)
        XCTAssertEqual(TorReturn.onDirectDeadline(relayLinksOpen: 1, extensions: 1), .anotherCircuit)
        XCTAssertEqual(TorReturn.onDirectDeadline(relayLinksOpen: 1, extensions: 2), .restart)
    }

    // MARK: Where TorService asks

    private func torService() throws -> String {
        try String(contentsOf: repoRoot().appendingPathComponent("Foxy/Tor/TorService.swift"), encoding: .utf8)
    }

    private func body(_ src: String, _ signature: String) -> String {
        guard let start = src.range(of: signature) else { return "" }
        let rest = src[start.lowerBound...]
        guard let end = rest.range(of: "\n    }\n") else { return String(rest) }
        return String(rest[..<end.upperBound])
    }

    func testAReturnAsksTheRuleBeforeSettingUp() throws {
        let resumed = body(try torService(), "static func resumed(away: TimeInterval)")
        guard let rule = resumed.range(of: "TorReturn.returnLeavesSetUpAlone("),
              let setUp = resumed.range(of: "setUp(\"back after") else {
            return XCTFail("resumed no longer asks TorReturn.returnLeavesSetUpAlone before its set-up")
        }
        XCTAssertLessThan(rule.lowerBound, setUp.lowerBound)
    }

    func testAReturnAsksWhetherTheRouteIsUpFirst() throws {
        let src = try torService()
        let resumed = body(src, "static func resumed(away: TimeInterval)")
        guard let up = resumed.range(of: "TorReturn.returnFindsRouteUp("),
              let alone = resumed.range(of: "TorReturn.returnLeavesSetUpAlone("),
              let setUp = resumed.range(of: "setUp(\"back after") else {
            return XCTFail("resumed no longer asks TorReturn.returnFindsRouteUp before its set-up")
        }
        XCTAssertLessThan(up.lowerBound, alone.lowerBound)
        XCTAssertLessThan(alone.lowerBound, setUp.lowerBound)
        XCTAssertFalse(resumed.contains("away < 30"), "the half minute is the rule's, counted from the later of the two")
        // brought back is noted only when the return takes Tor from parked
        XCTAssertTrue(resumed.contains("if wasParked { broughtBackAt = Date() }"))
    }

    func testTheDeadlineAsksTheRuleBeforeRestartingDirect() throws {
        let expired = body(try torService(), "private static func deadlineExpired()")
        guard let rule = expired.range(of: "TorReturn.onDirectDeadline("),
              let restart = expired.range(of: "setUp(\"direct did not move\")") else {
            return XCTFail("deadlineExpired no longer asks TorReturn.onDirectDeadline before restarting direct")
        }
        XCTAssertLessThan(rule.lowerBound, restart.lowerBound)
    }

    func testTheRouteStillOpensOnTorsOwnAnnouncement() throws {
        let src = try torService()
        XCTAssertTrue(src.contains("forCircuitEstablished"), "ready comes from Tor's CIRCUIT_ESTABLISHED")
        let established = body(src, "private static func established()")
        XCTAssertTrue(established.contains("guard dirInfo") && established.contains("guard socksPort != 0"),
                      "the route opens only with directory info and the SOCKS port known")
    }
}
