import XCTest
@testable import Foxy

/// The bridge's range checks for counterReserveAt and restoreSecrets. seedSecrets
/// is gone (stage 2); these actions take the ranges it took, with the same checks.
/// (Moved from NUT13Tests, which now also runs in tools/nativetests.)
final class CounterRangeCheckTests: XCTestCase {
    private let good: [String: Any] = ["action": "restoreSecrets", "id": "4", "keysetId": "00b4cd27d8861a44", "start": 0, "count": 10]

    private func with(_ key: String, _ value: Any?) -> [String: Any] {
        var body = good
        body[key] = value
        return body
    }

    /// restoreSecrets' range, checked to be what counterReserveAt makes of the same body.
    private func range(_ body: [String: Any]) -> FoxyBridge.NativeCheck<FoxyBridge.CounterRequest> {
        let at = FoxyBridge.counterReserveAtCheck(body)
        switch FoxyBridge.restoreSecretsCheck(body) {
        case .ok(let asked):
            XCTAssertEqual(at, .ok(asked.range))
            XCTAssertNil(asked.candidate)
            return .ok(asked.range)
        case .refuse(let why):
            XCTAssertEqual(at, .refuse(why))
            return .refuse(why)
        }
    }

    func testSeedSecretsIsGone() {
        guard case .unknown = FoxyBridge.dispatch(["action": "seedSecrets", "id": "4"]) else {
            return XCTFail("seedSecrets still runs")
        }
    }

    func testTheRangeActionsRunInEveryBuild() {
        // no switch since stage 4: the test host is launched with no arguments
        guard case .run = FoxyBridge.dispatch(good) else { return XCTFail("restoreSecrets does not run") }
        XCTAssertEqual(FoxyBridge.restoreSecretsCheck(with("count", 0)), .refuse("bad request"))
        XCTAssertEqual(FoxyBridge.counterReserveAtCheck(with("count", 0)), .refuse("bad request"))
    }

    func testAGoodRangeIsTaken() {
        XCTAssertEqual(range(good), .ok(.init(keysetId: "00b4cd27d8861a44", version: 0, start: 0, count: 10)))
        let v01 = "015ba18a8adcd02e715a58358eb618da4a4b3791151a4bee5e968bb88406ccf76a"
        let edges: [(String, Any, Any, UInt8, UInt64, Int)] = [
            ("00b4cd27d8861a44", 0, 1, 0, 0, 1),
            ("00b4cd27d8861a44", 0, 1000, 0, 0, 1000),
            ("00b4cd27d8861a44", 0x7FFF_FFFF, 1, 0, 0x7FFF_FFFF, 1),
            ("00b4cd27d8861a44", 0x7FFF_FC18, 1000, 0, 0x7FFF_FC18, 1000),
            (v01, 9_007_199_254_740_991, 1, 1, 9_007_199_254_740_991, 1),
            (v01, Double(1 << 40), 1000.0, 1, 1 << 40, 1000),         // WebKit may hand numbers over as doubles
        ]
        for (id, start, count, version, wantStart, wantCount) in edges {
            var body = good
            body["keysetId"] = id; body["start"] = start; body["count"] = count
            XCTAssertEqual(range(body), .ok(.init(keysetId: id, version: version, start: wantStart, count: wantCount)), "\(id) \(start) \(count)")
        }
    }

    func testUpperCaseKeysetIdsAreOneKeysetWithLowerCase() {
        XCTAssertEqual(range(with("keysetId", "00B4CD27D8861A44")), .ok(.init(keysetId: "00b4cd27d8861a44", version: 0, start: 0, count: 10)))
    }

    func testCountsOutsideOneToAThousandAreRefused() {
        for count in [0, 1001, -1, 1.5, "10", true, NSNull(), Double.nan, 1e300] as [Any] {
            XCTAssertEqual(range(with("count", count)), .refuse("bad request"), "count \(count)")
        }
        XCTAssertEqual(range(with("count", nil)), .refuse("bad request"))
    }

    func testStartsOutsideTheKeysetsCountersAreRefused() {
        let v01 = "01" + String(repeating: "cd", count: 32)
        let refused: [(String, Any?, Any)] = [
            ("00b4cd27d8861a44", -1, 1),
            ("00b4cd27d8861a44", 0x8000_0000, 1),
            ("00b4cd27d8861a44", 0x7FFF_FFFF, 2),                  // the last counter would wrap
            ("00b4cd27d8861a44", 1 << 40, 1),
            (v01, 9_007_199_254_740_992, 1),
            (v01, 9_007_199_254_740_991, 2),
            ("00b4cd27d8861a44", 0.5, 1),
            ("00b4cd27d8861a44", "0", 1),
            ("00b4cd27d8861a44", false, 1),
            ("00b4cd27d8861a44", nil, 1),
        ]
        for (id, start, count) in refused {
            var body = good
            body["keysetId"] = id; body["start"] = start; body["count"] = count
            XCTAssertEqual(range(body), .refuse("bad request"), "\(id) \(String(describing: start))")
        }
    }

    func testKeysetIdsThatAreNotHexVersion00Or01AreRefused() {
        let ids: [Any?] = [
            nil, 5, "", "00b4cd27d8861a4", "00b4cd27d8861a445", "01b4cd27d8861a44",
            "00" + String(repeating: "ab", count: 32), "02" + String(repeating: "ab", count: 32),
            "I2yN+iRYfkzT",                                         // a legacy base64 id
            "00b4cd27d8861a4z", "00b4cd27 8861a44", "００b4cd27d8861a44",
        ]
        for id in ids {
            XCTAssertEqual(range(with("keysetId", id)), .refuse("bad request"), "\(String(describing: id))")
        }
    }

    // MARK: The lock-key actions (P2PK.swift)

    /// p2pkReserve {count}: 0 (a peek) to 64. The seed's lock keys have no
    /// keyset, so there is no id here — only how many.
    func testALockKeyReservationTakesZeroToSixtyFour() {
        for count in [0, 1, 64] {
            XCTAssertEqual(FoxyBridge.p2pkReserveCheck(["count": count]), .ok(count))
        }
        XCTAssertEqual(FoxyBridge.p2pkReserveCheck(["count": 2.0]), .ok(2), "WebKit may hand a whole number over as a double")
        for count in [-1, 65, 1000, 1.5, "3", true, NSNull(), Double.nan] as [Any] {
            XCTAssertEqual(FoxyBridge.p2pkReserveCheck(["count": count]), .refuse("bad request"), "\(count)")
        }
        XCTAssertEqual(FoxyBridge.p2pkReserveCheck([:]), .refuse("bad request"))
    }

    /// p2pkPubkeys {start, count}: 1 to 300, and no index past 20,000 — the last
    /// one as well as the first.
    func testAScanTakesUpToThreeHundredAndStopsAtTwentyThousand() {
        XCTAssertEqual(FoxyBridge.p2pkPubkeysCheck(["start": 0, "count": 300]), .ok(.init(start: 0, count: 300)))
        XCTAssertEqual(FoxyBridge.p2pkPubkeysCheck(["start": 19_700, "count": 300]), .ok(.init(start: 19_700, count: 300)))
        XCTAssertEqual(FoxyBridge.p2pkPubkeysCheck(["start": 19_999, "count": 1]), .ok(.init(start: 19_999, count: 1)))
        let refused: [(Any?, Any)] = [
            (19_701, 300),                 // the last index would be past 20,000
            (20_000, 1),
            (0, 301),
            (0, 0),
            (-1, 1),
            (0.5, 1),
            ("0", 1),
            (false, 1),
            (nil, 1),                      // no start at all
            (1 << 40, 1),
        ]
        for (start, count) in refused {
            var body: [String: Any] = ["count": count]
            body["start"] = start
            XCTAssertEqual(FoxyBridge.p2pkPubkeysCheck(body), .refuse("bad request"),
                           "\(String(describing: start)) + \(count)")
        }
        XCTAssertEqual(FoxyBridge.p2pkPubkeysCheck(["start": 0]), .refuse("bad request"))
    }

    /// p2pkKey {index}: a normal BIP-32 child index. Whether this phone will
    /// answer for it is the window's question, not this one's.
    func testALockKeyIndexIsANormalBip32Child() {
        for index in [0, 1, 20_000, 0x7FFF_FFFF] as [UInt64] {
            XCTAssertEqual(FoxyBridge.p2pkKeyCheck(["index": Int(index)]), .ok(index), "\(index)")
        }
        for index in [-1, 0x8000_0000, 1 << 40, 1.5, "7", true, NSNull()] as [Any] {
            XCTAssertEqual(FoxyBridge.p2pkKeyCheck(["index": index]), .refuse("bad request"), "\(index)")
        }
        XCTAssertEqual(FoxyBridge.p2pkKeyCheck([:]), .refuse("bad request"))
    }

    func testTheLockKeyActionsRunInEveryBuild() {
        for body in [["action": "p2pkReserve", "id": "5", "count": 1],
                     ["action": "p2pkPubkeys", "id": "5", "start": 0, "count": 1],
                     ["action": "p2pkKey", "id": "5", "index": 0]] as [[String: Any]] {
            guard case .run = FoxyBridge.dispatch(body) else {
                XCTFail("\(body["action"] ?? "") does not run")
                continue
            }
        }
    }
}
